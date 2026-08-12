import { describe, expect, test } from "bun:test";

import type { AgentChatQuestionExchange } from "./control/agentChat";
import { assembleAgentTranscript } from "./agentChatTranscript";
import type { AgentTranscriptMessage } from "./agentChatTranscript";
import { activity, user } from "./agentChatTranscript.fixtures";

describe("agent chat turn-state projection", () => {
  test("replays one durable answered-question record without exposing secret text", () => {
    const exchange: AgentChatQuestionExchange = {
      conversation_id: "conversation:1",
      turn_id: "turn:1",
      callback_id: "callback:1",
      runtime_operation_id: "turn:runtime:1",
      event_sequence: 3,
      provider_request_ref: "provider:request:1",
      deadline_ticks: null,
      auto_resolution_ms: null,
      status: "answered",
      questions: [
        {
          question_id: "secret",
          header: "Credential",
          prompt: "Enter the token",
          kind: "secret_text",
          allow_other: false,
          options: [],
        },
      ],
      answers: [
        {
          question_id: "secret",
          selected_option_ids: [],
          text: null,
          skipped: false,
          redacted: true,
        },
      ],
    };
    const items = assembleAgentTranscript(
      [user],
      [],
      [],
      null,
      "conversation:1",
      [exchange],
    );

    expect(items[1]).toMatchObject({
      kind: "answered-question",
      answer: {
        outcome: "override",
        text: "Answer hidden",
      },
    });
  });

  test("keeps a restarted unanswered question visible but unanswerable", () => {
    const exchange: AgentChatQuestionExchange = {
      conversation_id: "conversation:1",
      turn_id: "turn:1",
      callback_id: "callback:restart",
      runtime_operation_id: "turn:runtime:1",
      event_sequence: 3,
      provider_request_ref: null,
      deadline_ticks: null,
      auto_resolution_ms: null,
      status: "abandoned",
      questions: [
        {
          question_id: "choice",
          header: "Choose",
          prompt: "Continue?",
          kind: "single_choice",
          allow_other: false,
          options: [],
        },
      ],
      answers: [],
    };
    const items = assembleAgentTranscript(
      [user],
      [],
      [{ turnId: "turn:1", status: "failed" }],
      null,
      "conversation:1",
      [exchange],
    );

    expect(items).toContainEqual({
      kind: "activity",
      id: "turn:1:callback:restart:settled",
      label: "Question expired after restart",
    });
  });

  test("terminal turn items do not pulse", () => {
    const items = assembleAgentTranscript(
      [user],
      [activity()],
      [{ turnId: "turn:1", status: "cancelled" }],
      null,
      "conversation:1",
    );

    expect(items[2]).toEqual({
      kind: "activity",
      id: "terminal:turn:1",
      label: "Turn cancelled",
      spinning: false,
    });
  });

  test("empty reasoning summaries and unknown echoes leave no rows", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({ kind: "reasoning_summary", status: "completed", lifecycle: "completed" }),
        activity({
          activity_id: "activity:echo",
          kind: "unknown",
          kind_namespace: "codex.app-server.item.userMessage",
          disclosure: "identity_and_lifecycle_only",
          status: "completed",
          lifecycle: "completed",
        }),
        activity({
          activity_id: "activity:reasoning-with-content",
          kind: "reasoning_summary",
          status: "completed",
          lifecycle: "completed",
          content_change: "replacement_snapshot",
          content_stream: "reasoning_summary_text",
          content: "Considered the plan shape before answering.",
        }),
      ],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
    );

    // Only the reasoning summary with content survives, with its first line
    // as the row detail.
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "tool-call",
      label: "Reasoning summary",
      detail: "Considered the plan shape before answering.",
    });
  });

  test("settles interrupted activity from durable turn truth", () => {
    const items = assembleAgentTranscript(
      [user],
      [activity()],
      [{ turnId: "turn:1", status: "cancelled" }],
      null,
      "conversation:1",
    );

    expect(items[1]).toMatchObject({
      kind: "tool-call",
      status: "error",
    });
    expect(items[2]).toEqual({
      kind: "activity",
      id: "terminal:turn:1",
      label: "Turn cancelled",
      spinning: false,
    });
  });

  test("keeps reasoning, unknown, and failure truth explicit", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({
          activity_id: "reasoning",
          kind: "reasoning_summary",
          content_stream: "reasoning_summary_text",
          content: "Readable summary",
        }),
        activity({
          activity_id: "unknown",
          sequence: 2,
          kind: "unknown",
          lifecycle: "completed",
          status: "failed",
          content_stream: null,
          content_change: null,
          content: null,
        }),
      ],
      [],
      "Working…",
      "conversation:1",
    );

    expect(items[1]).toMatchObject({
      kind: "tool-call",
      label: "Reasoning summary",
      status: "running",
    });
    expect(items[2]).toEqual({
      kind: "tool-call",
      id: "turn:1:turn:runtime:1:unknown",
      label: "Activity",
      detail: undefined,
      status: "error",
      output: undefined,
    });
    expect(items[3]).toEqual({
      kind: "activity",
      id: "working:conversation:1",
      label: "Working…",
    });
  });

  test("deduplicates only explicit final activity against the canonical reply", () => {
    const assistant: AgentTranscriptMessage = {
      id: "message:turn:1:assistant",
      turnId: "turn:1",
      sequence: 1,
      role: "assistant",
      text: "Canonical final",
    };
    const items = assembleAgentTranscript(
      [user, assistant],
      [
        activity({
          activity_id: "intermediate",
          kind: "assistant_message",
          assistant_phase: "intermediate",
          content_stream: "intermediate_assistant_text",
          content: "Intermediate note",
        }),
        activity({
          activity_id: "final",
          sequence: 2,
          kind: "assistant_message",
          lifecycle: "completed",
          status: "completed",
          assistant_phase: "final",
          content_stream: "final_answer_text",
          content_change: "replacement_snapshot",
          content: "Canonical final",
        }),
      ],
      [],
      null,
      "conversation:1",
    );

    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({
      kind: "message",
      markdown: "Intermediate note",
    });
    expect(items[2]).toEqual({
      kind: "message",
      id: "message:turn:1:assistant",
      role: "assistant",
      markdown: "Canonical final",
    });
  });
});
