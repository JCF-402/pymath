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
            if (!section) continue;

            const block = blocks.find(candidate =>
                candidate.startLine === section.lineStart &&
                candidate.source.trim() === view.source.trim(),
            );

            // Require position and source to agree before updating a view.
            if (!block) continue;

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
