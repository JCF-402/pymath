import type { PythonResponse } from "./types";
import type { RebuildRequest } from "./note-rebuild";
import { RebuildResults } from "./rebuild-results";
import { runNoteRebuild } from "./rebuild-runner";

type SendRequest = (
    request: RebuildRequest,
) => Promise<PythonResponse>;

export class RebuildCoordinator {
    readonly results = new RebuildResults();

    private queue: Promise<void> = Promise.resolve();
    private controllers = new Map<string, AbortController>();
    private closed = false;

    constructor(private sendRequest: SendRequest) {}

    rebuild(
        notePath: string,
        requests: RebuildRequest[],
    ): Promise<boolean> {
        if (this.closed) {
            return Promise.reject(
                new Error("Rebuild coordinator is closed."),
            );
        }

        // Stop older work for this note before its next request.
        this.controllers.get(notePath)?.abort();

        const controller = new AbortController();
        this.controllers.set(notePath, controller);

        const task = this.queue.then(async () => {
            try {
                // A queued rebuild may already have been replaced.
                if (controller.signal.aborted || this.closed) {
                    return false;
                }

                this.results.register(notePath, requests);

                await runNoteRebuild(
                    requests,
                    this.sendRequest,
                    response => {
                        this.results.accept(response);
                    },
                    controller.signal,
                );

                return true;
            } catch (error) {
                if (controller.signal.aborted || this.closed) {
                    this.results.clearNote(notePath);
                    return false;
                }

                // Keep the recorded reset failure for inspection.
                // Other failures must discard incomplete results.
                if (
                    this.results.getStatus(notePath)?.reset !== "failed"
                ) {
                    this.results.clearNote(notePath);
                }

                throw error;
            } finally {
                // An older task must not remove its replacement.
                if (this.controllers.get(notePath) === controller) {
                    this.controllers.delete(notePath);
                }
            }
        });

        // A failed task must not prevent later tasks from running.
        this.queue = task.then(
            () => {},
            () => {},
        );

        return task;
    }

    close(): void {
        this.closed = true;

        for (const controller of this.controllers.values()) {
            controller.abort();
        }

        this.controllers.clear();
        this.results.clear();
    }
}
