import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
    entryPoints: ['src/state-saver.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false,
});
const { StateSaver } =
    // eslint-disable-next-line no-unsanitized/method -- Import only the locally bundled module under test.
    await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

function clock(t) {
    const previous = globalThis.window;
    const timers = new Map();
    let id = 0;
    globalThis.window = {
        setTimeout(callback, delay) {
            assert.equal(delay, 300);
            timers.set(++id, callback); return id;
        },
        clearTimeout(timer) { timers.delete(timer); },
    };
    t.after(() => {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    });
    return {
        count: () => timers.size,
        fire() {
            const callbacks = [...timers.values()]; timers.clear();
            for (const callback of callbacks) callback();
        },
    };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('typing is debounced and saves the latest state', async t => {
    const timer = clock(t), written = [], errors = [];
    const state = { blocks: { x: 1 } };
    const saver = new StateSaver(() => state, async value => { written.push(value); }, error => errors.push(error));
    saver.schedule(); state.blocks.x = 2; saver.schedule();
    assert.equal(timer.count(), 1); assert.equal(written.length, 0);
    timer.fire(); await tick();
    assert.deepEqual(written, [{ blocks: { x: 2 } }]);
    assert.deepEqual(errors, []); await saver.close();
});

test('writes are serialized and queued snapshots cannot be changed by later edits', async t => {
    clock(t);
    const state = { value: 1 }, written = [], releases = [];
    const saver = new StateSaver(() => state, snapshot => {
        written.push(snapshot); return new Promise(resolve => releases.push(resolve));
    }, () => {});
    const first = saver.saveNow(); state.value = 2;
    const second = saver.saveNow(); state.value = 3;
    await tick(); assert.deepEqual(written, [{ value: 1 }]);
    releases.shift()(); await first; await tick();
    assert.deepEqual(written, [{ value: 1 }, { value: 2 }]);
    releases.shift()(); await second; await saver.close();
});

test('explicit settings save cancels the delayed save and includes pending block changes', async t => {
    const timer = clock(t), written = [];
    const state = { settings: false, blocks: { x: 5 } };
    const saver = new StateSaver(() => state, async snapshot => { written.push(snapshot); }, () => {});
    saver.schedule(); state.settings = true;
    await saver.saveNow(); assert.equal(timer.count(), 0);
    timer.fire(); await tick();
    assert.deepEqual(written, [{ settings: true, blocks: { x: 5 } }]); await saver.close();
});

test('failed writes reject or report errors without poisoning subsequent writes', async t => {
    const timer = clock(t), errors = [], written = [];
    let fail = true;
    const saver = new StateSaver(() => ({ value: 5 }), async snapshot => {
        if (fail) throw new Error('disk failure'); written.push(snapshot);
    }, error => errors.push(error.message));
    await assert.rejects(saver.saveNow(), /disk failure/);
    saver.schedule(); timer.fire(); await tick();
    assert.deepEqual(errors, ['disk failure']);
    fail = false; await saver.saveNow();
    assert.deepEqual(written, [{ value: 5 }]); await saver.close();
});

test('unload flushes pending edits behind active writes and disables scheduling', async t => {
    const timer = clock(t), written = [], releases = [];
    const state = { value: 1 };
    const saver = new StateSaver(() => state, snapshot => {
        written.push(snapshot); return new Promise(resolve => releases.push(resolve));
    }, () => {});
    const first = saver.saveNow(); await tick();
    state.value = 2; saver.schedule();
    let closed = false;
    const closing = saver.close().then(() => { closed = true; });
    assert.equal(timer.count(), 0); saver.schedule(); assert.equal(timer.count(), 0);
    releases.shift()(); await first; await tick();
    assert.equal(closed, false); assert.deepEqual(written, [{ value: 1 }, { value: 2 }]);
    releases.shift()(); await closing; assert.equal(closed, true);
    await saver.close(); assert.equal(written.length, 2);
});

test('unload exposes a failed final flush', async t => {
    clock(t);
    const saver = new StateSaver(() => ({}), async () => { throw new Error('flush failed'); }, () => {});
    saver.schedule(); await assert.rejects(saver.close(), /flush failed/);
});
