# Quest static WebGPU experiment

This separate build reuses the authoritative NextPlayer entry point, controls,
styles and asset loading. It does not modify the production build or deployment.
Generated files and raw device measurements live in the ignored
`NextPlayer/experimental-builds/quest-static/` directory.

From `NextPlayer`, run `npm run build:quest-experiment`. The default experimental
variant is `static-subgroup2-triangle`; `experiment.json` lists comparison modes.
The normal `npm run build` remains unchanged.

## Result on Quest 3, 29 October 2026

One static scene, **1,174,066 splats**, **1680 × 1760 per eye**, alpha cutoff
**1/255**, no contribution culling or foveation. Meta Browser
154.1.0.32.54.1101200317 / Chromium 154.0.8037.126, PlayCanvas 2.21.3.

| Renderer | Mean frame time | FPS | p95 frame time |
| --- | ---: | ---: | ---: |
| WebGPU hybrid baseline | 52.19 ms | 19.16 | 54.0 ms |
| WebGL CPU sort baseline | 32.63 ms | 30.64 | 34.8 ms |
| Experimental WebGPU, stationary | about 27 ms | about 37 | about 28 ms |
| Experimental WebGPU, continuous simulated translation | 36.57 ms | 27.35 | 40.0 ms |

The stationary result is approximately **1.94× the original WebGPU FPS** and
**21% above WebGL**. It is not a claim of 37 FPS during continuous translation.
The motion run moves the camera ±5 cm sinusoidally through the real XR update
and draw path. It performed 376 fresh GPU sorts across 452 measured frames.
These are off-head headset measurements, not a worn-headset comfort assessment.
Each run warms up for five seconds before sampling for approximately 17 seconds.
GPU clocks were observed at 545 MHz; Android thermal status ranged from 0 to 1
over the investigation. No clocks or thermal controls were overridden.

## What changed

1. **Sort stable IDs when needed.** The static path keeps source centers and IDs
   resident on the GPU. It reuses the order during rotation and sorts again after
   translation, scene changes, or object transforms. Both eyes still project and
   cull on every frame. Transform changes upload matrices, not the full centers
   array. The movement threshold matches the existing CPU sorter's 1 mm policy.
   Depth keys retain all 32 bits of the computed float depth ordering; ties remain
   stable. The standard textured splat renderer retains its original color data.
2. **Use subgroup voting for radix scatter.** The Quest's 64/128-lane subgroups
   replace the shared atomic bitmasks. Two rounds per workgroup were fastest in
   the measured useful configurations. The hybrid reorder stage fell from about
   9.95 ms to 3.5 ms. This has no inter-workgroup spin waiting and explicitly
   rejects incompatible subgroup capabilities rather than silently corrupting
   the output.
3. **Draw one enclosing triangle per Gaussian.** The triangle contains the full
   Gaussian disk. Fragment evaluation, alpha threshold and blending are unchanged.
   The hybrid draw stage fell from about 29.6 ms to 21 ms. The stationary static
   path draws in about 23 ms, with no recurring projection/compaction/sort passes.

Two pinned-engine defects were also corrected inside this build:

- At XR entry, an active session could have an empty eye-view array. Uniform setup
  skipped the view bind group, while drawing took the ordinary camera path. Both
  now use the same nonempty-view condition. This eliminated three transient GPU
  validation errors on session entry.
- Radix sorting with caller-supplied IDs swapped that input into the output
  ping-pong, while `sortedIndices` returned an untouched internal buffer. Outputs
  now stay in the owned buffers, and caller input is preserved.

The build also incorporates the uniform atomic participation correction from
[PlayCanvas PR 9756](https://github.com/playcanvas/engine/pull/9756).
Guarded build-time transformations fail if the pinned engine source changes;
they never edit `node_modules` or production bundles.

## Validation and limits

- Stable permutation tests cover 16-, 20- and 32-bit keys, supplied IDs, ties,
  partial workgroups, and counts from 1 to 200,003.
- Full-scene checks validate all 1,174,066 IDs before and after translation:
  no missing/duplicate splats, monotonic depth keys and stable equal-key order.
- Invalidation checks exercise stationary reuse, rotation reuse, camera
  translation, and object movement without reuploading all source positions.
- The image comparison freezes the same projection/order and swaps only geometry.
  Reference repeats are pixel-identical. Triangle rasterization differs slightly
  because interpolation changes: approximately 0.30 RGB levels RMS on a 0–255
  scale, maximum 4 levels, about 58.5 dB PSNR. This is not a bit-identical renderer
  or a claim that different depth quantizations produce identical images.
- Final measured XR runs have zero captured JavaScript or GPU validation errors.
  Broken shader runs and invalid timestamp queries were excluded.

This remains a **static-scene, Quest-specific experiment**. Animation and custom
vertex deformation are outside its validated scope. Results are from one scene;
large screen-filling splats can trade the triangle's reduced vertex work for more
fragment work. Multi-scene and worn-headset assessment are needed before making
it the general production default. WebGPU XR still requires the headset's enabled
XR binding/layer flags in this browser installation.

The unsuccessful 8-bit radix, packed-read, reordered projection-cache and cached
clip-radius variants were removed from the maintained code after measurement.

## Reproduce without changing the server

Use the project's existing Quest launcher and an authenticated localhost test
tab through the existing SSH/ADB tunnel. The runner requires its exact CDP target
ID and refuses unrelated origins. It intercepts only that page's `main.js` response
with the experimental bundle; server files remain unchanged.

```sh
npm run build:quest-experiment
node experiments/quest-static/run-quest.mjs TARGET_ID baseline 52888
node experiments/quest-static/run-quest.mjs TARGET_ID webgl 52888
node experiments/quest-static/run-quest.mjs TARGET_ID static-subgroup2-triangle 52888 --verify
node experiments/quest-static/run-quest.mjs TARGET_ID static-subgroup2-triangle 52888 --motion
```

After an experimental static run, invoke `__emsQuestVerifyImage()` and
`__emsQuestVerifyStaticOrder()` through that exact target's CDP Runtime.evaluate
with `awaitPromise` and `returnByValue`. Both restore their temporary camera and
renderer changes. Raw measurements are saved separately from the source;
`measurements.json` keeps the compact final evidence without scene imagery.

Research references: [WebSplatter](https://arxiv.org/html/2602.03207v1),
[GPU sorting implementations and portability notes](https://github.com/b0nes164/GPUSorting),
[WebGPU subgroups proposal](https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroups.md),
and the [CUDA Gaussian rasterizer analysis](https://grgkopanas.github.io/3dgs_cuda_blog/).
The measured improvements here come from the implementation and device runs above;
speedups reported by other renderers were not treated as Quest benchmarks.
