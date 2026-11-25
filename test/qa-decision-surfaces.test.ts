import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import {
  type DecisionView,
} from "../shared/contracts";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.ok(probe(), "the condition never settled");
}

const at = new Date(Date.now() - 60_000).toISOString();

const decision = (over: Partial<DecisionView> = {}): DecisionView => {
  const { askerLabel, ...rest } = over;
  return {
    id: "decision-1",
    version: 1,
    question: "Which branch do we cut?",
    headline: "Which branch do we cut?",
    choices: [
      { label: "main", consequence: "Use the stable branch." },
      { label: "branch", consequence: "Start from the feature branch." },
    ],
    recommended: "main",
    details: null,
    overtakenBy: [],
    context: null,
    options: ["main", "branch"],
    recommendation: "main",
    askedBy: {
      agentId: "agent-asker",
      project: { origin: "owner/decisions", path: "/fixture/decisions" },
    },
    links: { tasks: [], leads: [], papercuts: [] },
    askerLabel: askerLabel ?? "agent-asker",
    status: "open",
    answer: null,
    withdrawal: null,
    supersededBy: null,
    delivery: null,
    createdAt: "2026-09-29T10:00:00Z",
    updatedAt: "2026-09-29T10:00:00Z",
    versions: [],
    stale: false,
    projectKey: "decisions",
    ...rest,
  };
};
const popoverProps = () => ({
  theme: { colors: c },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "ios" as const },
  context: "agent" as const,
  workspaceId: "ws-1",
  agentId: "agent-asker",
  close: () => {},
});

/**
 * A client whose decision reads and answers are scripted, counting every read.
 * It serves no board snapshot, so every read here also proves a failed snapshot
 * falls back to a direct decision read (task 1030 keyed the read on it).
 */
function decisionClient(script: {
  reads: Array<DecisionView[] | Error | "pending">;
  answer?: Error;
}) {
  const state = { reads: 0, answers: [] as unknown[] };
  const client = {
    rpc: async (contract: { name: string }, input: Record<string, unknown>) => {
      if (contract.name === "decision.list") {
        state.reads++;
        const next =
          script.reads.length > 1 ? script.reads.shift()! : script.reads[0]!;
        if (next === "pending") return new Promise<DecisionView[]>(() => {});
        if (next instanceof Error) throw next;
        return next;
      }
      if (contract.name === "decision.answer") {
        if (script.answer) throw script.answer;
        state.answers.push(input);
        return decision({ status: "answered" });
      }
      throw new Error(`unexpected rpc ${contract.name}`);
    },
    openPanel() {},
  };
  return { client, state };
}

async function popover(client: unknown) {
  const { decisionPillPopover } = await import("../client/decision-pill");
  return decisionPillPopover({
    client: client as never,
    boardPanelId: "queue-board",
  });
}

test("a decision list that fails says so with a retry, and never reads as loading", async () => {
  const { client, state } = decisionClient({
    reads: [new Error("connection reset"), [decision()]],
  });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() =>
    ui.text().includes("Could not load decisions: connection reset"),
  );
  assert.doesNotMatch(
    ui.text(),
    /Loading decisions…/,
    "a failed read is not still loading",
  );
  ui.press("Retry loading open decisions");
  await settle(() => ui.text().includes("Which branch do we cut?"));
  assert.ok(state.reads >= 2, "the retry reads Queue again");
});

test("while the first read is in flight the popover says it is loading decisions", async () => {
  const { client } = decisionClient({ reads: ["pending"] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  assert.match(ui.text(), /Loading decisions…/);
});

test("with no open decisions the popover says so, with no answer box to fill", async () => {
  const { client } = decisionClient({ reads: [[]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes("No open decisions."));
  assert.equal(ui.query(/Answer box:/), undefined);
});

test("the answer button names why it is unavailable, and the option rows meet the 44-point target", async () => {
  const { client } = decisionClient({ reads: [[decision()]] });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes("Which branch do we cut?"));
  assert.equal(
    ui.get(/Answer decision: Which branch do we cut\?/).props.accessibilityHint,
    "Write an answer or pick an option first",
  );
  assert.equal(ui.get(/^Use option: main/).props.style.minHeight, 44);
  ui.type(/Answer box: Which branch do we cut\?/, "Cut from main.");
  assert.equal(
    ui.get(/Answer decision: Which branch do we cut\?/).props.accessibilityHint,
    undefined,
    "an enabled button carries no reason",
  );
});

test("a refused answer is not confirmed, keeps the draft, and reloads the decision", async () => {
  const { client, state } = decisionClient({
    reads: [[decision()]],
    answer: new Error("Decision changed to version 2"),
  });
  const Popover = await popover(client);
  const ui = mount(h(Popover as never, popoverProps() as never));
  await settle(() => ui.text().includes("Which branch do we cut?"));
  ui.type(/Answer box: Which branch do we cut\?/, "Cut from main.");
  ui.press(/Answer decision: Which branch do we cut\?/);
  await settle(() =>
    ui.text().includes("Answer not confirmed: Decision changed to version 2"),
  );
  assert.match(
    ui.text(),
    /Check the decision before answering again; your draft is kept\./,
  );
  assert.equal(
    ui.query(/Answer box: Which branch do we cut\?/)?.props.value,
    "Cut from main.",
    "the draft survives the refusal",
  );
  assert.equal(state.answers.length, 0);
});

// ---- Native questions: the thread's own requests on the shared controls ---

test("a native question submit names why it is unavailable, and a failed answer is not confirmed", async () => {
  const { NativeQuestionAnswer, bindWebQuestions } = await import(
    "../client/native-questions"
  );
  const sent: unknown[] = [];
  const unbind = bindWebQuestions(async (agentId, requestId, answers) => {
    sent.push([agentId, requestId, answers]);
    throw new Error("Thread is no longer waiting");
  });
  try {
    const request = {
      id: "permission-1",
      questions: [
        {
          header: "Question 1",
          question: "Ship it?",
          options: ["release", "hold"],
        },
      ],
    };
    const ui = mount(
      h(NativeQuestionAnswer as never, {
        agentId: "worker",
        request,
        onAnswered() {},
        c,
      }),
    );
    assert.equal(
      ui.get("Submit answer").props.accessibilityState.disabled,
      true,
    );
    assert.equal(
      ui.get("Submit answer").props.accessibilityHint,
      "Answer every question first",
    );
    assert.equal(
      ui.get("Answer Question 1: release").props.accessibilityState.selected,
      false,
    );
    ui.press("Answer Question 1: release");
    assert.equal(
      ui.get("Answer Question 1: release").props.accessibilityState.selected,
      true,
    );
    ui.press("Submit answer");
    await settle(() =>
      ui.text().includes("Answer not confirmed: Thread is no longer waiting"),
    );
    assert.match(ui.text(), /Check the question before answering again\./);
    assert.deepEqual(sent, [
      ["worker", "permission-1", { "Question 1": "release" }],
    ]);
  } finally {
    unbind();
  }
});
