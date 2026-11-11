import { profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { ResolutionAdapter } from '../core/resolution';
import {
  holdsOf, runSchema, submissionSchema, taskControlInputSchema, taskNextSchema,
  type Run, type Task, type TaskControlInput,
} from '../shared/contracts';
import { collectOwnerVerbFacts, ownerTaskNext, ownerVerb } from '../core/verbs/owner-verbs';
import type { Adapter, AgentObservation } from '../core/host';
import { toolTimelinePage } from './support/tool-timeline';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';
import { git } from '../core/git/index';

/**
 * An owner control admitted against the facts `next` showed keeps working while
 * the automatic lifecycle pass only *observes* the task, and still refuses a
 * real controlling change. The store already records that distinction as
 * `lastSubstantiveVersion`; these are the public owner-control consequences.
 */

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const CALLER = 'owner-thread';
const workspaceId = 'workspace';


const workerProfile = profile('worker', 'test/worker'), reviewerProfile = profile('reviewer', 'test/reviewer');

const idle = (id: string, workspace = workspaceId): AgentObservation =>
  ({ id, workspaceId: workspace, status: 'idle', active: false, permissions: false, error: '' });

/** A one-shot barrier: the awaited work signals entry, then waits for release. */
function gate() {
  let open!: () => void, enter!: () => void;
  const released = new Promise<void>(resolve => { open = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { released, entered, release: () => open(), enter: () => enter() };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-owner-observe-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Steer me', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  store.setMeta('pool', [
    { profileId: workerProfile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewerProfile.id, enabled: true, group: 'review', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  const observations = new Map<string, AgentObservation>();
  const archived = new Set<string>();
  const adapter = {
    profiles: async () => [workerProfile, reviewerProfile],
    observe: async (id: string) => observations.get(id) ?? idle(id, null as unknown as string),
    agentTimelinePage: async () => toolTimelinePage([]),
    archiveAgent: async (id: string) => { archived.add(id); }, notify: async () => {},
    findAgents: async () => [], findRunAgents: async () => [], findAnyOpenBranchPr: async () => [],
    verifyWorkspace: async () => {}, findWorkspaces: async () => [],
    originAgent: async (id: string) => ({ id, workspaceId, archived: archived.has(id), status: 'idle', title: id }),
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/7', head }),
    verifyResume: async () => head,
    verifyInspectedRevisionHead: async () => {},
    createRun: async () => { throw new Error('no dispatch is expected in these fixtures'); },
    sendRun: async () => {},
    stopAgentTurn: async (id: string) => {
      const observed = observations.get(id);
      if (observed) observations.set(id, { ...observed, status: 'idle', active: false, permissions: false, activeTurnId: undefined });
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0, () => true);
  engine.profiles = [workerProfile, reviewerProfile];
  const taskId = inserted.id;
  const task = () => store.task(taskId);
  const next = () => taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task())));
  const events = (kind: string) => store.eventsAll(taskId).filter(event => event.kind === kind);
  const dispatched = (overrides: Partial<Task> = {}) => {
    observations.set('worker-agent', idle('worker-agent'));
    return store.update(taskId, {
      phase: 'working', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId, directory: '/worktree',
      agentId: 'worker-agent', runId: 'worker-run', profile: workerProfile, workerModel: workerProfile.model,
      idleSince: new Date().toISOString(), agentActive: true, lastAgentStatus: 'running',
      ...overrides,
    });
  };
  /** A dispatched task with the retained author's PR identity (owner-move-retry's shape). */
  const retainedPr = async (status: 'blocked' | 'error' = 'blocked') => {
    await engine.stop();
    dispatched({ completion: null, resumePrNumber: 7, prUrl: null, prHead: null });
    store.setCredential('worker-run', 'worker-token');
    await engine.complete({ taskId, runId: 'worker-run', eventId: 'blocked-result', status, summary: 'Owner acceptance needed' }, 'worker-token');
    store.update(taskId, { phase: status, resolution: { ...task().resolution, attention: true } });
    observations.set('worker-agent', idle('worker-agent'));
  };
  /** A reviewing task with a current retained reviewer run, as a stopped review leaves it. */
  const reviewingWithReviewer = () => {
    store.update(taskId, { phase: 'reviewing', prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
      completion: null, agentActive: true, lastAgentStatus: 'running', idleSince: new Date().toISOString() });
    const run = runSchema.parse({
      id: 'review-run', taskId, role: 'reviewer', generation: 1, head, base, agentId: 'review-agent', workspaceId,
      profile: reviewerProfile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: false,
    });
    store.putRun(run);
    store.setCredential(run.id, 'review-token');
    store.update(taskId, { resolution: { ...task().resolution, currentRunId: run.id,
      reviewerAgentId: 'review-agent', reviewerProfile } });
    observations.set('review-agent', idle('review-agent'));
    return store.run(run.id)!;
  };
  /** The production observation projection write the lifecycle pass makes. */
  const observeWorker = (agentId = 'worker-agent') =>
    (engine as unknown as { recordObservation: (task: Task, state: AgentObservation) => void })
      .recordObservation(store.task(taskId), idle(agentId));
  /** Run one owner control through its durable operation, as `queue.task` does. */
  const start = async (control: TaskControlInput) => {
    const acceptance = await engine.startOperation({ key: `observation-${control.version}-${randomUUID().slice(0, 8)}`,
      kind: 'task_control', payload: { type: 'task_control', control }, taskId, expectedVersion: control.version });
    if (!('accepted' in acceptance)) throw new Error(`operation was not accepted: ${acceptance.reason}`);
    return engine.awaitOperation(acceptance.operation.id);
  };
  return {
    dir, store, engine, adapter, observations, taskId, task, next, events, dispatched, retainedPr, reviewingWithReviewer, observeWorker, start,
    control: (fields: Record<string, unknown>) => taskControlInputSchema.parse({ taskId, version: task().version, caller: CALLER, ...fields }),
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 5)); }
  return predicate();
};

test('an owner control admitted at the version next showed survives an observation-only advance', async () => {
  const f = fixture();
  try {
    const task = f.dispatched();
    // Queue is paused, so the task's own quantum only observes: it records the
    // idle projection and nothing else. It holds this task's lane while the
    // owner's control is accepted and queued behind it.
    f.store.setMeta('paused', true);
    const observationGate = gate();
    const observe = f.adapter.observe;
    f.adapter.observe = async (id: string) => { observationGate.enter(); await observationGate.released; return observe(id); };
    const quantum = f.engine.scheduleTaskQuantum(task.id);
    await observationGate.entered;

    const control = f.control({ action: 'stop', reason: 'Hand this back for a planning ruling' });
    const operationPromise = f.start(control);
    observationGate.release();
    await quantum;
    const operation = await operationPromise;

    assert.equal(operation.state, 'succeeded', operation.diagnostic);
    const stopped = f.store.task(task.id);
    assert.equal(stopped.held, true, 'the stop applied');
    assert.match(holdsOf(stopped).dispatch?.reason ?? '', /^Owner stop: /);
    assert.equal(stopped.reason, 'Dispatch held; release to continue');
    assert.ok(stopped.version > task.version, 'the observed task version keeps moving forward');
    assert.ok((stopped.lastSubstantiveVersion ?? 0) > (task.lastSubstantiveVersion ?? 0), 'the stop is the substantive write');
    assert.equal(f.events('owner_stopped').length, 1, 'one durable owner result');
    assert.equal(f.events('owner_control').length, 1, 'one owner_control audit line');
  } finally { await f.close(); }
});

test('an owner move revalidates the current facts after its awaited source proof, not the observed version', async () => {
  const f = fixture();
  try {
    await f.retainedPr();
    const task = f.task();
    // The automatic observation lands while the move awaits its published-source
    // proof. It changes only the projection the store keeps out of a substantive
    // advance: activity, status and the observation stamps.
    const proofGate = gate();
    f.adapter.verifyInspectedRevisionHead = async () => { proofGate.enter(); await proofGate.released; };
    const moving = f.engine.performTaskControl(f.control({ action: 'move', to: 'review', reason: 'Review the delivered scope' }));
    await proofGate.entered;
    (f.engine as unknown as { recordObservation: (task: Task, state: AgentObservation) => void })
      .recordObservation(f.store.task(task.id), idle('worker-agent'));
    proofGate.release();
    const moved = await moving;

    assert.equal(moved.phase, 'awaiting_review');
    assert.equal(moved.version > task.version, true);
    assert.equal(f.events('owner_control').length, 1, 'one durable owner result');
    assert.equal(f.store.runs(f.taskId).filter(run => !run.released).length, 0, 'nothing was invented or displaced');
  } finally { await f.close(); }
});

test('a real controlling change during the same awaited proof still refuses with nothing written', async () => {
  const f = fixture();
  try {
    await f.retainedPr();
    const task = f.task();
    const proofGate = gate();
    f.adapter.verifyInspectedRevisionHead = async () => {
      proofGate.enter();
      await proofGate.released;
      f.store.update(task.id, { reason: 'A concurrent owner edit' });
    };
    const moving = f.engine.performTaskControl(f.control({ action: 'move', to: 'review', reason: 'Review the delivered scope' }));
    await proofGate.entered;
    proofGate.release();
    await assert.rejects(moving, /Task changed; refresh before retrying/);
    const after = f.store.task(task.id);
    assert.equal(after.phase, task.phase);
    assert.equal(after.reason, 'A concurrent owner edit');
    assert.equal(f.events('owner_control').length, 0, 'the refused move wrote no owner result');
  } finally { await f.close(); }
});

test('an owner reviewer restart survives an observation recorded during its own awaited liveness read', async () => {
  const f = fixture();
  try {
    const run = f.reviewingWithReviewer();
    const task = f.task();
    const livenessGate = gate();
    let fired = false;
    const observe = f.adapter.observe;
    f.adapter.observe = async (id: string) => {
      if (!fired) { fired = true; livenessGate.enter(); await livenessGate.released; f.observeWorker('review-agent'); }
      return observe(id);
    };
    const restarting = f.engine.performTaskControl(f.control({ action: 'restart', role: 'reviewer', fresh: true, reason: 'Start a fresh independent reader' }));
    await livenessGate.entered;
    livenessGate.release();
    const restarted = await restarting;

    assert.equal(restarted.phase, 'awaiting_review');
    assert.equal(restarted.resolution.currentRunId, null);
    assert.equal(restarted.resolution.reviewerAgentId, null);
    const old = f.store.run(run.id)!;
    // A fresh restart confirms the reader's archive before releasing its lease
    // and revoking its callback credential.
    assert.equal(old.released, true, 'the archived reader releases its lease');
    assert.throws(() => f.store.authenticate(run.id, 'review-token'));
    assert.equal(old.status, 'superseded');
    assert.ok(old.replacedAt, 'the replacement is recorded on the run it replaced');
    assert.ok(restarted.version > task.version, 'versions stay monotonic');
    assert.equal(f.events('owner_control').length, 1, 'one durable owner result');
  } finally { await f.close(); }
});

test('an unsettled run change during the same awaited read still refuses and changes nothing', async () => {
  const f = fixture();
  try {
    const run = f.reviewingWithReviewer();
    const task = f.task();
    const livenessGate = gate();
    let fired = false;
    const observe = f.adapter.observe;
    f.adapter.observe = async (id: string) => {
      if (!fired) { fired = true; livenessGate.enter(); await livenessGate.released; f.store.putRun({ ...f.store.run(run.id)!, status: 'uncertain' }); }
      return observe(id);
    };
    const restarting = f.engine.performTaskControl(f.control({ action: 'restart', role: 'reviewer', fresh: true, reason: 'Start a fresh independent reader' }));
    await livenessGate.entered;
    livenessGate.release();
    await assert.rejects(restarting, /Task or run changed; refresh before retrying/);
    const after = f.store.task(task.id);
    assert.equal(after.phase, task.phase);
    assert.equal(after.resolution.currentRunId, run.id, 'the reader keeps its lease');
    assert.equal(f.store.run(run.id)!.released, false);
    assert.equal(f.events('owner_control').length, 0, 'the refused restart wrote no owner result');
  } finally { await f.close(); }
});

test('an owner completion survives the observations it awaits, with one durable acceptance', async () => {
  const f = fixture();
  try {
    f.dispatched({ completion: null, prUrl: null, prHead: null });
    const task = f.task();
    const livenessGate = gate();
    let fired = false;
    const observe = f.adapter.observe;
    f.adapter.observe = async (id: string) => {
      if (!fired) { fired = true; livenessGate.enter(); await livenessGate.released; f.observeWorker(); }
      return observe(id);
    };
    const completing = f.engine.performTaskControl(f.control({ action: 'complete', reason: 'Report-only work is finished' }));
    await livenessGate.entered;
    livenessGate.release();
    const completed = await completing;

    assert.equal(completed.phase, 'done');
    assert.equal(completed.reportAcceptance?.kind, 'owner_completed');
    assert.equal(completed.reportAcceptance?.taskVersion, task.version, 'the acceptance records the version the owner acted on');
    assert.equal(f.events('owner_completed').length, 1, 'one durable completion result');
    assert.ok(completed.version > task.version, 'versions stay monotonic');
  } finally { await f.close(); }
});

test('the coordinator application path applies the same verb under the same observation', async () => {
  const f = fixture();
  try {
    await f.retainedPr();
    const view = f.next().verbs.find(entry => entry.verb === 'move' && (entry.args as Record<string, unknown> | undefined)?.to === 'review')!;
    assert.equal(view.available, true, view.refusal);
    // The coordinator applies the verb registry's own derived arguments through
    // the same engine entry a report reaches.
    const proofGate = gate();
    f.adapter.verifyInspectedRevisionHead = async () => { proofGate.enter(); await proofGate.released; };
    const applying = ownerVerb('move')!.apply(input => f.engine.performTaskControl(input),
      { ...(view.args as Record<string, unknown>), reason: 'Reported review move', caller: CALLER });
    await proofGate.entered;
    f.observeWorker();
    proofGate.release();
    const moved = await applying;

    assert.equal(moved.phase, 'awaiting_review');
    assert.equal(f.events('owner_control').length, 1, 'one durable owner result');
  } finally { await f.close(); }
});

test('retry_effect reads current effects instead of resending after an observation-only advance', async () => {
  const f = fixture();
  try {
    const task = f.dispatched();
    f.store.setMeta('paused', true);
    const observationGate = gate();
    const observe = f.adapter.observe;
    f.adapter.observe = async (id: string) => { observationGate.enter(); await observationGate.released; return observe(id); };
    const quantum = f.engine.scheduleTaskQuantum(task.id);
    await observationGate.entered;

    const operationPromise = f.start(f.control({ action: 'retry_effect', reason: 'Retry the recorded effect', effect: 'workspace_archive.ghost' }));
    observationGate.release();
    await quantum;
    const operation = await operationPromise;

    assert.equal(operation.state, 'failed');
    assert.match(operation.diagnostic, /No recorded side effect workspace_archive\.ghost is pending on this task/);
    assert.ok(f.store.task(task.id).version > task.version);
    assert.equal(f.events('owner_control').length, 0, 'nothing was applied or resent');
  } finally { await f.close(); }
});

const reliabilityLane = { key: 'reliability', title: 'Queue reliability',
  aim: 'Every waiting or stopped state has a visible cause, owner and supported exit.', repositories: [{ origin: 'acme/repo', path: '/repo' }] };

test('an owner lane attachment applies over an observation recorded during its awaited origin read', async () => {
  const f = fixture();
  try {
    f.store.upsertLane(reliabilityLane);
    const task = f.dispatched();
    // The control is suspended in the awaited repository-origin read. The
    // lifecycle pass records the worker's idle projection in that window.
    const attaching = f.engine.performTaskControl(f.control({ action: 'set_lane', lanes: ['reliability'] }));
    (f.engine as unknown as { recordObservation: (task: Task, state: AgentObservation) => void })
      .recordObservation(f.store.task(task.id), idle('worker-agent'));
    const observed = f.store.task(task.id);
    const attached = await attaching;

    assert.deepEqual(attached.lanes, ['reliability']);
    assert.equal(attached.lastAgentStatus, 'idle', 'the lane write keeps the observation it landed on');
    assert.equal(attached.agentActive, false);
    assert.equal(attached.version, observed.version + 1, 'one substantive advance for the lane edit');
    assert.equal(f.events('owner_control').length, 1);
  } finally { await f.close(); }
});

test('a substantive change during the awaited origin read refuses the lane attachment and writes nothing', async () => {
  const f = fixture();
  try {
    f.store.upsertLane(reliabilityLane);
    const task = f.dispatched();
    const attaching = f.engine.performTaskControl(f.control({ action: 'set_lane', lanes: ['reliability'] }));
    f.store.update(task.id, { reason: 'A concurrent owner edit' });
    await assert.rejects(attaching, /Task changed during the lane attachment; refresh before retrying/);
    const after = f.store.task(task.id);
    assert.deepEqual(after.lanes, task.lanes, 'the refused attachment wrote no lane');
    assert.equal(after.reason, 'A concurrent owner edit');
    assert.equal(f.events('owner_control').length, 0);
  } finally { await f.close(); }
});

test('an owner subscription applies over an observation recorded during its awaited recipient read', async () => {
  const f = fixture();
  try {
    const task = f.dispatched();
    const recipientGate = gate();
    const originAgent = f.adapter.originAgent!;
    f.adapter.originAgent = async (id: string) => { recipientGate.enter(); await recipientGate.released; return originAgent(id); };
    const subscribing = f.engine.completionSubscription({ taskId: task.id, version: task.version, agentId: 'finisher-agent', action: 'subscribe' });
    await recipientGate.entered;
    (f.engine as unknown as { recordObservation: (task: Task, state: AgentObservation) => void })
      .recordObservation(f.store.task(task.id), idle('worker-agent'));
    const observed = f.store.task(task.id);
    recipientGate.release();
    const subscribed = await subscribing;

    const override = subscribed.completionSubscriptionOverrides.find(entry => entry.agentId === 'finisher-agent');
    assert.deepEqual(override, { agentId: 'finisher-agent', workspaceId, subscribed: true });
    assert.equal(subscribed.lastAgentStatus, 'idle', 'the subscription write keeps the observation it landed on');
    assert.equal(subscribed.version, observed.version + 1);
    assert.equal(f.events('completion_subscribed').length, 1, 'one durable subscription write');
  } finally { await f.close(); }
});

test('a substantive change during the awaited recipient read refuses the subscription and writes nothing', async () => {
  const f = fixture();
  try {
    const task = f.dispatched();
    const recipientGate = gate();
    const originAgent = f.adapter.originAgent!;
    f.adapter.originAgent = async (id: string) => { recipientGate.enter(); await recipientGate.released; return originAgent(id); };
    const subscribing = f.engine.completionSubscription({ taskId: task.id, version: task.version, agentId: 'finisher-agent', action: 'subscribe' });
    await recipientGate.entered;
    f.store.update(task.id, { completionSubscriptionOverrides: [{ agentId: 'planner', workspaceId, subscribed: false }] });
    recipientGate.release();
    await assert.rejects(subscribing, /Task changed during the recipient observation; refresh before retrying/);
    const after = f.store.task(task.id);
    assert.deepEqual(after.completionSubscriptionOverrides, [{ agentId: 'planner', workspaceId, subscribed: false }],
      'the refused write did not overwrite the concurrent subscription edit');
    assert.equal(f.events('completion_subscribed').length, 0);
  } finally { await f.close(); }
});

test('an admitted retry joins the automatic archive already in flight: the actual result, one native effect', async t => {
  for (const unknownDelivery of [false, true] as const) await t.test(String(unknownDelivery), async t => {
    const f = await terminalArchiveFixture(t);
    f.remote.participant.status = 'closed';
    const entered = gate(), release = gate();
    const ref = f.api.workspaces.ref;
    f.api.workspaces.ref = () => ({ ...ref(), archive: async (requestId: string) => {
      f.remote.archives.push(requestId); entered.enter(); await release.released; f.remote.catalogued = false;
      if (unknownDelivery) throw Error('delivery response lost');
      return { archivedAt: new Date().toISOString() };
    } });
    f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries
      .map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) });
    f.engine.enqueueCleanup(f.task().id);
    await entered.entered;
    // The owner's control is admitted at the version `next` shows now, while the
    // automatic archive owns the workspace. It joins that same occurrence.
    const retry = f.engine.performTaskControl({ action: 'retry_effect', taskId: f.task().id, version: f.task().version,
      effect: 'workspace_archive.ws', caller: 'operator', reason: 'Retry after repairing the archive blocker' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.remote.archives.length, 1, 'the owner admits no second native request');
    release.release();
    await retry;
    await f.engine.drainCleanup();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws'], 'the admitted retry settles to the automatic result');
    assert.equal(f.remote.archives.length, 1, 'unknown delivery is observed, never replayed');
    assert.equal(existsSync(f.directory), false);
  });
});

test('automatic progress that already settled the named effect leaves a stale retry a safe refusal, never a replay', async t => {
  const f = await terminalArchiveFixture(t);
  f.remote.participant.status = 'closed';
  const admitted = f.task().version;
  f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries
    .map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) });
  f.engine.enqueueCleanup(f.task().id);
  await f.engine.drainCleanup();
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws'], 'the automatic pass settled the archive');
  assert.equal(f.remote.archives.length, 1);

  await assert.rejects(f.engine.performTaskControl({ action: 'retry_effect', taskId: f.task().id, version: admitted,
    effect: 'workspace_archive.ws', caller: 'operator', reason: 'Retry after repairing the archive blocker' }),
  /Task changed; refresh before retrying/);
  assert.equal(f.remote.archives.length, 1, 'a settled effect is never replayed');
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
});

test('an archive whose delivery stays unknown is observed, never replayed, and keeps its recorded intent', async t => {
  const f = await terminalArchiveFixture(t);
  f.remote.participant.status = 'closed';
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = () => ({ ...ref(), archive: async (requestId: string) => {
    f.remote.archives.push(requestId);
    f.remote.observationError = true;                 // the outcome cannot be read back
    throw Error('delivery response lost');
  } });
  f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries
    .map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) });
  f.engine.enqueueCleanup(f.task().id);
  await f.engine.drainCleanup();

  assert.equal(f.remote.archives.length, 1, 'the automatic attempt made one native request');
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws', 'an unknown outcome keeps its durable intent');
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.ok(existsSync(f.directory), 'nothing is torn down on an unknown outcome');

  // The owner's admitted retry observes the same operation and reports what it saw.
  await assert.rejects(f.engine.performTaskControl({ action: 'retry_effect', taskId: f.task().id, version: f.task().version,
    effect: 'workspace_archive.ws', caller: 'operator', reason: 'Retry after repairing the archive blocker' }),
  /unavailable|unconfirmed|no cause|failed/);
  assert.equal(f.remote.archives.length, 1, 'unknown delivery is never replayed by the retry');
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws', 'the unknown operation stays owned by its recorded intent');
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
});

test('the same recorded archive operation reconciles once its outcome is observable, with no new native request', async t => {
  const f = await terminalArchiveFixture(t);
  f.remote.participant.status = 'closed';
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = () => ({ ...ref(), archive: async (requestId: string) => {
    f.remote.archives.push(requestId); f.remote.observationError = true; throw Error('delivery response lost');
  } });
  f.updateResolution({ workspaceArchiveRetries: f.task().resolution.workspaceArchiveRetries
    .map(record => ({ ...record, nextAttemptAt: new Date(0).toISOString() })) });
  f.engine.enqueueCleanup(f.task().id);
  await f.engine.drainCleanup();
  assert.equal(f.remote.archives.length, 1);
  assert.equal(f.task().resolution.archiveIntentWorkspaceId, 'ws');

  // The same operation's outcome becomes observable: the workspace is positively gone.
  f.remote.observationError = false;
  f.remote.catalogued = false;
  await git(f.primary, 'worktree', 'remove', f.directory);
  const settled = await f.engine.performTaskControl({ action: 'retry_effect', taskId: f.task().id, version: f.task().version,
    effect: 'workspace_archive.ws', caller: 'operator', reason: 'Retry after repairing the archive blocker' });

  assert.deepEqual(settled.resolution.archivedWorkspaceIds, ['ws'], 'the recorded operation reconciles from the observation');
  assert.equal(settled.resolution.archiveIntentWorkspaceId, null, 'its intent settles with it');
  assert.equal(f.remote.archives.length, 1, 'reconciliation sends no second native request');
});

/** A dispatched task with the reviewer's accepted merge verdict at its exact head. */
function readyForMerge(f: ReturnType<typeof fixture>) {
  return f.store.update(f.taskId, {
    phase: 'awaiting_review', prUrl: 'https://github.com/example/repo/pull/7', prHead: head, resumePrNumber: 7,
    resolution: { ...f.task().resolution,
      review: { taskId: f.taskId, runId: 'review-run', eventId: 'review-accepted', status: 'ready_to_merge', summary: 'Fine at this head', head, reviewId: 12 } },
  });
}

test('a reviewed merge move refuses a substantive terminal transition that lands during its final PR observation', async () => {
  const f = fixture();
  try {
    const task = readyForMerge(f);
    let observations = 0;
    const verifyPr = f.adapter.verifyPr!;
    f.adapter.verifyPr = async (...args: Parameters<NonNullable<typeof verifyPr>>) => {
      observations++;
      // The verb's final PR observation (the one after its displacement work):
      // another owner control cancels the task while the read is in flight.
      if (observations === 2) f.store.update(task.id, { phase: 'cancelled', reason: 'Owner cancelled while the merge moved' });
      return verifyPr(...args);
    };
    await assert.rejects(f.engine.performTaskControl(f.control({ action: 'move', to: 'merge', reason: 'The review is accepted; take it to merge' })),
      /Task changed; refresh before retrying/);

    const after = f.store.task(task.id);
    assert.equal(observations, 2, 'the concurrent transition landed on the verb\'s final PR observation');
    assert.equal(after.phase, 'cancelled', 'the merge move did not overwrite the terminal transition');
    assert.equal(after.reason, 'Owner cancelled while the merge moved');
    assert.ok(!after.resolution.mergeIntent, 'no merge intent was written');
    assert.equal(f.events('owner_control').length, 0, 'the refused move wrote no owner result');
  } finally { await f.close(); }
});

test('the same reviewed merge move still applies when only an observation lands during that final read', async () => {
  const f = fixture();
  try {
    const task = readyForMerge(f);
    let observations = 0;
    const verifyPr = f.adapter.verifyPr!;
    f.adapter.verifyPr = async (...args: Parameters<NonNullable<typeof verifyPr>>) => {
      observations++;
      if (observations === 2) f.observeWorker();
      return verifyPr(...args);
    };
    const moved = await f.engine.performTaskControl(f.control({ action: 'move', to: 'merge', reason: 'The review is accepted; take it to merge' }));

    assert.equal(moved.phase, 'verifying', 'the observation-only advance does not block the admitted move');
    assert.equal(moved.resolution.review?.status, 'ready_to_merge');
    assert.ok(moved.resolution.integrationTurn?.sequence, 'the integration turn is recorded');
    assert.ok(moved.version > task.version, 'versions stay monotonic');
    assert.equal(f.events('owner_control').length, 1, 'one durable owner result');
  } finally { await f.close(); }
});

for (const read of [1, 2]) {
  test(`a merge move preserves cancellation across awaited PR read ${read}`, async () => {
    const f = fixture();
    const barrier = gate();
    try {
      const task = readyForMerge(f);
      let reads = 0;
      const verifyPr = f.adapter.verifyPr!;
      f.adapter.verifyPr = async (...args: Parameters<NonNullable<typeof verifyPr>>) => {
        if (++reads === read) { barrier.enter(); await barrier.released; }
        return verifyPr(...args);
      };
      const pending = f.engine.performTaskControl(f.control({ action: 'move', to: 'merge', reason: 'Apply the accepted review' }));
      const refused = assert.rejects(pending, /Task changed; refresh before retrying/);
      await barrier.entered;
      f.store.update(task.id, { phase: 'cancelled', reason: 'Concurrent owner cancellation' });
      const cancelled = f.task();
      barrier.release();
      await refused;
      assert.deepEqual(f.task(), cancelled, 'the refusal preserves the entire concurrent write');
      assert.equal(f.events('owner_control').length, 0);
      assert.equal(f.events('owner_stop_intent').length, 0);
      assert.ok(!f.task().resolution.mergeIntent);
    } finally { barrier.release(); await f.close(); }
  });
}

for (const read of [1, 2]) {
  test(`a merge move tolerates observation updates across awaited PR read ${read}`, async () => {
    const f = fixture();
    const barrier = gate();
    try {
      const task = readyForMerge(f);
      let reads = 0;
      const verifyPr = f.adapter.verifyPr!;
      f.adapter.verifyPr = async (...args: Parameters<NonNullable<typeof verifyPr>>) => {
        if (++reads === read) { barrier.enter(); await barrier.released; }
        return verifyPr(...args);
      };
      const pending = f.engine.performTaskControl(f.control({ action: 'move', to: 'merge', reason: 'Apply the accepted review' }));
      await barrier.entered;
      f.observeWorker();
      const observedVersion = f.task().version;
      barrier.release();
      const moved = await pending;
      assert.equal(moved.phase, 'verifying');
      assert.ok(moved.version > observedVersion && observedVersion > task.version);
      assert.equal(f.events('owner_control').length, 1);
      assert.equal(f.events('owner_stop_intent').length, 0);
      assert.ok(!moved.resolution.mergeIntent, 'ordinary verification still owns merge intent');
    } finally { barrier.release(); await f.close(); }
  });
}

test('a merge move refuses cancellation during participant observation before stopping or settling that run', async () => {
  const f = fixture();
  const barrier = gate();
  try {
    const run = f.reviewingWithReviewer();
    readyForMerge(f);
    f.adapter.observe = async id => {
      barrier.enter(); await barrier.released;
      return { ...idle(id), active: true, status: 'running' };
    };
    const pending = f.engine.performTaskControl(f.control({ action: 'move', to: 'merge', reason: 'Apply the accepted review' }));
    const refused = assert.rejects(pending, /Task changed; refresh before retrying/);
    await barrier.entered;
    f.store.update(f.taskId, { phase: 'cancelled', reason: 'Concurrent cancellation during participant read' });
    const cancelled = f.task();
    barrier.release();
    await refused;
    assert.deepEqual(f.task(), cancelled);
    assert.deepEqual(f.store.runs(f.taskId), [run], 'the participant and callback binding remain owned');
    assert.equal(f.events('owner_stop_intent').length, 0);
    assert.equal(f.events('owner_control').length, 0);
  } finally { barrier.release(); await f.close(); }
});
