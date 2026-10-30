import './player-entry.mjs';
import './verify-image.mjs';
import './verify-static.mjs';
import './verify-geometry.mjs';
import { StorageBuffer } from 'playcanvas/build/playcanvas/src/platform/graphics/storage-buffer.js';
import { ComputeRadixSort } from 'playcanvas/build/playcanvas/src/scene/graphics/radix-sort/compute-radix-sort.js';
import { BUFFERUSAGE_COPY_SRC, BUFFERUSAGE_COPY_DST } from 'playcanvas';

// A device-side correctness check, run on demand by the external test runner.
// It checks the stable permutation, not only sorted key values: duplicate or
// missing splats would otherwise look like a performance improvement.
globalThis.__emsQuestVerifySort = async (counts = [1, 127, 255, 256, 257, 2047, 2049, 200003]) => {
    const { app } = await document.querySelector('pc-app').ready();
    if (app.xr.active) throw new Error('End XR before running the isolated sort check.');
    const device = app.graphicsDevice;
    if (!device.isWebGPU) throw new Error('The sort check requires WebGPU.');
    const autoRender = app.autoRender;
    app.autoRender = false;
    const results = [];
    try {
        for (const bits of [16, 20, 32]) for (const count of counts) {
            const keys = new Uint32Array(count);
            let seed = 12345;
            for (let i = 0; i < count; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; keys[i] = bits === 32 ? seed : (seed >>> 12) & ((1 << bits) - 1); }
            const expected = Array.from({ length: count }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
            const buffer = new StorageBuffer(device, keys.byteLength, BUFFERUSAGE_COPY_SRC | BUFFERUSAGE_COPY_DST);
            const sorter = new ComputeRadixSort(device);
            const labels = new Uint32Array(count).map((_,i)=>count-i+100);
            const values = bits === 32 ? new StorageBuffer(device, labels.byteLength, BUFFERUSAGE_COPY_SRC | BUFFERUSAGE_COPY_DST) : null;
            try {
                buffer.write(0, keys);
                values?.write(0, labels);
                const output = sorter.sort(buffer, count, bits, values ?? undefined, true);
                device.submit();
                const bytes = await output.read(0, count * 4, null, true);
                const actual = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
                let mismatch = -1;
                for (let i = 0; i < count; i++) if (actual[i] !== (values ? labels[expected[i]] : expected[i])) { mismatch = i; break; }
                results.push({ count, bits, mismatch });
                if (mismatch >= 0) throw new Error(`GPU sort permutation mismatch at ${mismatch} of ${count}`);
                if (values) {
                    const sourceBytes = await values.read(0, count * 4, null, true);
                    const sourceValues = new Uint32Array(sourceBytes.buffer, sourceBytes.byteOffset, count);
                    for (let i = 0; i < count; i++) if (sourceValues[i] !== labels[i]) throw new Error('GPU sort mutated caller-supplied IDs.');
                }
            } finally { sorter.destroy(); buffer.destroy(); values?.destroy(); }
        }
        return results;
    } finally { app.autoRender = autoRender; }
};
