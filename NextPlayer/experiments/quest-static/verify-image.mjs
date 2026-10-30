import { Mesh, Texture, RenderTarget, PIXELFORMAT_RGBA8, FILTER_NEAREST } from 'playcanvas';

function quad(device, size) {
    const mesh = new Mesh(device);
    const positions = new Float32Array(size * 12);
    const indices = new Uint32Array(size * 6);
    for (let i = 0; i < size; i++) {
        positions.set([-1,-1,i, 1,-1,i, 1,1,i, -1,1,i], i * 12);
        indices.set([i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3], i * 6);
    }
    mesh.setPositions(positions, 3); mesh.setIndices(indices); mesh.update();
    return mesh;
}

function compare(a, b) {
    let squared = 0, max = 0, changed = 0, over4 = 0, signal = 0;
    for (let i=0;i<a.length;i+=4) {
        let pixelMax = 0;
        for (let c=0;c<3;c++) {
            const delta = Math.abs(a[i+c]-b[i+c]);
            squared += delta * delta; max = Math.max(max, delta); pixelMax = Math.max(pixelMax, delta);
            signal += a[i+c];
        }
        changed += pixelMax > 0; over4 += pixelMax > 4;
    }
    const mse = squared / (a.length / 4 * 3);
    return { maxChannelDifference: max, changedPixels: changed, pixelsOver4: over4,
        rmse: Math.sqrt(mse), psnr: mse ? 10 * Math.log10(255*255/mse) : null,
        meanReferenceBrightness: signal / (a.length / 4 * 3) };
}

// Freeze projection and order only inside this offline comparison. Live XR
// always continues to project the current head pose on every frame.
globalThis.__emsQuestVerifyImage = async (width = 1680, height = 1760, mode = 'geometry') => {
    if (!['geometry', 'static-shader'].includes(mode)) throw new Error('Unknown image comparison mode.');
    const { app } = await document.querySelector('pc-app').ready();
    if (app.xr.active) throw new Error('End XR before comparing immutable flat frames.');
    const device = app.graphicsDevice;
    const camera = app.root.findByName('camera').camera;
    const previousTarget = camera.renderTarget;
    const previousAuto = app.autoRender;
    const previousUpdate = app.update;
    const texture = new Texture(device, { name: 'Quest image comparison', width, height, format: PIXELFORMAT_RGBA8,
        mipmaps: false, minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST });
    const target = new RenderTarget({ colorBuffer: texture, depth: true, samples: 1 });
    let renderer, originalMesh, prepare, originalChunk, referenceMesh, originalInstances, hybrid, frameUpdate, defines;
    const frame = () => new Promise(resolve => { app.once('frameend', resolve); app.renderNextFrame = true; });
    const read = async () => { await frame(); return texture.read(0,0,width,height,{ immediate: true }); };
    app.autoRender = false;
    // Navigation easing can keep moving the camera after a test translation.
    // Freeze update callbacks as well as sort/projection for immutable images.
    app.update = () => {};
    try {
        camera.renderTarget = target;
        await frame(); await frame();
        for (const cam of app.renderer.gsplatDirector.camerasMap.values()) {
            for (const layer of cam.layersMap.values()) {
                const r=layer.gsplatManager?.renderer;
                if (r?.projector || r?.sorter) renderer=r;
            }
        }
        if (!renderer) throw new Error('No hybrid renderer for image comparison.');
        hybrid = !!renderer.projector;
        const bytes = hybrid ? await renderer.intervalCompaction.numSplatsBuffer.read(0,4,null,true) : null;
        const count = hybrid ? new Uint32Array(bytes.buffer,bytes.byteOffset,1)[0] : renderer.count;
        if (!count) throw new Error('Empty reference projection.');
        prepare = renderer.prepareRenderView;
        originalMesh = renderer.meshInstance.mesh;
        originalInstances = renderer.meshInstance.instancingCount;
        originalChunk = renderer.material.shaderChunks.wgsl.get('gsplatHybridVS');
        const size = Number(renderer.material.defines.get('{GSPLAT_INSTANCE_SIZE}'));
        if (!Number.isInteger(size) || size <= 0) throw new Error('Invalid splat instance size.');
        if (mode === 'geometry') referenceMesh = quad(device,size);
        else {
            if (hybrid) throw new Error('Static shader comparison needs the static GPU renderer.');
            frameUpdate = renderer.frameUpdate;
            renderer.frameUpdate = () => {};
            defines = ['QUEST_STATIC_COVARIANCE'].map(name => [name, renderer.material.getDefine(name)]);
        }
        renderer.prepareRenderView = function () {
            this.meshInstance.setIndirect(null,-1);
            this.meshInstance.instancingCount = Math.ceil(count/size);
            return true;
        };
        const setShader = code => { if (hybrid) { renderer.material.shaderChunks.wgsl.set('gsplatHybridVS',code); renderer.material.update(); } };
        renderer.meshInstance.mesh = referenceMesh || originalMesh;
        if (defines) for (const [name] of defines) renderer.material.setDefine(name, false);
        renderer.material.update();
        setShader(globalThis.__emsQuestRasterShaders.baseline);
        await frame();
        const baseline = await read();
        const repeat = await read();
        renderer.meshInstance.mesh = originalMesh;
        if (defines) for (const [name, value] of defines) renderer.material.setDefine(name, value);
        renderer.material.update();
        setShader(globalThis.__emsQuestRasterShaders.selected);
        await frame();
        const candidate = await read();
        globalThis.__emsQuestComparisonPixels = { width, height, baseline, candidate };
        return { mode, width, height, splats: count, repeat: compare(baseline,repeat), candidate: compare(baseline,candidate) };
    } finally {
        if (renderer && prepare) {
            renderer.prepareRenderView = prepare;
            renderer.meshInstance.mesh = originalMesh;
            renderer.meshInstance.instancingCount = originalInstances;
            if (frameUpdate) renderer.frameUpdate = frameUpdate;
            if (defines) for (const [name, value] of defines) renderer.material.setDefine(name, value);
            if (hybrid) {
                if (originalChunk) renderer.material.shaderChunks.wgsl.set('gsplatHybridVS',originalChunk);
                else renderer.material.shaderChunks.wgsl.delete('gsplatHybridVS');
            }
            renderer.material.update();
        }
        camera.renderTarget = previousTarget;
        app.autoRender = previousAuto;
        app.update = previousUpdate;
        app.renderNextFrame = true;
        referenceMesh?.destroy(); target.destroy(); texture.destroy();
    }
};
