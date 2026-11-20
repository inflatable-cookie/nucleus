import assert from "node:assert/strict";
import { test } from "node:test";
import { rowStep, needsInputStep } from "../hosts/t3code/one-row";
import { taskAttention } from "../shared/task-attention";
import { TASK_PROGRESSING_REASON } from "../shared/task-detail-summary";
import {
  isSettledWaitProse,
  taskStopClassification,
} from "../shared/task-stop";

test("settled-wait prose is never a fault or a stop's cause (nucleus#1437)", () => {
  assert.ok(isSettledWaitProse(TASK_PROGRESSING_REASON));
  assert.ok(isSettledWaitProse(` ${TASK_PROGRESSING_REASON} `));
  assert.equal(isSettledWaitProse("Reviewer callback is missing"), false);
  assert.deepEqual(
    taskAttention({ phase: "blocked", held: false, reason: TASK_PROGRESSING_REASON }),
    { state: "attention", cause: "Needs attention" },
    "a blocked phase names the unknown, never the progressing prose",
  );
  assert.equal(taskStopClassification(TASK_PROGRESSING_REASON).reason, "operator_needed");
});

test("a waiting task's role fault names no row step unless its attention owns it (nucleus#1437)", () => {
  const failed = [{ role: "recovery", pending: false, live: false, faulted: true }];
  assert.equal(rowStep(failed), "", "no owned fault, no step");
  assert.equal(rowStep(failed, false), "");
  assert.equal(rowStep(failed, true), "blocked: recovery");
  const asking = [
    { role: "reviewer", pending: true, live: true, faulted: false },
    { role: "recovery", pending: false, live: false, faulted: true },
  ];
  assert.equal(rowStep(asking), "reviewer needs input", "a current request always names the row");
  assert.equal(needsInputStep(rowStep(asking)), true);
  assert.equal(needsInputStep(rowStep(failed, true)), false);
});
