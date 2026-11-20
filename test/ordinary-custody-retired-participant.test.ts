import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import type { ResolutionAdapter } from "../core/resolution";
import type { HostPolicyConstructor } from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import type { HostProcessFact } from "../core/host/types";
import { participantTemporaryDirectory } from "../core/machine/participant-roots";
import { Store } from "../core/store/store";
import { collectOwnerVerbFacts, ownerPendingEffects } from "../core/verbs/owner-verbs";
import { runTemporaryDirectory } from "../core/workspaces/run-scratch";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { createAdapter } from "../hosts/t3code";
import { PARENT_MODEL, PARENT_PROVIDER } from "../hosts/t3code/nesting";
import type { AcpSessionSurface } from "../shared/acp/surface";
import { submissionSchema, type Profile, type Run, type Task } from "../shared/contracts";
import type { HostAgentSpec } from "../shared/host";
import { t3Fake } from "./support/t3code-fake";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CALLER = "owner-thread";

const workerProfile: Profile = {
  id: "synthetic-worker",
  name: "Synthetic Worker",
  provider: "synthetic-provider",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};

const reviewerProfile: Profile = {
  id: "synthetic-reviewer",
  name: "Synthetic Reviewer",
  provider: "synthetic-provider",
  model: "synthetic-model",
  available: true,
  problem: "",
  notes: "",
  supportedThinking: [],
};

function acpStub(server: Awaited<ReturnType<typeof t3Fake>>): AcpSessionSurface {
  return {
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
    release() {
      for (const thread of server.threads.values()) {
        if (thread.thread.providerInstanceId !== PARENT_PROVIDER) continue;
        for (const run of thread.runs) {
          if (["preparing", "starting", "running", "waiting"].includes(run.status))
            run.status = "completed";
        }
      }
    },
  };
}

function subscribeRequests(server: Awaited<ReturnType<typeof t3Fake>>, threadId: string): number {
  return server.commands.filter(
    (command) => command.type === "orchestration.subscribeThread" && command.threadId === threadId,
  ).length;
}

async function setupT3Engine(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nucleus-1418-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = await realpath(root);
  const worktreeDir = join(directory, "repo");
  const scratchRoot = join(directory, "scratch", "nucleus");
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });

  const server = await t3Fake(t, worktreeDir);
  const acp = acpStub(server);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(directory, "hosts", "t3code.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp,
    reentryTimeoutMs: 200,
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
      models: [{ slug: PARENT_MODEL, name: "Nucleus" }],
    },
  ];
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory: worktreeDir,
    project: { projectId: "synthetic-project" },
  });

  const makeSpec = (requestId: string, role: string, runId: string): HostAgentSpec => ({
    workspaceId: workspace.id,
    profile: role === "reviewer" ? reviewerProfile : workerProfile,
    title: `${role}:${runId}`,
    taskNumber: 1418,
    mcpBindingPath: null,
    attempt: () => ({
      requestId,
      prompt: `Prompt for ${runId}`,
      labels: {
        "nucleus.task": "task-1418",
        "nucleus.run": runId,
        "nucleus.role": role,
      },
      environment: {},
    }),
  });

  const adapter = createAdapter(HostPolicies as unknown as HostPolicyConstructor, host, {
    socketPath: join(directory, "callback.sock"),
    helperPath: join(directory, "worker-report.mjs"),
  });
  let listedProcesses: HostProcessFact[] | null = [];
  adapter.hostProcessListing = async () => listedProcesses;
  adapter.verifyPr = async (_task, prNumber) => ({
    prNumber,
    url: `https://github.com/org/repo/pull/${prNumber}`,
    head: HEAD,
    base: "main",
    state: "open",
    mergeable: true,
  });
  adapter.verifyResume = async () => {};
  adapter.verifyInspectedRevisionHead = async () => {};

  const store = new Store(join(directory, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("hostId", host.hostId);
  const engine = new Engine(store, adapter, 0);
  t.after(() => engine.stop());

  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: "sub-1418",
      title: "Reconcile retired T3 participant custody",
      repoPath: worktreeDir,
      planningCommit: BASE,
      handoffPath: "handoff.md",
      originAgentId: "origin-1418",
    }),
    host.hostId,
    "handoff",
    BASE,
  );

  return {
    directory,
    worktreeDir,
    scratchRoot,
    server,
    host,
    workspace,
    adapter,
    store,
    engine,
    task: store.task(inserted.id),
    makeSpec,
    setProcesses(next: HostProcessFact[] | null) {
      listedProcesses = next;
    },
  };
}

function seedOrdinaryRoundState(
  f: Awaited<ReturnType<typeof setupT3Engine>>,
  ids: {
    workerId: string;
    retiredWorkerId: string;
    priorReviewerId: string;
    nextReviewerId: string;
  },
) {
  for (const id of [ids.workerId, ids.retiredWorkerId, ids.priorReviewerId, ids.nextReviewerId]) {
    const entry = f.server.threads.get(id);
    if (!entry) continue;
    for (const run of entry.runs) run.status = "completed";
    if ("activeRunId" in entry.thread) entry.thread.activeRunId = null;
  }
  const currentTicket = "worker-current-ticket";
  const retiredTicket = "worker-retired-ticket";
  const currentDir = runTemporaryDirectory(currentTicket, f.scratchRoot);
  const retiredDir = runTemporaryDirectory(retiredTicket, f.scratchRoot);
  mkdirSync(currentDir, { recursive: true });
  mkdirSync(retiredDir, { recursive: true });

  const now = new Date().toISOString();
  const priorRun: Run = {
    id: "prior-review-run",
    taskId: f.task.id,
    role: "reviewer",
    generation: 1,
    head: HEAD,
    base: BASE,
    agentId: ids.priorReviewerId,
    workspaceId: f.workspace.id,
    profile: reviewerProfile,
    profileGroup: "reviewers",
    temporaryDirectory: runTemporaryDirectory("prior-review-run", f.scratchRoot),
    status: "finished",
    createdAt: now,
    lastObservedAt: null,
    active: false,
    idleSince: null,
    released: true,
    completion: {
      eventId: "evt-prior-review",
      taskId: f.task.id,
      runId: "prior-review-run",
      status: "changes_required",
      summary: "Needs follow-up",
    },
  };
  mkdirSync(priorRun.temporaryDirectory!, { recursive: true });
  f.store.putRun(priorRun);
  f.store.db
    .prepare("INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)")
    .run("evt-prior-review", f.task.id, priorRun.id, "hash-1", JSON.stringify({ accepted: true }));

  const nextRun: Run = {
    id: "next-review-run",
    taskId: f.task.id,
    role: "reviewer",
    generation: 2,
    head: HEAD,
    base: BASE,
    agentId: ids.nextReviewerId,
    priorRunId: priorRun.id,
    ordinaryDetached: true,
    workspaceId: f.workspace.id,
    profile: reviewerProfile,
    profileGroup: "reviewers",
    temporaryDirectory: runTemporaryDirectory("next-review-run", f.scratchRoot),
    status: "intent",
    createdAt: now,
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: false,
  };
  mkdirSync(nextRun.temporaryDirectory!, { recursive: true });
  f.store.putRun(nextRun);

  f.store.update(f.task.id, {
    phase: "reviewing",
    agentId: ids.workerId,
    runId: currentTicket,
    directory: f.worktreeDir,
    workspaceId: f.workspace.id,
    prUrl: "https://github.com/org/repo/pull/42",
    prHead: HEAD,
    resumePrNumber: 42,
    profile: workerProfile,
    profileGroup: "workers",
    workerModel: workerProfile.model,
    workerModels: [workerProfile.model],
    temporaryDirectory: currentDir,
    retiredWorkers: [
      {
        agentId: ids.retiredWorkerId,
        runId: retiredTicket,
        profile: workerProfile,
        reason: "Non-delivery replacement",
      },
    ],
    resolution: {
      ...f.store.task(f.task.id).resolution,
      currentRunId: nextRun.id,
      reviewerAgentId: ids.nextReviewerId,
      reviewerProfile,
    },
  });

  f.store.event(
    f.task.id,
    "owned_tool_hold",
    JSON.stringify({ runId: retiredTicket, reason: "prior bounded hold" }),
  );

  return {
    task: f.store.task(f.task.id),
    priorRun,
    nextRun,
    currentTicket,
    retiredTicket,
    currentDir,
    retiredDir,
  };
}

test("retired and gone T3 participants reconcile through positive custody and scratch process proof without snapshotting retired threads", async (t) => {
  const f = await setupT3Engine(t);
  const worker = await f.host.createAgent(f.makeSpec("w-cur", "worker", "worker-current-ticket"));
  const retired = await f.host.createAgent(f.makeSpec("w-ret", "worker", "worker-retired-ticket"));
  const priorReviewer = await f.host.createAgent(f.makeSpec("r-old", "reviewer", "prior-review-run"));
  const nextReviewer = await f.host.createAgent(f.makeSpec("r-new", "reviewer", "next-review-run"));

  // Simulate barge#107 + swallowtail#252: retired worker is archived on T3 and
  // prior reviewer was archived (then also test purged/deleted-from-inventory).
  await f.host.archiveAgent(retired.id);
  await f.host.archiveAgent(priorReviewer.id);

  const seeded = seedOrdinaryRoundState(f, {
    workerId: worker.id,
    retiredWorkerId: retired.id,
    priorReviewerId: priorReviewer.id,
    nextReviewerId: nextReviewer.id,
  });

  const beforeSubRetired = subscribeRequests(f.server, retired.id);
  const beforeSubPrior = subscribeRequests(f.server, priorReviewer.id);

  await f.engine.resolution.ordinaryRoundCustody(seeded.task, seeded.nextRun);

  assert.equal(
    subscribeRequests(f.server, retired.id),
    beforeSubRetired,
    "archived retired worker must not trigger orchestration.subscribeThread",
  );
  assert.equal(
    subscribeRequests(f.server, priorReviewer.id),
    beforeSubPrior,
    "archived prior reviewer must not trigger orchestration.subscribeThread",
  );
  assert.deepEqual(
    ownerPendingEffects(collectOwnerVerbFacts(f.store, f.store.task(seeded.task.id)))
      .filter((effect) => effect.kind === "owned_tool"),
    [],
    "positive retired custody + process proof settles recorded owned_tool_hold",
  );

  // Now purge the retired worker from T3's complete inventory (`originAgent === null`):
  // positive gone proof + scratch process proof still succeeds without snapshotting.
  f.server.threads.delete(retired.id);
  await f.engine.resolution.ordinaryRoundCustody(f.store.task(seeded.task.id), seeded.nextRun);
});

test("execution lease reconciles retired T3 custody and keeps live or ambiguous evidence blocking", async (t) => {
  const f = await setupT3Engine(t);
  const worker = await f.host.createAgent(f.makeSpec("lease-worker", "worker", "worker-current-ticket"));
  const retired = await f.host.createAgent(f.makeSpec("lease-retired", "worker", "worker-retired-ticket"));
  const prior = await f.host.createAgent(f.makeSpec("lease-prior", "reviewer", "prior-review-run"));
  const next = await f.host.createAgent(f.makeSpec("lease-next", "reviewer", "next-review-run"));
  await f.host.archiveAgent(retired.id);
  const seeded = seedOrdinaryRoundState(f, { workerId: worker.id, retiredWorkerId: retired.id,
    priorReviewerId: prior.id, nextReviewerId: next.id });
  const task = f.store.task(seeded.task.id);
  const before = subscribeRequests(f.server, retired.id);
  assert.equal(await f.engine.resolution.executionLease(task, undefined, true, true), true);
  assert.equal(subscribeRequests(f.server, retired.id), before);
  assert.equal(await f.engine.resolution.executionLease(task, undefined, true, true), true, "replay remains safe");
  f.setProcesses([{ pid: 12345, ppid: 1, pgid: 12345, cwd: seeded.retiredDir,
    command: "node live-retired-child.mjs" } as HostProcessFact]);
  assert.equal(await f.engine.resolution.executionLease(task, undefined, true, true), false);
  f.setProcesses(null);
  assert.equal(await f.engine.resolution.executionLease(task, undefined, true, true), false);
  f.setProcesses([]);
  f.store.putRun({ ...seeded.nextRun, released: true, status: "finished" });
  f.store.update(task.id, {
    phase: "merging",
    completion: { taskId: task.id, runId: seeded.currentTicket, eventId: "worker-ready",
      status: "ready_for_review", summary: "Ready", prNumber: 42 },
    resolution: { ...f.store.task(task.id).resolution,
      review: { taskId: task.id, runId: seeded.priorRun.id, eventId: "approved",
        status: "ready_to_merge", summary: "Approved", head: HEAD, reviewId: 42 } },
  });
  (f.adapter as typeof f.adapter & ResolutionAdapter).externalMerge = async () => ({ head: HEAD, commit: "c".repeat(40) });
  assert.equal(await f.engine.resolution.recoverExternalMerge(f.store.task(task.id)), true);
  assert.equal(f.store.task(task.id).resolution.mergedCommit, "c".repeat(40));
  assert.equal(f.store.task(task.id).phase, "syncing");
});

test("ordinary review refuses closed receiving reviewer, wrong-workspace origin, unrecorded root, unavailable timeline without probes, and live scratch process", async (t) => {
  const f = await setupT3Engine(t);
  const worker = await f.host.createAgent(f.makeSpec("w-cur", "worker", "worker-current-ticket"));
  const retired = await f.host.createAgent(f.makeSpec("w-ret", "worker", "worker-retired-ticket"));
  const priorReviewer = await f.host.createAgent(f.makeSpec("r-old", "reviewer", "prior-review-run"));
  const nextReviewer = await f.host.createAgent(f.makeSpec("r-new", "reviewer", "next-review-run"));

  await f.host.archiveAgent(retired.id);
  await f.host.archiveAgent(priorReviewer.id);
  f.engine.wakeTask = async () => {};
  const seeded = seedOrdinaryRoundState(f, {
    workerId: worker.id,
    retiredWorkerId: retired.id,
    priorReviewerId: priorReviewer.id,
    nextReviewerId: nextReviewer.id,
  });

  // 1. Live process under the retired worker's beside scratch directory refuses.
  f.setProcesses([
    {
      pid: 90421,
      ppid: 1,
      pgid: 90421,
      uid: 501,
      startIdentity: "start-90421",
      command: "node runaway-tool.mjs",
      cwd: seeded.retiredDir,
    },
  ]);
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(seeded.task, seeded.nextRun),
    /Ordinary review participant has live or unknown tools/,
  );
  f.setProcesses([]);

  // 2. Unrecorded scratch directory refuses.
  f.store.update(seeded.task.id, { temporaryDirectory: "" });
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(f.store.task(seeded.task.id), seeded.nextRun),
    /a participant run temporary directory is unrecorded/,
  );
  f.store.update(seeded.task.id, { temporaryDirectory: seeded.currentDir });

  // 3. Deleted/gone retired worker on an adapter without process probes refuses:
  //    unavailable timeline alone never clears a retired/gone participant.
  const probes = f.adapter as unknown as {
    noLiveWorkspaceProcesses?: typeof f.adapter.noLiveWorkspaceProcesses;
    hostProcessListing?: typeof f.adapter.hostProcessListing;
  };
  const savedNoLive = probes.noLiveWorkspaceProcesses;
  const savedListing = probes.hostProcessListing;
  f.server.threads.delete(retired.id);
  probes.noLiveWorkspaceProcesses = undefined;
  probes.hostProcessListing = undefined;
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(f.store.task(seeded.task.id), seeded.nextRun),
    /owned workspace or run process identity is unavailable/,
  );
  probes.noLiveWorkspaceProcesses = savedNoLive;
  probes.hostProcessListing = savedListing;

  // 4. Wrong-workspace fence on retired worker origin refuses.
  const foreignDir = join(f.directory, "foreign-repo");
  mkdirSync(foreignDir, { recursive: true });
  const foreignWorkspace = await f.host.createWorkspace({
    title: "Foreign worktree",
    requestId: "foreign-workspace-intent",
    directory: await realpath(foreignDir),
    project: { projectId: "synthetic-project" },
  });
  const foreignRow = f.server.threads.get(priorReviewer.id)!;
  f.server.threads.set(retired.id, {
    ...foreignRow,
    thread: {
      ...foreignRow.thread,
      id: retired.id,
      projectId: "synthetic-project",
      worktreePath: foreignWorkspace.directory,
      archivedAt: "2026-11-20T00:00:00.000Z",
      deletedAt: null,
    },
  });
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(f.store.task(seeded.task.id), seeded.nextRun),
    /Ordinary review participant is not idle and permission-free in the recorded workspace/,
  );
  f.server.threads.delete(retired.id);

  // 5. Exact-head receiving reviewer that is closed/archived refuses: never treated as retired.
  await f.host.archiveAgent(nextReviewer.id);
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(f.store.task(seeded.task.id), seeded.nextRun),
    /Ordinary review participant is not idle and permission-free in the recorded workspace/,
  );
});

test("transient or unreadable T3 projection preserves the actionable T3 cause and recovers without stale failure override", async (t) => {
  const f = await setupT3Engine(t);
  const worker = await f.host.createAgent(f.makeSpec("w-cur", "worker", "worker-current-ticket"));
  const retired = await f.host.createAgent(f.makeSpec("w-ret", "worker", "worker-retired-ticket"));
  const priorReviewer = await f.host.createAgent(f.makeSpec("r-old", "reviewer", "prior-review-run"));
  const nextReviewer = await f.host.createAgent(f.makeSpec("r-new", "reviewer", "next-review-run"));

  await f.host.archiveAgent(retired.id);
  await f.host.archiveAgent(priorReviewer.id);
  f.engine.wakeTask = async () => {};
  const seeded = seedOrdinaryRoundState(f, {
    workerId: worker.id,
    retiredWorkerId: retired.id,
    priorReviewerId: priorReviewer.id,
    nextReviewerId: nextReviewer.id,
  });

  // Incomplete T3 projection on live worker timeline preserves the exact field cause,
  // never flattening to `unavailable`.
  f.server.controls.incompleteThread = true;
  await assert.rejects(
    f.host.agentTimelinePage(worker.id, 100),
    /hasMoreHistory true with no cursor/,
  );
  await assert.rejects(
    f.engine.resolution.ordinaryRoundCustody(seeded.task, seeded.nextRun),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /hasMoreHistory true with no cursor/);
      assert.doesNotMatch(error.message, /read 1 is unavailable/);
      return true;
    },
  );

  // Recover via deliverLaunchRun too: pre-send non-transport refusal parks with the real cause,
  // and once T3 evidence returns, fresh positive proof succeeds regardless of the stale failure.
  await f.engine.resolution.deliverLaunchRun(f.store.task(seeded.task.id), "reviewer", {
    agentId: seeded.nextRun.agentId,
    firstReviewEntryWorker: false,
    nonDeliveryReplacement: false,
    run: seeded.nextRun,
    workspaceId: f.workspace.id,
    profile: reviewerProfile,
    group: "reviewers",
    token: "tok-1418",
  });
  const refusedTask = f.store.task(seeded.task.id);
  assert.equal(refusedTask.phase, "needs_attention");
  assert.match(refusedTask.reason, /hasMoreHistory true with no cursor/);
  assert.doesNotMatch(refusedTask.reason, /read 1 is unavailable/);

  f.server.controls.incompleteThread = false;
  const retryRun: Run = { ...seeded.nextRun, id: "next-review-run-2", status: "intent" };
  f.store.putRun(retryRun);
  f.store.update(seeded.task.id, {
    resolution: { ...f.store.task(seeded.task.id).resolution, currentRunId: retryRun.id },
  });
  await f.engine.resolution.ordinaryRoundCustody(f.store.task(seeded.task.id), retryRun, false);
});

test("deliverLaunchRun releases unsent ordinaryDetached run and defers transport on T3 transport/timeout failure", async (t) => {
  const f = await setupT3Engine(t);
  const worker = await f.host.createAgent(f.makeSpec("w-cur", "worker", "worker-current-ticket"));
  const retired = await f.host.createAgent(f.makeSpec("w-ret", "worker", "worker-retired-ticket"));
  const priorReviewer = await f.host.createAgent(f.makeSpec("r-old", "reviewer", "prior-review-run"));
  const nextReviewer = await f.host.createAgent(f.makeSpec("r-new", "reviewer", "next-review-run"));

  await f.host.archiveAgent(retired.id);
  await f.host.archiveAgent(priorReviewer.id);
  f.engine.wakeTask = async () => {};
  const seeded = seedOrdinaryRoundState(f, {
    workerId: worker.id,
    retiredWorkerId: retired.id,
    priorReviewerId: priorReviewer.id,
    nextReviewerId: nextReviewer.id,
  });

  // Simulated T3 read interruption produces a transport outage on observe/timeline.
  f.server.controls.interruptThreadReads = 1;
  await assert.rejects(
    f.engine.resolution.deliverLaunchRun(seeded.task, "reviewer", {
      agentId: seeded.nextRun.agentId,
      firstReviewEntryWorker: false,
      nonDeliveryReplacement: false,
      run: seeded.nextRun,
      workspaceId: f.workspace.id,
      profile: reviewerProfile,
      group: "reviewers",
      token: "tok-1418-2",
    }),
    /T3Code (?:transport|timeout)/i,
  );
  const afterTask = f.store.task(seeded.task.id);
  const releasedRun = f.store.run(seeded.nextRun.id)!;
  assert.equal(releasedRun.status, "superseded");
  assert.equal(releasedRun.released, true);
  assert.equal(afterTask.resolution.currentRunId, null);
  assert.notEqual(afterTask.phase, "needs_attention");
  assert.equal(afterTask.resolution.attention, false);
});

test("retry_effect owned_tool.<runId> and move to=review reconcile recorded owned_tool holds on retired/gone participants", async (t) => {
  const f = await setupT3Engine(t);
  const worker = await f.host.createAgent(f.makeSpec("w-cur", "worker", "worker-current-ticket"));
  const retired = await f.host.createAgent(f.makeSpec("w-ret", "worker", "worker-retired-ticket"));
  const priorReviewer = await f.host.createAgent(f.makeSpec("r-old", "reviewer", "prior-review-run"));
  const nextReviewer = await f.host.createAgent(f.makeSpec("r-new", "reviewer", "next-review-run"));

  await f.host.archiveAgent(retired.id);
  await f.host.archiveAgent(priorReviewer.id);
  f.engine.wakeTask = async () => {};
  const seeded = seedOrdinaryRoundState(f, {
    workerId: worker.id,
    retiredWorkerId: retired.id,
    priorReviewerId: priorReviewer.id,
    nextReviewerId: nextReviewer.id,
  });
  f.server.threads.delete(retired.id);

  // Prepare task for owner retry_effect and move to=review (with retained PR & released prior run).
  f.store.putRun({ ...seeded.nextRun, status: "superseded", released: true });
  f.store.update(seeded.task.id, {
    phase: "needs_attention",
    prUrl: null,
    resumePrNumber: 42,
    resolution: {
      ...f.store.task(seeded.task.id).resolution,
      currentRunId: null,
      attention: true,
    },
  });

  // Live process blocks retry_effect first.
  f.setProcesses([
    {
      pid: 99100,
      ppid: 1,
      pgid: 99100,
      uid: 501,
      startIdentity: "start-99100",
      command: "node live-retired-child.mjs",
      cwd: seeded.retiredDir,
    },
  ]);
  await assert.rejects(
    f.engine.performTaskControl({
      action: "retry_effect",
      taskId: seeded.task.id,
      version: f.store.task(seeded.task.id).version,
      effect: `owned_tool.${seeded.retiredTicket}`,
      reason: "check retired worker hold",
      caller: CALLER,
    }),
    /Owned-tool hold worker-retired-ticket remains/,
  );

  // Process exits -> retry_effect reconciles and settles the owned_tool hold cleanly.
  f.setProcesses([]);
  await f.engine.performTaskControl({
    action: "retry_effect",
    taskId: seeded.task.id,
    version: f.store.task(seeded.task.id).version,
    effect: `owned_tool.${seeded.retiredTicket}`,
    reason: "reconcile cleared retired worker hold",
    caller: CALLER,
  });
  assert.deepEqual(
    ownerPendingEffects(collectOwnerVerbFacts(f.store, f.store.task(seeded.task.id)))
      .filter((effect) => effect.kind === "owned_tool"),
    [],
  );

  // Re-record an owned_tool_hold and verify `move to=review` ALSO reconciles it once proven clear
  // (while refusing first when a live process holds the retired scratch dir).
  f.store.event(
    seeded.task.id,
    "owned_tool_hold",
    JSON.stringify({ runId: seeded.retiredTicket, reason: "stale hold" }),
  );
  f.setProcesses([
    {
      pid: 99101,
      ppid: 1,
      pgid: 99101,
      uid: 501,
      startIdentity: "start-99101",
      command: "node live-retired-child.mjs",
      cwd: seeded.retiredDir,
    },
  ]);
  await assert.rejects(
    f.engine.performTaskControl({
      action: "move",
      to: "review",
      taskId: seeded.task.id,
      version: f.store.task(seeded.task.id).version,
      reason: "should refuse while retired scratch has live process",
      caller: CALLER,
    }),
    /Owned-tool hold worker-retired-ticket remains/,
  );

  f.setProcesses([]);
  const moved = await f.engine.performTaskControl({
    action: "move",
    to: "review",
    taskId: seeded.task.id,
    version: f.store.task(seeded.task.id).version,
    reason: "reconcile retired worker hold and enter review",
    caller: CALLER,
  });
  assert.equal(moved.phase, "awaiting_review");
  assert.deepEqual(
    ownerPendingEffects(collectOwnerVerbFacts(f.store, moved))
      .filter((effect) => effect.kind === "owned_tool"),
    [],
  );
});

test("participantTemporaryDirectory resolves replaced task leaves beside retired or run tickets while rejecting foreign hosts", () => {
  const root = "/synthetic/mount/scratch/nucleus";
  const retiredTicket = "retired-worker-ticket";
  const replacedTicket = "replaced-worker-ticket";
  const currentTicket = "current-worker-ticket";
  const task: Task = {
    id: "task-1",
    hostId: "t3code:local",
    runId: currentTicket,
    temporaryDirectory: runTemporaryDirectory(retiredTicket, root),
    retiredWorkers: [
      { agentId: "w1", runId: retiredTicket, hostId: "t3code:local", profile: workerProfile, reason: "replaced" },
      { agentId: "w2", runId: replacedTicket, profile: workerProfile, reason: "replaced" },
      { agentId: "w3", runId: "foreign-ticket", hostId: "paseo:remote", profile: workerProfile, reason: "rehosted" },
    ],
  } as unknown as Task;

  // Task leaf still carries the replaced worker's own directory after task.runId moved:
  assert.equal(
    participantTemporaryDirectory(task, [], retiredTicket),
    runTemporaryDirectory(retiredTicket, root),
  );
  // Another retired worker on the same host resolves beside that leaf:
  assert.equal(
    participantTemporaryDirectory(task, [], replacedTicket),
    runTemporaryDirectory(replacedTicket, root),
  );
  // Foreign-host retired worker still returns undefined:
  assert.equal(participantTemporaryDirectory(task, [], "foreign-ticket"), undefined);
});
