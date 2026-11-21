import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Adapter, AgentObservation } from "../core/host";
import { Store } from "../core/store/store";
import { QueueRuntime } from "../service/runtime-owner";
import {
  dispositionSchema,
  holdsOf,
  submissionSchema,
  type Task,
} from "../shared/contracts";
import { DISPOSITION_CONTROL_REFUSAL } from "../core/verbs/control-refusals";
import { holdPatch, OPERATOR_HOLD_OWNER } from "../core/merge/merge-hold";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import { profile } from "./support/fakes";

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const CALLER = "owner-thread";
const HOST_ID = "host";

const workerProfile = profile("worker", "test/worker");
const reviewerProfile = profile("reviewer", "test/reviewer");

type StopHarness = {
  dir: string;
  observations: Map<string, AgentObservation>;
  stops: string[];
  dispatched: string[];
  hostOnline: boolean;
  stopImpl: (id: string) => Promise<void>;
  runtime: QueueRuntime;
  openRuntime: () => Promise<QueueRuntime>;
  insertTask: (overrides?: Partial<Task>) => Task;
  close: () => Promise<void>;
};

async function makeHarness(): Promise<StopHarness> {
  const dir = mkdtempSync(join(tmpdir(), "ns-owner-stop-resume-"));
  const observations = new Map<string, AgentObservation>();
  const stops: string[] = [];
  const dispatched: string[] = [];
  const state = {
    hostOnline: true,
    stopImpl: async (id: string) => {
      stops.push(id);
      const current = observations.get(id);
      if (current) {
        observations.set(id, {
          ...current,
          status: "idle",
          active: false,
          permissions: false,
          activeTurnId: undefined,
        });
      }
    },
  };

  const makeAdapter = (): Adapter => {
    const client = { isConnected: state.hostOnline };
    return {
      hostId: HOST_ID,
      socketPath: join(dir, "callback.sock"),
      helperPath: join(dir, "worker-helper.mjs"),
      client,
      isConnected: () => state.hostOnline && client.isConnected,
      connect: async () => {
        if (!state.hostOnline) throw new Error("host offline");
        client.isConnected = true;
      },
      close: async () => {
        client.isConnected = false;
      },
      catalog: async () => ({ providers: [] }),
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
      findAgents: async () => [],
      findRunAgents: async () => [],
      verifyWorkspace: async () => {},
      findWorkspaces: async () => [],
      findAnyOpenBranchPr: async () => [],
      verifyPr: async () => ({
        url: "https://github.com/example/repo/pull/7",
        head: HEAD,
      }),
      createRun: async () => {
        throw new Error("unexpected run creation");
      },
      sendRun: async (_task: Task, run: { id: string }) => {
        dispatched.push(run.id);
      },
      stopAgentTurn: async (id: string) => state.stopImpl(id),
    } as unknown as Adapter;
  };

  let activeRuntime: QueueRuntime | null = null;
  const openRuntime = async () => {
    if (activeRuntime && activeRuntime.phase !== "stopped") {
      await activeRuntime.drain();
    }
    const runtime = new QueueRuntime({
      dataDir: dir,
      adapterFactory: makeAdapter,
      timers: false,
    });
    await runtime.started;
    await runtime.bootstrap;
    runtime.engine.hostAvailable = (hostId?: string | null) =>
      !hostId || (hostId === HOST_ID && state.hostOnline);
    runtime.engine.profiles = [workerProfile, reviewerProfile];
    activeRuntime = runtime;
    return runtime;
  };

  const runtime = await openRuntime();
  runtime.store.setMeta("paused", false);
  return {
    dir,
    observations,
    stops,
    dispatched,
    get hostOnline() {
      return state.hostOnline;
    },
    set hostOnline(value: boolean) {
      state.hostOnline = value;
    },
    get stopImpl() {
      return state.stopImpl;
    },
    set stopImpl(fn: (id: string) => Promise<void>) {
      state.stopImpl = fn;
    },
    get runtime() {
      return activeRuntime!;
    },
    openRuntime,
    insertTask: (overrides: Partial<Task> = {}) => {
      const inserted = activeRuntime!.store.insert(
        submissionSchema.parse({
          submissionId: randomUUID(),
          title: "Durable stop target",
          repoPath: "/repo",
          planningCommit: BASE,
          handoffPath: "handoff.md",
          originAgentId: "origin",
        }),
        HOST_ID,
        "handoff",
        BASE,
      );
      return activeRuntime!.store.update(inserted.id, {
        phase: "working",
        agentId: "worker-agent",
        workspaceId: "workspace",
        directory: "/worktree",
        runId: "worker-run",
        profile: workerProfile,
        workerModel: workerProfile.model,
        lastAgentStatus: "running",
        agentActive: true,
        ...overrides,
      });
    },
    close: async () => {
      if (activeRuntime && activeRuntime.phase !== "stopped") {
        await activeRuntime.drain();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function liveRun(
  store: Store,
  taskId: string,
  opts: {
    id: string;
    role: "revision" | "reviewer" | "executor" | "recovery";
    agentId: string;
    workspaceId?: string;
    turnId?: string;
    active?: boolean;
  },
  observations?: Map<string, AgentObservation>,
) {
  const createdAt = new Date().toISOString();
  store.putRun({
    id: opts.id,
    taskId,
    role: opts.role,
    generation: 1,
    head: HEAD,
    base: BASE,
    agentId: opts.agentId,
    workspaceId: opts.workspaceId ?? "workspace",
    profile: opts.role === "reviewer" ? reviewerProfile : workerProfile,
    status: "running",
    createdAt,
    lastObservedAt: createdAt,
    active: opts.active ?? true,
    idleSince: null,
    completion: null,
    released: false,
  });
  observations?.set(opts.agentId, {
    id: opts.agentId,
    workspaceId: opts.workspaceId ?? "workspace",
    status: opts.active === false ? "idle" : "running",
    active: opts.active ?? true,
    permissions: false,
    error: "",
    ...(opts.turnId ? { activeTurnId: opts.turnId } : {}),
  });
}

function nextVerbs(store: Store, taskId: string) {
  return ownerTaskNext(collectOwnerVerbFacts(store, store.task(taskId)));
}

test("reopen after hold+intent commits before native stopAgentTurn resumes once and blocks new work", async () => {
  const h = await makeHarness();
  try {
    const task = h.insertTask({ agentId: null, runId: null });
    liveRun(
      h.runtime.store,
      task.id,
      { id: "worker-run", role: "revision", agentId: "worker-agent", turnId: "turn-1" },
      h.observations,
    );

    // Trigger durable taskControl stop, then simulate a service interruption AFTER the hold + intent
    // persisted on disk and BEFORE `stopAgentTurn` crosses the native boundary (aborting the store
    // connection/process right inside `cancelParticipantBoundary` by returning via raw DB snapshot).
    const preBoundaryDb = join(h.dir, "queue.sqlite");
    let capturedBeforeBoundary: Task | null = null;
    h.stopImpl = async (id: string) => {
      // At this moment, boundaryStartedAt just stamped; verify a clean pre-boundary snapshot as well:
      capturedBeforeBoundary = h.runtime.store.task(task.id);
      throw new Error("simulated crash mid-boundary");
    };
    const res = await h.runtime.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      reason: "Pause work for planning change",
      caller: CALLER,
    });
    assert.ok("accepted" in res);
    assert.equal(res.operation.state, "needs_attention");
    assert.ok(capturedBeforeBoundary);
    assert.ok(h.runtime.store.task(task.id).holds?.dispatch, "dispatch hold persisted before boundary");
    assert.equal(h.runtime.store.task(task.id).resolution.stop?.reason, "held");
    assert.equal(h.runtime.store.task(task.id).resolution.ownerStop?.cancellations[0]?.turnId, "turn-1");

    // Simulate interruption right after initial commit BEFORE boundaryStartedAt was set.
    h.runtime.store.transaction(() => {
      const t = h.runtime.store.task(task.id);
      const stop = t.resolution.ownerStop!;
      h.runtime.store.update(task.id, {
        resolution: {
          ...t.resolution,
          ownerStop: {
            ...stop,
            cancellations: stop.cancellations.map((c) => ({
              ...c,
              status: "intent" as const,
              boundaryStartedAt: null,
              note: null,
            })),
          },
        },
      });
      const op = h.runtime.store.operation(stop.operationId!)!;
      h.runtime.store.putOperation({
        ...op,
        state: "running",
        settledAt: null,
        preSendBoundaryStartedAt: null,
        effect: op.effect ? { ...op.effect, status: "intent", result: null, resultAt: null } : null,
      });
    });

    // Reopen fresh runtime with restored adapter; `resumeOperations` resumes the interrupted stop once.
    h.stops.length = 0;
    h.stopImpl = async (id: string) => {
      h.stops.push(id);
      const cur = h.observations.get(id)!;
      h.observations.set(id, { ...cur, status: "idle", active: false, activeTurnId: undefined });
    };
    const reopened = await h.openRuntime();
    reopened.engine.resumeOperations();
    const settledOp = await reopened.engine.awaitOperation(res.operation.id);
    assert.equal(settledOp.state, "succeeded");
    assert.deepEqual(h.stops, ["worker-agent"], "exact pre-boundary turn is cancelled once on reopen");

    const finalTask = reopened.store.task(task.id);
    assert.equal(finalTask.resolution.ownerStop, null);
    assert.ok(finalTask.holds?.dispatch, "accepted dispatch hold stands after reopen");
    assert.equal(finalTask.resolution.stop?.reason, "held");
    assert.equal(
      reopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_stop_intent").length,
      1,
    );
    assert.equal(
      reopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_stop_sent").length,
      1,
    );
    assert.equal(
      reopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_stopped").length,
      1,
    );
    assert.equal(
      reopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_control").length,
      1,
    );

    // Verify hold prevents non-owner work dispatch, while restart/release work after settlement.
    assert.equal(
      reopened.engine.coordinatorActionRunId.run("coord", () =>
        reopened.engine.dispatchWaitsFor(finalTask),
      ),
      "held",
    );
    const next = nextVerbs(reopened.store, task.id);
    assert.equal(next.verbs.find((v) => v.verb === "release")?.available, true);
    assert.equal(next.verbs.find((v) => v.verb === "restart")?.available, true);

    // Replaying identical stop operation idempotently returns the settled task without re-sending.
    const replay = await reopened.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      reason: "Pause work for planning change",
      caller: CALLER,
    });
    assert.ok(!("accepted" in replay));
    assert.deepEqual(h.stops, ["worker-agent"]);
    assert.equal(
      reopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_stopped").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("reopen after host acted before confirmation settles via observation without duplicating stopAgentTurn, while newer turn stays untouched", async () => {
  const h = await makeHarness();
  try {
    const task = h.insertTask({ agentId: null, runId: null });
    liveRun(
      h.runtime.store,
      task.id,
      { id: "worker-run", role: "revision", agentId: "worker-agent", turnId: "turn-old" },
      h.observations,
    );
    liveRun(
      h.runtime.store,
      task.id,
      { id: "review-run", role: "reviewer", agentId: "review-agent", turnId: "turn-rev-1" },
      h.observations,
    );

    // Host actually stops worker-agent (making it idle) and review-agent moves to a newer turn,
    // but both `stopAgentTurn` calls throw as if service died before recording confirmation.
    h.stopImpl = async (id: string) => {
      h.stops.push(id);
      if (id === "worker-agent") {
        h.observations.set(id, {
          id,
          workspaceId: "workspace",
          status: "idle",
          active: false,
          permissions: false,
          error: "",
        });
      } else {
        h.observations.set(id, {
          id,
          workspaceId: "workspace",
          status: "running",
          active: true,
          permissions: false,
          error: "",
          activeTurnId: "turn-rev-new",
        });
      }
      throw new Error("connection lost before response");
    };

    const res = await h.runtime.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      reason: "Halt current round",
      caller: CALLER,
    });
    assert.ok("accepted" in res);
    assert.equal(res.operation.state, "needs_attention");
    assert.equal(h.runtime.store.task(task.id).resolution.ownerStop?.cancellations.length, 2);

    // While host is offline during reopen, `ownerStop` stays under hold.
    h.stops.length = 0;
    h.hostOnline = false;
    const offlineReopened = await h.openRuntime();
    await offlineReopened.engine.observeOwnerStop(task.id);
    assert.ok(offlineReopened.store.task(task.id).resolution.ownerStop);
    assert.equal(nextVerbs(offlineReopened.store, task.id).verbs.find((v) => v.verb === "release")?.available, false);

    // Bring host back online and reopen runtime so sweep runs: observes worker idle and reviewer on newer turn!
    h.hostOnline = true;
    const onlineReopened = await h.openRuntime();
    await onlineReopened.engine.wake();
    assert.deepEqual(
      h.stops,
      [],
      "neither the already-idle worker nor the newer turn is cancelled again",
    );

    const settledTask = onlineReopened.store.task(task.id);
    assert.equal(settledTask.resolution.ownerStop, null);
    assert.ok(settledTask.holds?.dispatch, "dispatch hold persists until explicit release/restart/move");
    assert.equal(
      onlineReopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_stopped").length,
      1,
    );
    const settledPayload = JSON.parse(
      onlineReopened.store.eventsAll(task.id).find((e) => e.kind === "owner_stopped")!.detail,
    );
    assert.ok(
      settledPayload.settled.some(
        (s: { runId: string; kind: string; untouchedTurnId: string | null }) =>
          s.runId === "review-run" && s.kind === "newer_turn_untouched" && s.untouchedTurnId === "turn-rev-new",
      ),
    );
    assert.equal(onlineReopened.store.operation(res.operation.id)?.settlement?.kind, "superseded");
    assert.equal(
      onlineReopened.store.eventsAll(task.id).filter((e) => e.kind === "operation_superseded").length,
      1,
    );
    assert.equal(nextVerbs(onlineReopened.store, task.id).verbs.find((v) => v.verb === "release")?.available, true);
  } finally {
    await h.close();
  }
});

test("multi-participant partial stop preserves already-sent worker and settles remaining uncertain participant without duplicate cancel", async () => {
  const h = await makeHarness();
  try {
    const task = h.insertTask({ agentId: null, runId: null });
    liveRun(
      h.runtime.store,
      task.id,
      { id: "worker-run", role: "revision", agentId: "worker-agent", turnId: "w-turn-1" },
      h.observations,
    );
    liveRun(
      h.runtime.store,
      task.id,
      { id: "review-run", role: "reviewer", agentId: "review-agent", turnId: "r-turn-1" },
      h.observations,
    );

    h.stopImpl = async (id: string) => {
      h.stops.push(id);
      if (id === "worker-agent") {
        h.observations.set(id, {
          id,
          workspaceId: "workspace",
          status: "idle",
          active: false,
          permissions: false,
          error: "",
        });
        return;
      }
      throw new Error("reviewer transport timeout");
    };

    const res = await h.runtime.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      reason: "Stop both participants",
      caller: CALLER,
    });
    assert.ok("accepted" in res);
    assert.equal(res.operation.state, "needs_attention");
    const partial = h.runtime.store.task(task.id).resolution.ownerStop!;
    assert.equal(partial.cancellations.find((c) => c.runId === "worker-run")?.status, "sent");
    assert.equal(partial.cancellations.find((c) => c.runId === "review-run")?.status, "uncertain");
    assert.equal(h.runtime.store.eventsAll(task.id).filter((e) => e.kind === "owner_stop_sent").length, 1);

    // Before reviewer confirms idle, restart/release/stop refuse consistently.
    const curVer = h.runtime.store.task(task.id).version;
    await assert.rejects(
      h.runtime.taskControl({
        action: "release",
        taskId: task.id,
        version: curVer,
        kind: "dispatch",
        caller: CALLER,
      }),
      /An accepted owner stop still awaits cancellation confirmation/,
    );
    await assert.rejects(
      h.runtime.taskControl({
        action: "restart",
        taskId: task.id,
        version: curVer,
        reason: "Cannot restart yet",
        caller: CALLER,
      }),
      /needs_attention|An accepted owner stop still awaits cancellation confirmation/,
    );

    // Reopen; reviewer finishes turn and becomes idle; sweep settles without re-cancelling worker.
    h.stops.length = 0;
    h.observations.set("review-agent", {
      id: "review-agent",
      workspaceId: "workspace",
      status: "closed",
      active: false,
      permissions: false,
      error: "",
    });
    const reopened = await h.openRuntime();
    await reopened.engine.wake();
    assert.deepEqual(h.stops, []);
    assert.equal(reopened.store.task(task.id).resolution.ownerStop, null);
    assert.equal(reopened.store.eventsAll(task.id).filter((e) => e.kind === "owner_stopped").length, 1);

    // Now owner can release the hold!
    const released = await reopened.taskControl({
      action: "release",
      taskId: task.id,
      version: reopened.store.task(task.id).version,
      kind: "dispatch",
      caller: CALLER,
    });
    assert.ok(!("accepted" in released) && !("backpressured" in released));
    assert.deepEqual(holdsOf(released), {});
  } finally {
    await h.close();
  }
});

test("ambiguous missing turnId after pre-boundary interruption keeps visible wait under hold without blind replay", async () => {
  const h = await makeHarness();
  try {
    const task = h.insertTask({ agentId: null, runId: null });
    liveRun(
      h.runtime.store,
      task.id,
      { id: "worker-run", role: "revision", agentId: "worker-agent", turnId: "turn-1" },
      h.observations,
    );

    // Crash right inside boundary wait, then roll back boundaryStartedAt to test ambiguous missing turnId on reopen.
    h.stopImpl = async () => {
      throw new Error("crash before send");
    };
    const res = await h.runtime.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      reason: "Stop ambiguously",
      caller: CALLER,
    });
    assert.ok("accepted" in res);
    h.runtime.store.transaction(() => {
      const t = h.runtime.store.task(task.id);
      const stop = t.resolution.ownerStop!;
      h.runtime.store.update(task.id, {
        resolution: {
          ...t.resolution,
          ownerStop: {
            ...stop,
            cancellations: stop.cancellations.map((c) => ({
              ...c,
              status: "intent" as const,
              boundaryStartedAt: null,
            })),
          },
        },
      });
    });

    // On reopen, host reports `active: true` WITHOUT `activeTurnId` -> ambiguous turn identity!
    h.stops.length = 0;
    h.observations.set("worker-agent", {
      id: "worker-agent",
      workspaceId: "workspace",
      status: "running",
      active: true,
      permissions: false,
      error: "",
      activeTurnId: undefined,
    });
    const reopened = await h.openRuntime();
    await reopened.engine.wake();
    assert.deepEqual(h.stops, [], "ambiguous active turn never blindly replays stopAgentTurn");
    const stuck = reopened.store.task(task.id);
    assert.ok(stuck.holds?.dispatch);
    assert.equal(stuck.resolution.ownerStop?.cancellations[0]?.status, "uncertain");
    assert.match(
      stuck.resolution.stop?.detail ?? "",
      /Active turn identity is ambiguous/,
    );
  } finally {
    await h.close();
  }
});

test("preserves independent dispatch and merge holds and settles pre-boundary stop when newer owner action finishes task", async () => {
  const h = await makeHarness();
  try {
    const baseTask = h.insertTask({ agentId: null, runId: null });
    const withDispatch = h.runtime.store.update(
      baseTask.id,
      holdPatch(baseTask, "dispatch", OPERATOR_HOLD_OWNER, "Manual operator hold before stop", null),
    );
    const task = h.runtime.store.update(
      withDispatch.id,
      holdPatch(withDispatch, "merge", OPERATOR_HOLD_OWNER, "Wait for release window", null),
    );
    const dispatchGenBefore = holdsOf(task).dispatch!.generation;
    const mergeGenBefore = holdsOf(task).merge!.generation;
    liveRun(
      h.runtime.store,
      task.id,
      { id: "worker-run", role: "revision", agentId: "worker-agent", turnId: "turn-1" },
      h.observations,
    );

    h.stopImpl = async () => {
      throw new Error("timeout");
    };
    const res = await h.runtime.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      reason: "Stop under existing holds",
      caller: CALLER,
    });
    assert.ok("accepted" in res);
    const held = h.runtime.store.task(task.id);
    assert.equal(held.holds?.dispatch?.reason, "Manual operator hold before stop");
    assert.equal(held.holds?.dispatch?.generation, dispatchGenBefore);
    assert.equal(held.holds?.merge?.reason, "Wait for release window");
    assert.equal(held.holds?.merge?.generation, mergeGenBefore);

    // Newer owner action marks the task cancelled/disposed while `ownerStop` has an unsent cancellation.
    h.stops.length = 0;
    h.runtime.store.transaction(() => {
      const cur = h.runtime.store.task(task.id);
      const stop = cur.resolution.ownerStop!;
      h.runtime.store.update(task.id, {
        phase: "cancelled",
        resolution: {
          ...cur.resolution,
          ownerStop: {
            ...stop,
            cancellations: stop.cancellations.map((c) => ({
              ...c,
              status: "intent" as const,
              boundaryStartedAt: null,
            })),
          },
        },
      });
    });
    await h.runtime.engine.observeOwnerStop(task.id);
    assert.deepEqual(h.stops, [], "terminal task never fires pre-boundary stopAgentTurn");
    assert.equal(h.runtime.store.task(task.id).resolution.ownerStop, null);
    assert.equal(h.runtime.store.task(task.id).holds?.merge?.reason, "Wait for release window");
  } finally {
    await h.close();
  }
});

test("genuine pre-send refusal writes no hold or intent and records preSendReceipt; replay after reopen never applies", async () => {
  const h = await makeHarness();
  try {
    const task = h.insertTask({ agentId: null, runId: null });
    liveRun(
      h.runtime.store,
      task.id,
      { id: "worker-run", role: "revision", agentId: "worker-agent", turnId: "turn-1" },
      h.observations,
    );
    // Mark run delivery uncertain -> genuine DurableFenceRefusal pre-send!
    h.runtime.store.putRun({
      ...h.runtime.store.run("worker-run")!,
      status: "uncertain",
    });

    await assert.rejects(
      h.runtime.taskControl({
        action: "stop",
        taskId: task.id,
        version: task.version,
        reason: "Refused pre-send",
        caller: CALLER,
      }),
      /uncertain/i,
    );

    const after = h.runtime.store.task(task.id);
    assert.equal(after.holds?.dispatch, undefined, "pre-send refusal writes no hold");
    assert.equal(after.resolution.ownerStop, null);
    assert.equal(h.runtime.store.eventsAll(task.id).filter((e) => e.kind === "owner_stop_intent").length, 0);
    assert.deepEqual(h.stops, []);
    const ops = h.runtime.store.unfinishedTaskOperations(task.id);
    assert.equal(ops.length, 0, "pre-send refusal settled failed, not unfinished");
  } finally {
    await h.close();
  }
});

test("preserves proof-executor exception, role-scoped stop, paused queue, and mergeAlreadyRequested across interruption", async () => {
  const h = await makeHarness();
  try {
    h.runtime.store.setMeta("paused", true);
    const task = h.insertTask({
      phase: "merging",
      agentId: null,
      runId: null,
      prHead: HEAD,
      resolution: {
        ...h.runtime.store.task(h.insertTask().id).resolution,
        mergeIntent: true,
        mergeHead: HEAD,
        mergeRequestedAt: "2026-11-20T00:00:00.000Z",
      },
    });
    // Live reviewer + live proof executor; role="reviewer" should target ONLY reviewer and leave executor running!
    liveRun(
      h.runtime.store,
      task.id,
      { id: "review-run", role: "reviewer", agentId: "review-agent", turnId: "rev-1" },
      h.observations,
    );
    liveRun(
      h.runtime.store,
      task.id,
      { id: "exec-run", role: "executor", agentId: "exec-agent", turnId: "exec-1" },
      h.observations,
    );

    h.stopImpl = async () => {
      throw new Error("lost connection");
    };
    const res = await h.runtime.taskControl({
      action: "stop",
      taskId: task.id,
      version: task.version,
      role: "reviewer",
      reason: "Pause review only",
      caller: CALLER,
    });
    assert.ok("accepted" in res);
    assert.equal(res.operation.state, "needs_attention");
    const stuck = h.runtime.store.task(task.id);
    assert.equal(stuck.resolution.ownerStop?.cancellations.length, 1);
    assert.equal(stuck.resolution.ownerStop?.cancellations[0]?.runId, "review-run");
    assert.equal(stuck.resolution.ownerStop?.executorContinues.length, 1);
    assert.equal(stuck.resolution.ownerStop?.mergeRequested, true);
    assert.match(stuck.holds?.dispatch?.reason ?? "", /merge was already requested/);
    assert.match(stuck.resolution.stop?.detail ?? "", /Nucleus cannot cancel a request it already sent/);

    // Reopen while paused; reviewer goes idle -> sweep settles cleanly, preserving merge warning and executorContinues!
    h.stops.length = 0;
    h.observations.set("review-agent", {
      id: "review-agent",
      workspaceId: "workspace",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    });
    const reopened = await h.openRuntime();
    await reopened.engine.wake();
    assert.deepEqual(h.stops, [], "executor is untouched and reviewer confirmed idle");
    const stoppedEvent = reopened.store
      .eventsAll(task.id)
      .find((e) => e.kind === "owner_stopped");
    assert.ok(stoppedEvent);
    const parsed = JSON.parse(stoppedEvent.detail);
    assert.equal(parsed.role, "reviewer");
    assert.equal(parsed.mergeAlreadyRequested?.head, HEAD);
    assert.deepEqual(parsed.executorContinues, [
      { runId: "exec-run", agentId: "exec-agent" },
    ]);
    assert.equal(reopened.store.task(task.id).resolution.ownerStop, null);
    assert.equal(reopened.store.getMeta("paused"), true);
  } finally {
    await h.close();
  }
});

test("disposition active check and terminal cancel check with ownerStop absent after cancel", async () => {
  const h = await makeHarness();
  try {
    const cancellingTask = h.insertTask({
      agentId: null,
      runId: null,
      disposition: dispositionSchema.parse({
        kind: "cancel",
        status: "draining",
        requestedAt: new Date().toISOString(),
        requestedBy: CALLER,
        reason: "Disposition in flight",
        workDisposition: "archive_if_empty",
      }),
    });
    await assert.rejects(
      h.runtime.taskControl({
        action: "stop",
        taskId: cancellingTask.id,
        version: cancellingTask.version,
        reason: "Stop active disposition",
        caller: CALLER,
      }),
      new RegExp(DISPOSITION_CONTROL_REFUSAL),
    );

    const task = h.insertTask({ agentId: null, runId: null });
    const cancelled = await h.runtime.taskControl({
      action: "cancel",
      taskId: task.id,
      version: task.version,
      reason: "Cancel first",
      caller: CALLER,
    });
    assert.ok(!("accepted" in cancelled) && !("backpressured" in cancelled));
    await assert.rejects(
      h.runtime.taskControl({
        action: "stop",
        taskId: task.id,
        version: cancelled.version,
        reason: "Stop cancelled task",
        caller: CALLER,
      }),
      /stop applies to unfinished work/,
    );
  } finally {
    await h.close();
  }
});
