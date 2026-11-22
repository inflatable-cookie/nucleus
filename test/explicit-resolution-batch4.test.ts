import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error untyped ESM helper module
import { stampInput } from "../bin/cli-stamping.mjs";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { Decisions } from "../core/planning/decisions";
import { closeClearedEscalations } from "../core/questions/escalation-settlement";
import {
  escalationVerbChoices,
  plannerEscalations,
  type EscalationVerbChoice,
} from "../core/questions/ladder";
import { Store } from "../core/store/store";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import {
  collectOwnerVerbFacts,
  ownerVerbViews,
  parkedRestart,
} from "../core/verbs/owner-verbs";
import {
  OPERATOR_BOARD_CALLER,
  questionAnswerInputSchema,
  runSchema,
  submissionSchema,
} from "../shared/contracts";
import { observeIdle } from "./support/fakes";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "1".repeat(40);
const PLANNER = "planner-live";
const REPO = "/repo/explicit-batch4";

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-explicit-batch4-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("hostRegistry", [
    { id: "host-1", kind: "paseo", label: "Host" },
  ]);
  store.upsertProject({
    key: "explicit-batch4",
    name: "Explicit Batch 4",
    repositories: [
      { origin: "https://github.com/example/explicit-batch4.git", path: REPO },
    ],
  });
  store.setProjectPlanner({
    key: "explicit-batch4",
    agentId: PLANNER,
    setBy: "operator",
  });
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Batch 4 escalation task",
      repoPath: REPO,
      planningCommit: BASE,
      handoffPath: "handoff.md",
      originAgentId: PLANNER,
      responsible: true,
    }),
    "host-1",
    "handoff",
    BASE,
  );
  const adapter = {
    hostId: "host-1",
    profiles: async () => [],
    listLiveAgents: async () => [
      { id: PLANNER, title: "Planner", directory: REPO, workspaceId: null },
    ],
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: false,
    }),
    observe: async (agentId: string) =>
      agentId === PLANNER
        ? {
            id: PLANNER,
            status: "idle",
            active: false,
            workspaceId: "ws-planner",
            cwd: REPO,
          }
        : (await observeIdle(null)(agentId))!,
    stopAgentTurn: async () => {},
    archiveAgent: async () => {},
    createRun: async () => {
      throw new Error("Unexpected createRun");
    },
    sendRun: async () => {},
    notify: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const taskId = inserted.id;
  return {
    store,
    engine,
    taskId,
    task: () => store.task(taskId),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeRun(
  taskId: string,
  overrides: Record<string, unknown> & { id: string },
) {
  const at = new Date(Date.now() - 5_000).toISOString();
  return runSchema.parse({
    taskId,
    role: "revision",
    attempt: 1,
    generation: 1,
    agentId: `agent-${overrides.id}`,
    hostId: "host-1",
    workspaceId: "ws-worker",
    head: HEAD_A,
    base: BASE,
    profile: {
      id: "p-1",
      name: "P",
      provider: "codex",
      model: "gpt-5",
      notes: "",
      available: true,
      problem: "",
      supportedThinking: [],
    },
    status: "running",
    active: true,
    released: false,
    createdAt: at,
    lastObservedAt: at,
    idleSince: null,
    completion: null,
    ...overrides,
  });
}

function recordOpenEscalation(
  store: Store,
  engine: Engine,
  taskId: string,
  id: string,
  options: {
    runId?: string | null;
    payload?: Record<string, unknown>;
    offered?: EscalationVerbChoice[];
  } = {},
) {
  const cause = "e".repeat(64);
  store.event(
    taskId,
    "planner_escalation",
    `${id}: cause ${cause}; run ${options.runId ?? "worker"}; question pending`,
  );
  store.event(
    taskId,
    "planner_escalation_payload",
    `${id}: ${JSON.stringify({ cause, runId: options.runId ?? null, question: "How should this stuck task proceed?", ...(options.payload ?? {}) })}`,
  );
  engine.resolution.waiting(
    store.task(taskId),
    `Waiting with the planner: blocker escalation ${id} is open`,
    "escalated",
    {
      fact: { code: "escalation", subject: id },
    },
  );
  const offered = options.offered ?? [];
  store.event(
    taskId,
    "planner_escalation_offered",
    `${id}: ${JSON.stringify(offered)}`,
  );
  const questionId = `ns-escalation-${id}`;
  const choices = [
    "Stop and keep the work",
    "Wait until a time (put an ISO timestamp in Reason)",
    ...offered.map((o) => o.label),
  ];
  engine.resolution.openDelegatedQuestion(
    store.task(taskId),
    questionId,
    PLANNER,
    `Choose how to continue\n${choices.map((c) => `- ${c}`).join("\n")}`,
    60_000,
    "planner",
    "host-1",
  );
  return { questionId };
}

test("question.answer schema and CLI run-ticket transport forward task version", async () => {
  const parsed = questionAnswerInputSchema.parse({
    questionId: "ns-escalation-esc-1",
    caller: PLANNER,
    choice: "Stop and keep the work",
    version: 7,
    reason: "Park at current version",
  });
  assert.equal(parsed.version, 7);
  const forwarded: Record<string, unknown>[] = [];
  await stampInput({
    method: "question.answer",
    input: {
      questionId: "ns-escalation-esc-1",
      choice: "Stop and keep the work",
      version: 7,
      reason: "Park",
    },
    context: {
      callerSource: () => ({ source: "ticket" }),
      readTicket: () => ({ taskId: "task-1", runId: "run-planner" }),
      credentialFor: () => "cred",
      answerThroughTicket: async (
        _ticket: unknown,
        payload: Record<string, unknown>,
      ) => {
        forwarded.push(payload);
        return { ok: true };
      },
    },
  });
  assert.equal(forwarded[0]?.version, 7);
});

test("#1491 shape: plain-choice answer binds to task version after PR/run changes and refuses stale version without bumping task version", async () => {
  const fx = makeFixture();
  try {
    const runId = "run-worker-1491";
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: runId,
        agentId: "agent-worker-1491",
        active: false,
      }),
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "working",
        runId,
        agentId: "agent-worker-1491",
        prHead: HEAD_A,
        resolution: { ...fx.task().resolution, currentRunId: runId },
      },
      "worker_started",
      "worker run",
    );
    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-1491",
      { runId },
    );
    const staleVersion = fx.task().version;
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head changed after offer",
    );
    const currentVersion = fx.task().version;

    await assert.rejects(
      async () =>
        await fx.engine.resolution.answerDelegatedQuestion(
          {
            questionId,
            choice: "Wait until a time (put an ISO timestamp in Reason)",
            version: staleVersion,
            reason: new Date(Date.now() + 3_600_000).toISOString(),
          },
          PLANNER,
        ),
      new RegExp(`Task is now at version ${currentVersion}`),
    );
    assert.equal(
      fx.task().version,
      currentVersion,
      "stale refusal must not bump task version",
    );

    await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: "Wait until a time (put an ISO timestamp in Reason)",
        version: currentVersion,
        reason: new Date(Date.now() + 3_600_000).toISOString(),
      },
      PLANNER,
    );
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-1491",
      )?.answered,
      true,
    );
  } finally {
    await fx.close();
  }
});

test("underlay#046 shape: real owner retry guard runs without 'no longer available' loop, and exact effect clearance never closes an unrelated worker blocker", async () => {
  const fx = makeFixture();
  try {
    const reviewerRunId = "run-rev-046";
    const deliveryId = `ns-review-${"c".repeat(64)}`;
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: reviewerRunId,
        role: "reviewer",
        agentId: "agent-rev-046",
        workspaceId: "ws-rev",
        active: false,
        reviewDeliveries: [
          {
            authorizationId: randomUUID(),
            operationId: randomUUID(),
            deliveryId,
            taskId: fx.taskId,
            runId: reviewerRunId,
            head: HEAD_A,
            checkpointOrdinal: 1,
            taskVersion: fx.task().version,
            briefVersion: 1,
            briefDigest: null,
            reason: "Review head A",
            instruction: "Review head A",
            createdAt: new Date().toISOString(),
            status: "uncertain",
            evidence: "delivery timed out",
            observedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "reviewing",
        prHead: HEAD_A,
        resolution: { ...fx.task().resolution, currentRunId: reviewerRunId },
      },
      "review_started",
      "uncertain reviewer delivery",
    );
    const offered = escalationVerbChoices(
      ownerVerbViews(collectOwnerVerbFacts(fx.store, fx.task())),
    );
    const retryOffer = offered.find((item) => item.verb === "retry_effect");
    assert.ok(retryOffer);
    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-046",
      { runId: reviewerRunId, offered },
    );
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head moved",
    );
    try {
      await fx.engine.resolution.answerDelegatedQuestion(
        {
          questionId,
          choice: retryOffer.label,
          version: fx.task().version,
          reason: "Retry uncertain delivery",
        },
        PLANNER,
      );
    } catch (error) {
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /is no longer available|binding/i,
      );
    }

    // Add an unrelated uncertain reviewer launch run; clearing it must NOT close an open worker blocker.
    const workerRunId = "run-worker-blocker";
    const launchRunId = "run-unrelated-launch";
    fx.store.putRun(
      makeRun(fx.taskId, { id: workerRunId, role: "revision", attempt: 2 }),
    );
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: launchRunId,
        role: "reviewer",
        attempt: 3,
        status: "uncertain",
        active: false,
      }),
    );
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-worker-open", {
      runId: workerRunId,
    });
    const clearedLaunch = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "record.clear",
        kind: "effect",
        id: `run-delivery.${launchRunId}`,
        accept: ["effect_may_land"],
        reason: "Clear unrelated reviewer launch effect",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(clearedLaunch.explicitResolution?.status, "applied");
    await fx.engine.resolution.ladder.resumeEscalationWaits(fx.task());
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-worker-open",
      )?.answered,
      false,
      "clearing an unrelated reviewer launch effect must not close an open worker blocker",
    );

    // Clearing esc-046's own review-delivery effect closes esc-046 without closing esc-worker-open.
    const clearedDelivery = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "record.clear",
        kind: "effect",
        id: `review-delivery.${deliveryId}`,
        accept: ["effect_may_land"],
        reason: "Clear esc-046 delivery effect",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(clearedDelivery.explicitResolution?.status, "applied");
    assert.deepEqual(closeClearedEscalations(fx.store, fx.task()), ["esc-046"]);
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-worker-open",
      )?.answered,
      false,
    );
  } finally {
    await fx.close();
  }
});

test("simulated roll between run.release commit and auto-close: maintenance retires stop, wait, decision and initial question window atomically", async () => {
  const fx = makeFixture();
  try {
    const runId = "run-worker-roll";
    fx.store.putRun(
      makeRun(fx.taskId, { id: runId, agentId: "agent-worker-roll" }),
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "working",
        runId,
        agentId: "agent-worker-roll",
        resolution: { ...fx.task().resolution, currentRunId: runId },
      },
      "worker_started",
      "live run before roll",
    );
    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-roll",
      { runId },
    );
    const decisions = new Decisions(fx.store);
    const decision = decisions.add({
      headline: "Escalation operator decision",
      question: "How should esc-roll proceed?",
      choices: [
        { label: "Stop and keep the work", consequence: "Parks task" },
        {
          label: "Return to the worker with a new approach",
          consequence: "Continues worker",
        },
      ],
      askedBy: PLANNER,
      tasks: [fx.taskId],
    });
    fx.store.event(
      fx.taskId,
      "planner_escalation_decision_linked",
      `esc-roll: decision ${decision.id}`,
    );
    fx.store.event(
      fx.taskId,
      "planner_escalation_wait",
      `esc-roll: ${JSON.stringify({ kind: "time", target: new Date(Date.now() + 3_600_000).toISOString() })}`,
    );

    const resolved = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "run.release",
        run: runId,
        accept: ["live_turn", "unreported_result"],
        reason: "Release run before simulated roll",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(resolved.explicitResolution?.status, "applied");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-roll",
      )?.answered,
      false,
    );

    await fx.engine.resolution.ladder.resumeEscalationWaits(fx.task());
    const afterEvents = fx.store.eventsAll(fx.taskId);
    assert.equal(
      plannerEscalations(afterEvents).find((e) => e.id === "esc-roll")
        ?.answered,
      true,
    );
    assert.equal(fx.task().resolution.stop, null);
    assert.equal(fx.store.decision(decision.id).status, "withdrawn");
    assert.equal(
      afterEvents.some((e) => e.kind === "planner_escalation_wait_superseded"),
      true,
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${questionId}`)
        .some((e) => e.kind === "delegated_closed"),
      true,
    );
    assert.throws(
      () => fx.engine.resolution.delegatedQuestionForTask(fx.taskId, PLANNER),
      /no open|not found|question/i,
    );
    assert.equal(
      afterEvents.filter((e) => e.kind === "owner_resolution").length,
      1,
    );

    // Unreviewed external merge is NOT closed by an uncertain reviewer launch.
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-ext-merge", {
      payload: { commit: HEAD_B, head: HEAD_B },
    });
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: "run-uncertain-launch",
        role: "reviewer",
        attempt: 2,
        status: "uncertain",
        active: false,
        createdAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
    fx.store.update(
      fx.taskId,
      {
        resolution: {
          ...fx.task().resolution,
          currentRunId: "run-uncertain-launch",
        },
      },
      "uncertain_launch",
      "uncertain reviewer launch",
    );
    assert.deepEqual(closeClearedEscalations(fx.store, fx.task()), []);
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-ext-merge",
      )?.answered,
      false,
    );
  } finally {
    await fx.close();
  }
});

test("deleted restart-as-escalation-answer path: parkedRestart never returns answer", () => {
  const fx = makeFixture();
  try {
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-no-restart");
    const parked = parkedRestart(collectOwnerVerbFacts(fx.store, fx.task()));
    assert.ok(!parked || !("answer" in parked));
  } finally {
    fx.close();
  }
});
