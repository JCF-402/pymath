import {
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
	FileSystemAdapter,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';


import {spawn} from "node:child_process";
import * as path from "node:path";


export default class PyMath extends Plugin {
	settings!: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// For now spawn python process onload()
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("PyMath requires desktop Obsidian.");
		}

		const backendPath = path.join(
			adapter.getBasePath(),
			".obsidian",
			"plugins",
			this.manifest.id,
			"backend.py"
		);

		const python = spawn("python3",[backendPath])

		


		this.registerMarkdownCodeBlockProcessor("pymath", async (source: string, el: HTMLElement) => {

			python.stdout.on("data",(data) => {
			const response = JSON.parse(data.toString());
			console.log("Python returned:", response)
		});

		python.stderr.on("data",(data) => {
			console.error("Python error:", data.toString());
		});

		python.stdin.write(
			JSON.stringify({
				x:5
			}) + "\n"

		)
	})

		// Use this later to / add PyMath block to editor.
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-modal-complex',
			name: 'Open modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			},
		});

		// Use this later for PyMath settings
		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

	}

	// on unload the plugin must deactivate the running Python process.
	// Additional details
	onunload() {}


	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MyPluginSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
