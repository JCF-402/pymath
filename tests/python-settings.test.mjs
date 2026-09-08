import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const obsidian = `
export const controls = [];
export class EditorSuggest {}
export class Notice { constructor(message) { this.message = message; } }
export class Plugin {
    manifest = { id: 'pymath' }; callbacks = []; writes = []; tabs = []; commands = [];
    async loadData() { return this.data; }
    async saveData(data) { this.writes.push(structuredClone(data)); }
    register(callback) { this.callbacks.push(callback); }
    registerEvent() {} registerMarkdownCodeBlockProcessor() {} registerEditorSuggest() {}
    addCommand(command) { this.commands.push(command); }
    addSettingTab(tab) { this.tabs.push(tab); }
}
export class FileSystemAdapter { getBasePath() { return '/test-vault'; } }
export class PluginSettingTab { containerEl = { empty() {}, createDiv(options) { return { options }; } }; }
export class Setting {
    constructor(container) { this.container = container; controls.push(this); }
    setHeading() { return this; }
    setName(name) { this.name = name; return this; }
    setDesc(description) { this.description = description; return this; }
    addText(callback) {
        const input = {
            setPlaceholder() { return this; },
            setValue(value) { this.value = value; return this; },
            onChange(callback) { this.change = callback; return this; },
        };
        this.input = input; callback(input); return this;
    }
    addDropdown(callback) {
        const input = { addOptions() { return this; }, setValue() { return this; }, onChange(callback) { this.change = callback; return this; } };
        this.input = input; callback(input); return this;
    }
    addToggle(callback) { return this.addText(callback); }
}
export class MarkdownView {} export class Modal {} export class TFile {}
export class MarkdownRenderChild {}
export async function loadMathJax() {} export async function finishRenderMath() {}
export function renderMath() {}
`;
const processStub = `
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
export const spawns = [];
export function spawn(executable, args) {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => {
        child.kills++; child.emit('exit', 0);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        setImmediate(() => child.emit('close', 0));
    };
    child.stdin.on('data', chunk => {
        if (executable.startsWith('/missing/') || executable.startsWith('/broken/')) return;
        const request = JSON.parse(chunk.toString());
        queueMicrotask(() => child.stdout.write(JSON.stringify({requestId: request.requestId, result: ''}) + '\\n'));
    });
    if (executable.startsWith('/missing/')) queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    if (executable.startsWith('/broken/')) queueMicrotask(() => child.emit('close', 1));
    spawns.push({ executable, args, child }); return child;
}
`;
const compiled = await build({
    stdin: { contents: `export {default as PyMath} from './src/main'; export {controls,FileSystemAdapter} from 'obsidian'; export {spawns} from 'node:child_process';`,
        resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'settings-test-stubs', setup(builder) {
        builder.onResolve({filter:/^(obsidian|node:child_process)$/}, args => ({path:args.path,namespace:'stub'}));
        builder.onLoad({filter:/.*/,namespace:'stub'}, args => ({contents:args.path==='obsidian'?obsidian:processStub,loader:'js'}));
    } }],
});
const { PyMath, controls, FileSystemAdapter, spawns } =
    // eslint-disable-next-line no-unsanitized/method -- Import only locally bundled plugin code and fixed mocks.
    await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

async function load(t, data) {
    const plugin = new PyMath(); plugin.data = data;
    plugin.app = { vault: { adapter: new FileSystemAdapter(), configDir: '.obsidian', on() {}, getMarkdownFiles() { return []; } }, metadataCache: { on() {} } };
    await plugin.onload();
    t.after(() => { plugin.onunload(); for (const callback of plugin.callbacks) callback(); });
    return plugin;
}

test('older settings retain the existing SymPy executable', async t => {
    const plugin = await load(t, {settings:{showSubstitutionSteps:true}});
    const expected = '/Users/jomarcardona/miniforge/envs/python-general/bin/python';
    assert.equal(plugin.savedData.settings.pythonPath, expected);
    assert.equal(spawns.at(-1).executable, expected);
    assert.equal(plugin.savedData.settings.showSubstitutionSteps, true);
});

test('saved executable is passed to spawn as one argument even with spaces', async t => {
    const expected = '/Applications/Python Environment/bin/python';
    const plugin = await load(t, {settings:{pythonPath:expected}});
    assert.equal(plugin.savedData.settings.pythonPath, expected);
    assert.equal(spawns.at(-1).executable, expected);
    assert.deepEqual(spawns.at(-1).args, ['/test-vault/.obsidian/plugins/pymath/backend.py']);
});

test('executable control saves trimmed paths and falls back to python3 for blank input', async t => {
    const plugin = await load(t, {settings:{pythonPath:'/existing/python'}});
    plugin.tabs[0].display();
    const control = controls.findLast(item => item.name === 'Python executable');
    assert.equal(control.input.value, '/existing/python');
    await control.input.change('  /new/python  ');
    assert.equal(plugin.writes.at(-1).settings.pythonPath, '/new/python');
    await control.input.change('   ');
    assert.equal(plugin.writes.at(-1).settings.pythonPath, 'python3');
    // Changing the setting alone does not restart the running process.
    assert.equal(spawns.at(-1).executable, '/existing/python');
});

test('restart uses the latest path, deduplicates commands, and ignores old process close', async t => {
    const plugin = await load(t, {settings:{pythonPath:'/old/python'}});
    const old = spawns.at(-1).child, before = spawns.length;
    assert.ok(plugin.commands.some(c => c.id === 'restart-python'));
    plugin.savedData.settings.pythonPath = '/new/python';
    const first = plugin.restartPython(), second = plugin.restartPython();
    assert.equal(first, second); await first;
    assert.equal(spawns.length, before + 1);
    assert.equal(spawns.at(-1).executable, '/new/python');
    assert.equal(old.kills, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(plugin.pythonProcess, spawns.at(-1).child);
    assert.equal(old.listenerCount('error'), 0);
    assert.equal(old.stdout.listenerCount('data'), 0);
    assert.equal(old.stdin.listenerCount('error'), 0);
});

test('unload during restart cannot spawn a subsequent Python process', async t => {
    const plugin = await load(t, {settings:{pythonPath:'/python'}});
    let finish;
    plugin.noteRuntime.restart = () => new Promise(resolve => {finish=resolve;});
    const restarting = plugin.restartPython();
    await new Promise(resolve => setImmediate(resolve));
    const child = spawns.at(-1).child;
    plugin.onunload(); finish(); await restarting;
    const count = spawns.length;
    await assert.rejects(plugin.restartPython(), /unloading/);
    assert.equal(spawns.length, count); assert.equal(child.kills, 1);
    assert.equal(plugin.pythonProcess, null);
});

test('precision and number-format controls validate, save and refresh active results', async t => {
    const plugin = await load(t, { settings: {} });
    assert.equal(plugin.savedData.settings.precision, 12);
    assert.equal(plugin.savedData.settings.numberFormat, 'automatic');
    let refreshes = 0;
    plugin.noteRuntime.refreshGlobals = async () => { refreshes++; };
    plugin.tabs[0].display();
    const precision = controls.findLast(item => item.name === 'Precision');
    for (const invalid of ['', '0', '31', '3.5', 'abc']) await precision.input.change(invalid);
    assert.equal(refreshes, 0);
    await precision.input.change('6');
    assert.equal(plugin.writes.at(-1).settings.precision, 6);
    const format = controls.findLast(item => item.name === 'Number format');
    await format.input.change('scientific');
    assert.equal(plugin.writes.at(-1).settings.numberFormat, 'scientific');
    assert.equal(refreshes, 2);
});

test('decimal places accepts zero and blank reset, rejects invalid input and refreshes', async t => {
    const plugin = await load(t, { settings: {} });
    assert.equal(plugin.savedData.settings.decimalPlaces, null);
    let refreshes = 0; plugin.noteRuntime.refreshGlobals = async () => { refreshes++; };
    plugin.tabs[0].display();
    const control = controls.findLast(item => item.name === 'Decimal places');
    for (const value of ['-1', '21', '2.5', 'abc']) await control.input.change(value);
    assert.equal(refreshes, 0);
    for (const [value, expected] of [['2', 2], ['0', 0], ['', null]]) {
        await control.input.change(value);
        assert.equal(plugin.writes.at(-1).settings.decimalPlaces, expected);
    }
    assert.equal(refreshes, 3);
});

test('dataset settings share their own section container', async t => {
    const plugin = await load(t, { settings: {} }); plugin.tabs[0].display();
    const path = controls.findLast(item => item.name === 'Dataset CSV path');
    const unit = controls.findLast(item => item.name === 'Dataset display unit');
    const precision = controls.findLast(item => item.name === 'Precision');
    assert.equal(path.container, unit.container);
    assert.equal(path.container.options.cls, 'pymath-dataset-settings');
    assert.notEqual(path.container, precision.container);
});

test('missing primary uses the fallback without rewriting synced paths', async t => {
    const before = spawns.length;
    const plugin = await load(t, {settings:{pythonPath:'/missing/python',pythonFallbackPath:'/working/python'}});
    assert.deepEqual(spawns.slice(before).map(item => item.executable), ['/missing/python', '/working/python']);
    assert.equal(plugin.pythonProcess, spawns.at(-1).child);
    assert.equal(plugin.savedData.settings.pythonPath, '/missing/python');
    assert.equal(plugin.savedData.settings.pythonFallbackPath, '/working/python');
    const count = spawns.length;
    await plugin.restartPython();
    assert.equal(spawns.length, count + 2);
    assert.equal(plugin.pythonProcess, spawns.at(-1).child);
});

test('backend failure also falls back, while working primary does not launch fallback', async t => {
    const broken = await load(t, {settings:{pythonPath:'/broken/python',pythonFallbackPath:'/working/python'}});
    assert.equal(broken.pythonProcess, spawns.at(-1).child);
    assert.equal(spawns.at(-1).executable, '/working/python');
    const before = spawns.length;
    await load(t, {settings:{pythonPath:'/working/python',pythonFallbackPath:'/unused/python'}});
    assert.equal(spawns.length, before + 1);
});

test('identical paths are tried once and total failure leaves settings available', async t => {
    const before = spawns.length;
    const plugin = await load(t, {settings:{pythonPath:'/missing/python',pythonFallbackPath:' /missing/python '}});
    assert.equal(spawns.length, before + 1);
    assert.equal(plugin.tabs.length, 1);
    await assert.rejects(plugin.restartPython(), /Could not start Python/);
});

test('fallback path is optional and its setting saves a trimmed value', async t => {
    const plugin = await load(t, {settings:{pythonPath:'/working/python'}});
    assert.equal(plugin.savedData.settings.pythonFallbackPath, '');
    plugin.tabs[0].display();
    const control = controls.findLast(item => item.name === 'Fallback Python executable');
    await control.input.change('  C:\\Python\\python.exe  ');
    assert.equal(plugin.writes.at(-1).settings.pythonFallbackPath, 'C:\\Python\\python.exe');
    await control.input.change('  ');
    assert.equal(plugin.savedData.settings.pythonFallbackPath, '');
});
