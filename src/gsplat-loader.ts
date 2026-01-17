import { Asset, Entity, type AppBase } from 'playcanvas';

import type { Config, Global } from './types';
import { AnimatedSplatPlayer } from './animated-splat-player';

/**
 * Check if a URL points to an animated splat sequence
 */
const isAnimatedSplat = (url: string): boolean => {
    // Strip query params before checking extension
    const urlWithoutQuery = url.split('?')[0];
    return urlWithoutQuery.toLowerCase().endsWith('.splatseq');
};

const loadGsplat = async (app: AppBase, config: Config, progressCallback: (progress: number) => void) => {
    const { contents, contentUrl, unified, aa } = config;
    
    // Check for animated splat format
    if (isAnimatedSplat(contentUrl)) {
        // Return null - animated splats are handled separately by the viewer
        // This signals that we need special handling
        return null;
    }
    
    const c = contents as unknown as ArrayBuffer;
    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();
    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;
    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);

    return new Promise<Entity>((resolve, reject) => {
        asset.on('load', () => {
            const entity = new Entity('gsplat');
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', {
                unified: unified || filename.toLowerCase().endsWith('lod-meta.json'),
                asset
            });
            // don't support AA in unified mode yet
            if (aa && !entity.gsplat.unified) {
                entity.gsplat.material.setDefine('GSPLAT_AA', true);
            }
            app.root.addChild(entity);
            resolve(entity);
        });

        let watermark = 0;
        asset.on('progress', (received, length) => {
            const progress = Math.min(1, received / length) * 100;
            if (progress > watermark) {
                watermark = progress;
                progressCallback(Math.trunc(watermark));
            }
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

export { loadGsplat };
