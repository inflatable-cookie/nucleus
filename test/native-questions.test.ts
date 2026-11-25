import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { formatAgentId } from "../shared/agent-identity";
import { mount, useNativeStubs } from "./support/render";

useNativeStubs();

const settle = async (ready: () => boolean) => {
  for (let i = 0; i < 30 && !ready(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(ready());
};

test("web question projections keep equal native IDs on separate hosts", async () => {
  const { bindWebQuestions, updateWebQuestions, useTaskQuestions } =
    await import("../client/native-questions");
  const agentId = "same";
  const refA = formatAgentId("host-a", agentId);
  const refB = formatAgentId("host-b", agentId);
  assert.notEqual(refA, refB);

  function Card({ reference }: { reference: string }) {
    const questions = useTaskQuestions([agentId], [reference]);
    return React.createElement(
      "Text",
      null,
      questions.map((request) => request.questions[0]?.question).join(","),
    );
  }

  const stop = bindWebQuestions(async () => {});
  const uiA = mount(React.createElement(Card, { reference: refA }));
  const uiB = mount(React.createElement(Card, { reference: refB }));
  try {
    updateWebQuestions(refA, [
      { id: "p", questions: [{ header: "Q", question: "Host A", options: [] }] },
    ]);
    await settle(() => uiA.text().includes("Host A"));
    assert.doesNotMatch(uiB.text(), /Host A/);
    updateWebQuestions(refB, [
      { id: "p", questions: [{ header: "Q", question: "Host B", options: [] }] },
    ]);
    await settle(() => uiB.text().includes("Host B"));
    assert.doesNotMatch(uiA.text(), /Host B/);
    updateWebQuestions(refA, []);
    await settle(() => !uiA.text().includes("Host A"));
    assert.match(uiB.text(), /Host B/);
  } finally {
    updateWebQuestions(refA, []);
    updateWebQuestions(refB, []);
    stop();
    uiA.update(React.createElement("View"));
    uiB.update(React.createElement("View"));
  }
});

test("a failed web question refresh keeps the last known request; a successful empty read clears it", async () => {
  const { refreshWebQuestions, updateWebQuestions, webQuestionsForAgent } =
    await import("../client/native-questions");
  const id = "host:worker-refresh-boundary";
  const previous = [
    {
      id: "request-1",
      questions: [{ header: "Q", question: "Still open?", options: [] }],
    },
  ];
  updateWebQuestions(id, previous);
  const error = new Error("service unavailable");
  const failed = await refreshWebQuestions(id, async () => {
    throw error;
  });
  assert.deepEqual(failed, { ok: false, error });
  assert.deepEqual(
    webQuestionsForAgent(id),
    previous,
    "unknown after a failed read stays distinct from no questions",
  );
  assert.deepEqual(await refreshWebQuestions(id, async () => []), { ok: true });
  assert.deepEqual(
    webQuestionsForAgent(id),
    [],
    "only a successful empty read clears the request",
  );
});

test("the detail answer control submits through the web binding and refuses without it", async () => {
  const { answerNativeQuestion, bindWebQuestions, NativeQuestionAnswer } =
    await import("../client/native-questions");
  const agentId = formatAgentId("host-a", "worker");
  const request = {
    id: "permission-1",
    questions: [
      {
        header: "Question 1",
        question: "Choose a branch?",
        options: ["main", "release"],
      },
    ],
  };
  await assert.rejects(
    () => answerNativeQuestion(agentId, request.id, { "Question 1": "main" }),
    /no live question/,
  );

  const submitted: unknown[] = [];
  let acknowledged = false;
  const stop = bindWebQuestions(async (agentId, requestId, answers) => {
    submitted.push({ agentId, requestId, answers });
  });
  const ui = mount(
    React.createElement(NativeQuestionAnswer, {
      agentId,
      request,
      onAnswered: () => {
        acknowledged = true;
      },
      c: new Proxy({}, { get: () => "#000" }) as never,
    }),
  );
  try {
    assert.equal(
      ui.query("Submit answer")!.props.accessibilityState.disabled,
      true,
    );
    ui.press("Answer Question 1: release");
    assert.equal(
      ui.query("Submit answer")!.props.accessibilityState.disabled,
      false,
    );
    ui.press("Submit answer");
    await settle(() => acknowledged);
    assert.deepEqual(submitted, [
      { agentId, requestId: request.id, answers: { "Question 1": "release" } },
    ]);
  } finally {
    ui.update(React.createElement("View"));
    stop();
  }
});
