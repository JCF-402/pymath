import { LatexSuggest } from "./latex-suggest";
import { prepareGlobalLatex } from "./latex-render";
import { insertPyMathBlock } from "./insert-block";
import { Dataset } from "./dataset";
import {Plugin,FileSystemAdapter,Notice} from 'obsidian';
import {DEFAULT_SETTINGS,PyMathSettingTab,} from './settings';

import {PyMathData} from "./types"
import { createPythonResponseReceiver } from './python-response';
import { validateSavedBlocks } from './block-data';
import { NoteRuntime } from './note-runtime';
import { VaultGlobals } from './vault-globals';
import { PyMathSuggest } from './editor-suggest';
import { StateSaver } from './state-saver';
import { PythonTransport } from './python-transport';

import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import * as path from "node:path";


export default class PyMath extends Plugin {
	pythonProcess: ChildProcessWithoutNullStreams | null = null;
	pythonTransport: PythonTransport | null = null;
	savedData: PyMathData = {
		settings: DEFAULT_SETTINGS,
		blocks: {},
		variables: {},
		functions: {}
	};
	dataset: Dataset | null = null;
	noteRuntime: NoteRuntime | null = null;
	stateSaver: StateSaver | null = null;
	private unloading = false;
	private globalIndex: VaultGlobals | null = null;
	private restarting: Promise<void> | null = null;

	async onload() {
		const data = await this.loadData() as Partial<PyMathData> | null;

		this.savedData = {
			settings: {
				...DEFAULT_SETTINGS,
				...data?.settings,
				// Keep configured paths; new installs use the portable default.
				pythonPath: data?.settings?.pythonPath ??
					DEFAULT_SETTINGS.pythonPath,
			},
			blocks: validateSavedBlocks(data?.blocks),
			variables: data?.variables ?? {},
			functions: data?.functions ?? {},
		};

		this.stateSaver = new StateSaver(
			() => this.savedData,
			state => this.saveData(state),
			error => console.error('PyMath state save failed:', error),
		);

		this.unloading = false;
		const transport = await this.startConfiguredPython();

		const globals: VaultGlobals = new VaultGlobals(this.app, () => runtime.refreshGlobals());
		this.globalIndex = globals;
		this.register(() => globals.close());
		const runtime: NoteRuntime = new NoteRuntime(this.app, transport, {
			getDisplay: () => ({ showUnitsInSteps: this.savedData.settings.showUnitsInSteps, decimalPlaces: this.savedData.settings.decimalPlaces, precision: this.savedData.settings.precision, numberFormat: this.savedData.settings.numberFormat }),
			getGlobals: () => globals.getDefinitions(),
			getBlocks: () => this.savedData.blocks,
			setBlocks: blocks => {
				this.savedData.blocks = blocks;
				this.stateSaver?.schedule();
			},
			showSubstitutionSteps: () => this.savedData.settings.showSubstitutionSteps,
		});
		this.noteRuntime = runtime;
		this.dataset = new Dataset(this.app, () => this.savedData.settings,
            message => { new Notice(`PyMath dataset: ${message}`); });
        this.register(() => this.dataset?.close());
        void this.dataset.reload();
        this.addCommand({ id: 'reload-datasets', name: 'Reload datasets', callback: () => { void this.dataset?.reload(); } });
        this.registerMarkdownPostProcessor(prepareGlobalLatex, -100);
        this.registerEditorSuggest(new LatexSuggest(this.app, globals));
        this.registerEditorSuggest(new PyMathSuggest(this.app, globals, this.dataset));
		this.register(() => runtime.close());

		this.registerEvent(
			this.app.metadataCache.on('changed', (file, text, metadata) => {
				const notePath = file.path;
				globals.update(notePath, text);
				const revision = globals.revision(notePath);
				void globals.ready.then(async () => {
					if (globals.revision(notePath) !== revision || file.path !== notePath) return;
					await runtime.updateNote(notePath, text, metadata);
				}).catch((error: unknown) => {
					console.error('PyMath note update failed:', error);
				});
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', file => {
				globals.removePath(file.path);
				void runtime.removePath(file.path).catch((error: unknown) => {
					console.error('PyMath path cleanup failed:', error);
				});
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				globals.renamePath(oldPath, file.path);
				void runtime.renamePath(oldPath, file.path).catch((error: unknown) => {
					console.error('PyMath path rename failed:', error);
				});
			}),
		);

		// Views display note results; only the coordinator sends calculations.
		this.registerMarkdownCodeBlockProcessor('pymath', (source, el, ctx) =>
			globals.ready.then(() => runtime.registerBlock(source, el, ctx)),
		);

		this.addCommand({
			id: 'insert-pymath-block',
			name: 'Insert PyMath block',
			editorCallback: insertPyMathBlock,
		});

		this.addCommand({
			id: 'restart-python',
			name: 'Restart Python',
			callback: () => {
				void this.restartPython().catch((error: unknown) => {
					if (this.unloading) return;
					console.error('PyMath restart failed:', error);
					new Notice('Python could not restart. Check the Python executable setting.');
				});
			},
		});

		this.addSettingTab(new PyMathSettingTab(this.app, this));

	}

	private async startConfiguredPython(failOnError = false): Promise<PythonTransport> {
		const paths = [...new Set([
			this.savedData.settings.pythonPath,
			this.savedData.settings.pythonFallbackPath,
		].filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
		const failures: string[] = [];
		for (const executable of paths) {
			if (this.unloading) throw new Error('PyMath is unloading.');
			try {
				const transport = this.startPython(executable);
				// A successful spawn alone does not prove SymPy or the backend loaded.
				const probe = {
					type: 'reset-note', requestId: crypto.randomUUID(), notePath: '__pymath_startup__',
				};
				const response = await transport.send(probe);
				if ('error' in response) throw new Error(response.error);
				if (this.unloading) throw new Error('PyMath is unloading.');
				return transport;
			} catch (error) {
				this.stopPython();
				if (this.unloading) throw new Error('PyMath is unloading.');
				failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const error = new Error(`Could not start Python. Check the executable paths and required packages. ${failures.join('; ')}`);
		if (failOnError) throw error;
		// Keep settings available even if neither configured executable works.
		new Notice(error.message);
		const transport = new PythonTransport((_text, callback) => callback(error));
		transport.close(error);
		return transport;
	}

	private startPython(pythonPath: string): PythonTransport {
		if (this.unloading) throw new Error('PyMath is unloading.');
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('PyMath requires desktop Obsidian.');
		}
		const backendPath = path.join(
			adapter.getBasePath(), this.app.vault.configDir,
			'plugins', this.manifest.id, 'backend.py',
		);
		const python = spawn(pythonPath, [backendPath]);
		const transport = new PythonTransport((text, callback) => {
			if (python.stdin.destroyed || !python.stdin.writable) {
				callback(new Error('Python is not running.'));
				return;
			}
			python.stdin.write(text, callback);
		});
		this.pythonProcess = python;
		this.pythonTransport = transport;
		python.stdout.setEncoding('utf8');
		python.stderr.setEncoding('utf8');

		const onError = (error: Error) => transport.close(error);
		const receiveResponse = createPythonResponseReceiver(
			response => { transport.accept(response); },
			error => transport.close(
				error instanceof Error ? error : new Error(String(error)),
			),
		);
		const onStderr = (text: string) => console.error('PyMath Python:', text);
		python.on('error', onError);
		python.stdin.on('error', onError);
		python.stdout.on('error', onError);
		python.stderr.on('error', onError);
		python.stdout.on('data', receiveResponse);
		python.stderr.on('data', onStderr);

		// Keep error handlers until the process and its streams have closed.
		python.once('close', () => {
			transport.close(new Error('Python exited.'));
			python.off('error', onError);
			python.stdin.off('error', onError);
			python.stdout.off('error', onError);
			python.stderr.off('error', onError);
			python.stdout.off('data', receiveResponse);
			python.stderr.off('data', onStderr);
			// A late close from the old process must not clear its replacement.
			if (this.pythonProcess === python) this.pythonProcess = null;
		});
		return transport;
	}

	private stopPython(): void {
		const python = this.pythonProcess;
		const transport = this.pythonTransport;
		this.pythonProcess = null;
		this.pythonTransport = null;
		transport?.close(new Error('Python stopped.'));
		python?.kill();
	}

	restartPython(): Promise<void> {
		if (this.restarting) return this.restarting;
		const restart = this.performRestart();
		this.restarting = restart;
		void restart.finally(() => {
			if (this.restarting === restart) this.restarting = null;
		}).catch(() => {});
		return restart;
	}

	private async performRestart(): Promise<void> {
		this.stopPython();
		const transport = await this.startConfiguredPython(true);
		await this.noteRuntime?.restart(transport);
	}

	onunload() {
		this.unloading = true;
		this.dataset?.close();
		this.globalIndex?.close();
		this.globalIndex = null;
		this.noteRuntime?.close();
		this.noteRuntime = null;
		this.stopPython();
		void this.stateSaver?.close().catch((error: unknown) => {
			console.error('PyMath final save failed:', error);
		});
	}

	async saveState() {
		await this.stateSaver?.saveNow();
	}

}
