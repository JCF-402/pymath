import type { Blocks, ParsedLine } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value);
}

function isParsedLine(value: unknown): value is ParsedLine {
    if (!isRecord(value) || typeof value.expression !== "string") {
        return false;
    }

    if (value.scope !== undefined && value.scope !== "global") return false;

    switch (value.type) {
        case "expression":
            return value.scope === undefined;

        case "assignment":
            return typeof value.variable === "string" &&
                value.variable.length > 0;

        case "function":
            return typeof value.name === "string" &&
                value.name.length > 0 &&
                Array.isArray(value.parameters) &&
                value.parameters.every(
                    parameter =>
                        typeof parameter === "string" &&
                        parameter.length > 0,
                );

        default:
            return false;
    }
}

export function validateSavedBlocks(
    value: unknown,
): Record<string, Blocks> {
    const blocks: Record<string, Blocks> = {};

    if (!isRecord(value)) return blocks;

    for (const [id, entry] of Object.entries(value)) {
        if (!isRecord(entry)) continue;

        if (
            !id ||
            entry.id !== id ||
            typeof entry.notePath !== "string" ||
            !entry.notePath.trim() ||
            typeof entry.source !== "string" ||
            typeof entry.order !== "number" ||
            !Number.isInteger(entry.order) ||
            entry.order < 0 ||
            !Array.isArray(entry.lines) ||
            !entry.lines.every(isParsedLine)
        ) {
            continue;
        }

        // Copy only the fields our current block format uses.
        Object.defineProperty(blocks, id, {
            value: {
                id,
                notePath: entry.notePath,
                source: entry.source,
                order: entry.order,
                lines: entry.lines,
            },
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    return blocks;
}
