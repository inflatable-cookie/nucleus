import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost, type T3CodeConfig } from "../hosts/t3code/adapter";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import { identity } from "../hosts/t3code/intents";
import { canonical } from "../hosts/t3code/state";
import type { AcpSessionSurface } from "../shared/acp/surface";
import type { HostAgentSpec } from "../shared/host";
import type { Profile, Task } from "../shared/contracts";
import {
  syntheticRun,
  syntheticRuntimeRequest,
  syntheticTurnItem,
  t3Fake,
  STAMP,
} from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";

/**
 * nucleus#1459: a finished task's parent is archived from its durable parent binding
 * by the host pass's own terminal step, so a done task never stays in the operator's
 * T3 snoozed list because an Inbox, row or sibling read failed, timed out or was lost
 * with the process. These cases drive the real T3 host against the private synthetic
 * nightly: the recorded commands, their identities and the binding's own typed record
 * are what is asserted. Nothing here is a live probe.
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

const nucleusProvider = {
  instanceId: PARENT_PROVIDER,
  displayName: "Nucleus",
  driver: "acpRegistry",
  enabled: true,
  status: "ready",
  models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
};

/** The parent's held turn is released locally; the nightly ends the run with it. */
function acpStub(
  server: Awaited<ReturnType<typeof t3Fake>>,
  inboxDirectory: string,
) {
  const released: Array<{ sessionId: string; reason: string }> = [];
  const surface: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/sessions/${input.taskId}.json`,
    }),
    bindInbox: ({ hostId }) => ({
      sessionId: "session:inbox",
      hostId,
      directory: inboxDirectory,
      bindingPath: `${inboxDirectory}/binding.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release(sessionId, reason) {
      released.push({ sessionId, reason });
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
  const root = await realpath(
    mkdtempSync(join(tmpdir(), "t3code-parent-archive-")),
  );
  const server = await t3Fake(t, root);
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
  const acp = acpStub(server, join(root, "inbox"));
  mkdirSync(join(root, "inbox"));
  const options: T3CodeConfig = {
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 2_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 300,
  };
  const host = new T3CodeHost(options);
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory: root,
    project: { projectId: "synthetic-project" },
  });
  const spec = (taskId: string, runId: string): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: "Synthetic task",
    taskNumber: 1459,
    mcpBindingPath: null,
    attempt: () => ({
      requestId: runId,
      prompt: "Worker prompt",
      labels: storedT3Labels("worker", { taskId, runId }),
      environment: {},
    }),
  });
  /** The parent this host binds for a task, after its worker child is created. */
  const parentFor = async (taskId = "synthetic-task") => {
    await host.createAgent(spec(taskId, `${taskId}-worker`));
    return Object.values(host.state.read().parents ?? {}).find(
      (parent) => parent.taskId === taskId,
    )!;
  };
  return { root, server, host, options, workspace, acp, parentFor };
}

type Server = Awaited<ReturnType<typeof t3Fake>>;

const commandsOf = (server: Server, type: string) =>
  server.commands.filter(
    (command) => (command.type ?? command.method) === type,
  );
const since = (server: Server, before: number) => server.commands.slice(before);
/** Every worker child's turns finish, as a provider turn does when its run ends. */
const finishChildren = (host: T3CodeHost, server: Server) => {
  for (const threadId of Object.keys(host.state.read().agents)) {
    const thread = server.threads.get(threadId);
    if (!thread) continue;
    for (const run of thread.runs)
      if (run.status === "running") run.status = "completed";
  }
  for (const thread of server.threads.values())
    for (const task of thread.subagents ?? []) task.status = "completed";
};
const doneTask = (
  host: T3CodeHost,
  id = "synthetic-task",
  extra: Partial<Task> = {},
) =>
  ({
    id,
    hostId: host.hostId,
    phase: "done",
    removedAt: null,
    ...extra,
  }) as unknown as Task;
const parentArchiveCommand = (host: T3CodeHost, threadId: string) =>
  identity("parent-archive", canonical([host.hostId, threadId]));

test("a stored done task whose workspace is retired archives its snoozed parent from the binding", async (t) => {
  const { server, host, workspace, acp, parentFor } = await fixture(t);
  const parent = await parentFor();
  finishChildren(host, server);
  // The operator's own snooze on the finished parent, and the task's own workspace
  // handle retired before the parent is archived: neither may hide the obligation.
  const remote = server.threads.get(parent.threadId)!.thread;
  remote.snoozedUntil = "2099-01-01T00:00:00.000Z";
  remote.snoozedAt = STAMP;
  await host.workspaceRef(workspace.id).archive("synthetic-workspace-retire");
  assert.equal(
    host.state.read().workspaces[workspace.id]?.archivedAt != null,
    true,
  );

  const before = server.commands.length;
  const waits = await host.reconcileFinishedParents([doneTask(host)]);
  assert.deepEqual(waits, [], "the archived parent settles with no wait");

  assert.equal(remote.archivedAt, STAMP, "T3 shows the same parent archived");
  const archived = commandsOf(server, "thread.archive").filter(
    (command) => command.threadId === parent.threadId,
  );
  assert.equal(archived.length, 1);
  assert.equal(
    archived[0]!.commandId,
    parentArchiveCommand(host, parent.threadId),
  );
  assert.equal(
    commandsOf(server, "thread.unsnooze").length,
    0,
    "a snooze is retired by the archive, never rewritten",
  );
  assert.equal(
    commandsOf(server, "thread.settle").length,
    0,
    "Nucleus never settles",
  );
  assert.deepEqual(
    since(server, before).map((command) => command.type ?? command.method),
    ["thread.archive"],
    "the terminal step sends only the parent's own archive",
  );
  assert.deepEqual(
    acp.released.map((entry) => entry.sessionId),
    [parent.sessionId],
    "the finished parent's held turn is released first",
  );
  assert.notEqual(
    host.state.read().parents![parent.taskId]!.archivedAt,
    undefined,
  );
  assert.equal(host.state.read().parents![parent.taskId]!.archive, undefined);

  // A second pass owes nothing: the observation, not a resend, settled it.
  const again = server.commands.length;
  assert.deepEqual(await host.reconcileFinishedParents([doneTask(host)]), []);
  assert.equal(since(server, again).length, 0);
});

test("a failing Inbox read does not strand the finished parent", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const parent = await parentFor();
  // The Inbox exists, and T3 shows it deleted: the presentation pass refuses on its
  // first read, which is exactly the fault that used to starve the parent archive.
  await host.reconcileThreadTitles([]);
  const inbox = host.state.read().inbox!;
  // The tombstone is the shell shape that carries `deletedAt`, so the inbox read sees it.
  server.controls.shellTombstones = true;
  server.threads.get(inbox.threadId)!.thread.deletedAt = STAMP;
  finishChildren(host, server);

  // The host pass's own order: the terminal step, then the presentation steps.
  await host.reconcileFinishedParents([doneTask(host)]);
  await assert.rejects(
    () => host.reconcileThreadTitles([doneTask(host)]),
    /Nucleus inbox is deleted or archived/,
  );

  assert.equal(server.threads.get(parent.threadId)!.thread.archivedAt, STAMP);
  assert.notEqual(
    host.state.read().parents![parent.taskId]!.archivedAt,
    undefined,
  );
  assert.equal(commandsOf(server, "thread.archive").length, 1);
});

test("a sibling parent's transient read fault stays that parent's wait", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const first = await parentFor("synthetic-task");
  const second = await parentFor("synthetic-task-b");
  finishChildren(host, server);
  // One projection read fails: the parent it belongs to waits, the other archives.
  server.controls.threadProjectionErrors = 1;

  const waits = await host.reconcileFinishedParents([
    doneTask(host, "synthetic-task"),
    doneTask(host, "synthetic-task-b"),
  ]);
  assert.equal(waits.length, 1, "exactly the parent whose read failed waits");
  assert.equal(waits[0]!.state, "read_failed");
  const waiting = waits[0]!.threadId === first.threadId ? first : second;
  const archived = waiting === first ? second : first;
  assert.equal(server.threads.get(waiting.threadId)!.thread.archivedAt, null);
  assert.equal(server.threads.get(archived.threadId)!.thread.archivedAt, STAMP);
  assert.equal(
    host.state.read().parents![waiting.taskId]!.archive?.state,
    "read_failed",
    "the binding keeps the typed reason across a roll",
  );
  assert.equal(
    host.state.read().parents![archived.taskId]!.archive,
    undefined,
    "the settled binding keeps no wait",
  );

  // The next pass reads again and settles the one that waited.
  assert.deepEqual(
    await host.reconcileFinishedParents([
      doneTask(host, "synthetic-task"),
      doneTask(host, "synthetic-task-b"),
    ]),
    [],
  );
  assert.equal(server.threads.get(waiting.threadId)!.thread.archivedAt, STAMP);
});

test("a service roll settles a parent archive whose reply was lost by reading the same thread", async (t) => {
  const { server, host, options, parentFor } = await fixture(t);
  const parent = await parentFor();
  finishChildren(host, server);
  // The archive lands and its reply is lost with the process: unknown delivery.
  server.controls.disconnectAfterEffect = true;
  const waits = await host.reconcileFinishedParents([doneTask(host)]);
  server.controls.disconnectAfterEffect = false;
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.state, "unknown");
  assert.equal(server.threads.get(parent.threadId)!.thread.archivedAt, STAMP);
  assert.equal(commandsOf(server, "thread.archive").length, 1);
  assert.equal(
    host.state.read().parents![parent.taskId]!.archivedAt,
    undefined,
  );
  host.close();

  // The rolled service reads the same binding and the same thread: the recorded
  // intent is observed, never resent.
  const rolled = new T3CodeHost(options);
  t.after(() => rolled.close());
  await rolled.connect();
  assert.deepEqual(
    await rolled.reconcileFinishedParents([doneTask(rolled)]),
    [],
  );
  assert.equal(
    commandsOf(server, "thread.archive").length,
    1,
    "the archive is never resent",
  );
  assert.notEqual(
    rolled.state.read().parents![parent.taskId]!.archivedAt,
    undefined,
  );
  assert.equal(rolled.state.read().parents![parent.taskId]!.archive, undefined);
});

test("a retired child with held initial work cannot strand a rejected parent archive", async (t) => {
  const { server, host, options, parentFor } = await fixture(t);
  const parent = await parentFor();
  const remote = server.threads.get(parent.threadId)!;
  const delegated = remote.subagents[0]!;
  const childId = delegated.childThreadId;
  const child = server.threads.get(childId)!;
  const runId = "run:thread:synthetic:ordinal:1";
  child.runs = [
    syntheticRun(childId, 1, {
      id: runId,
      status: "queued",
      queueHeld: false,
      startedAt: null,
      completedAt: null,
      userMessageId: `message:${delegated.id.slice("node:".length)}`,
    }),
  ];
  remote.thread.snoozedUntil = "2099-01-01T00:00:00.000Z";
  remote.pendingBackgroundTasks = [
    {
      kind: "subagent",
      taskId: delegated.id.replace("node:", "turn-item:"),
      childThreadId: childId,
    },
  ];
  const rejected = parentArchiveCommand(host, parent.threadId);
  const dispose = identity(
    "dispose",
    canonical([host.hostId, parent.threadId, delegated.id]),
  );
  delegated.completionDelivery = { state: "pending", observedByRunId: null };
  server.controls.rejectedArchives.push(rejected);
  server.controls.archiveChecksDelegatedTasks = true;
  host.state.update((state) => {
    const { workspaceId, labels, parentThreadId } = state.agents[childId]!;
    state.retiredAgents = {
      ...state.retiredAgents,
      [childId]: { workspaceId, labels, parentThreadId },
    };
    delete state.agents[childId];
    const disposal = state.intents[dispose]!;
    disposal.status = "unknown";
    disposal.timedOut = true;
    delete disposal.result;
    state.intents[rejected] = {
      status: "unknown",
      kind: "thread.archive",
      threadId: parent.threadId,
      timedOut: true,
      payload: canonical({
        method: "orchestration.dispatchCommand",
        payload: {
          type: "thread.archive",
          threadId: parent.threadId,
          commandId: rejected,
        },
      }),
      diagnostic: {
        command: "thread.archive",
        reason: "OrchestrationV2DispatchCommandError",
      },
    };
  });
  const task = doneTask(host);
  const active = await host.reconcileFinishedParents([task]);
  assert.match(active[0]!.reason, /active work/);
  assert.equal(commandsOf(server, "queued-run.cancel").length, 0);
  assert.equal(commandsOf(server, "thread.archive").length, 0);
  assert.equal(
    commandsOf(server, "delegated_task.completion-delivery.dispose").length,
    1,
  );

  child.runs[0]!.queueHeld = true;
  server.controls.shellStatuses[childId] = "idle";
  const beforeClearing = server.commands.length;
  const clearing = await host.reconcileFinishedParents([task]);
  assert.equal(clearing[0]!.state, "unobserved");
  assert.equal(delegated.completionDelivery.state, "disposed");
  assert.deepEqual(
    since(server, beforeClearing).map((command) => command.type),
    ["delegated_task.completion-delivery.dispose", "queued-run.cancel"],
  );
  assert.deepEqual(
    commandsOf(server, "delegated_task.completion-delivery.dispose").map(
      (command) => command.commandId,
    ),
    [dispose, dispose],
  );
  assert.equal(child.runs[0]!.status, "cancelled");
  assert.deepEqual(
    commandsOf(server, "queued-run.cancel").map((command) => command.runId),
    [runId],
  );
  assert.equal(commandsOf(server, "thread.archive").length, 0);

  const replay = await host.reconcileFinishedParents([task]);
  assert.equal(replay[0]!.state, "unknown");
  assert.deepEqual(
    commandsOf(server, "thread.archive").map((command) => command.commandId),
    [rejected],
  );
  host.close();

  const rolled = new T3CodeHost(options);
  t.after(() => rolled.close());
  await rolled.connect();
  assert.deepEqual(await rolled.reconcileFinishedParents([task]), []);
  assert.equal(remote.thread.archivedAt, STAMP);
  const successor =
    rolled.state.read().parents![parent.taskId]!.archiveCommandId;
  assert.ok(successor && successor !== rejected);
  assert.deepEqual(
    commandsOf(server, "thread.archive").map((command) => command.commandId),
    [rejected, successor],
  );
  assert.equal(commandsOf(server, "thread.settle").length, 0);
});

test("an idle child with background work or a pending user question keeps the archive waiting", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const parent = await parentFor();
  const remote = server.threads.get(parent.threadId)!;
  const childId = remote.subagents[0]!.childThreadId;
  const child = server.threads.get(childId)!;
  child.runs = [];
  child.thread.forkedFrom = null;
  child.pendingBackgroundTasks = [];
  child.turnItems = [
    syntheticTurnItem(childId, 1, {
      type: "command_execution",
      status: "running",
      exitCode: null,
      completedAt: null,
    }),
  ];
  const task = doneTask(host);
  const assertWaiting = async () => {
    const before = server.commands.length;
    const waits = await host.reconcileFinishedParents([task]);
    assert.match(waits[0]!.reason, /active work/);
    assert.deepEqual(since(server, before), []);
  };
  await assertWaiting();

  child.turnItems[0]!.status = "completed";
  child.pendingBackgroundTasks = [
    { kind: "command", taskId: "synthetic-shell-only" },
  ];
  await assertWaiting();

  child.pendingBackgroundTasks = [];
  const requestId = "synthetic-child-question";
  child.runtimeRequests = [syntheticRuntimeRequest({ id: requestId })];
  child.turnItems.push(
    syntheticTurnItem(childId, 2, {
      type: "user_input_request",
      status: "waiting",
      requestId,
      completedAt: null,
    }),
  );
  await assertWaiting();

  child.runtimeRequests[0]!.status = "resolved";
  child.turnItems[1]!.status = "completed";
  assert.equal(
    (await host.reconcileFinishedParents([task]))[0]!.state,
    "unobserved",
  );
  assert.equal(commandsOf(server, "subagent.stop").length, 1);
  assert.deepEqual(await host.reconcileFinishedParents([task]), []);
  assert.equal(remote.thread.archivedAt, STAMP);
});

test("a pending background item for an idle orphan clears through the delegated record", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const parent = await parentFor();
  const remote = server.threads.get(parent.threadId)!;
  const delegated = remote.subagents[0]!;
  const child = server.threads.get(delegated.childThreadId)!;
  child.runs = [];
  child.thread.forkedFrom = null;
  remote.turnItems.push({
    id: delegated.id.replace("node:", "turn-item:"),
    runId: delegated.runId,
    nodeId: delegated.id,
    type: "subagent",
    status: "running",
    subagentId: delegated.id,
  });
  remote.pendingBackgroundTasks = [
    {
      kind: "subagent",
      taskId: remote.turnItems.at(-1)!.id,
      childThreadId: delegated.childThreadId,
    },
  ];
  server.controls.archiveChecksDelegatedTasks = true;
  const task = doneTask(host, parent.taskId, { phase: "cancelled" });
  assert.equal(
    (await host.reconcileFinishedParents([task]))[0]!.state,
    "unobserved",
  );
  assert.equal(delegated.status, "cancelled");
  assert.equal(commandsOf(server, "subagent.stop").length, 1);
  assert.deepEqual(await host.reconcileFinishedParents([task]), []);
  assert.equal(remote.thread.archivedAt, STAMP);
  assert.equal(commandsOf(server, "thread.settle").length, 0);
});

test("a nonterminal task, a shared binding and a role thread are never archived", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const parent = await parentFor();
  finishChildren(host, server);
  const child = Object.keys(host.state.read().agents)[0]!;

  // A twin record claims the same thread: neither is a proved single identity.
  host.state.update((state) => {
    state.parents!["synthetic-task-twin"] = {
      ...state.parents!["synthetic-task"]!,
    };
  });
  const sharedWaits = await host.reconcileFinishedParents([doneTask(host)]);
  assert.equal(sharedWaits.length, 1);
  assert.equal(sharedWaits[0]!.state, "mismatched");
  assert.match(sharedWaits[0]!.reason, /more than one task/);

  // An unarchived twin is still never archived by a nonterminal task either.
  host.state.update((state) => {
    delete state.parents!["synthetic-task-twin"];
  });
  assert.deepEqual(
    await host.reconcileFinishedParents([
      {
        id: "synthetic-task",
        hostId: host.hostId,
        phase: "working",
        removedAt: null,
      } as unknown as Task,
    ]),
    [],
  );

  // A binding that points at a role thread is not this task's parent thread.
  host.state.update((state) => {
    state.parents!["synthetic-task"]!.threadId = child;
  });
  const roleWaits = await host.reconcileFinishedParents([doneTask(host)]);
  assert.equal(roleWaits.length, 1);
  assert.equal(roleWaits[0]!.state, "mismatched");
  assert.match(roleWaits[0]!.reason, /not this task's parent thread/);

  assert.equal(commandsOf(server, "thread.archive").length, 0);
  assert.equal(server.threads.get(parent.threadId)!.thread.archivedAt, null);
});

test("a parent whose thread reports another checkout is a typed wait, never an archive", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const parent = await parentFor();
  finishChildren(host, server);
  server.threads.get(parent.threadId)!.thread.providerInstanceId =
    "other-provider";

  const waits = await host.reconcileFinishedParents([doneTask(host)]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.state, "mismatched");
  assert.match(waits[0]!.reason, /checkout and provider/);
  assert.equal(commandsOf(server, "thread.archive").length, 0);
  assert.equal(
    host.state.read().parents![parent.taskId]!.archive?.state,
    "mismatched",
  );
});

/**
 * Spec 069 §4: the host pass hands only a page of finished tasks, so the obligation is
 * selected from the open bindings and each task resolved through the store's
 * single-task read. Six finishes in one interval (more than one batch) are all archived
 * over the following passes with an empty task list, and a binding whose task is not
 * finished is left alone.
 */
test("open bindings resolved through the lookup archive every finish over passes, batch by batch", async (t) => {
  const { server, host, parentFor } = await fixture(t);
  const finished = [
    "finish-1",
    "finish-2",
    "finish-3",
    "finish-4",
    "finish-5",
    "finish-6",
  ];
  const parents: Array<{ threadId: string }> = [];
  for (const id of finished) parents.push(await parentFor(id));
  const live = await parentFor("still-working");
  finishChildren(host, server);
  const lookup = (taskId: string) =>
    taskId === "still-working"
      ? doneTask(host, taskId, { phase: "working" } as Partial<Task>)
      : finished.includes(taskId)
        ? doneTask(host, taskId)
        : null;
  const archived = () =>
    parents.filter(
      (parent) => server.threads.get(parent.threadId)!.thread.archivedAt,
    ).length;
  assert.deepEqual(await host.reconcileFinishedParents([], lookup), []);
  assert.equal(archived(), 4, "one pass archives one batch");
  assert.deepEqual(await host.reconcileFinishedParents([], lookup), []);
  assert.equal(
    archived(),
    6,
    "the next pass archives the rest; none was dropped",
  );
  assert.equal(
    server.threads.get(live.threadId)!.thread.archivedAt ?? null,
    null,
    "a live task's parent is never archived",
  );
});
