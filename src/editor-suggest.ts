import type { Dataset } from "./dataset";
import {
    EditorSuggest, renderMath, loadMathJax, type App, type Editor, type EditorPosition,
    type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile,
} from "obsidian";
import { completionQuery, mathSuggestions, type MathSuggestion } from "./autocomplete";
import { pymathLines } from "./pymath-lines";
import type { VaultGlobals } from "./vault-globals";

export class PyMathSuggest extends EditorSuggest<MathSuggestion> {
    private cachedText: string | undefined;
    private contentLines = new Set<number>();

    constructor(app: App, private globals: VaultGlobals, private dataset?: Dataset) {
        super(app);
        this.limit = 30;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
        if (!file || editor.somethingSelected()) return null;
        const query = completionQuery(editor.getLine(cursor.line), cursor.ch);
        if (!query) return null;
        const text = editor.getValue();
        if (text !== this.cachedText) {
            this.cachedText = text;
            this.contentLines = new Set(pymathLines(text).map(line => line.line));
        }
        if (!this.contentLines.has(cursor.line)) return null;
        return { start: { line: cursor.line, ch: cursor.ch - query.length }, end: cursor, query };
    }

    async getSuggestions(context: EditorSuggestContext): Promise<MathSuggestion[]> {
        await this.globals.ready;
        await this.dataset?.ready;
        const math = mathSuggestions(context.editor.getValue(), context.file.path,
            context.start.line, context.query, this.globals.getDefinitions());
        const rows = this.dataset?.items.filter(item => item.name.toLowerCase().startsWith(context.query.toLowerCase())).slice(0, 30) ?? [];
        if (rows.length) await loadMathJax();
        return [...math, ...rows].slice(0, 30);
    }

    renderSuggestion(item: MathSuggestion, el: HTMLElement): void {
        const isotope = item.scope === "dataset" ? /^([A-Za-z]+)_(\d+)_(\d+)$/.exec(item.name) : null;
        if (isotope) {
            const title = el.createDiv({ cls: "pymath-dataset-name" });
            try {
                title.appendChild(renderMath(`{}^{${isotope[2]}}_{${isotope[3]}}\\mathrm{${isotope[1]}}`, false));
            } catch {
                title.setText(item.name);
            }
        } else {
            el.createDiv({ text: item.parameters ? `${item.name}(${item.parameters.join(", ")})` : item.name });
        }
        if (item.tag) el.createDiv({ cls: "pymath-suggestion-detail", text: item.tag });
        el.createDiv({ cls: "pymath-suggestion-detail",
            text: item.scope === "dataset" ? item.description ?? "Dataset"
                : item.scope === "global" ? `Global · ${item.notePath ?? ""}`
                : item.scope === "builtin" ? `Built-in · ${item.description ?? ""}`
                : item.scope === "parameter" ? "Function parameter" : "Local · this note" });
    }

    selectSuggestion(item: MathSuggestion): void {
        const context = this.context;
        if (!context) return;
        const { editor, start, end, query } = context;
        const cursor = editor.getCursor();
        if (cursor.line !== end.line || cursor.ch !== end.ch || editor.getRange(start, end) !== query) return;
        // Replace the suffix too when completing in the middle of an identifier.
        const suffix = /^[\p{L}\p{M}\p{N}_]*/u.exec(editor.getLine(end.line).slice(end.ch))![0];
        const replaceEnd = { line: end.line, ch: end.ch + suffix.length };
        const hasCall = /^\s*\(/.test(editor.getLine(end.line).slice(replaceEnd.ch));
        const addCall = item.parameters !== undefined && !hasCall;
        const insertion = item.insertText ?? item.name;
        editor.replaceRange(insertion + (addCall ? "()" : ""), start, replaceEnd);
        editor.setCursor({ line: start.line, ch: start.ch + insertion.length +
            (addCall ? (item.parameters!.length ? 1 : 2) : 0) });
        this.close();
    }
}
