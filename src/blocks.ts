import type { CachedMetadata } from "obsidian";
import type { Blocks } from "./types";

export interface ScannedBlock {
    source: string;
    order: number;
    startLine: number;
}

export interface IdentifiedBlock extends ScannedBlock {
    id: string;
}

export interface BlockMatchResult {
    blocks: IdentifiedBlock[];
    removedIds: string[];
    needsRebuild: boolean;
}

export function matchPyMathBlocks(
    notePath: string,
    scanned: ScannedBlock[],
    saved: Record<string, Blocks>,
): BlockMatchResult {
    const previous = Object.values(saved).filter(
        block => block.notePath === notePath,
    );

    const previousBySource = new Map<string, Blocks[]>();
    const currentCounts = new Map<string, number>();

    for (const block of previous) {
        const matches = previousBySource.get(block.source) ?? [];
        matches.push(block);
        previousBySource.set(block.source, matches);
    }

    for (const block of scanned) {
        currentCounts.set(
            block.source,
            (currentCounts.get(block.source) ?? 0) + 1,
        );
    }

    const retainedIds = new Set<string>();
    let needsRebuild = false;

    const blocks = scanned.map(block => {
        const candidates = previousBySource.get(block.source) ?? [];

        // Reuse an ID only when the source identifies exactly
        // one block in both the previous and current note.
        const previousBlock =
            candidates.length === 1 &&
            currentCounts.get(block.source) === 1
                ? candidates[0]
                : undefined;

        if (previousBlock) {
            retainedIds.add(previousBlock.id);

            // Moving a block can change evaluation order.
            if (previousBlock.order !== block.order) {
                needsRebuild = true;
            }

            return {
                ...block,
                id: previousBlock.id,
            };
        }

        needsRebuild = true;

        return {
            ...block,
            id: crypto.randomUUID(),
        };
    });

    const removedIds = previous
        .filter(block => !retainedIds.has(block.id))
        .map(block => block.id);

    if (removedIds.length > 0) {
        needsRebuild = true;
    }

    return {
        blocks,
        removedIds,
        needsRebuild,
    };
}

export function scanPyMathBlocks(
    text: string,
    metadata: CachedMetadata,
): ScannedBlock[] {
    const lines = text.split(/\r?\n/);
    const blocks: ScannedBlock[] = [];

    const sections = (metadata.sections ?? [])
        .filter(section => section.type === "code")
        .sort((a, b) => a.position.start.line - b.position.start.line);

    for (const section of sections) {
        const startLine = section.position.start.line;
        const endLine = section.position.end.line;
        const openingLine = lines[startLine] ?? "";

        // Accept backtick or tilde fences with the pymath language.
        const opening = /^ {0,3}(`{3,}|~{3,})pymath\s*$/.exec(
            openingLine,
        );

        if (!opening) continue;

        const fence = opening[1]!;
        const fenceCharacter = fence[0]!;

        // A closing fence must use the same character and be
        // at least as long as the opening fence.
        const closingPattern = new RegExp(
            `^ {0,3}${fenceCharacter}{${fence.length},}[ \\t]*$`,
        );

        const hasClosingFence =
            endLine > startLine &&
            closingPattern.test(lines[endLine] ?? "");

        // Exclude the closing fence, but retain the last content
        // line if the user has not closed the block yet.
        const contentEnd = hasClosingFence ? endLine : endLine + 1;

        blocks.push({
            source: lines.slice(startLine + 1, contentEnd).join("\n"),
            order: blocks.length,
            startLine,
        });
    }

    return blocks;
}
