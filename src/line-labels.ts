// Labels follow the expression, separated by whitespace. Either suffix order
// is accepted: expression [m/s] {Speed}, or expression {Speed} [m/s].
export function lineLabels(source: string): { expression: string; unit?: string; tag?: string } {
    let expression = source;
    let unit: string | undefined;
    let tag: string | undefined;
    for (let count = 0; count < 2; count++) {
        const match = /\s+(?:\[([\p{L}°µΩ][^[\]\r\n]*)\]|\{([^{}\r\n]*)\})$/u.exec(expression);
        if (!match) break;
        if (match[2]?.includes("\\")) break; // A LaTeX variable, not a trailing tag.
        const preceding = expression.slice(0, match.index).trimEnd();
        // Do not consume a set literal that is itself the expression.
        if (!preceding || /[=+*/^,(-]$/.test(preceding)) break;
        if (match[1] !== undefined) {
            if (unit !== undefined) break;
            unit = match[1].trim();
        } else {
            if (tag !== undefined) break;
            tag = match[2]!.trim();
            if (!tag) throw new Error("Enter a label inside the equation tag.");
        }
        expression = preceding;
    }
    return { expression, ...(unit !== undefined ? { unit } : {}), ...(tag !== undefined ? { tag } : {}) };
}
