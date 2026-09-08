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
    ): boolean {
        const lines = [...(results ?? [])].sort(([a], [b]) => a - b);
        const key = JSON.stringify([error ?? null, lines]);
        const previous = this.rendered.get(el);
        const nodes = Array.from(el.childNodes);

        if (previous?.key === key && previous.nodes.length === nodes.length &&
            nodes.every((node, index) => node === previous.nodes[index])) {
            return false;
        }

        if (error) {
            el.setText(`PyMath: ${error}`);
        } else {
            el.empty();
            for (const [, result] of lines) {
                const output = el.createDiv();
                if ("error" in result) {
                    output.setText(`PyMath: ${result.error}`);
                } else {
                    try {
                        output.appendChild(renderMath(result.result, true));
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
