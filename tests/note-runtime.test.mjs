import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';

// Node needs a browser timer shim for the runtime under test.
globalThis.window = { setTimeout, clearTimeout };

// Exercise the real runtime and Python backend, replacing only Obsidian's UI API.
const obsidianStub = `
export class Menu {}
export class TFile {
    constructor(path) { this.path = path; this.stat = { mtime: 1, size: 0 }; }
    get extension() { return this.path.split('.').at(-1); }
}
export class MarkdownRenderChild {
    callbacks = [];
    constructor(el) { this.containerEl = el; }
    register(callback) { this.callbacks.push(callback); }
    registerDomEvent() {}
    unload() { for (const callback of this.callbacks) callback(); }
}
export async function loadMathJax() {}
export async function finishRenderMath() {}
export function renderMath(source) { if (source.includes("\\tag{")) throw new Error("Tags unsupported in this renderer"); return { latex: source }; }
`;

const compiled = await build({
    stdin: {
        contents: `
            export { NoteRuntime } from './src/note-runtime';
            export { VaultGlobals } from './src/vault-globals';
            export { PythonTransport } from './src/python-transport';
            export { createPythonResponseReceiver } from './src/python-response';
            export { TFile } from 'obsidian';
        `,
        resolveDir: process.cwd(),
        loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{
        name: 'obsidian-stub',
        setup(builder) {
            builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
            builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: obsidianStub, loader: 'js' }));
        },
    }],
});
const { NoteRuntime, VaultGlobals, PythonTransport, createPythonResponseReceiver, TFile } =
    // This URL contains only the locally bundled source and the test stub above.
    // eslint-disable-next-line no-unsanitized/method -- Only locally bundled source and the fixed test stub are imported.
    await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

class Element {
    text = '';
    children = [];
    messages = [];
    textNode = null;
    get childNodes() { return this.textNode ? [this.textNode] : this.children; }
    hasChildNodes() { return this.childNodes.length > 0; }
    setText(text) {
        this.messages.push(text);
        this.text = text; this.children = [];
        this.textNode = text ? { text } : null;
    }
    empty() { this.setText(''); }
    createEl(tag, options) { const child = new Element(); child.tagName = tag; child.attributes = options.attr; this.children.push(child); return child; }
    createDiv(options) { const child = new Element(); child.className = options?.cls; this.children.push(child); return child; }
    appendChild(child) { this.children.push(child); }
    output() { return [this.text, ...this.children.map(c => c.latex ?? c.output())].filter(Boolean).join(this.className === 'pymath-equation-body' ? ' ' : '|'); }
}

function note(sources) {
    const lines = [], sections = [], starts = [];
    for (const source of sources) {
        const start = lines.length;
        starts.push(start);
        lines.push('```pymath', ...source.split('\n'), '```', '');
        sections.push({ type: 'code', position: {
            start: { line: start, col: 0, offset: 0 },
            end: { line: lines.length - 2, col: 3, offset: 0 },
        } });
    }
    return { text: lines.join('\n'), metadata: { sections }, starts };
}

function setup(send) {
    let blocks = {}, showSteps = false, reads = 0, globals, display;
    const files = new Map(), contents = new Map();
    const app = {
        vault: {
            getAbstractFileByPath: path => files.get(path),
            getMarkdownFiles: () => [...files.values()],
            async read(file) { reads++; return contents.get(file.path).text; },
        },
        metadataCache: { getFileCache: file => contents.get(file.path)?.metadata ?? null },
    };
    const runtime = new NoteRuntime(app, { send }, {
        getDisplay: () => display,
        getGlobals: () => globals?.getDefinitions(),
        getBlocks: () => blocks,
        setBlocks: value => { blocks = value; },
        showSubstitutionSteps: () => showSteps,
    });
    function set(path, data) {
        const file = files.get(path) ?? new TFile(path);
        file.stat.mtime++;
        file.stat.size = data.text.length;
        files.set(path, file); contents.set(path, data);
    }
    function view(path, source, start, docId = "test-document") {
        const el = new Element();
        const children = [];
        const context = {
            sourcePath: path, docId,
            getSectionInfo: () => start === null ? null : { lineStart: start },
            addChild: child => children.push(child),
        };
        return { el, ready: runtime.registerBlock(source, el, context),
            move(line) { start = line; },
            unload() { children.forEach(child => child.unload()); },
        };
    }
    function remove(path) { files.delete(path); contents.delete(path); }
    function rename(oldPath, newPath) {
        const file = files.get(oldPath), data = contents.get(oldPath);
        remove(oldPath); file.path = newPath;
        files.set(newPath, file); contents.set(newPath, data);
    }
    return { app, runtime, set, view, remove, rename, blocks: () => blocks, reads: () => reads,
        showSteps(value) { showSteps = value; },
        display(value) { display = value; },
        async indexGlobals(t) {
            globals = new VaultGlobals(app, () => runtime.refreshGlobals());
            t.after(() => globals.close());
            await globals.ready;
            return globals;
        },
    };
}

async function pythonHarness(t) {
    const child = spawn(process.env.PYMATH_PYTHON ?? 'python3', ['-B', 'src/backend.py']);
    const exit = once(child, 'close');
    const sent = [];
    const transport = new PythonTransport((text, callback) => {
        sent.push(JSON.parse(text)); child.stdin.write(text, callback);
    }, 5000);
    child.on('error', error => transport.close(error));
    child.on('close', () => transport.close(new Error('Python exited.')));
    child.stdin.on('error', error => transport.close(error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', createPythonResponseReceiver(r => transport.accept(r), error => transport.close(error)));
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    const h = setup(request => transport.send(request));
    t.after(async () => {
        h.runtime.close(); transport.close(); child.kill(); await exit;
        assert.equal(stderr, '');
    });
    return { ...h, sent, child, transport, send: request => transport.send(request) };
}

test('initial views share a note rebuild; edits, removed definitions, and multiple panes refresh', async t => {
    const h = await pythonHarness(t);
    let data = note(['x = 5', 'x^2 + 25']);
    h.set('A.md', data);
    const definition = h.view('A.md', 'x = 5', 0);
    const result = h.view('A.md', 'x^2 + 25', data.starts[1]);
    const pane = h.view('A.md', 'x^2 + 25', data.starts[1]);
    await Promise.all([definition.ready, result.ready, pane.ready]);
    assert.equal(h.reads(), 1);
    assert.deepEqual(h.sent.map(r => r.type), ['reset-note', 'assignment', 'expression']);
    assert.equal(result.el.output(), '50'); assert.equal(pane.el.output(), '50');

    definition.unload();
    data = note(['x = 10', 'x^2 + 25']); h.set('A.md', data);
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    assert.equal(result.el.output(), '125'); assert.equal(pane.el.output(), '125');
    const count = h.sent.length;
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    assert.equal(h.sent.length, count);

    result.unload(); pane.unload();
    data = note(['x^2 + 25']); h.set('A.md', data);
    const rebuild = h.runtime.updateNote('A.md', data.text, data.metadata);
    const newView = h.view('A.md', 'x^2 + 25', 0);
    await Promise.all([rebuild, newView.ready]);
    assert.equal(newView.el.output(), 'x^{2} + 25');
    assert.equal(Object.values(h.blocks()).length, 1);
});

test('whole note rebuilds include unseen functions and isolate notes; display setting changes apply', async t => {
    const h = await pythonHarness(t);
    let data = note(['x = 5\nf(t) = t^2 + x', 'f(3)']);
    h.set('A.md', data);
    const view = h.view('A.md', 'f(3)', data.starts[1]); await view.ready;
    assert.equal(view.el.output(), "f{\\left(3 \\right)} = 14");
    const other = note(['x = 100']); h.set('B.md', other);
    await h.runtime.updateNote('B.md', other.text, other.metadata);
    view.unload();
    data = note(['V = 5\nd = 3\nx = V*d']); h.set('A.md', data);
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    h.showSteps(true);
    const steps = h.view('A.md', 'V = 5\nd = 3\nx = V*d', 0); await steps.ready;
    assert.match(steps.el.output(), /x = V \\cdot d = 5 \\cdot 3 = 15/);
    assert.ok(Object.values(h.blocks()).some(b => b.notePath === 'B.md'));
});

test('invalid definitions discard old state, and a fully empty note still resets', async t => {
    const h = await pythonHarness(t);
    let data = note(['x = 5', 'x + 2']); h.set('A.md', data);
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    data = note(['x =', 'x + 2']); h.set('A.md', data);
    const work = h.runtime.updateNote('A.md', data.text, data.metadata);
    const invalid = h.view('A.md', 'x =', 0), result = h.view('A.md', 'x + 2', data.starts[1]);
    await Promise.all([work, invalid.ready, result.ready]);
    assert.match(invalid.el.output(), /Line 1/);
    assert.match(result.el.output(), /Cannot use 'x': Line 1/);
    await h.runtime.updateNote('A.md', '', {});
    assert.equal(Object.keys(h.blocks()).length, 0);
    assert.equal(h.sent.at(-1).type, 'reset-note');
});

test('a newer metadata update wins over an old initialization read', async () => {
    const sent = [];
    const h = setup(async r => { sent.push(r); return { requestId: r.requestId, result: r.expression ?? '' }; });
    const old = note(['x = 5']), fresh = note(['x = 10']); h.set('A.md', old);
    let release;
    h.app.vault.read = () => new Promise(resolve => { release = resolve; });
    const oldView = h.view('A.md', 'x = 5', 0);
    h.set('A.md', fresh);
    await h.runtime.updateNote('A.md', fresh.text, fresh.metadata);
    release(old.text); await oldView.ready;
    assert.deepEqual(sent.filter(r => r.type !== 'reset-note').map(r => r.expression), ['10']);
    h.runtime.close();
});

test('new edits cancel old lines and cannot publish stale results', async () => {
    const sent = [], waiting = [];
    const h = setup(r => {
        sent.push(r);
        return new Promise(resolve => waiting.push(() => resolve({ requestId: r.requestId, result: r.expression ?? '' })));
    });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const old = note(['x = 5\nx + 1']), fresh = note(['x = 10']);
    const first = h.runtime.updateNote('A.md', old.text, old.metadata);
    await tick(); waiting.shift()(); await tick();
    const next = h.runtime.updateNote('A.md', fresh.text, fresh.metadata);
    waiting.shift()(); await first; await tick();
    assert.equal(sent.at(-1).type, 'reset-note');
    waiting.shift()(); await tick(); waiting.shift()(); await next;
    assert.ok(!sent.some(r => r.expression === 'x + 1'));
    const view = h.view('A.md', 'x = 10', 0); await view.ready;
    assert.equal(view.el.output(), '10'); h.runtime.close();
});

test('missing metadata defers calculation; shutdown does not publish late results', async () => {
    const sent = [];
    let release;
    const h = setup(r => { sent.push(r); return new Promise(resolve => { release = resolve; }); });
    const data = note(['5']); h.set('A.md', { ...data, metadata: null });
    const view = h.view('A.md', '5', 0); await view.ready;
    assert.match(view.el.output(), /Waiting/); assert.equal(sent.length, 0);
    const work = h.runtime.updateNote('A.md', data.text, data.metadata);
    await new Promise(resolve => setImmediate(resolve));
    h.runtime.close(); const before = view.el.output();
    release({ requestId: sent[0].requestId, result: '' }); await work;
    assert.equal(sent.length, 1); assert.equal(view.el.output(), before);
});

test('deleting a note clears Python and saved scope without affecting another note', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5\nf(t) = t + x']);
    for (const path of ['A.md', 'B.md']) {
        h.set(path, data); await h.runtime.updateNote(path, data.text, data.metadata);
    }
    h.remove('A.md'); await h.runtime.removeNote('A.md');
    assert.ok(Object.values(h.blocks()).every(b => b.notePath === 'B.md'));
    assert.equal((await h.send({requestId:'probe-a',notePath:'A.md',type:'expression',expression:'x'})).result, 'x');
    assert.equal((await h.send({requestId:'probe-b',notePath:'B.md',type:'expression',expression:'f(2)'})).result, "f{\\left(2 \\right)} = 7");
});

test('renaming rebuilds at the new path and clears the old Python scope', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5', 'x + 2']); h.set('Old.md', data);
    const oldView = h.view('Old.md', 'x + 2', data.starts[1]); await oldView.ready;
    h.rename('Old.md', 'New.md'); await h.runtime.renameNote('Old.md', 'New.md');
    assert.ok(Object.values(h.blocks()).every(b => b.notePath === 'New.md'));
    const newView = h.view('New.md', 'x + 2', data.starts[1]); await newView.ready;
    assert.equal(newView.el.output(), '7');
    assert.equal((await h.send({requestId:'old-probe',notePath:'Old.md',type:'expression',expression:'x'})).result, 'x');
});

test('delete during calculation cancels remaining lines and performs a final reset', async () => {
    const sent = [], waiting = [];
    const h = setup(r => { sent.push(r); return new Promise(resolve => waiting.push(() => resolve({requestId:r.requestId,result:''}))); });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const data = note(['x = 5\nx + 2']);
    const work = h.runtime.updateNote('A.md', data.text, data.metadata);
    await tick(); waiting.shift()(); await tick();
    const removed = h.runtime.removeNote('A.md');
    waiting.shift()(); await work; await tick();
    assert.deepEqual(sent.map(r => r.type), ['reset-note','assignment','reset-note']);
    waiting.shift()(); await removed;
    assert.equal(Object.keys(h.blocks()).length, 0); h.runtime.close();
});

test('recreating a path during cleanup preserves the replacement note results', async () => {
    const sent = [], waiting = [];
    const h = setup(r => { sent.push(r); return new Promise(resolve => waiting.push(() => resolve({requestId:r.requestId,result:r.expression ?? ''}))); });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const removed = h.runtime.removeNote('A.md'); await tick();
    const fresh = note(['10']); h.set('A.md', fresh);
    const replacement = h.runtime.updateNote('A.md', fresh.text, fresh.metadata);
    waiting.shift()(); await removed; await tick();
    waiting.shift()(); await tick(); waiting.shift()(); await replacement;
    const view = h.view('A.md', '10', 0); await view.ready;
    assert.equal(view.el.output(), '10'); assert.equal(Object.keys(h.blocks()).length, 1);
    h.runtime.close();
});

test('deleting during initialization invalidates the old file read', async () => {
    const sent = [];
    const h = setup(async r => {sent.push(r); return {requestId:r.requestId,result:''};});
    const data = note(['x = 5']); h.set('A.md', data);
    let release;
    h.app.vault.read = () => new Promise(resolve => {release=resolve;});
    const view = h.view('A.md', 'x = 5', 0);
    h.remove('A.md'); await h.runtime.removeNote('A.md');
    release(data.text); await view.ready;
    assert.deepEqual(sent.map(r=>r.type), ['reset-note']);
    assert.equal(Object.keys(h.blocks()).length, 0); h.runtime.close();
});

test('folder rename rebuilds nested notes and preserves similarly named folders', async t => {
    const h = await pythonHarness(t);
    for (const [path, value] of [['Math/A.md', '5'], ['Math/Sub/B.md', '10'], ['Mathematics/C.md', '20']]) {
        const data = note([`x = ${value}`]); h.set(path, data);
        await h.runtime.updateNote(path, data.text, data.metadata);
    }
    h.rename('Math/A.md', 'Calculations/A.md');
    h.rename('Math/Sub/B.md', 'Calculations/Sub/B.md');
    await h.runtime.renamePath('Math', 'Calculations');
    assert.deepEqual(Object.values(h.blocks()).map(b => b.notePath).sort(),
        ['Calculations/A.md', 'Calculations/Sub/B.md', 'Mathematics/C.md']);
    for (const [path, expected] of [['Math/A.md', 'x'], ['Math/Sub/B.md', 'x'],
        ['Calculations/A.md', '5'], ['Calculations/Sub/B.md', '10'], ['Mathematics/C.md', '20']]) {
        const response = await h.send({requestId:`probe-${path}`,notePath:path,type:'expression',expression:'x'});
        assert.equal(response.result, expected);
    }
});

test('folder deletion cleans nested notes only and unrelated paths send no resets', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5']);
    for (const path of ['Math/A.md', 'Math/Sub/B.md', 'Mathematics/C.md']) {
        h.set(path, data); await h.runtime.updateNote(path, data.text, data.metadata);
    }
    h.remove('Math/A.md'); h.remove('Math/Sub/B.md');
    const start = h.sent.length;
    await h.runtime.removePath('Math');
    assert.deepEqual(h.sent.slice(start).map(r => [r.type, r.notePath]),
        [['reset-note','Math/A.md'],['reset-note','Math/Sub/B.md']]);
    assert.deepEqual(Object.values(h.blocks()).map(b => b.notePath), ['Mathematics/C.md']);
    const count = h.sent.length;
    await h.runtime.removePath('image.png'); await h.runtime.renamePath('Other', 'New');
    assert.equal(h.sent.length, count);
});

test('path rename still handles single files and clears state when extension changes', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5']); h.set('A.md', data);
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    h.rename('A.md', 'B.md'); await h.runtime.renamePath('A.md', 'B.md');
    assert.deepEqual(Object.values(h.blocks()).map(b => b.notePath), ['B.md']);
    h.rename('B.md', 'B.txt'); await h.runtime.renamePath('B.md', 'B.txt');
    assert.equal(Object.keys(h.blocks()).length, 0);
    assert.equal(h.sent.at(-1).type, 'reset-note');
    assert.equal(h.sent.at(-1).notePath, 'B.md');
});

test('folder deletion cancels active and queued calculations for all children', async () => {
    const sent = [], waiting = [];
    const h = setup(r => {sent.push(r);return new Promise(resolve=>waiting.push(()=>resolve({requestId:r.requestId,result:''})));});
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const data = note(['x = 5\nx + 2']);
    const first = h.runtime.updateNote('Math/A.md', data.text, data.metadata);
    const second = h.runtime.updateNote('Math/Sub/B.md', data.text, data.metadata);
    await tick(); waiting.shift()(); await tick();
    const removed = h.runtime.removePath('Math');
    waiting.shift()(); await Promise.all([first, second]); await tick();
    waiting.shift()(); await tick(); waiting.shift()(); await removed;
    assert.deepEqual(sent.map(r=>[r.notePath,r.type]), [
        ['Math/A.md','reset-note'],['Math/A.md','assignment'],
        ['Math/A.md','reset-note'],['Math/Sub/B.md','reset-note'],
    ]);
    assert.equal(Object.keys(h.blocks()).length, 0); h.runtime.close();
});

test('restart rebuilds notes on a fresh Python process and retains visible views', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5\nf(t) = t + x', 'f(3)']); h.set('A.md', data);
    const view = h.view('A.md', 'f(3)', data.starts[1]); await view.ready;
    assert.equal(view.el.output(), "f{\\left(3 \\right)} = 8");
    const fresh = await pythonHarness(t);
    h.transport.close(); h.child.kill();
    await h.runtime.restart(fresh.transport);
    assert.equal(view.el.output(), "f{\\left(3 \\right)} = 8");
    assert.deepEqual(fresh.sent.map(r=>r.type), ['reset-note','assignment','function','expression']);
    const edited = note(['x = 10\nf(t) = t + x', 'f(3)']); h.set('A.md', edited);
    await h.runtime.updateNote('A.md', edited.text, edited.metadata);
    assert.equal(view.el.output(), "f{\\left(3 \\right)} = 13");
});

test('restart during initial read initializes the waiting view on the new transport', async () => {
    const h = setup(async r=>({requestId:r.requestId,result:'old'}));
    const data = note(['5']); h.set('A.md', data);
    // An earlier incomplete metadata event can establish a revision first.
    await h.runtime.updateNote('A.md', data.text, {});
    let release, reads = 0;
    h.app.vault.read = async () => {
        reads++;
        if (reads === 1) return new Promise(resolve=>{release=resolve;});
        return data.text;
    };
    const view = h.view('A.md','5',0), sent = [];
    await h.runtime.restart({send:async r=>{sent.push(r);return {requestId:r.requestId,result:r.expression ?? ''};}});
    release(data.text); await view.ready;
    assert.equal(view.el.output(), '5');
    assert.deepEqual(sent.map(r=>r.type), ['reset-note','expression']);
    h.runtime.close();
});

test('prose edits update block positions without calculations or DOM replacement', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5', 'x + 2']); h.set('A.md', data);
    const view = h.view('A.md', 'x + 2', data.starts[1]); await view.ready;
    const count = h.sent.length, nodes = [...view.el.childNodes], messages = view.el.messages.length;
    const ids = Object.keys(h.blocks());
    const metadata = { sections: data.metadata.sections.map(section => ({...section,position:{
        start:{...section.position.start,line:section.position.start.line+2},
        end:{...section.position.end,line:section.position.end.line+2},
    }})) };
    view.move(data.starts[1]+2);
    await h.runtime.updateNote('A.md', 'Some prose\n\n'+data.text, metadata);
    assert.equal(h.sent.length, count);
    assert.deepEqual(Object.keys(h.blocks()), ids);
    assert.deepEqual(view.el.childNodes, nodes);
    assert.equal(view.el.childNodes[0], nodes[0]);
    assert.equal(view.el.messages.length, messages);
    const pane = h.view('A.md', 'x + 2', data.starts[1]+2); await pane.ready;
    assert.equal(pane.el.output(), '7');
    assert.ok(!pane.el.messages.includes('Calculating…'));
    assert.equal(h.sent.length, count);
});

test('existing output stays visible during a rebuild and same results retain their DOM', async t => {
    const h = await pythonHarness(t);
    const data = note(['x = 5', 'x + 2']); h.set('A.md',data);
    const view = h.view('A.md','x + 2',data.starts[1]); await view.ready;
    // Initial startup may legitimately show progress; only rebuilds must preserve output.
    view.el.messages.length = 0;
    const node = view.el.childNodes[0], messages = view.el.messages.length;
    const edited = note(['x = 2 + 3', 'x + 2']); h.set('A.md',edited);
    const work = h.runtime.updateNote('A.md',edited.text,edited.metadata);
    assert.equal(view.el.output(),'7');
    assert.equal(view.el.messages.length,messages);
    await work;
    assert.equal(view.el.childNodes[0],node);
    assert.equal(view.el.messages.length,messages);
    const changed = note(['x = 10','x + 2']); h.set('A.md',changed);
    const newer = h.runtime.updateNote('A.md',changed.text,changed.metadata);
    assert.equal(view.el.output(),'7');
    await newer; assert.equal(view.el.output(),'12');
    assert.ok(!view.el.messages.includes('Calculating…'));
});

test('prose changes during an active rebuild do not cancel or repeat the batch', async () => {
    const sent=[],waiting=[];
    const h=setup(r=>{sent.push(r);return new Promise(resolve=>waiting.push(()=>resolve({requestId:r.requestId,result:r.expression??''})));});
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    const data=note(['5']);
    const work=h.runtime.updateNote('A.md',data.text,data.metadata);
    await tick();
    const prose=h.runtime.updateNote('A.md',data.text+'Prose after the block',data.metadata);
    waiting.shift()();await tick();waiting.shift()();await Promise.all([work,prose]);
    assert.deepEqual(sent.map(r=>r.type),['reset-note','expression']);
    h.runtime.close();
});

test('reordering calculations still rebuilds the note', async t => {
    const h=await pythonHarness(t);
    const data=note(['x = 5','x + 2']); h.set('A.md',data);
    await h.runtime.updateNote('A.md',data.text,data.metadata);
    const count=h.sent.length;
    const reordered=note(['x + 2','x = 5']); h.set('A.md',reordered);
    await h.runtime.updateNote('A.md',reordered.text,reordered.metadata);
    assert.equal(h.sent[count].type,'reset-note');
    const view=h.view('A.md','x + 2',0);await view.ready;
    assert.equal(view.el.output(),'x + 2');
});


test('closed notes supply globals before first render; edits refresh consumers without opening sources', async t => {
    const h = await pythonHarness(t);
    h.set('Constants.md', note(['@global c = 3']));
    // Deliberately order the function before its dependency in the vault.
    h.set('Binding.md', note(['@global energy(m) = m*c^2']));
    h.set('Consumer.md', note(['energy(2)']));
    const index = await h.indexGlobals(t);
    assert.equal(h.sent.length, 0, 'indexing must not calculate every note');
    const view = h.view('Consumer.md', 'energy(2)', 0); await view.ready;
    assert.equal(view.el.output(), "\\operatorname{energy}{\\left(2 \\right)} = 18");
    assert.ok(h.sent.every(request => request.notePath === 'Consumer.md'));
    // Ignore initial startup progress when checking for refresh flicker.
    view.el.messages.length = 0;

    const updated = note(['@global c = 4']); h.set('Constants.md', updated);
    index.update('Constants.md', updated.text);
    // Exercise the debounced automatic callback, without calling refresh ourselves.
    for (let attempt = 0; attempt < 100 && view.el.output() !== "\\operatorname{energy}{\\left(2 \\right)} = 32"; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 10));
    }
    assert.equal(view.el.output(), "\\operatorname{energy}{\\left(2 \\right)} = 32");
    assert.ok(!view.el.messages.includes('Calculating…'));

    h.remove('Binding.md'); index.removePath('Binding.md');
    await h.runtime.refreshGlobals();
    assert.notEqual(view.el.output(), "\\operatorname{energy}{\\left(2 \\right)} = 32", 'deleted definitions must not remain callable');
});

test('global functions resolve forward references, local overrides stay local, and parameters shadow globals', async t => {
    const h = await pythonHarness(t);
    h.set('A.md', note(['@global energy(m) = scale(m)*c^2\n@global scale(m) = m*2']));
    h.set('Z.md', note(['@global c = 3\n@global m = 100\n@global π_1 = 7']));
    await h.indexGlobals(t);
    h.set('Use.md', note(['c = 10\nenergy(2)\nc\nπ_1']));
    const view = h.view('Use.md', 'c = 10\nenergy(2)\nc\nπ_1', 0); await view.ready;
    assert.equal(view.el.output(), "c = 10|\\operatorname{energy}{\\left(2 \\right)} = 36|10|7");
    h.set('Other.md', note(['c']));
    const other = h.view('Other.md', 'c', 0); await other.ready;
    assert.equal(other.el.output(), '3');
    h.set('Z.md', note(['c = 12\n@global c = 3\nc']));
    const source = h.view('Z.md', 'c = 12\n@global c = 3\nc', 0); await source.ready;
    assert.equal(source.el.output(), 'c = 12|c = 3|12');
});

test('duplicate globals, cycles and undefined references fail explicitly and recover after correction', async t => {
    const h = await pythonHarness(t);
    h.set('A.md', note(['@global c = 3'])); h.set('B.md', note(['@global c = 4']));
    h.set('Use.md', note(['c+1']));
    const index = await h.indexGlobals(t);
    const view = h.view('Use.md', 'c+1', 0); await view.ready;
    assert.match(view.el.output(), /Duplicate global 'c'.*A.md:2.*B.md:2/);
    index.removePath('B.md'); await h.runtime.refreshGlobals();
    assert.equal(view.el.output(), '4');
    index.update('A.md', note(['@global c = d\n@global d = c']).text);
    await h.runtime.refreshGlobals(); assert.match(view.el.output(), /Circular global/);
    index.update('A.md', note(['@global c = missing']).text);
    await h.runtime.refreshGlobals(); assert.match(view.el.output(), /Undefined global/);
    index.update('A.md', note(['@global c = 9']).text);
    await h.runtime.refreshGlobals(); assert.equal(view.el.output(), '10');
});

test('Python restart restores indexed globals without reading or opening their defining notes', async t => {
    const h = await pythonHarness(t);
    h.set('Hidden.md', note(['@global c = 5']));
    h.set('Use.md', note(['c^2'])); await h.indexGlobals(t);
    const view = h.view('Use.md', 'c^2', 0); await view.ready;
    const reads = h.reads();
    const fresh = await pythonHarness(t);
    await h.runtime.restart(fresh.transport);
    assert.equal(view.el.output(), '25'); assert.equal(h.reads(), reads);
    assert.deepEqual(fresh.sent.map(r => r.type), ['reset-note', 'expression']);
});

test('commented calculations render only math; commenting out definitions clears their previous values', async t => {
    const h = await pythonHarness(t);
    const source = '# Values\nx = 5 # starting value\nf(t) = t*x # multiply\nf(2) # answer';
    h.set('Comments.md', note([source]));
    const view = h.view('Comments.md', source, 0); await view.ready;
    assert.match(view.el.output(), /10$/); assert.doesNotMatch(view.el.output(), /Values|starting|answer|#/);
    view.unload();
    const changed = '# x = 5\n# f(t) = t*x';
    const data = note([changed]); h.set('Comments.md', data);
    await h.runtime.updateNote('Comments.md', data.text, data.metadata);
    const empty = h.view('Comments.md', changed, 0); await empty.ready;
    assert.equal(empty.el.output(), '');
    const response = await h.send({ type: 'expression', expression: 'x', notePath: 'Comments.md', requestId: crypto.randomUUID() });
    assert.equal(response.result, 'x');
});

test('closed-note globals with comments evaluate and can be disabled by commenting them out', async t => {
    const h = await pythonHarness(t);
    h.set('Hidden.md', note(['# constants\n@global scale = 5 # factor\n@global f(t) = t*scale # multiply']));
    h.set('Use.md', note(['f(2) # evaluate']));
    const index = await h.indexGlobals(t);
    const view = h.view('Use.md', 'f(2) # evaluate', 0); await view.ready;
    assert.equal(view.el.output(), "f{\\left(2 \\right)} = 10");
    index.update('Hidden.md', note(['# @global scale = 5\n# @global f(t) = t*scale']).text);
    await h.runtime.refreshGlobals();
    assert.notEqual(view.el.output(), '10');
});

test('global failures stay on dependent lines, propagate through local assignments and recover', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global broken = missing\n@global dependent(t) = t*broken\n@global good = 7']));
    const source = 'good+1\nx = dependent(2)\nx+1\n3+4';
    h.set('Use.md', note([source]));
    const index = await h.indexGlobals(t);
    const view = h.view('Use.md', source, 0); await view.ready;
    assert.match(view.el.output(), /^8\|PyMath:/);
    assert.match(view.el.output(), /Globals.md:2/);
    assert.match(view.el.output(), /Cannot use 'x'/);
    assert.match(view.el.output(), /\|7$/);
    index.update('Globals.md', note(['@global broken = 5\n@global dependent(t) = t*broken\n@global good = 7']).text);
    await h.runtime.refreshGlobals();
    assert.equal(view.el.output(), '8|x = 10|11|7');
});

test('malformed global definitions poison their names without stopping unrelated notes', async t => {
    const h = await pythonHarness(t);
    h.set('Bad.md', note(['@global broken =']));
    const source = '2+3\nbroken+1'; h.set('Use.md', note([source]));
    const index = await h.indexGlobals(t);
    const view = h.view('Use.md', source, 0); await view.ready;
    assert.match(view.el.output(), /^5\|PyMath:.*Bad.md:2/);
    index.update('Bad.md', note(['@global broken = 4']).text);
    await h.runtime.refreshGlobals(); assert.equal(view.el.output(), '5|5');
});

test('duplicate and circular globals leave independent math and local overrides working', async t => {
    const h = await pythonHarness(t);
    h.set('A.md', note(['@global clash = 1\n@global a = b\n@global b = a']));
    h.set('B.md', note(['@global clash = 2']));
    const source = 'clash\na\nclash = 9\nclash+1\nf(a) = a+1\nf(2)\n8';
    h.set('Use.md', note([source])); await h.indexGlobals(t);
    const view = h.view('Use.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Duplicate global/);
    assert.match(view.el.output(), /Circular global/);
    assert.match(view.el.output(), /clash = 9\|10\|/);
    assert.match(view.el.output(), / = 3\|8$/);
    const definition = h.view('B.md', '@global clash = 2', 0); await definition.ready;
    assert.match(definition.el.output(), /Duplicate global/);
});

test('global changes rebuild direct and indirect consumers but leave unrelated notes alone', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global scale = 2\n@global f(x) = x*scale\n@global other = 9']));
    const index = await h.indexGlobals(t);
    for (const [path, expression] of [['Direct.md', 'scale+1'], ['Indirect.md', 'f(3)'], ['Other.md', 'other+1']]) {
        h.set(path, note([expression])); await h.view(path, expression, 0).ready;
    }
    const before = h.sent.length;
    index.update('Globals.md', note(['@global scale = 4\n@global f(x) = x*scale\n@global other = 9']).text);
    await h.runtime.refreshGlobals();
    assert.deepEqual([...new Set(h.sent.slice(before).map(request => request.notePath))].sort(), ['Direct.md', 'Indirect.md']);
    const after = h.sent.length;
    await h.view('Other.md', 'other+1', 0).ready;
    assert.equal(h.sent.length, after);
});

test('comment-only edits preserve calculations, block identity and updated saved source', async t => {
    const h = await pythonHarness(t);
    const original = 'x = 5 # first\nx+1'; h.set('A.md', note([original]));
    const old = h.view('A.md', original, 0); await old.ready; old.unload();
    const before = h.sent.length, id = Object.keys(h.blocks())[0];
    const updated = '# Heading\nx = 5 # revised\n\nx+1 # result';
    const data = note([updated]); h.set('A.md', data);
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    const view = h.view('A.md', updated, 0); await view.ready;
    assert.equal(view.el.output(), 'x = 5|6'); assert.equal(h.sent.length, before);
    assert.equal(h.blocks()[id].source, updated);
});

test('new globals resolve previously symbolic references and moved errors report the current line', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global broken = missing']));
    const index = await h.indexGlobals(t);
    h.set('Use.md', note(['broken']));
    const view = h.view('Use.md', 'broken', 0); await view.ready;
    assert.match(view.el.output(), /Globals.md:2/);
    index.update('Globals.md', note(['# heading\n@global broken = missing']).text);
    await h.runtime.refreshGlobals(); assert.match(view.el.output(), /Globals.md:3/);
    index.update('Globals.md', note(['@global broken = missing\n@global missing = 4']).text);
    await h.runtime.refreshGlobals(); assert.equal(view.el.output(), '4');
});

test('syntax errors stay on their line, invalidate earlier values and allow independent calculations', async t => {
    const h = await pythonHarness(t);
    const source = 'x = 5\ny = 9\n# explanation\ny =\nx+2\ny+1\ny = 4\ny+1';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /^x = 5\|y = 9\|PyMath: Line 4:/);
    assert.match(view.el.output(), /\|7\|PyMath: Line 6: Cannot use 'y'/);
    assert.match(view.el.output(), /\|y = 4\|5$/);
});

test('invalid function declarations poison the function until a valid redefinition', async t => {
    const h = await pythonHarness(t);
    const source = 'f(t) = t+1\nf(t,t) = t\nf(2)\n2+3\nf(t) = t*3\nf(2)';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Line 2:.*unique/);
    assert.match(view.el.output(), /Cannot use 'f'/);
    assert.match(view.el.output(), /\|5\|/);
    assert.match(view.el.output(), / = 6$/);
});

test('valid lines in partially invalid blocks still track global changes and diagnostic line moves', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global scale = 3']));
    const index = await h.indexGlobals(t);
    const source = 'y =\nscale+1'; h.set('Use.md', note([source]));
    const view = h.view('Use.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Line 1:.*\|4$/);
    index.update('Globals.md', note(['@global scale = 5']).text);
    await h.runtime.refreshGlobals(); assert.match(view.el.output(), /\|6$/);
    view.unload();
    const changed = '# new heading\ny =\nscale+1'; const data = note([changed]);
    h.set('Use.md', data); await h.runtime.updateNote('Use.md', data.text, data.metadata);
    const next = h.view('Use.md', changed, 0); await next.ready;
    assert.match(next.el.output(), /Line 2:.*\|6$/);
});

test('Python errors report original block lines, explain brackets and retain details', async t => {
    const h = await pythonHarness(t);
    const source = '# heading\n\nx = (2+3\n4+5\n2+*3\n2+3)';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Line 3: Missing closing bracket '\)'\. Details:/);
    assert.match(view.el.output(), /\|9\|/);
    assert.match(view.el.output(), /Line 5: Invalid expression/);
    assert.match(view.el.output(), /Line 6: Unexpected or mismatched closing bracket/);
});

test('moving a Python error with comments refreshes its displayed line', async t => {
    const h = await pythonHarness(t);
    h.set('A.md', note(['2+*3']));
    const view = h.view('A.md', '2+*3', 0); await view.ready;
    assert.match(view.el.output(), /Line 1:/); view.unload();
    const source = '# heading\n\n2+*3'; const data = note([source]);
    h.set('A.md', data); await h.runtime.updateNote('A.md', data.text, data.metadata);
    const next = h.view('A.md', source, 0); await next.ready;
    assert.match(next.el.output(), /Line 3:/);
});

test('function argument errors provide guidance and global syntax errors keep source provenance', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global broken = (2+3'])); await h.indexGlobals(t);
    const source = 'f(x) = x+1\nf(1,2)\nbroken\n9';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Line 2: Check the function's arguments\. Details:/);
    assert.match(view.el.output(), /Line 3:.*Globals.md:2.*Missing closing bracket/);
    assert.match(view.el.output(), /\|9$/);
});

test('curated built-ins evaluate in the actual SymPy parser', async t => {
    const h = await pythonHarness(t);
    const expressions = ['sin(0)', 'cos(0)', 'tan(0)', 'asin(0)', 'acos(1)', 'atan(0)',
        'sqrt(4)', 'exp(0)', 'log(E)', 'log(8,2)', 'Abs(-2)', 'factorial(3)', 'floor(3/2)',
        'ceiling(3/2)', 'simplify(x+x)', 'expand((x+1)^2)', 'factor(x^2-1)',
        'diff(x^2,x)', 'integrate(x,x)', 'pi', 'E', 'I', 'oo'];
    const source = expressions.join('\n'); h.set('Builtins.md', note([source]));
    const view = h.view('Builtins.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    assert.equal(view.el.children.length, expressions.length);
    assert.match(view.el.output(), /^0\|1\|0\|0\|0\|0\|2\|1\|1\|3\|2\|6\|1\|2\|/);
});

test('numeric final results approximate while substitution steps and stored values stay exact', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    const source = 'y = 500000\nx = sin(y)*10\nx - sin(y)*10\nr = 1/3\nr*3\nsin(z)';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    const output = view.el.output();
    assert.match(output, /x = .*sin.*500000.* = /);
    assert.match(output, / = 1\.778/);
    assert.match(output, /\|0\|r = .* = 0\.333/);
    assert.match(output, /\|1\|.*sin.*z/);
    assert.doesNotMatch(output, /PyMath:/);
});

test('plain numeric expressions and assignments approximate without turning integers or symbols into decimals', async t => {
    const h = await pythonHarness(t);
    const source = 'sin(5000)\nx = sqrt(2)\nx^2\nsin(0)\nz+1';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /^-0\.987/);
    assert.match(view.el.output(), /x = 1\.414/);
    assert.match(view.el.output(), /\|2\|0\|z \+ 1$/);
});

test('display settings refresh visible results and preserve exact stored values', async t => {
    const h = await pythonHarness(t);
    h.display({ precision: 4, numberFormat: 'decimal' });
    const source = 'x = 1/3\nx*3\nsin(5000)\n1/10000000';
    h.set('A.md', note([source])); const view = h.view('A.md', source, 0); await view.ready;
    assert.equal(view.el.output(), 'x = 0.3333|1|-0.988|0.0000001');
    h.display({ precision: 6, numberFormat: 'scientific' });
    await h.runtime.refreshGlobals();
    assert.match(view.el.output(), /x = 3\.33333 \\times 10\^\{-1\}/);
    assert.match(view.el.output(), /1 \\times 10\^\{-7\}/);
    const exact = await h.send({ type: 'expression', expression: 'x*3', notePath: 'A.md', requestId: crypto.randomUUID() });
    assert.equal(exact.result, '1');
});

test('decimal places set fixed fractional digits and refresh without changing exact values', async t => {
    const h = await pythonHarness(t);
    h.display({ precision: 3, numberFormat: 'automatic', decimalPlaces: 2 });
    const source = 'x = 1/3\nx*3\n12345+1/8\n-1/10000';
    h.set('A.md', note([source])); const view = h.view('A.md', source, 0); await view.ready;
    assert.equal(view.el.output(), 'x = 0.33|1.00|12345.12|0.00');
    h.display({ precision: 3, numberFormat: 'decimal', decimalPlaces: 5 });
    await h.runtime.refreshGlobals();
    assert.equal(view.el.output(), 'x = 0.33333|1.00000|12345.12500|-0.00010');
    h.display({ precision: 3, numberFormat: 'scientific', decimalPlaces: 2 });
    await h.runtime.refreshGlobals();
    assert.match(view.el.output(), /x = 3\.33 \\times 10\^\{-1\}/);
});

test('unit labels render after results without affecting stored values or propagating', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    const source = 'distance = 100 [m] # length\ntime = 5 [s]\nspeed = distance/time [m/s]\nspeed*2';
    h.set('A.md', note([source])); const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /distance = 100\\,\\text\{m\}/);
    assert.match(view.el.output(), /speed = .*20\\,\\text\{m\/s\}\|40$/);
    assert.doesNotMatch(view.el.output(), /PyMath:/);
});

test('global variables and functions accept display labels without making units dependencies', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global speed = 20 [m/s]\n@global travel(t) = speed*t [m]']));
    await h.indexGlobals(t);
    h.set('A.md', note(['travel(2) [m]\nspeed']));
    const view = h.view('A.md', 'travel(2) [m]\nspeed', 0); await view.ready;
    assert.equal(view.el.output(), "\\operatorname{travel}{\\left(2 \\right)} = 40\\,\\text{m}|20");
});

test('equation tags render with units and do not alter or propagate through calculations', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global speed = 20 [m/s] {Fluid velocity}']));
    await h.indexGlobals(t);
    const source = 'x = speed+2 [m/s] {Outlet velocity}\nx*2';
    h.set('A.md', note([source])); const view = h.view('A.md', source, 0); await view.ready;
    assert.equal(view.el.output(), 'x = 22\\,\\text{m/s}|(Outlet velocity)|44');
    const definition = h.view('Globals.md', '@global speed = 20 [m/s] {Fluid velocity}', 0);
    await definition.ready; assert.match(definition.el.output(), /\(Fluid velocity\)/);
});

test('standalone calls retain their written arguments and decorations', async t => {
    const h = await pythonHarness(t);
    const source = 'f(x) = x^2\ny = 3\nf(y) [m] {Evaluation}\nf(3)+1';
    h.set('A.md', note([source])); const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /f\{\\left\(y \\right\)\} = 9\\,\\text\{m\}\|\(Evaluation\)\|10$/);
});

test('automatic notation selects scientific for small and large results even with decimal places', async t => {
    const h = await pythonHarness(t);
    h.display({ precision: 12, numberFormat: 'automatic', decimalPlaces: 3 });
    const source = '0.0000001\n3.016\n1000000\n-0.0000001\n0';
    h.set('A.md', note([source])); const view = h.view('A.md', source, 0); await view.ready;
    assert.equal(view.el.output(), '1.000\\times 10^{-7}|3.016|1.000\\times 10^{6}|-1.000\\times 10^{-7}|0.000'.replaceAll('\\times', ' \\times'));
    h.display({ precision: 12, numberFormat: 'scientific', decimalPlaces: 3 });
    await h.runtime.refreshGlobals();
    assert.doesNotMatch(view.el.output(), /10\^\{0\}/);
    assert.match(view.el.output(), /\|3\.016\|/);
});

test('plot mode replaces the whole block with a PNG and does not overwrite note variables', async t => {
    const h = await pythonHarness(t);
    const source = 'x = 5\nf(x) = sin(x)\n@plot f(x) {Sine curve}\n@range x = -10, 10';
    h.set('Plot.md', note([source]));
    const view = h.view('Plot.md', source, 0); await view.ready;
    assert.equal(view.el.children.length, 1);
    const chart = view.el.children[0];
    assert.equal(chart.tagName, 'img');
    assert.equal(chart.attributes['data-pymath-download'], 'Plot-plot-1.png');
    const png = Buffer.from(chart.attributes.src.split(',')[1], 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1120); assert.equal(png.readUInt32BE(20), 630);
    const value = await h.send({ type: 'expression', expression: 'x', notePath: 'Plot.md', requestId: crypto.randomUUID() });
    assert.equal(value.result, '5');
});

test('global plot dependencies refresh the chart and plot failures replace it with one message', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global scale = 2\n@global f(t) = scale*t']));
    const index = await h.indexGlobals(t);
    const source = '@plot f(t)\n@range t = 0, 10'; h.set('Plot.md', note([source]));
    const view = h.view('Plot.md', source, 0); await view.ready;
    const image = view.el.children[0].attributes.src;
    index.update('Globals.md', note(['@global scale = 4\n@global f(t) = scale*t']).text);
    await h.runtime.refreshGlobals();
    assert.notEqual(view.el.children[0].attributes.src, image);
    assert.ok(view.el.children[0].attributes['data-pymath-download'].endsWith('.png'));
    view.unload();
    const bad = '@plot sqrt(-1)\n@range t = 0, 10'; const data = note([bad]); h.set('Plot.md', data);
    await h.runtime.updateNote('Plot.md', data.text, data.metadata);
    const error = h.view('Plot.md', bad, 0); await error.ready;
    assert.match(error.el.output(), /No real, finite/); assert.equal(error.el.children.length, 0);
});

test('plot configuration and failed definitions produce errors without poisoning later calculations', async t => {
    const h = await pythonHarness(t);
    for (const [source, expected] of [
        ['@plot sin(x)', /exactly one @range/],
        ['@plot x\n@range x = 5, 1', /minimum/],
        ['f(x) =\n@plot f(x)\n@range x = -1, 1', /Line 1/],
        ['@plot x+y\n@range x = -1, 1', /Undefined plot/],
        ['@plot x\n@range x = 0, 1\n@range x = 0, 2', /exactly one @range/],
    ]) {
        const data = note([source]); h.set('Plot.md', data);
        await h.runtime.updateNote('Plot.md', data.text, data.metadata);
        const view = h.view('Plot.md', source, 0); await view.ready;
        assert.match(view.el.output(), expected); view.unload();
    }
    const response = await h.send({ type: 'expression', expression: '2+3', notePath: 'Plot.md', requestId: crypto.randomUUID() });
    assert.equal(response.result, '5');
});

test('plot comments reuse the chart, range edits rebuild it, and constant curves are supported', async t => {
    const h = await pythonHarness(t);
    let source = '@plot 2\n@range x = -1, 1'; h.set('Plot.md', note([source]));
    let view = h.view('Plot.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
    const before = h.sent.length;
    view.unload(); source = '# A constant\n@plot 2 # curve\n@range x = -1, 1';
    let data = note([source]); h.set('Plot.md', data);
    await h.runtime.updateNote('Plot.md', data.text, data.metadata);
    view = h.view('Plot.md', source, 0); await view.ready;
    assert.equal(h.sent.length, before);
    view.unload(); source = '@plot 2\n@range x = -10, 10'; data = note([source]); h.set('Plot.md', data);
    await h.runtime.updateNote('Plot.md', data.text, data.metadata);
    view = h.view('Plot.md', source, 0); await view.ready;
    assert.ok(h.sent.length > before); assert.equal(view.el.children[0].tagName, 'img');
});

test('multiple curves share one image and changes to the second curve dependency refresh it', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global amplitude = 2']));
    const index = await h.indexGlobals(t);
    const source = '@plot sin(x) {Sine}\n@plot amplitude*cos(x) {Cosine}\n@range x = -10, 10';
    h.set('Plot.md', note([source])); const view = h.view('Plot.md', source, 0); await view.ready;
    assert.equal(view.el.children.length, 1); assert.equal(view.el.children[0].tagName, 'img');
    const first = view.el.children[0].attributes.src;
    const request = h.sent.findLast(request => request.type === 'plot');
    assert.deepEqual(request.curves.map(curve => curve.tag), ['Sine', 'Cosine']);
    index.update('Globals.md', note(['@global amplitude = 4']).text); await h.runtime.refreshGlobals();
    assert.notEqual(view.el.children[0].attributes.src, first);
});

test('a failed later curve reports its own source line rather than silently dropping it', async t => {
    const h = await pythonHarness(t);
    const source = '@plot sin(x) {Good}\n# comment\n@plot missing+x {Bad curve}\n@range x = -1, 1';
    h.set('Plot.md', note([source])); const view = h.view('Plot.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Bad curve \(line 3\)/); assert.equal(view.el.children.length, 0);
});

test('plot customization reaches the backend, controls dimensions, and edits refresh the image', async t => {
    const h = await pythonHarness(t);
    let source = '@plot sin(x) {Sine}\n@plot cos(x) {Cosine}\n@range x = -5, 5\n@title Waves\n@xlabel Angle\n@ylabel Amplitude\n@grid off\n@legend top-right\n@size 6, 3\n@color 1 "#ff8800"\n@style 2 dashed\n@width 2 3';
    h.set('Plot.md', note([source]));
    let view = h.view('Plot.md', source, 0); await view.ready;
    const image = view.el.children[0].attributes.src;
    const png = Buffer.from(image.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), 840); assert.equal(png.readUInt32BE(20), 420);
    const request = h.sent.findLast(r => r.type === 'plot');
    assert.equal(request.options.grid, false);
    assert.equal(request.options.title, 'Waves');
    assert.equal(request.curves[0].color, '#ff8800');
    assert.equal(request.curves[1].style, 'dashed');
    assert.equal(request.curves[1].width, 3);
    view.unload();
    source = source.replace('@grid off', '@grid on');
    const data = note([source]); h.set('Plot.md', data);
    await h.runtime.updateNote('Plot.md', data.text, data.metadata);
    view = h.view('Plot.md', source, 0); await view.ready;
    assert.notEqual(view.el.children[0].attributes.src, image);
    assert.ok(view.el.children[0].attributes['data-pymath-download'].endsWith('.png'));
});

test('invalid plot options display useful errors without stopping Python', async t => {
    const h = await pythonHarness(t);
    for (const [option, expected] of [
        ['@size 16, 12', /Line 3:.*area/],
        ['@grid maybe', /Line 3:.*grid on/],
        ['@legend nowhere', /Line 3:.*Legend/],
        ['@style 2 dashed', /Line 3:.*curve numbers/],
        ['@width 1 0', /Line 3:.*width/],
        ['@color 1 imaginarycolor', /unknown color/],
        ['@title One\n@title Two', /Line 4:.*only once/],
    ]) {
        const source = '@plot x\n@range x = 0, 1\n' + option;
        const data = note([source]); h.set('Plot.md', data);
        await h.runtime.updateNote('Plot.md', data.text, data.metadata);
        const view = h.view('Plot.md', source, 0); await view.ready;
        assert.match(view.el.output(), expected);
        view.unload();
    }
});

test('SymPy calculus and algebra operations render through the real note runtime', async t => {
    const h = await pythonHarness(t);
    for (const [source, expected] of [
        ['integrate(t^2, t)', /\\frac\{t\^\{3\}\}\{3\}/],
        ['integrate(t^2, (t, 0, 3))', / = 9$/],
        ['integrate(exp(-t), (t, 0, oo))', / = 1$/],
        ['diff(t^3, t, 2)', /6 t/],
        ['limit(sin(t)/t, t, 0)', / = 1$/],
        ['summation(k, (k, 1, 10))', / = 55$/],
        ['product(k, (k, 1, 4))', / = 24$/],
        ['series(exp(t), t, 0, 4)', /O/],
        ['solve(t^2-4, t)', /-2, 2/],
        ['solve(t^2+1, t)', /i/],
        ['solve(1, t)', /\\left\[\\right\]/],
        ['integrate(sin(t^t), t)', /\\int/],
        ['f(t) = t^2\nintegrate(f(t), (t, 0, 3))', /9/],
        ['x = 5\nF(t) = integrate(t^2, t)\nF(3)', /9/],
    ]) {
        const data = note([source]); h.set('Calculus.md', data);
        await h.runtime.updateNote('Calculus.md', data.text, data.metadata);
        const view = h.view('Calculus.md', source, 0); await view.ready;
        assert.match(view.el.output(), expected, source); view.unload();
    }
});

test('calculus errors recover and definite integrals retain exact stored values', async t => {
    const h = await pythonHarness(t);
    const source = 'x = 5\ndiff(x^2, x)\narea = integrate(t, (t, 0, 1))\narea*2';
    h.set('Calculus.md', note([source]));
    const view = h.view('Calculus.md', source, 0); await view.ready;
    assert.match(view.el.output(), /Line 2/);
    const response = await h.send({type: 'expression', expression: 'area*2', notePath: 'Calculus.md', requestId: crypto.randomUUID()});
    assert.equal(response.result, '1');
    const roots = await h.send({type: 'expression', expression: 'solve(t^2-2, t)', decimalPlaces: 3, notePath: 'Calculus.md', requestId: crypto.randomUUID()});
    assert.equal(roots.result, String.raw`\left[-1.414, 1.414\right]`);
});

test('calculus notation preserves operators, bounds, results and unevaluated expressions', async t => {
    const h = await pythonHarness(t);
    const check = async (expression, pattern, extra = {}) => {
        const response = await h.send({type: 'expression', expression, notePath: 'Notation.md', requestId: crypto.randomUUID(), ...extra});
        assert.equal(response.error, undefined, expression);
        assert.match(response.result, pattern, expression);
        return response.result;
    };
    await check('integrate(t^2, (t, 0, 3))', /\\int\\limits_\{0\}\^\{3\}.* = 9$/);
    await check('diff(t^3, t, 2)', /\\frac\{d\^\{2\}\}.* = 6 t$/);
    await check('limit(sin(t)/t, t, 0)', /\\lim_.* = 1$/);
    await check('summation(k, (k, 1, 10))', /\\sum_.* = 55$/);
    await check('product(k, (k, 1, 4))', /\\prod_.* = 24$/);
    await check('integrate(t, (t, 0, 1))', / = 0\.500$/, {decimalPlaces: 3});
    const unresolved = await check('integrate(sin(t^t), t)', /\\int/);
    assert.equal(unresolved.includes(' = '), false);
    await check('integrate(t^2, (t, 0, 3))', /^A = \\int.* = 9$/, {type: 'assignment', variable: 'A', showSubstitutionSteps: true});
    await check('A+1', /^10$/);
    await check('integrate(t^2, t)', /^F.* = \\int.* = /, {type: 'function', name: 'F', parameters: ['t']});
    await check('F(3)', / = 9$/);
    await check('t+1', / = t \+ 1$/, {type: 'function', name: 'integrate', parameters: ['t']});
    const shadowed = await check('integrate(2)', / = 3$/);
    assert.equal(shadowed.includes('\\int'), false);
});

test('symbols replace numeric assignments and assumptions drive simplification without numeric formatting errors', async t => {
    const h = await pythonHarness(t);
    const source = 'x = 5\n@symbol x positive\nsqrt(x^2)\nformula = x^2 + 2\nsubs(formula, x, 3)\nintegrate(x, (x, 0, 2))';
    h.set('Symbols.md', note([source]));
    const view = h.view('Symbols.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    assert.doesNotMatch(view.el.output(), /symbol: positive/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Symbols.md', requestId: crypto.randomUUID()});
    assert.equal((await send('sqrt(x^2)')).result, 'x');
    assert.equal((await send('subs(formula, x, 3)')).result, '11');
    assert.equal((await send('x')).result, 'x');
    assert.match((await send('formula')).result, /x/);
    assert.equal((await send('subs(x, 5, 3)')).error.includes('targets must be symbols'), true);
});

test('assumptions rebuild, contradictions invalidate names, and plain declarations recover', async t => {
    const h = await pythonHarness(t);
    for (const [declaration, expected] of [
        ['positive', /^x$/], ['real', /left/], ['positive negative', /Conflicting/],
        ['unknown', /Unknown assumption/], ['', /x/],
    ]) {
        const source = '@symbol x ' + declaration + '\nsqrt(x^2)';
        const data = note([source]); h.set('Symbols.md', data);
        await h.runtime.updateNote('Symbols.md', data.text, data.metadata);
        const response = await h.send({type: 'expression', expression: 'sqrt(x^2)', notePath: 'Symbols.md', requestId: crypto.randomUUID()});
        assert.match(response.error ?? response.result, expected);
    }
});

test('simultaneous substitutions preserve formulas and support global symbols from closed notes', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global @symbol x positive\n@global formula = x^2 + 2']));
    await h.indexGlobals(t);
    const source = '@symbol y real\nsubs(formula, x, 3)\nsubs(x + 2*y, [(x, y), (y, 1)])';
    h.set('Use.md', note([source])); const view = h.view('Use.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    assert.match(view.el.output(), /11/);
    const response = await h.send({type: 'expression', expression: 'subs(x+2*y, [(x, y), (y, 1)])', notePath: 'Use.md', requestId: crypto.randomUUID()});
    assert.equal(response.result, 'y + 2');
    await h.runtime.restart({send: h.send});
    const retained = await h.send({type: 'expression', expression: 'sqrt(x^2)', notePath: 'Use.md', requestId: crypto.randomUUID()});
    assert.equal(retained.result, 'x');
});

test('plots accept formulas built from symbols with assumptions', async t => {
    const h = await pythonHarness(t);
    const source = '@symbol x real\nformula = x^2\n@plot formula\n@range x = -2, 2';
    h.set('Symbols.md', note([source])); const view = h.view('Symbols.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
});

test('equations and systems preserve symbols, render named solutions, and allow reuse', async t => {
    const h = await pythonHarness(t);
    const source = '@symbol x real\n@symbol y real\nfirst = Eq(x+y, 5)\nsecond = Eq(x-y, 1)\nsolutions = solve([first, second], [x,y], dict=True)\nsolutions[0][x]\nsubs(x+y, solutions[0])';
    h.set('Equations.md', note([source]));
    const view = h.view('Equations.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    assert.match(view.el.output(), /x = 3/);
    assert.match(view.el.output(), /y = 2/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Equations.md', requestId: crypto.randomUUID()});
    assert.equal((await send('x')).result, 'x');
    assert.equal((await send('solutions[0][x]')).result, '3');
    assert.equal((await send('subs(x+y, solutions[0])')).result, '5');
    assert.match((await send('solve([Eq(x+y, 1), Eq(x+y, 2)], [x,y], dict=True)')).result, /left\[.*right\]/);
    assert.match((await send('linsolve([x+y-5], (x,y))')).result, /y/);
    assert.match((await send('nonlinsolve([x^2+y^2-5, x-y-1], (x,y))')).result, /2/);
    assert.match((await send('solveset(x^2+1, x, domain=S.Reals)')).result, /emptyset/);
});

test('solution dictionaries and numerical root vectors respect decimal places', async t => {
    const h = await pythonHarness(t);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Roots.md', requestId: crypto.randomUUID(), decimalPlaces: 3});
    const exact = await send('solve(x^2-2, x, dict=True)');
    assert.match(exact.result, /x = -1\.414/);
    assert.match(exact.result, /x = 1\.414/);
    assert.equal((await send('nsolve(cos(x)-x, x, 1)')).result, '0.739');
    const vector = await send('nsolve([x+y-5, x-y-1], [x,y], [1,1])');
    assert.match(vector.result, /3\.000/); assert.match(vector.result, /2\.000/);
    const failure = await send('nsolve(x^2+1, x, 1)');
    assert.equal(typeof failure.error, 'string');
    assert.equal((await send('2+3')).result, '5.000');
});

test('global equation lists and solution containers resolve and refresh across notes', async t => {
    const h = await pythonHarness(t);
    h.set('Definitions.md', note(['@global @symbol x real\n@global @symbol y real\n@global equations = [Eq(x+y, 5), Eq(x-y, 1)]\n@global solutions = solve(equations, [x,y], dict=True)']));
    const index = await h.indexGlobals(t);
    const source = 'solutions[0][x]';
    h.set('Use.md', note([source])); const view = h.view('Use.md', source, 0); await view.ready;
    assert.equal(view.el.output(), '3');
    index.update('Definitions.md', note(['@global @symbol x real\n@global @symbol y real\n@global equations = [Eq(x+y, 7), Eq(x-y, 1)]\n@global solutions = solve(equations, [x,y], dict=True)']).text);
    await h.runtime.refreshGlobals();
    assert.equal(view.el.output(), '4');
});

test('positive assumptions restrict symbolic roots and solving does not assign them', async t => {
    const h = await pythonHarness(t);
    const source = '@symbol x positive\nsolve(Eq(x^2, 4), x, dict=True)\nx';
    h.set('Positive.md', note([source])); const view = h.view('Positive.md', source, 0); await view.ready;
    assert.match(view.el.output(), /x = 2/);
    assert.doesNotMatch(view.el.output(), /-2/);
    const value = await h.send({type: 'expression', expression: 'x', notePath: 'Positive.md', requestId: crypto.randomUUID()});
    assert.equal(value.result, 'x');
});

test('matrix arithmetic, transpose, inverses and vector operations retain exact values', async t => {
    const h = await pythonHarness(t);
    h.showSteps(true);
    const source = 'A = Matrix([[1,2],[3,4]])\nv = Matrix([5,6])\nw = A*v\nB = A.inv()\nA*B\nA.T';
    h.set('Matrices.md', note([source])); const view = h.view('Matrices.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Matrices.md', requestId: crypto.randomUUID()});
    assert.equal((await send('w[0]')).result, '17');
    assert.equal((await send('w[1]')).result, '39');
    assert.equal((await send('(A*B-eye(2)).norm()')).result, '0');
    assert.equal((await send('(A+A-2*A).norm()')).result, '0');
    assert.equal((await send('A.T[0,1]')).result, '3');
    assert.equal((await send('det(A)')).result, '-2');
    assert.equal((await send('A.rank()')).result, '2');
    assert.equal((await send('A.trace()')).result, '5');
    assert.equal((await send('Matrix([1,2,3]).dot(Matrix([4,5,6]))')).result, '32');
    assert.equal((await send('Matrix([1,0,0]).cross(Matrix([0,1,0]))[2]')).result, '1');
    assert.equal((await send('(A*A.LUsolve(v)-v).norm()')).result, '0');
});

test('eigenvalue multiplicities are not displayed as equalities and matrix errors recover', async t => {
    const h = await pythonHarness(t);
    const send = expression => h.send({type: 'expression', expression, notePath: 'MatrixErrors.md', requestId: crypto.randomUUID(), decimalPlaces: 3});
    const eigen = await send('diag(2,2,3).eigenvals()');
    assert.match(eigen.result, /2\.000.*multiplicity.*2/);
    assert.match(eigen.result, /3\.000.*multiplicity.*1/);
    assert.doesNotMatch(eigen.result, / = /);
    const vectors = await send('diag(2,3).eigenvects()');
    assert.equal(vectors.error, undefined);
    assert.match(vectors.result, /matrix/);
    for (const expression of ['Matrix([[1,2],[2,4]]).inv()', 'Matrix([[1,2],[3]])', 'eye(2)*Matrix([1,2,3])']) {
        assert.equal(typeof (await send(expression)).error, 'string');
    }
    assert.equal((await send('2+3')).result, '5.000');
});

test('global matrices and symbolic entry substitutions work across notes', async t => {
    const h = await pythonHarness(t);
    h.set('Definitions.md', note(['@global @symbol x real\n@global A = Matrix([[x,0],[0,2]])']));
    await h.indexGlobals(t);
    h.set('Use.md', note(['subs(A, x, 3).det()']));
    const view = h.view('Use.md', 'subs(A, x, 3).det()', 0); await view.ready;
    assert.equal(view.el.output(), '6');
});

test('first-order ODE solutions and initial conditions work with substitution steps enabled', async t => {
    const h = await pythonHarness(t);
    h.showSteps(true);
    const source = '@symbol t\ny = Function("y")\node = Eq(diff(y(t), t), y(t))\nsolution = dsolve(ode, y(t), ics={y(0): 2})\nsubs(solution.rhs, t, 0)';
    h.set('ODE.md', note([source])); const view = h.view('ODE.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    assert.doesNotMatch(view.el.output(), /unknown function/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'ODE.md', requestId: crypto.randomUUID()});
    assert.equal((await send('subs(solution.rhs, t, 0)')).result, '2');
    assert.equal((await send('simplify(diff(solution.rhs,t)-solution.rhs)')).result, '0');
    assert.match((await send('dsolve(ode, y(t))')).result, /C_\{1\}/);
    assert.match((await send('y(t)')).result, /y/);
});

test('second-order ODEs accept derivative initial conditions and malformed ODEs recover', async t => {
    const h = await pythonHarness(t);
    const source = '@symbol t\ny = Function("y")\node = Eq(diff(y(t), t, 2) + y(t), 0)\nsolution = dsolve(ode, y(t), ics={y(0): 0, diff(y(t), t).subs(t, 0): 1})';
    h.set('Oscillator.md', note([source])); const view = h.view('Oscillator.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Oscillator.md', requestId: crypto.randomUUID()});
    assert.equal((await send('simplify(solution.rhs-sin(t))')).result, '0');
    assert.equal((await send('subs(diff(solution.rhs,t), t, 0)')).result, '1');
    assert.equal(typeof (await send('dsolve(t+1, y(t))')).error, 'string');
    assert.equal((await send('2+3')).result, '5');
});

test('coupled ODEs return reusable equation lists', async t => {
    const h = await pythonHarness(t);
    const source = '@symbol t\nu = Function("u")\nv = Function("v")\nsolutions = dsolve([Eq(diff(u(t),t),v(t)), Eq(diff(v(t),t),u(t))], [u(t),v(t)], ics={u(0): 1, v(0): 0})';
    h.set('System.md', note([source])); const view = h.view('System.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'System.md', requestId: crypto.randomUUID()});
    assert.equal((await send('subs(solutions[0].rhs, t, 0)')).result, '1');
    assert.equal((await send('subs(solutions[1].rhs, t, 0)')).result, '0');
    assert.equal((await send('simplify(diff(solutions[0].rhs,t)-solutions[1].rhs)')).result, '0');
});

test('global initial-value ODE solutions can be plotted from another note', async t => {
    const h = await pythonHarness(t);
    h.set('Definitions.md', note(['@global @symbol t\n@global y = Function("y")\n@global ode = Eq(diff(y(t),t), y(t))\n@global solution = dsolve(ode, y(t), ics={y(0): 2})']));
    await h.indexGlobals(t);
    const source = '@plot solution.rhs\n@range t = 0, 2';
    h.set('Plot.md', note([source])); const view = h.view('Plot.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
});

test('plot axis controls render, refresh, and preserve the download image', async t => {
    const h = await pythonHarness(t);
    let source = '@plot x^2\n@range x = 0.1, 100\n@xscale log\n@yscale log\n@yrange 0.01, 10000\n@aspect equal';
    h.set('Axes.md', note([source])); let view = h.view('Axes.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
    const image = view.el.children[0].attributes.src;
    const options = h.sent.findLast(r => r.type === 'plot').options;
    assert.equal(options.xrangeScale, 'log');
    assert.equal(options.yrangeScale, 'log');
    assert.deepEqual(options.yrange, [0.01, 10000]);
    assert.equal(options.aspect, 'equal');
    view.unload();
    source = source.replace('@aspect equal', '@aspect auto');
    const data = note([source]); h.set('Axes.md', data); await h.runtime.updateNote('Axes.md', data.text, data.metadata);
    view = h.view('Axes.md', source, 0); await view.ready;
    assert.notEqual(view.el.children[0].attributes.src, image);
    assert.ok(view.el.children[0].attributes['data-pymath-download'].endsWith('.png'));
});

test('invalid axis controls report errors and log plots omit nonpositive samples', async t => {
    const h = await pythonHarness(t);
    for (const [source, expected] of [
        ['@plot x\n@range x = -1, 1\n@xscale log', /positive range/],
        ['@plot -x\n@range x = 1, 10\n@yscale log', /positive, finite/],
        ['@plot x\n@range x = 1, 10\n@yscale log\n@yrange 0, 10', /positive vertical/],
        ['@plot x\n@range x = 1, 10\n@yrange 2, 1', /Line 3/],
        ['@plot x\n@range x = 1, 10\n@aspect square', /Aspect/],
        ['@plot x\n@range x = 1, 10\n@xscale invalid', /Axis scale/],
    ]) {
        const data = note([source]); h.set('Axes.md', data); await h.runtime.updateNote('Axes.md', data.text, data.metadata);
        const view = h.view('Axes.md', source, 0); await view.ready;
        assert.match(view.el.output(), expected); view.unload();
    }
    const source = '@plot x\n@range x = -1, 1\n@yscale log';
    const data = note([source]); h.set('Axes.md', data); await h.runtime.updateNote('Axes.md', data.text, data.metadata);
    const view = h.view('Axes.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
});

test('parametric and polar plots render with styles and downloadable PNGs', async t => {
    const h = await pythonHarness(t);
    for (const [source, mode] of [
        ['@parametric cos(t), sin(t) {Circle}\n@parametric 2*cos(t), 2*sin(t) {Outer}\n@range t = 0, 2*pi\n@aspect equal\n@style 2 dashed', 'parametric'],
        ['@polar 1 + cos(t) {Cardioid}\n@range t = 0, 2*pi\n@yrange 0, 2', 'polar'],
        ['@parametric 1, t\n@range t = -2, 2', 'parametric'],
    ]) {
        const data = note([source]); h.set('Curves.md', data);
        await h.runtime.updateNote('Curves.md', data.text, data.metadata);
        const view = h.view('Curves.md', source, 0); await view.ready;
        assert.equal(view.el.children[0].tagName, 'img', view.el.output());
        assert.ok(view.el.children[0].attributes['data-pymath-download'].endsWith('.png'));
        assert.equal(h.sent.findLast(r => r.type === 'plot').mode, mode);
        view.unload();
    }
});

test('parametric second-coordinate globals refresh and invalid plot kinds show errors', async t => {
    const h = await pythonHarness(t);
    h.set('Globals.md', note(['@global height = 1']));
    const index = await h.indexGlobals(t);
    const source = '@parametric cos(t), height*sin(t)\n@range t = 0, 2*pi\n@aspect equal';
    h.set('Curves.md', note([source])); const view = h.view('Curves.md', source, 0); await view.ready;
    const image = view.el.children[0].attributes.src;
    index.update('Globals.md', note(['@global height = 2']).text); await h.runtime.refreshGlobals();
    assert.notEqual(view.el.children[0].attributes.src, image); view.unload();
    for (const [bad, expected] of [
        ['@parametric cos(t)\n@range t = 0, 1', /x-expression, y-expression/],
        ['@parametric t, missing\n@range t = 0, 1', /Undefined plot/],
        ['@plot t\n@polar t\n@range t = 0, 1', /one plot kind/],
        ['@polar t\n@range t = 0, 1\n@yscale log', /linear axes/],
        ['@polar 1\n@range t = 0, 1\n@yrange -1, 2', /nonnegative/],
    ]) {
        const data = note([bad]); h.set('Curves.md', data); await h.runtime.updateNote('Curves.md', data.text, data.metadata);
        const output = h.view('Curves.md', bad, 0); await output.ready;
        assert.match(output.el.output(), expected); output.unload();
    }
});

test('unit quantities propagate, convert, and preserve exact arithmetic and old labels', async t => {
    const h = await pythonHarness(t);
    h.showSteps(true);
    const source = 'distance = unit(100, "m")\nduration = unit(10, "s")\nspeed = distance/duration\nconvert(speed, "km/h")\nlegacy = 10 [m/s]';
    h.set('Units.md', note([source])); const view = h.view('Units.md', source, 0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:/);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Units.md', requestId: crypto.randomUUID()});
    assert.equal((await send('magnitude(speed, "km/h")')).result, '36');
    assert.equal((await send('magnitude(unit(1,"m")+unit(20,"cm"),"m")')).result, '1.2');
    assert.equal((await send('magnitude(unit(2,"kg")*unit(3,"m/s^2"),"N")')).result, '6');
    assert.equal((await send('magnitude(unit(1,"kPa"),"Pa")')).result, '1000');
    assert.equal((await send('magnitude(unit(1,"kJ"),"J")')).result, '1000');
    assert.equal((await send('unit(1,"m")/unit(100,"cm")')).result, '1');
    assert.equal((await send('legacy*2')).result, '20');
});

test('incompatible unit operations fail and later independent calculations recover', async t => {
    const h = await pythonHarness(t);
    const send = expression => h.send({type: 'expression', expression, notePath: 'Units.md', requestId: crypto.randomUUID()});
    for (const expression of ['unit(1,"m")+unit(1,"s")', 'convert(unit(1,"m"),"s")', 'sin(unit(1,"m"))', 'unit(1,"Celsius")']) {
        assert.equal(typeof (await send(expression)).error, 'string', expression);
    }
    assert.equal((await send('2+3')).result, '5');
    const formatted = await h.send({type: 'expression', expression: 'convert(unit(1,"m"),"km")', decimalPlaces: 4, notePath: 'Units.md', requestId: crypto.randomUUID()});
    assert.match(formatted.result, /0.0010/);
});

test('global quantities and unit-bearing functions support magnitude plots', async t => {
    const h = await pythonHarness(t);
    h.set('Definitions.md', note(['@global acceleration = unit(2,"m/s^2")\n@global velocity(t) = acceleration*unit(t,"s")']));
    await h.indexGlobals(t);
    const source = '@plot magnitude(velocity(t), "m/s")\n@range t = 0, 5';
    h.set('Plot.md', note([source])); const view = h.view('Plot.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img', view.el.output());
});

test('declarations leave no empty rows and equation storage names stay hidden', async t => {
    const h = await pythonHarness(t);
    const source = '@symbol x real\n@symbol y real\nfirst = Eq(x+y,5)\nsecond = Eq(x-y,1)\nsolve([first,second],[x,y],dict=True)';
    h.set('Clean.md', note([source])); const view = h.view('Clean.md',source,0); await view.ready;
    assert.equal(view.el.children.length,3);
    assert.doesNotMatch(view.el.output(), /symbol:|first|second/);
    assert.match(view.el.output(), /x \+ y = 5/);
    assert.match(view.el.output(), /x = 3/);
});

test('braced subscript variables evaluate, display and resolve global references', async t => {
    const h = await pythonHarness(t);
    h.set('Defs.md', note(['@global p_{n,1} = 4']));
    await h.indexGlobals(t);
    const source = 'p_{long text} = p_{n,1} + 2\np_{long text}*2\nf(x_{a,b}) = x_{a,b}^2\nf(3)';
    h.set('Subscripts.md', note([source])); const view = h.view('Subscripts.md',source,0); await view.ready;
    assert.doesNotMatch(view.el.output(), /PyMath:|pymathsub/);
    assert.match(view.el.output(), /12/);
    assert.match(view.el.output(), /9/);
});


test('powered display unit labels render superscripts and do not affect evaluation', async t => {
    const h = await pythonHarness(t);
    const source = 'mass = 938.27 [MeV/c^2]\nmass*2\n3 [m s^{-2}]';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /\\text\{MeV\/c\}\^\{2\}/);
    assert.match(view.el.output(), /1876[.]54/);
    assert.match(view.el.output(), /\\text\{m s\}\^\{-2\}/);
    assert.doesNotMatch(view.el.output(), /PyMath:|textasciicircum/);
});


test('numeric assignments omit redundant steps while dependent formulas retain them', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    const source = 'mass = 9.109*10^-31 [kg]\nc = 299800000.0\np = 1.0072764666\nx = 3\ny = x*2';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    const lines = view.el.output().split('|');
    for (const line of lines.slice(0, 4)) assert.equal(line.split(' = ').length, 2, line);
    assert.match(lines[0], /\\text\{kg\}/);
    assert.match(lines[4], /y = .*x.* = .*3.* = 6/);
});

test('optional step units use local and closed-note global labels and clear on reassignment', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    h.display({ precision: 12, numberFormat: 'automatic', showUnitsInSteps: true });
    h.set('Globals.md', note(['@global distance = 10 [m]'])); await h.indexGlobals(t);
    const source = 'time = 2 [s]\nspeed = distance/time\ndistance = 4\nother = distance/time';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    let lines = view.el.output().split('|');
    assert.match(lines[1], /\\text\{m\}/);
    assert.match(lines[1], /\\text\{s\}/);
    assert.match(lines[1], / = 5$/);
    assert.doesNotMatch(lines[3], /\\text\{m\}/);
    assert.match(lines[3], /\\text\{s\}/);
    h.display({ precision: 12, numberFormat: 'automatic', showUnitsInSteps: false });
    await h.runtime.refreshGlobals();
    lines = view.el.output().split('|');
    assert.doesNotMatch(lines[1], /\\text/);
    assert.match(lines[1], / = 5$/);
});


test('dataset display labels survive assignments, globals and inline substitution without changing arithmetic', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    h.display({ precision: 12, numberFormat: 'automatic', showUnitsInSteps: true });
    h.set('Globals.md', note(['@global mass = label(4.0026, "u")'])); await h.indexGlobals(t);
    const source = 'localmass = label(3.016, "u")\nx = mass + localmass\ny = 2*label(3.016, "u")';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    const lines = view.el.output().split('|');
    assert.match(lines[0], /\\text\{u\}/);
    assert.equal(lines[0].split(' = ').length, 2);
    assert.match(lines[1], /\\text\{u\}.*\\text\{u\}.* = 7.0186$/);
    assert.match(lines[2], /\\text\{u\}.* = 6.032$/);
    assert.doesNotMatch(view.el.output(), /PyMath:|Dummy|label/);
});


test('export contexts without section positions render duplicate blocks in note order', async t => {
    const h = await pythonHarness(t);
    h.set('A.md', note(['x = 2', 'x', 'x = 7', 'x']));
    const first = h.view('A.md', 'x', null, 'pdf');
    const second = h.view('A.md', 'x', null, 'pdf');
    const separateExport = h.view('A.md', 'x', null, 'another-pdf');
    await Promise.all([first.ready, second.ready, separateExport.ready]);
    assert.equal(first.el.output(), '2');
    assert.equal(second.el.output(), '7');
    assert.equal(separateExport.el.output(), '2');
    const missing = h.view('A.md', 'z+1', null, 'pdf'); await missing.ready;
    assert.match(missing.el.output(), /Could not locate/);
});

test('export contexts await plot images without section positions', async t => {
    const h = await pythonHarness(t);
    const source = '@plot x^2\n@range x = 0, 2';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, null, 'pdf'); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
    assert.match(view.el.children[0].attributes.src, /^data:image\/png;base64,/);
});

test('block steps directives override both global settings and edits invalidate cached display', async t => {
    const h = await pythonHarness(t);
    const on = '@steps on # show work\nx = 3\ny = x*2';
    const off = '@steps off\nz = x*3';
    h.set('A.md', note([on, off]));
    const a = h.view('A.md', on, 0);
    const b = h.view('A.md', off, note([on, off]).starts[1]);
    await Promise.all([a.ready, b.ready]);
    assert.match(a.el.output(), /y = .*x.* = .*3.* = 6/);
    assert.equal(b.el.output(), 'z = 9');
    h.showSteps(true); await h.runtime.refreshGlobals();
    assert.equal(b.el.output(), 'z = 9');
    const changed = on.replace('@steps on', '@steps off');
    const data = note([changed, off]); h.set('A.md', data);
    await h.runtime.updateNote('A.md', data.text, data.metadata);
    const c = h.view('A.md', changed, 0); await c.ready;
    assert.equal(c.el.output(), 'x = 3|y = 6');
    const invalid = '@steps maybe\nq = (';
    h.set('B.md', note([invalid]));
    const d = h.view('B.md', invalid, 0); await d.ready;
    assert.match(d.el.output(), /Line 1: Use @steps on or @steps off/);
    assert.match(d.el.output(), /Line 2:/);
});


test('LaTeX variable names and nested subscript names evaluate and render without encoded identifiers', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    h.set('Globals.md', note([String.raw`@global {\Delta m} = 3`])); await h.indexGlobals(t);
    const source = String.raw`p_{\mathrm{out}} = 2
energy = {\Delta m}*p_{\mathrm{out}}
{\Delta m}
`;
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.match(view.el.output(), /\\Delta m/);
    assert.match(view.el.output(), /p_\{\\mathrm\{out\}\}/);
    assert.match(view.el.output(), / = 6/);
    assert.doesNotMatch(view.el.output(), /PyMath:|pymathsub/);
});


test('inline labels appear in the first step without a units-only intermediate step', async t => {
    const h = await pythonHarness(t); h.showSteps(true);
    h.display({ precision: 12, numberFormat: 'automatic', decimalPlaces: 3, showUnitsInSteps: true });
    const source = 'Δm_react = 2label(2.0141017780, "u")';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    const steps = view.el.output().split(' = ');
    assert.equal(steps.length, 3, view.el.output());
    assert.match(steps[1], /2.*2[.]014.*\\text\{u\}/);
    assert.equal(steps[2], '4.028');
});

test('pi tick directives render and reject unsupported formats and log axes', async t => {
    const h = await pythonHarness(t);
    const source = '@plot sin(x)\n@range x = 0, 2*pi\n@xticks pi';
    h.set('A.md', note([source]));
    const view = h.view('A.md', source, 0); await view.ready;
    assert.equal(view.el.children[0].tagName, 'img');
    for (const [suffix, error] of [['@xticks degrees', /Tick format/], ['@xticks pi\n@xscale log', /linear axis/]]) {
        const invalid = '@plot x\n@range x = 1, 10\n'+suffix;
        h.set('B.md', note([invalid]));
        const data = note([invalid]); await h.runtime.updateNote('B.md', data.text, data.metadata);
        const bad = h.view('B.md', invalid, 0); await bad.ready;
        assert.match(bad.el.output(), error);
    }
});
