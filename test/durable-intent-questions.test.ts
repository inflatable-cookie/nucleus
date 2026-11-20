import assert from "node:assert/strict";
import { test } from "node:test";
import { Decisions } from "../core/planning/decisions";
import { RuntimeQuestions } from "../core/runtime/questions";
import { resumeEscalationWaits } from "../core/questions/ladder/resume";
import { escalationWaitState } from "../core/questions/ladder/hold";
import {
  deferredRestart,
  intentFixture,
  lostReply,
} from "./support/intent-restart";
import { observeIdle } from "./support/fakes";

const request = {
  requestId: "request",
  questions: [
    { header: "Colour", question: "Which colour?", options: ["Blue", "Red"] },
  ],
};

test("native_manual_answer_intent records the exact question before a lost reply", async (t) => {
  let pending = true;
  const f = intentFixture(t, {
    pendingQuestions: async () => (pending ? [request] : []),
    answerNativeQuestion: async () => {
      pending = false;
      throw lostReply;
    },
  });
  const questions = new RuntimeQuestions({
    store: f.store,
    engine: f.engine,
    decisions: new Decisions(f.store),
    markStoreAccess() {},
  });
  await deferredRestart(
    t,
    f,
    "native_manual_answer_intent",
    () =>
      assert.rejects(
        questions.answerNativeQuestion({
          taskId: f.id,
          agentId: "worker",
          requestId: "request",
          answers: { Colour: "Blue" },
        }),
        lostReply,
      ),
    "Manual native answer has no restart receipt reader",
    (store) => {
      assert.equal(
        store
          .eventsAll(f.id)
          .filter((e) => e.kind === "native_manual_answer_delivered").length,
        1,
      );
    },
  );
});

for (const kind of [
  "native_question_delegate_intent",
  "native_question_response_intent",
] as const) {
  test(`${kind} is recorded by native question routing before delivery settles`, async (t) => {
    const response = kind === "native_question_response_intent";
    const f = intentFixture(t, {
      pendingQuestions: async () => [request],
      answerNativeQuestion: async () => {
        throw lostReply;
      },
    });
    f.engine.resolution.plannerRungsFor = async () =>
      ({ rungs: [{ agentId: "planner", rung: "task" }] }) as Awaited<
        ReturnType<typeof f.engine.resolution.plannerRungsFor>
      >;
    f.engine.resolution.delegation.requireHost = async () => "host";
    f.engine.resolution.askBound = async (_task, _recipient, input) => {
      // The real askBound records the delegate intent (onIntent) after the window
      // opens and before the send; this stub keeps that order.
      input.onIntent?.();
      if (!response) throw lostReply;
      return "Answer: Blue\nReason: Fixture answer";
    };
    await deferredRestart(
      t,
      f,
      kind,
      async () => {
        const writing = f.engine.resolution.answerNativeQuestions(
          f.id,
          "worker",
          "ws",
          "question",
          request,
          new AbortController().signal,
        );
        if (response) await assert.rejects(writing, lostReply);
        else await writing;
      },
      response
        ? "Native response intent lacks receipt reconciliation"
        : "Delegation can leave a bare intent before the delivery window is recorded",
      (store) => {
        assert.ok(
          store
            .eventsAll(f.id)
            .some((e) => e.kind === "native_question_answered"),
        );
      },
    );
  });
}

test("native_question_dismiss_intent records the superseded native prompt", async (t) => {
  const f = intentFixture(t);
  f.store.event(f.id, "operator_question", "question: test question");
  await deferredRestart(
    t,
    f,
    "native_question_dismiss_intent",
    async () => {
      f.engine.resolution.supersedeOpenOwnerQuestions(
        f.id,
        "Fixture supersession",
      );
    },
    "The dispatch reader does not independently sweep a pending dismissal",
    (store) => {
      assert.ok(
        store
          .eventsAll(f.id)
          .some(
            (e) =>
              e.kind === "native_question_dismissed" &&
              e.detail.startsWith("question:"),
          ),
      );
    },
  );
});

test("native_permission_cancel_intent records the withdrawn permission before a lost reply", async (t) => {
  const f = intentFixture(t, {
    observe: async (id) => ({
      ...(await observeIdle("ws")(id)),
      permissions: true,
      pendingRequest: {
        id: "permission",
        kind: "permission",
        firstLine: "[Queue decision question]",
      },
    }),
    answerNativePermission: async () => {
      throw lostReply;
    },
  });
  f.store.event(f.id, "operator_question_superseded", "question: withdrawn");
  await deferredRestart(
    t,
    f,
    "native_permission_cancel_intent",
    () => f.engine.resolution.resolveWithdrawnPending(f.task()),
    "No independent reader settles a stranded permission cancellation",
    (store) => {
      assert.equal(
        store
          .eventsAll(f.id)
          .filter(
            (e) =>
              e.kind.startsWith("native_permission_cancel_") &&
              e.kind !== "native_permission_cancel_intent",
          ).length,
        1,
      );
    },
  );
});

test("agent_ask_resume_intent fences delivery of the saved answer", async (t) => {
  let sends = 0;
  const f = intentFixture(t, {
    notify: async () => {
      sends++;
      throw lostReply;
    },
  });
  f.store.event(
    f.id,
    "agent_ask",
    "ask: kind process; run worker-run (worker); agent worker; question fixture",
  );
  await deferredRestart(
    t,
    f,
    "agent_ask_resume_intent",
    async () => {
      f.engine.resolution.agentAsks.notifyAskAnswered(
        f.id,
        "ask",
        "Continue",
        "planner",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(sends, 1);
    },
    "The send fence has no observer for a lost answer reply",
    (store) => {
      assert.equal(
        store.eventsAll(f.id).filter((e) => e.kind === "agent_ask_resumed")
          .length,
        1,
      );
      assert.equal(sends, 1);
    },
  );
});

test("reviewer_escalation_direction_intent precedes direction to the retained reader", async (t) => {
  const f = intentFixture(t, {
    observe: async (id) => ({
      ...(await observeIdle("ws")(id)),
      active: true,
      status: "running",
    }),
    steerOrNotify: async () => {
      throw lostReply;
    },
  });
  f.run();
  f.engine.resolution.update(f.task(), {
    incident: {
      id: "incident",
      role: "reviewer",
      runId: "run",
      fingerprint: "fixture",
      attempt: 1,
      cause: "stalled_turn",
      detail: "Fixture reviewer fault",
      action: "",
      status: "reconciling",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  await deferredRestart(
    t,
    f,
    "reviewer_escalation_direction_intent",
    () =>
      f.engine.resolution.settlePlannerEscalation(
        f.task(),
        "escalation",
        "Work: continue the task",
        "operator",
      ),
    "The direction intent has no timeline receipt reader",
    (store) => {
      assert.ok(
        store
          .eventsAll(f.id)
          .some((e) => e.kind === "reviewer_escalation_direction_sent"),
      );
    },
  );
});

test("planner_escalation_wake_intent preserves an interrupted time-wait wake", async (t) => {
  const f = intentFixture(t, {}, { phase: "blocked" });
  const wait = { kind: "time" as const, target: new Date(0).toISOString() };
  const state = escalationWaitState("escalation", wait);
  f.engine.resolution.waiting(f.task(), state.stopDetail, state.stopReason);
  f.store.event(
    f.id,
    "planner_escalation_wait",
    `escalation: ${JSON.stringify(wait)}`,
  );
  f.engine.resolution.applyOperatorControl = async () => {
    throw lostReply;
  };
  await deferredRestart(
    t,
    f,
    "planner_escalation_wake_intent",
    () => resumeEscalationWaits(f.engine.resolution.ladder, f.task()),
    "A bare wake is held as unknown without an applicable retry",
    (store) => {
      assert.ok(
        store.eventsAll(f.id).some((e) => e.kind === "planner_escalation_woke"),
      );
    },
  );
});
