import {
    ADDRESS_CLAMP_TO_EDGE, BLEND_PREMULTIPLIED, BUFFER_STATIC, CULLFACE_NONE,
    Entity, FILTER_LINEAR, FILTER_NEAREST, Mat4, Mesh, MeshInstance,
    PIXELFORMAT_R32U, PIXELFORMAT_RGBA8, PIXELFORMAT_RGBA32F, SEMANTIC_ATTR13,
    SEMANTIC_POSITION, ShaderMaterial, Texture, TYPE_FLOAT32, Vec3, VertexBuffer,
    VertexFormat, type AppBase
} from 'playcanvas';
import { GSplatSorter } from 'playcanvas/build/playcanvas/src/scene/gsplat/gsplat-sorter.js';
import { mediaFetch } from './media-request';
import type { SceneManifest } from './scene-manifest';

export interface TexturedSplatHeader {
    format: 'ems-gstex'; version: 1; pointCount: number; patchSize: number;
    atlasWidth: number; atlasHeight: number; geometryFloats: 12; scene: SceneManifest;
}

export const readTexturedHeader = (buffer: ArrayBuffer): { header: TexturedSplatHeader; offset: number } => {
    const bytes = new Uint8Array(buffer);
    if (new TextDecoder().decode(bytes.subarray(0, 8)) !== 'EMSGSTX1') throw new Error('Invalid GStex asset signature.');
    const length = new DataView(buffer).getUint32(8, true);
    if (length < 2 || length > 65524 || 12 + length > buffer.byteLength || length % 4) throw new Error('Invalid GStex header size.');
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))) as TexturedSplatHeader;
    if (header.format !== 'ems-gstex' || header.version !== 1 || header.geometryFloats !== 12
        || ![header.pointCount, header.patchSize, header.atlasWidth, header.atlasHeight].every(n => Number.isSafeInteger(n) && n > 0)
        || header.pointCount > 2000000 || header.patchSize > 256) throw new Error('Unsupported GStex layout.');
    return { header, offset: 12 + length };
};

const vertex = `
attribute vec3 vertex_position;
attribute float instance_index;
uniform mat4 patchModel;
uniform mat4 matrix_viewProjection;
uniform highp usampler2D patchOrder;
uniform highp sampler2D patchCenters;
uniform highp sampler2D patchAxisU;
uniform highp sampler2D patchAxisV;
uniform int dataWidth;
varying vec2 patchCoord;
flat varying vec3 patchAtlas;
void main() {
    int slot = int(instance_index);
    ivec2 address = ivec2(slot % dataWidth, slot / dataWidth);
    int id = int(texelFetch(patchOrder, address, 0).r);
    address = ivec2(id % dataWidth, id / dataWidth);
    vec4 center = texelFetch(patchCenters, address, 0);
    vec4 u = texelFetch(patchAxisU, address, 0);
    vec4 v = texelFetch(patchAxisV, address, 0);
    patchCoord = vertex_position.xy * 3.0;
    patchAtlas = vec3(u.w, v.w, center.w);
    vec3 position = center.xyz + u.xyz * patchCoord.x + v.xyz * patchCoord.y;
    gl_Position = matrix_viewProjection * patchModel * vec4(position, 1.0);
}`;

const fragment = `
precision highp float;
uniform sampler2D colourAtlas;
uniform vec2 atlasSize;
uniform float patchSize;
varying vec2 patchCoord;
flat varying vec3 patchAtlas;
void main() {
    float alpha = min(0.99, patchAtlas.z * exp(-0.5 * dot(patchCoord, patchCoord)));
    if (alpha < 1.0 / 255.0) discard;
    vec2 localUV = clamp(patchCoord / 6.0 + 0.5, 0.0, 1.0);
    vec2 atlasUV = (patchAtlas.xy + 0.5 + localUV * (patchSize - 1.0)) / atlasSize;
    vec3 rgb = texture2D(colourAtlas, atlasUV).rgb;
    gl_FragColor = vec4(rgb * alpha, alpha);
}`;

export const loadTexturedSplat = async (
    app: AppBase, camera: Entity, contentRoot: Entity, url: string, progress: (n: number) => void
): Promise<{ count: number; diagnostics: string[]; destroy: () => void }> => {
    if (app.graphicsDevice.deviceType !== 'webgl2') throw new Error('The GStex prototype requires the WebGL2 backend.');
    const response = await mediaFetch(url);
    if (!response.ok) throw new Error(`GStex download failed (HTTP ${response.status}).`);
    const buffer = await response.arrayBuffer();
    const { header, offset } = readTexturedHeader(buffer);
    const geometryBytes = header.pointCount * 48;
    if (buffer.byteLength !== offset + geometryBytes + header.atlasWidth * header.atlasHeight * 4) throw new Error('GStex payload length mismatch.');
    const device = app.graphicsDevice;
    if (Math.max(header.atlasWidth, header.atlasHeight) > device.maxTextureSize) throw new Error('GStex atlas exceeds this device texture limit.');
    const width = Math.ceil(Math.sqrt(header.pointCount));
    const height = Math.ceil(header.pointCount / width);
    const source = new Float32Array(buffer, offset, header.pointCount * 12);
    if (!source.every(Number.isFinite)) throw new Error('GStex geometry contains non-finite values.');
    const textures: Texture[] = [];
    const makeTexture = (name: string, w: number, h: number, format: number, linear = false): Texture => {
        const result = new Texture(device, { name, width: w, height: h, format, mipmaps: false,
            minFilter: linear ? FILTER_LINEAR : FILTER_NEAREST, magFilter: linear ? FILTER_LINEAR : FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE });
        textures.push(result); return result;
    };
    const order = makeTexture('GStex order', width, height, PIXELFORMAT_R32U);
    const data = [0, 1, 2].map(index => {
        const texture = makeTexture(`GStex geometry ${index}`, width, height, PIXELFORMAT_RGBA32F);
        const target = texture.lock() as Float32Array;
        for (let point = 0; point < header.pointCount; point++) target.set(source.subarray(point * 12 + index * 4, point * 12 + index * 4 + 4), point * 4);
        texture.unlock(); return texture;
    });
    const atlas = makeTexture('GStex colour atlas', header.atlasWidth, header.atlasHeight, PIXELFORMAT_RGBA8, true);
    (atlas.lock() as Uint8Array).set(new Uint8Array(buffer, offset + geometryBytes)); atlas.unlock();
    const entity = new Entity('textured-surface'); contentRoot.addChild(entity);
    const mesh = new Mesh(device);
    mesh.setPositions([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]); mesh.setIndices([0,1,2,0,2,3]); mesh.update();
    const material = new ShaderMaterial({ uniqueName: 'EMS-GStex', vertexGLSL: vertex, fragmentGLSL: fragment,
        attributes: { vertex_position: SEMANTIC_POSITION, instance_index: SEMANTIC_ATTR13 } });
    material.cull = CULLFACE_NONE; material.depthWrite = false; material.blendType = BLEND_PREMULTIPLIED;
    material.setParameter('patchOrder', order); material.setParameter('patchCenters', data[0]);
    material.setParameter('patchAxisU', data[1]); material.setParameter('patchAxisV', data[2]);
    material.setParameter('colourAtlas', atlas); material.setParameter('dataWidth', width);
    material.setParameter('atlasSize', [header.atlasWidth, header.atlasHeight]); material.setParameter('patchSize', header.patchSize); material.update();
    const indices = Float32Array.from({ length: header.pointCount }, (_, i) => i);
    const instances = new VertexBuffer(device, new VertexFormat(device, [{ semantic: SEMANTIC_ATTR13, components: 1, type: TYPE_FLOAT32 }]),
        header.pointCount, { usage: BUFFER_STATIC, data: indices.buffer });
    const meshInstance = new MeshInstance(mesh, material, entity);
    meshInstance.setInstancing(instances, true); meshInstance.instancingCount = 0; meshInstance.cull = false;
    entity.addComponent('render', { meshInstances: [meshInstance] });
    const centers = new Float32Array(header.pointCount * 3);
    for (let i = 0; i < header.pointCount; i++) centers.set(source.subarray(i * 12, i * 12 + 3), i * 3);
    // PlayCanvas bundles public declarations separately from internal ones;
    // the objects here are the same pinned runtime classes.
    const sorter = new GSplatSorter(device as unknown as ConstructorParameters<typeof GSplatSorter>[0],
        app.scene as unknown as ConstructorParameters<typeof GSplatSorter>[1]);
    // The sort upload covers complete texture rows, while centers/count retain
    // only real primitives (the same allocation contract as GSplatInstance).
    sorter.init(order as unknown as Parameters<GSplatSorter['init']>[0], width * height, centers);
    const inverse = new Mat4(); const position = new Vec3(); const direction = new Vec3();
    const lastPosition = new Vec3(Infinity,Infinity,Infinity); const lastDirection = new Vec3(Infinity,Infinity,Infinity);
    const update = (): void => {
        const count = sorter.applyPendingSorted();
        if (count >= 0) meshInstance.instancingCount = Math.min(count, header.pointCount);
        inverse.copy(entity.getWorldTransform()).invert();
        // Instanced draws do not receive PlayCanvas's ordinary model uniform.
        material.setParameter('patchModel', entity.getWorldTransform().data);
        inverse.transformPoint(camera.getPosition(), position);
        inverse.transformVector(camera.forward, direction).normalize();
        direction.mulScalar(-1); // PlayCanvas's sorter expects the camera +Z axis.
        if (!position.equalsApprox(lastPosition) || !direction.equalsApprox(lastDirection)) {
            sorter.setCamera(position, direction); lastPosition.copy(position); lastDirection.copy(direction);
        }
    };
    app.on('prerender', update); update(); progress(100);
    return { count: header.pointCount,
        diagnostics: [`Representation: textured surface splats · ${header.patchSize}×${header.patchSize} texels/patch`,
            `GStex payload: ${(buffer.byteLength/1048576).toFixed(1)} MB · atlas ${(header.atlasWidth*header.atlasHeight*4/1048576).toFixed(1)} MB`],
        destroy: () => { app.off('prerender', update); sorter.destroy(); entity.destroy(); instances.destroy(); material.destroy(); textures.forEach(t => t.destroy()); }
    };
};
