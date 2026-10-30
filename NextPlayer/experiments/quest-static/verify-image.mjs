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

function triangle(device, size) {
    const mesh = new Mesh(device);
    const positions = new Float32Array(size * 9), indices = new Uint32Array(size * 3);
    for(let i=0;i<size;i++) {
        positions.set([0,2,i,-Math.sqrt(3),-1,i,Math.sqrt(3),-1,i],i*9);
        indices.set([i*3,i*3+1,i*3+2],i*3);
    }
    mesh.setPositions(positions,3);mesh.setIndices(indices);mesh.update();return mesh;
}

function compare(a, b) {
    let squared = 0, max = 0, changed = 0, over4 = 0, signal = 0,alphaSquared=0,alphaMax=0;
    for (let i=0;i<a.length;i+=4) {
        let pixelMax = 0;
        for (let c=0;c<3;c++) {
            const delta = Math.abs(a[i+c]-b[i+c]);
            squared += delta * delta; max = Math.max(max, delta); pixelMax = Math.max(pixelMax, delta);
            signal += a[i+c];
        }
        changed += pixelMax > 0; over4 += pixelMax > 4;
        const alphaDelta=Math.abs(a[i+3]-b[i+3]);alphaSquared+=alphaDelta*alphaDelta;alphaMax=Math.max(alphaMax,alphaDelta);
    }
    const mse = squared / (a.length / 4 * 3);
    return { maxChannelDifference: max, changedPixels: changed, pixelsOver4: over4,
        rmse: Math.sqrt(mse), psnr: mse ? 10 * Math.log10(255*255/mse) : null,
        meanReferenceBrightness: signal / (a.length / 4 * 3),alphaRmse:Math.sqrt(alphaSquared/(a.length/4)),alphaMax };
}

// Freeze projection and order only inside this offline comparison. Live XR
// always continues to project the current head pose on every frame.
globalThis.__emsQuestVerifyImage = async (width = 1680, height = 1760, mode = 'geometry', sortOffset = [0,0,0]) => {
    if (!['geometry', 'static-shader', 'draw-state', 'sort','support','combined'].includes(mode)) throw new Error('Unknown image comparison mode.');
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
    let renderer, originalMesh, prepare, originalChunk, referenceMesh, originalInstances, hybrid, frameUpdate, defines, originalSize, originalDepth,manager,originalBits;
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
                if (r?.projector || r?.sorter) {renderer=r;manager=layer.gsplatManager;}
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
        originalSize=size; originalDepth=renderer.material.depthTest;
        originalBits=renderer.sortBits;
        const forceSort=(bits,offset=[0,0,0])=>{
            const node=manager.cameraNode,position=node.getPosition().clone();
            try{
                node.setPosition(position.x+offset[0],position.y+offset[1],position.z+offset[2]);
                renderer.sortBits=bits;renderer.lastPosition[0]=Infinity;
                prepare.call(renderer,manager.world,manager.world.getState(manager.world.lastWorldStateVersion),manager._fillRenderViewParams());
            }finally{node.setPosition(position);}
        };
        if (!Number.isInteger(size) || size <= 0) throw new Error('Invalid splat instance size.');
        if (mode === 'geometry') referenceMesh = quad(device,size);
        else if(mode === 'draw-state') {
            if(hybrid)throw new Error('Draw-state comparison needs the static renderer.');
            referenceMesh=triangle(device,128);
            frameUpdate=renderer.frameUpdate;renderer.frameUpdate=()=>{};
        }
        else {
            if (hybrid) throw new Error('Static shader comparison needs the static GPU renderer.');
            frameUpdate = renderer.frameUpdate;
            renderer.frameUpdate = () => {};
            defines = mode==='sort'?[]:[mode==='support'||mode==='combined'?'QUEST_SMALL_CAPS':'QUEST_STATIC_COVARIANCE'].map(name => [name, renderer.material.getDefine(name)]);
        }
        renderer.prepareRenderView = function () {
            this.meshInstance.setIndirect(null,-1);
            this.meshInstance.instancingCount = Math.ceil(count/Number(this.material.defines.get('{GSPLAT_INSTANCE_SIZE}')));
            return true;
        };
        const setShader = code => { if (hybrid) { renderer.material.shaderChunks.wgsl.set('gsplatHybridVS',code); renderer.material.update(); } };
        renderer.meshInstance.mesh = referenceMesh || originalMesh;
        if(mode==='draw-state') {
            renderer.material.setDefine('{GSPLAT_INSTANCE_SIZE}',128);
            renderer.material.depthTest=true;
        }
        if (defines) for (const [name] of defines) renderer.material.setDefine(name, false);
        renderer.material.update();
        if(mode==='sort'||mode==='combined')forceSort(32);
        setShader(globalThis.__emsQuestRasterShaders.baseline);
        await frame();
        const baseline = await read();
        const repeat = await read();
        renderer.meshInstance.mesh = originalMesh;
        renderer.material.setDefine('{GSPLAT_INSTANCE_SIZE}',originalSize);
        renderer.material.depthTest=originalDepth;
        if (defines) for (const [name, value] of defines) renderer.material.setDefine(name, value);
        renderer.material.update();
        if(mode==='sort'||mode==='combined')forceSort(originalBits,sortOffset);
        setShader(globalThis.__emsQuestRasterShaders.selected);
        await frame();
        const candidate = await read();
        globalThis.__emsQuestComparisonPixels = { width, height, baseline, candidate };
        return { mode, width, height, sortOffset, splats: count, repeat: compare(baseline,repeat), candidate: compare(baseline,candidate) };
    } finally {
        if (renderer && prepare) {
            renderer.prepareRenderView = prepare;
            renderer.sortBits=originalBits;
            renderer.meshInstance.mesh = originalMesh;
            renderer.meshInstance.instancingCount = originalInstances;
            renderer.material.setDefine('{GSPLAT_INSTANCE_SIZE}',originalSize);
            renderer.material.depthTest=originalDepth;
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
