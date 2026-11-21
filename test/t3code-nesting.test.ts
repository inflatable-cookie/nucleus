import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { decode } from "../hosts/t3code/contracts";
import { projection } from "../hosts/t3code/contracts";
import { proposedOwner } from "../core/acp/decisions";
import {
  HOLD_MARKER,
  PARENT_MODEL,
  PARENT_PROVIDER,
  childTaskId,
  childThreadId,
  parentPromptRules,
} from "../hosts/t3code/nesting";
import type { AcpSessionSurface } from "../shared/acp/surface";
import {
  HostSnapshotPendingError,
  ProvenPreSendRefusalError,
} from "../core/host";
import type { HostAgentSpec } from "../shared/host";
import type { Profile, Task } from "../shared/contracts";
import {
  t3Fake,
  STAMP,
  syntheticRuntimeRequest,
  syntheticTurnItem,
  threadProjection,
} from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";
import { HostReadRefusalError } from "../core/host";

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

/**
 * The Nucleus ACP provider instance an operator registers in T3's settings. The
 * nightly lists it beside every other provider, with the models its `session/new`
 * answered (`nucleus` and `nucleus-quiet`, Spec 065).
 */
const nucleusProvider = {
  instanceId: PARENT_PROVIDER,
  displayName: "Nucleus",
  driver: "acpRegistry",
  enabled: true,
  status: "ready",
  models: [
    { slug: PARENT_MODEL, name: "Nucleus" },
    { slug: "nucleus-quiet", name: "Nucleus (quiet)" },
  ],
};

/**
 * The service's ACP session surface, as the T3 host sees it: minting records the
 * prompt rules the launched agent reads, and `release` ends the parent's held turn —
 * here by completing the live run of the parent thread, which is what the ACP agent
 * does when the service answers `release`.
 */
function acpStub(server: Awaited<ReturnType<typeof t3Fake>>) {
  const bindings: Array<{
    taskId: string;
    sessionId: string;
    ignorePattern?: string;
    holdPattern?: string;
  }> = [];
  const released: Array<{ sessionId: string; reason: string }> = [];
  const endHeldTurns = () => {
    for (const thread of server.threads.values()) {
      if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
      for (const run of thread.runs)
        if (
          ["preparing", "starting", "running", "waiting"].includes(run.status)
        )
          run.status = "completed";
    }
  };
  const surface: AcpSessionSurface = {
    bind(input) {
      const sessionId = `session:${input.taskId}`;
      bindings.push({
        taskId: input.taskId,
        sessionId,
        ...(input.ignorePattern ? { ignorePattern: input.ignorePattern } : {}),
        ...(input.holdPattern ? { holdPattern: input.holdPattern } : {}),
      });
      return {
        sessionId,
        taskId: input.taskId,
        bindingPath: `/synthetic/acp/sessions/${input.taskId}.json`,
      };
    },
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release(sessionId, reason) {
      released.push({ sessionId, reason });
      endHeldTurns();
    },
  };
  return { surface, bindings, released };
}

async function fixture(
  t: TestContext,
  options: { provider?: boolean; runOnLaunch?: boolean } = {},
) {
  const root = await realpath(mkdtempSync(join(tmpdir(), "t3code-nesting-")));
  const server = await t3Fake(t, root);
  if (options.provider !== false)
    server.controls.providers = [
      nucleusProvider,
      {
        instanceId: "synthetic-provider",
        displayName: "Synthetic provider",
        driver: "codex",
        enabled: true,
        status: "ready",
        models: [
          { slug: "synthetic-model", name: "Synthetic model" },
          { slug: "synthetic-model-2", name: "Synthetic model two" },
        ],
      },
    ];
  server.controls.runOnLaunch = options.runOnLaunch !== false;
  server.controls.parentHeldTurn = options.runOnLaunch !== false;
  const acp = acpStub(server);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  await host.connect();
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory: root,
    project: { projectId: "synthetic-project" },
  });
  const spec = (
    requestId: string,
    prompt: string,
    role = "worker",
  ): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile,
    title: role === "worker" ? "Synthetic task" : `${role}: Synthetic task`,
    taskNumber: 1305,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt,
      labels: storedT3Labels(role, {
        runId: role === "worker" ? "worker-run" : `${role}-run`,
      }),
      environment: {},
    }),
  });
  return { root, server, host, workspace, spec, acp };
}

const parentOf = (host: T3CodeHost) =>
  Object.values(host.state.read().parents ?? {})[0];
/** Every recorded role child's runs finish, as a provider turn does when a run ends. */
const finishChildren = (
  host: T3CodeHost,
  server: Awaited<ReturnType<typeof t3Fake>>,
) => {
  for (const threadId of Object.keys(host.state.read().agents)) {
    const thread = server.threads.get(threadId);
    if (!thread) continue;
    for (const run of thread.runs)
      if (run.status === "running") run.status = "completed";
  }
};
/** One recorded command by dispatch type, or by method for a launch (which carries no `type`). */
const commandOf = (server: Awaited<ReturnType<typeof t3Fake>>, type: string) =>
  server.commands.find((command) => (command.type ?? command.method) === type);
const commandsOf = (server: Awaited<ReturnType<typeof t3Fake>>, type: string) =>
  server.commands.filter(
    (command) => (command.type ?? command.method) === type,
  );

test("the connect probe records whether the nucleus ACP provider is there, before any task", async (t) => {
  const { host } = await fixture(t);
  assert.equal(host.state.read().nesting?.state, "nested");
  assert.match(
    host.nativeParentingStatus,
    /native parenting on the nucleus ACP provider/,
  );
  assert.equal(
    host.state.read().parents,
    undefined,
    "a read-only probe records no parent thread",
  );
  const missing = await fixture(t, { provider: false });
  assert.equal(missing.host.state.read().nesting?.state, "unavailable");
  assert.match(
    missing.host.state.read().nesting!.reason,
    /T3 provider not ready: T3Code has no nucleus ACP provider instance; run `nucleus t3 install`/,
  );
  assert.match(
    missing.host.nativeParentingStatus,
    /native parenting unavailable.*no nucleus ACP provider/,
  );
  const pending = await fixture(t, { provider: false });
  pending.server.controls.providerInstances = {
    nucleus: { driver: "acpRegistry", enabled: true },
  };
  await pending.host.connect();
  assert.match(
    pending.host.nativeParentingStatus,
    /registered but not ready.*status unknown/,
  );
  const warning = await fixture(t, { provider: false });
  warning.server.controls.providers = [
    { ...nucleusProvider, status: "warning", message: "The probe failed" },
  ];
  await warning.host.connect();
  assert.match(
    warning.host.nativeParentingStatus,
    /registered but not ready.*warning.*The probe failed/,
  );
});

test("the first role launches the task parent on the nucleus ACP provider and runs as its child", async (t) => {
  const { host, server, acp, spec, workspace } = await fixture(t);
  const created = await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  assert.ok(parent, "the task records its parent thread");
  assert.ok(
    server.threads.has(parent.threadId),
    "the parent thread exists in the host catalog",
  );

  // The parent: the Nucleus ACP provider, the task's own checkout, and a title the
  // task's own state sync will own from then on.
  const launch = server.commands[0]!;
  assert.equal(launch.method, "orchestration.launchThread");
  assert.equal(launch.threadId, parent.threadId);
  assert.deepEqual(launch.modelSelection, {
    instanceId: PARENT_PROVIDER,
    model: PARENT_MODEL,
  });
  assert.deepEqual(launch.workspaceStrategy, {
    type: "existing_worktree",
    worktreePath: workspace.directory,
  });
  assert.equal(launch.runtimeMode, "full-access");

  // The binding is minted before the launch, with the host's prompt rules: the
  // agent's own configuration, never text it parses.
  assert.equal(acp.bindings.length, 1);
  assert.equal(acp.bindings[0]!.taskId, "synthetic-task");
  // The hold rule is anchored and escaped, so it matches exactly the sentence this host sends.
  assert.equal(acp.bindings[0]!.holdPattern, parentPromptRules().holdPattern);
  assert.match(HOLD_MARKER, new RegExp(acp.bindings[0]!.holdPattern!));
  assert.doesNotMatch(HOLD_MARKER, /nucleus-hold|task-/);
  assert.match(acp.bindings[0]!.ignorePattern!, /delegated-task/);

  // The role: a native child of that parent's live run, with the profile's own
  // provider and model, no workspace strategy (it inherits the parent's checkout)
  // and a completion wake that cannot reach the parent agent.
  const request = commandOf(server, "delegated_task.request")!;
  const parentProjection = server.threads.get(parent.threadId)!;
  const liveRun = parentProjection.runs.find(
    (run: Record<string, unknown>) => run.id === request.parentRunId,
  )!;
  assert.equal(liveRun.rootNodeId, request.parentNodeId);
  assert.equal(request.parentThreadId, parent.threadId);
  assert.equal(request.task, "Do the work");
  assert.deepEqual(request.modelSelection, {
    instanceId: "synthetic-provider",
    model: "synthetic-model",
  });
  assert.equal(request.completionWake, "settled_only");
  assert.equal(request.runtimeMode, "full-access");
  assert.equal(created.id, childThreadId(request.commandId));
  assert.equal(created.workspaceId, workspace.id);
  assert.equal(
    server.commands.some(
      (command) =>
        command.workspaceStrategy !== undefined &&
        command.type === "delegated_task.request",
    ),
    false,
  );

  // Creation disposes the child's completion delivery under the derived task id.
  const dispose = commandOf(
    server,
    "delegated_task.completion-delivery.dispose",
  )!;
  assert.equal(dispose.taskId, childTaskId(request.commandId));
  assert.equal(dispose.parentThreadId, parent.threadId);
  assert.equal(
    parentProjection.subagents![0]!.completionDelivery.state,
    "disposed",
  );

  // And the child is the run's agent: recorded labels, observation and the unread
  // worker row all point at it, while the parent stays out of `findAgents`.
  assert.deepEqual(
    (await host.findAgents({ "nucleus.task": "synthetic-task" })).map(
      (agent) => agent.id,
    ),
    [created.id],
  );
  assert.equal((await host.observe(created.id)).workspaceId, workspace.id);
  assert.equal(host.state.read().nesting?.state, "nested");
});

test("a released parent is re-entered by message before the next child, and disposed for that follow-up", async (t) => {
  const { host, server, acp, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  // A parent persisted before the readable prompt has no holdText and an old binding.
  host.state.update((state) => {
    delete state.parents!["synthetic-task"]!.holdText;
  });
  // The worker finished: the sweep releases the held turn, as the ACP agent ends it.
  finishChildren(host, server);
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "working" } as Task,
  ]);
  assert.deepEqual(
    acp.released.map((entry) => entry.sessionId),
    [parent.sessionId],
  );
  const heldRun = server.threads.get(parent.threadId)!.runs.at(-1)!;
  assert.equal(heldRun.status, "completed");

  const reviewer = await host.createAgent(
    spec("review-run", "Review it", "reviewer"),
  );
  const hold = commandsOf(server, "message.dispatch").find(
    (command) => command.threadId === parent.threadId,
  )!;
  assert.ok(hold, "the parent is re-entered by a message");
  assert.equal(hold.text, HOLD_MARKER);
  assert.doesNotMatch(hold.text, /nucleus-hold|synthetic-task/);
  const run = server.threads.get(parent.threadId)!.runs.at(-1)!;
  assert.equal(run.status, "running");
  const request = commandsOf(server, "delegated_task.request").at(-1)!;
  assert.equal(
    request.parentRunId,
    run.id,
    "the child is anchored on the re-entered run",
  );
  assert.equal(request.parentNodeId, run.rootNodeId);
  assert.equal(reviewer.id, childThreadId(request.commandId));

  // A follow-up to the retained child records a new delegated task, and Nucleus
  // disposes it itself: T3 leaves a follow-up's wake pending.
  await host.sendMessage(reviewer.id, {
    messageId: "review-followup",
    text: "One more look",
  });
  const followUpDispose = commandsOf(
    server,
    "delegated_task.completion-delivery.dispose",
  ).find((command) => command.taskId === childTaskId("review-followup"))!;
  assert.ok(followUpDispose, "the follow-up completion delivery is disposed");
  const followUp = server.threads
    .get(parent.threadId)!
    .subagents!.find(
      (child: Record<string, unknown>) =>
        child.id === childTaskId("review-followup"),
    )!;
  assert.equal(followUp.childThreadId, reviewer.id);
  assert.equal(followUp.completionDelivery.state, "disposed");
});

test("a parent with no live turn releases nothing, and the sweep releases one turn once", async (t) => {
  const { host, server, acp, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  // The worker child is live: the parent keeps its held turn.
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "working" } as Task,
  ]);
  assert.equal(acp.released.length, 0, "a live child keeps the held turn");
  // The child finishes while the parent still holds its turn: the sweep releases,
  // and a second pass sends nothing more.
  finishChildren(host, server);
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "working" } as Task,
  ]);
  assert.deepEqual(
    acp.released.map((entry) => entry.sessionId),
    [parent.sessionId],
  );
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "working" } as Task,
  ]);
  assert.equal(acp.released.length, 1, "one release per held turn");
  // The terminal step archives a finished task's parent, never the shared project or the
  // child, and it does so from the parent binding rather than the row pass (nucleus#1459).
  await host.reconcileFinishedParents([
    { id: "synthetic-task", hostId: host.hostId, phase: "done" } as Task,
  ]);
  assert.notEqual(server.threads.get(parent.threadId)!.thread.archivedAt, null);
  assert.notEqual(parentOf(host)?.archivedAt, undefined);
  // The presentation pass leaves the archived parent alone.
  await host.reconcileThreadTitles([
    { id: "synthetic-task", hostId: host.hostId, phase: "done" } as Task,
  ]);
  assert.equal(commandsOf(server, "thread.archive").length, 1);
});

test("child questions and permissions are answered on the child, never through the parent", async (t) => {
  const { host, server, spec } = await fixture(t);
  const created = await host.createAgent(spec("worker-create", "Do the work"));
  const child = server.threads.get(created.id)!;
  child.runtimeRequests.push(
    syntheticRuntimeRequest({
      id: "child-question",
      kind: "user_input",
      status: "pending",
    }),
  );
  child.turnItems.push(
    syntheticTurnItem(created.id, child.turnItems.length + 1, {
      type: "user_input_request",
      requestId: "child-question",
    }),
  );
  assert.deepEqual(await host.pendingQuestions(created.id), [
    {
      requestId: "child-question",
      questions: [
        {
          header: "Synthetic",
          question: "Synthetic question?",
          options: ["Yes", "No"],
        },
      ],
    },
  ]);
  await host.answerNativeQuestion(
    created.id,
    (await host.observe(created.id)).workspaceId!,
    "child-question",
    { Synthetic: "Yes" },
  );
  const answer = commandsOf(server, "runtime-request.respond").at(-1)!;
  assert.equal(answer.threadId, created.id);
  const questionId = child.turnItems.find(
    (item: Record<string, unknown>) => item.requestId === "child-question",
  )!.questions[0].id;
  assert.deepEqual(answer.answers, { [questionId]: ["Yes"] });

  child.runtimeRequests.push(
    syntheticRuntimeRequest({
      id: "child-permission",
      kind: "command",
      status: "pending",
    }),
  );
  await host.respondRuntimeRequest(
    created.id,
    (await host.observe(created.id)).workspaceId!,
    "child-permission",
    { decision: "accept" },
    "permission-intent",
  );
  const permission = commandsOf(server, "runtime-request.respond").at(-1)!;
  assert.equal(permission.threadId, created.id);
  assert.equal(permission.decision, "accept");
  assert.equal(
    commandsOf(server, "runtime-request.respond").some(
      (command) => command.threadId === parentOf(host)!.threadId,
    ),
    false,
  );
});

test("a reconnect re-enters the same parent thread rather than launching another", async (t) => {
  const { host, server, spec } = await fixture(t);
  const first = await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  // A T3 restart: this connection dies and the host proves identity again, with the
  // same durable state and the same parent thread.
  server.dropSockets();
  host.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.connect();
  const reviewer = await host.createAgent(
    spec("review-run", "Review it", "reviewer"),
  );
  assert.equal(parentOf(host)!.threadId, parent.threadId);
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "no second parent thread",
  );
  assert.equal(
    commandsOf(server, "delegated_task.request").at(-1)!.parentThreadId,
    parent.threadId,
  );
  assert.notEqual(reviewer.id, first.id);
});

test("without the nucleus provider the role refuses before the send and names the fix", async (t) => {
  const { host, server, spec } = await fixture(t, { provider: false });
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /T3 provider not ready: T3Code has no nucleus ACP provider instance; run `nucleus t3 install`/.test(
        error.reason,
      ),
  );
  // Nothing is launched at all: no parent and no top-level role thread. The task
  // waits visibly with the reason and the fix (nucleus#1366).
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  assert.equal(commandOf(server, "orchestration.launchThread"), undefined);
  assert.equal(host.state.read().parents, undefined);
  assert.equal(host.state.read().nesting?.state, "unavailable");
  assert.match(host.nativeParentingStatus, /native parenting unavailable/);
});

test("a deleted child does not hold the parent turn", async (t) => {
  const { host, server, acp, spec } = await fixture(t);
  const child = await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  // The terminal lane removed the child; absence from the complete inventory is the
  // positive fact, so the parent is released instead of holding forever.
  server.threads.get(child.id)!.thread.deletedAt = STAMP;
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "working" } as Task,
  ]);
  assert.deepEqual(
    acp.released.map((entry) => entry.sessionId),
    [parent.sessionId],
  );
});

test("a deletedAt tombstone in the inventory counts as deleted for a child and for the parent", async (t) => {
  const { host, server, acp, spec } = await fixture(t);
  // A nightly that keeps a removed thread's tombstone row instead of omitting it.
  server.controls.shellTombstones = true;
  const child = await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(child.id)!.thread.deletedAt = STAMP;
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "working" } as Task,
  ]);
  assert.deepEqual(
    acp.released.map((entry) => entry.sessionId),
    [parent.sessionId],
    "a tombstone child does not hold the turn",
  );
  // The shape proves itself: the shell the adapter just read listed the removed child
  // as a row, not by omission, so this case exercises the tombstone path and cannot
  // pass through absence (nucleus#1305 review).
  assert.ok(
    server.shells.some(
      (snapshot) =>
        snapshot.threads.includes(child.id) ||
        snapshot.archivedThreads.includes(child.id),
    ),
    "the fake served the removed child as a tombstone row",
  );

  // The parent itself as a tombstone: the next role refuses instead of sending to it
  // (there is no top-level fallback any more, nucleus#1366).
  server.threads.get(parent.threadId)!.thread.deletedAt = STAMP;
  const sentBefore = server.commands.length;
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review it", "reviewer")),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /parent thread is deleted; inspect the retained binding/.test(
        error.reason,
      ),
  );
  assert.ok(
    server.shells.some((snapshot) =>
      snapshot.threads.includes(parent.threadId),
    ),
    "the fake served the removed parent as a tombstone row",
  );
  assert.equal(
    server.commands
      .slice(sentBefore)
      .some((command) => command.threadId === parent.threadId),
    false,
    "nothing is sent to a tombstoned parent",
  );
  assert.match(host.state.read().nesting!.reason, /parent thread is deleted/);
  assert.notEqual(
    host.state.read().parents!["synthetic-task"]!.archivedAt,
    undefined,
  );
});

test("a role launched after its parent was archived refuses instead of re-launching it", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(parent.threadId)!.thread.archivedAt = STAMP;
  const launches = () =>
    commandsOf(server, "orchestration.launchThread").length;
  const before = launches();
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review it", "reviewer")),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /parent thread is archived; use an owner restart/.test(error.reason),
  );
  assert.equal(launches(), before, "the archived parent is not launched again");
  assert.equal(
    commandsOf(server, "delegated_task.request").length,
    1,
    "only the worker became a child",
  );
  assert.notEqual(
    host.state.read().parents!["synthetic-task"]!.archivedAt,
    undefined,
  );
});

test("a manually restored parent clears an older finished marker only after verifying its binding", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  const remote = server.threads.get(parent.threadId)!.thread;
  remote.archivedAt = STAMP;
  await assert.rejects(() =>
    host.createAgent(spec("review-archived", "Review", "reviewer")),
  );
  remote.archivedAt = null;
  await host.createAgent(spec("review-live", "Review", "reviewer"));
  assert.equal(
    host.state.read().parents![parent.taskId]!.archivedAt,
    undefined,
  );
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 2);
});

test("an older finished marker is reclassified when the parent was deleted", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  host.state.update((state) => {
    state.parents![parent.taskId]!.archivedAt = STAMP;
  });
  server.threads.delete(parent.threadId);
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review", "reviewer")),
    /parent thread is deleted/,
  );
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("a parent with a changed checkout is fenced even with an older finished marker", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  host.state.update((state) => {
    state.parents![parent.taskId]!.archivedAt = STAMP;
  });
  server.threads.get(parent.threadId)!.thread.worktreePath = "/synthetic/other";
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review", "reviewer")),
    /no longer matches/,
  );
  assert.equal(host.state.read().parents![parent.taskId]!.archivedAt, STAMP);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("the restart restore effect unarchives the same bound parent and reuses it", async (t) => {
  const { host, server, spec, workspace, acp } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(parent.threadId)!.thread.archivedAt = STAMP;
  const task = {
    id: parent.taskId,
    workspaceId: workspace.id,
    directory: workspace.directory,
    phase: "working",
    removedAt: null,
    resolution: { mergedCommit: null },
  } as Task;
  await host.nesting.restoreForRestart(task, "owner-operation", () => true);
  await host.nesting.restoreForRestart(task, "owner-operation", () => true);
  assert.equal(commandsOf(server, "thread.unarchive").length, 1);
  assert.equal(server.threads.get(parent.threadId)!.thread.archivedAt, null);
  await host.createAgent(spec("worker-next", "Continue"));
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 2);
  assert.equal(acp.bindings.length, 1);
});

test("a lost unarchive reply is reconciled by reading the same parent before any repeat", async (t) => {
  const { host, server, spec, workspace } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(parent.threadId)!.thread.archivedAt = STAMP;
  const task = {
    id: parent.taskId,
    workspaceId: workspace.id,
    directory: workspace.directory,
    phase: "working",
    removedAt: null,
    resolution: { mergedCommit: null },
  } as Task;
  server.controls.disconnectAfterEffect = true;
  await assert.rejects(() =>
    host.nesting.restoreForRestart(task, "operation-1", () => true),
  );
  server.controls.disconnectAfterEffect = false;
  await host.connect();
  assert.equal(
    await host.nesting.observeRestartRestore(task, "wrong-operation"),
    "not_found",
  );
  assert.equal(
    await host.nesting.observeRestartRestore(task, "operation-1"),
    "live",
  );
  await host.nesting.restoreForRestart(task, "operation-2", () => true);
  assert.equal(commandsOf(server, "thread.unarchive").length, 1);
  assert.equal(server.threads.get(parent.threadId)!.thread.archivedAt, null);
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
});

test("the restart restore effect refuses a changed binding and unknown prior delivery", async (t) => {
  const { host, server, spec, workspace } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  const remote = server.threads.get(parent.threadId)!.thread;
  const task = {
    id: parent.taskId,
    workspaceId: workspace.id,
    directory: workspace.directory,
    phase: "working",
    removedAt: null,
    resolution: { mergedCommit: null },
  } as Task;
  remote.archivedAt = STAMP;
  remote.providerInstanceId = "other";
  await assert.rejects(
    () => host.nesting.restoreForRestart(task, "operation-1", () => true),
    /binding/,
  );
  remote.providerInstanceId = PARENT_PROVIDER;
  host.state.update((state) => {
    state.intents["unknown-unarchive"] = {
      status: "unknown",
      kind: "thread.unarchive",
      threadId: parent.threadId,
      payload: "{}",
    };
  });
  await assert.rejects(
    () => host.nesting.restoreForRestart(task, "operation-2", () => true),
    /delivery remains unknown/,
  );
  assert.equal(commandsOf(server, "thread.unarchive").length, 0);
});

test("a routine sweep leaves a manually archived parent archived", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(parent.threadId)!.thread.archivedAt = STAMP;
  await host.reconcileThreadTitles([
    { id: parent.taskId, phase: "working" } as Task,
  ]);
  assert.equal(server.threads.get(parent.threadId)!.thread.archivedAt, STAMP);
  assert.equal(commandsOf(server, "thread.unarchive").length, 0);
  assert.equal(parentOf(host)?.threadId, parent.threadId);
});

test("a sweep retains a deleted nonterminal parent and never launches a replacement", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(parent.threadId)!.thread.deletedAt = STAMP;
  await host.nesting.reconcile([
    { id: parent.taskId, phase: "working" } as Task,
  ]);
  assert.equal(parentOf(host)?.threadId, parent.threadId);
  await assert.rejects(
    () => host.createAgent(spec("review-after-delete", "Review", "reviewer")),
    /parent thread is deleted/,
  );
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
});

test("a parent gone from the complete inventory refuses without sending anything", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.delete(parent.threadId);
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review it", "reviewer")),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /parent thread is deleted; inspect the retained binding/.test(
        error.reason,
      ),
  );
  assert.equal(
    commandsOf(server, "message.dispatch").some(
      (command) => command.threadId === parent.threadId,
    ),
    false,
    "nothing is sent to a parent that no longer exists",
  );
  assert.equal(
    commandsOf(server, "delegated_task.request").length,
    1,
    "no second child is created",
  );
});

test("a nucleus provider that is not an ACP driver refuses with guidance before any send", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.providers = [
    { ...nucleusProvider, driver: "codex" },
    {
      instanceId: "synthetic-provider",
      displayName: "Synthetic provider",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic" }],
    },
  ];
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /not an ACP provider \(the acpRegistry driver\); run `nucleus t3 install`/.test(
        error.reason,
      ),
  );
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  assert.equal(
    commandOf(server, "orchestration.launchThread"),
    undefined,
    "no top-level role thread is launched",
  );
});

test("a parent thread T3 will not run refuses the role instead of launching a top-level thread", async (t) => {
  const { host, server, spec } = await fixture(t, { runOnLaunch: false });
  // The parent launches, but its turn never starts: the bounded re-entry wait proves
  // it, and the role refuses with the reason instead of landing on a top-level thread.
  server.controls.runOnLaunch = false;
  const started = Date.now();
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /parent thread did not reach a live run; restart the task or move it to another host/.test(
        error.reason,
      ),
  );
  assert.ok(
    Date.now() - started >= 300,
    "the re-entry wait is bounded, not skipped",
  );
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "only the parent was launched, never a top-level role thread",
  );
  assert.deepEqual(
    Object.keys(host.state.read().agents),
    [],
    "no role thread is recorded for a refused create",
  );
});

test("a child command whose outcome is unknown is never resent under the same identity", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const before = commandsOf(server, "delegated_task.request").length;
  server.controls.refuseMutation = true;
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review it", "reviewer")),
    /Host delivery is unknown/,
  );
  const attempted = commandsOf(server, "delegated_task.request").length;
  assert.equal(attempted, before + 1, "the failed send reached the fake once");
  server.controls.refuseMutation = false;
  // The recorded outcome is unknown delivery: the same command is not sent again,
  // and the retry answers the unknown rather than inventing a second child.
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review it", "reviewer")),
    /Host delivery is unknown/,
  );
  assert.equal(commandsOf(server, "delegated_task.request").length, attempted);
});

test("the recorded delegated-task wire shapes decode into the projection", () => {
  const recorded = {
    thread: {
      id: "thread:delegated-task:nucleus-child-1",
      projectId: "synthetic-project",
      title: "Child",
      providerInstanceId: "synthetic-provider",
      modelSelection: {
        instanceId: "synthetic-provider",
        model: "synthetic-model",
      },
      runtimeMode: "full-access",
      settledOverride: null,
      settledAt: null,
      worktreePath: "/synthetic",
      branch: "synthetic",
      archivedAt: null,
      deletedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runs: [],
    runtimeRequests: [],
    turnItems: [],
    messages: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    subagents: [
      {
        id: "node:delegated-task:nucleus-child-1",
        threadId: "thread:parent",
        runId: "run:1",
        parentNodeId: "node:root:1",
        origin: "app_owned",
        createdBy: "user",
        driver: "codex",
        providerInstanceId: "synthetic-provider",
        providerThreadId: null,
        childThreadId: "thread:delegated-task:nucleus-child-1",
        nativeTaskRef: null,
        prompt: "Do the work",
        title: null,
        model: "synthetic-model",
        status: "running",
        result: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        completionDelivery: { state: "pending", observedByRunId: null },
      },
    ],
  };
  const decoded = decode(projection, recorded, "projection");
  assert.equal(decoded.subagents![0]!.completionDelivery!.state, "pending");
  assert.equal(
    decoded.subagents![0]!.childThreadId,
    "thread:delegated-task:nucleus-child-1",
  );
  // A missing delivery block is a well-formed older record, never a refusal.
  const older = decode(
    projection,
    {
      ...recorded,
      subagents: [{ ...recorded.subagents[0]!, completionDelivery: undefined }],
    },
    "projection",
  );
  assert.equal(older.subagents![0]!.completionDelivery, undefined);
});

test("a guard that turned false before the child send refuses it before delivery", async (t) => {
  const { host, server, spec } = await fixture(t);
  const guarded: HostAgentSpec = {
    ...spec("worker-create", "Do the work"),
    guard: { allowed: async () => true, stillAllowed: () => false },
  };
  await assert.rejects(
    () => host.createAgent(guarded),
    (error: unknown) => error instanceof ProvenPreSendRefusalError,
  );
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
});

test("a nested role's options come from its own provider, not the parent provider's model", async (t) => {
  const { host, server, spec, workspace } = await fixture(t);
  // The live shape: the Nucleus ACP parent provider reports models with no
  // options at all, and codex carries the role's level on `reasoningEffort`.
  // Judging the codex profile against the parent's model entry refused every
  // nested role launch on the pilot (nucleus#1375).
  server.controls.providers = [
    nucleusProvider,
    {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [
        {
          slug: "gpt-6.1-terra",
          name: "GPT-6.1 Terra",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low", isDefault: true },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
    },
  ];
  const codex: Profile = {
    ...profile,
    provider: "codex",
    model: "gpt-6.1-terra",
    thinkingOptionId: "high",
  };
  const created = await host.createAgent({
    ...spec("worker-create", "Do the work"),
    profile: codex,
  });
  const request = commandOf(server, "delegated_task.request")!;
  assert.deepEqual(request.modelSelection, {
    instanceId: "codex",
    model: "gpt-6.1-terra",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  assert.equal(created.id, childThreadId(request.commandId));
  assert.equal(
    parentOf(host)!.workspaceId,
    workspace.id,
    "the parent thread is still the task's own",
  );
});

test("a nested role whose provider has not settled its options waits before any parent is launched", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.providers = [
    { ...nucleusProvider },
    {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [
        {
          slug: "gpt-6.1-terra",
          name: "GPT-6.1 Terra",
          capabilities: { optionDescriptors: [] },
        },
      ],
    },
  ];
  const codex: Profile = {
    ...profile,
    provider: "codex",
    model: "gpt-6.1-terra",
    thinkingOptionId: "high",
  };
  await assert.rejects(
    () =>
      host.createAgent({
        ...spec("worker-create", "Do the work"),
        profile: codex,
      }),
    (error: unknown) => error instanceof HostSnapshotPendingError,
  );
  assert.equal(
    parentOf(host),
    undefined,
    "the fence runs before the parent thread exists, so no held turn is left behind",
  );
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
});

test("a nested role refuses a missing model on a settled provider before creating a parent", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.providers = [
    nucleusProvider,
    {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [
        {
          slug: "other",
          name: "Other",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
      ],
    },
  ];
  await assert.rejects(
    () =>
      host.createAgent({
        ...spec("worker-create", "Work"),
        profile: {
          ...profile,
          provider: "codex",
          model: "missing",
          thinkingOptionId: "high",
        },
      }),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /does not report model missing/.test(error.message),
  );
  assert.equal(parentOf(host), undefined);
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
});

test("decisionParent routes an archived parent to the Inbox and keeps a disconnected host unknown", async (t) => {
  const { host, server, spec } = await fixture(t);
  const taskId = "synthetic-task";
  const fakeStore = {
    taskOrNull: (id: string) =>
      id === taskId
        ? ({ id, hostId: host.hostId, removedAt: null } as Task)
        : null,
  } as unknown as import("../core/store/store").Store;
  const decision = {
    id: "11111111-1111-4111-8111-111111111199",
    version: 1,
    links: { tasks: [taskId] },
  } as unknown as import("../shared/contracts").Decision;
  const lookup = (_hostId: string, id: string) => host.decisionParent(id);

  assert.deepEqual(host.decisionParent(taskId), { state: "absent" });
  assert.deepEqual(proposedOwner(fakeStore, decision, host.hostId, lookup), {
    kind: "inbox",
    hostId: host.hostId,
  });

  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  assert.deepEqual(host.decisionParent(taskId), {
    state: "parent",
    sessionId: parent.sessionId,
  });
  assert.deepEqual(proposedOwner(fakeStore, decision, host.hostId, lookup), {
    kind: "task",
    taskId,
    hostId: host.hostId,
    sessionId: parent.sessionId,
  });

  finishChildren(host, server);
  await host.reconcileFinishedParents([
    { id: taskId, hostId: host.hostId, phase: "done" } as Task,
  ]);
  assert.notEqual(parentOf(host)?.archivedAt, undefined);
  assert.deepEqual(host.decisionParent(taskId), { state: "absent" });
  assert.deepEqual(proposedOwner(fakeStore, decision, host.hostId, lookup), {
    kind: "inbox",
    hostId: host.hostId,
  });

  host.close();
  assert.deepEqual(host.decisionParent(taskId), { state: "unknown" });
  assert.deepEqual(proposedOwner(fakeStore, decision, host.hostId, lookup), {
    kind: "inbox",
    hostId: host.hostId,
  });
});

/**
 * nucleus#1458: a parent binding stored before its launch was sent. A transient read
 * fails the first pass between the binding and the launch; the replay, a rolled host,
 * a lost launch reply and a parent that T3 shows as archived or as another checkout
 * are each observed before any parent or child is sent.
 */
const reopenHost = (
  t: TestContext,
  root: string,
  server: Awaited<ReturnType<typeof t3Fake>>,
  acp: ReturnType<typeof acpStub>,
) => {
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 300,
  });
  t.after(() => host.close());
  return host;
};

test("#1458 a transient read after the parent binding is stored resumes the same unsent launch on replay", async (t) => {
  const { host, server, spec, acp } = await fixture(t);
  // The narrow read and the complete inventory are both unanswerable (nucleus#1460:
  // a working inventory now settles a single narrow failure in the same create).
  server.controls.threadProjectionErrors = 1;
  churnInventory(server);
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  server.controls.beforeArchiveRead = () => {};
  const bound = parentOf(host)!;
  assert.ok(bound, "the binding is durable before the launch is sent");
  assert.equal(
    commandOf(server, "orchestration.launchThread"),
    undefined,
    "nothing is sent while the pre-send read is unresolved",
  );

  const created = await host.createAgent(spec("worker-create", "Do the work"));
  assert.ok(created.id);
  const parent = parentOf(host)!;
  assert.equal(parent.threadId, bound.threadId, "the same parent identity");
  assert.equal(parent.sessionId, bound.sessionId, "the same ACP binding");
  assert.equal(
    acp.bindings.length,
    1,
    "the binding is reused, not minted again",
  );
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
  assert.equal(
    commandOf(server, "delegated_task.request")!.parentThreadId,
    parent.threadId,
  );
});

test("#1458 a rolled host resumes the prepared launch from durable state without a second parent", async (t) => {
  const { host, server, spec, acp, root } = await fixture(t);
  // Narrow read and complete inventory both unanswerable (nucleus#1460).
  server.controls.threadProjectionErrors = 1;
  churnInventory(server);
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  server.controls.beforeArchiveRead = () => {};
  const bound = parentOf(host)!;
  host.close();

  const rolled = reopenHost(t, root, server, acp);
  await rolled.connect();
  await rolled.createAgent(spec("worker-create", "Do the work"));
  assert.equal(parentOf(rolled)!.threadId, bound.threadId);
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("#1458 a lost launch reply is settled by the parent T3 shows, with one parent and one child", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.disconnectAfterLaunch = true;
  await assert.rejects(() =>
    host.createAgent(spec("worker-create", "Do the work")),
  );
  const bound = parentOf(host)!;
  assert.ok(server.threads.has(bound.threadId), "the launch took effect");
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);

  server.controls.disconnectAfterLaunch = false;
  await host.connect();
  await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(parentOf(host)!.threadId, bound.threadId);
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "no second parent is launched",
  );
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("#1458 a prepared binding whose parent T3 shows archived refuses without a launch or a child", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.threadProjectionErrors = 1;
  churnInventory(server);
  await assert.rejects(() =>
    host.createAgent(spec("worker-create", "Do the work")),
  );
  server.controls.beforeArchiveRead = () => {};
  const bound = parentOf(host)!;
  const twin = threadProjection(bound.threadId, bound.directory);
  Object.assign(twin.thread, {
    projectId: bound.projectId,
    worktreePath: bound.directory,
    providerInstanceId: PARENT_PROVIDER,
    modelSelection: { instanceId: PARENT_PROVIDER, model: PARENT_MODEL },
    archivedAt: STAMP,
  });
  server.threads.set(bound.threadId, twin);

  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    /parent thread is archived/,
  );
  assert.equal(commandOf(server, "orchestration.launchThread"), undefined);
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
});

test("#1458 a prepared binding whose parent id is held by another checkout refuses without adopting it", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.threadProjectionErrors = 1;
  churnInventory(server);
  await assert.rejects(() =>
    host.createAgent(spec("worker-create", "Do the work")),
  );
  server.controls.beforeArchiveRead = () => {};
  const bound = parentOf(host)!;
  const twin = threadProjection(bound.threadId, "/synthetic/other-checkout");
  Object.assign(twin.thread, {
    projectId: bound.projectId,
    providerInstanceId: PARENT_PROVIDER,
    modelSelection: { instanceId: PARENT_PROVIDER, model: PARENT_MODEL },
  });
  server.threads.set(bound.threadId, twin);

  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    /no longer matches its recorded project and checkout/,
  );
  assert.equal(commandOf(server, "orchestration.launchThread"), undefined);
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
});

test("#1458 an unknown launch whose parent T3 does not show is never resent as a replacement", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.disconnectMutation = true;
  await assert.rejects(() =>
    host.createAgent(spec("worker-create", "Do the work")),
  );
  server.controls.disconnectMutation = false;
  const bound = parentOf(host)!;
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(server.threads.has(bound.threadId), false);

  await host.connect();
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    /parent thread is deleted/,
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "a possibly sent launch is not resent under the same identity",
  );
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
});

// nucleus#1460: the installed nightly answers an absent parent with the generic
// incomplete projection error, which grants no absence. The complete inventory decides.
const GENERIC_ABSENT = "OrchestrationV2GetThreadProjectionError" as const;
/** Makes every complete inventory read fail to pair (the inventory is unavailable). */
const churnInventory = (server: Awaited<ReturnType<typeof t3Fake>>) => {
  server.controls.beforeArchiveRead = () => {
    server.controls.snapshotSequence++;
  };
};
/** A binding stored before its launch was sent, with the inventory unavailable for that dispatch. */
async function preparedBinding(t: TestContext) {
  const f = await fixture(t);
  f.server.controls.absentThreadError = GENERIC_ABSENT;
  churnInventory(f.server);
  await assert.rejects(
    () => f.host.createAgent(f.spec("worker-create", "Do the work")),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  f.server.controls.beforeArchiveRead = () => {};
  const bound = parentOf(f.host)!;
  assert.ok(bound, "the binding is durable before the launch");
  assert.equal(commandOf(f.server, "orchestration.launchThread"), undefined);
  return { ...f, bound };
}

test("#1460 a prepared binding behind the generic absent read is resumed once by the ordinary worker create", async (t) => {
  const { host, server, spec, bound, acp } = await preparedBinding(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(
    parentOf(host)!.threadId,
    bound.threadId,
    "the same parent identity",
  );
  assert.equal(
    parentOf(host)!.sessionId,
    bound.sessionId,
    "the same ACP binding",
  );
  assert.equal(
    acp.bindings.length,
    1,
    "the binding is reused, not minted again",
  );
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);

  await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "recovered once",
  );
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("#1460 a generic absent read with a complete inventory launches the parent in the same create", async (t) => {
  const { host, server, spec, acp } = await fixture(t);
  server.controls.absentThreadError = GENERIC_ABSENT;
  await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
  assert.equal(acp.bindings.length, 1);
});

test("#1460 owner restart is not blocked by the generic read: the precheck restores nothing and the prepared parent is launched once", async (t) => {
  const { host, server, spec, workspace, bound } = await preparedBinding(t);
  const task = {
    id: bound.taskId,
    workspaceId: workspace.id,
    directory: workspace.directory,
    phase: "working",
    removedAt: null,
    resolution: { mergedCommit: null },
  } as Task;
  await host.nesting.restoreForRestart(task, "owner-op-1460", () => true);
  assert.equal(
    commandOf(server, "thread.unarchive"),
    undefined,
    "nothing is unarchived",
  );
  assert.equal(
    await host.nesting.observeRestartRestore(task, "owner-op-1460"),
    "not_found",
  );
  assert.equal(
    commandOf(server, "orchestration.launchThread"),
    undefined,
    "the precheck sends nothing",
  );

  await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(parentOf(host)!.threadId, bound.threadId);
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("#1460 an unavailable complete inventory keeps a prepared parent waiting for the worker and the restart", async (t) => {
  const { host, server, spec, workspace, bound } = await preparedBinding(t);
  churnInventory(server);
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  const task = {
    id: bound.taskId,
    workspaceId: workspace.id,
    directory: workspace.directory,
    phase: "working",
    removedAt: null,
    resolution: { mergedCommit: null },
  } as Task;
  await assert.rejects(
    () => host.nesting.restoreForRestart(task, "owner-op-1460", () => true),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  assert.equal(commandOf(server, "orchestration.launchThread"), undefined);
  assert.equal(commandOf(server, "thread.unarchive"), undefined);
  assert.equal(
    parentOf(host)!.archivedAt,
    undefined,
    "a wait marks nothing finished",
  );
});

test("#1460 a live parent whose projection stays unreadable waits without a second parent or child", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.controls.threadProjectionErrors = 99;
  await assert.rejects(
    () => host.createAgent(spec("review-run", "Review", "reviewer")),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  server.controls.threadProjectionErrors = 0;
  assert.equal(parentOf(host)!.threadId, parent.threadId);
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(commandsOf(server, "delegated_task.request").length, 1);
});

test("#1460 a reserved launch is never resent behind the generic absent read", async (t) => {
  const { host, server, spec } = await fixture(t);
  server.controls.absentThreadError = GENERIC_ABSENT;
  server.controls.disconnectMutation = true;
  await assert.rejects(() =>
    host.createAgent(spec("worker-create", "Do the work")),
  );
  server.controls.disconnectMutation = false;
  const bound = parentOf(host)!;
  assert.equal(commandsOf(server, "orchestration.launchThread").length, 1);
  assert.equal(server.threads.has(bound.threadId), false);

  // A sent parent keeps its transient wait: the generic read cannot prove it deleted,
  // and the inventory is not consulted for it (nucleus#1451 fence).
  await host.connect();
  await assert.rejects(
    () => host.createAgent(spec("worker-create", "Do the work")),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "never resent",
  );
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  assert.equal(
    parentOf(host)!.archivedAt,
    undefined,
    "a wait marks nothing finished",
  );
});
