import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import { reconcileRoutingSignoffs } from "../core/dispatch/routing-signoff";
import { Store } from "../core/store/store";
import { git } from "../core/git/index";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import {
  poolSchema,
  submissionSchema,
  taskControlInputSchema,
  type Profile,
} from "../shared/contracts";
import { fakeAdapter, profile, submission } from "./support/fakes";

function setupMultiHostFixture(options?: {
  usageLevel?: "low" | "normal" | "high" | "maximum";
  paseoProfiles?: Profile[];
  t3Profiles?: Profile[];
  extraPool?: Array<ReturnType<typeof poolSchema.parse>>;
  repoPath?: string;
}) {
  const store = new Store(":memory:");
  const paseoWorker = profile("paseo-only", "sonnet", {
    provider: "anthropic",
    supportedThinking: ["medium"],
  });
  const t3Worker = profile("t3-only", "gpt-5.4", {
    provider: "codex",
    supportedThinking: ["high"],
  });
  const t3SameModel = profile("t3-same-model", "sonnet", {
    provider: "codex",
    supportedThinking: ["medium"],
  });
  const t3Frontier = profile("t3-frontier", "opus", {
    provider: "codex",
    supportedThinking: ["xhigh"],
  });
  const paseoReviewer = profile("paseo-reviewer", "haiku", {
    provider: "anthropic",
  });
  const t3Reviewer = profile("t3-reviewer", "gpt-5-mini", {
    provider: "codex",
  });
  const paseoProfiles = options?.paseoProfiles ?? [paseoWorker, paseoReviewer];
  const t3Profiles = options?.t3Profiles ?? [
    t3Worker,
    t3SameModel,
    t3Frontier,
    t3Reviewer,
  ];
  const allProfiles = [...paseoProfiles, ...t3Profiles];
  const workerIds = new Set(["paseo-only", "t3-only", "t3-same-model", "t3-frontier"]);
  const pool = [
    ...allProfiles.map((p) =>
      poolSchema.parse({
        profileId: p.id,
        enabled: true,
        group: p.id,
        weight: 1,
        scopes: ["general"],
        capability: p.id === "t3-frontier" ? "frontier" : workerIds.has(p.id) ? "heavyweight" : "worker",
        cost: p.id === "t3-frontier" ? "very_high" : "medium",
        roles: workerIds.has(p.id) ? ["worker"] : ["reviewer"],
      }),
    ),
    ...(options?.extraPool ?? []),
  ];
  store.setMeta("pool", pool);
  store.setMeta("usageLevel", options?.usageLevel ?? "normal");
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 12);

  const archivedWorkspaces: Array<{ host: string; id: string }> = [];
  const archivedAgents: Array<{ host: string; id: string }> = [];
  const createdWorkspaces: Array<{ host: string; id: string; dir: string }> = [];
  const launchedRuns: Array<{ host: string; profileId: string; taskId: string }> = [];
  const cancelledAgents: Array<{ host: string; agentId: string }> = [];
  const agentWorkspaces = new Map<string, string>();
  const agentStatuses = new Map<string, { status: string; active: boolean }>();

  const makeAdapter = (hostId: string) =>
    fakeAdapter({
      hostId,
      validate: async () => "a".repeat(40),
      createWorkspace: async (task) => {
        const id = `ws-${hostId.replace(/:/g, "-")}-${task.id}`;
        const dir = join(
          options?.repoPath ?? "/synthetic",
          `worktrees-${task.id}`,
        );
        createdWorkspaces.push({ host: hostId, id, dir });
        return { id, directory: dir };
      },
      recoverTaskWorkspace: async (task) => {
        const id = `ws-rec-${hostId.replace(/:/g, "-")}-${task.id}`;
        const dir = join(
          options?.repoPath ?? "/synthetic",
          `worktrees-${task.id}`,
        );
        createdWorkspaces.push({ host: hostId, id, dir });
        return { id, directory: dir };
      },
      archiveTaskWorkspace: async (_task, workspaceId) => {
        archivedWorkspaces.push({ host: hostId, id: workspaceId });
        return [];
      },
      createAgent: async (task) => {
        const id = `ag-${hostId.replace(/:/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
        agentWorkspaces.set(id, task.workspaceId ?? "");
        agentStatuses.set(id, { status: "idle", active: false });
        return { id, workspaceId: task.workspaceId };
      },
      observe: async (agentId) => {
        const st = agentStatuses.get(agentId) ?? { status: "idle", active: false };
        return {
          id: agentId,
          workspaceId: agentWorkspaces.get(agentId) ?? null,
          status: st.status,
          active: st.active,
          permissions: false,
          error: "",
          labels: { task: currentTaskId ?? "" },
        };
      },
      stopAgentTurn: async (agentId: string) => {
        cancelledAgents.push({ host: hostId, agentId });
        agentStatuses.set(agentId, { status: "idle", active: false });
      },
      archiveAgent: async (agentId: string) => {
        archivedAgents.push({ host: hostId, id: agentId });
      },
      originAgent: async (agentId: string) => ({
        id: agentId,
        workspaceId: agentWorkspaces.get(agentId) ?? null,
        title: "",
        deleted: false,
        archived: archivedAgents.some((a) => a.host === hostId && a.id === agentId),
      }),
      verifyResume: async () => "c".repeat(40),
      verifyPrIdentity: async (task) => ({
        number: task.resumePrNumber ?? 42,
        url: task.prUrl ?? "https://github.com/org/repo/pull/42",
        head: task.prHead ?? "c".repeat(40),
        base: "main",
        mergeable: "CLEAN",
        behind: 0,
      }),
      verifyPr: async (task) => ({
        number: task.resumePrNumber ?? 42,
        url: task.prUrl ?? "https://github.com/org/repo/pull/42",
        head: task.prHead ?? "c".repeat(40),
        base: "main",
        mergeable: "CLEAN",
        behind: 0,
      }),
      createRun: async (task, run) => {
        const id = `ag-${hostId.replace(/:/g, "-")}-${run.id}`;
        agentWorkspaces.set(id, task.workspaceId ?? "");
        agentStatuses.set(id, { status: "idle", active: false });
        launchedRuns.push({
          host: hostId,
          profileId: run.profile?.id ?? "",
          taskId: task.id,
        });
        return { id, workspaceId: task.workspaceId };
      },
    });

  let currentTaskId: string | null = null;
  const paseo = makeAdapter("paseo:one");
  const t3 = makeAdapter("t3code:one");
  const engine = new Engine(store, paseo, 0);
  engine.profiles = paseoProfiles;
  engine.hostIds = () => ["paseo:one", "t3code:one"];
  engine.resolveHostAdapter = (id) => (id === "t3code:one" ? t3 : paseo);
  engine.profileCatalogKnownFor = () => true;
  engine.profilesFor = (id) =>
    id === "t3code:one" ? t3Profiles : paseoProfiles;

  return {
    store,
    engine,
    paseoWorker,
    t3Worker,
    t3SameModel,
    t3Frontier,
    archivedWorkspaces,
    archivedAgents,
    createdWorkspaces,
    launchedRuns,
    cancelledAgents,
    agentWorkspaces,
    agentStatuses,
    setTaskId: (id: string) => {
      currentTaskId = id;
    },
  };
}

test("required-profile availability counts online secondary hosts and clears once back online", async () => {
  const f = setupMultiHostFixture();
  try {
    const task = f.store.insert(
      submission({
        complexity: "very_high",
        preferredProfileId: "t3-only",
        requirePreferred: true,
        thinkingOptionId: "high",
      }),
      "paseo:one",
      "handoff",
      "a".repeat(40),
    );
    const decisions = new Decisions(f.store);

    // t3code:one is online and can launch t3-only in high thinking mode -> no unavailable decision
    reconcileRoutingSignoffs(
      f.store,
      decisions,
      task.id,
      f.engine.profilesFor(task.hostId),
      {
        workerProfiles: f.engine.workerRoutingProfiles(task),
        workerCatalogPending: f.engine.workerHostCatalogPending(task),
      },
    );
    assert.equal(decisions.list({ status: "open" }).length, 0);

    // If t3code:one goes offline, required t3-only IS unavailable -> asks once
    f.engine.hostAvailable = (id) => id !== "t3code:one";
    reconcileRoutingSignoffs(
      f.store,
      decisions,
      task.id,
      f.engine.profilesFor(task.hostId),
      {
        workerProfiles: f.engine.workerRoutingProfiles(f.store.task(task.id)),
        workerCatalogPending: f.engine.workerHostCatalogPending(task),
      },
    );
    const open = decisions.list({ status: "open" });
    assert.equal(open.length, 1);
    assert.match(
      open[0]!.question,
      /Required worker profile t3-only is missing, disabled or unavailable/,
    );

    // Once t3code:one comes back online, the wait clears automatically
    f.engine.hostAvailable = () => true;
    reconcileRoutingSignoffs(
      f.store,
      decisions,
      task.id,
      f.engine.profilesFor(task.hostId),
      {
        workerProfiles: f.engine.workerRoutingProfiles(f.store.task(task.id)),
        workerCatalogPending: f.engine.workerHostCatalogPending(task),
      },
    );
    assert.equal(decisions.list({ status: "open" }).length, 0);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("next route view offers cross-host move only when target host is online and supports task mode", async () => {
  const f = setupMultiHostFixture();
  try {
    const task = f.store.insert(
      submission({
        complexity: "very_high",
        preferredProfileId: "t3-only",
        requirePreferred: true,
        thinkingOptionId: "high",
      }),
      "paseo:one",
      "handoff",
      "a".repeat(40),
    );
    f.store.update(task.id, {
      phase: "changes_requested",
      workspaceId: "ws-paseo-1",
      directory: "/synthetic/ws-paseo-1",
      profile: f.paseoWorker,
      profileRequests: {
        worker: {
          profileId: "t3-only",
          reason: "Move to T3",
          required: true,
          thinkingOptionId: "high",
        },
      },
    });

    const nextFor = (id: string) => {
      const current = f.store.task(id);
      return ownerTaskNext({
        ...collectOwnerVerbFacts(f.store, current),
        hostProfiles: f.engine.workerRoutingProfiles(current),
        hostViews: f.engine.routingHostViews(current),
      });
    };
    const onlineView = nextFor(task.id);
    const workerVerb = onlineView.verbs.find(
      (v) => v.verb === "route" && v.args?.role === "worker",
    );
    assert.equal(workerVerb?.available, true);
    assert.equal(workerVerb?.args?.profileId, "t3-only");
    assert.deepEqual(workerVerb?.fill, ["reason"]);
    assert.match(workerVerb?.note ?? "", /moves this task from paseo:one to t3code:one/);

    // Target host lacks requested thinking mode ("xhigh" not in t3-only supportedThinking)
    f.store.update(task.id, {
      thinkingOptionId: "xhigh",
      profileRequests: {
        worker: {
          profileId: "t3-only",
          reason: "Needs xhigh",
          required: true,
          thinkingOptionId: "xhigh",
        },
      },
    });
    const badModeView = nextFor(task.id);
    const badModeVerb = badModeView.verbs.find(
      (v) => v.verb === "route" && v.args?.role === "worker",
    );
    assert.equal(badModeVerb?.args?.profileId, "");
    assert.deepEqual(badModeVerb?.fill, ["profileId", "reason"]);
    assert.match(badModeVerb?.note ?? "", /cannot launch on any online host/);

    // Target host offline clears profileId and explains host offline
    f.store.update(task.id, {
      thinkingOptionId: "high",
      profileRequests: {
        worker: {
          profileId: "t3-only",
          reason: "Move to T3",
          required: true,
          thinkingOptionId: "high",
        },
      },
    });
    f.engine.hostAvailable = (id) => id !== "t3code:one";
    const offlineView = nextFor(task.id);
    const offlineVerb = offlineView.verbs.find(
      (v) => v.verb === "route" && v.args?.role === "worker",
    );
    assert.equal(offlineVerb?.args?.profileId, "");
    assert.deepEqual(offlineVerb?.fill, ["profileId", "reason"]);
    assert.match(offlineVerb?.note ?? "", /Host offline/);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("route without now, route now, and board-approved route move dispatched task across Paseo and T3 with cleanup", async () => {
  const f = setupMultiHostFixture({ usageLevel: "normal" });
  try {
    // 1. Dispatched idle/needs_attention task on paseo:one moves on `route` (within level using same-model T3 profile)
    const task = f.store.insert(
      submission({ complexity: "very_high" }),
      "paseo:one",
      "handoff",
      "a".repeat(40),
    );
    f.setTaskId(task.id);
    f.agentWorkspaces.set("ag-paseo-1", "ws-paseo-1");
    f.agentStatuses.set("ag-paseo-1", { status: "idle", active: false });
    f.store.update(task.id, {
      phase: "needs_attention",
      workspaceId: "ws-paseo-1",
      directory: "/synthetic/ws-paseo-1",
      agentId: "ag-paseo-1",
      runId: "run-paseo-1",
      profile: f.paseoWorker,
      profileGroup: "paseo-only",
      prUrl: "https://github.com/org/repo/pull/42",
      prHead: "d".repeat(40),
      resumePrNumber: 42,
      completion: {
        taskId: task.id,
        runId: "run-paseo-1",
        eventId: "ev-1",
        status: "blocked",
        summary: "Blocked on old host",
        head: "d".repeat(40),
        prNumber: 42,
      },
    });
    const moved = await f.engine.applyTaskControlRoute(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: f.store.task(task.id).version,
        action: "route",
        role: "worker",
        profileId: "t3-same-model",
        reason: "Move to T3 worker",
      }),
      (v) => v,
    );
    assert.equal(moved.hostId, "t3code:one");
    assert.equal(moved.hostSelection?.basis, "worker_profile");
    assert.equal(moved.hostSelection?.hostId, "t3code:one");
    assert.equal(moved.branch, task.branch);
    assert.equal(moved.prUrl, "https://github.com/org/repo/pull/42");
    assert.equal(moved.prHead, "d".repeat(40));
    assert.equal(moved.resumePrNumber, 42);
    assert.equal(moved.workspaceId, null);
    assert.equal(moved.agentId, null);
    assert.equal(moved.retiredWorkers[0]?.hostId, "paseo:one");
    assert.equal(moved.resolution.displacedHostWorkspaces.length, 1);
    assert.equal(moved.resolution.displacedHostWorkspaces[0]?.hostId, "paseo:one");

    // Ordinary cleanup settles old host workspace & thread on paseo:one only once
    await f.engine.lifecycle.archive(f.store.task(task.id));
    const afterCleanup = f.store.task(task.id);
    assert.equal(
      afterCleanup.resolution.displacedHostWorkspaces[0]?.state,
      "archived",
    );
    assert.ok(
      f.archivedAgents.some(
        (entry) => entry.host === "paseo:one" && entry.id === "ag-paseo-1",
      ),
    );
    assert.equal(
      f.archivedAgents.some((entry) => entry.host === "t3code:one"),
      false,
    );

    // 2. Now task is on t3code:one; route to frontier paseo profile unsigned waits for board sign-off,
    // then `TaskQuantum` applies the approved route when answered on board!
    // Put a live active agent on t3code:one first
    await f.engine.withHost("t3code:one", () =>
      f.engine.taskQuantumOwner.taskQuantum(task.id),
    );
    await f.engine.withHost("t3code:one", () =>
      f.engine.resolution.advance(f.store.task(task.id)),
    );
    const runningTask = f.store.task(task.id);
    assert.ok(runningTask.workspaceId?.startsWith("ws-"));
    assert.ok(runningTask.agentId);
    f.agentWorkspaces.set(runningTask.agentId!, runningTask.workspaceId!);
    f.agentStatuses.set(runningTask.agentId!, { status: "running", active: true });
    const frontierPool = [
      ...f.store.pool().filter((e) => e.profileId !== "paseo-only"),
      poolSchema.parse({
        profileId: "paseo-only",
        enabled: true,
        group: "paseo-only",
        weight: 1,
        scopes: ["general"],
        capability: "frontier",
        cost: "very_high",
        roles: ["worker"],
      }),
    ];
    f.store.setMeta("pool", frontierPool);
    f.store.update(task.id, { phase: "working" });
    const signedPending = await f.engine.applyTaskControlRoute(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: f.store.task(task.id).version,
        action: "route",
        role: "worker",
        profileId: "paseo-only",
        reason: "Needs Paseo frontier profile",
        caller: "supervisor",
      }),
      (v) => v,
    );
    // Still on t3code:one waiting for operator board sign-off
    assert.equal(signedPending.hostId, "t3code:one");
    await f.engine.withHost("t3code:one", () =>
      f.engine.taskQuantumOwner.quantumFinish(task.id),
    );
    const decisionId =
      f.store.task(task.id).profileRequests?.worker?.signoff?.decisionId;
    assert.ok(decisionId);
    const decision = f.engine.signoffDecisions.get({ id: decisionId! });
    f.engine.signoffDecisions.answer({
      id: decision.id,
      version: decision.version,
      answer: decision.options[0]!,
      answeredBy: "operator (board)",
      relayed: false,
      note: "",
    });
    // Mark current T3 agent idle and let quantumFinish apply the approved route now!
    f.agentStatuses.set(runningTask.agentId!, { status: "idle", active: false });
    await f.engine.withHost("t3code:one", () =>
      f.engine.taskQuantumOwner.quantumFinish(task.id),
    );
    const movedBack = f.store.task(task.id);
    assert.equal(movedBack.hostId, "paseo:one");
    assert.equal(movedBack.profile?.id, "paseo-only");

    // 3. `route now=true` from paseo:one to t3code:one on an active agent cancels old run and moves immediately
    const task3 = f.store.insert(
      submission({ complexity: "very_high" }),
      "paseo:one",
      "handoff",
      "a".repeat(40),
    );
    f.setTaskId(task3.id);
    f.store.update(task3.id, {
      phase: "working",
      workspaceId: "ws-paseo-live",
      directory: "/synthetic/ws-paseo-live",
      agentId: "ag-paseo-live",
      runId: "run-paseo-live",
      profile: f.paseoWorker,
      profileGroup: "paseo-only",
      prUrl: "https://github.com/org/repo/pull/77",
      prHead: "f".repeat(40),
      resumePrNumber: 77,
    });
    f.agentWorkspaces.set("ag-paseo-live", "ws-paseo-live");
    f.agentStatuses.set("ag-paseo-live", { status: "running", active: true });
    const movedNow = await f.engine.applyTaskControlRoute(
      taskControlInputSchema.parse({
        taskId: task3.id,
        version: f.store.task(task3.id).version,
        action: "route",
        role: "worker",
        profileId: "t3-only",
        reason: "Replace live Paseo worker with T3 now",
        caller: "operator (board)",
        now: true,
      }),
      (v) => v,
    );
    assert.equal(movedNow.hostId, "t3code:one");
    assert.equal(movedNow.profile?.id, "t3-only");
    assert.equal(movedNow.prUrl, "https://github.com/org/repo/pull/77");
    assert.ok(
      f.cancelledAgents.some(
        (c) => c.host === "paseo:one" && c.agentId === "ag-paseo-live",
      ),
    );
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("restart fresh selection / WorkerFailover moves task to T3 when Paseo worker is excluded or routed", async () => {
  const f = setupMultiHostFixture();
  try {
    const task = f.store.insert(
      submission({ complexity: "very_high" }),
      "paseo:one",
      "handoff",
      "a".repeat(40),
    );
    f.setTaskId(task.id);
    f.agentWorkspaces.set("ag-paseo-fail", "ws-paseo-fail");
    f.agentStatuses.set("ag-paseo-fail", { status: "error", active: false });
    f.store.update(task.id, {
      phase: "working",
      workspaceId: "ws-paseo-fail",
      directory: "/synthetic/ws-paseo-fail",
      agentId: "ag-paseo-fail",
      runId: "run-paseo-fail",
      profile: f.paseoWorker,
      profileGroup: "paseo-only",
      failoverReason: "Provider quota exhausted",
      workerExclusions: [
        {
          agentId: null,
          profileId: "paseo-only",
          reason: "Exhausted",
          createdAt: new Date().toISOString(),
        },
      ],
      prUrl: "https://github.com/org/repo/pull/99",
      prHead: "e".repeat(40),
      resumePrNumber: 99,
    });
    // Mark t3-only unavailable except on t3code:one; leave paseo-only excluded
    await f.engine.recoverExhaustedWorkers();
    const moved = f.store.task(task.id);
    assert.equal(moved.hostId, "t3code:one");
    assert.equal(moved.hostSelection?.basis, "worker_profile");
    assert.ok(
      moved.profile?.id === "t3-only" || moved.profile?.id === "t3-same-model",
    );
    assert.equal(moved.prUrl, "https://github.com/org/repo/pull/99");
    assert.equal(moved.resolution.displacedHostWorkspaces[0]?.hostId, "paseo:one");

    await f.engine.lifecycle.archive(moved);
    await f.engine.withHost("t3code:one", () =>
      f.engine.taskQuantumOwner.taskQuantum(task.id),
    );
    assert.ok(f.store.task(task.id).workspaceId);
    assert.ok(
      f.launchedRuns.some(
        (run) =>
          run.host === "t3code:one" &&
          (run.profileId === "t3-only" || run.profileId === "t3-same-model"),
      ),
    );
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("route rejects move when real git worktree has uncommitted changes and recovers clean branch after move", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-cross-host-git-"));
  const repoDir = join(root, "repo");
  const worktreeDir = join(root, "wt");
  mkdirSync(repoDir, { recursive: true });
  await git(repoDir, "init");
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "Test");
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  await git(repoDir, "add", "README.md");
  await git(repoDir, "commit", "-m", "init");
  const head = await git(repoDir, "rev-parse", "HEAD");
  await git(repoDir, "worktree", "add", "-b", "ns-task-branch", worktreeDir, head);

  const f = setupMultiHostFixture({ repoPath: root });
  try {
    const task = f.store.insert(
      submission({
        complexity: "very_high",
        repoPath: repoDir,
        planningCommit: head,
      }),
      "paseo:one",
      "handoff",
      head,
    );
    f.store.update(task.id, {
      phase: "needs_attention",
      workspaceId: "ws-real-paseo",
      directory: worktreeDir,
      profile: f.paseoWorker,
      branch: "ns-task-branch",
    });
    // Dirty worktree refuses the cross-host move
    writeFileSync(join(worktreeDir, "dirty.txt"), "uncommitted\n");
    await assert.rejects(
      f.engine.applyTaskControlRoute(
        taskControlInputSchema.parse({
          taskId: task.id,
          version: f.store.task(task.id).version,
          action: "route",
          role: "worker",
          profileId: "t3-only",
          reason: "Try move while dirty",
        }),
        (v) => v,
      ),
      /uncommitted changes/,
    );
    rmSync(join(worktreeDir, "dirty.txt"));

    const moved = await f.engine.applyTaskControlRoute(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: f.store.task(task.id).version,
        action: "route",
        role: "worker",
        profileId: "t3-only",
        reason: "Move clean checkout",
      }),
      (v) => v,
    );
    assert.equal(moved.hostId, "t3code:one");
    assert.equal(moved.resolution.displacedHostWorkspaces[0]?.head, head);
  } finally {
    await f.engine.stop();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart fresh selection carries host change for approved same-model cross-host worker route", async () => {
  const f = setupMultiHostFixture();
  try {
    const task = f.store.insert(
      submission({ complexity: "very_high" }),
      "paseo:one",
      "handoff",
      "a".repeat(40),
    );
    f.setTaskId(task.id);
    f.agentWorkspaces.set("ag-paseo-restart", "ws-paseo-restart");
    f.agentStatuses.set("ag-paseo-restart", { status: "idle", active: false });
    f.store.update(task.id, {
      phase: "needs_attention",
      workspaceId: "ws-paseo-restart",
      directory: "/synthetic/ws-paseo-restart",
      agentId: "ag-paseo-restart",
      runId: "run-paseo-restart",
      profile: f.paseoWorker,
      profileGroup: "paseo-only",
      profileRequests: {
        worker: {
          profileId: "t3-same-model",
          reason: "Move on next fresh restart",
          required: true,
        },
      },
      prUrl: "https://github.com/org/repo/pull/101",
      prHead: "f".repeat(40),
      resumePrNumber: 101,
    });
    const armed = await f.engine.applyTaskControlRestart(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: f.store.task(task.id).version,
        action: "restart",
        role: "worker",
        fresh: true,
        reason: "Fresh restart to T3 same-model route",
      }),
      (v) => v,
    );
    assert.equal(armed.replacementProfile?.profileId, "t3-same-model");
    await f.engine.recoverExhaustedWorkers();
    const moved = f.store.task(task.id);
    assert.equal(moved.hostId, "t3code:one");
    assert.equal(moved.hostSelection?.basis, "worker_profile");
    assert.equal(moved.profile?.id, "t3-same-model");
    assert.equal(moved.prUrl, "https://github.com/org/repo/pull/101");
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
