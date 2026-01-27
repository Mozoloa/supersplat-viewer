# Quest Browser Optimization Plan

## 🔴 High Impact (Priority)

### 1. Reduce Frame Entity Overhead
**Status**: ⏸️ Reverted (caused issues)

**Problem**: Each animated frame is a separate Entity with gsplat component. Swapping visibility still leaves all frames in the scene graph.

**Fix**: Frame pool recycling was implemented but caused race conditions - frames were evicted while still loading/needed. **Reverted to original behavior.** This optimization needs more careful implementation with proper loading state tracking.

**Alternative approach for future**: Instead of evicting frames aggressively, consider lazy cleanup after playback completes a full cycle.

---

### 2. Lower Preload Ahead Count
**Status**: ✅ Done

**Problem**: `preloadAhead: number = 5` is too aggressive for Quest's limited memory.

**Fix**: Reduced to `preloadAhead: 2` in `animated-splat-player.ts`. Also added `loadingFrames` Set to prevent duplicate load attempts.

---

### 3. Disable Splat Sorting During Playback
**Status**: ✅ Done

**Problem**: The sorter fires `updated` events constantly, triggering unnecessary work.

**Fix**: Added `sortEveryNFrames: 5` - only sorts every 5 frame changes during playback. Always sorts when paused. See `showFrame()` in `animated-splat-player.ts`.

---

### 4. Reduce Ray Visualization Complexity
**Status**: ⏸️ Reverted (broke grab mechanism)

**Problem**: Cylinder ray entity with material created per-controller adds overhead.

**Fix**: Attempted to disable rays on Quest/mobile but detection was too aggressive and broke grab functionality on desktop. **Reverted to original behavior.**

**Alternative for future**: Only apply this optimization inside actual XR sessions on Quest, not globally.

---

## 🟡 Medium Impact

### 5. Frame Throttling
Skip animation frame updates (e.g., every 2nd render frame).

### 6. Reduce HUD Canvas Updates
Cache canvas, only redraw when values actually change.

### 7. Stencil Complexity
Only enable tint plane when temperature ≠ 0.

### 8. LOD Settings for Quest
More aggressive LOD: `lodRangeMin: 3`, `lodRangeMax: 10`, `splatBudget: 500000`.

---

## 🟢 Lower Impact

### 9. Verify Post-Effects Disabled in XR
Already done but worth verifying.

### 10. Cache findComponents Result
`app.root.findComponents('gsplat')` traverses scene every frame - cache it.

### 11. ZIP Parsing Optimization
Consider Web Workers or uncompressed splatseq for faster load.

### 12. Skip Marker Updates When Invisible
Markers have opacity=0, skip transform updates.

---

## Quick Reference

| # | Change | File | Effort | Impact |
|---|--------|------|--------|--------|
| 1 | Recycle frame entities | animated-splat-player.ts | High | Very High |
| 2 | Reduce `preloadAhead` to 2 | animated-splat-player.ts | Low | High |
| 3 | Skip sorting during playback | animated-splat-player.ts / viewer.ts | Medium | High |
| 4 | Simplify/disable ray vis | xr.ts | Low | Medium |
| 5 | Frame-skip animation | animated-splat-player.ts | Medium | High |
| 6 | Cache HUD updates | xr.ts | Low | Low |
| 7 | Conditional tint plane | xr.ts | Low | Medium |
| 8 | Quest-specific LOD | viewer.ts | Low | High |
