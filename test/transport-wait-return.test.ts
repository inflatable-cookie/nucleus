import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { submission } from './support/fakes';
import { TASK_PROGRESSING_REASON } from '../shared/task-detail-summary';

/**
 * Spec 066 C2 (papercut reproduction: nucleus#1318 and #1321).
 *
 * A transport wait is a reading of one host at one moment, not a sentence that
 * has to be recognised again. The pass that observes that host answer settles the
 * wait it wrote and visits the ready task in the same pass; an unrelated owner
 * stop beside it stays as it was; another host that is still failing holds only
 * its own tasks, and a repeated pass converges with no extra events.
 *
 * The stored shapes are written by the real writer (`resolution.transportDeferred`,
 * `resolution.waiting`, the engine's own `hostWait`), with synthetic host
 * identities, so a fixture never hand-writes a row the code could not produce.
 */
const HOST_A = 't3code:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOST_B = 't3code:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
type Loose = Record<string, any>;

function fixture(
  t: TestContext,
  hostProcessListing?: Adapter['hostProcessListing'],
  observationInventory?: Adapter['observationInventory'],
) {
  const store = new Store(':memory:');
  const engine = new Engine(
    store,
    { hostProcessListing, observationInventory } as Adapter,
    60_000,
  );
  t.after(async () => { await engine.stop(); store.close(); });
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 0);
  /** This pass's clock per host: the one fact a transport wait is re-read against. */
  const online: Record<string, boolean> = { [HOST_A]: true, [HOST_B]: true };
  const visited: string[] = [];
  const dispatched: string[] = [];
  engine.hostIds = () => [HOST_A, HOST_B];
  engine.hostAvailable = host => online[host] !== false;
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.clearRetiredInvalidations = () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {};
  engine.archiveRetiredErroredAgents = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.deliverPendingBriefAmendments = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.origins.pass = async () => {};
  engine.resolution.observationTargets = () => [];
  engine.resolution.observe = async () => {};
  // The task quantum is the visit this batch is judged on: record it, and let the
  // fixture keep the task's own step out of the assertion.
  engine.scheduleTaskQuantum = async taskId => { visited.push(taskId); };
  engine.dispatchQueued = async () => {
    for (const task of [HOST_A, HOST_B].flatMap(host => store.tasks().filter(entry => entry.hostId === host)))
      if (engine.taskHostAvailable(store.task(task.id))) dispatched.push(task.id);
  };
  for (const method of ['deliverNotices', 'deliverQueuedMessages', 'resumeAskQuestions', 'raiseOperatorQuestions',
    'delegateNativeQuestions', 'resumeResponsibleAnsweredQuestions', 'deliverHoldNotices', 'deliverDecisionNotices',
    'deliverDrainNotices', 'deliverHostOutageNotices'] as const)
    (engine.resolution as Loose)[method] = async () => {};
  const add = (hostId: string, title: string) => {
    const inserted = store.insert(submission({ title, repoPath: `/synthetic/${hostId.slice(0, 6)}` }), hostId, 'handoff.md', 'b'.repeat(40));
    return store.update(inserted.id, {
      phase: 'working', workspaceId: `workspace-${inserted.id}`, agentId: `worker-${inserted.id}`, runId: 'initial',
    }, 'dispatched');
  };
  const pass = () => engine.auditPass(true);
  const kinds = (id: string) => store.eventsAll(id).map(event => event.kind);
  return { store, engine, online, visited, dispatched, add, pass, kinds };
}

const transportCause = (hostId: string) => new Error(`Transport not connected: host ${hostId} is unavailable`);

test('a transport wait clears on the pass that observes the host answer, and the ready task is visited in that pass', async t => {
  const f = fixture(t);
  const task = f.add(HOST_A, 'Transport-waiting task');
  // The live shape: the transport dropped mid-call, and the failure recorded the
  // host-scoped wait with its own diagnostic in the stop.
  f.engine.resolution.transportDeferred(f.store.task(task.id), transportCause(HOST_A));
  const stored = f.store.task(task.id);
  assert.equal(stored.resolution.stop?.reason, 'host_unavailable', stored.reason);
  assert.match(stored.resolution.stop?.detail ?? '',
    /^Daemon transport unavailable; retrying on the next pass: Transport not connected: host t3code:aaaa/);
  assert.equal(stored.reason, stored.resolution.stop?.detail, 'the board shows the recorded cause');

  // The host is still away when the next pass looks: the wait holds and nothing is started.
  f.online[HOST_A] = false;
  await f.pass();
  assert.equal(f.store.task(task.id).resolution.stop?.reason, 'host_unavailable', 'a host that did not answer holds its own wait');
  assert.deepEqual(f.visited, [], 'no quantum is started for an unavailable host');
  assert.ok(f.store.task(task.id).resolution.hostWait, 'the task records its own host wait');
  assert.ok(f.kinds(task.id).includes('transport_deferred'), 'the transport cause stays in history');

  // The host is back: the same pass settles the wait and visits the ready task.
  f.online[HOST_A] = true;
  await f.pass();
  const cleared = f.store.task(task.id);
  assert.equal(cleared.resolution.stop, null, 'the transport condition clears on return');
  assert.equal(cleared.resolution.hostWait, null, 'and so does the independent host wait');
  assert.equal(cleared.reason, TASK_PROGRESSING_REASON, 'the stale daemon text does not survive as the reason');
  assert.deepEqual(f.visited, [task.id], 'the ready task is visited in the returning pass');
  assert.equal(f.kinds(task.id).filter(kind => kind === 'host_wait_cleared').length, 1);
  assert.equal(f.store.notices().filter(notice => notice.kind === 'host_outage').length, 0, 'a short loss sends no notice');

  // The same fact repeated settles nothing twice: a later pass adds no event and no wait.
  await f.pass();
  assert.equal(f.kinds(task.id).filter(kind => kind === 'host_wait_cleared').length, 1, 'a repeated pass converges');
  assert.equal(f.kinds(task.id).filter(kind => kind === 'transport_deferred').length, 1, 'one reading, one record');
  assert.equal(f.store.task(task.id).resolution.stop, null);
});

test('an inventory that loses the transport fails only its own step: the host stays connected and the task moves on', async t => {
  let connected = true;
  const f = fixture(t, undefined, async () => {
    if (!connected) throw transportCause(HOST_A);
    return new Map();
  });
  const task = f.add(HOST_A, 'Inventory transport task');
  f.engine.resolution.observationTargets = () => ['agent-1'];
  f.engine.resolution.transportDeferred(f.store.task(task.id), transportCause(HOST_A));

  // Spec 069 §2 (superseding Spec 066 R6): the registry still claims the host, so a
  // lost inventory is one failed call. It fails only its own step and leaves the
  // host up (degraded takes three failed passes in a row); the connected host settles
  // the task's own wait and its owner's quantum retries the work.
  connected = false;
  await f.pass();
  assert.equal(f.engine.hostHealth.read(HOST_A).state, 'up', 'one failed pass is not the host');
  assert.equal(f.engine.hostOutages.current(HOST_A), null, 'and opens no outage');
  const settled = f.store.task(task.id);
  assert.equal(settled.resolution.stop, null, 'the connected host settles the transport wait');
  assert.equal(settled.resolution.hostWait, null);
  assert.deepEqual(f.visited, [task.id], 'and the task is visited by its own owner');
  assert.match(String(f.store.getMeta('hostPassError')), /observationInventory: Transport not connected/);

  connected = true;
  await f.pass();
  assert.equal(f.engine.hostHealth.read(HOST_A).state, 'up', 'and a clean pass keeps it up');
  assert.equal(f.store.task(task.id).resolution.stop, null);
});

test('a slow process reader and a still-failing host leave the returning host free to settle', async t => {
  let readStarted!: () => void;
  let releaseRead!: () => void;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const gated = new Promise<null>(resolve => { releaseRead = () => resolve(null); });
  const f = fixture(t, () => { readStarted(); return gated; });
  t.after(releaseRead);
  const ready = f.add(HOST_A, 'Ready task');
  const away = f.add(HOST_B, 'Away task');
  const interactive = f.add(HOST_A, 'Operator stop');
  const reason = "Interactive session: waiting for the operator in the worker's thread";
  f.store.update(interactive.id, { interactive: true }, 'interactive');
  f.engine.resolution.waiting(f.store.task(interactive.id), reason, 'interactive');
  f.engine.resolution.transportDeferred(f.store.task(ready.id), transportCause(HOST_A));
  f.engine.resolution.transportDeferred(f.store.task(away.id), transportCause(HOST_B));
  f.online[HOST_B] = false;

  const audit = f.pass();
  try {
    const timeout = AbortSignal.timeout(5_000);
    await Promise.race([Promise.all([reading, audit]), new Promise<never>((_, reject) => {
      timeout.addEventListener('abort', () => reject(Error('audit waited for process cleanup')), { once: true });
    })]);
  } finally {
    releaseRead();
  }

  assert.equal(f.store.task(ready.id).resolution.stop, null, 'the reachable host settles its own task');
  assert.equal(f.store.task(away.id).resolution.stop?.reason, 'host_unavailable', 'the failing host keeps its own task waiting');
  assert.deepEqual(new Set(f.visited), new Set([ready.id, interactive.id]));
  const next = (id: string) => ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(id)));
  assert.equal(next(ready.id).stop?.reason === 'host_unavailable', false);
  assert.equal(next(away.id).stop?.reason, 'host_unavailable');
  assert.equal(next(interactive.id).stop?.reason, 'interactive');
  assert.deepEqual(f.dispatched.filter(id => id === ready.id), [ready.id], 'and dispatch reads it as ready');
  assert.equal(f.store.getMeta('engineError'), '', 'one host\'s transport failure is not an engine fault');
  const settled = f.kinds(ready.id).filter(kind => kind === 'host_wait_cleared');
  assert.equal(settled.length, 1);
  await f.pass();
  assert.deepEqual(f.kinds(ready.id).filter(kind => kind === 'host_wait_cleared'), settled);
});

test('an owner stop beside the wait keeps its question when the host answers', async t => {
  const f = fixture(t);
  const task = f.add(HOST_A, 'Interactive task');
  // The owner's answer is the current stop; the host going away is a separate,
  // independent wait (the outage preservation rule) and leaves the question alone.
  const reason = "Interactive session: waiting for the operator in the worker's thread";
  f.store.update(task.id, { interactive: true }, 'interactive');
  f.engine.resolution.waiting(f.store.task(task.id), reason, 'interactive');
  f.online[HOST_A] = false;
  await f.pass();
  assert.equal(f.store.task(task.id).resolution.stop?.reason, 'interactive', 'the host going away does not replace the owner stop');
  assert.ok(f.store.task(task.id).resolution.hostWait, 'the independent host wait is still recorded');

  f.online[HOST_A] = true;
  await f.pass();
  const after = f.store.task(task.id);
  assert.equal(after.resolution.hostWait, null, 'the host wait clears when the host answers');
  assert.equal(after.resolution.stop?.reason, 'interactive', 'the owner stop stays visible');
  assert.equal(after.reason, reason);
  assert.deepEqual(f.visited, [task.id], 'the task is still visited while its owner stop stands');
});

test('a transport deferral beside an attention stop records its cause and replaces no decision', async t => {
  const f = fixture(t);
  const task = f.add(HOST_A, 'Parked task');
  const reason = 'Revision budget exhausted; operator decision required';
  f.store.update(task.id, { phase: 'needs_attention', reason, resolution: { ...f.store.task(task.id).resolution, attention: true } }, 'needs_attention');

  f.engine.resolution.transportDeferred(f.store.task(task.id), transportCause(HOST_A));
  assert.equal(f.store.task(task.id).resolution.stop, null, 'an attention episode keeps its own record');
  assert.equal(f.store.task(task.id).reason, reason);
  assert.ok(f.kinds(task.id).includes('transport_deferred'), 'the transport reading is durable beside it');

  await f.pass();
  assert.equal(f.store.task(task.id).reason, reason, 'the returning host settles nothing onto the owner\'s answer');
  assert.equal(f.store.task(task.id).resolution.hostWait, null);
});
