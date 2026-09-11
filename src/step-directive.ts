import { stripComment } from "./comments";

export function stepDirective(line: string): boolean | undefined {
    const match = /^@steps\s+(on|off)$/u.exec(stripComment(line).trim());
    return match ? match[1] === "on" : undefined;
}

// A directive applies to the whole block; the last one takes precedence.
export function blockSteps(source: string): boolean | undefined {
    let value: boolean | undefined;
    for (const line of source.split(/\r?\n/)) value = stepDirective(line) ?? value;
    return value;
}
