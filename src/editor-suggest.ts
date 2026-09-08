import {
    EditorSuggest, type App, type Editor, type EditorPosition,
    type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile,
} from "obsidian";
import { completionQuery, mathSuggestions, type MathSuggestion } from "./autocomplete";
import { pymathLines } from "./pymath-lines";
import type { VaultGlobals } from "./vault-globals";

export class PyMathSuggest extends EditorSuggest<MathSuggestion> {
    private cachedText: string | undefined;
    private contentLines = new Set<number>();

    constructor(app: App, private globals: VaultGlobals) {
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
        return mathSuggestions(context.editor.getValue(), context.file.path,
            context.start.line, context.query, this.globals.getDefinitions());
    }

    renderSuggestion(item: MathSuggestion, el: HTMLElement): void {
        el.createDiv({ text: item.parameters ? `${item.name}(${item.parameters.join(", ")})` : item.name });
        el.createDiv({ cls: "pymath-suggestion-detail",
            text: item.scope === "global" ? `Global · ${item.notePath ?? ""}`
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
        editor.replaceRange(item.name + (addCall ? "()" : ""), start, replaceEnd);
        editor.setCursor({ line: start.line, ch: start.ch + item.name.length +
            (addCall ? (item.parameters!.length ? 1 : 2) : 0) });
        this.close();
    }
}
