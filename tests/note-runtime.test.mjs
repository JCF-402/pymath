import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';

// Node needs a browser timer shim for the runtime under test.
globalThis.window = { setTimeout, clearTimeout };

// Exercise the real runtime and Python backend, replacing only Obsidian's UI API.
const obsidianStub = `
export class TFile {
    constructor(path) { this.path = path; this.stat = { mtime: 1, size: 0 }; }
    get extension() { return this.path.split('.').at(-1); }
}
export class MarkdownRenderChild {
    callbacks = [];
    constructor(el) { this.containerEl = el; }
    register(callback) { this.callbacks.push(callback); }
    unload() { for (const callback of this.callbacks) callback(); }
}
export async function loadMathJax() {}
export async function finishRenderMath() {}
export function renderMath(source) { return { latex: source }; }
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
    createDiv() { const child = new Element(); this.children.push(child); return child; }
    appendChild(child) { this.children.push(child); }
    output() { return [this.text, ...this.children.map(c => c.latex ?? c.output())].filter(Boolean).join('|'); }
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
    let blocks = {}, showSteps = false, reads = 0, globals;
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
    function view(path, source, start) {
        const el = new Element();
        const children = [];
        const context = {
            sourcePath: path,
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
    assert.equal(view.el.output(), '14');
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
    assert.equal((await h.send({requestId:'probe-b',notePath:'B.md',type:'expression',expression:'f(2)'})).result, '7');
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
    assert.equal(view.el.output(), '8');
    const fresh = await pythonHarness(t);
    h.transport.close(); h.child.kill();
    await h.runtime.restart(fresh.transport);
    assert.equal(view.el.output(), '8');
    assert.deepEqual(fresh.sent.map(r=>r.type), ['reset-note','assignment','function','expression']);
    const edited = note(['x = 10\nf(t) = t + x', 'f(3)']); h.set('A.md', edited);
    await h.runtime.updateNote('A.md', edited.text, edited.metadata);
    assert.equal(view.el.output(), '13');
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
    assert.equal(view.el.output(), '18');
    assert.ok(h.sent.every(request => request.notePath === 'Consumer.md'));

    const updated = note(['@global c = 4']); h.set('Constants.md', updated);
    index.update('Constants.md', updated.text);
    // Exercise the debounced automatic callback, without calling refresh ourselves.
    for (let attempt = 0; attempt < 100 && view.el.output() !== '32'; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, 10));
    }
    assert.equal(view.el.output(), '32');
    assert.ok(!view.el.messages.includes('Calculating…'));

    h.remove('Binding.md'); index.removePath('Binding.md');
    await h.runtime.refreshGlobals();
    assert.notEqual(view.el.output(), '32', 'deleted definitions must not remain callable');
});

test('global functions resolve forward references, local overrides stay local, and parameters shadow globals', async t => {
    const h = await pythonHarness(t);
    h.set('A.md', note(['@global energy(m) = scale(m)*c^2\n@global scale(m) = m*2']));
    h.set('Z.md', note(['@global c = 3\n@global m = 100\n@global π_1 = 7']));
    await h.indexGlobals(t);
    h.set('Use.md', note(['c = 10\nenergy(2)\nc\nπ_1']));
    const view = h.view('Use.md', 'c = 10\nenergy(2)\nc\nπ_1', 0); await view.ready;
    assert.equal(view.el.output(), 'c = 10|36|10|7');
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
    assert.equal(view.el.output(), '10');
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
    assert.match(view.el.output(), /\|3\|8$/);
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
    assert.match(view.el.output(), /\|6$/);
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
