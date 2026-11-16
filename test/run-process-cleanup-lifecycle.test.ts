import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, runningPid, wait } from "./support/run-process-cleanup-fixture";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { processParentPid } from "../core/machine/process-identity";

test("initial worker report and displaced-worker identity persist cleanup independently of the task's next run", async () => {
  const f = fixture();
  try {
    const run = f.run("revision");
    f.store.update(f.task.id, { runId: run.id, agentId: run.agentId, temporaryDirectory: run.temporaryDirectory }, "fixture_launch");
    f.store.update(f.task.id, { completion: { taskId: f.task.id, runId: run.id, eventId: "report", status: "progress_checkpoint", summary: "fixture" } }, "fixture_report");
    assert.ok(f.store.getMeta(`runProcessCleanup:${run.id}`));
    f.store.update(f.task.id, { runId: randomUUID(), agentId: "next-worker", completion: null, temporaryDirectory: undefined }, "fixture_next");
    f.release(run); await f.cleanup();
    assert.equal(existsSync(run.temporaryDirectory!), false);
    assert.equal(f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)?.pending, false);
  } finally { await f.close(); }
});

test("rollback preserves scratch and does not publish a cleanup intent", async () => {
  const f = fixture();
  try {
    const run = f.run();
    assert.throws(() => f.store.transaction(() => { f.release(run); throw Error("rollback fixture"); }), /rollback fixture/);
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(f.store.getMeta(`runProcessCleanup:${run.id}`), undefined);
    await f.cleanup();
    assert.ok(existsSync(run.temporaryDirectory!));
  } finally { await f.close(); }
});

test("settled attached tools stop after helper exit while their observed provider stays alive", async () => {
  const f = fixture();
  try {
    const run = f.run(), child = await f.hostTool(run);
    await f.cleanup();
    assert.equal(processParentPid(child.tool), child.host, "the tool has a live non-init parent");
    process.kill(child.helper, "SIGKILL");
    await wait(() => !runningPid(child.helper));
    f.release(run); await f.cleanup();
    await wait(() => !runningPid(child.tool));
    assert.ok(runningPid(child.host)); assert.equal(runningPid(child.helper), false);
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally { await f.close(); }
});
