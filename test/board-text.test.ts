import { test } from "node:test";
import assert from "node:assert/strict";
import { attention, prerequisiteLine } from "../client/board/text";
import type { TaskSummary } from "../shared/contracts";

test("board attention delegates its phase rule and retains explicit origin and resolution faults", () => {
  const task = (phase: string, extra: Record<string, unknown> = {}) => ({
    phase, resolution: { attention: false },
    ...extra,
  }) as unknown as TaskSummary;
  assert.equal(attention(task("blocked")), true);
  assert.equal(attention(task("working")), false);
  assert.equal(attention(task("working", { originError: "unreadable" })), true);
  assert.equal(attention(task("working", { resolution: { attention: true } })), true);
});

test("prerequisite card text uses the wait-state decoder for generated entries", () => {
  const task = {
    waitState: { state: "waiting_prerequisite", owner: "Queue" },
    waitingOn: "task-17",
    reason: "Waiting for prerequisites: Build (01234567-89ab-cdef-0123-456789abcdef): working; Test (11234567-89ab-cdef-0123-456789abcdef): done",
  } as unknown as TaskSummary;
  assert.equal(prerequisiteLine(task), "After task-17 · Build · Working · +1 more");
});
