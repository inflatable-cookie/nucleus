import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

test("a held archive displays its reason and retries at its durable deadline without a sweep", async (t) => {
  const f = await terminalArchiveFixture(t);
  f.engine.completionFollowUpDelays = [10, 20, 40, 80, 160];
  f.updateResolution({
    workspaceArchiveRetries: f
      .task()
      .resolution.workspaceArchiveRetries.map((retry) => ({
        ...retry,
        nextAttemptAt: new Date(Date.now() + 300).toISOString(),
      })),
  });
  f.engine.enqueueCleanup(f.task().id);
  await f.engine.drainCleanup();
  assert.match(f.task().resolution.cleanupReason, /native history unavailable/);
  assert.equal(f.remote.archives.length, 0);
  const deadline = Date.now() + 5000;
  while (
    !f.task().resolution.archivedWorkspaceIds.includes("ws") &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ["ws"]);
  assert.equal(f.remote.archives.length, 1);
});
