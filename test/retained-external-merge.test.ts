import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "../shared/contracts";
import { participantToolRunIds } from "../core/recovery/task-reasons";

test("retired worker process proofs include their task-row run identity", () => {
  const task = {
    agentId: "current",
    workspaceId: "workspace",
    runId: "current-run",
    retiredWorkers: [{ agentId: "retired", runId: "retired-run" }],
  } as unknown as Task;
  assert.deepEqual(participantToolRunIds(task, [], "retired", "workspace"), [
    "retired-run",
  ]);
});
