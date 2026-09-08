import { isPlotDirective } from "./plot-options";
import { calculationLines } from "./source-lines";
import type { Blocks, BlockLine, GlobalDefinition } from "./types";

type ResetRequest = {
    type: "reset-note";
    globals?: GlobalDefinition[];
    requestId: string;
    notePath: string;
};

type EvaluationRequest = BlockLine & {
    requestId: string;
    notePath: string;
    blockId: string;
    lineIndex: number;
    sourceLine: number;
    showSubstitutionSteps: boolean;
};

export type RebuildRequest = ResetRequest | EvaluationRequest;

export function createNoteRebuild(
    notePath: string,
    blocks: Record<string, Blocks>,
    showSubstitutionSteps: boolean,
    globals?: GlobalDefinition[],
    display?: { precision: number; numberFormat: string; decimalPlaces?: number | null },
): RebuildRequest[] {
    const requests: RebuildRequest[] = [
        {
            type: "reset-note",
            ...(globals ? { globals } : {}),
            requestId: crypto.randomUUID(),
            notePath,
        },
    ];

    const noteBlocks = Object.values(blocks)
        .filter(block => block.notePath === notePath)
        .sort((a, b) => a.order - b.order);

    for (const block of noteBlocks) {
        const sourceLines = calculationLines(block.source).filter(line => !isPlotDirective(block.source.split(/\r?\n/)[line - 1]!));
        for (const [lineIndex, parsed] of block.lines.entries()) {
            requests.push({
                ...parsed,
                ...display,
                requestId: crypto.randomUUID(),
                notePath,
                blockId: block.id,
                lineIndex,
                sourceLine: parsed.type === "plot" ? parsed.sourceLine : sourceLines[lineIndex] ?? lineIndex + 1,
                showSubstitutionSteps,
            });
        }
    }

    return requests;
}
