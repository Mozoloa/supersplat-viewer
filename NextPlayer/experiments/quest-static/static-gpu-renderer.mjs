import { GSplatQuadRenderer } from 'playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-quad-renderer.js';
import { GSplatResourceBase } from 'playcanvas/build/playcanvas/src/scene/gsplat/gsplat-resource-base.js';
import { ComputeRadixSort } from 'playcanvas/build/playcanvas/src/scene/graphics/radix-sort/compute-radix-sort.js';
import { Compute } from 'playcanvas/build/playcanvas/src/platform/graphics/compute.js';
import { Shader } from 'playcanvas/build/playcanvas/src/platform/graphics/shader.js';
import { StorageBuffer } from 'playcanvas/build/playcanvas/src/platform/graphics/storage-buffer.js';
import { BindGroupFormat, BindStorageBufferFormat, BindUniformBufferFormat } from 'playcanvas/build/playcanvas/src/platform/graphics/bind-group-format.js';
import { UniformBufferFormat, UniformFormat } from 'playcanvas/build/playcanvas/src/platform/graphics/uniform-buffer-format.js';
import { BUFFERUSAGE_COPY_SRC, BUFFERUSAGE_COPY_DST, SHADERLANGUAGE_WGSL, SHADERSTAGE_COMPUTE, UNIFORMTYPE_VEC4, UNIFORMTYPE_UINT } from 'playcanvas/build/playcanvas/src/platform/graphics/constants.js';
import { covarianceCache, depthTest } from 'quest-static-config';
import { StaticCovarianceCache, cachedCornerSource, uncachedCornerSource, permitsStaticGeometry } from './static-geometry.mjs';

// Static-scene experiment: GPU-sort stable world IDs only when the camera's
// sort parameters or the scene change. The normal vertex projection still runs
// on every frame for both eyes; visibility is never frozen with the sort order.
export class QuestStaticGpuRenderer extends GSplatQuadRenderer {
    constructor(...args) {
        super(...args);
        // This player loads sorted splats only; none writes depth. Every surviving
        // fragment passes the cleared depth buffer, so avoid the redundant read.
        this.material.depthTest = depthTest;
        this.sorter = new ComputeRadixSort(this.device);
        this.covarianceCache=covarianceCache ? new StaticCovarianceCache(this.device) : null;
        this.sourceState = null;
        this.sourceVersions = [];
        this.sourceUploads = 0;
        this.sortRuns = 0;
        this.lastPosition = [Infinity, Infinity, Infinity];
        this.lastDirection = [Infinity, Infinity, Infinity];
        this.origin = new Float32Array(4);
        this.direction = new Float32Array(4);
        this.format = new BindGroupFormat(this.device, [
            new BindStorageBufferFormat('questPositions', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('questKeys', SHADERSTAGE_COMPUTE, false),
            new BindStorageBufferFormat('questModels', SHADERSTAGE_COMPUTE, true),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.uniformFormat = new UniformBufferFormat(this.device, [
            new UniformFormat('questOrigin', UNIFORMTYPE_VEC4), new UniformFormat('questForward', UNIFORMTYPE_VEC4),
            new UniformFormat('questLength', UNIFORMTYPE_UINT), new UniformFormat('questRadial', UNIFORMTYPE_UINT)
        ]);
        this.keyShader = new Shader(this.device, { name: 'QuestStaticSortKeys', shaderLanguage: SHADERLANGUAGE_WGSL,
            computeBindGroupFormat: this.format, computeUniformBufferFormats: { uniforms: this.uniformFormat },
            cshader: `
@group(0) @binding(0) var<storage, read> questPositions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> questKeys: array<u32>;
@group(0) @binding(2) var<storage, read> questModels: array<mat4x4f>;
struct Parameters { questOrigin: vec4f, questForward: vec4f, questLength: u32, questRadial: u32 };
@group(0) @binding(3) var<uniform> uniforms: Parameters;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= uniforms.questLength) { return; }
    let position = questPositions[id.x];
    let worldPosition = questModels[u32(position.w)] * vec4f(position.xyz, 1.0);
    let delta = worldPosition.xyz - uniforms.questOrigin.xyz;
    let depth = select(dot(delta, uniforms.questForward.xyz), dot(delta, delta), uniforms.questRadial != 0u);
    let bits = bitcast<u32>(depth);
    let ordered = select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
    questKeys[id.x] = ~ordered;
}` });
        this.keyCompute = new Compute(this.device, this.keyShader, 'QuestStaticSortKeys');
        globalThis.__emsQuestStaticRenderer = this;
    }
    get usesGpuSort() { return true; }
    get requiresBounds() { return false; }
    prepareRenderView(world, state, params) {
        const count = state.totalActiveSplats;
        if (!count) { this.meshInstance.visible = false; return false; }
        const changed = state !== this.sourceState || state.splats.some((s,i)=>s.resource.centersVersion !== this.sourceVersions[i]);
        let modelsChanged = changed;
        for (let i=0; !modelsChanged && i<state.splats.length; i++) {
            const matrix=state.splats[i].node.getWorldTransform().data;
            for(let j=0;j<16;j++) if(matrix[j]!==this.modelMatrices[i*16+j]) { modelsChanged=true;break; }
        }
        if (changed) {
            this.cacheCapacity=0;
            const positions = new Float32Array(count * 4);
            const ids = new Uint32Array(count);
            let cursor = 0;
            for (let modelIndex=0; modelIndex<state.splats.length; modelIndex++) {
                const splat=state.splats[modelIndex];
                const centers = splat.resource.centers ?? splat.resource.gsplatData.getCenters();
                const intervals = splat.intervals.length ? splat.intervals : [0, splat.activeSplats];
                let packedOffset = splat.intervalOffsets[0];
                for (let interval=0; interval<intervals.length/2; interval++) {
                    const begin = intervals[interval*2], end = intervals[interval*2+1];
                    const offset = splat.intervalOffsets.length === intervals.length/2 ? splat.intervalOffsets[interval] : packedOffset;
                    for (let i=begin; i<end; i++,cursor++) {
                        const x=centers[i*3], y=centers[i*3+1], z=centers[i*3+2];
                        positions[cursor*4]=x;
                        positions[cursor*4+1]=y;
                        positions[cursor*4+2]=z;
                        positions[cursor*4+3]=modelIndex;
                        ids[cursor]=offset+i-begin;
                        this.cacheCapacity=Math.max(this.cacheCapacity,ids[cursor]+1);
                    }
                    packedOffset += end-begin;
                }
            }
            if (cursor !== count) throw new Error('Static GPU sort: world interval count mismatch.');
            if (this.count !== count) {
                this.positions?.destroy(); this.keys?.destroy(); this.ids?.destroy();
                const usage = BUFFERUSAGE_COPY_SRC | BUFFERUSAGE_COPY_DST;
                this.positions = new StorageBuffer(this.device,count*16,usage);
                this.keys = new StorageBuffer(this.device,count*4,usage);
                this.ids = new StorageBuffer(this.device,count*4,usage);
                this.count = count;
            }
            this.positions.write(0,positions); this.ids.write(0,ids);
            this.sourceState = state;
            this.sourceVersions = state.splats.map(s=>s.resource.centersVersion);
            this.sourceUploads++;
        }
        if (modelsChanged) {
            const byteSize=state.splats.length*64;
            if (!this.models || this.models.byteSize !== byteSize) {
                this.models?.destroy();
                this.models=new StorageBuffer(this.device,byteSize,BUFFERUSAGE_COPY_DST);
                this.modelMatrices=new Float32Array(state.splats.length*16);
            }
            state.splats.forEach((s,i)=>this.modelMatrices.set(s.node.getWorldTransform().data,i*16));
            this.models.write(0,this.modelMatrices);
        }
        if (this.covarianceCache && permitsStaticGeometry(params.material)) {
            const cache=this.covarianceCache.update(world.workBuffer,this.ids,count,this.cacheCapacity,state.textureSize,changed);
            this.material.setParameter('questCovariance',cache);
        }
        const position = params.cameraNode.getPosition(), forward = params.cameraNode.forward;
        // Match the existing CPU sorter's 1 mm / 0.001 rad invalidation policy.
        const translated = Math.hypot(position.x-this.lastPosition[0],position.y-this.lastPosition[1],position.z-this.lastPosition[2]) > 0.001;
        const rotated = !params.radialSorting && Math.hypot(forward.x-this.lastDirection[0],forward.y-this.lastDirection[1],forward.z-this.lastDirection[2]) > 0.001;
        if (changed || modelsChanged || translated || rotated || this.lastRadial !== params.radialSorting) {
            const xyz=[position.x,position.y,position.z],direction=[forward.x,forward.y,forward.z];
            this.origin.set(xyz); this.direction.set(direction);
            this.keyCompute.setParameter('questPositions',this.positions); this.keyCompute.setParameter('questKeys',this.keys);
            this.keyCompute.setParameter('questModels',this.models);
            this.keyCompute.setParameter('questOrigin',this.origin); this.keyCompute.setParameter('questForward',this.direction);
            this.keyCompute.setParameter('questLength',count); this.keyCompute.setParameter('questRadial',params.radialSorting?1:0);
            this.keyCompute.setupDispatch(Math.ceil(count/256),1,1);
            this.device.computeDispatch([this.keyCompute],'QuestStaticSortKeys');
            this.order = this.sorter.sort(this.keys,count,32,this.ids,true);
            this.lastPosition = xyz; this.lastDirection = direction; this.lastRadial = params.radialSorting;
            this.sortRuns++;
        }
        this.meshInstance.setIndirect(null,-1);
        this.meshInstance.instancingCount = Math.ceil(count/GSplatResourceBase.instanceSize);
        this.meshInstance.visible = true;
        this.material.setParameter('splatOrder',this.order);
        this.material.setParameter('numSplats',count);
        this.material.setParameter('splatTextureSize',state.textureSize);
        return true;
    }
    frameUpdate(params) {
        super.frameUpdate(params);
        if (!covarianceCache) return;
        const allowed=permitsStaticGeometry(params.material);
        let dirty=false;
        if(this.material.getDefine('QUEST_STATIC_COVARIANCE')!==allowed) {
            this.material.setDefine('QUEST_STATIC_COVARIANCE',allowed);dirty=true;
        }
        const corner=allowed ? cachedCornerSource : (params.material.hasShaderChunks && params.material.shaderChunks.wgsl.get('gsplatCornerVS')) || uncachedCornerSource;
        if(this.material.shaderChunks.wgsl.get('gsplatCornerVS')!==corner){this.material.shaderChunks.wgsl.set('gsplatCornerVS',corner);dirty=true;}
        if(dirty)this.material.update();
    }
    destroy() {
        this.covarianceCache?.destroy();
        this.sorter.destroy(); this.keyCompute.destroy(); this.keyShader.destroy(); this.format.destroy();
        this.positions?.destroy(); this.keys?.destroy(); this.ids?.destroy(); this.models?.destroy();
        if (globalThis.__emsQuestStaticRenderer === this) delete globalThis.__emsQuestStaticRenderer;
        super.destroy();
    }
}
