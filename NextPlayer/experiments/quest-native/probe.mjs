// QA-only adapter. Published builds do not import this module.
import { Mat4 } from 'playcanvas';
import { Compute } from 'playcanvas/build/playcanvas/src/platform/graphics/compute.js';
import { Shader } from 'playcanvas/build/playcanvas/src/platform/graphics/shader.js';
import { StorageBuffer } from 'playcanvas/build/playcanvas/src/platform/graphics/storage-buffer.js';
import { BindGroupFormat, BindStorageBufferFormat, BindUniformBufferFormat } from 'playcanvas/build/playcanvas/src/platform/graphics/bind-group-format.js';
import { UniformBufferFormat, UniformFormat } from 'playcanvas/build/playcanvas/src/platform/graphics/uniform-buffer-format.js';
import { BUFFERUSAGE_COPY_SRC, SHADERLANGUAGE_WGSL, SHADERSTAGE_COMPUTE, UNIFORMTYPE_UINT } from 'playcanvas/build/playcanvas/src/platform/graphics/constants.js';
import { NativeSplatCore } from './core.mjs';
import shaderSource from 'quest-native-wgsl';

function compare(a,b){
    let squares=0,max=0,changed=0,alphaSquares=0,alphaMax=0,visible=0,visibleSquares=0;
    for(let i=0;i<a.length;i+=4){
        let localMax=0,s=0;
        for(let c=0;c<3;c++){const d=Math.abs(a[i+c]-b[i+c]);s+=d*d;max=Math.max(max,d);localMax=Math.max(localMax,d);}
        squares+=s;changed+=localMax>4;
        const d=Math.abs(a[i+3]-b[i+3]);alphaSquares+=d*d;alphaMax=Math.max(alphaMax,d);
        if(a[i+3]>1||b[i+3]>1){visible++;visibleSquares+=s;}
    }
    const mse=squares/(a.length/4*3);
    return{rmse:Math.sqrt(mse),psnr:mse?10*Math.log10(255*255/mse):null,max,pixelsOver4:changed,alphaRmse:Math.sqrt(alphaSquares/(a.length/4)),alphaMax,visiblePixels:visible,visibleRmse:Math.sqrt(visibleSquares/(visible*3))};
}

globalThis.__emsQuestNativeBench=async({width=1680,height=1760,frames=10,epsilon=1/1024,modes=['fused'],shaderCode=shaderSource,Core=NativeSplatCore}={})=>{
    const {app}=await document.querySelector('pc-app').ready(),device=app.graphicsDevice,r=globalThis.__emsQuestStaticRenderer;
    if(app.xr.active||!r?.covarianceCache)throw new Error('Use a loaded static QA scene outside XR.');
    if(!Number.isInteger(frames)||frames<1||frames>60)throw new Error('Use 1 to 60 sample frames.');
    if(!Number.isFinite(epsilon)||epsilon<0||epsilon>1/255)throw new Error('Invalid contribution threshold.');
    if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw new Error('Invalid probe dimensions.');
    if(!modes.length||modes.some(mode=>!['draw','fused','occlusion','tiled','pruned','depth-reject'].includes(mode)))throw new Error('Unknown probe mode.');
    if(r.count!==r.cacheCapacity||r.sourceState.splats.length!==1)throw new Error('This probe requires one contiguous static source.');
    if(r.sortBits!==32||r.material.getParameter('questSupport').data!==1)throw new Error('Use support=1&sortbits=32 for a matched reference.');
    if(app.scene.gsplat.antiAlias||!r.material.getDefine('QUEST_STATIC_COVARIANCE'))throw new Error('Custom/AA geometry is outside this probe.');
    const profiling=device.gpuProfiler.enabled;
    device.gpuProfiler.enabled=true;
    const camera=app.root.findByName('camera'),c=camera.camera;
    const saved={auto:app.autoRender,update:app.update,clear:c.clearColor.clone()};
    app.autoRender=false;app.update=()=>{};c.clearColor.set(0,0,0,0);
    let core,pack,compute,shader,bindFormat;
    let referenceUniforms;
    const captureUniforms=()=>{
        if(c.renderTarget?.width===width&&c.renderTarget?.height===height)referenceUniforms=Object.fromEntries(['matrix_projection','matrix_view','matrix_model','viewport_size'].map(name=>[name,Array.from(device.scope.resolve(name).value)]));
    };
    app.on('frameend',captureUniforms);
    const errors=[];const onError=e=>errors.push(e.error.message);device.wgpu.addEventListener('uncapturederror',onError);
    try{
        const reference=await __emsQuestVerifyImage(width,height,'combined');
        const referencePasses=Object.fromEntries(device.gpuProfiler.passTimings||[]);
        app.renderNextFrame=false;
        const baseline=__emsQuestComparisonPixels.candidate.slice();
        if(!referenceUniforms)throw new Error('Reference draw did not expose its camera uniforms.');
        const projection=referenceUniforms.matrix_projection;
        const view=new Mat4().set(referenceUniforms.matrix_view).mul(new Mat4().set(referenceUniforms.matrix_model));
        const format=r.workBuffer.format;
        const capacity=r.cacheCapacity;
        pack=new StorageBuffer(device,capacity*64,BUFFERUSAGE_COPY_SRC);
        const uniformFormat=new UniformBufferFormat(device,[new UniformFormat('splatTextureSize',UNIFORMTYPE_UINT),new UniformFormat('count',UNIFORMTYPE_UINT)]);
        bindFormat=new BindGroupFormat(device,[new BindStorageBufferFormat('ids',SHADERSTAGE_COMPUTE,true),new BindStorageBufferFormat('covariance',SHADERSTAGE_COMPUTE,true),new BindStorageBufferFormat('packed',SHADERSTAGE_COMPUTE,false),new BindUniformBufferFormat('uniforms',SHADERSTAGE_COMPUTE),...format.getComputeBindFormats()]);
        shader=new Shader(device,{name:'Native prototype static data import',shaderLanguage:SHADERLANGUAGE_WGSL,computeBindGroupFormat:bindFormat,computeUniformBufferFormats:{uniforms:uniformFormat},cshader:`
#include "halfTypesCS"
@group(0) @binding(0) var<storage,read> ids:array<u32>;
@group(0) @binding(1) var<storage,read> covariance:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> packed:array<vec4f>;
struct Params{splatTextureSize:u32,count:u32};
@group(0) @binding(3) var<uniform> uniforms:Params;
struct Splat{index:u32,uv:vec2i};var<private> splat:Splat;
${format.getComputeInputDeclarations(4)}
${format.getReadCode()}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid:vec3u){
 if(gid.x>=uniforms.count){return;}
 let id=ids[gid.x];splat.index=id;splat.uv=vec2i(i32(id%uniforms.splatTextureSize),i32(id/uniforms.splatTextureSize));
 let center=getCenter();let opacity=getOpacity();let color=getColor();
 packed[id*4u]=vec4f(center,opacity);packed[id*4u+1u]=covariance[id*2u];packed[id*4u+2u]=covariance[id*2u+1u];packed[id*4u+3u]=vec4f(vec3f(color),opacity);
}`});
        const importErrors=(await shader.impl.getComputeShaderModule().getCompilationInfo()).messages.filter(m=>m.type==='error');
        if(importErrors.length)throw new Error(importErrors.map(m=>m.message).join('\n'));
        compute=new Compute(device,shader,'Native static import');
        compute.setParameter('ids',r.ids);compute.setParameter('covariance',r.covarianceCache.output);compute.setParameter('packed',pack);
        compute.setParameter('splatTextureSize',r.sourceState.textureSize);compute.setParameter('count',r.count);
        for(const stream of format.resourceStreams)compute.setParameter(stream.name,r.workBuffer.getTexture(stream.name));
        compute.setupDispatch(Math.ceil(r.count/256),1,1);device.computeDispatch([compute],'Native static import');device.submit();
        await device.wgpu.queue.onSubmittedWorkDone();
        core=await Core.create(device.wgpu,pack.impl.buffer,r.order.impl.buffer,r.count,width,height,shaderCode);
        const shaderParams=c.camera.shaderParams;
        if(shaderParams.toneMapping!==0||device.scope.resolve('exposure').value!==1)throw new Error('Native probe requires linear tone mapping at unit exposure.');
        const configuration={view:Array.from(view.data),projection,decodeGamma:shaderParams.shaderOutputGamma===0?1:0,epsilon,minPixelSize:app.scene.gsplat.minPixelSize,alphaClip:app.scene.gsplat.alphaClipForward};
        const results=[];
        let oracleReady=false;
        for(const mode of modes){
            if(mode==='pruned'&&!oracleReady)throw new Error('Run a complete tiled analysis before the view-dependent visibility oracle.');
            core.configure({...configuration,mode,tiled:mode==='tiled'});
            await core.frame();
            const times=[];for(let i=0;i<frames;i++)times.push(await core.frame());
            const pixels=await core.pixels();
            const stats=new Uint32Array(await core.read(core.tiles,48,core.tileCount*16));
            if(mode==='tiled'){
                if(stats[8]||stats[0]>core.capacity)throw new Error(`Incomplete tile lists: ${stats[8]} overflowing tiles.`);
                oracleReady=true;
            }
            const importance=mode==='tiled'?new Float32Array(await core.read(core.importance,r.count*4)):null;
            const mean=Object.fromEntries(Object.keys(times[0]).map(name=>[name,times.reduce((s,t)=>s+t[name],0)/times.length]));
            results.push({mode,diagnostic:mode==='depth-reject',viewDependentOracle:mode==='pruned',ms:mean,totalMs:Object.values(mean).reduce((a,b)=>a+b,0),pairCount:stats[0],maxTileCount:stats[4],overflowTiles:stats[8],importance:importance?[0,1/8192,1/4096,1/2048,1/1024,1/512,1/255].map(threshold=>({threshold,count:importance.reduce((n,value)=>n+Number(value>threshold),0)})):undefined,image:compare(baseline,pixels)});
            globalThis.__emsQuestNativePixels={width,height,baseline,candidate:pixels};
            if(errors.length)throw new Error(errors.join('\n'));
        }
        return{width,height,count:r.count,reference,referencePasses,configuration,shaderParams:{toneMapping:shaderParams.toneMapping,gamma:shaderParams.shaderOutputGamma},bufferBytes:core.owned.reduce((n,b)=>n+b.size,0)+pack.byteSize,results,errors};
    }finally{
        core?.destroy();pack?.destroy();compute?.destroy();shader?.destroy();bindFormat?.destroy();
        app.off('frameend',captureUniforms);
        device.wgpu.removeEventListener('uncapturederror',onError);
        device.gpuProfiler.enabled=profiling;
        c.clearColor.copy(saved.clear);app.autoRender=saved.auto;app.update=saved.update;app.renderNextFrame=true;
    }
};
