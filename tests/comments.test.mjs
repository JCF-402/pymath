import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({
    stdin: { contents: `export * from './src/comments'; export * from './src/parser'; export * from './src/vault-globals'; export * from './src/autocomplete';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
});
const { stripComment, parseBlock, extractGlobals, completionQuery, mathSuggestions } =
    // eslint-disable-next-line no-unsanitized/method -- Import only locally bundled project code.
    await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const note = source => '```pymath\n' + source + '\n```';

test('comments and blank lines produce no calculations while trailing comments leave expressions intact', () => {
    assert.deepEqual(parseBlock('# Heading\n \n # x = broken'), []);
    assert.deepEqual(parseBlock(''), []);
    assert.deepEqual(parseBlock('# Heading\nx = 5 # value\nf(t) = t*x#function\nf(2) # result'), [
        { type: 'assignment', variable: 'x', expression: '5' },
        { type: 'function', name: 'f', parameters: ['t'], expression: 't*x' },
        { type: 'expression', expression: 'f(2)' },
    ]);
    assert.throws(() => parseBlock('# Heading\n\nx = # missing'), /Line 3/);
});

test('hashes within quoted strings and escaped quotes are preserved', () => {
    for (const expression of ['Symbol("a#b")', "Symbol('a#b')", 'Symbol("a\\"#b")', 'Symbol("""a#b""")']) {
        assert.equal(stripComment(expression + ' # trailing'), expression + ' ');
        assert.equal(parseBlock(expression + ' # trailing')[0].expression, expression);
    }
});

test('global indexing ignores commented definitions and strips trailing comments', () => {
    const globals = extractGlobals('A.md', note('# @global fake = 1\n@global c = 3 # constant\n@global f(x) = x*c # function'));
    assert.equal(globals.length, 2); assert.equal(globals[0].expression, '3');
    assert.equal(globals[0].line, 3); assert.equal(globals[1].expression, 'x*c');
    assert.match(extractGlobals('A.md', note('@global c = # missing'))[0].error, /expression/);
});

test('autocomplete ignores comments including assignment signs in trailing prose', () => {
    assert.equal(completionQuery('sc # explanation = value', 2), 'sc');
    assert.equal(completionQuery('sc # explanation', 10), null);
    assert.equal(completionQuery('# sc', 4), null);
    const text = note('# secret = 1\nscale = 2 # factor\nsc');
    assert.deepEqual(mathSuggestions(text, 'A.md', 3, 's', []).filter(item => item.scope !== 'builtin').map(item => item.name), ['scale']);
});

test('unit labels are stripped after comments and ordinary indexing is preserved', () => {
    assert.deepEqual(parseBlock('v = 10 [m/s] # speed'), [{ type: 'assignment', variable: 'v', expression: '10', unit: 'm/s' }]);
    assert.equal(parseBlock('values[0]')[0].expression, 'values[0]');
    assert.equal(parseBlock('Symbol("[m]")')[0].expression, 'Symbol("[m]")');
    assert.equal(completionQuery('speed [met', 10), null);
});

test('tags and units are separate metadata in either order and before comments', () => {
    for (const suffix of ['[m/s] {Velocity}', '{Velocity} [m/s]']) {
        assert.deepEqual(parseBlock('v = 20 ' + suffix + ' # label')[0],
            { type: 'assignment', variable: 'v', expression: '20', unit: 'm/s', tag: 'Velocity' });
    }
    assert.equal(parseBlock('x = {1,2}')[0].expression, '{1,2}');
    assert.equal(parseBlock('Symbol("{name}")')[0].expression, 'Symbol("{name}")');
    assert.throws(() => parseBlock('x = 2 {}'), /equation tag/);
    assert.equal(completionQuery('x = 2 {Vel', 10), null);
});
