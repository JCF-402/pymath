import type { PythonResponse } from './types';

// A stdout event can contain part of a response or several responses at once.
// This closure keeps unfinished text until the next chunk arrives.
export function createPythonResponseReceiver(onResponse: (response: PythonResponse) => void, onError: (error: unknown) => void,): (chunk: string) => void {
	let buffer = '';

	return (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) continue;

			let response: PythonResponse;
			try {
				// TypeScript types do not validate JSON, so check Python's output.
				const value: unknown = JSON.parse(line);

				if (typeof value !== "object" || value === null || !("requestId" in value)){
					throw new Error("Expected a Python response with a request ID. Internal error.")
				}
				
				const requestId = value.requestId;

				if ('result' in value && typeof value.result === "string" && typeof requestId === "string"){
					response = {
						result: value.result,
                        ...("image" in value && typeof value.image === "string" &&
                            value.image.startsWith("iVBORw0KGgo") && /^[A-Za-z0-9+/=]+$/.test(value.image)
                            ? { image: value.image } : {}),
                        ...("tag" in value && typeof value.tag === "string" ? { tag: value.tag } : {}),
						requestId
					}
				}
				else if ((typeof requestId === "string" || requestId === null) && 'error' in value && typeof value.error === 'string' ){
					response = {
						error: value.error,
						requestId
					};
				} else {
					throw new Error('Expected a string result or error.');
				}

			} catch (error) {
				onError(error);
				continue;
			}

			// Keep application logic separate from reading the stdout stream.
			onResponse(response);
		}
	};
}
