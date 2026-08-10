import { describe, expect, test } from "bun:test";

import type {
  AgentChatActivity,
  AgentChatPlanDecision,
  AgentChatQuestionExchange,
  AgentChatSubagentDirectory,
} from "./control/agentChat";
import {
  assembleAgentTranscript,
  latestFailedTurnNotice,
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

function subagentDirectory(
  overrides: Partial<AgentChatSubagentDirectory> = {},
): AgentChatSubagentDirectory {
  return {
    project_id: "project:1",
    conversation_id: "conversation:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: "turn:runtime:1",
    first_sequence: 2,
    last_sequence: 4,
    subagents: [
      {
        subagent_id: "child-1",
        parent_kind: "operation",
        parent_id: null,
        status: "running",
        label: "Analyst",
        description: null,
        model: null,
        reasoning: null,
        background: null,
        originating_activity_ref: null,
      },
    ],
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
    expect(panel).toContain("onOpenChild={(childId) => void chooseActor(childId)}");
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

  test("groups known child activities while preserving primary ordering", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({ sequence: 1, label: "Main work", content: "primary" }),
        activity({
          sequence: 2,
          activity_id: "child-activity-1",
          actor_kind: "subagent",
          actor_id: "child-1",
          label: "Inspect",
          content: "first detail",
        }),
        activity({
          sequence: 3,
          activity_id: "child-activity-2",
          actor_kind: "subagent",
          actor_id: "child-1",
          label: "Build",
          content: "second detail",
        }),
        activity({
          sequence: 4,
          activity_id: "child-activity-3",
          actor_kind: "subagent",
          actor_id: "child-2",
          label: "Test",
          content: "terminal detail",
        }),
      ],
      [],
      null,
      "conversation:1",
      [],
      [],
      [
        subagentDirectory({
          last_sequence: 4,
          subagents: [
            subagentDirectory().subagents[0],
            { ...subagentDirectory().subagents[0], subagent_id: "child-2", label: "Builder", status: "completed" },
          ],
        }),
      ],
    );

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "tool-call",
      "subagent-group",
      "subagent-group",
    ]);
    expect(items[2]).toEqual({
      kind: "subagent-group",
      id: 'turn:1:subagent:["turn:runtime:1","child-1"]',
      subagent: {
        id: '["turn:runtime:1","child-1"]',
        label: "Analyst",
        status: "running",
        activityLine: "Build",
      },
      detailLines: ["Inspect", "Build"],
    });
    expect(items[3]).toMatchObject({
      kind: "subagent-group",
      subagent: {
        label: "Builder",
        status: "completed",
        summary: "Test",
      },
      detailLines: ["Test"],
    });
  });

  test("keeps unknown child status literal and falls back without a directory", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({
          sequence: 1,
          activity_id: "unknown-child-activity",
          actor_kind: "subagent",
          actor_id: "child-unknown",
          label: "Waiting for provider truth",
          content: "still observing",
        }),
        activity({
          sequence: 2,
          activity_id: "undocumented-child-activity",
          actor_kind: "subagent",
          actor_id: "child-undocumented",
          label: "Unattributed activity",
          content: "preserve this row",
        }),
      ],
      [],
      null,
      "conversation:1",
      [],
      [],
      [
        subagentDirectory({
          last_sequence: 1,
          subagents: [
            { ...subagentDirectory().subagents[0], subagent_id: "child-unknown", status: "unknown" },
          ],
        }),
      ],
    );

    expect(items[1]).toMatchObject({
      kind: "subagent-group",
      subagent: {
        label: "Analyst",
        status: "unknown",
        activityLine: "Waiting for provider truth",
      },
    });
    expect(items[2]).toMatchObject({
      kind: "tool-call",
      label: "Unattributed activity",
      detail: "preserve this row",
    });
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

  test("a completed turn leaves no streaming caret on an in-progress task list", () => {    const items = assembleAgentTranscript(
      [user],
      [
        activity({
          kind: "plan",
          status: "in_progress",
          task_list: [{ content: "Done", status: "completed", priority: null }],
        }),
      ],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
    );

    expect(items[1]).toMatchObject({
      kind: "message",
      isStreaming: false,
    });
  });

  test("streamed orphan list markers join their item text for display", () => {
    const items = assembleAgentTranscript(
      [user],
      [
        activity({
          kind: "plan",
          status: "completed",
          content_stream: "plan_text",
          content: "7.\n\n  List the expected outputs.\n\n8.\n\n  Confirm the scenario is small.",
        }),
      ],
      [{ turnId: "turn:1", status: "completed" }],
      null,
      "conversation:1",
    );

    expect(items[1]).toHaveProperty(
      "markdown",
      "7. List the expected outputs.\n\n8. Confirm the scenario is small.",
    );
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

describe("agent chat actor selector placement", () => {
  test("rides with the composer as a chip whenever attributed work exists", async () => {
    const panel = await Bun.file(
      new URL("./AgentChatPanel.svelte", import.meta.url),
    ).text();

    // The ghost selector no longer rides the transcript shell.
    expect(panel).not.toMatch(/class="actor-navigation"/);

    // Composer-zone placement: inside the floating composer, directly above
    // the input, so it sits where the operator's attention is.
    expect(panel).toMatch(
      /class="composer-float"[\s\S]*actorSelectorVisible[\s\S]*<AgentChatInput/,
    );

    // Visibility: directories exist, or the current selection is a child —
    // including a dangling one, so a stuck child view always has a way back.
    expect(panel).toContain(
      'subagentDirectories.length > 0 || actorSelection.kind === "subagent"',
    );

    // Chip trigger: icon + current actor label + reflected child status,
    // matching the composer's chip row rather than ghost text.
    expect(panel).toContain('class="actor-selector-chip"');
    expect(panel).toContain("actorChipLabel");
    expect(panel).toContain("StatusIndicator");
    expect(panel).toContain('"All work"');
    expect(panel).toContain('"Primary"');
    expect(panel).toContain('"git-branch"');

    // All work remains the return path through the same chooser.
    expect(panel).toContain("onOpenChild={(childId) => void chooseActor(childId)}");
  });

  test("resets a dangling child selection to All work on hydrate and directory events", async () => {
    const panel = await Bun.file(
      new URL("./AgentChatPanel.svelte", import.meta.url),
    ).text();

    // Both hydration and directory events run the reconcile.
    expect(panel).toMatch(
      /retain\(retainedActorSelections, nextConversationId, actorSelection\);[\s\S]{0,200}void reconcileActorSelection\(\);/,
    );
    expect(panel).toMatch(
      /retain\(retainedSubagentDirectories, conversationId, subagentDirectories\);[\s\S]{0,200}void reconcileActorSelection\(\);/,
    );

    // The reconcile only fires for a subagent selection, only when no
    // directory entry matches the operation and child, and the reset
    // persists through the server so durable state agrees.
    expect(panel).toMatch(
      /async function reconcileActorSelection\(\)[\s\S]*actorSelection\.kind !== "subagent"[\s\S]*runtime_operation_id === actorSelection\.runtime_operation_id[\s\S]*subagent\.subagent_id === actorSelection\.actor_id[\s\S]*actorSelectionFor\("all"\)[\s\S]*selectAgentChatActor\(fallback\)/,
    );
  });
});

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

function planDecision(
  overrides: Partial<AgentChatPlanDecision> = {},
): AgentChatPlanDecision {
  return {
    conversation_id: "conversation:1",
    project_id: "project:1",
    turn_id: "turn:1",
    turn_ordinal: 1,
    runtime_operation_id: "turn:runtime:1",
    activity_id: "activity:1",
    plan: "# Plan\n\n1. Do the work",
    status: "accepted",
    decided_at_unix_ms: 1000,
    accept_turn_id: "turn:2",
    ...overrides,
  };
}

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
