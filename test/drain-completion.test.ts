import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';

/**
 * Per-drain completion (2026-10-23, the #608 delivery blocker). The safety
 * tick (`sweepOnce`) queues a window behind any running pass; when a pass
 * outlasts the tick, the sweep chain never empties. `wake()` must still
 * resolve once the drain it requested has covered the fleet, its lane work
 * settled and its projections drained, while window passes continue. A failed
 * or stopped drain pass credits nothing. Passes are scripted with barriers;
 * no wall-clock budget is involved.
 */

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-drain-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const engine = new Engine(store, {} as Adapter, 0);
  const passes: { drain: boolean; release: (error?: Error) => void; done: Promise<void> }[] = [];
  let arrived: () => void = () => {};
  let closing = false;
  // Each pass waits for its release; the test decides when and how it ends.
  (engine as unknown as { auditPass: (drain: boolean) => Promise<{ fault: Error | null; covered: boolean }> }).auditPass = drain => closing ? Promise.resolve({ fault: null, covered: true }) : new Promise(resolve => {
    let finish!: () => void;
    const done = new Promise<void>(r => { finish = r; });
    passes.push({ drain, release: error => { resolve({ fault: error ?? null, covered: true }); finish(); }, done });
    arrived();
  });
  const nextPass = (count: number) => new Promise<void>(resolve => {
    if (passes.length >= count) return resolve();
    arrived = () => { if (passes.length >= count) resolve(); };
  });
  const settled = (promise: Promise<void>) => {
    const state = { value: 'pending' as 'pending' | 'resolved' | 'rejected', error: null as Error | null };
    promise.then(() => { state.value = 'resolved'; }, error => { state.value = 'rejected'; state.error = error; });
    return state;
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { engine, store, passes, nextPass, settled, flush,
    hold: (key: string) => { let release!: () => void; void engine.scheduleLane(key, 1, () => new Promise<void>(r => { release = r; })); return () => release(); },
    close: async () => { closing = true; for (const pass of passes) pass.release(); await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the whole wake() resolves after its own drain while safety-tick windows keep the audit lane busy', async () => {
  const f = fixture(); try {
    // Another lane is busy, so the drain's quiesce must wait for it.
    const releaseTask = f.hold('task:busy');
    const wake = f.settled(f.engine.wake());
    await f.nextPass(1);
    assert.equal(f.passes[0]!.drain, true);
    f.passes[0]!.release();
    await f.flush();
    assert.equal(wake.value, 'pending', 'the drain is done; its quiesce waits for the busy task lane');
    // A safety tick starts a window that outlasts the tick: from here the
    // audit lane is never idle while ticks keep arriving.
    void f.engine.sweepOnce();
    await f.nextPass(2);
    assert.equal(f.passes[1]!.drain, false);
    void f.engine.sweepOnce();
    releaseTask();
    await f.flush();
    assert.equal(wake.value, 'resolved', 'wake() resolved, quiesce and projections included, with a window still running');
    // The chain keeps running the window the last tick queued.
    f.passes[1]!.release();
    await f.nextPass(3);
    assert.equal(f.passes[2]!.drain, false);
  } finally { await f.close(); }
});

test('a drain requested during a window pass waits for its own full drain pass, not the window', async () => {
  const f = fixture(); try {
    void f.engine.sweepOnce();
    await f.nextPass(1);
    assert.equal(f.passes[0]!.drain, false);
    const wake = f.settled(f.engine.wake());
    f.passes[0]!.release();
    await f.nextPass(2);
    await f.flush();
    assert.equal(wake.value, 'pending', 'the window that was running does not credit the drain');
    assert.equal(f.passes[1]!.drain, true);
    void f.engine.sweepOnce();
    f.passes[1]!.release();
    await f.flush();
    assert.equal(wake.value, 'resolved');
  } finally { await f.close(); }
});

test('a drain requested during a running drain is not credited by it; a second drain covers it', async () => {
  const f = fixture(); try {
    const first = f.settled(f.engine.wake());
    await f.nextPass(1);
    const second = f.settled(f.engine.wake());
    f.passes[0]!.release();
    await f.nextPass(2);
    await f.flush();
    assert.equal(first.value, 'resolved');
    assert.equal(second.value, 'pending', 'the drain that started before the request does not credit it');
    assert.equal(f.passes[1]!.drain, true);
    f.passes[1]!.release();
    await f.flush();
    assert.equal(second.value, 'resolved');
  } finally { await f.close(); }
});

test('a failed drain pass rejects its waiters, and a stop rejects the uncovered ones; neither reports success', async () => {
  const f = fixture(); try {
    const failed = f.settled(f.engine.wake());
    await f.nextPass(1);
    f.passes[0]!.release(new Error('pass fault'));
    await f.flush();
    assert.equal(failed.value, 'rejected');
    assert.match(failed.error!.message, /pass fault/);
    // A drain still waiting when the engine stops is not credited.
    const uncovered = f.settled(f.engine.wake());
    await f.nextPass(2);
    const stopping = f.engine.stop();
    f.passes[1]!.release();
    await stopping;
    await f.flush();
    assert.equal(uncovered.value, 'rejected');
    assert.match(uncovered.error!.message, /stopped before the requested reconciliation drain covered the fleet/);
  } finally { await f.close(); }
});

test('coalescing is unchanged: windows requested during a window become one more window, and a drain absorbs a window', async () => {
  const f = fixture(); try {
    void f.engine.sweepOnce();
    await f.nextPass(1);
    void f.engine.sweepOnce(); void f.engine.sweepOnce();
    f.passes[0]!.release();
    await f.nextPass(2);
    assert.equal(f.passes[1]!.drain, false);
    f.passes[1]!.release();
    await f.flush();
    assert.equal(f.passes.length, 2, 'two coalesced window requests ran as one window');
    const wake = f.settled(f.engine.wake());
    await f.nextPass(3);
    void f.engine.sweepOnce();
    f.passes[2]!.release();
    await f.flush();
    assert.equal(wake.value, 'resolved');
    await f.flush();
    assert.equal(f.passes.length, 3, 'a window requested during a drain is covered by it');
  } finally { await f.close(); }
});

test('lane work the drain scheduled still settles, before projections, even with the audit lane busy', async () => {
  const f = fixture(); try {
    const order: string[] = [];
    const engine = f.engine as unknown as { drainTitles: () => Promise<void> };
    const titles = engine.drainTitles.bind(f.engine);
    engine.drainTitles = async () => { order.push('projections'); return titles(); };
    const wake = f.settled(f.engine.wake());
    await f.nextPass(1);
    // The drain schedules a task quantum of its own that is still running when the pass ends.
    let releaseFollowUp!: () => void;
    void f.engine.scheduleLane('task:follow-up', 1, () => new Promise<void>(r => { releaseFollowUp = () => { order.push('follow-up'); r(); }; }));
    f.passes[0]!.release();
    await f.flush();
    // The drain is done; a tick now starts a window that keeps the audit lane busy.
    void f.engine.sweepOnce();
    await f.nextPass(2);
    await f.flush();
    assert.equal(wake.value, 'pending', 'the drain\'s own follow-up must settle first, window or not');
    assert.deepEqual(order, []);
    releaseFollowUp();
    await f.flush();
    assert.equal(wake.value, 'resolved');
    assert.deepEqual(order, ['follow-up', 'projections'], 'projections drain after the follow-up');
  } finally { await f.close(); }
});

test('Sol #609 P2: a drain requested while the chain is ending is covered by a new chain, never rejected', async () => {
  for (let delay = 0; delay <= 12; delay++) {
    const f = fixture(); try {
      const first = f.settled(f.engine.wake());
      await f.nextPass(1);
      f.passes[0]!.release();
      for (let i = 0; i < delay; i++) await Promise.resolve();
      const second = f.settled(f.engine.wake());
      await f.flush();
      assert.equal(first.value, 'resolved', `delay ${delay}`);
      assert.notEqual(second.value, 'rejected', `delay ${delay}: ${second.error?.message}`);
      if (second.value === 'pending') {
        assert.equal(f.passes.length, 2, `delay ${delay}: a new drain pass runs for it`);
        assert.equal(f.passes[1]!.drain, true);
        f.passes[1]!.release();
        await f.flush();
      }
      assert.equal(second.value, 'resolved', `delay ${delay}`);
    } finally { await f.close(); }
  }
});

test('Sol #609 P2: wake() waits only for projections queued at its cut, not ones a later window adds', async () => {
  const f = fixture(); try {
    const engine = f.engine as unknown as { syncWorkspaceTitle: (task: { id: string }) => Promise<void>; enqueueTitle: (id: string) => void };
    const gates = new Map<string, () => void>();
    engine.syncWorkspaceTitle = task => new Promise<void>(resolve => { gates.set(task.id, resolve); });
    (f.store as unknown as { task: (id: string) => { id: string; hostId: string } }).task = id => ({ id, hostId: "host" }); // #912: titles run inside their task host
    engine.enqueueTitle('cut-title');
    const wake = f.settled(f.engine.wake());
    await f.nextPass(1);
    f.passes[0]!.release();
    await f.flush();
    // A later window queues another title while the cut's title is still in flight.
    engine.enqueueTitle('later-title');
    await f.flush();
    assert.equal(wake.value, 'pending', 'the title in the cut is still in flight');
    gates.get('cut-title')!();
    await f.flush();
    assert.equal(wake.value, 'resolved', 'the later title, still blocked, does not extend this wake');
    gates.get('later-title')?.();
  } finally { await f.close(); }
});

test('Sol #609 P2: a queued projection behind an in-flight one for the same key is its own occurrence in the cut', async () => {
  const f = fixture(); try {
    const engine = f.engine as unknown as { syncWorkspaceTitle: (task: { id: string }) => Promise<void>; enqueueTitle: (id: string) => void };
    const gates: (() => void)[] = [];
    engine.syncWorkspaceTitle = () => new Promise<void>(resolve => { gates.push(resolve); });
    (f.store as unknown as { task: (id: string) => { id: string; hostId: string } }).task = id => ({ id, hostId: "host" }); // #912: titles run inside their task host
    engine.enqueueTitle('task-a');
    await f.flush();
    assert.equal(gates.length, 1, 'the old title is in flight');
    engine.enqueueTitle('task-a'); // the phase changed: a new title is queued behind it
    const wake = f.settled(f.engine.wake());
    await f.nextPass(1);
    f.passes[0]!.release();
    await f.flush();
    gates[0]!();
    await f.flush();
    assert.equal(wake.value, 'pending', 'the old title alone does not satisfy the queued new one');
    assert.equal(gates.length, 2);
    gates[1]!();
    await f.flush();
    assert.equal(wake.value, 'resolved');
  } finally { await f.close(); }
});
