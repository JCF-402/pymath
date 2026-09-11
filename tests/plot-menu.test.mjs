import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const compiled = await build({
    stdin: { contents: "export * from './src/plot-menu'; export { menus } from 'obsidian';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{name: 'menu-stub', setup(b) {
        b.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'stub'}));
        b.onLoad({filter: /.*/, namespace: 'stub'}, () => ({contents: 'export const menus=[]; export class Menu { constructor(){menus.push(this);} addItem(fn){const item={setTitle(v){this.title=v;return this;},setIcon(){return this;},onClick(fn){this.click=fn;return this;}};fn(item);this.item=item;return this;} showAtMouseEvent(){} }', loader:'js'}));
    }}],
});
const { registerPlotMenu, menus } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
test('right-click saves the current image and ignores ordinary content', () => {
    let handler, download;
    registerPlotMenu({}, {registerDomEvent(_el,type,callback){assert.equal(type,'contextmenu');handler=callback;}});
    let src='data:image/png;base64,one';
    const target={tagName:'IMG',classList:{contains:()=>true},getAttribute:key=>key==='src'?src:'Plot.png',
        ownerDocument:{createElement(){return {click(){download=[this.href,this.download];}};}}};
    const event={target,preventDefault(){this.prevented=true;},stopPropagation(){}};
    handler(event); assert.equal(event.prevented,true);
    assert.equal(menus.at(-1).item.title,'Save PNG'); menus.at(-1).item.click();
    assert.deepEqual(download,[src,'Plot.png']);
    src='data:image/png;base64,two';handler(event);menus.at(-1).item.click();assert.equal(download[0],src);
    const count=menus.length;handler({target:{tagName:'DIV'}});assert.equal(menus.length,count);
});
