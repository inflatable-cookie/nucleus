import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { ResolutionAdapter } from '../core/resolution';
import {
  submissionSchema, taskControlInputSchema, taskNextSchema, taskDetailView, summarizeTask, holdsOf,
  type Task,
} from '../shared/contracts';
import { taskStopRecord } from '../shared/task-stop';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * Spec 050 `stop` visibility (Queue #396; papercut 755cf03a, longhorn #054 /
 * task 2af901a8, 2026-10-20).
 *
 * The reported shape: the owner stopped an idle worker during the
 * completion-delivery grace window; the accepted stop recorded a dispatch hold,
 * but `next` kept showing the run "running" with nothing the owner could act on.
 * The acceptance is that the hold and the still-owned run are visible at once —
 * in the stop response, in `next` and on the board — before any run settles, and
 * that a refused or unknown cancellation never reads as success.
 */
const base = 'b'.repeat(40);
const head = 'a'.repeat(40);
const CALLER = 'owner-thread';
const GRACE_REASON = 'Worker idle; allowing time for completion delivery';


const workerProfile = profile('worker', 'test/worker');

function fixture(graceMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-stop-'));
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Stop me', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.setMeta('pool', [
    { profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
  ]);
  const observations = new Map<string, AgentObservation>();
  // Round 4: verbs cancel a live turn through Paseo's active-turn cancellation.
  const stops: string[] = [];
  const notified: Array<{ agentId: string; messageId: string; text: string }> = [];
  const sent: Array<{ task: Task; run: { id: string; agentId: string | null }; }> = [];
  const adapter = {
    profiles: async () => [workerProfile],
    observe: async (id: string) => observations.get(id) ?? { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' },
    archiveAgent: async () => {}, notify: async (agentId: string, messageId: string, text: string) => { notified.push({ agentId, messageId, text }); },
    findAgents: async () => [], findRunAgents: async () => [],
    verifyWorkspace: async () => {}, findWorkspaces: async () => [],
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head }),
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async (task: Task, run: { id: string; agentId: string | null }) => { sent.push({ task, run }); },
    stopAgentTurn: async (id: string) => {
      stops.push(id);
      const observed = observations.get(id);
      if (observed) observations.set(id, { ...observed, status: 'idle', active: false, permissions: false, activeTurnId: undefined });
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, graceMs, () => true);
  engine.profiles = [workerProfile];
  const task = () => store.task(inserted.id);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task())));
  const board = () => summarizeTask(task(), false, false, {}, store.runs(inserted.id));
  const events = (kind: string) => store.eventsAll(inserted.id).filter(event => event.kind === kind);
  return {
    dir, path, store, engine, adapter, observations, stops, notified, sent, taskId: inserted.id, task, next, board, events,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A dispatched pre-PR worker the engine has just observed idle: the completion-delivery grace window. */
function idleWorker(f: ReturnType<typeof fixture>, overrides: Partial<Task> = {}) {
  const now = new Date().toISOString();
  return f.store.update(f.taskId, {
    phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'workspace', directory: '/worktree',
    agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
    lastAgentStatus: 'idle', agentActive: false, lastObservedAt: now, idleSince: now,
    resolution: { ...f.task().resolution, stop: taskStopRecord('lifecycle', GRACE_REASON, null, now, []) },
    ...overrides,
  });
}

/** A dispatched worker whose turn is still live. */
function liveWorker(f: ReturnType<typeof fixture>, overrides: Partial<Task> = {}) {
  const worker = idleWorker(f, { idleSince: null, lastAgentStatus: 'running', ...overrides });
  f.observations.set('worker-agent', { id: 'worker-agent', workspaceId: 'workspace', status: 'running', active: true, permissions: false, error: '' });
  return worker;
}

const stopControl = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'stop', taskId: f.taskId, version: f.task().version, reason: 'Owner redirects the work', caller: CALLER, ...extra }));
const verb = (f: ReturnType<typeof fixture>, name: string) => f.next().verbs.filter(entry => entry.verb === name);

test('an accepted stop of an idle worker shows its dispatch hold and the still-owned run at once, in the response, next and the board', async () => {
  const f = fixture(); try {
    idleWorker(f);
    assert.equal(verb(f, 'restart')[0]!.available, false, 'an idle worker with no owner stop keeps ordinary handling');
    assert.equal(f.next().activeRun?.status, 'running');
    // The reported starting point: the engine's own idle grace, no hold, the run
    // owned with no result yet.
    const before = f.next();
    assert.equal(before.stop?.kind, 'wait');
    assert.equal(before.stop?.reason, 'lifecycle');
    assert.equal(before.stop?.detail, GRACE_REASON);
    assert.deepEqual(before.holds, {}, 'no fence exists before the stop');
    assert.equal(before.activeRun?.runId, 'worker-run');
    assert.equal(before.activeRun?.released, false, 'the run is still owned');
    assert.equal(before.activeRun?.summary, null, 'no result is invented');
    assert.equal(verb(f, 'release').length, 0, 'there is nothing to release before the stop');

    const stopped = await stopControl(f);
    // Response presentation: the returned task carries the fence at once, before
    // any run settles, under the owner's own caller identity.
    assert.equal(stopped.phase, 'working', 'the phase still describes a run that owns the task');
    assert.equal(stopped.held, true);
    assert.equal(stopped.holds?.dispatch?.owner, CALLER);
    assert.equal(stopped.holds?.dispatch?.reason, 'Owner stop: Owner redirects the work');
    assert.equal(stopped.holds?.dispatch?.generation, 1);
    assert.equal(stopped.completion, null, 'nothing is fabricated as finished');
    // Spec 050 #396: the accepted stop records the held stop with its fence in
    // the same control quantum (two store updates on the task's control lane, not
    // an atomic SQLite transaction), so the raw response names the hold rather
    // than the wait the task was in when it was stopped.
    assert.equal(stopped.resolution.stop?.reason, 'held');
    assert.equal(stopped.resolution.stop?.detail, 'Dispatch held; release to continue');
    assert.deepEqual(stopped.resolution.stop?.suggestedVerbs, []);
    assert.equal(stopped.reason, 'Dispatch held; release to continue');

    const after = f.next();
    assert.equal(after.stop?.kind, 'hold');
    assert.equal(after.stop?.reason, 'held');
    assert.equal(after.stop?.detail, 'Owner stop: Owner redirects the work');
    assert.equal(after.stop?.owner, CALLER);
    assert.equal(after.stop?.since, stopped.holds!.dispatch!.at);
    assert.match(after.stop!.evidence!, /^dispatch hold generation 1/);
    assert.equal(after.holds.dispatch?.owner, CALLER);
    assert.equal(after.activeRun?.runId, 'worker-run');
    assert.equal(after.activeRun?.released, false, 'the stopped run is still owned and named');
    assert.equal(after.activeRun?.summary, null);
    // The exit the report asked for exists as soon as the fence does: release.
    const release = verb(f, 'release');
    assert.equal(release.length, 1);
    assert.equal(release[0]!.available, true);
    assert.equal(release[0]!.args?.kind, 'dispatch');
    assert.match(String(release[0]!.args?.summary), /Dispatch held by owner-thread: Owner stop: Owner redirects the work/);
    assert.equal(verb(f, 'keep_hold')[0]!.available, true);
    // The owner stop names the retained run and its observed idle state. Restart
    // can record a continuation under the hold; release is still the delivery gate.
    const restart = verb(f, 'restart')[0]!;
    assert.equal(restart.available, true);
    assert.equal(after.activeRun?.status, 'stopped');
    assert.equal(verb(f, 'move').find(entry => entry.args?.to === 'work'), undefined, 'no move work view is offered as available');

    // Board projection: one hold chip kind and the hold stop, never a fabricated wait.
    const card = f.board();
    assert.equal(card.stop, 'hold');
    assert.equal(card.holdKind, 'dispatch');
    assert.equal(card.held, true);
    assert.equal(card.holds?.dispatch?.owner, CALLER);
    const detail = taskDetailView(f.task());
    assert.equal(detail.holdKind, 'dispatch');
    assert.deepEqual(detail.holds?.dispatch?.reason, 'Owner stop: Owner redirects the work');

    // The producer trail: an idle worker needs no cancellation, and the stop is
    // recorded once as an owner control.
    assert.deepEqual(f.stops, [], 'an idle worker has no live turn to cancel');
    assert.equal(f.events('owner_stop_intent').length, 0);
    assert.equal(f.events('owner_stop_sent').length, 0, 'nothing is claimed stopped');
    assert.equal(f.events('owner_stop_uncertain').length, 0);
    assert.equal(f.events('owner_stopped').length, 1);
    assert.deepEqual(JSON.parse(f.events('owner_stopped')[0]!.detail).cancelled, []);
    assert.deepEqual(JSON.parse(f.events('owner_stopped')[0]!.detail).runIds, ['worker-run']);
    assert.equal(f.events('owner_control').length, 1);
    // `queue.task`'s applied outcome is recorded outside task history.
    const outcomes = f.store.verbOutcomes('1970-01-01T00:00:00.000Z').filter(entry => entry.action === 'stop');
    assert.deepEqual(outcomes.map(entry => entry.outcome), ['applied']);

    // The existing release rule retires the held stop with its last fence, so the
    // stop never outlives the hold it describes.
    const released = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'release', taskId: f.taskId, version: f.task().version, kind: 'dispatch', caller: CALLER }));
    assert.deepEqual(holdsOf(released), {});
    assert.equal(released.resolution.stop, null);
    assert.notEqual(f.next().stop?.kind, 'hold');
  } finally { await f.close(); }
});

test('the accepted stop and its hold read the same after a reload, before the run settles', async () => {
  const f = fixture(); let reopened: Store | undefined; try {
    idleWorker(f);
    await stopControl(f);
    const before = f.next();
    f.store.close();
    reopened = new Store(f.path);
    const task = reopened.task(f.taskId);
    // A fresh store has no engine memory: only the durable fence and its records.
    const reloaded = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(reopened, task)));
    assert.deepEqual(reloaded.stop, before.stop);
    assert.deepEqual(reloaded.holds, before.holds);
    assert.equal(reloaded.activeRun?.released, false, 'the run is still owned after reload');
    assert.equal(reloaded.verbs.filter(entry => entry.verb === 'release' && entry.available).length, 1);
    const card = summarizeTask(task, false, false, {}, reopened.runs(f.taskId));
    assert.equal(card.stop, 'hold');
    assert.equal(card.holdKind, 'dispatch');
    assert.equal(holdsOf(task).dispatch?.owner, CALLER);
  } finally { reopened?.close(); if (!reopened) f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('owner stop restart records the instruction under the hold and release delivers once on the retained run', async () => {
  const f = fixture(); try {
    idleWorker(f);
    f.store.setCredential('worker-run', 'worker-callback-token');
    await stopControl(f);
    const held = await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'restart', taskId: f.taskId,
      version: f.task().version, role: 'worker', reason: 'Continue after stop', instruction: 'Preserve the current source and report the fix', caller: CALLER }));
    assert.ok(holdsOf(held).dispatch, 'restart does not release the owner stop hold');
    assert.equal(held.resolution.deferredVerb?.input.action, 'restart');
    assert.equal(f.sent.length, 0, 'nothing is delivered while the hold stands');
    await f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'release', taskId: f.taskId,
      version: f.task().version, kind: 'dispatch', caller: CALLER }));
    assert.equal(f.notified.length, 1);
    assert.equal(f.notified[0]!.agentId, 'worker-agent');
    assert.match(f.notified[0]!.text, /Preserve the current source and report the fix/);
    assert.equal(f.sent.length, 0, 'the retained run receives a message; no replacement run is created');
    assert.equal(f.task().runId, 'worker-run');
    assert.equal(f.task().agentId, 'worker-agent');
    assert.doesNotThrow(() => f.store.authenticate('worker-run', 'worker-callback-token'), 'the existing callback stays bound to the retained run');
    assert.equal(f.store.runs(f.taskId).length, 0);
    assert.equal(f.task().resolution.deferredVerb, null);
    assert.equal(f.events('owner_stop_sent').length, 0, 'the already idle thread was not cancelled again');
  } finally { await f.close(); }
});

test('a live worker stopped by the owner keeps its accepted stop through the first idle observation', async () => {
  // Queue #403 (review of #641): the accepted stop was visible until the stopped
  // worker was next observed idle, where reconciliation wrote its idle note over
  // `task.reason` and cleared the stored `held` stop. `next`, task detail and the
  // fence still named the hold, so the raw task read and the board card were the
  // ones that lied. The fixture follows the reported control flow: a live worker,
  // the owner's stop accepted and settled as sent with the run still owned, then
  // the first idle observation with no `idleSince`, a later reconcile and a store
  // reload.
  const f = fixture(60_000); let reopened: Store | undefined; try {
    liveWorker(f);
    const stopped = await stopControl(f);
    assert.deepEqual(f.stops, ['worker-agent'], 'the live turn is cancelled once');
    assert.equal(f.events('owner_stop_sent').length, 1, 'the cancellation settled as sent');
    assert.equal(f.events('owner_stop_uncertain').length, 0);
    const accepted = stopped.resolution.stop;
    assert.equal(stopped.reason, 'Dispatch held; release to continue');
    assert.equal(accepted?.reason, 'held');
    assert.equal(f.task().idleSince, null, 'the stop itself starts no idle grace');
    assert.equal(f.task().phase, 'working');
    assert.equal(f.task().completion, null, 'the stop invents no result');

    // The first idle observation since the stop: the grace starts, the accepted
    // stop and its stored record stay exactly as the verb wrote them.
    await f.engine.scheduleTaskQuantum(f.taskId);
    const firstIdle = f.task();
    assert.ok(firstIdle.idleSince, 'the first idle observation still starts the completion-delivery grace');
    assert.equal(firstIdle.reason, 'Dispatch held; release to continue', 'the accepted stop stays the visible cause');
    assert.deepEqual(firstIdle.resolution.stop, accepted, 'the stored stop is not replaced by the idle wait');
    assert.equal(firstIdle.phase, 'working', 'the phase still describes the run that owns the task');
    assert.equal(firstIdle.completion, null, 'the idle observation invents no result');
    assert.equal(holdsOf(firstIdle).dispatch?.generation, 1, 'the fence is not renewed');
    assert.equal(f.events('task_waiting').length, 1, 'the stop record is written once and never rewritten');
    assert.equal(f.events('owner_stopped').length, 1);
    assert.equal(f.events('owner_stop_intent').length, 1);

    // Every read the owner has names the hold, not the idle note.
    const afterFirst = f.next();
    assert.equal(afterFirst.stop?.kind, 'hold');
    assert.equal(afterFirst.stop?.reason, 'held');
    assert.equal(afterFirst.stop?.detail, 'Owner stop: Owner redirects the work');
    assert.equal(afterFirst.stop?.owner, CALLER);
    assert.equal(afterFirst.activeRun?.runId, 'worker-run');
    assert.equal(afterFirst.activeRun?.released, false, 'the run is still owned');
    assert.equal(afterFirst.activeRun?.summary, null, 'no result is invented');
    const card = f.board();
    assert.equal(card.stop, 'hold');
    assert.equal(card.holdKind, 'dispatch');
    assert.equal(card.reason, 'Dispatch held; release to continue', 'the board card does not regress to the idle note');
    assert.equal(card.stopRecord?.reason, 'held');
    assert.equal(taskDetailView(firstIdle).resolution.stop?.reason, 'held');

    // A later reconcile past the grace still leaves the accepted stop alone, and
    // spends no reminder, cancellation or recovery on the held task.
    f.store.update(f.taskId, { idleSince: new Date(Date.now() - 120_000).toISOString() });
    const agedVersion = f.task().version;
    await f.engine.scheduleTaskQuantum(f.taskId);
    const later = f.task();
    assert.equal(later.version, agedVersion, 'the later reconcile writes nothing to the accepted stop');
    assert.equal(f.events('initial_pr_lookup_unavailable').length, 1, 'the later reconcile ran its branch-PR step past the grace');
    assert.equal(later.reason, 'Dispatch held; release to continue');
    assert.deepEqual(later.resolution.stop, accepted, 'the stop does not churn with the clock');
    assert.equal(f.events('task_waiting').length, 1);
    assert.equal(f.events('callback_reminder').length, 0, 'a held task gets no reporting reminder');
    assert.deepEqual(f.stops, ['worker-agent'], 'no second cancellation');
    assert.equal(f.events('owner_stop_sent').length, 1);
    assert.equal(f.next().activeRun?.released, false, 'the run is still unreleased');
    assert.equal(f.next().stop?.kind, 'hold');

    // Durable, not engine memory: a fresh store reads the same accepted stop.
    f.store.close();
    reopened = new Store(f.path);
    const stored = reopened.task(f.taskId);
    assert.equal(stored.reason, 'Dispatch held; release to continue');
    assert.equal(stored.resolution.stop?.reason, 'held');
    assert.deepEqual(stored.resolution.stop, accepted);
    assert.equal(holdsOf(stored).dispatch?.generation, 1);
    assert.equal(stored.phase, 'working');
    assert.equal(stored.completion, null);
    const reloaded = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(reopened, stored)));
    assert.equal(reloaded.stop?.kind, 'hold');
    assert.equal(reloaded.stop?.detail, 'Owner stop: Owner redirects the work');
    assert.equal(reloaded.activeRun?.released, false);
    const reloadedCard = summarizeTask(stored, false, false, {}, reopened.runs(f.taskId));
    assert.equal(reloadedCard.reason, 'Dispatch held; release to continue');
    assert.equal(reloadedCard.stop, 'hold');
    assert.equal(reloadedCard.holdKind, 'dispatch');
  } finally { reopened?.close(); if (!reopened) f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('stopping a live worker cancels the turn durably and leaves the run to settle; a repeated stop sends nothing more', async () => {
  const f = fixture(); try {
    liveWorker(f);
    const stopped = await stopControl(f);
    assert.deepEqual(f.stops, ['worker-agent'], 'the live turn is cancelled once');
    assert.equal(f.events('owner_stop_intent').length, 1);
    assert.equal(f.events('owner_stop_sent').length, 1);
    assert.equal(f.events('owner_stop_sent')[0]!.detail.includes('worker-run'), true, 'the cancellation names the run it stopped');
    assert.ok(stopped.holds?.dispatch, 'the accepted stop parks the task');
    assert.equal(f.store.task(f.taskId).completion, null, 'the run is left as it is for restart or move');
    assert.equal(f.next().stop?.kind, 'hold');
    assert.equal(f.next().activeRun?.released, false);

    // The report's retried control: an accepted stop that already stands must
    // not resend a cancellation or read as a second, different success.
    const again = await stopControl(f);
    assert.deepEqual(f.stops, ['worker-agent'], 'the cancelled turn is never resent');
    assert.equal(f.events('owner_stop_intent').length, 1);
    assert.equal(f.events('owner_stop_sent').length, 1);
    assert.equal(f.events('owner_stopped').length, 2, 'the retry is recorded as its own audit line');
    assert.equal(again.holds?.dispatch?.reason, 'Owner stop: Owner redirects the work');
    assert.equal(again.holds?.dispatch?.generation, 1, 'an existing dispatch hold stands');
    assert.deepEqual(again.resolution.stop, stopped.resolution.stop, 'the held stop record is not rewritten by a repeat');
    assert.equal(f.next().stop?.kind, 'hold');
  } finally { await f.close(); }
});

test('an unknown cancellation never reads as an accepted stop, and the retry cancels exactly once', async () => {
  const f = fixture(); try {
    liveWorker(f);
    const before = f.task();
    const cancel = f.adapter.stopAgentTurn!;
    (f.adapter as unknown as { stopAgentTurn: (id: string) => Promise<void> }).stopAgentTurn = async () => { throw new Error('daemon unreachable'); };
    await assert.rejects(stopControl(f), /could not stop the live revision run \(worker-run\): daemon unreachable; retry the same verb/);
    // Refused means refused: no fence, no hold stop, the run still owned.
    assert.deepEqual(f.task(), before, 'a refused cancellation writes nothing to the task');
    assert.deepEqual(holdsOf(f.task()), {});
    assert.notEqual(f.next().stop?.kind, 'hold');
    assert.deepEqual(f.next().holds, {});
    assert.equal(f.next().activeRun?.released, false);
    assert.equal(f.board().stop, 'wait', 'the board keeps the pre-stop wait, never a hold');
    assert.equal(f.board().holdKind, undefined);
    assert.equal(f.board().holds, undefined, 'the board claims no fence');
    assert.equal(f.events('owner_stop_intent').length, 1);
    assert.equal(f.events('owner_stop_uncertain').length, 1);
    assert.equal(f.events('owner_stop_sent').length, 0, 'an unknown outcome never claims a sent stop');
    assert.equal(f.events('owner_stopped').length, 0);
    assert.equal(f.events('owner_control').length, 0);
    const refusals = f.store.verbOutcomes('1970-01-01T00:00:00.000Z').filter(entry => entry.action === 'stop');
    assert.equal(refusals.at(-1)!.outcome, 'refused');
    assert.match(String(refusals.at(-1)!.detail.reason), /could not stop the live revision run/);

    // After the adapter recovers, the same control cancels once and applies once.
    (f.adapter as unknown as { stopAgentTurn: (id: string) => Promise<void> }).stopAgentTurn = cancel;
    const stopped = await stopControl(f);
    assert.deepEqual(f.stops, ['worker-agent']);
    assert.equal(f.events('owner_stop_sent').length, 1);
    assert.ok(stopped.holds?.dispatch);
    assert.equal(f.next().stop?.kind, 'hold');
    const outcomes = f.store.verbOutcomes('1970-01-01T00:00:00.000Z').filter(entry => entry.action === 'stop');
    assert.deepEqual(outcomes.map(entry => entry.outcome), ['refused', 'applied']);
  } finally { await f.close(); }
});

test('a stale version refuses a stop before anything is cancelled or parked', async () => {
  // The durable-side-effect refusal this title used to claim is owned by
  // test/owner-move-retry.test.ts ("stop refuses a run with unknown delivery"):
  // it refuses on a run whose delivery is unknown, and no fixture in this file
  // reaches that condition.
  const f = fixture(); try {
    liveWorker(f);
    const stale = f.task().version;
    f.store.update(f.taskId, { reason: 'A concurrent owner update' });
    await assert.rejects(
      f.engine.performTaskControl(taskControlInputSchema.parse({ action: 'stop', taskId: f.taskId, version: stale, reason: 'Owner redirects the work', caller: CALLER })),
      /Task changed; refresh before retrying/);
    assert.deepEqual(f.stops, [], 'a stale version cancels nothing');
    assert.equal(f.events('owner_stop_intent').length, 0);
    assert.deepEqual(holdsOf(f.task()), {}, 'a stale version parks nothing');
    assert.equal(f.events('owner_stopped').length, 0);
  } finally { await f.close(); }
});
