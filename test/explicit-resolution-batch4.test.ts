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
import {
  closeClearedEscalations,
  escalationVerbChoices,
  plannerEscalations,
  type EscalationVerbChoice,
} from "../core/questions/ladder";
import { Store } from "../core/store/store";
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
  taskControlInputSchema,
} from "../shared/contracts";
import { decisionAnswer } from "../shared/rpc/decisions";
import { observeIdle } from "./support/fakes";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "1".repeat(40);
const PLANNER = "planner-live";
const REPO = "/repo/explicit-batch4";

function makeFixture(options: { plannerRoutable?: boolean } = {}) {
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
  store.event(
    taskId,
    "planner_escalation_offered",
    `${id}: ${JSON.stringify(options.offered ?? [])}`,
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
    ...(options.offered ?? []).map((o) => o.label),
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
  return questionId;
}

test("question.answer and decision.answer schemas validate explicit command + version requirements", () => {
  const validTopVersion = questionAnswerInputSchema.parse({
    questionId: "ns-escalation-1",
    caller: PLANNER,
    version: 3,
    command: { action: "run.release", run: "run-1", accept: ["live_turn"] },
    reason: "Release stuck run",
  });
  assert.equal(validTopVersion.command?.action, "run.release");

  const validCommandVersion = questionAnswerRequestSchema.parse({
    taskId: "task-1",
    caller: PLANNER,
    command: { action: "phase.set", to: "working", version: 4 },
    reason: "Return to working",
  });
  assert.equal(validCommandVersion.command?.version, 4);

  const validDecisionCmd = decisionAnswer.input.parse({
    id: "dec-1",
    version: 1,
    answer: "Release stuck reviewer",
    answeredBy: OPERATOR_BOARD_CALLER,
    relayed: false,
    command: {
      action: "run.release",
      run: "run-1",
      version: 5,
      accept: ["live_turn"],
    },
  });
  assert.equal(validDecisionCmd.command?.version, 5);

  assert.throws(
    () =>
      decisionAnswer.input.parse({
        id: "dec-1",
        version: 1,
        answer: "Missing task version on command",
        answeredBy: OPERATOR_BOARD_CALLER,
        relayed: false,
        command: { action: "run.release", run: "run-1" },
      }),
    /requires command\.version/,
  );

  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-1",
        caller: PLANNER,
        command: { action: "turn.release" },
        reason: "Missing version",
      }),
    /requires a task version/,
  );

  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-1",
        caller: PLANNER,
        version: 2,
        command: { action: "turn.release", version: 3 },
        reason: "Mismatched versions",
      }),
    /must match/,
  );

  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-1",
        caller: PLANNER,
        version: 2,
        answer: "Try again",
        command: { action: "turn.release" },
        reason: "Both answer and command",
      }),
    /Provide exactly one of answer, choice, decision or command/,
  );
});

test("underlay#046 shape: real owner control runs without 'is no longer available' offer-match loop", async () => {
  const f = makeFixture();
  try {
    const reviewer = runSchema.parse({
      id: "rev-uncertain-046",
      taskId: f.taskId,
      role: "reviewer",
      generation: 1,
      head: HEAD_A,
      base: BASE,
      agentId: "reviewer-046",
      workspaceId: "ws-046",
      hostId: "host-1",
      profile: null,
      status: "uncertain",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(reviewer);
    f.store.update(f.taskId, {
      phase: "reviewing",
      prHead: HEAD_A,
      resolution: {
        ...f.task().resolution,
        currentRunId: reviewer.id,
        reviewerAgentId: reviewer.agentId,
      },
    });
    const offer: EscalationVerbChoice = {
      label: `Retry run-delivery.${reviewer.id}: observe and retry the recorded effect`,
      verb: "retry_effect",
      args: { effect: `run-delivery.${reviewer.id}` },
    };
    const id = "underlay-046-retry";
    const questionId = recordOpenEscalation(f.store, f.engine, f.taskId, id, {
      runId: reviewer.id,
      offered: [offer],
    });
    // Change the task's PR head so `next` no longer matches the original snapshot.
    f.store.update(f.taskId, { prHead: HEAD_B });
    // Release the run so `next` stops offering `retry_effect` for `run-delivery.<id>`.
    f.store.putRun({ ...reviewer, released: true, status: "superseded" });
    assert.equal(
      escalationVerbChoices(
        ownerVerbViews(collectOwnerVerbFacts(f.store, f.task())),
      ).some((choice) => choice.verb === "retry_effect"),
      false,
    );

    // Real answer -> real EscalationSettlement -> real Engine.performTaskControl -> real RetryEffectControls.
    // It must NOT fail with the deleted "is no longer available" or "binding changed" refusals.
    await assert.rejects(
      async () =>
        f.engine.resolution.answerDelegatedQuestion(
          {
            questionId,
            choice: offer.label,
            version: f.task().version,
            reason: "Run real retry_effect guard path",
          },
          PLANNER,
        ),
      (error: Error) => {
        assert.doesNotMatch(error.message, /no longer available/i);
        assert.doesNotMatch(error.message, /binding changed/i);
        assert.match(error.message, /effect|pending|retry/i);
        return true;
      },
    );
  } finally {
    await f.close();
  }
});

test("escalation explicit command enforces version, warnings, accept, clears its own escalation stop and returns updated next", async () => {
  const f = makeFixture();
  try {
    const run = runSchema.parse({
      id: "run-stuck-1",
      taskId: f.taskId,
      role: "reviewer",
      generation: 1,
      head: HEAD_A,
      base: BASE,
      agentId: "reviewer-1",
      workspaceId: "ws-1",
      hostId: "host-1",
      profile: null,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, {
      phase: "reviewing",
      prHead: HEAD_A,
      resolution: {
        ...f.task().resolution,
        currentRunId: run.id,
        reviewerAgentId: "reviewer-1",
      },
    });
    const id = "explicit-cmd-release";
    const questionId = recordOpenEscalation(f.store, f.engine, f.taskId, id, {
      runId: run.id,
    });
    const currentVersion = f.task().version;

    // 1. Stale version returns stale status without changing anything or settling the escalation.
    const stale = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion + 99,
        command: { action: "run.release", run: run.id, accept: [] },
        reason: "Release stuck reviewer",
      },
      PLANNER,
    );
    assert.equal((stale as { status?: string }).status, "stale");
    assert.match(
      (stale as { explicitResolution?: { next: string } }).explicitResolution
        ?.next ?? "",
      new RegExp(`version ${currentVersion}`),
    );
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      false,
    );

    // 2. Unaccepted warnings return warnings with ids and change nothing.
    const warned = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion,
        command: { action: "run.release", run: run.id, accept: [] },
        reason: "Release stuck reviewer",
      },
      PLANNER,
    );
    assert.equal((warned as { status?: string }).status, "warnings");
    const warningIds = (
      warned as {
        explicitResolution?: { warnings: Array<{ id: string }>; next: string };
      }
    ).explicitResolution?.warnings.map((w) => w.id);
    assert.deepEqual(warningIds?.sort(), ["live_turn", "unreported_result"]);
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      false,
    );

    // 3. Repeating with accept applies the command, clears the escalation's own stop, writes owner_resolution, and returns updated next.
    const applied = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion,
        command: {
          action: "run.release",
          run: run.id,
          accept: ["live_turn", "unreported_result"],
        },
        reason: "Release stuck reviewer",
      },
      PLANNER,
    );
    assert.equal((applied as { status?: string }).status, "applied");
    const nextText =
      (applied as { explicitResolution?: { next: string } }).explicitResolution
        ?.next ?? "";
    assert.ok(nextText.length > 0);
    assert.doesNotMatch(nextText, /Waiting with the planner/i);
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(f.task().resolution.stop, null);
    assert.equal(
      f.store.eventsAll(f.taskId).filter((e) => e.kind === "owner_resolution")
        .length,
      1,
    );
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      true,
    );
    await f.engine.resolution.ladder.resumeEscalationWaits(f.task());
    assert.equal(f.task().resolution.stop, null);
  } finally {
    await f.close();
  }
});

test("recorded versioned answer refuses after task version advances across restart/retry", async () => {
  const f = makeFixture();
  try {
    const id = "stale-recorded-receipt";
    const questionId = recordOpenEscalation(f.store, f.engine, f.taskId, id);
    const staleVersion = f.task().version;
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const choice = "Wait until a time (put an ISO timestamp in Reason)";
    f.store.event(
      `delegation:${questionId}`,
      "delegated_answer",
      JSON.stringify({
        questionId,
        caller: PLANNER,
        answer: choice,
        version: staleVersion,
        reason: future,
      }),
    );
    // Advance the task version before the recorded receipt is replayed.
    f.store.update(f.taskId, { prHead: HEAD_A });
    const currentVersion = f.task().version;
    assert.notEqual(currentVersion, staleVersion);

    await assert.rejects(
      async () =>
        f.engine.resolution.answerDelegatedQuestion(
          { questionId, choice, version: staleVersion, reason: future },
          PLANNER,
        ),
      new RegExp(`Task is now at version ${currentVersion}`),
    );
    assert.equal(
      f.store
        .eventsAll(f.taskId)
        .filter((e) => e.kind === "planner_escalation_wait").length,
      0,
    );

    // Resubmitting with the reported current version applies the wait cleanly (stale refusal does not bump version).
    const applied = await f.engine.resolution.answerDelegatedQuestion(
      { questionId, choice, version: currentVersion, reason: future },
      PLANNER,
    );
    assert.equal(applied.questionId, questionId);
    assert.equal(
      f.store
        .eventsAll(f.taskId)
        .filter((e) => e.kind === "planner_escalation_wait").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("run-ticket CLI transport and board decision.answer carry explicit commands end to end", async () => {
  const f = makeFixture({ plannerRoutable: true });
  try {
    // 1. Run-ticket CLI stamping forwards command + version to answerDelegatedQuestionFromTicket.
    const run = runSchema.parse({
      id: "run-ticket-1",
      taskId: f.taskId,
      role: "recovery",
      generation: 1,
      head: HEAD_A,
      base: BASE,
      agentId: PLANNER,
      workspaceId: "ws-1",
      hostId: "host-1",
      profile: null,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(run);
    const token = "tok-" + randomUUID();
    f.store.setCredential(run.id, token);
    const ticketEscId = "ticket-cmd-esc";
    const ticketQuestionId = recordOpenEscalation(
      f.store,
      f.engine,
      f.taskId,
      ticketEscId,
      { runId: run.id, recipient: PLANNER },
    );
    let forwardedPayload: Record<string, unknown> | null = null;
    const stamped = await stampInput({
      method: "question.answer",
      input: {
        questionId: ticketQuestionId,
        version: f.task().version,
        command: { action: "phase.set", to: "working", accept: ["live_runs"] },
        reason: "Ticket command answer",
      },
      context: {
        callerSource: () => ({ source: "ticket" }),
        readTicket: () => ({ taskId: f.taskId, runId: run.id }),
        credentialFor: () => token,
        answerThroughTicket: async (
          _ticket: unknown,
          payload: Record<string, unknown>,
        ) => {
          forwardedPayload = payload;
          return f.engine.resolution.answerDelegatedQuestionFromTicket(
            payload as Parameters<
              typeof f.engine.resolution.answerDelegatedQuestionFromTicket
            >[0],
            token,
          );
        },
      },
    });
    assert.ok(forwardedPayload);
    assert.equal(
      (forwardedPayload as { command?: { action?: string } }).command?.action,
      "phase.set",
    );
    assert.equal((stamped.early as { status?: string }).status, "applied");
    assert.equal(f.task().phase, "working");

    // 2. Board decision.answer carrying an explicit command runs with operator_board authority and enforces hard gates.
    f.store.update(f.taskId, {
      phase: "verifying",
      resumePrNumber: 42,
      prUrl: "https://github.com/example/explicit-batch4/pull/42",
      prHead: HEAD_A,
    });
    const boardEscId = "board-cmd-esc";
    const boardQuestionId = recordOpenEscalation(
      f.store,
      f.engine,
      f.taskId,
      boardEscId,
    );
    // Hard gate via delegated command: merge.now refuses without review verdict even with accept.
    await assert.rejects(
      async () =>
        f.engine.resolution.answerDelegatedQuestion(
          {
            questionId: boardQuestionId,
            version: f.task().version,
            command: {
              action: "merge.now",
              head: HEAD_A,
              accept: ["checks", "holds", "turn_held"],
            },
            reason: "Attempt unreviewed merge",
          },
          PLANNER,
        ),
      /review verdict|operator source acceptance/i,
    );
    // Authority: unauthorized decider is refused.
    const deciderEscId = "decider-unauth-esc";
    const deciderQ = recordOpenEscalation(
      f.store,
      f.engine,
      f.taskId,
      deciderEscId,
      { recipient: "decider-1", role: "decider" },
    );
    await assert.rejects(
      async () =>
        f.engine.resolution.answerDelegatedQuestion(
          {
            questionId: deciderQ,
            version: f.task().version,
            command: { action: "phase.set", to: "working", accept: [] },
            reason: "Decider lacks explicit command authority",
          },
          "decider-1",
        ),
      /requires this task's coordinator, its live responsible planner or the operator board/i,
    );

    // Board decision route: classify to operator -> answer via Decisions.answer with command -> resumeEscalationWaits applies with operator_board authority.
    f.engine.resolution.classifyEscalationToOperator(
      f.task(),
      boardEscId,
      "Needs operator board decision",
      `planner ${PLANNER}`,
      {
        authority: "operator_choices",
        question: "How should this escalation be resolved?",
        choices: [
          {
            label: "Release run and continue",
            consequence: "Releases the recovery run.",
          },
          { label: "Stop task", consequence: "Stops the task." },
        ],
        recommended: "Release run and continue",
      },
    );
    const linkedDecision = new Decisions(f.store).list({
      task: f.taskId,
      status: "open",
    })[0]!;
    assert.ok(linkedDecision);
    const parsedRpc = decisionAnswer.input.parse({
      id: linkedDecision.id,
      version: linkedDecision.version,
      answer: "Operator releases the stuck run directly",
      answeredBy: OPERATOR_BOARD_CALLER,
      relayed: false,
      command: {
        action: "run.release",
        run: run.id,
        version: f.task().version,
        accept: ["live_turn", "unreported_result"],
      },
    });
    const answeredDecision = new Decisions(f.store).answer(parsedRpc);
    assert.equal(answeredDecision.answer?.command?.action, "run.release");
    await f.engine.resolution.ladder.resumeEscalationWaits(f.task());
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find(
        (e) => e.id === boardEscId,
      )?.answered,
      true,
    );
    const resolutionEvents = f.store
      .eventsAll(f.taskId)
      .filter((e) => e.kind === "owner_resolution");
    assert.equal(
      JSON.parse(resolutionEvents.at(-1)!.detail).source,
      "operator_board",
    );
  } finally {
    await f.close();
  }
});

test("cause-cleared closure retires owned waits and open board decisions, never closes unreviewed external merge on uncertain launch, and preserves deliberate waits", async () => {
  const f = makeFixture();
  try {
    // 1. Stopped reviewer escalation with linked board decision: releasing reviewer retires wait + withdraws decision so resumeEscalationWaits does NOT restore the stop.
    const reviewer = runSchema.parse({
      id: "rev-exhausted-1",
      taskId: f.taskId,
      role: "reviewer",
      generation: 1,
      head: HEAD_A,
      base: BASE,
      agentId: "reviewer-1",
      workspaceId: "ws-1",
      hostId: "host-1",
      profile: null,
      status: "finished",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(reviewer);
    f.store.update(f.taskId, {
      phase: "reviewing",
      prHead: HEAD_A,
      resolution: { ...f.task().resolution, currentRunId: reviewer.id },
    });
    const revEscId = "rev-cont-cleared";
    recordOpenEscalation(f.store, f.engine, f.taskId, revEscId, {
      runId: null,
      payload: { reviewContinuation: "exhausted", reader: reviewer.id },
    });
    f.engine.resolution.classifyEscalationToOperator(
      f.task(),
      revEscId,
      "Reviewer stopped",
      `planner ${PLANNER}`,
      {
        authority: "operator_choices",
        question: "Replace reviewer?",
        choices: [
          { label: "Replace", consequence: "Starts fresh reviewer." },
          { label: "Stop", consequence: "Stops task." },
        ],
        recommended: "Replace",
      },
    );
    const openDecision = new Decisions(f.store).list({
      task: f.taskId,
      status: "open",
    })[0]!;
    assert.ok(openDecision);

    f.store.putRun({ ...reviewer, released: true });
    await f.engine.resolution.ladder.resumeEscalationWaits(f.task());
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find(
        (e) => e.id === revEscId,
      )?.answered,
      true,
    );
    assert.equal(f.task().resolution.stop, null);
    assert.equal(
      new Decisions(f.store).get({ id: openDecision.id }).status,
      "withdrawn",
    );

    // 2. Unreviewed external-merge escalation must NOT close on a new uncertain reviewer run; closes only on operator acceptance / review at merged head.
    const extEscId = "ext-merge-cleared";
    recordOpenEscalation(f.store, f.engine, f.taskId, extEscId, {
      payload: { head: HEAD_B, commit: "c".repeat(40) },
    });
    const uncertainReviewer = runSchema.parse({
      id: "rev-uncertain-after-ext",
      taskId: f.taskId,
      role: "reviewer",
      generation: 1,
      head: HEAD_B,
      base: BASE,
      agentId: null,
      workspaceId: "ws-1",
      hostId: "host-1",
      profile: null,
      status: "uncertain",
      createdAt: new Date(Date.now() + 1000).toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(uncertainReviewer);
    f.store.update(f.taskId, {
      resolution: {
        ...f.task().resolution,
        currentRunId: uncertainReviewer.id,
      },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), []);

    f.store.update(f.taskId, {
      resolution: {
        ...f.task().resolution,
        ownerAcceptances: [
          {
            head: HEAD_B,
            prNumber: 42,
            kind: "operator_source",
            at: new Date().toISOString(),
            review: null,
            qualification: "Operator accepted merged head",
            actor: { agentId: OPERATOR_BOARD_CALLER, role: "operator" },
            authority: { kind: "operator", note: null },
            reason: "Operator accepted merged head",
            missingEvidence: null,
          },
        ],
      },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), [extEscId]);

    // 3. Recovery-pending escalation closes when its incident clears.
    const incEscId = "rec-pending-cleared";
    f.store.update(f.taskId, {
      phase: "needs_attention",
      resolution: {
        ...f.task().resolution,
        incident: {
          id: "inc-1",
          role: "reviewer",
          runId: reviewer.id,
          fingerprint: "fp-1",
          attempt: 1,
          cause: "stalled_turn",
          status: "escalated",
          detail: "Escalated",
          action: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    recordOpenEscalation(f.store, f.engine, f.taskId, incEscId, {
      payload: { cause: "recovery-pending" },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), []);
    f.store.update(f.taskId, {
      resolution: { ...f.task().resolution, incident: null },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), [incEscId]);
  } finally {
    await f.close();
  }
});

test("deleted restart-as-escalation-answer path: parkedRestart never returns answer", async () => {
  const f = makeFixture();
  try {
    f.store.update(f.taskId, {
      phase: "done",
      resolution: {
        ...f.task().resolution,
        attention: false,
        recovery: {
          id: "rec-1",
          key: "recovery-key-1",
          generation: 1,
          status: "escalated",
          summary: "Escalated",
          incidentId: "inc-1",
          runId: null,
          agentId: null,
          idleSince: null,
          action: null,
        },
      },
    });
    const parked = parkedRestart(collectOwnerVerbFacts(f.store, f.task()));
    assert.ok("refusal" in parked);
    await assert.rejects(
      () =>
        f.engine.performTaskControl(
          taskControlInputSchema.parse({
            taskId: f.taskId,
            version: f.task().version,
            action: "restart",
            reason: "Old restart-as-escalation-answer lever",
          }),
        ),
      /done|Nothing is parked/i,
    );
  } finally {
    await f.close();
  }
});
