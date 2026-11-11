import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

test("an active terminal thread shows its wait and is retried after it becomes idle", async (t) => {
  const f = await terminalArchiveFixture(t);
  f.engine.completionFollowUpDelays = [50, 100, 200, 400, 800];
  let active = true,
    archived = false,
    calls = 0;
  f.adapter.observe = async (id) => ({
    id,
    workspaceId: "ws",
    status: active ? "running" : "idle",
    active,
    permissions: false,
    error: "",
    labels: { "northstar.task": f.task().id },
  });
  f.adapter.originAgent = async (id) => ({
    id,
    workspaceId: "ws",
    title: "",
    archived,
  });
  f.adapter.archiveAgent = async () => {
    calls++;
    archived = true;
  };
  await f.engine.wakeTask(f.task().id);
  assert.equal(calls, 0);
  assert.ok(
    f.store
      .eventsAll(f.task().id)
      .some(
        (event) =>
          event.kind === "thread_archive_wait" &&
          event.detail.includes("active"),
      ),
  );
  active = false;
  const deadline = Date.now() + 3000;
  while (!archived && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(archived, true);
  assert.equal(calls, 1);
});
