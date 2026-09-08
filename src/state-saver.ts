export class StateSaver {
    private timer: number | undefined;
    private queue: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(
        private readState: () => unknown,
        private writeState: (state: unknown) => Promise<void>,
        private reportError: (error: unknown) => void,
    ) {}

    schedule(): void {
        if (this.closed) return;

        if (this.timer !== undefined) {
            window.clearTimeout(this.timer);
        }

        this.timer = window.setTimeout(() => {
            this.timer = undefined;
            void this.saveNow().catch(this.reportError);
        }, 300);
    }

    async saveNow(): Promise<void> {
        if (this.timer !== undefined) {
            window.clearTimeout(this.timer);
            this.timer = undefined;
        }

        // Freeze this save's data before later edits change it.
        const snapshot = structuredClone(this.readState());
        const write = this.queue.then(() => this.writeState(snapshot));

        // Keep the queue usable after failure; the caller still sees rejection.
        this.queue = write.catch(() => {});
        await write;
    }

    async close(): Promise<void> {
        this.closed = true;

        if (this.timer !== undefined) {
            await this.saveNow();
        } else {
            await this.queue;
        }
    }
}
