import type { LineResult, PythonResponse } from "./types";
import type { RebuildRequest } from "./note-rebuild";

export interface RebuildStatus {
    reset: "pending" | "succeeded" | "failed";
    pendingCount: number;
    error?: string;
}

type Destination =
    | { notePath: string; type: "reset" }
    | {
        notePath: string;
        type: "line";
        blockId: string;
        lineIndex: number;
    };

export class RebuildResults {
    private pending = new Map<string, Destination>();
    private blocksByNote = new Map<string, Set<string>>();
    private statuses = new Map<string, RebuildStatus>();

    readonly results = new Map<string, Map<number, LineResult>>();

    register(notePath: string, requests: RebuildRequest[]): void {
        // Validate before clearing the previous results.
        if (
            requests.length === 0 ||
            requests[0]?.type !== "reset-note" ||
            requests.filter(r => r.type === "reset-note").length !== 1 ||
            requests.some(r => r.notePath !== notePath) ||
            new Set(requests.map(r => r.requestId)).size !== requests.length
        ) {
            throw new Error("Invalid note rebuild batch.");
        }

        this.clearNote(notePath);

        const blockIds = new Set<string>();

        for (const request of requests) {
            if (request.type === "reset-note") {
                this.pending.set(request.requestId, {
                    notePath,
                    type: "reset",
                });
            } else {
                blockIds.add(request.blockId);

                this.pending.set(request.requestId, {
                    notePath,
                    type: "line",
                    blockId: request.blockId,
                    lineIndex: request.lineIndex,
                });
            }
        }

        this.blocksByNote.set(notePath, blockIds);
        this.statuses.set(notePath, {
            reset: "pending",
            pendingCount: requests.length,
        });
    }

    accept(response: PythonResponse): boolean {
        if (typeof response.requestId !== "string") return false;

        const destination = this.pending.get(response.requestId);
        if (!destination) return false;

        const status = this.statuses.get(destination.notePath);
        if (!status) return false;

        this.pending.delete(response.requestId);
        status.pendingCount -= 1;

        if (destination.type === "reset") {
            if ("error" in response) {
                // Discard this rebuild's remaining destinations and results.
                this.clearNote(destination.notePath);

                this.statuses.set(destination.notePath, {
                    reset: "failed",
                    pendingCount: 0,
                    error: response.error,
                });
            } else {
                status.reset = "succeeded";
            }

            return true;
        }

        const blockResults =
            this.results.get(destination.blockId) ??
            new Map<number, LineResult>();

        blockResults.set(
            destination.lineIndex,
            "error" in response
                ? { error: response.error }
                : { result: response.result, ...(response.image ? { image: response.image } : {}), ...(response.tag ? { tag: response.tag } : {}) },
        );

        this.results.set(destination.blockId, blockResults);
        return true;
    }

    getStatus(notePath: string): RebuildStatus | undefined {
        const status = this.statuses.get(notePath);

        // Return a copy so callers cannot modify internal state.
        return status ? { ...status } : undefined;
    }

    clearNote(notePath: string): void {
        for (const blockId of this.blocksByNote.get(notePath) ?? []) {
            this.results.delete(blockId);
        }

        for (const [requestId, destination] of this.pending) {
            if (destination.notePath === notePath) {
                this.pending.delete(requestId);
            }
        }

        this.blocksByNote.delete(notePath);
        this.statuses.delete(notePath);
    }

    clear(): void {
        this.pending.clear();
        this.blocksByNote.clear();
        this.statuses.clear();
        this.results.clear();
    }
}
