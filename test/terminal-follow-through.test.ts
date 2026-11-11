import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

test("closeout schedules workspace archive without a sweep tick", async (t) => {
  const f = await terminalArchiveFixture(t);
  f.store.update(f.task().id, {
    phase: "closing",
    resolution: {
      ...f.task().resolution,
      workspaceArchiveRetries: [],
      cleanupReason: "",
    },
  });
  // Model the closeout transition within the real task-lane quantum.
  const resolution = f.engine.resolution as any;
  resolution.integrationQuantum = async (
    _id: string,
    work: () => Promise<void>,
  ) => {
    f.store.update(
      f.task().id,
      { phase: "done" },
      "closed_out",
      "fixture closeout",
    );
    await work();
  };
  f.adapter.originAgent = async () => null;
  const started = Date.now();
  await f.engine.wakeTask(f.task().id);
  await f.engine.quiesce();
  await f.engine.drainCleanup();
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ["ws"]);
  assert.equal(f.remote.archives.length, 1);
  t.diagnostic(
    `fixture closeout to workspace archived: ${Date.now() - started} ms, one native archive request, no sweep tick`,
  );
});


test("completion follow-through uses live engine overrides without delaying output settlement", async (t) => {
  const f = await terminalArchiveFixture(t);
  const completion = f.engine.completionFollowUps;
  const calls: string[] = [];
  // Replace ports after the phase context exists, as retained test and adapter overrides do.
  f.engine.terminalThreadsPending = () => false;
  f.engine.scheduleCompletionFollowUp = () => { calls.push("completion"); };
  f.engine.scheduleTerminalArchiveRetry = () => { calls.push("terminal_archive"); };
  f.engine.scheduleRunBuildOutputs = () => { calls.push("build_output"); return Promise.resolve(); };
  f.engine.enqueueCleanup = () => { calls.push("cleanup"); };
  const after = f.task();
  const before = { ...after, phase: "closing" as const, resolution: { ...after.resolution, integrationTurn: null } };
  completion.finishQuantum(after.id, before, f.store.runs(after.id), undefined, false, false, false);
  assert.deepEqual(calls, ["completion", "terminal_archive", "build_output"]);
  await Promise.resolve();
  assert.deepEqual(calls, ["completion", "terminal_archive", "build_output", "cleanup"]);
});
