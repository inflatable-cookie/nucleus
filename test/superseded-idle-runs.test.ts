import { profile as sharedProfile } from "./support/fakes";
/**
 * Queue #339: release superseded idle runs on any task through the shared
 * settlement.
 *
 * One general rule, applied on finished and unfinished tasks through the
 * shared reconciler and owner-verb settlement: a stored run the canonical
 * callback binding proves superseded, freshly observed idle with its
 * owned-tool and effect safeguards passing, releases once with its history
 * kept. A current result-pending run always stays held, live and uncertain
 * states refuse with no state change, and the ordinary downstream path works
 * after settlement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  runSchema,
  submissionSchema,
  taskControlInputSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host";
import { toolTimelinePage } from "./support/tool-timeline";
import type { HostProcessFact } from "../core/host/types";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";

const head = "a".repeat(40),
  base = "b".repeat(40);

type Role = "worker" | "reviewer" | "coordinator";
const profile = (id: string, model: string, roles: Role[]) =>
  sharedProfile(id, model);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-superseded-idle-"));
  const worktree = join(dir, "worktree");
  mkdirSync(worktree);
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const worker = profile("worker", "test/worker", ["worker"]);
  const reviewer = profile("reviewer", "test/reviewer", ["reviewer"]);
  const coord = profile("coord", "test/coord", ["coordinator"]);
  const all = [worker, reviewer, coord];
  store.setMeta(
    "pool",
    all.map((item) => ({
      profileId: item.id,
      enabled: true,
      group: item.id,
      roles: [
        item.id === "reviewer"
          ? "reviewer"
          : item.id === "coord"
            ? "coordinator"
            : "worker",
      ],
      weight: "default",
      scopes: ["general"],
    })),
  );
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Superseded idle",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  const states = new Map<string, AgentObservation>();
  const timelineEntries: Array<{
    timestamp: string;
    turnId?: string;
    item: { type: string; [key: string]: unknown };
  }> = [];
  let hostProcesses: HostProcessFact[] | null = [];
  const observe = (id: string, state: Partial<AgentObservation> = {}) =>
    states.set(id, {
      id,
      workspaceId: "ws",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      ...state,
    });
  const archived: string[] = [];
  const createdRuns: Run[] = [];
  const createdRunTokens = new Map<string, string>();
  const adapter = {
    profiles: async () => all,
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => {
      throw new Error("no workspaces in this fixture");
    },
    findWorkspaces: async () => [],
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw new Error(`Agent ${id} missing`);
      return state;
    },
    agentTimelinePage: async () => toolTimelinePage(timelineEntries),
    hostProcessListing: async () => hostProcesses,
    archiveAgent: async () => {},
    notify: async () => {},
    findRunAgents: async () => [],
    verifyPr: async () => ({
      head,
      url: "https://github.com/example/repo/pull/7",
    }),
    verifyPrIdentity: async () => ({
      head,
      url: "https://github.com/example/repo/pull/7",
    }),
    verifyCleanQueueWorktree: async () => {},
    verifyResume: async () => {},
    verifyReview: async () => 12345,
    publishReview: async () => 12345,
    mergeGate: async () => ({ head, base, wait: "" }),
    merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: "main" }),
    syncMain: async () => base,
    verifyCloseout: async () => {},
    createRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r);
      createdRunTokens.set(r.id, token);
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run, token: string) => {
      createdRuns.push(r);
      createdRunTokens.set(r.id, token);
    },
    archiveTaskWorkspace: async (
      _t: Task,
      id: string,
      _dir: string,
      _head: string,
      allowed: () => boolean,
    ) => {
      if (!allowed()) return false;
      archived.push(id);
      return true;
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const taskId = submitted.id;
  const current = () => store.task(taskId);
  const events = (kind: string) =>
    store.eventsAll(taskId).filter((event) => event.kind === kind);
  const run = (overrides: Partial<Run> & { id: string }): Run =>
    store.putRun(
      runSchema.parse({
        taskId,
        role: "recovery",
        generation: current().coordinatorGeneration,
        head,
        base,
        agentId: null,
        workspaceId: "ws",
        profile: null,
        status: "running",
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        active: false,
        idleSince: null,
        completion: null,
        released: false,
        ...overrides,
      }),
    ) as unknown as Run;
  return {
    dir,
    store,
    engine,
    adapter,
    taskId,
    current,
    events,
    observe,
    archived,
    createdRuns,
    createdRunTokens,
    run,
    timelineEntries,
    setHostProcesses: (processes: HostProcessFact[] | null) => {
      hostProcesses = processes;
    },
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An unfinished reviewing task with a retained worker and one current reviewer run. */
function reviewingTask(
  f: ReturnType<typeof fixture>,
  runId: string,
  agentId = "review-agent",
) {
  f.observe("worker-agent");
  f.store.update(f.taskId, {
    phase: "reviewing",
    workspaceId: "ws",
    directory: join(f.dir, "worktree"),
    agentId: "worker-agent",
    runId: "worker-run",
    profile: {
      id: "worker",
      name: "worker",
      provider: "test",
      model: "test/worker",
      notes: "",
      available: true,
      problem: "",
      supportedThinking: [],
    },
    workerModel: "test/worker",
    prUrl: "https://github.com/example/repo/pull/7",
    prHead: head,
    resumePrNumber: 7,
    completion: {
      taskId: f.taskId,
      runId: "worker-run",
      eventId: "ready-7",
      status: "ready_for_review",
      summary: "Ready",
      prNumber: 7,
    },
  });
  f.run({
    id: runId,
    role: "reviewer",
    agentId,
    status: "running",
    active: true,
    profile: {
      id: "reviewer",
      name: "reviewer",
      provider: "test",
      model: "test/reviewer",
      notes: "",
      available: true,
      problem: "",
      supportedThinking: [],
    },
  });
  f.store.update(f.taskId, {
    resolution: {
      ...f.current().resolution,
      currentRunId: runId,
      reviewerAgentId: agentId,
    },
  });
  return f.store.run(runId)!;
}

const reviewerBlocked = (taskId: string, runId: string) => ({
  eventId: `verdict-${runId}`,
  taskId,
  runId,
  status: "blocked" as const,
  summary: "Reviewer finished without a verdict",
  head,
});

test("an idle current reader with an unaccepted report stays protected", async () => {
  const f = fixture();
  try {
    const run = reviewingTask(f, "reader-unaccepted");
    f.observe("review-agent");
    // The verdict is recorded on the run but not yet applied: result pending.
    f.store.setCredential(run.id, "token");
    f.store.putRun({
      ...run,
      completion: reviewerBlocked(f.taskId, run.id) as never,
    });
    const version = f.current().version;
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      0,
    );
    assert.equal(
      f.store.run(run.id)!.released,
      false,
      "the current result-pending reader stays held",
    );
    assert.equal(f.events("run_released_from_observed_liveness").length, 0);
    assert.equal(f.current().version, version, "a hold writes nothing");
  } finally {
    await f.close();
  }
});

test("an idle current reader with an accepted report stays protected", async () => {
  const f = fixture();
  try {
    const run = reviewingTask(f, "reader-accepted");
    f.observe("review-agent");
    const completion = reviewerBlocked(f.taskId, run.id);
    f.store.putRun({ ...run, completion: completion as never });
    // The report is accepted into the task resolution, but the run still holds its lease.
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        review: { ...completion, reviewText: "findings" } as never,
      },
    });
    const version = f.current().version;
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      0,
    );
    assert.equal(
      f.store.run(run.id)!.released,
      false,
      "the just-accepted reader stays held",
    );
    assert.equal(f.events("run_released_from_observed_liveness").length, 0);
    assert.equal(f.current().version, version, "a hold writes nothing");
  } finally {
    await f.close();
  }
});

test("a stale idle superseded recovery run settles exactly once, with history kept", async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: "working",
      workspaceId: "ws",
      directory: join(f.dir, "worktree"),
      agentId: "worker-agent",
      runId: "worker-run",
    });
    // The episode was cleared, but two recovery runs were never released.
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        recoveryActive: false,
        recovery: null,
      },
    });
    f.run({ id: "stale-a", agentId: "coord-a" });
    f.run({ id: "stale-b", agentId: "coord-b" });
    f.observe("coord-a");
    f.observe("coord-b");
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      2,
    );
    for (const id of ["stale-a", "stale-b"]) {
      const settled = f.store.run(id)!;
      assert.equal(settled.released, true);
      assert.equal(settled.status, "superseded");
      assert.equal(
        settled.completion,
        null,
        "history is kept; no completion is invented",
      );
    }
    assert.equal(f.events("run_released_from_observed_liveness").length, 2);
    assert.match(
      f.events("run_released_from_observed_liveness")[0]!.detail,
      /stale-a/,
    );
    // Exactly once: a second pass finds nothing settleable and writes nothing.
    const version = f.current().version;
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      0,
    );
    assert.equal(f.events("run_released_from_observed_liveness").length, 2);
    assert.equal(
      f.current().version,
      version,
      "no churn once nothing settleable remains",
    );
  } finally {
    await f.close();
  }
});

test("live, permission-blocked and uncertain states refuse, with no state change", async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: "working",
      workspaceId: "ws",
      directory: join(f.dir, "worktree"),
      agentId: "worker-agent",
      runId: "worker-run",
    });
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        recoveryActive: false,
        recovery: null,
      },
    });
    f.run({ id: "live-run", agentId: "coord-live" });
    f.run({ id: "permission-run", agentId: "coord-permission" });
    f.run({
      id: "uncertain-run",
      agentId: "coord-uncertain",
      status: "uncertain",
    });
    f.run({ id: "agentless-run", agentId: null });
    f.run({ id: "unknown-run", agentId: "coord-unknown" });
    f.run({ id: "intent-run", agentId: "coord-intent", status: "intent" });
    f.observe("coord-live", { status: "running", active: true });
    f.observe("coord-permission", { permissions: true });
    f.observe("coord-uncertain");
    f.observe("coord-intent");
    // coord-unknown is never registered: the agent is unreadable.
    const version = f.current().version;
    const before = new Map(
      [
        "live-run",
        "permission-run",
        "uncertain-run",
        "agentless-run",
        "unknown-run",
        "intent-run",
      ].map((id) => [id, JSON.stringify(f.store.run(id))] as const),
    );
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      0,
    );
    for (const [id, snapshot] of before) {
      assert.equal(f.store.run(id)!.released, false, `${id} stays held`);
      assert.equal(
        JSON.stringify(f.store.run(id)),
        snapshot,
        `${id} is unchanged`,
      );
    }
    assert.equal(f.events("run_released_from_observed_liveness").length, 0);
    assert.equal(f.current().version, version, "refusals write nothing");
  } finally {
    await f.close();
  }
});

test("a run with a pending authenticated delivery stays held", async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: "working",
      workspaceId: "ws",
      directory: join(f.dir, "worktree"),
      agentId: "worker-agent",
      runId: "worker-run",
    });
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        recoveryActive: false,
        recovery: null,
      },
    });
    const run = reviewingTask(f, "delivery-run");
    // The run is superseded by binding (not current), but its review delivery is still reserved.
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        currentRunId: null,
        reviewerAgentId: null,
      },
    });
    f.store.putRun({
      ...run,
      reviewDeliveries: [
        {
          deliveryId: `ns-review-${"c".repeat(64)}`,
          authorizationId: "auth-1",
          operationId: "op-1",
          taskId: f.taskId,
          runId: run.id,
          head,
          checkpointOrdinal: 1,
          taskVersion: 1,
          briefVersion: null,
          briefDigest: null,
          reason: "continue",
          instruction: "go",
          createdAt: new Date().toISOString(),
          status: "reserved",
          evidence: "",
          observedAt: null,
        },
      ],
    });
    f.observe("review-agent");
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      0,
    );
    assert.equal(
      f.store.run(run.id)!.released,
      false,
      "a pending authenticated delivery stays held",
    );
  } finally {
    await f.close();
  }
});

test("after settlement the reader report applies and the revision launches", async () => {
  const f = fixture();
  try {
    const reader = reviewingTask(f, "reader-downstream");
    f.store.update(f.taskId, {
      coordinatorAgentId: "coord-stale",
      resolution: {
        ...f.current().resolution,
        recoveryActive: false,
        recovery: null,
      },
    });
    f.run({ id: "stale-recovery", agentId: "coord-stale" });
    f.observe("coord-stale");
    f.observe("review-agent");
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      1,
    );
    assert.equal(f.store.run("stale-recovery")!.status, "superseded");
    // The ordinary downstream path works: the reader's report is applied ...
    f.store.setCredential(reader.id, "token");
    const receipt = await f.engine.complete(
      {
        eventId: randomUUID(),
        taskId: f.taskId,
        runId: reader.id,
        status: "changes_required",
        summary: "One finding",
        head,
        reviewResponsibility: "author",
        reviewText: "Address the retry guard.",
      },
      "token",
    );
    assert.equal(receipt.accepted, true);
    await f.engine.wake();
    assert.equal(f.current().phase, "changes_requested");
    // ... and the revision launches on the retained worker.
    const task = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: f.taskId,
        version: f.current().version,
        action: "restart",
        reason: "Continue the revision",
        caller: "owner-thread",
        instruction: "Address the finding and continue",
      }),
    );
    assert.equal(task.phase, "changes_requested");
    await f.engine.wake();
    const revision = f.store
      .runs(f.taskId)
      .findLast((run) => run.role === "revision");
    assert.ok(revision && !revision.released, "the revision launched");
  } finally {
    await f.close();
  }
});

test("after settlement cleanup archives the workspace", async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: "done",
      workspaceId: "ws",
      directory: join(f.dir, "worktree"),
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/1",
      resolution: {
        ...f.store.task(f.taskId).resolution,
        mergedCommit: head,
        syncedCommit: head,
        recoveryActive: false,
        recovery: null,
      },
    });
    f.run({ id: "stale-done", agentId: "coord-done" });
    f.observe("coord-done");
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      1,
    );
    f.engine.enqueueCleanup(f.taskId);
    await f.engine.drainCleanup();
    assert.deepEqual(
      f.archived,
      ["ws"],
      "cleanup archives the workspace after settlement",
    );
  } finally {
    await f.close();
  }
});

test("the recovery busy wait stops toggling once nothing settleable remains", async () => {
  const f = fixture();
  try {
    f.store.update(f.taskId, {
      phase: "needs_attention",
      reason: "Worker blocked: needs a ruling",
      workspaceId: "ws",
      directory: join(f.dir, "worktree"),
      agentId: "worker-agent",
      runId: "worker-run",
      coordinatorAgentId: "coord-busy",
      resolution: {
        ...f.current().resolution,
        attention: true,
        recoveryActive: false,
        recovery: null,
      },
    });
    f.run({ id: "busy-a", agentId: "coord-busy" });
    f.run({ id: "busy-b", agentId: "coord-busy" });
    f.observe("coord-busy");
    assert.equal(
      await f.engine.settleSupersededIdleRuns(f.taskId, "test settlement"),
      2,
    );
    await f.engine.resolution.recovery.route(f.current());
    const version = f.current().version;
    const reason = f.current().reason;
    await f.engine.resolution.recovery.route(f.store.task(f.taskId));
    assert.equal(
      f.current().version,
      version,
      "the busy wait no longer bumps the version",
    );
    assert.equal(f.current().reason, reason, "the busy wait no longer toggles");
    assert.ok(
      !f.current().reason.includes("unreleased run"),
      "no stale run still owns the wait",
    );
  } finally {
    await f.close();
  }
});
