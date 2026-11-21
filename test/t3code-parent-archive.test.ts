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
import { t3Fake, STAMP } from "./support/t3code-fake";
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
