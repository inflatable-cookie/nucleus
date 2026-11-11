import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

test("terminal thread observation retries after transport reconnects without a sweep", async (t) => {
  const f = await terminalArchiveFixture(t);
  f.engine.completionFollowUpDelays = [10, 20, 40, 80, 160];
  let failed = false,
    archived = false,
    archiveCalls = 0;
  f.adapter.observe = async (id) => {
    if (!failed) {
      failed = true;
      throw Error("Transport not connected");
    }
    return {
      id,
      workspaceId: "ws",
      status: "idle",
      active: false,
      permissions: false,
      error: "",
      labels: { "northstar.task": f.task().id },
    };
  };
  f.adapter.originAgent = async (id) => ({
    id,
    workspaceId: "ws",
    title: "",
    archived,
  });
  f.adapter.archiveAgent = async () => {
    archiveCalls++;
    archived = true;
  };
  await f.engine.wakeTask(f.task().id);
  const deadline = Date.now() + 3000;
  while (!archived && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    archived,
    true,
    "the bounded retry archived after the transport returned",
  );
  assert.equal(archiveCalls, 1);
  assert.ok(
    f.store
      .eventsAll(f.task().id)
      .some(
        (event) =>
          event.kind === "thread_archive_wait" &&
          event.detail.includes("Transport not connected"),
      ),
  );
});
