import { mathName } from "./math-names";
import type { ParsedLine } from "./types";

export const symbolAssumptions = [
    "real", "positive", "negative", "nonnegative", "nonpositive",
    "nonzero", "integer", "rational", "complex", "finite", "even", "odd",
];

export function symbolDeclaration(text: string): ParsedLine | null {
    if (!/^@symbol(?:\s|$)/u.test(text)) return null;
    const match = new RegExp(`^@symbol\\s+(${mathName})(?:\\s+(.*))?$`, "u").exec(text);
    if (!match) throw new Error("Use @symbol name, optionally followed by assumptions.");
    const assumptions = match[2]?.split(/[\s,]+/u).filter(Boolean) ?? [];
    for (const assumption of assumptions) {
        if (!symbolAssumptions.includes(assumption)) throw new Error(`Unknown assumption '${assumption}'. Use ${symbolAssumptions.join(", ")}.`);
    }
    if (new Set(assumptions).size !== assumptions.length) throw new Error("Do not repeat an assumption.");
    return { type: "assignment", variable: match[1]!, expression: "", assumptions };
}
