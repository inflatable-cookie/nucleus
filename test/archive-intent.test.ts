import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { OPERATOR_BOARD_CALLER } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { ownedRevisableTask, ownerRevisionFixture } from './support/review-entry-fixture';

/**
 * One durable `archiveIntentWorkspaceId` can outlive the task removal that wrote
 * it. An intent no reviewer run names on a nonterminal task is an unknown native
 * outcome: visible, observed on its own interval, and never re-sent.
 */
const LOST = 'wks_0123456789abcdef';

async function intentFixture() {
  const f = ownerRevisionFixture();
  const { task, engine, store } = await ownedRevisableTask(f, {});
  const calls: string[] = [], observations: string[] = [];
  const adapter = (engine as unknown as { adapter: Adapter }).adapter;
  adapter.archiveTaskWorkspace = async (_task, id) => { calls.push(id); return true; };
  adapter.taskWorkspaceArchived = async id => { observations.push(id); return false; };
  store.update(task.id, { resolution: { ...store.task(task.id).resolution, archiveIntentWorkspaceId: LOST, archiveIntentHead: null } });
  const now = () => store.task(task.id);
  const expireRetry = () => store.update(task.id, { resolution: { ...now().resolution,
    workspaceArchiveRetries: now().resolution.workspaceArchiveRetries.map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) } });
  const retry = (force = false) => engine.performTaskControl({ taskId: task.id, version: now().version, action: 'retry_effect', effect: `workspace_archive.${LOST}`,
    ...(force ? { force: true } : {}), reason: 'Observe the unconfirmed archive entry', caller: OPERATOR_BOARD_CALLER });
  const offered = () => ownerTaskNext(collectOwnerVerbFacts(store, now())).verbs.find(verb => verb.verb === 'retry_effect' && verb.args?.effect === `workspace_archive.${LOST}`);
  return { engine, calls, observations, now, expireRetry, retry, offered, close: async () => { await engine.stop(); f.close(); } };
}

test('an intent no reviewer run names is reported with its catalog answer and never re-sent', async () => {
  const f = await intentFixture();
  try {
    await new Lifecycle(f.engine).archive(f.now());
    const refusal = f.now().resolution.workspaceArchiveRetries.find(record => record.workspaceId === LOST)!;
    assert.match(refusal.error, /no longer matches a reviewer run/);
    assert.match(refusal.error, /the catalog still lists that workspace entry/);
    assert.equal(f.offered()?.available, true);
    await assert.rejects(f.retry(), /no longer matches a reviewer run/);
    assert.deepEqual(f.calls, [], 'an unknown outcome sends no native request');
    assert.equal(f.now().resolution.archiveIntentWorkspaceId, LOST);
    assert.ok(f.now().resolution.workspaceArchiveRetries.find(record => record.workspaceId === LOST)!.attempts > 1);
  } finally { await f.close(); }
});

test('an unreadable intent owes one observation per recorded interval', async () => {
  const f = await intentFixture();
  try {
    await new Lifecycle(f.engine).archive(f.now());
    assert.equal(f.observations.length, 1);
    await new Lifecycle(f.engine).archive(f.now());
    assert.equal(f.observations.length, 1, 'no catalog read inside the recorded interval');
    f.expireRetry();
    await new Lifecycle(f.engine).archive(f.now());
    assert.equal(f.observations.length, 2, 'the due pass observes once');
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('forcing an unreadable intent keeps its observation available', async () => {
  const f = await intentFixture();
  try {
    await new Lifecycle(f.engine).archive(f.now());
    await f.retry(true);
    assert.match(String(f.offered()?.args?.summary), /left on disk after forced settlement/);
    await assert.rejects(f.retry(), /no longer matches a reviewer run/);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});
