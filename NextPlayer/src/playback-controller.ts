export type PlaybackState = 'paused' | 'starting' | 'playing' | 'error';

/** One cancellable start and one error/stop path for either animation format. */
export class PlaybackController {
    state: PlaybackState = 'paused';
    error: string | null = null;
    private controller: AbortController | null = null;
    private pending: Promise<void> | null = null;
    private destroyed = false;

    constructor(private readonly stop: () => void, private readonly changed: () => void) {}

    start(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
        if (this.destroyed) return Promise.reject(new DOMException('Playback was closed.', 'AbortError'));
        if (this.pending) return this.pending;
        if (this.state === 'playing') return Promise.resolve();
        const controller = new AbortController();
        this.controller = controller;
        this.state = 'starting';
        this.error = null;
        this.changed();
        // Invoke immediately: HTMLMediaElement.play() must retain the click's
        // user activation, including when XR is requested in the same click.
        const pending = (async () => {
            try {
                await action(controller.signal);
                controller.signal.throwIfAborted();
                this.state = 'playing';
                this.changed();
            } catch (error) {
                if (!controller.signal.aborted) this.fail(error);
                throw error;
            } finally {
                if (this.controller === controller) {
                    this.controller = null;
                    this.pending = null;
                }
            }
        })();
        this.pending = pending;
        return pending;
    }

    pause(): void {
        this.stop();
        this.controller?.abort();
        this.controller = null;
        this.pending = null;
        this.state = 'paused';
        this.changed();
    }

    fail(error: unknown): void {
        if (this.destroyed) return;
        this.stop();
        this.controller?.abort();
        this.controller = null;
        this.pending = null;
        this.error = error instanceof Error ? error.message : String(error);
        this.state = 'error';
        this.changed();
    }

    destroy(): void {
        this.destroyed = true;
        this.stop();
        this.controller?.abort();
        this.controller = null;
        this.pending = null;
        this.state = 'paused';
    }
}

/** Start audio in the current gesture, with bounded waiting and cancellation. */
export function playAudio(audio: HTMLAudioElement, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const finish = (error?: unknown): void => {
            window.clearTimeout(timeout);
            signal.removeEventListener('abort', aborted);
            if (error) reject(error);
            else resolve();
        };
        const aborted = (): void => finish(new DOMException('Playback start was cancelled.', 'AbortError'));
        const timeout = window.setTimeout(() => finish(new Error('Source audio did not start.')), 10000);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) { aborted(); return; }
        try {
            audio.play().then(() => finish(), finish);
        } catch (error) {
            finish(error);
        }
    });
}
