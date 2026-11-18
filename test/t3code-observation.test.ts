import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import type { Task } from '../shared/contracts';
import { WIRE_LABEL_KEYS } from '../shared/wire-labels';
import { STAMP, t3Fake, threadProjection, syntheticRun } from './support/t3code-fake';
import { storedHostState, storedHostStateShape, taskFact, type StoredThread } from './support/t3code-state';

/**
 * nucleus#1328: T3 stops paying for finished work.
 *
 * The adapter observes a thread only while its Nucleus task is live, and a pass
 * reads one snapshot per thread, shared by every consumer and skipped when T3's
 * own thread list says nothing changed. Every count here is taken on the serving
 * side: the fake's `snapshots` log is the same fact the Nightly's own server trace
 * carries for `orchestration.subscribeThread`, and that rate is what costs T3 the
 * CPU.
 */

/** A thread id in the shape the stored file carries, with a synthetic identity. */
const threadId = (name: string) => `nucleus-thread-synthetic${name}`;

type Fake = Awaited<ReturnType<typeof t3Fake>>;
type Projection = ReturnType<typeof threadProjection>;

/** One seeded T3 thread: what the Nightly serves for it, and nothing it would not. */
function seed(server: Fake, id: string, directory: string, change: (projection: Projection) => void = () => {}) {
  const projection = threadProjection(id, directory);
  change(projection);
  server.threads.set(id, projection);
  return projection;
}

async function fixture(t: TestContext, input: {
  threads: readonly StoredThread[];
  settled?: readonly { threadId: string; runId: string }[];
  pendingSettles?: readonly { threadId: string; runId: string }[];
  /** Threads this host proved it removed. */
  deleted?: readonly string[];
  seed?: (server: Fake, directory: string) => void;
}) {
  const root = mkdtempSync(join(tmpdir(), 't3code-observation-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(storedHostState({ directory, threads: input.threads,
    settled: input.settled, pendingSettles: input.pendingSettles, deleted: input.deleted })), { mode: 0o600 });
  for (const thread of input.threads) seed(server, thread.id, directory);
  input.seed?.(server, directory);
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath, timeoutMs: 1_000,
    probeThreadId: input.threads[0]!.id });
  t.after(() => host.close());
  await host.connect();
  /** One thread's snapshots as the serving side counted them since `from`. */
  const snapshotsFor = (id: string, from = 0) => server.snapshots.slice(from).filter(snapshot => snapshot.threadId === id).length;
  return { root, directory, server, host, statePath, snapshotsFor, served: () => server.snapshots.length };
}

/** Every read-only consumer one pass runs for a live thread. */
async function consume(host: T3CodeHost, id: string) {
  await host.observe(id);
  await host.pendingQuestions(id);
  await host.answeredQuestions(id);
  await host.agentTimelinePage(id);
  await host.reads.activeRunId(id);
}

test('the fixture is the state shape the adapter really stores', async t => {
  const only = { id: threadId('shape'), taskId: 'task-shape', runId: 'run-shape' };
  const { host } = await fixture(t, { threads: [only] });
  const stored = host.state.read();
  assert.deepEqual(Object.keys(stored).sort(), [...storedHostStateShape.topLevel].sort(),
    'a test host state carries the stored top-level keys');
  const agent = stored.agents[only.id]!;
  assert.deepEqual(Object.keys(agent).sort(), [...storedHostStateShape.agent].sort(), 'the stored agent record keys');
  assert.deepEqual(Object.keys(stored.workspaces[agent.workspaceId]!).sort(), [...storedHostStateShape.workspace].sort(),
    'the stored workspace record keys');
  for (const intent of Object.values(stored.intents))
    for (const key of storedHostStateShape.intent) assert.ok(Object.hasOwn(intent, key), `the stored intent carries ${key}`);
  // The adapter parses and rewrites the stored record on its first pass, so a
  // retired record's shape is checked against the same captured key list.
  await host.beginHostPass([taskFact(only.taskId, 'done') as Task]);
  await host.endHostPass();
  const retired = host.state.read().retiredAgents?.[only.id];
  assert.deepEqual(Object.keys(retired ?? {}).sort(), ['labels', 'workspaceId'], 'a retired record keeps the launch identity');
  for (const key of Object.keys(retired ?? {})) assert.ok(storedHostStateShape.retiredAgent.includes(key), `the retired record uses only captured keys, not ${key}`);
});

test('a pass over terminal tasks serves no T3 thread snapshot at all', async t => {
  // The stored file as it really is: every tracked thread belongs to a task that is
  // over, and T3 reports each archived. Before nucleus#1328 one pass served several
  // full snapshots per thread, on every sweep, forever.
  const terminal = Array.from({ length: 12 }, (_, index) => ({ id: threadId(`done${index}`), taskId: `task-done-${index}`,
    runId: `run-done-${index}`, role: 'revision' as const }));
  const live = { id: threadId('live'), taskId: 'task-live', runId: 'run-live' };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [...terminal, live],
    settled: terminal.slice(0, 3).map(thread => ({ threadId: thread.id, runId: thread.runId })),
    seed: fake => { for (const thread of terminal) fake.threads.get(thread.id)!.thread.archivedAt = STAMP; },
  });
  const tasks = [...terminal.map(thread => taskFact(thread.taskId, 'done')), taskFact(live.taskId, 'working')] as Task[];
  const before = served();
  await host.beginHostPass(tasks);

  // Deciding what to observe is a thread-list read: no thread snapshot is served.
  assert.equal(served(), before, 'opening the pass served no thread snapshot');
  const stored = host.state.read();
  assert.deepEqual(Object.keys(stored.agents), [live.id], 'only the live task keeps an observed thread');
  for (const thread of terminal) {
    assert.equal(stored.agents[thread.id], undefined, `${thread.id} is no longer observed`);
    assert.equal(stored.retiredAgents?.[thread.id]?.labels[WIRE_LABEL_KEYS.task], thread.taskId, 'its launch identity is kept');
    assert.equal(stored.retiredAgents?.[thread.id]?.labels[WIRE_LABEL_KEYS.run], thread.runId);
  }
  // The whole pass: titles, both settle paths, the observation inventory and the
  // reconciliation passes all run against those finished threads and serve nothing.
  await host.reconcileThreadTitles(tasks);
  await host.settleWorkerThread(terminal[3]!.id, terminal[3]!.runId);
  await host.settleReportedThread(terminal[4]!.id, terminal[4]!.runId);
  assert.deepEqual([...(await host.observationInventory(terminal.map(thread => thread.id)))!], []);
  await host.unsettleWorkerThread(terminal[5]!.id, terminal[5]!.taskId);
  await host.reconcileSettledThreads();
  await host.reconcileReportedSettlements();
  await host.endHostPass();
  assert.equal(served(), before, 'a full pass over finished tasks served no thread snapshot');
  for (const thread of terminal) assert.equal(snapshotsFor(thread.id, before), 0, `${thread.id} was not snapshotted`);
  assert.equal(server.commands.filter(command => command.type === 'thread.settle').length, 0, 'no settle was sent');
  assert.equal(host.reads.observes(live.id), true, 'the live task thread is still observed');
});

test('an unchanged thread is not snapshotted, and a changed live thread is snapshotted once per pass', async t => {
  const live = { id: threadId('live'), taskId: 'task-live', runId: 'run-live' };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [live],
    seed: (fake, directory) => seed(fake, live.id, directory, projection => {
      projection.runs.push(syntheticRun(live.id, 1, { id: 'native-run-1', status: 'running', rootNodeId: 'node-root-1' }));
    }),
  });
  const tasks = [taskFact(live.taskId, 'working')] as Task[];

  // One pass, five consumers, one snapshot: every reader shares the same answer.
  let before = served();
  await host.beginHostPass(tasks);
  await consume(host, live.id);
  assert.equal(snapshotsFor(live.id, before), 1, 'a changed live thread is snapshotted once, shared by every consumer');
  await host.endHostPass();

  // A second pass with nothing changed serves nothing: the thread's own row in
  // T3's list is the change marker, and this one is identical.
  before = served();
  await host.beginHostPass(tasks);
  await consume(host, live.id);
  assert.equal(served(), before, 'an unchanged live thread is not snapshotted again');
  await host.endHostPass();

  // T3 reports the run finished: the row changed, so the next pass reads once.
  server.threads.get(live.id)!.runs[0]!.status = 'completed';
  before = served();
  await host.beginHostPass(tasks);
  await consume(host, live.id);
  assert.equal(snapshotsFor(live.id, before), 1, 'a changed live thread is snapshotted once in the pass that sees it');
  assert.equal((await host.observe(live.id)).active, false, 'the shared snapshot is the changed state');
  await host.endHostPass();
});

test('a thread T3 reports archived leaves observation even while its task is live', async t => {
  const archived = { id: threadId('archived'), taskId: 'task-live', runId: 'run-archived', role: 'reviewer' as const };
  const { host, served } = await fixture(t, { threads: [archived],
    seed: fake => { fake.threads.get(archived.id)!.thread.archivedAt = STAMP; } });
  const tasks = [taskFact(archived.taskId, 'working')] as Task[];
  const before = served();
  await host.beginHostPass(tasks);
  await host.endHostPass();
  assert.equal(served(), before, 'an archived thread is not read');
  assert.equal(host.state.read().agents[archived.id], undefined, 'an archived thread leaves the live map');
  assert.ok(host.state.read().retiredAgents?.[archived.id], 'and keeps its launch identity');
});

test('a terminal task keeps its exact settle and lookup after its agent records leave host state', async t => {
  const settledThread = { id: threadId('settled'), taskId: 'task-done', runId: 'run-settled', role: 'revision' as const };
  const awaiting = { id: threadId('awaiting'), taskId: 'task-done', runId: 'run-awaiting', role: 'revision' as const };
  const removed = { id: threadId('removed'), taskId: 'task-done', runId: 'run-removed', role: 'recovery' as const };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [settledThread, awaiting, removed],
    settled: [{ threadId: settledThread.id, runId: settledThread.runId }],
    // A handover settle recorded before the task ended and never completed.
    pendingSettles: [{ threadId: awaiting.id, runId: awaiting.runId }],
    // A thread this host proved it removed, which is the other terminal fact.
    deleted: [removed.id],
  });
  const tasks = [taskFact('task-done', 'done')] as Task[];
  await host.beginHostPass(tasks);
  const stored = host.state.read();
  assert.equal(stored.agents[settledThread.id], undefined);
  assert.equal(stored.agents[awaiting.id], undefined);
  assert.equal(stored.retiredAgents?.[settledThread.id]?.labels[WIRE_LABEL_KEYS.run], settledThread.runId);
  // The durable settle receipt an exact settle still reads.
  const marker = stored.settledThreads?.[settledThread.id];
  assert.ok(marker, 'the recorded settle marker stays');
  assert.equal(stored.intents[marker!]?.status, 'settled');

  const before = served();
  // An exact lookup answers from the launch identity alone: no snapshot.
  const found = await host.findAgents({ [WIRE_LABEL_KEYS.task]: 'task-done', [WIRE_LABEL_KEYS.run]: settledThread.runId });
  assert.deepEqual(found, [{ id: settledThread.id, workspaceId: stored.retiredAgents![settledThread.id]!.workspaceId }]);
  assert.equal(snapshotsFor(settledThread.id, before), 0, 'the exact lookup reads no T3 thread');
  // Settling again sends nothing and reads nothing: the task is over and the
  // recorded receipt is what a settle reads. The unresolved one is retired rather
  // than resent, and never read for.
  await host.settleWorkerThread(settledThread.id, settledThread.runId);
  await host.settleReportedThread(awaiting.id, awaiting.runId);
  await host.reconcileSettledThreads();
  assert.deepEqual(Object.keys(host.state.read().pendingSettles ?? {}), [], 'the unresolved settle is retired, not resent');
  assert.equal(server.commands.filter(command => command.type === 'thread.settle').length, 0, 'no settle was sent');
  assert.equal(served(), before, 'no exact settle or lookup read a thread that left observation');
  // The thread-list answer the terminal lane needs is still available for free.
  const observed = await host.observe(settledThread.id);
  assert.equal(observed.status, 'idle');
  assert.deepEqual(observed.labels, stored.retiredAgents![settledThread.id]!.labels);
  assert.equal(served(), before, 'the terminal answer comes from the thread list');
  // A proven removal is recorded on the retired identity rather than dropped: that
  // identity is what keeps a removed thread out of observation, and it is never
  // looked up as a thread that could still be attached.
  assert.ok(host.state.read().retiredAgents?.[removed.id], 'a removed thread keeps its launch identity');
  const afterRemoval = host.state.read().retiredAgents![removed.id]!;
  assert.equal(typeof afterRemoval.deletedAt, 'string', 'the removal is recorded on the kept identity');
  assert.deepEqual(await host.findAgents({ [WIRE_LABEL_KEYS.task]: 'task-done', [WIRE_LABEL_KEYS.run]: removed.runId }), [],
    'a removed thread is not an exact lookup answer');
  assert.equal(served(), before, 'and looking it up reads nothing');
  await host.endHostPass();
});

test('a live task still reads its own threads once for their step and row title', async t => {
  // The window must not cost a live task its presentation: a live support thread
  // that ended with a fault still names the row's step, from that pass's snapshot.
  const worker = { id: threadId('worker'), taskId: 'task-live', runId: 'run-worker' };
  const reviewer = { id: threadId('reviewer'), taskId: 'task-live', runId: 'run-reviewer', role: 'reviewer' as const };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [worker, reviewer],
    seed: (fake, directory) => {
      seed(fake, reviewer.id, directory, projection => {
        projection.thread.title = '225 review: synthetic';
        projection.runs.push(syntheticRun(reviewer.id, 1, { id: 'review-stage', status: 'failed' }));
      });
    },
  });
  // The row's base title is what the adapter recorded when it last titled the row.
  host.state.update(state => { state.agents[worker.id]!.title = 'Working*: synthetic'; });
  const tasks = [taskFact('task-live', 'working')] as Task[];
  const before = served();
  await host.beginHostPass(tasks);
  await host.reconcileThreadTitles(tasks);
  await host.endHostPass();
  assert.equal(snapshotsFor(reviewer.id, before), 1, 'the reviewer thread is read once for its step');
  assert.equal(snapshotsFor(worker.id, before), 1, 'the worker row is read once for its title');
  assert.ok(host.state.read().agents[reviewer.id] !== undefined, 'a live support thread stays observed');
  const titles = server.commands.filter(command => command.type === 'thread.metadata.update').map(command => command.title);
  assert.ok(titles.some(title => String(title).includes('blocked: reviewer')), 'the row names the faulted reviewer');
});
