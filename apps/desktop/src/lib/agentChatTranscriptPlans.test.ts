import { describe, expect, test } from "bun:test";

import { assembleAgentTranscript, latestFailedTurnNotice } from "./agentChatTranscript";
import { activity, planDecision, user } from "./agentChatTranscript.fixtures";

describe("latestFailedTurnNotice", () => {
  test("returns the most recent failed turn reason", () => {
    expect(
      latestFailedTurnNotice([
        {
          turnId: "turn:1",
          status: "failed",
          failureReason: "[swallowtail.codex.turn.timeout] first",
        },
        { turnId: "turn:2", status: "completed" },
        {
          turnId: "turn:3",
          status: "failed",
          failureReason:
            "[swallowtail.codex.app_server.malformed_notification] latest",
        },
      ]),
    ).toBe("[swallowtail.codex.app_server.malformed_notification] latest");
  });

  test("stays quiet without a failed turn reason", () => {
    expect(
      latestFailedTurnNotice([
        { turnId: "turn:1", status: "completed" },
        { turnId: "turn:2", status: "cancelled" },
        { turnId: "turn:3", status: "failed" },
      ]),
    ).toBeNull();
    expect(latestFailedTurnNotice([])).toBeNull();
  });
});

describe("decided plan transcript records", () => {
  const planActivity = activity({
    kind: "plan",
    content_stream: "plan_text",
    content: "# Plan\n\n1. Do the work",
  });

  test("a settled decision replaces the flattened plan with one record", () => {
    const items = assembleAgentTranscript(
      [user],
      [planActivity],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
      [],
      [planDecision()],
    );

    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      kind: "decided-plan",
      id: "turn:1:turn:runtime:1:activity:1:decided",
      plan: "# Plan\n\n1. Do the work",
      status: "accepted",
      decidedAt: new Date(1000).toLocaleString(),
    });
  });

  test("a pending plan stays out of the transcript while the composer reviews it", () => {
    const items = assembleAgentTranscript(
      [user],
      [planActivity],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
      [],
      [planDecision({ status: "pending", decided_at_unix_ms: null, accept_turn_id: null })],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "message", role: "user" });
  });

  test("an undecided plan keeps the legacy flattened rendering", () => {
    const items = assembleAgentTranscript(
      [user],
      [planActivity],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
    );

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "message",
      role: "assistant",
      markdown: "# Plan\n\n1. Do the work",
    });
  });

  test("a dismissed decision records the plan as a non-event", () => {
    const items = assembleAgentTranscript(
      [user],
      [planActivity],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
      [],
      [planDecision({ status: "dismissed", accept_turn_id: null })],
    );

    expect(items[1]).toMatchObject({
      kind: "decided-plan",
      status: "dismissed",
    });
  });
});
