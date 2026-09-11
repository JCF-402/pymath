// Keep each right-hand side intact; CSS wraps whole steps at the available width.
export function equationSteps(source: string): string[] {
    const parts: string[] = [];
    let depth = 0, delimiters = 0, start = 0;
    for (let i = 0; i < source.length; i++) {
        if (source.slice(i, i + 5) === "\\left") delimiters++;
        if (source.slice(i, i + 6) === "\\right") delimiters--;
        if (source[i] === "{" && source[i - 1] !== "\\") depth++;
        if (source[i] === "}" && source[i - 1] !== "\\") depth--;
        if (depth === 0 && delimiters === 0 && source.slice(i, i + 3) === " = ") {
            parts.push(source.slice(start, i));
            start = i + 1;
            i += 2;
        }
    }
    parts.push(source.slice(start));
    return parts;
}
