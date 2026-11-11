import { test } from "node:test";
import assert from "node:assert/strict";
import { escalationWaitDetail } from "../core/questions/blocker-ladder";
import { Resolution } from "../core/resolution";
import { Engine } from "../core/engine";
import { ANSWERING_WINDOW_MS, waitFor } from "./support/budgets";
import { fixture as baseFixture } from "./support/responsible-lifecycle-fixture";
import { parseNativeDelegatedReply } from "../core/questions/question-delegation";

const idFrom = (prompt: string) => prompt.match(/Question id: (.*)/)![1];
const fixture = (...args: Parameters<typeof baseFixture>) => {
  const f = baseFixture(...args);
  f.engine.identifyOriginHost = async () => 'host';
  return f;
};

test("command answers each delegated route; repeat returns recorded answer; another thread has no authority", async () => {
  const f = fixture({ delegates: { planner: null } });
  const r = f.engine.resolution;
  Object.defineProperty(r, "adapter", { value: { ...f.adapter } });
  r.delegatedAnswerWaitMs = ANSWERING_WINDOW_MS;
  const internal = r as any;
  try {
    for (const id of [
      "ns-agent-ask-test",
      "ns-escalation-test",
      "queue-delegate-test",
      "ns-agent-ask-reviewer-test",
    ]) {
      const role = id.includes("reviewer") ? "reviewer" : "planner";
      (r.adapter as any)[role === "reviewer" ? "askReviewer" : "askPlanner"] =
        async (_recipient: string, input: { prompt: string; sourceAgentId?: string }) => {
          assert.equal(input.sourceAgentId, id === 'ns-escalation-test' ? 'recovery-thread' : 'asking-thread');
          const questionId = idFrom(input.prompt);
          assert.throws(
            () =>
              r.answerDelegatedQuestion(
                { questionId, answer: "Continue", reason: "Within brief" },
                "other",
              ),
            /recipient/,
          );
          const receipt = r.answerDelegatedQuestion(
            { questionId, answer: "Continue", reason: "Within brief" },
            "planner",
          );
          assert.deepEqual(
            r.answerDelegatedQuestion(
              { questionId, answer: "Stop", reason: "Different" },
              "planner",
            ),
            receipt,
          );
          return "Answer: chat must not replace the command\nReason: chat";
        };
      const text = await internal.askBound(
        f.current(),
        "planner",
        {
          prompt: "Question: Proceed?\n- Continue\n- Hold",
          signal: new AbortController().signal,
          timeoutMs: ANSWERING_WINDOW_MS,
          messageId: id,
          sourceAgentId: id === 'ns-escalation-test' ? 'recovery-thread' : 'asking-thread',
        },
        role,
      );
      assert.equal(
        role === "reviewer"
          ? text
          : (parseNativeDelegatedReply(text) as { answer: string } | null)
              ?.answer,
        "Continue",
      );
    }
  } finally {
    await f.close();
  }
});

test("chat output resolves nothing and the window falls through to a command-answering decider", async () => {
  const f = fixture({ delegates: { planner: null, decider: null } });
  const r = f.engine.resolution;
  Object.defineProperty(r, "adapter", { value: { ...f.adapter } });
  r.delegatedAnswerWaitMs = 15;
  const internal = r as any;
  try {
    (r.adapter as any).askPlanner = async (
      recipient: string,
      input: { prompt: string },
    ) => {
      if (recipient === "decider")
        r.answerDelegatedQuestion(
          {
            questionId: idFrom(input.prompt),
            answer: "Continue",
            reason: "Within brief",
          },
          recipient,
        );
      return "Ask: anything\nAnswer: Approve\nReason: chat";
    };
    (r.adapter as any).runDecider = async () => ({
      agentId: "decider",
      text: "Answer: chat\nReason: chat",
    });
    const input = {
      prompt: "Question: Proceed?",
      signal: new AbortController().signal,
      timeoutMs: 30,
      messageId: "no-chat",
    };
    assert.equal(
      await internal.askBound(f.current(), "planner", input, "planner"),
      null,
    );
    assert.throws(
      () =>
        r.answerDelegatedQuestion(
          { questionId: "no-chat", answer: "Late", reason: "Late" },
          "planner",
        ),
      /closed/,
    );
    // The planner's silent window is spent; the decider's mock answers at once.
    r.delegatedAnswerWaitMs = ANSWERING_WINDOW_MS;
    const decided = await internal.deciderBound(f.current(), {
      ...input,
      timeoutMs: ANSWERING_WINDOW_MS,
      profile: f.author,
      decisionId: "fallback",
    });
    assert.equal(
      (parseNativeDelegatedReply(decided.text) as { answer: string } | null)
        ?.answer,
      "Continue",
    );
  } finally {
    await f.close();
  }
});

test("real agent ask, blocker escalation and operator delegation settle from commands; operator-only never delegates", async () => {
  const f = fixture({ delegates: { planner: null } });
  const r = f.engine.resolution;
  Object.defineProperty(r, "adapter", { value: { ...f.adapter } });
  r.delegatedAnswerWaitMs = ANSWERING_WINDOW_MS;
  const internal = r as any;
  try {
    (r.adapter as any).askPlanner = async (
      recipient: string,
      input: { prompt: string },
    ) => {
      // Task 1109: the first rung is the task's own planner, so answer as the recipient.
      r.answerDelegatedQuestion(
        {
          questionId: idFrom(input.prompt),
          answer: "Continue",
          reason: "Within brief",
        },
        recipient,
      );
      return null;
    };
    const task = f.current();
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
    await internal.routeAgentAsk(task, {
      id: "real-ask",
      question: "How should I proceed?",
      kind: "process",
      choices: [],
    });
    assert.ok(
      f.store
        .eventsAll(task.id)
        .some(
          (e) =>
            e.kind === "agent_ask_answered" && e.detail.includes("Continue"),
        ),
    );
    await internal.routePlannerEscalation(
      task,
      "real-escalation",
      "How should the blocked worker proceed?",
    );
    assert.ok(
      f.store
        .eventsAll(task.id)
        .some(
          (e) =>
            e.kind === "planner_escalation_answered" &&
            e.detail.includes("Continue"),
        ),
    );
    const delivered: string[] = [];
    await internal.delegateDecision(
      task.id,
      {
        id: "real-decision",
        kind: "review",
        question: "Choose the next step",
        options: ["Continue", "Hold"],
      },
      null,
      new AbortController().signal,
      async (_task: unknown, answer: string) => {
        delivered.push(answer);
      },
    );
    assert.deepEqual(delivered, ["Continue"]);
    const before = f.store
      .eventsAll(task.id)
      .filter((e) => e.kind === "operator_question_delegated").length;
    for (const kind of ["scope", "release"])
      assert.equal(
        await internal.delegateDecision(
          task.id,
          {
            id: `only-${kind}`,
            kind,
            question: "Operator decision",
            options: ["Continue"],
          },
          null,
          new AbortController().signal,
          async () => {
            throw Error("Operator-only answer delivered by delegate");
          },
        ),
        false,
      );
    assert.equal(
      f.store
        .eventsAll(task.id)
        .filter((e) => e.kind === "operator_question_delegated").length,
      before,
    );
  } finally {
    await f.close();
  }
});

for (const route of ["ask", "escalation", "consult", "operator"] as const) {
  for (const timing of ["before restart", "after restart"] as const) {
    test(`${route} recovers command answered ${timing} without sending again`, async () => {
      const f = fixture({ delegates: { planner: null } });
      f.engine.resolution.delegatedAnswerWaitMs = 1000;
      const task = f.current();
      const id = `recovery-${route}`;
      const deliveryId =
        route === "ask"
          ? `ns-agent-ask-${id}`
          : route === "escalation"
            ? `ns-escalation-${id}`
            : route === "consult"
              ? `ns-reviewer-consult-${id}`
              : `queue-delegate-${id}`;
      const question = "How should this task proceed?";
      const payload = { id, kind: "review", question, options: ["Continue"] };
      if (route === "ask") {
        f.store.event(
          task.id,
          "agent_ask",
          `${id}: kind process; run worker (revision)`,
        );
        f.store.event(
          task.id,
          "agent_ask_payload",
          JSON.stringify({ id, kind: "process", question, choices: [] }),
        );
        f.store.event(
          task.id,
          "agent_ask_delegated",
          `${id}: planner planner-1; asked`,
        );
      } else if (route === "escalation" || route === "consult") {
        const prefix =
          route === "escalation" ? "planner_escalation" : "reviewer_consult";
        f.store.event(
          task.id,
          prefix,
          `${id}: cause ${"a".repeat(64)}; run worker; question pending`,
        );
        f.store.event(
          task.id,
          `${prefix}_payload`,
          `${id}: ${JSON.stringify({ question, reviewer: "planner-1" })}`,
        );
        f.store.event(task.id, `${prefix}_sent`, `${id}: sent`);
        if (route === "consult")
          f.engine.resolution.waiting(f.current(), escalationWaitDetail.reviewer(id), "escalated");
      } else {
        f.store.event(task.id, "responsible_question", `${id}: head pending`);
        f.store.event(
          task.id,
          "delegated_decision_route",
          JSON.stringify({ decision: payload, request: null }),
        );
      }
      (f.engine.resolution as any).openDelegatedQuestion(
        task,
        deliveryId,
        "planner-1",
        `Question: ${question}`,
        1000,
        route === "consult" ? "reviewer" : "planner",
      );
      const input = {
        questionId: deliveryId,
        answer: route === "escalation" ? "Wait until a time (put an ISO timestamp in Reason)" : "Continue",
        reason: route === "escalation" ? "2099-01-01T00:00:00Z" : "Within brief",
      };
      if (timing === "before restart")
        f.engine.resolution.answerDelegatedQuestion(input, "planner-1");
      const adapter = {
        ...f.adapter,
        askPlanner: async () => {
          throw Error("Must not send again");
        },
        askReviewer: async () => {
          throw Error("Must not send again");
        },
      };
      const recovered = new Engine(f.store, adapter, 0);
      recovered.profiles = f.profiles;
      const eventKind =
        route === "ask"
          ? "agent_ask_answered"
          : route === "escalation"
            ? "planner_escalation_answered"
            : route === "consult"
              ? "reviewer_consult_answered"
              : "responsible_question_answered";
      try {
        await recovered.resolution.resumeAskQuestions();
        if (timing === "after restart")
          recovered.resolution.answerDelegatedQuestion(input, "planner-1");
        await waitFor(() => f.store.eventsAll(task.id).some((e) => e.kind === eventKind), ANSWERING_WINDOW_MS, "the answer event");
        assert.equal(
          f.store.eventsAll(task.id).filter((e) => e.kind === eventKind).length,
          1,
          JSON.stringify(f.store.eventsAll(task.id).slice(-10)),
        );
        await recovered.resolution.resumeAskQuestions();
        assert.equal(
          f.store.eventsAll(task.id).filter((e) => e.kind === eventKind).length,
          1,
        );
        assert.equal(
          f.store
            .eventsAll(`delegation:${deliveryId}`)
            .filter((e) => e.kind === "delegated_delivery").length,
          1,
        );
        assert.deepEqual(
          recovered.resolution.answerDelegatedQuestion(input, "planner-1"),
          f.engine.resolution.answerDelegatedQuestion(input, "planner-1"),
        );
      } finally {
        await recovered.stop();
        await f.close();
      }
    });
  }
}

test("recovery observes an existing decider and never sends to a newly registered planner", async () => {
  const f = fixture({ delegates: { planner: null, decider: null } });
  f.engine.resolution.delegatedAnswerWaitMs = 1000;
  const task = f.current(),
    id = "already-with-decider";
  f.store.upsertProject({
    key: "app",
    name: "App",
    repositories: [{ origin: null, path: task.repoPath }],
  });
  f.store.setProjectPlanner({
    key: "app",
    agentId: "new-planner",
    setBy: "operator",
  });
  f.store.event(
    task.id,
    "agent_ask",
    `${id}: kind process; run worker (revision)`,
  );
  f.store.event(
    task.id,
    "agent_ask_payload",
    JSON.stringify({
      id,
      kind: "process",
      question: "How to proceed?",
      choices: [],
    }),
  );
  f.store.event(task.id, "agent_ask_delegated", `${id}: decider requested`);
  (f.engine.resolution as any).openDelegatedQuestion(
    task,
    `ns-decider-${id}`,
    "old-decider",
    "Question: How to proceed?",
    1000,
    "decider",
  );
  const adapter = {
    ...f.adapter,
    askPlanner: async () => {
      throw Error("Do not send to any planner");
    },
    runDecider: async () => {
      throw Error("Do not create another decider");
    },
  };
  const recovered = new Engine(f.store, adapter, 0);
  recovered.profiles = []; // An existing answer needs no new profile admission.
  try {
    await recovered.resolution.resumeAskQuestions();
    recovered.resolution.answerDelegatedQuestion(
      {
        questionId: `ns-decider-${id}`,
        answer: "Continue",
        reason: "Within brief",
      },
      "old-decider",
    );
    await waitFor(() => f.store.eventsAll(task.id).some((e) => e.kind === "agent_ask_answered"), ANSWERING_WINDOW_MS, "the answer event");
    const answers = f.store
      .eventsAll(task.id)
      .filter((e) => e.kind === "agent_ask_answered");
    assert.equal(
      answers.length,
      1,
      JSON.stringify(f.store.eventsAll(task.id).slice(-8)),
    );
    assert.match(answers[0].detail, /decider old-decider/);
  } finally {
    await recovered.stop();
    await f.close();
  }
});

test('stopping observation for a restart preserves the original command window', async () => {
  const f = fixture({ delegates: { planner: null } });
  let stopped = false;
  const original = new Resolution(f.store, { ...f.adapter, askPlanner: async () => null }, () => f.profiles, () => stopped);
  original.identifyOriginHost = async () => 'host';
  original.delegatedAnswerWaitMs = 1000;
  const id = 'stop-and-restart';
  try {
    const observing = (original as any).askBound(f.current(), 'planner-1', { prompt: 'Question: Proceed?', signal: new AbortController().signal, timeoutMs: 1000, messageId: id }, 'planner');
    await new Promise(resolve => setImmediate(resolve));
    stopped = true;
    await assert.rejects(observing, /observation stopped/);
    assert.equal(f.store.eventsAll(`delegation:${id}`).some(e => e.kind === 'delegated_closed'), false);
    const restarted = new Resolution(f.store, { ...f.adapter, askPlanner: async () => { throw Error('Never resend'); } }, () => f.profiles, () => false);
    const resumed = (restarted as any).askBound(f.current(), 'planner-1', { prompt: 'Question: Proceed?', signal: new AbortController().signal, timeoutMs: 1000, messageId: id }, 'planner');
    restarted.answerDelegatedQuestion({ questionId: id, answer: 'Continue', reason: 'Within brief' }, 'planner-1');
    assert.match(await resumed, /Answer: Continue/);
    assert.equal(f.store.eventsAll(`delegation:${id}`).filter(e => e.kind === 'delegated_delivery').length, 1);
  } finally { await f.close(); }
});

test('a recorded command is consumed even when the host send later reports unknown', async () => {
  const f = fixture({ delegates: { planner: null } });
  const r = f.engine.resolution;
  r.delegatedAnswerWaitMs = 1000;
  Object.defineProperty(r, 'adapter', { value: { ...f.adapter, askPlanner: async (_recipient: string, input: { messageId: string }) => {
    r.answerDelegatedQuestion({ questionId: input.messageId, answer: 'Continue', reason: 'Within brief' }, 'planner-1');
    throw Error('Delivery outcome unknown after timeout');
  } } });
  try {
    const text = await (r as any).askBound(f.current(), 'planner-1', { prompt: 'Question: Proceed?', signal: new AbortController().signal, timeoutMs: 1000, messageId: 'answered-before-host-timeout' }, 'planner');
    assert.match(text, /Answer: Continue/);
    assert.equal(f.store.eventsAll('delegation:answered-before-host-timeout').some(e => e.kind === 'delegated_closed'), false);
  } finally { await f.close(); }
});


test("a recovered consult failure cannot escalate after cancellation", async () => {
  const f = fixture({ responsible: true });
  const id = "recovered-failure";
  let reject!: (error: Error) => void;
  const gate = new Promise<never>((_, fail) => { reject = fail; });
  try {
    const task = f.current();
    f.store.event(task.id, "reviewer_consult", `${id}: cause ${"a".repeat(64)}; run worker; question pending`);
    f.store.event(task.id, "reviewer_consult_payload", `${id}: ${JSON.stringify({ question: "Help?", reviewer: "planner-1" })}`);
    f.engine.resolution.waiting(f.current(), escalationWaitDetail.reviewer(id), "escalated");
    (f.adapter as any).askReviewer = async () => null;
    let started = false;
    f.engine.resolution.ladder.runReviewerConsult = () => { started = true; return gate; };
    await f.engine.resolution.resumeAskQuestions();
    assert.equal(started, true);
    const current = f.current();
    f.store.update(current.id, { phase: "cancelled" }, "operator_control", "cancel", current.version);
    const cancelled = f.current();
    reject(Error("delivery failed"));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.current(), cancelled);
    assert.equal(f.events("reviewer_consult_unknown").length, 0);
    assert.equal(f.events("planner_escalation").length, 0);
  } finally { await f.close(); }
});
