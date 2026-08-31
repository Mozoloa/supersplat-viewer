import { Asset, Entity, Mat4, platform, Quat, Vec3, type AppBase } from 'playcanvas';
import { GSplatCompressedData } from 'playcanvas/build/playcanvas/src/scene/gsplat/gsplat-compressed-data.js';
import { GSplatCompressedResource } from 'playcanvas/build/playcanvas/src/scene/gsplat/gsplat-compressed-resource.js';
import { GSplatUnifiedSorter } from 'playcanvas/build/playcanvas/src/scene/gsplat-unified/gsplat-unified-sorter.js';
import { PersistentFrameCache } from './persistent-frame-cache';
import { mediaFetch } from './media-request';

const MAGIC = 'EMSSPLAT';
const PREFIX_BYTES = 16;
const MAX_PLY_HEADER_BYTES = 64 * 1024;
const EMPTY_FLOAT32 = new Float32Array(0);
const EMPTY_UINT32 = new Uint32Array(0);
const EMPTY_UINT8 = new Uint8Array(0);
let rangedTimingReads = 0;
let rangedHttpCacheHits = 0;
let unalignedPackedCopies = 0;
let unalignedPackedCopyBytes = 0;

type PackedFrameBytes = ArrayBuffer | Uint8Array;

interface FastCompressedPly {
    data: GSplatCompressedData;
    cacheByteOffset: number;
}

// The current PlayCanvas unified CPU sorter clones every centers buffer on the
// main thread before transferring that clone to its worker. For a 1.176M-splat
// animation this is a fresh ~14 MB copy on every visual sample. EMS owns these
// generated arrays and uses one camera/sorter, so opt only those arrays into a
// true ownership transfer; all ordinary PlayCanvas resources retain upstream
// clone semantics.
const TRANSFERABLE_CENTERS = new WeakSet<Float32Array>();
let zeroCopySorterTransfers = 0;
const upstreamSetCenters = GSplatUnifiedSorter.prototype.setCenters;
GSplatUnifiedSorter.prototype.setCenters = function (
    this: GSplatUnifiedSorter,
    id: number,
    centers: Float32Array | null
): void {
    if (!centers || !TRANSFERABLE_CENTERS.has(centers) || this.centersSet.has(id)) {
        upstreamSetCenters.call(this, id, centers);
        return;
    }
    TRANSFERABLE_CENTERS.delete(centers);
    this.centersSet.add(id);
    const centersBuffer = centers.buffer;
    this.worker.postMessage({
        command: 'addCenters',
        id,
        centers: centersBuffer
    }, [centersBuffer]);
    zeroCopySorterTransfers++;
};

const parseFastCompressedPly = (input: PackedFrameBytes): FastCompressedPly | null => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const headerProbe = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, MAX_PLY_HEADER_BYTES)));
    const marker = headerProbe.indexOf('end_header');
    if (marker < 0 || !headerProbe.startsWith('ply\n') && !headerProbe.startsWith('ply\r\n')) return null;

    let bodyOffset = marker + 'end_header'.length;
    if (bytes[bodyOffset] === 13) bodyOffset++;
    if (bytes[bodyOffset] !== 10) return null;
    bodyOffset++;
    const lines = headerProbe.slice(0, marker).split(/\r?\n/);
    const elements = new Map<string, { count: number; properties: string[] }>();
    const comments: string[] = [];
    let current: { count: number; properties: string[] } | null = null;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('comment ')) {
            comments.push(line.slice(8));
            continue;
        }
        const parts = line.split(/\s+/);
        if (parts[0] === 'format' && (parts[1] !== 'binary_little_endian' || parts[2] !== '1.0')) return null;
        if (parts[0] === 'element' && parts.length === 3) {
            const count = Number(parts[2]);
            if (!Number.isSafeInteger(count) || count < 1) return null;
            current = { count, properties: [] };
            elements.set(parts[1], current);
        } else if (parts[0] === 'property' && parts.length === 3 && current) {
            current.properties.push(`${parts[1]} ${parts[2]}`);
        }
    }

    const chunk = elements.get('chunk');
    const vertex = elements.get('vertex');
    const expectedVertex = [
        'uint packed_position',
        'uint packed_rotation',
        'uint packed_scale',
        'uint packed_color'
    ];
    if (!chunk || !vertex || elements.size !== 2
        || chunk.properties.length !== 12 && chunk.properties.length !== 18
        || !chunk.properties.every(property => property.startsWith('float '))
        || vertex.properties.length !== expectedVertex.length
        || !vertex.properties.every((property, index) => property === expectedVertex[index])
        || chunk.count !== Math.ceil(vertex.count / 256)) {
        return null;
    }

    const chunkFloats = chunk.count * chunk.properties.length;
    const chunkBytes = chunkFloats * 4;
    const vertexWords = vertex.count * 4;
    const requiredBytes = bodyOffset + chunkBytes + vertexWords * 4;
    if (requiredBytes !== bytes.byteLength) return null;

    // Older Sharp outputs did not pad the PLY header. Typed-array views cannot
    // begin at an unaligned byte offset, but the packed body is still canonical.
    // One native contiguous copy preserves the fast resource path and is much
    // cheaper than sending every frame through PlayCanvas's generic PLY parser.
    const cacheByteOffset = (4 - bodyOffset % 4) % 4;
    let packedBuffer = bytes.buffer as ArrayBuffer;
    let packedBodyOffset = bytes.byteOffset + bodyOffset;
    if (packedBodyOffset % 4 !== 0) {
        packedBuffer = bytes.slice(bodyOffset).buffer as ArrayBuffer;
        packedBodyOffset = 0;
        unalignedPackedCopies++;
        unalignedPackedCopyBytes += packedBuffer.byteLength;
    }

    const data = new GSplatCompressedData();
    data.numSplats = vertex.count;
    data.comments = comments;
    data.chunkData = new Float32Array(packedBuffer, packedBodyOffset, chunkFloats);
    data.vertexData = new Uint32Array(packedBuffer, packedBodyOffset + chunkBytes, vertexWords);
    data.shData0 = new Uint8Array(0);
    data.shData1 = new Uint8Array(0);
    data.shData2 = new Uint8Array(0);
    data.shBands = 0;
    return { data, cacheByteOffset };
};

const CENTER_WORKER_SOURCE = `
self.onmessage = event => {
    const {
        id,
        numSplats,
        chunkSize,
        verticesBuffer,
        chunksBuffer,
        frameBuffer,
        vertexByteOffset,
        vertexWords,
        chunkByteOffset,
        chunkFloats
    } = event.data;
    try {
        const vertices = frameBuffer
            ? new Uint32Array(frameBuffer, vertexByteOffset, vertexWords)
            : new Uint32Array(verticesBuffer);
        const chunks = frameBuffer
            ? new Float32Array(frameBuffer, chunkByteOffset, chunkFloats)
            : new Float32Array(chunksBuffer);
        const centers = new Float32Array(numSplats * 3);
        const numChunks = Math.ceil(numSplats / 256);
        for (let chunk = 0; chunk < numChunks; chunk++) {
            const offset = chunk * chunkSize;
            const minX = chunks[offset];
            const minY = chunks[offset + 1];
            const minZ = chunks[offset + 2];
            const maxX = chunks[offset + 3];
            const maxY = chunks[offset + 4];
            const maxZ = chunks[offset + 5];
            // Hoist interpolation ranges and quantization divisors out of the
            // million-item inner loop. This is algebraically equivalent to
            // mix(min, max, quantized / maxQuantized).
            const scaleX = (maxX - minX) / 2047;
            const scaleY = (maxY - minY) / 1023;
            const scaleZ = (maxZ - minZ) / 2047;
            const end = Math.min(numSplats, (chunk + 1) * 256);
            for (let i = chunk * 256; i < end; i++) {
                const packed = vertices[i * 4];
                centers[i * 3] = minX + (packed >>> 21) * scaleX;
                centers[i * 3 + 1] = minY + (packed >>> 11 & 1023) * scaleY;
                centers[i * 3 + 2] = minZ + (packed & 2047) * scaleZ;
            }
        }
        self.postMessage({ id, centersBuffer: centers.buffer }, [centers.buffer]);
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
};
`;

class PackedCenterWorker {
    private readonly worker: Worker;
    private readonly pending = new Map<number, {
        resolve: (centers: Float32Array) => void;
        reject: (error: Error) => void;
    }>();
    private nextId = 1;
    private broken = false;

    constructor() {
        const url = URL.createObjectURL(new Blob([CENTER_WORKER_SOURCE], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        URL.revokeObjectURL(url);
        this.worker.onmessage = (event: MessageEvent<{
            id: number;
            centersBuffer?: ArrayBuffer;
            error?: string;
        }>) => {
            const job = this.pending.get(event.data.id);
            if (!job) return;
            this.pending.delete(event.data.id);
            if (event.data.error || !event.data.centersBuffer) {
                job.reject(new Error(event.data.error || 'Center worker returned no data.'));
            } else {
                job.resolve(new Float32Array(event.data.centersBuffer));
            }
        };
        this.worker.onerror = event => {
            this.broken = true;
            const error = new Error(event.message || 'Center worker failed.');
            for (const job of this.pending.values()) job.reject(error);
            this.pending.clear();
        };
    }

    compute(data: GSplatCompressedData): Promise<Float32Array> {
        if (this.broken) return Promise.reject(new Error('Center worker is unavailable.'));
        const id = this.nextId++;
        // Native contiguous copy is much faster on Quest than a 1.176M-item
        // JavaScript strided extraction loop. The copy is transient and is
        // transferred to the worker immediately.
        const vertices = data.vertexData.slice();
        const chunks = data.chunkData.slice();
        const promise = new Promise<Float32Array>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        try {
            this.worker.postMessage({
                id,
                numSplats: data.numSplats,
                chunkSize: data.chunkSize,
                verticesBuffer: vertices.buffer,
                chunksBuffer: chunks.buffer
            }, [vertices.buffer, chunks.buffer]);
        } catch (error) {
            const job = this.pending.get(id);
            this.pending.delete(id);
            job?.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return promise;
    }

    computeTransferred(data: GSplatCompressedData): Promise<Float32Array> {
        if (this.broken) return Promise.reject(new Error('Center worker is unavailable.'));
        const frameBuffer = data.vertexData.buffer;
        if (!(frameBuffer instanceof ArrayBuffer) || data.chunkData.buffer !== frameBuffer) {
            return Promise.reject(new Error('Packed splat input does not share one transferable frame buffer.'));
        }
        const id = this.nextId++;
        const promise = new Promise<Float32Array>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        try {
            this.worker.postMessage({
                id,
                numSplats: data.numSplats,
                chunkSize: data.chunkSize,
                frameBuffer,
                vertexByteOffset: data.vertexData.byteOffset,
                vertexWords: data.vertexData.length,
                chunkByteOffset: data.chunkData.byteOffset,
                chunkFloats: data.chunkData.length
            }, [frameBuffer]);
        } catch (error) {
            const job = this.pending.get(id);
            this.pending.delete(id);
            job?.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return promise;
    }

    destroy(): void {
        this.worker.terminate();
        const error = new Error('Animated splat player was destroyed while building centers.');
        for (const job of this.pending.values()) job.reject(error);
        this.pending.clear();
    }
}

export interface SplatStreamFrame {
    offset: number;
    length: number;
}

export interface SplatStreamManifest {
    format: 'ems-splat-stream';
    version: 1;
    fps: number;
    frame_count: number;
    duration_seconds: number;
    width: number;
    height: number;
    focal_length_px: number;
    compressed: boolean;
    frame_encoding: 'supersplat-compressed-ply' | 'ply';
    audio_offset_seconds?: number;
    frame_to_canonical?: number[][];
    frames: SplatStreamFrame[];
}

const readRange = async (
    url: string,
    start: number,
    end: number,
    signal?: AbortSignal
): Promise<ArrayBuffer> => {
    const response = await mediaFetch(url, {
        cache: 'force-cache',
        headers: { Range: `bytes=${start}-${end}` },
        signal,
        priority: 'high'
    } as RequestInit & { priority: 'high' });
    if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(
            response.status === 200
                ? 'This server returned the entire animation instead of a byte range. Range delivery is required for bounded-memory playback.'
                : `Animation range request failed: HTTP ${response.status} ${response.statusText}`
        );
    }
    const result = await response.arrayBuffer();
    const expected = end - start + 1;
    if (result.byteLength !== expected) {
        throw new Error(`Animation range was truncated (${result.byteLength}/${expected} bytes).`);
    }
    const timing = performance.getEntriesByName(url, 'resource').at(-1) as PerformanceResourceTiming | undefined;
    // A cross-origin resource only exposes sizes when the server opts in with
    // Timing-Allow-Origin. A zero transfer with the expected decoded body is a
    // real browser HTTP-cache hit, not merely an opaque timing entry.
    if (timing?.decodedBodySize === expected) {
        rangedTimingReads++;
        if (timing.transferSize === 0) rangedHttpCacheHits++;
    }
    return result;
};

const validateManifest = (value: unknown): SplatStreamManifest => {
    const manifest = value as Partial<SplatStreamManifest> | null;
    if (!manifest || manifest.format !== 'ems-splat-stream' || manifest.version !== 1) {
        throw new Error('Unsupported animated splat stream. Expected ems-splat-stream version 1.');
    }
    if (!Number.isFinite(manifest.fps) || manifest.fps! <= 0
        || !Number.isInteger(manifest.frame_count) || manifest.frame_count! < 2
        || !Number.isFinite(manifest.width) || manifest.width! < 1
        || !Number.isFinite(manifest.height) || manifest.height! < 1
        || !Number.isFinite(manifest.focal_length_px) || manifest.focal_length_px! <= 0
        || !Array.isArray(manifest.frames)
        || manifest.frames.length !== manifest.frame_count) {
        throw new Error('Animated splat stream metadata is invalid.');
    }
    for (const frame of manifest.frames) {
        if (!frame || !Number.isSafeInteger(frame.offset) || frame.offset < 0
            || !Number.isSafeInteger(frame.length) || frame.length < 1) {
            throw new Error('Animated splat stream contains an invalid frame index.');
        }
    }
    if (manifest.frame_to_canonical !== undefined) {
        if (!Array.isArray(manifest.frame_to_canonical)
            || manifest.frame_to_canonical.length !== manifest.frame_count
            || manifest.frame_to_canonical.some(matrix =>
                !Array.isArray(matrix)
                || matrix.length !== 16
                || matrix.some(value => !Number.isFinite(value)))) {
            throw new Error('Animated splat stream contains an invalid canonical camera track.');
        }
    }
    const calculatedDuration = manifest.frame_count! / manifest.fps!;
    if (!Number.isFinite(manifest.duration_seconds) || manifest.duration_seconds! <= 0) {
        manifest.duration_seconds = calculatedDuration;
    }
    return manifest as SplatStreamManifest;
};

export class SplatStreamSource {
    readonly url: string;
    readonly manifest: SplatStreamManifest;
    readonly dataOffset: number;
    downloadedBytes = 0;
    networkRequests = 0;
    networkTotalMs = 0;
    cacheHits = 0;
    inFlightHits = 0;
    localCacheFillBytes = 0;

    private readonly frameCache = new Map<number, PackedFrameBytes>();
    private readonly frameLoads = new Map<number, Promise<PackedFrameBytes>>();
    private readonly localCacheFillLoads = new Map<number, Promise<void>>();
    private readonly frameReadByteOffsets: number[];
    // Long production clips cannot loop before this cache is displaced, so a
    // large byte LRU only adds browser pressure. Retain roughly two to five
    // compressed production frames, while small clips can still stay whole.
    private readonly frameCacheBudget = (platform.mobile ? 48 : 96) * 1024 * 1024;
    private frameCacheBytes = 0;
    readonly persistentCache: PersistentFrameCache | null;
    readonly persistentCacheUnavailableReason: string | null;

    private constructor(
        url: string,
        manifest: SplatStreamManifest,
        dataOffset: number,
        persistentCache: PersistentFrameCache | null,
        persistentCacheUnavailableReason: string | null
    ) {
        this.url = url;
        this.manifest = manifest;
        this.dataOffset = dataOffset;
        this.frameReadByteOffsets = new Array(manifest.frame_count).fill(0);
        this.persistentCache = persistentCache;
        this.persistentCacheUnavailableReason = persistentCacheUnavailableReason;
    }

    static async open(url: string): Promise<SplatStreamSource> {
        const prefix = await readRange(url, 0, PREFIX_BYTES - 1);
        const bytes = new Uint8Array(prefix);
        const magic = new TextDecoder().decode(bytes.subarray(0, 8));
        const view = new DataView(prefix);
        const version = view.getUint32(8, true);
        const manifestLength = view.getUint32(12, true);
        if (magic !== MAGIC || version !== 2 || manifestLength < 2 || manifestLength > 16 * 1024 * 1024) {
            throw new Error('This is not a supported animated splat stream. Legacy .splatseq files remain available in the legacy player.');
        }
        const manifestBytes = await readRange(url, PREFIX_BYTES, PREFIX_BYTES + manifestLength - 1);
        const manifestText = new TextDecoder().decode(manifestBytes);
        const manifest = validateManifest(JSON.parse(manifestText));
        const cacheIdentity = `${new URL(url, location.href).pathname}\n${manifestText}`;
        const cacheResult = await PersistentFrameCache.open(
            cacheIdentity,
            manifest.frames.map(frame => frame.length)
        );
        return new SplatStreamSource(
            url,
            manifest,
            PREFIX_BYTES + manifestLength,
            cacheResult.cache,
            cacheResult.reason
        );
    }

    private retainRawFrame(index: number, result: PackedFrameBytes): void {
        if (result.byteLength > this.frameCacheBudget) return;
        while (this.frameCacheBytes + result.byteLength > this.frameCacheBudget && this.frameCache.size > 0) {
            const oldest = this.frameCache.entries().next().value as [number, PackedFrameBytes] | undefined;
            if (!oldest) break;
            this.frameCache.delete(oldest[0]);
            this.frameCacheBytes -= oldest[1].byteLength;
        }
        this.frameCache.set(index, result);
        this.frameCacheBytes += result.byteLength;
    }

    async readFrame(index: number): Promise<PackedFrameBytes> {
        const cached = this.frameCache.get(index);
        if (cached) {
            // Refresh insertion order so the bounded cache behaves as an LRU.
            this.frameCache.delete(index);
            this.frameCache.set(index, cached);
            this.cacheHits++;
            return cached;
        }
        const pending = this.frameLoads.get(index);
        if (pending) {
            this.inFlightHits++;
            return pending;
        }
        const frame = this.manifest.frames[index];
        if (!frame) throw new Error(`Animation frame ${index} is outside the stream.`);
        const start = this.dataOffset + frame.offset;
        const request = (async () => {
            const filling = this.localCacheFillLoads.get(index);
            if (filling) {
                try {
                    await filling;
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
                }
            }
            const local = await this.persistentCache?.read(index, this.frameReadByteOffsets[index]);
            if (local) {
                this.retainRawFrame(index, local);
                return local;
            }
            const started = performance.now();
            this.networkRequests++;
            try {
                const result = await readRange(this.url, start, start + frame.length - 1);
                this.downloadedBytes += result.byteLength;
                this.retainRawFrame(index, result);
                // One bounded copy is allowed to drain into the OPFS worker.
                // If flash has not finished the previous frame, skip this
                // opportunistic write instead of building a RAM backlog.
                this.persistentCache?.putCopy(index, result);
                return result;
            } finally {
                this.networkTotalMs += performance.now() - started;
            }
        })().finally(() => this.frameLoads.delete(index));
        this.frameLoads.set(index, request);
        return request;
    }

    async cacheAll(
        onProgress: (cachedFrames: number, frameCount: number, cachedBytes: number, totalBytes: number) => void,
        signal?: AbortSignal
    ): Promise<void> {
        const cache = this.persistentCache;
        if (!cache) {
            throw new Error(`Local cache is unavailable: ${this.persistentCacheUnavailableReason || 'unknown reason'}.`);
        }
        await cache.requestPersistence();
        await cache.drainWrites();
        const report = (): void => {
            const stats = cache.stats;
            onProgress(stats.cachedFrames, stats.frameCount, stats.cachedBytes, stats.totalBytes);
        };
        report();
        for (let index = 0; index < this.manifest.frame_count; index++) {
            if (signal?.aborted) throw new DOMException('Local caching was cancelled.', 'AbortError');
            const foregroundLoad = this.frameLoads.get(index);
            if (foregroundLoad) {
                try {
                    await foregroundLoad;
                } catch {
                    // The cache fill below gets one clean retry.
                }
            }
            await cache.drainWrites();
            if (cache.has(index)) {
                report();
                continue;
            }
            const frame = this.manifest.frames[index];
            const start = this.dataOffset + frame.offset;
            const fill = (async () => {
                const result = await readRange(this.url, start, start + frame.length - 1, signal);
                this.localCacheFillBytes += result.byteLength;
                if (!await cache.putTransferred(index, result)) {
                    throw new Error(cache.lastWriteError || 'Quest local-cache storage reserve was reached.');
                }
            })();
            this.localCacheFillLoads.set(index, fill);
            try {
                await fill;
            } finally {
                this.localCacheFillLoads.delete(index);
            }
            report();
        }
    }

    get cachedBytes(): number {
        return this.frameCacheBytes;
    }

    setFrameReadByteOffset(index: number, byteOffset: number): void {
        this.frameReadByteOffsets[index] = Math.max(0, Math.min(3, byteOffset));
    }

    releaseFrame(index: number, expected: PackedFrameBytes): void {
        if (this.frameCache.get(index) !== expected) return;
        this.frameCache.delete(index);
        this.frameCacheBytes -= expected.byteLength;
    }

    destroy(): void {
        this.persistentCache?.destroy();
        this.frameCache.clear();
        this.frameCacheBytes = 0;
        this.frameLoads.clear();
        this.localCacheFillLoads.clear();
    }
}

interface BufferedFrame {
    index: number;
    asset: Asset | null;
    resource: GSplatCompressedResource | null;
    entity: Entity;
    splats: number;
}

interface RetiringFrame {
    frame: BufferedFrame;
    releaseAfterFrameEnd: number;
}

interface FramePose {
    position: Vec3;
    rotation: Quat;
}

export interface SplatStreamPlayerOptions {
    app: AppBase;
    contentRoot: Entity;
    source: SplatStreamSource;
    audioUrl?: string | null;
    onStateChange?: () => void;
}

export interface SplatStreamPerformanceStats {
    deliveredFps: number;
    averageNetworkMs: number;
    averageParseUploadMs: number;
    averageCentersMs: number;
    averageTexturesMs: number;
    averageSortInputSplats: number;
    currentFrame: number;
    sourceSplats: number;
    submittedSplats: number;
    cacheFrames: number;
    cacheFrameCount: number;
}

export class SplatStreamPlayer {
    readonly manifest: SplatStreamManifest;
    maxBufferedFrames = 2;

    private readonly app: AppBase;
    private readonly contentRoot: Entity;
    private readonly source: SplatStreamSource;
    private readonly onStateChange?: () => void;
    private readonly audio: HTMLAudioElement | null;
    private readonly centerWorker: PackedCenterWorker | null;
    private readonly framePoses: FramePose[] | null;
    private readonly directSplatCapacity: number;
    // The logical frame cache remains a strict double buffer, but Quest's CPU
    // sorter can retain just-retired resources for several display samples. A
    // four-slot ring lets network/decode continue while those references
    // drains, without returning to unbounded per-sample allocation churn.
    private readonly maxDirectResources = 4;
    private readonly cache = new Map<number, BufferedFrame>();
    private readonly loading = new Map<number, Promise<BufferedFrame>>();
    private readonly retiring = new Map<number, RetiringFrame>();
    // Direct packed-Ply frames all share the same shader format. Once a
    // disabled placement has survived a complete renderer reconciliation,
    // retain its entity, textures and work-buffer materials as the inactive
    // half of the double buffer. The next sample can upload into that storage
    // instead of allocating and garbage-collecting ~37 MB of GPU resources.
    private readonly directPool: BufferedFrame[] = [];
    private currentFrame = -1;
    // Unlike the manifest frame index, this never wraps. It prevents a sample
    // selected with stale cold-cache timing from being shown after a newer
    // sample and making the animation appear to jump backwards.
    private currentAbsoluteFrame = -1;
    private desiredFrame = 0;
    private lastMissedFrame = -1;
    private silentPlayhead = 0;
    private silentClockAnchor = 0;
    private prefetchToken = 0;
    private foregroundLoad: Promise<void> | null = null;
    private destroyed = false;
    private completedFrameEnds = 0;
    private parsedFrames = 0;
    private fastPathFrames = 0;
    private parseUploadTotalMs = 0;
    private centerBuildTotalMs = 0;
    private centerDispatchTotalMs = 0;
    private textureBuildTotalMs = 0;
    private directResourceCreates = 0;
    private directResourceReuses = 0;
    private directResourceAlive = 0;
    private directPoolWaits = 0;
    private directPoolWaitTotalMs = 0;
    private directCapacityResizes = 0;
    private readonly recentDisplayTimes: number[] = [];
    private rawPrefetchIndex = -1;
    private rawPrefetch: Promise<PackedFrameBytes> | null = null;
    private rawPrefetches = 0;
    private rawPrefetchUses = 0;
    private completedLoops = 0;
    private lastLoopRestartAt = Number.NEGATIVE_INFINITY;
    private sampleOffsetTotalMs = 0;
    private sampleOffsetCount = 0;
    private updateHandler: () => void;
    private frameEndHandler: () => void;
    private readonly audioEndedHandler = (): void => {
        if (this.playing && !this.destroyed) this.restartLoop();
    };

    playing = false;
    droppedFrames = 0;
    currentSplatCount = 0;

    constructor(options: SplatStreamPlayerOptions) {
        this.app = options.app;
        this.contentRoot = options.contentRoot;
        this.source = options.source;
        this.manifest = options.source.manifest;
        // A compressed frame needs at least 16 bytes per splat; its header and
        // chunk table make frame.length / 16 a safe, slightly conservative
        // upper bound. Reserving this once prevents variable-count animations
        // from repeatedly destroying and recreating packed GPU textures as a
        // larger frame appears later in the loop.
        this.directSplatCapacity = Math.max(1, Math.ceil(
            this.manifest.frames.reduce((maximum, frame) => Math.max(maximum, frame.length), 0) / 16
        ));
        this.onStateChange = options.onStateChange;
        this.audio = options.audioUrl ? new Audio(options.audioUrl) : null;
        this.framePoses = this.manifest.frame_to_canonical?.map(values => {
            const matrix = new Mat4().set([
                values[0], values[4], values[8], values[12],
                values[1], values[5], values[9], values[13],
                values[2], values[6], values[10], values[14],
                values[3], values[7], values[11], values[15]
            ]);
            return {
                position: matrix.getTranslation(new Vec3()),
                rotation: new Quat().setFromMat4(matrix)
            };
        }) ?? null;
        try {
            this.centerWorker = new PackedCenterWorker();
        } catch (error) {
            this.centerWorker = null;
            console.warn('[SplatStream] Center worker is unavailable; using synchronous expansion.', error);
        }
        if (this.audio) {
            this.audio.preload = 'auto';
            // The source media can be a few milliseconds shorter than the
            // splat timeline. In that case currentTime stops before the
            // manifest boundary, so the update loop alone can never observe
            // the old restart condition.
            this.audio.addEventListener('ended', this.audioEndedHandler);
            this.audio.load();
        }
        this.updateHandler = () => this.update();
        this.frameEndHandler = () => this.onFrameEnd();
    }

    async load(onProgress: (progress: number) => void): Promise<Entity> {
        onProgress(0);
        const first = await this.ensureFrame(0, progress => onProgress(Math.round(progress * 0.9)));
        // Bound resident GPU/CPU resources by an estimated byte budget rather
        // than duration. Compressed PlayCanvas frames use roughly 28 bytes per
        // splat before renderer work buffers; 48 leaves useful safety margin.
        const estimatedFrameBytes = Math.max(1, first.splats) * 48;
        // Decoded unified resources are substantially larger than their PLY
        // payload and Quest Browser shares its process budget with WebXR. Keep
        // only a strict double buffer; compressed bytes have their own cheaper
        // LRU below this.
        const gpuBudget = (platform.mobile ? 128 : 256) * 1024 * 1024;
        const frameCap = 2;
        this.maxBufferedFrames = Math.max(2, Math.min(
            frameCap,
            this.manifest.frame_count,
            Math.floor(gpuBudget / estimatedFrameBytes)
        ));
        this.display(first);
        onProgress(90);
        this.app.on('update', this.updateHandler);
        this.app.on('frameend', this.frameEndHandler);
        onProgress(100);
        this.onStateChange?.();
        return first.entity;
    }

    private async createFrame(index: number, onProgress?: (progress: number) => void): Promise<BufferedFrame> {
        const frameBytes = await this.source.readFrame(index);
        // Keep the costly stages busy without allocating another decoded
        // GSplat: while PlayCanvas parses/uploads this frame, fetch exactly one
        // predicted raw timeline sample into the bounded byte cache.
        this.primeRawPipeline(index);
        const parseStarted = performance.now();
        onProgress?.(45);
        if (this.manifest.frame_encoding === 'supersplat-compressed-ply') {
            const parsed = parseFastCompressedPly(frameBytes);
            if (parsed) {
                const { data } = parsed;
                this.source.setFrameReadByteOffset(index, parsed.cacheByteOffset);
                // The deep module and public bundle resolve to the same pinned
                // PlayCanvas runtime object, but their generated declarations
                // carry separate private nominal fields.
                let buffered = await this.acquireDirectPoolFrame(data);
                const textureStarted = performance.now();
                const reusedResource = Boolean(buffered?.resource);
                let resource: GSplatCompressedResource;
                if (buffered?.resource) {
                    resource = buffered.resource;
                    this.uploadDirectResource(resource, data);
                    this.directResourceReuses++;
                } else {
                    const resourceDevice = this.app.graphicsDevice as unknown as ConstructorParameters<typeof GSplatCompressedResource>[0];
                    resource = new GSplatCompressedResource(resourceDevice, data, { prepareCenters: false });
                    this.reserveDirectResourceCapacity(resource, data);
                    const entity = new Entity(`splat-stream-frame-${index}`);
                    entity.enabled = false;
                    entity.addComponent('gsplat', { resource });
                    this.contentRoot.addChild(entity);
                    buffered = {
                        index,
                        asset: null,
                        resource,
                        entity,
                        splats: resource.numSplats
                    };
                    this.directResourceCreates++;
                    this.directResourceAlive++;
                }
                this.textureBuildTotalMs += performance.now() - textureStarted;
                // Large production frames are evicted from the byte LRU
                // anyway. After textures/chunk bounds own their copies,
                // transfer that original ranged ArrayBuffer to the center
                // worker instead of cloning another ~19 MB on the XR thread.
                const transferInput = Boolean(this.centerWorker && frameBytes.byteLength >= 8 * 1024 * 1024);
                if (transferInput) this.source.releaseFrame(index, frameBytes);
                const centerStarted = performance.now();
                const centerPromise = (this.centerWorker
                    ? (transferInput
                        ? this.centerWorker.computeTransferred(data)
                        : this.centerWorker.compute(data))
                    : Promise.resolve(data.getCenters()))
                    .catch(error => {
                        if (this.destroyed || transferInput) throw error;
                        return data.getCenters();
                    })
                    .then(centers => {
                        this.centerBuildTotalMs += performance.now() - centerStarted;
                        return centers;
                    });
                this.centerDispatchTotalMs += performance.now() - centerStarted;
                let centers: Float32Array;
                try {
                    centers = await centerPromise;
                } catch (error) {
                    if (this.destroyed) this.destroyFrameStorageAfterReconcile([buffered]);
                    else this.destroyFrameStorage(buffered);
                    throw error;
                }
                TRANSFERABLE_CENTERS.add(centers);
                resource.centers = centers;
                if (reusedResource) {
                    // The unified manager keys CPU sorter centers and placement
                    // rebuilds on this version. Texture contents do not need a
                    // format change, but the new positions/count do.
                    resource.centersVersion++;
                }
                // The resource has copied packed values to texture backing
                // storage and materialized CPU centers/chunk bounds. Drop the
                // input views so the ranged ArrayBuffer can die as soon as it
                // leaves the one-frame pipeline instead of being retained by
                // both the source LRU and the decoded resource.
                data.chunkData = EMPTY_FLOAT32;
                data.vertexData = EMPTY_UINT32;
                data.shData0 = EMPTY_UINT8;
                data.shData1 = EMPTY_UINT8;
                data.shData2 = EMPTY_UINT8;
                if (!transferInput && frameBytes.byteLength >= 8 * 1024 * 1024) {
                    this.source.releaseFrame(index, frameBytes);
                }
                buffered.index = index;
                buffered.splats = resource.numSplats;
                buffered.entity.name = `splat-stream-frame-${index}`;
                this.parsedFrames++;
                this.fastPathFrames++;
                this.parseUploadTotalMs += performance.now() - parseStarted;
                onProgress?.(100);
                if (this.destroyed) {
                    this.finalizeFrameRelease(buffered);
                    throw new Error('Animated splat player was destroyed while loading.');
                }
                return buffered;
            }
        }
        const extension = this.manifest.frame_encoding === 'ply' ? '.ply' : '.compressed.ply';
        const filename = `stream-frame-${index.toString().padStart(6, '0')}${extension}`;
        // PlayCanvas' PLY parser consumes a Response stream. Supplying the
        // ArrayBuffer directly to Response can clone a production-size frame;
        // enqueue a zero-copy typed-array view instead.
        const frameView = frameBytes instanceof Uint8Array ? frameBytes : new Uint8Array(frameBytes);
        const frameStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(frameView);
                controller.close();
            }
        });
        const response = new Response(frameStream, {
            headers: { 'content-length': String(frameBytes.byteLength) }
        });
        const asset = new Asset(filename, 'gsplat', { url: filename, filename });
        asset.file = { url: filename, filename, contents: response };
        asset.data = { decompress: false, reorder: false };

        return new Promise<BufferedFrame>((resolve, reject) => {
            asset.on('progress', (received: number, total: number) => {
                if (total > 0) onProgress?.(45 + Math.round(received / total * 55));
            });
            asset.once('load', () => {
                this.parsedFrames++;
                this.parseUploadTotalMs += performance.now() - parseStarted;
                // The parsed resource owns everything needed for rendering.
                // Do not keep a second strong reference to the raw frame body
                // through the Asset after the bounded source cache decides its
                // lifetime.
                const assetFile = asset.file as { contents?: Response | ArrayBuffer | null } | null;
                if (assetFile) assetFile.contents = null;
                const entity = new Entity(`splat-stream-frame-${index}`);
                entity.enabled = false;
                entity.addComponent('gsplat', { asset });
                this.contentRoot.addChild(entity);
                const buffered = {
                    index,
                    asset,
                    resource: null,
                    entity,
                    splats: entity.gsplat?.resource?.numSplats ?? 0
                };
                if (this.destroyed) {
                    this.finalizeFrameRelease(buffered);
                    reject(new Error('Animated splat player was destroyed while loading.'));
                    return;
                }
                resolve(buffered);
            });
            asset.once('error', reject);
            this.app.assets.add(asset);
            this.app.assets.load(asset);
        });
    }

    private primeRawPipeline(currentIndex: number): void {
        if (!this.playing || this.destroyed || this.rawPrefetch) return;
        const averageParseMs = this.parsedFrames > 0
            ? this.parseUploadTotalMs / this.parsedFrames
            : 0;
        // The prefetched sample is displayed only after its range-read and
        // parse/upload finish. Network history is deliberately excluded here:
        // while an OPFS cache fills, a lifetime average of old network reads is
        // no longer predictive and can select a frame far in the future.
        const predictionMs = Math.min(250, Math.max(0, averageParseMs));
        const predictedTime = (
            this.playhead + predictionMs / 1000
        ) % this.manifest.duration_seconds;
        let predictedIndex = Math.min(
            this.manifest.frame_count - 1,
            Math.floor(predictedTime * this.manifest.fps)
        );
        if (predictedIndex === currentIndex || this.cache.has(predictedIndex)) {
            predictedIndex = (predictedIndex + 1) % this.manifest.frame_count;
        }
        this.rawPrefetchIndex = predictedIndex;
        this.rawPrefetches++;
        this.rawPrefetch = this.source.readFrame(predictedIndex).catch(error => {
            console.warn(`[SplatStream] Raw pipeline frame ${predictedIndex} failed:`, error);
            throw error;
        });
        // The foreground consumer observes the same promise through readFrame's
        // in-flight deduplication. Attach a rejection handler now so a network
        // failure cannot become an unhandled promise while parsing continues.
        void this.rawPrefetch.catch(() => undefined);
    }

    private takeRawPipelineFrame(): number | null {
        if (!this.rawPrefetch || this.rawPrefetchIndex < 0) return null;
        const result = this.rawPrefetchIndex;
        this.rawPrefetchIndex = -1;
        this.rawPrefetch = null;
        this.rawPrefetchUses++;
        return result;
    }

    private ensureFrame(index: number, onProgress?: (progress: number) => void): Promise<BufferedFrame> {
        const normalized = (index + this.manifest.frame_count) % this.manifest.frame_count;
        const cached = this.cache.get(normalized);
        if (cached) return Promise.resolve(cached);
        // An evicted placement must survive through one complete render so the
        // unified GSplat manager can reconcile it out of its world first. If
        // playback needs it again during that grace frame, cancel retirement
        // instead of downloading and allocating a duplicate.
        const retiring = this.retiring.get(normalized);
        if (retiring) {
            this.retiring.delete(normalized);
            this.cache.set(normalized, retiring.frame);
            return Promise.resolve(retiring.frame);
        }
        const pending = this.loading.get(normalized);
        if (pending) return pending;
        const request = this.createFrame(normalized, onProgress)
            .then(frame => {
                this.cache.set(normalized, frame);
                return frame;
            })
            .finally(() => this.loading.delete(normalized));
        this.loading.set(normalized, request);
        return request;
    }

    private display(frame: BufferedFrame): void {
        if (frame.index === this.currentFrame) return;
        const previous = this.cache.get(this.currentFrame);
        if (previous) previous.entity.enabled = false;
        const pose = this.framePoses?.[frame.index];
        if (pose) {
            frame.entity.setLocalPosition(pose.position);
            frame.entity.setLocalRotation(pose.rotation);
        }
        frame.entity.enabled = true;
        this.currentFrame = frame.index;
        this.currentSplatCount = frame.splats;
        if (this.playing) {
            const now = performance.now();
            this.recentDisplayTimes.push(now);
            while (this.recentDisplayTimes.length > 1 && this.recentDisplayTimes[0] < now - 5000) {
                this.recentDisplayTimes.shift();
            }
            let sampleOffset = this.playhead - frame.index / this.manifest.fps;
            const duration = this.manifest.duration_seconds;
            if (sampleOffset > duration * 0.5) sampleOffset -= duration;
            if (sampleOffset < -duration * 0.5) sampleOffset += duration;
            this.sampleOffsetTotalMs += sampleOffset * 1000;
            this.sampleOffsetCount++;
        }
        this.lastMissedFrame = -1;
        this.trimCache();
        // Sequential prefetch is useful while paused, but during playback it
        // competes with the audio-clock sample for the same network, parser and
        // GPU-upload budget. Large Quest streams must spend that budget only on
        // the newest requested timeline sample.
        if (!this.playing) this.prefetchFrom(frame.index);
        this.onStateChange?.();
    }

    private absoluteFrameNearClock(index: number): number {
        const frameCount = this.manifest.frame_count;
        const clockFrame = this.completedLoops * frameCount + this.desiredFrame;
        let candidate = this.completedLoops * frameCount + index;
        if (candidate - clockFrame > frameCount / 2) candidate -= frameCount;
        if (clockFrame - candidate > frameCount / 2) candidate += frameCount;
        return candidate;
    }

    private displayChronologically(frame: BufferedFrame): boolean {
        const absoluteFrame = this.absoluteFrameNearClock(frame.index);
        const clockFrame = this.completedLoops * this.manifest.frame_count + this.desiredFrame;
        // A one-frame lead tolerates the clock changing between update() and
        // promise completion. Larger speculative leads are exactly what made
        // cold-to-warm cache transitions look like shuffled source frames.
        if (absoluteFrame > clockFrame + 1 || absoluteFrame <= this.currentAbsoluteFrame) {
            return false;
        }
        this.display(frame);
        this.currentAbsoluteFrame = absoluteFrame;
        return true;
    }

    private prefetchFrom(index: number): void {
        const token = ++this.prefetchToken;
        void (async () => {
            for (let ahead = 1; ahead < this.maxBufferedFrames && token === this.prefetchToken; ahead++) {
                const frameIndex = (index + ahead) % this.manifest.frame_count;
                try {
                    await this.ensureFrame(frameIndex);
                    this.trimCache();
                    this.onStateChange?.();
                } catch (error) {
                    if (this.destroyed) break;
                    console.warn(`[SplatStream] Could not prefetch frame ${frameIndex}:`, error);
                    break;
                }
            }
        })();
    }

    private finalizeFrameRelease(frame: BufferedFrame): void {
        frame.entity.enabled = false;
        if (!this.destroyed && frame.resource && !frame.asset
            && this.cache.size + this.directPool.length < this.maxDirectResources) {
            frame.index = -1;
            this.directPool.push(frame);
            return;
        }
        this.destroyFrameStorage(frame);
    }

    private destroyFrameStorage(frame: BufferedFrame): void {
        frame.entity.enabled = false;
        if (frame.entity.gsplat) frame.entity.removeComponent('gsplat');
        frame.entity.destroy();
        if (frame.asset) {
            frame.asset.unload();
            this.app.assets.remove(frame.asset);
        } else {
            if (frame.resource) {
                frame.resource.destroy();
                frame.resource = null;
                this.directResourceAlive = Math.max(0, this.directResourceAlive - 1);
            }
        }
    }

    private destroyFrameStorageAfterReconcile(frames: Iterable<BufferedFrame>): void {
        const pending = [...new Set(frames)];
        if (pending.length === 0) return;
        for (const frame of pending) frame.entity.enabled = false;
        // Removing the component immediately leaves an already-captured
        // unified world state holding a placement whose resource was nulled by
        // GSplatPlacement.destroy(). Let one render reconcile the disabled
        // placements first, then release their storage. During page unload the
        // callback may never run, which is fine: the browser owns teardown.
        this.app.once('frameend', () => {
            for (const frame of pending) this.destroyFrameStorage(frame);
        });
        this.app.renderNextFrame = true;
    }

    private takeDirectPoolFrame(data: GSplatCompressedData): BufferedFrame | null {
        for (let i = this.directPool.length - 1; i >= 0; i--) {
            const frame = this.directPool[i];
            const packedTexture = frame.resource?.getTexture('packedTexture');
            const chunkTexture = frame.resource?.getTexture('chunkTexture');
            if (frame.resource?.refCount === 0 && packedTexture && chunkTexture
                && packedTexture.width * packedTexture.height * 4 >= data.vertexData.length
                && chunkTexture.width * chunkTexture.height * 4 >= data.numChunks * 20) {
                this.directPool.splice(i, 1);
                return frame;
            }
        }
        // An undersized free texture cannot be resized without changing its
        // address layout. Discard it before allocating the uncommon larger
        // frame; in-use candidates remain untouched until the renderer lets
        // go of their world state.
        for (let i = this.directPool.length - 1; i >= 0; i--) {
            const frame = this.directPool[i];
            if (frame.resource?.refCount === 0) {
                this.directPool.splice(i, 1);
                this.destroyFrameStorage(frame);
            }
        }
        return null;
    }

    private async acquireDirectPoolFrame(data: GSplatCompressedData): Promise<BufferedFrame | null> {
        let waited = false;
        const waitStarted = performance.now();
        while (!this.destroyed) {
            const reusable = this.takeDirectPoolFrame(data);
            if (reusable) {
                if (waited) this.directPoolWaitTotalMs += performance.now() - waitStarted;
                return reusable;
            }
            if (this.directResourceAlive < this.maxDirectResources) {
                if (waited) this.directPoolWaitTotalMs += performance.now() - waitStarted;
                return null;
            }
            if (!waited) {
                waited = true;
                this.directPoolWaits++;
            }
            // A unified CPU-sort world state can hold the just-disabled
            // resource slightly past frameend. Keep rendering and wait for
            // that reference to drain instead of allocating a third texture
            // set and immediately feeding the GC/driver cleanup queue.
            await new Promise<void>(resolve => {
                let settled = false;
                const finish = (): void => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeout);
                    this.app.off('frameend', finish);
                    resolve();
                };
                const timeout = window.setTimeout(finish, 100);
                this.app.on('frameend', finish);
                this.app.renderNextFrame = true;
            });
        }
        throw new Error('Animated splat player was destroyed while waiting for a reusable GPU buffer.');
    }

    private uploadDirectResource(resource: GSplatCompressedResource, data: GSplatCompressedData): void {
        const packedTexture = resource.getTexture('packedTexture');
        const chunkTexture = resource.getTexture('chunkTexture');
        if (!packedTexture || !chunkTexture) {
            throw new Error('Reusable compressed splat resource is missing its packed textures.');
        }

        const packedTarget = packedTexture.lock() as Uint32Array;
        packedTarget.set(data.vertexData);
        packedTexture.unlock();

        const chunkTarget = chunkTexture.lock() as Float32Array;
        const requiredChunkBounds = data.numChunks * 6;
        const existingChunkBuffer = resource.chunks?.buffer;
        resource.chunks = existingChunkBuffer && existingChunkBuffer.byteLength >= requiredChunkBounds * 4
            ? new Float32Array(existingChunkBuffer, 0, requiredChunkBounds)
            : new Float32Array(requiredChunkBounds);
        const chunkBounds = resource.chunks;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (let chunk = 0; chunk < data.numChunks; chunk++) {
            const sourceOffset = chunk * data.chunkSize;
            const targetOffset = chunk * 20;
            const boundsOffset = chunk * 6;
            // Avoid thousands of transient subarray objects per frame. This
            // same pass updates the GPU chunk record, CPU sort bounds and AABB
            // instead of walking the chunk table three separate times.
            for (let value = 0; value < data.chunkSize; value++) {
                chunkTarget[targetOffset + value] = data.chunkData[sourceOffset + value];
            }
            for (let value = data.chunkSize; value < 20; value++) {
                chunkTarget[targetOffset + value] = 0;
            }
            if (data.chunkSize === 12) {
                chunkTarget[targetOffset + 15] = 1;
                chunkTarget[targetOffset + 16] = 1;
                chunkTarget[targetOffset + 17] = 1;
            }

            const chunkMinX = data.chunkData[sourceOffset];
            const chunkMinY = data.chunkData[sourceOffset + 1];
            const chunkMinZ = data.chunkData[sourceOffset + 2];
            const chunkMaxX = data.chunkData[sourceOffset + 3];
            const chunkMaxY = data.chunkData[sourceOffset + 4];
            const chunkMaxZ = data.chunkData[sourceOffset + 5];
            chunkBounds[boundsOffset] = chunkMinX;
            chunkBounds[boundsOffset + 1] = chunkMinY;
            chunkBounds[boundsOffset + 2] = chunkMinZ;
            chunkBounds[boundsOffset + 3] = chunkMaxX;
            chunkBounds[boundsOffset + 4] = chunkMaxY;
            chunkBounds[boundsOffset + 5] = chunkMaxZ;
            const radius = Math.exp(Math.max(
                data.chunkData[sourceOffset + 9],
                data.chunkData[sourceOffset + 10],
                data.chunkData[sourceOffset + 11]
            ));
            minX = Math.min(minX, chunkMinX - radius);
            minY = Math.min(minY, chunkMinY - radius);
            minZ = Math.min(minZ, chunkMinZ - radius);
            maxX = Math.max(maxX, chunkMaxX + radius);
            maxY = Math.max(maxY, chunkMaxY + radius);
            maxZ = Math.max(maxZ, chunkMaxZ + radius);
        }
        chunkTexture.unlock();

        resource.gsplatData = data;
        resource.aabb.center.set(
            (minX + maxX) * 0.5,
            (minY + maxY) * 0.5,
            (minZ + maxZ) * 0.5
        );
        resource.aabb.halfExtents.set(
            (maxX - minX) * 0.5,
            (maxY - minY) * 0.5,
            (maxZ - minZ) * 0.5
        );
        resource.mesh?.aabb.copy(resource.aabb);
    }

    private reserveDirectResourceCapacity(resource: GSplatCompressedResource, data: GSplatCompressedData): void {
        const packedTexture = resource.getTexture('packedTexture');
        const chunkTexture = resource.getTexture('chunkTexture');
        if (!packedTexture || !chunkTexture) return;

        let resized = false;
        if (packedTexture.width * packedTexture.height < this.directSplatCapacity) {
            const width = Math.ceil(Math.sqrt(this.directSplatCapacity));
            const height = Math.ceil(this.directSplatCapacity / width);
            packedTexture.resize(width, height);
            resource.streams.textureDimensions.set(width, height);
            resized = true;
        }

        const chunkCapacity = Math.ceil(this.directSplatCapacity / 256);
        const currentChunkCapacity = Math.floor(chunkTexture.width / 5) * chunkTexture.height;
        if (currentChunkCapacity < chunkCapacity) {
            const rowChunks = Math.ceil(Math.sqrt(chunkCapacity));
            const rows = Math.ceil(chunkCapacity / rowChunks);
            chunkTexture.resize(rowChunks * 5, rows);
            resized = true;
        }

        if (resized) {
            // Texture.resize discards its previous backing storage. Restore the
            // current frame before the placement/material is created.
            this.uploadDirectResource(resource, data);
            this.directCapacityResizes++;
        }
    }

    private retireFrame(frame: BufferedFrame): void {
        frame.entity.enabled = false;
        this.retiring.set(frame.index, {
            frame,
            releaseAfterFrameEnd: this.completedFrameEnds + 1
        });
        // Entity disablement removes the placement from its layer immediately,
        // but the renderer reconciles that layer only during render(). Force
        // the full frame which makes the later resource release safe.
        this.app.renderNextFrame = true;
    }

    private onFrameEnd(): void {
        this.completedFrameEnds++;
        for (const [index, pending] of this.retiring) {
            if (pending.releaseAfterFrameEnd <= this.completedFrameEnds) {
                this.retiring.delete(index);
                this.finalizeFrameRelease(pending.frame);
            }
        }
    }

    private trimCache(): void {
        const keep = new Set<number>();
        keep.add(this.currentFrame);
        const targetSize = Math.min(this.maxBufferedFrames, this.manifest.frame_count);
        for (let ahead = 0; keep.size < targetSize; ahead++) {
            keep.add((this.desiredFrame + ahead) % this.manifest.frame_count);
        }
        for (const [index, frame] of this.cache) {
            if (!keep.has(index)) {
                this.cache.delete(index);
                this.retireFrame(frame);
            }
        }
    }

    private get playhead(): number {
        if (this.audio && Number.isFinite(this.audio.currentTime)) {
            return Math.max(0, this.audio.currentTime - (this.manifest.audio_offset_seconds ?? 0));
        }
        return this.playing
            ? Math.max(0, performance.now() / 1000 - this.silentClockAnchor)
            : this.silentPlayhead;
    }

    private get loopDuration(): number {
        const manifestDuration = this.manifest.duration_seconds;
        if (!this.audio || !Number.isFinite(this.audio.duration)) return manifestDuration;
        const audioDuration = this.audio.duration - (this.manifest.audio_offset_seconds ?? 0);
        return audioDuration > 0 ? Math.min(manifestDuration, audioDuration) : manifestDuration;
    }

    private async waitForAudioMetadata(): Promise<void> {
        if (!this.audio || this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) return;
        const audio = this.audio;
        await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => {
                cleanup();
                reject(new Error('Audio metadata did not arrive in time.'));
            }, 10000);
            const cleanup = (): void => {
                window.clearTimeout(timeout);
                audio.removeEventListener('loadedmetadata', loaded);
                audio.removeEventListener('error', failed);
            };
            const loaded = (): void => { cleanup(); resolve(); };
            const failed = (): void => { cleanup(); reject(new Error('The source audio could not be loaded.')); };
            audio.addEventListener('loadedmetadata', loaded, { once: true });
            audio.addEventListener('error', failed, { once: true });
        });
    }

    async play(): Promise<void> {
        if (this.playing) return;
        // Stop the paused-state sequential prefetch loop. An already active
        // request can finish, but it cannot start another neighbour afterward.
        ++this.prefetchToken;
        // A raw hint may have been selected before a pause or XR transition.
        // Its bytes can finish into the bounded cache, but its old frame index
        // must not steer the resumed timeline.
        this.rawPrefetch = null;
        this.rawPrefetchIndex = -1;
        if (this.audio) {
            await this.waitForAudioMetadata();
            const offset = this.manifest.audio_offset_seconds ?? 0;
            const localTime = this.playhead;
            if (localTime >= this.loopDuration || this.audio.currentTime < offset) {
                this.audio.currentTime = offset;
            }
            await this.audio.play();
        } else {
            this.silentClockAnchor = performance.now() / 1000 - this.silentPlayhead;
        }
        this.playing = true;
        this.onStateChange?.();
    }

    pause(): void {
        if (!this.playing) return;
        this.silentPlayhead = Math.min(this.playhead, this.manifest.duration_seconds);
        this.audio?.pause();
        this.playing = false;
        this.rawPrefetch = null;
        this.rawPrefetchIndex = -1;
        if (this.currentFrame >= 0) this.prefetchFrom(this.currentFrame);
        this.onStateChange?.();
    }

    async toggle(): Promise<void> {
        if (this.playing) this.pause();
        else await this.play();
    }

    private restartLoop(): void {
        const now = performance.now();
        // The media 'ended' event and the PlayCanvas update may observe the
        // same boundary in one task. Restart exactly once for that boundary.
        if (now - this.lastLoopRestartAt < 100) return;
        this.lastLoopRestartAt = now;
        const offset = this.manifest.audio_offset_seconds ?? 0;
        this.completedLoops++;
        if (this.audio) {
            this.audio.currentTime = offset;
            void this.audio.play().catch(error => console.warn('[SplatStream] Audio loop restart failed:', error));
        } else {
            this.silentPlayhead = 0;
            this.silentClockAnchor = performance.now() / 1000;
        }
    }

    private syncToClock(): void {
        let time = this.playhead;
        if (this.audio?.ended || time >= this.loopDuration - 0.001) {
            this.restartLoop();
            time = 0;
        }
        this.desiredFrame = Math.min(
            this.manifest.frame_count - 1,
            Math.floor(time * this.manifest.fps)
        );
        const ready = this.cache.get(this.desiredFrame);
        if (ready) {
            this.displayChronologically(ready);
        } else {
            if (this.lastMissedFrame !== this.desiredFrame) {
                this.lastMissedFrame = this.desiredFrame;
                this.droppedFrames++;
            }
            this.requestDesiredFrame();
        }
    }

    private requestDesiredFrame(): void {
        if (this.foregroundLoad || this.destroyed) return;
        // Paused-state prefetch may have filled the second decoded slot with a
        // neighbour that is no longer useful once the audio clock advances.
        // Retire it before the ranged read so its GPU storage is available to
        // the strict double buffer by the time parsing begins.
        this.trimCache();
        // Prefer the one raw frame whose transfer has already overlapped the
        // previous parse. It was predicted from the live audio clock, and any
        // remaining wait is deduplicated by SplatStreamSource.
        const requestedFrame = this.takeRawPipelineFrame() ?? this.desiredFrame;
        this.foregroundLoad = this.ensureFrame(requestedFrame)
            .then(frame => {
                // On high-bitrate independent-frame streams the audio clock can
                // move several source frames during one range-read + parse +
                // upload. Showing the completed clock sample preserves visible
                // progress; requiring exact equality can starve the display
                // forever even though useful frames keep finishing.
                if (this.playing && !this.destroyed) {
                    this.displayChronologically(frame);
                } else {
                    this.trimCache();
                }
            })
            .catch(error => {
                if (!this.destroyed) console.error(`[SplatStream] Frame ${requestedFrame} failed:`, error);
            })
            .finally(() => {
                this.foregroundLoad = null;
                if (this.playing && !this.destroyed) this.syncToClock();
            });
    }

    private update(): void {
        if (!this.playing || this.destroyed) return;
        this.syncToClock();
        this.app.renderNextFrame = true;
    }

    get performanceStats(): SplatStreamPerformanceStats {
        const displayWindowMs = this.recentDisplayTimes.length > 1
            ? this.recentDisplayTimes[this.recentDisplayTimes.length - 1] - this.recentDisplayTimes[0]
            : 0;
        const current = this.cache.get(this.currentFrame);
        const sourceSplats = current?.splats ?? this.currentSplatCount;
        const submittedSplats = sourceSplats;
        const cache = this.source.persistentCache?.stats;
        return {
            deliveredFps: displayWindowMs > 0
                ? (this.recentDisplayTimes.length - 1) * 1000 / displayWindowMs
                : 0,
            averageNetworkMs: this.source.networkRequests > 0
                ? this.source.networkTotalMs / this.source.networkRequests
                : 0,
            averageParseUploadMs: this.parsedFrames > 0
                ? this.parseUploadTotalMs / this.parsedFrames
                : 0,
            averageCentersMs: this.fastPathFrames > 0
                ? this.centerBuildTotalMs / this.fastPathFrames
                : 0,
            averageTexturesMs: this.fastPathFrames > 0
                ? this.textureBuildTotalMs / this.fastPathFrames
                : 0,
            averageSortInputSplats: submittedSplats,
            currentFrame: Math.max(0, this.currentFrame),
            sourceSplats,
            submittedSplats,
            cacheFrames: cache?.cachedFrames ?? 0,
            cacheFrameCount: cache?.frameCount ?? this.manifest.frame_count
        };
    }

    get diagnostics(): string[] {
        const averageNetworkMs = this.source.networkRequests > 0
            ? this.source.networkTotalMs / this.source.networkRequests
            : 0;
        const averageParseMs = this.parsedFrames > 0
            ? this.parseUploadTotalMs / this.parsedFrames
            : 0;
        const displayWindowMs = this.recentDisplayTimes.length > 1
            ? this.recentDisplayTimes[this.recentDisplayTimes.length - 1] - this.recentDisplayTimes[0]
            : 0;
        const deliveredFps = displayWindowMs > 0
            ? (this.recentDisplayTimes.length - 1) * 1000 / displayWindowMs
            : 0;
        const averageCentersMs = this.fastPathFrames > 0
            ? this.centerBuildTotalMs / this.fastPathFrames
            : 0;
        const averageTexturesMs = this.fastPathFrames > 0
            ? this.textureBuildTotalMs / this.fastPathFrames
            : 0;
        const averageCenterDispatchMs = this.fastPathFrames > 0
            ? this.centerDispatchTotalMs / this.fastPathFrames
            : 0;
        const averageSampleOffsetMs = this.sampleOffsetCount > 0
            ? this.sampleOffsetTotalMs / this.sampleOffsetCount
            : 0;
        return [
            `Animation: ${this.manifest.frame_count.toLocaleString()} frames · ${this.manifest.fps.toFixed(2)} fps · ${this.manifest.duration_seconds.toFixed(1)} s`,
            `Capture camera: ${this.framePoses ? 'removed into canonical frame 0' : 'legacy camera-relative frames'}`,
            `Playback: ${this.playing ? 'playing' : 'paused'} · frame ${Math.max(0, this.currentFrame) + 1}/${this.manifest.frame_count}`,
            `Quality: full baseline · ${this.performanceStats.sourceSplats.toLocaleString()} splats submitted`,
            `Timeline: ${this.completedLoops} completed loops · ${this.loopDuration.toFixed(3)} s effective / ${this.manifest.duration_seconds.toFixed(3)} s splats`,
            `Stream buffer: ${this.cache.size}/${this.maxBufferedFrames} frames · ${(this.source.cachedBytes / 1048576).toFixed(1)} MB raw cache`,
            `Delivery: ${deliveredFps.toFixed(1)} visual fps · ${averageNetworkMs.toFixed(0)} ms network · ${averageParseMs.toFixed(0)} ms parse/upload`,
            `Decode: ${this.fastPathFrames}/${this.parsedFrames} direct packed-Ply · ${unalignedPackedCopies} alignment copies (${(unalignedPackedCopyBytes / 1048576).toFixed(0)} MB) · ${averageCentersMs.toFixed(0)} ms async centers (${averageCenterDispatchMs.toFixed(0)} ms main) · ${averageTexturesMs.toFixed(0)} ms textures`,
            `GPU reuse: ${this.directResourceReuses}/${this.fastPathFrames} uploads reused · ${this.directResourceCreates} resources created · ${this.directCapacityResizes} capacity reserves · ${this.directPool.length} pooled`,
            `GPU waits: ${this.directPoolWaits} · ${(this.directPoolWaits > 0 ? this.directPoolWaitTotalMs / this.directPoolWaits : 0).toFixed(0)} ms average · ${this.directResourceAlive}/${this.maxDirectResources} resources alive`,
            `Sorter centers: ${zeroCopySorterTransfers} zero-copy worker transfers`,
            `Network: ${(this.source.downloadedBytes / 1048576).toFixed(1)} MB · ${this.source.networkRequests} reads · ${this.source.cacheHits} cache hits`,
            `Quest local cache: ${this.source.persistentCache?.diagnostics ?? `unavailable (${this.source.persistentCacheUnavailableReason || 'unknown'})`}${this.source.persistentCache ? ` · ${this.source.persistentCache.alignedReadHits} aligned reads` : ''}${this.source.localCacheFillBytes > 0 ? ` · ${(this.source.localCacheFillBytes / 1048576).toFixed(0)} MB downloaded for cache` : ''}`,
            `HTTP disk cache: ${rangedHttpCacheHits}/${rangedTimingReads} measured range reads`,
            `Pipeline: ${this.rawPrefetchUses}/${this.rawPrefetches} raw samples consumed · ${this.source.inFlightHits} in-flight joins`,
            `A/V sample offset: ${averageSampleOffsetMs >= 0 ? '+' : ''}${averageSampleOffsetMs.toFixed(0)} ms (${averageSampleOffsetMs >= 0 ? 'visual behind' : 'visual ahead'})`,
            `Late visual frames: ${this.droppedFrames} · clock: ${this.audio ? 'source audio' : 'monotonic fallback'}`
        ];
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.pause();
        this.audio?.removeEventListener('ended', this.audioEndedHandler);
        this.audio?.removeAttribute('src');
        this.audio?.load();
        this.app.off('update', this.updateHandler);
        this.app.off('frameend', this.frameEndHandler);
        this.destroyFrameStorageAfterReconcile([
            ...this.cache.values(),
            ...[...this.retiring.values()].map(pending => pending.frame),
            ...this.directPool
        ]);
        this.cache.clear();
        this.retiring.clear();
        this.directPool.length = 0;
        this.loading.clear();
        this.rawPrefetch = null;
        this.rawPrefetchIndex = -1;
        this.centerWorker?.destroy();
        this.source.destroy();
    }
}
