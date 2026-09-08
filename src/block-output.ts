import { renderMath } from "obsidian";
import type { LineResult } from "./types";

interface RenderedOutput {
    key: string;
    nodes: ChildNode[];
}

// Avoid replacing MathJax DOM when the displayed output has not changed.
export class BlockOutput {
    private rendered = new WeakMap<HTMLElement, RenderedOutput>();

    render(
        el: HTMLElement,
        error: string | undefined,
        results: Map<number, LineResult> | undefined,
        plotMode = false,
        downloadName = "pymath-plot.png",
    ): boolean {
        const lines = [...(results ?? [])].sort(([a], [b]) => a - b);
        const key = JSON.stringify([error ?? null, lines, plotMode, downloadName]);
        const previous = this.rendered.get(el);
        const nodes = Array.from(el.childNodes);

        if (previous?.key === key && previous.nodes.length === nodes.length &&
            nodes.every((node, index) => node === previous.nodes[index])) {
            return false;
        }

        if (error) {
            el.setText(`PyMath: ${error}`);
        } else if (plotMode) {
            el.empty();
            const failure = lines.map(([, result]) => result).find(result => "error" in result);
            const chart = lines.map(([, result]) => result).find(result => "image" in result && result.image);
            if (failure && "error" in failure) el.setText(`PyMath: ${failure.error}`);
            else if (chart && "image" in chart && chart.image) {
                const url = `data:image/png;base64,${chart.image}`;
                el.createEl("img", { cls: "pymath-plot", attr: {
                    src: url, alt: "PyMath function plot",
                } });
                el.createDiv({ cls: "pymath-plot-actions" }).createEl("a", {
                    cls: "pymath-plot-download",
                    text: "Save PNG",
                    attr: { href: url, download: downloadName, "aria-label": "Save plot as PNG" },
                });
            }
        } else {
            el.empty();
            for (const [, result] of lines) {
                const output = el.createDiv({ cls: "pymath-result" });
                if ("error" in result) {
                    output.setText(`PyMath: ${result.error}`);
                } else {
                    try {
                        if (result.tag) {
                            const row = output.createDiv({ cls: "pymath-tagged-equation" });
                            const equation = row.createDiv({ cls: "pymath-equation-body" });
                            equation.appendChild(renderMath(result.result, true));
                            row.createDiv({ cls: "pymath-equation-tag" }).setText(`(${result.tag})`);
                        } else {
                            output.createDiv({ cls: "pymath-equation-body" }).appendChild(renderMath(result.result, true));
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        output.setText(`PyMath: ${message}`);
                    }
                }
            }
        }

        this.rendered.set(el, { key, nodes: Array.from(el.childNodes) });
        return true;
    }
}
