import { datasetDefaults, type DatasetSettings } from "./dataset";
import { datasetSettings } from "./dataset-settings";
import { App, PluginSettingTab, Setting } from 'obsidian';
import PyMath from './main';

export interface PyMathSettings extends DatasetSettings {
	decimalPlaces: number | null;
	precision: number;
	numberFormat: "automatic" | "decimal" | "scientific";
	showSubstitutionSteps: boolean;
	showUnitsInSteps: boolean;
	pythonPath: string;
	pythonFallbackPath: string;
}

export const DEFAULT_SETTINGS: PyMathSettings = {
	...datasetDefaults,
	decimalPlaces: null,
	precision: 12,
	numberFormat: 'automatic',
	showSubstitutionSteps: false,
	showUnitsInSteps: false,
	pythonPath: 'python3',
	pythonFallbackPath: '',
};

export class PyMathSettingTab extends PluginSettingTab {
	plugin: PyMath;

	constructor(app: App, plugin: PyMath) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
        const pythonSection = containerEl.createDiv({ cls: "pymath-settings-section" });
        new Setting(pythonSection).setName("Python environment").setHeading();
        const displaySection = containerEl.createDiv({ cls: "pymath-settings-section" });
        new Setting(displaySection).setName("Calculation display").setHeading();
        datasetSettings(containerEl, this.plugin);

		new Setting(pythonSection)
			.setName('Python executable')
			.setDesc('Command or full path to Python with SymPy installed. Run Restart Python after changing it.')
			.addText(text =>
				text
					.setPlaceholder('python3')
					.setValue(this.plugin.savedData.settings.pythonPath)
					.onChange(async value => {
						this.plugin.savedData.settings.pythonPath =
							value.trim() || DEFAULT_SETTINGS.pythonPath;
						await this.plugin.saveState();
					}),
			);

		new Setting(pythonSection)
			.setName('Fallback Python executable')
			.setDesc('Optional second path or command for another environment or device. Tried if the primary cannot start the backend. Run Restart Python after changing it.')
			.addText(text => text.setValue(this.plugin.savedData.settings.pythonFallbackPath)
				.onChange(async value => {
					this.plugin.savedData.settings.pythonFallbackPath = value.trim();
					await this.plugin.saveState();
				}));

		new Setting(displaySection)
			.setName('Show substitution steps')
			.setDesc('Show assignments with their formula, substituted values, and result. Updates existing results immediately.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.savedData.settings.showSubstitutionSteps)
					.onChange(async value => {
						this.plugin.savedData.settings.showSubstitutionSteps = value;
						await this.plugin.saveState();
                        await this.plugin.noteRuntime?.refreshGlobals();
					}),
			);

        new Setting(displaySection)
            .setName('Show units in substitution steps')
            .setDesc('Include declared unit labels beside substituted values when substitution steps are enabled.')
            .addToggle(toggle => toggle.setValue(this.plugin.savedData.settings.showUnitsInSteps)
                .onChange(async value => {
                    this.plugin.savedData.settings.showUnitsInSteps = value;
                    await this.plugin.saveState();
                    await this.plugin.noteRuntime?.refreshGlobals();
                }));

		new Setting(displaySection)
			.setName('Precision')
			.setDesc('Significant digits in displayed results (2–30).')
			.addText(text => text.setValue(String(this.plugin.savedData.settings.precision))
				.onChange(async value => {
					const digits = Number(value);
					if (!Number.isInteger(digits) || digits < 2 || digits > 30) return;
					this.plugin.savedData.settings.precision = digits;
					await this.plugin.saveState();
					await this.plugin.noteRuntime?.refreshGlobals();
				}));
		new Setting(displaySection)
			.setName('Decimal places')
			.setDesc('Digits after the decimal point (0–20). Leave blank to use significant digits. Scientific format applies this to the mantissa.')
			.addText(text => text
				.setPlaceholder('Use significant digits')
				.setValue(this.plugin.savedData.settings.decimalPlaces === null ? '' : String(this.plugin.savedData.settings.decimalPlaces))
				.onChange(async value => {
					const places = value.trim() === '' ? null : Number(value);
					if (places !== null && (!Number.isInteger(places) || places < 0 || places > 20)) return;
					this.plugin.savedData.settings.decimalPlaces = places;
					await this.plugin.saveState();
					await this.plugin.noteRuntime?.refreshGlobals();
				}));
		new Setting(displaySection)
			.setName('Number format')
			.setDesc('Choose how numeric results are displayed.')
			.addDropdown(dropdown => dropdown
				.addOptions({ automatic: 'Automatic', decimal: 'Decimal', scientific: 'Scientific' })
				.setValue(this.plugin.savedData.settings.numberFormat)
				.onChange(async value => {
					if (value !== 'automatic' && value !== 'decimal' && value !== 'scientific') return;
					this.plugin.savedData.settings.numberFormat = value;
					await this.plugin.saveState();
					await this.plugin.noteRuntime?.refreshGlobals();
				}));

	}
}
