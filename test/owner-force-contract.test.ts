import test from 'node:test';
import assert from 'node:assert/strict';
import { taskControlInputSchema } from '../shared/contracts';

test('force is retained for a reasoned owner move and effect settlement', () => {
  for (const control of [
    { action: 'move', to: 'closeout' },
    { action: 'retry_effect', effect: 'workspace_archive.example' },
  ]) {
    const parsed = taskControlInputSchema.parse({ ...control, taskId: 'task', version: 1, reason: 'Owner resolved the gate', force: true });
    assert.equal((parsed as { force?: boolean }).force, true);
  }
});

test('forced settlement names its effect and force is limited to the two owner verbs', () => {
  const base = { taskId: 'task', version: 1, reason: 'Owner resolved the gate', force: true };
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'retry_effect' }).success, false);
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'stop' }).success, false);
  assert.equal(taskControlInputSchema.safeParse({ ...base, action: 'move', to: 'work', reason: '' }).success, false);
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Task } from '../shared/contracts';
import { collectOwnerVerbFacts, ownerPendingEffects } from '../core/verbs/owner-verbs';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'force-contract-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Force', repoPath: '/repo',
    planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
  let calls = 0;
  const remote = { merged: true };
  const adapter = {
    merged: async () => ({ merged: remote.merged, commit: remote.merged ? base : null, head, base: 'main' }),
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head }),
    verifyPrIdentity: async (_task: Task, number: number) => ({ url: `https://github.com/example/repo/pull/${number}`, head, repository: 'example/repo', headRepository: 'example/repo' }),
    merge: async () => { calls++; },
    observe: async () => { calls++; throw Error('must not observe'); },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta('paused', false);
  store.update(task.id, { phase: 'needs_attention', prHead: head, prUrl: 'https://github.com/example/repo/pull/7', resumePrNumber: 7,
    resolution: { ...store.task(task.id).resolution, attention: true, integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() } } });
  const current = () => store.task(task.id);
  const apply = (fields: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: task.id, version: current().version, caller: 'operator (board)', reason: 'Resolved by owner', ...fields }));
  return { store, engine, task: current, apply, remote, calls: () => calls };
}

test('forced settlement records its caller and does not observe or send', async () => {
  const f = await fixture();
  try {
    f.store.event(f.task().id, 'owned_tool_hold', JSON.stringify({ runId: 'run', reason: 'unknown tool' }));
    await f.apply({ action: 'retry_effect', effect: 'owned_tool.run', force: true });
    assert.equal(f.calls(), 0);
    assert.equal(ownerPendingEffects(collectOwnerVerbFacts(f.store, f.task())).some(x => x.effect === 'owned_tool.run'), false);
    assert.equal(f.task().resolution.ownerSettlements.at(-1)?.caller, 'operator (board)');
    assert.equal(f.store.eventsAll(f.task().id).filter(e => e.kind === 'owner_settled').length, 1);
  } finally { f.store.close(); }
});

test('force refuses a non-planner and merge without operator acceptance', async () => {
  const f = await fixture();
  try {
    f.store.event(f.task().id, 'owned_tool_hold', JSON.stringify({ runId: 'run', reason: 'unknown tool' }));
    const version = f.task().version;
    await assert.rejects(f.apply({ action: 'retry_effect', effect: 'owned_tool.run', force: true, caller: 'worker' }), /planner.*operator/);
    await assert.rejects(f.apply({ action: 'move', to: 'merge', force: true }), /operator source acceptance/i);
    assert.equal(f.task().version, version);
    assert.equal(f.calls(), 0);
  } finally { f.store.close(); }
});

test('force moves a merged task past a blocking effect and frees its turn', async () => {
  const f = await fixture();
  try {
    f.store.event(f.task().id, 'owned_tool_hold', JSON.stringify({ runId: 'run', reason: 'unknown tool' }));
    const result = await f.apply({ action: 'move', to: 'closeout', force: true });
    assert.equal(result.phase, 'syncing');
    assert.equal(result.resolution.mergedCommit, base);
    assert.equal(result.resolution.integrationTurn, null);
    assert.equal(result.resolution.ownerSettlements[0]?.effect, 'owned_tool.run');
    assert.equal(f.calls(), 0);
  } finally { f.store.close(); }
});

test('a force move that cannot act refuses without changing the task', async () => {
  const f = await fixture();
  try {
    f.remote.merged = false;
    const before: Task = f.task();
    await assert.rejects(f.apply({ action: 'move', to: 'closeout', force: true }), /not confirmed merged/);
    assert.equal(f.task().version, before.version);
  } finally { f.store.close(); }
});


test('force review binds an unbound PR at the observed head', async () => {
  const f = await fixture();
  try {
    f.store.update(f.task().id, { prHead: null, prUrl: null, resumePrNumber: null });
    await assert.rejects(f.apply({ action: 'move', to: 'review', force: true }), /pass prNumber/);
    const result = await f.apply({ action: 'move', to: 'review', force: true, prNumber: 4918 });
    assert.equal(result.resumePrNumber, 4918);
    assert.equal(result.prHead, head);
    assert.equal(result.prUrl, 'https://github.com/example/repo/pull/4918');
    assert.equal(result.phase, 'awaiting_review');
    await assert.rejects(f.apply({ action: 'move', to: 'review', force: true, prNumber: 4919 }), /differs/);
  } finally { f.store.close(); }
});
