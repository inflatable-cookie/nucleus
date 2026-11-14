import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  blockerLadderStep,
  consultRecovery,
  escalationRecovery,
  escalationWaitDetail,
  type PlannerEscalation,
  type ReviewerConsult,
} from "../core/questions/blocker-ladder";
import { answeredQuestionOutcome } from "../core/questions/native-questions";
import { operatorQuestionStep } from "../core/questions/operator-question";
import {
  applyBinaryApproval,
  APPROVE_BY_DEFAULT_REASON,
} from "../core/questions/question-delegation";
import type { Completion } from "../shared/contracts";

const blocked = { status: "blocked", providerUnavailable: false } as Completion;
const errored = { status: "error", providerUnavailable: false } as Completion;
const provider = { status: "blocked", providerUnavailable: true } as Completion;
const consult = (change: Partial<ReviewerConsult> = {}): ReviewerConsult => ({
  id: "c1",
  cause: "cause",
  runId: "run",
  reviewer: "r",
  question: "q",
  answered: false,
  unknown: false,
  advice: null,
  ...change,
});
const escalation = (
  change: Partial<PlannerEscalation> = {},
): PlannerEscalation => ({
  id: "e1",
  cause: "cause",
  runId: "run",
  question: "q",
  refusal: null,
  answered: false,
  unknown: false,
  missed: false,
  decisionId: null,
  ...change,
});

test("blockerLadderStep classifies, waits or continues", () => {
  const cases: Array<[object, string]> = [
    [
      { classified: false, completion: blocked, escalations: [], consults: [] },
      "classify",
    ],
    [
      { classified: false, completion: errored, escalations: [], consults: [] },
      "classify",
    ],
    [
      {
        classified: false,
        completion: provider,
        escalations: [],
        consults: [],
      },
      "continue",
    ],
    [
      {
        classified: false,
        completion: { status: "ready_for_review" },
        escalations: [],
        consults: [],
      },
      "continue",
    ],
    [
      { classified: true, completion: blocked, escalations: [], consults: [] },
      "continue",
    ],
    [
      {
        classified: false,
        completion: blocked,
        escalations: [escalation()],
        consults: [],
      },
      "classify",
    ],
    [
      {
        classified: true,
        completion: blocked,
        escalations: [escalation()],
        consults: [],
      },
      "wait",
    ],
    [
      {
        classified: true,
        completion: blocked,
        escalations: [escalation({ unknown: true })],
        consults: [],
      },
      "wait",
    ],
    [
      {
        classified: true,
        completion: blocked,
        escalations: [escalation({ decisionId: "d1" })],
        consults: [],
      },
      "wait",
    ],
    [
      {
        classified: true,
        completion: blocked,
        escalations: [escalation({ answered: true })],
        consults: [consult()],
      },
      "wait",
    ],
    [
      {
        classified: true,
        completion: blocked,
        escalations: [],
        consults: [consult({ unknown: true })],
      },
      "continue",
    ],
    [
      {
        classified: true,
        completion: blocked,
        escalations: [escalation({ answered: true })],
        consults: [consult({ answered: true })],
      },
      "continue",
    ],
    [
      { classified: true, completion: null, escalations: [], consults: [] },
      "continue",
    ],
  ];
  for (const [facts, expected] of cases)
    assert.equal(
      blockerLadderStep(facts as Parameters<typeof blockerLadderStep>[0]).kind,
      expected,
      expected,
    );
  const waitOf = (facts: Parameters<typeof blockerLadderStep>[0]) => {
    const step = blockerLadderStep(facts);
    if (step.kind !== "wait") throw new Error(step.kind);
    return step.detail;
  };
  assert.equal(
    waitOf({
      classified: true,
      completion: blocked,
      escalations: [escalation()],
      consults: [],
    }),
    escalationWaitDetail.planner("e1"),
  );
  assert.equal(
    waitOf({
      classified: true,
      completion: blocked,
      escalations: [escalation({ unknown: true })],
      consults: [],
    }),
    escalationWaitDetail.unknown("e1"),
  );
  assert.equal(
    waitOf({
      classified: true,
      completion: blocked,
      escalations: [escalation({ decisionId: "d1" })],
      consults: [],
    }),
    escalationWaitDetail.operator("e1", "d1"),
  );
  assert.equal(
    waitOf({
      classified: true,
      completion: blocked,
      escalations: [],
      consults: [consult()],
    }),
    escalationWaitDetail.reviewer("c1"),
  );
});

test("operatorQuestionStep skip, proof GO, open fence and raise", () => {
  const q = { id: "q1", kind: "budget" as const };
  const release = { id: "go", kind: "release" as const };
  const cases: Array<[object, string]> = [
    [
      {
        question: null,
        entrypoint: "worker",
        alreadyMarked: false,
        decisionMarked: false,
        openQuestion: false,
      },
      "skip",
    ],
    [
      {
        question: release,
        entrypoint: "proof",
        alreadyMarked: false,
        decisionMarked: false,
        openQuestion: true,
      },
      "proof_go",
    ],
    [
      {
        question: release,
        entrypoint: "proof",
        alreadyMarked: true,
        decisionMarked: true,
        openQuestion: false,
      },
      "proof_go",
    ],
    [
      {
        question: q,
        entrypoint: "worker",
        alreadyMarked: true,
        decisionMarked: false,
        openQuestion: false,
      },
      "skip_marked",
    ],
    [
      {
        question: q,
        entrypoint: "worker",
        alreadyMarked: false,
        decisionMarked: false,
        openQuestion: true,
      },
      "skip_open",
    ],
    [
      {
        question: q,
        entrypoint: "worker",
        alreadyMarked: false,
        decisionMarked: false,
        openQuestion: false,
      },
      "raise",
    ],
    [
      {
        question: release,
        entrypoint: "worker",
        alreadyMarked: false,
        decisionMarked: false,
        openQuestion: false,
      },
      "raise",
    ],
  ];
  for (const [facts, expected] of cases)
    assert.equal(
      operatorQuestionStep(facts as Parameters<typeof operatorQuestionStep>[0])
        .kind,
      expected,
      expected,
    );
  const fresh = operatorQuestionStep({
    question: release,
    entrypoint: "proof",
    alreadyMarked: false,
    decisionMarked: false,
    openQuestion: false,
  });
  assert.deepEqual(fresh, {
    kind: "proof_go",
    recordIntent: true,
    ensureBoard: true,
  });
  const recovering = operatorQuestionStep({
    question: release,
    entrypoint: "proof",
    alreadyMarked: true,
    decisionMarked: false,
    openQuestion: false,
  });
  assert.deepEqual(recovering, {
    kind: "proof_go",
    recordIntent: false,
    ensureBoard: true,
  });
});

test("answeredQuestionOutcome skip, agent change, refuse and resume", () => {
  const base = {
    seen: false,
    phaseOk: true,
    unreleasedRun: false,
    stillBlocked: true,
    watchAgentId: "a1",
    currentAgentId: "a1",
    hasApplier: true,
  };
  const cases: Array<[object, string]> = [
    [{ ...base, watchKind: "worker", seen: true }, "skip"],
    [{ ...base, watchKind: "worker", phaseOk: false }, "skip"],
    [{ ...base, watchKind: "worker", unreleasedRun: true }, "skip"],
    [{ ...base, watchKind: "worker", stillBlocked: false }, "skip"],
    [{ ...base, watchKind: "reviewer", stillBlocked: false }, "skip"],
    [
      { ...base, watchKind: "worker", currentAgentId: "a2" },
      "unknown_agent_changed",
    ],
    [
      { ...base, watchKind: "worker", currentAgentId: null },
      "unknown_agent_changed",
    ],
    [
      { ...base, watchKind: "reviewer", currentAgentId: "a2" },
      "unknown_agent_changed",
    ],
    [{ ...base, watchKind: "worker", hasApplier: false }, "refuse_no_applier"],
    [
      { ...base, watchKind: "reviewer", hasApplier: false },
      "refuse_no_applier",
    ],
    [{ ...base, watchKind: "worker" }, "resume_worker"],
    [{ ...base, watchKind: "reviewer" }, "resume_reviewer"],
  ];
  for (const [facts, expected] of cases)
    assert.equal(
      answeredQuestionOutcome(
        facts as Parameters<typeof answeredQuestionOutcome>[0],
      ).kind,
      expected,
      expected,
    );
  // Worker checks identity before blocked evidence; reviewer checks blocked evidence first.
  assert.equal(
    answeredQuestionOutcome({
      ...base,
      watchKind: "worker",
      stillBlocked: false,
      currentAgentId: "a2",
    }).kind,
    "unknown_agent_changed",
  );
  assert.equal(
    answeredQuestionOutcome({
      ...base,
      watchKind: "reviewer",
      stillBlocked: false,
      currentAgentId: "a2",
    }).kind,
    "skip",
  );
  assert.deepEqual(
    answeredQuestionOutcome({
      ...base,
      watchKind: "worker",
      currentAgentId: null,
    }),
    { kind: "unknown_agent_changed", from: "a1", to: "none" },
  );
});

test("consultRecovery and escalationRecovery skip or run", () => {
  const consultFacts = {
    answered: false,
    unknown: false,
    recoverable: false,
    question: "q",
    hasAdapter: true,
    inFlight: false,
  };
  for (const [facts, expected] of [
    [consultFacts, "run"],
    [{ ...consultFacts, answered: true }, "skip"],
    [{ ...consultFacts, unknown: true, recoverable: false }, "skip"],
    [{ ...consultFacts, unknown: true, recoverable: true }, "run"],
    [{ ...consultFacts, question: null }, "skip"],
    [{ ...consultFacts, hasAdapter: false }, "skip"],
    [{ ...consultFacts, inFlight: true }, "skip"],
  ] as const)
    assert.equal(consultRecovery(facts).kind, expected);

  const escalationFacts = {
    missedNoAnswer: false,
    answered: false,
    unknown: false,
    observing: true,
    missed: false,
    recoverable: true,
    decisionId: null as string | null,
    question: "q" as string | null,
    inFlight: false,
  };
  for (const [facts, expected] of [
    [escalationFacts, "run"],
    [{ ...escalationFacts, missedNoAnswer: true }, "skip"],
    [{ ...escalationFacts, answered: true }, "skip"],
    [{ ...escalationFacts, unknown: true, observing: false }, "skip"],
    [{ ...escalationFacts, unknown: true, observing: true }, "run"],
    [{ ...escalationFacts, missed: true, recoverable: false }, "skip"],
    [{ ...escalationFacts, missed: true, recoverable: true }, "run"],
    [{ ...escalationFacts, decisionId: "d1" }, "skip"],
    [{ ...escalationFacts, question: null }, "skip"],
    [{ ...escalationFacts, inFlight: true }, "skip"],
  ] as const)
    assert.equal(escalationRecovery(facts).kind, expected);
});

test("bug 23: applyBinaryApproval records approve by default only for the approval", () => {
  assert.deepEqual(
    applyBinaryApproval("Spend more?", ["Approve", "Hold"], "Approve"),
    { choice: "Approve", reason: APPROVE_BY_DEFAULT_REASON },
  );
  assert.deepEqual(
    applyBinaryApproval("Spend more?", ["Approve", "Hold"], "approve"),
    { choice: "Approve", reason: APPROVE_BY_DEFAULT_REASON },
  );
  assert.equal(
    applyBinaryApproval("Spend more?", ["Approve", "Hold"], "Hold"),
    null,
  );
  assert.equal(
    applyBinaryApproval(
      "Should we release this?",
      ["Approve", "Hold"],
      "Approve",
    ),
    null,
  );
  assert.equal(APPROVE_BY_DEFAULT_REASON, "approve by default, Tom 2026-11-03");
});
