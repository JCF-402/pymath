import {MarkdownView,Modal,Plugin,FileSystemAdapter, loadMathJax, renderMath, finishRenderMath} from 'obsidian';
import {DEFAULT_SETTINGS,MyPluginSettings,SampleSettingTab,} from './settings';

import {PyMathData, PythonResponse} from "./types"
import { createPythonResponseReceiver } from './python-response';
import { parseBlock} from './parser';

import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import * as path from "node:path";
import { json } from 'node:stream/consumers';
import { error } from 'node:console';


export default class PyMath extends Plugin {
	pythonProcess: ChildProcessWithoutNullStreams | null = null;
	savedData: PyMathData = {
		settings: DEFAULT_SETTINGS,
		blocks: {},
		variables: {},
		functions: {}
	};
	pendingBlocks = new Map<string, HTMLElement>();

	async onload() {
		const data = await this.loadData() as Partial<PyMathData> | null;

		// savedData keeps track of information in between using Obsidian or turning the plugin on/off
		// Ideally it is updated everytime that a setting changes or
		// Everytime that a blocks information is changed. 
		// It is the source of truth
		// The first time this plugin loads it will be empty/null
		this.savedData = {
			settings: {
				...DEFAULT_SETTINGS,
				...data?.settings
			},
			blocks: data?.blocks ?? {},
			variables: data?.variables ?? {},
			functions: data?.functions ?? {},
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
		const pythonPath = "/Users/jomarcardona/miniforge/envs/python-general/bin/python";
		this.pythonProcess = spawn(pythonPath,[backendPath]);
		this.pythonProcess.stdout.setEncoding("utf8");
		this.pythonProcess.stderr.setEncoding("utf8");

		const receiveResponse = createPythonResponseReceiver(
			(response) => this.handlePythonResponse(response),
			(error) => console.error('Invalid Python response:', error),
		);
		const stdout = this.pythonProcess.stdout;
		stdout.on('data', receiveResponse);
		this.register(() => stdout.off('data', receiveResponse));

		this.pythonProcess.stderr.on("data",(data: string) => {
			console.error("Python error:", data);
		});
		


		this.registerMarkdownCodeBlockProcessor("pymath", async (source: string, el: HTMLElement, ctx) => {
		// Whenever a block is processed we need to check if the text changed with respect to what is 
		// stored in savedData. 
		// If the text is the same then we don't need to parse again and we probably don't need to turn on 
		// the python process. Which is another thing we need to check, if the process exists or not already.
		let requestId: string | undefined;
		
		try {
		
			const lines = parseBlock(source);

			// Ensure Mathjax is ready before Python can return a result. 
			await loadMathJax();
			const stdin = this.pythonProcess?.stdin;
			if (!stdin || stdin.destroyed || !stdin.writable) {
				throw new Error("Python is not running");
			}
			el.empty();

			for (const parsed of lines) {
				const output = el.createDiv();
				output.setText("Calculating...");

				requestId = crypto.randomUUID();
				const id = requestId
				// Store the destination before sending the request. 
			    this.pendingBlocks.set(id,output);

				try {
					stdin.write(JSON.stringify({
						...parsed,
						requestId: id,
						notePath: ctx.sourcePath,
					}) + "\n",
					(error) => {
						if (!error) return;

						this.pendingBlocks.delete(id);
						output.setText(`PyMath: ${error.message}`);
					});
				} catch (error) {
					this.pendingBlocks.delete(requestId);
					const message = error instanceof Error ? error.message : String(error);
					output.setText(`PyMath: ${message}`);
				}
			}

	}
	catch (error) {
		if (requestId) {
			this.pendingBlocks.delete(requestId);
		}
		const message = error instanceof Error ? error.message : String(error);
		el.setText(`PyMath: ${message}`)
	}

	});

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
		this.pendingBlocks.clear()
	}

	handlePythonResponse(response: PythonResponse) {
		const requestId = response.requestId;

		if (typeof requestId !== "string") {
			if ("error" in response) {
			console.error("PyMath received an unlinked error:", response.error)
		}
		return;
	}


		const el = this.pendingBlocks.get(requestId);
		this.pendingBlocks.delete(requestId);

		if (!el) return;

		if ("error" in response) {
			el.setText(`PyMath: ${response.error}`)
			return;
		}
		

		try {
			// Convert pythons latex into a formatted math element.
			const math = renderMath(response.result, true)
			// Replace "Calculating..." with the rendered math.
			el.empty();
			el.appendChild(math);

			// Finish updating MathJax's styles.
			void finishRenderMath().catch((error: unknown) => {
				console.error("PyMath math styling failed:", error);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message: String(error);
			el.setText(`PyMath: ${message}`);
		}
		
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
