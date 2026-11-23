import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import { T3TransientReadError } from "../hosts/t3code/reads";
import { t3AdapterClass } from "../hosts/t3code";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { HostPolicies } from "../core/host/host-policies";
import {
  HostReadRefusalError,
  ProvenPreSendRefusalError,
  type Adapter,
  type HostPolicyConstructor,
} from "../core/host";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import {
  profileSchema,
  runSchema,
  submissionSchema,
  taskControlInputSchema,
  type Profile,
} from "../shared/contracts";
import type { HostAgentSpec } from "../shared/host";
import { hostReadTransientKey } from "../core/recovery/host-read-transient";
import { t3Fake } from "./support/t3code-fake";
import { storedT3Labels } from "./support/t3code-labels";
import { toolTimelinePage } from "./support/tool-timeline";
import { briefDigest } from "../core/planning/brief";

const Policy = HostPolicies as unknown as HostPolicyConstructor;
const stamp = "2026-11-20T00:00:00.000Z";
const head = "a".repeat(40);
const base = "b".repeat(40);

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

async function makeT3Fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3code-admission-churn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const acp: AcpSessionSurface = {
    bind: (input) => ({
      sessionId: `session:${input.taskId}`,
      taskId: input.taskId,
      bindingPath: `/synthetic/acp/${input.taskId}.json`,
    }),
    async turn() {
      throw new Error("the agent is not driven in this test");
    },
    async message() {
      throw new Error("the agent is not driven in this test");
    },
    release() {},
  };
  const statePath = join(root, "state.json");
  const connectHost = async () => {
    const host = new T3CodeHost({
      endpoint: server.endpoint,
      bearer: "synthetic-bearer",
      statePath,
      timeoutMs: 1_000,
      probeThreadId: "synthetic-probe",
      acp: () => acp,
      reentryTimeoutMs: 300,
    });
    t.after(() => host.close());
    await host.connect();
    const served = (await host.rpc.call("server.getConfig", {})) as {
      providers: Array<Record<string, unknown>>;
    };
    server.controls.providers = [
      ...served.providers,
      {
        instanceId: PARENT_PROVIDER,
        displayName: "Nucleus",
        driver: "acpRegistry",
        enabled: true,
        status: "ready",
        models: [
          {
            slug: PARENT_MODEL,
            name: "Nucleus",
            isCustom: false,
            supportsReasoning: false,
            variants: [],
          },
        ],
      },
    ];
    server.controls.runOnLaunch = true;
    server.controls.parentHeldTurn = true;
    return host;
  };

  const host = await connectHost();
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-admission-churn",
    directory,
    project: { projectId: "synthetic-project", workspaceRoot: directory },
  });
  const spec = (
    requestId: string,
    role: string,
    taskId = "synthetic-task",
    restart = false,
  ): HostAgentSpec => ({
    workspaceId: workspace.id,
    title: "Admission churn task",
    profile,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt: "Synthetic prompt",
      labels: storedT3Labels(role, { taskId, runId: `${role}-${requestId}` }),
      environment: {},
    }),
    ...(restart ? { restart: true } : {}),
  });
  return { root, directory, server, host, workspace, spec, connectHost };
}

function makeEngineFixture(
  t: TestContext,
  options: { hostId?: string; repoDir?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ns-admission-engine-"));
  const repoDir = options.repoDir ?? join(dir, "repo");
  const hostId = options.hostId ?? "t3code";
  if (!options.repoDir) {
    execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Fixture"], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["-C", repoDir, "config", "user.email", "fixture@example.test"],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "base"], {
      stdio: "ignore",
    });
  }
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 10);
  const worker = profileSchema.parse({
    id: "worker",
    name: "Worker",
    provider: "synthetic-provider",
    model: "synthetic-model",
    notes: "",
    available: true,
    problem: "",
    supportedThinking: [],
  });
  const reviewer = profileSchema.parse({
    id: "reviewer",
    name: "Reviewer",
    provider: "synthetic-provider",
    model: "synthetic-reviewer",
    notes: "",
    available: true,
    problem: "",
    supportedThinking: [],
  });
  const coordinator = profileSchema.parse({
    id: "coord",
    name: "Coordinator",
    provider: "synthetic-provider",
    model: "synthetic-coord",
    notes: "",
    available: true,
    problem: "",
    supportedThinking: [],
  });
  store.setProfiles(
    [worker, reviewer, coordinator].map(
      ({ available: _a, problem: _p, supportedThinking: _s, ...stored }) =>
        stored,
    ),
  );
  store.setMeta("pool", [
    { profileId: "worker", enabled: true, group: "worker", roles: ["worker"], weight: "default", scopes: ["general"] },
    { profileId: "reviewer", enabled: true, group: "reviewer", roles: ["reviewer"], weight: "default", scopes: ["general"] },
    { profileId: "coord", enabled: true, group: "coord", roles: ["coordinator"], weight: "default", scopes: ["general"] },
  ]);

  let currentAdapter = {} as Adapter;
  const adapterProxy = new Proxy({} as Adapter, {
    get(_target, prop) {
      const value = Reflect.get(currentAdapter as object, prop);
      return typeof value === "function" ? value.bind(currentAdapter) : value;
    },
  });
  const engine = new Engine(store, adapterProxy, 0);
  engine.profiles = [worker, reviewer, coordinator];
  t.after(async () => {
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  engine.hostIds = () => [hostId];
  engine.hostAvailable = () => true;
  engine.resolveHostAdapter = () => adapterProxy;
  return {
    dir,
    repoDir,
    hostId,
    store,
    engine,
    profiles: { worker, reviewer, coordinator },
    setAdapter(adapter: Adapter) {
      currentAdapter = adapter;
    },
  };
}

test("narrow reads share parent projection under archive churn and recover after T3 reload without duplicate start", async (t) => {
  const { server, host, spec, connectHost } = await makeT3Fixture(t);
  const firstChild = await host.createAgent(
    spec("launch-worker-1", "worker", "task-1451-reload"),
  );
  const parentThreadId = host.state.read().parents?.["task-1451-reload"]?.threadId;
  assert.ok(parentThreadId, "bound task parent recorded");

  // Continuous background archive movement would exhaust paired inventory reads.
  server.controls.beforeArchiveRead = () => {
    server.controls.snapshotSequence++;
  };
  const archiveBefore = server.requests.filter(
    (r) => r.tag === "orchestration.getArchivedShellSnapshot",
  ).length;
  const subscribeBefore = server.requests.filter(
    (r) => r.tag === "orchestration.subscribeThread",
  ).length;

  // Release first child turn; keep the parent's existing held run intact so reload reuses it via narrow read.
  const firstWire = server.threads.get(firstChild.id)!;
  firstWire.runs = [];

  // First pre-send attempt hits OrchestrationV2GetThreadProjectionError over wire.
  const launchCountBefore = server.requests.filter(
    (r) => r.tag === "orchestration.launchThread",
  ).length;
  server.controls.threadProjectionErrors = 1;
  await assert.rejects(
    host.createAgent(spec("launch-reviewer-1", "reviewer", "task-1451-reload")),
    (error: unknown) => error instanceof T3TransientReadError,
  );
  assert.equal(
    server.requests.filter((r) => r.tag === "orchestration.launchThread")
      .length,
    launchCountBefore,
    "no duplicate child launched when pre-send narrow read failed",
  );
  assert.equal(host.connected, true);

  // Reload host instance and retry with the same requestId: succeeds via narrow read with zero archive snapshot reads.
  const reloadedHost = await connectHost();
  const secondChild = await reloadedHost.createAgent(
    spec("launch-reviewer-1", "reviewer", "task-1451-reload"),
  );
  assert.notEqual(secondChild.id, firstChild.id);
  const archiveAfter = server.requests.filter(
    (r) => r.tag === "orchestration.getArchivedShellSnapshot",
  ).length;
  assert.equal(
    archiveAfter - archiveBefore,
    0,
    "bound parent admission + pre-send fence read zero archive snapshots under archive churn",
  );
  assert.equal(
    server.requests.filter(
      (r) =>
        r.tag === "orchestration.subscribeThread" &&
        r.payload.threadId === parentThreadId,
    ).length > 0 &&
      server.requests.filter((r) => r.tag === "orchestration.subscribeThread")
        .length -
        subscribeBefore <=
        4,
    true,
  );
  assert.equal(
    reloadedHost.state.read().parents?.["task-1451-reload"]?.threadId,
    parentThreadId,
    "reload kept exact parent binding without launching a second parent",
  );
});

test("#1448 ordinary reviewer admission's custody check waits boundedly on T3TransientReadError, resumes on clear, and still blocks live or unknown tools", async (t) => {
  const { directory, server, host, workspace, spec } = await makeT3Fixture(t);
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "config", "user.name", "Fixture"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    ["-C", directory, "config", "user.email", "fixture@example.test"],
    { stdio: "ignore" },
  );
  execFileSync(
    "git",
    ["-C", directory, "commit", "--allow-empty", "-m", "base"],
    { stdio: "ignore" },
  );
  const f = makeEngineFixture(t, { hostId: host.hostId, repoDir: directory });
  const t3Adapter = new (t3AdapterClass(Policy))(host);
  const overrides: Record<string, unknown> = {
    hostProcessListing: async () => [],
    noLiveWorkspaceProcesses: async () => null,
    verifyPr: async () => ({
      prNumber: 7,
      url: "https://github.com/example/repo/pull/7",
      head,
      branch: "feature/1448",
      merged: false,
      base: "main",
      baseSha: base,
      title: "Review admission churn",
      state: "open",
      repository: "example/repo",
      headRepository: "example/repo",
      isCrossRepository: false,
    }),
    verifyResume: async () => {},
    verifyInspectedRevisionHead: async () => {},
    createRun: async () => ({
      id: "reviewer-agent-1448",
      workspaceId: workspace.id,
    }),
  };
  const adapter = new Proxy(t3Adapter as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Adapter;
  f.setAdapter(adapter);

  const brief = "Ordinary review admission brief.\n";
  const inserted = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-1448",
      title: "Review admission churn",
      repoPath: directory,
      planningCommit: base,
      handoffPath: "",
      brief: {
        text: brief,
        mediaType: "text/markdown",
        digest: briefDigest(brief),
      },
      originAgentId: "origin",
    }),
    host.hostId,
    "",
    base,
  );
  const workerAgent = await host.createAgent(
    spec("worker-1448", "worker", inserted.id),
  );
  server.threads.get(workerAgent.id)!.runs = [];
  const parentThreadId = host.state.read().parents?.[inserted.id]?.threadId;
  if (parentThreadId) server.threads.get(parentThreadId)!.runs = [];

  const workerRun = runSchema.parse({
    id: "worker-run-1448",
    taskId: inserted.id,
    role: "executor",
    generation: 1,
    head,
    base,
    agentId: workerAgent.id,
    workspaceId: workspace.id,
    profile: f.profiles.worker,
    status: "finished",
    createdAt: stamp,
    lastObservedAt: stamp,
    active: false,
    idleSince: stamp,
    temporaryDirectory: join(directory, "run-tmp-worker"),
    completion: {
      taskId: inserted.id,
      runId: "worker-run-1448",
      eventId: "done-1448",
      status: "ready_for_review",
      summary: "Ready",
      head,
      prNumber: 7,
    },
    released: true,
  });
  f.store.putRun(workerRun);
  const workingTask = f.store.update(
    inserted.id,
    {
      phase: "blocked",
      agentId: workerAgent.id,
      workspaceId: workspace.id,
      directory,
      runId: workerRun.id,
      profile: f.profiles.worker,
      completion: workerRun.completion,
      retiredWorkers: [
        {
          agentId: workerAgent.id,
          runId: workerRun.id,
          profile: f.profiles.worker,
          reason: "prior worker",
        },
      ],
    },
    "work_done",
  );

  // Move to review fails its custody read with real OrchestrationV2GetThreadProjectionError:
  // must retain operation pending without consuming attempts or raising immediate attention,
  // then succeed automatically once the transient projection error clears.
  server.controls.threadProjectionErrors = 1;
  const control = taskControlInputSchema.parse({
    taskId: workingTask.id,
    version: workingTask.version,
    action: "move",
    to: "review",
    reason: "Enter ordinary review",
  });
  const op = await f.engine.startOperation({
    key: "move-review-1448",
    kind: "task_control",
    taskId: workingTask.id,
    expectedVersion: workingTask.version,
    payload: { type: "task_control", control },
  });
  assert.ok("accepted" in op);
  const deadline = Date.now() + 2_000;
  let waitedOp = f.store.operation(op.operation.id)!;
  while (
    Date.now() < deadline &&
    !(waitedOp.state === "pending" && /retrying automatically/.test(waitedOp.diagnostic))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    waitedOp = f.store.operation(op.operation.id)!;
  }
  assert.equal(
    waitedOp.state,
    "pending",
    `expected pending wait, got ${waitedOp.state}: ${waitedOp.diagnostic}`,
  );
  assert.equal(waitedOp.attempts, 0, "transient read wait consumes zero operation attempts");
  assert.match(waitedOp.diagnostic, /retrying automatically/);
  assert.notEqual(f.store.task(workingTask.id).phase, "needs_attention");

  // Once the transient clears, automatic retry finishes the move without a repeat operator click.
  const completedOp = await f.engine.awaitOperation(op.operation.id);
  assert.equal(
    completedOp.state,
    "succeeded",
    `expected succeeded after clear, got ${completedOp.state}: ${completedOp.diagnostic}`,
  );
  assert.equal(
    f.store.getMeta(hostReadTransientKey("op", op.operation.id)),
    undefined,
    "cleared op transient episode on success",
  );
  await f.engine.quiesce();
  await f.engine.drainTitles();
  for (const r of f.store.runs(workingTask.id)) {
    if (!r.released)
      f.store.putRun({ ...r, status: "finished", released: true });
  }

  // After ordinary move to review is accepted, ordinary reviewer admission's custody check
  // also enters a recoverable wait on T3TransientReadError (and T3 archive churn), resumes
  // without consuming launches, and still blocks positively live tool custody.
  const reviewTask = f.store.task(workingTask.id);
  f.store.setCompletionReceipt(
    workerRun.completion!.eventId,
    reviewTask.id,
    workerRun.id,
    "hash-1448",
    JSON.stringify({ accepted: true }),
  );
  const detachedReviewerRun = runSchema.parse({
    id: "reviewer-run-1448",
    taskId: reviewTask.id,
    role: "reviewer",
    generation: 1,
    head,
    base,
    agentId: workerAgent.id,
    workspaceId: workspace.id,
    profile: f.profiles.reviewer,
    status: "intent",
    createdAt: stamp,
    lastObservedAt: null,
    active: null,
    idleSince: null,
    completion: null,
    released: false,
    priorRunId: workerRun.id,
    ordinaryDetached: true,
    temporaryDirectory: join(directory, "run-tmp-reviewer"),
  });
  f.store.putRun(detachedReviewerRun);
  f.store.update(reviewTask.id, {
    resolution: {
      ...reviewTask.resolution,
      currentRunId: detachedReviewerRun.id,
    },
  });
  // The worker's row moves, so its custody read needs a fresh snapshot (an
  // unchanged row is answered from the held one, Spec 069 batch 5), and that read
  // fails transiently.
  server.threads.get(workerAgent.id)!.thread.updatedAt =
    "2026-01-02T00:00:00.000Z";
  server.controls.threadProjectionErrors = 1;
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(
      f.store.task(reviewTask.id),
      detachedReviewerRun,
    ),
    (error: unknown) => error instanceof T3TransientReadError,
  );
  f.engine.noteStepFailure(
    reviewTask.id,
    new T3TransientReadError(new Error("custody transient")),
  );
  assert.equal(
    f.store.task(reviewTask.id).resolution.stop?.reason,
    "external_unavailable",
  );
  assert.notEqual(f.store.task(reviewTask.id).phase, "needs_attention");
  server.controls.threadProjectionErrors = 0;
  await f.engine.resolution.ordinaryRoundCustody(
    f.store.task(reviewTask.id),
    detachedReviewerRun,
  );

  // Positively live or genuinely unknown tool custody still blocks ordinary reviewer admission (no exemption).
  overrides.agentTimelinePage = async () =>
    toolTimelinePage(
      [
        {
          timestamp: stamp,
          item: {
            type: "tool_call",
            callId: "tool-1",
            name: "bash",
            status: "running",
          },
        },
      ],
      { projection: "bounded", pendingBackgroundTasks: [] },
    );
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(
      f.store.task(reviewTask.id),
      detachedReviewerRun,
    ),
    /live or unknown tools|still live/i,
  );
  overrides.agentTimelinePage = async () =>
    toolTimelinePage([], {
      gap: true,
      projection: "projected",
      hasOlder: false,
    });
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(
      f.store.task(reviewTask.id),
      detachedReviewerRun,
    ),
    /live or unknown tools|gap|inconclusive/i,
  );
});

test("#1431 in-place parent restore and external archive refusal stay intact under split inventory churn", async (t) => {
  const { server, host, spec, workspace } = await makeT3Fixture(t);
  await host.createAgent(spec("launch-1431", "worker", "task-1431"));
  const parentId = host.state.read().parents?.["task-1431"]?.threadId!;
  assert.ok(parentId);
  await host.archiveAgent(parentId);

  // Split archive churn active: ordinary non-restart launch must still positively see parent archived and refuse.
  server.controls.beforeArchiveRead = () => {
    server.controls.snapshotSequence++;
  };
  await assert.rejects(
    host.createAgent(spec("followup-1431", "reviewer", "task-1431", false)),
    (error: unknown) =>
      error instanceof ProvenPreSendRefusalError &&
      /parent thread is archived/i.test(error.message),
  );

  // Restart restore under temporary projection error yields retryable HostReadRefusalError without unarchiving or replacing parent.
  const taskRecord = {
    id: "task-1431",
    workspaceId: workspace.id,
    directory: workspace.directory,
    phase: "working",
    removedAt: null,
    resolution: { mergedCommit: null },
  } as never;
  server.controls.threadProjectionErrors = 1;
  await assert.rejects(
    host.nesting.restoreForRestart(taskRecord, "owner-op-1431", () => true),
    (error: unknown) => error instanceof HostReadRefusalError,
  );
  assert.equal(
    server.commands.filter(
      (c) => (c.type ?? c.method) === "thread.unarchive",
    ).length,
    0,
  );

  // Once projection read succeeds, #1431 in-place unarchive runs once and reuses the exact bound parent.
  server.controls.threadProjectionErrors = 0;
  await host.nesting.restoreForRestart(taskRecord, "owner-op-1431", () => true);
  assert.equal(
    server.commands.filter(
      (c) =>
        (c.type ?? c.method) === "thread.unarchive" && c.threadId === parentId,
    ).length,
    1,
    "#1431 in-place parent restore ran once after transient read cleared",
  );
  server.controls.runOnLaunch = true;
  server.controls.parentHeldTurn = true;
  await host.createAgent(spec("restart-1431", "reviewer", "task-1431"));
  assert.equal(
    host.state.read().parents?.["task-1431"]?.threadId,
    parentId,
  );
});

test("recovery coordinator admission waits cleanly on HostReadRefusalError, preserves recoveryAttempts, and resumes without duplicate launch", async (t) => {
  const f = makeEngineFixture(t);
  const task = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-coord-churn",
      title: "Coord churn",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  const waitingTask = f.store.update(
    task.id,
    {
      phase: "blocked",
      reason: "Needs coordinator recovery",
      workspaceId: "ws-coord",
      directory: f.repoDir,
      agentId: "worker-coord",
      runId: "worker-run-coord",
      profile: f.profiles.worker,
      resolution: {
        ...task.resolution,
        stop: {
          reason: "operator_needed",
          since: stamp,
          detail: "Needs coordinator recovery",
          suggestedVerbs: ["restart"],
        },
      },
    },
    "blocked",
  );

  let createdCoords = 0;
  let transient = true;
  f.setAdapter({
    supportsCoordinatorRecovery: true,
    supportsRecovery: true,
    observe: async (id: string) => {
      if (transient) throw new T3TransientReadError(new Error("T3 read kept moving"));
      return {
        id,
        workspaceId: "ws-coord",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      };
    },
    createRun: async () => {
      if (transient) throw new T3TransientReadError(new Error("T3 read kept moving"));
      createdCoords++;
      return { id: "coord-agent-1", workspaceId: "ws-coord" };
    },
  } as unknown as Adapter);

  await f.engine.resolution.recovery.route(f.store.task(waitingTask.id));
  const waited = f.store.task(waitingTask.id);
  assert.equal(waited.resolution.recoveryAttempts, 0, "did not burn recoveryAttempts");
  assert.equal(waited.resolution.stop?.reason, "external_unavailable");
  assert.notEqual(waited.phase, "needs_attention");
  assert.equal(createdCoords, 0);

  transient = false;
  await f.engine.resolution.recovery.route(f.store.task(waitingTask.id));
  const launched = f.store.task(waitingTask.id);
  assert.equal(createdCoords, 1, "launched coordinator once on recovery");
  assert.equal(launched.coordinatorAgentId, "coord-agent-1");
  assert.equal(
    f.store.getMeta(hostReadTransientKey("task", waitingTask.id)),
    undefined,
  );
});

test("question.answer honors recorded answers during unreadable HostReadRefusalError and retries cleanly without duplicate send", async (t) => {
  const f = makeEngineFixture(t);
  const task = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-question-churn",
      title: "Question churn",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  f.store.update(task.id, {
    phase: "blocked",
    workspaceId: "ws-q",
    directory: f.repoDir,
    agentId: "worker-q",
    runId: "run-q",
    profile: f.profiles.worker,
  });

  const escalationId = "esc-churn-1";
  const questionId = `ns-escalation-${escalationId}`;
  f.store.event(
    task.id,
    "planner_escalation",
    `${escalationId}: ${JSON.stringify({
      id: escalationId,
      level: 1,
      role: "planner",
      summary: "Restart worker after churn",
      options: ["restart worker", "park for operator"],
    })}`,
  );
  f.store.event(
    `delegation:${questionId}`,
    "delegated_delivery",
    JSON.stringify({
      taskId: task.id,
      recipient: "planner-agent",
      role: "planner",
      prompt: "- restart worker\n- park for operator",
      deadline: Date.now() + 60_000,
      hostId: f.hostId,
    }),
  );

  let transient = true;
  let restartsExecuted = 0;
  f.engine.resolution.escalationSettlement.applyDelegatedEscalationAnswer =
    async (_taskId, _escId, _qId, _answer) => {
      if (transient) throw new T3TransientReadError(new Error("T3 read kept moving"));
      restartsExecuted++;
      return null;
    };

  const pendingReceipt =
    await f.engine.resolution.delegation.answerDelegatedQuestion(
      {
        questionId,
        choice: "restart worker",
        reason: "Transient read should hold recorded answer safely",
      },
      "planner-agent",
    );
  assert.equal(
    "status" in pendingReceipt ? pendingReceipt.status : undefined,
    "pending",
  );
  assert.equal(restartsExecuted, 0);
  assert.equal(
    f.store
      .eventsAll(`delegation:${questionId}`)
      .some((e) => e.kind === "delegated_command_refused"),
    false,
    "never poisons the recorded answer as delegated_command_refused",
  );
  assert.equal(
    f.store.task(task.id).resolution.stop?.reason,
    "external_unavailable",
  );

  // Conflicting second answer is still refused even while pending.
  await assert.rejects(
    async () =>
      await f.engine.resolution.delegation.answerDelegatedQuestion(
        {
          questionId,
          choice: "park for operator",
          reason: "Conflicting replay must refuse",
        },
        "planner-agent",
      ),
    /already has a recorded answer|settled|in progress/i,
  );

  // Clear transient refusal and let Sweep recovery run: applies once cleanly.
  transient = false;
  await f.engine.resolution.delegation.recoverPendingEscalationAnswers();
  assert.equal(restartsExecuted, 1);
  assert.equal(
    f.store.getMeta(hostReadTransientKey("question", questionId)),
    undefined,
  );
  assert.equal(
    f.store
      .eventsAll(`delegation:${questionId}`)
      .some((e) => e.kind === "delegated_command_applied"),
    true,
  );
});

test("sustained pre-send HostReadRefusalError escalates once cleanly after bounded attempts", async (t) => {
  const f = makeEngineFixture(t);
  f.store.setMeta("hostReadTransientLimitMs", 1);
  f.store.setMeta("hostReadTransientMinAttempts", 2);
  f.store.setMeta("hostReadTransientMaxAttempts", 2);

  const task = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-sustained",
      title: "Sustained churn",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    f.hostId,
    "handoff.md",
    base,
  );

  assert.equal(
    f.engine.deferHostReadTransient(
      task.id,
      new T3TransientReadError(new Error("T3 read kept moving")),
      false,
      "Ordinary review admission",
    ),
    "wait",
  );
  assert.notEqual(f.store.task(task.id).phase, "needs_attention");
  assert.equal(
    f.engine.deferHostReadTransient(
      task.id,
      new T3TransientReadError(new Error("T3 read kept moving")),
      false,
      "Ordinary review admission",
    ),
    "wait",
  );
  assert.notEqual(f.store.task(task.id).phase, "needs_attention");

  // Third failure exceeds maxAttempts=2 -> one actionable escalation.
  assert.equal(
    f.engine.deferHostReadTransient(
      task.id,
      new T3TransientReadError(new Error("T3 read kept moving")),
      false,
      "Ordinary review admission",
    ),
    "exhausted",
  );
  const escalated = f.store.task(task.id);
  assert.equal(escalated.phase, "needs_attention");
  assert.match(escalated.reason, /could not read host state after 3 attempts/);

  // Same episode re-checking exhaustion does not emit a duplicate escalation event.
  const episodeDetail = new T3TransientReadError(new Error("T3 read kept moving")).message;
  f.store.setMeta(hostReadTransientKey("task", task.id), {
    startedAt: Number(
      f.store
        .eventsAll(task.id)
        .find((e) => e.kind === "host_read_transient_exhausted")!
        .detail.split(":")[0],
    ),
    attempts: 2,
    retryAt: 0,
    detail: episodeDetail,
  });
  assert.equal(
    f.engine.deferHostReadTransient(
      task.id,
      new T3TransientReadError(new Error("T3 read kept moving")),
      false,
      "Ordinary review admission",
    ),
    "exhausted",
  );
  const events = f.store
    .eventsAll(task.id)
    .filter((e) => e.kind === "host_read_transient_exhausted");
  assert.equal(events.length, 1);
});
