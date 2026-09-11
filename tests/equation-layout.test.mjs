import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built=await build({stdin:{contents:"export * from './src/equation-layout';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {equationSteps}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
test('steps remain whole regardless of source length',()=>{
    assert.deepEqual(equationSteps('x = 5'), ['x', '= 5']);
    assert.deepEqual(equationSteps('x = V d = 12 * 34 = 408'), ['x', '= V d', '= 12 * 34', '= 408']);
    const rhs = 'a+'.repeat(100)+'1';
    assert.deepEqual(equationSteps('x = '+rhs+' = 201'), ['x', '= '+rhs, '= 201']);
});
test('equalities inside grouped math are not split',()=>{
    assert.deepEqual(equationSteps(String.raw`x = \frac{a = b}{c}`), ['x', String.raw`= \frac{a = b}{c}`]);
    assert.deepEqual(equationSteps(String.raw`\left(x = 2\right) = y`), [String.raw`\left(x = 2\right)`, '= y']);
});
