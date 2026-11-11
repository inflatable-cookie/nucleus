import { Resolution } from '../core/resolution';
import { delegateQuestion } from '../core/questions/planner-delegation';
import { parseNativeDelegatedReply } from '../core/questions/question-delegation';
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { Store, digest } from "../core/store/store";
import { ANSWERING_WINDOW_MS, waitFor } from "./support/budgets";
import { fixture } from "./support/responsible-lifecycle-fixture";

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

for (const responseStarted of [false, true]) {
  test(`native receipt recovery ${responseStarted ? "fences an uncertain response" : "starts an unsent response once"}`, async () => {
    const f = fixture({ delegates: { planner: null } });
    const task = f.current();
    const request = {
      requestId: "permission-recovery",
      questions: [{ header: "Next", question: "How to proceed?", options: [] }],
    };
    const id = digest(`native-question:worker:${request.requestId}`);
    const questionId = `queue-native-${id}-0`;
    f.engine.resolution.delegatedAnswerWaitMs = 1000;
    f.store.event(
      task.id,
      "native_question_delegated",
      `${id}: worker; permission ${request.requestId}`,
    );
    (f.engine.resolution as any).openDelegatedQuestion(
      task,
      questionId,
      "planner-1",
      "Question: How to proceed?",
      1000,
      "planner",
    );
    f.engine.resolution.answerDelegatedQuestion(
      { questionId, answer: "Continue", reason: "Within brief" },
      "planner-1",
    );
    let sends = 0;
    let release!: () => void;
    const pendingResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      ...f.adapter,
      pendingQuestions: async (agent: string) =>
        agent === "worker" ? [request] : [],
      askPlanner: async () => {
        throw Error("Never repeat the delegated question");
      },
      answerNativeQuestion: async () => {
        sends++;
        if (responseStarted) await pendingResponse;
      },
    };
    const first = new Engine(f.store, adapter, 0);
    const recovered = new Engine(f.store, adapter, 0);
    try {
      if (responseStarted) {
        await first.resolution.delegateNativeQuestions();
        await waitFor(() => sends > 0, ANSWERING_WINDOW_MS, "the delegated send");
        assert.equal(sends, 1);
        assert.equal(
          f.store
            .eventsAll(task.id)
            .some((e) => e.kind === "native_question_answered"),
          false,
          "The host response is still unobserved",
        );
      }
      // A fresh service has no in-memory in-flight guard and the host still reports pending.
      for (let i = 0; i < 3; i++) {
        await recovered.resolution.delegateNativeQuestions();
        await pause();
      }
      assert.equal(
        sends,
        1,
        "Recovery must not send an uncertain permission response again",
      );
      assert.equal(
        f.store
          .eventsAll(task.id)
          .filter((e) => e.kind === "native_question_response_intent").length,
        1,
      );
      release();
      await waitFor(() => f.store.eventsAll(task.id).some((e) => e.kind === "native_question_answered"), ANSWERING_WINDOW_MS, "the native answer");
      assert.equal(
        f.store
          .eventsAll(task.id)
          .filter((e) => e.kind === "native_question_answered").length,
        1,
      );
      await recovered.resolution.delegateNativeQuestions();
      assert.equal(sends, 1);
    } finally {
      release();
      await first.stop();
      await recovered.stop();
      await f.close();
    }
  });
}

test("completed unanswered escalation windows stay terminal across maintenance and restart", async () => {
  const f = fixture({ delegates: { planner: null, decider: null } });
  const task = f.current(),
    id = "expired-escalation";
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
  f.store.event(
    task.id,
    "planner_escalation",
    `${id}: cause ${"a".repeat(64)}; run worker; question pending`,
  );
  f.store.event(
    task.id,
    "planner_escalation_payload",
    `${id}: ${JSON.stringify({ question: "How should the blocked worker proceed?" })}`,
  );
  let asks = 0,
    creates = 0,
    archives = 0;
  const adapter = {
    ...f.adapter,
    askPlanner: async () => {
      asks++;
      return null;
    },
    runDecider: async () => {
      creates++;
      return { agentId: "decider-1", text: null };
    },
    archiveAgent: async () => {
      archives++;
    },
  };
  Object.defineProperty(f.engine.resolution, "adapter", { value: adapter });
  f.engine.identifyOriginHost = async () => 'host';
  f.engine.resolution.delegatedAnswerWaitMs = 10;
  const recovered = new Engine(f.store, adapter, 0);
  recovered.identifyOriginHost = async () => 'host';
  recovered.profiles = f.profiles;
  try {
    await (f.engine.resolution as any).routePlannerEscalation(
      task,
      id,
      "How should the blocked worker proceed?",
    );
    assert.deepEqual(
      { asks, creates, archives },
      { asks: 2, creates: 1, archives: 1 },
    );
    const events = f.store.eventsAll(task.id);
    assert.ok(
      events.some(
        (e) =>
          e.kind === "planner_escalation_missed" &&
          e.detail.includes("no delegated answer was produced"),
      ),
    );
    const plannerEvents = f.store.eventsAll(`delegation:ns-escalation-${id}`);
    const deciderEvents = f.store.eventsAll(`delegation:ns-decider-${id}`);
    for (const service of [f.engine, recovered]) {
      for (let i = 0; i < 3; i++) {
        await service.resolution.resumeAskQuestions();
        await pause();
      }
    }
    assert.deepEqual(
      { asks, creates, archives },
      { asks: 2, creates: 1, archives: 1 },
    );
    assert.deepEqual(f.store.eventsAll(task.id), events);
    assert.deepEqual(
      f.store.eventsAll(`delegation:ns-escalation-${id}`),
      plannerEvents,
    );
    assert.deepEqual(
      f.store.eventsAll(`delegation:ns-decider-${id}`),
      deciderEvents,
    );
  } finally {
    await recovered.stop();
    await f.close();
  }
});


for (const outcome of ['unobserved', 'sent', 'answered'] as const) {
  test(`planner recovery after a crash preserves ${outcome} delivery evidence in the journal`, async () => {
    const f = fixture({ delegates: { planner: null } });
    const task = f.current();
    const id = `crash-${outcome}`;
    const messageId = `ns-agent-ask-${id}`;
    const key = `delegation:${messageId}`;
    let stopped = false, sends = 0, deciders = 0, unknowns = 0;
    let release!: () => void;
    const pendingSend = new Promise<void>(resolve => { release = resolve; });
    const adapter = {
      ...f.adapter,
      askPlanner: async (agent: string) => {
        if (agent === 'planner-1') { sends++; await pendingSend; }
        return null;
      },
      runDecider: async () => { deciders++; return { agentId: 'decider-recovered', text: null }; },
    };
    const original = new Resolution(f.store, adapter, () => f.profiles, () => stopped);
    original.identifyOriginHost = async () => 'host';
    original.delegatedAnswerWaitMs = 500;
    const observing = original.askBound(task, 'planner-1', {
      prompt: 'Question: Proceed?', signal: new AbortController().signal,
      timeoutMs: 500, messageId,
    }, 'planner');
    // Attach before stopping the simulated process so its rejection is observed.
    const interrupted = assert.rejects(observing, /observation stopped/);
    let journal: Store | undefined;
    let recovered: Engine | undefined;
    try {
      await waitFor(() => sends === 1, ANSWERING_WINDOW_MS, 'the original host call');
      if (outcome === 'sent') {
        release();
        await waitFor(() => f.store.eventsAll(key).some(event => event.kind === 'delegated_sent'), ANSWERING_WINDOW_MS, 'the positive send observation');
      }
      stopped = true;
      release();
      await interrupted;
      assert.equal(f.store.eventsAll(key).some(event => event.kind === 'delegated_closed'), false);
      // Reopen the on-disk journal with a fresh service, not an in-memory delivery mock.
      journal = new Store(f.store.path);
      recovered = new Engine(journal, adapter, 0);
      recovered.profiles = f.profiles;
      recovered.identifyOriginHost = async () => 'host';
      recovered.resolution.delegatedAnswerWaitMs = 10;
      if (outcome === 'answered') recovered.resolution.answerDelegatedQuestion({
        questionId: messageId, answer: 'Continue', reason: 'The original question arrived',
      }, 'planner-1');
      const input = {
        planner: 'planner-1', plannerMessageId: messageId, decisionId: id,
        context: { question: 'Proceed?', choices: [], context: [] },
        signal: new AbortController().signal, parse: parseNativeDelegatedReply,
        onIntent: () => {}, onMiss: () => {}, onUnknown: () => { unknowns++; },
      };
      const result = await delegateQuestion(recovered.resolution, task, input);
      assert.equal(sends, 1, 'a restart never resends the planner question');
      if (outcome === 'unobserved') {
        assert.equal(result, null);
        assert.equal(unknowns, 1);
        assert.equal(deciders, 0, 'an expired unobserved send cannot open a decider rung');
        assert.match(journal.eventsAll(key).findLast(event => event.kind === 'delegated_closed')!.detail, /unknown/);
        await delegateQuestion(recovered.resolution, task, input);
        assert.equal(deciders, 0, 'uncertainty remains fenced on the next recovery');
      } else if (outcome === 'sent') {
        assert.equal(deciders, 1, 'a positively observed send can expire into a known miss');
        assert.equal(unknowns, 0);
      } else {
        assert.equal(result?.role, 'planner', 'an authenticated answer settles the original window');
        assert.equal(deciders, 0);
        assert.equal(unknowns, 0);
      }
    } finally {
      stopped = true;
      release();
      await interrupted;
      await recovered?.stop();
      journal?.close();
      await f.close();
    }
  });
}
