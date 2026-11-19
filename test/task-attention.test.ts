import { test } from "node:test";
import assert from "node:assert/strict";
import { taskAttention } from "../shared/task-attention";
import { pipelineColumn } from "../shared/pipeline-board";
import { attention } from "../client/board/text";
import type { TaskSummary, Task } from "../shared/contracts";
import { taskStopKind } from "../shared/task-view";

/**
 * nucleus#1366: one attention projection. The board's attention marker and
 * column, `task.next`'s stop kind and the T3 host row all read this classifier, so
 * these cases pin the reading once — an owner hold with a release condition and an
 * unresolved prerequisite wait are *waiting* with a named cause, never attention.
 */

const until = { kind: "task" as const, taskId: "0f8a2b3c-0000-4000-8000-000000000001" };
const fence = (release: boolean) => ({
  owner: "operator",
  reason: "Active common admission is the prerequisite",
  at: "2026-11-19T00:00:00.000Z",
  generation: 1,
  until: release ? until : null,
});

const task = (overrides: Partial<TaskSummary> = {}): TaskSummary =>
  ({
    id: "synthetic-task",
    title: "Synthetic",
    repoPath: "/synthetic",
    version: 1,
    number: 1,
    reference: "nucleus#1",
    entrypoint: "worker",
    phase: "needs_attention",
    reason: "Worker creation refused before send: a synthetic cause",
    held: false,
    dependsOn: [],
    queuePriority: 0,
    lanes: [],
    resolution: {},
    ...overrides,
  }) as TaskSummary;

test("an owner hold with a release condition is waiting with the named cause", () => {
  const held = task({
    phase: "needs_attention",
    held: true,
    holds: { dispatch: { ...fence(true), since: "2026-11-19T00:00:00.000Z" } },
    waitingOn: "nucleus#1364",
  });
  const projection = taskAttention({
    phase: held.phase,
    held: held.held,
    holds: held.holds,
    attention: true,
    waitingOn: held.waitingOn,
  });
  assert.equal(projection.state, "waiting");
  assert.equal(projection.state === "waiting" && projection.cause, "Waiting on nucleus#1364");
  // The board's attention marker and column agree with it.
  assert.equal(attention(held), false, "the card is not attention");
  assert.equal(pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }), "Working");
});

test("a hold with no release condition still needs its owner", () => {
  const held = task({
    phase: "needs_attention",
    held: true,
    holds: { dispatch: { ...fence(false), since: "2026-11-19T00:00:00.000Z" } },
  });
  assert.equal(
    taskAttention({ phase: held.phase, held: held.held, holds: held.holds }).state,
    "attention",
  );
  assert.equal(attention(held), true);
  assert.equal(pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }), "Attention");
});

test("an unresolved prerequisite wait is waiting; an operator-correctable one is attention", () => {
  const waiting = task({ waitState: { state: "waiting_prerequisite", owner: "prerequisites", nextAction: "Wait" } });
  assert.equal(attention(waiting), false);
  assert.equal(pipelineColumn({ kind: "task", id: waiting.id, lanes: [], value: waiting }), "Working");
  const correctable = task({ waitState: { state: "waiting_prerequisite", owner: "operator", nextAction: "Correct the list" } });
  assert.equal(attention(correctable), true);
  assert.equal(attention(task({ phase: "queued", waitState: correctable.waitState })), true);
  assert.equal(taskAttention({ phase: "queued", held: false, prerequisiteOperator: true }).state, "attention");
  assert.equal(taskStopKind({ phase: "needs_attention", held: false, resolution: {},
    prerequisiteWait: { releasedAt: null } } as unknown as Task, [], null,
    { state: "waiting_prerequisite", owner: "operator", nextAction: "Correct the list" }), "attention");
  assert.equal(
    taskStopKind({ phase: "needs_attention", held: false, resolution: {} } as unknown as Task),
    "attention",
  );
});

test("a live role is active, a finished task is finished, and an origin fault is attention", () => {
  assert.equal(taskAttention({ phase: "working", held: false, liveRun: true }).state, "active");
  assert.equal(taskAttention({ phase: "done", held: false, liveRun: true }).state, "finished");
  assert.equal(taskAttention({ phase: "cancelled", held: false }).state, "finished");
  assert.equal(
    taskAttention({ phase: "awaiting_review", held: false, originFault: true }).state,
    "attention",
  );
  // Between roles nothing runs and nobody is needed, so the task waits.
  assert.equal(taskAttention({ phase: "awaiting_review", held: false }).state, "waiting");
});

test("next reports a prerequisite wait as a wait even in an attention phase", () => {
  assert.equal(
    taskStopKind({
      phase: "needs_attention",
      held: false,
      resolution: {},
      prerequisiteWait: { at: "2026-11-19T00:00:00.000Z", releasedAt: null },
    } as unknown as Task),
    "wait",
  );
});
