import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostPolicies } from "../core/host/host-policies";
import {
  ArchiveNotDeliveredError,
  HostUnknownDeliveryError,
  ProvenPreSendRefusalError,
  type Adapter,
  type HostPolicyConstructor,
} from "../core/host";
import { HostFacade } from "../core/host/host-facade";
import { Admission } from "../core/host/admission";
import { createOwnedCloseoutWorktree } from "../core/workspaces/workspace-continuation/host";
import { createAdapter as createT3Adapter, T3CodeHost } from "../hosts/t3code";
import {
  PARENT_MODEL,
  PARENT_PROVIDER,
  childThreadId,
} from "../hosts/t3code/nesting";
import { createBbHostAdapter } from "../service/bb-host";
import {
  createHostOperations,
  HostOperationError,
  type BbHostSdk,
  type HostOperationName,
} from "../hosts/bb/plugin/operations";
import type { BbWorkspaceRecord } from "../hosts/bb/threads";
import { Store } from "../core/store/store";
import { AcpSessions } from "../core/acp/sessions";
import { acpBindingPath, readAcpBinding } from "../shared/acp/binding";
import { RunUsageTracker } from "../core/telemetry/run-usage-tracker";
import { QuestionRaiseRoutes } from "../core/questions/question-raise-routes";
import { Dispositions } from "../core/verbs/disposition/controls";
import { fenceDisposition } from "../core/verbs/disposition/requests";
import { resumeDispositions } from "../core/verbs/disposition/effects";
import { BriefAmendmentDelivery } from "../core/verbs/brief-amendment";
import { createUnboundAdapter } from "../core/host/unbound-adapter";
import { QueueRuntime } from "../service/runtime-owner";
import { submissionSchema, type Profile, type Run } from "../shared/contracts";
import type { AcpSessionSurface } from "../shared/acp/surface";
import type { HostAgentSpec } from "../shared/host";
import { wireLabels } from "../shared/wire-labels";
import { t3Fake } from "./support/t3code-fake";
import { bbFake, bbWire, BB_STAMP } from "./support/bb-fake";

const profile: Profile = {
  id: "synthetic-profile",
  name: "Synthetic",
  provider: "codex",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};

function initRepo(root: string): { repoPath: string; head: string } {
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
  run("init", "-b", "main");
  run("config", "user.name", "Synthetic");
  run("config", "user.email", "synthetic@example.test");
  writeFileSync(join(repoPath, "README.md"), "# synthetic\n");
  run("add", "README.md");
  run("commit", "-m", "initial");
  return { repoPath: realpathSync(repoPath), head: run("rev-parse", "HEAD") };
}

test("T3 adapter covers decider, consult reviewer, enqueueMessage, interruptAndContinue, withdrawal, and closeout workspace recovery", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-t3-parity-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const { repoPath, head } = initRepo(scratch);
  const worktreeDir = join(scratch, "task-wt");
  execFileSync(
    "git",
    ["worktree", "add", "-b", "ns-task-wt", worktreeDir, head],
    { cwd: repoPath },
  );
  const realWorktreeDir = realpathSync(worktreeDir);
  const dataDir = join(scratch, "data");
  mkdirSync(dataDir, { recursive: true });

  const server = await t3Fake(t, repoPath);
  server.controls.providers = [
    {
      instanceId: PARENT_PROVIDER,
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
    },
    {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic" }],
      supportedRuntimeModes: ["full-access"],
    },
  ];
  server.controls.runOnLaunch = true;
  server.controls.parentHeldTurn = true;

  const releasedSessions: string[] = [];
  const acp: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: join(scratch, `acp-${input.taskId}.json`),
    }),
    turn: async () => {
      throw new Error("unused");
    },
    message: async () => {
      throw new Error("unused");
    },
    release: (sessionId) => {
      releasedSessions.push(sessionId);
    },
  };

  const native = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(dataDir, "hosts", "t3code.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    reentryTimeoutMs: 300,
  });
  await native.connect();
  t.after(() => native.close());

  const adapter = createT3Adapter(
    HostPolicies as unknown as HostPolicyConstructor,
    native,
    {
      socketPath: join(dataDir, "callback.sock"),
      helperPath: join(dataDir, "worker-report.mjs"),
    },
  );
  const facade = new HostFacade({ adapter });

  const ws = await native.createWorkspace({
    title: "Synthetic task",
    requestId: "req-ws-1",
    directory: realWorktreeDir,
    project: { workspaceRoot: repoPath },
  });

  const store = new Store(join(dataDir, "queue.sqlite"));
  t.after(() => store.close());
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "T3 parity task",
      repoPath,
      planningCommit: head,
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    native.hostId,
    "/synthetic/handoff.md",
    head,
  );
  store.update(task.id, {
    workspaceId: ws.id,
    directory: realWorktreeDir,
    resolution: { ...task.resolution, closeoutWorkspaceHead: head },
  });
  const current = store.task(task.id);

  // 1. Decider run creates a nested child with its own launch ID and accepts
  //    the first question under `ns-decider-<id>` without intent collision.
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    adapter.runDecider!(current, {
      profile,
      signal: aborted.signal,
      timeoutMs: 1_000,
      decisionId: "dec-aborted",
    }),
    ProvenPreSendRefusalError,
  );
  const decider = await adapter.runDecider!(current, {
    profile,
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    decisionId: "dec-1",
  });
  assert.equal(decider.agentId, childThreadId("ns-decider-launch-dec-1"));
  assert.equal(decider.text, null);
  await adapter.askPlanner!(decider.agentId, {
    prompt: "Choose option A or B",
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    messageId: "ns-decider-dec-1",
  });
  const deciderQuestion = server.commands.findLast(
    (cmd) => (cmd as { commandId?: string }).commandId === "ns-decider-dec-1",
  );
  assert.ok(deciderQuestion, "decider received its first question message");
  assert.equal(
    (deciderQuestion as { threadId?: string }).threadId,
    decider.agentId,
  );

  // 2. Consult reviewer creates a nested child with its own launch ID and
  //    accepts the first consult prompt under `ns-reviewer-consult-<id>`.
  const consult = await adapter.createConsultReviewer!(current, {
    profile,
    id: "consult-1",
  });
  assert.equal(
    consult.id,
    childThreadId("ns-reviewer-consult-launch-consult-1"),
  );
  assert.equal(consult.workspaceId, ws.id);
  await adapter.askReviewer!(consult.id, {
    prompt: "Please advise on the blocker",
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    messageId: "ns-reviewer-consult-consult-1",
  });
  const consultQuestion = server.commands.findLast(
    (cmd) =>
      (cmd as { commandId?: string }).commandId ===
      "ns-reviewer-consult-consult-1",
  );
  assert.ok(consultQuestion, "consult reviewer received its first question");
  assert.equal((consultQuestion as { threadId?: string }).threadId, consult.id);

  // 3. enqueueMessage is exposed through T3Adapter and dispatches queue_after_active.
  await facade.enqueueMessage(consult.id, {
    messageId: "msg-queue-1",
    text: "Queued amendment",
  });
  const queuedCmd = server.commands.findLast(
    (cmd) => (cmd as { commandId?: string }).commandId === "msg-queue-1",
  );
  assert.ok(queuedCmd, "enqueueMessage sent message.dispatch");
  assert.deepEqual((queuedCmd as { dispatchMode?: unknown }).dispatchMode, {
    type: "queue_after_active",
  });

  // 4. interruptAndContinue is exposed through T3Adapter and steers the active run.
  const consultThread = server.threads.get(consult.id)!;
  await facade.interruptAndContinue(consult.id, "msg-steer-1", "Steer now");
  const steerCmd = server.commands.findLast(
    (cmd) => (cmd as { commandId?: string }).commandId === "msg-steer-1",
  );
  assert.ok(steerCmd, "interruptAndContinue sent message.dispatch");
  assert.deepEqual((steerCmd as { dispatchMode?: unknown }).dispatchMode, {
    type: "steer_active",
    targetRunId: "run:ns-reviewer-consult-launch-consult-1",
  });

  // With no active run, interruptAndContinue refuses before send, and withdrawal
  // falls back once to enqueueMessage so an idle worker still resumes.
  consultThread.runs.length = 0;
  await assert.rejects(
    facade.interruptAndContinue(consult.id, "msg-steer-idle", "No run"),
    ProvenPreSendRefusalError,
  );
  store.update(task.id, { agentId: consult.id });
  store.event(task.id, "disposition_turn_interrupted", consult.id);
  const controls = new Dispositions({
    store,
    adapter,
  } as never);
  await controls.continueWithdrawnWorker(store.task(task.id));
  assert.ok(
    store
      .eventsAll(task.id)
      .some(
        (event) =>
          event.kind === "disposition_withdraw_continued" &&
          event.detail === consult.id,
      ),
    "idle T3 worker resumed via queued fallback on cancellation withdrawal",
  );

  // 5. Closeout workspace recovery: simulate crash between Git worktree creation
  //    and host registration; findCloseoutWorkspaces proves and adopts it.
  const preCreatedDir = await createOwnedCloseoutWorktree(null, dataDir, {
    title: `Closeout: ${current.title}`,
    requestId: `ns-closeout-workspace-${task.id}`,
    source: {
      kind: "worktree",
      cwd: repoPath,
      action: "branch-off",
      baseBranch: head,
      branchName: `ns-closeout-${task.id}`,
      worktreeSlug: `ns-closeout-${task.id}`,
    },
  });
  assert.ok(existsSync(preCreatedDir));
  const adopted = await adapter.findCloseoutWorkspaces(current);
  assert.equal(adopted.length, 1);
  const closeout = adopted[0]!;
  assert.equal(realpathSync(closeout.directory), realpathSync(preCreatedDir));
  await adapter.verifyCloseoutWorkspace(
    current,
    closeout.id,
    closeout.directory,
  );

  // 6. Exact-checkout guard still refuses non-closeout roles on the recovered
  //    workspace, while a closeout child retires the old parent and launches
  //    under a replacement parent bound to the recovered closeout checkout.
  const oldParentId = native.nesting.parentOf(task.id)!.threadId;
  await assert.rejects(
    native.createAgent({
      workspaceId: closeout.id,
      profile,
      title: "Review: T3 parity task",
      taskNumber: current.number,
      mcpBindingPath: null,
      attempt: () => ({
        prompt: "Wrong role on recovered closeout workspace",
        requestId: "ns-wrong-role-closeout",
        labels: wireLabels({
          task: task.id,
          run: "run-wrong",
          role: "reviewer",
        }),
        environment: {},
      }),
    }),
    ProvenPreSendRefusalError,
  );
  const closeoutChild = await native.createAgent({
    workspaceId: closeout.id,
    profile,
    title: "Closeout: T3 parity task",
    taskNumber: current.number,
    mcpBindingPath: null,
    attempt: () => ({
      prompt: "Run closeout in recovered checkout",
      requestId: "ns-closeout-run-1",
      labels: wireLabels({
        task: task.id,
        run: "run-closeout",
        role: "closeout",
      }),
      environment: {},
    }),
  });
  assert.equal(closeoutChild.id, childThreadId("ns-closeout-run-1"));
  assert.equal(closeoutChild.workspaceId, closeout.id);
  const newParent = native.nesting.parentOf(task.id)!;
  assert.notEqual(newParent.threadId, oldParentId);
  assert.equal(newParent.workspaceId, closeout.id);
  assert.equal(newParent.directory, closeout.directory);
  assert.ok(
    server.commands.some(
      (cmd) =>
        (cmd as { type?: string; threadId?: string }).type ===
          "thread.archive" &&
        (cmd as { threadId?: string }).threadId === oldParentId,
    ),
    "old parent on lost checkout was archived",
  );
  assert.ok(releasedSessions.length > 0, "old parent ACP session was released");
});

test("BB adapter covers enqueueMessage, interruptAndContinue, withdrawal, archived-vs-deleted proof, and closeout crash recovery", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-bb-parity-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const { repoPath, head } = initRepo(scratch);
  const worktreeDir = join(scratch, "task-wt");
  execFileSync(
    "git",
    ["worktree", "add", "-b", "ns-bb-wt", worktreeDir, head],
    { cwd: repoPath },
  );
  const realWorktreeDir = realpathSync(worktreeDir);
  const dataDir = join(scratch, "data");
  mkdirSync(dataDir, { recursive: true });

  const bbHost = "bb:0123456789abcdef0123456789abcdef";
  const store = new Store(join(dataDir, "queue.sqlite"));
  t.after(() => store.close());
  const fake = bbFake();
  const operation = async (op: HostOperationName, input: unknown) =>
    fake.operations.execute(op, input);

  const handle = `bb-worktree-${"c".repeat(40)}`;
  store.setMeta("bbWorkspaces", {
    [handle]: {
      id: handle,
      directory: realWorktreeDir,
      projectId: "proj_synthetic",
      repositoryRoot: repoPath,
      title: "BB task",
    } satisfies BbWorkspaceRecord,
  });

  const adapter = createBbHostAdapter(
    bbHost,
    () => true,
    dataDir,
    store,
    operation,
  ) as Adapter & {
    guardedNativeAgentCreate(
      spec: HostAgentSpec,
      mcp: boolean,
      retry: boolean,
    ): Promise<{ id: string; workspaceId: string | null }>;
    createCloseoutWorkspace(
      task: ReturnType<Store["task"]>,
    ): Promise<{ id: string; directory: string }>;
    findCloseoutWorkspaces(
      task: ReturnType<Store["task"]>,
    ): Promise<Array<{ id: string; directory: string }>>;
    verifyCloseoutWorkspace(
      task: ReturnType<Store["task"]>,
      id: string,
      directory: string,
    ): Promise<void>;
  };
  const facade = new HostFacade({ adapter });

  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "BB parity task",
      repoPath,
      planningCommit: head,
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    bbHost,
    "/synthetic/handoff.md",
    head,
  );
  store.update(task.id, {
    workspaceId: handle,
    directory: realWorktreeDir,
    resolution: { ...task.resolution, closeoutWorkspaceHead: head },
  });
  const current = store.task(task.id);

  const worker = await adapter.guardedNativeAgentCreate(
    {
      workspaceId: handle,
      taskNumber: 1510,
      title: "BB parity task",
      profile,
      mcpBindingPath: null,
      attempt: () => ({
        requestId: "ns-run-worker",
        labels: wireLabels({
          task: task.id,
          run: "run-worker",
          role: "worker",
        }),
        environment: {},
        prompt: "Synthetic worker prompt.",
      }),
    },
    false,
    false,
  );

  // 1. enqueueMessage queues behind active turn via thread.send (queue-if-active).
  await facade.enqueueMessage(worker.id, {
    messageId: "bb-queue-1",
    text: "Queued brief amendment",
  });
  const queuedSend = fake.calls.findLast(
    (call) => call.method === "threads.send",
  );
  assert.ok(queuedSend);
  assert.equal((queuedSend.args as { mode: string }).mode, "queue-if-active");

  // 2. interruptAndContinue refuses before send when idle (as ProvenPreSendRefusalError),
  //    withdrawal falls back once to enqueueMessage, and steer succeeds when active.
  await assert.rejects(
    facade.interruptAndContinue(worker.id, "bb-steer-idle", "Steer idle"),
    ProvenPreSendRefusalError,
  );
  store.update(task.id, { agentId: worker.id });
  store.event(task.id, "disposition_turn_interrupted", worker.id);
  const controls = new Dispositions({ store, adapter } as never);
  await controls.continueWithdrawnWorker(store.task(task.id));
  assert.ok(
    store
      .eventsAll(task.id)
      .some(
        (event) =>
          event.kind === "disposition_withdraw_continued" &&
          event.detail === worker.id,
      ),
    "idle BB worker resumed via queued fallback on cancellation withdrawal",
  );

  // Unknown delivery on steer must NOT resend via enqueueMessage.
  fake.rows.get(worker.id)!.status = "active";
  fake.rows.get(worker.id)!.runtime.displayStatus = "active";
  fake.controls.loseSteer = true;
  const sendsBeforeUnknown = fake.calls.filter(
    (call) => call.method === "threads.send",
  ).length;
  await controls.continueWithdrawnWorker({
    ...store.task(task.id),
    version: store.task(task.id).version + 1,
  });
  const sendsAfterUnknown = fake.calls.filter(
    (call) => call.method === "threads.send",
  ).length;
  assert.equal(
    sendsAfterUnknown,
    sendsBeforeUnknown + 1,
    "unknown steer delivery never resends via enqueueMessage",
  );
  fake.controls.loseSteer = false;

  await facade.interruptAndContinue(worker.id, "bb-steer-live", "Steer active");
  const steerSend = fake.calls.findLast(
    (call) => call.method === "threads.send",
  );
  assert.ok(steerSend);
  assert.equal((steerSend.args as { mode: string }).mode, "steer");

  // 3. Archived thread is NOT mistaken for deleted; deleteAgent proves cascade,
  //    refuses foreign threads, and deletes an archived owned thread cleanly.
  const foreignId = "thr_foreign";
  fake.rows.set(
    foreignId,
    bbWire("list", {
      id: foreignId,
      status: "idle",
      runtime: { displayStatus: "idle" },
    }),
  );
  fake.rows.get(worker.id)!.archivedAt = BB_STAMP;
  const archivedOrigin = await facade.originAgent(worker.id);
  assert.ok(archivedOrigin, "archived thread is still visible via originAgent");
  assert.equal(archivedOrigin.archived, true);

  fake.cascades.set(worker.id, [foreignId]);
  await assert.rejects(facade.deleteAgent(worker.id), ArchiveNotDeliveredError);
  assert.ok(fake.rows.has(worker.id), "foreign cascade left worker intact");

  fake.cascades.set(worker.id, []);
  await facade.deleteAgent(worker.id);
  assert.equal(
    fake.rows.has(worker.id),
    false,
    "deleteAgent removed archived BB thread",
  );
  assert.equal(await facade.originAgent(worker.id), null);

  // Unreadable (non-array) post-delete threads.list response fails closed.
  const badSdk: BbHostSdk = {
    ...fake.sdk,
    threads: {
      ...fake.sdk.threads,
      experimental_listCascade: async () => ({
        threads: [{ threadId: "thr_bad", cascadeThreadIds: [] }],
      }),
      delete: async () => ({ ok: true as const }),
      list: async () => null as never,
    },
  };
  const badOps = createHostOperations({
    sdk: badSdk,
    pluginId: "nucleus",
    sdkVersion: "0.6.132",
    dataDir: () => "/synthetic/bb",
  });
  await assert.rejects(
    badOps.execute("thread.delete", {
      threadId: "thr_bad",
      expectedCascadeThreadIds: [],
    }),
    (error: unknown) =>
      error instanceof HostOperationError && error.code === "unavailable",
  );

  // 4. Closeout workspace crash recovery: adopt a proven unregistered worktree,
  //    and refuse a dirty/unproved path at the deterministic closeout location.
  const preCreatedDir = await createOwnedCloseoutWorktree(null, dataDir, {
    title: `Closeout: ${current.title}`,
    requestId: `ns-closeout-workspace-${task.id}`,
    source: {
      kind: "worktree",
      cwd: repoPath,
      action: "branch-off",
      baseBranch: head,
      branchName: `ns-closeout-${task.id}`,
      worktreeSlug: `ns-closeout-${task.id}`,
    },
  });
  writeFileSync(join(preCreatedDir, "dirty.txt"), "uncommitted\n");
  assert.deepEqual(
    await adapter.findCloseoutWorkspaces(current),
    [],
    "dirty closeout worktree is refused for adoption",
  );
  rmSync(join(preCreatedDir, "dirty.txt"));

  const adopted = await adapter.findCloseoutWorkspaces(current);
  assert.equal(adopted.length, 1);
  const closeout = adopted[0]!;
  assert.equal(realpathSync(closeout.directory), realpathSync(preCreatedDir));
  await adapter.verifyCloseoutWorkspace(
    current,
    closeout.id,
    closeout.directory,
  );
});

test("kept fallbacks are explicit and visible: run usage, native decisions, and production live-run presence", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-fallback-visibility-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const store = new Store(join(scratch, "queue.sqlite"));
  t.after(() => store.close());

  const hostId = "t3code:synthetic-host";
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Fallback visibility task",
      repoPath: "/synthetic/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    hostId,
    "/synthetic/handoff.md",
    "a".repeat(40),
  );
  const run: Run = {
    id: "run-no-usage",
    taskId: task.id,
    hostId,
    role: "executor",
    generation: 1,
    head: "",
    base: "",
    agentId: "thr-1",
    workspaceId: "ws-1",
    profile: null,
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
  };
  store.putRun(run);

  // 1. RunUsageTracker records one visible `run_usage_unavailable` event when host lacks subscribeRunUsage.
  const noUsageSource = {};
  const tracker = new RunUsageTracker(
    store,
    noUsageSource,
    undefined,
    () => noUsageSource,
  );
  tracker.sync();
  tracker.sync();
  tracker.close();
  const usageEvents = store
    .eventsAll(task.id)
    .filter((event) => event.kind === "run_usage_unavailable");
  assert.equal(usageEvents.length, 1);
  assert.match(
    usageEvents[0]!.detail,
    /run-no-usage:.*does not expose a live run usage stream/,
  );

  // 2. QuestionRaiseRoutes records `operator_question_route_fallback` when native decisions fall back to board/ladder.
  const boardAdapter = {
    capabilities: () => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: true,
      nativeDecisions: false,
    }),
    reportingViaMcp: false,
  } as unknown as Adapter;
  const controller = new AbortController();
  const routes = new QuestionRaiseRoutes({
    store,
    adapter: boardAdapter,
    queueBudgetQuestionCurrent: () => true,
    queueAskRaises: new Map(),
    queueAskRaiseAnsweredBy: new Map(),
    ensureQueueRaiseDecision: () => {},
    taskPlannerFor: async () => null,
    projectPlannerFor: async () => ({ planner: null }),
    identifyOriginHost: async () => null,
    withHost: async (_h: string, fn: () => unknown) => fn(),
    originHostAvailable: () => false,
    host: { sendMessage: async () => {} },
    delegateDecision: async () => false,
    stopped: () => false,
  } as never);
  const pending = routes.raiseDecision(
    task,
    {
      id: "q-fallback-1",
      kind: "budget",
      question: "Continue?",
      options: ["Yes", "No"],
    },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending);
  const routeEvents = store
    .eventsAll(task.id)
    .filter((event) => event.kind === "operator_question_route_fallback");
  assert.equal(routeEvents.length, 1);
  assert.match(
    routeEvents[0]!.detail,
    /q-fallback-1:.*native in-thread decision unavailable/,
  );

  // 3. Production composition: a constructed Paseo adapter with no live Paseo
  //    connection reports liveRunPresence active=false (never hides T3/BB fallback),
  //    and a mixed deployment with Paseo + T3 connected names the unsupported host.
  const runtimeDir = join(scratch, "runtime-data");
  mkdirSync(runtimeDir, { recursive: true });
  let paseoConnected = false;
  const fakePaseo = {
    isConnected: () => paseoConnected,
    liveRunPresence: {
      listWorkspaces: async () => [],
      listTerminals: async () => [],
      createTerminal: async () => ({ id: "term-1" }),
      setWorkspaceLabels: async () => {},
    },
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: runtimeDir,
    adapterFactory: () => fakePaseo,
    timers: false,
    hostRunEndpoint: false,
  });
  t.after(() => runtime.stop());
  // Mirror production wiring where `paseoAdapter` is always constructed even when offline.
  (runtime as unknown as { paseoAdapter: unknown }).paseoAdapter = fakePaseo;
  const registry = (
    runtime as unknown as {
      hostRegistry: {
        connect(
          id: string,
          endpoint: string,
          entry: { adapter: Adapter; admission: Admission },
        ): symbol;
      };
    }
  ).hostRegistry;
  registry.connect("t3code:synthetic", "http://127.0.0.1:0", {
    adapter: boardAdapter,
    admission: new Admission(),
  });

  // Paseo disconnected, T3 connected -> inactive, explicitly naming T3.
  const offlineHealth = runtime.health();
  assert.equal(offlineHealth.liveRunPresence?.active, false);
  assert.deepEqual(offlineHealth.liveRunPresence?.unsupportedHosts, [
    "t3code:synthetic",
  ]);
  assert.match(offlineHealth.liveRunPresence?.reason ?? "", /t3code:synthetic/);

  // Paseo connected alongside T3 -> active for Paseo, still explicitly naming T3.
  paseoConnected = true;
  registry.connect("paseo:local", "ws://127.0.0.1:0", {
    adapter: fakePaseo,
    admission: new Admission(),
  });
  const mixedHealth = runtime.health();
  assert.equal(mixedHealth.liveRunPresence?.active, true);
  assert.deepEqual(mixedHealth.liveRunPresence?.unsupportedHosts, [
    "t3code:synthetic",
  ]);
  assert.match(mixedHealth.liveRunPresence?.reason ?? "", /t3code:synthetic/);
});

test("T3 closeout recovery binds ACP to closeoutDirectory, retains old parent on archive failure, and resumes prepared replacement parent", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-t3-closeout-handoff-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const { repoPath, head } = initRepo(scratch);
  const worktreeDir = join(scratch, "task-wt");
  execFileSync(
    "git",
    ["worktree", "add", "-b", "ns-task-wt", worktreeDir, head],
    { cwd: repoPath },
  );
  const realWorktreeDir = realpathSync(worktreeDir);
  const dataDir = join(scratch, "data");
  mkdirSync(dataDir, { recursive: true });

  const server = await t3Fake(t, repoPath);
  server.controls.providers = [
    {
      instanceId: PARENT_PROVIDER,
      displayName: "Nucleus",
      driver: "acpRegistry",
      enabled: true,
      status: "ready",
      models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
    },
    {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      status: "ready",
      models: [{ slug: "synthetic-model", name: "Synthetic" }],
      supportedRuntimeModes: ["full-access"],
    },
  ];
  server.controls.runOnLaunch = true;
  server.controls.parentHeldTurn = true;

  const store = new Store(join(dataDir, "queue.sqlite"));
  const acp = new AcpSessions({ store } as never, {
    dataHome: dataDir,
    socketPath: join(dataDir, "callback.sock"),
  });
  let failReplacementBindOnce = false;
  const controlledAcp: AcpSessionSurface = {
    bind: (input) => {
      if (failReplacementBindOnce) {
        failReplacementBindOnce = false;
        throw new Error("simulated interruption before replacement bind write");
      }
      return acp.bind(input);
    },
    turn: (input, token) => acp.turn(input, token),
    message: (input, token) => acp.message(input, token),
    release: (sessionId, reason) => acp.release(sessionId, reason),
    observedCards: (scope, cards) => acp.observedCards(scope, cards),
  };

  const statePath = join(dataDir, "hosts", "t3code.json");
  const native = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => controlledAcp,
    reentryTimeoutMs: 300,
  });
  await native.connect();
  let afterInterruptedBind: T3CodeHost | undefined;
  let resumed: T3CodeHost | undefined;
  t.after(() => {
    resumed?.close();
    afterInterruptedBind?.close();
    native.close();
    store.close();
  });

  const adapter = createT3Adapter(
    HostPolicies as unknown as HostPolicyConstructor,
    native,
    {
      socketPath: join(dataDir, "callback.sock"),
      helperPath: join(dataDir, "worker-report.mjs"),
    },
  );

  const ws = await native.createWorkspace({
    title: "Synthetic task",
    requestId: "req-ws-handoff-1",
    directory: realWorktreeDir,
    project: { workspaceRoot: repoPath },
  });

  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "T3 closeout handoff task",
      repoPath,
      planningCommit: head,
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    native.hostId,
    "/synthetic/handoff.md",
    head,
  );
  store.update(task.id, {
    workspaceId: ws.id,
    directory: realWorktreeDir,
    resolution: { ...task.resolution, closeoutWorkspaceHead: head },
  });

  // Launch original parent via consult reviewer.
  await adapter.createConsultReviewer!(store.task(task.id), {
    profile,
    id: "consult-handoff",
  });
  const readState = () =>
    JSON.parse(readFileSync(statePath, "utf8")) as {
      parents?: Record<
        string,
        {
          threadId: string;
          sessionId: string;
          workspaceId: string;
          directory: string;
          launchCommandId?: string;
        }
      >;
      intents: Record<string, unknown>;
    };
  const originalParent = readState().parents?.[task.id];
  assert.ok(originalParent, "original parent persisted");

  // Create recovered closeout worktree and record closeoutDirectory (keeping task.directory).
  const preCreatedDir = await createOwnedCloseoutWorktree(null, dataDir, {
    title: `Closeout: ${store.task(task.id).title}`,
    requestId: `ns-closeout-workspace-${task.id}`,
    source: {
      kind: "worktree",
      cwd: repoPath,
      action: "branch-off",
      baseBranch: head,
      branchName: `ns-closeout-${task.id}`,
      worktreeSlug: `ns-closeout-${task.id}`,
    },
  });
  assert.ok(existsSync(preCreatedDir));
  const adopted = await adapter.findCloseoutWorkspaces(store.task(task.id));
  assert.equal(adopted.length, 1);
  const closeout = adopted[0]!;
  store.update(task.id, {
    resolution: {
      ...store.task(task.id).resolution,
      closeoutDirectory: closeout.directory,
      closeoutWorkspaceId: closeout.id,
    },
  });

  // Unrecorded directory is refused by AcpSessions.bind.
  assert.throws(
    () => acp.bind({ taskId: task.id, directory: join(scratch, "unrecorded") }),
    /unrecorded checkout/,
  );

  // 1. Archive failure retains the old parent binding and refuses to launch a replacement.
  server.controls.refuseMutation = true;
  const closeoutSpec = (requestId: string): HostAgentSpec => ({
    workspaceId: closeout.id,
    profile,
    title: "Closeout run",
    taskNumber: store.task(task.id).number,
    mcpBindingPath: null,
    attempt: () => ({
      prompt: "Finish closeout",
      requestId,
      labels: wireLabels({
        task: task.id,
        run: `run-${requestId}`,
        role: "closeout",
      }),
      environment: {},
    }),
  });
  await assert.rejects(
    native.createAgent(closeoutSpec("req-closeout-handoff-1")),
  );
  assert.equal(
    readState().parents?.[task.id]?.threadId,
    originalParent.threadId,
    "old parent binding retained when archive fails",
  );
  server.controls.refuseMutation = false;

  // 2. Interruption after the old parent archive is confirmed and before the
  //    replacement binding is saved retains the archived binding and never
  //    adopts the archived original parent on retry (even after reopening).
  failReplacementBindOnce = true;
  await assert.rejects(
    native.createAgent(closeoutSpec("req-closeout-handoff-interrupted")),
    /simulated interruption before replacement bind write/,
  );
  assert.ok(
    server.threads.get(originalParent.threadId)?.thread.archivedAt,
    "original parent archive is already confirmed in T3",
  );
  assert.equal(
    readState().parents?.[task.id]?.threadId,
    originalParent.threadId,
    "archived prior parent binding stays recorded until replacement bind succeeds",
  );

  // Reopen the adapter after the interruption; retry creates the scoped
  // replacement parent on closeoutDirectory and never adopts the archived original.
  afterInterruptedBind = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => controlledAcp,
    reentryTimeoutMs: 300,
  });
  await afterInterruptedBind.connect();
  const closeoutChild = await afterInterruptedBind.createAgent(
    closeoutSpec("req-closeout-handoff-2"),
  );
  assert.ok(closeoutChild.id);
  const replacementParent = readState().parents?.[task.id];
  assert.ok(replacementParent, "replacement parent persisted");
  assert.notEqual(replacementParent.threadId, originalParent.threadId);
  assert.equal(replacementParent.directory, closeout.directory);
  assert.equal(
    server.threads.get(replacementParent.threadId)?.thread.worktreePath,
    closeout.directory,
  );
  assert.ok(
    replacementParent.launchCommandId,
    "replacement parent persists scoped launchCommandId",
  );
  const boundPointer = readAcpBinding(
    acpBindingPath(dataDir, closeout.directory),
  );
  assert.notEqual(boundPointer.kind, "inbox");
  if (boundPointer.kind !== "inbox") {
    assert.equal(boundPointer.taskId, task.id);
    assert.equal(boundPointer.sessionId, replacementParent.sessionId);
  }

  // 3. Restart recovery while replacement parent is prepared (no launch intent reserved yet)
  //    resumes the exact same threadId and launchCommandId.
  server.threads.delete(replacementParent.threadId);
  const preparedState = readState();
  delete preparedState.intents[replacementParent.launchCommandId!];
  writeFileSync(statePath, JSON.stringify(preparedState, null, 2));

  resumed = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => controlledAcp,
    reentryTimeoutMs: 300,
  });
  await resumed.connect();
  await resumed.createAgent(closeoutSpec("req-closeout-handoff-3"));
  const resumedParent = readState().parents?.[task.id];
  assert.equal(resumedParent?.threadId, replacementParent.threadId);
  assert.equal(
    resumedParent?.launchCommandId,
    replacementParent.launchCommandId,
  );

  // 4. Even if state.parents[task.id] were absent on a recovered closeout retry
  //    while the archived original thread exists in T3, nesting still derives the
  //    scoped replacement identity and never adopts the archived original parent.
  const missingParentState = readState();
  delete missingParentState.parents?.[task.id];
  writeFileSync(statePath, JSON.stringify(missingParentState, null, 2));
  await resumed.createAgent(closeoutSpec("req-closeout-handoff-4"));
  const recoveredAgain = readState().parents?.[task.id];
  assert.equal(recoveredAgain?.threadId, replacementParent.threadId);
  assert.notEqual(recoveredAgain?.threadId, originalParent.threadId);
  assert.equal(recoveredAgain?.directory, closeout.directory);
});

test("BB listExactThreads rejects malformed or unexpected rows instead of treating them as absent", async () => {
  const fake = bbFake();
  for (const badRows of [[null], [{ id: "thr_unexpected" }]]) {
    const badSdk: BbHostSdk = {
      ...fake.sdk,
      threads: {
        ...fake.sdk.threads,
        experimental_listCascade: async () => ({
          threads: [{ threadId: "thr_target", cascadeThreadIds: [] }],
        }),
        delete: async () => ({ ok: true as const }),
        list: async () => badRows as never,
      },
    };
    const ops = createHostOperations({
      sdk: badSdk,
      pluginId: "nucleus",
      sdkVersion: "0.6.132",
      dataDir: () => "/synthetic/bb",
    });
    await assert.rejects(
      ops.execute("thread.delete", {
        threadId: "thr_target",
        expectedCascadeThreadIds: [],
      }),
      (error: unknown) =>
        error instanceof HostOperationError && error.code === "unavailable",
    );
  }
});

test("Dispositions.continueWithdrawnWorker routes through the withdrawn task's recorded host rather than the ambient adapter", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-withdraw-host-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const store = new Store(join(scratch, "queue.sqlite"));
  t.after(() => store.close());

  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Cross-host withdrawal task",
      repoPath: "/synthetic/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    "t3code:remote",
    "/synthetic/handoff.md",
    "a".repeat(40),
  );
  store.update(task.id, { agentId: "thr-t3-worker" });
  store.event(task.id, "disposition_turn_interrupted", "thr-t3-worker");

  const ambientCalls: string[] = [];
  const taskHostCalls: Array<{ id: string; messageId: string }> = [];
  const ambientAdapter = {
    interruptAndContinue: async (id: string) => {
      ambientCalls.push(id);
    },
  } as unknown as Adapter;
  const taskHostAdapter = {
    interruptAndContinue: async (id: string, messageId: string) => {
      taskHostCalls.push({ id, messageId });
    },
  } as unknown as Adapter;

  let activeAdapter = ambientAdapter;
  const engineStub = {
    store,
    get adapter() {
      return activeAdapter;
    },
    async onTaskHost<T>(
      target: { hostId?: string | null },
      fn: () => Promise<T>,
    ) {
      assert.equal(target.hostId, "t3code:remote");
      const previous = activeAdapter;
      activeAdapter = taskHostAdapter;
      try {
        return await fn();
      } finally {
        activeAdapter = previous;
      }
    },
  };
  const dispositions = new Dispositions(engineStub as never);
  await dispositions.continueWithdrawnWorker(store.task(task.id));

  assert.deepEqual(ambientCalls, []);
  assert.equal(taskHostCalls.length, 1);
  assert.equal(taskHostCalls[0]!.id, "thr-t3-worker");
});

test("Unbound fleet sweep still delivers queued brief amendments and interrupts resumed cancellations on the task host", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-unbound-fleet-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const store = new Store(join(scratch, "queue.sqlite"));
  t.after(() => store.close());

  const taskHostId = "t3code:connected";
  const enqueued: Array<{ id: string; messageId: string; text: string }> = [];
  const interrupted: Array<{ id: string; messageId: string; text: string }> =
    [];
  const connectedHostAdapter = {
    enqueueMessage: async (id: string, messageId: string, text: string) => {
      enqueued.push({ id, messageId, text });
    },
    interruptAndContinue: async (
      id: string,
      messageId: string,
      text: string,
    ) => {
      interrupted.push({ id, messageId, text });
    },
  } as unknown as Adapter;

  let activeAdapter: Adapter = createUnboundAdapter();
  const withHost = async <T>(hostId: string, fn: () => Promise<T> | T) => {
    assert.equal(hostId, taskHostId);
    const previous = activeAdapter;
    activeAdapter = connectedHostAdapter;
    try {
      return await fn();
    } finally {
      activeAdapter = previous;
    }
  };

  // 1. BriefAmendments.deliverPending enters withHost before checking enqueueMessage.
  const amendedTask = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Queued amendment task",
      repoPath: "/synthetic/repo",
      planningCommit: "b".repeat(40),
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    taskHostId,
    "/synthetic/handoff.md",
    "b".repeat(40),
  );
  store.update(amendedTask.id, {
    phase: "working",
    agentId: "thr-amend-worker",
    briefVersions: [
      {
        version: 2,
        text: "Updated brief text",
        digest: `sha256:${"c".repeat(64)}`,
        mediaType: "text/markdown",
        pinnedAt: new Date().toISOString(),
        reason: "clarification",
      },
    ],
  });
  store.event(
    amendedTask.id,
    "brief_amendment_delivery_intent",
    JSON.stringify({
      version: 2,
      agentId: "thr-amend-worker",
      hostId: taskHostId,
      role: "worker",
      messageId: "ns-amend-v2",
    }),
  );

  const engineStub = {
    store,
    stopped: false,
    get adapter() {
      return activeAdapter;
    },
    resolution: {
      originHostAvailable: (hostId: string) => hostId === taskHostId,
      withHost,
    },
    taskHostAvailable: (task: { hostId?: string | null }) =>
      task.hostId === taskHostId,
    withHost,
    hooks: {
      emit: async () => {},
    },
    host: {
      observe: async () => ({
        active: true,
        permissions: false,
        status: "running",
      }),
      archiveAgent: async () => {},
    },
    removeSiblings: async () => {},
  };

  const amendments = new BriefAmendmentDelivery(engineStub as never);
  await amendments.deliverPending();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]!.id, "thr-amend-worker");
  assert.equal(enqueued[0]!.messageId, "ns-amend-v2");
  assert.ok(
    store
      .eventsAll(amendedTask.id)
      .some((event) => event.kind === "brief_amendment_delivered"),
    "queued amendment recorded delivered on the task host",
  );

  // 2. resumeDispositions builds dispositionDeps() on the unbound default adapter,
  //    yet resolves interruptTurn dynamically inside withHost(task.hostId).
  const cancelledTask = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Resumed cancellation task",
      repoPath: "/synthetic/repo",
      planningCommit: "d".repeat(40),
      handoffPath: "/synthetic/handoff.md",
      originAgentId: "origin",
    }),
    taskHostId,
    "/synthetic/handoff.md",
    "d".repeat(40),
  );
  store.update(cancelledTask.id, {
    phase: "working",
    agentId: "thr-cancel-worker",
  });
  fenceDisposition(store, {
    taskId: cancelledTask.id,
    version: store.task(cancelledTask.id).version,
    action: "cancel",
    reason: "operator cancel",
    workDisposition: "preserve",
    requestedBy: "operator",
  });

  const dispositions = new Dispositions(engineStub as never);
  const deps = dispositions.dispositionDeps();
  assert.equal(
    deps.interruptTurn,
    undefined,
    "unbound ambient adapter exposes no interruptTurn outside withHost",
  );
  await resumeDispositions(store, deps);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]!.id, "thr-cancel-worker");
  assert.ok(
    store
      .eventsAll(cancelledTask.id)
      .some(
        (event) =>
          event.kind === "disposition_turn_interrupted" &&
          event.detail === "thr-cancel-worker",
      ),
    "resumed cancellation interrupted active turn on the task host",
  );
});
