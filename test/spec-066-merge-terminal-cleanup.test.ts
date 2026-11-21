/**
 * Spec 066 merge and terminal-cleanup slice (C6): a verified merge proceeds
 * through synchronization, closeout and workspace archive without retry-text or
 * stale-episode dependencies. Fixtures plant the stored reproduction shapes and
 * drive them through the real writers.
 */
import { profile } from "./support/fakes";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, operationInputHash, Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { ResolutionAdapter } from "../core/resolution";
import {
  runSchema,
  submissionSchema,
  taskControlInputSchema,
  taskNextSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import type { Adapter, AgentObservation } from "../core/host";
import { EXTERNAL_MERGE_CHECK_REASON_PREFIX } from "../core/recovery/task-reasons";
import { Lifecycle } from "../core/closeout/workspace-lifecycle";
import { git } from "../core/git/index";
import { syncMain } from "../core/forge/index";
import { plannerEscalations } from "../core/questions/ladder/records";
import { taskControlOperation } from "../core/verbs/task-control-key";
import { recoveryOvertakenByMerge } from "../core/recovery/merge-occurrence";
import { Reports } from "../core/intake/report";

const head = "a".repeat(40),
  base = "b".repeat(40),
  merged = "c".repeat(40);
const CALLER = "owner-thread";
const RETRY_TEXT = "Resolution check retry requested";
const workerProfile = profile("worker", "test/worker"),
  reviewerProfile = profile("reviewer", "test/reviewer");

function fixture(
  dir = mkdtempSync(join(tmpdir(), "ns-066-c6-")),
  repoPath = "/repo",
) {
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("hostId", "host");
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "C6 merge cleanup",
      repoPath,
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  store.setMeta("pool", [
    {
      profileId: workerProfile.id,
      enabled: true,
      group: "author",
      roles: ["worker"],
      weight: "default",
      scopes: ["general"],
    },
    {
      profileId: reviewerProfile.id,
      enabled: true,
      group: "review",
      roles: ["reviewer"],
      weight: "default",
      scopes: ["general"],
    },
  ]);
  store.putRepository(
    { origin: null, path: repoPath },
    "queue",
    "fixture keeps Queue closeout",
  );
  const observations = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = "workspace") =>
    observations.set(id, {
      id,
      workspaceId,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    });
  idle("worker-agent");
  let merges = 0,
    syncs = 0,
    archives = 0,
    sends = 0,
    notices = 0;
  let observeArchive: () => Promise<boolean> = async () => true;
  const adapter = {
    hostId: "host",
    isConnected: () => true,
    profiles: async () => [workerProfile, reviewerProfile],
    observe: async (id: string) =>
      observations.get(id) ?? {
        id,
        workspaceId: "workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      },
    agentTimelinePage: async () => ({
      entries: [],
      hasOlder: false,
      hasNewer: false,
      gap: false,
      staleCursor: false,
      reset: false,
      epoch: "fixture",
      projection: "projected",
      startCursor: null,
      endCursor: null,
    }),
    originAgent: async (id: string) => ({
      id,
      workspaceId: "workspace",
      archived: false,
    }),
    archiveAgent: async () => {},
    notify: async () => {
      notices++;
    },
    findAgents: async () => [],
    findRunAgents: async () => [],
    findWorkspaces: async () => [],
    verifyWorkspace: async () => {},
    verifyPr: async () => ({
      url: "https://github.com/example/repo/pull/7",
      head,
    }),
    externalMerge: async () => ({ head, commit: merged }),
    createRun: async () => {
      throw new Error("no dispatch is expected in these fixtures");
    },
    sendRun: async () => {
      sends++;
    },
    stopAgentTurn: async () => {},
    merge: async () => {
      merges++;
    },
    syncMain: async () => {
      syncs++;
      return merged;
    },
    taskWorkspaceArchived: async () => observeArchive(),
    archiveTaskWorkspace: async (
      _t: Task,
      _id: string,
      _d: string,
      _h: string,
      allowed: () => boolean,
    ) => {
      archives++;
      return allowed();
    },
    preflightWorkspaceStorage: async () => {},
    hostProcessListing: async () => [],
  } as unknown as Adapter & ResolutionAdapter & { hostId: string };
  const engine = new Engine(store, adapter, 0, () => true);
  engine.profiles = [workerProfile, reviewerProfile];
  const task = () => store.task(inserted.id);
  const events = (kind: string) =>
    store.eventsAll(inserted.id).filter((event) => event.kind === kind);
  const next = () =>
    taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task())));
  return {
    dir,
    store,
    engine,
    adapter,
    observations,
    idle,
    taskId: inserted.id,
    task,
    events,
    next,
    counts: () => ({ merges, syncs, archives, sends, notices }),
    setObserveArchive: (fn: () => Promise<boolean>) => {
      observeArchive = fn;
    },
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function plantMerged(
  f: ReturnType<typeof fixture>,
  source = { head, base, merged },
) {
  const { head, base, merged } = source;
  const recovery = {
    id: "episode",
    key: "episode",
    generation: 1,
    runId: "recovery-run",
    agentId: "coordinator-agent",
    status: "pending" as const,
    summary: "",
    idleSince: null,
    incidentId: null,
  };
  f.store.update(f.taskId, {
    phase: "syncing",
    reason: "Merge verified; synchronizing local integration branch",
    planningBase: base,
    workspaceIntent: true,
    agentIntent: true,
    workspaceId: "workspace",
    directory: join(f.dir, "worktree"),
    agentId: "worker-agent",
    runId: "worker-run",
    profile: workerProfile,
    workerModel: workerProfile.model,
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/7",
    completion: {
      taskId: f.taskId,
      runId: "worker-run",
      eventId: "worker-ready",
      status: "ready_for_review",
      summary: "Ready",
      prNumber: 7,
    },
    resolution: {
      ...f.task().resolution,
      mergeIntent: true,
      mergeHead: head,
      mergedCommit: merged,
      syncedCommit: null,
      externalMerge: true,
      review: {
        taskId: f.taskId,
        runId: "review-run",
        eventId: "review-1",
        status: "ready_to_merge",
        summary: "Approved",
        head,
        reviewId: 12,
      },
    },
  });
  f.engine.resolution.update(
    f.task(),
    { recoveryPhase: "closeout", recoveryAttempts: 0, recovery: null },
    {},
    "closeout_recovery_budget",
  );
  f.store.putRun(
    runSchema.parse({
      id: "recovery-run",
      taskId: f.taskId,
      role: "recovery",
      generation: 1,
      head,
      base,
      agentId: "coordinator-agent",
      workspaceId: "workspace",
      profile: null,
      status: "finished",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      released: true,
      completion: {
        taskId: f.taskId,
        runId: "recovery-run",
        eventId: "recovery-done",
        status: "recovered",
        summary: "Settled",
      },
    }) as Run,
  );
  f.engine.resolution.update(
    f.task(),
    {
      integrationTurn: null,
      currentRunId: "recovery-run",
      attention: false,
      recoveryActive: true,
      recovery,
    },
    { reason: RETRY_TEXT },
    "resolution_retry",
  );
  f.idle("coordinator-agent");
  f.idle("worker-agent");
  return f.task();
}

function plantDone(
  f: ReturnType<typeof fixture>,
  directory: string,
  extra: Partial<Task["resolution"]> = {},
) {
  f.store.update(f.taskId, {
    phase: "done",
    reason: "Nucleus-owned closeout at the synchronized integration commit",
    workspaceIntent: true,
    agentIntent: true,
    workspaceId: "workspace",
    directory,
    agentId: "worker-agent",
    runId: "worker-run",
    profile: workerProfile,
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/7",
    completion: {
      taskId: f.taskId,
      runId: "worker-run",
      eventId: "worker-ready",
      status: "ready_for_review",
      summary: "Ready",
      prNumber: 7,
    },
    resolution: {
      ...f.task().resolution,
      mergedCommit: merged,
      syncedCommit: merged,
      mergeHead: head,
      externalMerge: true,
      ...extra,
    },
  });
  return f.task();
}

/** Leave unrelated checkout-gate cases with a settled recovery, not an active fault. */
function settleFixtureRecovery(f: ReturnType<typeof fixture>) {
  const task = f.task(),
    recovery = task.resolution.recovery;
  f.store.update(f.taskId, {
    resolution: {
      ...task.resolution,
      recoveryActive: false,
      currentRunId: null,
      recovery: recovery ? { ...recovery, status: "resolved" } : null,
    },
  });
}

test("merge occurrence proof binds the original recovery run and rejects a current fault", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task();
    const episode = task.resolution.recovery!;
    const witness = {
      episodeId: episode.id,
      incidentId: episode.incidentId,
      stopKey: episode.key,
      runId: episode.runId,
      generation: episode.generation,
      prNumber: 7,
      head,
      mergedCommit: null,
    };
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: { ...episode, mergeWitness: witness },
      },
    });
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), true);
    f.store.update(f.taskId, {
      resolution: {
        ...f.task().resolution,
        recovery: {
          ...f.task().resolution.recovery!,
          mergeWitness: { ...witness, mergedCommit: merged },
        },
      },
    });
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), false);
  } finally {
    await f.close();
  }
});

test("legacy recovery requires its exact run launch before the verified merge", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    f.store.update(f.taskId, {
      resolution: { ...f.task().resolution, externalMerge: false },
    });
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), false);
    f.store.event(
      f.taskId,
      "merge_response_accepted",
      `GitHub accepted the guarded merge for ${head}`,
    );
    f.store.event(
      f.taskId,
      "telemetry_recovery",
      JSON.stringify({ runId: "recovery-run", targetRole: "coordinator" }),
    );
    f.store.event(f.taskId, "recovery_action_bound", "recovery-done");
    f.store.event(f.taskId, "merge_verified", "");
    f.store.event(
      f.taskId,
      "run_released_from_recorded_completion",
      "recovery recovery-run",
    );
    f.store.event(f.taskId, "run_result_applied", "recovery-run");
    f.store.putRun({
      ...f.store.run("recovery-run")!,
      completion: {
        taskId: f.taskId,
        runId: "recovery-run",
        eventId: "recovery-done",
        status: "blocked",
        summary: "Need input",
      },
    });
    const episode = f.task().resolution.recovery!;
    const stop = {
      reason: "escalated" as const,
      detail:
        "Waiting with the planner: blocker escalation escalation is open; the task gets no worker turn until the planner acts",
      since: new Date().toISOString(),
      suggestedVerbs: [],
    };
    f.store.update(f.taskId, {
      resolution: {
        ...f.task().resolution,
        stop,
        recovery: {
          ...episode,
          status: "resolved",
          action: {
            eventId: "recovery-done",
            runId: "recovery-run",
            reportStatus: "blocked",
            coordinatorAction: { verb: "cannot", reason: "Need input" },
            summary: "Need input",
            status: "applied",
          },
        },
      },
    });
    assert.equal(
      recoveryOvertakenByMerge(f.store, f.task()),
      false,
      "a missing escalation cannot prove the occurrence",
    );
    f.store.event(f.taskId, "planner_escalation", "escalation: cause");
    f.store.event(
      f.taskId,
      "planner_escalation_payload",
      `escalation: ${JSON.stringify({ id: "escalation", runId: "recovery-run", source: "recovery" })}`,
    );
    f.store.event(f.taskId, "task_waiting", JSON.stringify(stop));
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), true);
    f.store.event(f.taskId, "merge_verified", "");
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), false);
  } finally {
    await f.close();
  }
});

test("a recovery opened after merge remains the owner of its current fault", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task();
    const episode = task.resolution.recovery!;
    const witness = {
      episodeId: episode.id,
      incidentId: episode.incidentId,
      stopKey: episode.key,
      runId: episode.runId,
      generation: episode.generation,
      prNumber: 7,
      head,
      mergedCommit: merged,
    };
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: { ...episode, mergeWitness: witness },
      },
    });
    const before = f.task();
    f.engine.resolution.closeout.continueRecordedMerge(before, {
      kind: "sweep",
    });
    assert.deepEqual(f.task(), before);
    await f.engine.wake();
    assert.equal(f.task().resolution.recovery?.status, "pending");
    assert.notEqual(f.task().phase, "done");
    assert.equal(f.counts().syncs, 0);
  } finally {
    await f.close();
  }
});

test("the stored late recovery escalation follows its exact verified merge once", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const prior = f.task();
    const episode = prior.resolution.recovery!;
    const stop = {
      reason: "escalated" as const,
      detail:
        "Waiting with the planner: blocker escalation escalation is open; the task gets no worker turn until the planner acts",
      since: new Date().toISOString(),
      suggestedVerbs: [],
    };
    f.store.update(f.taskId, {
      phase: "blocked",
      resolution: {
        ...prior.resolution,
        externalMerge: false,
        currentRunId: null,
        recoveryActive: false,
        stop,
        recovery: {
          ...episode,
          status: "resolved",
          action: {
            eventId: "recovery-done",
            runId: "recovery-run",
            reportStatus: "blocked",
            coordinatorAction: { verb: "cannot", reason: "Need input" },
            summary: "Need input",
            status: "applied",
          },
        },
      },
    });
    f.store.event(
      f.taskId,
      "merge_response_accepted",
      `GitHub accepted the guarded merge for ${head}`,
    );
    f.store.event(
      f.taskId,
      "telemetry_recovery",
      JSON.stringify({ runId: "recovery-run", targetRole: "coordinator" }),
    );
    f.store.event(f.taskId, "recovery_action_bound", "recovery-done");
    f.store.event(f.taskId, "merge_verified", "");
    f.store.event(
      f.taskId,
      "run_released_from_recorded_completion",
      "recovery recovery-run",
    );
    f.store.event(f.taskId, "run_result_applied", "recovery-run");
    f.store.putRun({
      ...f.store.run("recovery-run")!,
      completion: {
        taskId: f.taskId,
        runId: "recovery-run",
        eventId: "recovery-done",
        status: "blocked",
        summary: "Need input",
      },
    });
    f.store.event(f.taskId, "planner_escalation", "escalation: cause");
    f.store.event(
      f.taskId,
      "planner_escalation_payload",
      `escalation: ${JSON.stringify({ id: "escalation", runId: "recovery-run", source: "recovery" })}`,
    );
    f.store.event(
      f.taskId,
      "planner_escalation_wait",
      `escalation: ${JSON.stringify({ kind: "time", target: "2099-01-01T00:00:00Z" })}`,
    );
    f.store.event(f.taskId, "task_waiting", JSON.stringify(stop));
    await f.engine.wake();
    const advanced = f.task();
    assert.ok(["syncing", "closing", "done"].includes(advanced.phase));
    assert.equal(advanced.resolution.stop, null);
    assert.equal(advanced.resolution.recovery?.action?.status, "applied");
    assert.equal(f.events("planner_escalation_resolved").length, 1);
    assert.equal(f.events("planner_escalation_wait_superseded").length, 1);
    await sweepToDone(f);
    await f.engine.wake();
    const events = f.store.eventsAll(f.taskId),
      counts = f.counts();
    await f.engine.wake();
    assert.deepEqual(f.store.eventsAll(f.taskId), events);
    assert.deepEqual(f.counts(), counts);
    assert.equal(f.counts().merges, 0);
    assert.equal(f.counts().sends, 0);
    assert.equal(f.events("main_synchronized").length, 1);
  } finally {
    await f.close();
  }
});

test("verified merge retires its own recovery and retains the live run for custody", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task();
    const episode = task.resolution.recovery!;
    const run = f.store.run("recovery-run")!;
    f.store.putRun({
      ...run,
      hostId: "host",
      released: false,
      status: "running",
      completion: null,
    });
    f.store.setCredential(run.id, "synthetic-token");
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: run.id,
            generation: run.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    const retired = f.engine.resolution.closeout.continueRecordedMerge(
      f.task(),
      { kind: "sweep" },
    );
    assert.equal(retired.resolution.recovery?.status, "resolved");
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(f.store.run(run.id)?.mergeRetirement?.episodeId, episode.id);
    const oldRun = f.store.run(run.id)!;
    f.store.putRun({
      ...oldRun,
      id: "new-recovery",
      status: "running",
      mergeRetirement: undefined,
    });
    const current = f.task();
    f.store.update(f.taskId, {
      resolution: {
        ...current.resolution,
        recoveryActive: true,
        recovery: {
          ...current.resolution.recovery!,
          id: "new-episode",
          runId: "new-recovery",
          status: "running",
          mergeWitness: undefined,
        },
      },
    });
    const attempts = f.task().resolution.recoveryAttempts;
    const input = {
      taskId: f.taskId,
      runId: run.id,
      eventId: "late-recovery",
      status: "blocked" as const,
      summary: "The previous participant was unavailable",
      head,
      coordinatorGeneration: run.generation,
    };
    const reopened = new Store(f.store.path);
    const restarted = new Engine(reopened, f.adapter, 0, () => true);
    try {
      const reports = new Reports(restarted);
      const { coordinatorGeneration: _generation, ...report } = input;
      await assert.rejects(reports.report(report, "wrong-token"));
      await reports.report(report, "synthetic-token");
      const events = reopened.eventsAll(f.taskId);
      await reports.report(report, "synthetic-token");
      assert.deepEqual(reopened.eventsAll(f.taskId), events);
    } finally {
      await restarted.stop();
      reopened.close();
    }
    assert.equal(f.task().phase, "syncing");
    assert.equal(f.task().resolution.recovery?.status, "running");
    assert.equal(f.task().resolution.recovery?.runId, "new-recovery");
    assert.equal(f.task().resolution.recoveryAttempts, attempts);
    assert.equal(f.store.run(run.id)?.completion?.eventId, input.eventId);
    assert.equal(f.store.run(run.id)?.released, false);
  } finally {
    await f.close();
  }
});

test("merge verification retires an accepted recovery report before it reaches the ladder", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task(),
      episode = task.resolution.recovery!,
      run = f.store.run("recovery-run")!;
    f.store.putRun({
      ...run,
      released: false,
      status: "running",
      completion: null,
    });
    f.store.setCredential(run.id, "synthetic-token");
    f.store.update(f.taskId, {
      phase: "merging",
      resolution: {
        ...task.resolution,
        externalMerge: false,
        mergedCommit: null,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: run.id,
            generation: run.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    await f.engine.complete(
      {
        taskId: f.taskId,
        runId: run.id,
        eventId: "pending-report",
        status: "blocked",
        summary: "The earlier participant was unavailable",
        head,
        coordinatorGeneration: run.generation,
        coordinatorAction: { verb: "cannot", reason: "Need input" },
      },
      "synthetic-token",
    );
    f.adapter.merged = async () => ({
      merged: true,
      head,
      base: "main",
      commit: merged,
    });
    await f.engine.resolution.reconcileMergeIntent(f.task());
    assert.equal(f.task().phase, "syncing");
    assert.equal(f.task().resolution.recovery?.status, "resolved");
    assert.equal(f.task().resolution.recovery?.action?.status, "refused");
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(
      f.events("run_result_applied").filter((event) => event.detail === run.id)
        .length,
      1,
    );
    assert.equal(f.events("planner_escalation").length, 0);
  } finally {
    await f.close();
  }
});

test("an observed external merge retains the recovery callback and execution custody", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task(),
      episode = task.resolution.recovery!,
      run = f.store.run("recovery-run")!;
    f.store.putRun({
      ...run,
      released: false,
      status: "running",
      completion: null,
    });
    f.store.setCredential(run.id, "synthetic-token");
    f.store.update(f.taskId, {
      phase: "blocked",
      resolution: {
        ...task.resolution,
        externalMerge: false,
        mergeIntent: false,
        mergeHead: null,
        mergedCommit: null,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: run.id,
            generation: run.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    f.engine.resolution.executionLease = async () => true;
    assert.equal(
      await f.engine.resolution.recoverExternalMerge(f.task()),
      true,
    );
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(f.task().resolution.recovery?.status, "resolved");
    await f.engine.complete(
      {
        taskId: f.taskId,
        runId: run.id,
        eventId: "external-late",
        status: "blocked",
        summary: "The earlier participant was unavailable",
        head,
        coordinatorGeneration: run.generation,
      },
      "synthetic-token",
    );
    assert.equal(f.task().phase, "syncing");
    assert.equal(f.events("planner_escalation").length, 0);
    assert.equal(f.store.run(run.id)?.released, false);
  } finally {
    await f.close();
  }
});

test("recovery result reconciliation cannot apply an overtaken report after restart", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    f.adapter.supportsCoordinatorRecovery = true;
    const task = f.task(),
      episode = task.resolution.recovery!,
      run = f.store.run("recovery-run")!;
    const completion = {
      taskId: f.taskId,
      runId: run.id,
      eventId: "pending-after-roll",
      status: "blocked" as const,
      summary: "The earlier participant was unavailable",
      head,
      coordinatorGeneration: run.generation,
      coordinatorAction: { verb: "cannot" as const, reason: "Need input" },
    };
    f.store.putRun({ ...run, released: false, status: "running", completion });
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: {
          ...episode,
          action: {
            eventId: completion.eventId,
            runId: run.id,
            reportStatus: completion.status,
            coordinatorAction: completion.coordinatorAction,
            summary: completion.summary,
            status: "pending",
          },
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: run.id,
            generation: run.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    const reopened = new Store(f.store.path);
    const restarted = new Engine(reopened, f.adapter, 0, () => true);
    try {
      await restarted.resolution.recovery.pass(f.taskId);
    } finally {
      await restarted.stop();
      reopened.close();
    }
    assert.equal(f.task().phase, "syncing");
    assert.equal(f.task().resolution.recovery?.action?.status, "refused");
    assert.equal(f.events("planner_escalation").length, 0);
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(
      f.events("run_result_applied").filter((event) => event.detail === run.id)
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("a retired recovery releases custody only after the participant lease is proved", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    f.adapter.supportsCoordinatorRecovery = true;
    const task = f.task(),
      episode = task.resolution.recovery!,
      run = f.store.run("recovery-run")!;
    f.store.putRun({
      ...run,
      released: false,
      status: "running",
      completion: null,
    });
    f.store.setCredential(run.id, "synthetic-token");
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: run.id,
            generation: run.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    await f.engine.complete(
      {
        taskId: f.taskId,
        runId: run.id,
        eventId: "late-escalation",
        status: "escalate",
        summary: "Old escalation",
        head,
        coordinatorGeneration: run.generation,
      },
      "synthetic-token",
    );
    f.engine.resolution.executionLease = async () => false;
    await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.store.run(run.id)?.released, false);
    f.engine.resolution.executionLease = async () => true;
    await f.engine.resolution.recovery.pass(f.taskId);
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(f.task().resolution.recovery?.status, "resolved");
    assert.equal(f.events("planner_escalation").length, 0);
  } finally {
    await f.close();
  }
});

test("an independent stop is not cleared with an old recovery", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task(),
      episode = task.resolution.recovery!;
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: episode.runId,
            generation: episode.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    f.engine.resolution.openPlannerEscalation(f.task(), {
      cause: digest("independent"),
      runId: "worker-run",
      question: "An independent decision remains open",
      payload: { cause: "independent" },
    });
    const before = f.task();
    f.engine.resolution.closeout.continueRecordedMerge(before, {
      kind: "sweep",
    });
    assert.equal(f.task().resolution.stop?.reason, "escalated");
    assert.equal(f.task().phase, before.phase);
    assert.equal(f.task().resolution.recovery?.status, "resolved");
    await f.engine.wake();
    assert.equal(f.task().resolution.stop?.reason, "escalated");
    assert.equal(f.counts().syncs, 0);
  } finally {
    await f.close();
  }
});

test("owner closeout uses the same occurrence decision", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task();
    const episode = task.resolution.recovery!;
    f.store.update(f.taskId, {
      phase: "blocked",
      resolution: {
        ...task.resolution,
        currentRunId: null,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: episode.runId,
            generation: episode.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    const before = f.task();
    const result = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "move",
        to: "closeout",
        taskId: f.taskId,
        version: before.version,
        reason: "Resume verified closeout",
        caller: CALLER,
      }),
    );
    assert.equal(result.phase, "syncing");
    assert.equal(result.resolution.recovery?.status, "resolved");
  } finally {
    await f.close();
  }
});

test("an independent hold survives the merge occurrence decision", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task();
    const episode = task.resolution.recovery!;
    f.store.update(f.taskId, {
      held: true,
      mergeHold: true,
      holdOwner: "another-owner",
      holdReason: "Keep the hold",
      resolution: {
        ...task.resolution,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: episode.runId,
            generation: episode.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    const before = f.task();
    f.engine.resolution.closeout.continueRecordedMerge(before, {
      kind: "sweep",
    });
    assert.equal(f.task().held, true);
    assert.equal(f.task().holdOwner, before.holdOwner);
    assert.equal(f.task().resolution.recovery?.status, "resolved");
  } finally {
    await f.close();
  }
});

test("an uncertain independent effect remains owned after recovery is retired", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    const task = f.task(),
      episode = task.resolution.recovery!;
    f.store.update(f.taskId, {
      resolution: {
        ...task.resolution,
        recovery: {
          ...episode,
          mergeWitness: {
            episodeId: episode.id,
            incidentId: episode.incidentId,
            stopKey: episode.key,
            runId: episode.runId,
            generation: episode.generation,
            prNumber: 7,
            head,
            mergedCommit: null,
          },
        },
      },
    });
    f.store.putNotice({
      id: "independent",
      taskId: f.taskId,
      agentId: "origin",
      recipientAgentId: "origin",
      workspaceId: null,
      sources: [],
      originEntry: true,
      kind: "attention",
      status: "uncertain",
      error: "Delivery outcome is unknown",
      text: "Independent notice",
    });
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    assert.equal(f.task().resolution.recovery?.status, "resolved");
    await f.engine.wake();
    assert.equal(
      f.store.notices(f.taskId).find((notice) => notice.id === "independent")
        ?.status,
      "uncertain",
    );
    assert.equal(f.counts().syncs, 0);
    assert.equal(f.counts().sends, 0);
  } finally {
    await f.close();
  }
});

async function integrationFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-066-c6-integration-"));
  const repo = join(dir, "integration");
  const writer = join(dir, "writer");
  const configure = async (path: string) => {
    await git(path, "config", "user.name", "Nucleus fixture");
    await git(path, "config", "user.email", "queue@example.invalid");
  };
  try {
    await git(dir, "init", "--bare", "--initial-branch=main", "origin.git");
    await git(dir, "clone", join(dir, "origin.git"), repo);
    await configure(repo);
    await git(repo, "commit", "--allow-empty", "-m", "Planning base");
    await git(repo, "push", "-u", "origin", "main");
    const base = await git(repo, "rev-parse", "HEAD");
    await git(dir, "clone", join(dir, "origin.git"), writer);
    await configure(writer);
    await git(writer, "switch", "-c", "source");
    writeFileSync(join(writer, "change.txt"), "Reviewed work");
    await git(writer, "add", "change.txt");
    await git(writer, "commit", "-m", "Reviewed work");
    const head = await git(writer, "rev-parse", "HEAD");
    await git(writer, "switch", "main");
    await git(writer, "merge", "--no-ff", "--no-edit", head);
    await git(writer, "push", "origin", "main");
    const merged = await git(writer, "rev-parse", "HEAD");
    const f = fixture(dir, repo);
    f.adapter.externalMerge = async () => ({ head, commit: merged });
    f.adapter.syncMain = syncMain;
    return { ...f, repo, writer, source: { base, head, merged } };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function sweepToDone(f: ReturnType<typeof fixture>) {
  for (let pass = 0; pass < 4 && f.task().phase !== "done"; pass++)
    await f.engine.wake();
  assert.equal(f.task().phase, "done", f.task().reason);
}

function assertSettledNext(f: ReturnType<typeof fixture>) {
  assert.deepEqual(
    f
      .next()
      .verbs.filter(
        (entry) =>
          entry.available &&
          ["move", "retry_effect", "restart"].includes(entry.verb),
      ),
    [],
  );
}

for (const alreadySynchronized of [true, false]) {
  test(`C6 legacy retry follows ordinary sweep with ${alreadySynchronized ? "an already current checkout" : "a fast-forward still owed"}`, async () => {
    const f = await integrationFixture();
    try {
      if (alreadySynchronized) await git(f.repo, "pull", "--ff-only");
      plantMerged(f, f.source);
      // The retry is an integration obligation. A separate recovery with no
      // occurrence proof must not be silently retired by synchronization.
      f.store.update(f.taskId, {
        resolution: {
          ...f.task().resolution,
          recovery: null,
          recoveryActive: false,
          currentRunId: null,
        },
      });
      const events = () => f.store.eventsAll(f.taskId);
      let sends = 0;
      f.adapter.syncMain = (task, allowed, applied, before) =>
        syncMain(
          task,
          allowed,
          (move) => {
            assert.equal(f.events("main_sync_intent").length, 1);
            assert.equal(move.from, f.source.base);
            assert.equal(move.to, f.source.merged);
            sends++;
            applied?.(move);
          },
          before,
        );
      await sweepToDone(f);
      const done = f.task();
      assert.equal(done.resolution.recoveryActive, false);
      assert.equal(done.resolution.recovery, null);
      assert.equal(done.resolution.currentRunId, null);
      assert.equal(done.resolution.syncedCommit, f.source.merged);
      assert.equal(await git(f.repo, "rev-parse", "HEAD"), f.source.merged);
      assert.equal(f.events("recorded_merge_phase_reconciled").length, 0);
      assert.equal(f.events("main_synchronized").length, 1);
      assert.equal(
        f.events("resolution_retry").length,
        1,
        "the old event stays in history",
      );
      assert.equal(f.events("closeout_recovery_budget").length, 1);
      assert.equal(
        f.events("main_sync_intent").length,
        alreadySynchronized ? 0 : 1,
      );
      assert.equal(sends, alreadySynchronized ? 0 : 1);
      if (!alreadySynchronized) {
        const kinds = events().map((event) => event.kind);
        assert.ok(
          kinds.indexOf("main_sync_intent") <
            kinds.indexOf("integration_checkout_fast_forwarded"),
        );
      }
      assert.equal(f.counts().merges, 0);
      assert.equal(f.counts().sends, 0);
      assertSettledNext(f);
      // Terminal cleanup still owes its first pass after the closeout write.
      await f.engine.wake();
      assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ["workspace"]);
      const settled = events();
      const counts = f.counts();
      await f.engine.wake();
      assert.deepEqual(events(), settled);
      assert.deepEqual(f.counts(), counts);
    } finally {
      await f.close();
    }
  });
}

test("C6 an escalated task with an exact reviewed merge resumes without a planner restart", async () => {
  const f = await integrationFixture();
  try {
    plantMerged(f, f.source);
    const original = f.task();
    f.store.update(f.taskId, {
      phase: "blocked",
      resolution: {
        ...original.resolution,
        recovery: null,
        recoveryActive: false,
        currentRunId: null,
        mergeIntent: false,
        mergeHead: null,
        mergedCommit: null,
        externalMerge: false,
      },
    });
    f.engine.resolution.openPlannerEscalation(f.task(), {
      cause: digest("synthetic pre-merge blocker"),
      runId: original.runId,
      question: "The reviewed PR appeared blocked. What should continue?",
      payload: { refusal: "pre_merge" },
    });
    assert.equal(f.task().resolution.stop?.reason, "escalated");
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId))[0]?.answered,
      false,
    );
    await sweepToDone(f);
    const done = f.task();
    assert.equal(done.resolution.mergedCommit, f.source.merged);
    assert.equal(done.resolution.review?.head, f.source.head);
    assert.equal(done.resolution.recovery, null);
    assert.equal(done.resolution.stop, null);
    assert.equal(f.events("planner_escalation_resolved").length, 1);
    assert.equal(f.events("main_synchronized").length, 1);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId))[0]?.answered,
      true,
    );
    assert.equal(f.counts().merges, 0);
    assert.equal(f.counts().sends, 0);
    assertSettledNext(f);
    await f.engine.wake();
    assert.equal(f.events("planner_escalation_resolved").length, 1);
    assert.equal(f.events("main_synchronized").length, 1);
  } finally {
    await f.close();
  }
});

test("C6 a live participant keeps the verified merge gated", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    settleFixtureRecovery(f);
    f.observations.set("worker-agent", {
      id: "worker-agent",
      workspaceId: "workspace",
      status: "running",
      active: true,
      permissions: false,
      error: "",
    });
    await f.engine.wake();
    assert.equal(f.task().phase, "syncing");
    assert.equal(f.task().resolution.mergedCommit, merged);
    assert.match(f.next().reason, /waits for participant worker-agent/i);
    assert.equal(f.counts().syncs, 0);
    assert.equal(f.counts().merges, 0);
    const stopped = f.events("task_waiting").length;
    await f.engine.wake();
    assert.equal(f.events("task_waiting").length, stopped);
    assert.equal(f.counts().syncs, 0);
  } finally {
    await f.close();
  }
});

test("C6 a restart with unknown delivery on the current binding still blocks synchronization", async () => {
  const f = fixture();
  try {
    plantMerged(f);
    settleFixtureRecovery(f);
    const task = f.task();
    const control = taskControlInputSchema.parse({
      taskId: task.id,
      version: task.version,
      action: "restart",
      role: "worker",
      reason: "Resume the retained worker",
    });
    const { key, payload } = taskControlOperation(control);
    const accepted = f.store.acceptOperation({
      key,
      payload,
      kind: "task_control",
      inputHash: operationInputHash(payload),
      taskId: task.id,
      expectedVersion: task.version,
    });
    if ("backpressured" in accepted)
      throw Error("Unexpected operation backpressure");
    const { operation } = accepted;
    f.store.putOperation({
      ...operation,
      state: "needs_attention",
      attempts: 1,
      diagnostic: "Transport",
      startedAt: operation.createdAt,
      settledAt: operation.createdAt,
      effect: {
        kind: "task_control",
        target: "restart",
        intentAt: operation.createdAt,
        status: "uncertain",
        result: null,
        resultAt: null,
      },
    });
    for (let pass = 0; pass < 2; pass++) await f.engine.wake();
    assert.equal(f.task().resolution.syncedCommit, null);
    assert.equal(f.store.operation(operation.id)?.effect?.status, "uncertain");
    assert.equal(f.events("operation_superseded").length, 0);
    assert.equal(f.events("main_sync_intent").length, 0);
    assert.equal(f.counts().syncs, 0);
    assert.equal(f.counts().sends, 0);
    assert.match(f.next().reason, /operation .* is uncertain/);
  } finally {
    await f.close();
  }
});

test("C6 a fast-forward whose result was lost is observed before closeout", async () => {
  const f = await integrationFixture();
  let restarted: Engine | undefined;
  try {
    plantMerged(f, f.source);
    settleFixtureRecovery(f);
    let writes = 0;
    f.adapter.syncMain = (task, allowed, _applied, before) =>
      syncMain(
        task,
        allowed,
        () => {
          writes++;
          // The checkout moved, but the old process never recorded its result.
          f.store.setMeta("paused", true);
          throw new Error("Interrupted before recording the checkout result");
        },
        before,
      );
    await f.engine.wake();
    assert.equal(await git(f.repo, "rev-parse", "HEAD"), f.source.merged);
    assert.equal(f.task().resolution.syncedCommit, null);
    assert.equal(f.events("main_sync_intent").length, 1);
    assert.equal(f.events("main_synchronized").length, 0);
    assert.equal(f.next().phase, "syncing");
    await f.engine.stop();
    f.store.setMeta("paused", false);
    restarted = new Engine(f.store, f.adapter, 0, () => true);
    restarted.profiles = [workerProfile, reviewerProfile];
    await sweepToDone({ ...f, engine: restarted });
    assert.equal(f.task().resolution.syncedCommit, f.source.merged);
    assert.equal(f.events("main_sync_intent").length, 1);
    assert.equal(f.events("main_synchronized").length, 1);
    assert.equal(writes, 1);
    assert.equal(f.counts().merges, 0);
    assertSettledNext(f);
  } finally {
    await restarted?.stop();
    await f.close();
  }
});

for (const barrier of ["dirty", "divergent", "unproved"] as const) {
  test(`C6 a ${barrier} integration checkout holds and keeps the verified merge`, async () => {
    const f = await integrationFixture();
    try {
      if (barrier === "dirty")
        writeFileSync(join(f.repo, "keep.txt"), "Local changes");
      if (barrier === "divergent")
        await git(f.repo, "commit", "--allow-empty", "-m", "Local change");
      if (barrier === "unproved")
        await git(
          f.writer,
          "push",
          "--force",
          "origin",
          `${f.source.base}:main`,
        );
      const before = await git(f.repo, "rev-parse", "HEAD");
      plantMerged(f, f.source);
      settleFixtureRecovery(f);
      await f.engine.wake();
      assert.equal(f.task().resolution.mergedCommit, f.source.merged);
      assert.equal(f.task().resolution.syncedCommit, null);
      assert.equal(f.task().phase, "syncing");
      assert.match(
        f.next().reason,
        barrier === "dirty"
          ? /dirty/
          : barrier === "divergent"
            ? /differs from origin/
            : /not a valid commit name|merge-base/i,
      );
      assert.equal(await git(f.repo, "rev-parse", "HEAD"), before);
      assert.equal(f.events("main_sync_intent").length, 0);
      assert.equal(f.counts().merges, 0);
      await f.engine.wake();
      assert.equal(f.events("main_synchronized").length, 0);
      assert.equal(f.events("main_sync_failed").length, 1);
    } finally {
      await f.close();
    }
  });
}

test("a verified merge re-observes its forge identity before leaving a pre-attention park", async () => {
  const f = fixture();
  try {
    const planted = plantMerged(f);
    f.store.update(f.taskId, {
      phase: "needs_attention",
      reason: `${EXTERNAL_MERGE_CHECK_REASON_PREFIX} fixture head unavailable`,
      resolution: {
        ...planted.resolution,
        recovery: null,
        recoveryActive: false,
        currentRunId: null,
        externalMergePreAttention: { phase: "reviewing", reason: "Ready" },
      },
    });
    f.adapter.externalMerge = async () => ({ head: base, commit: merged });
    await f.engine.wake();
    assert.equal(f.task().phase, "needs_attention");
    assert.ok(f.task().resolution.externalMergePreAttention);
    assert.equal(f.counts().syncs, 0);
    assert.match(f.next().reason, /fixture head unavailable/);
    f.engine.resolution.externalMerge.externalMergeProbeMs = 0;
    f.adapter.externalMerge = async () => ({ head, commit: merged });
    await sweepToDone(f);
    assert.equal(f.task().resolution.externalMergePreAttention, null);
    assert.equal(f.events("external_merge_pre_attention_restored").length, 0);
    assert.equal(f.counts().syncs, 1);
    assertSettledNext(f);
  } finally {
    await f.close();
  }
});

test("retry_effect settles a gone workspace archive from a recorded retry without a send", async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, "gone-worktree");
    plantDone(f, directory, {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport not connected (status: disposed)",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    f.setObserveArchive(async () => true);
    const settled = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "retry_effect",
        taskId: f.taskId,
        version: f.task().version,
        effect: "workspace_archive.workspace",
        reason: "Observe the gone workspace",
        caller: CALLER,
      }),
    );
    assert.deepEqual(settled.resolution.archivedWorkspaceIds, ["workspace"]);
    assert.equal(settled.resolution.archiveIntentWorkspaceId, null);
    assert.equal(settled.resolution.workspaceArchiveRetries.length, 0);
    assert.equal(f.counts().archives, 0);
    assert.equal(f.events("workspace_archived").length, 1);
    await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "retry_effect",
        taskId: f.taskId,
        version: f.task().version,
        effect: "workspace_archive.workspace",
        reason: "Replay the gone workspace",
        caller: CALLER,
      }),
    );
    assert.equal(f.events("workspace_archived").length, 1);
    assert.equal(f.counts().archives, 0);
  } finally {
    await f.close();
  }
});

test("a failed archive observation waits, then completes when the host answers", async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, "transport-worktree");
    plantDone(f, directory, {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport not connected (status: disposed)",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    f.setObserveArchive(async () => {
      throw Error("Transport not connected (status: disposed)");
    });
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "retry_effect",
          taskId: f.taskId,
          version: f.task().version,
          effect: "workspace_archive.workspace",
          reason: "Observe the dropped transport",
          caller: CALLER,
        }),
      ),
      /Waiting to reconcile the uncertain workspace archive for workspace: Transport not connected/,
    );
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
    assert.equal(f.counts().archives, 0);
    f.setObserveArchive(async () => true);
    const settled = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "retry_effect",
        taskId: f.taskId,
        version: f.task().version,
        effect: "workspace_archive.workspace",
        reason: "Host returned",
        caller: CALLER,
      }),
    );
    assert.deepEqual(settled.resolution.archivedWorkspaceIds, ["workspace"]);
    assert.equal(f.counts().archives, 0);
  } finally {
    await f.close();
  }
});

test("a paused gone-workspace retry makes no observation and settles after resume", async () => {
  const f = fixture();
  try {
    plantDone(f, join(f.dir, "paused-gone"), {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport not connected (status: disposed)",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    let observations = 0;
    f.setObserveArchive(async () => {
      observations++;
      return true;
    });
    f.store.setMeta("paused", true);
    const before = f.task();
    const retry = () =>
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "retry_effect",
          taskId: f.taskId,
          version: f.task().version,
          effect: "workspace_archive.workspace",
          reason: "Observe the gone workspace",
          caller: CALLER,
        }),
      );
    await assert.rejects(
      retry(),
      /Nucleus is paused; this retry ran no archive attempt/,
    );
    assert.equal(observations, 0);
    assert.equal(f.counts().archives, 0);
    assert.deepEqual(f.task().resolution, before.resolution);
    assert.equal(f.events("workspace_archived").length, 0);
    f.store.setMeta("paused", false);
    const settled = await retry();
    assert.deepEqual(settled.resolution.archivedWorkspaceIds, ["workspace"]);
    assert.equal(observations, 1);
    assert.equal(f.counts().archives, 0);
  } finally {
    await f.close();
  }
});

test("a live closeout run holds a gone-workspace retry", async () => {
  const f = fixture();
  try {
    plantDone(f, join(f.dir, "live-run-gone"), {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport disconnected",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    f.store.putRun(
      runSchema.parse({
        id: "closeout-run",
        taskId: f.taskId,
        role: "closeout",
        generation: 1,
        head,
        base,
        agentId: "closeout-agent",
        workspaceId: "workspace",
        profile: null,
        status: "running",
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        active: true,
        idleSince: null,
        completion: null,
        released: false,
      }) as Run,
    );
    f.observations.set("closeout-agent", {
      id: "closeout-agent",
      workspaceId: "workspace",
      status: "running",
      active: true,
      permissions: false,
      error: "",
    });
    let observations = 0;
    f.setObserveArchive(async () => {
      observations++;
      return true;
    });
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "retry_effect",
          taskId: f.taskId,
          version: f.task().version,
          effect: "workspace_archive.workspace",
          reason: "Observe the gone workspace",
          caller: CALLER,
        }),
      ),
      /Waiting for all task runs to release/,
    );
    assert.equal(observations, 0);
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
    assert.equal(f.events("workspace_archived").length, 0);
    assert.equal(f.counts().archives, 0);
  } finally {
    await f.close();
  }
});

test("a retry overlapping a cleanup sweep settles a gone workspace once", async () => {
  const f = fixture();
  try {
    plantDone(f, join(f.dir, "concurrent-gone"), {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport disconnected",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    let started!: () => void, release!: () => void;
    const observing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observations = 0;
    f.setObserveArchive(async () => {
      observations++;
      started();
      await wait;
      return true;
    });
    f.engine.enqueueCleanup(f.taskId);
    await observing;
    const retry = f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "retry_effect",
        taskId: f.taskId,
        version: f.task().version,
        effect: "workspace_archive.workspace",
        reason: "Observe the gone workspace",
        caller: CALLER,
      }),
    );
    release();
    await retry;
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ["workspace"]);
    assert.equal(f.events("workspace_archived").length, 1);
    assert.equal(observations, 1);
    assert.equal(f.counts().archives, 0);
  } finally {
    await f.close();
  }
});

test("an ambiguous catalog observation never archives", async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, "ambiguous-worktree");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "keep"), "present");
    plantDone(f, directory, {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport not connected (status: disposed)",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    f.setObserveArchive(async () => {
      throw Error("Transport not connected (status: disposed)");
    });
    const lifecycle = new Lifecycle(f.engine);
    await lifecycle.pass();
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
    assert.match(
      f.task().resolution.cleanupReason,
      /Waiting to reconcile the uncertain workspace archive for workspace: Transport not connected/,
    );
    assert.equal(f.counts().archives, 0);
    assert.ok(existsSync(directory));
  } finally {
    await f.close();
  }
});

test("retry_effect settles an intent-state cleanup after the directory is gone", async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, "cleanup-gone");
    plantDone(f, directory, {
      archivedWorkspaceIds: ["workspace"],
      buildOutputCleanups: [
        {
          workspaceId: "workspace",
          directory,
          state: "intent",
          detail: "Build output cleanup intent recorded",
          at: new Date().toISOString(),
        },
      ],
    });
    const settled = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "retry_effect",
        taskId: f.taskId,
        version: f.task().version,
        effect: "build_output_cleanup.workspace",
        reason: "Observe the gone cleanup target",
        caller: CALLER,
      }),
    );
    assert.equal(settled.resolution.buildOutputCleanups[0]?.state, "complete");
    assert.equal(
      settled.resolution.buildOutputCleanups[0]?.detail,
      "directory absent; nothing to clean up",
    );
  } finally {
    await f.close();
  }
});

test("a still-present workspace with a recorded retry is observed, then archived once the host answers", async () => {
  const f = fixture();
  try {
    const directory = join(f.dir, "live-worktree");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "keep"), "present");
    plantDone(f, directory, {
      workspaceArchiveRetries: [
        {
          workspaceId: "workspace",
          attempts: 1,
          error: "Transport not connected (status: disposed)",
          nextAttemptAt: new Date(0).toISOString(),
        },
      ],
    });
    f.setObserveArchive(async () => false);
    const lifecycle = new Lifecycle(f.engine);
    await lifecycle.pass();
    assert.ok(
      f.task().resolution.archivedWorkspaceIds.includes("workspace") ||
        f.counts().archives >= 1,
      `phase=${f.task().phase} archived=${JSON.stringify(f.task().resolution.archivedWorkspaceIds)} reason=${f.task().resolution.cleanupReason}`,
    );
    const archives = f.counts().archives;
    await lifecycle.pass();
    assert.equal(
      f.counts().archives,
      archives,
      "a repeated pass does not send another archive",
    );
  } finally {
    await f.close();
  }
});

/**
 * Bovine #6601 shape: a recovery episode opened before the verified merge that
 * never launched a run. Its pre-merge witness is unbound, and its recovery-pending
 * escalation is the stop the synchronizing task now carries.
 */
function plantNoRunEpisode(
  f: ReturnType<typeof fixture>,
  { escalate = true }: { escalate?: boolean } = {},
) {
  plantMerged(f);
  f.store.db.prepare("DELETE FROM runs WHERE id=?").run("recovery-run");
  const episode = f.task().resolution.recovery!;
  f.store.update(f.taskId, {
    resolution: {
      ...f.task().resolution,
      currentRunId: null,
      recovery: {
        ...episode,
        runId: null,
        agentId: null,
        status: "pending",
        mergeWitness: {
          episodeId: episode.id,
          incidentId: episode.incidentId,
          stopKey: episode.key,
          runId: null,
          generation: episode.generation,
          prNumber: 7,
          head,
          mergedCommit: null,
        },
      },
    },
  });
  if (escalate)
    f.engine.resolution.openPlannerEscalation(f.task(), {
      cause: digest(`recovery-pending:${f.taskId}:${episode.id}`),
      runId: null,
      question:
        "Recovery was requested for this task but started no run. The task was synchronizing the verified merge.",
      payload: { cause: "recovery-pending", taskId: f.taskId, runId: null },
    });
  return f.task();
}

const closeoutOffer = (f: ReturnType<typeof fixture>) =>
  f
    .next()
    .verbs.find(
      (entry) =>
        entry.verb === "move" &&
        (entry.args?.to === "closeout" ||
          entry.refusal?.includes("closeout") ||
          entry.refusal?.includes("waits") ||
          entry.refusal?.includes("overtaken")),
    );

test("C6 a no-run episode with its exact pre-merge witness is overtaken by the verified merge", async () => {
  const f = fixture();
  try {
    plantNoRunEpisode(f);
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), true);
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    const settled = f.task();
    assert.equal(settled.phase, "syncing");
    assert.equal(settled.resolution.recovery?.status, "resolved");
    assert.equal(settled.resolution.recoveryActive, false);
    assert.equal(settled.resolution.stop, null);
    assert.equal(f.events("planner_escalation_resolved").length, 1);
    assert.equal(f.counts().merges, 0);
    // Repeating the decision converges: no new event, version or merge.
    const events = f.store.eventsAll(f.taskId).length;
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    assert.equal(f.task().version, settled.version);
    assert.equal(f.store.eventsAll(f.taskId).length, events);
    assert.equal(f.counts().merges, 0);
  } finally {
    await f.close();
  }
});

test("C6 the coordinator sweep settles a no-run episode before its pending clock escalates", async () => {
  const f = fixture();
  try {
    plantNoRunEpisode(f);
    await f.engine.wake();
    const after = f.task();
    assert.equal(after.resolution.recovery?.status, "resolved");
    assert.equal(after.resolution.stop, null);
    // Routing answered the outlived escalation by ordinary progress; nothing re-opens it.
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId))[0]?.answered,
      true,
    );
    assert.equal(f.counts().merges, 0);
    const occurrenceEvents = () =>
      f.store
        .eventsAll(f.taskId)
        .filter((event) =>
          [
            "recorded_merge_phase_reconciled",
            "planner_escalation_resolved",
            "planner_escalation_answered",
            "planner_escalation_wait_superseded",
          ].includes(event.kind),
        ).length;
    const decided = occurrenceEvents();
    await f.engine.wake();
    // Later passes advance synchronization, but the same occurrence is never decided again.
    assert.equal(occurrenceEvents(), decided);
    assert.equal(f.task().resolution.recovery?.status, "resolved");
    assert.equal(f.counts().merges, 0);
  } finally {
    await f.close();
  }
});

test("C6 the owner move closes out the no-run merge through the same decision, and the preview offers it", async () => {
  const f = fixture();
  try {
    const before = plantNoRunEpisode(f);
    assert.equal(closeoutOffer(f)?.available, true);
    const result = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        action: "move",
        to: "closeout",
        taskId: f.taskId,
        version: before.version,
        reason: "Resume verified closeout",
        caller: CALLER,
      }),
    );
    assert.equal(result.phase, "syncing");
    assert.equal(result.resolution.recovery?.status, "resolved");
    assert.equal(result.resolution.stop, null);
    assert.equal(f.counts().merges, 0);
  } finally {
    await f.close();
  }
});

test("C6 a current synchronization fault keeps its own stop and names it to the owner", async () => {
  const f = fixture();
  try {
    plantNoRunEpisode(f, { escalate: false });
    f.engine.resolution.waiting(
      f.task(),
      "Synchronization failed: the integration checkout is dirty",
      "lifecycle",
    );
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    const held = f.task();
    assert.equal(held.resolution.stop?.reason, "lifecycle");
    assert.equal(held.resolution.recovery?.status, "resolved");
    assert.equal(f.counts().merges, 0);
    assert.match(
      closeoutOffer(f)?.refusal ?? "",
      /Recorded merge waits: .*Synchronization failed/,
    );
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "move",
          to: "closeout",
          taskId: f.taskId,
          version: held.version,
          reason: "Resume verified closeout",
          caller: CALLER,
        }),
      ),
      /Recorded merge waits: .*Synchronization failed/,
    );
    assert.equal(f.task().resolution.stop?.reason, "lifecycle");
  } finally {
    await f.close();
  }
});

test("C6 an independent merge hold keeps the no-run merge held and is named to the owner", async () => {
  const f = fixture();
  try {
    const before = plantNoRunEpisode(f, { escalate: false });
    f.store.update(f.taskId, {
      held: true,
      mergeHold: true,
      holdOwner: "another-owner",
      holdReason: "Keep the hold",
    });
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    assert.equal(f.task().held, true);
    assert.equal(f.task().holdOwner, "another-owner");
    assert.equal(f.task().phase, before.phase);
    assert.equal(f.counts().merges, 0);
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "move",
          to: "closeout",
          taskId: f.taskId,
          version: f.task().version,
          reason: "Resume verified closeout",
          caller: CALLER,
        }),
      ),
      /Recorded merge waits: a merge hold is active/,
    );
  } finally {
    await f.close();
  }
});

test("C6 an ambiguous recovery launch keeps the no-run episode unproved and owned", async () => {
  const f = fixture();
  try {
    const before = plantNoRunEpisode(f);
    const episode = before.resolution.recovery!;
    f.store.putRun(
      runSchema.parse({
        id: "ambiguous-recovery-run",
        taskId: f.taskId,
        role: "recovery",
        generation: episode.generation,
        head,
        base,
        agentId: null,
        workspaceId: "workspace",
        profile: null,
        status: "intent",
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        active: false,
        idleSince: null,
        released: false,
        completion: null,
      }) as Run,
    );
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), false);
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    assert.equal(f.task().resolution.recovery?.status, "pending");
    assert.equal(f.events("planner_escalation_resolved").length, 0);
    assert.equal(f.counts().merges, 0);
    await assert.rejects(
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "move",
          to: "closeout",
          taskId: f.taskId,
          version: f.task().version,
          reason: "Resume verified closeout",
          caller: CALLER,
        }),
      ),
      /ambiguous-recovery-run/,
    );
  } finally {
    await f.close();
  }
});

test("C6 a witness bound to the merged commit does not overtake a no-run episode", async () => {
  const f = fixture();
  try {
    plantNoRunEpisode(f);
    const episode = f.task().resolution.recovery!;
    f.store.update(f.taskId, {
      resolution: {
        ...f.task().resolution,
        recovery: {
          ...episode,
          mergeWitness: { ...episode.mergeWitness!, mergedCommit: merged },
        },
      },
    });
    assert.equal(recoveryOvertakenByMerge(f.store, f.task()), false);
    f.engine.resolution.closeout.continueRecordedMerge(f.task(), {
      kind: "sweep",
    });
    assert.equal(f.task().resolution.recovery?.status, "pending");
    assert.equal(f.counts().merges, 0);
  } finally {
    await f.close();
  }
});
