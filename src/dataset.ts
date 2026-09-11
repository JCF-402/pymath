import { TFile, type App } from "obsidian";
import type { MathSuggestion } from "./autocomplete";

export interface DatasetSettings {
    datasetPath: string;
    datasetName: string;
    datasetValue: string;
    datasetDescription: string;
    datasetUnit: string;
}
export const datasetDefaults: DatasetSettings = {
    datasetPath: "", datasetName: "{El}_{A}_{Z}", datasetValue: "mass_u",
    datasetDescription: "{El}-{A}, Z={Z}, N={N}", datasetUnit: "u",
};

export function csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [], field = "", quoted = false, closed = false;
    const source = text.replace(/^\uFEFF/, "");
    for (let index = 0; index < source.length; index++) {
        const char = source[index]!;
        if (quoted) {
            if (char === '"') {
                if (source[index + 1] === '"') { field += '"'; index++; }
                else { quoted = false; closed = true; }
            } else field += char;
            continue;
        }
        if (char === ',' || char === '\n' || char === '\r') {
            row.push(field); field = ""; closed = false;
            if (char !== ',') {
                if (row.some(value => value.trim())) rows.push(row);
                row = [];
                if (char === '\r' && source[index + 1] === '\n') index++;
            }
        } else if (char === '"' && !field && !closed) quoted = true;
        else {
            if (closed || char === '"') throw new Error("Invalid CSV quoting.");
            field += char;
        }
    }
    if (quoted) throw new Error("Unclosed CSV quote.");
    row.push(field);
    if (row.some(value => value.trim())) rows.push(row);
    return rows;
}

export function datasetSuggestions(text: string, config: DatasetSettings): MathSuggestion[] {
    const [header, ...rows] = csvRows(text);
    if (!header) throw new Error("Dataset is empty.");
    const columns = header.map(value => value.trim());
    if (columns.some(value => !value) || new Set(columns).size !== columns.length) throw new Error("CSV headers must be unique and nonempty.");
    const valueColumn = columns.indexOf(config.datasetValue);
    if (valueColumn < 0) throw new Error(`Missing value column: ${config.datasetValue}`);
    for (const template of [config.datasetName, config.datasetDescription]) {
        for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
            if (!columns.includes(match[1]!)) throw new Error(`Missing template column: ${match[1]}`);
        }
    }
    return rows.map((row, index) => {
        if (row.length !== columns.length) throw new Error(`CSV row ${index + 2}: column count does not match header.`);
        const value = row[valueColumn]!.trim();
        // Keep the original digits; never round through JavaScript Number.
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new Error(`CSV row ${index + 2}: value must be a number.`);
        const expand = (template: string) => template.replace(/\{([^{}]+)\}/g, (_match, key: string) => row[columns.indexOf(key)]!.trim());
        const name = expand(config.datasetName).trim();
        if (!name) throw new Error(`CSV row ${index + 2}: empty name.`);
        return { name, scope: "dataset", unit: config.datasetUnit.trim() || undefined,
            insertText: config.datasetUnit.trim() ? `label(${value}, ${JSON.stringify(config.datasetUnit.trim())})` : value,
            description: [value + (config.datasetUnit ? ` ${config.datasetUnit}` : ""), expand(config.datasetDescription), config.datasetPath].filter(Boolean).join(" · ") };
    });
}

export class Dataset {
    items: MathSuggestion[] = [];
    ready: Promise<void> = Promise.resolve();
    private revision = 0;
    private closed = false;
    constructor(private app: App, private settings: () => DatasetSettings, private onError: (message: string) => void) {}
    reload(): Promise<void> {
        const revision = ++this.revision;
        this.items = [];
        const config = { ...this.settings() };
        this.ready = (async () => {
            if (this.closed || !config.datasetPath.trim()) return;
            try {
                const path = config.datasetPath.trim();
                if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new Error("Use a vault-relative CSV path.");
                const file = this.app.vault.getAbstractFileByPath(path);
                if (!(file instanceof TFile) || file.extension.toLowerCase() !== "csv") throw new Error(`CSV file not found: ${path}`);
                if (file.stat.size > 5 * 1024 * 1024) throw new Error("Dataset exceeds the 5 MB limit.");
                const items = datasetSuggestions(await this.app.vault.read(file), config);
                if (!this.closed && revision === this.revision) this.items = items;
            } catch (error) {
                if (!this.closed && revision === this.revision) this.onError(error instanceof Error ? error.message : String(error));
            }
        })();
        return this.ready;
    }
    invalidate(): void { this.revision++; this.items = []; }
    close(): void { this.closed = true; this.revision++; this.items = []; }
}
