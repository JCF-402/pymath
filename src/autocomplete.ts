import { builtinSuggestions } from "./builtin-suggestions";
import { stripComment } from "./comments";
import { parseLine } from "./parser";
import { pymathLines } from "./pymath-lines";
import { extractGlobals } from "./vault-globals";
import type { GlobalDefinition } from "./types";

export interface MathSuggestion {
    name: string;
    parameters?: string[];
    scope: "local" | "global" | "parameter" | "builtin";
    description?: string;
    notePath?: string;
}

const name = String.raw`[\p{L}_][\p{L}\p{M}\p{N}_]*`;
const signature = new RegExp(`^\\s*(?:@global\\s+)?(${name})\\s*\\(([^()]*)\\)\\s*=(?!=)`, "u");

export function completionQuery(line: string, ch: number): string | null {
    const code = stripComment(line);
    if (ch > code.length) return null;
    const unitStart = /\s+\[[\p{L}°µΩ][^[\]]*\]?$/u.exec(code);
    if (unitStart && ch > unitStart.index + 1) return null;
    const prefix = code.slice(0, ch);
    // Do not offer mathematical names inside strings, comments or directives.
    if (/[#'"@]/.test(prefix.replace(/^\s*@global\s+/, ""))) return null;
    const match = /[\p{L}\p{M}\p{N}_]+$/u.exec(prefix);
    if (!match || !new RegExp(`^${name}$`, "u").test(match[0])) return null;
    const assignment = /^\s*(?:@global\s+)?[^=]+=(?!=)/u.exec(code);
    if (assignment && ch < assignment[0].length) return null;
    return match[0];
}

export function mathSuggestions(
    text: string, notePath: string, cursorLine: number, query: string,
    indexed: GlobalDefinition[],
): MathSuggestion[] {
    const lines = pymathLines(text);
    const current = lines.find(line => line.line === cursorLine);
    if (!current) return [];
    const candidates = new Map<string, MathSuggestion>(builtinSuggestions.map(item => [item.name, item]));
    // The current editor buffer replaces its saved global definitions.
    const globals = [...indexed.filter(item => item.notePath !== notePath), ...extractGlobals(notePath, text)];
    const counts = new Map<string, number>();
    for (const item of globals) {
        if ("error" in item) continue;
        const key = item.type === "assignment" ? item.variable : item.name;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        candidates.set(key, { name: key, scope: "global", notePath: item.notePath,
            ...(item.type === "function" ? { parameters: item.parameters } : {}) });
    }
    for (const [key, count] of counts) if (count > 1) candidates.delete(key);
    const globalContext = /^\s*@global\s/u.test(current.text);
    if (!globalContext) {
        for (const line of lines) {
            if (line.line >= cursorLine) break;
            try {
                const parsed = parseLine(line.text);
                if (parsed.type === "expression" || parsed.scope === "global") continue;
                const key = parsed.type === "assignment" ? parsed.variable : parsed.name;
                candidates.set(key, { name: key, scope: "local",
                    ...(parsed.type === "function" ? { parameters: parsed.parameters } : {}) });
            } catch { /* Incomplete edits must not disable other suggestions. */ }
        }
    }
    const match = signature.exec(current.text);
    if (match) {
        for (const parameter of match[2]!.split(",").map(value => value.trim())) {
            if (new RegExp(`^${name}$`, "u").test(parameter)) {
                candidates.set(parameter, { name: parameter, scope: "parameter" });
            }
        }
    }
    const priority = { parameter: 0, local: 1, global: 2, builtin: 3 };
    return [...candidates.values()].filter(item => item.name.startsWith(query))
        .sort((a, b) => priority[a.scope] - priority[b.scope] || a.name.localeCompare(b.name))
        .slice(0, 30);
}
