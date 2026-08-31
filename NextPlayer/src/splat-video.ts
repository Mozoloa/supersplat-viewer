import {
    Entity,
    GSplatContainer,
    GSplatFormat,
    PIXELFORMAT_RGBA8,
    Vec3,
    type AppBase,
    type Texture
} from 'playcanvas';
import { Mp4VideoDecoder } from './mp4-video-decoder';
import { mediaFetch } from './media-request';

const PROBE_BYTES = 16;
const TILE = 16;
const IDENTITY_RGBA_TO_LUMA = Uint8Array.from({ length: 256 }, (_unused, value) => value);
const LIMITED_EXPANDED_RGBA_TO_LUMA = Uint8Array.from({ length: 256 }, (_unused, value) => {
    if (value === 0 || value === 255) return value;
    return Math.round(value * 219 / 255 + 16);
});

interface ByteRange {
    offset: number;
    length: number;
    raw_length: number;
}

interface AttributeBounds {
    position_min: number[];
    position_max: number[];
    scale_min: number[];
    scale_max: number[];
    color_min: number[];
    color_max: number[];
}

export interface SplatVideoManifest {
    format: 'ems-splat-video';
    version: 1;
    fps: number;
    frame_count: number;
    width: number;
    height: number;
    focal_length_px: number;
    duration_seconds?: number;
    audio_offset_seconds?: number;
    splats_per_frame: number;
    grid: [number, number];
    layers: number;
    video: {
        path: string;
        codec: string;
        dimensions: [number, number];
        pixel_format: 'I420-or-NV12' | 'RGBA-luma';
        rgba_luma_decode?: 'limited-expanded-inverse';
        qp: number;
        mapping: { Y: number[]; U: number[]; V: number[] };
    };
    exact: {
        path: string;
        codec: 'deflate';
        layout?: 'planes' | 'texture-ready-v1' | 'texture-ready-v2';
        mapping: number[];
        frames: ByteRange[];
    };
    residual?: {
        path: string;
        codec: 'deflate';
        operation: 'add-u8';
        mapping: number[];
        frames: ByteRange[];
        fingerprints?: number[];
    };
    attributes: {
        plane_count: number;
        position_bits: 16;
        scale_bits: 8;
        rotation_bits: 8;
        color_bits: 8;
        alpha_bits: 8;
        bounds_mode: 'frame' | 'first-margin';
        bounds: AttributeBounds[];
    };
    frame_to_canonical?: number[][];
}

const rangeFetch = async (url: string, start: number, end: number): Promise<ArrayBuffer> => {
    const response = await mediaFetch(url, {
        headers: { Range: `bytes=${start}-${end}` }
    });
    if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`Attribute side-data server did not honor byte range ${start}-${end} (HTTP ${response.status}).`);
    }
    const result = await response.arrayBuffer();
    if (result.byteLength !== end - start + 1) {
        throw new Error(`Attribute side-data range was truncated (${result.byteLength}/${end - start + 1}).`);
    }
    return result;
};

const inflateDeflate = async (compressed: ArrayBuffer, expectedBytes: number, label: string): Promise<Uint8Array> => {
    const output = new Uint8Array(expectedBytes);
    const reader = new Blob([compressed]).stream()
        .pipeThrough(new DecompressionStream('deflate'))
        .getReader();
    let offset = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (offset + value.byteLength > output.byteLength) {
                throw new Error(`${label} expanded beyond ${expectedBytes} bytes.`);
            }
            output.set(value, offset);
            offset += value.byteLength;
        }
    } finally {
        reader.releaseLock();
    }
    if (offset !== expectedBytes) {
        throw new Error(`${label} expanded to ${offset}/${expectedBytes} bytes.`);
    }
    return output;
};

const validateNumberArray = (value: unknown, length: number): value is number[] =>
    Array.isArray(value) && value.length === length && value.every(item => Number.isFinite(item));

const validateManifest = (value: unknown): SplatVideoManifest => {
    const manifest = value as Partial<SplatVideoManifest> | null;
    if (!manifest || manifest.format !== 'ems-splat-video' || manifest.version !== 1) {
        throw new Error('Unsupported splat-video manifest.');
    }
    if (!Number.isFinite(manifest.fps) || manifest.fps! <= 0
        || !Number.isInteger(manifest.frame_count) || manifest.frame_count! < 2
        || !Number.isInteger(manifest.splats_per_frame) || manifest.splats_per_frame! < 1
        || !Array.isArray(manifest.grid) || manifest.grid.length !== 2
        || manifest.grid.some(value => !Number.isInteger(value) || value < TILE || value % TILE)
        || !Number.isInteger(manifest.layers) || manifest.layers! < 1
        || manifest.grid[0] * manifest.grid[1] * manifest.layers! !== manifest.splats_per_frame
        || !manifest.video || !validateNumberArray(manifest.video.dimensions, 2)
        || manifest.video.dimensions.some(value => !Number.isInteger(value) || value < TILE || value % 2)
        || !manifest.exact || manifest.exact.codec !== 'deflate'
        || !Array.isArray(manifest.exact.frames) || manifest.exact.frames.length !== manifest.frame_count
        || !manifest.attributes || !Array.isArray(manifest.attributes.bounds)
        || manifest.attributes.bounds.length !== manifest.frame_count) {
        throw new Error('Splat-video metadata is invalid.');
    }
    for (const frame of manifest.exact.frames) {
        if (!frame || !Number.isSafeInteger(frame.offset) || frame.offset < 0
            || !Number.isSafeInteger(frame.length) || frame.length < 1
            || !Number.isSafeInteger(frame.raw_length) || frame.raw_length < 1) {
            throw new Error('Splat-video exact side-data index is invalid.');
        }
    }
    if (manifest.residual) {
        if (manifest.residual.codec !== 'deflate'
            || manifest.residual.operation !== 'add-u8'
            || !Array.isArray(manifest.residual.mapping)
            || manifest.residual.mapping.length < 1
            || manifest.residual.mapping.some(value => !Number.isInteger(value) || value < 0)
            || !Array.isArray(manifest.residual.frames)
            || manifest.residual.frames.length !== manifest.frame_count
            || (manifest.residual.fingerprints !== undefined
                && (!Array.isArray(manifest.residual.fingerprints)
                    || manifest.residual.fingerprints.length !== manifest.frame_count
                    || manifest.residual.fingerprints.some(value => !Number.isInteger(value)
                        || value < 0 || value > 0xffffffff)))) {
            throw new Error('Splat-video lossless residual metadata is invalid.');
        }
        for (const frame of manifest.residual.frames) {
            if (!frame || !Number.isSafeInteger(frame.offset) || frame.offset < 0
                || !Number.isSafeInteger(frame.length) || frame.length < 1
                || !Number.isSafeInteger(frame.raw_length) || frame.raw_length < 1) {
                throw new Error('Splat-video lossless residual index is invalid.');
            }
        }
    }
    for (const bounds of manifest.attributes.bounds) {
        if (!bounds
            || !validateNumberArray(bounds.position_min, 3) || !validateNumberArray(bounds.position_max, 3)
            || !validateNumberArray(bounds.scale_min, 3) || !validateNumberArray(bounds.scale_max, 3)
            || !validateNumberArray(bounds.color_min, 3) || !validateNumberArray(bounds.color_max, 3)) {
            throw new Error('Splat-video attribute bounds are invalid.');
        }
    }
    if (manifest.attributes.position_bits !== 16
        || manifest.attributes.scale_bits !== 8
        || manifest.attributes.rotation_bits !== 8
        || manifest.attributes.color_bits !== 8
        || manifest.attributes.alpha_bits !== 8) {
        throw new Error('This player build expects pos16/scale8/rotation8/color8/alpha8 splat-video attributes.');
    }
    return manifest as SplatVideoManifest;
};

export class SplatVideoSource {
    readonly url: string;
    readonly manifest: SplatVideoManifest;
    readonly videoUrl: string;
    readonly exactUrl: string;
    readonly residualUrl: string | null;
    exactDownloadedBytes = 0;
    exactNetworkRequests = 0;
    exactCacheHits = 0;
    exactCacheBytes = 0;
    residualDownloadedBytes = 0;
    residualNetworkRequests = 0;
    residualCacheHits = 0;
    residualCacheBytes = 0;

    private readonly exactCache = new Map<number, Promise<Uint8Array>>();
    private readonly exactCacheReservations = new Map<number, number>();
    private readonly residualCache = new Map<number, Promise<Uint8Array>>();
    private readonly residualCacheReservations = new Map<number, number>();
    private readonly prefetchQueue: number[] = [];
    private readonly prefetchQueued = new Set<number>();
    private prefetchActive = 0;
    private readonly maxPrefetchConcurrency = 3;
    private readonly maxExactCacheBytes = 96 * 1024 * 1024;
    private readonly maxResidualCacheBytes = 32 * 1024 * 1024;

    private constructor(url: string, manifest: SplatVideoManifest) {
        this.url = url;
        this.manifest = manifest;
        this.videoUrl = new URL(manifest.video.path, url).href;
        this.exactUrl = new URL(manifest.exact.path, url).href;
        this.residualUrl = manifest.residual ? new URL(manifest.residual.path, url).href : null;
    }

    static async openIfPresent(url: string): Promise<SplatVideoSource | null> {
        const probe = await rangeFetch(url, 0, PROBE_BYTES - 1);
        const text = new TextDecoder().decode(probe).trimStart();
        if (!text.startsWith('{')) return null;
        const response = await mediaFetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Splat-video manifest failed: HTTP ${response.status}.`);
        const manifest = validateManifest(await response.json());
        return new SplatVideoSource(url, manifest);
    }

    async readExactFrame(index: number): Promise<Uint8Array> {
        const cached = this.exactCache.get(index);
        if (cached) {
            this.exactCacheHits++;
            this.exactCache.delete(index);
            this.exactCache.set(index, cached);
            return await cached;
        }
        return await this.loadExactFrame(index);
    }

    async readResidualFrame(index: number): Promise<Uint8Array | null> {
        if (!this.manifest.residual || !this.residualUrl) return null;
        const cached = this.residualCache.get(index);
        if (cached) {
            this.residualCacheHits++;
            this.residualCache.delete(index);
            this.residualCache.set(index, cached);
            return await cached;
        }
        return await this.loadResidualFrame(index);
    }

    prefetchAfter(index: number, count: number): void {
        for (let distance = 1; distance <= count; distance++) {
            const candidate = (index + distance) % this.manifest.frame_count;
            if (!this.exactCache.has(candidate) && !this.prefetchQueued.has(candidate)) {
                this.prefetchQueue.push(candidate);
                this.prefetchQueued.add(candidate);
            }
        }
        this.pumpPrefetch();
    }

    async primeAfter(index: number, count: number): Promise<void> {
        // Bound both network and DecompressionStream concurrency. Starting a
        // dozen 6+ MB inflates at once causes worse Quest stalls than waiting
        // for a short, deterministic startup buffer.
        for (let offset = 1; offset <= count; offset += this.maxPrefetchConcurrency) {
            const batch: Promise<Uint8Array>[] = [];
            for (let lane = 0; lane < this.maxPrefetchConcurrency && offset + lane <= count; lane++) {
                batch.push(this.readExactFrame((index + offset + lane) % this.manifest.frame_count));
            }
            await Promise.all(batch);
        }
    }

    private async loadExactFrame(index: number): Promise<Uint8Array> {
        const entry = this.manifest.exact.frames[index];
        if (!entry) throw new Error(`Exact frame ${index} is outside the animation.`);
        const promise = (async (): Promise<Uint8Array> => {
            this.exactNetworkRequests++;
            const compressed = await rangeFetch(this.exactUrl, entry.offset, entry.offset + entry.length - 1);
            this.exactDownloadedBytes += compressed.byteLength;
            return await inflateDeflate(compressed, entry.raw_length, `Exact frame ${index}`);
        })();
        this.exactCache.set(index, promise);
        this.exactCacheReservations.set(index, entry.raw_length);
        this.exactCacheBytes += entry.raw_length;
        this.trimExactCache(index);
        try {
            return await promise;
        } catch (error) {
            if (this.exactCache.get(index) === promise) this.removeExactCacheEntry(index);
            throw error;
        }
    }

    private async loadResidualFrame(index: number): Promise<Uint8Array> {
        const residual = this.manifest.residual;
        if (!residual || !this.residualUrl) throw new Error('Lossless residual stream is unavailable.');
        const entry = residual.frames[index];
        if (!entry) throw new Error(`Residual frame ${index} is outside the animation.`);
        const promise = (async (): Promise<Uint8Array> => {
            this.residualNetworkRequests++;
            const compressed = await rangeFetch(this.residualUrl!, entry.offset, entry.offset + entry.length - 1);
            this.residualDownloadedBytes += compressed.byteLength;
            return await inflateDeflate(compressed, entry.raw_length, `Residual frame ${index}`);
        })();
        this.residualCache.set(index, promise);
        this.residualCacheReservations.set(index, entry.raw_length);
        this.residualCacheBytes += entry.raw_length;
        this.trimResidualCache(index);
        try {
            return await promise;
        } catch (error) {
            if (this.residualCache.get(index) === promise) this.removeResidualCacheEntry(index);
            throw error;
        }
    }

    private trimExactCache(protectedIndex: number): void {
        while (this.exactCacheBytes > this.maxExactCacheBytes && this.exactCache.size > 1) {
            const oldest = this.exactCache.keys().next().value as number | undefined;
            if (oldest === undefined) break;
            if (oldest === protectedIndex) {
                const protectedPromise = this.exactCache.get(oldest)!;
                this.exactCache.delete(oldest);
                this.exactCache.set(oldest, protectedPromise);
                continue;
            }
            this.removeExactCacheEntry(oldest);
        }
    }

    private removeExactCacheEntry(index: number): void {
        if (!this.exactCache.delete(index)) return;
        this.exactCacheBytes -= this.exactCacheReservations.get(index) ?? 0;
        this.exactCacheReservations.delete(index);
    }

    private trimResidualCache(protectedIndex: number): void {
        while (this.residualCacheBytes > this.maxResidualCacheBytes && this.residualCache.size > 1) {
            const oldest = this.residualCache.keys().next().value as number | undefined;
            if (oldest === undefined) break;
            if (oldest === protectedIndex) {
                const protectedPromise = this.residualCache.get(oldest)!;
                this.residualCache.delete(oldest);
                this.residualCache.set(oldest, protectedPromise);
                continue;
            }
            this.removeResidualCacheEntry(oldest);
        }
    }

    private removeResidualCacheEntry(index: number): void {
        if (!this.residualCache.delete(index)) return;
        this.residualCacheBytes -= this.residualCacheReservations.get(index) ?? 0;
        this.residualCacheReservations.delete(index);
    }

    private pumpPrefetch(): void {
        while (this.prefetchActive < this.maxPrefetchConcurrency && this.prefetchQueue.length) {
            const index = this.prefetchQueue.shift()!;
            this.prefetchQueued.delete(index);
            if (this.exactCache.has(index)) continue;
            this.prefetchActive++;
            void this.loadExactFrame(index).catch(error => {
                console.warn(`[SplatVideo] Exact-frame prefetch ${index} failed:`, error);
            }).finally(() => {
                this.prefetchActive--;
                this.pumpPrefetch();
            });
        }
    }
}

const READ_GLSL = `
uniform vec3 emsPositionMin;
uniform vec3 emsPositionMax;
uniform vec3 emsScaleMin;
uniform vec3 emsScaleMax;
uniform vec3 emsColorMin;
uniform vec3 emsColorMax;

vec3 getCenter() {
    vec3 low = floor(loadMeansLow().xyz * 255.0 + 0.5);
    vec3 high = floor(loadMeansHigh().xyz * 255.0 + 0.5);
    vec3 q = (low + high * 256.0) / 65535.0;
    return mix(emsPositionMin, emsPositionMax, q);
}
vec3 getScale() {
    return exp(mix(emsScaleMin, emsScaleMax, loadScales().xyz));
}
vec4 getRotation() {
    return normalize(loadRotations() * 2.0 - 1.0);
}
vec4 getColor() {
    vec4 value = loadColors();
    return vec4(mix(emsColorMin, emsColorMax, value.xyz), value.w);
}
`;

const READ_WGSL = `
uniform emsPositionMin: vec3f;
uniform emsPositionMax: vec3f;
uniform emsScaleMin: vec3f;
uniform emsScaleMax: vec3f;
uniform emsColorMin: vec3f;
uniform emsColorMax: vec3f;

fn getCenter() -> vec3f {
    let low = floor(loadMeansLow().xyz * 255.0 + 0.5);
    let high = floor(loadMeansHigh().xyz * 255.0 + 0.5);
    let q = (low + high * 256.0) / 65535.0;
    return mix(uniform.emsPositionMin, uniform.emsPositionMax, q);
}
fn getScale() -> vec3f {
    return exp(mix(uniform.emsScaleMin, uniform.emsScaleMax, loadScales().xyz));
}
fn getRotation() -> vec4f {
    return normalize(loadRotations() * 2.0 - 1.0);
}
fn getColor() -> vec4f {
    let value = loadColors();
    return vec4f(mix(uniform.emsColorMin, uniform.emsColorMax, value.xyz), value.w);
}
`;

const textureWords = (texture: Texture): Uint32Array => {
    const bytes = texture.lock() as Uint8Array;
    return new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
};

const unlock = (texture: Texture): void => texture.unlock();

export interface SplatVideoPlayerOptions {
    app: AppBase;
    contentRoot: Entity;
    source: SplatVideoSource;
    audioUrl?: string | null;
    onStateChange?: () => void;
}

export class SplatVideoPlayer {
    readonly manifest: SplatVideoManifest;
    playing = false;
    droppedFrames = 0;
    currentSplatCount = 0;

    private readonly app: AppBase;
    private readonly contentRoot: Entity;
    private readonly source: SplatVideoSource;
    private readonly onStateChange?: () => void;
    private readonly audio: HTMLAudioElement | null;
    private readonly positionMin = new Float32Array(3);
    private readonly positionMax = new Float32Array(3);
    private readonly scaleMin = new Float32Array(3);
    private readonly scaleMax = new Float32Array(3);
    private readonly colorMin = new Float32Array(3);
    private readonly colorMax = new Float32Array(3);
    private readonly planes: Array<Uint8Array | null>;
    private readonly planePixels: number;
    private readonly sourceTileColumns: number;
    private readonly sourceTileRows: number;
    private readonly rgbaLumaLut: Uint8Array;
    private atlasTileBases: Uint32Array | null = null;
    private exactFrame: Uint8Array | null = null;
    private residualFrame: Uint8Array | null = null;
    private frameCopy: Uint8Array | null = null;
    private lumaCopy: Uint8Array | null = null;
    private chromaU: Uint8Array | null = null;
    private chromaV: Uint8Array | null = null;
    private container: GSplatContainer | null = null;
    private entity: Entity | null = null;
    private currentFrame = -1;
    private frameBusy = false;
    private pollTimer = 0;
    private decoder: Mp4VideoDecoder | null = null;
    private destroyed = false;
    private playbackOffset = 0;
    private playbackStartedAt = 0;
    private decodedFrames = 0;
    private uploadedFrames = 0;
    private copiedBytes = 0;
    private decodeUploadTotalMs = 0;
    private videoWaitTotalMs = 0;
    private videoCopyTotalMs = 0;
    private exactTotalMs = 0;
    private residualTotalMs = 0;
    private textureUploadTotalMs = 0;
    private nativeFormat = 'pending';
    private decodedColorSpace = 'pending';
    private stage = 'constructed';
    private attributeFingerprint = 0;
    private readonly distinctAttributeFingerprints = new Set<number>();
    private presentedFrames = 0;
    private lastPresentedFrame = -1;
    private lastFrameEndAt = performance.now();
    private forcedFlatPresentations = 0;
    private readonly presentedFrameIndices = new Set<number>();
    private readonly presentedAttributeFingerprints = new Set<number>();
    private readonly pollHandler = (): void => this.pollVideoFrame();
    private readonly frameEndHandler = (): void => {
        this.lastFrameEndAt = performance.now();
        this.presentedFrames++;
        if (this.currentFrame < 0) return;
        this.lastPresentedFrame = this.currentFrame;
        this.presentedFrameIndices.add(this.currentFrame);
        this.presentedAttributeFingerprints.add(this.attributeFingerprint);
    };

    constructor(options: SplatVideoPlayerOptions) {
        this.app = options.app;
        this.contentRoot = options.contentRoot;
        this.source = options.source;
        this.manifest = options.source.manifest;
        this.onStateChange = options.onStateChange;
        this.planePixels = this.manifest.grid[0] * this.manifest.grid[1] * this.manifest.layers;
        this.sourceTileColumns = this.manifest.grid[0] / TILE;
        this.sourceTileRows = this.manifest.grid[1] * this.manifest.layers / TILE;
        this.rgbaLumaLut = this.manifest.video.rgba_luma_decode === 'limited-expanded-inverse'
            ? LIMITED_EXPANDED_RGBA_TO_LUMA
            : IDENTITY_RGBA_TO_LUMA;
        this.planes = Array.from({ length: this.manifest.attributes.plane_count }, () => null);
        this.audio = options.audioUrl ? new Audio(options.audioUrl) : null;
        if (this.audio) {
            this.audio.preload = 'auto';
            this.audio.loop = true;
            this.audio.load();
        }
        this.app.on('frameend', this.frameEndHandler);
        (globalThis as typeof globalThis & { __emsSplatVideoPlayer?: SplatVideoPlayer })
            .__emsSplatVideoPlayer = this;
    }

    get debugSnapshot(): Record<string, unknown> {
        return {
            stage: this.stage,
            currentFrame: this.currentFrame,
            decodedFrames: this.decodedFrames,
            uploadedFrames: this.uploadedFrames,
            nativeFormat: this.nativeFormat,
            decodedColorSpace: this.decodedColorSpace,
            decoderCodec: this.decoder?.codec ?? 'pending',
            decoderQueueSize: this.decoder?.decodeQueueSize ?? 0,
            decoderSeekCount: this.decoder?.seekCount ?? 0,
            skippedCompressedSamples: this.decoder?.skippedCompressedSamples ?? 0,
            videoNetworkRequests: this.decoder?.networkRequests ?? 0,
            videoDownloadedBytes: this.decoder?.downloadedBytes ?? 0,
            videoCompressedCacheBytes: this.decoder?.compressedCacheBytes ?? 0,
            averageDecodeUploadMs: this.uploadedFrames ? this.decodeUploadTotalMs / this.uploadedFrames : 0,
            averageVideoWaitMs: this.uploadedFrames ? this.videoWaitTotalMs / this.uploadedFrames : 0,
            averageVideoCopyMs: this.uploadedFrames ? this.videoCopyTotalMs / this.uploadedFrames : 0,
            averageExactWaitMs: this.uploadedFrames ? this.exactTotalMs / this.uploadedFrames : 0,
            averageResidualWaitMs: this.uploadedFrames ? this.residualTotalMs / this.uploadedFrames : 0,
            averageTextureUploadMs: this.uploadedFrames ? this.textureUploadTotalMs / this.uploadedFrames : 0,
            exactNetworkRequests: this.source.exactNetworkRequests,
            exactDownloadedBytes: this.source.exactDownloadedBytes,
            exactCacheHits: this.source.exactCacheHits,
            exactCacheBytes: this.source.exactCacheBytes,
            residualNetworkRequests: this.source.residualNetworkRequests,
            residualDownloadedBytes: this.source.residualDownloadedBytes,
            residualCacheHits: this.source.residualCacheHits,
            residualCacheBytes: this.source.residualCacheBytes,
            losslessResidual: Boolean(this.manifest.residual),
            videoPaused: !this.playing,
            videoTime: this.playbackTime(),
            manifestFrames: this.manifest.frame_count,
            manifestDuration: this.manifest.duration_seconds ?? this.manifest.frame_count / this.manifest.fps,
            attributeFingerprint: this.attributeFingerprint.toString(16).padStart(8, '0'),
            distinctAttributeFingerprints: this.distinctAttributeFingerprints.size,
            presentedFrames: this.presentedFrames,
            forcedFlatPresentations: this.forcedFlatPresentations,
            lastPresentedFrame: this.lastPresentedFrame,
            presentedFrameIndices: this.presentedFrameIndices.size,
            presentedAttributeFingerprints: this.presentedAttributeFingerprints.size,
            audio: this.audio ? {
                currentTime: this.audio.currentTime,
                duration: this.audio.duration,
                paused: this.audio.paused,
                readyState: this.audio.readyState,
                error: this.audio.error ? {
                    code: this.audio.error.code,
                    message: this.audio.error.message
                } : null
            } : null
        };
    }

    get diagnostics(): string[] {
        const average = this.uploadedFrames ? this.decodeUploadTotalMs / this.uploadedFrames : 0;
        const videoWaitAverage = this.uploadedFrames ? this.videoWaitTotalMs / this.uploadedFrames : 0;
        const videoCopyAverage = this.uploadedFrames ? this.videoCopyTotalMs / this.uploadedFrames : 0;
        const exactAverage = this.uploadedFrames ? this.exactTotalMs / this.uploadedFrames : 0;
        const residualAverage = this.uploadedFrames ? this.residualTotalMs / this.uploadedFrames : 0;
        const textureUploadAverage = this.uploadedFrames ? this.textureUploadTotalMs / this.uploadedFrames : 0;
        return [
            `Splat video: ${this.nativeFormat} · ${this.manifest.video.dimensions.join('×')} · QP ${this.manifest.video.qp} · exact ${this.manifest.exact.layout ?? 'planes'}${this.manifest.residual ? ' + byte-exact residual' : ''}`,
            `Attribute samples: ${this.uploadedFrames} uploaded · ${this.droppedFrames} video frames dropped`,
            `Visual proof: ${this.distinctAttributeFingerprints.size} decoded fingerprints · ${this.presentedAttributeFingerprints.size} presented`,
            `Decode/copy/upload: ${average.toFixed(1)} ms avg · exact side ${exactAverage.toFixed(1)} ms avg · residual ${residualAverage.toFixed(1)} ms avg`,
            `Breakdown: video wait ${videoWaitAverage.toFixed(1)} · RGBA copy/unpack ${videoCopyAverage.toFixed(1)} · pack/upload ${textureUploadAverage.toFixed(1)} ms`,
            `Streamed: ${(this.copiedBytes / 1048576).toFixed(1)} MB decoded atlas · ${((this.decoder?.downloadedBytes ?? 0) / 1048576).toFixed(1)} MB video ranges · ${(this.source.exactDownloadedBytes / 1048576).toFixed(1)} MB exact ranges · ${(this.source.residualDownloadedBytes / 1048576).toFixed(1)} MB residual ranges · ${(this.source.exactCacheBytes / 1048576).toFixed(1)} MB rolling exact cache`
        ];
    }

    async load(onProgress: (progress: number) => void): Promise<Entity> {
        onProgress(5);
        this.stage = 'demuxing-attribute-video';
        this.decoder = await Mp4VideoDecoder.create(this.source.videoUrl, this.manifest.frame_count);
        const expectedDimensions = this.manifest.video.dimensions;
        if (this.decoder.dimensions[0] !== expectedDimensions[0]
            || this.decoder.dimensions[1] !== expectedDimensions[1]) {
            throw new Error(`Attribute video is ${this.decoder.dimensions.join('×')}; expected ${expectedDimensions.join('×')}.`);
        }
        onProgress(20);
        this.stage = 'decoding-first-frame';
        await this.handleVideoFrame(0);
        this.stage = 'buffering-protected-lookahead';
        onProgress(55);
        await this.source.primeAfter(0, Math.min(4, this.manifest.frame_count - 1));
        this.stage = 'ready';
        // Meta Browser can suspend PlayCanvas' flat-page render loop while its
        // compositor still presents audio and WebXR remains available. Keep
        // the media clock independent; XR rendering consumes the latest upload.
        this.pollTimer = window.setInterval(this.pollHandler, 16);
        onProgress(100);
        if (!this.entity) throw new Error('Attribute frame decoded without creating a splat entity.');
        return this.entity;
    }

    async play(): Promise<void> {
        if (this.destroyed) return;
        const duration = this.manifest.duration_seconds ?? this.manifest.frame_count / this.manifest.fps;
        if (this.audio) {
            const offset = this.manifest.audio_offset_seconds ?? 0;
            const localTime = Math.max(0, this.audio.currentTime - offset);
            if (localTime >= duration || this.audio.currentTime < offset) {
                this.audio.currentTime = offset;
                this.playbackOffset = 0;
            } else {
                this.playbackOffset = localTime;
            }
            await this.audio.play();
        }
        this.playbackStartedAt = performance.now();
        this.playing = true;
        this.onStateChange?.();
    }

    pause(): void {
        this.playbackOffset = this.playbackTime();
        this.audio?.pause();
        this.playing = false;
        this.onStateChange?.();
    }

    async toggle(): Promise<void> {
        if (this.playing) this.pause();
        else await this.play();
    }

    destroy(): void {
        this.destroyed = true;
        this.app.off('frameend', this.frameEndHandler);
        window.clearInterval(this.pollTimer);
        this.pollTimer = 0;
        this.decoder?.destroy();
        this.decoder = null;
        this.audio?.pause();
        this.audio?.removeAttribute('src');
        this.audio?.load();
        if (this.entity?.gsplat) this.entity.removeComponent('gsplat');
        this.entity?.destroy();
        this.container?.destroy();
        this.container = null;
        this.entity = null;
    }

    private pollVideoFrame(): void {
        if (this.destroyed || this.frameBusy || !this.playing || !this.decoder) return;
        const index = Math.min(
            this.manifest.frame_count - 1,
            Math.max(0, Math.floor((this.playbackTime() + 1e-5) * this.manifest.fps))
        );
        if (index === this.currentFrame) return;

        this.frameBusy = true;
        void this.handleVideoFrame(index).catch(error => {
            console.error('[SplatVideo]', error);
            this.pause();
        }).finally(() => {
            this.frameBusy = false;
            // Catch a frame that became current while the previous one was
            // being copied/materialized, without waiting for another render.
            if (!this.destroyed) queueMicrotask(this.pollHandler);
        });
    }

    private async handleVideoFrame(index: number): Promise<void> {
        if (this.destroyed || !this.decoder) return;
        this.stage = 'decoding-native-video-frame';
        if (this.currentFrame >= 0) {
            const delta = (index - this.currentFrame + this.manifest.frame_count) % this.manifest.frame_count;
            if (delta > 1) this.droppedFrames += delta - 1;
        }

        const started = performance.now();
        const exactPromise = (async () => {
            const exactStarted = performance.now();
            const bytes = await this.source.readExactFrame(index);
            this.exactTotalMs += performance.now() - exactStarted;
            return bytes;
        })();
        const residualPromise = (async () => {
            const residualStarted = performance.now();
            const bytes = await this.source.readResidualFrame(index);
            this.residualTotalMs += performance.now() - residualStarted;
            return bytes;
        })();
        const videoWaitStarted = performance.now();
        const frame = await this.decoder.frame(index);
        this.videoWaitTotalMs += performance.now() - videoWaitStarted;
        try {
            // Frame zero also unpacks planes for stable sorter centers. Later
            // frames keep only the decoder's RGBA atlas and fuse atlas lookup,
            // deinterleave and two texture writes into one tile-ordered pass.
            this.stage = `copying-${frame.format ?? 'opaque'}`;
            const videoCopyStarted = performance.now();
            const textureReady = this.manifest.exact.layout === 'texture-ready-v1'
                || this.manifest.exact.layout === 'texture-ready-v2';
            await this.copyVideoPlanes(frame, !textureReady || index === 0);
            this.videoCopyTotalMs += performance.now() - videoCopyStarted;
            this.stage = 'waiting-exact-side-data';
            this.decodedFrames++;
            const [exact, residual] = await Promise.all([exactPromise, residualPromise]);
            this.stage = 'materializing-textures';
            this.populatePlanes(exact);
            this.residualFrame = residual;
            if (residual && (!textureReady || index === 0)) {
                this.applyResidualToUnpackedPlanes(residual);
            }
            const textureUploadStarted = performance.now();
            this.upload(index);
            const expectedFingerprint = this.manifest.residual?.fingerprints?.[index];
            if (expectedFingerprint !== undefined && this.attributeFingerprint !== expectedFingerprint) {
                throw new Error(
                    `Lossless correction proof failed at frame ${index}: `
                    + `${this.attributeFingerprint.toString(16).padStart(8, '0')}/`
                    + `${expectedFingerprint.toString(16).padStart(8, '0')}.`
                );
            }
            this.textureUploadTotalMs += performance.now() - textureUploadStarted;
        } finally {
            frame.close();
        }
        // Do not prefetch sequential protected frames while the audio clock is
        // dropping visual samples. On this source, four-frame lookahead caused
        // roughly four downloads per displayed frame because every predicted
        // frame was already obsolete by the next upload. The startup buffer
        // remains; subsequent misses fetch only the frame actually selected.
        this.decodeUploadTotalMs += performance.now() - started;
        this.uploadedFrames++;
        this.currentFrame = index;
        this.currentSplatCount = this.manifest.splats_per_frame;
        this.stage = 'ready';
        this.app.renderNextFrame = true;
        this.presentIfRenderLoopSuspended();

        this.onStateChange?.();
    }

    private presentIfRenderLoopSuspended(): void {
        if (this.app.xr?.active || document.visibilityState !== 'visible'
            || performance.now() - this.lastFrameEndAt <= 100) {
            return;
        }
        // Meta Browser can keep timers and WebCodecs alive while suspending the
        // PlayCanvas requestAnimationFrame loop for its flat panel. A direct
        // render presents the newly uploaded textures without running a second
        // scene update. Never do this during XR: the XR session exclusively
        // owns frame pacing there.
        this.app.render();
        this.forcedFlatPresentations++;
        this.frameEndHandler();
    }

    private playbackTime(): number {
        const duration = this.manifest.duration_seconds ?? this.manifest.frame_count / this.manifest.fps;
        if (this.audio) {
            const offset = this.manifest.audio_offset_seconds ?? 0;
            return ((this.audio.currentTime - offset) % duration + duration) % duration;
        }
        if (!this.playing) return this.playbackOffset;
        return (this.playbackOffset + (performance.now() - this.playbackStartedAt) / 1000) % duration;
    }

    private async copyVideoPlanes(frame: VideoFrame, unpack = true): Promise<void> {
        const [width, height] = this.manifest.video.dimensions;
        const visible: DOMRectInit = frame.visibleRect ?? {
            x: 0,
            y: 0,
            width: frame.displayWidth,
            height: frame.displayHeight
        };
        if (visible.width !== width || visible.height !== height) {
            throw new Error(`Decoded attribute video is ${visible.width}×${visible.height} visible (${frame.codedWidth}×${frame.codedHeight} coded); expected ${width}×${height}.`);
        }
        this.decodedColorSpace = [
            `range=${frame.colorSpace.fullRange === true ? 'full' : (frame.colorSpace.fullRange === false ? 'limited' : 'unknown')}`,
            `matrix=${frame.colorSpace.matrix ?? 'unknown'}`,
            `primaries=${frame.colorSpace.primaries ?? 'unknown'}`,
            `transfer=${frame.colorSpace.transfer ?? 'unknown'}`
        ].join(' · ');
        if ((frame.format === 'I420' || frame.format === 'NV12') && frame.colorSpace.fullRange !== true) {
            throw new Error('Attribute video was decoded with limited-range conversion; numeric bytes would be corrupted.');
        }
        const yBytes = width * height;
        const chromaBytes = yBytes / 4;
        const rgba = frame.format === 'RGBA' || frame.format === 'RGBX'
            || frame.format === 'BGRA' || frame.format === 'BGRX';
        if (rgba && this.manifest.video.pixel_format === 'RGBA-luma') {
            const rgbaBytes = yBytes * 4;
            if (!this.frameCopy || this.frameCopy.byteLength !== rgbaBytes) {
                this.frameCopy = new Uint8Array(rgbaBytes);
            }
            if (!this.lumaCopy || this.lumaCopy.byteLength !== yBytes) {
                this.lumaCopy = new Uint8Array(yBytes);
            }
            await frame.copyTo(this.frameCopy, {
                rect: visible,
                layout: [{ offset: 0, stride: width * 4 }]
            });
            if (!unpack) {
                this.nativeFormat = `${frame.format} fused CPU atlas`;
                this.copiedBytes += rgbaBytes;
                return;
            }
            for (let source = 0, destination = 0; destination < yBytes; source += 4, destination++) {
                const value = this.frameCopy[source];
                this.lumaCopy[destination] = this.rgbaLumaLut[value];
            }
            this.nativeFormat = `${frame.format} grayscale atlas`;
            this.copiedBytes += rgbaBytes;
            this.unpackMappedPlanes(this.lumaCopy, width, this.manifest.video.mapping.Y);
            return;
        }
        const copyBytes = yBytes + chromaBytes * 2;
        if (!this.frameCopy || this.frameCopy.byteLength !== copyBytes) {
            this.frameCopy = new Uint8Array(copyBytes);
            this.chromaU = new Uint8Array(chromaBytes);
            this.chromaV = new Uint8Array(chromaBytes);
        }
        this.nativeFormat = frame.format ?? 'opaque';
        if (frame.format === 'I420') {
            await frame.copyTo(this.frameCopy, {
                rect: visible,
                layout: [
                    { offset: 0, stride: width },
                    { offset: yBytes, stride: width / 2 },
                    { offset: yBytes + chromaBytes, stride: width / 2 }
                ]
            });
            this.chromaU!.set(this.frameCopy.subarray(yBytes, yBytes + chromaBytes));
            this.chromaV!.set(this.frameCopy.subarray(yBytes + chromaBytes));
        } else if (frame.format === 'NV12') {
            await frame.copyTo(this.frameCopy, {
                rect: visible,
                layout: [
                    { offset: 0, stride: width },
                    { offset: yBytes, stride: width }
                ]
            });
            const interleaved = this.frameCopy.subarray(yBytes);
            const u = this.chromaU!;
            const v = this.chromaV!;
            for (let index = 0; index < chromaBytes; index++) {
                u[index] = interleaved[index * 2];
                v[index] = interleaved[index * 2 + 1];
            }
        } else if (rgba) {
            throw new Error(
                'This browser exposes HEVC as RGBA; this sequence needs the Quest RGBA-luma playback encoding.'
            );
        } else {
            throw new Error(`Decoded VideoFrame format ${frame.format} is not addressable I420/NV12/RGBA.`);
        }
        this.copiedBytes += this.frameCopy.byteLength;
        const y = this.frameCopy.subarray(0, yBytes);
        this.unpackMappedPlanes(y, width, this.manifest.video.mapping.Y);
        this.unpackMappedPlanes(this.chromaU!, width / 2, this.manifest.video.mapping.U);
        this.unpackMappedPlanes(this.chromaV!, width / 2, this.manifest.video.mapping.V);
    }

    private unpackMappedPlanes(source: Uint8Array, sourceWidth: number, mapping: number[]): void {
        const destinationTileColumns = sourceWidth / TILE;
        const sourcePlaneTiles = this.sourceTileColumns * this.sourceTileRows;
        const outputWidth = this.manifest.grid[0];
        for (let slot = 0; slot < mapping.length; slot++) {
            const output = this.planes[mapping[slot]] ?? new Uint8Array(this.planePixels);
            this.planes[mapping[slot]] = output;
            const firstTile = slot * sourcePlaneTiles;
            for (let tileRow = 0; tileRow < this.sourceTileRows; tileRow++) {
                let globalTile = firstTile + tileRow * this.sourceTileColumns;
                let sourcePlaneTileColumn = 0;
                let remaining = this.sourceTileColumns;
                while (remaining > 0) {
                    const destinationTileRow = Math.floor(globalTile / destinationTileColumns);
                    const destinationTileColumn = globalTile % destinationTileColumns;
                    const take = Math.min(remaining, destinationTileColumns - destinationTileColumn);
                    const bytes = take * TILE;
                    for (let innerRow = 0; innerRow < TILE; innerRow++) {
                        const sourceOffset = (destinationTileRow * TILE + innerRow) * sourceWidth
                            + destinationTileColumn * TILE;
                        const outputOffset = (tileRow * TILE + innerRow) * outputWidth
                            + sourcePlaneTileColumn * TILE;
                        output.set(source.subarray(sourceOffset, sourceOffset + bytes), outputOffset);
                    }
                    globalTile += take;
                    sourcePlaneTileColumn += take;
                    remaining -= take;
                }
            }
        }
    }

    private populatePlanes(exact: Uint8Array): void {
        if (this.manifest.exact.layout === 'texture-ready-v1'
            || this.manifest.exact.layout === 'texture-ready-v2') {
            const textureBlocks = this.manifest.exact.layout === 'texture-ready-v1' ? 13 : 5;
            const expected = this.planePixels * textureBlocks;
            if (exact.byteLength !== expected) {
                throw new Error(`Texture-ready exact payload has ${exact.byteLength}/${expected} bytes.`);
            }
            this.exactFrame = exact;
            // RGBA texture blocks are followed by a scalar alpha block.
            this.planes[16] = exact.subarray(this.planePixels * (textureBlocks - 1));
            for (const plane of this.manifest.video.mapping.Y
                .concat(this.manifest.video.mapping.U, this.manifest.video.mapping.V)) {
                if (!this.planes[plane]) {
                    throw new Error(`Video-coded attribute plane ${plane} is missing.`);
                }
            }
            return;
        }
        const expected = this.manifest.exact.mapping.length * this.planePixels;
        if (exact.byteLength !== expected) {
            throw new Error(`Exact plane payload has ${exact.byteLength}/${expected} bytes.`);
        }
        for (let slot = 0; slot < this.manifest.exact.mapping.length; slot++) {
            const plane = this.manifest.exact.mapping[slot];
            this.planes[plane] = exact.subarray(slot * this.planePixels, (slot + 1) * this.planePixels);
        }
        if (this.planes.some(plane => !plane)) {
            throw new Error('Attribute plane mappings do not cover every required byte plane.');
        }
    }

    private createContainer(): void {
        const device = this.app.graphicsDevice;
        const format = new GSplatFormat(device, [
            { name: 'meansLow', format: PIXELFORMAT_RGBA8 },
            { name: 'meansHigh', format: PIXELFORMAT_RGBA8 },
            { name: 'scales', format: PIXELFORMAT_RGBA8 },
            { name: 'rotations', format: PIXELFORMAT_RGBA8 },
            { name: 'colors', format: PIXELFORMAT_RGBA8 }
        ], { readGLSL: READ_GLSL, readWGSL: READ_WGSL });
        const container = new GSplatContainer(device, this.manifest.splats_per_frame, format);
        container.parameters.set('emsPositionMin', this.positionMin);
        container.parameters.set('emsPositionMax', this.positionMax);
        container.parameters.set('emsScaleMin', this.scaleMin);
        container.parameters.set('emsScaleMax', this.scaleMax);
        container.parameters.set('emsColorMin', this.colorMin);
        container.parameters.set('emsColorMax', this.colorMax);

        const unionMin = new Vec3(Infinity, Infinity, Infinity);
        const unionMax = new Vec3(-Infinity, -Infinity, -Infinity);
        for (const bounds of this.manifest.attributes.bounds) {
            unionMin.x = Math.min(unionMin.x, bounds.position_min[0]);
            unionMin.y = Math.min(unionMin.y, bounds.position_min[1]);
            unionMin.z = Math.min(unionMin.z, bounds.position_min[2]);
            unionMax.x = Math.max(unionMax.x, bounds.position_max[0]);
            unionMax.y = Math.max(unionMax.y, bounds.position_max[1]);
            unionMax.z = Math.max(unionMax.z, bounds.position_max[2]);
        }
        container.aabb.setMinMax(unionMin, unionMax);
        this.container = container;

        const entity = new Entity('splat-video');
        entity.addComponent('gsplat', { resource: container });
        this.contentRoot.addChild(entity);
        this.entity = entity;
    }

    private upload(index: number): void {
        if (!this.container) this.createContainer();
        const container = this.container!;
        const bounds = this.manifest.attributes.bounds[index];
        this.positionMin.set(bounds.position_min);
        this.positionMax.set(bounds.position_max);
        this.scaleMin.set(bounds.scale_min);
        this.scaleMax.set(bounds.scale_max);
        this.colorMin.set(bounds.color_min);
        this.colorMax.set(bounds.color_max);

        const positionLow = [this.requiredPlane(0), this.requiredPlane(2), this.requiredPlane(4)];
        let positionHigh: Uint8Array[] | null = null;
        let positionHighTexture: Uint8Array | null = null;
        if (this.manifest.exact.layout === 'texture-ready-v1'
            || this.manifest.exact.layout === 'texture-ready-v2') {
            const exact = this.exactFrame;
            if (!exact) throw new Error('Texture-ready exact frame is missing.');
            const textureBytes = this.planePixels * 4;
            positionHighTexture = exact.subarray(0, textureBytes);
            this.copyTexture(container.getTexture('meansHigh')!, positionHighTexture);
            if (this.manifest.exact.layout === 'texture-ready-v1') {
                this.copyTexture(container.getTexture('scales')!, exact.subarray(textureBytes, textureBytes * 2));
                this.copyTexture(container.getTexture('rotations')!, exact.subarray(textureBytes * 2, textureBytes * 3));
                this.packFusedAtlasTextures(container, exact.subarray(textureBytes * 3));
            } else {
                this.packFusedAtlasTexturesV2(container, exact.subarray(textureBytes));
            }
        } else {
            positionHigh = [this.requiredPlane(1), this.requiredPlane(3), this.requiredPlane(5)];
            const scales = [this.requiredPlane(6), this.requiredPlane(7), this.requiredPlane(8)];
            const rotations = [
                this.requiredPlane(9), this.requiredPlane(10), this.requiredPlane(11), this.requiredPlane(12)
            ];
            const colors = [
                this.requiredPlane(13), this.requiredPlane(14), this.requiredPlane(15), this.requiredPlane(16)
            ];
            this.packRgbTexture(container.getTexture('meansHigh')!, positionHigh);
            this.packRgbTexture(container.getTexture('scales')!, scales);
            this.packRgbaTexture(container.getTexture('rotations')!, rotations);
            this.packRgbTexture(container.getTexture('meansLow')!, positionLow);
            this.packRgbaTexture(container.getTexture('colors')!, colors);
        }

        if (index === 0) {
            const centers = container.centers;
            const lowX = positionLow[0]; const lowY = positionLow[1]; const lowZ = positionLow[2];
            const sx = (bounds.position_max[0] - bounds.position_min[0]) / 65535;
            const sy = (bounds.position_max[1] - bounds.position_min[1]) / 65535;
            const sz = (bounds.position_max[2] - bounds.position_min[2]) / 65535;
            for (let i = 0; i < this.planePixels; i++) {
                const highOffset = i * 4;
                const highX = positionHighTexture ? positionHighTexture[highOffset] : positionHigh![0][i];
                const highY = positionHighTexture ? positionHighTexture[highOffset + 1] : positionHigh![1][i];
                const highZ = positionHighTexture ? positionHighTexture[highOffset + 2] : positionHigh![2][i];
                centers[i * 3] = bounds.position_min[0] + (lowX[i] | highX << 8) * sx;
                centers[i * 3 + 1] = bounds.position_min[1] + (lowY[i] | highY << 8) * sy;
                centers[i * 3 + 2] = bounds.position_min[2] + (lowZ[i] | highZ << 8) * sz;
            }
            container.update(this.manifest.splats_per_frame, true);
        } else {
            // Preserve frame-zero centers for CPU sorting. Canonicalized SHARP
            // motion is locally coherent, and avoiding a ~14 MB sorter clone on
            // every sample keeps animated render cost close to a static splat.
            container.update(this.manifest.splats_per_frame, false);
        }
    }

    private requiredPlane(index: number): Uint8Array {
        const plane = this.planes[index];
        if (!plane) throw new Error(`Required attribute plane ${index} is missing.`);
        return plane;
    }

    private applyResidualToUnpackedPlanes(residual: Uint8Array): void {
        const metadata = this.manifest.residual;
        if (!metadata) throw new Error('Lossless residual bytes have no manifest metadata.');
        const expected = metadata.mapping.length * this.planePixels;
        if (residual.byteLength !== expected) {
            throw new Error(`Residual plane payload has ${residual.byteLength}/${expected} bytes.`);
        }
        for (let slot = 0; slot < metadata.mapping.length; slot++) {
            const plane = this.requiredPlane(metadata.mapping[slot]);
            const correction = residual.subarray(slot * this.planePixels, (slot + 1) * this.planePixels);
            for (let index = 0; index < this.planePixels; index++) {
                plane[index] = (plane[index] + correction[index]) & 255;
            }
        }
    }

    private packFusedAtlasTextures(container: GSplatContainer, alpha: Uint8Array): void {
        const expectedMapping = [0, 2, 4, 13, 14, 15];
        if (this.manifest.video.pixel_format !== 'RGBA-luma'
            || expectedMapping.some((plane, slot) => this.manifest.video.mapping.Y[slot] !== plane)) {
            throw new Error('Fused texture packing needs the six-plane Quest RGBA-luma atlas.');
        }
        const rgba = this.frameCopy;
        if (!rgba || rgba.byteLength !== this.manifest.video.dimensions[0] * this.manifest.video.dimensions[1] * 4) {
            throw new Error('Decoded RGBA atlas is missing.');
        }
        if (alpha.byteLength !== this.planePixels) {
            throw new Error(`Exact alpha has ${alpha.byteLength}/${this.planePixels} bytes.`);
        }
        const residualMetadata = this.manifest.residual;
        const residual = this.residualFrame;
        let corrections: Uint8Array[] | null = null;
        if (residualMetadata) {
            if (!residual
                || residualMetadata.mapping.length !== expectedMapping.length
                || residualMetadata.mapping.some((plane, slot) => plane !== expectedMapping[slot])
                || residual.byteLength !== expectedMapping.length * this.planePixels) {
                throw new Error('Lossless residual does not match the six-plane fused atlas.');
            }
            corrections = expectedMapping.map((_plane, slot) =>
                residual.subarray(slot * this.planePixels, (slot + 1) * this.planePixels));
        }

        const atlasWidth = this.manifest.video.dimensions[0];
        const atlasTileColumns = atlasWidth / TILE;
        const sourcePlaneTiles = this.sourceTileColumns * this.sourceTileRows;
        let tileBases = this.atlasTileBases;
        if (!tileBases) {
            tileBases = new Uint32Array(sourcePlaneTiles * 6);
            for (let slot = 0; slot < 6; slot++) {
                for (let tile = 0; tile < sourcePlaneTiles; tile++) {
                    const globalTile = slot * sourcePlaneTiles + tile;
                    tileBases[slot * sourcePlaneTiles + tile] =
                        Math.floor(globalTile / atlasTileColumns) * TILE * atlasWidth
                        + globalTile % atlasTileColumns * TILE;
                }
            }
            this.atlasTileBases = tileBases;
        }

        const sourceWords = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4);
        const meansWords = textureWords(container.getTexture('meansLow')!);
        const colorWords = textureWords(container.getTexture('colors')!);
        const outputWidth = this.manifest.grid[0];
        for (let tile = 0; tile < sourcePlaneTiles; tile++) {
            const destinationTileX = tile % this.sourceTileColumns;
            const destinationTileY = Math.floor(tile / this.sourceTileColumns);
            const destinationBase = destinationTileY * TILE * outputWidth + destinationTileX * TILE;
            const base0 = tileBases[tile];
            const base1 = tileBases[sourcePlaneTiles + tile];
            const base2 = tileBases[sourcePlaneTiles * 2 + tile];
            const base3 = tileBases[sourcePlaneTiles * 3 + tile];
            const base4 = tileBases[sourcePlaneTiles * 4 + tile];
            const base5 = tileBases[sourcePlaneTiles * 5 + tile];
            for (let row = 0; row < TILE; row++) {
                const destinationRow = destinationBase + row * outputWidth;
                const atlasRow = row * atlasWidth;
                for (let column = 0; column < TILE; column++) {
                    const destination = destinationRow + column;
                    const source0 = sourceWords[base0 + atlasRow + column] & 255;
                    const source1 = sourceWords[base1 + atlasRow + column] & 255;
                    const source2 = sourceWords[base2 + atlasRow + column] & 255;
                    const source3 = sourceWords[base3 + atlasRow + column] & 255;
                    const source4 = sourceWords[base4 + atlasRow + column] & 255;
                    const source5 = sourceWords[base5 + atlasRow + column] & 255;
                    let r0 = this.rgbaLumaLut[source0];
                    let r1 = this.rgbaLumaLut[source1];
                    let r2 = this.rgbaLumaLut[source2];
                    let r3 = this.rgbaLumaLut[source3];
                    let r4 = this.rgbaLumaLut[source4];
                    let r5 = this.rgbaLumaLut[source5];
                    if (corrections) {
                        r0 = (r0 + corrections[0][destination]) & 255;
                        r1 = (r1 + corrections[1][destination]) & 255;
                        r2 = (r2 + corrections[2][destination]) & 255;
                        r3 = (r3 + corrections[3][destination]) & 255;
                        r4 = (r4 + corrections[4][destination]) & 255;
                        r5 = (r5 + corrections[5][destination]) & 255;
                    }
                    meansWords[destination] = r0 | r1 << 8 | r2 << 16;
                    colorWords[destination] = (r3 | r4 << 8 | r5 << 16 | alpha[destination] << 24) >>> 0;
                }
            }
        }
        // A decoder/upload counter can advance while the same visible data is
        // repeatedly presented. Hash sparse samples from the actual packed GPU
        // texture payload so device acceptance proves that distinct visual
        // attributes reached the renderer.
        let fingerprint = 2166136261;
        const sampleStep = Math.max(1, Math.floor(this.planePixels / 97));
        for (let index = 0; index < this.planePixels; index += sampleStep) {
            fingerprint = Math.imul(fingerprint ^ meansWords[index], 16777619);
            fingerprint = Math.imul(fingerprint ^ colorWords[index], 16777619);
        }
        this.attributeFingerprint = fingerprint >>> 0;
        this.distinctAttributeFingerprints.add(this.attributeFingerprint);
        unlock(container.getTexture('meansLow')!);
        unlock(container.getTexture('colors')!);
        this.nativeFormat = 'RGBA fused CPU atlas';
    }

    private packFusedAtlasTexturesV2(container: GSplatContainer, alpha: Uint8Array): void {
        // V2 keeps only position-high and alpha in the exact side stream. The
        // remaining 13 byte planes are lossless-HEVC coded, cutting the
        // fetch/inflate bottleneck while retaining byte-exact renderer input.
        const expectedMapping = [0, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        if (this.manifest.video.pixel_format !== 'RGBA-luma'
            || expectedMapping.some((plane, slot) => this.manifest.video.mapping.Y[slot] !== plane)) {
            throw new Error('Fused V2 texture packing needs the 13-plane Quest RGBA-luma atlas.');
        }
        const rgba = this.frameCopy;
        if (!rgba || rgba.byteLength !== this.manifest.video.dimensions[0] * this.manifest.video.dimensions[1] * 4) {
            throw new Error('Decoded RGBA atlas is missing.');
        }
        if (alpha.byteLength !== this.planePixels) {
            throw new Error(`Exact alpha has ${alpha.byteLength}/${this.planePixels} bytes.`);
        }

        const atlasWidth = this.manifest.video.dimensions[0];
        const atlasTileColumns = atlasWidth / TILE;
        const sourcePlaneTiles = this.sourceTileColumns * this.sourceTileRows;
        let tileBases = this.atlasTileBases;
        if (!tileBases) {
            tileBases = new Uint32Array(sourcePlaneTiles * expectedMapping.length);
            for (let slot = 0; slot < expectedMapping.length; slot++) {
                for (let tile = 0; tile < sourcePlaneTiles; tile++) {
                    const globalTile = slot * sourcePlaneTiles + tile;
                    tileBases[slot * sourcePlaneTiles + tile] =
                        Math.floor(globalTile / atlasTileColumns) * TILE * atlasWidth
                        + globalTile % atlasTileColumns * TILE;
                }
            }
            this.atlasTileBases = tileBases;
        }

        const sourceWords = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4);
        const meansWords = textureWords(container.getTexture('meansLow')!);
        const scaleWords = textureWords(container.getTexture('scales')!);
        const rotationWords = textureWords(container.getTexture('rotations')!);
        const colorWords = textureWords(container.getTexture('colors')!);
        const outputWidth = this.manifest.grid[0];
        const lumaLut = this.rgbaLumaLut;
        for (let tile = 0; tile < sourcePlaneTiles; tile++) {
            const destinationTileX = tile % this.sourceTileColumns;
            const destinationTileY = Math.floor(tile / this.sourceTileColumns);
            const destinationBase = destinationTileY * TILE * outputWidth + destinationTileX * TILE;
            const base0 = tileBases[tile];
            const base1 = tileBases[sourcePlaneTiles + tile];
            const base2 = tileBases[sourcePlaneTiles * 2 + tile];
            const base3 = tileBases[sourcePlaneTiles * 3 + tile];
            const base4 = tileBases[sourcePlaneTiles * 4 + tile];
            const base5 = tileBases[sourcePlaneTiles * 5 + tile];
            const base6 = tileBases[sourcePlaneTiles * 6 + tile];
            const base7 = tileBases[sourcePlaneTiles * 7 + tile];
            const base8 = tileBases[sourcePlaneTiles * 8 + tile];
            const base9 = tileBases[sourcePlaneTiles * 9 + tile];
            const base10 = tileBases[sourcePlaneTiles * 10 + tile];
            const base11 = tileBases[sourcePlaneTiles * 11 + tile];
            const base12 = tileBases[sourcePlaneTiles * 12 + tile];
            for (let row = 0; row < TILE; row++) {
                const destinationRow = destinationBase + row * outputWidth;
                const atlasRow = row * atlasWidth;
                for (let column = 0; column < TILE; column++) {
                    const destination = destinationRow + column;
                    const offset = atlasRow + column;
                    const source0 = sourceWords[base0 + offset] & 255;
                    const source1 = sourceWords[base1 + offset] & 255;
                    const source2 = sourceWords[base2 + offset] & 255;
                    const source3 = sourceWords[base3 + offset] & 255;
                    const source4 = sourceWords[base4 + offset] & 255;
                    const source5 = sourceWords[base5 + offset] & 255;
                    const source6 = sourceWords[base6 + offset] & 255;
                    const source7 = sourceWords[base7 + offset] & 255;
                    const source8 = sourceWords[base8 + offset] & 255;
                    const source9 = sourceWords[base9 + offset] & 255;
                    const source10 = sourceWords[base10 + offset] & 255;
                    const source11 = sourceWords[base11 + offset] & 255;
                    const source12 = sourceWords[base12 + offset] & 255;
                    const r0 = lumaLut[source0];
                    const r1 = lumaLut[source1];
                    const r2 = lumaLut[source2];
                    const r3 = lumaLut[source3];
                    const r4 = lumaLut[source4];
                    const r5 = lumaLut[source5];
                    const r6 = lumaLut[source6];
                    const r7 = lumaLut[source7];
                    const r8 = lumaLut[source8];
                    const r9 = lumaLut[source9];
                    const r10 = lumaLut[source10];
                    const r11 = lumaLut[source11];
                    const r12 = lumaLut[source12];
                    meansWords[destination] = r0 | r1 << 8 | r2 << 16;
                    scaleWords[destination] = r3 | r4 << 8 | r5 << 16;
                    rotationWords[destination] = (r6 | r7 << 8 | r8 << 16 | r9 << 24) >>> 0;
                    colorWords[destination] = (r10 | r11 << 8 | r12 << 16 | alpha[destination] << 24) >>> 0;
                }
            }
        }

        let fingerprint = 2166136261;
        const sampleStep = Math.max(1, Math.floor(this.planePixels / 97));
        for (let index = 0; index < this.planePixels; index += sampleStep) {
            fingerprint = Math.imul(fingerprint ^ meansWords[index], 16777619);
            fingerprint = Math.imul(fingerprint ^ scaleWords[index], 16777619);
            fingerprint = Math.imul(fingerprint ^ rotationWords[index], 16777619);
            fingerprint = Math.imul(fingerprint ^ colorWords[index], 16777619);
        }
        this.attributeFingerprint = fingerprint >>> 0;
        this.distinctAttributeFingerprints.add(this.attributeFingerprint);
        unlock(container.getTexture('meansLow')!);
        unlock(container.getTexture('scales')!);
        unlock(container.getTexture('rotations')!);
        unlock(container.getTexture('colors')!);
        this.nativeFormat = 'RGBA fused CPU atlas V2';
    }

    private packRgbTexture(texture: Texture, channels: Uint8Array[]): void {
        const words = textureWords(texture);
        const [r, g, b] = channels;
        for (let index = 0; index < this.planePixels; index++) {
            words[index] = r[index] | g[index] << 8 | b[index] << 16;
        }
        unlock(texture);
    }

    private copyTexture(texture: Texture, source: Uint8Array): void {
        const destination = texture.lock() as Uint8Array;
        if (destination.byteLength < source.byteLength) {
            throw new Error(`Texture byte length is ${destination.byteLength}/${source.byteLength}.`);
        }
        destination.set(source);
        unlock(texture);
    }

    private packRgbaTexture(texture: Texture, channels: Uint8Array[]): void {
        const words = textureWords(texture);
        const [r, g, b, a] = channels;
        for (let index = 0; index < this.planePixels; index++) {
            words[index] = (r[index] | g[index] << 8 | b[index] << 16 | a[index] << 24) >>> 0;
        }
        unlock(texture);
    }
}
