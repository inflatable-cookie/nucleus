import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostPolicies } from "../core/host/host-policies";
import {
  ArchiveNotDeliveredError,
  ProvenPreSendRefusalError,
  type Adapter,
  type HostPolicyConstructor,
} from "../core/host";
import { HostFacade } from "../core/host/host-facade";
import { createAdapter as createT3Adapter, T3CodeHost } from "../hosts/t3code";
import { PARENT_MODEL, PARENT_PROVIDER, childThreadId } from "../hosts/t3code/nesting";
import { createBbHostAdapter } from "../service/bb-host";
import { HostOperationError, type HostOperationName } from "../hosts/bb/plugin/operations";
import type { BbWorkspaceRecord } from "../hosts/bb/threads";
import { Store } from "../core/store/store";
import { RunUsageTracker } from "../core/telemetry/run-usage-tracker";
import { QuestionRaiseRoutes } from "../core/questions/question-raise-routes";
import { QueueRuntime } from "../service/runtime-owner";
import { submissionSchema, type Profile, type Run } from "../shared/contracts";
import type { AcpSessionSurface } from "../shared/acp/surface";
import type { HostAgentSpec } from "../shared/host";
import { wireLabels } from "../shared/wire-labels";
import { t3Fake } from "./support/t3code-fake";
import { bbFake, bbWire } from "./support/bb-fake";

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

test("T3 adapter covers decider, consult reviewer, enqueueMessage, interruptAndContinue, and closeout workspace recovery", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-t3-parity-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const { repoPath, head } = initRepo(scratch);
  const worktreeDir = join(scratch, "task-wt");
  execFileSync("git", ["worktree", "add", "-b", "ns-task-wt", worktreeDir, head], { cwd: repoPath });
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

  const acp: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: join(scratch, `acp-${input.taskId}.json`),
    }),
    turn: async () => { throw new Error("unused"); },
    message: async () => { throw new Error("unused"); },
    release: () => {},
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

  // 1. Decider run creates a nested child via delegated_task.request.
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
  assert.equal(decider.agentId, childThreadId("ns-decider-dec-1"));
  assert.equal(decider.text, null);

  // 2. Consult reviewer creates a nested child via delegated_task.request.
  const consult = await adapter.createConsultReviewer!(current, {
    profile,
    id: "consult-1",
  });
  assert.equal(consult.id, childThreadId("ns-reviewer-consult-consult-1"));
  assert.equal(consult.workspaceId, ws.id);

  // 3. enqueueMessage is exposed through T3Adapter and dispatches queue_after_active.
  await facade.enqueueMessage(consult.id, {
    messageId: "msg-queue-1",
    text: "Queued amendment",
  });
  const queuedCmd = server.commands.findLast(
    (cmd) => (cmd as { commandId?: string }).commandId === "msg-queue-1",
  );
  assert.ok(queuedCmd, "enqueueMessage sent message.dispatch");
  assert.deepEqual(
    (queuedCmd as { dispatchMode?: unknown }).dispatchMode,
    { type: "queue_after_active" },
  );

  // 4. interruptAndContinue is exposed through T3Adapter and steers the active run.
  const consultThread = server.threads.get(consult.id)!;
  await facade.interruptAndContinue(consult.id, "msg-steer-1", "Steer now");
  const steerCmd = server.commands.findLast(
    (cmd) => (cmd as { commandId?: string }).commandId === "msg-steer-1",
  );
  assert.ok(steerCmd, "interruptAndContinue sent message.dispatch");
  assert.deepEqual(
    (steerCmd as { dispatchMode?: unknown }).dispatchMode,
    { type: "steer_active", targetRunId: "run:ns-reviewer-consult-consult-1" },
  );

  // With no active run, interruptAndContinue refuses before send.
  consultThread.runs.length = 0;
  await assert.rejects(
    facade.interruptAndContinue(consult.id, "msg-steer-idle", "No run"),
    ProvenPreSendRefusalError,
  );

  // 5. Closeout workspace recovery creates a real Git worktree under the task workspaces root,
  //    finds it through findCloseoutWorkspaces, and passes verifyCloseoutWorkspace.
  const closeout = await adapter.createCloseoutWorkspace(current);
  assert.ok(existsSync(closeout.directory));
  assert.match(closeout.directory, new RegExp(`ns-closeout-${task.id}$`));
  const found = await adapter.findCloseoutWorkspaces(current);
  assert.deepEqual(found, [closeout]);
  await adapter.verifyCloseoutWorkspace(current, closeout.id, closeout.directory);
});

test("BB adapter covers enqueueMessage, interruptAndContinue, deleteAgent, and closeout workspace recovery", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ns-bb-parity-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const { repoPath, head } = initRepo(scratch);
  const worktreeDir = join(scratch, "task-wt");
  execFileSync("git", ["worktree", "add", "-b", "ns-bb-wt", worktreeDir, head], { cwd: repoPath });
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

  const adapter = createBbHostAdapter(bbHost, () => true, dataDir, store, operation) as Adapter & {
    guardedNativeAgentCreate(
      spec: HostAgentSpec,
      mcp: boolean,
      retry: boolean,
    ): Promise<{ id: string; workspaceId: string | null }>;
    createCloseoutWorkspace(task: ReturnType<Store["task"]>): Promise<{ id: string; directory: string }>;
    findCloseoutWorkspaces(task: ReturnType<Store["task"]>): Promise<Array<{ id: string; directory: string }>>;
    verifyCloseoutWorkspace(task: ReturnType<Store["task"]>, id: string, directory: string): Promise<void>;
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
        labels: wireLabels({ task: task.id, run: "run-worker", role: "worker" }),
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
  const queuedSend = fake.calls.findLast((call) => call.method === "threads.send");
  assert.ok(queuedSend);
  assert.equal((queuedSend.args as { mode: string }).mode, "queue-if-active");

  // 2. interruptAndContinue refuses before send when idle, and steers when active.
  await assert.rejects(
    facade.interruptAndContinue(worker.id, "bb-steer-idle", "Steer idle"),
    (error: unknown) => error instanceof HostOperationError && error.code === "refused",
  );
  fake.rows.get(worker.id)!.status = "active";
  fake.rows.get(worker.id)!.runtime.displayStatus = "active";
  await facade.interruptAndContinue(worker.id, "bb-steer-live", "Steer active");
  const steerSend = fake.calls.findLast((call) => call.method === "threads.send");
  assert.ok(steerSend);
  assert.equal((steerSend.args as { mode: string }).mode, "steer");

  // 3. deleteAgent proves cascade, refuses foreign threads, and deletes owned threads.
  const foreignId = "thr_foreign";
  fake.rows.set(foreignId, bbWire("list", { id: foreignId, status: "idle", runtime: { displayStatus: "idle" } }));
  fake.cascades.set(worker.id, [foreignId]);
  await assert.rejects(facade.deleteAgent(worker.id), ArchiveNotDeliveredError);
  assert.ok(fake.rows.has(worker.id), "foreign cascade left worker intact");

  fake.cascades.set(worker.id, []);
  await facade.deleteAgent(worker.id);
  assert.equal(fake.rows.has(worker.id), false, "deleteAgent removed the BB thread");

  // 4. Closeout workspace recovery creates a real Git worktree under the task workspaces root,
  //    finds it through findCloseoutWorkspaces, and passes verifyCloseoutWorkspace.
  const closeout = await adapter.createCloseoutWorkspace(current);
  assert.ok(existsSync(closeout.directory));
  assert.match(closeout.directory, new RegExp(`ns-closeout-${task.id}$`));
  const found = await adapter.findCloseoutWorkspaces(current);
  assert.deepEqual(found, [closeout]);
  await adapter.verifyCloseoutWorkspace(current, closeout.id, closeout.directory);
});

test("kept fallbacks are explicit and visible: run usage, native decisions, and live-run presence", async (t) => {
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
  const tracker = new RunUsageTracker(store, noUsageSource, undefined, () => noUsageSource);
  tracker.sync();
  tracker.sync();
  tracker.close();
  const usageEvents = store
    .eventsAll(task.id)
    .filter((event) => event.kind === "run_usage_unavailable");
  assert.equal(usageEvents.length, 1);
  assert.match(usageEvents[0]!.detail, /run-no-usage:.*does not expose a live run usage stream/);

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
    { id: "q-fallback-1", kind: "budget", question: "Continue?", options: ["Yes", "No"] },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending);
  const routeEvents = store
    .eventsAll(task.id)
    .filter((event) => event.kind === "operator_question_route_fallback");
  assert.equal(routeEvents.length, 1);
  assert.match(routeEvents[0]!.detail, /q-fallback-1:.*native in-thread decision unavailable/);

  // 3. service.health explicitly reports liveRunPresence inactive when no host provides it.
  const runtimeDir = join(scratch, "runtime-data");
  mkdirSync(runtimeDir, { recursive: true });
  const runtime = new QueueRuntime({
    dataDir: runtimeDir,
    adapterFactory: () => boardAdapter,
    timers: false,
    hostRunEndpoint: false,
  });
  t.after(() => runtime.stop());
  const health = runtime.health();
  assert.equal(health.liveRunPresence?.active, false);
  assert.match(health.liveRunPresence?.reason ?? "", /unavailable/i);
});
