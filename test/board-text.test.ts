import { test } from "node:test";
import assert from "node:assert/strict";
import { attention, prerequisiteLine } from "../client/board/text";
import type { TaskSummary } from "../shared/contracts";
import { rustPrerequisiteLine, type RustDependencyFact, type RustTask } from "../client/web/rust-board";

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

test("Rust prerequisite card text reuses the shared formatter over the engine's dependency facts", () => {
  const fact = (taskId: string, status: RustDependencyFact["status"], phase: RustDependencyFact["phase"] = null) => ({
    taskId, reference: `fixture#${taskId}`, title: `Task ${taskId}`, phase, status,
  });
  const line = (dependencyStatus: RustTask["dependencyStatus"]) => rustPrerequisiteLine({ dependencyStatus });
  const wait = (releasedAtMs: number | null, prerequisites: RustDependencyFact[]) => ({ reason: "Hold for the schema", releasedAtMs, prerequisites });
  assert.equal(line({ dependencies: [fact("1", "pending", "working")], prerequisiteWait: null, blocking: false }), null);
  assert.equal(
    line({ dependencies: [fact("1", "satisfied", "done"), fact("2", "removed"), fact("3", "goal_unmet", "done")], prerequisiteWait: null, blocking: true }),
    "After fixture#2 · Task 2 · removed before completion · +1 more",
  );
  // An unreleased wait leads and shares identities with the dependency list.
  assert.equal(
    line({ dependencies: [fact("4", "pending", "reviewing")], prerequisiteWait: wait(null, [fact("4", "pending", "reviewing")]), blocking: true }),
    "After fixture#4 · Task 4 · Reviewing",
  );
  // A wait with nothing unfinished names its reason; a released wait no longer counts.
  assert.equal(line({ dependencies: [], prerequisiteWait: wait(null, []), blocking: true }), "After prerequisite · Hold for the schema");
  assert.equal(line({ dependencies: [], prerequisiteWait: wait(1, [fact("5", "pending", "queued")]), blocking: true }), "Waiting for prerequisite");
  // A redacted prerequisite in another scope has no reference, title or identity.
  const redacted = { taskId: "", reference: "", title: null, phase: null, status: "pending" } as const;
  assert.equal(line({ dependencies: [redacted, redacted], prerequisiteWait: null, blocking: true }), "After prerequisite · Prerequisite · pending · +1 more");
});
