import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({stdin:{contents:"export * from './src/latex-definitions'; export * from './src/latex-render';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {extractLatexDefinitions, mathRegions, prepareGlobalLatex} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
test('indexes inline and display definitions but not code, comments, frontmatter or unfinished math', () => {
 const source = '---\nx: $@global fake = 1$\n---\n`$@global nope = 2$`\n```latex\n$$@global code = 2$$\n```\n<!-- $@global hidden = 3$ -->\n$@global E = mc^2$\n$$\n@global\nF = ma\n$$\n$@global unfinished = 4';
 assert.deepEqual(extractLatexDefinitions('A.md', source).map(x=>x.formula), ['E = mc^2','F = ma']);
 assert.equal(mathRegions('$E_').at(-1).closed, false);
});
test('removes the marker before native rendering without touching ordinary math', () => {
 const nodes = [{textContent:'\n@global\nE = mc^2'}, {textContent:'x = 3'}];
 prepareGlobalLatex({querySelectorAll:()=>nodes});
 assert.deepEqual(nodes.map(n=>n.textContent), ['E = mc^2','x = 3']);
});
