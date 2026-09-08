// Root-level PyMath content, excluding frontmatter, comments and other fences.
export function pymathLines(text: string): { text: string; line: number }[] {
    const result: { text: string; line: number }[] = [];
    const lines = text.split(/\r?\n/);
    let fence: string | undefined;
    let pymath = false;
    let comment = false;
    let frontmatter = lines[0]?.trim() === "---";
    for (const [index, line] of lines.entries()) {
        if (frontmatter) {
            if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
            continue;
        }
        if (!fence) {
            if (comment) {
                if (line.includes("-->")) comment = false;
                continue;
            }
            const commentStart = line.indexOf("<!--");
            if (commentStart >= 0) {
                comment = !line.includes("-->", commentStart + 4);
                continue;
            }
            const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
            if (!opening) continue;
            fence = opening[1]!;
            pymath = opening[2]!.trim() === "pymath";
            continue;
        }
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) {
            fence = undefined;
            pymath = false;
            continue;
        }
        if (pymath) result.push({ text: line, line: index });
    }
    return result;
}
