import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  escalationWaitDetail,
  hasConcreteOperatorChoices,
  isPlaceholderDecisionRecord,
} from "../core/questions/ladder";
import { Decisions } from "../core/planning/decisions";
import { Engine } from "../core/engine";
import { fixture } from "./support/responsible-lifecycle-fixture";

const until = async (pass: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!pass()) {
    if (Date.now() >= deadline) throw new Error("condition never settled");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("structured authority distinguishes concrete operator choices from defer-only and bare handoffs", () => {
  assert.equal(hasConcreteOperatorChoices(undefined), false);
  assert.equal(
    hasConcreteOperatorChoices({
      authority: "bare_classification",
      choices: [
        { label: "Option A", consequence: "Does A", kind: "action" },
        { label: "Option B", consequence: "Does B", kind: "action" },
      ],
    }),
    false,
  );
  assert.equal(
    hasConcreteOperatorChoices({
      authority: "operator_choices",
      choices: [
        {
          label: "Keep task held",
          consequence: "Keeps the task blocked in the board",
          kind: "hold",
        },
        {
          label: "Ask planner for recommendation",
          consequence: "Returns the occurrence to the planner",
          kind: "defer_planning",
        },
      ],
    }),
    false,
    "choices that only defer planning or hold never authorize an operator card",
  );
  assert.equal(
    hasConcreteOperatorChoices({
      authority: "operator_choices",
      choices: [
        {
          label: "Keep the task blocked until manual staging sign-off",
          consequence: "Holds release until the operator clears staging",
          kind: "action",
        },
        {
          label: "Approve staging exception",
          consequence: "Proceeds without waiting for staging",
          kind: "action",
        },
      ],
      recommended: "Keep the task blocked until manual staging sign-off",
    }),
    true,
    "concrete action choices with consequences pass regardless of displayed label words",
  );
  assert.equal(
    isPlaceholderDecisionRecord({ choices: undefined, options: [] }),
    true,
  );
  assert.equal(
    isPlaceholderDecisionRecord({
      choices: [
        { label: "Return to planner", consequence: "Synthesized fallback" },
        { label: "Keep held", consequence: "Synthesized fallback" },
      ],
      options: [],
    }),
    true,
    "legacy decisions whose choices came from compactChoices fallback have no explicit options",
  );
  assert.equal(
    isPlaceholderDecisionRecord({
      choices: [
        { label: "Option A", consequence: "Effect A" },
        { label: "Option B", consequence: "Effect B" },
      ],
      options: ["Option A", "Option B"],
    }),
    false,
  );
});

test("defer-only choices return the exact escalation occurrence to the planner without creating an operator card", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  let plannerPrompt = "";
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string; messageId?: string },
  ) => {
    if (input.messageId?.startsWith("ns-escalation-return-")) {
      plannerPrompt = input.prompt;
      return "Choice: Return to the worker with a new approach\nReason: Use the staged verifier fixture";
    }
    return null;
  };
  try {
    f.store.upsertProject({
      key: "app",
      name: "App",
      repositories: [{ origin: null, path: join(f.dir, "repo") }],
    });
    f.store.setProjectPlanner({
      key: "app",
      agentId: "planner-1",
      setBy: "operator",
    });
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked", {
      summary: "The staging verifier fixture is missing",
      cause: { kind: "external", name: "missing fixture" },
    });
    await until(
      () =>
        f.events("planner_escalation").length > 0 &&
        f.events("planner_escalation_offered").length > 0,
    );
    const escalationId = f
      .events("planner_escalation")[0]!
      .detail.split(":", 1)[0]!;

    f.engine.resolution.classifyEscalationToOperator(
      f.current(),
      escalationId,
      "Only defer-planning options remain",
      "planner planner-1",
      {
        authority: "operator_choices",
        sourceQuestionId: `ns-escalation-${escalationId}`,
        choices: [
          {
            label: "Keep task blocked",
            consequence: "Parks task until someone returns to it",
            kind: "hold",
          },
          {
            label: "Return to planner",
            consequence: "Sends escalation back for planning",
            kind: "defer_planning",
          },
        ],
      },
    );

    assert.equal(new Decisions(f.store).list({ task: f.current().id }).length, 0);
    await until(() => f.events("planner_escalation_applied").length > 0);
    assert.match(plannerPrompt, new RegExp(escalationId));
    assert.match(plannerPrompt, /The staging verifier fixture is missing/);
    assert.match(plannerPrompt, /Work needed:/);
    assert.equal(new Decisions(f.store).list({ task: f.current().id }).length, 0);
    await f.settle(3);
    assert.equal(f.run().role, "revision");
    assert.match(f.run().instruction ?? "", /staged verifier fixture/);
  } finally {
    await f.close();
  }
});

test("an unavailable planner keeps the returned escalation visible, parked, and preserves independent holds", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  f.engine.resolution.plannerRungsFor = async () => ({
    rungs: [],
    issue: "Planner host is offline",
    projectFailed: true,
  });
  try {
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked", {
      summary: "Dependency gate needs a plan",
      cause: { kind: "external", name: "dep gate" },
    });
    await until(() => f.events("planner_escalation").length > 0);
    const escalationId = f
      .events("planner_escalation")[0]!
      .detail.split(":", 1)[0]!;
    const afterBlocked = f.current();
    await f.engine.performTaskControl({
      taskId: afterBlocked.id,
      version: afterBlocked.version,
      action: "hold",
      kind: "dispatch",
      reason: "Operator dispatch fence",
    });
    const afterDispatchHold = f.current();
    await f.engine.performTaskControl({
      taskId: afterDispatchHold.id,
      version: afterDispatchHold.version,
      action: "hold",
      kind: "merge",
      reason: "Operator merge fence",
    });

    const runsBefore = f.store.runs(afterBlocked.id).length;
    f.engine.resolution.classifyEscalationToOperator(
      f.current(),
      escalationId,
      "Needs planner recommendation",
      "planner planner-1",
      {
        authority: "bare_classification",
        sourceQuestionId: `ns-escalation-${escalationId}`,
      },
    );

    await until(() => f.events("planner_escalation_routing_wait").length > 0);
    await f.engine.wake();
    await f.engine.quiesce();
    const parked = f.current();
    assert.equal(new Decisions(f.store).list({ task: parked.id }).length, 0);
    assert.equal(parked.resolution.stop?.reason, "escalated");
    assert.match(
      parked.resolution.stop?.detail ?? "",
      /returned to the planner.*waiting for a routable planner|Planner host is offline/i,
    );
    assert.equal(parked.held, true);
    assert.equal(parked.holds.dispatch?.reason, "Operator dispatch fence");
    assert.equal(parked.holds.merge?.reason, "Operator merge fence");
    assert.equal(f.store.runs(parked.id).length, runsBefore);
  } finally {
    await f.close();
  }
});

test("repeated inability to decide and duplicate return answers coalesce without looping or launching tasks", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  let asks = 0;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string },
  ) => {
    asks += 1;
    f.delegated.planner.push(input);
    return "Decision: operator\nReason: Still uncertain which branch to revise.";
  };
  try {
    f.store.upsertProject({
      key: "app",
      name: "App",
      repositories: [{ origin: null, path: join(f.dir, "repo") }],
    });
    f.store.setProjectPlanner({
      key: "app",
      agentId: "planner-1",
      setBy: "operator",
    });
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked");
    await until(() => f.events("planner_escalation_return_exhausted").length > 0);

    const task = f.current();
    const escalationId = f
      .events("planner_escalation")[0]!
      .detail.split(":", 1)[0]!;
    const runsAtPark = f.store.runs(task.id).length;

    // Duplicate/replayed sweeps and repeated bare classifications must coalesce.
    await f.engine.resolution.resumeAskQuestions();
    await f.engine.wake();
    await f.engine.quiesce();
    f.engine.resolution.classifyEscalationToOperator(
      f.current(),
      escalationId,
      "Repeated bare classification",
      "planner planner-1",
      {
        authority: "bare_classification",
        sourceQuestionId: `ns-escalation-return-${escalationId}-project`,
      },
    );
    await f.engine.wake();
    await f.engine.quiesce();

    assert.equal(asks, 2, "one initial ask and one return ask; no infinite loop");
    assert.equal(f.events("planner_escalation_returned").length, 1);
    assert.equal(f.events("planner_escalation_return_exhausted").length, 1);
    assert.equal(new Decisions(f.store).list({ task: task.id }).length, 0);
    assert.equal(
      f.current().resolution.stop?.detail,
      escalationWaitDetail.returnedNoPlanner(escalationId),
    );
    assert.equal(f.store.runs(task.id).length, runsAtPark);
  } finally {
    await f.close();
  }
});

test("a restart with an unknown closed return delegation does not resend or loop", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  let asks = 0;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async () => {
    asks += 1;
    return null;
  };
  try {
    f.store.upsertProject({
      key: "app",
      name: "App",
      repositories: [{ origin: null, path: join(f.dir, "repo") }],
    });
    f.store.setProjectPlanner({
      key: "app",
      agentId: "planner-1",
      setBy: "operator",
    });
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked");
    await until(() => f.events("planner_escalation").length > 0);
    const task = f.current();
    const escalationId = f
      .events("planner_escalation")[0]!
      .detail.split(":", 1)[0]!;

    // Stop the engine before recording a returned round with an unknown closed delivery.
    await f.engine.stop();
    f.store.event(
      task.id,
      "planner_escalation_returned",
      `${escalationId}: ${JSON.stringify({ who: "planner planner-1", reason: "defer", sourceQuestionId: `ns-escalation-${escalationId}-project` })}`,
    );
    const returnQid = `ns-escalation-return-${escalationId}-project`;
    f.store.event(task.id, "planner_escalation_return_sent", `${escalationId}: sent`);
    f.store.event(`delegation:${returnQid}`, "delegated_closed", "unknown shutdown");

    asks = 0;
    const restarted = new Engine(f.store, f.adapter, 0);
    try {
      await restarted.resolution.resumeAskQuestions();
      await restarted.wake();
      await restarted.quiesce();
      assert.equal(asks, 0, "unknown delivery must never resend");
      assert.ok(
        f.store
          .eventsAll(task.id)
          .some(
            (event) =>
              event.kind === "planner_escalation_unknown" &&
              event.detail.startsWith(`${escalationId}:`),
          ),
      );
      assert.equal(new Decisions(f.store).list({ task: task.id }).length, 0);
    } finally {
      await restarted.stop();
    }
  } finally {
    await f.close();
  }
});

test("still-open legacy placeholder decisions withdraw and return while answered and non-ladder operator decisions stay intact", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  let asks = 0;
  (f.adapter as unknown as Record<string, unknown>).askPlanner = async (
    _planner: string,
    input: { prompt: string; messageId?: string },
  ) => {
    if (!input.messageId?.startsWith("ns-escalation-return-")) return null;
    asks += 1;
    f.delegated.planner.push(input);
    return "Choice: Return to the worker with a new approach\nReason: Re-scope the legacy blocker cleanly";
  };
  try {
    f.store.upsertProject({
      key: "app",
      name: "App",
      repositories: [{ origin: null, path: join(f.dir, "repo") }],
    });
    f.store.setProjectPlanner({
      key: "app",
      agentId: "planner-1",
      setBy: "operator",
    });
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked");
    await until(() => f.events("planner_escalation").length > 0);
    const task = f.current();
    const escalationId = f
      .events("planner_escalation")[0]!
      .detail.split(":", 1)[0]!;

    const decisions = new Decisions(f.store);
    // 1. Legacy placeholder ladder decision (no stored choices/options).
    const legacy = decisions.add({
      question: `Blocker escalation ${escalationId} on task cannot be settled by the planner.`,
      askedBy: "origin",
      tasks: [task.id],
    });
    // 2. Genuinely operator-owned permission request / ask decision without choices.
    const nativePerm = decisions.add({
      question: "Approve running native permission tool?",
      askedBy: "worker",
      tasks: [task.id],
    });
    f.store.event(task.id, "native_question_operator", `req-1: decision ${nativePerm.id}`);
    // 3. Standalone unrelated decision without choices.
    const standalone = decisions.add({
      question: "Standalone operator note question",
      askedBy: "origin",
      tasks: [task.id],
    });

    f.store.event(
      task.id,
      "planner_escalation_decision",
      `${escalationId}: the planner planner-1 said it cannot decide: legacy placeholder`,
    );
    f.store.event(
      task.id,
      "planner_escalation_decision_linked",
      `${escalationId}: decision ${legacy.id}`,
    );
    const stopDetail = escalationWaitDetail.operator(escalationId, legacy.id);
    f.store.event(
      task.id,
      "planner_escalation_wait",
      `${escalationId}: ${JSON.stringify({ kind: "decision", target: legacy.id, stopDetail, stopReason: "escalated" })}`,
    );
    f.engine.resolution.waiting(f.current(), stopDetail, "escalated");

    asks = 0;
    await f.engine.resolution.resumeAskQuestions();
    await until(() => f.events("planner_escalation_applied").length > 0);

    const legacyAfter = decisions.get({ id: legacy.id });
    assert.equal(legacyAfter.status, "withdrawn");
    assert.equal(legacyAfter.withdrawal?.withdrawnBy, "nucleus");
    assert.equal(legacyAfter.answer, null);
    assert.equal(decisions.get({ id: nativePerm.id }).status, "open");
    assert.equal(decisions.get({ id: standalone.id }).status, "open");
    assert.equal(asks, 1);
    assert.ok(f.events("planner_escalation_returned").length === 1);
    assert.ok(
      f
        .events("planner_escalation_wait_superseded")
        .some((event) => event.detail.includes(legacy.id)),
    );
  } finally {
    await f.close();
  }
});

test("already-answered legacy placeholder decisions settle normally without withdrawing", async () => {
  const f = fixture({ responsible: true });
  f.engine.resolution.delegatedAnswerWaitMs = 5000;
  try {
    await f.reviews(1);
    await f.engine.wake();
    await f.report("blocked");
    await until(() => f.events("planner_escalation").length > 0);
    const task = f.current();
    const escalationId = f
      .events("planner_escalation")[0]!
      .detail.split(":", 1)[0]!;

    const decisions = new Decisions(f.store);
    const legacyAnswered = decisions.add({
      question: `Blocker escalation ${escalationId} on task cannot be settled by the planner.`,
      askedBy: "origin",
      tasks: [task.id],
    });
    f.store.event(
      task.id,
      "planner_escalation_decision_linked",
      `${escalationId}: decision ${legacyAnswered.id}`,
    );
    const stopDetail = escalationWaitDetail.operator(
      escalationId,
      legacyAnswered.id,
    );
    f.store.event(
      task.id,
      "planner_escalation_wait",
      `${escalationId}: ${JSON.stringify({ kind: "decision", target: legacyAnswered.id, stopDetail, stopReason: "escalated" })}`,
    );
    f.engine.resolution.waiting(f.current(), stopDetail, "escalated");

    decisions.answer({
      id: legacyAnswered.id,
      version: legacyAnswered.version,
      answer: "Return to the worker with a new approach — honor existing operator answer",
      answeredBy: "operator (board)",
      relayed: false,
      note: "",
    });

    await f.engine.resolution.resumeAskQuestions();
    await until(() => f.events("planner_escalation_answered").length > 0);
    await until(() => f.events("planner_escalation_applied").length > 0);

    const fetched = decisions.get({ id: legacyAnswered.id });
    assert.equal(fetched.status, "answered");
    assert.equal(f.events("planner_escalation_returned").length, 0);
  } finally {
    await f.close();
  }
});
