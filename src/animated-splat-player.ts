import { Asset, Entity, platform, Vec3, Quat } from 'playcanvas';

import type { Global } from './types';

/**
 * Manifest structure for .splatseq files
 */
interface SplatSeqManifest {
    format: 'splatseq';
    version: number;
    fps: number;
    frame_count: number;
    width: number;
    height: number;
    focal_length_px: number;
    compressed: boolean;
    frames: string[];
}

/**
 * AnimatedSplatPlayer handles loading and playback of .splatseq files
 * (animated gaussian splat sequences)
 */
class AnimatedSplatPlayer {
    private global: Global;

    private manifest: SplatSeqManifest | null = null;

    private frameAssets: Asset[] = [];

    private frameEntities: Entity[] = [];

    private currentFrame: number = 0;

    private isPlaying: boolean = false;

    private playbackTime: number = 0;

    private playbackDirection: number = 1; // 1 = forward, -1 = backward (for pingpong)

    private zipData: Map<string, ArrayBuffer> = new Map();

    // Preloading
    private preloadedFrames: Set<number> = new Set();

    private preloadAhead: number = 2; // frames to preload ahead (reduced for Quest)

    // Track frames currently being loaded to prevent duplicate loads
    private loadingFrames: Set<number> = new Set();

    // Skip sorting during playback (optimization #3)
    private sortSkipCounter: number = 0;

    // SPEC-11: adaptive sort interval — mobile gets longer skip
    private sortEveryNFrames: number = platform.mobile ? 10 : 5;

    // SPEC-11: track camera pose at last sort to skip when stationary
    private lastSortCameraPos = new Vec3();

    private lastSortCameraRot = new Quat();

    constructor(global: Global) {
        this.global = global;
    }

    /**
     * Check if a URL points to an animated splat sequence
     */
    static isAnimatedSplat(url: string): boolean {
        // Strip query params before checking extension
        const urlWithoutQuery = url.split('?')[0];
        return urlWithoutQuery.toLowerCase().endsWith('.splatseq');
    }

    /**
     * Load a .splatseq file and prepare for playback
     */
    async load(url: string, progressCallback: (progress: number) => void): Promise<Entity> {
        const { state } = this.global;

        // Fetch the zip file
        console.log('[AnimatedSplat] Starting download:', url);
        progressCallback(0);
        const response = await fetch(url);
        const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);
        console.log('[AnimatedSplat] Total bytes:', totalBytes);
        
        // Stream the response for progress tracking
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let receivedBytes = 0;

        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                receivedBytes += value.length;
                if (totalBytes > 0) {
                    const pct = Math.floor((receivedBytes / totalBytes) * 50);
                    progressCallback(pct); // 0-50% for download
                    if (receivedBytes % (10 * 1024 * 1024) < value.length) {
                        console.log(`[AnimatedSplat] Downloaded ${Math.round(receivedBytes / 1024 / 1024)}MB / ${Math.round(totalBytes / 1024 / 1024)}MB`);
                    }
                }
            }
        }

        console.log('[AnimatedSplat] Download complete, combining chunks...');

        // Combine chunks into ArrayBuffer
        const zipBuffer = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) {
            zipBuffer.set(chunk, offset);
            offset += chunk.length;
        }

        // Parse ZIP file
        console.log('[AnimatedSplat] Parsing ZIP...');
        progressCallback(50);
        try {
            await this.parseZip(zipBuffer.buffer);
        } catch (e) {
            console.error('[AnimatedSplat] ZIP parse error:', e);
            throw e;
        }

        console.log('[AnimatedSplat] ZIP parsed, files found:', Array.from(this.zipData.keys()));

        // Load manifest
        const manifestData = this.zipData.get('manifest.json');
        if (!manifestData) {
            throw new Error('Invalid .splatseq file: missing manifest.json');
        }
        this.manifest = JSON.parse(new TextDecoder().decode(manifestData));
        
        console.log(`[AnimatedSplat] Loaded manifest: ${this.manifest.frame_count} frames @ ${this.manifest.fps} fps`);

        // Update state for splat animation controls (independent of camera animation)
        state.hasSplatAnimation = true;
        state.splatAnimationPlaying = true;
        state.splatAnimationMode = 'pingpong'; // Default to pingpong for seamless looping
        state.splatAnimationSpeed = 1; // Default to normal speed
        this.playbackDirection = 1;

        // Load first frame immediately
        progressCallback(60);
        const firstFrameEntity = await this.loadFrame(0);
        this.frameEntities[0] = firstFrameEntity;
        this.preloadedFrames.add(0);
        
        // Start preloading more frames in background
        this.preloadFrames(1, Math.min(this.preloadAhead, this.manifest.frame_count - 1));

        progressCallback(100);

        // Set up update loop
        this.setupUpdateLoop();

        return firstFrameEntity;
    }

    /**
     * Parse a ZIP file into memory
     */
    private async parseZip(buffer: ArrayBuffer): Promise<void> {
        // Simple ZIP parser - reads local file headers
        const view = new DataView(buffer);
        let offset = 0;

        while (offset < buffer.byteLength - 4) {
            const signature = view.getUint32(offset, true);
            
            // Local file header signature
            if (signature !== 0x04034b50) {
                // Try to find end of central directory or next header
                offset++;
                continue;
            }

            const compressionMethod = view.getUint16(offset + 8, true);
            const compressedSize = view.getUint32(offset + 18, true);
            // const uncompressedSize = view.getUint32(offset + 22, true);
            const fileNameLength = view.getUint16(offset + 26, true);
            const extraFieldLength = view.getUint16(offset + 28, true);

            const fileNameBytes = new Uint8Array(buffer, offset + 30, fileNameLength);
            const fileName = new TextDecoder().decode(fileNameBytes);

            const dataStart = offset + 30 + fileNameLength + extraFieldLength;
            const compressedData = new Uint8Array(buffer, dataStart, compressedSize);

            if (compressionMethod === 0) {
                // Stored (no compression) - copy the data directly
                const uncompressedData = new Uint8Array(compressedSize);
                uncompressedData.set(new Uint8Array(buffer, dataStart, compressedSize));
                this.zipData.set(fileName, uncompressedData.buffer);
            } else if (compressionMethod === 8) {
                // Deflate compression - use DecompressionStream
                const decompressed = await this.decompressDeflate(compressedData);
                this.zipData.set(fileName, decompressed);
            } else {
                console.warn(`[AnimatedSplat] Unsupported compression method ${compressionMethod} for ${fileName}`);
            }

            offset = dataStart + compressedSize;
        }
    }

    /**
     * Decompress deflate data using Web Streams API
     */
    private async decompressDeflate(data: Uint8Array): Promise<ArrayBuffer> {
        // Add zlib header for raw deflate
        const zlibData = new Uint8Array(data.length + 2);
        zlibData[0] = 0x78; // CMF
        zlibData[1] = 0x9c; // FLG
        zlibData.set(data, 2);

        try {
            const ds = new DecompressionStream('deflate');
            const writer = ds.writable.getWriter();
            writer.write(data.slice().buffer);
            writer.close();
            
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            
            return result.buffer;
        } catch {
            // Fallback: try with deflate-raw
            try {
                const ds = new DecompressionStream('deflate-raw');
                const writer = ds.writable.getWriter();
                writer.write(data.slice().buffer);
                writer.close();
                
                const reader = ds.readable.getReader();
                const chunks: Uint8Array[] = [];
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }
                
                const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
                const result = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    result.set(chunk, offset);
                    offset += chunk.length;
                }
                
                return result.buffer;
            } catch (e) {
                console.error('[AnimatedSplat] Decompression failed:', e);
                throw e;
            }
        }
    }

    /**
     * Load a single frame as a gsplat entity
     */
    private loadFrame(frameIndex: number): Promise<Entity> {
        const { app } = this.global;
        
        if (!this.manifest) {
            throw new Error('Manifest not loaded');
        }

        const framePath = this.manifest.frames[frameIndex];
        const frameData = this.zipData.get(framePath);
        
        if (!frameData) {
            throw new Error(`Frame ${frameIndex} not found in archive: ${framePath}`);
        }

        // Create a mock Response object - the PlayCanvas PLY loader expects asset.file.contents
        // to be a Response (it calls response.body.getReader())
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(frameData));
                controller.close();
            }
        });
        const mockResponse = new Response(stream, {
            headers: { 'content-length': String(frameData.byteLength) }
        });

        const filename = `frame_${frameIndex.toString().padStart(4, '0')}.ply`;
        
        // Create asset with file.contents as a Response object
        const asset = new Asset(filename, 'gsplat', {
            url: filename,
            filename
        });
        asset.file = {
            url: filename,
            filename,
            contents: mockResponse
        };

        return new Promise<Entity>((resolve, reject) => {
            asset.on('load', () => {
                const entity = new Entity(`gsplat_frame_${frameIndex}`);
                entity.setLocalEulerAngles(0, 0, 180);
                entity.addComponent('gsplat', { asset });
                
                // Hide by default (only current frame visible)
                entity.enabled = frameIndex === this.currentFrame;
                
                app.root.addChild(entity);
                this.frameAssets[frameIndex] = asset;
                
                resolve(entity);
            });

            asset.on('error', (err) => {
                console.error(`[AnimatedSplat] Failed to load frame ${frameIndex}:`, err);
                reject(err);
            });

            app.assets.add(asset);
            app.assets.load(asset);
        });
    }

    /**
     * Preload frames in background
     */
    private async preloadFrames(start: number, end: number): Promise<void> {
        for (let i = start; i <= end; i++) {
            // Skip if already loaded, already preloaded, or currently loading
            if (this.frameEntities[i] || this.preloadedFrames.has(i) || this.loadingFrames.has(i)) {
                continue;
            }
            
            // Mark as loading to prevent duplicate attempts
            this.loadingFrames.add(i);
            
            try {
                const entity = await this.loadFrame(i);
                this.frameEntities[i] = entity;
                this.preloadedFrames.add(i);
            } catch (e) {
                console.error(`[AnimatedSplat] Failed to preload frame ${i}:`, e);
            } finally {
                this.loadingFrames.delete(i);
            }
        }
    }

    /**
     * Set up the update loop for animation playback
     */
    private setupUpdateLoop(): void {
        const { app, state, events } = this.global;

        // Listen for scrub events
        events.on('scrubAnim', (time: number) => {
            this.seekTo(time);
        });

        app.on('update', (dt) => {
            if (!this.manifest || !state.hasSplatAnimation) return;

            // Handle playback based on mode
            const mode = state.splatAnimationMode;
            const speed = state.splatAnimationSpeed ?? 1;
            
            if (mode !== 'paused') {
                const duration = this.manifest.frame_count / this.manifest.fps;
                const scaledDt = dt * speed;
                
                if (mode === 'pingpong') {
                    // Ping-pong: forward then backward
                    this.playbackTime += scaledDt * this.playbackDirection;
                    
                    if (this.playbackTime >= duration) {
                        this.playbackTime = duration;
                        this.playbackDirection = -1; // Reverse
                    } else if (this.playbackTime <= 0) {
                        this.playbackTime = 0;
                        this.playbackDirection = 1; // Forward
                    }
                } else if (mode === 'loop') {
                    // Normal loop: always forward, wrap around
                    this.playbackTime += scaledDt;
                    if (this.playbackTime >= duration) {
                        this.playbackTime = 0;
                    }
                }
                
                // Calculate current frame
                const targetFrame = Math.min(
                    Math.floor(this.playbackTime * this.manifest.fps),
                    this.manifest.frame_count - 1
                );
                
                if (targetFrame !== this.currentFrame) {
                    this.showFrame(targetFrame);
                }
            }

            // Preload upcoming frames
            if (this.manifest) {
                const nextFrame = (this.currentFrame + 1) % this.manifest.frame_count;
                const preloadEnd = (this.currentFrame + this.preloadAhead) % this.manifest.frame_count;
                
                // Handle wrap-around
                if (preloadEnd > nextFrame) {
                    this.preloadFrames(nextFrame, preloadEnd);
                } else {
                    this.preloadFrames(nextFrame, this.manifest.frame_count - 1);
                    this.preloadFrames(0, preloadEnd);
                }
            }

            // Request render
            app.renderNextFrame = true;
        });
    }

    /**
     * Show a specific frame (hide others)
     * Includes sort-skipping optimization (#3) for smoother playback
     */
    private async showFrame(frameIndex: number): Promise<void> {
        const { state } = this.global;
        
        // Hide current frame
        if (this.frameEntities[this.currentFrame]) {
            this.frameEntities[this.currentFrame].enabled = false;
        }

        // Load frame if not already loaded
        if (!this.frameEntities[frameIndex]) {
            try {
                const entity = await this.loadFrame(frameIndex);
                this.frameEntities[frameIndex] = entity;
                this.preloadedFrames.add(frameIndex);
            } catch (e) {
                console.error(`[AnimatedSplat] Failed to load frame ${frameIndex} on demand:`, e);
                return;
            }
        }

        // Show new frame
        const newFrameEntity = this.frameEntities[frameIndex];
        newFrameEntity.enabled = true;
        this.currentFrame = frameIndex;

        // SPEC-11: Skip sorting during playback (expensive on Quest)
        // Sort every N frames, but only if camera actually moved
        this.sortSkipCounter++;
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
            const gsplat = (newFrameEntity as any).gsplat;
            if (gsplat?.instance) {
                gsplat.instance.sort(this.global.camera);
            }
        }
    }

    /**
     * Seek to a specific time
     */
    seekTo(time: number): void {
        if (!this.manifest) return;
        
        this.playbackTime = Math.max(0, Math.min(time, this.global.state.animationDuration));
        this.global.state.animationTime = this.playbackTime;
        
        const targetFrame = Math.floor(this.playbackTime * this.manifest.fps) % this.manifest.frame_count;
        if (targetFrame !== this.currentFrame) {
            this.showFrame(targetFrame);
        }
    }

    /**
     * Get the currently visible entity (for bounds calculation etc)
     */
    getCurrentEntity(): Entity | null {
        return this.frameEntities[this.currentFrame] || null;
    }

    /**
     * Clean up resources
     */
    destroy(): void {
        const { app } = this.global;
        
        // Destroy all frame entities and assets
        for (const entity of this.frameEntities) {
            if (entity) {
                entity.destroy();
            }
        }
        
        for (const asset of this.frameAssets) {
            if (asset) {
                asset.unload();
                app.assets.remove(asset);
            }
        }

        this.frameEntities = [];
        this.frameAssets = [];
        this.zipData.clear();
        this.preloadedFrames.clear();
        this.manifest = null;
    }
}

export { AnimatedSplatPlayer, SplatSeqManifest };
