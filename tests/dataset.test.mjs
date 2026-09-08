import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({
    stdin: { contents: `export * from './src/dataset'; export {TFile} from 'obsidian';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'stub', setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class TFile { extension = "csv"; stat = {size: 20}; }', loader: 'js' }));
    } }],
});
const { csvRows, datasetSuggestions, datasetDefaults, Dataset, TFile } =
    // eslint-disable-next-line no-unsanitized/method -- Import locally bundled project code and fixed mocks.
    await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const csv = 'N,Z,A,El,mass_u\n1,2,3,He,3.0160293097\n2,2,4,He,4.0026032497\n';
const config = { ...datasetDefaults, datasetPath: 'Data/isotopes.csv' };

test('CSV supports BOM, CRLF, quoted commas, escaped quotes and multiline fields', () => {
    assert.deepEqual(csvRows('\uFEFFa,b\r\n"x,y","a""b\nz"\r\n'), [['a', 'b'], ['x,y', 'a"b\nz']]);
    assert.throws(() => csvRows('a\n"unfinished'), /Unclosed/);
    assert.throws(() => csvRows('a\n"value"x'), /quoting/);
});
test('dataset templates produce isotope suggestions preserving all digits', () => {
    const rows = datasetSuggestions(csv, config);
    assert.equal(rows[1].name, 'He_4_2'); assert.equal(rows[1].insertText, '4.0026032497');
    assert.match(rows[1].description, /4\.0026032497 u.*He-4, Z=2, N=2.*Data\/isotopes.csv/);
    const precise = datasetSuggestions(csv.replace('4.0026032497', '4.002603249700000000001'), config);
    assert.equal(precise[1].insertText, '4.002603249700000000001');
});
test('bad headers, mismatched rows and nonnumeric values are rejected', () => {
    assert.throws(() => datasetSuggestions('N,N\n1,2', config), /unique/);
    assert.throws(() => datasetSuggestions(csv, { ...config, datasetValue: 'missing' }), /Missing value/);
    assert.throws(() => datasetSuggestions(csv, { ...config, datasetName: '{missing}' }), /template column/);
    assert.throws(() => datasetSuggestions(csv + '1,2\n', config), /column count/);
    assert.throws(() => datasetSuggestions(csv.replace('4.0026032497', 'sqrt(4)'), config), /must be a number/);
});
test('reload reads configured CSV once, clears failed loads and prevents stale reads after settings change', async () => {
    const file = new TFile(); let reads = 0, finish;
    const errors = [];
    const app = { vault: { getAbstractFileByPath: () => file, read: async () => { reads++; return csv; } } };
    const dataset = new Dataset(app, () => config, message => errors.push(message));
    await dataset.reload(); assert.equal(dataset.items.length, 2); assert.equal(reads, 1);
    app.vault.read = () => new Promise(resolve => { finish = resolve; });
    const pending = dataset.reload(); dataset.invalidate(); finish(csv); await pending;
    assert.equal(dataset.items.length, 0);
    app.vault.read = async () => 'bad'; await dataset.reload();
    assert.equal(errors.length, 1); assert.equal(dataset.items.length, 0);
    dataset.close(); await dataset.reload(); assert.equal(dataset.items.length, 0);
});
