import { EditorSuggest, type App, type Editor, type EditorPosition, type EditorSuggestContext, type TFile } from 'obsidian';
import { extractLatexDefinitions, mathRegions, type LatexDefinition } from './latex-definitions';
import type { VaultGlobals } from './vault-globals';

export class LatexSuggest extends EditorSuggest<LatexDefinition> {
    constructor(app: App, private globals: VaultGlobals) { super(app); this.limit = 30; }
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null) {
        if (!file || editor.somethingSelected()) return null;
        const text = editor.getValue();
        const offset = editor.posToOffset(cursor);
        const region = mathRegions(text).find(item => item.from <= offset && offset <= item.to);
        if (!region || /^\s*@global\b/.test(region.content)) return null;
        const query = /[\\\p{L}\p{N}_{}]+$/u.exec(text.slice(region.from, offset))?.[0];
        if (!query) return null;
        return { start: editor.offsetToPos(offset - query.length), end: cursor, query };
    }
    async getSuggestions(context: EditorSuggestContext): Promise<LatexDefinition[]> {
        await this.globals.ready;
        const definitions = [...this.globals.getLatexDefinitions().filter(item => item.notePath !== context.file.path),
            ...extractLatexDefinitions(context.file.path, context.editor.getValue())];
        const normalized = (value: string) => value.replace(/[\\{}\s]/g, '').toLowerCase();
        return definitions.filter(item => normalized(item.name).includes(normalized(context.query))).slice(0, 30);
    }
    renderSuggestion(item: LatexDefinition, el: HTMLElement): void {
        el.createDiv({ text: item.name });
        el.createDiv({ cls: 'pymath-suggestion-detail', text: item.formula });
        el.createDiv({ cls: 'pymath-suggestion-detail', text: `${item.notePath}:${item.line}` });
    }
    selectSuggestion(item: LatexDefinition): void {
        const ctx = this.context;
        if (!ctx) return;
        const cursor = ctx.editor.getCursor();
        if (cursor.line !== ctx.end.line || cursor.ch !== ctx.end.ch || ctx.editor.getRange(ctx.start, ctx.end) !== ctx.query) return;
        const tail = /^[\\\p{L}\p{N}_{}]*/u.exec(ctx.editor.getLine(ctx.end.line).slice(ctx.end.ch))![0];
        const formula = item.formula.replace(/\r?\n/g, ' ');
        ctx.editor.replaceRange(formula, ctx.start, { line: ctx.end.line, ch: ctx.end.ch + tail.length });
        ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + formula.length });
        this.close();
    }
}
