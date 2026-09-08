import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

globalThis.window = { setTimeout, clearTimeout };
const compiled = await build({
    stdin: { contents: `export * from './src/vault-globals'; export * from './src/parser'; export * from './src/block-data';`,
        resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
});
const { VaultGlobals, extractGlobals, parseLine, validateSavedBlocks } =
    // eslint-disable-next-line no-unsanitized/method -- Import only locally bundled project code.
    await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

const note = source => '```pymath\n' + source + '\n```';

test('@global accepts Unicode variables and functions, rejects expressions, and survives saved-data validation', () => {
    assert.deepEqual(parseLine('@global φ1 = 3'), { type: 'assignment', variable: 'φ1', expression: '3', scope: 'global' });
    assert.deepEqual(parseLine('@global f(x) = x^2'), { type: 'function', name: 'f', parameters: ['x'], expression: 'x^2', scope: 'global' });
    assert.throws(() => parseLine('@global x+2'), /definition/);
    assert.throws(() => parseLine('@global'), /expression/);
    const block = { id: 'one', notePath: 'A.md', source: '', order: 0, lines: [parseLine('@global π_1 = 2')] };
    assert.deepEqual(validateSavedBlocks({ one: block }), { one: block });
    block.lines = [{ type: 'expression', expression: '1', scope: 'global' }];
    assert.deepEqual(validateSavedBlocks({ one: block }), {});
});

test('index scans PyMath fences only, skips frontmatter and outer examples, and reports original line numbers', () => {
    const text = ['---', 'example: |', '  ```pymath', '  @global fake = 1', '  ```', '---',
        '@global prose = 2', '````md', '```pymath', '@global example = 3', '```', '````',
        '~~~pymath', '@global π_1 = 4', 'local = 8', '@global f(x) = x*π_1', '~~~'].join('\n');
    const definitions = extractGlobals('A.md', text);
    assert.equal(definitions.length, 2); assert.equal(definitions[0].line, 14);
    assert.equal(definitions[0].variable, 'π_1'); assert.equal(definitions[1].name, 'f');
    assert.match(extractGlobals('A.md', note('@global c ='))[0].error, /expression/);
    assert.deepEqual(extractGlobals('A.md', '<!--\n' + note('@global hidden = 1') + '\n-->'), []);
});

function harness(t, files, read) {
    const app = { vault: { getMarkdownFiles: () => files, read } };
    let refreshes = 0;
    const index = new VaultGlobals(app, async () => { refreshes++; });
    t.after(() => index.close());
    return { index, refreshes: () => refreshes };
}

test('startup reads cannot overwrite a newer metadata event or resurrect deleted notes', async t => {
    const a = { path: 'A.md' }, b = { path: 'B.md' };
    const pending = new Map();
    const { index } = harness(t, [a, b], file => new Promise(resolve => pending.set(file.path, resolve)));
    index.update('A.md', note('@global c = 8')); index.removePath('B.md');
    pending.get('A.md')(note('@global c = 1')); pending.get('B.md')(note('@global d = 2'));
    await index.ready;
    assert.equal(index.getDefinitions().length, 1);
    assert.equal(index.getDefinitions()[0].expression, '8');
});

test('folder rename keeps definitions available, deletion respects path boundaries, prose does not invalidate globals', async t => {
    const files = [{ path: 'Folder/A.md' }, { path: 'Folder2/B.md' }];
    const { index } = harness(t, files, async file => note(file.path.startsWith('Folder/') ? '@global c = 1' : '@global d = 2'));
    await index.ready;
    const before = index.getDefinitions();
    index.update('Folder/A.md', note('@global c = 1') + '\nSome prose');
    assert.equal(index.getDefinitions(), before);
    files[0].path = 'Moved/A.md'; index.renamePath('Folder', 'Moved');
    assert.deepEqual(index.getDefinitions().map(d => d.notePath), ['Folder2/B.md', 'Moved/A.md']);
    index.removePath('Moved'); assert.deepEqual(index.getDefinitions().map(d => d.variable), ['d']);
});

test('renaming during an initial read indexes the new path and discards the old response', async t => {
    const file = { path: 'Old.md' }; let finishOld;
    const { index } = harness(t, [file], item => item.path === 'Old.md'
        ? new Promise(resolve => { finishOld = resolve; })
        : Promise.resolve(note('@global c = 4')));
    file.path = 'New.md'; index.renamePath('Old.md', 'New.md');
    finishOld(note('@global c = 1')); await index.ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(index.getDefinitions().map(d => [d.notePath, d.expression]), [['New.md', '4']]);
});

test('unload prevents a pending initial read from publishing definitions or scheduling work', async t => {
    let finish;
    const { index, refreshes } = harness(t, [{ path: 'A.md' }], () => new Promise(resolve => { finish = resolve; }));
    index.close(); finish(note('@global c = 1')); await index.ready;
    assert.deepEqual(index.getDefinitions(), []); assert.equal(refreshes(), 0);
});
