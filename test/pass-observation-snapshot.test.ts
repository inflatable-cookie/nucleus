import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type { Adapter, HostProcessFact, TimelinePage } from "../core/host";
import { PassSnapshot, boundedRead } from "../core/scheduling/pass-snapshot";
import { fakeAdapter, submission } from "./support/fakes";
import { toolTimelinePage } from "./support/tool-timeline";
import { runSchema, type Task } from "../shared/contracts";

const HOST = "host-1";
const HEAD = "a".repeat(40);

function runningShellEntry(callId = "call-1") {
  return {
    timestamp: new Date(Date.now() - 20 * 60_000).toISOString(),
    item: {
      type: "tool_call",
      callId,
      name: "shell",
      status: "running",
      detail: { type: "shell", command: "sleep 60" },
    },
  };
}

function seedFinishedWorkerTask(
  store: Store,
  slug: string,
  hostId = HOST,
): { task: Task; runId: string; agentId: string } {
  const inserted = store.insert(
    submission({
      submissionId: `sub-${slug}`,
      title: `Task ${slug}`,
    }),
    hostId,
    "handoff",
    HEAD,
  );
  const agentId = `agent-${slug}`;
  const runId = `run-${slug}`;
  const updated = store.update(inserted.id, {
    phase: "needs_attention",
    workspaceId: `ws-${slug}`,
    directory: `/tmp/synthetic-${slug}`,
    agentId,
    runId,
    reason: "Awaiting tool proof",
  });
  store.putRun(
    runSchema.parse({
      id: runId,
      taskId: updated.id,
      role: "revision",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId,
      workspaceId: `ws-${slug}`,
      hostId,
      profile: null,
      status: "stopped",
      createdAt: new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: new Date().toISOString(),
      completion: null,
      released: false,
    }),
  );
  return { task: store.task(updated.id), runId, agentId };
}

function engineFixture(
  t: TestContext,
  adapterOverrides: Record<string, unknown>,
) {
  const store = new Store(":memory:");
  const adapter = fakeAdapter({
    hostId: HOST,
    observe: async (id: string) => ({
      id,
      workspaceId: `ws-${id.replace(/^agent-/, "")}`,
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: new Date().toISOString(),
    }),
    ...adapterOverrides,
  });
  const engine = new Engine(store, adapter as unknown as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  return { store, engine, adapter };
}

test("PassSnapshot shares one process read within a pass and refuses reuse after expiry", async () => {
  let calls = 0;
  const firstBatch: HostProcessFact[] = [
    {
      pid: 101,
      ppid: 1,
      pgid: 101,
      uid: 501,
      startIdentity: "start-101",
      command: "node worker.js",
      cwd: "/tmp/synthetic-a",
    },
  ];
  const secondBatch: HostProcessFact[] = [
    {
      pid: 202,
      ppid: 1,
      pgid: 202,
      uid: 501,
      startIdentity: "start-202",
      command: "node worker-2.js",
      cwd: "/tmp/synthetic-b",
    },
  ];
  const read = async () => {
    calls++;
    return {
      state: "listed" as const,
      processes: calls === 1 ? firstBatch : secondBatch,
    };
  };

  const snapshot = new PassSnapshot();
  const [a, b] = await Promise.all([
    snapshot.processes(HOST, read, 500),
    snapshot.processes(HOST, read, 500),
  ]);
  assert.equal(calls, 1, "two readers in one pass share a single process read");
  assert.deepEqual(a, { state: "listed", processes: firstBatch });
  assert.deepEqual(b, { state: "listed", processes: firstBatch });

  snapshot.expire();
  assert.equal(snapshot.active, false);
  const afterExpiry = await snapshot.processes(HOST, read, 500);
  assert.equal(calls, 2, "an expired snapshot never serves stale data");
  assert.deepEqual(afterExpiry, { state: "listed", processes: secondBatch });
});

test("two tasks in one audit pass share one process snapshot, and a second pass reads fresh", async (t) => {
  let processCalls = 0;
  const snapshots: HostProcessFact[][] = [
    [
      {
        pid: 1001,
        ppid: 1,
        pgid: 1001,
        uid: 501,
        startIdentity: "pass-1",
        command: "pass-one-proc",
        cwd: "/tmp/synthetic-one",
      },
    ],
    [
      {
        pid: 2002,
        ppid: 1,
        pgid: 2002,
        uid: 501,
        startIdentity: "pass-2",
        command: "pass-two-proc",
        cwd: "/tmp/synthetic-two",
      },
    ],
  ];

  const f = engineFixture(t, {
    hostProcessListing: async () => {
      const idx = Math.min(processCalls, snapshots.length - 1);
      processCalls++;
      return snapshots[idx]!;
    },
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-shared")]),
  });
  const first = seedFinishedWorkerTask(f.store, "one");
  const second = seedFinishedWorkerTask(f.store, "two");

  // During one pass, both tasks' owned-tool reads share the host pass's one
  // process snapshot instead of running `hostProcessListing` per task.
  const observedByTask: Array<{ task: string; pids: number[] }> = [];
  const originalQuantum = f.engine.taskQuantum.bind(f.engine);
  f.engine.taskQuantum = async (taskId: string) => {
    const read = await f.engine.resolution.readPassProcesses(HOST);
    observedByTask.push({
      task: taskId,
      pids: read.state === "listed" ? read.processes.map((p) => p.pid) : [],
    });
    return originalQuantum(taskId);
  };

  await f.engine.auditPass(true);
  assert.equal(
    processCalls,
    1,
    "two tasks in one pass share one process-table read",
  );
  assert.deepEqual(
    observedByTask
      .filter(
        (item) => item.task === first.task.id || item.task === second.task.id,
      )
      .map((item) => item.pids),
    [[1001], [1001]],
  );
  assert.equal(
    f.engine.resolution.currentPassSnapshot(),
    null,
    "the pass snapshot is cleared as soon as the audit pass finishes",
  );

  // Pass 2 must NOT reuse Pass 1's snapshot.
  observedByTask.length = 0;
  await f.engine.auditPass(true);
  assert.equal(
    processCalls,
    2,
    "the next pass takes a fresh process snapshot instead of reusing a stale one",
  );
  assert.deepEqual(
    observedByTask
      .filter(
        (item) => item.task === first.task.id || item.task === second.task.id,
      )
      .map((item) => item.pids),
    [[2002], [2002]],
  );
});

test("a quantum with a 60 s process read returns inside its bound with unknown", async (t) => {
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (slowTimer) clearTimeout(slowTimer);
  });

  const f = engineFixture(t, {
    hostProcessListing: () =>
      new Promise<HostProcessFact[]>((resolve) => {
        slowTimer = setTimeout(() => resolve([]), 60_000);
        slowTimer.unref?.();
      }),
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-slow")]),
  });
  f.engine.resolution.passProcessReadTimeoutMs = 40;
  f.engine.resolution.quantumReadTimeoutMs = 40;

  const { task, runId, agentId } = seedFinishedWorkerTask(f.store, "slow-proc");

  const started = Date.now();
  const hold = await f.engine.resolution.ownedToolHold(agentId, {
    taskId: task.id,
    runId,
    runIds: [runId],
    workspaceId: task.workspaceId!,
    requireCompleteEvidence: true,
  });
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 2_000,
    `expected bounded return well under 60 s, took ${elapsed} ms`,
  );
  assert.ok(
    hold && /unreadable|unknown|timed out/i.test(hold),
    `slow process read must return unknown/unreadable hold rather than clearing, got: ${hold}`,
  );
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "observation_outage").length,
    0,
    "no 120 s quantum outage is recorded",
  );
});

test("timeline reads are shared within one pass, bounded by deadline, and not reused across passes", async (t) => {
  let timelineCalls = 0;
  const f = engineFixture(t, {
    agentTimelinePage: async () => {
      timelineCalls++;
      return toolTimelinePage([]);
    },
  });
  f.engine.resolution.quantumReadTimeoutMs = 50;

  const snap1 = f.engine.resolution.beginPassSnapshot();
  const [p1, p2] = await Promise.all([
    f.engine.resolution.readPassTimelinePage("agent-x", 100, HOST),
    f.engine.resolution.readPassTimelinePage("agent-x", 100, HOST),
  ]);
  assert.equal(timelineCalls, 1, "timeline page is shared within one pass");
  assert.equal(p1.state, "ok");
  assert.equal(p2.state, "ok");
  f.engine.resolution.endPassSnapshot(snap1);

  const snap2 = f.engine.resolution.beginPassSnapshot();
  const p3 = await f.engine.resolution.readPassTimelinePage(
    "agent-x",
    100,
    HOST,
  );
  assert.equal(timelineCalls, 2, "next pass reads a fresh timeline page");
  assert.equal(p3.state, "ok");
  f.engine.resolution.endPassSnapshot(snap2);

  // Slow timeline page hits its deadline and returns unknown.
  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (hangTimer) clearTimeout(hangTimer);
  });
  f.adapter.agentTimelinePage = () =>
    new Promise<TimelinePage | null>((resolve) => {
      hangTimer = setTimeout(() => resolve(toolTimelinePage([])), 60_000);
      hangTimer.unref?.();
    });
  const timedOut = await f.engine.resolution.readPassTimelinePage(
    "agent-hung",
    100,
    HOST,
  );
  assert.equal(timedOut.state, "unknown");
  assert.match(timedOut.reason, /timed out/);
});

test("slow forge externalMerge read inside a task quantum returns unknown instead of hanging or claiming PR open", async (t) => {
  let forgeTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (forgeTimer) clearTimeout(forgeTimer);
  });

  const f = engineFixture(t, {
    externalMerge: () =>
      new Promise<{ head: string; commit: string } | null>((resolve) => {
        forgeTimer = setTimeout(() => resolve(null), 60_000);
        forgeTimer.unref?.();
      }),
    agentTimelinePage: async () => toolTimelinePage([]),
    hostProcessListing: async () => [],
  });
  f.engine.resolution.quantumReadTimeoutMs = 40;
  f.engine.resolution.passProcessReadTimeoutMs = 40;

  const { task } = seedFinishedWorkerTask(f.store, "slow-forge");
  f.store.update(task.id, {
    phase: "awaiting_review",
    prHead: HEAD,
    resumePrNumber: 42,
    reason: "External merge check previously failed",
    reasonFact: { code: "external_merge_check" },
    resolution: {
      ...task.resolution,
      attention: true,
    },
  });

  const started = Date.now();
  const recovered = await f.engine.resolution.recoverExternalMerge(
    f.store.task(task.id),
  );
  const elapsed = Date.now() - started;

  assert.equal(recovered, false);
  assert.ok(elapsed < 2_000, `expected bounded forge read, took ${elapsed} ms`);
  assert.equal(
    f.store.task(task.id).resolution.attention,
    true,
    "a timed-out forge read is unknown, not 'PR is open', so attention stays set",
  );
});

test("boundedRead propagates errors thrown before deadline and swallows late rejections after timeout", async () => {
  await assert.rejects(
    boundedRead(
      "failing read",
      async () => {
        throw new Error("transport boom");
      },
      1_000,
    ),
    /transport boom/,
  );

  let rejectLate!: (error: Error) => void;
  const late = new Promise<string>((_resolve, reject) => {
    rejectLate = reject;
  });
  const result = await boundedRead("late reject", () => late, 10);
  assert.equal(result.state, "unknown");
  rejectLate(new Error("late failure after timeout"));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("timing: task quantum with a 60 s process double settles inside its bound with unknown", async (t) => {
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (slowTimer) clearTimeout(slowTimer);
  });

  const f = engineFixture(t, {
    hostProcessListing: () =>
      new Promise<HostProcessFact[]>((resolve) => {
        slowTimer = setTimeout(() => resolve([]), 60_000);
        slowTimer.unref?.();
      }),
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-timing")]),
  });
  // Keep a real wall-clock deadline (250 ms) against the 60 s process double
  // so the timing lane verifies real elapsed time stays well inside the bound.
  f.engine.resolution.passProcessReadTimeoutMs = 250;
  f.engine.resolution.quantumReadTimeoutMs = 250;

  const { task } = seedFinishedWorkerTask(f.store, "timing-slow");

  const started = performance.now();
  await f.engine.auditPass(true);
  const elapsedMs = performance.now() - started;

  assert.ok(
    elapsedMs < 5_000,
    `audit pass with 60 s process double should settle inside its bound, took ${elapsedMs.toFixed(1)} ms`,
  );
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "observation_outage").length,
    0,
    "task quantum must not hit the 120 s observation_outage bound",
  );
});
