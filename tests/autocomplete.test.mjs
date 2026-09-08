import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({
    stdin: { contents: `export * from './src/autocomplete'; export * from './src/editor-suggest';`,
        resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'obsidian-stub', setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents:
            'export async function loadMathJax() {} export function renderMath(latex) { return {latex}; } export class EditorSuggest { context = null; close() { this.closed = true; } }', loader: 'js' }));
    } }],
});
const { completionQuery, mathSuggestions, PyMathSuggest } =
    // eslint-disable-next-line no-unsanitized/method -- Import locally bundled code and a fixed UI stub.
    await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const note = source => '```pymath\n' + source + '\n```';
const global = (variable, notePath = 'Constants.md') => ({ type: 'assignment', scope: 'global', variable, expression: '5', notePath, line: 2 });

test('queries accept Unicode names and avoid definitions, strings, comments, numbers and directives', () => {
    for (const text of ['π_1', 'φ1', '2*ener', '@global energy = sc']) {
        assert.ok(completionQuery(text, text.length));
    }
    for (const text of ['123', '# ene', '"ene', '@glo']) assert.equal(completionQuery(text, text.length), null);
    assert.equal(completionQuery('energy = 3', 3), null);
    assert.equal(completionQuery('f(energy) = energy', 5), null);
});

test('locals come from earlier blocks in the live buffer and override globals; later locals stay hidden', () => {
    const text = note('scale = 4\nspeed(t) = t*2') + '\n' + note('sc\nsecret = 8');
    const results = mathSuggestions(text, 'Use.md', 5, 's', [global('scale'), global('shared')]);
    assert.deepEqual(results.filter(item => item.scope !== 'builtin').map(item => [item.name, item.scope]), [['scale', 'local'], ['speed', 'local'], ['shared', 'global']]);
    assert.deepEqual(results[1].parameters, ['t']);
});

test('current-note globals replace stale index entries, include forward declarations and omit conflicts', () => {
    const text = note('ne\n@global newer = 2');
    const results = mathSuggestions(text, 'Use.md', 1, '', [global('old', 'Use.md'), global('external')]);
    assert.deepEqual(results.filter(item => item.scope !== 'builtin').map(item => item.name), ['external', 'newer']);
    assert.deepEqual(mathSuggestions(note('du'), 'Use.md', 1, 'du', [global('duplicate'), global('duplicate', 'Other.md')]), []);
});

test('global function bodies exclude note locals, and their parameters shadow global names', () => {
    const text = note('local = 3\n@global f(scale) = sc');
    const results = mathSuggestions(text, 'Use.md', 2, '', [global('scale'), global('other')]);
    assert.ok(!results.some(item => item.name === 'local'));
    assert.equal(results.find(item => item.name === 'scale').scope, 'parameter');
});

function editor(text, line, ch) {
    return {
        text, cursor: { line, ch }, selected: false,
        getValue() { return this.text; }, getLine(line) { return this.text.split('\n')[line]; },
        getCursor() { return this.cursor; }, somethingSelected() { return this.selected; },
        getRange(start, end) { return this.getLine(start.line).slice(start.ch, end.ch); },
        replaceRange(value, start, end) {
            const lines = this.text.split('\n');
            lines[start.line] = lines[start.line].slice(0, start.ch) + value + lines[end.line].slice(end.ch);
            this.text = lines.join('\n');
        },
        setCursor(cursor) { this.cursor = cursor; },
    };
}
function suggest() {
    return new PyMathSuggest({}, { ready: Promise.resolve(), getDefinitions: () => [global('scale')] });
}

test('editor triggers only in PyMath content, excluding other fences, prose and commented examples', () => {
    for (const text of ['ordinary scale', '```js\nscale\n```', '<!--\n```pymath\nscale\n```\n-->']) {
        const line = text.split('\n').findIndex(line => line.includes('scale'));
        const e = editor(text, line, eLength(text, line));
        assert.equal(suggest().onTrigger(e.cursor, e, { path: 'Use.md' }), null);
    }
    const e = editor(note('sc'), 1, 2), s = suggest();
    const trigger = s.onTrigger(e.cursor, e, { path: 'Use.md' });
    assert.equal(trigger.query, 'sc');
    e.selected = true; assert.equal(s.onTrigger(e.cursor, e, { path: 'Use.md' }), null);
});
function eLength(text, line) { return text.split('\n')[line].length; }

test('function selection replaces identifier suffix, inserts parentheses and positions the cursor', () => {
    const e = editor(note('enOld + 2'), 1, 2), s = suggest();
    s.context = { ...s.onTrigger(e.cursor, e, { path: 'Use.md' }), editor: e, file: { path: 'Use.md' } };
    s.selectSuggestion({ name: 'energy', parameters: ['mass'], scope: 'global' });
    assert.equal(e.getLine(1), 'energy() + 2'); assert.equal(e.cursor.ch, 7); assert.equal(s.closed, true);
});

test('existing calls keep their arguments and stale suggestions cannot edit a moved cursor', () => {
    const e = editor(note('en(2)'), 1, 2), s = suggest();
    s.context = { ...s.onTrigger(e.cursor, e, { path: 'Use.md' }), editor: e };
    s.selectSuggestion({ name: 'energy', parameters: ['mass'], scope: 'global' });
    assert.equal(e.getLine(1), 'energy(2)');
    e.text = note('en'); e.cursor.ch = 2;
    s.context = { ...s.onTrigger(e.cursor, e, { path: 'Use.md' }), editor: e };
    e.cursor = { line: 1, ch: 1 };
    s.selectSuggestion({ name: 'energy', parameters: [], scope: 'global' });
    assert.equal(e.getLine(1), 'en');
});

test('suggestion provider uses indexed globals and renders signatures and provenance as text', async () => {
    const e = editor(note('sc'), 1, 2), s = suggest();
    const context = { ...s.onTrigger(e.cursor, e, { path: 'Use.md' }), editor: e, file: { path: 'Use.md' } };
    const results = await s.getSuggestions(context);
    assert.equal(results[0].name, 'scale');
    const rows = [];
    s.renderSuggestion({ name: 'energy', parameters: ['m'], scope: 'global', notePath: 'Physics.md' }, { createDiv: row => rows.push(row) });
    assert.equal(rows[0].text, 'energy(m)'); assert.equal(rows[1].text, 'Global · Physics.md');
});

test('built-ins have signatures and descriptions and user definitions override them', () => {
    const suggestions = mathSuggestions(note('sq'), 'A.md', 1, 'sq', []);
    assert.equal(suggestions[0].name, 'sqrt');
    assert.deepEqual(suggestions[0].parameters, ['x']);
    assert.ok(suggestions[0].description);
    const local = mathSuggestions(note('sin = 5\nsi'), 'A.md', 2, 'si', []);
    assert.equal(local[0].name, 'sin'); assert.equal(local[0].scope, 'local');
    assert.equal(local.filter(item => item.name === 'sin').length, 1);
    assert.equal(local[0].parameters, undefined);
    const globals = mathSuggestions(note('pi'), 'A.md', 1, 'pi', [global('pi')]);
    assert.equal(globals[0].scope, 'global');
    const duplicate = mathSuggestions(note('pi'), 'A.md', 1, 'pi', [global('pi'), global('pi', 'Other.md')]);
    assert.deepEqual(duplicate, []);
});

test('built-in selection inserts calls but constants remain bare names', () => {
    for (const [query, result, cursor] of [['sq', 'sqrt()', 5], ['pi', 'pi', 2]]) {
        const e = editor(note(query), 1, query.length), s = suggest();
        s.context = { ...s.onTrigger(e.cursor, e, { path: 'A.md' }), editor: e };
        const item = mathSuggestions(e.text, 'A.md', 1, query, [])[0];
        s.selectSuggestion(item);
        assert.equal(e.getLine(1), result); assert.equal(e.cursor.ch, cursor);
    }
    const rows = [];
    suggest().renderSuggestion(mathSuggestions(note('sq'), 'A.md', 1, 'sq', [])[0], { createDiv: row => rows.push(row) });
    assert.equal(rows[1].text, 'Built-in · Principal square root');
});

test('equation tags describe local and global suggestions without changing insertion names', () => {
    const text = note('localSpeed = 2 {Local speed}\nlo');
    const local = mathSuggestions(text, 'A.md', 2, 'lo', [])[0];
    assert.equal(local.name, 'localSpeed'); assert.equal(local.tag, 'Local speed');
    const entry = { ...global('velocity'), tag: 'Fluid velocity' };
    const item = mathSuggestions(note('vel'), 'A.md', 1, 'vel', [entry])[0];
    const rows = []; suggest().renderSuggestion(item, { createDiv: row => rows.push(row) });
    assert.equal(rows[0].text, 'velocity'); assert.equal(rows[1].text, 'Fluid velocity');
    assert.match(rows[2].text, /Constants.md/);
});

test('dataset suggestions search by name and insert only the original numeric literal', async () => {
    const item = { name: 'He_4_2', scope: 'dataset', insertText: '4.002603249700000000001', description: 'Helium-4 · u' };
    const s = new PyMathSuggest({}, { ready: Promise.resolve(), getDefinitions: () => [] }, { ready: Promise.resolve(), items: [item] });
    const e = editor(note('He'), 1, 2);
    s.context = { ...s.onTrigger(e.cursor, e, { path: 'A.md' }), editor: e, file: { path: 'A.md' } };
    const rows = await s.getSuggestions(s.context);
    assert.ok(rows.includes(item)); s.selectSuggestion(item);
    assert.equal(e.getLine(1), item.insertText); assert.equal(e.cursor.ch, item.insertText.length);
});

test('dataset isotope names render inline LaTeX with mass and atomic numbers', () => {
    const rows = [];
    const el = { createDiv(options) {
        const row = { ...options, appendChild(child) { this.math = child; }, setText(text) { this.text = text; } };
        rows.push(row); return row;
    } };
    suggest().renderSuggestion({ name: 'He_4_2', scope: 'dataset', insertText: '4.0026032497', description: 'Mass in u' }, el);
    assert.equal(rows[0].math.latex, '{}^{4}_{2}\\mathrm{He}');
    assert.equal(rows[1].text, 'Mass in u');
});
