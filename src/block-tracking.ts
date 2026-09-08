import type { CachedMetadata } from "obsidian";
import type { Blocks, ParsedLine } from "./types";
import { scanPyMathBlocks, matchPyMathBlocks } from "./blocks";
import { parseBlock } from "./parser";

export function trackNoteBlocks(
    notePath: string,
    text: string,
    metadata: CachedMetadata,
    saved: Record<string, Blocks>,
) {
    // Missing metadata must not be treated as an empty note.
    if (!metadata.sections) return null;

    const scanned = scanPyMathBlocks(text, metadata);
    const matched = matchPyMathBlocks(notePath, scanned, saved);

    const blocks = { ...saved };
    const errors: Record<string, string> = {};

    for (const id of matched.removedIds) {
        delete blocks[id];
    }

    for (const block of matched.blocks) {
        let lines: ParsedLine[] = [];

        try {
            lines = parseBlock(block.source);
        } catch (error) {
            // Keep identity and source while an expression is incomplete.
            errors[block.id] =
                error instanceof Error ? error.message : String(error);
        }

        blocks[block.id] = {
            id: block.id,
            notePath,
            source: block.source,
            order: block.order,
            lines,
        };
    }

    return {
        blocks,
        errors,
        identifiedBlocks: matched.blocks,
        needsRebuild: matched.needsRebuild,
    };
}
