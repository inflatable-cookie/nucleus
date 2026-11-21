import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import {
  ProvenPreSendRefusalError,
  type Adapter,
} from "../core/host";
import {
  T3InventoryChurnError,
  T3TransientReadError,
} from "../hosts/t3code/reads";
import {
  hostReadTransientKey,
  readHostReadTransientEpisode,
  unwrapCoordinatorRouteWrapper,
} from "../core/recovery/host-read-transient";
import { cause } from "../core/recovery/coordinator-episode";
import {
  CREATION_REFUSED_BEFORE_SEND,
  refusedLaunchProfiles,
} from "../core/recovery/refused-launch";
import { blockingRecoveryEffects } from "../core/recovery/recovery-effects";
import { noticeSettlement } from "../core/questions/notices";
import { noticeId } from "../core/questions/origin";
import { queueOperationSchema } from "../shared/operations";
import {
  noticeSchema,
  profileSchema,
  runSchema,
  submissionSchema,
} from "../shared/contracts";
import { collectOwnerVerbFacts, ownerVerbViews } from "../core/verbs/owner-verbs";
import { assembleOwnerTaskNext } from "../core/verbs/task-next";

const stamp = "2026-11-20T00:00:00.000Z";
const head = "a".repeat(40);
const base = "b".repeat(40);

function makeEngineFixture(
  t: TestContext,
  options: { dbPath?: string; repoDir?: string; hostId?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ns-host-obs-recovery-"));
  const repoDir = options.repoDir ?? join(dir, "repo");
  const dbPath = options.dbPath ?? join(dir, "queue.sqlite");
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

  const openEngine = (targetDbPath: string) => {
    const store = new Store(targetDbPath);
    store.setMeta("paused", false);
    store.setMeta("globalLimit", 10);
    store.setProfiles(
      [worker, reviewer, coordinator].map(
        ({ available: _a, problem: _p, supportedThinking: _s, ...stored }) =>
          stored,
      ),
    );
    store.setMeta("pool", [
      { profileId: "worker", enabled: true, group: "worker", roles: ["worker"], weight: 1, scopes: ["general"] },
      { profileId: "reviewer", enabled: true, group: "reviewer", roles: ["reviewer"], weight: 1, scopes: ["general"] },
      { profileId: "coord", enabled: true, group: "coord", roles: ["coordinator"], weight: 1, scopes: ["general"] },
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
    engine.profileCatalogKnown = () => true;
    engine.profileCatalogKnownFor = () => true;
    engine.hostIds = () => [hostId];
    engine.hostAvailable = () => true;
    engine.resolveHostAdapter = () => adapterProxy;
    let closed = false;
    return {
      store,
      engine,
      setAdapter(adapter: Adapter) {
        currentAdapter = Object.assign(
          {
            verifyWorkspace: async (task: { branch: string }) => task.branch,
            workspaceAvailable: async () => true,
          },
          adapter,
        ) as Adapter;
      },
      async close() {
        if (closed) return;
        closed = true;
        await engine.stop();
        store.close();
      },
    };
  };

  const handle = openEngine(dbPath);
  t.after(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    repoDir,
    dbPath,
    hostId,
    profiles: { worker, reviewer, coordinator },
    openEngine,
    ...handle,
  };
}

test("persisted projection-refusal records normalize without coordinator routing, profile exclusion, effect replay, or repeated reason wrapping", async (t) => {
  const f = makeEngineFixture(t);
  const underlying =
    "Worker admission could not read host state after 5 attempts over 120s: T3 thread.getSnapshot timed out for parent thread thr-parent";
  const wrappedReason =
    `No coordinator profile is available for recovery. No coordinator profile is available for recovery. ${underlying}`;

  const task = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-1461-persisted",
      title: "Persisted projection refusal",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-1461",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  f.store.putRun(
    runSchema.parse({
      id: "coord-run-persisted",
      taskId: task.id,
      role: "recovery",
      generation: 1,
      head: base,
      base,
      agentId: null,
      workspaceId: "ws-1461",
      profile: f.profiles.coordinator,
      status: "superseded",
      createdAt: stamp,
      lastObservedAt: null,
      active: null,
      idleSince: null,
      completion: null,
      released: true,
    }),
  );
  f.store.putOperation(
    queueOperationSchema.parse({
      id: "c".repeat(64),
      key: "op-1461-presend",
      kind: "task_control",
      hostId: f.hostId,
      taskId: task.id,
      expectedVersion: task.version,
      inputHash: "d".repeat(64),
      state: "needs_attention",
      attempts: 1,
      diagnostic: underlying,
      effect: {
        kind: "task_control",
        target: task.id,
        intentAt: stamp,
        status: "reconciled",
        result: underlying,
        resultAt: stamp,
      },
      createdAt: stamp,
      settledAt: stamp,
    }),
  );
  f.store.event(
    task.id,
    "host_read_transient_exhausted",
    `1763600000000:T3 thread.getSnapshot: ${underlying}`,
  );
  f.store.update(task.id, {
    phase: "needs_attention",
    originHostId: f.hostId,
    workspaceId: "ws-1461",
    directory: f.repoDir,
    profile: f.profiles.worker,
    profileGroup: "worker",
    reason: wrappedReason,
    resolution: {
      ...task.resolution,
      attention: true,
      recoveryActive: false,
      recovery: {
        id: "rec-1461",
        key: "k-1461",
        generation: 1,
        runId: null,
        agentId: null,
        status: "pending",
        summary: "",
        idleSince: null,
        incidentId: null,
        progress: "0",
        action: null,
      },
      stop: {
        reason: "route_unavailable",
        since: stamp,
        detail: wrappedReason,
        suggestedVerbs: ["route", "restart"],
      },
    },
  });

  // cause() must unwrap legacy coordinator-route prefixes so it can never recurse.
  assert.equal(
    cause(f.store.task(task.id), f.store.runs(task.id)),
    underlying,
  );
  assert.equal(unwrapCoordinatorRouteWrapper(wrappedReason), underlying);
  assert.equal(
    blockingRecoveryEffects(f.store, f.store.task(task.id)).length,
    0,
    "pre-send reconciled host-read exhaustion must not block recovery effects",
  );

  // Simulate service restart over the persisted SQLite database.
  await f.close();
  const restarted = f.openEngine(f.dbPath);
  t.after(() => restarted.close());

  let coordCreates = 0;
  let workerCreates = 0;
  const deliveredNotices: Array<{ to: string; body: string }> = [];
  restarted.setAdapter({
    supportsCoordinatorRecovery: true,
    supportsRecovery: true,
    originAgent: async (id: string) => ({
      id,
      workspaceId: "ws-origin",
      archived: false,
      status: "idle",
      active: false,
      error: "",
    }),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-origin",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
    messageAgent: async (id: string, body: string) => {
      deliveredNotices.push({ to: id, body });
    },
    notify: async (to: string, body: string) => {
      deliveredNotices.push({ to, body });
    },
    createAgent: async () => {
      workerCreates++;
      throw new T3TransientReadError(new Error("parent projection still unavailable"));
    },
    createRun: async () => {
      coordCreates++;
      return { id: "coord-should-never-launch", workspaceId: "ws-1461" };
    },
  } as unknown as Adapter);

  restarted.engine.resumeOperations();
  await restarted.engine.scheduleTaskQuantum(task.id);
  await restarted.engine.resolution.recovery.route(restarted.store.task(task.id));
  await restarted.engine.resolution.deliverNotices();

  // Repeat across another sweep pass to verify notice coalescing and zero coord churn.
  await restarted.engine.scheduleTaskQuantum(task.id);
  await restarted.engine.resolution.recovery.route(restarted.store.task(task.id));
  await restarted.engine.resolution.deliverNotices();

  const finalTask = restarted.store.task(task.id);
  assert.equal(coordCreates, 0, "must never launch a coordinator for host-read exhaustion");
  assert.equal(workerCreates, 2, "only worker probe ran during ordinary admission sweeps");
  assert.equal(finalTask.phase, "needs_attention");
  assert.equal(finalTask.resolution.stop?.reason, "operator_needed");
  assert.ok(
    !finalTask.reason.includes("No coordinator profile is available for recovery"),
    `expected unwrapped reason, got: ${finalTask.reason}`,
  );
  assert.equal(finalTask.resolution.recovery, null);
  assert.equal(
    refusedLaunchProfiles(restarted.store, task.id).size,
    0,
    "must not exclude any coordinator profile",
  );
  assert.equal(
    restarted.store.eventsAll(task.id).filter((e) => e.kind === CREATION_REFUSED_BEFORE_SEND).length,
    0,
  );
  assert.equal(
    restarted.store.eventsAll(task.id).filter((e) => e.kind === "host_read_transient_exhausted").length,
    1,
    "exhaustion event stays coalesced at 1",
  );
  assert.equal(
    restarted.store.notices(task.id).filter((n) => n.kind === "attention").length,
    1,
    "exactly one attention notice raised across repeated passes and restart",
  );
  assert.equal(deliveredNotices.length, 1);

  const next = assembleOwnerTaskNext(
    collectOwnerVerbFacts(restarted.store, finalTask),
    ownerVerbViews,
  );
  assert.equal(next.stop?.owner, "host-read recovery");
  assert.ok(next.stop?.evidence?.includes("could not read host state"));
  assert.ok(!next.stop?.suggestedVerbs.includes("route"));
  assert.equal(
    restarted.store.listDecisions({ status: "open", task: task.id }).length,
    0,
  );
});

test("bounded host-read retries recover on fresh relevant evidence and keep unrelated tasks and holds intact", async (t) => {
  const f = makeEngineFixture(t);
  f.store.setMeta("hostReadTransientLimitMs", 60_000);
  f.store.setMeta("hostReadTransientMinAttempts", 2);
  f.store.setMeta("hostReadTransientMaxAttempts", 3);

  // Task 1: fails parent projection on worker launch twice, then fresh evidence succeeds.
  const recoveringTask = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-recover",
      title: "Recovering parent projection",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-recover",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  f.store.update(recoveringTask.id, {
    phase: "dispatching",
    workspaceId: "ws-recover",
    directory: f.repoDir,
    profile: f.profiles.worker,
    profileGroup: "worker",
  });

  // Task 2: unrelated healthy task in same repo/host (proves fair progress).
  const healthyTask = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-healthy",
      title: "Healthy sibling",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-healthy",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  f.store.update(healthyTask.id, {
    phase: "dispatching",
    workspaceId: "ws-healthy",
    directory: f.repoDir,
    profile: f.profiles.worker,
    profileGroup: "worker",
  });

  // Task 3: task with independent owner dispatch hold (stays held).
  const heldTask = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-held",
      title: "Held sibling",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-held",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  f.store.update(heldTask.id, {
    phase: "dispatching",
    workspaceId: "ws-held",
    directory: f.repoDir,
    profile: f.profiles.worker,
    profileGroup: "worker",
    holds: {
      dispatch: {
        owner: "operator",
        reason: "Manual hold",
        at: stamp,
        generation: 1,
        until: null,
      },
    },
  });

  let projectionReady = false;
  let healthyLaunched = 0;
  let coordCreates = 0;
  f.setAdapter({
    supportsCoordinatorRecovery: true,
    supportsRecovery: true,
    createAgent: async (spec: { workspaceId: string }) => {
      if (spec.workspaceId === "ws-healthy") {
        healthyLaunched++;
        return { id: "agent-healthy", workspaceId: "ws-healthy" };
      }
      if (!projectionReady) {
        throw new T3TransientReadError(
          new Error("parent projection incomplete for ws-recover"),
        );
      }
      return { id: "agent-recovered", workspaceId: "ws-recover" };
    },
    createRun: async () => {
      coordCreates++;
      return { id: "coord-unexpected", workspaceId: "ws-recover" };
    },
  } as unknown as Adapter);

  await f.engine.scheduleTaskQuantum(recoveringTask.id);
  await f.engine.scheduleTaskQuantum(healthyTask.id);
  await f.engine.scheduleTaskQuantum(heldTask.id);
  await f.engine.resolution.recovery.route(f.store.task(recoveringTask.id));

  assert.equal(healthyLaunched, 1, "healthy task makes progress while sibling waits");
  assert.equal(f.store.task(healthyTask.id).phase, "working");
  assert.equal(coordCreates, 0, "waiting read must not enter coordinator routing");
  assert.ok(f.store.task(heldTask.id).holds?.dispatch, "independent hold stays intact");
  assert.equal(f.store.task(heldTask.id).agentId, null);

  const waiting = f.store.task(recoveringTask.id);
  assert.equal(waiting.phase, "dispatching");
  assert.equal(waiting.resolution.stop?.reason, "external_unavailable");
  const episode = readHostReadTransientEpisode(f.store, recoveringTask.id, "task");
  assert.ok(episode);
  assert.equal(episode.hostId, f.hostId);
  assert.equal(episode.target, "workspace ws-recover");
  assert.equal(episode.attempts, 1);

  // Fresh evidence arrives -> ordinary admission succeeds and clears wait cleanly.
  projectionReady = true;
  await f.engine.scheduleTaskQuantum(recoveringTask.id);
  const resumed = f.store.task(recoveringTask.id);
  assert.equal(resumed.phase, "working");
  assert.equal(resumed.agentId, "agent-recovered");
  assert.equal(resumed.resolution.stop, null);
  assert.equal(
    f.store.getMeta(hostReadTransientKey("task", recoveringTask.id)),
    undefined,
  );
});

test("independent incomplete observation shape (T3InventoryChurnError) stays in host recovery across restart and keeps genuine pre-send refusal separate", async (t) => {
  const f = makeEngineFixture(t);
  f.store.setMeta("hostReadTransientLimitMs", 1);
  f.store.setMeta("hostReadTransientMinAttempts", 1);
  f.store.setMeta("hostReadTransientMaxAttempts", 1);

  // Task A: reviewing task whose advancePhase / settleAdvanceFailure hits T3InventoryChurnError.
  const reviewTask = f.store.insert(
    submissionSchema.parse({
      submissionId: "sub-review-churn",
      title: "Reviewer incomplete observation",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-rev",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  f.store.update(reviewTask.id, {
    phase: "reviewing",
    originHostId: f.hostId,
    workspaceId: "ws-rev",
    directory: f.repoDir,
    agentId: "worker-rev",
    prHead: head,
    profile: f.profiles.worker,
  });

  // First failure enters bounded host-read wait via RecoveryLifecycle.settleAdvanceFailure.
  f.engine.resolution.settleAdvanceFailure(
    f.store.task(reviewTask.id),
    new T3InventoryChurnError(5),
    null,
    () => null,
  );
  let afterFirst = f.store.task(reviewTask.id);
  assert.equal(afterFirst.phase, "reviewing");
  assert.equal(afterFirst.resolution.stop?.reason, "external_unavailable");

  // Service restarts while in waiting state: resumeHostReadTransients re-arms, second failure exhausts.
  await f.close();
  const restarted = f.openEngine(f.dbPath);
  t.after(() => restarted.close());
  restarted.setAdapter({
    supportsCoordinatorRecovery: true,
    supportsRecovery: true,
    originAgent: async (id: string) => ({
      id,
      workspaceId: "ws-origin",
      archived: false,
      status: "idle",
      active: false,
      error: "",
    }),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-origin",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    }),
    messageAgent: async () => {},
    notify: async () => {},
    createRun: async () => {
      throw new Error("coordinator must not launch for host observation exhaustion");
    },
  } as unknown as Adapter);
  restarted.engine.resumeOperations();

  restarted.engine.resolution.settleAdvanceFailure(
    restarted.store.task(reviewTask.id),
    new T3InventoryChurnError(5),
    null,
    () => null,
  );

  // Even during coordinator routing pass and notice delivery, host-read recovery owns it.
  const routeResult = await restarted.engine.resolution.recovery.route(
    restarted.store.task(reviewTask.id),
  );
  assert.equal(routeResult, undefined);
  await restarted.engine.resolution.deliverNotices();

  const exhausted = restarted.store.task(reviewTask.id);
  assert.equal(exhausted.phase, "reviewing");
  assert.equal(exhausted.resolution.stop?.reason, "operator_needed");
  assert.match(exhausted.reason, /Owner: host-read recovery\./);
  assert.equal(
    restarted.store.notices(reviewTask.id).filter((n) => n.kind === "attention").length,
    1,
  );

  // Repeated exhaustion pass coalesces notice & does not trigger route_unavailable or coordinator launch.
  restarted.engine.resolution.settleAdvanceFailure(
    restarted.store.task(reviewTask.id),
    new T3InventoryChurnError(5),
    null,
    () => null,
  );
  assert.equal(
    restarted.store.eventsAll(reviewTask.id).filter((e) => e.kind === "host_read_transient_exhausted").length,
    1,
  );
  assert.equal(
    noticeSettlement({
      notice: noticeSchema.parse({
        id: noticeId(exhausted),
        taskId: exhausted.id,
        kind: "attention",
        agentId: "origin-rev",
        recipientAgentId: "origin-rev",
        text: exhausted.reason,
        status: "pending",
        attempts: 0,
        error: "",
        createdAt: stamp,
        sentAt: null,
        originEntry: true,
      }),
      taskRemoved: false,
      disposition: "none",
      originUnreachable: false,
      target: "origin-rev",
      currentNoticeId: noticeId(exhausted),
      supportsCoordinatorRecovery: true,
      coordinatorNeedsOwner: false,
      ownerActionNeeded: true,
      awaitingProof: false,
      closeoutHookHold: false,
      sshAuthExhausted: false,
      hostReadExhausted: true,
      recoveryEscalated: false,
      completionCohort: null,
    }).kind,
    "send",
  );

  // Task B: genuine ProvenPreSendRefusalError keeps its own creation refusal owner (never confused with incomplete observation).
  const refusedTask = restarted.store.insert(
    submissionSchema.parse({
      submissionId: "sub-genuine-refusal",
      title: "Genuine capability refusal",
      repoPath: f.repoDir,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin-ref",
    }),
    f.hostId,
    "handoff.md",
    base,
  );
  restarted.store.update(refusedTask.id, {
    phase: "dispatching",
    workspaceId: "ws-ref",
    directory: f.repoDir,
    profile: f.profiles.worker,
    profileGroup: "worker",
  });
  restarted.setAdapter({
    supportsCoordinatorRecovery: true,
    supportsRecovery: true,
    createAgent: async () => {
      throw new ProvenPreSendRefusalError("Unsupported model option requested");
    },
  } as unknown as Adapter);
  await restarted.engine.launchAgentOnce(restarted.store.task(refusedTask.id));
  const afterRefusal = restarted.store.task(refusedTask.id);
  assert.equal(afterRefusal.phase, "needs_attention");
  assert.match(afterRefusal.reason, /^Worker creation refused before send:/);
  assert.equal(
    restarted.store.getMeta(hostReadTransientKey("task", refusedTask.id)),
    undefined,
  );
});
