import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
// @ts-expect-error untyped ESM helper module
import { stampInput } from "../bin/cli-stamping.mjs";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { Decisions } from "../core/planning/decisions";
import { RuntimeQuestions } from "../core/runtime/questions";
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
import { Store } from "../core/store/store";
import {
  collectOwnerVerbFacts,
  ownerVerbViews,
  parkedRestart,
} from "../core/verbs/owner-verbs";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import {
  OPERATOR_BOARD_CALLER,
  questionAnswerInputSchema,
  questionAnswerRequestSchema,
  runSchema,
  submissionSchema,
} from "../shared/contracts";
import { observeIdle } from "./support/fakes";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "1".repeat(40);
const PLANNER = "planner-live";
const REPO = "/repo/explicit-batch4";

function makeFixture(
  options: { plannerRoutable?: boolean; stopTurnError?: string } = {},
) {
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
      {
        origin: "https://github.com/example/explicit-batch4.git",
        path: REPO,
      },
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
  const plannerRoutable = options.plannerRoutable ?? true;
  const adapter = {
    hostId: "host-1",
    profiles: async () => [],
    listLiveAgents: async () =>
      plannerRoutable
        ? [
            {
              id: PLANNER,
              title: "Planner",
              directory: REPO,
              workspaceId: null,
            },
          ]
        : [],
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: !plannerRoutable && id === PLANNER,
    }),
    observe: async (agentId: string) => {
      if (agentId === PLANNER) {
        return plannerRoutable
          ? {
              id: PLANNER,
              status: "idle",
              active: false,
              workspaceId: "ws-planner",
              cwd: REPO,
            }
          : {
              id: PLANNER,
              status: "closed",
              active: false,
              workspaceId: "ws-planner",
              cwd: REPO,
            };
      }
      return (await observeIdle(null)(agentId))!;
    },
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
    dir,
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

function recordOpenEscalation(
  store: Store,
  engine: Engine,
  taskId: string,
  id: string,
  options: {
    runId?: string | null;
    payload?: Record<string, unknown>;
    offered?: EscalationVerbChoice[];
    recipient?: string;
    role?: "planner" | "decider";
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
    `${id}: ${JSON.stringify({
      cause,
      runId: options.runId ?? null,
      question: "How should this stuck task proceed?",
      ...(options.payload ?? {}),
    })}`,
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
    { fact: { code: "escalation", subject: id } },
  );
  const questionId = `ns-escalation-${id}`;
  const choices = [
    "Wait until a time (put an ISO timestamp in Reason)",
    ...offered.map((o) => o.label),
  ];
  engine.resolution.openDelegatedQuestion(
    store.task(taskId),
    questionId,
    options.recipient ?? PLANNER,
    `Choose how to continue\n${choices.map((c) => `- ${c}`).join("\n")}`,
    60_000,
    options.role ?? "planner",
    "host-1",
  );
  return { questionId, offered };
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

test("question.answer schemas and run-ticket CLI transport carry explicit command + version", async () => {
  const valid = questionAnswerInputSchema.parse({
    questionId: "ns-escalation-esc-1",
    caller: PLANNER,
    version: 7,
    command: {
      action: "run.release",
      run: "run-1",
      accept: ["live_turn"],
    },
    reason: "Release stuck run",
  });
  assert.equal(valid.version, 7);
  assert.equal(valid.command?.action, "run.release");
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

  const req = questionAnswerRequestSchema.parse({
    questionId: "ns-escalation-esc-1",
    caller: PLANNER,
    version: 7,
    command: { action: "record.clear", kind: "escalation", id: "esc-1" },
    reason: "Clear resolved escalation",
  });
  assert.equal(req.version, 7);

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

test("#1491 shape: escalation lists explicit commands, choosing one runs ordinary RPC without escalation-answer markers, enforces version/warnings/hard-gates, and closes on cause clearance", async () => {
  const fx = makeFixture({ stopTurnError: "host stop timed out" });
  try {
    const runId = "run-worker-1491";
    const run = makeRun(fx.taskId, {
      id: runId,
      agentId: "agent-worker-1491",
    });
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
      releaseOption,
      "run.release should be listed as an offered option",
    );
    assert.equal(releaseOption.command?.action, "run.release");
    assert.equal(releaseOption.command.run, runId);

    // Simulate #1491: task PR head and version advance after offer.
    const staleVersion = fx.task().version;
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head changed after offer",
    );
    const currentVersion = fx.task().version;
    assert.notEqual(currentVersion, staleVersion);

    // 1) Choosing the listed option with a stale version returns stale and writes nothing.
    const staleReply = (await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: releaseOption.label,
        version: staleVersion,
        reason: "Release stuck run with stale version",
      },
      PLANNER,
    )) as { status?: string; version?: number };
    assert.equal(staleReply.status, "stale");
    assert.equal(staleReply.version, currentVersion);
    assert.equal(fx.store.run(runId)?.released, false);

    // 2) Choosing the listed option without accept returns warnings and leaves escalation open.
    const warnedReply = (await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: releaseOption.label,
        version: currentVersion,
        reason: "Release stuck run without accept",
      },
      PLANNER,
    )) as {
      status?: string;
      explicitResolution?: { warnings: { id: string }[]; next: string };
    };
    assert.equal(warnedReply.status, "warnings");
    assert.ok(
      warnedReply.explicitResolution?.warnings.some(
        (w) => w.id === "live_turn",
      ),
    );
    assert.equal(
      fx.store
        .eventsAll(fx.taskId)
        .some((e) => e.kind === "planner_escalation_answered"),
      false,
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${questionId}`)
        .some((e) => e.kind === "delegated_answer"),
      false,
    );

    // 3) Hard gate: merge.now without ready review verdict refuses even with accept.
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

    // 4) Repeating with accept applies run.release, closes via closeClearedEscalations,
    // writes NO planner_escalation_answered / delegated_answer, and preserves host diagnostic in next.
    const appliedReply = (await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion,
        command: {
          action: "run.release",
          run: runId,
          accept: ["live_turn", "unreported_result"],
        },
        reason: "Release stuck run after accepting warnings",
      },
      PLANNER,
    )) as {
      status?: string;
      explicitResolution?: { warnings: { id: string }[]; next: string };
    };
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
      "decoupled command must write no planner_escalation_answered marker",
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${questionId}`)
        .some((e) => e.kind === "delegated_answer"),
      false,
      "decoupled command must write no delegated_answer marker",
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${questionId}`)
        .some((e) => e.kind === "delegated_closed"),
      true,
      "auto-close must close the initial question window so it is no longer discoverable",
    );
    assert.throws(
      () => fx.engine.resolution.delegatedQuestionForTask(fx.taskId, PLANNER),
      /no open|not found|question/i,
    );
  } finally {
    await fx.close();
  }
});

test("underlay#046 shape: real owner control runs through Engine.performTaskControl without 'is no longer available' loop", async () => {
  const fx = makeFixture();
  try {
    const reviewerRunId = "run-rev-046";
    const operationId = randomUUID();
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
            operationId,
            deliveryId: `ns-review-${"c".repeat(64)}`,
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
    assert.ok(
      retryOffer,
      "retry_effect should be offered for uncertain delivery",
    );

    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-046",
      { runId: reviewerRunId, offered },
    );

    // Move PR head so the original snapshot offer would have failed the old binding-hash / offer-match guard.
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head moved after escalation offer",
    );

    // Real path: answerDelegatedQuestion -> EscalationSettlement -> Engine.performTaskControl -> RetryEffectControls.
    // Must not fail with "is no longer available" (any refusal comes from the real verb guard, not offer matching).
    try {
      await fx.engine.resolution.answerDelegatedQuestion(
        {
          questionId,
          choice: retryOffer.label,
          version: fx.task().version,
          reason: "Retry uncertain reviewer delivery",
        },
        PLANNER,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /is no longer available/i);
      assert.doesNotMatch(message, /binding/i);
    }

    // Clearing the sole uncertain run-delivery effect closes its matching escalation and clears the stop.
    const deliveryId = `ns-review-${"c".repeat(64)}`;
    const clearedEffect = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "record.clear",
        kind: "effect",
        id: `review-delivery.${deliveryId}`,
        accept: ["effect_may_land"],
        reason: "Clear sole uncertain reviewer delivery effect",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(clearedEffect.explicitResolution?.status, "applied");
    assert.deepEqual(closeClearedEscalations(fx.store, fx.task()), ["esc-046"]);
    assert.equal(fx.task().resolution.stop, null);
  } finally {
    await fx.close();
  }
});

test("simulated roll between command commit and auto-close: maintenance closes escalation atomically without resending the command", async () => {
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
    // Link an open board decision and an active owned wait to this escalation.
    const decisions = new Decisions(fx.store);
    const decision = decisions.add({
      headline: "Escalation operator decision",
      question: "How should esc-roll proceed?",
      choices: [
        { label: "Release run", consequence: "Releases the run" },
        { label: "Keep stopped", consequence: "Keeps the task parked" },
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

    // Board and native-inbox decision answers on a listed explicit command option
    // dispatch the command without persisting a decision answer or escalation-answer marker.
    const runtimeQuestions = new RuntimeQuestions({
      store: fx.store,
      engine: fx.engine,
      decisions,
      markStoreAccess: () => {},
    });
    const boardWarned = (await runtimeQuestions.answerDecision({
      id: decision.id,
      version: decision.version,
      answer: `Explicit command: run.release run=${runId}`,
      answeredBy: OPERATOR_BOARD_CALLER,
      relayed: false,
      note: "Board operator chose run.release",
    })) as {
      status: string;
      explicitResolution?: { status: string; warnings: { id: string }[] };
    };
    assert.equal(boardWarned.status, "open");
    assert.equal(boardWarned.explicitResolution?.status, "warnings");
    assert.ok(
      boardWarned.explicitResolution?.warnings.some(
        (w) => w.id === "live_turn",
      ),
    );
    assert.equal(fx.store.decision(decision.id).status, "open");
    assert.equal(
      fx.store
        .eventsAll(fx.taskId)
        .some((e) => e.kind === "planner_escalation_answered"),
      false,
    );

    // Step 1: commit the explicit command directly via resolveExplicitly (simulating a roll
    // immediately after the command commits, before closeClearedEscalations runs).
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
      "escalation is still open right after simulated roll",
    );
    assert.equal(fx.store.decision(decision.id).status, "open");

    // Step 2: maintenance pass runs after the roll and closes the escalation atomically
    // without resending the explicit command.
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
      "maintenance must not resend the explicit command",
    );

    // Step 3: non-clearance guards — unreviewed external merge is NOT closed by an uncertain launch.
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
    const facts = collectOwnerVerbFacts(fx.store, fx.task());
    const parked = parkedRestart(facts);
    assert.ok(
      !parked || !("answer" in parked),
      "parkedRestart must not fall back to answering an open escalation",
    );
  } finally {
    fx.close();
  }
});
