import { stripComment } from "./comments";

// Positions are one-based within the block, including comments and blank lines.
export function calculationLines(source: string): number[] {
    return source.split(/\r?\n/).flatMap((line, index) => stripComment(line).trim() ? [index + 1] : []);
}
