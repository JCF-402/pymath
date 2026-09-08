import type { PythonResponse } from "./types";
import type { RebuildRequest } from "./note-rebuild";

type SendRequest = (
    request: RebuildRequest,
) => Promise<PythonResponse>;

export async function runNoteRebuild(
    requests: RebuildRequest[],
    sendRequest: SendRequest,
    onResponse: (response: PythonResponse) => void,
    signal?: AbortSignal,
): Promise<void> {
    const checkCancelled = () => {
        if (signal?.aborted) {
            throw new Error("Note rebuild cancelled.");
        }
    };

    checkCancelled();

    const first = requests[0];

    if (
        !first ||
        first.type !== "reset-note" ||
        requests.filter(request => request.type === "reset-note").length !== 1 ||
        requests.some(request => request.notePath !== first.notePath)
    ) {
        throw new Error("Expected a rebuild for one note, starting with reset.");
    }

    for (const request of requests) {
        checkCancelled();

        // Do not send the next request until this one responds.
        const response = await sendRequest(request);

        // An edit may have arrived while Python was calculating.
        // Ignore this response if the rebuild is now obsolete.
        checkCancelled();

        if (response.requestId !== request.requestId) {
            throw new Error("Python returned an unexpected request ID.");
        }

        onResponse(response);

        if (request.type === "reset-note" && "error" in response) {
            throw new Error(`Could not reset note: ${response.error}`);
        }
    }
}
