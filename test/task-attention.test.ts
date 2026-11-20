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

const until = {
  kind: "task" as const,
  taskId: "0f8a2b3c-0000-4000-8000-000000000001",
};
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
  assert.equal(
    projection.state === "waiting" && projection.cause,
    "Waiting on nucleus#1364",
  );
  // The board's attention marker and column agree with it.
  assert.equal(attention(held), false, "the card is not attention");
  assert.equal(
    pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }),
    "Working",
  );
});

test("a hold with no release condition still needs its owner", () => {
  const held = task({
    phase: "needs_attention",
    held: true,
    holds: { dispatch: { ...fence(false), since: "2026-11-19T00:00:00.000Z" } },
  });
  assert.equal(
    taskAttention({ phase: held.phase, held: held.held, holds: held.holds })
      .state,
    "attention",
  );
  assert.equal(attention(held), true);
  assert.equal(
    pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }),
    "Attention",
  );
});

test("an unresolved prerequisite wait is waiting; an operator-correctable one is attention", () => {
  const waiting = task({
    waitState: {
      state: "waiting_prerequisite",
      owner: "prerequisites",
      nextAction: "Wait",
    },
  });
  assert.equal(attention(waiting), false);
  assert.equal(
    pipelineColumn({ kind: "task", id: waiting.id, lanes: [], value: waiting }),
    "Working",
  );
  const correctable = task({
    waitState: {
      state: "waiting_prerequisite",
      owner: "operator",
      nextAction: "Correct the list",
    },
  });
  assert.equal(attention(correctable), true);
  assert.equal(
    attention(task({ phase: "queued", waitState: correctable.waitState })),
    true,
  );
  assert.equal(
    taskAttention({ phase: "queued", held: false, prerequisiteOperator: true })
      .state,
    "attention",
  );
  assert.equal(
    taskStopKind(
      {
        phase: "needs_attention",
        held: false,
        resolution: {},
        prerequisiteWait: { releasedAt: null },
      } as unknown as Task,
      [],
      null,
      {
        state: "waiting_prerequisite",
        owner: "operator",
        nextAction: "Correct the list",
      },
    ),
    "attention",
  );
  assert.equal(
    taskStopKind({
      phase: "needs_attention",
      held: false,
      resolution: {},
    } as unknown as Task),
    "attention",
  );
});

test("a live role is active, a finished task is finished, and an origin fault is attention", () => {
  assert.equal(
    taskAttention({ phase: "working", held: false, liveRun: true }).state,
    "active",
  );
  assert.equal(
    taskAttention({ phase: "done", held: false, liveRun: true }).state,
    "finished",
  );
  assert.equal(
    taskAttention({ phase: "cancelled", held: false }).state,
    "finished",
  );
  assert.equal(
    taskAttention({ phase: "awaiting_review", held: false, originFault: true })
      .state,
    "attention",
  );
  // Between roles nothing runs and nobody is needed, so the task waits.
  assert.equal(
    taskAttention({ phase: "awaiting_review", held: false }).state,
    "waiting",
  );
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

/**
 * nucleus#1419: a planner's own hold is a deliberate park, so a quiet task behind
 * it waits — and once the planner's nudge for that hold generation goes
 * unanswered, the fence needs its owner again. An operator's own hold, a running
 * role and an independent call for a person keep their own reading.
 */

const plannerFence = (extra: Record<string, unknown> = {}) => ({
  dispatch: {
    owner: "planner-thread",
    reason: "Approved, waiting for the upgrade day",
    since: "2026-11-19T00:00:00.000Z",
    until: null,
    planner: true as const,
    ...extra,
  },
});

test("a planner's own hold with no release condition waits with a named cause", () => {
  const held = task({
    phase: "needs_attention",
    held: true,
    holds: plannerFence(),
  });
  const projection = taskAttention({
    phase: held.phase,
    held: held.held,
    holds: held.holds,
  });
  assert.equal(projection.state, "waiting");
  assert.equal(
    projection.state === "waiting" && projection.cause,
    "Held by planner",
    "the wait names its holder, as the board's own label does",
  );
  assert.equal(attention(held), false, "the card is not attention");
  assert.equal(
    pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }),
    "Working",
    "and neither is the board's column",
  );
});

test("an unanswered planner nudge makes the same hold attention again", () => {
  for (const unanswered of ["planner", "delivery"] as const) {
    const held = task({
      phase: "needs_attention",
      held: true,
      holds: plannerFence({ unanswered }),
    });
    const projection = taskAttention({
      phase: held.phase,
      held: held.held,
      holds: held.holds,
    });
    assert.equal(projection.state, "attention", unanswered);
    assert.match(
      projection.state === "attention" ? projection.cause : "",
      unanswered === "delivery"
        ? /not delivered to the planner/
        : /has not answered/,
    );
    assert.equal(
      attention(held),
      true,
      `the card is attention (${unanswered})`,
    );
    assert.equal(
      pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }),
      "Attention",
      `the board column agrees (${unanswered})`,
    );
  }
});

test("a hold another participant placed is not a planner park", () => {
  // The view only marks the task planner's own fence (nucleus#1419): a hold a
  // worker, reviewer or coordinator placed keeps its existing attention.
  const holds = {
    dispatch: {
      owner: "reviewer-thread",
      reason: "Review is paused for the receipt",
      since: "2026-11-19T00:00:00.000Z",
      until: null,
    },
  };
  const held = task({ phase: "needs_attention", held: true, holds });
  assert.equal(
    taskAttention({ phase: held.phase, held: held.held, holds: held.holds })
      .state,
    "attention",
    "another participant's hold is never snoozed",
  );
  assert.equal(attention(held), true);
  assert.equal(
    pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }),
    "Attention",
  );
});

test("an operator's own hold with no release condition still needs the operator", () => {
  const held = task({
    phase: "needs_attention",
    held: true,
    holds: {
      dispatch: {
        owner: "operator",
        reason: "Held for the operator",
        since: "2026-11-19T00:00:00.000Z",
        until: null,
      },
    },
  });
  assert.equal(attention(held), true);
  assert.equal(
    pipelineColumn({ kind: "task", id: held.id, lanes: [], value: held }),
    "Attention",
  );
});

test("a running role and an independent call for a person win over a planner's hold", () => {
  const holds = plannerFence();
  assert.equal(
    taskAttention({ phase: "working", held: true, holds, liveRun: true }).state,
    "active",
    "a planner's hold never interrupts a running role",
  );
  assert.equal(
    taskAttention({
      phase: "needs_attention",
      held: true,
      holds,
      attention: true,
    }).state,
    "attention",
    "an independent attention call stays visible",
  );
  assert.equal(
    taskAttention({ phase: "queued", held: true, holds, originFault: true })
      .state,
    "attention",
  );
  // A hold with a release condition is still the wait it names, and never an
  // escalation the planner has to answer.
  assert.equal(
    taskAttention({
      phase: "needs_attention",
      held: true,
      holds: plannerFence({ until, unanswered: "planner" }),
    }).state,
    "waiting",
  );
});
