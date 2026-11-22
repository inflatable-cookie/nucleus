import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { createAdapter } from "../hosts/t3code";
import { T3_THREAD_READ_CONCURRENCY } from "../hosts/t3code/reads";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";
import { Store } from "../core/store/store";
import { SweepMaintenance } from "../core/scheduling/sweep-maintenance";
import { submissionSchema, type Task } from "../shared/contracts";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import {
  STAMP,
  syntheticRuntimeRequest,
  syntheticTurnItem,
  t3Fake,
  threadProjection,
} from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";
import {
  storedHostState,
  taskFact,
  type StoredThread,
} from "./support/t3code-state";

/**
 * Spec 069 batch 5: the load Nucleus puts on a T3 host.
 *
 * Every count is taken on the serving side, from the fake's own request log: the
 * same facts T3's server trace carries for `orchestration.subscribeThread`,
 * `orchestration.subscribeShell` and `orchestration.getArchivedShellSnapshot`.
 */

type Fake = Awaited<ReturnType<typeof t3Fake>>;

const LIVE = 40;
const threadId = (index: number) => `nucleus-thread-load${index}`;
const taskId = (index: number) => `task-load-${index}`;

async function fixture(
  t: TestContext,
  input: { live?: number; finished?: number; followUps?: string[] } = {},
) {
  const live = input.live ?? LIVE;
  const finished = input.finished ?? 0;
  const root = mkdtempSync(join(tmpdir(), "t3code-load-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const threads: StoredThread[] = Array.from(
    { length: live + finished },
    (_, index) => ({
      id: threadId(index),
      taskId: taskId(index),
      runId: `run-load-${index}`,
    }),
  );
  const state = storedHostState({ directory, threads });
  const workspaceId = Object.keys(state.workspaces)[0]!;
  const followUps = Object.fromEntries(
    (input.followUps ?? []).map((id) => [
      id,
      {
        workspaceId,
        labels: storedT3Labels("worker", {
          taskId: taskId(0),
          runId: "follow-up-run",
        }),
        parentThreadId: threadId(0),
      },
    ]),
  );
  const statePath = join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      Object.keys(followUps).length ? { ...state, followUps } : state,
    ),
    { mode: 0o600 },
  );
  for (const [index, thread] of threads.entries()) {
    const projection = threadProjection(thread.id, directory);
    // A finished task's threads are archived, as closeout leaves them.
    if (index >= live) projection.thread.archivedAt = STAMP;
    server.threads.set(thread.id, projection);
  }
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 5_000,
    probeThreadId: threadId(0),
  });
  t.after(() => host.close());
  await host.connect();
  const tasks = threads.map((thread, index) =>
    taskFact(thread.taskId, index < live ? "working" : "done"),
  ) as Task[];
  const liveIds = threads.slice(0, live).map((thread) => thread.id);
  return { server, host, tasks, liveIds, directory };
}

/** Requests of one method the fake has served, from `from`. */
const served = (server: Fake, method: string, from = 0) =>
  server.requests.slice(from).filter((request) => request.tag === method)
    .length;
const counts = (server: Fake, from = 0) => ({
  subscribeThread: served(server, "orchestration.subscribeThread", from),
  subscribeShell: served(server, "orchestration.subscribeShell", from),
  archived: served(server, "orchestration.getArchivedShellSnapshot", from),
  total: server.requests.length - from,
});

/**
 * One host pass as the sweep runs it for live work: the pass opens, observation is
 * reconciled, each live thread is read for its state, its pending questions and its
 * timeline, and the board's live lists are read.
 */
async function pass(host: T3CodeHost, tasks: Task[], ids: readonly string[]) {
  await host.beginHostPass(tasks);
  await host.observationInventory(ids);
  for (const id of ids) {
    await host.observe(id);
    await host.pendingQuestions(id);
    await host.agentTimelinePage(id);
  }
  await host.listLiveAgents();
  await host.activeThreads();
  await host.findAgents({ [WIRE_LABEL_KEYS.task]: tasks[0]!.id });
  host.endHostPass();
}

test("steady state: passes over 40 idle threads read no thread snapshot, no shell and no archive after the first read", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t, { finished: 20 });
  const start = server.requests.length;
  await pass(host, tasks, liveIds);
  const first = counts(server, start);
  const steady = server.requests.length;
  const PASSES = 10;
  for (let index = 0; index < PASSES; index++)
    await pass(host, tasks, liveIds);
  const after = counts(server, steady);
  t.diagnostic(
    `first pass ${JSON.stringify(first)}; ${PASSES} steady passes ${JSON.stringify(after)}`,
  );
  assert.ok(first.subscribeThread <= LIVE, "each live thread is read at most once");
  assert.equal(after.subscribeThread, 0, "an idle unchanged thread is never re-read");
  assert.equal(after.subscribeShell, 0, "the held shell subscription answers");
  assert.equal(after.archived, 0, "finished tasks cost no archived read");
  assert.equal(after.total, 0, "a steady pass sends T3 nothing at all");
});

test("a thread whose row changes is read once, in the pass that sees the change", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t);
  await pass(host, tasks, liveIds);
  const target = liveIds[7]!;
  server.threads.get(target)!.thread.updatedAt = "2026-01-02T00:00:00.000Z";
  const before = server.snapshots.length;
  await pass(host, tasks, liveIds);
  const reads = server.snapshots.slice(before);
  assert.deepEqual(
    reads.map((read) => read.threadId),
    [target],
    "only the changed thread is read, once",
  );
  const again = server.snapshots.length;
  await pass(host, tasks, liveIds);
  assert.equal(server.snapshots.length, again, "and not again once read");
});

test("a derived notice thread T3 never created costs no RPC, and a revision run reads its retained agent thread", async (t) => {
  // A message sent to a live child records the follow-up child T3 might start
  // under the message's own id: a reminder, and a revision run's prompt to the
  // retained reviewer (`ns-run-<runId>`), whose real thread is the retained one.
  const reminder = "thread:delegated-task:ns-reminder-load";
  const revision = "thread:delegated-task:ns-run-revision-load";
  const { server, host, tasks, liveIds } = await fixture(t, {
    followUps: [reminder, revision],
  });
  const start = server.requests.length;
  for (let index = 0; index < 3; index++) await pass(host, tasks, liveIds);
  const asked = server.requests
    .slice(start)
    .filter((request) => request.tag === "orchestration.subscribeThread")
    .map((request) => (request.payload as { threadId: string }).threadId);
  assert.equal(asked.includes(reminder), false, "the reminder is never read");
  assert.equal(asked.includes(revision), false, "the revision id is never read");
  assert.ok(
    host.state.read().followUps?.[revision],
    "an unseen follow-up stays a candidate while its task runs",
  );
  // The revision run's agent is the retained thread, read from the live shell.
  const retained = await host.observe(liveIds[0]!);
  assert.equal(retained.id, liveIds[0]);
  assert.equal(
    host.reads.live.row(revision),
    undefined,
    "T3's own shell never listed the derived id",
  );
});

test("the pending-question scan reads only the threads T3 marks as awaiting input", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t);
  await pass(host, tasks, liveIds);
  const asking = liveIds[3]!;
  const projection = server.threads.get(asking)!;
  projection.turnItems = [
    syntheticTurnItem(asking, 1, {
      type: "user_input_request",
      id: "question-load-item",
      nodeId: "question-load-node",
      requestId: "question-load",
      runId: "run-question-load",
      questions: [
        {
          id: "question-load-choice",
          header: "Question 1",
          question: "Which way?",
          options: [{ label: "Left" }],
        },
      ],
    }),
  ];
  projection.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "question-load",
      kind: "user_input",
      status: "pending",
    }),
  ];
  // Let the earlier pass's held snapshots stand: only the scan runs here.
  await host.reads.shell();
  const before = server.snapshots.length;
  host.reads.beginPass(tasks);
  for (const id of liveIds) await host.pendingQuestions(id);
  host.reads.endPass();
  assert.deepEqual(
    server.snapshots.slice(before).map((read) => read.threadId),
    [asking],
    "one read, of the flagged thread",
  );
});

test("thread snapshot reads to one host are capped, and the connection keeps its heartbeat", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t);
  server.controls.slowSnapshotMs = 30;
  host.reads.beginPass(tasks);
  await Promise.all(liveIds.map((id) => host.observe(id)));
  host.reads.endPass();
  server.controls.slowSnapshotMs = 0;
  assert.ok(server.threadReads.max > 0);
  assert.ok(
    server.threadReads.max <= T3_THREAD_READ_CONCURRENCY,
    `at most ${T3_THREAD_READ_CONCURRENCY} reads at once (saw ${server.threadReads.max})`,
  );
  assert.equal(host.connected, true);
  assert.deepEqual(host.reads.threadReadLoad(), { inFlight: 0, waiting: 0 });
});

test("live lists, held observations and the catalog answer promptly while T3 is wedged", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t);
  await pass(host, tasks, liveIds);
  const catalog = await host.catalog();
  server.controls.stalledMethods = [
    "server.getConfig",
    "orchestration.subscribeThread",
    "orchestration.subscribeShell",
    "orchestration.getArchivedShellSnapshot",
  ];
  let started = Date.now();
  assert.ok((await host.listLiveAgents()).length >= LIVE);
  assert.ok((await host.activeThreads()).length >= LIVE);
  assert.ok(host.projectObservation()?.length);
  assert.equal((await host.observe(liveIds[0]!)).id, liveIds[0]);
  assert.ok(Date.now() - started < 500, "live lists and held state answer at once");
  started = Date.now();
  assert.deepEqual(
    await host.catalog(),
    catalog,
    "the catalog answers from the last read while T3 is slow",
  );
  assert.ok(Date.now() - started < 3_000, "within the catalog's prompt bound");
  server.controls.stalledMethods = [];
});

test("a reconnect re-snapshots the shell exactly once", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t);
  await pass(host, tasks, liveIds);
  const before = served(server, "orchestration.subscribeShell");
  server.dropSockets();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.connect();
  for (let index = 0; index < 3; index++) await pass(host, tasks, liveIds);
  assert.equal(
    served(server, "orchestration.subscribeShell") - before,
    1,
    "one snapshot for the new connection, then the live tail",
  );
});

test("retention reads T3's archived threads only on its own interval, and deletes old threads by id", async (t) => {
  // Tom, 2026-11-22: "Pruning can read archived threads - it needs to know what's
  // there, but that shouldn't be running regularly? Once or twice a day?"
  const { server, host, tasks, liveIds } = await fixture(t, { finished: 4 });
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.setMeta("paused", false);
  const finished = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Finished task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    host.hostId,
    "handoff",
    "a".repeat(40),
  );
  store.update(finished.id, { phase: "done" });
  // The finished task's archived threads carry its labels, as closeout left them.
  host.state.update((state) => {
    for (let index = LIVE; index < LIVE + 4; index++)
      state.agents[threadId(index)]!.labels = storedT3Labels("worker", {
        taskId: finished.id,
        runId: `run-load-${index}`,
      });
  });
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  const maintenance = new SweepMaintenance({
    adapter,
    hostAvailable: () => true,
    hostIds: () => [host.hostId],
    migrateProjectOwnersToPlanners: async () => {},
    removeSiblings: async () => {},
    stopped: false,
    store,
    withHost: (_hostId: string, work: () => unknown) => work(),
  } as unknown as ConstructorParameters<typeof SweepMaintenance>[0]);
  const HOUR = 3_600_000;
  const NOON = Date.parse("2026-11-22T12:00:00.000Z");
  const archived = () =>
    served(server, "orchestration.getArchivedShellSnapshot");
  const before = archived();
  // A day of hourly maintenance ticks, with host passes between them.
  for (let hour = 0; hour < 24; hour++) {
    await maintenance.run(NOON + hour * HOUR);
    await maintenance.threadRetentionRun;
    await pass(host, tasks, liveIds);
  }
  assert.equal(
    archived() - before,
    2,
    "the archived walk ran twice in a day (12-hour default), and nowhere else",
  );
  const deletes = server.commands
    .filter((command) => command.type === "thread.delete")
    .map((command) => command.threadId);
  for (let index = LIVE; index < LIVE + 4; index++)
    assert.ok(
      deletes.includes(threadId(index)),
      "an old archived thread of a finished task is deleted by its id",
    );
  assert.equal(
    deletes.filter((id) => liveIds.includes(id)).length,
    0,
    "no live task's thread is touched",
  );
  const health = store.getMeta<{
    hosts: { deleted: number; error: string }[];
  }>("threadRetention");
  assert.equal(health?.hosts[0]?.error, "");
  assert.equal(health?.hosts[0]?.deleted, 0, "the second walk finds nothing left");
});
