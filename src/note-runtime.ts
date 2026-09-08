import {
    TFile, loadMathJax, finishRenderMath,
    type App, type CachedMetadata, type MarkdownPostProcessorContext,
} from "obsidian";
import type { Blocks, GlobalDefinition } from "./types";
import { scanPyMathBlocks, type IdentifiedBlock } from "./blocks";
import type { PythonTransport } from "./python-transport";
import { BlockViews } from "./block-views";
import { trackNoteBlocks } from "./block-tracking";
import { createNoteRebuild } from "./note-rebuild";
import { RebuildCoordinator } from "./rebuild-coordinator";
import { BlockOutput } from "./block-output";

interface RuntimeState {
    getGlobals?: () => GlobalDefinition[];
    getBlocks: () => Record<string, Blocks>;
    setBlocks: (blocks: Record<string, Blocks>) => void;
    showSubstitutionSteps: () => boolean;
}

interface NoteSnapshot {
    globals: GlobalDefinition[] | undefined;
    text: string;
    metadata: CachedMetadata;
    blocks: IdentifiedBlock[];
    errors: Record<string, string>;
    showSubstitutionSteps: boolean;
    status: "pending" | "ready" | "failed";
    error?: string;
    work?: Promise<void>;
}

export class NoteRuntime {
    private coordinator: RebuildCoordinator;
    private blockViews = new BlockViews();
    private blockOutput = new BlockOutput();
    private notes = new Map<string, NoteSnapshot>();
    private initializations = new Map<string, Promise<void>>();
    private revisions = new Map<string, number>();
    private mathReady: Promise<void> | undefined;
    private closed = false;

    constructor(
        private app: App,
        transport: PythonTransport,
        private state: RuntimeState,
    ) {
        this.coordinator = new RebuildCoordinator(request => transport.send(request));
    }

    async registerBlock(
        source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext,
    ): Promise<void> {
        if (this.closed) return;
        this.blockViews.register(ctx.sourcePath, source, el, ctx);

        // Cached results normally render before this delay. Never replace
        // existing output with a loading message during a background rebuild.
        const loadingTimer = window.setTimeout(() => {
            if (!this.closed && !el.hasChildNodes()) el.setText("Calculating…");
        }, 150);

        try {
            await this.ensureNoteReady(ctx.sourcePath);
            if (this.closed) return;
            if (!this.notes.has(ctx.sourcePath)) {
                el.setText("Waiting for note metadata…");
                return;
            }
            await this.refreshNoteViews(ctx.sourcePath);
        } catch (error) {
            if (!this.closed) el.setText(`PyMath: ${this.message(error)}`);
        } finally {
            window.clearTimeout(loadingTimer);
        }
    }

    updateNote(notePath: string, text: string, metadata: CachedMetadata): Promise<void> {
        if (this.closed) return Promise.resolve();
        this.revisions.set(notePath, (this.revisions.get(notePath) ?? 0) + 1);

        // An actually empty file has no definitions even if sections are absent.
        // Otherwise, absent section metadata is not evidence of deletion.
        const cache = !text.trim() ? { ...metadata, sections: [] } : metadata;
        if (!cache.sections) return Promise.resolve();

        const previous = this.notes.get(notePath);
        const showSteps = this.state.showSubstitutionSteps();
        const scanned = scanPyMathBlocks(text, cache);
        const calculationsUnchanged = previous !== undefined &&
            previous.showSubstitutionSteps === showSteps &&
            previous.globals === this.state.getGlobals?.() &&
            previous.blocks.length === scanned.length &&
            previous.blocks.every((block, index) => block.source === scanned[index]?.source);
        if (calculationsUnchanged) {
            // Prose edits can move blocks without changing their calculations.
            previous.text = text;
            previous.metadata = cache;
            previous.blocks = scanned.map((block, index) => ({
                ...block, id: previous.blocks[index]!.id,
            }));
            return (previous.work ?? Promise.resolve()).then(() => this.refreshNoteViews(notePath));
        }

        const saved = this.state.getBlocks();
        const update = trackNoteBlocks(notePath, text, cache, saved);
        if (!update) return Promise.resolve();
        if (!previous && update.identifiedBlocks.length === 0 &&
            !Object.values(saved).some(block => block.notePath === notePath)) {
            return Promise.resolve();
        }

        this.state.setBlocks(update.blocks);
        const snapshot: NoteSnapshot = {
            text, metadata: cache, blocks: update.identifiedBlocks,
            globals: this.state.getGlobals?.(),
            errors: update.errors, showSubstitutionSteps: showSteps, status: "pending",
        };
        this.notes.set(notePath, snapshot);

        // Build a complete replacement batch before resetting Python state.
        const requests = createNoteRebuild(notePath, update.blocks, showSteps, snapshot.globals);
        snapshot.work = this.coordinator.rebuild(notePath, requests)
            .then(async completed => {
                if (!completed || this.closed || this.notes.get(notePath) !== snapshot) return;
                snapshot.status = "ready";
                await this.refreshNoteViews(notePath);
            })
            .catch(error => {
                if (this.closed || this.notes.get(notePath) !== snapshot) return;
                snapshot.status = "failed";
                snapshot.error = this.message(error);
                this.blockViews.setNoteMessage(notePath, `PyMath: ${snapshot.error}`);
            });
        return snapshot.work;
    }

    private async ensureNoteReady(notePath: string): Promise<void> {
        if (this.closed) return;
        const snapshot = this.notes.get(notePath);
        if (snapshot) {
            // A new render also picks up a changed display setting.
            if (snapshot.showSubstitutionSteps !== this.state.showSubstitutionSteps() ||
                snapshot.globals !== this.state.getGlobals?.()) {
                await this.updateNote(notePath, snapshot.text, snapshot.metadata);
            } else {
                await snapshot.work;
            }
            return;
        }

        const existing = this.initializations.get(notePath);
        if (existing) return existing;
        const initialization = this.initializeNote(notePath);
        this.initializations.set(notePath, initialization);
        try {
            await initialization;
        } finally {
            if (this.initializations.get(notePath) === initialization) {
                this.initializations.delete(notePath);
            }
        }
    }

    private async initializeNote(notePath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) throw new Error("The source note could not be found.");
        const revision = this.revisions.get(notePath) ?? 0;
        const modified = file.stat.mtime;
        const size = file.stat.size;
        const metadata = this.app.metadataCache.getFileCache(file);
        if (!metadata) return;

        const text = await this.app.vault.read(file);
        if (this.closed || file.path !== notePath || file.stat.mtime !== modified ||
            file.stat.size !== size || this.app.metadataCache.getFileCache(file) !== metadata ||
            (this.revisions.get(notePath) ?? 0) !== revision) return;

        await this.updateNote(notePath, text, metadata);
    }

    private async refreshNoteViews(notePath: string): Promise<void> {
        const snapshot = this.notes.get(notePath);
        if (!snapshot || this.closed) return;
        if (snapshot.status !== "ready") {
            if (snapshot.error) {
                this.blockViews.setNoteMessage(notePath, `PyMath: ${snapshot.error}`);
            }
            return;
        }

        this.mathReady ??= loadMathJax();
        await this.mathReady;
        if (this.closed || this.notes.get(notePath) !== snapshot) return;

        let changed = false;
        this.blockViews.updateNote(notePath, snapshot.blocks, (blockId, el) => {
            const rendered = this.blockOutput.render(
                el, snapshot.errors[blockId], this.coordinator.results.results.get(blockId),
            );
            changed = rendered || changed;
        });
        if (changed) await finishRenderMath();
    }

    async removeNote(notePath: string): Promise<void> {
        if (this.closed) return;

        // Invalidate reads that started before the deletion or rename.
        const revision = (this.revisions.get(notePath) ?? 0) + 1;
        this.revisions.set(notePath, revision);
        this.notes.delete(notePath);
        this.initializations.delete(notePath);
        this.blockViews.clearNote(notePath);

        const blocks = { ...this.state.getBlocks() };
        for (const [id, block] of Object.entries(blocks)) {
            if (block.notePath === notePath) delete blocks[id];
        }
        this.state.setBlocks(blocks);

        // Cancel older work and clear Python state through the same queue.
        const completed = await this.coordinator.rebuild(
            notePath,
            createNoteRebuild(notePath, {}, false),
        );

        // A new note may already exist at the same path.
        if (completed && !this.closed && this.revisions.get(notePath) === revision) {
            this.coordinator.results.clearNote(notePath);
        }
    }

    async renameNote(oldPath: string, newPath: string): Promise<void> {
        await this.removeNote(oldPath);
        if (this.closed) return;

        const file = this.app.vault.getAbstractFileByPath(newPath);
        // It may have moved or been deleted again while cleanup ran.
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;

        await this.ensureNoteReady(newPath);
        await this.refreshNoteViews(newPath);
    }

    private trackedNotesUnder(path: string): string[] {
        const paths = new Set([
            ...this.notes.keys(),
            ...this.initializations.keys(),
            ...Object.values(this.state.getBlocks()).map(block => block.notePath),
        ]);
        return [...paths].filter(notePath =>
            notePath === path || notePath.startsWith(`${path}/`),
        );
    }

    async removePath(path: string): Promise<void> {
        if (this.closed) return;
        const notes = this.trackedNotesUnder(path);

        // Invalidate every affected note now; Python resets remain serialized.
        await Promise.all(notes.map(notePath => this.removeNote(notePath)));
    }

    async renamePath(oldPath: string, newPath: string): Promise<void> {
        if (this.closed) return;
        const notes = this.trackedNotesUnder(oldPath);
        await Promise.all(notes.map(notePath => {
            const suffix = notePath.slice(oldPath.length);
            return this.renameNote(notePath, `${newPath}${suffix}`);
        }));
    }

    async refreshGlobals(): Promise<void> {
        if (this.closed) return;
        await Promise.all([...this.notes.entries()].map(([path, snapshot]) =>
            this.updateNote(path, snapshot.text, snapshot.metadata),
        ));
    }

    async restart(transport: PythonTransport): Promise<void> {
        if (this.closed) return;
        const snapshots = [...this.notes.entries()];
        const initializing = [...this.initializations.keys()];
        this.coordinator.close();
        this.coordinator = new RebuildCoordinator(request => transport.send(request));

        // Old reads and completions must not publish into the new session.
        for (const path of new Set([...this.revisions.keys(), ...initializing])) {
            this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
        }
        this.notes.clear();
        this.initializations.clear();

        // Keep visible views registered while their Python state is rebuilt.
        const rebuilding = snapshots.map(([path, snapshot]) =>
            this.updateNote(path, snapshot.text, snapshot.metadata),
        );
        // Notes still being read have no snapshot to replay yet.
        const reading = initializing.filter(path => !this.notes.has(path))
            .map(path => this.ensureNoteReady(path));
        await Promise.all([...rebuilding, ...reading]);
    }

    close(): void {
        this.closed = true;
        this.coordinator.close();
        this.blockViews.clear();
        this.notes.clear();
        this.initializations.clear();
        this.revisions.clear();
    }

    private message(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
