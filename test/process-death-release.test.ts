import { profile, createTaskAgent } from "./support/fakes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { rememberParticipantProcessTable } from "../core/machine/participant-process-observation";
import { processDeathProof } from "../core/recovery/process-death";
import {
  runSchema,
  submissionSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import type { ParticipantActivity } from "../shared/schema/task-activity";
import type { Adapter, AgentObservation } from "../core/host";

/**
 * Spec 068 §3 (nucleus#1552): process facts are liveness evidence.
 *
 * After a machine reboot Nucleus kept reviewers recorded as running with dead
 * processes, and only a planner `run.release` / `run.start` moved them. A
 * stalled turn whose own recorded process is provably gone is now released
 * through the ordinary `run.release` plan, with one event naming the proof, and
 * ordinary admission relaunches the role. An unreadable process table or a live
 * process proves nothing. A `run_stalled` stop admits the coordinator without
 * waiting on its own subject's idleness.
 *
 * Only the adapter, the clock and the recorded process facts are fixtures; the
 * stall path, the observation pass and the coordinator route are the real ones.
 */

const head = "a".repeat(40),
  base = "b".repeat(40);
const worker = profile("worker", "test/worker");
const reviewer = profile("reviewer", "test/reviewer");
const coordinator = profile("coordinator", "test/coordinator");
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-process-death-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("pool", [
    {
      profileId: worker.id,
      enabled: true,
      group: "author",
      roles: ["worker"],
      weight: "default",
      scopes: ["general"],
    },
    {
      profileId: reviewer.id,
      enabled: true,
      group: "review",
      roles: ["reviewer"],
      weight: "default",
      scopes: ["general"],
    },
    {
      profileId: coordinator.id,
      enabled: true,
      group: "coordinate",
      roles: ["coordinator"],
      weight: "default",
      scopes: ["general"],
    },
  ]);
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Process death release",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  store.update(
    submitted.id,
    {
      phase: "reviewing",
      planningBase: base,
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: "workspace",
      directory: "/worktree",
      agentId: "worker",
      runId: "worker-run",
      profile: worker,
      workerModel: worker.model,
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/7",
      responsible: true,
      completion: {
        taskId: submitted.id,
        runId: "worker-run",
        eventId: "worker-ready",
        status: "ready_for_review",
        summary: "Ready",
        prNumber: 7,
      },
    },
    "dispatched",
  );
  const participantActivity = (
    runId: string,
    agentId: string,
    turnId: string | null,
    process: {
      pid: number;
      startIdentity: string;
      seenAt: number | null;
    } | null,
  ): ParticipantActivity => ({
    runId,
    agentId,
    turnId,
    turnStartedAt: minutesAgo(40),
    permission: null,
    tool: null,
    process,
  });
  const putReviewerRun = (patch: Partial<Run> = {}): Run => {
    const run = runSchema.parse({
      id: "review-run",
      taskId: submitted.id,
      role: "reviewer",
      generation: 1,
      head,
      base,
      agentId: "review-agent",
      workspaceId: "workspace",
      profile: reviewer,
      status: "running",
      createdAt: minutesAgo(40),
      briefVersion: submitted.briefVersions.at(-1)?.version ?? null,
      lastObservedAt: minutesAgo(40),
      active: true,
      idleSince: null,
      completion: null,
      released: false,
      ...patch,
    });
    store.putRun(run);
    return run;
  };
  putReviewerRun({
    participantActivity: participantActivity(
      "review-run",
      "review-agent",
      "reviewer-turn-1",
      null,
    ),
  });
  store.setCredential("review-run", "reviewer-token");
  store.update(submitted.id, {
    resolution: {
      ...store.task(submitted.id).resolution,
      currentRunId: "review-run",
      reviewerAgentId: "review-agent",
      reviewerProfile: reviewer,
    },
  });

  /** A stalled but live-looking thread: Paseo still says running, no activity for 40 minutes. */
  const stalled = (id: string): AgentObservation => ({
    id,
    workspaceId: "workspace",
    status: "running",
    active: true,
    permissions: false,
    error: "",
    provider: "test",
    updatedAt: minutesAgo(40),
    turnStartedAt: minutesAgo(41),
    activeTurnId: "stalled-turn",
  });
  const states = new Map<string, AgentObservation>([
    ["review-agent", stalled("review-agent")],
    [
      "worker",
      {
        id: "worker",
        workspaceId: "workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
        provider: "test",
      },
    ],
  ]);
  const createdRuns: Run[] = [];
  const adapter = {
    profiles: async () => [worker, reviewer, coordinator],
    validate: async () => base,
    createWorkspace: async () => ({ id: "workspace", directory: "/worktree" }),
    verifyWorkspace: async (candidate: Task) => candidate.branch,
    findWorkspaces: async () => [],
    findAgents: async () => [],
    findRunAgents: async () => [],
    createAgent: createTaskAgent,
    observe: async (id: string) =>
      states.get(id) ?? {
        id,
        workspaceId: "workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      },
    archiveAgent: async () => {},
    notify: async () => {},
    originAgent: async (id: string) => ({
      id,
      workspaceId: "workspace",
      title: id,
      archived: false,
    }),
    stopAgentTurn: async (id: string) => {
      const state = states.get(id);
      if (state)
        states.set(id, {
          ...state,
          active: false,
          status: "idle",
          activeTurnId: undefined,
        });
    },
    verifyPr: async () => ({
      url: "https://github.com/example/repo/pull/7",
      head,
    }),
    verifyPrIdentity: async () => ({
      url: "https://github.com/example/repo/pull/7",
      head,
      repository: "example/repo",
      headRepository: "example/repo",
    }),
    verifyCleanQueueWorktree: async () => {},
    verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: "" }),
    merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: "main" }),
    syncMain: async () => head,
    verifyCloseout: async () => {},
    createRun: async (_t: Task, run: Run) => {
      createdRuns.push(run);
      const id = `agent-${run.id}`;
      states.set(id, {
        id,
        workspaceId: run.workspaceId,
        status: "running",
        active: true,
        permissions: false,
        error: "",
      });
      return { id, workspaceId: run.workspaceId };
    },
    sendRun: async (_t: Task, run: Run) => {
      createdRuns.push(run);
      if (run.agentId)
        states.set(run.agentId, {
          ...(states.get(run.agentId) ?? {
            id: run.agentId,
            workspaceId: run.workspaceId,
            permissions: false,
            error: "",
          }),
          active: true,
          status: "running",
        });
    },
    supportsCoordinatorRecovery: true,
  } as unknown as Adapter & { supportsCoordinatorRecovery?: boolean };
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer, coordinator];
  return {
    dir,
    store,
    engine,
    submitted,
    states,
    createdRuns,
    participantActivity,
    putReviewerRun,
    current: () => store.task(submitted.id),
    events: (kind: string) =>
      store.eventsAll(submitted.id).filter((event) => event.kind === kind),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a reviewer whose recorded process started before this boot is released and relaunched", async () => {
  const f = fixture();
  try {
    // Seen before this machine booted: no process from the earlier boot survives.
    const seenAt = Date.now() - uptime() * 1_000 - 60_000;
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        {
          pid: 4242,
          startIdentity: `4242@${new Date(seenAt).toISOString()}`,
          seenAt,
        },
      ),
    });
    assert.equal(
      processDeathProof(f.store, f.current(), f.store.run("review-run"))
        ?.evidence,
      "pre_boot",
      "the recorded process predates this boot",
    );

    await f.engine.wake();

    const released = f.store.run("review-run")!;
    assert.equal(released.released, true, "the dead reviewer run is released");
    const proof = f.events("participant_process_gone");
    assert.equal(proof.length, 1, "one event names the proof");
    assert.match(proof[0]!.detail, /"evidence":"pre_boot"/);
    assert.match(proof[0]!.detail, /"pid":4242/);
    assert.match(proof[0]!.detail, /"evidence":"pre_boot"/);
    assert.equal(
      f.current().resolution.stop ?? null,
      null,
      "a released run is not a stall stop",
    );

    const launched = f.createdRuns.filter((run) => run.role === "reviewer");
    assert.equal(
      launched.length,
      1,
      "ordinary admission relaunches the reviewer",
    );
    assert.notEqual(
      launched[0]!.agentId,
      "review-agent",
      "a released reviewer gets a fresh thread",
    );
    assert.equal(f.current().resolution.currentRunId, launched[0]!.id);
    assert.equal(f.current().phase, "reviewing");
  } finally {
    await f.close();
  }
});

test("a reused PID with a different start identity is released", async () => {
  const f = fixture();
  try {
    const at = Date.now();
    const process = {
      pid: 5151,
      startIdentity: "5151@boot-9:7",
      seenAt: at - 5_000,
    };
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        process,
      ),
    });
    // The same PID now belongs to a different process: its start identity differs.
    rememberParticipantProcessTable(
      [
        {
          pid: 5151,
          ppid: 1,
          pgid: 5151,
          uid: 501,
          state: "S",
          startIdentity: "5151@boot-9:100",
          command: "node",
          cwd: null,
        },
      ],
      at,
      new Set([5151]),
    );

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, true);
    const proof = f.events("participant_process_gone");
    assert.equal(proof.length, 1);
    assert.match(proof[0]!.detail, /"evidence":"start_identity_changed"/);
    assert.equal(
      f.createdRuns.filter((run) => run.role === "reviewer").length,
      1,
      "the relaunch follows the release",
    );
  } finally {
    await f.close();
  }
});

test("an unreadable process table keeps the run and records the stall", async () => {
  const f = fixture();
  try {
    const seenAt = Date.now() - 5_000;
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        { pid: 6262, startIdentity: "6262@boot-9:11", seenAt },
      ),
    });
    rememberParticipantProcessTable(null, Date.now());
    assert.equal(
      processDeathProof(f.store, f.current(), f.store.run("review-run")),
      null,
      "an unreadable table proves nothing",
    );

    await f.engine.wake();

    assert.equal(
      f.store.run("review-run")!.released,
      false,
      "the run keeps its lease",
    );
    assert.equal(f.events("participant_process_gone").length, 0);
    assert.equal(f.current().resolution.stop?.reason, "run_stalled");
    assert.equal(f.current().resolution.attention, true);
  } finally {
    await f.close();
  }
});

test("a live process with a stale display is kept, and its run_stalled stop admits the coordinator", async () => {
  const f = fixture();
  try {
    const at = Date.now();
    const startIdentity = "7373@boot-9:21";
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        { pid: 7373, startIdentity, seenAt: at - 5_000 },
      ),
    });
    rememberParticipantProcessTable(
      [
        {
          pid: 7373,
          ppid: 1,
          pgid: 7373,
          uid: 501,
          state: "S",
          startIdentity,
          command: "node",
          cwd: null,
        },
      ],
      at,
      new Set([7373]),
    );

    await f.engine.wake();

    assert.equal(
      f.store.run("review-run")!.released,
      false,
      "a live process is never released for a stale display",
    );
    const stop = f.current().resolution.stop;
    assert.equal(stop?.reason, "run_stalled");
    assert.deepEqual(stop?.suggestedVerbs, ["restart"]);
    assert.equal(
      f.createdRuns.some((run) => run.role === "recovery"),
      true,
      "the stalled participant is the stop's subject, not an idle barrier",
    );
    assert.ok(f.current().resolution.recovery?.runId);
    assert.equal(
      f.states.get("review-agent")?.status,
      "running",
      "the host still displays the participant as running",
    );
  } finally {
    await f.close();
  }
});

test("two writers: only the dead reviewer is released; the retained worker keeps its binding", async () => {
  const f = fixture();
  try {
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        {
          pid: 8484,
          startIdentity: "8484@earlier-boot",
          seenAt: Date.now() - uptime() * 1_000 - 60_000,
        },
      ),
    });
    // The retained worker is a live second writer on its own recorded process.
    f.store.update(f.submitted.id, {
      participantActivity: f.participantActivity(
        "worker-run",
        "worker",
        "worker-turn-1",
        {
          pid: 9494,
          startIdentity: "9494@boot-9:31",
          seenAt: Date.now() - 5_000,
        },
      ),
    });
    rememberParticipantProcessTable(
      [
        {
          pid: 9494,
          ppid: 1,
          pgid: 9494,
          uid: 501,
          state: "S",
          startIdentity: "9494@boot-9:31",
          command: "node",
          cwd: null,
        },
      ],
      Date.now(),
      new Set([9494]),
    );

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, true);
    const after = f.current();
    assert.equal(
      after.agentId,
      "worker",
      "the retained worker keeps its thread",
    );
    assert.equal(after.runId, "worker-run");
    assert.equal(
      f.events("participant_process_gone").length,
      1,
      "only the participant whose own process is gone is released",
    );
  } finally {
    await f.close();
  }
});

test("a released worker returns to ordinary dispatch so the worker relaunches", async () => {
  const f = fixture();
  try {
    // A working task whose own retained worker process predates this boot. The
    // reviewer run is released first so only the worker is under observation.
    f.store.putRun({
      ...f.store.run("review-run")!,
      released: true,
      active: false,
      status: "superseded",
    });
    const seenAt = Date.now() - uptime() * 1_000 - 60_000;
    f.store.update(f.submitted.id, {
      phase: "working",
      completion: null,
      prHead: null,
      prUrl: null,
      participantActivity: f.participantActivity(
        "worker-run",
        "worker",
        "worker-turn-1",
        {
          pid: 4343,
          startIdentity: `4343@${new Date(seenAt).toISOString()}`,
          seenAt,
        },
      ),
      resolution: {
        ...f.current().resolution,
        currentRunId: null,
        reviewerAgentId: null,
        reviewerProfile: null,
      },
    });
    f.states.set("worker", {
      id: "worker",
      workspaceId: "workspace",
      status: "running",
      active: true,
      permissions: false,
      error: "",
      provider: "test",
      model: worker.model,
      updatedAt: minutesAgo(40),
      turnStartedAt: minutesAgo(41),
      activeTurnId: "worker-turn-1",
    });

    await f.engine.wake();

    const current = f.current();
    const proof = f.events("participant_process_gone");
    assert.equal(proof.length, 1, "the worker release records its proof");
    assert.match(proof[0]!.detail, /"evidence":"pre_boot"/);
    assert.equal(
      current.resolution.stop?.reason === "run_stalled",
      false,
      "a released worker is not a stall stop",
    );
    // The dead binding is gone and the task is not left with nothing to run: the
    // release returns it to ordinary dispatch, which admits a new worker.
    assert.notEqual(
      current.runId,
      "worker-run",
      "the released worker binding is cleared",
    );
    assert.equal(
      current.agentId,
      `agent-${f.submitted.id}`,
      "ordinary dispatch admits a fresh worker after the release",
    );
    assert.equal(current.phase, "working");
    assert.equal(
      current.resolution.stop,
      null,
      "the task is running, not parked",
    );
    assert.match(current.reason, /Worker running/);
    assert.equal(
      f.events("worker_process_gone_redispatch").length,
      1,
      "the redispatch is recorded beside the proof",
    );
  } finally {
    await f.close();
  }
});
