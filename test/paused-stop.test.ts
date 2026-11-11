import { fakeAdapter, profile } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  ProvenPreSendRefusalError,
  type ResolutionAdapter,
} from "../core/resolution";
import {
  summarizeTask,
  runSchema,
  submissionSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host";

/**
 * Queue #650: while Queue is paused, the operator can stop every active thread
 * now, and each stopped thread resumes in its own agent when the queue starts
 * again. The control refuses unless paused, stops each kind of Queue-owned run
 * through the durable stop path, records a `paused_stop` marker that suppresses
 * every failure treatment, and resumes (or hands to the ordinary replacement
 * rules) on unpause.
 */

const head = "a".repeat(40),
  base = "b".repeat(40);

type Role = "worker" | "reviewer" | "coordinator";


interface SentContinuation {
  kind: "worker" | "run";
  taskId: string;
  runId: string | null;
  messageId: string;
  text: string;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-paused-stop-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", true);
  const worker = profile("worker", "test/worker");
  const reviewer = profile("reviewer", "test/reviewer");
  const coord = profile("coord", "test/coord");
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
      weight: 1,
      scopes: ["general"],
    })),
  );
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Stop me while paused",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );

  const observations = new Map<
    string,
    {
      id: string;
      workspaceId: string | null;
      status: string;
      active: boolean;
      permissions: boolean;
      error: string;
      provider?: string;
      model?: string;
      activeTurnId?: string;
      updatedAt?: string;
    }
  >();
  const busy = (id: string, workspaceId = "workspace") =>
    observations.set(id, {
      id,
      workspaceId,
      status: "running",
      active: true,
      permissions: false,
      error: "",
      provider: "test",
      model: "test/worker",
      activeTurnId: `turn-${id}`,
    });
  const idle = (id: string, workspaceId = "workspace") =>
    observations.set(id, {
      id,
      workspaceId,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      provider: "test",
      model: "test/worker",
    });
  const stoppedAgents: string[] = [];
  const sent: SentContinuation[] = [];
  const notifyTargets: string[] = [];
  const failWorkerResume = new Map<string, () => never>();
  const failRunResume = new Map<string, () => never>();
  const adapter = fakeAdapter({
    profiles: async () => all,
    validate: async () => base,
    verifyWorkspace: async () => {},
    createWorkspace: async () => {
      throw new Error("paused-stop fixtures do not create workspaces");
    },
    findRunAgents: async () => [],
    createAgent: async (t: Task) => {
      idle(`worker-${t.runId ?? "new"}`, t.workspaceId!);
      return { id: `worker-${t.runId ?? "new"}`, workspaceId: t.workspaceId };
    },
    observe: async (id: string) => {
      const state = observations.get(id);
      // A null entry is an agent this host cannot observe at all (deleted,
      // failed identity): the adapter's own refusal, never a fallback answer.
      if (state === null) throw new Error(`agent ${id} is not observable`);
      return (
        state ?? {
          id,
          workspaceId: null,
          status: "idle",
          active: false,
          permissions: false,
          error: "",
        }
      );
    },
    notify: async (target: string) => {
      notifyTargets.push(target);
    },
    stopAgentTurn: async (id: string) => {
      stoppedAgents.push(id);
      const state = observations.get(id);
      if (state) {
        state.active = false;
        state.status = "idle";
        state.activeTurnId = undefined;
      }
    },
    continueWorker: async (task: Task, messageId: string, text: string) => {
      const failing = failWorkerResume.get(task.agentId!);
      if (failing) failing();
      const state = observations.get(task.agentId!);
      if (state) {
        state.status = "running";
        state.active = true;
        state.activeTurnId = `resumed-${messageId}`;
      }
      sent.push({
        kind: "worker",
        taskId: task.id,
        runId: task.runId ?? null,
        messageId,
        text,
      });
    },
    continueRun: async (run: Run, messageId: string, text: string) => {
      const failing = failRunResume.get(run.id);
      if (failing) failing();
      const state = observations.get(run.agentId!);
      if (state && state.status !== "closed") {
        state.status = "running";
        state.active = true;
        state.activeTurnId = `resumed-${messageId}`;
      }
      sent.push({
        kind: "run",
        taskId: run.taskId,
        runId: run.id,
        messageId,
        text,
      });
    },
    continueReviewer: async (_t: Task, _r: Run, _m: string) => ({
      sent: false as const,
      reason:
        "paused-stop fixtures never continue reviewers through the review gate",
    }),
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
    createRun: async (_t: Task, r: Run) => {
      idle(r.agentId!, r.workspaceId);
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    },
    sendRun: async (_t: Task, r: Run) => {
      idle(r.agentId!, r.workspaceId);
    },
  } as unknown as Adapter & ResolutionAdapter);
  const engine = new Engine(store, adapter, 0);
  engine.profiles = all;
  const current = () => store.task(submitted.id);
  const events = (kind: string) =>
    store.eventsAll(submitted.id).filter((event) => event.kind === kind);
  const run = (
    id: string,
    role: Run["role"],
    agentId: string,
    overrides: Partial<Run> = {},
  ): Run =>
    runSchema.parse({
      id,
      taskId: submitted.id,
      role,
      generation: 1,
      head,
      base,
      agentId,
      workspaceId: "workspace",
      profile: role === "reviewer" ? reviewer : coord,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
      ...overrides,
    });
  /** The task is mid-worker-turn in its retained workspace. */
  const workingTask = (): Task => {
    busy("worker-agent");
    store.update(submitted.id, {
      phase: "working",
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: "workspace",
      directory: "/worktree",
      agentId: "worker-agent",
      runId: "worker-run",
      profile: worker,
      workerModel: worker.model,
      completion: null,
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/7",
    });
    return store.task(submitted.id);
  };
  const stop = () => engine.stopActiveThreads({ caller: "operator (board)" });
  return {
    dir,
    store,
    engine,
    adapter,
    taskId: submitted.id,
    current,
    events,
    run,
    workingTask,
    busy,
    idle,
    observations,
    stoppedAgents,
    sent,
    notifyTargets,
    failWorkerResume,
    failRunResume,
    profiles: { worker, reviewer, coord },
    stop,
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("stop active threads refuses unless the queue is paused", async () => {
  const f = fixture();
  try {
    f.workingTask();
    f.store.setMeta("paused", false);
    await assert.rejects(f.stop(), /only while the queue is paused/);
    assert.equal(f.stoppedAgents.length, 0, "nothing was stopped");
    assert.equal(f.current().pausedStop, undefined, "no marker was written");
  } finally {
    await f.close();
  }
});

test("stop active threads stops the retained worker turn and marks it, keeping holds, PR state and phase", async () => {
  const f = fixture();
  try {
    const task = f.workingTask();
    // An existing dispatch hold stands: the queue-wide stop never adds or renews one.
    f.store.update(f.taskId, {
      holds: {
        dispatch: {
          owner: "other-thread",
          reason: "External gate",
          at: new Date().toISOString(),
          generation: 0,
          until: null,
        },
      },
    });
    const result = await f.stop();
    assert.deepEqual(
      f.stoppedAgents,
      ["worker-agent"],
      "the live worker turn was cancelled",
    );
    assert.equal(result.stopped.length, 1);
    assert.deepEqual(result.stopped[0], {
      taskId: f.taskId,
      runId: "worker-run",
      agentId: "worker-agent",
      role: "worker",
    });
    const marked = f.current();
    assert.equal(marked.pausedStop?.role, "worker");
    assert.equal(marked.pausedStop?.agentId, "worker-agent");
    assert.equal(marked.pausedStop?.runId, "worker-run");
    assert.equal(marked.pausedStop?.operator, "operator (board)");
    assert.equal(marked.pausedStop?.workspaceId, "workspace");
    assert.equal(marked.phase, "working", "the phase is untouched");
    assert.equal(marked.prHead, head, "the PR head is untouched");
    assert.equal(
      marked.holds.dispatch?.owner,
      "other-thread",
      "the existing dispatch hold stands",
    );
    assert.equal(marked.holds.merge, undefined, "no merge hold was added");
    assert.ok(
      f.events("paused_stop_intent").length >= 1,
      "the durable stop intent was recorded",
    );
    assert.equal(f.events("paused_stop_sent").length, 1);
    assert.equal(
      f.events("owner_control").length,
      0,
      "no owner verb rode along",
    );
    assert.equal(
      marked.resolution.stop?.reason,
      "paused_stop",
      "the task names the visible paused-stop wait",
    );
    assert.match(marked.reason, /stopped while Nucleus was paused/);
  } finally {
    await f.close();
  }
});

test("stop active threads stops each kind of active run and keeps review state", async () => {
  const f = fixture();
  try {
    f.workingTask();
    f.store.putRun(f.run("reviewer-run", "reviewer", "reviewer-agent"));
    f.busy("reviewer-agent", "workspace");
    f.store.putRun(f.run("recovery-run", "recovery", "recovery-agent"));
    f.busy("recovery-agent", "workspace");
    f.store.putRun(f.run("executor-run", "executor", "executor-agent"));
    f.busy("executor-agent", "workspace");
    f.store.update(f.taskId, {
      resolution: { ...f.current().resolution, currentRunId: "reviewer-run" },
    });
    const result = await f.stop();
    assert.deepEqual(result.stopped.map((entry) => entry.role).sort(), [
      "executor",
      "recovery",
      "reviewer",
      "worker",
    ]);
    assert.equal(f.store.run("reviewer-run")?.pausedStop?.role, "reviewer");
    assert.equal(f.store.run("recovery-run")?.pausedStop?.role, "recovery");
    assert.equal(f.store.run("executor-run")?.pausedStop?.role, "executor");
    // Review state survives: the retained reviewer run keeps its lease and identity.
    const reviewer = f.store.run("reviewer-run")!;
    assert.equal(reviewer.released, false);
    assert.equal(reviewer.status, "running");
    assert.equal(f.current().resolution.currentRunId, "reviewer-run");
    assert.equal(
      new Set(f.stoppedAgents).size,
      4,
      "each live agent was cancelled exactly once",
    );
  } finally {
    await f.close();
  }
});

test("stop active threads skips idle, unobservable and settled threads, and never touches planner threads", async () => {
  const f = fixture();
  try {
    f.workingTask();
    // An idle worker mid-task: nothing is running, so nothing is stopped.
    f.idle("worker-agent");
    const result = await f.stop();
    assert.equal(result.stopped.length, 0);
    assert.equal(f.stoppedAgents.length, 0);
    assert.equal(f.current().pausedStop, undefined);
    // An unobservable agent is never stopped and never marked.
    f.busy("worker-agent");
    const before = f.observations.get("worker-agent")!;
    f.observations.delete("worker-agent");
    await f.stop();
    assert.equal(
      f.stoppedAgents.length,
      0,
      "an unreadable identity is never stopped",
    );
    f.observations.set("worker-agent", before);
    // A run whose turn settles during its cancellation (a late callback) is ordinary history.
    const late = f.run("late-run", "reviewer", "late-agent");
    f.store.putRun(late);
    f.busy("late-agent");
    const original = f.adapter.stopAgentTurn!;
    (
      f.adapter as { stopAgentTurn: (id: string) => Promise<void> }
    ).stopAgentTurn = async (id: string) => {
      await original.call(f.adapter, id);
      f.store.putRun({
        ...late,
        completion: {
          status: "ready_to_merge",
          summary: "Approved",
          runId: late.id,
          taskId: f.taskId,
          head,
          eventId: "evt",
        } as Run["completion"],
        released: true,
        status: "finished",
      });
    };
    await f.stop();
    assert.equal(
      f.store.run("late-run")?.pausedStop,
      undefined,
      "a settled run is never marked",
    );
    assert.ok(
      !f.notifyTargets.some((target) => target.includes("planner")),
      "no planner thread was touched",
    );
  } finally {
    await f.close();
  }
});

test("a stopped thread raises no failure treatment while the marker is unresolved", async () => {
  const f = fixture();
  try {
    f.workingTask();
    await f.stop();
    assert.equal(
      f.observations.get("worker-agent")!.active,
      false,
      "the thread is idle after the stop",
    );
    // The full audit pass runs its ordinary observation and reminder machinery.
    await f.engine.wake();
    const task = f.current();
    assert.equal(
      task.resolution.stop?.reason,
      "paused_stop",
      "the task still names the paused-stop wait",
    );
    assert.equal(
      task.resolution.incident,
      null,
      "no missing-callback incident was recorded",
    );
    assert.equal(
      task.resolution.attention,
      false,
      "the task did not raise attention",
    );
    assert.equal(task.failoverReason, "", "no replacement was armed");
    assert.equal(task.retiredWorkers.length, 0, "no replacement counter moved");
    assert.equal(
      f.notifyTargets.length,
      0,
      "no callback reminder or planner notice was sent",
    );
    assert.equal(
      task.pausedStop?.agentId,
      "worker-agent",
      "the marker survives the pass",
    );
  } finally {
    await f.close();
  }
});

test("a stopped reviewer run raises no reminder and is not replaced while the marker is unresolved", async () => {
  const f = fixture();
  try {
    f.workingTask();
    f.store.putRun(f.run("reviewer-run", "reviewer", "reviewer-agent"));
    f.busy("reviewer-agent");
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        currentRunId: "reviewer-run",
        reviewerAgentId: "reviewer-agent",
      },
    });
    await f.stop();
    // The reviewer's session was closed meanwhile (a daemon restart): still resumable, not a crash.
    f.observations.set("reviewer-agent", {
      id: "reviewer-agent",
      workspaceId: "workspace",
      status: "closed",
      active: false,
      permissions: false,
      error: "",
    });
    await f.engine.wake();
    const task = f.current();
    assert.equal(task.resolution.stop?.reason, "paused_stop");
    assert.equal(
      task.resolution.incident,
      null,
      "no stopped-reviewer incident was recorded",
    );
    assert.equal(
      f.store.run("reviewer-run")?.retainedAgentClosedAt,
      undefined,
      "the closed observation did not retire the thread",
    );
    assert.equal(
      f.store.run("reviewer-run")?.released,
      false,
      "the run keeps its lease",
    );
    assert.equal(f.notifyTargets.length, 0);
  } finally {
    await f.close();
  }
});

test("unpause resumes each stopped thread in its own agent, oldest stop first", async () => {
  const f = fixture();
  try {
    f.workingTask();
    const first = f.run("reviewer-run", "reviewer", "reviewer-agent");
    f.store.putRun(first);
    f.busy("reviewer-agent");
    const second = f.run("recovery-run", "recovery", "recovery-agent");
    f.store.putRun({
      ...second,
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });
    f.busy("recovery-agent", "workspace");
    const stopped = await f.stop();
    assert.equal(stopped.stopped.length, 3);
    // The recovery run's stop is the oldest: backdate its marker one second.
    const recovery = f.store.run("recovery-run")!;
    f.store.putRun({
      ...recovery,
      pausedStop: {
        ...recovery.pausedStop!,
        at: new Date(Date.parse(recovery.pausedStop!.at) - 1000).toISOString(),
      },
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    assert.deepEqual(
      f.sent.map((item) => item.runId ?? "worker-run"),
      ["recovery-run", "reviewer-run", "worker-run"],
      "resumes go oldest stop first, each thread in its own agent",
    );
    assert.equal(
      f.current().pausedStop,
      undefined,
      "the worker marker cleared once resumed",
    );
    assert.equal(
      f.store.run("reviewer-run")?.pausedStop,
      undefined,
      "the reviewer marker cleared once resumed",
    );
    assert.equal(
      f.store.run("recovery-run")?.pausedStop,
      undefined,
      "the recovery marker cleared once resumed",
    );
    assert.equal(f.events("paused_resume").length, 3);
    assert.ok(
      f.sent.every((item) => /paused-stop continuation/i.test(item.text)),
      "each continuation names the stopped queue",
    );
    assert.ok(
      f.sent.every(
        (item) =>
          item.messageId.startsWith("ns-paused-resume-") ||
          item.messageId.startsWith("paused-"),
      ),
      "each continuation carries an at-most-once message identity",
    );
    assert.equal(
      f.current().resolution.stop,
      null,
      "the visible paused-stop wait cleared",
    );
    assert.equal(
      f.current().phase,
      "working",
      "the resume stays in the retained thread",
    );
  } finally {
    await f.close();
  }
});

test("unpause resumes a closed-but-resumable agent in its own session", async () => {
  const f = fixture();
  try {
    f.workingTask();
    await f.stop();
    // The daemon closed the agent meanwhile; the session persists and pi resumes it.
    f.observations.set("worker-agent", {
      id: "worker-agent",
      workspaceId: "workspace",
      status: "closed",
      active: false,
      permissions: false,
      error: "",
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    assert.equal(
      f.sent.length,
      1,
      "the continuation was delivered to the closed-but-resumable session",
    );
    assert.equal(f.current().pausedStop, undefined);
    assert.equal(f.events("paused_resume").length, 1);
  } finally {
    await f.close();
  }
});

test("a worker thread that cannot be resumed is replaced under the ordinary rules", async () => {
  const f = fixture();
  try {
    f.workingTask();
    await f.stop();
    f.failWorkerResume.set("worker-agent", () => {
      throw new ProvenPreSendRefusalError(
        "Retained worker identity changed; no continuation was sent",
      );
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    const task = f.current();
    assert.equal(task.pausedStop, undefined, "the marker cleared");
    assert.match(task.failoverReason, /^agent_errored: paused-stop resume/);
    assert.equal(f.events("paused_resume_replacement_armed").length, 1);
    assert.equal(f.sent.length, 0, "nothing was delivered");
    assert.equal(
      task.retiredWorkers.length,
      0,
      "the arm moves no replacement counter itself",
    );
    // The ordinary sweep now owns the replacement: the retained thread is a closed,
    // non-resumable session, so the sweep retires it and dispatches on the retained workspace.
    f.observations.set("worker-agent", {
      id: "worker-agent",
      workspaceId: "workspace",
      status: "closed",
      active: false,
      permissions: false,
      error: "session lost",
    });
    f.store.setMeta("paused", false);
    await f.engine.wake();
    assert.equal(
      f.current().retiredWorkers.length,
      1,
      "the ordinary sweep retired the unrecoverable worker",
    );
    assert.equal(
      f.current().phase,
      "working",
      "the ordinary replacement launched on the retained workspace",
    );
  } finally {
    await f.close();
  }
});

test("a reviewer thread that cannot be resumed falls back to the ordinary stopped-run handling", async () => {
  const f = fixture();
  try {
    f.workingTask();
    f.store.putRun(f.run("reviewer-run", "reviewer", "reviewer-agent"));
    f.busy("reviewer-agent");
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        currentRunId: "reviewer-run",
        reviewerAgentId: "reviewer-agent",
      },
    });
    await f.stop();
    f.failRunResume.set("reviewer-run", () => {
      throw new ProvenPreSendRefusalError(
        "Retained run identity changed; no provider continuation was sent",
      );
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    assert.equal(
      f.sent.filter((item) => item.runId === "reviewer-run").length,
      0,
    );
    assert.equal(
      f.store.run("reviewer-run")?.pausedStop,
      undefined,
      "the marker cleared",
    );
    assert.equal(f.events("paused_resume_refused").length, 1);
    // The ordinary machinery owns the fault now: the observation pass reminds, then the
    // responsible-task path replaces the reviewer at the same head.
    await f.engine.wake();
    const task = f.current();
    assert.equal(
      task.resolution.incident?.cause,
      "missing_callback",
      "the ordinary stopped-reviewer path took over",
    );
    assert.equal(
      f.store.run("reviewer-run")?.released,
      false,
      "the run keeps its lease for the ordinary handling",
    );
  } finally {
    await f.close();
  }
});

test("an uncertain resume retries in place with the same message identity, then hands over", async () => {
  const f = fixture();
  try {
    f.workingTask();
    const reviewerRun = f.run("reviewer-run", "reviewer", "reviewer-agent");
    f.store.putRun(reviewerRun);
    f.busy("reviewer-agent");
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        currentRunId: "reviewer-run",
        reviewerAgentId: "reviewer-agent",
      },
    });
    await f.stop();
    let attempts = 0;
    f.failRunResume.set("reviewer-run", () => {
      attempts += 1;
      throw new Error("transport reset");
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    assert.equal(attempts, 1);
    assert.equal(
      f.store.run("reviewer-run")?.pausedStop?.agentId,
      "reviewer-agent",
      "the marker survives an uncertain delivery",
    );
    assert.equal(f.events("paused_resume_uncertain").length, 1);
    // Two more uncertain attempts exhaust the bound; the ordinary handling owns the fault.
    await f.engine.wake();
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(
      attempts,
      3,
      "each retry reused the same delivery identity bound",
    );
    assert.equal(
      f.store.run("reviewer-run")?.pausedStop,
      undefined,
      "the marker cleared after the bound",
    );
    assert.equal(f.events("paused_resume_refused").length, 1);
    // The delivery identity is derived from the run, so every attempt reuses it.
    assert.deepEqual(
      f
        .events("paused_resume_intent")
        .filter((event) => {
          try {
            return JSON.parse(event.detail).runId === "reviewer-run";
          } catch {
            return false;
          }
        })
        .map((event) => JSON.parse(event.detail).attempt),
      [1, 2, 3],
    );
  } finally {
    await f.close();
  }
});

test("the initial worker's uncertain resume retries the same bound, then hands over (review 5760041700)", async () => {
  const f = fixture();
  try {
    f.workingTask();
    await f.stop();
    let attempts = 0;
    f.failWorkerResume.set("worker-agent", () => {
      attempts += 1;
      throw new Error("transport reset");
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    assert.equal(attempts, 1);
    assert.equal(
      f.current().pausedStop?.agentId,
      "worker-agent",
      "the marker survives an uncertain delivery",
    );
    assert.equal(f.events("paused_resume_uncertain").length, 1);
    // Two more uncertain attempts exhaust the bound; the ordinary replacement owns the fault.
    await f.engine.wake();
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(
      attempts,
      3,
      "each retry counted the task-row thread's attempts",
    );
    assert.equal(
      f.current().pausedStop,
      undefined,
      "the marker cleared after the bound",
    );
    // The hand-over is durable: the arm event names the reason, and the ordinary
    // sweep then answers it by the one-thread rules (an idle retained thread with
    // no observed failure continues; only a real failure or operator relay replaces).
    const armed = f.events("paused_resume_replacement_armed");
    assert.equal(armed.length, 1);
    assert.match(armed[0]!.detail, /^agent_errored: paused-stop resume/);
    assert.ok(
      f
        .events("worker_replacement_refused")
        .some((event) => event.detail.includes("same_model_no_failure")),
      "the ordinary sweep owned the arm and refused replacement without a failure",
    );
  } finally {
    await f.close();
  }
});

test("a run whose identity moves on while stopped is stale history for the resume", async () => {
  const f = fixture();
  try {
    f.workingTask();
    f.store.putRun(f.run("reviewer-run", "reviewer", "reviewer-agent"));
    f.busy("reviewer-agent");
    f.store.update(f.taskId, {
      resolution: {
        ...f.current().resolution,
        currentRunId: "reviewer-run",
        reviewerAgentId: "reviewer-agent",
      },
    });
    await f.stop();
    // The reviewer run was retargeted to another agent between the stop and the unpause:
    // the marker names work Queue no longer owns.
    f.store.putRun({
      ...f.store.run("reviewer-run")!,
      agentId: "replacement-agent",
    });
    f.store.setMeta("paused", false);
    await f.engine.resumePausedStops();
    assert.equal(
      f.sent.filter((item) => item.runId === "reviewer-run").length,
      0,
      "a moved run is never resumed",
    );
    assert.equal(f.events("paused_resume_stale").length, 1);
    assert.equal(
      f.events("paused_resume").length,
      1,
      "only the worker resumed",
    );
    assert.equal(f.current().pausedStop, undefined);
  } finally {
    await f.close();
  }
});

test("the board summary marks a task with a stopped thread until it resumes", async () => {
  const f = fixture();
  try {
    f.workingTask();
    const task = f.current();
    const noRuns = summarizeTask(task);
    assert.equal(noRuns.pausedStop, undefined);
    task.pausedStop = {
      at: new Date().toISOString(),
      operator: "operator (board)",
      runId: "worker-run",
      agentId: "worker-agent",
      workspaceId: "workspace",
      role: "worker",
    };
    assert.equal(
      summarizeTask(task).pausedStop,
      true,
      "the task row marker shows on the card",
    );
    task.pausedStop = undefined;
    f.store.putRun(f.run("reviewer-run", "reviewer", "reviewer-agent"));
    const runs = f.store.runs(f.taskId);
    runs[0]!.pausedStop = {
      at: new Date().toISOString(),
      operator: "operator (board)",
      runId: "reviewer-run",
      agentId: "reviewer-agent",
      workspaceId: "workspace",
      role: "reviewer",
    };
    assert.equal(
      summarizeTask(task, false, false, {}, runs).pausedStop,
      true,
      "a run marker shows on the card",
    );
    runs[0]!.pausedStop = undefined;
    assert.equal(
      summarizeTask(task, false, false, {}, runs).pausedStop,
      undefined,
      "the card clears once the run resumes",
    );
  } finally {
    await f.close();
  }
});
