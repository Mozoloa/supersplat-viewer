import '@playcanvas/web-components';
import {
    Asset,
    EventHandler,
    type Texture,
    type AppBase,
    type Entity,
    revision as engineRevision,
    version as engineVersion
} from 'playcanvas';

import { AnimatedSplatPlayer } from './animated-splat-player';
import { observe } from './core/observe';
import { loadGsplat } from './gsplat-loader';
import { importSettings } from './settings';
import type { Config, Global } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';
import { version as appVersion } from '../package.json';

const loadSkybox = (app: AppBase, url: string) => {
    return new Promise<Asset>((resolve, reject) => {
        const asset = new Asset('skybox', 'texture', {
            url
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });

        asset.on('load', () => {
            resolve(asset);
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const main = (app: AppBase, camera: Entity, settingsJson: any, config: Config) => {
    const events = new EventHandler();

    const state = observe(events, {
        readyToRender: false,
        hqMode: true,
        progress: 0,
        inputMode: 'desktop',
        cameraMode: 'fly',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasSplatAnimation: false,
        splatAnimationPlaying: false,
        splatAnimationMode: 'pingpong' as 'pingpong' | 'loop' | 'paused',
        splatAnimationSpeed: 1,
        hasAR: false,
        hasVR: false,
        isFullscreen: false,
        controlsHidden: false
    });

    const global: Global = {
        app,
        settings: importSettings(settingsJson),
        config,
        state,
        events,
        camera
    };

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    camera.addComponent('camera');

    // Initialize XR support
    initXr(global);

    // Initialize user interface
    initUI(global);

    // Check if this is an animated splat
    const isAnimated = config.contentUrl && AnimatedSplatPlayer.isAnimatedSplat(config.contentUrl);

    // Load model - either animated or regular
    let gsplatLoad: Promise<Entity>;
    
    if (isAnimated) {
        // For animated splats, we'll handle loading in the viewer
        // Create a placeholder promise that resolves to null
        gsplatLoad = Promise.resolve(null);
    } else {
        gsplatLoad = loadGsplat(
            app,
            config,
            (progress: number) => {
                state.progress = progress;
            }
        );
    }

    // Load skybox
    const skyboxLoad = config.skyboxUrl &&
        loadSkybox(app, config.skyboxUrl).then((asset) => {
            app.scene.envAtlas = asset.resource as Texture;
        });

    // Load and play sound
    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        document.body.addEventListener('click', () => {
            if (sound) {
                sound.play();
            }
        }, {
            capture: true,
            once: true
        });
    }

    // Create the viewer
    const viewer = new Viewer(global, gsplatLoad, skyboxLoad);

    // Listen for same-tab content swaps (same-origin only)
    try {
        const channel = new BroadcastChannel('ngty-supersplat-viewer');
        channel.addEventListener('message', (event) => {
            const data = (event as MessageEvent).data as any;
            if (data && data.type === 'loadSplat' && typeof data.contentUrl === 'string') {
                const mode = data.mode || 'replace'; // 'replace' or 'add'
                console.log('[ngty-swap] recv', {
                    contentUrl: data.contentUrl,
                    mode,
                    xrActive: app.xr.active,
                    xrType: app.xr.type,
                    visibility: document.visibilityState
                });
                
                if (mode === 'add') {
                    viewer.addSplat(data.contentUrl);
                } else {
                    viewer.loadSplat(data.contentUrl);
                }
            }
        });
    } catch {
        // ignore
    }

    // Dev-friendly cross-origin swap (webapp -> viewer) via window.postMessage
    window.addEventListener('message', (event: MessageEvent) => {
        // Only accept messages from the opener window (the webapp that launched us)
        if (window.opener && event.source !== window.opener) return;

        const data = event.data as any;
        if (data && data.type === 'loadSplat' && typeof data.contentUrl === 'string') {
            const mode = data.mode || 'replace';
            console.log('[ngty-swap] msg', {
                origin: event.origin,
                contentUrl: data.contentUrl,
                mode,
                xrActive: app.xr.active,
                xrType: app.xr.type,
                visibility: document.visibilityState
            });
            
            if (mode === 'add') {
                viewer.addSplat(data.contentUrl);
            } else {
                viewer.loadSplat(data.contentUrl);
            }
        }
    });

    return viewer;
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export { main };
