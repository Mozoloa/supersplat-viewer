import { uncachedCornerSource } from './static-geometry.mjs';

globalThis.__emsQuestVerifyGeometry = async () => {
    const {app}=await document.querySelector('pc-app').ready();
    if(app.xr.active)throw new Error('End XR before checking geometry invalidation.');
    const r=globalThis.__emsQuestStaticRenderer;
    if(!r?.covarianceCache)throw new Error('Select the covariance-cache variant.');
    let manager;
    for(const camera of app.renderer.gsplatDirector.camerasMap.values())for(const layer of camera.layersMap.values()) {
        if(layer.gsplatManager?.renderer===r)manager=layer.gsplatManager;
    }
    const state=manager.world.getState(manager.world.lastWorldStateVersion);
    const model=state.splats[0].node, scale=model.getLocalScale().clone();
    const camera=manager.cameraNode, position=camera.getPosition().clone();
    const material=manager._fillRenderViewParams().material;
    const originalCorner=material.hasShaderChunks ? material.shaderChunks.wgsl.get('gsplatCornerVS') : undefined;
    const auto=app.autoRender;
    const update=app.update;
    const frame=()=>new Promise(resolve=>{app.once('frameend',resolve);app.renderNextFrame=true;});
    app.autoRender=false;
    app.update=()=>{};
    try {
        await frame();await frame();const initial=r.covarianceCache.rebuilds;
        await frame();const stationaryReused=r.covarianceCache.rebuilds===initial;
        camera.setPosition(position.x+0.02,position.y,position.z);
        await frame();await frame();const cameraReused=r.covarianceCache.rebuilds===initial;
        model.setLocalScale(scale.x*1.01,scale.y,scale.z);
        await frame();await frame();const modelRebuilt=r.covarianceCache.rebuilds>initial;
        const changedModelImage=await globalThis.__emsQuestVerifyImage(1680,1760,'static-shader');
        const customCorner=uncachedCornerSource+'\n// Geometry validation custom corner';
        material.shaderChunks.wgsl.set('gsplatCornerVS',customCorner);material.update();
        await frame();await frame();
        const customPreserved=!r.material.getDefine('QUEST_STATIC_COVARIANCE') && r.material.shaderChunks.wgsl.get('gsplatCornerVS')===customCorner;
        globalThis.__emsQuestGeometryCheck={stationaryReused,cameraReused,modelRebuilt,customPreserved,cacheBytes:r.covarianceCache.output.byteSize,changedModelImage};
        if(!stationaryReused||!cameraReused||!modelRebuilt||!customPreserved)throw new Error('Geometry cache invalidation or custom shader preservation failed.');
        if(changedModelImage.repeat.maxChannelDifference!==0||changedModelImage.candidate.maxChannelDifference!==0)throw new Error('Cached covariance changed the comparison image: '+JSON.stringify(changedModelImage));
        return globalThis.__emsQuestGeometryCheck;
    } finally {
        if(originalCorner)material.shaderChunks.wgsl.set('gsplatCornerVS',originalCorner);
        else material.shaderChunks.wgsl.delete('gsplatCornerVS');
        material.update();model.setLocalScale(scale);camera.setPosition(position);
        await frame();app.autoRender=auto;app.update=update;app.renderNextFrame=true;
    }
};
