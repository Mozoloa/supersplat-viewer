globalThis.__emsQuestVerifyStaticOrder = async () => {
    const {app} = await document.querySelector('pc-app').ready();
    if (app.xr.active) throw new Error('End XR before the deterministic sort check.');
    let manager;
    for (const camera of app.renderer.gsplatDirector.camerasMap.values()) for (const layer of camera.layersMap.values()) {
        if (layer.gsplatManager?.renderer === globalThis.__emsQuestStaticRenderer) manager=layer.gsplatManager;
    }
    if (!manager) throw new Error('No static GPU renderer.');
    const r=manager.renderer, camera=manager.cameraNode, position=camera.getPosition().clone(), rotation=camera.getRotation().clone();
    const auto=app.autoRender;
    const params={...manager._fillRenderViewParams(),radialSorting:true};
    const state=manager.world.getState(manager.world.lastWorldStateVersion);
    const model=state.splats[0].node,modelPosition=model.getLocalPosition().clone();
    const prepare=()=>r.prepareRenderView(manager.world,state,params);
    const read=async buffer=>{const b=await buffer.read(0,r.count*4,null,true);return new Uint32Array(b.buffer,b.byteOffset,r.count)};
    const check=async()=>{
        const keys=await read(r.keys),ids=await read(r.ids),order=await read(r.order);
        let max=0;for(const id of ids)max=Math.max(max,id);
        const lookup=new Uint32Array(max+1).fill(0xffffffff),seen=new Uint8Array(r.count);
        for(let i=0;i<ids.length;i++) {if(lookup[ids[i]]!==0xffffffff)throw new Error('Duplicate source ID');lookup[ids[i]]=i;}
        let prior=-1,priorKey=-1;
        for(let i=0;i<order.length;i++) {
            const source=lookup[order[i]];
            if(source===undefined||source===0xffffffff||seen[source])throw new Error('Missing or duplicated sorted splat at '+i);
            const key=keys[source];
            if(key<priorKey||(key===priorKey&&source<prior))throw new Error('Unstable or incorrect depth order at '+i);
            seen[source]=1;prior=source;priorKey=key;
        }
        return {count:r.count,complete:true,stable:true};
    };
    app.autoRender=false;
    try {
        prepare();const initial=await check();const before=r.sortRuns;
        prepare();const stationaryReused=r.sortRuns===before;
        camera.rotateLocal(0,10,0);prepare();const rotationReused=r.sortRuns===before;
        camera.setPosition(position.x+0.02,position.y,position.z);prepare();
        const translationResorted=r.sortRuns===before+1;
        const translated=await check();
        const uploads=r.sourceUploads,sorts=r.sortRuns;
        model.setLocalPosition(modelPosition.x+0.02,modelPosition.y,modelPosition.z);prepare();
        const modelResorted=r.sortRuns===sorts+1;
        const reusedSourcePositions=r.sourceUploads===uploads;
        const modelTranslated=await check();
        if(!stationaryReused||!rotationReused||!translationResorted)throw new Error('Sort invalidation check failed.');
        if(!modelResorted||!reusedSourcePositions)throw new Error('Model movement should only upload its transform and resort.');
        return {initial,translated,modelTranslated,stationaryReused,rotationReused,translationResorted,modelResorted,reusedSourcePositions};
    } finally {
        model.setLocalPosition(modelPosition);
        camera.setPosition(position);camera.setRotation(rotation);prepare();
        app.autoRender=auto;app.renderNextFrame=true;
    }
};
