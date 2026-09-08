import { Setting } from "obsidian";
import type PyMath from "./main";
import type { DatasetSettings } from "./dataset";

export function datasetSettings(container: HTMLElement, plugin: PyMath): void {
    const section = container.createDiv({ cls: "pymath-dataset-settings" });
    new Setting(section).setName("CSV datasets").setHeading();
    const fields: [keyof DatasetSettings, string, string][] = [
        ['datasetPath', 'Dataset CSV path', 'Vault-relative path, for example Data/isotopes.csv. Run Reload datasets after changing these settings.'],
        ['datasetName', 'Dataset name template', 'Searchable row name, for example {El}_{A}_{Z}.'],
        ['datasetValue', 'Dataset value column', 'Numeric column to insert, for example mass_u.'],
        ['datasetDescription', 'Dataset description template', 'Extra information shown in autocomplete. Use {column} placeholders.'],
        ['datasetUnit', 'Dataset display unit', 'Shown in suggestions only; the inserted value has no unit label.'],
    ];
    for (const [key, name, description] of fields) {
        new Setting(section).setName(name).setDesc(description).addText(input => input
            .setValue(plugin.savedData.settings[key]).onChange(async value => {
                plugin.savedData.settings[key] = value.trim();
                plugin.dataset?.invalidate();
                await plugin.saveState();
            }));
    }
}
