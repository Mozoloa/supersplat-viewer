# SuperSplat Viewer — Performance Optimization Specs

Each spec is standalone and can be implemented independently. Order is by priority (P0 first).

---

## SPEC-01: Pre-allocate Math Objects in XR Update Loop

**Priority**: P0 — Quick win, biggest frame-time improvement  
**Risk**: None  
**Files**: `src/xr.ts`

### Problem

Inside the `app.on('update')` callback (~runs at 72Hz in VR), we allocate new `Vec3` and `Quat` objects every frame:

- `new Vec3(0, -0.707, -0.707)` — ray direction (lines ~545, ~590)
- `new Vec3().cross()` — rotation axis calculation
- `new Quat().setFromAxisAngle()` — ray orientation
- `new Color(0.3, 0.3, 0.3)` — default ray color

On Quest, this creates GC pressure → microstutter every few seconds when garbage collector runs.

### Fix

Move all temporary math objects to module scope (same pattern PlayCanvas engine uses internally — see `xr-input-source.js` line 15: `const vec3A = new Vec3()`).

Specifically, add near the top of `initXr()` (after existing declarations):

```typescript
// Reusable math objects for hot loop (avoid GC pressure)
const _rayDir = new Vec3();
const _forward = new Vec3();
const _halfPos = new Vec3();
const _yAxis = new Vec3(0, 1, 0);
const _crossAxis = new Vec3();
const _rayQuat = new Quat();
const _defaultRayColor = new Color(0.3, 0.3, 0.3);
```

Then replace all `new Vec3(...)` / `new Quat()` / `new Color()` inside the update loop with these reusable instances (use `.set()` or `.copy()` to reset values each frame).

### Verification

- Open VR, grab/move splat, check no visual difference
- MiniStats: frame time should be more consistent (fewer spikes)

---

## SPEC-02: Cache gsplat Component List

**Priority**: P0 — Quick win  
**Risk**: Low — must invalidate on entity add/remove  
**Files**: `src/xr.ts`

### Problem

`app.root.findComponents('gsplat')` runs every frame during XR. This traverses the entire scene graph. With animated splats (many frame entities), this is especially wasteful.

### Fix

Cache the result. Invalidate when entities change.

```typescript
let cachedGsplatComponents: any[] | null = null;
let cachedGsplatDirty = true;

// Invalidate on entity changes
app.on('entity:add', () => { cachedGsplatDirty = true; });
app.on('entity:remove', () => { cachedGsplatDirty = true; });

// In the update loop, replace:
//   const gsplatComponents = app.root.findComponents('gsplat');
// With:
if (cachedGsplatDirty) {
    cachedGsplatComponents = app.root.findComponents('gsplat');
    cachedGsplatDirty = false;
}
const gsplatComponents = cachedGsplatComponents;
```

Also invalidate on `xr:start` and after `loadSplat` completes.

### Verification

- Animated splat in VR: frames still switch, grab still works
- Regular splat: grab/scale works
- Multi-splat: all splats grabbable

---

## SPEC-03: One-Time Stencil Setup

**Priority**: P0 — Quick win  
**Risk**: None  
**Files**: `src/xr.ts`

### Problem

Every frame, the update loop iterates ALL gsplat components and checks if stencil is already configured:

```typescript
for (const comp of gsplatComponents) {
    const gsplat = (comp.entity as any).gsplat;
    if (gsplat && gsplat.instance && gsplat.instance.meshInstance) {
        const mi = gsplat.instance.meshInstance;
        if (!mi.stencilFront || mi.stencilFront.func !== FUNC_ALWAYS) {
            // set stencil...
        }
    }
}
```

This is redundant work 99.9% of frames.

### Fix

Track which entities have had stencil configured using a `WeakSet`:

```typescript
const stencilConfigured = new WeakSet<Entity>();

// In the update loop, replace the stencil block with:
for (const comp of gsplatComponents) {
    if (stencilConfigured.has(comp.entity)) continue;
    const gsplat = (comp.entity as any).gsplat;
    if (gsplat?.instance?.meshInstance) {
        const mi = gsplat.instance.meshInstance;
        mi.stencilFront = new StencilParameters({
            func: FUNC_ALWAYS, ref: 1,
            fail: STENCILOP_REPLACE, zfail: STENCILOP_REPLACE, zpass: STENCILOP_REPLACE
        });
        mi.stencilBack = mi.stencilFront;
        stencilConfigured.add(comp.entity);
    }
}
```

Clear the set on `xr:end` and when loading new splats.

### Verification

- Tint plane (temperature correction) still only tints the splat, not background
- Toggle temperature in VR HUD, verify colored overlay only on splat

---

## SPEC-04: Conditional Ray Material Update

**Priority**: P1  
**Risk**: None  
**Files**: `src/xr.ts`

### Problem

`rayMat.update()` is called every frame for every controller even when the hovered splat hasn't changed. Material updates trigger shader recompilation checks.

### Fix

Track previous hovered state per-controller and only update when it changes:

```typescript
const prevHoveredPerController = new Map<any, string | null>();

// In the ray update section:
const prevHovered = prevHoveredPerController.get(inputSource) ?? null;
const currentHovered = hitInstance?.id || null;

if (currentHovered !== prevHovered) {
    if (rayMat) {
        rayMat.emissive = hitInstance ? hitInstance.color : _defaultRayColor;
        rayMat.update();
    }
    prevHoveredPerController.set(inputSource, currentHovered);
}
```

Clean up the map entries when controllers disconnect (in the stale ray cleanup block).

### Verification

- Point at splats in multi-splat mode, ray still changes color
- Point at nothing, ray is gray

---

## SPEC-05: Skip Invisible Marker Updates

**Priority**: P1  
**Risk**: None  
**Files**: `src/xr.ts`, `src/splat-manager.ts`

### Problem

`splatManager.updateMarkers()` is called every frame. Markers have `opacity: 0` — they're invisible. Their transforms are still being computed and applied for no visual benefit.

### Fix

Option A (simple): Only call `updateMarkers()` when markers are actually visible (i.e., when a ray is hovering and in multi-splat mode with >1 splat).

Option B (better): Add a flag to SplatManager:

```typescript
// In SplatManager:
private markersVisible = false;

setMarkersVisible(visible: boolean) {
    this.markersVisible = visible;
    // optionally toggle marker.enabled
}

updateMarkers() {
    if (!this.markersVisible) return;
    // ... existing logic
}
```

In xr.ts, only set `markersVisible = true` when `splatManager.count > 1`.

### Verification

- Multi-splat: marker logic still aids grabbing
- Single splat / animated: no marker overhead

---

## SPEC-06: Conditional Tint Plane

**Priority**: P1  
**Risk**: Low  
**Files**: `src/xr.ts`

### Problem

The tint plane entity (for temperature color correction) is always enabled during XR, even when temperature is 0 (neutral/no effect). The multiplicative blend material draws a full-screen plane every frame.

### Fix

Only enable `tintPlane` when `temperature !== 0`:

```typescript
// In the temperature adjustment section:
tintPlane.enabled = (temperature !== 0);

// On XR start, initialize:
tintPlane.enabled = false; // instead of true
```

Also disable on reset:

```typescript
// In the reset handler:
temperature = 0;
tintPlane.enabled = false;
```

### Verification

- VR: no visible change at temperature 0
- Adjust temperature with joystick, tint appears
- Reset, tint disappears

---

## SPEC-07: Add GPU Sorting Support

**Priority**: P1  
**Risk**: Medium — needs testing on Quest  
**Files**: `src/types.ts`, `src/index.ts`, `src/index.html`, `src/viewer.ts`

### Problem

Splat sorting runs on CPU. In VR at 72Hz with large splats, sorting is one of the biggest CPU costs. PlayCanvas 2.14+ supports GPU sorting.

### Fix

1. Add `gpusort` to Config type:
```typescript
// types.ts
type Config = {
    // ... existing
    gpusort: boolean;
};
```

2. Parse URL param in `index.html`:
```typescript
gpusort: url.searchParams.has('gpusort')
```

3. In viewer.ts, when the gsplat LOD system is active (the `else` branch with streaming):
```typescript
gsplat.gpuSorting = config.gpusort;
```

4. Default to `true` for VR sessions (can override in the XR start handler):
```typescript
app.xr.on('start', () => {
    app.scene.gsplat.gpuSorting = true;
});
```

### Verification

- Load a splat with `?gpusort` param
- Check MiniStats: CPU time should drop noticeably
- Enter VR: sorting should not cause frame drops
- Visual quality: no sorting artifacts (splats should look correct from all angles)

---

## SPEC-08: Bump PlayCanvas Engine

**Priority**: P1 — Prerequisite for SPEC-07 GPU sorting and SPEC-09 WebGPU  
**Risk**: Medium — may have breaking API changes  
**Files**: `package.json`, potentially various imports

### Problem

We're on PlayCanvas 2.14.2. Upstream viewer uses 2.15.3. Newer engine has:
- GPU sorting improvements
- WebGPU device support
- Better gsplat LOD system
- Performance fixes in the render pipeline
- Fixed XrInputSource pose tracking (may eliminate our SteamVR workaround)

### Fix

1. Update `package.json`:
```json
"playcanvas": "2.15.3"
```

2. Run `npm install`

3. Fix any compile errors (check for renamed/moved APIs)

4. Test:
   - Desktop viewer loads and renders
   - VR mode works (grab, scale, HUD, exposure, temperature)
   - Animated splats play correctly
   - Multi-splat mode works

### Key risk areas

- `CameraFrame` API may have changed
- `GSplatComponent` properties may have been renamed
- `ShaderChunks` access pattern may differ
- XR script imports may need updating

### Verification

- Full regression test of all features
- Compare frame timings before/after

---

## SPEC-09: Add WebGPU Device Option

**Priority**: P2 — After SPEC-08  
**Risk**: Medium-High — Quest WebGPU support varies  
**Files**: `src/types.ts`, `src/index.ts`, `src/index.html`

### Problem

We're locked to WebGL2. WebGPU offers lower driver overhead, better GPU utilization, and native compute shader support. Quest browser has supported WebGPU since late 2024.

### Fix

1. Add to Config:
```typescript
webgpu: boolean;
```

2. In `index.html`:
```typescript
webgpu: url.searchParams.has('webgpu')
```

3. In `index.ts`, change device creation:
```typescript
const device = await createGraphicsDevice(canvas, {
    deviceTypes: config.webgpu ? ['webgpu', 'webgl2'] : ['webgl2'],
    // ... rest unchanged
});
```

4. **Important**: XR is currently not supported with WebGPU in PlayCanvas. Upstream disables XR when WebGPU is active: `if (!config.webgpu) { initXr(global); }`. We need the same guard, OR we fall back to WebGL2 when XR is requested.

### Strategy

- Default to WebGL2 (safe)
- Add `?webgpu` URL param for opt-in testing
- If XR + WebGPU both requested, prefer WebGL2 with a console warning
- Revisit when PlayCanvas adds XR+WebGPU support

### Verification

- `?webgpu`: renders correctly on desktop
- No `?webgpu`: unchanged behavior
- `?webgpu` + VR button: falls back gracefully or disables VR button

---

## SPEC-10: Let Engine Handle LOD

**Priority**: P2  
**Risk**: Low  
**Files**: `src/viewer.ts`

### Problem

Our LOD config uses manual `lodRangeMin`/`lodRangeMax` plus `splatBudget` — triple configuration. Upstream simplified to just `splatBudget` and lets the engine auto-manage LOD ranges. This is simpler and the engine team has tuned the defaults.

### Fix

In the LOD setup section of `viewer.ts` (inside the `else` branch for streaming/LOD splats), simplify:

```typescript
// Replace the existing ranges object with:
const ranges = {
    mobile: { low: 1, high: 2 },
    desktop: { low: 2, high: 4 }
};

const quality = platform.mobile ? ranges.mobile : ranges.desktop;

// Remove lodRangeMin/lodRangeMax manual setting
// Keep only:
results[0].gsplat.splatBudget = quality.low * 1000000;

// In updateLod:
const updateLod = () => {
    const budget = state.hqMode ? quality.high : quality.low;
    results[0].gsplat.splatBudget = budget * 1000000;
};
```

Keep the existing `lodUpdateAngle`, `lodBehindPenalty`, and `radialSorting` settings — those are good optimizations.

### Verification

- Desktop: scene loads, quality toggle works
- Quest: lower splat count, still looks reasonable

---

## SPEC-11: Optimize Animated Splat Sort Skipping

**Priority**: P2  
**Risk**: Low  
**Files**: `src/animated-splat-player.ts`

### Problem

`sortEveryNFrames: 5` — sorts on every 5th frame change. On Quest at lower FPS, this is still frequent. Also the sort counter should account for the actual device performance.

### Fix

1. Make `sortEveryNFrames` adaptive based on platform:

```typescript
import { platform } from 'playcanvas';

// In constructor:
this.sortEveryNFrames = platform.mobile ? 10 : 5;
```

2. Additionally, skip sorting entirely when the camera hasn't moved significantly since the last sort (the visual difference from an unsorted frame is negligible if the viewpoint is the same):

```typescript
private lastSortCameraPos = new Vec3();
private lastSortCameraRot = new Quat();

// In showFrame, replace the shouldSort logic:
const cam = this.global.camera;
const camPos = cam.getPosition();
const camRot = cam.getRotation();
const cameraMoved = camPos.distance(this.lastSortCameraPos) > 0.01 ||
                    Math.abs(camRot.dot(this.lastSortCameraRot)) < 0.999;

const shouldSort = state.splatAnimationMode === 'paused' ||
                  (this.sortSkipCounter >= this.sortEveryNFrames && cameraMoved);

if (shouldSort) {
    this.sortSkipCounter = 0;
    this.lastSortCameraPos.copy(camPos);
    this.lastSortCameraRot.copy(camRot);
    // ... sort
}
```

### Verification

- Animated splat in VR: playback smooth, no visual pop when sort happens
- Static camera viewing animation: sorting minimized
- Moving around animation: sorts when needed

---

## SPEC-12: Reduce HUD Canvas Texture Uploads

**Priority**: P2  
**Risk**: None  
**Files**: `src/xr.ts`

### Problem

`updateHudText()` calls `hudTexture.upload()` which is a GPU texture upload. Currently called on every joystick movement frame (potentially 72 times/sec while adjusting). GPU texture uploads stall the pipeline.

### Fix

Throttle HUD updates to max ~10Hz (every 100ms):

```typescript
let lastHudUpdateTime = 0;
const HUD_UPDATE_INTERVAL = 100; // ms

// In the exposure/temperature adjustment section:
if (changed) {
    const now = performance.now();
    if (now - lastHudUpdateTime > HUD_UPDATE_INTERVAL) {
        updateHudText(exposure.toFixed(2), Math.round(temperature).toString());
        lastHudUpdateTime = now;
    }
}
```

Also ensure the final value is always displayed (update once more when joystick returns to center / no input):

```typescript
// After the input loop, if no change happened this frame:
if (!changed && lastHudUpdateTime > 0) {
    // One final update to ensure display matches actual value
    updateHudText(exposure.toFixed(2), Math.round(temperature).toString());
    lastHudUpdateTime = 0;
}
```

### Verification

- VR HUD: values still update visually as you move joystick
- No visual lag (10Hz is fast enough for readable text)
- Frame timing smoother during adjustment

---

## SPEC-13: Investigate XrControllers for Pose Tracking

**Priority**: P3 — Research/spike  
**Risk**: Medium — the previous glitchiness needs investigation  
**Files**: `src/xr.ts`, `src/types.ts`

### Problem

Our custom `getControllerPose()` function is 50+ lines with a raw WebXR fallback for SteamVR. The PlayCanvas `XrControllers` script (from `playcanvas/scripts/esm/xr-controllers.mjs`) provides reliable pose tracking. Previous attempt was "glitchy" — needs investigation of what exactly was glitchy (models? tracking? latency?).

### What XrControllers gives us

- Reliable `inputSource.getPosition()` and `inputSource.getRotation()` (the engine handles gripSpace/targetRaySpace internally)
- 3D controller model rendering (loads from WebXR Input Profiles CDN)
- Proper controller lifecycle (add/remove/cleanup)

### What we keep regardless

ALL of our custom logic stays:
- Grab (grip button) + offset calculation
- Scale (trigger + joystick)
- Ray visualization (our custom rays)
- HUD (A/X button toggle)
- Exposure/Temperature (joystick when HUD visible)
- Playback cycling (B/Y button)
- Stencil tint plane

### Investigation steps

1. Test if PlayCanvas 2.15's `inputSource.getPosition()` works reliably on SteamVR without our manual fallback.
2. If yes: remove the entire `getControllerPose()` function and `currentXRFrame` hooking, replace with direct `inputSource.getPosition()`/`inputSource.getRotation()` calls.
3. If no: keep our fallback but log when it's hit to understand the actual failure rate.
4. Optionally add the `XrControllers` script for controller model rendering (cosmetic, not functional).

### Do NOT

- Do not replace our grab/scale/HUD logic with XrNavigation
- Do not change the origin spawn behavior
- Do not add locomotion systems

### Verification

- SteamVR: controllers track correctly
- Quest: controllers track correctly
- Grab, scale, HUD all work identically

---

## Implementation Order

```
SPEC-01 → SPEC-02 → SPEC-03  (P0, independent, do together)  ✅ DONE
SPEC-04 → SPEC-05 → SPEC-06  (P1 quick fixes, independent)   ✅ DONE
SPEC-08                        (engine bump, gate for SPEC-07/09) ✅ DONE
SPEC-07                        (GPU sorting, after engine bump)   ✅ DONE
SPEC-09                        (WebGPU — SKIPPED: XR+WebGPU not supported in PlayCanvas)
SPEC-10                        (splatBudget — SKIPPED: setter is no-op in 2.15.3)
SPEC-11 → SPEC-12             (P2, independent)               ✅ DONE
SPEC-13                        (research spike, any time)
```

### Additional optimizations (not in original specs)
- **Frame skipping**: `RENDER_EVERY_N = 2` — render every 2nd frame, compositor reprojects. Confirmed effective on Quest 3.
- **fixedFoveation = 1** — free foveated rendering, no quality loss in center vision.
