import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, qualifiedThreadArchiveEffectKey } from '../core/store/store';
import { archiveFinishedThreads, archiveReplacedReviewer, archiveSupersededWorkers, finishedThreadCleanupCatchUp, finishedThreadCleanupKey } from '../core/workspaces/thread-archive';
import { dispositionSchema } from '../shared/contracts';
import { profileSchema, submissionSchema, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { storedT3Labels } from './support/t3code-labels';
import { WIRE_LABEL_KEYS } from '../shared/wire-labels';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ns-thread-archive-'));
  const store = new Store(join(directory, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostRegistry', [{ id: 'host', endpoint: 'fixture' }]);
  const initial = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  const task = store.update(initial.id, { phase: 'verifying', agentId: 'worker', workspaceId: 'workspace', coordinatorAgentId: 'coordinator' });
  const archived = new Set<string>(), deleted = new Set<string>(), calls: string[] = [];
  const deletes: { id: string }[] = [];
  const adapter = {
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: '', archived: archived.has(id), deleted: deleted.has(id) }),
    archiveAgent: async (id: string) => { calls.push(id); archived.add(id); },
  } as Adapter;
  // A host that can remove a thread (T3Code): same observations, plus deletion.
  const t3Adapter = {
    ...adapter,
    deleteAgent: async (id: string) => { deletes.push({ id }); deleted.add(id); },
  } as Adapter;
  const run = (role: Run['role'], id: string, eventId = id): Run => ({ id, taskId: task.id, role, generation: task.coordinatorGeneration, head: 'b'.repeat(40), base: 'a'.repeat(40), workspaceId: 'workspace', agentId: id, profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true, completion: { taskId: task.id, runId: id, eventId, status: role === 'reviewer' ? 'changes_required' : 'recovered', summary: 'Finished', head: 'b'.repeat(40) } });
  return { store, task, adapter, t3Adapter, archived, deleted, calls, deletes, run, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('archive intent keys preserve legacy evidence and isolate host identities', () => {
  const f = fixture(); try {
    const a = f.store.threadArchiveKey('same', 'host');
    const b = f.store.threadArchiveKey('same', 'other');
    assert.ok(a && b); assert.notEqual(a, b);
    assert.throws(() => f.store.transaction(() => {
      f.store.putThreadArchiveEffect(a, 'same', { status: 'intent', at: 'now' });
      throw Error('rollback');
    }), /rollback/);
    assert.equal(f.store.getMeta(a), undefined); assert.equal(f.store.getMeta('threadArchive:same'), undefined);
    f.store.putThreadArchiveEffect(a, 'same', { status: 'intent', at: 'now' });
    assert.equal(f.store.getMeta(b), undefined);
    assert.equal(f.store.getMeta('threadArchive:same'), undefined);
    assert.equal(f.store.threadArchiveKey('same', 'other'), b);
    assert.equal(f.store.threadArchiveKey('same', null), null);
  } finally { f.close(); }
});

test('applied ordinary reviewer stays bound until replaced, retaining worker', async () => {
  const f = fixture(); try {
    const run = f.run('reviewer', 'reviewer-1'); f.store.putRun(run);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, reviewerAgentId: run.agentId, currentRunId: null } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    const current = f.store.task(f.task.id);
    f.store.update(f.task.id, { resolution: { ...current.resolution, review: run.completion } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.task(f.task.id).resolution.reviewerAgentId, run.agentId);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, reviewerAgentId: 'replacement' } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['reviewer-1']);
    assert.equal(f.archived.has('worker'), false);
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['reviewer-1']);
  } finally { f.close(); }
});

test('a retained reviewer for a live review-entry task is not archived with historical cleanup', async () => {
  const f = fixture(); try {
    const run = f.run('reviewer', 'review-entry-reviewer'); f.store.putRun(run);
    f.store.update(f.task.id, {
      entrypoint: 'review',
      reviewEntry: {
        operationId: 'a'.repeat(64), prNumber: 1, repository: 'example/repo', branch: 'feature',
        workspaceId: 'workspace', verifiedHead: 'b'.repeat(40), verifiedBase: 'a'.repeat(40), dispatchBase: null,
        planningCommit: 'a'.repeat(40), authority: 'owner',
        authorDeclaration: { models: ['test/author'], githubAuthor: 'author', authoringSystem: 'test', attestedBy: 'owner', provenance: 'fixture' },
        checkedAt: new Date().toISOString(), preserveWorkspace: true, directory: '/repo', workspaceMode: 'isolated',
        briefDigest: null, briefVersion: null,
      },
      resolution: { ...f.store.task(f.task.id).resolution, reviewerAgentId: run.agentId, currentRunId: null },
    });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.task(f.task.id).resolution.reviewerAgentId, run.agentId);
  } finally { f.close(); }
});

test('recovery coordinator stays across attempts and escalation, then archives after operator resolution', async () => {
  const f = fixture(); try {
    const run = f.run('recovery', 'coordinator'); f.store.putRun(run);
    const current = f.store.task(f.task.id);
    const recovery = { id: 'episode', key: 'fault', generation: current.coordinatorGeneration, runId: run.id, agentId: run.agentId, status: 'resolved' as const, summary: '', idleSince: null, incidentId: null };
    f.store.update(f.task.id, { resolution: { ...current.resolution, recovery, recoveryActive: false, recoveryAttempts: 1 } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    const second = f.run('recovery', 'coordinator'); second.id = 'second-attempt'; second.completion = { ...second.completion!, runId: second.id, eventId: second.id }; f.store.putRun(second);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, recovery: { ...recovery, runId: second.id, status: 'resolved' }, recoveryAttempts: 2 } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, recovery: { ...recovery, runId: second.id, status: 'escalated' } } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    f.store.event(f.task.id, 'escalation_resolved', 'operator answered');
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, recovery: { ...recovery, runId: second.id } } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['coordinator']);
    assert.equal(f.store.task(f.task.id).coordinatorAgentId, '');
  } finally { f.close(); }
});

test('restart reconciles an observed archive without sending again; uncertain archive does not block progress', async () => {
  const f = fixture(); try {
    const run = f.run('reviewer', 'reviewer-1'); f.store.putRun(run);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, review: run.completion, reviewerAgentId: run.agentId } });
    f.store.setMeta(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'), { status: 'intent', at: new Date().toISOString() });
    f.archived.add('reviewer-1');
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'))?.status, 'archived');
    const second = f.run('reviewer', 'reviewer-2'); f.store.putRun(second);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, review: second.completion, reviewerAgentId: 'replacement' } });
    f.adapter.archiveAgent = async () => { throw Error('transport uncertain'); };
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.equal(f.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'reviewer-2'))?.status, 'uncertain');
    assert.equal(f.store.task(f.task.id).phase, 'verifying');
    f.archived.add('reviewer-2');
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.equal(f.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'reviewer-2'))?.status, 'archived');
  } finally { f.close(); }
});

test('restart with a live prior intent never sends a second archive', async () => {
  const f = fixture(); try {
    const run = f.run('reviewer', 'reviewer-1'); f.store.putRun(run);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, review: run.completion } });
    f.store.setMeta(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'), { status: 'intent', at: new Date().toISOString() });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
    assert.equal(f.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'))?.status, 'uncertain');
  } finally { f.close(); }
});

test('an applied review remains archivable after the task projection moves on', async () => {
  const f = fixture(); try {
    const run = f.run('reviewer', 'reviewer-1'); f.store.putRun(run);
    f.store.event(f.task.id, 'review_result_applied', run.id);
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['reviewer-1']);
  } finally { f.close(); }
});

test('a third resolved recovery attempt retires the coordinator binding', async () => {
  const f = fixture(); try {
    const run = f.run('recovery', 'coordinator'); f.store.putRun(run);
    const current = f.store.task(f.task.id);
    f.store.update(f.task.id, { resolution: { ...current.resolution, recovery: { id: 'episode', key: 'fault', generation: current.coordinatorGeneration, runId: run.id, agentId: run.agentId, status: 'resolved', summary: '', idleSince: null, incidentId: null }, recoveryAttempts: 3, recoveryActive: false } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['coordinator']);
  } finally { f.close(); }
});

test('a released superseded executor is archived while the retained executor, worker and reviewer stay live', async () => {
  const f = fixture(); try {
    const oldExecutor = f.run('executor', 'old-executor');
    const retainedExecutor = f.run('executor', 'retained-executor');
    f.store.putRun(oldExecutor);
    f.store.putRun(retainedExecutor);
    const reviewer = f.run('reviewer', 'reviewer-1');
    f.store.putRun(reviewer);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, reviewerAgentId: reviewer.agentId, currentRunId: null,
      review: reviewer.completion } });

    await archiveFinishedThreads(f.store, f.adapter, f.task.id);

    assert.deepEqual(f.calls, ['old-executor']);
    assert.equal(f.archived.has('retained-executor'), false);
    assert.equal(f.archived.has('worker'), false);
    assert.equal(f.archived.has('reviewer-1'), false);
  } finally { f.close(); }
});

test('a merged, done task archives every thread Queue created for it, whatever its role or idle tool labels, and never a thread it does not own (Tom, 2026-10-19)', async () => {
  const f = fixture(); try {
    const labels: Record<string, Record<string, string>> = {
      worker: { 'northstar.task': f.task.id }, 'retired-worker': { 'northstar.task': f.task.id },
      'unapplied-reviewer': { 'northstar.task': f.task.id }, 'blocked-revision': { 'northstar.task': f.task.id },
      'adopted-elsewhere': { 'northstar.task': 'another-task' },
    };
    Object.assign(f.adapter, { observe: async (id: string) => ({ id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', labels: labels[id] ?? {} }) });
    // A reviewer whose result was never the applied one, and a revision that ended blocked: the ordinary rules keep both.
    const reviewer = f.run('reviewer', 'unapplied-reviewer'); reviewer.completion = { ...reviewer.completion!, status: 'blocked' }; f.store.putRun(reviewer);
    const revision = f.run('revision', 'blocked-revision'); f.store.putRun(revision);
    const foreign = f.run('reviewer', 'adopted-elsewhere'); f.store.putRun(foreign);
    f.store.update(f.task.id, { phase: 'done', retiredWorkers: [{ agentId: 'retired-worker', runId: 'old', profile: profileSchema.parse({ id: 'worker-profile', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] }), reason: 'replaced' }],
      resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual([...f.calls].sort(), ['blocked-revision', 'retired-worker', 'unapplied-reviewer', 'worker']);
    assert.equal(f.archived.has('adopted-elsewhere'), false, 'a thread labelled for another task is never archived');
    assert.equal(f.archived.has('coordinator'), false, 'the coordinator binding alone is not ownership');
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.equal(f.calls.length, 4, 'each thread is archived once');
  } finally { f.close(); }
});

test('an unmerged task keeps its worker and its unapplied reviewer threads', async () => {
  const f = fixture(); try {
    Object.assign(f.adapter, { observe: async (id: string) => ({ id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '', labels: { 'northstar.task': f.task.id } }) });
    const reviewer = f.run('reviewer', 'unapplied-reviewer'); reviewer.completion = { ...reviewer.completion!, status: 'blocked' }; f.store.putRun(reviewer);
    f.store.update(f.task.id, { phase: 'done' });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('a completed proof-only task archives its leftover task-bound agents after closeout', async () => {
  const f = fixture(); try {
    const task = f.store.update(f.task.id, { phase: 'done', entrypoint: 'proof', proofOnly: { commit: 'b'.repeat(40) },
      proofOnlyResult: { status: 'passed', commit: 'b'.repeat(40), selector: 'effigy check', executionRunId: 'executor-run',
        reviewerRunId: 'reviewer-run', evidence: 'Qualification passed.' } });
    f.store.putRun(f.run('executor', 'executor-agent'));
    f.store.putRun(f.run('reviewer', 'reviewer-agent'));
    Object.assign(f.adapter, { observe: async (id: string) => ({ id, workspaceId: 'workspace', status: 'idle', active: false,
      permissions: false, error: '', labels: { 'northstar.task': task.id } }) });

    await archiveFinishedThreads(f.store, f.adapter, task.id);

    assert.deepEqual([...f.calls].sort(), ['executor-agent', 'reviewer-agent', 'worker']);
    assert.ok(f.store.eventsAll(task.id).filter(event => event.kind === 'thread_archive_observed').length === 3);
  } finally { f.close(); }
});

test('a merged task never archives a thread still serving another task, or one with an active turn or pending permission (review #543)', async () => {
  const f = fixture(); try {
    const state: Record<string, { status: string; active: boolean; permissions: boolean }> = {
      worker: { status: 'idle', active: false, permissions: false },
      'busy-reviewer': { status: 'running', active: true, permissions: false },
      'asking-revision': { status: 'idle', active: false, permissions: true },
    };
    Object.assign(f.adapter, { observe: async (id: string) => ({ id, workspaceId: 'workspace', error: '', labels: { 'northstar.task': f.task.id }, ...(state[id] ?? { status: 'idle', active: false, permissions: false }) }) });
    f.store.putRun(f.run('reviewer', 'busy-reviewer'));
    f.store.putRun(f.run('revision', 'asking-revision'));
    // The merged task's worker was remapped as another live task's coordinator and holds an unreleased run there.
    const other = f.store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Other', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'other.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    f.store.update(other.id, { phase: 'closing', coordinatorAgentId: 'worker' });
    f.store.putRun({ ...f.run('closeout', 'worker'), id: 'other-closeout', taskId: other.id, released: false, completion: null });
    f.store.update(f.task.id, { phase: 'done', resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, [], 'no shared, active or permission-bound thread is archived');
    // Once the turn ends and the permission is answered, the next pass archives them.
    state['busy-reviewer'] = { status: 'idle', active: false, permissions: false };
    state['asking-revision'] = { status: 'idle', active: false, permissions: false };
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual([...f.calls].sort(), ['asking-revision', 'busy-reviewer']);
    assert.equal(f.archived.has('worker'), false, 'the shared worker stays while the other task needs it');
  } finally { f.close(); }
});

test('a failed observation before archive delivery can retry without replaying an unknown delivery', async () => {
  const f = fixture(); try {
    const run = f.run('reviewer', 'reviewer-1'); f.store.putRun(run);
    f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, review: run.completion } });
    const origin = f.adapter.originAgent!;
    f.adapter.originAgent = async () => { throw Error('Transport not connected'); };
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.equal(f.store.getMeta<{status: string}>(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'))?.status, 'ready');
    assert.deepEqual(f.calls, []);
    f.adapter.originAgent = origin;
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['reviewer-1']);
    assert.equal(f.store.getMeta<{status: string}>(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'))?.status, 'archived');
  } finally { f.close(); }
});

/** Labels and idleness the terminal lane reads before it touches one owned thread. */
function ownedAndIdle(f: ReturnType<typeof fixture>, extra: Record<string, { status?: string; active?: boolean; permissions?: boolean }> = {}) {
  Object.assign(f.adapter, { observe: async (id: string) => ({ id, workspaceId: 'workspace', error: '', labels: { 'northstar.task': f.task.id },
    status: 'idle', active: false, permissions: false, ...(extra[id] ?? {}) }) });
  Object.assign(f.t3Adapter, { observe: async (id: string) => {
    const run = f.store.runs(f.task.id).findLast(candidate => candidate.agentId === id);
    const role = !run || run.role === 'revision' ? 'worker' : run.role;
    return { id, workspaceId: 'workspace', error: '',
      labels: storedT3Labels(role, { taskId: f.task.id, runId: run?.id ?? 'synthetic-worker-run' }),
      status: 'idle', active: false, permissions: false, ...(extra[id] ?? {}) };
  } });
}

test('a task whose host can remove threads keeps its released support threads settled, never archived, and retains its reviewer and recovery bindings (#1155)', async () => {
  const f = fixture(); try {
    const reviewer = f.run('reviewer', 'reviewer-1'); f.store.putRun(reviewer);
    const recovery = f.run('recovery', 'coordinator'); f.store.putRun(recovery);
    const executor = f.run('executor', 'executor-1'); f.store.putRun(executor);
    const current = f.store.task(f.task.id);
    f.store.update(f.task.id, { resolution: { ...current.resolution, review: reviewer.completion, reviewerAgentId: reviewer.agentId,
      recovery: { id: 'episode', key: 'fault', generation: current.coordinatorGeneration, runId: recovery.id, agentId: recovery.agentId,
        status: 'resolved', summary: '', idleSince: null, incidentId: null }, recoveryActive: false, recoveryAttempts: 3 } });

    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);

    assert.deepEqual(f.calls, [], 'nothing is archived while the task is open');
    assert.equal(f.deletes.length, 0, 'nothing is removed while the task is open');
    const after = f.store.task(f.task.id);
    assert.equal(after.resolution.reviewerAgentId, 'reviewer-1', 'the retained reviewer binding stays, so the next round continues the same thread');
    assert.equal(after.coordinatorAgentId, 'coordinator', 'the retained recovery binding stays, so a second fault continues the same thread');
    assert.equal(f.store.eventsAll(f.task.id).some(event => ['reviewer_thread_released', 'recovery_thread_released'].includes(event.kind)), false);
  } finally { f.close(); }
});

test('at closeout a host that can remove threads archives the worker thread and deletes every support thread once (#1155)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    const reviewer = f.run('reviewer', 'reviewer-1'); f.store.putRun(reviewer);
    const recovery = f.run('recovery', 'coordinator'); f.store.putRun(recovery);
    const executor = f.run('executor', 'executor-1'); f.store.putRun(executor);
    const retired = f.run('revision', 'retired-worker'); f.store.putRun(retired);
    // A support thread archived earlier in the task's life — a replaced executor —
    // is still removed at closeout, under its own fresh cleanup record.
    const replacedExecutor = f.run('executor', 'old-executor'); f.store.putRun(replacedExecutor);
    f.store.putThreadArchiveEffect(qualifiedThreadArchiveEffectKey('host', 'old-executor'), 'old-executor',
      { status: 'archived', at: new Date().toISOString(), detail: 'Archive observed' });
    f.archived.add('old-executor');
    f.store.update(f.task.id, { phase: 'done', retiredWorkers: [{ agentId: 'retired-worker', runId: retired.id,
      profile: profileSchema.parse({ id: 'worker-profile', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] }), reason: 'replaced' }],
      resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });

    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);

    assert.deepEqual([...f.calls].sort(), ['retired-worker', 'worker'], 'the worker threads are archived');
    assert.deepEqual(f.deletes.map(item => item.id).sort(), ['coordinator', 'executor-1', 'old-executor', 'reviewer-1'],
      'every reviewer, recovery, coordinator and executor thread is removed, including one archived earlier');
    assert.deepEqual(f.deleted, new Set(['coordinator', 'executor-1', 'old-executor', 'reviewer-1']));
    assert.equal(f.archived.has('reviewer-1'), false, 'a support thread is never archived before it is removed');

    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual([...f.calls].sort(), ['retired-worker', 'worker'], 'each worker thread is archived once');
    assert.equal(f.deletes.length, 4, 'each support thread is removed once');
    assert.equal(f.store.eventsAll(f.task.id).filter(event => event.kind === 'thread_archive_observed').length, 6);
  } finally { f.close(); }
});

test('ordinary terminal cleanup records completion before a later catch-up query (#1155)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    f.store.putRun(f.run('reviewer', 'reviewer-1'));
    f.store.putRun(f.run('recovery', 'coordinator'));
    f.store.update(f.task.id, { phase: 'done',
      resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });
    const key = finishedThreadCleanupKey(f.task.id);
    assert.equal(f.store.getMeta(key), undefined);

    // Ordinary closeout can finish before the sweep queries for outstanding
    // effects. Its common terminal lane must retain that completion evidence.
    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    const completedAt = f.store.getMeta(key);
    assert.ok(completedAt, 'ordinary cleanup records completion without running catch-up');
    assert.deepEqual(finishedThreadCleanupCatchUp(f.store, 'host', true), [],
      'a cleaned task is excluded from the later catch-up query');
    assert.deepEqual(f.calls, ['worker']);
    assert.deepEqual(f.deletes.map(item => item.id).sort(), ['coordinator', 'reviewer-1']);

    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.equal(f.store.getMeta(key), completedAt, 'completion is recorded once per task');
    assert.equal(f.calls.length, 1);
    assert.equal(f.deletes.length, 2);
  } finally { f.close(); }
});

test('terminal cleanup archives a historical revision worker missing from current and retired bindings, and deletes labelled recovery (#1155)', async () => {
  const f = fixture(); try {
    const revision = f.run('revision', 'historical-worker'); f.store.putRun(revision);
    const recovery = f.run('recovery', 'historical-recovery'); f.store.putRun(recovery);
    ownedAndIdle(f);
    f.store.update(f.task.id, { phase: 'done', retiredWorkers: [],
      resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });

    const workerState = await f.t3Adapter.observe(revision.agentId!);
    assert.deepEqual(workerState.labels, storedT3Labels('worker', { taskId: f.task.id, runId: revision.id }),
      'the historical worker carries the stored worker shape with no role');
    assert.ok(!Object.hasOwn(workerState.labels!, WIRE_LABEL_KEYS.role));
    const recoveryState = await f.t3Adapter.observe(recovery.agentId!);
    assert.deepEqual(recoveryState.labels, storedT3Labels('recovery', { taskId: f.task.id, runId: recovery.id }));

    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual([...f.calls].sort(), ['historical-worker', 'worker'], 'both worker identities are archived');
    assert.deepEqual(f.deletes.map(item => item.id), ['historical-recovery'], 'the labelled recovery thread is deleted');
    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.equal(f.calls.length, 2, 'each worker archive happens once');
    assert.equal(f.deletes.length, 1, 'the recovery deletion happens once');
  } finally { f.close(); }
});

test('a lost thread.delete reply is read back from the host before anything else, and a removal that never landed stays observation-only (#1155)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    const reviewer = f.run('reviewer', 'reviewer-1'); f.store.putRun(reviewer);
    f.store.update(f.task.id, { phase: 'done', resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });

    // The removal landed but its reply was lost: the recorded outcome is unknown.
    const landed = f.t3Adapter.deleteAgent!;
    f.t3Adapter.deleteAgent = async (id) => { await landed.call(f.t3Adapter, id); throw Error('T3Code transport: thread.delete'); };
    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.equal(f.deleted.has('reviewer-1'), true);
    assert.equal(f.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'))?.status, 'uncertain');

    // Even the last permitted attempt must read before its retry-limit check.
    const key = qualifiedThreadArchiveEffectKey('host', 'reviewer-1');
    f.store.setMeta(key, { ...f.store.getMeta<Record<string, unknown>>(key), retries: 3 });
    // The next pass reads the host's own answer before anything else.
    f.t3Adapter.deleteAgent = landed;
    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.equal(f.deletes.length, 1, 'an observed removal is never sent a second time');
    assert.equal(f.store.getMeta<{ status: string; detail?: string }>(qualifiedThreadArchiveEffectKey('host', 'reviewer-1'))?.status, 'archived');

    // A removal that never landed is never re-sent: the lane keeps reading the
    // thread and records the wait, and no second command reaches the host.
    const second = fixture(); try {
      ownedAndIdle(second);
      const other = second.run('recovery', 'coordinator'); second.store.putRun(other);
      second.store.update(second.task.id, { phase: 'done', resolution: { ...second.store.task(second.task.id).resolution, mergedCommit: 'c'.repeat(40) } });
      let calls = 0;
      second.t3Adapter.deleteAgent = async (id) => { calls += 1; throw Error('T3Code transport: connection lost'); };
      await archiveFinishedThreads(second.store, second.t3Adapter, second.task.id, async () => null);
      assert.equal(second.deleted.has('coordinator'), false, 'the failed removal changed nothing on the host');
      assert.equal(second.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'coordinator'))?.status, 'uncertain');
      for (let pass = 0; pass < 3; pass++) await archiveFinishedThreads(second.store, second.t3Adapter, second.task.id, async () => null);
      assert.equal(calls, 1, 'a removal whose outcome is unknown is never sent again');
      assert.equal(second.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'coordinator'))?.status, 'uncertain');
    } finally { second.close(); }
  } finally { f.close(); }
});

test('a Paseo-bound task keeps today\'s thread handling: released support threads are archived, and closeout archives every thread (#1155)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    const reviewer = f.run('reviewer', 'reviewer-1'); f.store.putRun(reviewer);
    const current = f.store.task(f.task.id);
    f.store.update(f.task.id, { resolution: { ...current.resolution, review: reviewer.completion, currentRunId: null } });
    // The adapter has no deleteAgent, so nothing changes for a host that cannot remove a thread.
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['reviewer-1']);
    assert.equal(f.deletes.length, 0);

    f.store.update(f.task.id, { phase: 'done', resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual([...f.calls].sort(), ['reviewer-1', 'worker']);
    assert.equal(f.deletes.length, 0, 'a host without removal never deletes');
  } finally { f.close(); }
});

test('a displaced reviewer stays settled while a removable host keeps its task open, and is removed at closeout; Paseo keeps its archive fence (#1155)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    const seeded = f.run('reviewer', 'reviewer-1');
    // A displaced reader: no verdict, its turn already stopped by the verb.
    f.store.putRun({ ...seeded, released: false, status: 'running', completion: null });
    const reviewer = f.store.run(seeded.id)!;

    // A live turn is never fenced: the verb stops it first.
    Object.assign(f.t3Adapter, { observe: async (id: string) => ({ id, workspaceId: 'workspace', error: '',
      labels: storedT3Labels('reviewer', { taskId: f.task.id, runId: reviewer.id }), status: 'running', active: true, permissions: false }) });
    assert.equal(await archiveReplacedReviewer(f.store, f.t3Adapter, reviewer), false);

    // The fence is the stopped, idle thread with its released run: nothing is
    // archived or removed while the task is open.
    ownedAndIdle(f);
    Object.assign(f.t3Adapter, { settleReportedThread: async () => {} });
    assert.equal(await archiveReplacedReviewer(f.store, f.t3Adapter, reviewer), true);
    assert.equal(f.calls.length, 0, 'nothing is archived while the task is open');
    assert.equal(f.deletes.length, 0, 'and nothing is removed while the task is open');
    assert.equal(f.store.getMeta(qualifiedThreadArchiveEffectKey('host', 'reviewer-1')), undefined,
      'a removal fence records no effect before closeout');

    // The displaced thread is removed at closeout like the rest of the support set.
    f.store.putRun({ ...f.store.run('reviewer-1')!, released: true, status: 'superseded' });
    f.store.update(f.task.id, { phase: 'done', resolution: { ...f.store.task(f.task.id).resolution, mergedCommit: 'c'.repeat(40) } });
    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual(f.deletes.map(item => item.id), ['reviewer-1']);
    assert.deepEqual(f.calls, ['worker']);

    // Paseo keeps the archive fence it has today.
    const paseo = fixture(); try {
      ownedAndIdle(paseo);
      const seededPaseo = paseo.run('reviewer', 'reviewer-2');
      paseo.store.putRun({ ...seededPaseo, released: false, status: 'running', completion: null });
      assert.equal(await archiveReplacedReviewer(paseo.store, paseo.adapter, paseo.store.run(seededPaseo.id)!), true);
      assert.deepEqual(paseo.calls, ['reviewer-2'], 'a host without removal archives the displaced thread');
    } finally { paseo.close(); }
  } finally { f.close(); }
});

test('a completed cancellation cleans up its threads like a merge: the worker archived and its support threads removed (#1155 review)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    const reviewer = f.run('reviewer', 'reviewer-1'); f.store.putRun(reviewer);
    const recovery = f.run('recovery', 'coordinator'); f.store.putRun(recovery);
    f.store.update(f.task.id, { phase: 'cancelled', disposition: dispositionSchema.parse({ kind: 'cancel', status: 'complete',
      requestedAt: new Date().toISOString(), requestedBy: 'operator (board)', reason: 'Superseded by another priority',
      workDisposition: 'preserve', completedAt: new Date().toISOString() }),
      resolution: { ...f.store.task(f.task.id).resolution, recovery: null, recoveryActive: false } });

    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);

    assert.deepEqual(f.calls, ['worker'], 'a cancelled task archives its worker thread');
    assert.deepEqual(f.deletes.map(item => item.id).sort(), ['coordinator', 'reviewer-1'],
      'and removes every support thread');
    // Nothing durable is lost and each effect is idempotent.
    await archiveFinishedThreads(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual(f.calls, ['worker']);
    assert.equal(f.deletes.length, 2);
  } finally { f.close(); }
});

test('a completed Paseo cancellation keeps the existing support-only archive path (#1155)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    const reviewer = f.run('reviewer', 'reviewer-1'); f.store.putRun(reviewer);
    f.store.update(f.task.id, { phase: 'cancelled', disposition: dispositionSchema.parse({ kind: 'cancel', status: 'complete',
      requestedAt: new Date().toISOString(), requestedBy: 'operator (board)', reason: 'Superseded',
      workDisposition: 'preserve', completedAt: new Date().toISOString() }),
      resolution: { ...f.store.task(f.task.id).resolution, review: reviewer.completion, currentRunId: null } });
    await archiveFinishedThreads(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['reviewer-1'], 'the terminal lane does not add a worker archive on Paseo');
    assert.deepEqual(f.deletes, []);
  } finally { f.close(); }
});

test('a superseded worker is archived at once on a host that can remove threads, and never on Paseo (#1181)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f);
    f.store.update(f.task.id, { retiredWorkers: [{ agentId: 'old-worker', runId: 'old-run',
      profile: profileSchema.parse({ id: 'worker-profile', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] }), reason: 'route now to another profile' }] });

    await archiveSupersededWorkers(f.store, f.t3Adapter, f.task.id);

    assert.deepEqual(f.calls, ['old-worker'], 'the superseded worker thread is archived while the task is open');
    assert.deepEqual(f.deletes, [], 'a worker thread is archived, never removed');
    assert.equal(f.archived.has('worker'), false, 'the current worker thread stays');
    assert.equal(f.store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey('host', 'old-worker'))?.status, 'archived');

    await archiveSupersededWorkers(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual(f.calls, ['old-worker'], 'each superseded worker is archived exactly once');

    await archiveSupersededWorkers(f.store, f.adapter, f.task.id);
    assert.deepEqual(f.calls, ['old-worker'], 'Paseo keeps its existing handling: nothing is archived mid-task');
  } finally { f.close(); }
});

test('a superseded worker waits while its run is unreleased or its turn is still live (#1181)', async () => {
  const f = fixture(); try {
    ownedAndIdle(f, { 'old-worker': { status: 'running', active: true } });
    f.store.update(f.task.id, { retiredWorkers: [{ agentId: 'old-worker', runId: 'old-run',
      profile: profileSchema.parse({ id: 'worker-profile', name: 'Worker', provider: 'test', model: 'test/worker', notes: '', available: true, problem: '', supportedThinking: [] }), reason: 'route now to another profile' }] });
    f.store.putRun({ ...f.run('revision', 'old-run'), agentId: 'old-worker', released: false, completion: null });

    await archiveSupersededWorkers(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual(f.calls, [], 'an unreleased run fences the archive');

    f.store.putRun({ ...f.store.run('old-run')!, released: true });
    await archiveSupersededWorkers(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual(f.calls, [], 'a live turn still waits for the next pass');

    ownedAndIdle(f);
    await archiveSupersededWorkers(f.store, f.t3Adapter, f.task.id);
    assert.deepEqual(f.calls, ['old-worker'], 'the released, idle thread is archived once its run ends');
  } finally { f.close(); }
});
