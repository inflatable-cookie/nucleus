import { fakeAdapter } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { digest, Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { restartShape, type RestartShape } from '../core/verbs/owner-verbs';
import { REVIEW_AUTHORIZATION_REQUIRED, reviewCheckpointPathFor, writeReviewCheckpoint } from '../core/review/review-continuation';
import { REVIEW_CONTINUATION_LIMIT, runSchema, submissionSchema, taskControlInputSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { ABSENT_WORKER_REASON, type ResolutionAdapter } from '../core/resolution';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * A refused `restart` or `move` leaves the task, its runs and its events as they
 * were, whichever path refused. Current behaviour is the spec: this protects the
 * split's move PRs, where `store.update` auto-wraps and a lost transaction goes
 * silent. Each row asserts the shape it claims, so a fixture that drifts to
 * another path fails instead of proving nothing. The one write a refusal keeps is
 * its `verb_outcomes` telemetry row, asserted below.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';
const PR = 'https://github.com/example/repo/pull/7';
const profile = (id: string): Profile =>
  ({ id, name: id, provider: 'test', model: `test/${id}`, notes: '', available: true, problem: '', supportedThinking: [] });
const worker = profile('worker'), reviewer = profile('reviewer'), coord = profile('coord');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-refused-verb-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [worker, reviewer, coord].map(item => ({ profileId: item.id, enabled: true, group: item.id,
    roles: [item === reviewer ? 'reviewer' : item === coord ? 'coordinator' : 'worker'], weight: 1, scopes: ['general'] })));
  const taskId = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Refuse me', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base).id;
  const observations = new Map<string, AgentObservation>();
  for (const id of ['worker-agent', 'review-agent', 'coord-agent'])
    observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  const remote: string[] = [];
  const adapter = fakeAdapter({
    profiles: async () => [worker, reviewer, coord],
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => { throw Error('no workspace is expected'); },
    createAgent: async () => { remote.push('createAgent'); throw Error('no worker is expected'); },
    findRunAgents: async () => [],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    agentTimelinePage: async () => toolTimelinePage([]),
    notify: async () => { remote.push('notify'); },
    verifyPr: async () => ({ head, url: PR }),
    verifyPrIdentity: async () => ({ head, url: PR }),
    verifyCleanQueueWorktree: async () => {},
    verifyResume: async () => {},
    externalMerge: async () => null,
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }),
    createRun: async () => { remote.push('createRun'); throw Error('no run is expected'); },
    sendRun: async () => { remote.push('sendRun'); },
    continueReviewer: async () => { remote.push('continueReviewer'); return { sent: true as const }; },
    stopAgentTurn: async (id: string) => { remote.push(`stop:${id}`); },
  } as unknown as Adapter & ResolutionAdapter & Record<string, unknown>);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer, coord];
  const task = () => store.task(taskId);
  return {
    dir, store, engine, adapter, observations, remote, taskId, task,
    update: (patch: Partial<Task>) => store.update(taskId, patch),
    control: (args: Record<string, unknown>) => engine.performTaskControl(taskControlInputSchema.parse({
      taskId, version: task().version, reason: 'Owner call', caller: CALLER, ...args,
    })),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type F = ReturnType<typeof fixture>;

/** Everything a refusal must leave alone. */
const state = (f: F) => ({ task: f.task(), runs: f.store.runs(f.taskId), events: f.store.eventsAll(f.taskId) });

/**
 * What changed, by name. A full-state diff per failing row is enough output to
 * stall the test runner's stream parser past the file timeout, so a regression
 * across the table would hang the file instead of failing it.
 */
function changes(before: ReturnType<typeof state>, after: ReturnType<typeof state>): string[] {
  const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const differing = (a: Record<string, unknown>, b: Record<string, unknown>, prefix: string) =>
    keys(a, b).filter(key => !isDeepStrictEqual(a[key], b[key])).map(key => `${prefix}${key}`);
  const task = differing(before.task, after.task, 'task.').filter(key => key !== 'task.resolution');
  return [...task, ...differing(before.task.resolution, after.task.resolution, 'task.resolution.'),
    ...differing({ runs: before.runs }, { runs: after.runs }, ''),
    ...(isDeepStrictEqual(before.events, after.events) ? [] : [`events: ${before.events.length} to ${after.events.length}, last ${after.events.at(-1)?.kind}`])];
}

const runOf = (f: F, shape: Partial<Run> & Pick<Run, 'id' | 'role'>) => {
  const at = new Date().toISOString();
  const run = runSchema.parse({ taskId: f.taskId, generation: 1, head, base, agentId: 'review-agent', workspaceId: 'workspace', profile: reviewer,
    status: 'running', createdAt: at, lastObservedAt: at, active: false, idleSince: null, completion: null, released: false, ...shape });
  f.store.putRun(run);
  return run;
};

const bound = (phase: Task['phase'], extra: Partial<Task> = {}): Partial<Task> => ({
  phase, agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace', directory: '/worktree',
  profile: worker, workerModel: worker.model, lastAgentStatus: 'idle', agentActive: false, ...extra,
});
const withPr: Partial<Task> = { prUrl: PR, prHead: head, resumePrNumber: 7 };
const report = (f: F, status: 'blocked' | 'ready_for_review', prNumber?: number) =>
  ({ taskId: f.taskId, runId: 'worker-run', eventId: `worker-${status}`, status, summary: 'Reported', ...(prNumber ? { prNumber } : {}) }) as Task['completion'];

const blockedWorker = (f: F) => f.update(bound('blocked', { completion: report(f, 'blocked') }));
const blockedWithPr = (f: F) => f.update(bound('blocked', { ...withPr, completion: report(f, 'blocked', 7) }));
const retainedWorker = (f: F) => f.update(bound('needs_attention'));
function stoppedRevision(f: F) {
  f.update(bound('changes_requested', withPr));
  runOf(f, { id: 'revision-run', role: 'revision', agentId: 'worker-agent', profile: worker });
  f.store.update(f.taskId, { resolution: { ...f.task().resolution, currentRunId: 'revision-run' } });
}
function ownerStoppedWorker(f: F) {
  f.update(bound('working'));
  f.store.event(f.taskId, 'owner_stopped', JSON.stringify({ runIds: ['worker-run'] }));
}
function finishedRecovery(f: F, attention = true) {
  const run = runOf(f, { id: 'recovery-run', role: 'recovery', agentId: 'coord-agent', profile: null, status: 'running', active: true,
    completion: { eventId: 'rec-9', taskId: f.taskId, runId: 'recovery-run', status: 'recovered', summary: 'Resume', recoveryAction: 'resume_worker' } as Run['completion'] });
  f.update({ coordinatorAgentId: 'coord-agent', resolution: { ...f.task().resolution, attention, recoveryActive: true,
    recovery: { id: 'rec-9', key: 'k9', generation: 1, runId: run.id, agentId: 'coord-agent', status: 'running', summary: 'Coordinator recovery running', idleSince: null, incidentId: null } } });
}
function stall(f: F, role: 'worker' | 'reviewer', runId: string, turnId: string | null) {
  const at = new Date().toISOString();
  f.update({ resolution: { ...f.task().resolution, attention: true,
    incident: { id: 'stall', role, runId, ...(turnId ? { turnId } : {}), fingerprint: 'stall', attempt: 0, cause: 'stalled_turn', detail: 'looks stalled', action: '', status: 'reconciling', createdAt: at, updatedAt: at } as never } });
}
function reviewing(f: F) {
  f.update(bound('reviewing', { ...withPr, workspaceIntent: true, agentIntent: true, completion: report(f, 'ready_for_review', 7) }));
  return runOf(f, { id: 'review-run', role: 'reviewer' });
}
function checkpointReviewer(f: F) {
  const run = reviewing(f), eventId = 'checkpoint-1', ordinal = 1;
  const checkpoint = { covered: ['a'], remaining: ['b'] };
  const callback = { eventId, taskId: f.taskId, runId: run.id, status: 'review_in_progress', summary: 'Reading budget exhausted', head, checkpoint };
  const callbackDigest = digest(JSON.stringify(callback)), checkpointDigest = digest(JSON.stringify(checkpoint));
  const record = { ordinal, checkpoint, head, at: new Date().toISOString(), runId: run.id, path: reviewCheckpointPathFor(f.store, f.taskId, run.id, ordinal), eventId, callbackDigest, checkpointDigest };
  const response = { accepted: true, eventId, checkpoint: { ordinal, budget: REVIEW_CONTINUATION_LIMIT, continued: false, attention: REVIEW_AUTHORIZATION_REQUIRED, checkpointDigest } };
  f.store.setCredential(run.id, 'token');
  f.store.transaction(() => {
    writeReviewCheckpoint(f.store, f.taskId, record);
    f.store.putRun({ ...run, reviewCheckpoints: [record] });
    f.store.update(f.taskId, { reason: REVIEW_AUTHORIZATION_REQUIRED });
    f.store.db.prepare('INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)').run(eventId, f.taskId, run.id, callbackDigest, JSON.stringify(response));
  });
  f.update({ resolution: { ...f.task().resolution, currentRunId: run.id, reviewerAgentId: run.agentId, reviewerProfile: run.profile } });
}
function absentResolution(f: F) {
  f.update(bound('awaiting_review', { ...withPr, workspaceIntent: true, agentId: null, agentIntent: true, profile: null, completion: report(f, 'ready_for_review', 7) }));
  const run = runOf(f, { id: 'absent-review', role: 'reviewer', agentId: null, status: 'uncertain', active: null, lastObservedAt: null });
  f.update({ resolution: { ...f.task().resolution, currentRunId: run.id } });
}
function coordinatorEpisode(f: F) {
  f.update(bound('needs_attention', withPr));
  finishedRecovery(f);
  runOf(f, { id: 'fencing-reviewer', role: 'reviewer', active: true,
    completion: { eventId: 'finished-reviewer', taskId: f.taskId, runId: 'fencing-reviewer', status: 'blocked', summary: 'Finished without a verdict' } as Run['completion'] });
  f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
}
const unobservable = (f: F) => { f.adapter.observe = async () => { throw Error('Transport timeout'); }; };
const busyWorker = (f: F) => { f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' }); };
const refuseAdapter = (f: F, name: string) => { (f.adapter as unknown as Record<string, unknown>)[name] = async () => { throw Error(`${name} refused`); }; };

type Row = {
  name: string; shape: RestartShape | null; role?: 'worker' | 'reviewer' | 'coordinator'; args?: Record<string, unknown>;
  setup: (f: F) => void; refusal: RegExp;
};

const restartRows: Row[] = [
  { name: 'visible workspace mismatch', shape: 'pre_dispatch', role: 'worker',
    setup: f => { f.update({ phase: 'blocked', workspaceIntent: true, workspaceId: 'workspace', directory: '/worktree' });
      f.adapter.findWorkspaces = async () => [{ id: 'other', directory: '/other' }] as never; },
    refusal: /Visible workspace does not uniquely match/ },
  { name: 'worker lookup finds a match', shape: 'absent_worker', role: 'worker',
    setup: f => { f.update({ phase: 'needs_attention', reason: ABSENT_WORKER_REASON, workspaceIntent: true, agentIntent: true, agentId: null, runId: 'absent-worker', workspaceId: 'workspace', directory: '/worktree', profile: worker });
      f.adapter.findAgents = async () => [{ id: 'found', workspaceId: 'workspace' }] as never; },
    refusal: /no longer proven absent/ },
  { name: 'unobservable', shape: 'blocked_worker', role: 'worker', setup: f => { blockedWorker(f); unobservable(f); }, refusal: /cannot be observed/ },
  { name: 'active worker', shape: 'blocked_worker', role: 'worker', setup: f => { blockedWorker(f); busyWorker(f); }, refusal: /active or awaiting a response/ },
  { name: 'fresh, resume unverifiable', shape: 'blocked_worker', role: 'worker', args: { fresh: true }, setup: f => { blockedWorker(f); refuseAdapter(f, 'verifyResume'); }, refusal: /verifyResume refused/ },
  { name: 'no role, unobservable', shape: 'blocked_with_pr', role: 'worker', args: { role: undefined }, setup: f => { blockedWithPr(f); unobservable(f); }, refusal: /cannot be observed/ },
  { name: 'explicit role, active worker', shape: 'blocked_with_pr', role: 'worker', args: { role: 'worker' }, setup: f => { blockedWithPr(f); busyWorker(f); }, refusal: /active or awaiting a response/ },
  { name: 'unobservable', shape: 'stopped_revision', role: 'worker', setup: f => { stoppedRevision(f); unobservable(f); }, refusal: /cannot be observed/ },
  { name: 'active worker', shape: 'stopped_revision', role: 'worker', setup: f => { stoppedRevision(f); busyWorker(f); }, refusal: /active or awaiting a response/ },
  { name: 'stall has no turn to stop', shape: 'stalled_run', role: 'worker',
    setup: f => { f.update(bound('working')); stall(f, 'worker', 'worker-run', null); }, refusal: /no recorded active turn ID/ },
  { name: 'reviewer stall while paused', shape: 'stalled_run', role: 'reviewer',
    setup: f => { const run = reviewing(f); f.update({ resolution: { ...f.task().resolution, currentRunId: run.id } }); stall(f, 'reviewer', run.id, 'turn-1'); f.store.setMeta('paused', true); },
    refusal: /stalled-turn stop is deferred/ },
  { name: 'unobservable', shape: 'retained_worker', role: 'worker', setup: f => { retainedWorker(f); unobservable(f); }, refusal: /cannot be observed/ },
  { name: 'active worker', shape: 'retained_worker', role: 'worker', setup: f => { retainedWorker(f); busyWorker(f); }, refusal: /active or awaiting a response/ },
  { name: 'fresh', shape: 'owner_stopped_worker', role: 'worker', args: { fresh: true }, setup: ownerStoppedWorker, refusal: /resumes only on its retained thread/ },
  { name: 'unobservable', shape: 'owner_stopped_worker', role: 'worker', setup: f => { ownerStoppedWorker(f); unobservable(f); }, refusal: /cannot be observed/ },
  { name: 'active worker', shape: 'owner_stopped_worker', role: 'worker', setup: f => { ownerStoppedWorker(f); busyWorker(f); }, refusal: /no longer positively idle/ },
  { name: 'PR unverifiable', shape: 'checkpoint_reviewer', role: 'reviewer', setup: f => { checkpointReviewer(f); refuseAdapter(f, 'verifyPr'); }, refusal: /verifyPr refused/ },
  { name: 'observed reviewer still live', shape: 'stopped_reviewer', role: 'reviewer',
    setup: f => { reviewing(f); f.observations.set('review-agent', { id: 'review-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' }); },
    refusal: /still live/ },
  { name: 'ambiguous lookup', shape: 'absent_resolution', role: 'reviewer',
    setup: f => { absentResolution(f); finishedRecovery(f, false);
      f.adapter.findRunAgents = async () => [{ id: 'x', workspaceId: 'workspace' }, { id: 'y', workspaceId: 'workspace' }] as never; },
    refusal: /Run creation lookup is ambiguous/ },
  { name: 'fresh', shape: 'coordinator', role: 'coordinator', args: { fresh: true }, setup: coordinatorEpisode, refusal: /fresh is unsupported/ },
  { name: 'unsettled reviewer fences it', shape: 'coordinator', role: 'coordinator', setup: coordinatorEpisode, refusal: /still owns this task/ },
];

async function assertRefusedUnchanged(f: F, args: Record<string, unknown>, refusal: RegExp) {
  const since = new Date(Date.now() - 1000).toISOString();
  const before = state(f), remote = f.remote.length, outcomes = f.store.verbOutcomes(since).length;
  await assert.rejects(f.control(args), refusal);
  assert.deepEqual(changes(before, state(f)), [], 'the refusal left the task, runs and events unchanged');
  assert.deepEqual(f.remote.slice(remote), [], 'the refusal reached nothing remote');
  const recorded = f.store.verbOutcomes(since).slice(outcomes);
  assert.deepEqual(recorded.map(item => item.outcome), ['refused'], 'the refusal keeps only its telemetry row');
}

for (const row of restartRows) {
  test(`refused restart writes nothing: ${row.shape} (${row.name})`, async () => {
    const f = fixture(); try {
      row.setup(f);
      if (row.role) assert.equal(restartShape(f.task(), f.store.runs(f.taskId), row.role, f.store.eventsAll(f.taskId)), row.shape, 'the row reaches its shape');
      await assertRefusedUnchanged(f, { action: 'restart', role: row.role, ...row.args }, row.refusal);
    } finally { await f.close(); }
  });
}

test('refused restart writes nothing: a stale version', async () => {
  const f = fixture(); try {
    retainedWorker(f);
    await assertRefusedUnchanged(f, { action: 'restart', role: 'worker', version: f.task().version - 1 }, /Task changed; refresh before restarting/);
  } finally { await f.close(); }
});

/**
 * The settlement's writes commit, then the transaction refuses. This is the row a
 * lost `store.transaction` fails: `store.update` auto-wraps, so everything before
 * the throw would stay.
 */
function refuseAfterSettlement(f: F) {
  // Stopped-revision recovery settles through its own copy on Resolution.
  for (const owner of [f.engine, f.engine.resolution] as unknown as Array<{ settleVerbFences: (...args: unknown[]) => unknown }>) {
    const settle = owner.settleVerbFences;
    owner.settleVerbFences = function (this: unknown, ...args: unknown[]) {
      const before = f.store.eventsAll(f.taskId).length;
      settle.apply(this, args);
      assert.ok(f.store.eventsAll(f.taskId).length > before, 'the settlement wrote before the refusal');
      throw Error('Refused after settlement');
    };
  }
}
/** The same for a move whose fences settle after its own transition, inside its transaction. */
function refuseAfterTransition(f: F, kind: string) {
  const update = f.store.update;
  f.store.update = function (this: Store, ...args: Parameters<Store['update']>) {
    const updated = update.apply(this, args);
    if (args[2] === kind) throw Error('Refused after settlement');
    return updated;
  } as Store['update'];
}
const AFTER_SETTLEMENT = /Refused after settlement/;

const settledRows: Row[] = [
  { name: 'after settlement', shape: 'blocked_worker', role: 'worker', setup: f => { blockedWorker(f); finishedRecovery(f, false); refuseAfterSettlement(f); }, refusal: AFTER_SETTLEMENT },
  { name: 'after settlement', shape: 'retained_worker', role: 'worker', setup: f => { retainedWorker(f); finishedRecovery(f, false); refuseAfterSettlement(f); }, refusal: AFTER_SETTLEMENT },
  { name: 'after settlement', shape: 'stopped_revision', role: 'worker', setup: f => { stoppedRevision(f); finishedRecovery(f, false); refuseAfterSettlement(f); }, refusal: AFTER_SETTLEMENT },
  { name: 'after settlement', shape: 'coordinator', role: 'coordinator',
    setup: f => { coordinatorEpisode(f); f.observations.get('review-agent')!.status = 'idle'; f.observations.get('review-agent')!.active = false; refuseAfterSettlement(f); }, refusal: AFTER_SETTLEMENT },
];
for (const row of settledRows) {
  test(`refused restart rolls back: ${row.shape} (${row.name})`, async () => {
    const f = fixture(); try {
      row.setup(f);
      assert.equal(restartShape(f.task(), f.store.runs(f.taskId), row.role!, f.store.eventsAll(f.taskId)), row.shape, 'the row reaches its shape');
      await assertRefusedUnchanged(f, { action: 'restart', role: row.role, ...row.args }, row.refusal);
    } finally { await f.close(); }
  });
}

const ready = (f: F) => { f.update({ resolution: { ...f.task().resolution,
  review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-1', status: 'ready_to_merge', summary: 'Fine', head, reviewId: 11 } as never } }); };
const atReview = (f: F) => f.update(bound('awaiting_review', { prUrl: PR, prHead: head, completion: report(f, 'ready_for_review', 7) }));
const finished = (f: F) => f.update(bound('done', withPr));

type MoveRow = { to: 'work' | 'review' | 'merge' | 'closeout'; name: string; args?: Record<string, unknown>; setup: (f: F) => void; refusal: RegExp };
const moveRows: MoveRow[] = [
  { to: 'work', name: 'finished task', setup: finished, refusal: /needs an unfinished, unmerged task/ },
  { to: 'work', name: 'no author', setup: f => f.update(bound('reviewing', { agentIntent: false, agentId: null, profile: null, workspaceId: null })), refusal: /requires the task author/ },
  { to: 'work', name: 'waiting for prerequisites', setup: f => { atReview(f); f.update({ prerequisiteWait: { id: randomUUID(), waitsFor: ['dependency'], reason: 'waiting', releasedAt: null } as never }); }, refusal: /waiting for its retained prerequisites/ },
  { to: 'work', name: 'after settlement', setup: f => { atReview(f); finishedRecovery(f, false); refuseAfterSettlement(f); }, refusal: AFTER_SETTLEMENT },
  { to: 'review', name: 'finished task', setup: finished, refusal: /needs an unmerged task before merge intent/ },
  { to: 'review', name: 'no PR', setup: f => f.update(bound('needs_attention')), refusal: /needs a task PR/ },
  { to: 'review', name: 'a different PR', args: { prNumber: 8 }, setup: f => f.update(bound('needs_attention', withPr)), refusal: /must use the retained task PR #7/ },
  { to: 'review', name: 'PR unverifiable', setup: f => { atReview(f); refuseAdapter(f, 'verifyPr'); }, refusal: /verifyPr refused/ },
  { to: 'review', name: 'after its transition', setup: f => { atReview(f); finishedRecovery(f, false); refuseAfterTransition(f, 'move_review_requested'); }, refusal: AFTER_SETTLEMENT },
  { to: 'merge', name: 'finished task', setup: finished, refusal: /needs an unmerged task before merge intent/ },
  { to: 'merge', name: 'no accepted review', setup: atReview, refusal: /requires an accepted review at the current PR head/ },
  { to: 'merge', name: 'acceptance without the operator', args: { qualification: 'Accepted', head }, setup: atReview, refusal: /Qualified owner acceptance needs the operator/ },
  { to: 'merge', name: 'PR moved', setup: f => { atReview(f); ready(f); f.adapter.verifyPr = async () => ({ head: 'c'.repeat(40), url: PR }) as never; }, refusal: /differs from the task's recorded head/ },
  { to: 'merge', name: 'after settlement', setup: f => { atReview(f); ready(f); finishedRecovery(f, false); refuseAfterSettlement(f); }, refusal: AFTER_SETTLEMENT },
  { to: 'closeout', name: 'acceptance without the operator', args: { qualification: 'Accepted', head }, setup: atReview, refusal: /External-merge source acceptance needs the operator/ },
  { to: 'closeout', name: 'after its transition', setup: f => { atReview(f); finishedRecovery(f, false); f.adapter.externalMerge = async () => ({ head, commit: 'c'.repeat(40) }) as never; refuseAfterTransition(f, 'external_merge_observed'); }, refusal: AFTER_SETTLEMENT },
  { to: 'closeout', name: 'unmerged PR', setup: atReview, refusal: /The task PR is not merged/ },
];
for (const to of ['work', 'review', 'merge', 'closeout'] as const)
  moveRows.push({ to, name: 'a stale version', setup: atReview, args: { stale: true }, refusal: /Task changed/ });

for (const row of moveRows) {
  test(`refused move writes nothing: ${row.to} (${row.name})`, async () => {
    const f = fixture(); try {
      row.setup(f);
      const { stale, ...args } = row.args ?? {};
      await assertRefusedUnchanged(f, { action: 'move', to: row.to, ...args, ...(stale ? { version: f.task().version - 1 } : {}) }, row.refusal);
    } finally { await f.close(); }
  });
}

const BUG_12 = 'bug 12: a refused restart commits a write';
const pending = (f: F) => { f.update({ resolution: { ...f.task().resolution, nonDeliveryRoutePending: true, pendingRevisionCause: 'non_delivery' } }); };
const bug12Rows: Array<{ shape: RestartShape; args?: Record<string, unknown>; setup: (f: F) => void }> = [
  { shape: 'blocked_worker', setup: blockedWorker },
  { shape: 'retained_worker', setup: retainedWorker },
  { shape: 'stopped_revision', setup: stoppedRevision },
  { shape: 'blocked_with_pr', args: { role: undefined }, setup: blockedWithPr },
];
for (const row of bug12Rows) {
  // The target. When bug 12 is fixed this passes and the pin below fails: drop both marks together.
  test(`refused restart writes nothing: ${row.shape} (non-delivery replacement pending)`, { todo: BUG_12 }, async () => {
    const f = fixture(); try {
      row.setup(f); pending(f);
      await assertRefusedUnchanged(f, { action: 'restart', role: 'worker', ...row.args }, /Task changed/);
    } finally { await f.close(); }
  });
  test(`pin ${BUG_12}: ${row.shape} clears the pending replacement, then refuses`, async () => {
    const f = fixture(); try {
      row.setup(f); pending(f);
      assert.equal(restartShape(f.task(), f.store.runs(f.taskId), 'worker', f.store.eventsAll(f.taskId)), row.shape, 'the row reaches its shape');
      const before = f.task();
      await assert.rejects(f.control({ action: 'restart', role: 'worker', ...row.args }), /Task changed/);
      assert.equal(f.task().version, before.version + 1);
      assert.equal(f.task().resolution.nonDeliveryRoutePending, false);
      assert.equal(f.task().resolution.pendingRevisionCause, null);
      assert.equal(f.task().phase, before.phase);
      assert.deepEqual(f.store.eventsAll(f.taskId).filter(event => event.kind === 'non_delivery_replacement_superseded').length, 1);
    } finally { await f.close(); }
  });
}

test('refused restart writes nothing: blocked_with_pr (replacement pending, explicit role, active worker)', async () => {
  const f = fixture(); try {
    blockedWithPr(f); pending(f); busyWorker(f);
    await assertRefusedUnchanged(f, { action: 'restart', role: 'worker' }, /active or awaiting a response/);
  } finally { await f.close(); }
});

const LEASE_WAIT = 'a refused move to closeout records a participant wait on the task';
const noToolEvidence = (f: F) => { atReview(f); f.adapter.agentTimelinePage = undefined; };
// The target, as for bug 12: fixing the write flips this and the pin together.
test('refused move writes nothing: closeout (participant tool evidence unavailable)', { todo: LEASE_WAIT }, async () => {
  const f = fixture(); try {
    noToolEvidence(f);
    await assertRefusedUnchanged(f, { action: 'move', to: 'closeout' }, /execution participants or effects are not settled/);
  } finally { await f.close(); }
});
test(`pin: ${LEASE_WAIT}`, async () => {
  const f = fixture(); try {
    noToolEvidence(f);
    const before = f.task();
    await assert.rejects(f.control({ action: 'move', to: 'closeout' }), /execution participants or effects are not settled/);
    assert.ok(f.task().version > before.version);
    assert.match(f.task().reason, /Merge waits for participant worker-agent/);
  } finally { await f.close(); }
});
