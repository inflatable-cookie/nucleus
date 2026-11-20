import assert from "node:assert/strict";
import { test } from "node:test";
import { ProvenPreSendRefusalError } from "../core/host/errors";
import { Decisions } from "../core/planning/decisions";
import { operatorQuestionRecords } from "../core/questions/question-events";
import { intentFixture } from "./support/intent-restart";

// The native question a worker raises on its T3 thread, as the adapter lists it.
const request = {
  requestId: "request",
  questions: [
    { header: "Colour", question: "Which colour?", options: ["Blue", "Red"] },
  ],
};

type Fixture = ReturnType<typeof intentFixture>;

/** One maintenance pass: the same entry the sweep calls, then its in-flight answers settle. */
async function pass(f: Fixture): Promise<void> {
  f.engine.resolution.delegateNativeQuestions();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** The planners answer with one fixed reply and count how often they were asked. */
function planners(f: Fixture, reply: string, asks: string[]): void {
  f.engine.resolution.plannerRungsFor = async () =>
    ({ rungs: [{ agentId: "planner", rung: "task" }] }) as Awaited<
      ReturnType<typeof f.engine.resolution.plannerRungsFor>
    >;
  f.engine.resolution.delegation.requireHost = async () => "host";
  f.engine.resolution.askBound = async () => {
    asks.push("asked");
    return reply;
  };
}

const kinds = (f: Fixture) => f.store.eventsAll(f.id).map((event) => event.kind);

/** The native question's id, as the maintenance pass derived it for its permission. */
function nativeId(f: Fixture, kind: string): string {
  const event = f.store.eventsAll(f.id).find((row) => row.kind === kind);
  assert.ok(event, `${kind} is recorded`);
  return event.detail.split(":")[0]!;
}

test("a proven pre-send refusal is recorded as refused, and the recorded planner answer is delivered again without asking", async (t) => {
  const delivered: Array<Record<string, string>> = [];
  let pending = true;
  let refuse = true;
  const f = intentFixture(t, {
    pendingQuestions: async () => (pending ? [request] : []),
    answerNativeQuestion: async (_agent, _workspace, _request, answers) => {
      if (refuse) {
        refuse = false;
        throw new ProvenPreSendRefusalError(
          "T3Code send fence refused before delivery: subscribeThread: incomplete projection",
        );
      }
      delivered.push(answers);
      pending = false;
    },
  });
  const asks: string[] = [];
  planners(f, "Answer: Blue\nReason: Fixture answer", asks);
  await pass(f);
  assert.ok(kinds(f).includes("native_question_refused"));
  assert.ok(!kinds(f).includes("native_question_unknown"));
  assert.ok(!kinds(f).includes("native_question_answered"));
  assert.deepEqual(delivered, []);
  // The next pass delivers the recorded answer. The planner is not asked again.
  await pass(f);
  assert.deepEqual(delivered, [{ Colour: "Blue" }]);
  assert.equal(asks.length, 1);
  assert.ok(kinds(f).includes("native_question_answered"));
  await pass(f);
  assert.equal(delivered.length, 1, "a settled answer is never sent again");
});

test("a refused answer the thread answered independently is never sent", async (t) => {
  const delivered: Array<Record<string, string>> = [];
  let pending = true;
  let refuse = true;
  const f = intentFixture(t, {
    pendingQuestions: async () => (pending ? [request] : []),
    answerNativeQuestion: async (_agent, _workspace, _request, answers) => {
      if (refuse) {
        refuse = false;
        throw new ProvenPreSendRefusalError("T3Code thread is no longer observed");
      }
      delivered.push(answers);
    },
  });
  planners(f, "Answer: Blue\nReason: Fixture answer", []);
  await pass(f);
  assert.ok(kinds(f).includes("native_question_refused"));
  // Someone else answered on the thread before the recovery pass.
  pending = false;
  await pass(f);
  assert.deepEqual(delivered, []);
  assert.ok(kinds(f).includes("native_question_stale_answered"));
});

test("an operator escalation raises one card on the task and applies the operator's answer once", async (t) => {
  const delivered: Array<Record<string, string>> = [];
  let pending = true;
  const f = intentFixture(t, {
    pendingQuestions: async () => (pending ? [request] : []),
    answerNativeQuestion: async (_agent, _workspace, _request, answers) => {
      delivered.push(answers);
      pending = false;
    },
  });
  const asks: string[] = [];
  planners(
    f,
    "Decision: operator\nReason: The colour is the operator's to choose",
    asks,
  );
  await pass(f);
  assert.deepEqual(delivered, [], "nothing is sent while the operator decides");
  const id = nativeId(f, "native_question_operator");
  const link = operatorQuestionRecords(f.store.eventsAll(f.id)).get(
    `native-question-${id}-0`,
  )?.link;
  assert.ok(link, "the escalation links one Nucleus decision to the task");
  const card = new Decisions(f.store).get({ id: link.decisionId });
  assert.equal(card.status, "open");
  assert.deepEqual(card.links.tasks, [f.id]);
  // A pass while the card is open re-asks nobody and sends nothing.
  await pass(f);
  assert.deepEqual(delivered, []);
  assert.equal(asks.length, 1);
  // The operator's answer applies to the same permission, once.
  new Decisions(f.store).answer({
    id: card.id,
    version: card.version,
    answer: "Blue",
    answeredBy: "operator",
    relayed: false,
    note: "",
  });
  await pass(f);
  assert.deepEqual(delivered, [{ Colour: "Blue" }]);
  await pass(f);
  assert.deepEqual(delivered, [{ Colour: "Blue" }], "one answer, never a second");
  assert.equal(asks.length, 1);
});

test("an operator card settles when its permission is answered on the thread", async (t) => {
  const delivered: Array<Record<string, string>> = [];
  let pending = true;
  const f = intentFixture(t, {
    pendingQuestions: async () => (pending ? [request] : []),
    answerNativeQuestion: async (_agent, _workspace, _request, answers) => {
      delivered.push(answers);
    },
  });
  planners(f, "Decision: operator\nReason: The operator decides", []);
  await pass(f);
  const id = nativeId(f, "native_question_operator");
  const link = operatorQuestionRecords(f.store.eventsAll(f.id)).get(
    `native-question-${id}-0`,
  )?.link;
  assert.ok(link);
  pending = false;
  await pass(f);
  const card = new Decisions(f.store).get({ id: link.decisionId });
  assert.equal(card.status, "withdrawn");
  assert.deepEqual(delivered, []);
  assert.ok(kinds(f).includes("native_question_stale_answered"));
});
