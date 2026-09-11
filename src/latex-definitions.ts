export interface LatexDefinition { name: string; formula: string; notePath: string; line: number }
export interface MathRegion { from: number; to: number; content: string; closed: boolean }

// Mask non-math Markdown while preserving offsets into the original document.
export function mathRegions(text: string): MathRegion[] {
    let fence = '', frontmatter = /^(?:\uFEFF)?---\s*\r?\n/.test(text);
    const masked = text.split(/(?<=\n)/).map((line, index) => {
        let hide = false;
        if (frontmatter) { hide = true; if (index > 0 && /^(---|\.\.\.)\s*$/.test(line.trim())) frontmatter = false; }
        else if (fence) { hide = true; if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line.trimEnd())) fence = ''; }
        else { const match = /^ {0,3}(`{3,}|~{3,})/.exec(line); if (match) { fence = match[1]!; hide = true; } }
        return hide ? line.replace(/[^\n]/g, ' ') : line;
    }).join('').replace(/<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?(?:%%|$)|(`+)[^`]*?\1/g, value => value.replace(/[^\n]/g, ' '));
    const regions: MathRegion[] = [];
    const escaped = (index: number) => { let n = 0; while (index > 0 && masked[--index] === '\\') n++; return n % 2 === 1; };
    for (let i = 0; i < masked.length; i++) {
        if (masked[i] !== '$' || escaped(i)) continue;
        const delimiter = masked[i + 1] === '$' ? '$$' : '$';
        const from = i + delimiter.length;
        let end = from;
        while (end < masked.length && !(masked.startsWith(delimiter, end) && !escaped(end))) {
            if (delimiter === '$' && masked[end] === '\n') break;
            end++;
        }
        const closed = masked.startsWith(delimiter, end);
        regions.push({ from, to: end, content: text.slice(from, end), closed });
        i = end + (closed ? delimiter.length - 1 : -1);
    }
    return regions;
}

export function globalLatex(content: string): string | undefined {
    const match = /^\s*@global(?:\s+)([\s\S]*\S)\s*$/.exec(content);
    return match?.[1]?.trim();
}

export function extractLatexDefinitions(notePath: string, text: string): LatexDefinition[] {
    return mathRegions(text).flatMap(region => {
        const formula = region.closed ? globalLatex(region.content) : undefined;
        if (!formula) return [];
        const name = formula.split('=')[0]!.trim();
        if (!name || !formula.includes('=')) return [];
        return [{ name, formula, notePath, line: text.slice(0, region.from).split('\n').length }];
    });
}
