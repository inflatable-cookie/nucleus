import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  fixture,
  runningPid,
  wait,
} from "./support/run-process-cleanup-fixture";
import { hostOwesRunProcessCleanup } from "../core/machine/run-process-cleanup";
import { LaneScheduler } from "../core/scheduling/lane-scheduler";
import { LANE_PRIORITY_AUDIT } from "../core/scheduling/lane-priorities";
import {
  TaskQuantum,
  type TaskQuantumContext,
} from "../core/scheduling/task-quantum";
import { runSchema, submissionSchema } from "../shared/contracts";

/**
 * nucleus#1306 review 5943860105: the cleanup lane coalesces every task on a
 * host onto one queued sweep, so that sweep must be host-scoped. A task-scoped
 * one settles only the task whose request got there first and silently leaves
 * the rest of the burst owed.
 */

const base = "b".repeat(40);

/** The one host lane the task quanta schedule cleanup on. */
function laneContext(f: ReturnType<typeof fixture>) {
  const scheduler = new LaneScheduler(
    () => false,
    () => false,
    (work) => work(),
  );
  let listings = 0,
    sweeps = 0;
  const context = {
    stopped: false,
    store: f.store,
    adapter: {
      hostProcessListing: async () => {
        listings++;
        const read = await f.listing();
        return read.state === "listed" ? read.processes : null;
      },
    },
    cleanContext: <T>(work: () => T) => work(),
    scheduleLane: (
      key: string,
      priority: number,
      work: () => Promise<void> | void,
      options?: { coalesce?: string },
    ) =>
      scheduler.scheduleLane(
        key,
        priority,
        async () => {
          sweeps++;
          return work();
        },
        options,
      ),
  } as unknown as TaskQuantumContext;
  return { scheduler, context, listings: () => listings, sweeps: () => sweeps };
}

const tick = (ms = 20) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a burst of tasks on one host coalesces onto one sweep that settles every run", async () => {
  const f = fixture();
  try {
    const run = f.run(),
      child = f.orphan(run, "command");
    await wait(() => existsSync(child.ready));
    f.release(run);
    // A second task on the same host owes its own settled run's cleanup.
    const other = f.store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Second task",
        repoPath: join(f.root, "repo-two"),
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "fixture-host",
      "handoff",
      base,
    );
    const otherRun = runSchema.parse({
      id: "other-task-run",
      taskId: other.id,
      role: "revision",
      generation: 1,
      head: base,
      base,
      agentId: "agent-other",
      workspaceId: "ws",
      profile: null,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(otherRun);
    f.store.putRun({
      ...otherRun,
      released: true,
      status: "finished",
      active: false,
    });
    assert.equal(hostOwesRunProcessCleanup(f.store, "fixture-host"), true);
    const lane = laneContext(f);
    const quantum = new TaskQuantum(lane.context);
    // An earlier sweep still runs on the host lane: both task requests queue
    // behind it, which is the burst the review named.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = lane.scheduler.scheduleLane(
      "cleanup:fixture-host",
      LANE_PRIORITY_AUDIT,
      () => gate,
    );
    await tick();
    quantum.scheduleRunProcessCleanup(f.task.id);
    quantum.scheduleRunProcessCleanup(other.id);
    release();
    await holding;
    await lane.scheduler.quiesce();
    assert.equal(lane.sweeps(), 1, "the burst waited as one sweep");
    assert.ok(
      lane.listings() <= 2,
      "one sweep and at most its bounded re-read after a stop",
    );
    assert.equal(
      f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${run.id}`)
        ?.pending,
      false,
      "the first task's run is settled",
    );
    assert.equal(
      f.store.getMeta<{ pending: boolean }>(`runProcessCleanup:${otherRun.id}`)
        ?.pending,
      false,
      "the coalesced sweep owes every run of the host, not only the first task's",
    );
    await wait(() => !runningPid(child.pid));
    assert.equal(existsSync(run.temporaryDirectory!), false);
  } finally {
    await f.close();
  }
});

test("a host that owes no cleanup queues no sweep", async () => {
  const f = fixture();
  try {
    const run = f.run();
    assert.equal(
      hostOwesRunProcessCleanup(f.store, "fixture-host"),
      false,
      "a live run owes no cleanup",
    );
    const lane = laneContext(f);
    const quantum = new TaskQuantum(lane.context);
    quantum.scheduleRunProcessCleanup(f.task.id);
    await lane.scheduler.quiesce();
    assert.equal(
      lane.listings(),
      0,
      "a quantum never reads the process table for a host with nothing owed",
    );
    // A settled run whose cleanup already completed owes nothing either.
    f.release(run);
    const intent = f.store.getMeta<{ pending?: boolean }>(
      `runProcessCleanup:${run.id}`,
    )!;
    f.store.setMeta(`runProcessCleanup:${run.id}`, {
      ...intent,
      pending: false,
    });
    assert.equal(hostOwesRunProcessCleanup(f.store, "fixture-host"), false);
    quantum.scheduleRunProcessCleanup(f.task.id);
    await lane.scheduler.quiesce();
    assert.equal(lane.listings(), 0, "a completed cleanup is never rescanned");
  } finally {
    await f.close();
  }
});
