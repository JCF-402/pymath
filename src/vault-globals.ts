import { pymathLines } from "./pymath-lines";
import type { App } from "obsidian";
import { parseLine } from "./parser";
import type { GlobalDefinition } from "./types";

// Scan root-level fences directly so a closed note does not need a warm
// metadata cache. Non-PyMath fences and frontmatter are skipped as units.
export function extractGlobals(notePath: string, text: string): GlobalDefinition[] {
    const definitions: GlobalDefinition[] = [];
    for (const { text: line, line: index } of pymathLines(text)) {
        if (!/^\s*@global(?:\s|$)/u.test(line)) continue;
        try {
            const parsed = parseLine(line);
            if (parsed.type !== "expression") {
                definitions.push({ ...parsed, notePath, line: index + 1 });
            }
        } catch (error) {
            definitions.push({
                notePath, line: index + 1,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return definitions;
}

export class VaultGlobals {
    private byNote = new Map<string, GlobalDefinition[]>();
    private revisions = new Map<string, number>();
    private definitions: GlobalDefinition[] = [];
    private signature = "[]";
    private closed = false;
    private timer: number | undefined;
    readonly ready: Promise<void>;

    constructor(private app: App, private onChange: () => Promise<void>) {
        this.ready = this.initialize();
    }

    getDefinitions(): GlobalDefinition[] { return this.definitions; }

    revision(path: string): number | undefined { return this.revisions.get(path); }

    update(notePath: string, text: string): void {
        if (this.closed) return;
        this.touch(notePath);
        this.byNote.set(notePath, extractGlobals(notePath, text));
        this.publish();
    }

    removePath(path: string): void {
        for (const notePath of new Set([...this.byNote.keys(), ...this.revisions.keys()])) {
            if (notePath === path || notePath.startsWith(`${path}/`)) {
                this.touch(notePath);
                this.byNote.delete(notePath);
            }
        }
        this.publish();
    }

    renamePath(oldPath: string, newPath: string): void {
        for (const notePath of new Set([...this.byNote.keys(), ...this.revisions.keys()])) {
            if (notePath !== oldPath && !notePath.startsWith(`${oldPath}/`)) continue;
            const destination = newPath + notePath.slice(oldPath.length);
            const entries = this.byNote.get(notePath);
            this.touch(notePath);
            this.touch(destination);
            this.byNote.delete(notePath);
            if (entries && destination.toLowerCase().endsWith(".md")) {
                this.byNote.set(destination, entries.map(entry => ({ ...entry, notePath: destination })));
            }
        }
        this.publish();
        // Also cover notes whose initial read was interrupted by the rename.
        void this.readMissing().catch(error => console.error("PyMath global index failed:", error));
    }

    close(): void {
        this.closed = true;
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.byNote.clear();
    }

    private touch(path: string): void {
        this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
    }

    private async initialize(): Promise<void> {
        await this.readMissing();
    }

    private async readMissing(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles().filter(file => !this.byNote.has(file.path));
        // Register every path before awaiting reads so deletes invalidate queued reads too.
        const pending = files.map(file => {
            if (!this.revisions.has(file.path)) this.revisions.set(file.path, 0);
            return { file, path: file.path, revision: this.revisions.get(file.path) };
        });
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
            while (!this.closed) {
                const entry = pending[cursor++];
                if (!entry) return;
                const { file, path, revision } = entry;
                if (this.revisions.get(path) !== revision || file.path !== path) continue;
                let definitions: GlobalDefinition[];
                try {
                    definitions = extractGlobals(path, await this.app.vault.read(file));
                } catch (error) {
                    definitions = [{ notePath: path, line: 1, error: `Could not read global definitions: ${String(error)}` }];
                }
                if (this.closed || this.revisions.get(path) !== revision || file.path !== path) continue;
                this.byNote.set(path, definitions);
            }
        }));
        if (!this.closed) this.publish();
    }

    private publish(): void {
        if (this.closed) return;
        const next = [...this.byNote.entries()].sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, definitions]) => definitions);
        const signature = JSON.stringify(next);
        if (signature === this.signature) return;
        this.signature = signature;
        this.definitions = next;
        if (this.timer !== undefined) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
            this.timer = undefined;
            void this.ready.then(async () => {
                if (!this.closed) await this.onChange();
            }).catch(error => console.error("PyMath global refresh failed:", error));
        }, 150);
    }
}
