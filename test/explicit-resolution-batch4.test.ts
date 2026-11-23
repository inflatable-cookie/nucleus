import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { Decisions } from "../core/planning/decisions";
import { closeTerminalEscalations } from "../core/questions/escalation-settlement";
import {
  PLANNER_ESCALATION_CHOICES,
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
  runSchema,
  submissionSchema,
  taskControlInputSchema,
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
    askPlanner: async () => null,
    findAnyOpenBranchPr: async () => [],
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
  options: { runId?: string | null; offered?: EscalationVerbChoice[] } = {},
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
    `${id}: ${JSON.stringify({ cause, runId: options.runId ?? null, question: "How should this stuck task proceed?" })}`,
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

test("#1491 shape: first plain-choice answer after PR/run changed installs the wait and target at the current task version", async () => {
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
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head changed after offer",
    );

    const targetIso = new Date(Date.now() + 3_600_000).toISOString();
    await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: "Wait until a time (put an ISO timestamp in Reason)",
        reason: targetIso,
      },
      PLANNER,
    );
    const events = fx.store.eventsAll(fx.taskId);
    assert.equal(
      plannerEscalations(events).find((e) => e.id === "esc-1491")?.answered,
      true,
    );
    const waitEvent = events.findLast(
      (e) =>
        e.kind === "planner_escalation_wait" &&
        e.detail.startsWith("esc-1491:"),
    );
    assert.ok(waitEvent, "planner_escalation_wait must be recorded");
    const wait = JSON.parse(waitEvent.detail.slice("esc-1491: ".length)) as {
      kind: string;
      target: string;
    };
    assert.equal(wait.kind, "time");
    assert.equal(wait.target, targetIso);
    assert.equal(fx.task().resolution.stop?.reason, "lifecycle");
  } finally {
    await fx.close();
  }
});

test("underlay#046 shape: real owner retry guard runs without 'no longer available' or binding-hash loop, and record.clear kind=escalation stays the manual close", async () => {
  const fx = makeFixture();
  try {
    const reviewerRunId = "run-rev-046";
    const deliveryId = `ns-review-${"c".repeat(64)}`;
    const at = new Date().toISOString();
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
            createdAt: at,
            status: "uncertain",
            evidence: "delivery timed out",
            observedAt: at,
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

    // Manual close via record.clear kind=escalation remains the explicit close on non-terminal tasks.
    const cleared = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "record.clear",
        kind: "escalation",
        id: "esc-046",
        accept: [],
        reason: "Manual escalation close",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(cleared.explicitResolution?.status, "applied");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-046",
      )?.answered,
      true,
    );
    assert.equal(fx.task().resolution.stop, null);
  } finally {
    await fx.close();
  }
});

test("terminal phase (owner complete and late answer on ended task) closes open escalations and linked decisions in one transaction and refuses late answers", async () => {
  const fx = makeFixture();
  try {
    const decisions = new Decisions(fx.store);
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: "run-complete-1",
        status: "finished",
        active: false,
        released: true,
        endedAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    const { questionId: qComplete } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-complete",
    );
    const dComplete = decisions.add({
      headline: "Escalation before owner complete",
      question: "How should esc-complete proceed?",
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
      `esc-complete: decision ${dComplete.id}`,
    );

    // Real owner complete closes the open escalation and withdraws its linked decision in one transaction.
    await fx.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: fx.taskId,
        version: fx.task().version,
        action: "complete",
        reason: "Operator completed task",
        caller: OPERATOR_BOARD_CALLER,
      }),
    );
    assert.equal(fx.task().phase, "done");
    assert.equal(fx.store.decision(dComplete.id).status, "withdrawn");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-complete",
      )?.answered,
      true,
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${qComplete}`)
        .some((e) => e.kind === "delegated_closed"),
      true,
    );

    // Late plain answer on a newly cancelled task closes escalation + linked decision in one transaction and refuses as closed.
    fx.store.update(
      fx.taskId,
      { phase: "working" },
      "reopen",
      "setup terminal late-answer check",
    );
    const { questionId: qLate } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-terminal",
    );
    const dTerminal = decisions.add({
      headline: "Terminal task decision",
      question: "How should esc-terminal proceed?",
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
      `esc-terminal: decision ${dTerminal.id}`,
    );
    fx.store.update(
      fx.taskId,
      { phase: "cancelled" },
      "task_cancelled",
      "task ended before late answer",
    );
    // The terminal transition itself closed the escalation and withdrew its linked decision in the same transaction.
    assert.equal(fx.store.decision(dTerminal.id).status, "withdrawn");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-terminal",
      )?.answered,
      true,
    );
    await assert.rejects(
      async () =>
        await fx.engine.resolution.answerDelegatedQuestion(
          {
            questionId: qLate,
            choice: "Stop and keep the work",
            reason: "Late plain answer on ended task",
          },
          PLANNER,
        ),
      /closed|already settled/i,
    );
    assert.deepEqual(closeTerminalEscalations(fx.store, fx.task()), []);
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

test("round 10: pending merge intent does not close open escalations or linked decisions, and a decision-write error rolls back terminal completion", async () => {
  const fx = makeFixture();
  try {
    const decisions = new Decisions(fx.store);
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: "run-r10-1",
        status: "finished",
        active: false,
        released: true,
        endedAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-merge-intent");
    const linked = decisions.add({
      headline: "Escalation with pending merge intent",
      question: "How should esc-merge-intent proceed?",
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
      `esc-merge-intent: decision ${linked.id}`,
    );

    // Pending merge intent is not a terminal phase: maintenance must leave escalation and decision open.
    fx.store.update(
      fx.taskId,
      {
        phase: "merging",
        resolution: {
          ...fx.task().resolution,
          mergeIntent: true,
        },
      },
      "merge_intent",
      "pending merge",
    );
    assert.deepEqual(closeTerminalEscalations(fx.store, fx.task()), []);
    fx.engine.resolution.ladder.reconcileLegacyPlaceholderDecisions(fx.task());
    await fx.engine.resolution.ladder.resumeEscalationWaits(fx.task());
    assert.equal(fx.store.decision(linked.id).status, "open");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-merge-intent",
      )?.answered,
      false,
    );

    // Move back to parked state and inject a SQLite decision-write failure: owner complete must roll back atomically.
    fx.store.update(
      fx.taskId,
      {
        phase: "blocked",
        resolution: { ...fx.task().resolution, mergeIntent: false },
      },
      "blocked",
      "parked before complete",
    );
    fx.store.db.exec(`
      CREATE TRIGGER fail_decision_update BEFORE UPDATE ON decisions
      BEGIN
        SELECT RAISE(ABORT, 'simulated decision write failure');
      END;
    `);
    await assert.rejects(
      async () =>
        await fx.engine.performTaskControl(
          taskControlInputSchema.parse({
            taskId: fx.taskId,
            version: fx.task().version,
            action: "complete",
            reason: "Operator complete during decision fault",
            caller: OPERATOR_BOARD_CALLER,
          }),
        ),
      /simulated decision write failure/,
    );
    assert.equal(fx.task().phase, "blocked");
    assert.equal(fx.store.decision(linked.id).status, "open");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-merge-intent",
      )?.answered,
      false,
    );

    // Once the fault clears, owner complete succeeds and closes both atomically.
    fx.store.db.exec("DROP TRIGGER fail_decision_update;");
    await fx.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: fx.taskId,
        version: fx.task().version,
        action: "complete",
        reason: "Operator complete after fault cleared",
        caller: OPERATOR_BOARD_CALLER,
      }),
    );
    assert.equal(fx.task().phase, "done");
    assert.equal(fx.store.decision(linked.id).status, "withdrawn");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-merge-intent",
      )?.answered,
      true,
    );
  } finally {
    await fx.close();
  }
});

test("round 10: fresh escalations offer plain choices only (no route, restart, move or retry_effect options)", async () => {
  const fx = makeFixture();
  try {
    const runId = "run-plain-only";
    const deliveryId = `ns-review-${"d".repeat(64)}`;
    const at = new Date().toISOString();
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: runId,
        role: "reviewer",
        agentId: "agent-plain-only",
        workspaceId: "ws-plain-only",
        active: false,
        reviewDeliveries: [
          {
            authorizationId: randomUUID(),
            operationId: randomUUID(),
            deliveryId,
            taskId: fx.taskId,
            runId,
            head: HEAD_A,
            checkpointOrdinal: 1,
            taskVersion: fx.task().version,
            briefVersion: 1,
            briefDigest: null,
            reason: "Review head A",
            instruction: "Review head A",
            createdAt: at,
            status: "uncertain",
            evidence: "delivery timed out",
            observedAt: at,
          },
        ],
      }),
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "reviewing",
        prHead: HEAD_A,
        resolution: { ...fx.task().resolution, currentRunId: runId },
      },
      "review_started",
      "uncertain reviewer delivery",
    );
    // Confirm the task actually has executable owner verbs available via next/ownerVerbViews.
    const availableVerbs = escalationVerbChoices(
      ownerVerbViews(collectOwnerVerbFacts(fx.store, fx.task())),
    );
    assert.ok(
      availableVerbs.length > 0,
      "fixture must have at least one available owner verb",
    );

    const escId = "esc-plain-only";
    fx.store.event(
      fx.taskId,
      "planner_escalation",
      `${escId}: cause worker_error; run ${runId}; question q; options ${PLANNER_ESCALATION_CHOICES.join(" | ")}`,
    );
    fx.store.event(
      fx.taskId,
      "planner_escalation_question",
      `${escId}: Worker stopped; choose how it proceeds.`,
    );
    fx.store.event(
      fx.taskId,
      "planner_escalation_payload",
      `${escId}: ${JSON.stringify({ id: escId, runId })}`,
    );

    const routing = fx.engine.resolution.ladder.routePlannerEscalation(
      fx.task(),
      escId,
      "Worker stopped; choose how it proceeds.",
    );
    let askedRow: { taskId: string; detail: string } | undefined;
    for (let i = 0; i < 40 && !askedRow; i++) {
      askedRow = fx.store.db
        .prepare(
          "SELECT taskId, detail FROM events WHERE kind='delegated_delivery' AND taskId LIKE ? ORDER BY id DESC LIMIT 1",
        )
        .get(`delegation:%${escId}%`) as
        | { taskId: string; detail: string }
        | undefined;
      if (!askedRow) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const offeredEvent = fx.store
      .eventsAll(fx.taskId)
      .find(
        (e) =>
          e.kind === "planner_escalation_offered" &&
          e.detail.startsWith(`${escId}: `),
      );
    assert.ok(offeredEvent, "planner_escalation_offered must be recorded");
    assert.deepEqual(
      JSON.parse(offeredEvent.detail.slice(escId.length + 2)),
      [],
      "fresh escalation must not offer executable owner-verb options",
    );
    assert.ok(askedRow, "delegated question must be opened");
    const asked = JSON.parse(askedRow.detail) as { choices?: string[] };
    assert.deepEqual(asked.choices, [...PLANNER_ESCALATION_CHOICES]);

    await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId: askedRow.taskId.slice("delegation:".length),
        choice: "Wait until a time (put an ISO timestamp in Reason)",
        reason: new Date(Date.now() + 3_600_000).toISOString(),
      },
      PLANNER,
    );
    await routing;
  } finally {
    await fx.close();
  }
});

test("round 11: a merge reserved during a live planner question timeout leaves the escalation open", async () => {
  const fx = makeFixture();
  try {
    fx.engine.resolution.delegatedAnswerWaitMs = 150;
    const escId = "esc-merge-timeout";
    fx.store.event(
      fx.taskId,
      "planner_escalation",
      `${escId}: cause worker_error; run worker; question q; options ${PLANNER_ESCALATION_CHOICES.join(" | ")}`,
    );
    fx.store.event(
      fx.taskId,
      "planner_escalation_question",
      `${escId}: Worker stopped; choose how it proceeds.`,
    );
    fx.store.event(
      fx.taskId,
      "planner_escalation_payload",
      `${escId}: ${JSON.stringify({ id: escId, runId: null })}`,
    );
    const decisions = new Decisions(fx.store);
    const linked = decisions.add({
      headline: "Live question during pending merge",
      question: "How should esc-merge-timeout proceed?",
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
      `${escId}: decision ${linked.id}`,
    );

    // Start routing first, wait for the planner question's durable delivery, then
    // reserve the merge while that delegated answer window is live.
    const routing = fx.engine.resolution.ladder.routePlannerEscalation(
      fx.task(),
      escId,
      "Worker stopped; choose how it proceeds.",
    );
    let askedRow: { taskId: string; detail: string } | undefined;
    for (let i = 0; i < 60 && !askedRow; i++) {
      askedRow = fx.store.db
        .prepare(
          "SELECT taskId, detail FROM events WHERE kind='delegated_delivery' AND taskId LIKE ? ORDER BY id DESC LIMIT 1",
        )
        .get(`delegation:%${escId}%`) as
        | { taskId: string; detail: string }
        | undefined;
      if (!askedRow) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      askedRow,
      "delegated planner question must be delivered before reserving the merge",
    );
    assert.equal(
      fx.store
        .eventsAll(askedRow.taskId)
        .some((e) => e.kind === "delegated_closed"),
      false,
      "delegated planner question window must still be live when the merge is reserved",
    );

    fx.store.update(
      fx.taskId,
      {
        phase: "merging",
        resolution: { ...fx.task().resolution, mergeIntent: true },
      },
      "merge_intent",
      "merge reserved during live planner question",
    );
    await routing;

    assert.equal(fx.task().phase, "merging");
    assert.equal(fx.task().resolution.mergeIntent, true);
    const events = fx.store.eventsAll(fx.taskId);
    assert.equal(
      plannerEscalations(events).find((e) => e.id === escId)?.answered,
      false,
      "planner timeout during pending merge must not close the escalation",
    );
    assert.equal(
      events.some(
        (e) =>
          e.kind === "planner_escalation_answered" &&
          e.detail.startsWith(`${escId}:`),
      ),
      false,
    );
    assert.equal(
      events.some(
        (e) =>
          e.kind === "planner_escalation_missed" &&
          e.detail.startsWith(`${escId}:`) &&
          e.detail.includes("no answer in time"),
      ),
      true,
      "live planner window must expire with a timeout miss",
    );
    assert.equal(
      events.some(
        (e) =>
          e.kind === "planner_escalation_missed" &&
          e.detail ===
            `${escId}: no delegated answer was produced; the escalation stays open for the planner`,
      ),
      true,
    );
    assert.equal(fx.store.decision(linked.id).status, "open");
  } finally {
    await fx.close();
  }
});

test("round 11: interrupted planner-receipt recovery during a pending merge leaves the escalation open", async () => {
  const fx = makeFixture();
  try {
    const reviewerRunId = "run-rev-receipt-merge";
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: reviewerRunId,
        role: "reviewer",
        agentId: "agent-rev-receipt-merge",
        workspaceId: "ws-rev-receipt-merge",
        status: "running",
        active: true,
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
      "active retained reviewer",
    );
    const escId = "esc-receipt-merge";
    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      escId,
      { runId: reviewerRunId },
    );
    const answerText = "Keep reviewing head A and report findings";
    const reasonText =
      "Active retained reviewer should continue with this direction";
    const delegationKey = `delegation:${questionId}`;
    fx.store.event(
      delegationKey,
      "delegated_answer",
      JSON.stringify({
        questionId,
        caller: PLANNER,
        answer: answerText,
        reason: reasonText,
      }),
    );
    // Direction to an active retained reviewer journals control: null before delivery.
    fx.store.event(
      fx.taskId,
      "planner_escalation_answer_pending",
      `${escId}: ${JSON.stringify({
        questionId,
        who: `planner ${PLANNER}`,
        answer: `${answerText} — ${reasonText}`,
        control: null,
      })}`,
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "merging",
        resolution: { ...fx.task().resolution, mergeIntent: true },
      },
      "merge_intent",
      "pending merge during interrupted receipt recovery",
    );

    await assert.rejects(
      async () =>
        await fx.engine.resolution.answerDelegatedQuestion(
          {
            questionId,
            answer: answerText,
            reason: reasonText,
          },
          PLANNER,
        ),
      /outcome is unknown|did not replay/i,
    );

    assert.equal(fx.task().phase, "merging");
    assert.equal(fx.task().resolution.mergeIntent, true);
    const events = fx.store.eventsAll(fx.taskId);
    assert.equal(
      plannerEscalations(events).find((e) => e.id === escId)?.answered,
      false,
    );
    assert.equal(
      events.some(
        (e) =>
          e.kind === "planner_escalation_answered" &&
          e.detail.startsWith(`${escId}:`),
      ),
      false,
    );
    assert.equal(
      events.some(
        (e) =>
          e.kind === "planner_escalation_applied" &&
          e.detail.startsWith(`${escId}:`),
      ),
      false,
    );
    const delegationEvents = fx.store.eventsAll(delegationKey);
    assert.equal(
      delegationEvents.some((e) => e.kind === "delegated_command_applied"),
      false,
    );
    assert.equal(
      delegationEvents.some((e) => e.kind === "delegated_command_refused"),
      true,
    );
  } finally {
    await fx.close();
  }
});
