import { registerPlotMenu } from "./plot-menu";
import {
    MarkdownRenderChild,
    type MarkdownPostProcessorContext,
} from "obsidian";

import type { IdentifiedBlock } from "./blocks";

interface BlockView {
    notePath: string;
    source: string;
    el: HTMLElement;
    ctx: MarkdownPostProcessorContext;
}

export class BlockViews {
    private views = new Set<BlockView>();

    register(
        notePath: string,
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext,
    ): void {
        const view: BlockView = { notePath, source, el, ctx };
        this.views.add(view);

        // Remove the reference when Obsidian replaces or closes this view.
        const child = new MarkdownRenderChild(el);
        registerPlotMenu(el, child);

        child.register(() => {
            this.views.delete(view);
        });

        ctx.addChild(child);
    }

    updateNote(
        notePath: string,
        blocks: IdentifiedBlock[],
        render: (blockId: string, el: HTMLElement) => void,
    ): void {
        for (const view of this.views) {
            if (view.notePath !== notePath) continue;

            // Read the current position: edits above can move the block.
            const section = view.ctx.getSectionInfo(view.el);
            const matches = blocks.filter(candidate => candidate.source.trim() === view.source.trim());
            // Export renderers may not expose section positions. Keep identical
            // sources distinct by their occurrence within this render document.
            const peers = [...this.views].filter(candidate =>
                candidate.notePath === notePath && candidate.ctx.docId === view.ctx.docId &&
                candidate.source.trim() === view.source.trim());
            const block = section
                ? matches.find(candidate => candidate.startLine === section.lineStart)
                : matches.length === 1 ? matches[0]
                : view.ctx.docId ? matches[peers.indexOf(view)] : undefined;

            // When a position exists, never replace it with a source-only guess.
            if (!block) {
                if (!section) view.el.setText("PyMath: Could not locate this block in the source note.");
                continue;
            }

            render(block.id, view.el);
        }
    }

    setNoteMessage(notePath: string, message: string): void {
        for (const view of this.views) {
            if (view.notePath === notePath) view.el.setText(message);
        }
    }

    clearNote(notePath: string): void {
        for (const view of this.views) {
            if (view.notePath === notePath) this.views.delete(view);
        }
    }

    clear(): void {
        this.views.clear();
    }
}
