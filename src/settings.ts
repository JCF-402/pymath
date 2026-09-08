import { App, PluginSettingTab, Setting } from 'obsidian';
import MyPlugin from './main';

export interface MyPluginSettings {
	mySetting: string;
	showSubstitutionSteps: boolean;
	pythonPath: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	showSubstitutionSteps: false,
	pythonPath: 'python3',
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
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

		new Setting(containerEl)
			.setName('Show substitution steps')
			.setDesc('Show assignments with their formula, substituted values, and result. Applies when blocks render again.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.savedData.settings.showSubstitutionSteps)
					.onChange(async value => {
						this.plugin.savedData.settings.showSubstitutionSteps = value;
						await this.plugin.saveState();
					}),
			);

		new Setting(containerEl)
			.setName('Settings #1')
			.setDesc("It's a secret")
			.addText((text) =>
				text
					.setPlaceholder('Enter your secret')
					.setValue(this.plugin.savedData.settings.mySetting)
					.onChange(async (value) => {
						this.plugin.savedData.settings.mySetting = value;
						await this.plugin.saveState();
					}),
			);
	}
}
