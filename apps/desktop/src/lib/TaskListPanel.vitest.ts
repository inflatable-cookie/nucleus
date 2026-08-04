import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import TaskListPanel from "./TaskListPanel.svelte";
import type { ControlGoalRecordDto, ControlTaskRecordDto } from "./control";

describe("TaskListPanel", () => {
  it("renders host-supplied project work and restores external selection", async () => {
    const onRefresh = vi.fn();
    const screen = render(TaskListPanel, {
      props: {
        selectedProjectId: "project:one",
        goals: [goal("goal:one", "project:one", ["task:one"])],
        tasks: [task("task:one", "project:one"), task("task:other", "project:other")],
        selectedGoalId: null,
        selectedTaskId: null,
        onRefresh,
      },
    });

    expect(screen.queryByText("Other task")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: /Goal one/ }));
    expect(screen.getByRole("heading", { name: "Goal one" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /Task one/ }));
    expect(screen.getByRole("heading", { name: "Task one" })).toBeTruthy();

    await screen.rerender({
      selectedProjectId: "project:one",
      goals: [goal("goal:one", "project:one", ["task:one"])],
      tasks: [task("task:one", "project:one")],
      selectedGoalId: "goal:one",
      selectedTaskId: "task:one",
      onRefresh,
    });
    expect(screen.getByRole("heading", { name: "Task one" })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Refresh goals and tasks" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    screen.unmount();
  });

  it("keeps ungrouped, cleared, and stale selection host-driven", async () => {
    const onSelectionChange = vi.fn();
    const tasks = [
      task("task:grouped", "project:one"),
      { ...task("task:ungrouped", "project:one"), title: "Ungrouped task" },
    ];
    const screen = render(TaskListPanel, {
      props: {
        selectedProjectId: "project:one",
        goals: [goal("goal:one", "project:one", ["task:grouped"])],
        tasks,
        selectedGoalId: null,
        selectedTaskId: null,
        onSelectionChange,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: /Ungrouped task/ }));
    expect(onSelectionChange).toHaveBeenCalledWith(null, "task:ungrouped");
    expect(screen.getByRole("heading", { name: "Ungrouped task" })).toBeTruthy();
    expect(screen.queryByText("Goal one", { selector: ".parent-goal" })).toBeNull();

    await screen.rerender({
      selectedProjectId: "project:one",
      goals: [goal("goal:one", "project:one", ["task:grouped"])],
      tasks,
      selectedGoalId: null,
      selectedTaskId: null,
    });
    expect(screen.getByText("Select a goal or task")).toBeTruthy();

    await screen.rerender({
      selectedProjectId: "project:one",
      goals: [goal("goal:one", "project:one", ["task:grouped"])],
      tasks: [task("task:grouped", "project:one")],
      selectedGoalId: "goal:stale",
      selectedTaskId: "task:stale",
    });
    expect(screen.getByText("Select a goal or task")).toBeTruthy();
    screen.unmount();
  });
});

function goal(
  goalId: string,
  projectId: string,
  orderedTaskRefs: string[],
): ControlGoalRecordDto {
  return {
    goal_id: goalId,
    project_id: projectId,
    title: "Goal one",
    desired_outcome: "Finish the coherent slice.",
    scope: "project",
    status: "ready",
    blocked_reason: null,
    owner_refs: [],
    ordered_task_refs: orderedTaskRefs,
    planning_artifact_refs: [],
    provenance_refs: [],
    stop_conditions: [],
    evidence_refs: [],
    current_next_task_ref: orderedTaskRefs[0] ?? null,
    next_action: "Continue",
    revision_id: "revision:goal:one",
    created_at_epoch_seconds: null,
    updated_at_epoch_seconds: null,
    achieved_at_epoch_seconds: null,
  };
}

function task(taskId: string, projectId: string): ControlTaskRecordDto {
  return {
    task_id: taskId,
    project_id: projectId,
    title: projectId === "project:one" ? "Task one" : "Other task",
    description: "Do the work.",
    acceptance_criteria: [],
    importance: "normal",
    action_type: "execute",
    activity: "ready",
    assignment_intent: null,
    agent_ready: true,
    required_context_refs: [],
    allowed_actions: ["execute"],
    stop_conditions: [],
    validation_commands: [],
    blocked_reason: null,
    revision_id: `revision:${taskId}`,
  };
}
