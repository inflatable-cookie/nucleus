import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { holdPatch } from '../core/merge/merge-hold';
import { Engine } from '../core/engine';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { Store } from '../core/store/store';
import { git } from '../core/git/index';
import { RuntimeRetirementService } from '../core/runtime/runtime-retirement';
import { runSchema, submissionSchema } from '../shared/contracts';
import { toolTimelinePage } from './support/tool-timeline';
import { terminalArchiveFixture as fixture } from './support/terminal-archive-fixture';

// Tom, 2026-10-19: once a task is merged it is free to archive. A merged task's
// idle participant owes no tool history, so missing history no longer holds it.
test('next exposes a pre-intent terminal failure and the owner retry archives a merged task without its tool history', async t => {
  const f = await fixture(t);
  const view = f.next().find(view => view.args?.effect === 'workspace_archive.ws')!;
  assert.equal(view.available, true);
  assert.match(String(view.args?.summary), /native history unavailable/);
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, null);
  f.adapter.agentTimelinePage = async () => { f.remote.historyReads++; throw Error('native history unavailable'); };
  const before = f.task();
  const result = await f.retry();
  assert.deepEqual(result.resolution.archivedWorkspaceIds, ['ws']);
  assert.deepEqual(result.resolution.workspaceArchiveRetries, []);
  assert.equal(result.resolution.archiveIntentWorkspaceId, null);
  assert.equal(result.resolution.cleanupReason, '');
  assert.equal(existsSync(f.directory), false);
  assert.equal(f.remote.archives.length, 1);
  assert.equal(f.remote.historyReads, 0, 'a merged task reads no tool history');
  for (const key of ['phase', 'branch', 'prHead', 'completion', 'disposition', 'holds'] as const)
    assert.deepEqual(result[key], before[key], key);
  assert.equal(f.next().some(view => view.args?.effect === 'workspace_archive.ws'), false);
  assert.equal(f.store.events(f.task().id).filter(event => event.kind === 'owner_control').length, 1);
});

weighted(5)('owner terminal retry retains ordinary source, ownership, idle, retention and tool refusals', async t => {
  for (const shape of ['dirty', 'unpublished', 'foreign-workspace', 'foreign-participant', 'live', 'permission', 'gap', 'running-tool', 'hold', 'retention', 'shared'] as const) {
    // A merged task is free to archive: tool history (a gap or a stray running tool) no longer refuses it.
    const archives = shape === 'gap' || shape === 'running-tool';
    await t.test(shape, async t => {
      const f = await fixture(t);
      if (!['live', 'permission', 'gap', 'running-tool'].includes(shape)) f.remote.participant.status = 'closed';
      if (shape === 'dirty') await writeFile(join(f.directory, 'keep.txt'), 'local');
      if (shape === 'unpublished') await git(f.primary, 'push', 'origin', '--delete', f.task().branch);
      if (shape === 'foreign-workspace') f.remote.descriptor.projectRootPath = join(f.root, 'foreign');
      if (shape === 'foreign-participant') f.remote.participant.workspaceId = 'foreign';
      if (shape === 'live') f.remote.participant.active = true;
      if (shape === 'permission') f.remote.participant.permissions = true;
      if (shape === 'gap') f.adapter.agentTimelinePage = async () => toolTimelinePage([], { gap: true });
      if (shape === 'running-tool') f.adapter.agentTimelinePage = async () => toolTimelinePage([
        { timestamp: new Date().toISOString(), item: { type: 'tool_call', callId: 'live-tool', name: 'exec', status: 'running' } },
      ]);
      if (shape === 'hold') f.store.update(f.task().id, holdPatch(f.task(), 'dispatch', 'operator', 'Preserve checkout'));
      if (shape === 'retention') f.engine.hooks.retentionGate = async () => { throw Error('consumer retention blocked'); };
      if (shape === 'shared') {
        const other = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Other task', repoPath: f.primary,
          planningCommit: f.head, handoffPath: 'other.md', originAgentId: 'origin' }), 'host', 'handoff', f.head);
        f.store.update(other.id, { workspaceId: 'ws', directory: f.directory });
      }
      if (archives) {
        await f.retry();
        assert.equal(f.remote.archives.length, 1, shape);
        assert.equal(existsSync(f.directory), false, shape);
        return;
      }
      await assert.rejects(f.retry());
      assert.deepEqual(f.remote.archives, []);
      assert.ok(existsSync(f.directory));
      assert.equal(f.task().resolution.archiveIntentWorkspaceId, null);
      assert.ok(f.next().some(view => view.args?.effect === 'workspace_archive.ws'));
    });
  }
});

test('uncertain terminal archive observes delivery before replay or local teardown', async t => {
  for (const shape of ['gone', 'absent-retained', 'present', 'unobservable'] as const) await t.test(shape, async t => {
    const f = await fixture(t);
    f.remote.participant.status = 'closed';
    f.updateResolution({ archiveIntentWorkspaceId: 'ws', workspaceArchiveRetries: [] });
    assert.ok(f.next().some(view => view.args?.effect === 'workspace_archive.ws'));
    f.remote.catalogued = shape === 'present';
    f.remote.observationError = shape === 'unobservable';
    if (shape === 'gone') await git(f.primary, 'worktree', 'remove', f.directory);
    if (shape === 'unobservable') {
      await assert.rejects(f.retry(), /reconcile.*native catalog unavailable/);
      assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws');
      assert.ok(existsSync(f.directory));
    } else {
      await f.retry();
      assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
      assert.equal(existsSync(f.directory), false);
    }
    assert.equal(f.remote.archives.length, shape === 'present' ? 1 : 0);
  });
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('owner retry serializes behind an automatic archive and never duplicates its native effect', async t => {
  for (const unknownDelivery of [false, true]) await t.test(String(unknownDelivery), async t => {
    const f = await fixture(t), entered = barrier(), release = barrier();
    f.remote.participant.status = 'closed';
    const ref = f.api.workspaces.ref;
    f.api.workspaces.ref = () => ({ ...ref(), archive: async requestId => {
      f.remote.archives.push(requestId);
      entered.resolve();
      await release.promise;
      f.remote.catalogued = false;
      if (unknownDelivery) throw Error('delivery response lost');
      return { archivedAt: new Date().toISOString() };
    } });
    f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries.map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) });
    f.engine.enqueueCleanup(f.task().id);
    await entered.promise;
    const retry = f.retry();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.remote.archives.length, 1);
    release.resolve();
    await retry;
    await f.engine.drainCleanup();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
    assert.equal(f.remote.archives.length, 1, 'unknown delivery reconciles local teardown without a native replay');
  });
});

test('a targeted retry preserves unrelated backoff and settles run intents only through ordinary workspace cleanup', async t => {
  const f = await fixture(t);
  const unrelated = { workspaceId: 'closeout', attempts: 3, error: 'closeout history unavailable', nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() };
  const runIntent = { workspaceId: 'ws', directory: f.directory, runId: 'unapplied-run', agentId: 'worker', state: 'intent' as const, detail: 'authentic application proof still required', at: new Date().toISOString() };
  f.updateResolution({ closeoutWorkspaceId: 'closeout', closeoutDirectory: join(f.root, 'closeout'), closeoutWorkspaceHead: f.head,
    workspaceArchiveRetries: [...f.task().resolution.workspaceArchiveRetries, unrelated], buildOutputCleanups: [runIntent] });
  f.adapter.agentTimelinePage = async () => null;
  await f.retry();
  assert.deepEqual(f.task().resolution.workspaceArchiveRetries, [unrelated]);
  const covered = f.task().resolution.buildOutputCleanups.find(record => record.runId === runIntent.runId)!;
  assert.equal(covered.state, 'complete');
  assert.equal(covered.detail, 'Covered by the settled workspace build output cleanup');
  assert.match(f.task().resolution.cleanupReason, /closeout history unavailable/);
  assert.equal(f.remote.archives.length, 1);
});


test('one owner request attempts a workspace once even when multiple task roles reference it', async t => {
  const f = await fixture(t);
  f.updateResolution({ closeoutWorkspaceId: 'ws', closeoutDirectory: f.directory, closeoutWorkspaceHead: f.head });
  let attempts = 0;
  f.adapter.agentTimelinePage = async () => { attempts++; throw Error('native history unavailable'); };
  assert.equal(f.next().filter(view => view.args?.effect === 'workspace_archive.ws').length, 1);
  await f.retry();
  assert.equal(attempts, 0, 'a merged task reads no tool history');
  assert.equal(f.remote.archives.length, 1, 'the shared workspace is archived once');
});


test('owner retry archives a closed participant without reading unavailable or historical running tools', async t => {
  for (const history of ['unavailable', 'historical-running'] as const) await t.test(history, async t => {
    const f = await fixture(t);
    f.remote.participant.status = 'closed';
    f.adapter.agentTimelinePage = async () => {
      f.remote.historyReads++;
      if (history === 'unavailable') throw Error('archived history unavailable');
      return toolTimelinePage([{ timestamp: new Date().toISOString(), item: { type: 'tool_call', callId: 'old', name: 'exec', status: 'running' } }]);
    };
    const before = f.task();
    await f.retry();
    assert.equal(f.remote.historyReads, 0, 'closure proves managed liveness without historical fetches');
    assert.equal(f.remote.archives.length, 1);
    assert.equal(existsSync(f.directory), false);
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
    for (const key of ['phase', 'branch', 'prHead', 'completion', 'disposition'] as const)
      assert.deepEqual(f.task()[key], before[key], key);
    assert.deepEqual(f.task().resolution.review, before.resolution.review, 'closure creates no review credit');
    assert.equal(f.store.runs(f.task().id).length, 0, 'no synthetic tool or run completion');
    f.engine.enqueueCleanup(f.task().id);
    await f.engine.drainCleanup();
    assert.equal(f.remote.archives.length, 1, 'ordinary later cleanup stays idempotent');
  });
});

weighted(3)('only a coherent observation releases a participant: closed always, idle or errored once the task is merged', async t => {
  for (const shape of ['unknown', 'missing', 'failed', 'wrong-id', 'closed-active', 'closed-turn', 'closed-permission', 'idle-history', 'error-history'] as const) await t.test(shape, async t => {
    const f = await fixture(t);
    f.remote.participant.status = 'closed';
    if (shape === 'unknown') f.remote.participant.status = 'unknown';
    if (shape === 'missing') f.adapter.observe = async () => null as never;
    if (shape === 'failed') f.adapter.observe = async () => { throw Error('native observation failed'); };
    if (shape === 'wrong-id') f.adapter.observe = async () => ({ ...f.remote.participant, id: 'another-agent' });
    if (shape === 'closed-active') f.remote.participant.active = true;
    if (shape === 'closed-turn') f.remote.participant.activeTurnId = 'still-running';
    if (shape === 'closed-permission') f.remote.participant.permissions = true;
    if (shape === 'idle-history') f.remote.participant.status = 'idle';
    if (shape === 'error-history') f.remote.participant.status = 'error';
    f.adapter.agentTimelinePage = async () => { f.remote.historyReads++; throw Error('history unavailable'); };
    // A merged task's idle or errored participant owes no tool history (Tom, 2026-10-19); an
    // unknown, missing, wrong or still-active observation still refuses.
    if (shape.endsWith('-history')) {
      await f.retry();
      assert.equal(f.remote.archives.length, 1, shape);
      assert.equal(f.remote.historyReads, 0, shape);
      return;
    }
    await assert.rejects(f.retry());
    assert.deepEqual(f.remote.archives, []);
    assert.ok(existsSync(f.directory));
    assert.equal(f.task().resolution.archiveIntentWorkspaceId, null);
    assert.equal(f.remote.historyReads, 0);
  });
});

weighted(3)('run-bound output uses closure without losing application, participant or delivery fences', async t => {
  for (const shape of ['closed', 'idle', 'error', 'closed-active', 'closed-permission', 'unknown', 'missing', 'failed', 'unreleased', 'unapplied', 'uncertain'] as const) await t.test(shape, async t => {
    const f = await fixture(t);
    const run = runSchema.parse({ id: 'old-run', taskId: f.task().id, role: 'reviewer', generation: 1,
      head: f.head, base: f.head, agentId: 'old-reviewer', workspaceId: 'ws', status: 'finished', released: true,
      profile: null, createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null });
    if (shape !== 'unapplied') f.store.putRun({ ...run, released: shape !== 'unreleased', status: shape === 'uncertain' ? 'uncertain' : 'finished' });
    else f.store.update(f.task().id, { runId: run.id, completion: null });
    f.updateResolution({ buildOutputCleanups: [{ workspaceId: 'ws', directory: f.directory, runId: run.id,
      agentId: run.agentId!, state: 'intent', detail: 'Run output pending', at: new Date().toISOString() }] });
    const output = join(f.directory, 'node_modules');
    await mkdir(output);
    await writeFile(join(output, 'generated'), 'cache');
    f.remote.participant.status = 'closed';
    const observe = f.adapter.observe.bind(f.adapter);
    f.adapter.observe = async id => {
      if (id !== run.agentId) return observe(id);
      if (shape === 'failed') throw Error('native read failed');
      if (shape === 'missing') return null as never;
      return { ...await observe(id), status: ['idle', 'error', 'unknown'].includes(shape) ? shape : 'closed',
        active: shape === 'closed-active', permissions: shape === 'closed-permission' };
    };
    f.adapter.agentTimelinePage = async () => { f.remote.historyReads++; throw Error('archived history unavailable'); };
    await f.engine.settleRunBuildOutputs(f.task().id);
    const record = f.task().resolution.buildOutputCleanups.find(record => record.runId === run.id)!;
    assert.equal(record.state, shape === 'closed' ? 'complete' : 'intent');
    // Queue #342 node_modules supersession (2026-10-20): run-bound settlement keeps installed dependencies even when its gate closes.
    assert.equal(existsSync(output), true, shape);
    if (shape === 'closed') assert.match(record.detail, /Retained node_modules at /);
    assert.ok(existsSync(join(f.directory, 'task.txt')), 'source is retained');
    assert.equal(f.remote.historyReads, ['idle', 'error'].includes(shape) ? 1 : 0);
    assert.equal(f.store.run(run.id)?.completion ?? null, null, 'cleanup never invents a review result');
    assert.deepEqual(f.remote.archives, [], 'run output settlement does not archive the workspace');
  });
});

test('closed participants still leave failed and uncertain runtime retirement proofs outstanding', async t => {
  for (const shape of ['failure', 'timeout', 'spawn-error'] as const) await t.test(shape, async t => {
    const f = await fixture(t);
    f.remote.participant.status = 'closed';
    const calls: string[][] = [];
    const runtime = new RuntimeRetirementService(f.store, async args => {
      calls.push(args);
      return { code: shape === 'failure' ? 1 : null, timedOut: shape === 'timeout',
        spawnError: shape === 'spawn-error' ? 'spawn failed' : '', output: 'retirement unproved' };
    });
    f.updateResolution({ runtimeRetirements: [{ workspaceId: 'ws', directory: f.directory,
      scope: { kind: 'worktree', token: 'a'.repeat(32) }, state: 'captured', capturedAt: new Date().toISOString(),
      provedAt: null, attempts: 0, error: '', outputTail: '', nextAttemptAt: null }] });
    f.retirement.prove = runtime.prove.bind(runtime);
    await f.retry();
    assert.equal(f.remote.historyReads, 0);
    assert.equal(f.remote.archives.length, 1);
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
    assert.equal(f.task().resolution.runtimeRetirements[0].state, 'failed');
    assert.equal(f.task().resolution.runtimeRetirements[0].provedAt, null);
    assert.match(f.task().resolution.cleanupReason, /runtime retirement failed/i);
    assert.deepEqual(calls, [['container', 'retire', '--scope', 'a'.repeat(32), '--yes']]);
  });
});


// Task 390. An archive the adapter declines without an effect (a retained build
// output root) wrote no retry record, so every audit pass re-ran the whole proof
// — thread inventory, participant observation, Git source/publication proof and
// the build-output walk — for a cause that had not changed. The declined attempt
// now records the ordinary bounded retry the thrown refusals already use.
function proofCounters(store: Store, adapter: Awaited<ReturnType<typeof fixture>>['adapter'], api: any, taskId: string) {
  const counts = { proofs: 0, observe: 0, inventory: 0, catalog: 0, attempts: 0 };
  const archive = adapter.archiveTaskWorkspace!.bind(adapter);
  (adapter as any).archiveTaskWorkspace = (...args: any[]) => { counts.proofs++; return (archive as any)(...args); };
  const observe = adapter.observe.bind(adapter);
  adapter.observe = async (id: string) => { counts.observe++; return observe(id); };
  const list = api.agents.list;
  api.agents.list = async (...args: any[]) => { counts.inventory++; return list(...args); };
  const ref = api.workspaces.ref;
  api.workspaces.ref = (...args: any[]) => {
    const workspace = ref(...args), refresh = workspace.refresh;
    return { ...workspace, refresh: async () => { counts.catalog++; return refresh(); } };
  };
  const read = () => ({ ...counts,
    attempts: store.events(taskId).filter(event => event.kind === 'build_output_cleanup_intent').length });
  return { read };
}

/** A tracked root at node_modules: the archive declines without an effect, naming a durable reason. */
async function trackedBuildRoot(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(join(f.directory, 'node_modules'), 'tracked build root\n');
  await git(f.directory, 'add', '-A');
  await git(f.directory, 'commit', '-m', 'track a build output root');
  await git(f.directory, 'push', 'origin', f.task().branch);
  const head = await git(f.directory, 'rev-parse', 'HEAD');
  f.store.update(f.task().id, { prHead: head });
  return head;
}

weighted(4)('a retained build output refusal is re-proved only at its bounded retry interval', async t => {
  for (const next of ['repaired', 'changed'] as const) await t.test(next, async t => {
    const f = await fixture(t);
    f.remote.participant.status = 'closed';
    const head = await trackedBuildRoot(f);
    // Another owned workspace's own pending backoff is neither cleared nor consulted.
    const elsewhere = { workspaceId: 'closeout', attempts: 4, error: 'closeout history unavailable',
      nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() };
    f.updateResolution({ mergedCommit: head, syncedCommit: head, closeoutWorkspaceId: 'closeout',
      closeoutDirectory: join(f.root, 'closeout'), closeoutWorkspaceHead: head, workspaceArchiveRetries: [elsewhere] });
    const counters = proofCounters(f.store, f.adapter, f.api, f.task().id);
    const pass = () => new Lifecycle(f.engine).pass();
    await pass();
    assert.equal(f.remote.archives.length, 0, 'a retained root archives nothing');
    assert.ok(existsSync(f.directory), 'the retained workspace stays on disk');
    assert.equal(f.task().resolution.archiveIntentWorkspaceId, null, 'a declined archive records no intent');
    const declined = f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!;
    assert.match(declined.error, /Git reports tracked files at or under this build root/);
    assert.ok(Date.parse(declined.nextAttemptAt) > Date.now(), 'the ordinary backoff is due later');
    assert.deepEqual(f.task().resolution.workspaceArchiveRetries.filter(record => record.workspaceId === 'closeout'),
      [elsewhere], 'another workspace keeps its own record');
    assert.match(f.task().resolution.cleanupReason, /^Build output cleanup blocked: .*Git reports tracked files/,
      'the original reason stays visible');
    const settled = counters.read();
    assert.ok(settled.proofs === 1 && settled.observe > 0 && settled.attempts === 1, JSON.stringify(settled));
    await pass();
    await pass();
    assert.deepEqual(counters.read(), settled, 'no participant, catalog, Git or build output proof repeats inside the interval');
    assert.equal(f.remote.archives.length, 0);
    assert.equal(f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!.attempts, 1,
      'a pass inside the interval is not an attempt');
    assert.match(f.task().resolution.cleanupReason, /Git reports tracked files/, 'the reason survives every audit pass');
    // An owner retry is never held by the interval: it re-proves now.
    await assert.rejects(f.retry(), /Git reports tracked files/);
    assert.equal(counters.read().proofs, 2, 'an owner retry re-proves custody, source and publication');
    assert.equal(f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!.attempts, 2);
    assert.deepEqual(f.task().resolution.workspaceArchiveRetries.filter(record => record.workspaceId === 'closeout'),
      [elsewhere], 'an owner retry of one workspace leaves another workspace alone');
    // Past the interval the ordinary audit observes the cause again. Only this
    // workspace is due; the closeout workspace keeps its own future deadline.
    const due = () => f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries
      .map(record => record.workspaceId === 'ws' ? { ...record, nextAttemptAt: new Date(0).toISOString() } : record) });
    due();
    if (next === 'repaired') {
      await git(f.directory, 'rm', '--cached', 'node_modules');
      await rm(join(f.directory, 'node_modules'));
      await git(f.directory, 'commit', '-m', 'drop the tracked build root');
      await git(f.directory, 'push', 'origin', f.task().branch);
      const repaired = await git(f.directory, 'rev-parse', 'HEAD');
      f.store.update(f.task().id, { prHead: repaired });
      f.updateResolution({ mergedCommit: repaired, syncedCommit: repaired });
      await pass();
      assert.equal(f.remote.archives.length, 1, 'the repaired cause archives');
      assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
      assert.deepEqual(f.task().resolution.workspaceArchiveRetries.map(record => record.workspaceId), ['closeout'],
        'only the settled workspace loses its record');
      assert.equal(existsSync(f.directory), false);
      return;
    }
    // A changed refusal is observed at the interval and recorded in its own words.
    await git(f.directory, 'rm', '--cached', 'node_modules');
    await pass();
    const changed = f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!;
    assert.equal(changed.attempts, 3, 'the due pass re-observed the changed cause');
    assert.match(changed.error, /uncommitted files or unexpected commits/);
    assert.equal(f.remote.archives.length, 0);
    assert.ok(existsSync(join(f.directory, 'node_modules')), 'nothing is deleted under a refusal');
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  });
});

test('a reload resumes the same bounded archive refusal without repeating its proof', async t => {
  const f = await fixture(t);
  f.remote.participant.status = 'closed';
  const head = await trackedBuildRoot(f);
  f.updateResolution({ mergedCommit: head, syncedCommit: head, workspaceArchiveRetries: [] });
  await new Lifecycle(f.engine).pass();
  assert.equal(f.remote.archives.length, 0);
  const recorded = f.task().resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!;
  assert.match(recorded.error, /Git reports tracked files/);
  // A restarted service reads the durable record with a fresh store handle.
  const store = new Store(join(f.root, 'queue.sqlite'));
  const engine = new Engine(store, f.adapter, 0, () => true,
    new RuntimeRetirementService(store, async () => ({ code: 0, timedOut: false, spawnError: '', output: '{}' })));
  t.after(async () => { await engine.stop(); store.close(); });
  const reloaded = proofCounters(store, f.adapter, f.api, f.task().id);
  const baseline = reloaded.read();
  await new Lifecycle(engine).pass();
  assert.deepEqual(reloaded.read(), baseline,
    'the reloaded service does no proof work inside the interval');
  assert.equal(baseline.proofs, 0);
  assert.equal(store.task(f.task().id).resolution.workspaceArchiveRetries.find(record => record.workspaceId === 'ws')!.nextAttemptAt,
    recorded.nextAttemptAt, 'the record keeps its own deadline across the reload');
  assert.match(store.task(f.task().id).resolution.cleanupReason, /^Build output cleanup blocked: .*Git reports tracked files/);
  assert.equal(f.remote.archives.length, 0);
  assert.ok(existsSync(f.directory), 'the retained workspace is still there');
});

test('cleanup reobserves a closed participant across native archive before local teardown', async t => {
  const f = await fixture(t);
  f.remote.participant.status = 'closed';
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = () => ({ ...ref(), archive: async requestId => {
    f.remote.archives.push(requestId);
    f.remote.catalogued = false;
    f.remote.participant.activeTurnId = 'new-turn';
    return { archivedAt: new Date().toISOString() };
  } });
  await assert.rejects(f.retry(), /participants to become idle/);
  assert.ok(existsSync(f.directory), 'new liveness preserves local source after native delivery');
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws');
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.equal(f.remote.historyReads, 0);
  f.remote.participant.activeTurnId = null;
  await f.retry();
  assert.equal(existsSync(f.directory), false);
  assert.equal(f.remote.archives.length, 1, 'retry observes delivery before local teardown');
});
