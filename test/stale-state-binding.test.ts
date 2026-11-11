import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { incidentBindsCurrentWork, taskStopKind, runBindsCurrentWork, taskControlInputSchema, taskNextSchema, runSchema, submissionSchema,
  type Incident, type Notice, type Run, type Task } from '../shared/contracts';
import { acceptControl, fixture as continuationFixture, reviewControl } from './support/review-continuation-fixture';
import type { Adapter, AgentObservation } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

/**
 * Stale state never fences current work (papercuts 89643af2, 6ff5e903,
 * 4cfb2d35, 4b285a6e, 1792f99d). One rule: a record that names a released run
 * names superseded work, so it never refuses, reclassifies or supplies the
 * actionable text for the current work. Each case below is the observed sequence
 * from its papercut, and each assertion is the current work continuing.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40), otherHead = 'c'.repeat(40);
const CALLER = 'owner-thread';


function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-stale-binding-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const worker = profile('worker', 'test/worker'), reviewer = profile('reviewer', 'test/reviewer'), coord = profile('coord', 'test/coord');
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
    { profileId: coord.id, enabled: true, group: 'coord', roles: ['coordinator'], weight: 1, scopes: ['general'] },
  ]);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Stale state never fences current work', repoPath: '/repo',
    planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, model: string, workspaceId = 'workspace') =>
    observations.set(id, { id, workspaceId, status: 'idle', active: false, permissions: false, error: '', provider: 'test', model });
  idle('worker-agent', worker.model); idle('review-agent', reviewer.model); idle('coord-agent', coord.model);
  const notices: { agentId: string; messageId: string; text: string }[] = [];
  const adapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coord], validate: async () => base,
    verifyWorkspace: async () => {}, createWorkspace: async () => { throw new Error('fixtures create no workspaces'); },
      findRunAgents: async () => [],
    createAgent: async () => { throw new Error('fixtures create no agents'); },
    createRun: async () => { throw new Error('fixtures dispatch no runs'); },
    sendRun: async () => {},
    notify: async (agentId: string, messageId: string, text: string) => { notices.push({ agentId, messageId, text }); },
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    verifyPr: async () => ({ head: store.task(submitted.id).prHead ?? head, url: 'https://github.com/example/repo/pull/7' }),
    verifyPrIdentity: async () => ({ head: store.task(submitted.id).prHead ?? head, url: 'https://github.com/example/repo/pull/7' }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {}, verifyReview: async () => 4242, publishReview: async () => 4242,
    mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => otherHead, verifyCloseout: async () => {},
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer, coord];
  const task = () => store.task(submitted.id);
  const run = (id: string) => store.run(id)!;
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task())));
  const observation = (id: string) => observations.get(id);
  return { dir, store, engine, adapter, notices, taskId: submitted.id, profiles: { worker, reviewer, coord },
    task, run, next, observations, idle, observation,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof fixture>;

const at = new Date().toISOString();

function reviewerRun(f: Fixture, overrides: Partial<Run> = {}): Run {
  return runSchema.parse({
    id: 'review-run', taskId: f.taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent',
    workspaceId: 'workspace', profile: f.profiles.reviewer, status: 'finished', createdAt: at, lastObservedAt: at,
    active: false, idleSince: null, completion: null, released: true, ...overrides,
  });
}

function incidentFor(runId: string | null, status: Incident['status'] = 'reconciling'): Incident {
  return { id: `incident-${runId ?? 'task'}`, fingerprint: `incident-${runId ?? 'task'}`, role: 'reviewer', runId,
    turnId: null, attempt: 1, cause: 'provider_transient', detail: 'External merge check: transient GitHub connection failure',
    action: '', status, createdAt: at, updatedAt: at };
}

function reviewingTask(f: Fixture, patch: Partial<Task> = {}): Task {
  return f.store.update(f.taskId, {
    phase: 'reviewing', workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: f.profiles.worker, workerModel: f.profiles.worker.model,
    prHead: head, prUrl: 'https://github.com/example/repo/pull/7',
    completion: { taskId: f.taskId, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 7 },
    ...patch,
  }, 'test_fixture');
}

test('the binding rule is one derivation: a released run is superseded history wherever it is read', async () => {
  const f = fixture(); try {
    const task = reviewingTask(f, { resolution: { ...f.task().resolution, incident: incidentFor('released-review') } });
    const released = reviewerRun(f, { id: 'released-review', status: 'superseded', released: true });
    f.store.putRun(released);
    assert.equal(runBindsCurrentWork([released], released.id), false);
    assert.equal(runBindsCurrentWork([released], 'no-run-record'), true, 'an unreadable identity keeps its existing handling');
    assert.equal(runBindsCurrentWork([released], null), true, 'a record naming no run is not superseded by this rule');
    assert.equal(incidentBindsCurrentWork(task, [released]), false);
    assert.equal(taskStopKind(task, [released]), null, 'a superseded incident is not the stop or wait kind');
    const open = reviewerRun(f, { id: 'open-review', status: 'running', released: false, completion: null, active: true });
    f.store.putRun(open);
    f.store.update(f.taskId, { resolution: { ...f.task().resolution, incident: incidentFor(open.id) } }, 'incident_recorded');
    assert.equal(incidentBindsCurrentWork(f.task(), [released, open]), true, 'a fault on an unreleased run still binds');
    assert.equal(taskStopKind(f.task(), [released, open]), 'incident');
  } finally { await f.close(); }
});

test('an earlier reviewer reconciliation incident never fences the current retained reader (papercut 89643af2)', async () => {
  const f = continuationFixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Proofs'] });
    const recorded = new Date().toISOString();
    // The predecessor run is released and the replacement reader holds the exact
    // authenticated checkpoint; only the old incident still says reconciling.
    f.store.putRun(runSchema.parse({ id: 'predecessor-review', taskId: f.submitted.id, role: 'reviewer', generation: 1,
      head, base, agentId: 'predecessor-agent', workspaceId: 'workspace', profile: f.run().profile, status: 'superseded',
      createdAt: recorded, lastObservedAt: recorded, active: false, idleSince: null, completion: null, released: true,
      briefVersion: f.current().briefVersions.at(-1)?.version ?? null }));
    f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
      incident: incidentFor('predecessor-review') } }, 'incident_recorded');
    const view = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())));
    const restart = view.verbs.find(verb => verb.verb === 'restart')!;
    assert.equal(restart.available, true, restart.refusal ?? 'the superseded incident must not refuse the continuation');
    const result = await acceptControl(f, reviewControl(f));
    assert.notEqual(result.state, 'failed', result.diagnostic);
    assert.equal(f.reviewerDeliveries.length, 1, 'the current reader continues once');
    assert.equal(f.current().resolution.incident?.status, 'resolved',
      'the owner control settles the superseded incident with the fences it supersedes');
    assert.equal(f.store.run('predecessor-review')!.released, true, 'the predecessor stays released history');
  } finally { await f.close(); }
});

test('an accepted changes_required review with a finished reviewer returns the task to its author (papercut 4cfb2d35)', async () => {
  const f = fixture(); try {
    const completion = { taskId: f.taskId, runId: 'review-run', eventId: 'review-changes', status: 'changes_required' as const,
      summary: 'Fix the bounds check', head, reviewText: 'The bounds check accepts an empty range.', reviewCommentId: 4242 };
    const verdict = reviewerRun(f, { completion });
    f.store.putRun(verdict);
    // The accepted verdict is recorded and its reviewer is finished; only the
    // phase still says a review is running.
    const task = reviewingTask(f, { resolution: { ...f.task().resolution, currentRunId: null, review: completion } });
    assert.equal(task.phase, 'reviewing');
    await f.engine.resolution.advance(f.task());
    const after = f.task();
    assert.equal(after.phase, 'changes_requested', after.reason);
    assert.equal(after.resolution.review?.runId, verdict.id, 'the accepted verdict is kept as recorded evidence');
    assert.equal(after.resolution.pendingWorkerInstruction, 'Fix the bounds check');
    assert.equal(after.resolution.currentRunId, null);
    assert.ok(f.store.eventsAll(f.taskId).some(event => event.kind === 'stale_review_phase_reconciled'));
    // The reconciliation is a phase read only: it publishes, verifies and
    // applies nothing twice.
    await f.engine.resolution.advance(f.task());
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'stale_review_phase_reconciled').length, 1);
    assert.equal(f.store.eventsAll(f.taskId).filter(event => event.kind === 'review_result_applied').length, 0, 'no review credit is invented');
  } finally { await f.close(); }
});

test('a pre-send owner-control refusal settles definite instead of as unknown delivery (papercut 4b285a6e)', async () => {
  const f = fixture(); try {
    const task = reviewingTask(f, { resolution: { ...f.task().resolution, currentRunId: null, attention: true, recoveryActive: true,
      recovery: { id: 'episode', key: 'episode-key', generation: 1, runId: 'recovery-run', agentId: 'coord-agent', status: 'running',
        summary: 'Reconciling the review', idleSince: null, incidentId: null, action: null } } });
    f.store.putRun(runSchema.parse({ id: 'recovery-run', taskId: task.id, role: 'recovery', generation: 1, head, base,
      agentId: 'coord-agent', workspaceId: 'workspace', profile: f.profiles.coord, status: 'running', createdAt: at,
      lastObservedAt: at, active: true, idleSince: null, completion: null, released: false }));
    const control = taskControlInputSchema.parse({
      taskId: f.taskId, version: f.task().version, action: 'restart', role: 'coordinator', reason: 'Reconcile the review', caller: CALLER,
    });
    const before = f.task(), runsBefore = f.store.runs(f.taskId);
    const accepted = await f.engine.startOperation({ key: `stale-binding-${randomUUID()}`, kind: 'task_control', payload: { type: 'task_control', control },
      taskId: control.taskId, expectedVersion: control.version });
    assert.ok('accepted' in accepted);
    const settled = await f.engine.awaitOperation(accepted.operation.id);
    // The refusal is raised by Queue's own retained-run gate before any binding,
    // so it is definite: an uncertain effect would fence the next owner control.
    assert.equal(settled.state, 'failed', settled.diagnostic);
    assert.match(settled.diagnostic, /retained thread or uncertain delivery/);
    assert.equal(settled.effect?.status, 'reconciled');
    assert.deepEqual(f.task(), before);
    assert.deepEqual(f.store.runs(f.taskId), runsBefore);
  } finally { await f.close(); }
});

test('a superseded coordinator episode never reappears in an attention notice (papercut 1792f99d)', async () => {
  const f = fixture(); try {
    // The owner restart that continued the review resolved the episode and kept
    // its unapplied action as history, exactly as the fence settlement writes it.
    const task = reviewingTask(f, { phase: 'needs_attention', resolution: { ...f.task().resolution, attention: true,
      stop: { reason: 'run_stalled', detail: 'Reviewer continuing from checkpoint 1', since: at, suggestedVerbs: [] },
      incident: incidentFor('superseded-review', 'resolved'),
      recovery: { id: 'episode', key: 'episode-key', generation: 1, runId: 'old-coordinator', agentId: 'coord-agent', status: 'resolved',
        summary: 'Old coordinator: no turn since 14:36:03; re-arm or replace the reviewer', idleSince: null, incidentId: null,
        action: { eventId: 'old-coordinator-retry', runId: 'old-coordinator', reportStatus: 'recovered', summary: 'Re-arm the reviewer',
          status: 'refused', reason: 'Not applied; Superseded by an owner control: restart reviewer',
          coordinatorAction: { verb: 'restart', role: 'reviewer', reason: 'Re-arm the reviewer' } } } } });
    assert.ok(task);
    await f.engine.resolution.deliverNotices();
    const notices = f.store.notices(f.taskId).filter((notice: Notice) => notice.kind === 'attention');
    assert.equal(notices.length, 1, 'the current stop still reaches its owner');
    assert.match(notices[0]!.text, /Reviewer continuing from checkpoint 1/);
    assert.doesNotMatch(notices[0]!.text, /Coordinator could not apply its report/);
    assert.doesNotMatch(notices[0]!.text, /no turn since 14:36:03/);
    assert.equal(f.notices.length, 1);
  } finally { await f.close(); }
});
