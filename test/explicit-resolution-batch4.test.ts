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
import {
  closeClearedEscalations,
  escalationExplicitCommandChoices,
} from "../core/questions/escalation-settlement";
import {
  escalationVerbChoices,
  plannerEscalations,
  type EscalationVerbChoice,
  type LadderEvent,
} from "../core/questions/ladder";
import { RuntimeQuestions } from "../core/runtime/questions";
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
  questionAnswerRequestSchema,
  runSchema,
  submissionSchema,
} from "../shared/contracts";
import { decisionAnswer } from "../shared/rpc/decisions";
import { observeIdle } from "./support/fakes";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "1".repeat(40);
const PLANNER = "planner-live";
const REPO = "/repo/explicit-batch4";

function makeFixture(options: { stopTurnError?: string } = {}) {
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
    stopAgentTurn: async () => {
      if (options.stopTurnError) throw Error(options.stopTurnError);
    },
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
  const offered =
    options.offered ??
    escalationExplicitCommandChoices(
      store,
      store.task(taskId),
      id,
      store.eventsAll(taskId) as LadderEvent[],
    );
  store.event(
    taskId,
    "planner_escalation_offered",
    `${id}: ${JSON.stringify(offered)}`,
  );
  engine.resolution.waiting(
    store.task(taskId),
    `Waiting with the planner: blocker escalation ${id} is open`,
    "escalated",
    {
      fact: { code: "escalation", subject: id },
    },
  );
  const questionId = `ns-escalation-${id}`;
  const choices = [
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
  return { questionId, offered };
}

test("question.answer schemas and run-ticket CLI transport carry explicit command + version", async () => {
  const valid = questionAnswerInputSchema.parse({
    questionId: "ns-escalation-esc-1",
    caller: PLANNER,
    version: 7,
    command: { action: "run.release", run: "run-1", accept: ["live_turn"] },
    reason: "Release stuck run",
  });
  assert.equal(valid.version, 7);
  assert.deepEqual(valid.command?.accept, ["live_turn"]);
  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-esc-1",
        caller: PLANNER,
        command: { action: "run.release", run: "run-1" },
        reason: "Missing version",
      }),
    /requires a task version/,
  );
  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-esc-1",
        caller: PLANNER,
        version: 7,
        command: { action: "run.release", run: "run-1", version: 8 },
        reason: "Mismatched versions",
      }),
    /must match/,
  );
  assert.equal(
    questionAnswerRequestSchema.parse({
      questionId: "ns-escalation-esc-1",
      caller: PLANNER,
      version: 7,
      command: { action: "record.clear", kind: "escalation", id: "esc-1" },
      reason: "Clear resolved escalation",
    }).version,
    7,
  );
  const forwarded: Record<string, unknown>[] = [];
  await stampInput({
    method: "question.answer",
    input: {
      questionId: "ns-escalation-esc-1",
      version: 7,
      command: { action: "run.release", run: "run-1", accept: ["live_turn"] },
      reason: "Release via run ticket",
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
  assert.deepEqual(forwarded[0]?.command, {
    action: "run.release",
    run: "run-1",
    accept: ["live_turn"],
  });
});

test("#1491 shape: escalation lists explicit commands, choosing one runs ordinary RPC without answer markers, closes initial question window, and preserves host diagnostics", async () => {
  const fx = makeFixture({ stopTurnError: "host stop timed out" });
  try {
    const runId = "run-worker-1491";
    const run = makeRun(fx.taskId, { id: runId, agentId: "agent-worker-1491" });
    fx.store.putRun(run);
    fx.store.update(
      fx.taskId,
      {
        phase: "working",
        runId,
        agentId: run.agentId,
        resumePrNumber: 42,
        prUrl: "https://github.com/example/explicit-batch4/pull/42",
        prHead: HEAD_A,
        resolution: { ...fx.task().resolution, currentRunId: runId },
      },
      "worker_started",
      "live worker run",
    );
    const { questionId, offered } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-1491",
      { runId },
    );
    const releaseOption = offered.find(
      (item) => item.command?.action === "run.release",
    );
    assert.ok(
      releaseOption &&
        releaseOption.command?.action === "run.release" &&
        releaseOption.command.run === runId,
    );

    const staleVersion = fx.task().version;
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head changed after offer",
    );
    const currentVersion = fx.task().version;

    const staleReply = (await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: releaseOption.label,
        version: staleVersion,
        reason: "Stale release",
      },
      PLANNER,
    )) as { status?: string; version?: number };
    assert.equal(staleReply.status, "stale");
    assert.equal(staleReply.version, currentVersion);

    const warnedReply = (await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: releaseOption.label,
        version: currentVersion,
        reason: "Unaccepted release",
      },
      PLANNER,
    )) as {
      status?: string;
      explicitResolution?: { warnings: { id: string }[] };
    };
    assert.equal(warnedReply.status, "warnings");
    assert.ok(
      warnedReply.explicitResolution?.warnings.some(
        (w) => w.id === "live_turn",
      ),
    );

    await assert.rejects(
      async () =>
        await fx.engine.resolution.answerDelegatedQuestion(
          {
            questionId,
            version: currentVersion,
            command: {
              action: "merge.now",
              head: HEAD_B,
              accept: ["live_turn", "unreported_result"],
            },
            reason: "Attempt unreviewed merge",
          },
          PLANNER,
        ),
      /review|verdict|approved/i,
    );

    const appliedReply = (await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion,
        command: {
          action: "run.release",
          run: runId,
          accept: ["live_turn", "unreported_result"],
        },
        reason: "Accept warnings and release",
      },
      PLANNER,
    )) as { status?: string; explicitResolution?: { next: string } };
    assert.equal(appliedReply.status, "applied");
    assert.equal(fx.store.run(runId)?.released, true);
    assert.equal(fx.task().resolution.stop, null);
    assert.match(
      appliedReply.explicitResolution?.next ?? "",
      /Turn cancellation could not be confirmed/,
    );
    assert.doesNotMatch(
      appliedReply.explicitResolution?.next ?? "",
      /escalated stop/,
    );
    const taskEvents = fx.store.eventsAll(fx.taskId);
    assert.equal(
      taskEvents.some((e) => e.kind === "planner_escalation_resolved"),
      true,
    );
    assert.equal(
      taskEvents.some((e) => e.kind === "planner_escalation_answered"),
      false,
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${questionId}`)
        .some((e) => e.kind === "delegated_answer"),
      false,
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
  } finally {
    await fx.close();
  }
});

test("underlay#046 shape: real owner guard runs without 'no longer available' loop, and clearing the exact uncertain delivery closes its escalation even when an unrelated pending effect remains", async () => {
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
      {
        runId: reviewerRunId,
        offered,
      },
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
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /is no longer available|binding/i);
    }
    // Add an unrelated pending delivery effect on another run so ownerPendingEffects remains non-empty.
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: "run-unrelated-effect",
        role: "reviewer",
        attempt: 2,
        active: false,
        reviewDeliveries: [
          {
            authorizationId: randomUUID(),
            operationId: randomUUID(),
            deliveryId: `ns-review-${"d".repeat(64)}`,
            taskId: fx.taskId,
            runId: "run-unrelated-effect",
            head: HEAD_B,
            checkpointOrdinal: 1,
            taskVersion: fx.task().version,
            briefVersion: 1,
            briefDigest: null,
            reason: "Unrelated delivery",
            instruction: "Unrelated delivery",
            createdAt: new Date().toISOString(),
            status: "uncertain",
            evidence: "unrelated timeout",
            observedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const cleared = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "record.clear",
        kind: "effect",
        id: `review-delivery.${deliveryId}`,
        accept: ["effect_may_land"],
        reason: "Clear exact uncertain reviewer delivery",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(cleared.explicitResolution?.status, "applied");
    assert.deepEqual(closeClearedEscalations(fx.store, fx.task()), ["esc-046"]);
    assert.equal(fx.task().resolution.stop, null);
  } finally {
    await fx.close();
  }
});

test("board/inbox command dispatch enforces caller/relay checks and schema, and simulated roll closes escalation via maintenance without resending", async () => {
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
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-roll", { runId });
    const decisions = new Decisions(fx.store);
    const decision = decisions.add({
      headline: "Escalation operator decision",
      question: "How should esc-roll proceed?",
      choices: [
        {
          label: `Explicit command: run.release run=${runId}`,
          consequence: "Releases the run",
        },
        {
          label: "Explicit command: record.clear kind=escalation id=esc-roll",
          consequence: "Clears escalation",
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
    const runtimeQuestions = new RuntimeQuestions({
      store: fx.store,
      engine: fx.engine,
      decisions,
      markStoreAccess: () => {},
    });
    // Caller/relay checks are enforced before dispatching.
    assert.throws(
      () =>
        runtimeQuestions.answerDecision({
          id: decision.id,
          version: decision.version,
          answer: `Explicit command: run.release run=${runId}`,
          answeredBy: "operator (t3code:host-1)",
          relayed: false,
          note: "unauthenticated t3 identity",
        }),
      /authenticated T3 session/,
    );
    assert.throws(
      () =>
        runtimeQuestions.answerDecision({
          id: decision.id,
          version: decision.version,
          answer: `Explicit command: run.release run=${runId}`,
          answeredBy: PLANNER,
          relayed: false,
          note: "non-operator without relay",
        }),
      /Only the operator answers without a relay/,
    );
    // Board/inbox warning-bearing command rejects with warning IDs and keeps decision open (no decision persistence).
    await assert.rejects(
      async () =>
        await runtimeQuestions.answerDecision({
          id: decision.id,
          version: decision.version,
          answer: `Explicit command: run.release run=${runId}`,
          answeredBy: OPERATOR_BOARD_CALLER,
          relayed: false,
          note: "Board operator chose run.release",
        }),
      /live_turn/,
    );
    assert.equal(fx.store.decision(decision.id).status, "open");
    assert.equal(
      fx.store
        .eventsAll(fx.taskId)
        .some((e) => e.kind === "planner_escalation_answered"),
      false,
    );

    // Simulated roll: commit run.release directly, then maintenance closes escalation atomically without resending.
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
      afterEvents.filter((e) => e.kind === "owner_resolution").length,
      1,
    );

    // Board warning-free command returns a strict DecisionView accepted by the real decisionAnswer RPC schema.
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-board-clear");
    const d2 = decisions.add({
      headline: "Clear escalation",
      question: "Clear esc-board-clear?",
      choices: [
        {
          label:
            "Explicit command: record.clear kind=escalation id=esc-board-clear",
          consequence: "Clears escalation",
        },
        { label: "Stop and keep the work", consequence: "Stops task" },
      ],
      askedBy: PLANNER,
      tasks: [fx.taskId],
    });
    fx.store.event(
      fx.taskId,
      "planner_escalation_decision_linked",
      `esc-board-clear: decision ${d2.id}`,
    );
    const boardApplied = await runtimeQuestions.answerDecision({
      id: d2.id,
      version: d2.version,
      answer:
        "Explicit command: record.clear kind=escalation id=esc-board-clear",
      answeredBy: OPERATOR_BOARD_CALLER,
      relayed: false,
      note: "Clear via board",
    });
    const parsedView = decisionAnswer.output.parse(boardApplied);
    assert.equal(parsedView.status, "withdrawn");
    assert.equal(fx.task().resolution.stop, null);

    // Unreviewed external merge is NOT closed by an uncertain reviewer launch.
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-ext-merge", {
      payload: { commit: HEAD_B, head: HEAD_B },
    });
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: "run-uncertain-launch",
        role: "reviewer",
        attempt: 2,
        agentId: "agent-rev-uncertain",
        workspaceId: "ws-rev",
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
