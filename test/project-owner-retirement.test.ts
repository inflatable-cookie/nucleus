import { fakeAdapter, profile } from './support/fakes';
import { ANSWERING_WINDOW_MS, waitFor } from "./support/budgets";
import { answerFixturePrompt } from "./support/delegated-reply";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  projectSchema,
  submissionSchema,
  taskControlInputSchema,
  type Run,
  type Task,
} from "../shared/contracts";
import type { Adapter, AgentObservation, OriginAgent } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

/**
 * Spec 058 cutover 5: project ownership retires. The owner field stays readable on
 * old rows; a one-time migration converts a live owner thread into the project's
 * planner (`setBy` Queue, reason recorded) and drops an archived or missing one;
 * notices that fell back to the project owner route to the planner chain instead.
 */

const head = "a".repeat(40),
  base = "b".repeat(40);

const reviewerProfile = profile("reviewer", "test/reviewer"),
  coordinatorProfile = profile("coordinator", "test/coordinator");

function migrationFixture(agents: Record<string, OriginAgent | null>) {
  const dir = mkdtempSync(join(tmpdir(), "ns-owner-retire-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  const adapter = {
    profiles: async () => [],
    originAgent: async (id: string) => agents[id] ?? null,
    observe: async (id: string) =>
      ({
        id,
        workspaceId: "workspace",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      }) as AgentObservation,
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  return {
    dir,
    store,
    engine,
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes a pre-retirement project row exactly as an older build stored it. */
function writeLegacyProject(
  store: Store,
  key: string,
  owner: {
    agentId: string;
    assignedBy: string;
    assignedAt: string;
    note: string;
  } | null,
  planner?: { agentId: string; setBy: string; setAt: string } | null,
) {
  const project = projectSchema.parse({
    key,
    name: key,
    version: 1,
    visibility: "active",
    repositories: [{ origin: null, path: `/${key}` }],
    primary: { origin: null, path: `/${key}` },
    ...(owner ? { owner, ownerCheckedAt: owner.assignedAt } : {}),
    ...(planner !== undefined ? { planner } : {}),
  });
  store.db
    .prepare(
      "INSERT INTO projects(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
    )
    .run(key, JSON.stringify(project));
}

test("an old project row with an owner parses, and the one-time migration converts live owners to planners", async () => {
  const f = migrationFixture({
    live: {
      id: "live",
      workspaceId: "planning",
      title: "Supervisor",
      archived: false,
    },
    gone: {
      id: "gone",
      workspaceId: "planning",
      title: "Retired Supervisor",
      archived: true,
    },
    missing: null,
  });
  try {
    writeLegacyProject(f.store, "live-owner", {
      agentId: "live",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "Spec 042 seed",
    });
    writeLegacyProject(f.store, "archived-owner", {
      agentId: "gone",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "Spec 042 seed",
    });
    writeLegacyProject(f.store, "missing-owner", {
      agentId: "missing",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "Spec 042 seed",
    });
    writeLegacyProject(
      f.store,
      "both-already",
      {
        agentId: "live",
        assignedBy: "operator",
        assignedAt: "2026-10-03T00:00:00.000Z",
        note: "",
      },
      {
        agentId: "already-planner",
        setBy: "operator",
        setAt: "2026-11-01T00:00:00.000Z",
      },
    );
    writeLegacyProject(f.store, "never-owned", null);
    // Old rows parse: the owner record survives schema parsing untouched.
    const parsed = f.store
      .projects()
      .find((project) => project.key === "live-owner")!;
    assert.deepEqual(parsed.owner, {
      agentId: "live",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "Spec 042 seed",
    });

    await f.engine.migrateProjectOwnersToPlanners();
    const live = f.store.projectByKey("live-owner")!;
    assert.deepEqual(live.planner, {
      agentId: "live",
      setBy: "Queue",
      setAt: live.planner!.setAt,
    });
    assert.ok(
      live.owner,
      "the live owner field stays on the record as readable history",
    );
    assert.ok(
      f.store
        .events("project:live-owner")
        .some(
          (event) =>
            event.kind === "project_planner_set" &&
            event.detail.includes("by Queue") &&
            event.detail.includes("the live owner thread becomes the planner"),
        ),
      "the change names Queue and its reason",
    );

    const archived = f.store.projectByKey("archived-owner")!;
    assert.ok(!archived.planner, "no planner is minted");
    assert.equal(archived.owner, null, "an archived owner is dropped");
    assert.ok(
      f.store
        .events("project:archived-owner")
        .some((event) => event.kind === "project_owner_retired"),
    );

    const missing = f.store.projectByKey("missing-owner")!;
    assert.ok(!missing.planner, "no planner is minted");
    assert.equal(missing.owner, null, "a missing owner is dropped");

    const both = f.store.projectByKey("both-already")!;
    assert.deepEqual(
      both.planner,
      {
        agentId: "already-planner",
        setBy: "operator",
        setAt: "2026-11-01T00:00:00.000Z",
      },
      "a project with a planner is left alone",
    );
    assert.ok(!f.store.projectByKey("never-owned")!.planner);
    assert.equal(
      f.store.getMeta("projectOwnersToPlanners"),
      "done",
      "the migration records its one-time marker",
    );

    // Idempotent: a second run rewrites nothing.
    const eventsBefore = f.store.projects().length;
    await f.engine.migrateProjectOwnersToPlanners();
    assert.equal(f.store.projects().length, eventsBefore);
    assert.equal(
      f.store
        .events("project:live-owner")
        .filter((event) => event.kind === "project_planner_set").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("an unreadable owner thread defers its project to the next start, and the marker waits for every project", async () => {
  const f = migrationFixture({ flaky: null });
  try {
    writeLegacyProject(f.store, "flaky-project", {
      agentId: "flaky",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "",
    });
    const adapter = f.engine.adapter as {
      originAgent: (id: string) => Promise<OriginAgent | null>;
    };
    adapter.originAgent = async () => {
      throw new Error("Disconnected");
    };
    await f.engine.migrateProjectOwnersToPlanners();
    assert.equal(
      f.store.projectByKey("flaky-project")!.owner?.agentId,
      "flaky",
      "an unknown read changes nothing",
    );
    assert.ok(
      !f.store.getMeta("projectOwnersToPlanners"),
      "no marker while a project is unresolved",
    );
    adapter.originAgent = async (id) => ({
      id,
      workspaceId: "planning",
      title: "Recovered",
      archived: false,
    });
    await f.engine.migrateProjectOwnersToPlanners();
    assert.equal(
      f.store.projectByKey("flaky-project")!.planner?.agentId,
      "flaky",
    );
    assert.equal(f.store.getMeta("projectOwnersToPlanners"), "done");
  } finally {
    await f.close();
  }
});

/** A responsible task whose retained reviewer spent its checkpoint budget. */
function escalationFixture(
  askPlanner: (
    planner: string,
    input: { prompt: string },
  ) => Promise<string | null>,
) {
  const dir = mkdtempSync(join(tmpdir(), "ns-owner-retire-recovery-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  // Queue #912: the one registered host delegated questions route to.
  store.setMeta("hostId", "host");
  const states = new Map<string, AgentObservation>();
  const idle = (id: string, workspaceId = "workspace") =>
    states.set(id, {
      id,
      workspaceId,
      status: "idle",
      active: false,
      permissions: false,
      error: "",
    });
  idle("review-agent");
  const asks: Array<{ planner: string; prompt: string }> = [];
  const adapter = fakeAdapter({
    hostId: "host",
    profiles: async () => [reviewerProfile, coordinatorProfile],
    validate: async () => base,
    verifyWorkspace: async () => "branch",
    createWorkspace: async () => {
      throw new Error("No dispatch");
    },
    createAgent: async () => {
      throw new Error("No dispatch");
    },
    observe: async (id: string) => {
      const s = states.get(id);
      if (!s) throw new Error("Agent missing");
      return s;
    },
    createRun: async (t: Task, r: Run, token: string) => {
      states.set(`agent-${r.id}`, {
        id: `agent-${r.id}`,
        workspaceId: r.workspaceId,
        status: "running",
        active: true,
        permissions: false,
        error: "",
      });
      return { id: `agent-${r.id}`, workspaceId: r.workspaceId };
    },
    sendRun: async () => {},
    findRunAgents: async () => [],
    continueRun: async () => {},
    verifyReview: async () => {},
    mergeGate: async () => ({ head, base, wait: "" }),
    merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: "main" }),
    syncMain: async () => base,
    verifyCloseout: async () => {},
    notify: async () => {},
    verifyPr: async () => {
      throw new Error("No PR");
    },
    askPlanner: async (planner: string, input: { prompt: string }) => {
      asks.push({ planner, prompt: input.prompt });
      return answerFixturePrompt(
        engine.resolution,
        planner,
        input.prompt,
        await askPlanner(planner, input),
      );
    },
  } as unknown as Adapter & ResolutionAdapter);
  Object.assign(adapter, { supportsCoordinatorRecovery: true });
  const engine = new Engine(store, adapter, 0);
  engine.resolution.delegatedAnswerWaitMs = 1000;
  engine.profiles = [reviewerProfile, coordinatorProfile];
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Stuck review",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  store.update(submitted.id, {
    phase: "awaiting_review",
    planningBase: base,
    workspaceIntent: true,
    agentIntent: true,
    workspaceId: "workspace",
    directory: "/worktree",
    agentId: "reviewer",
    runId: "initial",
    profile: reviewerProfile,
    agentActive: false,
    lastAgentStatus: "idle",
    lastObservedAt: new Date().toISOString(),
  });
  const run: Run = {
    id: "review-run",
    taskId: submitted.id,
    role: "reviewer",
    generation: 1,
    head,
    base,
    workspaceId: "workspace",
    agentId: "review-agent",
    profile: reviewerProfile,
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: true,
    idleSince: null,
    completion: null,
    released: false,
    reviewCheckpoints: [
      {
        ordinal: 1,
        checkpoint: { covered: ["src/a.ts"], remaining: ["src/b.ts"] },
        head,
        at: new Date().toISOString(),
        runId: "review-run",
        path: "/worktree",
      },
    ],
    reviewBudgetExhaustedAt: new Date().toISOString(),
  };
  store.putRun(run);
  store.update(submitted.id, {
    resolution: {
      ...store.task(submitted.id).resolution,
      currentRunId: run.id,
      reviewerAgentId: "review-agent",
      reviewerProfile,
    },
  });
  // The escalation routes to the project's planner; the Queue planner stays unset here.
  store.upsertProject({
    key: "app",
    name: "App",
    repositories: [{ origin: null, path: "/repo" }],
  });
  store.setProjectPlanner({
    key: "app",
    agentId: "planner-thread",
    setBy: "test",
  });
  states.set("planner-thread", {
    id: "planner-thread",
    workspaceId: "planning",
    status: "idle",
    active: false,
    permissions: false,
    error: "",
  });
  return {
    dir,
    store,
    engine,
    asks,
    current: () => store.task(submitted.id),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a reviewer checkpoint-budget stop escalates once through the planner ladder, not to an owner", async () => {
  const f = escalationFixture(
    async () =>
      "Choice: Wait until a time (put an ISO timestamp in Reason)\nReason: 2099-01-01T00:00:00Z",
  );
  try {
    const before = f.current();
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    for (
      let wait = 0;
      wait < 50 &&
      !f.store
        .eventsAll(before.id)
        .some((event) => event.kind === "planner_escalation_answered");
      wait++
    )
      await new Promise((resolve) => setImmediate(resolve));
    const events = f.store.eventsAll(before.id);
    assert.ok(
      events.some((event) => event.kind === "planner_escalation"),
      "one planner escalation opens",
    );
    assert.ok(events.some((event) => event.kind === "planner_escalation_sent"));
    assert.ok(
      !events.some((event) => event.kind === "recovery_escalated"),
      "no recovery-coordinator owner escalation",
    );
    assert.equal(f.asks.length, 1, "the delegate was asked once");
    assert.match(f.asks[0]!.prompt, /spent its checkpoint budget and stopped/);
    assert.match(f.asks[0]!.prompt, /restart role=reviewer fresh/);
    assert.ok(
      events.some((event) => event.kind === "planner_escalation_answered"),
      "the answer settles the escalation",
    );
    // A repeated report on the same cause joins the open escalation instead of asking again.
    const asksAfter = f.asks.length;
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.equal(
      f.store
        .eventsAll(before.id)
        .filter((event) => event.kind === "planner_escalation").length,
      1,
      "never a second escalation for the same cause",
    );
    assert.equal(f.asks.length, asksAfter, "and never a second ask");
  } finally {
    await f.close();
  }
});

test("the ordinary operator verb still disposes of the escalated task", async () => {
  const f = escalationFixture(async () => null);
  try {
    await f.engine.resolution.recovery.route(f.current());
    await f.engine.quiesce();
    assert.ok(
      f.store
        .eventsAll(f.current().id)
        .some((event) => event.kind === "planner_escalation"),
    );
    // The planner lookup is asynchronous, so the escalated wait lands after quiesce.
    await waitFor(() => f.store.eventsAll(f.current().id).some((event) => event.kind === "planner_escalation_delegated"), ANSWERING_WINDOW_MS, "the planner escalation");
    // The operator's own verb overrides the ladder wait, as with any parked task.
    const moved = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: f.current().id,
        version: f.current().version,
        action: "move",
        to: "work",
        reason: "Operator disposes of the wait directly",
        caller: "operator (board)",
      }),
    );
    assert.equal(moved.phase, "changes_requested");
  } finally {
    await f.close();
  }
});
