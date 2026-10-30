// Isolated, guarded transformations of the pinned MIT-licensed engine.
// No edits to node_modules, generated production bundles, or the shared UI.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const subgroupReorder = readFileSync(new URL('./subgroup-reorder.wgsl', import.meta.url), 'utf8');
const configId = '\0quest-static-config';
export const variants = ['baseline', 'subgroup', 'subgroup2', 'subgroup2-triangle', 'static-subgroup2', 'static-subgroup2-triangle', 'static-cov-subgroup2-triangle', 'cpu', 'webgl'];
const configSource = `
const variant = new URL(location.href).searchParams.get('experiment') || 'static-cov-subgroup2-triangle';
if (!${JSON.stringify(variants)}.includes(variant)) throw new Error('Unknown Quest experiment: '+variant);
export let rounds = variant.includes('subgroup2') ? 2 : 8;
export let subgroup = variant.includes('subgroup');
export let staticGpu = variant.startsWith('static-');
export let triangles = variant.endsWith('-triangle');
export let covarianceCache = variant.includes('-cov-');
const requestedBatch = Number(new URL(location.href).searchParams.get('batch')) || 2048;
if (![128,2048].includes(requestedBatch)) throw new Error('Invalid experimental batch size');
export let batchSize = 128;
export let depthTest = true;
globalThis.__emsQuestExperiment = { variant, rounds, subgroup, triangles, staticGpu, covarianceCache, batchSize, depthTest, engine: '2.21.3', production: false };
globalThis.__emsConfigureQuestExperiment = (device, staticScene) => {
    const supported = device.isWebGPU && device.supportsSubgroups && device.supportsSubgroupId && device.minSubgroupSize >= 64 && device.maxSubgroupSize <= 128;
    subgroup = subgroup && supported;
    staticGpu = staticGpu && supported && staticScene;
    triangles = triangles && supported && staticScene;
    covarianceCache = covarianceCache && staticGpu;
    batchSize = staticGpu ? requestedBatch : 128;
    depthTest = !staticGpu || new URL(location.href).searchParams.get('depth') === 'on';
    if (!subgroup) rounds = 8;
    Object.assign(globalThis.__emsQuestExperiment, {rounds, subgroup, staticGpu, triangles, covarianceCache, batchSize, depthTest,
        reason: staticGpu ? 'Static GPU renderer' : !staticScene ? 'Standard renderer for this media type' : !supported ? 'Standard renderer for this GPU' : 'Comparison renderer'});
};
`;

function replaceOnce(code, from, to, label) {
    if (!code.includes(from) || code.indexOf(from) !== code.lastIndexOf(from)) throw new Error(`Pinned engine changed: ${label}`);
    return code.replace(from, to);
}

export function questEngineExperiment({ build = 'development', published = false } = {}) {
    return {
        name: 'quest-static-experiment',
        resolveId(id) {
            if (id === 'quest-static-config') return configId;
            if (id === 'quest-static-renderer') return fileURLToPath(new URL('./static-gpu-renderer.mjs', import.meta.url));
        },
        load(id) {
            if (id === configId) return configSource + `\nglobalThis.__emsQuestExperiment.build = ${JSON.stringify(build)};\nglobalThis.__emsQuestExperiment.published = ${published};`;
        },
        transform(code, id) {
            id = id.replaceAll('\\', '/');
            if (!id.includes('/node_modules/playcanvas/')) return null;
            if(id.endsWith('/gsplat-work-buffer.js')) {
                code=replaceOnce(code,'this.renderPass.render();','this.renderPass.render();\n            this.questGeometryVersion = (this.questGeometryVersion || 0) + 1;','geometry revision');
                return {code,map:null};
            }
            if (id.endsWith('/scene/renderer/renderer.js')) {
                // Match ForwardRenderer while waiting for the first XR views.
                // An empty array otherwise skips binding the view uniform group.
                code = replaceOnce(code, 'if (camera.xrActive) {\n\t\t\tviewList = camera.xrViews;',
                    'if (camera.xrActive && camera.xrViews.length) {\n\t\t\tviewList = camera.xrViews;', 'XR first-view uniforms');
                return { code, map: null };
            }
            if (id.endsWith('/gsplat-manager.js')) {
                code = replaceOnce(code, 'new GSplatHybridRenderer(this.device,', 'new (questStaticGpu ? QuestStaticGpuRenderer : GSplatHybridRenderer)(this.device,', 'static renderer');
                return { code: `import { staticGpu as questStaticGpu } from 'quest-static-config';\nimport { QuestStaticGpuRenderer } from 'quest-static-renderer';\n${code}`, map: null };
            }
            if (id.endsWith('/gsplat-resource-base.js')) {
                code = replaceOnce(code, 'static get instanceSize() {\n\t\treturn 128;', 'static get instanceSize() {\n\t\treturn questBatchSize;', 'instance batch size');
                code = replaceOnce(code, '\tstatic createMesh(device) {', `\tstatic createMesh(device) {
        if (questTriangles) {
            // The unit Gaussian disk is inscribed in this triangle. Fragment
            // evaluation, alpha cutoff and blending remain unchanged.
            const size = GSplatResourceBase.instanceSize;
            const positions = new Float32Array(size * 9);
            const indices = new Uint32Array(size * 3);
            for (let i = 0; i < size; i++) {
                positions.set([0, 2, i, -Math.sqrt(3), -1, i, Math.sqrt(3), -1, i], i * 9);
                indices.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
            }
            const mesh = new Mesh(device);
            mesh.setPositions(positions, 3); mesh.setIndices(indices); mesh.update();
            return mesh;
        }`, 'triangle geometry');
                return { code: `import { triangles as questTriangles, batchSize as questBatchSize } from 'quest-static-config';\n${code}`, map: null };
            }
            if (id.endsWith('/gsplat-projector.js')) {
                code = replaceOnce(code, 'const INDEX_COUNT = 6 * GSplatResourceBase.instanceSize;', '', 'static index count');
                code = replaceOnce(code, 'compute.setParameter("indexCount", INDEX_COUNT);', 'compute.setParameter("indexCount", (questTriangles ? 3 : 6) * GSplatResourceBase.instanceSize);', 'runtime triangle draw count');
                return { code: `import { triangles as questTriangles } from 'quest-static-config';\n${code}`, map: null };
            }
            if (id.endsWith('/compute-radix-sort-multipass.js')) {
                code = replaceOnce(code, 'const ELEMENTS_PER_THREAD = 8;', '', 'static radix rounds');
                code = replaceOnce(code, 'const ELEMENTS_PER_WORKGROUP = THREADS_PER_WORKGROUP * ELEMENTS_PER_THREAD;', '', 'static radix workgroup size');
                code = code.replaceAll('ELEMENTS_PER_THREAD', 'this._questElementsPerThread').replaceAll('ELEMENTS_PER_WORKGROUP', 'this._questElementsPerWorkgroup');
                code = code.replaceAll('{this._questElementsPerThread}', '{ELEMENTS_PER_THREAD}').replaceAll('{this._questElementsPerWorkgroup}', '{ELEMENTS_PER_WORKGROUP}');
                code = replaceOnce(code, '\t\t\t\tradixSortReorderSource,', `\t\t\t\tquestSubgroup ? ${JSON.stringify(subgroupReorder)} : radixSortReorderSource,`, 'runtime subgroup shader');
                code = replaceOnce(code, '\t\tsuper(device, indirect);', `\t\tsuper(device, indirect);
        this._questElementsPerThread = questRounds;
        this._questElementsPerWorkgroup = THREADS_PER_WORKGROUP * questRounds;
        if (questSubgroup && (!device.supportsSubgroups || !device.supportsSubgroupId || device.minSubgroupSize < 64 || device.maxSubgroupSize > 128)) {
            throw new Error('This Quest experiment requires 64/128-lane subgroups and subgroup_id. Select experiment=baseline on other GPUs.');
        }`, 'subgroup capability guard');
                // Preserve caller-supplied IDs. The original swap writes into
                // them while sortedIndices returns an untouched owned buffer.
                code = replaceOnce(code, 'const tempValues = currentValues;\n\t\t\t\tcurrentValues = nextValues;\n\t\t\t\tnextValues = tempValues;',
                    'currentValues = nextValues;\n\t\t\t\tnextValues = currentValues === this._values0 ? this._values1 : this._values0;', 'initial value buffer ownership');
                return { code: `import { rounds as questRounds, subgroup as questSubgroup } from 'quest-static-config';\n${code}`, map: null };
            }
            // Upstream PR 9756: uniform atomic participation on Adreno.
            if (id.endsWith('/chunks/radix-sort/compute-radix-sort-4bit.js')) {
                code = replaceOnce(code,
                    '\t\tif (is_valid) {\n\t\t\tlet elm = input[GID];\n\t\t\tlet digit = (elm >> CURRENT_BIT) & 0xFu;\n\t\t\tatomicAdd(&histogram[digit], 1u);\n\t\t}',
                    '\t\tlet elm = input[select(0u, GID, is_valid)];\n\t\tlet digit = (elm >> CURRENT_BIT) & 0xFu;\n\t\tatomicAdd(&histogram[digit], select(0u, 1u, is_valid));', 'histogram atomics');
                return { code, map: null };
            }
            if (id.endsWith('/chunks/radix-sort/compute-radix-sort-reorder.js')) {
                code = replaceOnce(code, 'let digit = select(16u, (k >> CURRENT_BIT) & 0xFu, is_valid);', 'let digit = (k >> CURRENT_BIT) & 0xFu;', 'reorder digit');
                code = replaceOnce(code, '\t\tif (is_valid) {\n\t\t\tatomicOr(&digit_masks[digit * 8u + word_idx], 1u << bit_idx);\n\t\t}',
                    '\t\tatomicOr(&digit_masks[digit * 8u + word_idx], select(0u, 1u << bit_idx, is_valid));', 'reorder atomics');
                return { code, map: null };
            }
            if (id.endsWith('/chunks/gsplat/vert/gsplatHybrid.js')) {
                code = code.replace('export {', 'globalThis.__emsQuestRasterShaders = { baseline: gsplatHybrid_default, selected: gsplatHybrid_default };\nexport {');
                return { code, map: null };
            }
            return null;
        }
    };
}
