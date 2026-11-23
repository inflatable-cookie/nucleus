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
import { processDeathProof } from "../core/recovery/dead-participant";
import {
  readCreationAttempt,
  settleCreationAttempt,
} from "../core/store/store-task-funnel";
import { runStartPlan } from "../core/verbs/explicit-run-start";
import { AGENT_NOT_FOUND, HostReadRefusalError } from "../core/host/errors";
import {
  runSchema,
  submissionSchema,
  taskNextSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import type { ParticipantActivity } from "../shared/schema/task-activity";
import type { Adapter, AgentObservation } from "../core/host";

/**
 * Spec 068 batch A: dead agents and uncertain launches recover by themselves.
 *
 * Seen on 2026-11-22 after a T3 crash and a reboot: runs whose processes were
 * gone and threads absent stayed "running", a changes_requested task whose
 * retained worker thread was gone sat in "Worker action requested", uncertain
 * creations waited for a planner, and replaced runs kept their old reasons.
 *
 * The adapter, the clock and the recorded process facts are fixtures; the stall
 * path, the observation pass, the creation lookup, the revision launch and the
 * coordinator route are the real ones. Process-death cases are ported from
 * nucleus#1552 (PR #453).
 */

const head = "a".repeat(40),
  base = "b".repeat(40);
const worker = profile("worker", "test/worker");
const reviewer = profile("reviewer", "test/reviewer");
const coordinator = profile("coordinator", "test/coordinator");
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const preBoot = () => Date.now() - uptime() * 1_000 - 60_000;

type Fixture = ReturnType<typeof fixture>;

function fixture(options: { graceMs?: number } = {}) {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "ns-dead-agent-"),
  );
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
      title: "Dead agent recovery",
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

  /** A stalled but live-looking thread: the host still says running, no activity for 40 minutes. */
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
  /** Threads the host no longer has: absent from its live list and its exact read. */
  const goneThreads = new Set<string>();
  /** Threads whose exact read fails (a partial or unreadable host read). */
  const unreadableThreads = new Set<string>();
  /** What a creation lookup answers per run id; a thrown value is a failed read. */
  const lookups = new Map<
    string,
    { id: string; workspaceId: string | null }[] | Error
  >();
  const createdRuns: Run[] = [];
  const adapter = {
    profiles: async () => [worker, reviewer, coordinator],
    validate: async () => base,
    createWorkspace: async () => ({ id: "workspace", directory: "/worktree" }),
    verifyWorkspace: async (candidate: Task) => candidate.branch,
    findWorkspaces: async () => [],
    findAgents: async () => [],
    findRunAgents: async (run: Run) => {
      const answer = lookups.get(run.id) ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    createAgent: createTaskAgent,
    observe: async (id: string) => {
      if (unreadableThreads.has(id))
        throw new HostReadRefusalError("host read refused: shell snapshot is stale");
      if (goneThreads.has(id)) throw new Error(AGENT_NOT_FOUND);
      return (
        states.get(id) ?? {
          id,
          workspaceId: "workspace",
          status: "idle",
          active: false,
          permissions: false,
          error: "",
        }
      );
    },
    archiveAgent: async () => {},
    notify: async () => {},
    originAgent: async (id: string) => {
      if (unreadableThreads.has(id))
        throw new HostReadRefusalError("host read refused: shell snapshot is stale");
      if (goneThreads.has(id)) return null;
      return { id, workspaceId: "workspace", title: id, archived: false };
    },
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
  const engine = new Engine(store, adapter, options.graceMs ?? 0);
  engine.profiles = [worker, reviewer, coordinator];
  return {
    dir,
    store,
    engine,
    submitted,
    states,
    goneThreads,
    unreadableThreads,
    lookups,
    createdRuns,
    participantActivity,
    putReviewerRun,
    current: () => store.task(submitted.id),
    events: (kind: string) =>
      store.eventsAll(submitted.id).filter((event) => event.kind === kind),
    next: () =>
      taskNextSchema.parse(
        ownerTaskNext(collectOwnerVerbFacts(store, store.task(submitted.id))),
      ),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Put the task in changes_requested after a reviewer verdict, with the review run settled. */
function changesRequested(f: Fixture) {
  f.store.putRun({
    ...f.store.run("review-run")!,
    released: true,
    active: false,
    status: "finished",
  });
  f.store.update(f.submitted.id, {
    phase: "changes_requested",
    reason: "Worker action requested: fix the failing test",
    resolution: {
      ...f.current().resolution,
      currentRunId: null,
      pendingWorkerInstruction: "fix the failing test",
    },
  });
}

/** One agentless creation whose native call ended (it threw) before this pass. */
function uncertainReviewer(f: Fixture, id = "uncertain-review"): Run {
  f.store.putRun({
    ...f.store.run("review-run")!,
    released: true,
    active: false,
    status: "superseded",
  });
  const run = runSchema.parse({
    id,
    taskId: f.submitted.id,
    role: "reviewer",
    generation: 1,
    head,
    base,
    agentId: null,
    workspaceId: "workspace",
    profile: reviewer,
    status: "intent",
    createdAt: minutesAgo(5),
    lastObservedAt: null,
    active: null,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.store.putRun(run);
  f.store.putRun({ ...f.store.run(id)!, status: "uncertain" });
  const attempt = readCreationAttempt(f.store, f.store.run(id)!);
  assert.ok(attempt, "the store journals every agentless creation");
  settleCreationAttempt(f.store, attempt!, "threw");
  f.store.update(f.submitted.id, {
    phase: "reviewing",
    resolution: {
      ...f.current().resolution,
      currentRunId: id,
      reviewerAgentId: null,
      reviewerProfile: reviewer,
    },
  });
  return f.store.run(id)!;
}

test("a reviewer whose recorded process started before this boot is released and relaunched fresh at the same head", async () => {
  const f = fixture();
  try {
    const seenAt = preBoot();
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
    );

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, true);
    const proof = f.events("participant_gone");
    assert.equal(proof.length, 1, "one event names the proof");
    assert.match(proof[0]!.detail, /"evidence":"pre_boot"/);
    assert.match(proof[0]!.detail, /"pid":4242/);
    const launched = f.createdRuns.filter((run) => run.role === "reviewer");
    assert.equal(launched.length, 1, "ordinary admission relaunches the reviewer once");
    assert.equal(launched[0]!.agentId, null, "on a fresh thread");
    assert.equal(launched[0]!.head, head, "at the same head");
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
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        { pid: 5151, startIdentity: "5151@boot-9:7", seenAt: at - 5_000 },
      ),
    });
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
    assert.match(
      f.events("participant_gone")[0]!.detail,
      /"evidence":"start_identity_changed"/,
    );
    assert.equal(
      f.createdRuns.filter((run) => run.role === "reviewer").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("an unreadable process table and a live thread keep the run and record the stall", async () => {
  const f = fixture();
  try {
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        { pid: 6262, startIdentity: "6262@boot-9:11", seenAt: Date.now() - 5_000 },
      ),
    });
    rememberParticipantProcessTable(null, Date.now());

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, false, "the run keeps its lease");
    assert.equal(f.events("participant_gone").length, 0);
    assert.equal(f.current().resolution.stop?.reason, "run_stalled");
  } finally {
    await f.close();
  }
});

test("a live process with a stale display is never released, and its run_stalled stop admits the coordinator", async () => {
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

    assert.equal(f.store.run("review-run")!.released, false);
    assert.equal(f.current().resolution.stop?.reason, "run_stalled");
    assert.equal(
      f.createdRuns.some((run) => run.role === "recovery"),
      true,
      "the stalled participant is the stop's subject, not an idle barrier",
    );
    assert.equal(f.states.get("review-agent")?.status, "running");
  } finally {
    await f.close();
  }
});

test("a live recorded process vetoes a missing thread: one writer at a time", async () => {
  const f = fixture();
  try {
    const at = Date.now();
    const startIdentity = "7474@boot-9:22";
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        { pid: 7474, startIdentity, seenAt: at - 5_000 },
      ),
    });
    f.goneThreads.add("review-agent");
    rememberParticipantProcessTable(
      [
        {
          pid: 7474,
          ppid: 1,
          pgid: 7474,
          uid: 501,
          state: "S",
          startIdentity,
          command: "node",
          cwd: null,
        },
      ],
      at,
      new Set([7474]),
    );

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, false);
    assert.equal(f.events("participant_gone").length, 0);
    assert.equal(f.createdRuns.filter((run) => run.role === "reviewer").length, 0);
  } finally {
    await f.close();
  }
});

test("reboot: every run whose thread is gone is released and relaunched with no planner command", async () => {
  const f = fixture();
  try {
    // After the reboot the host no longer has the reviewer's thread, and its
    // process (recorded before the boot) is gone too.
    const seenAt = preBoot();
    f.store.putRun({
      ...f.store.run("review-run")!,
      active: false,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        null,
        { pid: 3131, startIdentity: `3131@${new Date(seenAt).toISOString()}`, seenAt },
      ),
    });
    f.goneThreads.add("review-agent");
    f.states.delete("review-agent");

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, true);
    assert.equal(f.events("participant_gone").length, 1);
    const reviewers = f.createdRuns.filter((run) => run.role === "reviewer");
    assert.equal(reviewers.length, 1, "a fresh reviewer at the same head");
    assert.equal(reviewers[0]!.agentId, null);
    assert.equal(reviewers[0]!.head, head);
    assert.notEqual(f.current().resolution.reviewerAgentId, "review-agent");
    assert.equal(f.current().resolution.attention, false, "nothing parked for a person");
  } finally {
    await f.close();
  }
});

test("reboot: a thread missing from the host with no process facts is released on the exact read alone", async () => {
  const f = fixture();
  try {
    f.store.putRun({ ...f.store.run("review-run")!, active: false });
    f.goneThreads.add("review-agent");
    f.states.delete("review-agent");

    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, true);
    assert.match(f.events("participant_gone")[0]!.detail, /"evidence":"thread_absent"/);
    assert.equal(f.createdRuns.filter((run) => run.role === "reviewer").length, 1);
  } finally {
    await f.close();
  }
});

test("an unreadable or partial host read never releases a run", async () => {
  const f = fixture();
  try {
    f.store.putRun({ ...f.store.run("review-run")!, active: false });
    f.unreadableThreads.add("review-agent");

    await f.engine.wake();
    await f.engine.wake();

    assert.equal(f.store.run("review-run")!.released, false, "absence is never inferred");
    assert.equal(f.events("participant_gone").length, 0);
    assert.equal(f.createdRuns.filter((run) => run.role === "reviewer").length, 0);
  } finally {
    await f.close();
  }
});

test("two writers: only the dead reviewer is released; the live retained worker keeps its binding", async () => {
  const f = fixture();
  try {
    f.store.putRun({
      ...f.store.run("review-run")!,
      participantActivity: f.participantActivity(
        "review-run",
        "review-agent",
        "reviewer-turn-1",
        { pid: 8484, startIdentity: "8484@earlier-boot", seenAt: preBoot() },
      ),
    });
    f.store.update(f.submitted.id, {
      participantActivity: f.participantActivity(
        "worker-run",
        "worker",
        "worker-turn-1",
        { pid: 9494, startIdentity: "9494@boot-9:31", seenAt: Date.now() - 5_000 },
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
    assert.equal(f.current().agentId, "worker");
    assert.equal(f.current().runId, "worker-run");
    assert.equal(f.events("participant_gone").length, 1);
  } finally {
    await f.close();
  }
});

test("a dead initial worker with no PR returns to ordinary dispatch and relaunches", async () => {
  const f = fixture();
  try {
    f.store.putRun({
      ...f.store.run("review-run")!,
      released: true,
      active: false,
      status: "superseded",
    });
    const seenAt = preBoot();
    f.store.update(f.submitted.id, {
      phase: "working",
      completion: null,
      prHead: null,
      prUrl: null,
      participantActivity: f.participantActivity("worker-run", "worker", "worker-turn-1", {
        pid: 4343,
        startIdentity: `4343@${new Date(seenAt).toISOString()}`,
        seenAt,
      }),
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
    assert.equal(f.events("participant_gone").length, 1);
    assert.notEqual(current.runId, "worker-run");
    assert.equal(current.agentId, `agent-${f.submitted.id}`);
    assert.equal(current.phase, "working");
    assert.equal(f.events("worker_process_gone_redispatch").length, 1);
  } finally {
    await f.close();
  }
});

test("a dead initial worker with a PR continues the PR on a fresh worker", async () => {
  const f = fixture();
  try {
    f.store.putRun({
      ...f.store.run("review-run")!,
      released: true,
      active: false,
      status: "superseded",
    });
    f.store.update(f.submitted.id, {
      phase: "working",
      completion: null,
      resolution: {
        ...f.current().resolution,
        currentRunId: null,
        reviewerAgentId: null,
        reviewerProfile: null,
      },
    });
    // The worker's thread is gone on its host.
    f.goneThreads.add("worker");
    f.states.delete("worker");

    await f.engine.wake();
    await f.engine.wake();

    const current = f.current();
    assert.equal(f.events("participant_gone").length, 1);
    assert.match(f.events("participant_gone")[0]!.detail, /"evidence":"thread_absent"/);
    assert.equal(f.events("worker_gone_fresh_continuation").length, 1);
    assert.equal(current.retiredWorkers.at(-1)?.agentId, "worker", "the dead worker is history");
    const revisions = f.createdRuns.filter((run) => run.role === "revision");
    assert.equal(revisions.length, 1, "one revision continues the PR");
    assert.equal(revisions[0]!.agentId, null, "on a fresh worker thread");
    assert.equal(current.agentId, `agent-${revisions[0]!.id}`, "the fresh worker is the retained worker now");
    assert.equal(current.resolution.attention, false);
  } finally {
    await f.close();
  }
});

test("a changes_requested task whose retained worker thread is gone continues the revision on a fresh worker", async () => {
  const f = fixture();
  try {
    changesRequested(f);
    f.goneThreads.add("worker");
    f.states.delete("worker");

    await f.engine.wake();

    const current = f.current();
    const retired = f.events("retained_worker_gone");
    assert.equal(retired.length, 1, "the retirement records its proof");
    assert.match(retired[0]!.detail, /"evidence":"thread_absent"/);
    assert.equal(current.retiredWorkers.at(-1)?.agentId, "worker");
    assert.match(current.retiredWorkers.at(-1)!.reason, /fresh worker/);
    const revisions = f.createdRuns.filter((run) => run.role === "revision");
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.agentId, null, "a fresh worker, not the dead thread");
    assert.equal(current.agentId, `agent-${revisions[0]!.id}`);
    assert.equal(current.resolution.currentRunId, revisions[0]!.id);
  } finally {
    await f.close();
  }
});

test("a changes_requested task keeps a live retained worker for its revision", async () => {
  const f = fixture();
  try {
    changesRequested(f);
    await f.engine.wake();
    assert.equal(f.events("retained_worker_gone").length, 0);
    const revisions = f.createdRuns.filter((run) => run.role === "revision");
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.agentId, "worker", "the live retained worker takes the revision");
  } finally {
    await f.close();
  }
});

test("an unreadable read of the retained worker never retires it", async () => {
  const f = fixture();
  try {
    changesRequested(f);
    f.unreadableThreads.add("worker");
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.events("retained_worker_gone").length, 0, "a failed read proves nothing");
    assert.equal(f.current().agentId, "worker");
    assert.equal(
      f.createdRuns.filter((run) => run.role === "revision" && run.agentId !== "worker").length,
      0,
      "no fresh worker beside a worker that may be live",
    );
  } finally {
    await f.close();
  }
});

test("next offers run.start worker fresh when the retained worker is gone", async () => {
  const f = fixture();
  try {
    changesRequested(f);
    const offered = (next: ReturnType<Fixture["next"]>) =>
      (next.explicitCommands ?? [])
        .filter((command) => command.action === "run.start")
        .map((command) => (command.args as { agent?: string }).agent);
    assert.deepEqual(offered(f.next()).sort(), ["fresh", "retained"]);
    // The worker was retired as gone (as the revision launch does): fresh only.
    f.store.update(f.submitted.id, { agentId: null, agentIntent: false });
    assert.deepEqual(offered(f.next()), ["fresh"]);
  } finally {
    await f.close();
  }
});

test("uncertain creation: the one thread the lookup finds is bound", async () => {
  const f = fixture();
  try {
    const run = uncertainReviewer(f);
    f.lookups.set(run.id, [{ id: "found-review-agent", workspaceId: "workspace" }]);

    await f.engine.wake();

    const bound = f.store.run(run.id)!;
    assert.equal(bound.agentId, "found-review-agent");
    assert.equal(bound.released, false);
    assert.equal(f.current().resolution.reviewerAgentId, "found-review-agent");
    assert.equal(f.events("creation_bound_by_lookup").length, 1);
    assert.equal(
      f.createdRuns.filter((candidate) => candidate.role === "reviewer").length,
      0,
      "nothing is relaunched",
    );
  } finally {
    await f.close();
  }
});

test("uncertain creation: absent on a complete read after the grace releases it and relaunches once", async () => {
  const f = fixture();
  try {
    const run = uncertainReviewer(f);

    await f.engine.wake();
    await f.engine.wake();

    assert.equal(f.store.run(run.id)!.released, true);
    assert.ok(f.store.run(run.id)!.absentProvenAt);
    assert.equal(f.events("creation_absent_released").length, 1);
    const relaunched = f.createdRuns.filter((candidate) => candidate.role === "reviewer");
    assert.equal(relaunched.length, 1, "exactly one relaunch");
    assert.equal(f.current().resolution.currentRunId, relaunched[0]!.id);
    assert.doesNotMatch(f.current().reason, new RegExp(run.id), "the old run's reason is gone");
  } finally {
    await f.close();
  }
});

test("uncertain creation: a thread appearing late inside the grace is bound, never duplicated", async () => {
  const f = fixture({ graceMs: 60 * 60_000 });
  try {
    const run = uncertainReviewer(f);

    await f.engine.wake();
    assert.equal(f.store.run(run.id)!.released, false, "inside the grace an absent read waits");
    assert.equal(f.current().resolution.stop?.fact?.code, "creation_lookup");
    assert.match(f.current().reason, /grace period ends at/);

    f.lookups.set(run.id, [{ id: "late-agent", workspaceId: "workspace" }]);
    await f.engine.wake();

    assert.equal(f.store.run(run.id)!.agentId, "late-agent");
    assert.equal(
      f.createdRuns.filter((candidate) => candidate.role === "reviewer").length,
      0,
      "no duplicate reviewer",
    );
  } finally {
    await f.close();
  }
});

test("uncertain creation: a failed lookup keeps waiting with its reason named", async () => {
  const f = fixture();
  try {
    const run = uncertainReviewer(f);
    f.lookups.set(run.id, new Error("host read refused: shell snapshot is stale"));

    await f.engine.wake();

    assert.equal(f.store.run(run.id)!.released, false);
    assert.equal(f.store.run(run.id)!.agentId, null);
    assert.equal(f.current().resolution.stop?.reason, "lifecycle");
    assert.equal(f.current().resolution.stop?.fact?.subject, run.id);
    assert.match(f.current().reason, /lookup could not complete/);
    assert.equal(f.createdRuns.filter((candidate) => candidate.role === "reviewer").length, 0);
  } finally {
    await f.close();
  }
});

test("uncertain creation: past the attempt bound the task records a typed stop with its command", async () => {
  const f = fixture();
  try {
    const run = uncertainReviewer(f);
    for (let index = 0; index < 3; index++)
      f.store.event(
        f.submitted.id,
        "creation_absent_released",
        JSON.stringify({ runId: `earlier-${index}`, role: "reviewer" }),
      );

    await f.engine.wake();

    assert.equal(f.store.run(run.id)!.released, false);
    assert.equal(f.current().resolution.stop?.reason, "operator_needed");
    assert.match(f.current().reason, new RegExp(`run.start reviewer fresh replacing=${run.id}`));
  } finally {
    await f.close();
  }
});

/** An initial worker whose native create call ended (it threw) with no agent bound. */
function uncertainWorker(f: Fixture) {
  f.store.putRun({
    ...f.store.run("review-run")!,
    released: true,
    active: false,
    status: "superseded",
  });
  f.store.update(
    f.submitted.id,
    {
      phase: "working",
      completion: null,
      prHead: null,
      prUrl: null,
      agentId: null,
      agentIntent: true,
      runId: "uncertain-worker-run",
      resolution: {
        ...f.current().resolution,
        currentRunId: null,
        reviewerAgentId: null,
        reviewerProfile: null,
      },
    },
    "agent_intent",
  );
  const attempt = readCreationAttempt(f.store, {
    id: "uncertain-worker-run",
    taskId: f.submitted.id,
    hostId: f.current().hostId,
    workspaceId: "workspace",
    role: "worker",
  });
  assert.ok(attempt, "the initial worker's creation is journaled");
  settleCreationAttempt(f.store, attempt!, "threw");
}

test("uncertain worker creation: the one thread the lookup finds is bound", async () => {
  const f = fixture();
  try {
    uncertainWorker(f);
    f.lookups.set("uncertain-worker-run", [
      { id: "found-worker", workspaceId: "workspace" },
    ]);
    await f.engine.wake();
    assert.equal(f.current().agentId, "found-worker");
    assert.equal(f.current().runId, "uncertain-worker-run");
    assert.equal(f.events("creation_bound_by_lookup").length, 1);
  } finally {
    await f.close();
  }
});

test("uncertain worker creation: absent after the grace relaunches the worker once", async () => {
  const f = fixture();
  try {
    uncertainWorker(f);
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.events("creation_absent_released").length, 1);
    // The relaunch reuses the released run id (restartRunId), under a new attempt.
    assert.equal(f.events("creation_attempt_reserved").length, 2);
    assert.equal(f.current().phase, "working");
    assert.equal(f.current().agentId, `agent-${f.submitted.id}`, "one fresh worker");
  } finally {
    await f.close();
  }
});

test("uncertain worker creation: a failed lookup keeps the creation and names why", async () => {
  const f = fixture();
  try {
    uncertainWorker(f);
    f.lookups.set("uncertain-worker-run", new Error("host read refused"));
    await f.engine.wake();
    assert.equal(f.current().runId, "uncertain-worker-run");
    assert.equal(f.current().agentId, null);
    assert.equal(f.current().resolution.stop?.fact?.code, "worker_lookup");
    assert.match(f.current().reason, /lookup could not complete/);
  } finally {
    await f.close();
  }
});

test("a stop naming a superseded run clears once the run is released", async () => {
  const f = fixture();
  try {
    const run = uncertainReviewer(f, "old-review");
    f.store.update(f.submitted.id, {
      reason: `Uncertain reviewer creation ${run.id}; use run.start reviewer fresh replacing=${run.id}`,
      resolution: {
        ...f.current().resolution,
        currentRunId: null,
        stop: {
          reason: "lifecycle",
          detail: `Uncertain reviewer creation ${run.id}; use run.start reviewer fresh replacing=${run.id}`,
          since: new Date().toISOString(),
          suggestedVerbs: [],
          fact: { code: "creation_lookup", subject: run.id },
        },
      },
    });
    // A replacement released it outside the lookup (an owner command, say).
    f.store.putRun({ ...f.store.run(run.id)!, released: true, status: "superseded" });

    await f.engine.wake();

    assert.equal(f.events("superseded_run_stop_cleared").length, 1);
    assert.doesNotMatch(f.current().reason, /old-review/);
    assert.notEqual(f.current().resolution.stop?.fact?.subject, run.id);
  } finally {
    await f.close();
  }
});

test("replacing a reviewer that reported a verdict at the current head warns before discarding it", async () => {
  const f = fixture();
  try {
    f.store.putRun({
      ...f.store.run("review-run")!,
      completion: {
        taskId: f.submitted.id,
        runId: "review-run",
        eventId: "review-verdict",
        status: "changes_required",
        summary: "Two findings",
        head,
      },
    });
    const task = f.current();
    const input = {
      action: "run.start" as const,
      taskId: task.id,
      version: task.version,
      reason: "replace the reviewer",
      accept: [],
      caller: "operator_board",
      role: "reviewer" as const,
      agent: "fresh" as const,
      replacing: "review-run",
    };
    const plan = runStartPlan(f.engine, task, input);
    const warning = plan.warnings.find((item) => item.id === "discard_reported_verdict");
    assert.ok(warning, "the replacement names the reported verdict");
    assert.match(warning!.text, /already reported changes_required/);
    const note = (f.next().explicitCommands ?? [])
      .map((command) => command.note ?? "")
      .join("\n");
    assert.doesNotMatch(note, /replacing it discards/, "no offer replaces a reviewer that reported");
    // Once applied, the verdict is history and replacement no longer warns.
    f.store.event(f.submitted.id, "review_result_applied", "review-run");
    assert.equal(
      runStartPlan(f.engine, f.current(), { ...input, version: f.current().version })
        .warnings.some((item) => item.id === "discard_reported_verdict"),
      false,
    );
  } finally {
    await f.close();
  }
});
