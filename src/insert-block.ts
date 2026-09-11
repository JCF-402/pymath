import type { Editor } from "obsidian";

export function insertPyMathBlock(editor: Editor): void {
    const start = editor.getCursor("from");
    const end = editor.getCursor("to");
    const before = editor.getLine(start.line).slice(0, start.ch);
    const after = editor.getLine(end.line).slice(end.ch);
    const prefix = before.length ? "\n" : "";
    const suffix = after.length ? "\n" : "";
    const selected = editor.getSelection();
    editor.replaceRange(`${prefix}\`\`\`pymath\n${selected}\n\`\`\`${suffix}`, start, end);
    editor.setCursor({ line: start.line + (prefix ? 2 : 1), ch: 0 });
}
