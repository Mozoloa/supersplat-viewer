import { Compute } from 'playcanvas/build/playcanvas/src/platform/graphics/compute.js';
import { Shader } from 'playcanvas/build/playcanvas/src/platform/graphics/shader.js';
import { StorageBuffer } from 'playcanvas/build/playcanvas/src/platform/graphics/storage-buffer.js';
import { BindGroupFormat, BindStorageBufferFormat, BindUniformBufferFormat } from 'playcanvas/build/playcanvas/src/platform/graphics/bind-group-format.js';
import { UniformBufferFormat, UniformFormat } from 'playcanvas/build/playcanvas/src/platform/graphics/uniform-buffer-format.js';
import { BUFFERUSAGE_COPY_SRC, SHADERLANGUAGE_WGSL, SHADERSTAGE_COMPUTE, UNIFORMTYPE_UINT } from 'playcanvas/build/playcanvas/src/platform/graphics/constants.js';
import cornerSource from 'playcanvas/build/playcanvas/src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatCorner.js';
import quaternionSource from 'playcanvas/build/playcanvas/src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatQuatToMat3.js';
import modifySource from 'playcanvas/build/playcanvas/src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatModify.js';

// Reuse the engine's exact half/f32 operations and the baked work-buffer data.
// Storing f32 covariance does not introduce a new quantization step.
const covarianceFunction = cornerSource.slice(cornerSource.indexOf('fn computeCovariance('), cornerSource.indexOf('fn initCornerCov('));
if (!covarianceFunction.includes('*covB_ptr')) throw new Error('Pinned covariance shader changed.');
export const uncachedCornerSource = cornerSource;
export const cachedCornerSource = '#ifdef QUEST_STATIC_COVARIANCE\nvar<storage, read> questCovariance: array<vec4f>;\n#endif\n' + cornerSource.replace(
    'fn initCorner(source: ptr<function, SplatSource>, center: ptr<function, SplatCenter>, corner: ptr<function, SplatCorner>) -> bool {',
    `fn initCorner(source: ptr<function, SplatSource>, center: ptr<function, SplatCenter>, corner: ptr<function, SplatCorner>) -> bool {
    #if defined(QUEST_STATIC_COVARIANCE) && !defined(GSPLAT_2DGS)
        let a = questCovariance[splat.index * 2u].xyz;
        let b = questCovariance[splat.index * 2u + 1u].xyz;
        return initCornerCov(source, center, corner, a, b);
    #endif`);
export function permitsStaticGeometry(material) {
    // Hooks can increase opacity or alter covariance; keep their original path.
    if (material.getDefine('GSPLAT_2DGS')) return false;
    if (!material.hasShaderChunks) return true;
    for (const name of ['gsplatVS', 'gsplatCornerVS', 'gsplatCommonVS', 'gsplatReadVS', 'gsplatFormatVS', 'gsplatSourceVS', 'gsplatQuatToMat3VS']) {
        if (material.shaderChunks.wgsl.get(name)) return false;
    }
    const custom = material.shaderChunks.wgsl.get('gsplatModifyVS');
    return !custom || custom.trim() === modifySource.trim();
}

export class StaticCovarianceCache {
    constructor(device) { this.device=device; this.rebuilds=0; }
    update(workBuffer, ids, count, capacity, textureSize, sourceChanged) {
        const version=workBuffer.questGeometryVersion ?? 0;
        const format=workBuffer.format;
        let rebuild=sourceChanged || workBuffer!==this.workBuffer || version!==this.version;
        if (!this.output || this.output.byteSize < capacity*32) {
            this.output?.destroy();
            this.output=new StorageBuffer(this.device,capacity*32,BUFFERUSAGE_COPY_SRC);
            rebuild=true;
        }
        if (this.format !== format || this.formatKey !== format.hash) {
            this.compute?.destroy();this.shader?.destroy();this.bindFormat?.destroy();
            this.format=format;this.formatKey=format.hash;
            this.uniformFormat=new UniformBufferFormat(this.device,[new UniformFormat('splatTextureSize',UNIFORMTYPE_UINT),new UniformFormat('questCount',UNIFORMTYPE_UINT)]);
            this.bindFormat=new BindGroupFormat(this.device,[
                new BindStorageBufferFormat('questIds',SHADERSTAGE_COMPUTE,true),
                new BindStorageBufferFormat('questCovariance',SHADERSTAGE_COMPUTE,false),
                new BindUniformBufferFormat('uniforms',SHADERSTAGE_COMPUTE),
                ...format.getComputeBindFormats()
            ]);
            this.shader=new Shader(this.device,{name:'QuestStaticCovariance',shaderLanguage:SHADERLANGUAGE_WGSL,
                computeBindGroupFormat:this.bindFormat,computeUniformBufferFormats:{uniforms:this.uniformFormat},
                cshader:`
#include "halfTypesCS"
@group(0) @binding(0) var<storage, read> questIds: array<u32>;
@group(0) @binding(1) var<storage, read_write> questCovariance: array<vec4f>;
struct Parameters { splatTextureSize: u32, questCount: u32 };
@group(0) @binding(2) var<uniform> uniforms: Parameters;
struct Splat { index: u32, uv: vec2i };
var<private> splat: Splat;
${format.getComputeInputDeclarations(3)}
${format.getReadCode()}
${quaternionSource}
${covarianceFunction}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
    let i=gid.x+gid.y*groups.x*256u;
    if(i>=uniforms.questCount){return;}
    let id=questIds[i];
    splat.index=id;
    splat.uv=vec2i(i32(id%uniforms.splatTextureSize),i32(id/uniforms.splatTextureSize));
    let center=getCenter();
    let rotation=getRotation().yzwx;
    let scale=getScale();
    var a:vec3f;var b:vec3f;
    computeCovariance(half4(rotation.wxyz),half3(scale),&a,&b);
    questCovariance[id*2u]=vec4f(a,0.0);
    questCovariance[id*2u+1u]=vec4f(b,0.0);
}`});
            this.compute=new Compute(this.device,this.shader,'QuestStaticCovariance');
            rebuild=true;
        }
        if (rebuild) {
            this.compute.setParameter('questIds',ids);this.compute.setParameter('questCovariance',this.output);
            this.compute.setParameter('splatTextureSize',textureSize);this.compute.setParameter('questCount',count);
            for(const stream of format.resourceStreams)this.compute.setParameter(stream.name,workBuffer.getTexture(stream.name));
            const groups=Math.ceil(count/256),limit=this.device.limits.maxComputeWorkgroupsPerDimension;
            this.compute.setupDispatch(Math.min(groups,limit),Math.ceil(groups/limit),1);
            this.device.computeDispatch([this.compute],'QuestStaticCovariance');
            this.workBuffer=workBuffer;this.version=version;this.rebuilds++;
        }
        return this.output;
    }
    destroy(){this.output?.destroy();this.compute?.destroy();this.shader?.destroy();this.bindFormat?.destroy();}
}
