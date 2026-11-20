import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { createAdapter } from "../hosts/t3code";
import { T3RpcError } from "../hosts/t3code/rpc";
import { HostPolicies } from "../core/host/host-policies";
import { enginePorts } from "../core/port-context";
import { HostPass } from "../core/scheduling/host-pass";
import type { HostPolicyConstructor } from "../core/host";
import { taskWorkspaceTitle } from "../core/workspaces/workspace-title";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import {
  SNOOZE_HORIZON_MS,
  SNOOZE_RENEW_BEFORE_MS,
} from "../hosts/t3code/presentation";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submission } from "./support/fakes";
import type { AcpSessionSurface } from "../shared/acp/surface";
import type { HostAgentSpec } from "../shared/host";
import type { Profile, Task } from "../shared/contracts";
import { runSchema } from "../shared/contracts";
import type { TaskAttention } from "../shared/task-attention";
import { taskStopRecord } from "../shared/task-stop";
import { runHoldsSlot, taskHasUnreleasedRun } from "../shared/task-view";
import { taskRowAttention } from "../core/workspaces/task-row-attention";
import {
  t3Fake,
  STAMP,
  syntheticRun,
  syntheticRuntimeRequest,
} from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";

/**
 * A task's one row on T3 (Tom, 2026-11-15; nucleus#1366): the parent thread is the
 * row, it names the step its role children are doing, and it is snoozed — never
 * settled — while the task waits on nothing Nucleus runs and needs no one. Every
 * record here is a synthetic Nightly shape served by the fake transport; no live T3
 * is touched.
 */

const profile: Profile = {
  id: "synthetic-profile",
  name: "Synthetic",
  provider: "synthetic-provider",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};
const taskId = "synthetic-task";

const nucleusProvider = {
  instanceId: PARENT_PROVIDER,
  displayName: "Nucleus",
  driver: "acpRegistry",
  enabled: true,
  status: "ready",
  models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
};

/** The ACP surface: the parent's held turn ends when the service releases it. */
function acpStub(server: Awaited<ReturnType<typeof t3Fake>>) {
  const released: string[] = [];
  const surface: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/sessions/${input.taskId}.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release(sessionId) {
      released.push(sessionId);
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs)
          if (
            ["preparing", "starting", "running", "waiting"].includes(run.status)
          )
            run.status = "completed";
      }
    },
  };
  return { surface, released };
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3code-one-row-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = [
    nucleusProvider,
    {
      instanceId: "synthetic-provider",
      displayName: "Synthetic provider",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic model" }],
    },
  ];
  const acp = acpStub(server);
  let paused = false;
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 2_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 300,
    paused: () => paused,
  });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const spec = (requestId: string, role = "worker"): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: role === "worker" ? "Synthetic role" : `${role}: Synthetic role`,
    taskNumber: 225,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt: role === "worker" ? "Worker prompt" : `${role} prompt`,
      labels: storedT3Labels(role, { taskId, runId: `${requestId}-run` }),
      environment: {},
    }),
  });
  /** The task record core hands the adapter with the shared title helper's answer. */
  const task = (overrides: Partial<Task> = {}): Task =>
    ({
      id: taskId,
      number: 225,
      title: "Synthetic role",
      held: false,
      hostId: host.hostId,
      workspaceId: workspace.id,
      phase: "awaiting_review",
      ...overrides,
    }) as Task;
  const parentOf = () => Object.values(host.state.read().parents ?? {})[0];
  return {
    root,
    directory,
    server,
    host,
    workspace,
    spec,
    task,
    acp,
    parentOf,
    setPaused(value: boolean) {
      paused = value;
    },
  };
}

/** One recorded command by dispatch type, or by method for a launch (which carries no `type`). */
const commandsOf = (server: Awaited<ReturnType<typeof t3Fake>>, type: string) =>
  server.commands.filter(
    (command) => (command.type ?? command.method) === type,
  );
const waiting = (cause = "Waiting on nucleus#1364"): TaskAttention => ({
  state: "waiting",
  cause,
});

test("the inbox counts each active task once and excludes waiting, snoozed and finished tasks", async (t) => {
  const { acp, directory, host, parentOf, server, spec, setPaused } =
    await fixture(t);
  const inboxDir = mkdtempSync(join(directory, "inbox-"));
  acp.surface.bindInbox = ({ hostId }) => ({
    sessionId: "synthetic-inbox",
    hostId,
    directory: inboxDir,
    bindingPath: join(inboxDir, "binding"),
  });
  const worker = await host.createAgent(spec("worker-launch"));
  const reviewer = await host.createAgent(spec("reviewer-launch", "reviewer"));
  const roleThreads = [worker, reviewer].map(
    (role) => server.threads.get(role.id)!,
  );
  for (const role of roleThreads) {
    role.runs = [syntheticRun(role.thread.id, 1, { status: "running" })];
  }

  const otherTask = "synthetic-other-task";
  /** The pass's rows as the host step hands them over: the one projection per task. */
  const rows = (attention: Record<string, TaskAttention>) =>
    Object.entries(attention).map(([id, row]) => ({
      task: { id } as Task,
      attention: row,
    }));
  await host.reconcileTaskRow(taskId, { state: "active" });
  await host.reconcileTaskRow(otherTask, waiting());
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: { state: "active" }, [otherTask]: waiting() }),
  );
  const inbox = host.state.read().inbox!;
  const inboxTitle = () => server.threads.get(inbox.threadId)!.thread.title;
  assert.equal(inboxTitle(), "1 task running");

  await host.reconcileTaskRow(taskId, { state: "active" });
  await host.reconcileTaskRow(otherTask, { state: "active" });
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: { state: "active" }, [otherTask]: { state: "active" } }),
  );
  assert.equal(inboxTitle(), "2 tasks running");
  setPaused(true);
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: { state: "active" }, [otherTask]: { state: "active" } }),
  );
  assert.equal(inboxTitle(), "Paused: 2 tasks running");
  setPaused(false);
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: { state: "active" }, [otherTask]: { state: "active" } }),
  );
  assert.equal(inboxTitle(), "2 tasks running");

  for (const role of roleThreads) {
    role.runs = [syntheticRun(role.thread.id, 1, { status: "completed" })];
  }
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(server.threads.get(parentOf()!.threadId)!.thread.snoozedUntil);
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: waiting(), [otherTask]: { state: "active" } }),
  );
  assert.equal(inboxTitle(), "1 task running");

  await host.reconcileTaskRow(otherTask, { state: "finished" });
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: waiting(), [otherTask]: { state: "finished" } }),
  );
  assert.equal(inboxTitle(), "All quiet");

  // Pause changes only the prefix, even when the underlying title is unchanged.
  const titleUpdates = () =>
    commandsOf(server, "thread.metadata.update").filter(
      (command) => command.threadId === inbox.threadId,
    );
  const countBeforePause = titleUpdates().length;
  setPaused(true);
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: waiting(), [otherTask]: { state: "finished" } }),
  );
  assert.equal(inboxTitle(), "Paused: All quiet");
  assert.equal(titleUpdates().length, countBeforePause + 1);
  setPaused(false);
  await host.reconcileThreadTitles(
    [],
    rows({ [taskId]: waiting(), [otherTask]: { state: "finished" } }),
  );
  assert.equal(inboxTitle(), "All quiet");
  assert.equal(titleUpdates().length, countBeforePause + 2);
});

test("a row fault partway through the pass never publishes a partial running count (nucleus#1443)", async (t) => {
  const { acp, directory, host, server, workspace } = await fixture(t);
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  const engine = new Engine(store, adapter, 60_000);
  const pass = new HostPass(
    enginePorts(
      engine,
      [
        "adapter",
        "host",
        "inventoryHostMatches",
        "observeRetiredWorkers",
        "retiredObservationKey",
        "retiredObservationPlan",
        "scheduleLane",
        "stopped",
        "store",
      ],
      ["observationTargets"],
    ),
  );
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const inboxDir = mkdtempSync(join(directory, "inbox-"));
  acp.surface.bindInbox = ({ hostId }) => ({
    sessionId: "synthetic-inbox",
    hostId,
    directory: inboxDir,
    bindingPath: join(inboxDir, "binding"),
  });
  const runPass = () =>
    engine.withHost(host.hostId, () => pass.run(host.hostId));

  const insertTask = (name: string, hostId = host.hostId) =>
    store.insert(
      submission({ submissionId: name, title: name, repoPath: directory }),
      hostId,
      "handoff",
      "a".repeat(40),
    );
  const taskA = insertTask("inbox-count-a");
  const taskB = insertTask("inbox-count-b");
  const taskC = insertTask("inbox-count-c");
  const elsewhere = insertTask(
    "inbox-count-other-host",
    "synthetic-other-host",
  );
  /** One role's own thread, and the task row both of its roles share. */
  const launch = async (taskId: string, role: string, requestId: string) => {
    const agent = await host.createAgent({
      workspaceId: workspace.id,
      profile,
      title: role,
      taskNumber: 1,
      mcpBindingPath: null,
      attempt: () => ({
        requestId,
        prompt: "prompt",
        labels: storedT3Labels(role, { taskId, runId: `${requestId}-run` }),
        environment: {},
      }),
    });
    return {
      role: agent.id,
      row: host.state.read().parents![taskId]!.threadId,
    };
  };
  const rolesA = [
    await launch(taskA.id, "worker", "count-a-worker"),
    await launch(taskA.id, "reviewer", "count-a-reviewer"),
  ];
  const workerB = await launch(taskB.id, "worker", "count-b-worker");
  const workerC = await launch(taskC.id, "worker", "count-c-worker");
  const rows = () => [rolesA[0].row, workerB.row, workerC.row];
  const inboxTitle = () =>
    server.threads.get(host.state.read().inbox!.threadId)!.thread.title;
  const unsnoozes = () => commandsOf(server, "thread.unsnooze");

  // Every task waits, so every row is snoozed and the title counts nothing.
  await runPass();
  assert.equal(inboxTitle(), "All quiet");
  for (const row of rows())
    assert.ok(
      host.state.read().snoozes?.[row],
      `row ${row} was snoozed by the first pass`,
    );

  // All three tasks run. `store.tasks()` lists newest first and the pass keeps that
  // order among equal ranks, so the second row it presents is B's; that row's read
  // fails at the transport boundary, and the row step stops there.
  for (const task of [taskA, taskB, taskC, elsewhere])
    store.update(task.id, { phase: "working", agentActive: true });
  const presented = store
    .tasks()
    .filter((task) => task.hostId === host.hostId && task.removedAt == null);
  assert.equal(
    presented.length,
    3,
    "the other host's task is out of this pass",
  );
  assert.equal(
    presented[1]!.id,
    taskB.id,
    "the pass presents the newest task first",
  );
  const faulted = host.state.read().parents![presented[1]!.id]!.threadId;
  const call = host.rpc.call.bind(host.rpc);
  const readStream = host.rpc.readStream.bind(host.rpc);
  const faulty = (payload: unknown) =>
    (payload as { threadId?: string } | null)?.threadId === faulted;
  host.rpc.call = async (method, payload) =>
    faulty(payload)
      ? Promise.reject(new T3RpcError("transport", method))
      : call(method, payload);
  host.rpc.readStream = async (method, payload, accept) =>
    faulty(payload)
      ? Promise.reject(new T3RpcError("transport", method))
      : readStream(method, payload, accept);
  const faultyPass = await runPass();
  assert.equal(
    faultyPass.transportAnswered,
    false,
    "the row step stopped at the transport boundary",
  );
  assert.match(
    String(store.getMeta("hostPassError")),
    /\/reconcileTaskRows: T3Code transport/,
  );
  assert.equal(
    unsnoozes().length,
    1,
    "the rows after the fault were never written",
  );
  // The row writes were partial; the title is not. A's two live roles are one task.
  for (const role of rolesA)
    assert.ok(
      server.threads
        .get(role.role)
        ?.runs.some((run: { status?: string }) => run.status === "running"),
      `role ${role.role} is live`,
    );
  assert.equal(inboxTitle(), "3 tasks running");

  // A clean pass writes the remaining rows and finds nothing new to count.
  host.rpc.call = call;
  host.rpc.readStream = readStream;
  await runPass();
  assert.equal(unsnoozes().length, 3, "every remaining row is shown again");
  assert.equal(inboxTitle(), "3 tasks running");

  // The next passes read the store afresh: a finished task leaves, a started one joins.
  store.update(taskC.id, { phase: "done" });
  await runPass();
  assert.equal(inboxTitle(), "2 tasks running");
  const taskD = insertTask("inbox-count-d");
  store.update(taskD.id, { phase: "working", agentActive: true });
  await launch(taskD.id, "worker", "count-d-worker");
  await runPass();
  assert.equal(inboxTitle(), "3 tasks running");
});

test("the parent row names the step its role children are doing (acceptance 2)", async (t) => {
  const { host, server, spec, task, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const reviewer = await host.createAgent(spec("reviewer-launch", "reviewer"));
  server.threads.get(reviewer.id)!.runs = [
    syntheticRun("nightly-review-run", 1, {
      id: "nightly-review-run",
      status: "running",
      rootNodeId: "review-node",
    }),
  ];

  // The reviewer is running: the one row says so, on top of the task's own state title.
  const state = task({ agentId: parent.threadId });
  await host.setTaskWorkspaceTitle(
    state,
    taskWorkspaceTitle(state),
    "row-title-1",
    false,
  );
  const titles = () =>
    commandsOf(server, "thread.metadata.update").filter(
      (command) => command.threadId === parent.threadId,
    );
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role · reviewing",
  );
  assert.equal(
    server.threads.get(parent.threadId)!.thread.title,
    "Review: 225 Synthetic role · reviewing",
  );

  // The reviewer asks its own question: the row names that instead.
  const reviewerProjection = server.threads.get(reviewer.id)!;
  reviewerProjection.runs = [];
  reviewerProjection.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "reviewer-question",
      status: "pending",
      kind: "user_input",
    }),
  ];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role · reviewer needs input",
  );

  // The question is answered and the reviewer ends: the row drops the step.
  reviewerProjection.runtimeRequests = [];
  reviewerProjection.runs = [
    syntheticRun("nightly-review-run", 1, {
      id: "nightly-review-run",
      status: "completed",
      rootNodeId: "review-node",
    }),
  ];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, "Review: 225 Synthetic role");
});

test("a later round writes the same step again under a fresh command identity (acceptance 2)", async (t) => {
  const { host, server, spec, task, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const reviewer = await host.createAgent(spec("reviewer-launch", "reviewer"));
  const reviewerProjection = server.threads.get(reviewer.id)!;
  const state = task({ agentId: parent.threadId });
  const titles = () =>
    commandsOf(server, "thread.metadata.update").filter(
      (command) => command.threadId === parent.threadId,
    );
  const running = [
    syntheticRun("nightly-review-run", 1, {
      id: "nightly-review-run",
      status: "running",
      rootNodeId: "review-node",
    }),
  ];
  const ended = [
    syntheticRun("nightly-review-run", 1, {
      id: "nightly-review-run",
      status: "completed",
      rootNodeId: "review-node",
    }),
  ];

  reviewerProjection.runs = ended;
  await host.setTaskWorkspaceTitle(
    state,
    taskWorkspaceTitle(state),
    "row-base",
    false,
  );
  assert.equal(titles().at(-1)!.title, "Review: 225 Synthetic role");

  reviewerProjection.runs = running;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role · reviewing",
  );
  reviewerProjection.runs = ended;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, "Review: 225 Synthetic role");

  // Round two asks for the same step text again: the row needs a fresh identity, so
  // the previous title is never left on it while the reviewer works.
  reviewerProjection.runs = running;
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role · reviewing",
  );
  assert.equal(
    new Set(titles().map((command) => command.commandId)).size,
    titles().length,
  );
});

test("a superseded role thread never leaves its fault on the row (acceptance 2)", async (t) => {
  const { host, server, spec, task, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const state = task({ agentId: parent.threadId });
  const titles = () =>
    commandsOf(server, "thread.metadata.update").filter(
      (command) => command.threadId === parent.threadId,
    );
  await host.setTaskWorkspaceTitle(
    state,
    taskWorkspaceTitle(state),
    "row-base",
    false,
  );

  const failedRecovery = await host.createAgent(
    spec("recovery-launch-1", "recovery"),
  );
  server.threads.get(failedRecovery.id)!.runs = [
    syntheticRun("recovery-run-1", 1, {
      id: "recovery-run-1",
      status: "failed",
      rootNodeId: "recovery-node-1",
    }),
  ];
  // A waiting task's failed role run is history: it names neither the row nor its visibility (nucleus#1437).
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role",
    "a wait does not inherit a role's old fault",
  );
  // The task's own attention owns the fault, so the row names it and shows.
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Recovery failed",
  });
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role · blocked: recovery",
  );

  const recovery = await host.createAgent(
    spec("recovery-launch-2", "recovery"),
  );
  server.threads.get(recovery.id)!.runs = [
    syntheticRun("recovery-run-2", 1, {
      id: "recovery-run-2",
      status: "completed",
      rootNodeId: "recovery-node-2",
    }),
  ];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    titles().at(-1)!.title,
    "Review: 225 Synthetic role",
    "the superseded thread's fault is dropped",
  );

  server.threads.get(recovery.id)!.runs = [
    syntheticRun("recovery-run-3", 1, {
      id: "recovery-run-3",
      status: "running",
      rootNodeId: "recovery-node-2",
    }),
  ];
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(titles().at(-1)!.title, "Review: 225 Synthetic role · recovery");
});

test("a waiting task snoozes its parent row once, reads the horizon back, and renews before it lapses", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  await host.reconcileTaskRow(taskId, waiting());
  const snoozes = () => commandsOf(server, "thread.snooze");
  assert.equal(snoozes().length, 1, "one snooze for one wait");
  const [snooze] = snoozes();
  assert.equal(
    snooze!.threadId,
    parent.threadId,
    "the parent row is the task row",
  );
  assert.equal(
    projection.thread.snoozedUntil,
    snooze!.snoozedUntil,
    "the horizon is read back from the thread",
  );
  assert.ok(
    Date.parse(snooze!.snoozedUntil) > Date.now(),
    "the horizon is in the future",
  );
  const record = host.state.read().snoozes?.[parent.threadId];
  assert.equal(record?.state, "snoozed");
  assert.equal(record?.until, snooze!.snoozedUntil);

  // A repeated pass adds no write: the recorded row is inside its horizon.
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    server.commands.length,
    commands,
    "an unchanged row sends nothing",
  );
  assert.equal(
    projection.thread.settledOverride,
    null,
    "the row is never settled",
  );

  // The sweep renews before the horizon: a row inside the renew margin gets the
  // next horizon under a fresh command, so the row never wakes itself while the
  // task still waits. A renewal reads this host's own occurrence (the record's
  // horizon is the one T3 shows), so both sides move together here.
  const shortUntil = new Date(
    Date.now() + SNOOZE_RENEW_BEFORE_MS / 2,
  ).toISOString();
  projection.thread.snoozedUntil = shortUntil;
  host.state.update((state) => {
    state.snoozes![parent.threadId]!.until = shortUntil;
  });
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(snoozes().length, 2, "the renewal is one more snooze");
  const renewed = snoozes().at(-1)!;
  assert.notEqual(renewed.commandId, snooze!.commandId);
  assert.ok(
    Date.parse(renewed.snoozedUntil) - Date.now() > SNOOZE_HORIZON_MS / 2,
    "the renewed horizon is a full one",
  );
  assert.equal(projection.thread.snoozedUntil, renewed.snoozedUntil);
});

test("a prerequisite wait with an old role fault snoozes, and a current question still shows (nucleus#1437)", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  const failedRecovery = await host.createAgent(
    spec("recovery-launch-1", "recovery"),
  );
  server.threads.get(failedRecovery.id)!.runs = [
    syntheticRun("recovery-run-1", 1, {
      id: "recovery-run-1",
      status: "failed",
      rootNodeId: "recovery-node-1",
    }),
  ];

  // Negative twin: the historical failed recovery does not hold the row.
  await host.reconcileTaskRow(taskId, waiting("Waiting on nucleus#1364"));
  assert.ok(
    projection.thread.snoozedUntil,
    "the wait snoozes the row past the old fault",
  );
  assert.equal(commandsOf(server, "thread.unsnooze").length, 0);

  // Positive twin: a question the role asks now is a current request and surfaces the row.
  const reviewer = await host.createAgent(spec("reviewer-launch", "reviewer"));
  const reviewerProjection = server.threads.get(reviewer.id)!;
  reviewerProjection.runs = [
    syntheticRun("nightly-review-run", 1, {
      id: "nightly-review-run",
      status: "running",
      rootNodeId: "review-node",
    }),
  ];
  reviewerProjection.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "reviewer-question",
      status: "pending",
      kind: "user_input",
    }),
  ];
  await host.reconcileTaskRow(taskId, waiting("Waiting on nucleus#1364"));
  assert.equal(
    projection.thread.snoozedUntil,
    null,
    "a pending question shows the row",
  );
  assert.match(projection.thread.title ?? "", /reviewer needs input/);
});

test("a task that needs a person unsnoozes a row this host snoozed", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(projection.thread.snoozedUntil, "the row starts snoozed");

  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Worker creation refused before send",
  });
  assert.equal(
    commandsOf(server, "thread.unsnooze").length,
    1,
    "a person who must act surfaces the row",
  );
  assert.equal(projection.thread.snoozedUntil, null);
  assert.equal(
    projection.thread.settledOverride,
    null,
    "the row is surfaced, never settled",
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "the snooze record is retired",
  );

  // Already shown: a repeated attention pass sends nothing.
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Worker creation refused before send",
  });
  assert.equal(server.commands.length, commands);
});

test("an operator's own settled row is left alone", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  projection.thread.settledOverride = "settled";
  projection.thread.settledAt = STAMP;
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(
    server.commands.length,
    commands,
    "neither a snooze nor an unsettle is sent",
  );
  assert.equal(projection.thread.settledOverride, "settled");
  assert.equal(projection.thread.snoozedUntil, null);
});

test("unknown snooze delivery keeps its identity and a later landed snooze is undone", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  const until = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
  host.state.update((state) => {
    state.snoozes = {
      ...state.snoozes,
      [parent.threadId]: {
        episode: 0,
        commandId: "unknown-snooze",
        until,
        state: "unknown",
        recordedAt: STAMP,
      },
    };
  });
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(commandsOf(server, "thread.snooze").length, 0);
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.state, "unknown");
  projection.thread.snoozedUntil = until;
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(commandsOf(server, "thread.unsnooze").length, 1);
  assert.equal(projection.thread.snoozedUntil, null);
});

test("a later wait can snooze after an unknown send and its horizon expire", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const until = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
  host.state.update((state) => {
    state.snoozes = {
      ...state.snoozes,
      [parent.threadId]: {
        episode: 0,
        commandId: "uncertain-old-wait",
        until,
        state: "unknown",
        recordedAt: STAMP,
      },
    };
  });
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.ended, true);
  await host.reconcileTaskRow(taskId, waiting("A later wait"));
  assert.equal(
    commandsOf(server, "thread.snooze").length,
    0,
    "the old send can still land",
  );
  host.state.update((state) => {
    state.snoozes![parent.threadId]!.until = STAMP;
  });
  await host.reconcileTaskRow(taskId, waiting("A later wait"));
  assert.equal(commandsOf(server, "thread.snooze").length, 1);
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.state, "snoozed");
});

test("re-entry wakes a manually settled parent: it is unsettled before the re-entry message, never settled by Nucleus", async (t) => {
  const { host, server, spec, parentOf, acp } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  acp.surface.release(`session:${taskId}`, "test");
  server.threads.get(parent.threadId)!.thread.settledOverride = "settled";
  const before = server.commands.length;
  await host.createAgent(spec("reviewer-launch", "reviewer"));
  const sent = server.commands
    .slice(before)
    .filter((command) => command.threadId === parent.threadId);
  const unsettle = sent.findIndex(
    (command) => command.type === "thread.unsettle",
  );
  const dispatch = sent.findIndex(
    (command) => command.type === "message.dispatch",
  );
  assert.ok(
    unsettle >= 0 && dispatch > unsettle,
    "the parent is woken before the re-entry message is sent",
  );
  assert.equal(
    server.commands
      .slice(before)
      .some((command) => command.type === "thread.settle"),
    false,
  );
  assert.equal(
    server.threads.get(parent.threadId)!.thread.settledOverride,
    "active",
  );
});

test("a snooze refused for a pending approval stays active with no retry loop", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  projection.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "parent-approval",
      status: "pending",
      kind: "permission",
    }),
  ];

  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    commandsOf(server, "thread.snooze").length,
    1,
    "the refused snooze was sent once",
  );
  assert.equal(projection.thread.snoozedUntil, null, "the row stays active");
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.state, "unknown");

  // The same wait keeps the row active: this episode never retries.
  const commands = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    server.commands.length,
    commands,
    "a refused snooze is not retried for the same wait",
  );
});

test("Nucleus never settles a task thread, on any decision", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const reviewer = await host.createAgent(spec("reviewer-launch", "reviewer"));
  assert.ok(parentOf());
  for (const attention of [
    waiting(),
    { state: "active" } as TaskAttention,
    { state: "attention", cause: "Needs a person" } as TaskAttention,
    { state: "finished" } as TaskAttention,
  ])
    await host.reconcileTaskRow(taskId, attention);
  assert.equal(commandsOf(server, "thread.settle").length, 0);
  assert.equal(
    commandsOf(server, "thread.snooze").length,
    1,
    "the waiting decision snoozed once",
  );
  assert.ok(reviewer.id);
});

test("a role whose create refuses launches no top-level thread and names the fix", async (t) => {
  const { host, server, parentOf, workspace } = await fixture(t);
  server.controls.providers = [
    {
      instanceId: "synthetic-provider",
      displayName: "Synthetic provider",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic model" }],
    },
  ];
  await assert.rejects(
    () =>
      host.createAgent({
        workspaceId: workspace.id,
        profile,
        title: "Synthetic role",
        taskNumber: 225,
        mcpBindingPath: null,
        attempt: () => ({
          requestId: "refused-launch",
          prompt: "Worker prompt",
          labels: storedT3Labels("worker", { taskId }),
          environment: {},
        }),
      }),
    (error: unknown) =>
      error instanceof Error &&
      /T3 provider not ready: .*run `nucleus t3 install`/.test(error.message),
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    0,
    "nothing is launched",
  );
  assert.equal(parentOf(), undefined);
});

test("settled unsnooze that has not cleared snoozedUntil keeps the snooze record, re-observes on delayed apply, and retries as a new occurrence when still snoozed", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  await host.reconcileTaskRow(taskId, waiting());
  const snoozedUntil = projection.thread.snoozedUntil;
  assert.ok(snoozedUntil, "row is snoozed");

  // 1. Delayed apply: T3 acks thread.unsnooze, yet read-back still shows snoozedUntil.
  const nativeCall = host.rpc.call.bind(host.rpc);
  let dropUnsnoozeEffect = true;
  host.rpc.call = async (method, payload) => {
    if (
      dropUnsnoozeEffect &&
      method === "orchestration.dispatchCommand" &&
      (payload as { type?: string }).type === "thread.unsnooze"
    ) {
      return { ok: true };
    }
    return nativeCall(method, payload);
  };

  await host.reconcileTaskRow(taskId, { state: "active" });
  assert.equal(
    projection.thread.snoozedUntil,
    snoozedUntil,
    "row is still snoozed on T3",
  );
  assert.ok(
    host.state.read().snoozes?.[parent.threadId],
    "snooze record is kept until read-back proves cleared",
  );
  const firstUnsnoozeIntent = Object.values(host.state.read().intents).find(
    (intent) => intent.kind === "thread.unsnooze",
  );
  assert.equal(
    firstUnsnoozeIntent?.status,
    "settled",
    "first unsnooze receipt settled",
  );

  // When delayed apply lands before the next pass, re-observation forgets the snooze without resending.
  projection.thread.snoozedUntil = null;
  await host.reconcileTaskRow(taskId, { state: "active" });
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "delayed apply retired snooze on re-observe",
  );
  assert.equal(
    commandsOf(server, "thread.unsnooze").length,
    0,
    "no redundant unsnooze sent after delayed apply",
  );

  // 2. Ack that did not take: snooze again, ack unsnooze without clearing, then let the retry take.
  await host.reconcileTaskRow(taskId, waiting("Second wait"));
  const secondSnooze = projection.thread.snoozedUntil;
  assert.ok(secondSnooze, "second wait snoozes row");

  await host.reconcileTaskRow(taskId, { state: "active" });
  assert.equal(
    projection.thread.snoozedUntil,
    secondSnooze,
    "still snoozed after unapplied ack",
  );
  assert.ok(
    host.state.read().snoozes?.[parent.threadId],
    "snooze record stays for retry",
  );

  dropUnsnoozeEffect = false;
  await host.reconcileTaskRow(taskId, { state: "active" });
  const unsnoozeCommands = commandsOf(server, "thread.unsnooze");
  assert.equal(
    unsnoozeCommands.length,
    1,
    "next pass retries unsnooze on the wire",
  );
  const unsnoozeIntents = Object.entries(host.state.read().intents)
    .filter(([, intent]) => intent.kind === "thread.unsnooze")
    .map(([id]) => id);
  assert.equal(
    new Set(unsnoozeIntents).size,
    3,
    "retry used a fresh command identity as a new occurrence",
  );
  assert.equal(
    projection.thread.snoozedUntil,
    null,
    "read-back proves snoozedUntil cleared",
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "snooze record retired only after read-back",
  );
});

test("stale pass snapshot never hides a still-snoozed row or forgets an active snooze", async (t) => {
  const { host, server, spec, parentOf, task } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  const activeTask = task({ phase: "working", agentId: parent.threadId });

  await host.beginHostPass([activeTask]);
  // Populate T3Reads' held cache with snoozedUntil: null from earlier in this pass.
  const initial = await host.readProjection(parent.threadId, "observation");
  assert.equal(initial.thread.snoozedUntil, null);

  // Now T3 has snoozedUntil set while the pass's cached inventory row still had null.
  const until = new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString();
  projection.thread.snoozedUntil = until;
  host.state.update((state) => {
    state.snoozes = {
      ...state.snoozes,
      [parent.threadId]: {
        episode: 0,
        commandId: "stale-pass-snooze",
        until,
        state: "snoozed",
        recordedAt: STAMP,
      },
    };
  });

  await host.reconcileTaskRow(taskId, { state: "active" });
  host.endHostPass();
  assert.equal(
    commandsOf(server, "thread.unsnooze").length,
    1,
    "unsnoozeRow bypassed the stale held snapshot",
  );
  assert.equal(projection.thread.snoozedUntil, null);
  assert.equal(host.state.read().snoozes?.[parent.threadId], undefined);
});

test("unknown unsnooze delivery is never resent blindly and settles once read-back shows cleared", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(projection.thread.snoozedUntil);

  const nativeCall = host.rpc.call.bind(host.rpc);
  let unsnoozeAttempts = 0;
  host.rpc.call = async (method, payload) => {
    if (
      method === "orchestration.dispatchCommand" &&
      (payload as { type?: string }).type === "thread.unsnooze"
    ) {
      unsnoozeAttempts++;
      throw new T3RpcError("timeout", method);
    }
    return nativeCall(method, payload);
  };

  await assert.rejects(
    host.reconcileTaskRow(taskId, { state: "active" }),
    /Host delivery is unknown/i,
  );
  assert.equal(unsnoozeAttempts, 1);
  assert.ok(
    host.state.read().snoozes?.[parent.threadId],
    "snooze record stays while unsnooze delivery is unknown",
  );

  // Re-running while snoozedUntil is still set must not resend blindly while delivery is unknown.
  await host.reconcileTaskRow(taskId, { state: "active" });
  assert.equal(
    unsnoozeAttempts,
    1,
    "timed-out unknown unsnooze is never resent blindly",
  );
  const unknownUnsnooze = Object.values(host.state.read().intents).filter(
    (intent) =>
      intent.kind === "thread.unsnooze" && intent.status === "unknown",
  );
  assert.equal(
    unknownUnsnooze.length,
    1,
    "unknown delivery keeps one command identity",
  );

  // Once T3's read-back shows snoozedUntil cleared, the next pass settles and retires the snooze.
  projection.thread.snoozedUntil = null;
  host.rpc.call = nativeCall;
  await host.reconcileTaskRow(taskId, { state: "active" });
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "snooze retired after read-back",
  );
  assert.equal(
    Object.values(host.state.read().intents).some(
      (intent) =>
        intent.kind === "thread.unsnooze" && intent.status === "unknown",
    ),
    false,
    "unknown unsnooze intent settled by positive read-back",
  );
});

test("an operator snooze inside the renew margin is never overwritten or unsnoozed", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  const operatorUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  projection.thread.snoozedUntil = operatorUntil;
  const before = server.commands.length;

  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, { state: "active" });
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });

  assert.equal(
    server.commands.length,
    before,
    "no snooze or unsnooze sent for an operator snooze",
  );
  assert.equal(projection.thread.snoozedUntil, operatorUntil);
});

test("an operator horizon replacing this host occurrence is left alone, never renewed or unsnoozed (nucleus#1445)", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  await host.reconcileTaskRow(taskId, waiting());
  const ours = host.state.read().snoozes?.[parent.threadId];
  assert.equal(ours?.state, "snoozed");
  assert.equal(
    ours?.taskId,
    taskId,
    "the record is bound to the task whose row it snoozed",
  );

  // The operator replaces the horizon from their own client while the task waits.
  const operatorUntil = new Date(Date.now() + 30 * 60_000).toISOString();
  projection.thread.snoozedUntil = operatorUntil;
  const snoozes = () => commandsOf(server, "thread.snooze").length;
  const unsnoozes = () => commandsOf(server, "thread.unsnooze").length;
  const before = { snoozes: snoozes(), unsnoozes: unsnoozes() };

  // A renewal pass: the changed horizon is not this host's, so nothing is sent.
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(
    snoozes(),
    before.snoozes,
    "no renewal over the operator horizon",
  );
  assert.equal(
    projection.thread.snoozedUntil,
    operatorUntil,
    "the operator horizon stands",
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "the record stops claiming the row",
  );
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });

  // A person who must act does not clear the operator's snooze either.
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(
    unsnoozes(),
    before.unsnoozes,
    "no unsnooze of the operator horizon",
  );
  assert.equal(projection.thread.snoozedUntil, operatorUntil);
});

test("a read-back that is not this host horizon is never recorded as its own (nucleus#1445)", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  // The command lands, and another client's snooze replaces the row before the
  // read-back: the horizon T3 shows is not the one this host asked for.
  const nativeCall = host.rpc.call.bind(host.rpc);
  let planted: string | null = null;
  host.rpc.call = async (method, payload) => {
    const result = await nativeCall(method, payload);
    if (
      method === "orchestration.dispatchCommand" &&
      (payload as { type?: string }).type === "thread.snooze"
    ) {
      planted = new Date(Date.now() + 10 * 60_000).toISOString();
      projection.thread.snoozedUntil = planted;
    }
    return result;
  };

  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(planted, "the snooze command was sent");
  assert.equal(projection.thread.snoozedUntil, planted);
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "a different horizon is never adopted as this host occurrence",
  );
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });

  // With no record the row reads as the operator's, so later passes leave it alone.
  const snoozes = () => commandsOf(server, "thread.snooze").length;
  const before = snoozes();
  await host.reconcileTaskRow(taskId, waiting());
  assert.equal(snoozes(), before, "the operator occurrence is not renewed");
  assert.equal(projection.thread.snoozedUntil, planted);
});

test("a stale legacy record never renews or clears a snooze it cannot prove (nucleus#1445)", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;

  // A record written before the binding was stored, whose horizon is not the one
  // T3 shows: it is ambiguous evidence and claims nothing.
  const operatorUntil = new Date(Date.now() + 90 * 60_000).toISOString();
  projection.thread.snoozedUntil = operatorUntil;
  host.state.update((state) => {
    state.snoozes = {
      ...state.snoozes,
      [parent.threadId]: {
        episode: 0,
        commandId: "legacy-unproven-snooze",
        until: new Date(Date.now() + SNOOZE_HORIZON_MS).toISOString(),
        state: "snoozed",
        recordedAt: STAMP,
      },
    };
  });
  const before = server.commands.length;

  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });

  assert.equal(
    server.commands.length,
    before,
    "no snooze or unsnooze was sent",
  );
  assert.equal(
    projection.thread.snoozedUntil,
    operatorUntil,
    "the operator horizon stands",
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "the ambiguous record is retired",
  );
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });
});

test("an ambiguous or foreign parent binding is never addressed as a task row (nucleus#1445)", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(projection.thread.snoozedUntil);

  // Another task's parent record names the same thread: the row is ambiguous, so
  // this task's presentation writes nothing to it.
  host.state.update((state) => {
    state.parents = {
      ...state.parents,
      "synthetic-other-task": { ...parent, taskId: "synthetic-other-task" },
    };
  });
  const before = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(
    server.commands.length,
    before,
    "nothing is addressed to the ambiguous row",
  );
  assert.deepEqual(await host.rowSnoozeVisibility(taskId), { kind: "clear" });

  // A record another task wrote is not this row's ownership either.
  host.state.update((state) => {
    if (state.parents) delete state.parents["synthetic-other-task"];
    state.snoozes = {
      ...state.snoozes,
      [parent.threadId]: {
        episode: 0,
        commandId: "foreign-snooze",
        until: projection.thread.snoozedUntil!,
        state: "snoozed",
        taskId: "synthetic-other-task",
        recordedAt: STAMP,
      },
    };
  });
  const afterForeign = server.commands.length;
  await host.reconcileTaskRow(taskId, waiting());
  await host.reconcileTaskRow(taskId, {
    state: "attention",
    cause: "Needs a person",
  });
  assert.equal(
    server.commands.length,
    afterForeign,
    "a foreign record is never renewed or cleared",
  );
  assert.equal(host.state.read().snoozes?.[parent.threadId], undefined);
  assert.equal(
    projection.thread.snoozedUntil !== null,
    true,
    "the row stays as T3 shows it",
  );
});

test("a task row this host snoozed still receives its own message, and T3 wake then re-snoozes the wait (nucleus#1445)", async (t) => {
  const { host, server, spec, parentOf } = await fixture(t);
  await host.createAgent(spec("worker-launch"));
  const parent = parentOf()!;
  const projection = server.threads.get(parent.threadId)!;
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(
    projection.thread.snoozedUntil,
    "the row starts snoozed by this host",
  );

  await host.sendMessage(parent.threadId, {
    messageId: "own-row-message",
    text: "Nucleus keeps this task thread open for its next role.",
  });
  assert.equal(
    commandsOf(server, "thread.unsnooze").length,
    0,
    "the delivery gate sent no unsnooze for this host own row",
  );
  assert.equal(
    projection.thread.snoozedUntil,
    null,
    "T3 own wake clears the row when the message is delivered",
  );

  // The wait is still real, so the next presentation pass snoozes the row again.
  await host.reconcileTaskRow(taskId, waiting());
  assert.ok(projection.thread.snoozedUntil, "the waiting row is snoozed again");
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.taskId, taskId);
});

test("active worker going idle and resuming in the same native child unsnoozes on the immediate drain", async (t) => {
  const { directory, server, host, workspace, spec, parentOf } =
    await fixture(t);
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  const engine = new Engine(store, adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });

  const inserted = store.insert(
    submission({
      submissionId: "same-child-resume",
      title: "Same child resume",
      repoPath: directory,
    }),
    host.hostId,
    "handoff",
    "a".repeat(40),
  );
  const worker = await host.createAgent({
    workspaceId: workspace.id,
    profile,
    title: "Same child resume",
    taskNumber: inserted.number,
    mcpBindingPath: null,
    attempt: () => ({
      requestId: "worker-launch-same-child",
      prompt: "Worker prompt",
      labels: storedT3Labels("worker", {
        taskId: inserted.id,
        runId: "worker-run-1",
      }),
      environment: {},
    }),
  });
  const parent = parentOf()!;
  const parentProjection = server.threads.get(parent.threadId)!;
  const workerProjection = server.threads.get(worker.id)!;
  workerProjection.runs = [syntheticRun(worker.id, 1, { status: "running" })];
  const prereq = store.insert(
    submission({
      submissionId: "same-child-prereq",
      title: "Same child prereq",
      repoPath: directory,
    }),
    host.hostId,
    "handoff",
    "a".repeat(40),
  );
  // Real stored task state: worker went idle while waiting on a prerequisite -> snoozed parent row.
  workerProjection.runs = [syntheticRun(worker.id, 1, { status: "completed" })];
  store.update(inserted.id, {
    phase: "working",
    workspaceId: workspace.id,
    directory,
    agentId: worker.id,
    agentIntent: true,
    agentActive: false,
    idleSince: STAMP,
    runId: "worker-run-1",
    prerequisiteWait: {
      id: prereq.id,
      waitsFor: [prereq.id],
      reason: "Wait briefly before resuming",
      releasedAt: null,
    },
  });

  // 1. HostPass reconciles the waiting task and snoozes its parent row.
  await engine.auditPass(false);
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "parent row is snoozed while task waits",
  );
  assert.ok(
    host.state.read().snoozes?.[parent.threadId],
    "host recorded snooze",
  );

  // 2. The wait lifts and the same native child resumes.
  store.update(inserted.id, {
    prerequisiteWait: null,
    agentActive: true,
    idleSince: null,
  });
  workerProjection.runs = [syntheticRun(worker.id, 2, { status: "running" })];

  const activatedAt = Date.now();
  engine.enqueueTitle(inserted.id);
  await engine.drainProjections({ cleanup: false });
  const elapsedMs = Date.now() - activatedAt;

  assert.equal(
    parentProjection.thread.snoozedUntil,
    null,
    "parent row unsnoozed on the immediate drain",
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "snooze record retired after read-back",
  );
  assert.equal(
    store.task(inserted.id).agentId,
    worker.id,
    "same native worker child resumed",
  );
  assert.ok(
    elapsedMs < 2_000,
    `expected immediate drain reconcile (<2000ms), got ${elapsedMs}ms`,
  );
});

test("unconfirmed role launches snooze the verified parent and stay out of the Inbox running count until live or needing attention (nucleus#1453)", async (t) => {
  const { acp, directory, host, server, workspace, parentOf } =
    await fixture(t);
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  const engine = new Engine(store, adapter, 60_000);
  const pass = new HostPass(
    enginePorts(
      engine,
      [
        "adapter",
        "host",
        "inventoryHostMatches",
        "observeRetiredWorkers",
        "retiredObservationKey",
        "retiredObservationPlan",
        "scheduleLane",
        "stopped",
        "store",
      ],
      ["observationTargets"],
    ),
  );
  t.after(async () => {
    await engine.stop();
    store.close();
  });

  const inboxDir = mkdtempSync(join(directory, "inbox-"));
  let pendingDecision: string | null = null;
  acp.surface.bindInbox = ({ hostId }) => ({
    sessionId: "synthetic-inbox",
    hostId,
    directory: inboxDir,
    bindingPath: join(inboxDir, "binding"),
  });
  acp.surface.pendingDecisionKey = (id) =>
    pendingDecision && id === task.id ? pendingDecision : null;
  const runPass = () =>
    engine.withHost(host.hostId, () => pass.run(host.hostId));

  const task = store.insert(
    submission({
      submissionId: "unconfirmed-launch",
      title: "Unconfirmed reviewer launch",
      repoPath: directory,
    }),
    host.hostId,
    "handoff",
    "a".repeat(40),
  );
  const worker = await host.createAgent({
    workspaceId: workspace.id,
    profile,
    title: "Unconfirmed reviewer launch",
    taskNumber: task.number,
    mcpBindingPath: null,
    attempt: () => ({
      requestId: "worker-launch-1453",
      prompt: "Worker prompt",
      labels: storedT3Labels("worker", {
        taskId: task.id,
        runId: "worker-run-1453",
      }),
      environment: {},
    }),
  });
  const parent = parentOf()!;
  const parentProjection = server.threads.get(parent.threadId)!;
  const workerProjection = server.threads.get(worker.id)!;
  workerProjection.runs = [syntheticRun(worker.id, 1, { status: "completed" })];

  // Realistic idle worker with ready_for_review completion and a no-agent reserved reviewer run.
  const reviewRunId = "rev-run-1453";
  const uncertainReason =
    "Reviewer creation is uncertain; exact lookup decides whether it produced an agent";
  const makeReviewerRun = (overrides: Record<string, unknown> = {}) =>
    runSchema.parse({
      id: reviewRunId,
      taskId: task.id,
      hostId: host.hostId,
      role: "reviewer",
      generation: 0,
      head: "b".repeat(40),
      base: "a".repeat(40),
      agentId: null,
      workspaceId: workspace.id,
      profile,
      status: "intent",
      createdAt: STAMP,
      lastObservedAt: null,
      active: null,
      idleSince: null,
      completion: null,
      released: false,
      ...overrides,
    });

  store.update(task.id, {
    phase: "reviewing",
    workspaceId: workspace.id,
    directory,
    agentId: worker.id,
    agentIntent: false,
    agentActive: false,
    runId: "worker-run-1453",
    prHead: "b".repeat(40),
    prUrl: "https://example.invalid/pr/6510",
    completion: {
      eventId: "worker-evt-1453",
      taskId: task.id,
      runId: "worker-run-1453",
      status: "ready_for_review",
      head: "b".repeat(40),
      summary: "Ready for review",
      prNumber: 6510,
      verdicts: [],
    },
    reason: uncertainReason,
    resolution: {
      ...store.task(task.id).resolution,
      currentRunId: reviewRunId,
      attention: false,
      stop: taskStopRecord("lifecycle", uncertainReason, null, STAMP),
      incident: {
        id: "incident-1453",
        fingerprint: "incident-1453",
        role: "reviewer",
        runId: reviewRunId,
        turnId: null,
        attempt: 0,
        cause: "exact_lookup",
        detail: "Reviewer creation is uncertain",
        action: "exact_lookup",
        status: "reconciling",
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    },
  });
  const reservedRun = makeReviewerRun({ status: "intent", agentId: null });
  store.putRun(reservedRun);

  const inboxTitle = () =>
    server.threads.get(host.state.read().inbox!.threadId)!.thread.title;

  // 1. No-agent reserved (`intent`) delivery snoozes the verified parent row and keeps Inbox quiet.
  assert.equal(
    runHoldsSlot(reservedRun),
    true,
    "capacity stays held by the reserved run",
  );
  assert.equal(
    taskHasUnreleasedRun(store.task(task.id), true),
    true,
    "durable unreleased run remains unchanged",
  );
  assert.equal(taskRowAttention(store, store.task(task.id)).state, "waiting");
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "reserved no-agent launch snoozes parent row",
  );
  assert.equal(host.state.read().snoozes?.[parent.threadId]?.taskId, task.id);
  assert.equal(
    inboxTitle(),
    "All quiet",
    "reserved launch does not inflate Inbox running count",
  );

  // 2. No-agent uncertain (`uncertain`) delivery also keeps the row snoozed and Inbox quiet.
  const uncertainRun = makeReviewerRun({ status: "uncertain", agentId: null });
  store.putRun(uncertainRun);
  assert.equal(
    runHoldsSlot(uncertainRun),
    true,
    "capacity stays held by the uncertain run",
  );
  assert.equal(taskRowAttention(store, store.task(task.id)).state, "waiting");
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "uncertain no-agent launch keeps parent row snoozed",
  );
  assert.equal(
    inboxTitle(),
    "All quiet",
    "uncertain launch does not inflate Inbox running count",
  );

  // 3. Retained-thread reserved/uncertain delivery (`agentId` set, no observed live execution) also waits passively.
  const retainedUncertain = makeReviewerRun({
    status: "uncertain",
    agentId: "retained-reviewer-1",
    active: null,
  });
  store.putRun(retainedUncertain);
  assert.equal(taskRowAttention(store, store.task(task.id)).state, "waiting");
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "unconfirmed delivery with no active execution stays snoozed",
  );
  assert.equal(inboxTitle(), "All quiet");

  // 4. Transition to activity: exact lookup binds the reviewer and confirms running (`status: "running"`).
  // Even with the initial worker still idle (`agentActive: false`), the bound running reviewer surfaces the row.
  const reviewer = await host.createAgent({
    workspaceId: workspace.id,
    profile,
    title: "reviewer: Unconfirmed reviewer launch",
    taskNumber: task.number,
    mcpBindingPath: null,
    attempt: () => ({
      requestId: "reviewer-launch-1453",
      prompt: "Reviewer prompt",
      labels: storedT3Labels("reviewer", {
        taskId: task.id,
        runId: reviewRunId,
      }),
      environment: {},
    }),
  });
  const reviewerProjection = server.threads.get(reviewer.id)!;
  reviewerProjection.runs = [
    syntheticRun(reviewer.id, 1, { status: "running" }),
  ];
  store.putRun(
    makeReviewerRun({ status: "running", agentId: reviewer.id, active: true }),
  );
  store.update(task.id, {
    reason: "reviewer thread running",
    resolution: { ...store.task(task.id).resolution, stop: null },
  });
  assert.equal(taskRowAttention(store, store.task(task.id)).state, "active");
  await runPass();
  assert.equal(
    parentProjection.thread.snoozedUntil,
    null,
    "confirmed running reviewer unsnoozes parent row",
  );
  assert.equal(
    host.state.read().snoozes?.[parent.threadId],
    undefined,
    "snooze record retired after read-back",
  );
  assert.equal(
    inboxTitle(),
    "1 task running",
    "bound running reviewer counts in Inbox despite idle worker",
  );

  // 5. Return to uncertain no-agent launch in a passive wait -> snoozes again; then a pending question surfaces it.
  reviewerProjection.runs = [
    syntheticRun(reviewer.id, 1, { status: "completed" }),
  ];
  store.putRun(
    makeReviewerRun({ status: "uncertain", agentId: null, active: null }),
  );
  store.update(task.id, {
    reason: uncertainReason,
    resolution: {
      ...store.task(task.id).resolution,
      stop: taskStopRecord("lifecycle", uncertainReason, null, STAMP),
    },
  });
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "snoozed again while unconfirmed",
  );
  assert.equal(inboxTitle(), "All quiet");

  // 5a. Pending ACP decision on the task surfaces the row and clears the Nucleus snooze.
  pendingDecision = "decision-1453";
  await runPass();
  assert.equal(
    parentProjection.thread.snoozedUntil,
    null,
    "pending ACP decision unsnoozes parent row",
  );
  pendingDecision = null;
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "re-snoozed once decision clears",
  );

  // 5b. Support thread pending permission/question surfaces the row.
  reviewerProjection.runtimeRequests = [
    syntheticRuntimeRequest({
      id: "req-1453",
      status: "pending",
      kind: "permission",
    }),
  ];
  await runPass();
  assert.equal(
    parentProjection.thread.snoozedUntil,
    null,
    "pending role permission unsnoozes parent row",
  );
  assert.match(parentProjection.thread.title ?? "", /reviewer needs input/);
  reviewerProjection.runtimeRequests = [];
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "re-snoozed once permission clears",
  );

  // 5c. Genuine operator attention / escalation surfaces the row.
  store.update(task.id, {
    phase: "needs_attention",
    reason:
      "Reviewer creation lookup is ambiguous (2 matching agents); no resource was created",
    resolution: {
      ...store.task(task.id).resolution,
      attention: true,
      stop: taskStopRecord(
        "operator_needed",
        "Reviewer creation lookup is ambiguous",
        null,
        STAMP,
      ),
    },
  });
  await runPass();
  assert.equal(
    parentProjection.thread.snoozedUntil,
    null,
    "genuine operator attention unsnoozes parent row",
  );
  assert.equal(
    inboxTitle(),
    "All quiet",
    "attention row is visible without inflating running count",
  );
});

test("unbound worker agentIntent in a passive lifecycle wait snoozes and preserves manual snooze and settled threads (nucleus#1453)", async (t) => {
  const { directory, host, server, workspace, parentOf } = await fixture(t);
  const store = new Store(":memory:");
  store.setMeta("paused", false);
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  const engine = new Engine(store, adapter, 60_000);
  const pass = new HostPass(
    enginePorts(
      engine,
      [
        "adapter",
        "host",
        "inventoryHostMatches",
        "observeRetiredWorkers",
        "retiredObservationKey",
        "retiredObservationPlan",
        "scheduleLane",
        "stopped",
        "store",
      ],
      ["observationTargets"],
    ),
  );
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const runPass = () =>
    engine.withHost(host.hostId, () => pass.run(host.hostId));

  const task = store.insert(
    submission({
      submissionId: "unbound-worker-1453",
      title: "Unbound worker intent",
      repoPath: directory,
    }),
    host.hostId,
    "handoff",
    "a".repeat(40),
  );
  await host.createAgent({
    workspaceId: workspace.id,
    profile,
    title: "Unbound worker intent",
    taskNumber: task.number,
    mcpBindingPath: null,
    attempt: () => ({
      requestId: "worker-launch-unbound-1453",
      prompt: "Worker prompt",
      labels: storedT3Labels("worker", {
        taskId: task.id,
        runId: "worker-run-unbound-1453",
      }),
      environment: {},
    }),
  });
  const parent = parentOf()!;
  const parentProjection = server.threads.get(parent.threadId)!;

  // Unbound worker creation intent with a passive lifecycle wait (even in needs_attention).
  const waitReason =
    "Worker creation remains uncertain; waiting for its recorded producer to stop and the lookup grace period to pass";
  store.update(task.id, {
    phase: "needs_attention",
    workspaceId: workspace.id,
    directory,
    agentIntent: true,
    agentId: null,
    agentActive: null,
    runId: "worker-run-unbound-1453",
    reason: waitReason,
    resolution: {
      ...store.task(task.id).resolution,
      attention: false,
      stop: taskStopRecord("lifecycle", waitReason, null, STAMP),
    },
  });
  assert.equal(
    taskHasUnreleasedRun(store.task(task.id)),
    true,
    "capacity stays held by agentIntent",
  );
  assert.equal(taskRowAttention(store, store.task(task.id)).state, "waiting");

  // Operator manual snooze is retained and never overwritten.
  const operatorUntil = new Date(Date.now() + 3600_000).toISOString();
  parentProjection.thread.snoozedUntil = operatorUntil;
  await runPass();
  assert.equal(
    parentProjection.thread.snoozedUntil,
    operatorUntil,
    "operator manual snooze stays untouched",
  );
  assert.equal(host.state.read().snoozes?.[parent.threadId], undefined);

  // Operator manual settle is retained and never snoozed or unsettled.
  parentProjection.thread.snoozedUntil = null;
  parentProjection.thread.settledOverride = "settled";
  parentProjection.thread.settledAt = STAMP;
  await runPass();
  assert.equal(parentProjection.thread.settledOverride, "settled");
  assert.equal(parentProjection.thread.snoozedUntil, null);

  // An ordinary parent row gets snoozed, then unsnoozed once the worker is bound and active.
  parentProjection.thread.settledOverride = null;
  parentProjection.thread.settledAt = null;
  await runPass();
  assert.ok(
    parentProjection.thread.snoozedUntil,
    "unconfirmed worker wait snoozes verified parent",
  );
  store.update(task.id, {
    phase: "working",
    agentId: "bound-worker-1453",
    agentActive: true,
    reason: "Worker running",
    resolution: { ...store.task(task.id).resolution, stop: null },
  });
  await runPass();
  assert.equal(
    parentProjection.thread.snoozedUntil,
    null,
    "bound active worker unsnoozes parent",
  );
});
