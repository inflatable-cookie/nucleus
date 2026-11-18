import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { decode } from "../hosts/t3code/contracts";
import { projection } from "../hosts/t3code/contracts";
import {
  HOLD_MARKER,
  PARENT_MODEL,
  PARENT_PROVIDER,
  childTaskId,
  childThreadId,
} from "../hosts/t3code/nesting";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { ProvenPreSendRefusalError } from "../core/host";
import type { HostAgentSpec } from "../shared/host";
import type { Profile, Task } from "../shared/contracts";
import {
  t3Fake,
  STAMP,
  syntheticRuntimeRequest,
  syntheticTurnItem,
} from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";

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
  assert.equal(missing.host.state.read().nesting?.state, "fallback");
  assert.match(
    missing.host.state.read().nesting!.reason,
    /register the installed nucleus-acp command/,
  );
  assert.match(
    missing.host.nativeParentingStatus,
    /native parenting off.*no nucleus ACP provider/,
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
  assert.equal(acp.bindings[0]!.holdPattern, HOLD_MARKER);
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
  assert.match(hold.text, new RegExp(HOLD_MARKER));
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
  // A finished task archives its parent, never the shared project or the child.
  await host.reconcileThreadTitles([
    { id: "synthetic-task", phase: "done" } as Task,
  ]);
  assert.notEqual(server.threads.get(parent.threadId)!.thread.archivedAt, null);
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

test("without the nucleus provider the task keeps top-level role threads and says why", async (t) => {
  const { host, server, spec } = await fixture(t, { provider: false });
  const created = await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  const launch = server.commands[0]!;
  assert.equal(launch.method, "orchestration.launchThread");
  assert.equal(launch.threadId, created.id);
  assert.deepEqual(launch.modelSelection, {
    instanceId: "synthetic-provider",
    model: "synthetic-model",
  });
  assert.equal(host.state.read().parents, undefined);
  assert.equal(host.state.read().nesting?.state, "fallback");
  assert.match(host.state.read().nesting!.reason, /nucleus/);
  assert.match(host.nativeParentingStatus, /native parenting off/);
});

test("a fallback role of a parented task is a top-level thread: tagged, settled, never disposed", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  // A review checkout gives the reviewer its own workspace, which cannot be a child:
  // it is a top-level thread of a task that still has a parent.
  const other = await host.createWorkspace({
    title: "Review checkout",
    requestId: "review-workspace",
    directory: await realpath(
      mkdtempSync(join(tmpdir(), "t3code-nesting-review-")),
    ),
    project: { projectId: "synthetic-project" },
  });
  const reviewer = await host.createAgent({
    ...spec("review-run", "Review it", "reviewer"),
    workspaceId: other.id,
  });
  assert.equal(
    host.state.read().agents[reviewer.id]!.parentThreadId,
    undefined,
    "a fallback thread is not recorded as a child",
  );
  // The one-row fallback still applies to it: the tag is set and it settles on a report.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    commandsOf(server, "thread.tag.set").some(
      (command) =>
        command.threadId === reviewer.id && command.tag === "nucleus-support",
    ),
    "a fallback support thread is tagged",
  );
  for (const run of server.threads.get(reviewer.id)!.runs)
    run.status = "completed";
  await host.settleReportedThread(reviewer.id, "review-run");
  assert.ok(
    commandsOf(server, "thread.settle").some(
      (command) => command.threadId === reviewer.id,
    ),
    "a fallback support thread settles like a top-level one",
  );
  // And its follow-ups are not delegated tasks, so nothing disposes them as children.
  const before = commandsOf(
    server,
    "delegated_task.completion-delivery.dispose",
  ).length;
  await host.sendMessage(reviewer.id, {
    messageId: "review-followup",
    text: "One more look",
  });
  assert.equal(
    commandsOf(server, "delegated_task.completion-delivery.dispose").length,
    before,
    "a fallback thread sends no child dispose",
  );
});

test("a worker that fell back to a top-level thread keeps its own title, settle and unsettle", async (t) => {
  // The parent launches and is recorded, but its turn never starts, so the worker
  // falls back: this is the shape the review named, a task with a parent and a
  // top-level worker. The worker's own presentation must not be written to the parent.
  const { host, server, spec } = await fixture(t, { runOnLaunch: false });
  const worker = await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  assert.ok(parent, "the parent record stays after the fallback");
  assert.equal(
    host.state.read().agents[worker.id]!.parentThreadId,
    undefined,
    "the worker is not a child",
  );

  await host.setTaskWorkspaceTitle(
    {
      id: "synthetic-task",
      number: 1305,
      title: "Synthetic task",
      phase: "working",
      agentId: worker.id,
      runId: "worker-run",
    } as Task,
    "Synthetic task",
    "title-intent",
    false,
  );
  assert.ok(
    commandsOf(server, "thread.metadata.update").some(
      (command) =>
        command.threadId === worker.id && command.title === "Synthetic task",
    ),
    "the worker row is titled on its own thread",
  );
  assert.equal(
    commandsOf(server, "thread.metadata.update").some(
      (command) => command.threadId === parent.threadId,
    ),
    false,
    "the parent row is not titled for a fallback worker",
  );

  // The fallback launch ran no provider turn in this fixture, so give the worker one
  // recorded run that has ended, as a real handover would have.
  server.threads.get(worker.id)!.runs.push({
    id: "run:worker",
    status: "completed",
    startedAt: STAMP,
    ordinal: 1,
    rootNodeId: "node:root:worker",
  });
  await host.settleWorkerThread(worker.id, "worker-run");
  assert.ok(
    commandsOf(server, "thread.settle").some(
      (command) => command.threadId === worker.id,
    ),
    "the worker settles on its own thread",
  );
  assert.equal(
    commandsOf(server, "thread.settle").some(
      (command) => command.threadId === parent.threadId,
    ),
    false,
  );

  await host.unsettleWorkerThread(worker.id, "synthetic-task");
  assert.ok(
    commandsOf(server, "thread.unsettle").some(
      (command) => command.threadId === worker.id,
    ),
    "the worker surfaces on its own thread",
  );
  assert.equal(
    commandsOf(server, "thread.unsettle").some(
      (command) => command.threadId === parent.threadId,
    ),
    false,
  );
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

  // The parent itself as a tombstone: the next role falls back instead of sending to it.
  server.threads.get(parent.threadId)!.thread.deletedAt = STAMP;
  const sentBefore = server.commands.length;
  const reviewer = await host.createAgent(
    spec("review-run", "Review it", "reviewer"),
  );
  assert.ok(
    server.shells.some((snapshot) =>
      snapshot.threads.includes(parent.threadId),
    ),
    "the fake served the removed parent as a tombstone row",
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").at(-1)!.threadId,
    reviewer.id,
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

test("a role launched after its parent was archived falls back instead of re-launching it", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.get(parent.threadId)!.thread.archivedAt = STAMP;
  const reviewer = await host.createAgent(
    spec("review-run", "Review it", "reviewer"),
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    2,
    "the archived parent is not launched again",
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").at(-1)!.threadId,
    reviewer.id,
  );
  assert.deepEqual(
    commandsOf(server, "orchestration.launchThread").at(-1)!.modelSelection,
    { instanceId: "synthetic-provider", model: "synthetic-model" },
  );
  assert.equal(
    commandOf(server, "delegated_task.request")!.parentThreadId,
    parent.threadId,
    "only the worker became a child",
  );
  assert.notEqual(
    host.state.read().parents!["synthetic-task"]!.archivedAt,
    undefined,
  );
  assert.match(host.state.read().nesting!.reason, /parent thread is archived/);
});

test("a parent gone from the complete inventory also falls back, without a refused command", async (t) => {
  const { host, server, spec } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const parent = parentOf(host)!;
  server.threads.delete(parent.threadId);
  const reviewer = await host.createAgent(
    spec("review-run", "Review it", "reviewer"),
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread").at(-1)!.threadId,
    reviewer.id,
  );
  assert.equal(
    commandsOf(server, "message.dispatch").some(
      (command) => command.threadId === parent.threadId,
    ),
    false,
    "nothing is sent to a parent that no longer exists",
  );
  assert.match(host.state.read().nesting!.reason, /parent thread is deleted/);
});

test("a nucleus provider that is not an ACP driver falls back with guidance before any send", async (t) => {
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
  const created = await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  assert.equal(
    commandsOf(server, "orchestration.launchThread").length,
    1,
    "only the top-level role thread is launched",
  );
  assert.equal(
    commandsOf(server, "orchestration.launchThread")[0]!.threadId,
    created.id,
  );
  assert.match(host.state.read().nesting!.reason, /acpRegistry/);
});

test("a role that runs in another checkout stays a top-level thread", async (t) => {
  const { host, server, spec, acp } = await fixture(t);
  await host.createAgent(spec("worker-create", "Do the work"));
  const other = await host.createWorkspace({
    title: "Review checkout",
    requestId: "other-workspace",
    directory: (await realpath(
      mkdtempSync(join(tmpdir(), "t3code-nesting-other-")),
    )) as string,
    project: { projectId: "synthetic-project" },
  });
  const reviewSpec: HostAgentSpec = {
    ...spec("review-run", "Review it", "reviewer"),
    workspaceId: other.id,
  };
  const reviewer = await host.createAgent(reviewSpec);
  assert.equal(
    commandsOf(server, "delegated_task.request").length,
    1,
    "only the worker became a child",
  );
  const launched = commandsOf(server, "orchestration.launchThread").at(-1)!;
  assert.equal(launched.threadId, reviewer.id);
  assert.equal(launched.modelSelection.instanceId, "synthetic-provider");
  assert.equal(
    acp.released.length,
    0,
    "the parent keeps its held turn for the other role",
  );
});

test("a parent thread T3 will not run is a proven fallback, not an unknown delivery", async (t) => {
  const { host, server, spec } = await fixture(t, { runOnLaunch: false });
  // The parent launches, but its turn never starts: the re-entry message must time out
  // and the role must land on a top-level thread with its own command identity.
  server.controls.runOnLaunch = false;
  const created = await host.createAgent(spec("worker-create", "Do the work"));
  assert.equal(commandOf(server, "delegated_task.request"), undefined);
  assert.equal(
    commandsOf(server, "orchestration.launchThread").at(-1)!.threadId,
    created.id,
  );
  assert.equal(host.state.read().nesting?.state, "fallback");
  // Parked: the next role in the same task goes straight to the fallback instead of
  // paying the re-entry wait again.
  const started = Date.now();
  const reviewer = await host.createAgent(
    spec("review-run", "Review it", "reviewer"),
  );
  assert.ok(Date.now() - started < 5_000);
  assert.equal(
    commandsOf(server, "orchestration.launchThread").at(-1)!.threadId,
    reviewer.id,
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
