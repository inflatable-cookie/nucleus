import { describe, expect, test } from "bun:test";

import { assembleAgentTranscript } from "./agentChatTranscript";
import { activity, subagentDirectory, user } from "./agentChatTranscript.fixtures";

describe("agent chat transcript projection", () => {
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
});
