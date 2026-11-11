/**
 * Task 434: a lifecycle pass that owes no archive effect must not pay for the
 * terminal-transition work - the finished-task runtime stop, its manifest read
 * and the host-process sweep - and a pass that is due must still do all of it
 * (Tom's 2026-10-25 performance audit, item A3).
 *
 * The evidence is count-based and isolated: a private PATH shim records every
 * `git`, `ps` and `lsof` the pass spawns, and the hook itself is counted. No
 * live process, host scan or operator display is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { hostProcessSweepIntent } from '../core/machine/host-process-reap';
import type { Engine } from '../core/engine';
import { spawnLog } from './support/spawn-log';
import { terminalArchiveFixture as fixture } from './support/terminal-archive-fixture';

/** Count the finished-task runtime stop the pass actually evaluates. */
function countFinishedHook(engine: Engine) {
  const hooks = engine.hooks as unknown as { finished(task: unknown): Promise<unknown> };
  const real = hooks.finished.bind(hooks);
  const counter = { calls: 0 };
  hooks.finished = async (task: unknown) => { counter.calls++; return real(task); };
  return counter;
}

test('a pass inside the archive backoff spawns no git, ps or lsof and evaluates no finished hook', async t => {
  const f = await fixture(t);
  const log = await spawnLog(f.root);
  t.after(() => log.restore());
  const hooks = countFinishedHook(f.engine);
  const lifecycle = new Lifecycle(f.engine);
  const attempts = () => f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!.attempts;
  const before = attempts();

  // The fixture records a failed archive retry an hour away: nothing is due.
  const notDueAt = Date.now();
  for (let i = 0; i < 3; i++) { await log.reset(); await lifecycle.pass(); }
  const idle = log.counts();
  assert.deepEqual(idle, { git: 0, ps: 0, lsof: 0 },
    `a pass with no due archive attempt spawns nothing: ${JSON.stringify(idle)}`);
  assert.equal(hooks.calls, 0, 'the finished-task runtime stop is not re-evaluated inside the backoff');
  assert.equal(attempts(), before, 'no pass inside the interval is an attempt');
  const idleMs = Date.now() - notDueAt;

  // The same pass becomes expensive the moment the recorded retry is due.
  const dueAt = Date.now();
  f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries
    .map(record => record.workspaceId === 'ws' ? { ...record, nextAttemptAt: new Date(0).toISOString() } : record) });
  await log.reset();
  await lifecycle.pass();
  const due = log.counts();
  assert.equal(hooks.calls, 1, 'a due pass evaluates the finished-task runtime stop once');
  assert.ok(due.git > 0, `a due attempt reads Git: ${JSON.stringify(due)}`);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws'], 'the due pass archives what the backoff held');
  assert.equal(f.remote.archives.length, 1, 'exactly one native archive effect');
  const dueMs = Date.now() - dueAt;
  t.diagnostic(JSON.stringify({ workload: '3 passes inside the backoff + 1 due pass', idlePasses: 3, idleSpawns: idle,
    idleMs, dueSpawns: due, dueMs, hookCallsInsideBackoff: 0, dueHookCalls: 1 }));
});

test('the terminal-transition intents still run their one evaluation when no archive is due', async t => {
  const f = await fixture(t);
  const log = await spawnLog(f.root);
  t.after(() => log.restore());
  const hooks = countFinishedHook(f.engine);
  const lifecycle = new Lifecycle(f.engine);
  const attempts = () => f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!.attempts;
  const before = attempts();

  // The durable host-process intent is the restart authority for the transition's
  // one sweep: it runs and clears even though the archive retry is hours away.
  f.updateResolution({ hostProcessSweep: hostProcessSweepIntent('done') });
  await log.reset();
  await lifecycle.pass();
  const swept = log.counts();
  assert.ok(swept.ps > 0, `the durable sweep intent runs the host sweep: ${JSON.stringify(swept)}`);
  assert.equal(f.task().resolution.hostProcessSweep, null, 'one evaluation clears the intent');
  assert.ok(f.store.events(f.task().id).some(event => event.kind === 'host_process_sweep_settled'));
  assert.equal(attempts(), before, 'the archive itself is still backed off');

  // The durable finished-hook intent survives a crash and is evaluated here too.
  f.updateResolution({ finishedHook: { phase: 'done', at: new Date().toISOString() } });
  await log.reset();
  await lifecycle.pass();
  assert.ok(hooks.calls > 0, 'the durable finished-hook intent is evaluated');
  assert.equal(f.task().resolution.finishedHook, null, 'the settled intent clears');
  assert.ok(log.counts().git > 0, 'reading the bound manifest costs a Git read');
});

test('an owner retry bypasses only the backoff: it re-evaluates the transition work and archives', async t => {
  const f = await fixture(t);
  const log = await spawnLog(f.root);
  t.after(() => log.restore());
  const hooks = countFinishedHook(f.engine);
  assert.ok(Date.parse(f.task().resolution.workspaceArchiveRetries[0]!.nextAttemptAt) > Date.now(), 'the retry is backed off');

  await log.reset();
  const result = await f.retry();
  const spent = log.counts();
  assert.deepEqual(result.resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(hooks.calls, 1, 'the owner retry is a due attempt and evaluates the runtime stop');
  assert.ok(spent.git > 0, `an owner retry is due work: ${JSON.stringify(spent)}`);
  t.diagnostic(JSON.stringify({ workload: 'one owner retry of a backed-off workspace', spawns: spent, hookCalls: hooks.calls }));
});
