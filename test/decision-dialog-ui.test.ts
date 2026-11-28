import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { waitFor } from "./support/budgets";
import type { DecisionView } from "../shared/contracts";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#123456" }) as never;
const base: DecisionView = {
  id: "decision",
  version: 1,
  question: "Choose",
  choices: [
    { id: "one", label: "First", consequence: "First consequence" },
    { id: "two", label: "Second", consequence: "Second consequence" },
  ],
  recommended: "First",
  options: [],
  recommendation: null,
  context: null,
  askedBy: { agentId: "thread", project: null },
  askerLabel: "Planner",
  links: { tasks: [], leads: [], papercuts: [] },
  status: "open",
  answer: null,
  withdrawal: null,
  supersededBy: null,
  delivery: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  versions: [],
  stale: false,
  projectKey: null,
};

async function setup(decision: DecisionView) {
  const { DecisionDialog } = await import("../client/records/decision-dialog");
  const answers: Record<string, unknown>[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: async (method: string, input: unknown) => {
          if (method === "decision.get") return decision;
          if (method === "decision.answer") {
            answers.push(input as Record<string, unknown>);
            return decision;
          }
          throw new Error(method);
        },
        children: h(DecisionDialog, {
          id: decision.id,
          compact: false,
          busy: false,
          act: async (fn) => {
            await fn();
          },
          recordNotice: null,
          setRecordNotice: () => {},
          onOpenDecision: () => {},
          onOpenTask: () => {},
          onClose: () => {},
          c,
          inline: true,
        }),
      }),
    }),
  );
  await waitFor(
    () =>
      Boolean(
        ui.query("Operator answer") ||
          ui.query("Use option: First, recommended"),
      ),
    4000,
    "decision detail",
  );
  return {
    ui,
    answers,
    close: () => {
      ui.update(h("View"));
      client.clear();
    },
  };
}

test("decision choice, editable answer and replacement", async () => {
  const { ui, answers, close } = await setup(base);
  try {
    assert.equal(ui.get("Answer").props.disabled, true);
    assert.doesNotMatch(ui.text(), /Links|None/);
    ui.press("Use option: First, recommended");
    assert.equal(
      ui.get("Use option: First, recommended").props.accessibilityState.checked,
      true,
    );
    assert.equal(ui.get("Operator answer").props.value, "First");
    ui.press("Answer");
    await waitFor(() => answers.length === 1, 4000, "option answer");
    assert.equal(answers[0].optionId, "one");
    ui.press("Use option: First, recommended");
    ui.type("Operator answer", "First with changes");
    assert.match(ui.text(), /Edited/);
    ui.press("Use option: Second");
    assert.ok(ui.query("Replace your answer?"));
    ui.press("Keep mine");
    ui.press("Answer");
    await waitFor(() => answers.length === 2, 4000, "custom answer");
    assert.equal(answers[1].answer, "First with changes");
    assert.equal(answers[1].basedOnOptionId, "one");
  } finally {
    close();
  }
});

test("gate answers stay read-only and use their option", async () => {
  const { ui, answers, close } = await setup({ ...base, gate: true });
  try {
    assert.equal(ui.get("Operator answer").props.editable, false);
    ui.press("Use option: Second");
    ui.press("Answer");
    await waitFor(() => answers.length === 1, 4000, "gate answer");
    assert.equal(answers[0].optionId, "two");
  } finally {
    close();
  }
});

test("answered decisions mark the choice and retain answer metadata", async () => {
  const { ui, close } = await setup({
    ...base,
    status: "answered",
    answer: {
      optionId: "two",
      text: "Second",
      answeredBy: "operator via T3 Inbox",
      answeredAt: "2026-01-01T00:00:00Z",
      relayed: null,
      note: "A note",
    },
  });
  try {
    assert.equal(
      ui.get("Use option: Second").props.accessibilityState.checked,
      true,
    );
    assert.match(ui.text(), /Chosen/);
    assert.match(ui.text(), /Inbox/);
    assert.match(ui.text(), /A note/);
    assert.equal(ui.query("Operator answer"), undefined);
  } finally {
    close();
  }
});

test("Enter on an unselected card selects it and never submits another choice", async () => {
  const { ui, answers, close } = await setup(base);
  try {
    ui.get("Use option: First, recommended").props.onKeyDown({
      key: " ",
      preventDefault() {},
    });
    assert.equal(ui.get("Operator answer").props.value, "First");
    const second = ui.get("Use option: Second");
    second.props.onKeyDown({ key: "Enter", preventDefault() {} });
    // React Native Web presses the card again on the Enter keyup.
    ui.get("Use option: Second").props.onPress();
    assert.equal(ui.get("Operator answer").props.value, "Second");
    assert.equal(
      ui.get("Use option: Second").props.accessibilityState.checked,
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(answers.length, 0);
    ui.get("Use option: Second").props.onKeyDown({
      key: "Enter",
      preventDefault() {},
    });
    ui.get("Use option: Second").props.onPress();
    await waitFor(() => answers.length === 1, 4000, "keyboard answer");
    assert.equal(answers[0].optionId, "two");
  } finally {
    close();
  }
});

test("arrow keys move focus and Enter submits the selected choice", async () => {
  const { ui, answers, close } = await setup(base);
  try {
    let focused = false;
    const first = ui.get("Use option: First, recommended");
    first.props.onKeyDown({
      key: "ArrowDown",
      preventDefault() {},
      currentTarget: {
        parentElement: {
          querySelectorAll: () => [
            { focus() {} },
            {
              focus() {
                focused = true;
              },
            },
          ],
        },
      },
    });
    assert.equal(focused, true);
    ui.get("Use option: Second").props.onKeyDown({
      key: " ",
      preventDefault() {},
    });
    assert.equal(ui.get("Operator answer").props.value, "Second");
    ui.get("Use option: Second").props.onKeyDown({
      key: "Enter",
      preventDefault() {},
    });
    await waitFor(() => answers.length === 1, 4000, "keyboard answer");
    assert.equal(answers[0].optionId, "two");
  } finally {
    close();
  }
});
