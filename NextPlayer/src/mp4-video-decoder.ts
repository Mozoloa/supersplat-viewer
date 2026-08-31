import {
    createFile,
    DataStream,
    Endianness,
    MP4BoxBuffer,
    type Movie,
    type Sample
} from 'mp4box';
import { mediaFetch } from './media-request';

type WritableBox = {
    write(stream: DataStream): void;
};

type VideoSampleEntry = {
    hvcC?: WritableBox;
    avcC?: WritableBox;
    av1C?: WritableBox;
};

type DemuxedVideo = {
    config: VideoDecoderConfig;
    samples: Sample[];
    timestampToFrame: Map<number, number>;
    lowDelay: boolean;
};

const HEADER_CHUNK_BYTES = 1024 * 1024;

const fetchRange = async (url: string, start: number, end: number): Promise<ArrayBuffer> => {
    const response = await mediaFetch(url, {
        headers: { Range: `bytes=${start}-${end}` }
    });
    if (response.status !== 206) {
        await response.body?.cancel();
        throw new Error(`Attribute MP4 did not honor byte range ${start}-${end} (HTTP ${response.status}).`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== end - start + 1) {
        throw new Error(`Attribute MP4 range was truncated (${bytes.byteLength}/${end - start + 1}).`);
    }
    return bytes;
};

const timeout = async <T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> => {
    let timer = 0;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms.`)), milliseconds);
            })
        ]);
    } finally {
        window.clearTimeout(timer);
    }
};

const decoderDescription = (entry: VideoSampleEntry): ArrayBuffer | undefined => {
    const box = entry.hvcC ?? entry.avcC ?? entry.av1C;
    if (!box) return undefined;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    // WebCodecs wants the decoder configuration record payload, while MP4Box
    // serializes the complete hvcC/avcC box (size + fourcc + payload).
    return stream.buffer.slice(8);
};

const demux = async (url: string, expectedFrames: number): Promise<DemuxedVideo> => {
    // attributes.mp4 is written with +faststart, so its sample tables live at
    // the front. Parse only that small header and keep offset/size metadata;
    // retaining the complete 258+ MB mdat was the dominant Quest OOM source.
    const file = createFile();
    let movie: Movie | null = null;
    let demuxError: Error | null = null;
    file.onError = (_module, message) => {
        demuxError = new Error(`MP4 demux failed: ${message}`);
    };
    file.onReady = info => {
        movie = info;
    };

    let cursor = 0;
    for (let attempt = 0; attempt < 16 && !movie; attempt++) {
        const bytes = await fetchRange(url, cursor, cursor + HEADER_CHUNK_BYTES - 1);
        const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, cursor), false);
        if (demuxError) throw demuxError;
        cursor = Number.isSafeInteger(next) && next > cursor ? next : cursor + bytes.byteLength;
    }
    if (demuxError) throw demuxError;
    const parsedMovie = movie as Movie | null;
    if (!parsedMovie) throw new Error('Attribute MP4 faststart header exceeded 16 MiB or could not be parsed.');

    const track = parsedMovie.videoTracks[0];
    if (!track) throw new Error('Attribute MP4 has no video track.');
    if (track.nb_samples !== expectedFrames) {
        throw new Error(`Attribute MP4 has ${track.nb_samples} samples; expected ${expectedFrames}.`);
    }
    const samples = file.getTrackSamplesInfo(track.id);
    if (samples.length !== expectedFrames) {
        throw new Error(`Attribute MP4 indexed ${samples.length}/${expectedFrames} samples.`);
    }
    const trak = file.moov.traks.find(candidate => candidate.tkhd.track_id === track.id);
    const entry = trak?.mdia.minf.stbl.stsd.entries[0] as VideoSampleEntry | undefined;
    const description = entry ? decoderDescription(entry) : undefined;
    const config: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.video?.width ?? track.track_width,
        codedHeight: track.video?.height ?? track.track_height,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
        ...(description ? { description } : {})
    };
    const presentationOrder = [...samples].sort((a, b) => a.cts - b.cts);
    const timestampToFrame = new Map<number, number>();
    presentationOrder.forEach((sample, index) => {
        timestampToFrame.set(Math.round(sample.cts * 1_000_000 / sample.timescale), index);
    });
    return {
        config,
        samples,
        timestampToFrame,
        lowDelay: samples.every(sample => sample.cts === sample.dts)
    };
};

/**
 * Sequential MP4/WebCodecs bridge. Compressed GOP dependencies are decoded in
 * order, but frames skipped by a slow renderer are closed before CPU readback.
 */
export class Mp4VideoDecoder {
    readonly codec: string;
    readonly dimensions: readonly [number, number];

    private readonly config: VideoDecoderConfig;
    private readonly samples: Sample[];
    private readonly timestampToFrame: Map<number, number>;
    private readonly lowDelay: boolean;
    private readonly url: string;
    private decoder: VideoDecoder;
    private readonly frames = new Map<number, VideoFrame>();
    private nextSample = 0;
    private lastReturned = -1;
    private wantedFrame = 0;
    private outputSerial = 0;
    private waiters: Array<() => void> = [];
    private decoderError: Error | null = null;
    private destroyed = false;
    private readonly sampleCache = new Map<number, Promise<Uint8Array>>();
    private readonly sampleReservations = new Map<number, number>();
    private sampleCacheBytes = 0;
    private readonly maxSampleCacheBytes = 32 * 1024 * 1024;
    downloadedBytes = 0;
    networkRequests = 0;
    seekCount = 0;
    skippedCompressedSamples = 0;

    static async create(url: string, expectedFrames: number): Promise<Mp4VideoDecoder> {
        if (!('VideoDecoder' in globalThis) || !('EncodedVideoChunk' in globalThis)) {
            throw new Error('Splat-video playback requires the WebCodecs VideoDecoder API.');
        }
        const demuxed = await demux(url, expectedFrames);
        const support = await VideoDecoder.isConfigSupported(demuxed.config);
        if (!support.supported) {
            throw new Error(`This browser cannot decode ${demuxed.config.codec} through WebCodecs.`);
        }
        return new Mp4VideoDecoder(url, demuxed);
    }

    private constructor(url: string, demuxed: DemuxedVideo) {
        this.url = url;
        this.config = demuxed.config;
        this.samples = demuxed.samples;
        this.timestampToFrame = demuxed.timestampToFrame;
        this.lowDelay = demuxed.lowDelay;
        this.codec = demuxed.config.codec;
        this.dimensions = [demuxed.config.codedWidth!, demuxed.config.codedHeight!];
        this.decoder = this.createDecoder();
    }

    get decodeQueueSize(): number {
        return this.decoder.decodeQueueSize;
    }

    get compressedCacheBytes(): number {
        return this.sampleCacheBytes;
    }

    async frame(index: number): Promise<VideoFrame> {
        if (this.destroyed) throw new Error('Attribute decoder has been destroyed.');
        if (index < 0 || index >= this.samples.length) throw new Error(`Attribute frame ${index} is out of range.`);
        if (index <= this.lastReturned) this.rewind();
        this.seekOverObsoleteGops(index);
        this.wantedFrame = index;
        this.closeFramesBefore(index);

        while (!this.frames.has(index)) {
            if (this.decoderError) throw this.decoderError;
            if (this.nextSample >= this.samples.length) {
                await timeout(this.decoder.flush(), 10_000, `Flushing attribute frame ${index}`);
                if (!this.frames.has(index)) throw new Error(`Decoder did not output attribute frame ${index}.`);
                break;
            }

            const serial = this.outputSerial;
            // The current encoder is low-delay (CTS == DTS), but allow a few
            // queued samples so this remains valid if B-frames are introduced.
            const decodeLookahead = this.lowDelay ? 0 : 3;
            do {
                await this.decodeSample(this.nextSample++);
            } while (this.nextSample < this.samples.length
                && this.nextSample <= index + decodeLookahead
                && this.decoder.decodeQueueSize < 4
                && !this.frames.has(index));

            if (!this.frames.has(index)) {
                await timeout(this.waitForOutput(serial), 10_000, `Decoding attribute frame ${index}`);
            }
        }

        const frame = this.frames.get(index)!;
        this.frames.delete(index);
        this.lastReturned = index;
        // Attribute-side inflate and texture upload keep the main thread busy
        // after this frame is returned. Use that otherwise-idle interval to
        // fetch the next part of the current GOP into the bounded compressed
        // cache. The decoder still consumes only what the audio clock asks for.
        this.prefetchSamplesAfter(index, 8);
        return frame;
    }

    destroy(): void {
        this.destroyed = true;
        this.closeAllFrames();
        this.decoder.close();
        this.notifyOutput();
    }

    private createDecoder(): VideoDecoder {
        const decoder = new VideoDecoder({
            output: frame => this.handleOutput(frame),
            error: error => {
                this.decoderError = error instanceof Error ? error : new Error(String(error));
                this.notifyOutput();
            }
        });
        decoder.configure(this.config);
        return decoder;
    }

    private rewind(): void {
        this.closeAllFrames();
        this.decoder.close();
        this.decoderError = null;
        this.decoder = this.createDecoder();
        this.nextSample = 0;
        this.lastReturned = -1;
    }

    private seekOverObsoleteGops(wantedFrame: number): void {
        if (wantedFrame <= this.nextSample + 3) return;
        let syncSample = wantedFrame;
        while (syncSample > this.nextSample && !this.samples[syncSample].is_sync) syncSample--;
        if (syncSample <= this.nextSample) return;
        this.skippedCompressedSamples += syncSample - this.nextSample;
        this.seekCount++;
        this.closeAllFrames();
        this.decoder.close();
        this.decoderError = null;
        this.decoder = this.createDecoder();
        this.nextSample = syncSample;
        this.lastReturned = syncSample - 1;
    }

    private async decodeSample(index: number): Promise<void> {
        const sample = this.samples[index];
        const data = await this.readSample(index);
        if (this.decoderError) throw this.decoderError;
        if (this.decoder.state === 'closed') {
            throw new Error(`Attribute decoder closed before sample ${index}.`);
        }
        this.decoder.decode(new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: Math.round(sample.cts * 1_000_000 / sample.timescale),
            duration: Math.round(sample.duration * 1_000_000 / sample.timescale),
            data
        }));
    }

    private async readSample(index: number): Promise<Uint8Array> {
        const cached = this.sampleCache.get(index);
        if (cached) {
            this.sampleCache.delete(index);
            this.sampleCache.set(index, cached);
            return await cached;
        }
        const sample = this.samples[index];
        const promise = (async (): Promise<Uint8Array> => {
            this.networkRequests++;
            const bytes = await fetchRange(this.url, sample.offset, sample.offset + sample.size - 1);
            this.downloadedBytes += bytes.byteLength;
            return new Uint8Array(bytes);
        })();
        this.sampleCache.set(index, promise);
        this.sampleReservations.set(index, sample.size);
        this.sampleCacheBytes += sample.size;
        this.trimSampleCache(index);
        try {
            return await promise;
        } catch (error) {
            if (this.sampleCache.get(index) === promise) this.removeSampleCacheEntry(index);
            throw error;
        }
    }

    private prefetchSamplesAfter(index: number, count: number): void {
        for (let distance = 1; distance <= count; distance++) {
            const candidate = index + distance;
            if (candidate >= this.samples.length || this.sampleCache.has(candidate)) continue;
            void this.readSample(candidate).catch(error => {
                console.warn(`[SplatVideo] Attribute sample prefetch ${candidate} failed:`, error);
            });
        }
    }

    private trimSampleCache(protectedIndex: number): void {
        while (this.sampleCacheBytes > this.maxSampleCacheBytes && this.sampleCache.size > 1) {
            const oldest = this.sampleCache.keys().next().value as number | undefined;
            if (oldest === undefined) break;
            if (oldest === protectedIndex) {
                const promise = this.sampleCache.get(oldest)!;
                this.sampleCache.delete(oldest);
                this.sampleCache.set(oldest, promise);
                continue;
            }
            this.removeSampleCacheEntry(oldest);
        }
    }

    private removeSampleCacheEntry(index: number): void {
        if (!this.sampleCache.delete(index)) return;
        this.sampleCacheBytes -= this.sampleReservations.get(index) ?? 0;
        this.sampleReservations.delete(index);
    }

    private handleOutput(frame: VideoFrame): void {
        if (this.destroyed) {
            frame.close();
            return;
        }
        const index = this.timestampToFrame.get(frame.timestamp)
            ?? Math.round(frame.timestamp * this.samples.length
                / Math.max(1, this.samples.at(-1)!.cts + this.samples.at(-1)!.duration));
        if (index < this.wantedFrame) frame.close();
        else {
            this.frames.get(index)?.close();
            this.frames.set(index, frame);
        }
        this.notifyOutput();
    }

    private closeFramesBefore(index: number): void {
        for (const [frameIndex, frame] of this.frames) {
            if (frameIndex < index) {
                frame.close();
                this.frames.delete(frameIndex);
            }
        }
    }

    private closeAllFrames(): void {
        for (const frame of this.frames.values()) frame.close();
        this.frames.clear();
    }

    private waitForOutput(afterSerial: number): Promise<void> {
        if (this.outputSerial > afterSerial || this.decoderError) return Promise.resolve();
        return new Promise(resolve => this.waiters.push(resolve));
    }

    private notifyOutput(): void {
        this.outputSerial++;
        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach(resolve => resolve());
    }
}
