# Quest static WebGPU experiment

This separate build reuses the authoritative NextPlayer entry point, controls,
styles and asset loading. NGTY's existing 3D player setting selects it through
`/next-player-experimental/`; the regular NextPlayer remains available separately.
Generated files and raw device measurements live in the ignored
`NextPlayer/experimental-builds/quest-static/` directory.

From `NextPlayer`, run `npm run build:quest-experiment`. The default experimental
variant is `static-cov-subgroup2-triangle`; `experiment.json` lists comparison modes.
The normal `npm run build` remains unchanged.

For deployment, commit the player source, then run
`npm run build:quest-experiment -- --publish`. This writes the release bundle to
`webapp/public/next-player-experimental`, without the offline verification helpers.
Commit those generated release artifacts with the NGTY launcher changes, then
deploy that frontend commit using the existing Compose service. The manifest and
player diagnostics include the source commit, and the script URL uses the bundle
content hash. Unsupported GPUs and non-static media use the standard renderer
within the shared player; the diagnostics identify which path is active.

## Current default: movement and perceptual optimization, 30 October

The existing Experimental option now uses 24-bit depth keys (six radix passes
instead of eight), reuses radial depth order within 4 mm of translation, and
trims low-weight triangle caps on small projected splats. The triangle extent
starts at 0.8 and smoothly returns to 1 between projected radii of 12 and 48 px.
Scaling UVs before constructing the vertex offset avoids extra per-vertex work.
Both eyes still use the current pose every frame. Scene/model changes invalidate
ordering immediately. Non-radial sorting retains its 1 mm movement threshold.
These are measured perceptual approximations, not mathematically lossless changes.

| Scene / mode | Previous published experiment | Current default |
| --- | ---: | ---: |
| Original, VR stationary | 24.81 ms / 40.31 FPS | 23.18 ms / 43.15 FPS |
| Original, VR simulated movement | 34.27 ms / 29.18 FPS | 25.64 ms / 39.01 FPS |
| Dense, VR stationary | 49.29 ms / 20.29 FPS | 42.16 ms / 23.72 FPS |
| Dense, VR simulated movement | 58.65 ms / 17.05 FPS | 46.76 ms / 21.38 FPS |
| Dense, AR stationary | 62.47 ms / 16.01 FPS | 54.57 ms / 18.33 FPS |
| Dense, AR simulated movement | 75.86 ms / 13.18 FPS | 61.94 ms / 16.14 FPS |

VR movement gains are approximately **34% on the original and 25% on the dense
scene**. AR movement improves about **22%**. This does not meet a 2x gain over
the preceding experiment or the headset's refresh rate. These remain off-head,
five-second-warmup / 17-second-sample tests, not a worn comfort assessment.
The original VR-motion and dense AR-motion references were repeated with the
previous settings during this investigation; the other references are recorded
in the preceding release evidence. All runs keep all splats, 1680x1760 per eye,
alpha cutoff 1/255, and zero contribution culling/foveation.

Frozen comparisons cover both scenes, shifted/closer views, both native Quest
eye projections and a stale 4 mm sort origin with an unchanged render pose.
RGB RMS stays below 0.40 on an 8-bit scale (over 56 dB PSNR). Native-eye images
have fewer than 0.02% of pixels differing by more than four RGB levels, although
isolated RGB and alpha differences reach 26 levels. Reference repeats are exact.
These measurements support the perceptual choice on these scenes; they do not
prove invisibility for every scene, passthrough background, or head movement.
Large splats retain their full footprint. The exact covariance cache remains
pixel-identical under the existing scaled-model check. All 64 radix permutation
cases pass, spanning the full 16/20/24/32-bit range, explicit IDs and partial groups.
Standard-renderer capability fallback disables the new settings.

Several investigated alternatives were removed after measurement:

| Experiment | Observed reason to reject |
| --- | --- |
| GPU visibility compaction | 99.73% of dense-scene splats remained visible; added work made it slower |
| Sorted center/color/covariance cache | Small stationary gain, but movement regressed to 62.04 ms |
| Polynomial Gaussian evaluation | Dense stationary frame time worsened to 58.85 ms |
| Adaptive 50% splat merging with current SplatTransform | Image RMS 1.87, max 71, about 4.8% of pixels over four levels |
| 20-bit depth ordering | Larger image differences than the chosen 24-bit keys |

Research included [TileGS](https://arxiv.org/html/2609.03613),
[Gaussian Point Splatting](https://www.momentsingraphics.de/Siggraph2026.html),
[opacity-based occlusion culling](https://diglib.eg.org/items/e87f07bc-8702-4c07-aabf-b4bc205a75b1),
[WebSplatter](https://websplatter.github.io/), and the current
[PlayCanvas SplatTransform](https://github.com/playcanvas/splat-transform).
Tile-local ordering and opacity-aware culling remain relevant architectural
directions. Published CUDA/native desktop speedups are not Quest WebGPU results;
stochastic point rendering and asset simplification also introduce quality tradeoffs.
No paper's claimed speedup is counted in the table above.

The QA runner now ends sessions through the engine's `app.xr.end`, which releases
the WebGPU presentation binding, instead of calling the native session directly.
Two native browser crashes earlier in testing were excluded; subsequent VR and
AR runs completed without captured GPU/JavaScript errors. This is a corrected
test lifecycle, not proof that all native browser crashes are fixed.
Compact timing and image evidence is in
[measurements-20261030-perceptual.json](measurements-20261030-perceptual.json).
For an A/B reference, use `support=1&sortbits=32&sortdistance=0.001`; ordinary
Experimental launches require no query settings and select the current default.

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

## Follow-up on 30 October 2026

The optional `static-cov-subgroup2-triangle` variant caches each splat's static
covariance on the GPU. It uses the same baked data and half/f32 calculations as
the vertex shader, storing six f32 values in two aligned vectors. Geometry
revisions rebuild the cache; camera movement continues to project both eyes
without rebuilding it. Custom shape shaders and 2DGS retain their original path.

| Scene and motion | Existing static WebGPU | With covariance cache |
| --- | ---: | ---: |
| Original, stationary | 26.80–27.43 ms / 36.45–37.31 FPS | 26.11–26.40 ms / 37.88–38.30 FPS |
| New denser scene, stationary | 55.10–55.85 ms / 17.90–18.15 FPS | 53.44 ms / 18.71 FPS |
| New denser scene, simulated translation | 65.67 ms / 15.23 FPS | 63.77 ms / 15.68 FPS |

The denser scene has 1,175,708 splats, almost the same count as the original, but
its draw stage costs more than twice as much. Its WebGL reference measured
59.81 ms / 16.72 FPS; returning to quads measured 69.79 ms / 14.33 FPS. The
cache is a small additional gain, roughly 3–5% in these comparisons. It costs
about **36 MiB** per scene. It is now enabled in the experimental option requested
as NGTY's default; the regular NextPlayer option remains available. All runs retain
the quality settings above.

Frozen image comparisons at 1680 × 1760 are pixel-identical with caching on/off,
including after model scaling, on both scenes. Checks also cover cache reuse
during camera movement, rebuilds after model changes, preservation of a custom
corner shader, and all 1,175,708 sorted IDs in the denser scene. Comparison
helpers freeze navigation updates as well as sort order: otherwise camera
easing can change even consecutive reference images.

Early opacity rejection and flat-color/linear-UV interpolation did not improve
the measured workload and were removed. The runner now checks compiled shader
code to ensure the requested optimization actually ran. An initial inactive
cache branch was excluded from the evidence. Compact results and validation are
in [measurements-20261030.json](measurements-20261030.json).

One motion attempt hit a native Meta Browser SIGSEGV in `VrShellGL.OVRMo`. Its
cause is unresolved; it yielded no accepted timing. The browser was recovered
remotely, and later XR runs, including motion, completed without captured GPU
or JavaScript errors. This experimental browser path is not yet a production
reliability claim.

## What changed

### Published default and further measurements, 30 October

The existing NGTY **3D player** selector contains **Experimental**, and the
account setting is saved on the server. Its static-scene launcher uses the normal
HTTPS origin at `/next-player-experimental/`, with a visible experimental label
and source revision. Streamed animation and textured splats keep their existing
renderer path. Publication now rejects uncommitted NextPlayer source.

Two additional changes reduce draw overhead: batches contain 2,048 splats instead
of 128, and this splat-only player skips depth testing against an untouched clear
buffer. All surviving splat fragments already passed that test; the scene has no
opaque depth-writing meshes. This depth choice must not be copied into a mixed
mesh/splat scene without restoring depth testing. `batch=128&depth=on` reproduces
the previous draw state for comparison.

| Scene / mode | Previous experiment | Updated experiment |
| --- | ---: | ---: |
| Original, VR stationary | 26.11–26.40 ms / 37.88–38.30 FPS | 24.81 ms / 40.31 FPS |
| Dense, VR stationary | 53.44 ms / 18.71 FPS | 49.29 ms / 20.29 FPS |
| Dense, VR simulated translation | 63.77 ms / 15.68 FPS | 58.65 ms / 17.05 FPS |
| Dense, AR stationary | 68.43 ms / 14.61 FPS | 62.47 ms / 16.01 FPS |

The original scene now exceeds 2× its original WebGPU result (19.16 FPS), but
the dense scene does **not** meet a 2× target. Against its WebGL reference of
16.72 FPS, the updated dense VR result is about 21% faster. These stationary and
motion cases remain distinct; no worn-headset comfort claim is made.

The new draw state is pixel-identical to the previous state in frozen 1680×1760
comparisons on both scenes, including model translation/scaling. The capability
fallback now selects radix shader source, dispatch sizing and index counts after
capability detection, rather than capturing the requested configuration at module
initialization. A forced standard-renderer run on Quest and all 24 sort permutation
cases passed with zero captured GPU/JavaScript errors.

The current official **PlayCanvas 2.23.3** package was also benchmarked separately,
using the same authoritative NextPlayer entry point and no engine patches:
66.04 ms / 15.14 FPS on the dense scene, versus 66.45 ms / 15.05 FPS for the
standard 2.21.3 fallback. Its substantial renderer/CPU changes did not materially
improve this GPU-heavy workload. The tested experimental release therefore keeps
the pinned engine. Branchless fragment predication and smaller/larger batch
experiments were slower and removed. A shader-compilation failure produced an
invalid 90 FPS reading; it is explicitly excluded, not counted as a gain.

Compact evidence and research findings are in
[measurements-20261030-release.json](measurements-20261030-release.json).

### Renderer changes

1. **Sort stable IDs when needed.** The static path keeps source centers and IDs
   resident on the GPU. It reuses the order during rotation and sorts again after
   translation, scene changes, or object transforms. Both eyes still project and
   cull on every frame. Transform changes upload matrices, not the full centers
   array. The initial release used 1 mm and all 32 depth-key bits; the current
   defaults and measured approximation bounds are documented above. Equal-key
   ordering stays stable. The standard textured renderer retains its color data.
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

- Stable permutation tests cover 16-, 20-, 24- and 32-bit keys, supplied IDs, ties,
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
vertex deformation are outside its validated scope. Results now cover two scenes;
large screen-filling splats can trade the triangle's reduced vertex work for more
fragment work. More scenes and worn-headset assessment are needed before claiming
general performance or production stability. WebGPU XR still requires the headset's enabled
XR binding/layer flags in this browser installation.

The unsuccessful 8-bit radix, packed-read, reordered projection-cache and cached
clip-radius variants were removed from the maintained code after measurement.

## Reproduce without changing the server

Use the project's existing Quest launcher and a separate authenticated HTTPS tab
at `/next-player-experimental/index.html?quest-benchmark=1&content=...`.
The runner requires that exact CDP target ID and benchmark marker. It intercepts
only that page's `main.js`; the user's ordinary player tab and server remain
unchanged. If the selected LAN development origin shows its known private-CA
interstitial, the runner acknowledges that origin through the normal browser UI
once. It does not toggle debugger certificate overrides or disable TLS checking
globally. No SSH tunnel, localhost URL or copied cookie is needed.

```sh
npm run build:quest-experiment
node experiments/quest-static/run-quest.mjs TARGET_ID baseline 52888
node experiments/quest-static/run-quest.mjs TARGET_ID webgl 52888
node experiments/quest-static/run-quest.mjs TARGET_ID static-subgroup2-triangle 52888 --verify
node experiments/quest-static/run-quest.mjs TARGET_ID static-subgroup2-triangle 52888 --motion
node experiments/quest-static/run-quest.mjs TARGET_ID static-cov-subgroup2-triangle 52888
node experiments/quest-static/run-quest.mjs TARGET_ID static-cov-subgroup2-triangle 52888 --ar
node experiments/quest-static/run-quest.mjs TARGET_ID static-cov-subgroup2-triangle 52888 --standard --verify
```

After an experimental static run, invoke `__emsQuestVerifyImage()` and
`__emsQuestVerifyStaticOrder()` through that exact target's CDP Runtime.evaluate
with `awaitPromise` and `returnByValue`. Both restore their temporary camera and
renderer changes. Raw measurements are saved separately from the source;
`measurements.json` keeps the compact final evidence without scene imagery.

For the cache variant, also invoke `__emsQuestVerifyGeometry()`. The optional
`--flat` runner flag is for nonimmersive diagnostics and labels its output
accordingly; it must not be reported as an XR benchmark.

Use `__emsQuestVerifyImage(1680,1760,'draw-state')` to compare the current batches
and depth state with 128-splat batches and enabled depth testing. To benchmark an
unmodified engine release, unpack its official npm package into a research folder,
run `node experiments/quest-static/build-stock.mjs PATH_TO_PACKAGE`, then pass
`--bundle experimental-builds/quest-stock/main.js` to the runner with `baseline`.
This does not change application dependencies or publish the comparison build.

The root `scripts/quest-browser.ps1` launcher supports `-Unattended -Restart`,
`-DeviceSerial`, `-DebuggerPort`, `-ReversePort`, and `-Url`. Direct app launch,
clean restart, and repeated XR start/end were verified off-head. Keep USB/power
connected and the cameras facing a lit room. A lost-tracking Guardian dialog can
block XR even while CDP remains responsive. The normal HTTPS account session
persists through browser restarts. A stale native XR state
required one clean restart, not additional browser feature flags.

Research references: [WebSplatter](https://arxiv.org/html/2602.03207v1),
[GPU sorting implementations and portability notes](https://github.com/b0nes164/GPUSorting),
[WebGPU subgroups proposal](https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroups.md),
and the [CUDA Gaussian rasterizer analysis](https://grgkopanas.github.io/3dgs_cuda_blog/).
The measured improvements here come from the implementation and device runs above;
speedups reported by other renderers were not treated as Quest benchmarks.
