import { stepDirective } from "./step-directive";
import { stripComment } from "./comments";

// Positions are one-based within the block, including comments and blank lines.
export function calculationLines(source: string): number[] {
    return source.split(/\r?\n/).flatMap((line, index) => stripComment(line).trim() && stepDirective(line) === undefined ? [index + 1] : []);
}
