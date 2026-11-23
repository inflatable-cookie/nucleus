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
import { T3RpcClient, T3RpcError } from "../hosts/t3code/rpc";
import { T3CompatibilityError } from "../hosts/t3code/contracts";
import { T3ShellBackoffError } from "../hosts/t3code/live-shell";
import { HostReadRefusalError } from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import type { HostPolicyConstructor } from "../core/host";
import type { HostProcessFact } from "../core/host/types";
import { Engine } from "../core/engine";
import { runInTaskQuantumScope } from "../core/scheduling/pass-snapshot";
import { Store } from "../core/store/store";
import { SweepMaintenance } from "../core/scheduling/sweep-maintenance";
import { OPERATOR_BOARD_CALLER, runSchema, submissionSchema, type Task } from "../shared/contracts";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import {
  STAMP,
  syntheticProviderThread,
  syntheticRun,
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
  input: {
    live?: number;
    finished?: number;
    followUps?: string[];
    timeoutMs?: number;
  } = {},
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
    timeoutMs: input.timeoutMs ?? 5_000,
    probeThreadId: threadId(0),
  });
  t.after(() => host.close());
  await host.connect();
  const tasks = threads.map((thread, index) =>
    taskFact(thread.taskId, index < live ? "working" : "done"),
  ) as Task[];
  const liveIds = threads.slice(0, live).map((thread) => thread.id);
  return { server, host, tasks, liveIds, directory, workspaceId };
}

test("a missing pass timeline uses the exact T3 thread and the owned-process scan", async (t) => {
  const { host, server, directory, liveIds, workspaceId } = await fixture(t, {
    live: 1,
  });
  const agentId = liveIds[0]!;
  const thread = server.threads.get(agentId)!;
  const hostId = host.hostId;
  const runId = "run-load-0";
  const temporaryDirectory = join(directory, "run-scratch");
  server.controls.shellStatuses[agentId] = "completed";
  thread.runs = [syntheticRun(agentId, 1, { id: runId, status: "completed" })];
  thread.pendingBackgroundTasks = [];
  host.state.update((state) => {
    delete state.workspaces[workspaceId]!.archivedAt;
  });

  const store = new Store(":memory:");
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  let processes: HostProcessFact[] = [];
  adapter.hostProcessListing = async () => Object.assign(processes, { cwdComplete: true });
  const engine = new Engine(store, adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const head = "a".repeat(40);
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "completed-without-timeline",
      title: "Merge lease for a completed worker",
      repoPath: directory,
      planningCommit: head,
      handoffPath: "handoff.md",
      originAgentId: "synthetic-planner",
    }),
    hostId,
    "handoff.md",
    head,
  );
  const task = store.update(inserted.id, {
    phase: "merging",
    agentId,
    workspaceId,
    directory,
    runId,
    temporaryDirectory,
  });
  store.putRun(
    runSchema.parse({
      id: runId,
      taskId: task.id,
      hostId,
      agentId,
      workspaceId,
      temporaryDirectory,
      role: "revision",
      generation: 1,
      head,
      base: head,
      profile: null,
      status: "finished",
      released: true,
      createdAt: STAMP,
      lastObservedAt: STAMP,
      idleSince: STAMP,
      active: false,
      completion: null,
    }),
  );
  const resolution = engine.resolution;
  const beforeScan = await host.observe(agentId);
  const inPassWithoutTimeline = async <T>(work: () => Promise<T>) => {
    const snapshot = resolution.beginPassSnapshot();
    try {
      resolution.recordPassHostObservation(hostId, agentId, beforeScan);
      await resolution.primePassProcesses(hostId);
      resolution.sealPassHost(hostId);
      const requestsBefore = server.requests.length;
      const result = await runInTaskQuantumScope(5_000, work, snapshot);
      assert.equal(
        server.requests.slice(requestsBefore).filter((request) =>
          request.tag === "orchestration.subscribeThread" &&
          request.payload.acceptBoundedSnapshot === false,
        ).length,
        1,
        "one exact read replaces the missing timeline page",
      );
      return result;
    } finally {
      resolution.endPassSnapshot(snapshot);
    }
  };
  const lease = () =>
    inPassWithoutTimeline(() => resolution.executionLease(store.task(task.id)));

  assert.equal(await lease(), true, "merge acquires custody without a timeline page");

  const fact = {
    pid: 42,
    ppid: 1,
    pgid: 42,
    uid: process.getuid?.() ?? 501,
    startIdentity: "synthetic-start",
    command: "synthetic-detached-command",
  };
  for (const cwd of [directory, temporaryDirectory]) {
    processes = [{ ...fact, cwd }];
    assert.equal(await lease(), false);
    assert.match(store.task(task.id).reason, /process 42 remains/);
  }
  processes = [{ ...fact, state: "Z", cwd: null, openFiles: { paths: [], complete: false } }];
  assert.equal(await lease(), true, "a zombie cannot hold custody");
  processes = [];
  thread.runtimeRequests = [syntheticRuntimeRequest({ kind: "approval" })];
  assert.equal(await lease(), false);
  thread.runtimeRequests = [];
  delete server.controls.shellStatuses[agentId];
  thread.runs = [syntheticRun(agentId, 1, { id: runId, status: "running" })];
  assert.equal(await lease(), false);
  server.controls.shellStatuses[agentId] = "completed";
  thread.runs = [syntheticRun(agentId, 1, { id: runId, status: "completed" })];
  thread.thread.activeProviderThreadId = "current-provider";
  thread.providerThreads = [
    syntheticProviderThread({ id: "current-provider", status: "active" }),
    syntheticProviderThread({
      id: "previous-provider",
      status: "idle",
      pendingBackgroundTasks: [{ kind: "command", taskId: "running-command" }],
    }),
  ];
  assert.equal(await lease(), false);
  assert.match(store.task(task.id).reason, /running-command/);
  thread.providerThreads = [];

  thread.turnItems = [
    syntheticTurnItem(agentId, 1, {
      type: "command_execution",
      runId,
      status: "running",
    }),
  ];
  assert.equal(await lease(), false);
  assert.match(store.task(task.id).reason, /command synthetic-item-1/);
  thread.turnItems[0].status = "completed";
  thread.thread.pullRequests = [
    { host: "github.com", repository: "example/repo", number: 12, source: "agent", watch: {} },
  ];
  assert.equal(await lease(), false);
  assert.match(store.task(task.id).reason, /pull-request-watch:github.com\/example\/repo#12/);
  thread.thread.pullRequests = [];
  assert.equal(await lease(), true);

  thread.thread.updatedAt = new Date(Date.parse(STAMP) + 1_000).toISOString();
  thread.updatedAt = thread.thread.updatedAt;
  assert.equal(await lease(), false);
  assert.match(store.task(task.id).reason, /does not cover the participant's latest inactivity/);

  server.threads.delete(agentId);
  assert.equal(await lease(), false);
});

test("owner complete waits for a finished T3 participant's background work and process custody", async (t) => {
  const { host, server, liveIds, workspaceId, directory } = await fixture(t, { live: 1 });
  const agentId = liveIds[0]!;
  const runId = "run-complete";
  const temporaryDirectory = await realpath(mkdtempSync(join(tmpdir(), "t3code-complete-scratch-")));
  const thread = server.threads.get(agentId)!;
  thread.runs = [syntheticRun(agentId, 1, { id: runId, status: "completed" })];
  server.controls.shellStatuses[agentId] = "completed";
  thread.turnItems = [syntheticTurnItem(agentId, 1, {
    type: "command_execution", runId, status: "running",
  })];
  host.state.update((state) => {
    delete state.workspaces[workspaceId]!.archivedAt;
  });

  const store = new Store(":memory:");
  const adapter = createAdapter(HostPolicies as unknown as HostPolicyConstructor, host);
  adapter.findAnyOpenBranchPr = async () => [];
  let processes: HostProcessFact[] = [];
  adapter.hostProcessListing = async () => Object.assign(processes, { cwdComplete: true });
  const engine = new Engine(store, adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const head = "a".repeat(40);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: "owner-complete-custody",
    title: "Complete a report after background work",
    repoPath: directory,
    planningCommit: head,
    handoffPath: "handoff.md",
    originAgentId: "synthetic-planner",
  }), host.hostId, "handoff.md", head);
  const task = store.update(inserted.id, {
    phase: "working", agentId, workspaceId, directory, runId, temporaryDirectory,
  });
  store.putRun(runSchema.parse({
    id: runId, taskId: task.id, hostId: host.hostId, agentId, workspaceId,
    temporaryDirectory, role: "revision", generation: 1, head, base: head,
    status: "running", released: false, createdAt: STAMP, profile: null,
    lastObservedAt: STAMP, active: false, idleSince: STAMP, completion: null,
  }));
  store.setCredential(runId, "synthetic-complete-secret");
  const complete = () => engine.performTaskControl({
    taskId: task.id,
    version: store.task(task.id).version,
    action: "complete",
    reason: "Accept the finished report",
    caller: OPERATOR_BOARD_CALLER,
  });
  const refuses = async (reason: RegExp) => {
    await assert.rejects(complete, reason);
    assert.equal(store.task(task.id).phase, "working");
    assert.equal(store.run(runId)?.released, false);
    assert.doesNotThrow(() => store.authenticate(runId, "synthetic-complete-secret"));
  };
  assert.equal((await host.observe(agentId)).status, "idle");
  await refuses(/outstanding background work: command synthetic-item-1/);
  thread.turnItems[0].status = "completed";
  server.controls.threadCoverage = { hasMoreHistory: true, historyCursor: "older-items" };
  await refuses(/incomplete projection/);
  server.controls.threadCoverage = {};

  const serviceUid = process.getuid?.() ?? 501;
  const fact = {
    pid: 42, ppid: 1, pgid: 42, uid: serviceUid,
    startIdentity: "synthetic-start",
    command: "synthetic-detached-command",
    cwd: "/",
  };
  for (const root of [directory, temporaryDirectory]) {
    processes = [{
      ...fact, openFiles: { paths: [join(root, "output.log")], complete: true },
    }];
    await refuses(/process 42 still has an open file/);
  }
  processes = [{ ...fact, openFiles: { paths: [], complete: false } }];
  await refuses(/incomplete working-directory or open-file coverage/);
  processes = [{ ...fact, cwd: null }];
  await refuses(/incomplete working-directory or open-file coverage/);

  processes = [{
    ...fact, uid: serviceUid === 0 ? 501 : 0,
    cwd: null, openFiles: { paths: [], complete: false },
  }];
  assert.equal((await complete()).phase, "done");
  assert.equal(store.run(runId)?.released, true);
  assert.throws(() => store.authenticate(runId, "synthetic-complete-secret"), /unauthorized callback/i);
});

for (const provider of ["codex", "pi"]) {
  test(`an unlisted ${provider} thread is observed again after its turn ends`, async (t) => {
    const { host, server, liveIds, tasks, workspaceId } = await fixture(t, { live: 2 });
    const id = liveIds[1]!;
    const thread = server.threads.get(id)!;
    const ordinal = provider === "pi" ? 3 : 1;
    const turnId = `run:thread:${id}:ordinal:${ordinal}`;
    thread.thread.providerInstanceId = provider;
    thread.thread.modelSelection.instanceId = provider;
    thread.runs = [syntheticRun(id, ordinal, {
      id: turnId,
      status: "running",
      completedAt: null,
    })];
    if (provider === "pi") {
      thread.runs.unshift(syntheticRun(id, 1), syntheticRun(id, 2));
      thread.providerThreads = [syntheticProviderThread({
        driver: provider,
        providerInstanceId: provider,
        nativeThreadRef: { nativeId: `native-thread:pending:run:thread:${id}:ordinal:1` },
        status: "idle",
      })];
    }
    server.controls.shellUnlisted = [id];
    assert.equal(await host.reads.shellRow(id), undefined);
    assert.equal((await host.observe(id)).activeTurnId, turnId);

    Object.assign(thread.runs.at(-1), { status: "completed", completedAt: STAMP });
    host.reads.beginPass(tasks);
    t.after(() => host.reads.endPass());
    const observed = await host.observe(id);
    assert.equal(observed.workspaceId, workspaceId);
    assert.equal(observed.status, "idle");
    assert.equal(observed.active, false);
    assert.equal(observed.activeTurnId, null);
    assert.equal(observed.permissions, false);

    const exact = await host.observeParticipant(id);
    assert.deepEqual(exact, {
      id, workspaceId, status: "idle", active: false, permissions: false,
      activeTurnId: null, updatedAt: STAMP, pendingBackgroundTasks: [],
    });
  });
}

test("a lagging shell row cannot keep a turn active after its projection records completion", async (t) => {
  const { host, server, liveIds } = await fixture(t, { live: 1 });
  const id = liveIds[0]!;
  const thread = server.threads.get(id)!;
  thread.runs = [syntheticRun(id, 1, { status: "running", completedAt: null })];
  const running = await host.reads.shellRow(id);
  assert.equal(running?.activeRunId, thread.runs[0].id);
  t.mock.method(host.reads.live, "row", () => running);

  Object.assign(thread.runs[0], { status: "completed", completedAt: STAMP });
  const observed = await host.observe(id);
  assert.equal(observed.active, false);
  assert.equal(observed.activeTurnId, null);
  assert.equal(observed.status, "idle");
});

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

test("a running thread is re-read once per pass when its projection moves under an unchanged row", async (t) => {
  const { server, host, tasks, liveIds } = await fixture(t);
  const running = liveIds[2]!;
  server.threads.get(running)!.runs = [
    syntheticRun(running, 1, {
      id: "run-busy",
      status: "running",
      rootNodeId: "node-busy",
    }),
  ];
  await pass(host, tasks, liveIds);
  // The provider reports new background work: the projection moves, the shell row
  // of a running thread does not (T3 lists background tasks only on idle rows).
  server.threads.get(running)!.providerThreads = [
    syntheticProviderThread({
      id: "provider-busy",
      status: "active",
      pendingBackgroundTasks: [{ kind: "command", taskId: "busy-command" }],
    }),
  ];
  const rowBefore = JSON.stringify(host.reads.live.row(running));
  await host.reads.shell();
  assert.equal(
    JSON.stringify(host.reads.live.row(running)),
    rowBefore,
    "the shell row did not move",
  );
  const before = server.snapshots.length;
  await pass(host, tasks, liveIds);
  assert.deepEqual(
    server.snapshots.slice(before).map((read) => read.threadId),
    [running],
    "the running thread is read once, and no idle thread is read",
  );
  assert.deepEqual(
    (await host.agentTimelinePage(running))?.pendingBackgroundTasks,
    ["command busy-command"],
    "the pass saw the moved projection",
  );
  const again = server.snapshots.length;
  host.reads.beginPass(tasks);
  await host.observe(running);
  await host.observe(running);
  host.reads.endPass();
  assert.equal(server.snapshots.length - again, 1, "once per pass, not per read");
});

test("a live shell whose tail has gone quiet past its bound is re-snapshotted, and the live-agent list is served the last copy meanwhile", async (t) => {
  const { server, host, liveIds } = await fixture(t);
  await host.reads.shell();
  const before = served(server, "orchestration.subscribeShell");
  host.reads.live.quietBoundMs = 20;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(host.reads.live.live, false, "past the bound the copy is stale");
  await host.reads.shell();
  assert.equal(
    served(server, "orchestration.subscribeShell") - before,
    1,
    "a decision read takes one fresh snapshot",
  );
  // T3 stops answering: the picker still lists from the last copy, at once.
  server.controls.stalledMethods = ["orchestration.subscribeShell"];
  await new Promise((resolve) => setTimeout(resolve, 60));
  const started = Date.now();
  const listed = await host.listLiveAgents();
  assert.ok(Date.now() - started < 500);
  assert.ok(listed.some((agent) => agent.id === liveIds[0]));
  server.controls.stalledMethods = [];
});

test("a creation lookup never answers a thread the live shell lists as absent", async (t) => {
  const { server, host, liveIds } = await fixture(t);
  const target = liveIds[5]!;
  await host.reads.shell();
  // T3's projection store answers not-found while its shell lists the thread.
  server.controls.projectionMissing = [target];
  const found = await host.findRunAgents({
    [WIRE_LABEL_KEYS.task]: taskId(5),
    [WIRE_LABEL_KEYS.run]: "run-load-5",
  });
  assert.deepEqual(
    found.map((agent) => [agent.id, agent.hostConfirmed]),
    [[target, true]],
  );
  server.controls.projectionMissing = [];
});

test("a shell snapshot slower than its deadline is a timeout, never an incompatibility, and reopens back off", async (t) => {
  // The live shell's opening snapshot has the 60 s deadline thread snapshots have.
  assert.equal(
    new T3RpcClient({
      endpoint: "http://127.0.0.1:1",
      bearer: "synthetic-bearer",
    }).deadlineFor("orchestration.subscribeShell"),
    60_000,
  );
  // A host configured with a short deadline stands in for a snapshot past 60 s.
  const { server, host, liveIds, tasks } = await fixture(t, {
    live: 4,
    timeoutMs: 300,
  });
  host.reads.live.close();
  server.controls.slowShellMs = 600;
  await assert.rejects(host.reads.shell(), (error: unknown) => {
    assert.ok(!(error instanceof T3CompatibilityError), "not an incompatibility");
    return (
      error instanceof T3RpcError &&
      error.code === "timeout" &&
      error.method === "orchestration.subscribeShell"
    );
  });
  assert.equal(host.reads.compatibilityFailure, "", "nothing is reported to the operator");
  assert.equal(host.connected, true, "the connection stays up");
  // A decision read during the backoff is a bounded refusal, not another open.
  const opens = served(server, "orchestration.subscribeShell");
  await assert.rejects(
    host.reads.isObserved(liveIds[0]!),
    (error: unknown) =>
      error instanceof T3ShellBackoffError &&
      error instanceof HostReadRefusalError,
  );
  assert.equal(served(server, "orchestration.subscribeShell"), opens);
  // Once T3 answers in time and the backoff has run out, the shell reopens once.
  server.controls.slowShellMs = 0;
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  host.reads.beginPass(tasks);
  assert.equal(await host.reads.isObserved(liveIds[0]!), true);
  host.reads.endPass();
  assert.equal(served(server, "orchestration.subscribeShell"), opens + 1);
});

test("a settled delete receipt confirms the removal before T3's shell streams it", async (t) => {
  const { host, liveIds } = await fixture(t, { live: 4 });
  const target = liveIds[1]!;
  await host.reads.shell();
  assert.ok(host.reads.live.row(target), "listed before the removal");
  await host.deleteAgent(target);
  assert.equal(await host.reads.threadArchiveState(target), null);
});
