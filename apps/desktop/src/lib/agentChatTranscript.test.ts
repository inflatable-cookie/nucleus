import { describe, expect, test } from "bun:test";

import type {
  AgentChatActivity,
  AgentChatQuestionExchange,
} from "./control/agentChat";
import {
  assembleAgentTranscript,
  type AgentTranscriptMessage,
} from "./agentChatTranscript";

const user: AgentTranscriptMessage = {
  id: "message:turn:1:user",
  turnId: "turn:1",
  sequence: 0,
  role: "user",
  text: "Do the work",
};

function activity(
  overrides: Partial<AgentChatActivity> = {},
): AgentChatActivity {
  return {
    conversation_id: "conversation:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: "turn:runtime:1",
    activity_id: "activity:1",
    sequence: 1,
    kind: "command_execution",
    kind_namespace: null,
    lifecycle: "updated",
    status: "in_progress",
    assistant_phase: null,
    disclosure: "provider_display_content",
    label: null,
    correlation_kind: null,
    correlation_id: null,
    content_change: "delta",
    content_stream: "command_output",
    content: null,
    actor_kind: "primary",
    actor_id: null,
    task_list: null,
    subagents: [],
    ...overrides,
  };
}

describe("agent chat transcript projection", () => {
  test("desktop composition keeps activity, cancellation, and receipts together", async () => {
    const panel = await Bun.file(
      new URL("./AgentChatPanel.svelte", import.meta.url),
    ).text();

    expect(panel).toContain("AgentTranscript");
    expect(panel).toContain('listen<AgentChatActivity>("agent-chat:activity"');
    expect(panel).toContain('listen<AgentChatQuestionExchange>("agent-chat:question"');
    expect(panel).toContain('"agent-chat:subagents"');
    expect(panel).toContain("selectAgentChatActor");
    expect(panel).toContain('status={pendingQuestion ? "questioning"');
    expect(panel).toContain("answerAgentChatQuestion");
    expect(panel).toContain("cancelAgentChatTurn(projectId, conversationId)");
    expect(panel).toContain("await hydrateHistory(projectId, conversationId)");
    expect(panel).toContain("TaskCreationReceipt");
    expect(panel).toContain("TaskWorkflowReceipt");
  });

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

  test("assembles deltas and snapshots into one completion-only work item", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({ content: "old " }),
        activity({ sequence: 2, content: "content" }),
        activity({
          sequence: 3,
          lifecycle: "completed",
          status: "completed",
          content_change: "replacement_snapshot",
          content: "replacement",
        }),
      ],
      [],
      null,
      "conversation:1",
    );

    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({
      kind: "tool-call",
      id: "turn:1:turn:runtime:1:activity:1",
      label: "Command execution",
      detail: "replacement",
      status: "success",
      output: "replacement",
    });
  });

  test("keeps operation-local activity identities separate", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({ lifecycle: "completed", status: "completed" }),
        activity({
          sequence: 2,
          runtime_operation_id: "turn:runtime:2",
          lifecycle: "completed",
          status: "completed",
        }),
      ],
      [],
      null,
      "conversation:1",
    );

    expect(items).toHaveLength(3);
    expect(items[1].id).not.toBe(items[2].id);
  });

  test("presents provider task-list replacement with status priority and child attribution", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({
          kind: "plan",
          task_list: [
            { content: "Old item", status: "pending", priority: null },
          ],
        }),
        activity({
          sequence: 2,
          kind: "plan",
          actor_kind: "subagent",
          actor_id: "child-1",
          task_list: [
            { content: "Inspect", status: "completed", priority: "high" },
            { content: "Apply", status: "in_progress", priority: "medium" },
          ],
        }),
      ],
      [],
      null,
      "conversation:1",
    );

    expect(items[1]).toMatchObject({
      kind: "message",
      role: "assistant",
    });
    expect(items[1]).toHaveProperty(
      "markdown",
      "**Child work · child-1**\n\n**Plan**\n\n- **Completed** · high priority — Inspect\n- **In progress** · medium priority — Apply",
    );
  });

  test("task-list omission retains the snapshot and an empty replacement clears it", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({
          kind: "task",
          task_list: [
            { content: "Retained", status: "in_progress", priority: null },
          ],
        }),
        activity({
          sequence: 2,
          kind: "task",
          task_list: null,
        }),
        activity({
          sequence: 3,
          kind: "task",
          task_list: [],
        }),
      ],
      [],
      null,
      "conversation:1",
    );

    expect(items[1]).toHaveProperty(
      "markdown",
      "**Provider tasks**\n\n_Checklist cleared._",
    );
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
