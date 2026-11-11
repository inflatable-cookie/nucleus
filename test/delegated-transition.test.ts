import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { digest } from "../core/store/store";
import { ANSWERING_WINDOW_MS, waitFor } from "./support/budgets";
import { fixture } from "./support/responsible-lifecycle-fixture";

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
const question = "How should this task proceed?";
type Route = "ask" | "native" | "escalation" | "decision" | "reviewer";

function transitionFixture(
  route: Route,
  mode:
    | "answer"
    | "unknown"
    | "unobserved"
    | "next-unknown"
    | "complete"
    | "ineligible" = "answer",
) {
  const f = fixture({ delegates: { planner: null } });
  const task = f.current();
  const request = {
    requestId: "transition-permission",
    questions: [{ header: "Next", question, options: [] }],
  };
  const id =
    route === "native"
      ? digest(`native-question:worker:${request.requestId}`)
      : `transition-${route}`;
  const deliveryId =
    route === "native"
      ? `queue-native-${id}-0`
      : route === "escalation"
        ? `ns-escalation-${id}`
        : route === "decision"
          ? `queue-delegate-${id}`
          : route === "reviewer"
            ? `ns-agent-ask-reviewer-${id}`
            : `ns-agent-ask-${id}`;
  const deciderId = `ns-decider-${id}${route === "native" ? "-0" : ""}`;
  // Task 1109: the task planner is the first rung; the project planner is the second.
  const projectDeliveryId = `${deliveryId}-project`;
  f.store.upsertProject({
    key: "app",
    name: "App",
    repositories: [{ origin: null, path: task.repoPath }],
  });
  f.store.setProjectPlanner({
    key: "app",
    agentId: "planner-1",
    setBy: "operator",
  });
  if (route === "ask" || route === "reviewer") {
    f.store.event(
      task.id,
      "agent_ask",
      `${id}: kind process; run initial (worker)`,
    );
    f.store.event(
      task.id,
      "agent_ask_payload",
      JSON.stringify({
        id,
        kind: "process",
        question,
        choices: [],
        ...(route === "reviewer" ? { target: "reviewer" } : {}),
      }),
    );
    f.store.event(
      task.id,
      "agent_ask_delegated",
      `${id}: ${route === "reviewer" ? "reviewer reviewer-1; consult" : "planner planner-1; asked"}`,
    );
    if (route === "reviewer")
      f.store.update(task.id, {
        resolution: { ...task.resolution, reviewerAgentId: "reviewer-1" },
      });
  } else if (route === "native") {
    f.store.event(
      task.id,
      "native_question_delegated",
      `${id}: worker; permission ${request.requestId}`,
    );
  } else if (route === "escalation") {
    f.store.event(
      task.id,
      "planner_escalation",
      `${id}: cause ${"a".repeat(64)}; run worker; question pending`,
    );
    f.store.event(
      task.id,
      "planner_escalation_payload",
      `${id}: ${JSON.stringify({ question })}`,
    );
    f.store.event(task.id, "planner_escalation_sent", `${id}: sent`);
  } else {
    f.store.event(task.id, "responsible_question", `${id}: head pending`);
    f.store.event(
      task.id,
      "delegated_decision_route",
      JSON.stringify({
        decision: { id, kind: "review", question, options: ["Continue"] },
        request: null,
      }),
    );
  }
  const journal = (key: string, recipient: string, role: string) => {
    f.store.event(
      `delegation:${key}`,
      "delegated_delivery",
      JSON.stringify({
        taskId: task.id,
        recipient,
        role,
        prompt: `Question: ${question}`,
        deadline: Date.now() - 1000,
      }),
    );
    if (mode !== "unknown" && mode !== "unobserved")
      f.store.event(`delegation:${key}`, "delegated_sent", "Host send completed");
    f.store.event(
      `delegation:${key}`,
      "delegated_closed",
      mode === "unknown"
        ? "Delivery outcome unknown; never resend"
        : "No command answer in the window",
    );
  };
  journal(
    deliveryId,
    route === "reviewer" ? "reviewer-1" : "planner-1",
    route === "reviewer" ? "reviewer" : "planner",
  );
  if (route !== "reviewer" && mode !== "unknown" && mode !== "unobserved" && mode !== "next-unknown")
    journal(projectDeliveryId, "planner-2", "planner");
  if (mode === "complete") journal(deciderId, "decider-old", "decider");
  if (mode === "next-unknown") {
    const kind =
      route === "native"
        ? "native_question_unknown"
        : route === "escalation"
          ? "planner_escalation_unknown"
          : route === "decision"
            ? "operator_question_delegation_unknown"
            : "agent_ask_delegation_unknown";
    f.store.event(
      task.id,
      kind,
      `${id}: decider creation or dispatch outcome unknown; never retry`,
    );
  }
  const originalJournal = f.store.eventsAll(`delegation:${deliveryId}`);
  const counters = {
    plannerSends: 0,
    taskPlannerSends: 0,
    reviewerSends: 0,
    deciderCreates: 0,
    deciderSends: 0,
    nativeAnswers: 0,
  };
  let current: Engine;
  const adapter = {
    ...f.adapter,
    pendingQuestions: async (agent: string) =>
      agent === "worker" ? [request] : [],
    answerNativeQuestion: async () => {
      counters.nativeAnswers++;
    },
    askReviewer: async () => {
      counters.reviewerSends++;
      throw Error("Never resend to reviewer");
    },
    askPlanner: async (recipient: string, input: { prompt: string }) => {
      if (recipient === "planner-1" || recipient === "planner-2") counters.plannerSends++;
      else if (recipient === "origin") counters.taskPlannerSends++;
      else counters.deciderSends++;
      if ((recipient === "planner-1" || recipient === "planner-2") && route !== "reviewer")
        throw Error("Never resend to planner");
      if (route === "reviewer" && recipient === "origin") {
        // The task planner answers the escalated reviewer miss.
        current.resolution.answerDelegatedQuestion({ questionId: input.prompt.match(/^Question id: (.+)$/m)![1], answer: "Continue", reason: "Within the brief" }, recipient);
        return null;
      }
      current.resolution.answerDelegatedQuestion(
        {
          questionId: input.prompt.match(/^Question id: (.+)$/m)![1],
          answer: route === "escalation" ? "Wait until a time (put an ISO timestamp in Reason)" : "Continue",
          reason: route === "escalation" ? "2099-01-01T00:00:00Z" : "Within the brief",
        },
        recipient,
      );
      return null;
    },
    runDecider: async () => {
      counters.deciderCreates++;
      return { agentId: "decider-1", text: null };
    },
    archiveAgent: async () => {},
  };
  const fresh = () => {
    const engine = new Engine(f.store, adapter, 0);
    current = engine;
    engine.profiles = mode === "ineligible" ? [] : f.profiles;
    engine.resolution.delegatedAnswerWaitMs = ANSWERING_WINDOW_MS;
    return engine;
  };
  const drive = async (engine: Engine) => {
    if (route === "native") await engine.resolution.delegateNativeQuestions();
    else await engine.resolution.resumeAskQuestions();
  };
  const answered = () =>
    f.store
      .eventsAll(task.id)
      .some(
        (event) =>
          event.kind ===
          (route === "native"
            ? "native_question_answered"
            : route === "escalation"
              ? "planner_escalation_answered"
              : route === "decision"
                ? "responsible_question_answered"
                : "agent_ask_answered"),
      );
  return {
    f,
    task,
    id,
    deliveryId,
    deciderId,
    originalJournal,
    counters,
    fresh,
    drive,
    answered,
  };
}

for (const route of [
  "ask",
  "native",
  "escalation",
  "decision",
] as const) {
  test(`${route}: restart after known first-rung miss advances once without renewing its window`, async () => {
    const t = transitionFixture(route);
    const first = t.fresh(),
      second = t.fresh();
    try {
      await t.drive(first);
      await waitFor(t.answered, ANSWERING_WINDOW_MS, "the delegated answer");
      assert.equal(t.counters.reviewerSends, 0);
      assert.equal(t.counters.plannerSends, 0, 'neither recorded planner window is sent again');
      assert.equal(t.counters.taskPlannerSends, 0);
      assert.equal(t.counters.deciderCreates, 1);
      assert.equal(t.counters.deciderSends, 1);
      assert.deepEqual(
        t.f.store.eventsAll(`delegation:${t.deliveryId}`),
        t.originalJournal,
        "The original deadline and closed journal remain unchanged",
      );
      const before = { ...t.counters };
      await first.stop();
      for (let i = 0; i < 3; i++) {
        await t.drive(second);
        await pause();
      }
      assert.deepEqual(
        t.counters,
        before,
        "A second restart cannot send or create again",
      );
      assert.equal(
        t.f.store
          .eventsAll(`delegation:${t.deciderId}`)
          .filter((e) => e.kind === "delegated_delivery").length,
        1,
      );
    } finally {
      await first.stop();
      await second.stop();
      await t.f.close();
    }
  });
}

// Task 730 brief: a known reviewer miss advances once across restart.
test("reviewer: a known miss advances across restart without renewing its window", async () => {
  const t = transitionFixture("reviewer");
  const first = t.fresh(), second = t.fresh();
  try {
    await t.drive(first);
    await first.stop();
    for (let i = 0; i < 3; i++) { await t.drive(second); await pause(); }
    assert.equal(t.counters.reviewerSends, 0);
    assert.equal(t.counters.plannerSends, 0, 'the recorded reviewer window is never resent');
    assert.equal(t.counters.taskPlannerSends, 1, 'the task planner answers the escalated consult miss');
    assert.throws(() => second.resolution.answerDelegatedQuestion(
      { questionId: t.deliveryId, answer: "Late advice", reason: "Late" }, "reviewer-1"),
      /answer window has closed/);
    assert.deepEqual(t.f.store.eventsAll(`delegation:${t.deliveryId}`), t.originalJournal);
  } finally { await first.stop(); await second.stop(); await t.f.close(); }
});

for (const route of ["ask", "native", "escalation", "decision"] as const) {
  for (const mode of [
    "unknown",
    "unobserved",
    "next-unknown",
    "complete",
    "ineligible",
  ] as const) {
    test(`${route}: ${mode} remains terminal across repeated maintenance and restart`, async () => {
      const t = transitionFixture(route, mode);
      const first = t.fresh(),
        second = t.fresh();
      try {
        for (let i = 0; i < 3; i++) {
          await t.drive(first);
          await pause();
        }
        const settledEvents = t.f.store.eventsAll(t.task.id);
        const settledJournal = t.f.store.eventsAll(`delegation:${t.deliveryId}`);
        if (mode === "unobserved")
          assert.match(settledJournal.findLast(event => event.kind === "delegated_closed")!.detail, /unknown/);
        await first.stop();
        for (let i = 0; i < 3; i++) {
          await t.drive(second);
          await pause();
        }
        assert.deepEqual(
          t.f.store.eventsAll(t.task.id),
          settledEvents,
          "Terminal maintenance must not append repeated misses",
        );
        assert.deepEqual(t.counters, {
          plannerSends: 0,
          taskPlannerSends: 0,
          reviewerSends: 0,
          deciderCreates: 0,
          deciderSends: 0,
          nativeAnswers: 0,
        });
        assert.equal(t.answered(), false);
        assert.deepEqual(
          t.f.store.eventsAll(`delegation:${t.deliveryId}`),
          mode === "unobserved" ? settledJournal : t.originalJournal,
        );
        if (mode === "complete")
          assert.equal(
            t.f.store
              .eventsAll(`delegation:${t.deciderId}`)
              .filter((e) => e.kind === "delegated_delivery").length,
            1,
          );
      } finally {
        await first.stop();
        await second.stop();
        await t.f.close();
      }
    });
  }
}
