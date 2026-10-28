const MIB = 1024 * 1024;

const CACHE_WORKER_SOURCE = String.raw`
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const ROOT_NAME = 'ems-splat-cache-v1';
const META_NAME = 'meta.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let root = null;
let streamDirectory = null;
let streamId = '';
let meta = null;
let reserveBytes = 512 * MIB;
let cacheLimitBytes = 0;
let lastMetaWrite = 0;

const frameName = index => index.toString().padStart(6, '0') + '.bin';

const openAccess = async (handle, mode) => {
    if (typeof handle.createSyncAccessHandle !== 'function') {
        throw new Error('Quest browser does not expose synchronous OPFS worker access.');
    }
    return handle.createSyncAccessHandle({ mode });
};

const readJson = async directory => {
    try {
        const fileHandle = await directory.getFileHandle(META_NAME);
        const access = await openAccess(fileHandle, 'read-only');
        try {
            const size = access.getSize();
            const bytes = new Uint8Array(size);
            const read = access.read(bytes, { at: 0 });
            if (read !== size) return null;
            return JSON.parse(decoder.decode(bytes));
        } finally {
            access.close();
        }
    } catch {
        return null;
    }
};

const writeMeta = async force => {
    const now = Date.now();
    if (!force && now - lastMetaWrite < 5000) return;
    meta.lastAccess = now;
    const bytes = encoder.encode(JSON.stringify(meta));
    const fileHandle = await streamDirectory.getFileHandle(META_NAME, { create: true });
    const access = await openAccess(fileHandle, 'readwrite');
    try {
        access.truncate(0);
        const written = access.write(bytes, { at: 0 });
        if (written !== bytes.byteLength) throw new Error('Local cache metadata write was truncated.');
        access.flush();
    } finally {
        access.close();
    }
    lastMetaWrite = now;
};

const storageSnapshot = async () => {
    const estimate = await navigator.storage.estimate();
    return {
        cachedFrames: meta.cached.reduce((count, value) => count + (value ? 1 : 0), 0),
        cachedBytes: meta.cachedBytes,
        totalBytes: meta.totalBytes,
        frameCount: meta.frameCount,
        quotaBytes: estimate.quota || 0,
        usageBytes: estimate.usage || 0,
        reserveBytes,
        cacheLimitBytes,
        cachedIndices: meta.cached.flatMap((value, index) => value ? [index] : [])
    };
};

const listStreamMetadata = async () => {
    const result = [];
    for await (const [name, handle] of root.entries()) {
        if (handle.kind !== 'directory') continue;
        const candidate = await readJson(handle);
        if (candidate && candidate.version === 1 && Number.isFinite(candidate.cachedBytes)) {
            result.push({ name, meta: candidate });
        }
    }
    return result;
};

const ensureCapacity = async byteLength => {
    const estimate = await navigator.storage.estimate();
    const quota = estimate.quota || 0;
    const usage = estimate.usage || 0;
    const entries = await listStreamMetadata();
    let cacheBytes = entries.reduce((sum, entry) => sum + entry.meta.cachedBytes, 0);
    let reclaimed = 0;
    const candidates = entries
        .filter(entry => entry.name !== streamId)
        .sort((a, b) => (a.meta.lastAccess || 0) - (b.meta.lastAccess || 0));
    const fits = () => cacheBytes + byteLength <= cacheLimitBytes
        && usage + byteLength - reclaimed <= Math.max(0, quota - reserveBytes);
    while (!fits() && candidates.length > 0) {
        const oldest = candidates.shift();
        await root.removeEntry(oldest.name, { recursive: true });
        cacheBytes -= oldest.meta.cachedBytes;
        reclaimed += oldest.meta.cachedBytes;
    }
    return fits();
};

const initialize = async message => {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
        throw new Error('Origin-private file storage is unavailable. Use HTTPS or localhost in Quest Browser.');
    }
    streamId = message.streamId;
    const originRoot = await navigator.storage.getDirectory();
    root = await originRoot.getDirectoryHandle(ROOT_NAME, { create: true });
    streamDirectory = await root.getDirectoryHandle(streamId, { create: true });
    meta = await readJson(streamDirectory);
    const valid = meta
        && meta.version === 1
        && meta.streamId === streamId
        && meta.frameCount === message.frameLengths.length
        && meta.totalBytes === message.totalBytes
        && Array.isArray(meta.cached)
        && meta.cached.length === message.frameLengths.length;
    if (!valid) {
        await root.removeEntry(streamId, { recursive: true });
        streamDirectory = await root.getDirectoryHandle(streamId, { create: true });
        meta = {
            version: 1,
            streamId,
            frameCount: message.frameLengths.length,
            totalBytes: message.totalBytes,
            cachedBytes: 0,
            cached: new Array(message.frameLengths.length).fill(false),
            lastAccess: Date.now()
        };
        await writeMeta(true);
    }
    const estimate = await navigator.storage.estimate();
    const quota = estimate.quota || 0;
    reserveBytes = Math.min(2 * GIB, Math.max(512 * MIB, quota * 0.10));
    cacheLimitBytes = Math.min(8 * GIB, Math.max(0, quota - reserveBytes));
    await writeMeta(false);
    return storageSnapshot();
};

const readFrame = async message => {
    const index = message.index;
    const byteOffset = Math.max(0, Math.min(3, message.byteOffset || 0));
    if (!meta.cached[index]) return { hit: false, stats: await storageSnapshot() };
    try {
        const fileHandle = await streamDirectory.getFileHandle(frameName(index));
        const access = await openAccess(fileHandle, 'read-only');
        let buffer;
        try {
            if (access.getSize() !== message.length) throw new Error('Cached frame length changed.');
            buffer = new ArrayBuffer(message.length + byteOffset);
            const read = access.read(new Uint8Array(buffer, byteOffset, message.length), { at: 0 });
            if (read !== message.length) throw new Error('Cached frame read was truncated.');
        } finally {
            access.close();
        }
        // Reading does not change cache membership or storage usage. Deliver
        // the bytes without quota queries, metadata flushes or an index scan.
        // Access is persisted at open and on cache mutations instead.
        meta.lastAccess = Date.now();
        return { hit: true, buffer, byteOffset };
    } catch {
        meta.cached[index] = false;
        meta.cachedBytes = Math.max(0, meta.cachedBytes - message.length);
        try { await streamDirectory.removeEntry(frameName(index)); } catch {}
        await writeMeta(true);
        return { hit: false, stats: await storageSnapshot() };
    }
};

const writeFrame = async message => {
    const index = message.index;
    const buffer = message.buffer;
    if (meta.cached[index]) return { stored: true, stats: await storageSnapshot() };
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== message.length) {
        throw new Error('Local cache received an invalid frame body.');
    }
    if (!await ensureCapacity(buffer.byteLength)) {
        return {
            stored: false,
            reason: 'Storage reserve reached; older compatible streams could not free enough space.',
            stats: await storageSnapshot()
        };
    }
    const fileHandle = await streamDirectory.getFileHandle(frameName(index), { create: true });
    const access = await openAccess(fileHandle, 'readwrite');
    try {
        access.truncate(0);
        const written = access.write(new Uint8Array(buffer), { at: 0 });
        if (written !== buffer.byteLength) throw new Error('Local frame write was truncated.');
        access.flush();
    } finally {
        access.close();
    }
    meta.cached[index] = true;
    meta.cachedBytes += buffer.byteLength;
    await writeMeta(true);
    return { stored: true, stats: await storageSnapshot() };
};

const clearCurrent = async () => {
    await root.removeEntry(streamId, { recursive: true });
    streamDirectory = await root.getDirectoryHandle(streamId, { create: true });
    meta.cached.fill(false);
    meta.cachedBytes = 0;
    meta.lastAccess = Date.now();
    await writeMeta(true);
    return storageSnapshot();
};

const respond = (id, result) => {
    if (result && result.buffer instanceof ArrayBuffer) {
        self.postMessage({ id, ok: true, ...result }, [result.buffer]);
    } else {
        self.postMessage({ id, ok: true, ...result });
    }
};

const handle = async message => {
    switch (message.type) {
        case 'init': respond(message.id, { stats: await initialize(message) }); break;
        case 'read': respond(message.id, await readFrame(message)); break;
        case 'write': respond(message.id, await writeFrame(message)); break;
        case 'clear': respond(message.id, { stats: await clearCurrent() }); break;
        default: throw new Error('Unknown local-cache operation.');
    }
};

let operations = Promise.resolve();
self.onmessage = event => {
    const message = event.data;
    operations = operations.then(async () => {
        try {
            await handle(message);
        } catch (error) {
            self.postMessage({
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });
};
`;

export interface PersistentCacheStats {
    cachedFrames: number;
    cachedBytes: number;
    totalBytes: number;
    frameCount: number;
    quotaBytes: number;
    usageBytes: number;
    reserveBytes: number;
    cacheLimitBytes: number;
    cachedIndices: number[];
}

interface WorkerResult {
    id: number;
    ok: boolean;
    error?: string;
    hit?: boolean;
    stored?: boolean;
    reason?: string;
    buffer?: ArrayBuffer;
    byteOffset?: number;
    stats?: PersistentCacheStats;
}

export interface PersistentCacheOpenResult {
    cache: PersistentFrameCache | null;
    reason: string | null;
}

const compactHash = async (value: string): Promise<string> => {
    if (crypto.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return [...new Uint8Array(digest)].slice(0, 16).map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
    return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
};

export class PersistentFrameCache {
    static async open(identity: string, frameLengths: number[]): Promise<PersistentCacheOpenResult> {
        if (!window.isSecureContext) {
            return { cache: null, reason: 'requires HTTPS or localhost' };
        }
        const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
        if (!storage?.getDirectory || typeof Worker === 'undefined') {
            return { cache: null, reason: 'OPFS worker storage unavailable' };
        }
        const streamId = await compactHash(identity);
        const blobUrl = URL.createObjectURL(new Blob([CACHE_WORKER_SOURCE], { type: 'text/javascript' }));
        const worker = new Worker(blobUrl, { name: `ems-cache-${streamId}` });
        URL.revokeObjectURL(blobUrl);
        const cache = new PersistentFrameCache(worker, frameLengths);
        try {
            const result = await cache.request({
                type: 'init',
                streamId,
                frameLengths,
                totalBytes: frameLengths.reduce((sum, length) => sum + length, 0)
            });
            cache.applyStats(result.stats);
            return { cache, reason: null };
        } catch (error) {
            cache.destroy();
            return {
                cache: null,
                reason: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private readonly worker: Worker;
    private readonly frameLengths: number[];
    private readonly pending = new Map<number, {
        resolve: (result: WorkerResult) => void;
        reject: (error: Error) => void;
    }>();
    private readonly cachedIndices = new Set<number>();
    private nextId = 1;
    private writeBehind: Promise<void> | null = null;
    private destroyed = false;
    private failure: Error | null = null;
    private statsValue: PersistentCacheStats;

    readHits = 0;
    alignedReadHits = 0;
    readTotalMs = 0;
    writeBehindSkips = 0;
    lastWriteError: string | null = null;

    private constructor(worker: Worker, frameLengths: number[]) {
        this.worker = worker;
        this.frameLengths = frameLengths;
        this.statsValue = {
            cachedFrames: 0,
            cachedBytes: 0,
            totalBytes: frameLengths.reduce((sum, length) => sum + length, 0),
            frameCount: frameLengths.length,
            quotaBytes: 0,
            usageBytes: 0,
            reserveBytes: 0,
            cacheLimitBytes: 0,
            cachedIndices: []
        };
        worker.onmessage = event => {
            const result = event.data as WorkerResult;
            const request = this.pending.get(result.id);
            if (!request) return;
            this.pending.delete(result.id);
            if (!result.ok) request.reject(new Error(result.error || 'Local cache worker failed.'));
            else request.resolve(result);
        };
        worker.onerror = event => {
            this.close(new Error(event.message || 'Local cache worker crashed.'));
        };
        worker.onmessageerror = () => this.close(new Error('Local cache worker returned unreadable data.'));
    }

    private request(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<WorkerResult> {
        if (this.destroyed) return Promise.reject(this.failure ?? new Error('Local cache is closed.'));
        const id = this.nextId++;
        return new Promise<WorkerResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.worker.postMessage({ id, ...message }, transfer);
            } catch (error) {
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private applyStats(stats?: PersistentCacheStats): void {
        if (!stats) return;
        this.statsValue = stats;
        this.cachedIndices.clear();
        for (const index of stats.cachedIndices) this.cachedIndices.add(index);
    }

    get stats(): PersistentCacheStats {
        return this.statsValue;
    }

    has(index: number): boolean {
        return !this.destroyed && this.cachedIndices.has(index);
    }

    async read(index: number, byteOffset = 0): Promise<ArrayBuffer | Uint8Array | null> {
        if (!this.has(index)) return null;
        const started = performance.now();
        let result: WorkerResult;
        try {
            result = await this.request({
                type: 'read',
                index,
                length: this.frameLengths[index],
                byteOffset
            });
        } catch (error) {
            // OPFS is optional. Disable a failed worker once and let the
            // authoritative range source serve this and subsequent frames.
            this.close(error instanceof Error ? error : new Error(String(error)));
            return null;
        }
        this.applyStats(result.stats);
        if (!result.hit || !result.buffer) return null;
        this.readHits++;
        if (result.byteOffset) this.alignedReadHits++;
        this.readTotalMs += performance.now() - started;
        return result.byteOffset
            ? new Uint8Array(result.buffer, result.byteOffset, this.frameLengths[index])
            : result.buffer;
    }

    putCopy(index: number, source: ArrayBuffer): void {
        if (this.has(index) || this.destroyed) return;
        if (this.writeBehind) {
            this.writeBehindSkips++;
            return;
        }
        const copy = source.slice(0);
        this.writeBehind = this.putTransferred(index, copy)
            .then(() => undefined)
            .catch(error => {
                this.lastWriteError = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                this.writeBehind = null;
            });
    }

    async putTransferred(index: number, buffer: ArrayBuffer): Promise<boolean> {
        if (this.has(index)) return true;
        const result = await this.request(
            { type: 'write', index, length: this.frameLengths[index], buffer },
            [buffer]
        );
        this.applyStats(result.stats);
        if (!result.stored && result.reason) this.lastWriteError = result.reason;
        return Boolean(result.stored);
    }

    async requestPersistence(): Promise<boolean> {
        if (typeof navigator.storage.persist !== 'function') return false;
        return navigator.storage.persist();
    }

    async drainWrites(): Promise<void> {
        await this.writeBehind;
    }

    async clear(): Promise<void> {
        const result = await this.request({ type: 'clear' });
        this.applyStats(result.stats);
    }

    destroy(): void {
        this.close(new Error('Local cache was closed.'));
    }

    private close(error: Error): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.failure = error;
        this.lastWriteError = error.message;
        this.worker.terminate();
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
    }

    get diagnostics(): string {
        if (this.failure) return `unavailable (${this.failure.message}); using streamed playback`;
        const stats = this.statsValue;
        const averageReadMs = this.readHits > 0 ? this.readTotalMs / this.readHits : 0;
        const percent = stats.totalBytes > 0 ? stats.cachedBytes / stats.totalBytes * 100 : 0;
        return `${stats.cachedFrames}/${stats.frameCount} frames · ${(stats.cachedBytes / MIB).toFixed(0)}/${(stats.totalBytes / MIB).toFixed(0)} MB (${percent.toFixed(0)}%) · ${this.readHits} reads at ${averageReadMs.toFixed(0)} ms`;
    }
}
