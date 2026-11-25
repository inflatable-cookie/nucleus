import assert from "node:assert/strict";
import { test } from "node:test";
import { taskSummarySchema } from "../shared/contracts";
import { boardDetailReply, boardNext, boardTasks } from "./support/board-tasks";

test("the task card and Overview render the same activity detail", async t => {
  const { createElement: h } = await import("react");
  const { mount, useNativeStubs } = await import("./support/render");
  useNativeStubs();
  const { TaskCard } = await import("../client/board/cards");
  const { TaskSummaryBlock } = await import("../client/task/summary");
  const task = boardTasks()("activity", { title: "Task activity", phase: "working" });
  const activity = {
    state: "active" as const, role: "worker" as const, since: task.createdAt,
    detail: "Running `effigy test`", lastActivityAt: task.updatedAt,
  };
  const detail = boardDetailReply(task);
  detail.task.activity = activity;
  const reading = boardNext(detail.task, { activity });
  const row = taskSummarySchema.parse({
    id: task.id, title: task.title, repoPath: task.repoPath, phase: task.phase, version: task.version,
    number: task.number, reference: null, entrypoint: "worker", reason: task.reason, held: false,
    dependsOn: [], queuePriority: 0, resolution: {}, activity,
  });
  const c = {
    surface0: "#0d1117", surface1: "#161b22", surface2: "#30363d", border: "#30363d",
    foreground: "#f0f6fc", foregroundMuted: "#8b949e", accent: "#1f6feb",
    accentForeground: "#ffffff", statusSuccess: "#3fb950", statusWarning: "#f0883e", statusDanger: "#f85149",
  };
  const card = mount(h(TaskCard, { task: row, selected: false, onPress: () => {}, c, board: true }));
  const panel = mount(h(TaskSummaryBlock, { task: detail.task, next: reading, runs: detail.runs, c }));
  t.after(() => { card.update(h("View")); panel.update(h("View")); });
  assert.ok(card.text().includes(activity.detail));
  assert.ok(panel.text().includes(activity.detail));
});
