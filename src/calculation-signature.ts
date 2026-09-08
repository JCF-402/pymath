import { parseBlockLines } from "./parser";
import type { GlobalDefinition } from "./types";

export function blockSignature(source: string): string {
    try { return JSON.stringify(parseBlockLines(source)); }
    catch { return JSON.stringify({ invalid: source }); }
}

// Keep unresolved names too: adding a previously unknown global changes math.
// Conservative lexical references also cover calculator-style implicit products.
function names(source: string): string[] {
    const tokens = source.match(/[\p{L}_][\p{L}\p{M}\p{N}_]*/gu) ?? [];
    // SymPy can split an unknown name such as xy into x*y. Track both
    // interpretations so defining x later cannot leave a cached xy unchanged.
    return [...new Set(tokens.flatMap(token => [token, ...token]))];
}

export function globalSignature(sources: string[], globals: GlobalDefinition[], locations: boolean): string {
    const needed = new Set<string>();
    for (const source of sources) {
        try {
            for (const line of parseBlockLines(source)) {
                if (line.type === "invalid") continue;
                const parameters = line.type === "function" ? line.parameters : [];
                for (const name of names(line.expression)) if (!parameters.includes(name)) needed.add(name);
                if (line.type !== "expression" && line.scope === "global") {
                    needed.add(line.type === "assignment" ? line.variable : line.name);
                }
            }
        } catch { /* Invalid blocks do not send calculations. */ }
    }
    const selected = new Set<GlobalDefinition>();
    let changed = true;
    while (changed) {
        changed = false;
        for (const definition of globals) {
            const name = "error" in definition ? definition.name
                : definition.type === "assignment" ? definition.variable : definition.name;
            if (!name || !needed.has(name) || selected.has(definition)) continue;
            selected.add(definition);
            changed = true;
            if ("error" in definition) continue;
            const parameters = definition.type === "function" ? definition.parameters : [];
            for (const dependency of names(definition.expression)) {
                if (!parameters.includes(dependency)) needed.add(dependency);
            }
        }
    }
    return JSON.stringify([...selected].map(definition => {
        if (locations) return definition;
        const { notePath: _path, line: _line, ...calculation } = definition;
        return calculation;
    }).map(value => JSON.stringify(value)).sort());
}
