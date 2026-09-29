import '@playcanvas/web-components';
import {
    Asset,
    Color,
    Entity,
    GSPLAT_RENDERER_RASTER_CPU_SORT,
    GSPLAT_RENDERER_RASTER_GPU_SORT,
    Mat4,
    Quat,
    Vec3,
    type AppBase,
    type CameraComponent
} from 'playcanvas';

import {
    loadSceneDefinition,
    type Matrix4,
    type SceneManifest
} from './scene-manifest';
import { SplatStreamPlayer, SplatStreamSource } from './splat-stream';
import { SplatVideoPlayer, SplatVideoSource } from './splat-video';
import { desktopNavigation } from './desktop-navigation';
import { isSameOriginMedia } from './media-request';
import { playStereoVideo } from './stereo-video';

type XrInput = {
    gamepad?: Gamepad;
    handedness?: string;
    getPosition: () => Vec3 | null;
    getRotation: () => Quat | null;
};

type ImmersiveXrMode = 'immersive-ar' | 'immersive-vr';

const DESKTOP_CLEAR_COLOR = new Color(0.018, 0.021, 0.027, 1);
const AR_CLEAR_COLOR = new Color(0, 0, 0, 0);
const APPLY_POSITION = new Vec3();
const APPLY_SCALE = new Vec3();
const APPLY_ROTATION_MATRIX = new Mat4();
const APPLY_ROTATION = new Quat();
const CONTROLLER_POSE = new Mat4();
const GRABBED_CONTENT_POSE = new Mat4();
const XR_SCALE_DEAD_ZONE = 0.1;
const XR_SCALE_RATE = 0.3;
const XR_MIN_SCALE = 0.01;
const XR_MAX_SCALE = 100;

const ui = {
    headline: document.querySelector<HTMLElement>('#headline')!,
    detail: document.querySelector<HTMLElement>('#detail')!,
    diagnostics: document.querySelector<HTMLElement>('#diagnostics')!,
    notice: document.querySelector<HTMLElement>('#notice')!,
    progress: document.querySelector<HTMLElement>('#progress')!,
    reset: document.querySelector<HTMLButtonElement>('#reset')!,
    playback: document.querySelector<HTMLButtonElement>('#playback')!,
    ar: document.querySelector<HTMLButtonElement>('#enter-ar')!,
    vr: document.querySelector<HTMLButtonElement>('#enter-vr')!
};

const rowMajorToPlayCanvas = (values: Matrix4): Mat4 => new Mat4().set([
    values[0], values[4], values[8], values[12],
    values[1], values[5], values[9], values[13],
    values[2], values[6], values[10], values[14],
    values[3], values[7], values[11], values[15]
]);

const applyMatrix = (entity: Entity, matrix: Mat4): void => {
    const position = matrix.getTranslation(APPLY_POSITION);
    const scale = matrix.getScale(APPLY_SCALE);
    const rotationMatrix = APPLY_ROTATION_MATRIX.copy(matrix);
    const data = rotationMatrix.data;
    const sx = scale.x || 1;
    const sy = scale.y || 1;
    const sz = scale.z || 1;
    data[0] /= sx; data[1] /= sx; data[2] /= sx;
    data[4] /= sy; data[5] /= sy; data[6] /= sy;
    data[8] /= sz; data[9] /= sz; data[10] /= sz;
    const rotation = APPLY_ROTATION.setFromMat4(rotationMatrix);
    entity.setLocalPosition(position);
    entity.setLocalRotation(rotation);
    entity.setLocalScale(scale);
};

const readControllerMatrix = (source: XrInput, target: Mat4): boolean => {
    const position = source.getPosition();
    const rotation = source.getRotation();
    if (!position || !rotation) return false;
    target.setTRS(position, rotation, Vec3.ONE);
    return true;
};

const configureCamera = (camera: Entity, manifest: SceneManifest): CameraComponent => {
    const component = camera.camera;
    if (!component) throw new Error('PlayCanvas did not create the camera component.');
    const intrinsics = manifest.captureCamera.intrinsics;
    const verticalFov = 2 * Math.atan(intrinsics.height / (2 * intrinsics.fy)) * 180 / Math.PI;
    component.horizontalFov = false;
    component.fov = verticalFov;
    component.nearClip = manifest.captureCamera.near ?? 0.01;
    component.farClip = manifest.captureCamera.far ?? 1000;
    component.clearColor = DESKTOP_CLEAR_COLOR;
    return component;
};

const loadSplat = (
    app: AppBase,
    contentRoot: Entity,
    assetUrl: string,
    onProgress: (progress: number) => void
): Promise<Entity> => new Promise((resolve, reject) => {
    const filename = new URL(assetUrl, location.href).pathname.split('/').pop() || 'scene.ply';
    app.loader.withCredentials = isSameOriginMedia(assetUrl);
    const asset = new Asset(filename, 'gsplat', { url: assetUrl, filename });
    asset.on('progress', (received: number, total: number) => {
        if (total > 0) onProgress(Math.min(100, Math.round(received / total * 100)));
    });
    asset.on('load', () => {
        const splat = new Entity('authored-splat');
        splat.addComponent('gsplat', { asset });
        contentRoot.addChild(splat);
        onProgress(100);
        resolve(splat);
    });
    asset.on('error', reject);
    app.assets.add(asset);
    app.assets.load(asset);
});

const boot = async (app: AppBase, camera: Entity, contentRoot: Entity): Promise<void> => {
    const query = new URL(location.href).searchParams;
    const contentParam = query.get('content');
    if (!contentParam) throw new Error('NextPlayer requires a ?content= URL.');

    const contentUrl = new URL(contentParam, location.href).href;
    if (query.get('projection') === 'stereo') return playStereoVideo(app, camera, contentRoot, contentUrl, ui);
    ui.headline.textContent = 'Reading authored placement…';
    camera.addComponent('camera');
    const xrManager = app.xr;
    if (!xrManager) throw new Error('PlayCanvas WebXR support is unavailable in this browser.');
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    let activeXrMode: ImmersiveXrMode | null = null;
    const xrDebug = {
        secureContext: window.isSecureContext,
        apiPresent: !!xr,
        support: { 'immersive-ar': false, 'immersive-vr': false } as Record<ImmersiveXrMode, boolean>,
        activeMode: null as ImmersiveXrMode | null,
        startAttempts: 0,
        startSuccesses: 0,
        lastStartError: null as string | null,
        endedSessions: 0
    };
    (globalThis as typeof globalThis & { __emsXrDebug?: typeof xrDebug }).__emsXrDebug = xrDebug;

    // Full-quality baseline: current unified renderer, no contribution foveation,
    // no resolution reduction, and no culling beyond sub-8-bit alpha.
    app.scene.clusteredLightingEnabled = false;
    app.scene.gsplat.alphaClipForward = 1 / 255;
    app.scene.gsplat.minContribution = 0;
    app.scene.gsplat.foveationStrength = 0;
    app.scene.gsplat.useFog = false;
    const desktopRadialSorting = query.get('sort') === 'radial'
        ? true
        : app.scene.gsplat.radialSorting;
    app.scene.gsplat.radialSorting = desktopRadialSorting;

    const definition = await loadSceneDefinition(contentUrl, query.get('manifest'));
    const manifest = definition.manifest;
    const isAnimated = manifest.kind === 'animated-splat';
    let streamSource: SplatStreamSource | null = null;
    let videoSource: SplatVideoSource | null = null;
    let localCachePreparing = false;
    let pauseBackgroundCache = (): void => undefined;
    let resumeBackgroundCache = (): void => undefined;
    if (isAnimated) {
        if (!new URL(definition.assetUrl).pathname.toLowerCase().endsWith('.splatstream')) {
            throw new Error('NextPlayer animated playback expects an EMS .splatstream asset.');
        }
        ui.headline.textContent = 'Reading animation index…';
        videoSource = await SplatVideoSource.openIfPresent(definition.assetUrl);
        if (!videoSource) streamSource = await SplatStreamSource.open(definition.assetUrl);
        const stream = videoSource?.manifest ?? streamSource!.manifest;
        manifest.captureCamera.intrinsics = {
            projection: 'perspective',
            fx: stream.focal_length_px,
            fy: stream.focal_length_px,
            cx: stream.width * 0.5,
            cy: stream.height * 0.5,
            width: stream.width,
            height: stream.height
        };
        if (definition.warning) {
            definition.warning = `${definition.warning.split('Using identity placement')[0]}Using identity placement; capture intrinsics came from the animation index.`;
        }
    }

    const authoredCamera = rowMajorToPlayCanvas(manifest.captureCamera.cameraToWorld);
    const authoredContent = rowMajorToPlayCanvas(manifest.contentToWorld);
    let resetContent = authoredContent.clone();
    let xrAlignmentPending = false;
    let activeGrab: { source: XrInput; controllerToContent: Mat4; scale: number } | null = null;

    const cameraComponent = configureCamera(camera, manifest);
    applyMatrix(camera, authoredCamera);
    applyMatrix(contentRoot, authoredContent);
    const resetNavigation = desktopNavigation(app, camera, contentRoot, manifest.grabPivot);

    const webglContext = (app.graphicsDevice as unknown as { gl?: WebGL2RenderingContext }).gl;
    const webglMultiview = webglContext?.getExtension('OVR_multiview2') ?? null;
    const xrGpuBindingPresent = typeof (globalThis as typeof globalThis & { XRGPUBinding?: unknown }).XRGPUBinding !== 'undefined';

    const staticDiagnostics = [
        `Placement: ${definition.authored ? 'EMS metadata' : 'camera fallback'}`,
        `Coordinates: RH · +Y up · -Z forward · meters`,
        `Source camera: ${manifest.captureCamera.intrinsics.width}×${manifest.captureCamera.intrinsics.height}`,
        `Secure context: ${window.isSecureContext ? 'yes' : 'no'}`,
        `WebXR API: ${xr ? 'present' : 'missing'}`,
        `WebGPU API: ${(navigator as Navigator & { gpu?: unknown }).gpu ? 'present' : 'missing'} · XR GPU binding: ${xrGpuBindingPresent ? 'present' : 'missing'}`,
        `WebGL multiview extension: ${webglMultiview ? 'present' : 'missing'}`
    ];
    let loadedSplats = 0;
    let xrFrameCount = 0;
    let xrFrameTotalMs = 0;
    let xrWorstFrameMs = 0;
    let lastDiagnosticUpdate = 0;
    let completedSorts = 0;
    let completedSortTotalMs = 0;
    const recentSortTimes: number[] = [];
    app.scene.on('gsplat:sorted', (sortMs: number) => {
        completedSorts++;
        completedSortTotalMs += sortMs;
        if (!xrManager.active) {
            const now = performance.now();
            recentSortTimes.push(now);
            while (recentSortTimes.length > 1 && recentSortTimes[0] < now - 5000) {
                recentSortTimes.shift();
            }
        }
    });
    let animationPlayer: SplatStreamPlayer | SplatVideoPlayer | null = null;
    const rendererName = (): string => {
        switch (app.scene.gsplat.currentRenderer) {
            case GSPLAT_RENDERER_RASTER_GPU_SORT: return 'unified GPU sort';
            case GSPLAT_RENDERER_RASTER_CPU_SORT: return 'unified CPU sort';
            default: return `renderer ${app.scene.gsplat.currentRenderer}`;
        }
    };
    const refreshDiagnostics = (): void => {
        const frame = app.stats.frame;
        const vram = app.stats.vram;
        const trackedVram = vram.tex + vram.vb + vram.ib + vram.ub + vram.sb;
        const heap = (performance as Performance & {
            memory?: { usedJSHeapSize: number };
        }).memory?.usedJSHeapSize;
        const sortWindowMs = recentSortTimes.length > 1
            ? recentSortTimes[recentSortTimes.length - 1] - recentSortTimes[0]
            : 0;
        const sortRate = sortWindowMs > 0
            ? (recentSortTimes.length - 1) * 1000 / sortWindowMs
            : 0;
        const averageSortMs = completedSorts > 0 ? completedSortTotalMs / completedSorts : 0;
        ui.diagnostics.textContent = [
            ...staticDiagnostics,
            `Backend: ${app.graphicsDevice.deviceType} · ${rendererName()}`,
            `Resolution: ${app.graphicsDevice.width}×${app.graphicsDevice.height}`,
            `Splats: ${(frame.gsplats || loadedSplats).toLocaleString()}`,
            `Frame: ${frame.ms.toFixed(1)} ms · ${frame.fps || 0} fps`,
            `Sort: ${frame.gsplatSort.toFixed(1)} ms last · ${averageSortMs.toFixed(1)} ms mean · ${sortRate.toFixed(1)}/s`,
            `Sort basis: ${app.scene.gsplat.radialSorting ? 'radial distance (XR rotation-stable)' : 'camera direction'}`,
            `Memory: ${(trackedVram / 1048576).toFixed(1)} MB tracked VRAM${heap ? ` · ${(heap / 1048576).toFixed(1)} MB JS heap` : ''}`,
            `XR rate: ${xrManager.frameRate ? `${xrManager.frameRate} Hz` : 'not active'}`,
            ...(animationPlayer?.diagnostics ?? [])
        ].join('\n');
    };
    refreshDiagnostics();
    if (definition.warning) {
        ui.notice.textContent = definition.warning;
        ui.notice.dataset.level = 'warning';
    }

    ui.headline.textContent = isAnimated ? 'Buffering first animation frame…' : 'Loading splat…';
    const reportProgress = (progress: number): void => {
        ui.progress.style.setProperty('--progress', `${progress}%`);
        ui.detail.textContent = `${progress}%`;
    };
    if (videoSource) {
        const player = new SplatVideoPlayer({
            app,
            contentRoot,
            source: videoSource,
            audioUrl: query.get('audio'),
            onStateChange: () => {
                loadedSplats = player.currentSplatCount;
                const playbackLabel = player.playing ? 'Pause' : 'Play';
                if (ui.playback.textContent !== playbackLabel) {
                    ui.playback.textContent = playbackLabel;
                }
            }
        });
        animationPlayer = player;
        ui.playback.hidden = false;
        ui.playback.textContent = 'Start';
        ui.playback.addEventListener('click', async () => {
            try {
                await player.toggle();
            } catch (error) {
                ui.notice.textContent = `Playback could not start: ${error instanceof Error ? error.message : String(error)}`;
                ui.notice.dataset.level = 'error';
            }
        });
        // Meta Browser can leave a programmatic hidden-video play() pending
        // even though the media is muted. Expose a trusted user gesture before
        // awaiting frame zero so the page never deadlocks behind a hidden
        // playback button.
        await player.load(reportProgress);
        loadedSplats = player.currentSplatCount;
        ui.playback.textContent = player.playing ? 'Pause' : 'Play';
        window.addEventListener('beforeunload', () => player.destroy(), { once: true });
    } else if (streamSource) {
        const source = streamSource;
        const player = new SplatStreamPlayer({
            app,
            contentRoot,
            source,
            audioUrl: query.get('audio'),
            onStateChange: () => {
                loadedSplats = player.currentSplatCount;
                const playbackLabel = player.playing ? 'Pause' : 'Play';
                if (ui.playback.textContent !== playbackLabel) {
                    ui.playback.textContent = playbackLabel;
                }
            }
        });
        animationPlayer = player;
        await player.load(reportProgress);
        loadedSplats = player.currentSplatCount;
        ui.playback.hidden = false;
        ui.playback.textContent = 'Play';
        let cacheController: AbortController | null = null;
        let cacheTask: Promise<void> | null = null;
        let cacheDisabled = false;
        const startBackgroundCache = (): void => {
            const cache = source.persistentCache;
            if (!cache || cacheDisabled || cacheTask || player.playing || xrManager.active
                || cache.stats.cachedFrames >= cache.stats.frameCount) return;
            cacheController = new AbortController();
            const controller = cacheController;
            localCachePreparing = true;
            ui.headline.textContent = 'Preparing local playback in background…';
            cacheTask = source.cacheAll((cachedFrames, frameCount, cachedBytes, totalBytes) => {
                const percent = totalBytes > 0 ? cachedBytes / totalBytes * 100 : 0;
                ui.progress.style.setProperty('--progress', `${percent}%`);
                ui.detail.textContent = `${percent.toFixed(0)}% local · ${cachedFrames}/${frameCount} frames · ${(cachedBytes / 1073741824).toFixed(2)}/${(totalBytes / 1073741824).toFixed(2)} GB`;
            }, controller.signal).then(() => {
                ui.notice.textContent = 'Local playback is ready. Splat frames will be read from Quest storage.';
                ui.notice.dataset.level = 'ok';
            }).catch(error => {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                    cacheDisabled = true;
                    ui.notice.textContent = `Quest storage could not hold the complete animation; continuing with streamed playback. ${error instanceof Error ? error.message : String(error)}`;
                    ui.notice.dataset.level = 'warning';
                }
            }).finally(() => {
                if (cacheController === controller) cacheController = null;
                cacheTask = null;
                localCachePreparing = false;
                ui.headline.textContent = 'Audio-synchronized stream ready';
                const complete = cache.stats.cachedFrames >= cache.stats.frameCount;
                ui.detail.textContent = complete
                    ? 'Animation cached on Quest storage; only two decoded frames stay in RAM.'
                    : (player.playing || xrManager.active
                        ? 'Playing immediately; requested frames continue filling the local cache.'
                        : 'Local preparation resumes automatically while playback is idle.');
                refreshDiagnostics();
                if (!complete && !cacheDisabled && !player.playing && !xrManager.active) {
                    queueMicrotask(startBackgroundCache);
                }
            });
        };
        const stopBackgroundCache = (): void => {
            cacheController?.abort();
        };
        pauseBackgroundCache = stopBackgroundCache;
        resumeBackgroundCache = startBackgroundCache;
        ui.playback.addEventListener('click', async () => {
            const startingPlayback = !player.playing;
            if (startingPlayback) stopBackgroundCache();
            try {
                await player.toggle();
            } catch (error) {
                ui.notice.textContent = `Audio playback could not start: ${error instanceof Error ? error.message : String(error)}`;
                ui.notice.dataset.level = 'error';
            } finally {
                if (!player.playing) startBackgroundCache();
            }
        });
        if (source.persistentCache) {
            const stats = source.persistentCache.stats;
            if (stats.cachedFrames < stats.frameCount) {
                startBackgroundCache();
            } else {
                ui.detail.textContent = 'Animation cached on Quest storage; only two decoded frames stay in RAM.';
            }
        } else {
            staticDiagnostics.push(`Quest local cache: unavailable (${source.persistentCacheUnavailableReason || 'unknown'})`);
        }
        window.addEventListener('beforeunload', () => {
            stopBackgroundCache();
            player.destroy();
        }, { once: true });
    } else {
        const splat = await loadSplat(app, contentRoot, definition.assetUrl, reportProgress);
        loadedSplats = splat.gsplat?.resource?.numSplats ?? 0;
    }
    refreshDiagnostics();
    ui.headline.textContent = localCachePreparing
        ? 'Preparing local playback in background…'
        : isAnimated
        ? 'Audio-synchronized stream ready'
        : (definition.authored ? 'Authored view ready' : 'Legacy view ready');
    ui.detail.textContent = localCachePreparing
        ? ui.detail.textContent
        : isAnimated
        ? (streamSource?.persistentCache?.stats.cachedFrames === streamSource?.persistentCache?.stats.frameCount
            ? 'Animation cached on Quest storage; only two decoded frames stay in RAM.'
            : 'Only two decoded frames stay in RAM.')
        : (definition.authored
            ? 'Camera and splat use the saved generation matrices.'
            : 'This older asset has no placement sidecar.');

    const resetPlacement = (): void => {
        activeGrab = null;
        if (xrManager.active) {
            applyMatrix(contentRoot, resetContent);
        } else {
            applyMatrix(camera, authoredCamera);
            applyMatrix(contentRoot, authoredContent);
        }
        resetNavigation();
        ui.notice.textContent = 'Placement reset exactly.';
        ui.notice.dataset.level = 'ok';
    };
    ui.reset.addEventListener('click', resetPlacement);
    window.addEventListener('keydown', event => {
        if (event.key.toLowerCase() === 'r') resetPlacement();
    });

    const xrSupport: Record<ImmersiveXrMode, boolean> = {
        'immersive-ar': false,
        'immersive-vr': false
    };
    const modeName = (mode: ImmersiveXrMode): 'AR' | 'VR' => mode === 'immersive-ar' ? 'AR' : 'VR';
    const setXrAvailable = (mode: ImmersiveXrMode, available: boolean): void => {
        xrSupport[mode] = available;
        // PlayCanvas separately caches availability. Keep its cache aligned
        // with the direct browser probe so a Quest discovered after page load
        // can start immediately instead of waiting for another engine event.
        const availability = (xrManager as unknown as {
            _available?: Partial<Record<ImmersiveXrMode, boolean>>;
        })._available;
        if (availability) availability[mode] = available;
    };
    const updateXrButtons = (): void => {
        const update = (button: HTMLButtonElement, mode: ImmersiveXrMode): void => {
            const name = modeName(mode);
            button.dataset.available = String(xrSupport[mode]);
            button.disabled = activeXrMode !== null && activeXrMode !== mode;
            button.textContent = activeXrMode === mode
                ? `Exit ${name}`
                : `Enter ${name}`;
            button.title = xrSupport[mode]
                ? `Start immersive ${name}`
                : `Try immersive ${name}; the viewer will explain any browser or origin restriction`;
        };
        update(ui.ar, 'immersive-ar');
        update(ui.vr, 'immersive-vr');
    };
    const refreshXrSupport = async (): Promise<void> => {
        if (!xr) {
            setXrAvailable('immersive-ar', false);
            setXrAvailable('immersive-vr', false);
        } else {
            const probe = async (mode: ImmersiveXrMode): Promise<void> => {
                try {
                    setXrAvailable(mode, await xr.isSessionSupported(mode));
                } catch (error) {
                    setXrAvailable(mode, false);
                    ui.notice.textContent = `${modeName(mode)} capability probe failed: ${String(error)}`;
                    ui.notice.dataset.level = 'error';
                }
            };
            await Promise.all([probe('immersive-ar'), probe('immersive-vr')]);
        }
        xrDebug.support['immersive-ar'] = xrSupport['immersive-ar'];
        xrDebug.support['immersive-vr'] = xrSupport['immersive-vr'];
        updateXrButtons();
    };
    await refreshXrSupport();
    xrManager.on('available', (mode: ImmersiveXrMode, available: boolean) => {
        if (mode !== 'immersive-ar' && mode !== 'immersive-vr') return;
        setXrAvailable(mode, available);
        updateXrButtons();
    });
    xr?.addEventListener('devicechange', refreshXrSupport);
    window.addEventListener('focus', refreshXrSupport);
    window.addEventListener('pageshow', refreshXrSupport);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void refreshXrSupport();
    });

    xrManager.on('start', () => {
        // Headsets rotate far more often than they translate. Radial ordering
        // stays correct while looking around, avoids a million-splat CPU sort
        // for every tiny orientation change, and is also the PlayCanvas mode
        // intended to reduce rotation-induced ordering artifacts. Resource or
        // camera-position changes still request fresh sorts normally.
        app.scene.gsplat.radialSorting = true;
        // The headset compositor does not display this HTML panel. Stop its
        // layout/paint work during XR; the underlying counters continue so the
        // end-of-session summary remains available on the flat page.
        ui.diagnostics.hidden = true;
        recentSortTimes.length = 0;
        xrDebug.activeMode = activeXrMode;
        xrDebug.startSuccesses++;
        xrDebug.lastStartError = null;
        xrFrameCount = 0;
        xrFrameTotalMs = 0;
        xrWorstFrameMs = 0;
        updateXrButtons();
        xrAlignmentPending = true;
        let frames = 0;
        const alignFromFirstHeadPose = (): void => {
            if (++frames < 2) return;
            app.off('update', alignFromFirstHeadPose);

            const trackingFromHead = camera.getWorldTransform().clone();
            const worldFromContentInverse = authoredContent.clone().invert();
            const contentFromCaptureCamera = new Mat4().mul2(worldFromContentInverse, authoredCamera);
            const trackingFromContent = new Mat4().mul2(
                trackingFromHead,
                contentFromCaptureCamera.clone().invert()
            );
            applyMatrix(contentRoot, trackingFromContent);
            resetContent = trackingFromContent.clone();
            xrAlignmentPending = false;
            ui.notice.textContent = `${activeXrMode ? modeName(activeXrMode) : 'XR'} aligned. Grip moves; while gripping, hold trigger and use that hand's stick up/down to scale.`;
            ui.notice.dataset.level = 'ok';
        };
        app.on('update', alignFromFirstHeadPose);
    });

    xrManager.on('end', () => {
        const endedMode = activeXrMode ? modeName(activeXrMode) : 'XR';
        const averageFrameMs = xrFrameCount > 0 ? xrFrameTotalMs / xrFrameCount : 0;
        xrAlignmentPending = false;
        activeXrMode = null;
        app.scene.gsplat.radialSorting = desktopRadialSorting;
        ui.diagnostics.hidden = false;
        recentSortTimes.length = 0;
        xrDebug.activeMode = null;
        xrDebug.endedSessions++;
        cameraComponent.clearColor = DESKTOP_CLEAR_COLOR;
        applyMatrix(camera, authoredCamera);
        applyMatrix(contentRoot, authoredContent);
        resetContent = authoredContent.clone();
        resetNavigation();
        refreshXrSupport();
        resumeBackgroundCache();
        refreshDiagnostics();
        if (xrFrameCount > 0) {
            ui.notice.textContent = `${endedMode} session: ${averageFrameMs.toFixed(1)} ms average, ${xrWorstFrameMs.toFixed(1)} ms worst frame across ${xrFrameCount.toLocaleString()} frames.`;
            ui.notice.dataset.level = averageFrameMs <= 13.9 ? 'ok' : 'warning';
        }
    });

    const startXr = async (mode: ImmersiveXrMode): Promise<void> => {
        if (xrManager.active) {
            xrManager.end();
            return;
        }
        await refreshXrSupport();
        const name = modeName(mode);
        xrDebug.startAttempts++;
        xrDebug.lastStartError = null;
        if (!xr) {
            ui.notice.textContent = window.isSecureContext
                ? 'This browser does not expose WebXR. In Meta Browser, enable WebXR and reload the viewer.'
                : `Meta Browser is not treating ${window.location.origin} as secure. Add that exact origin—including port—to “Insecure origins treated as secure”, relaunch the browser, and reopen the viewer.`;
            ui.notice.dataset.level = 'error';
            return;
        }
        if (!xrSupport[mode]) {
            ui.notice.textContent = `${name} is not currently reported as available by Meta Browser. Reload the page after changing browser flags, then try again.`;
            ui.notice.dataset.level = 'error';
            return;
        }

        pauseBackgroundCache();
        if (animationPlayer && !animationPlayer.playing) {
            try {
                await animationPlayer.play();
            } catch (error) {
                ui.notice.textContent = `XR can start, but source audio was blocked: ${error instanceof Error ? error.message : String(error)}`;
                ui.notice.dataset.level = 'warning';
            }
        }

        // The XR runtime owns the camera pose. The content is aligned from its
        // first real head pose instead of applying a floor-height heuristic.
        activeXrMode = mode;
        cameraComponent.clearColor = mode === 'immersive-ar' ? AR_CLEAR_COLOR : DESKTOP_CLEAR_COLOR;
        updateXrButtons();
        applyMatrix(camera, new Mat4());
        xrManager.start(cameraComponent, mode, 'local', {
            callback: (error?: Error | null) => {
                if (error) {
                    activeXrMode = null;
                    cameraComponent.clearColor = DESKTOP_CLEAR_COLOR;
                    applyMatrix(camera, authoredCamera);
                    applyMatrix(contentRoot, authoredContent);
                    updateXrButtons();
                    xrDebug.activeMode = null;
                    xrDebug.lastStartError = error.message;
                    ui.notice.textContent = `Could not start ${name}: ${error.message}`;
                    ui.notice.dataset.level = 'error';
                    resumeBackgroundCache();
                }
            }
        });
    };

    ui.ar.addEventListener('click', () => startXr('immersive-ar'));
    ui.vr.addEventListener('click', () => startXr('immersive-vr'));

    app.on('update', (dt: number) => {
        const now = performance.now();
        if (xrManager.active && !xrAlignmentPending) {
            const frameMs = dt * 1000;
            xrFrameCount++;
            xrFrameTotalMs += frameMs;
            xrWorstFrameMs = Math.max(xrWorstFrameMs, frameMs);
        }
        if (!xrManager.active && now - lastDiagnosticUpdate >= 1000) {
            lastDiagnosticUpdate = now;
            refreshDiagnostics();
        }

        if (!xrManager.active || xrAlignmentPending) {
            activeGrab = null;
            return;
        }

        const sources = (xrManager.input.inputSources || []) as unknown as XrInput[];
        if (activeGrab) {
            const pressed = !!activeGrab.source.gamepad?.buttons[1]?.pressed;
            if (!pressed || !readControllerMatrix(activeGrab.source, CONTROLLER_POSE)) {
                activeGrab = null;
                return;
            }
            applyMatrix(
                contentRoot,
                GRABBED_CONTENT_POSE.mul2(CONTROLLER_POSE, activeGrab.controllerToContent)
            );
            const gamepad = activeGrab.source.gamepad;
            const triggerPressed = !!gamepad?.buttons[0]?.pressed;
            const stickY = gamepad?.axes ? (gamepad.axes[3] || gamepad.axes[1] || 0) : 0;
            if (triggerPressed && Math.abs(stickY) > XR_SCALE_DEAD_ZONE) {
                activeGrab.scale = Math.max(
                    XR_MIN_SCALE,
                    Math.min(activeGrab.scale * (1 - stickY * dt * XR_SCALE_RATE), XR_MAX_SCALE)
                );
            }
            contentRoot.setLocalScale(activeGrab.scale, activeGrab.scale, activeGrab.scale);
            return;
        }

        const source = sources.find(candidate => candidate.handedness === 'left' && candidate.gamepad?.buttons[1]?.pressed)
            ?? sources.find(candidate => candidate.gamepad?.buttons[1]?.pressed);
        if (!source) return;
        if (!readControllerMatrix(source, CONTROLLER_POSE)) return;
        const controllerToContent = new Mat4().copy(CONTROLLER_POSE).invert();
        controllerToContent.mul2(controllerToContent, contentRoot.getWorldTransform());
        activeGrab = {
            source,
            controllerToContent,
            scale: contentRoot.getLocalScale().x
        };
    });
};

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const appElement = document.querySelector('pc-app') as HTMLElement & { ready: () => Promise<{ app: AppBase }> };
        const cameraElement = document.querySelector('pc-entity[name="camera"]') as HTMLElement & { ready: () => Promise<{ entity: Entity }> };
        const contentElement = document.querySelector('pc-entity[name="content-root"]') as HTMLElement & { ready: () => Promise<{ entity: Entity }> };
        const [{ app }, { entity: camera }, { entity: contentRoot }] = await Promise.all([
            appElement.ready(),
            cameraElement.ready(),
            contentElement.ready()
        ]);
        await boot(app, camera, contentRoot);
    } catch (error) {
        console.error('[NextPlayer]', error);
        ui.headline.textContent = 'NextPlayer could not load';
        ui.detail.textContent = error instanceof Error ? error.message : String(error);
        ui.notice.textContent = 'The static viewer remains available for compatible splat files.';
        ui.notice.dataset.level = 'error';
    }
});
