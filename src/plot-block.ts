import { isPlotDirective, applyPlotOptions } from "./plot-options";
import { stripComment } from "./comments";
import { lineLabels } from "./line-labels";
import type { BlockLine, PlotLine } from "./types";

export function isPlotBlock(source: string): boolean {
    return source.split(/\r?\n/).some(line => isPlotDirective(stripComment(line)));
}

export function plotBlockLines(source: string, parse: (source: string) => BlockLine[]): BlockLine[] {
    const raw = source.split(/\r?\n/);
    const plots: { text: string; line: number; mode: "plot" | "parametric" | "polar" }[] = [], ranges: { text: string; line: number }[] = [];
    const options: { text: string; line: number }[] = [];
    const calculations = raw.map((line, index) => {
        const text = stripComment(line).trim();
        const curve = /^@(plot|parametric|polar)(?:\s|$)/u.exec(text);
        if (curve) { plots.push({ text: text.slice(curve[0].length).trim(), line: index + 1, mode: curve[1] as "plot" | "parametric" | "polar" }); return ""; }
        if (/^@range(?:\s|$)/u.test(text)) { ranges.push({ text: text.slice(6).trim(), line: index + 1 }); return ""; }
        if (isPlotDirective(text)) { options.push({ text, line: index + 1 }); return ""; }
        return line;
    });
    const plot: PlotLine = { type: "plot", expression: "", variable: "x", rangeStart: "", rangeEnd: "", sourceLine: plots[0]?.line ?? ranges[0]?.line ?? 1 };
    try {
        if (!plots.length || plots.length > 10) throw new Error("Use between one and ten @plot expressions per block.");
        if (new Set(plots.map(item => item.mode)).size !== 1) throw new Error("Use one plot kind per block: @plot, @parametric, or @polar.");
        if (plots[0]!.mode !== "plot") plot.mode = plots[0]!.mode;
        if (ranges.length !== 1) throw new Error("Use exactly one @range, such as @range x = -10, 10.");
        plot.curves = plots.map(item => {
            const labels = lineLabels(item.text);
            if (!labels.expression) throw new Error(`Line ${item.line}: Enter an expression after @plot.`);
            return { ...labels, sourceLine: item.line };
        });
        Object.assign(plot, plot.curves[0]);
        const range = /^([\p{L}_][\p{L}\p{M}\p{N}_]*)\s*=\s*([^,]+),\s*([^,]+)$/u.exec(ranges[0]!.text);
        if (!range) throw new Error(`Line ${ranges[0]!.line}: Use @range variable = minimum, maximum.`);
        plot.variable = range[1]!; plot.rangeStart = range[2]!.trim(); plot.rangeEnd = range[3]!.trim();
        applyPlotOptions(plot, options);
    } catch (error) {
        plot.error = error instanceof Error ? error.message : String(error);
    }
    // Preserve blank lines so definition errors retain their original positions.
    return [...parse(calculations.join("\n")), plot];
}
