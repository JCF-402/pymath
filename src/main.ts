import {
	MarkdownView,
	Modal,
	Plugin,
	FileSystemAdapter,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';

import {PyMathData} from "./types"

import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import * as path from "node:path";


export default class PyMath extends Plugin {
	pythonProcess: ChildProcessWithoutNullStreams | null = null;
	savedData: PyMathData = {
		settings: DEFAULT_SETTINGS,
		blocks: {},
		variables: {}
	};

	async onload() {
		const data = await this.loadData() as Partial<PyMathData>;

		// savedData keeps track of information in between using Obsidian or turning the plugin on/off
		// Ideally it is updated everytime that a setting changes or
		// Everytime that a blocks information is changed. 
		// It is the source of truth
		this.savedData = {
			settings: {
				...DEFAULT_SETTINGS,
				...data.settings
			},
			blocks: data.blocks ?? {},
			variables: data.variables ?? {}
		};

		// For now spawn python process onload()
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("PyMath requires desktop Obsidian.");
		}
		// backend.py needs to be in the plugin directory
		const backendPath = path.join(
			adapter.getBasePath(),
			this.app.vault.configDir,
			"plugins",
			this.manifest.id,
			"backend.py"
		);

		this.pythonProcess = spawn("python3",[backendPath]);
		this.pythonProcess.stdout.setEncoding("utf8");

		this.pythonProcess.stdout.on("data",(data: string) => {
			const response = JSON.parse(data);
			console.log("Python returned:", response)
		});

		this.pythonProcess.stderr.on("data",(data: string) => {
			console.error("Python error:", data);
		});
		


		this.registerMarkdownCodeBlockProcessor("pymath", async (source: string, el: HTMLElement) => {


		this.pythonProcess?.stdin.write(
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
	onunload() {
		this.pythonProcess?.kill();
		this.pythonProcess = null;
	}

	async saveState() {
		await this.saveData(this.savedData);
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
