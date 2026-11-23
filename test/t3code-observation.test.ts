import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import type { Task } from "../shared/contracts";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import {
  STAMP,
  t3Fake,
  threadProjection,
  syntheticRun,
} from "./support/t3code-fake";
import {
  storedHostState,
  storedHostStateShape,
  taskFact,
  type StoredThread,
} from "./support/t3code-state";

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
function seed(
  server: Fake,
  id: string,
  directory: string,
  change: (projection: Projection) => void = () => {},
) {
  const projection = threadProjection(id, directory);
  change(projection);
  server.threads.set(id, projection);
  return projection;
}

async function fixture(
  t: TestContext,
  input: {
    threads: readonly StoredThread[];
    /** Threads this host proved it removed. */
    deleted?: readonly string[];
    /** Tasks this host runs on its own parent thread. */
    parents?: readonly { taskId: string; threadId: string; title?: string }[];
    seed?: (server: Fake, directory: string) => void;
  },
) {
  const root = mkdtempSync(join(tmpdir(), "t3code-observation-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const statePath = join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      storedHostState({
        directory,
        threads: input.threads,
        deleted: input.deleted,
        parents: input.parents,
      }),
    ),
    { mode: 0o600 },
  );
  for (const thread of input.threads) seed(server, thread.id, directory);
  input.seed?.(server, directory);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 1_000,
    probeThreadId: input.threads[0]!.id,
  });
  t.after(() => host.close());
  await host.connect();
  /** One thread's snapshots as the serving side counted them since `from`. */
  const snapshotsFor = (id: string, from = 0) =>
    server.snapshots.slice(from).filter((snapshot) => snapshot.threadId === id)
      .length;
  return {
    root,
    directory,
    server,
    host,
    statePath,
    snapshotsFor,
    served: () => server.snapshots.length,
  };
}

/** Every read-only consumer one pass runs for a live thread. */
async function consume(host: T3CodeHost, id: string) {
  await host.observe(id);
  await host.pendingQuestions(id);
  await host.answeredQuestions(id);
  await host.agentTimelinePage(id);
  await host.reads.activeRunId(id);
}

test("the fixture is the state shape the adapter really stores", async (t) => {
  const only = {
    id: threadId("shape"),
    taskId: "task-shape",
    runId: "run-shape",
  };
  const { host } = await fixture(t, { threads: [only] });
  const stored = host.state.read();
  assert.deepEqual(
    Object.keys(stored).sort(),
    [...storedHostStateShape.topLevel].sort(),
    "a test host state carries the stored top-level keys",
  );
  const agent = stored.agents[only.id]!;
  assert.deepEqual(
    Object.keys(agent).sort(),
    [...storedHostStateShape.agent].sort(),
    "the stored agent record keys",
  );
  assert.deepEqual(
    Object.keys(stored.workspaces[agent.workspaceId]!).sort(),
    [...storedHostStateShape.workspace].sort(),
    "the stored workspace record keys",
  );
  for (const intent of Object.values(stored.intents))
    for (const key of storedHostStateShape.intent)
      assert.ok(Object.hasOwn(intent, key), `the stored intent carries ${key}`);
  // The adapter parses and rewrites the stored record on its first pass, so a
  // retired record's shape is checked against the same captured key list.
  await host.beginHostPass([taskFact(only.taskId, "done") as Task]);
  await host.endHostPass();
  const retired = host.state.read().retiredAgents?.[only.id];
  assert.deepEqual(
    Object.keys(retired ?? {}).sort(),
    ["labels", "workspaceId"],
    "a retired record keeps the launch identity",
  );
  for (const key of Object.keys(retired ?? {}))
    assert.ok(
      storedHostStateShape.retiredAgent.includes(key),
      `the retired record uses only captured keys, not ${key}`,
    );
});

test("a pass over terminal tasks serves no T3 thread snapshot at all", async (t) => {
  // The stored file as it really is: every tracked thread belongs to a task that is
  // over, and T3 reports each archived. Before nucleus#1328 one pass served several
  // full snapshots per thread, on every sweep, forever.
  const terminal = Array.from({ length: 12 }, (_, index) => ({
    id: threadId(`done${index}`),
    taskId: `task-done-${index}`,
    runId: `run-done-${index}`,
    role: "revision" as const,
  }));
  const live = { id: threadId("live"), taskId: "task-live", runId: "run-live" };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [...terminal, live],
    seed: (fake) => {
      for (const thread of terminal)
        fake.threads.get(thread.id)!.thread.archivedAt = STAMP;
    },
  });
  const tasks = [
    ...terminal.map((thread) => taskFact(thread.taskId, "done")),
    taskFact(live.taskId, "working"),
  ] as Task[];
  const before = served();
  await host.beginHostPass(tasks);

  // Deciding what to observe is a thread-list read: no thread snapshot is served.
  assert.equal(served(), before, "opening the pass served no thread snapshot");
  const stored = host.state.read();
  assert.deepEqual(
    Object.keys(stored.agents),
    [live.id],
    "only the live task keeps an observed thread",
  );
  for (const thread of terminal) {
    assert.equal(
      stored.agents[thread.id],
      undefined,
      `${thread.id} is no longer observed`,
    );
    assert.equal(
      stored.retiredAgents?.[thread.id]?.labels[WIRE_LABEL_KEYS.task],
      thread.taskId,
      "its launch identity is kept",
    );
    assert.equal(
      stored.retiredAgents?.[thread.id]?.labels[WIRE_LABEL_KEYS.run],
      thread.runId,
    );
  }
  // The whole pass: titles, the row decision (which finds no parent row for a
  // finished task), the observation inventory and the reconciliation passes all run
  // against those finished threads and serve nothing.
  await host.reconcileThreadTitles(tasks);
  await host.reconcileTaskRow(terminal[3]!.taskId, { state: "waiting", cause: "Waiting" });
  await host.reconcileTaskRow(terminal[4]!.taskId, { state: "attention", cause: "Needs a person" });
  assert.deepEqual(
    [
      ...(await host.observationInventory(
        terminal.map((thread) => thread.id),
      ))!,
    ],
    [],
  );
  await host.reconcileTaskRow(terminal[5]!.taskId, { state: "active" });
  await host.endHostPass();
  assert.equal(
    served(),
    before,
    "a full pass over finished tasks served no thread snapshot",
  );
  for (const thread of terminal)
    assert.equal(
      snapshotsFor(thread.id, before),
      0,
      `${thread.id} was not snapshotted`,
    );
  assert.equal(
    server.commands.filter((command) => command.type === "thread.settle")
      .length,
    0,
    "no settle was sent",
  );
  assert.equal(
    host.reads.observes(live.id),
    true,
    "the live task thread is still observed",
  );
});

test("an unchanged thread is not snapshotted, and a changed live thread is snapshotted once per pass", async (t) => {
  const live = { id: threadId("live"), taskId: "task-live", runId: "run-live" };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [live],
    seed: (fake, directory) =>
      seed(fake, live.id, directory, (projection) => {
        projection.runs.push(
          syntheticRun(live.id, 1, {
            id: "native-run-1",
            status: "running",
            rootNodeId: "node-root-1",
          }),
        );
      }),
  });
  const tasks = [taskFact(live.taskId, "working")] as Task[];

  // One pass, five consumers, one snapshot: every reader shares the same answer.
  let before = served();
  await host.beginHostPass(tasks);
  await consume(host, live.id);
  assert.equal(
    snapshotsFor(live.id, before),
    1,
    "a changed live thread is snapshotted once, shared by every consumer",
  );
  await host.endHostPass();

  // A second pass with nothing changed reads only what the row cannot carry: the
  // thread's own row in T3's list is the change marker for its state, but a running
  // thread's window (tool output a stall check reads) can move under an unchanged
  // row, so its window is refreshed once per pass and shared (Spec 069 batch 5).
  before = served();
  await host.beginHostPass(tasks);
  await consume(host, live.id);
  assert.equal(
    snapshotsFor(live.id, before),
    1,
    "an unchanged running thread's window is refreshed once in the pass",
  );
  await host.endHostPass();

  // T3 reports the run finished: the row changed, so the next pass reads once.
  server.threads.get(live.id)!.runs[0]!.status = "completed";
  before = served();
  await host.beginHostPass(tasks);
  await consume(host, live.id);
  assert.equal(
    snapshotsFor(live.id, before),
    1,
    "a changed live thread is snapshotted once in the pass that sees it",
  );
  assert.equal(
    (await host.observe(live.id)).active,
    false,
    "the shared snapshot is the changed state",
  );
  await host.endHostPass();
});

test("a thread T3 reports archived leaves observation even while its task is live", async (t) => {
  const archived = {
    id: threadId("archived"),
    taskId: "task-live",
    runId: "run-archived",
    role: "reviewer" as const,
  };
  const { host, served } = await fixture(t, {
    threads: [archived],
    seed: (fake) => {
      fake.threads.get(archived.id)!.thread.archivedAt = STAMP;
    },
  });
  const tasks = [taskFact(archived.taskId, "working")] as Task[];
  const before = served();
  await host.beginHostPass(tasks);
  await host.endHostPass();
  assert.equal(served(), before, "an archived thread is not read");
  assert.equal(
    host.state.read().agents[archived.id],
    undefined,
    "an archived thread leaves the live map",
  );
  assert.ok(
    host.state.read().retiredAgents?.[archived.id],
    "and keeps its launch identity",
  );
});

test("a terminal task keeps its exact lookup after its agent records leave host state", async (t) => {
  const settledThread = {
    id: threadId("settled"),
    taskId: "task-done",
    runId: "run-settled",
    role: "revision" as const,
  };
  const awaiting = {
    id: threadId("awaiting"),
    taskId: "task-done",
    runId: "run-awaiting",
    role: "revision" as const,
  };
  const removed = {
    id: threadId("removed"),
    taskId: "task-done",
    runId: "run-removed",
    role: "recovery" as const,
  };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [settledThread, awaiting, removed],
    // A thread this host proved it removed, which is the other terminal fact.
    deleted: [removed.id],
  });
  const tasks = [taskFact("task-done", "done")] as Task[];
  await host.beginHostPass(tasks);
  const stored = host.state.read();
  assert.equal(stored.agents[settledThread.id], undefined);
  assert.equal(stored.agents[awaiting.id], undefined);
  assert.equal(
    stored.retiredAgents?.[settledThread.id]?.labels[WIRE_LABEL_KEYS.run],
    settledThread.runId,
  );

  const before = served();
  // An exact lookup answers from the launch identity alone: no snapshot.
  const found = await host.findAgents({
    [WIRE_LABEL_KEYS.task]: "task-done",
    [WIRE_LABEL_KEYS.run]: settledThread.runId,
  });
  assert.deepEqual(found, [
    {
      id: settledThread.id,
      workspaceId: stored.retiredAgents![settledThread.id]!.workspaceId,
      hostConfirmed: true,
    },
  ]);
  assert.equal(
    snapshotsFor(settledThread.id, before),
    0,
    "the exact lookup reads no T3 thread",
  );
  // A finished task's row decision finds no row: Nucleus never settles a thread, so
  // there is nothing to send and nothing to read (nucleus#1366).
  await host.reconcileTaskRow("task-done", { state: "finished" });
  assert.equal(
    server.commands.filter((command) => command.type === "thread.settle")
      .length,
    0,
    "no settle was sent",
  );
  assert.equal(
    served(),
    before,
    "no exact settle or lookup read a thread that left observation",
  );
  // The thread-list answer the terminal lane needs is still available for free.
  const observed = await host.observe(settledThread.id);
  assert.equal(observed.status, "idle");
  assert.deepEqual(
    observed.labels,
    stored.retiredAgents![settledThread.id]!.labels,
  );
  assert.equal(
    served(),
    before,
    "the terminal answer comes from the thread list",
  );
  // A proven removal is recorded on the retired identity rather than dropped: that
  // identity is what keeps a removed thread out of observation, and it is never
  // looked up as a thread that could still be attached.
  assert.ok(
    host.state.read().retiredAgents?.[removed.id],
    "a removed thread keeps its launch identity",
  );
  const afterRemoval = host.state.read().retiredAgents![removed.id]!;
  assert.equal(
    typeof afterRemoval.deletedAt,
    "string",
    "the removal is recorded on the kept identity",
  );
  assert.deepEqual(
    await host.findAgents({
      [WIRE_LABEL_KEYS.task]: "task-done",
      [WIRE_LABEL_KEYS.run]: removed.runId,
    }),
    [],
    "a removed thread is not an exact lookup answer",
  );
  assert.equal(served(), before, "and looking it up reads nothing");
  await host.endHostPass();
});

test("a live task still reads its own threads once for their step and row title", async (t) => {
  // The window must not cost a live task its presentation: a live support thread
  // that ended with a fault still names the row's step, from that pass's snapshot.
  const worker = {
    id: threadId("worker"),
    taskId: "task-live",
    runId: "run-worker",
  };
  const parent = {
    id: threadId("parent"),
    taskId: "task-live",
    runId: "run-parent",
  };
  const reviewer = {
    id: threadId("reviewer"),
    taskId: "task-live",
    runId: "run-reviewer",
    role: "reviewer" as const,
  };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [worker, parent, reviewer],
    parents: [
      {
        taskId: "task-live",
        threadId: parent.id,
        title: "Working*: synthetic",
      },
    ],
    seed: (fake, directory) => {
      seed(fake, reviewer.id, directory, (projection) => {
        projection.thread.title = "225 review: synthetic";
        projection.runs.push(
          syntheticRun(reviewer.id, 1, {
            id: "review-stage",
            status: "failed",
          }),
        );
      });
    },
  });
  const tasks = [taskFact("task-live", "working")] as Task[];
  const before = served();
  await host.beginHostPass(tasks);
  await host.reconcileTaskRow("task-live", {
    state: "waiting",
    cause: "Waiting on nucleus#1364",
  });
  await host.endHostPass();
  assert.equal(
    snapshotsFor(reviewer.id, before),
    1,
    "the reviewer thread is read once for its step",
  );
  assert.ok(
    host.state.read().agents[reviewer.id] !== undefined,
    "a live support thread stays observed",
  );
  const titles = server.commands
    .filter(
      (command) =>
        command.type === "thread.metadata.update" &&
        command.threadId === parent.id,
    )
    .map((command) => command.title);
  assert.ok(
    titles.some((title) => String(title).includes("blocked: reviewer")),
    "the row names the faulted reviewer",
  );
});

test("an explicit stop still stops a live run in a thread that left observation", async (t) => {
  // A control action is not a read of the thread this host stopped paying for: the
  // thread list's own activeRunId names the run, so the stop lands and serves no
  // snapshot (nucleus#1328 review).
  const stopped = {
    id: threadId("stopped"),
    taskId: "task-done",
    runId: "run-stopped",
    role: "revision" as const,
  };
  const idle = { id: threadId("idle"), taskId: "task-done", runId: "run-idle" };
  const { host, server, snapshotsFor, served } = await fixture(t, {
    threads: [stopped, idle],
    seed: (fake, directory) => {
      const projection = seed(fake, stopped.id, directory, (p) => {
        p.runs.push(
          syntheticRun(stopped.id, 1, {
            id: "live-native-run",
            status: "running",
            rootNodeId: "node-root",
          }),
        );
      });
      projection.thread.archivedAt = STAMP;
      fake.threads.get(idle.id)!.thread.archivedAt = STAMP;
    },
  });
  const tasks = [taskFact("task-done", "done")] as Task[];
  await host.beginHostPass(tasks);
  assert.equal(
    host.state.read().agents[stopped.id],
    undefined,
    "the thread left observation",
  );
  const before = served();
  // A live run on a thread this host no longer observes is still stopped, once.
  await host.stopAgentTurn(stopped.id);
  const stops = server.commands.filter(
    (command) => command.type === "thread.stop",
  );
  assert.deepEqual(
    stops.map((command) => command.threadId),
    [stopped.id],
    "the stop reached the live run",
  );
  // Nothing was read to decide it, and a thread with no live run sends nothing.
  await host.stopAgentTurn(idle.id);
  assert.equal(
    server.commands.filter((command) => command.type === "thread.stop").length,
    1,
    "nothing is stopped twice",
  );
  assert.equal(
    snapshotsFor(stopped.id, before),
    0,
    "the stop read no snapshot",
  );
  assert.equal(served(), before, "neither stop served a thread snapshot");
  await host.endHostPass();
});

test('an unreadable thread list never reads as "nothing to stop"', async (t) => {
  // A stop must not report success because it could not look: core records a sent
  // stop from a plain return, so an unreadable list is an error here, and nothing is
  // sent (nucleus#1328 review).
  const alive = {
    id: threadId("alive"),
    taskId: "task-cancelled",
    runId: "run-alive",
    role: "revision" as const,
  };
  const { host, server, served } = await fixture(t, {
    threads: [alive],
    seed: (fake, directory) => {
      const projection = seed(fake, alive.id, directory, (p) => {
        p.runs.push(
          syntheticRun(alive.id, 1, {
            id: "live-native-run",
            status: "running",
            rootNodeId: "node-root",
          }),
        );
      });
      projection.thread.archivedAt = STAMP;
    },
  });
  const tasks = [taskFact(alive.taskId, "cancelled")] as Task[];
  // The pass retires the thread, then the list becomes unreadable, as a transient
  // server fault leaves it.
  await host.beginHostPass(tasks);
  assert.equal(
    host.state.read().agents[alive.id],
    undefined,
    "the thread left observation",
  );
  const before = served();
  (
    host as unknown as { reads: { readShell: () => Promise<unknown> } }
  ).reads.readShell = async () => {
    throw new Error("synthetic shell read failure");
  };
  await assert.rejects(
    host.stopAgentTurn(alive.id),
    /synthetic shell read failure/,
    "a stop on an unreadable list is refused, never silently skipped",
  );
  assert.equal(
    server.commands.filter((command) => command.type === "thread.stop").length,
    0,
    "and nothing was sent",
  );
  await host.endHostPass();
  assert.equal(served(), before, "the refusal cost no thread snapshot");
});

test("a command sent in a pass drops the snapshot held for its thread", async (t) => {
  // A post-write read in the same pass must see the write, not the snapshot taken
  // before it (nucleus#1328 review).
  const thread = {
    id: threadId("written"),
    taskId: "task-live",
    runId: "run-written",
  };
  const { host, snapshotsFor, served } = await fixture(t, {
    threads: [thread],
  });
  await host.beginHostPass([taskFact(thread.taskId, "working") as Task]);
  const before = served();
  // Warm the held snapshot, then write through the ledger's own dispatch path.
  const warm = await host.readProjection(thread.id, "observation");
  assert.equal(warm.thread.settledOverride, null);
  await host.intents.effect(
    "synthetic-title-write",
    "orchestration.dispatchCommand",
    {
      type: "thread.metadata.update",
      commandId: "synthetic-title-write",
      threadId: thread.id,
      title: "Written in this pass",
    },
  );
  const after = await host.readProjection(thread.id, "observation");
  assert.equal(
    after.thread.title,
    "Written in this pass",
    "the read after the write is fresh",
  );
  assert.equal(
    snapshotsFor(thread.id, before),
    2,
    "the write invalidated the held snapshot exactly once",
  );
  await host.endHostPass();
});

test("a retired thread returns to observation when T3 stops reporting it archived", async (t) => {
  // Re-attaching is an ordinary fact, not a one-way move: the same launch identity
  // comes back, and an exact lookup names it once (nucleus#1328 review).
  const thread = {
    id: threadId("reattached"),
    taskId: "task-live",
    runId: "run-reattached",
    role: "reviewer" as const,
  };
  const { host, server } = await fixture(t, {
    threads: [thread],
    seed: (fake, directory) => {
      seed(fake, thread.id, directory);
      fake.threads.get(thread.id)!.thread.archivedAt = STAMP;
    },
  });
  const tasks = [taskFact(thread.taskId, "working")] as Task[];
  await host.beginHostPass(tasks);
  await host.endHostPass();
  assert.equal(
    host.state.read().agents[thread.id],
    undefined,
    "the archived thread is not observed",
  );
  assert.ok(
    host.state.read().retiredAgents?.[thread.id],
    "and its launch identity is kept",
  );
  // T3 no longer reports it archived: the next pass observes it again.
  server.threads.get(thread.id)!.thread.archivedAt = null;
  await host.beginHostPass(tasks);
  await host.endHostPass();
  assert.deepEqual(
    host.state.read().agents[thread.id]?.labels,
    host.state.read().retiredAgents?.[thread.id]?.labels ??
      host.state.read().agents[thread.id]?.labels,
    "the same launch identity is observed again",
  );
  assert.equal(
    host.state.read().retiredAgents?.[thread.id],
    undefined,
    "and the retired entry is gone",
  );
  const found = await host.findAgents({
    [WIRE_LABEL_KEYS.task]: thread.taskId,
    [WIRE_LABEL_KEYS.run]: thread.runId,
  });
  assert.deepEqual(
    found.map((entry) => entry.id),
    [thread.id],
    "an exact lookup names the thread once",
  );
});

test("a re-attached nested child keeps its parent link and row title", async (t) => {
  // The retired record is the whole row identity, not just labels: a nested child
  // whose thread comes back must still be its parent's child, or its own row surfaces
  // and breaks the one-row rule (nucleus#1305, nucleus#1328 review).
  const parentThread = threadId("parent");
  const child = {
    id: threadId("child"),
    taskId: "task-live",
    runId: "run-child",
    parentThreadId: parentThread,
    title: "Working*: synthetic",
  };
  const { host, server } = await fixture(t, {
    threads: [child],
    parents: [
      {
        taskId: child.taskId,
        threadId: parentThread,
        title: "Working*: synthetic",
      },
    ],
    seed: (fake, directory) => {
      seed(fake, child.id, directory);
      fake.threads.get(child.id)!.thread.archivedAt = STAMP;
    },
  });
  const tasks = [taskFact(child.taskId, "working")] as Task[];
  await host.beginHostPass(tasks);
  await host.endHostPass();
  const retired = host.state.read().retiredAgents?.[child.id];
  assert.equal(
    retired?.parentThreadId,
    parentThread,
    "the retired record keeps the parent link",
  );
  assert.equal(
    retired?.title,
    "Working*: synthetic",
    "and the task state title its row rides on",
  );
  // T3 no longer reports it archived: the thread comes back as the child it was.
  server.threads.get(child.id)!.thread.archivedAt = null;
  await host.beginHostPass(tasks);
  await host.endHostPass();
  const restored = host.state.read().agents[child.id];
  assert.equal(
    restored?.parentThreadId,
    parentThread,
    "the restored record keeps the parent link",
  );
  assert.equal(restored?.title, "Working*: synthetic", "and the title");
  assert.equal(
    host.state.read().retiredAgents?.[child.id],
    undefined,
    "the retired entry is gone",
  );
  assert.equal(
    host.nesting.taskOfChild(child.id),
    child.taskId,
    "the one-row rule still resolves the child",
  );
});
