import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

test("thread archive recovery resumes the workspace archive without a sweep", async (t) => {
  const f = await terminalArchiveFixture(t);
  f.engine.completionFollowUpDelays = [20, 40, 80, 160, 320];
  f.store.update(f.task().id, {
    phase: "closing",
    resolution: {
      ...f.task().resolution,
      workspaceArchiveRetries: [],
      cleanupReason: "",
    },
  });
  (f.engine.resolution as any).integrationQuantum = async (
    _id: string,
    work: () => Promise<void>,
  ) => {
    if (f.task().phase === "closing")
      f.store.update(
        f.task().id,
        { phase: "done" },
        "closed_out",
        "fixture closeout",
      );
    await work();
  };
  let unavailable = true,
    archived = false;
  f.adapter.observe = async (id) => ({
    id,
    workspaceId: "ws",
    status: "idle",
    active: false,
    permissions: false,
    error: "",
    labels: { "northstar.task": f.task().id },
  });
  f.adapter.originAgent = async (id) => {
    if (unavailable) throw Error("Transport not connected");
    return { id, workspaceId: "ws", title: "", archived };
  };
  f.adapter.archiveAgent = async () => {
    archived = true;
  };
  await f.engine.wakeTask(f.task().id);
  assert.equal(f.remote.archives.length, 0, "workspace waits for the thread");
  unavailable = false;
  const deadline = Date.now() + 6000;
  while (
    !f.task().resolution.archivedWorkspaceIds.includes("ws") &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(archived, true);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ["ws"]);
});
