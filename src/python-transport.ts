import type { PythonResponse } from "./types";

type WriteRequest = (
    text: string,
    callback: (error?: Error | null) => void,
) => void;

interface PendingRequest {
    resolve: (response: PythonResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class PythonTransport {
    private pending = new Map<string, PendingRequest>();
    private closed = false;

    constructor(
        private write: WriteRequest,
        private timeoutMs = 10_000,
    ) {}

    send(request: { requestId: string }): Promise<PythonResponse> {
        if (this.closed) {
            return Promise.reject(new Error("Python transport is closed."));
        }

        if (this.pending.has(request.requestId)) {
            return Promise.reject(new Error("Duplicate request ID."));
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // A timed-out calculation may still be running.
                // Stop accepting work until the backend is restarted.
                this.close(new Error("Python request timed out."));
            }, this.timeoutMs);

            // Register before writing: Python may respond immediately.
            this.pending.set(request.requestId, {
                resolve,
                reject,
                timer,
            });

            try {
                this.write(JSON.stringify(request) + "\n", error => {
                    if (error) this.close(error);
                });
            } catch (error) {
                this.close(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        });
    }

    accept(response: PythonResponse): boolean {
        if (typeof response.requestId !== "string") return false;

        const pending = this.pending.get(response.requestId);
        if (!pending) return false;

        this.pending.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.resolve(response);

        return true;
    }

    close(error = new Error("Python transport closed.")): void {
        this.closed = true;

        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }

        this.pending.clear();
    }
}
