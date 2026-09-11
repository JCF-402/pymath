const identifier = String.raw`[\p{L}_][\p{L}\p{M}\p{N}_]*`;
// Bounded nesting keeps name matching compatible with JavaScript regular expressions.
let content = String.raw`[^{}\r\n]`;
for (let depth = 0; depth < 8; depth++) content = String.raw`(?:[^{}\r\n]|\{${content}*\})`;
export const mathName = String.raw`(?:${identifier}_\{${content}+\}|\{(?=[^\r\n]*\\)${content}+\}|${identifier})`;
export function splitParameters(text: string): string[] {
    const result: string[] = [];
    let start = 0, depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;
        if (text[i] === "," && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; }
    }
    result.push(text.slice(start).trim());
    return result;
}

export function latexNameCompletion(prefix: string): string | undefined {
    const starts = prefix.matchAll(/[\p{L}_][\p{L}\p{M}\p{N}_]*_\{|\{/gu);
    for (const match of starts) {
        const candidate = prefix.slice(match.index);
        let depth = 0, ended = false;
        for (let i = candidate.indexOf('{'); i < candidate.length; i++) {
            if (candidate[i] === '{' && candidate[i - 1] !== '\\') depth++;
            if (candidate[i] === '}' && candidate[i - 1] !== '\\') depth--;
            if (!depth && i < candidate.length - 1) { ended = true; break; }
        }
        if (!ended && (candidate.includes('_{') || candidate.includes('\\'))) return candidate;
    }
    return undefined;
}

export function latexNameSuffix(query: string, tail: string): string | undefined {
    if (!query.includes('{')) return undefined;
    let depth = 0;
    for (let i = 0; i < query.length; i++) {
        if (query[i - 1] === '\\') continue;
        if (query[i] === '{') depth++;
        if (query[i] === '}') depth--;
    }
    let end = 0;
    while (depth > 0 && end < tail.length) {
        if (tail[end - 1] !== '\\') {
            if (tail[end] === '{') depth++;
            if (tail[end] === '}') depth--;
        }
        end++;
    }
    return tail.slice(0, end);
}
