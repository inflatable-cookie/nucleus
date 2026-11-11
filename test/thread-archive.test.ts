import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, qualifiedThreadArchiveEffectKey } from '../core/store/store';
import { archiveFinishedThreads } from '../core/workspaces/thread-archive';
import { profileSchema, submissionSchema, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ns-thread-archive-'));
  const store = new Store(join(directory, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('hostRegistry', [{ id: 'host', endpoint: 'fixture' }]);
  const initial = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  const task = store.update(initial.id, { phase: 'verifying', agentId: 'worker', workspaceId: 'workspace', coordinatorAgentId: 'coordinator' });
  const archived = new Set<string>(), calls: string[] = [];
  const adapter = {
    originAgent: async (id: string) => ({ id, workspaceId: 'workspace', title: '', archived: archived.has(id) }),
    archiveAgent: async (id: string) => { calls.push(id); archived.add(id); },
  } as Adapter;
  const run = (role: Run['role'], id: string, eventId = id): Run => ({ id, taskId: task.id, role, generation: task.coordinatorGeneration, head: 'b'.repeat(40), base: 'a'.repeat(40), workspaceId: 'workspace', agentId: id, profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true, completion: { taskId: task.id, runId: id, eventId, status: role === 'reviewer' ? 'changes_required' : 'recovered', summary: 'Finished', head: 'b'.repeat(40) } });
  return { store, task, adapter, archived, calls, run, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
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
