import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type {
  Adapter,
  AgentObservation,
  HostProcessFact,
  TimelinePage,
} from "../core/host";
import {
  PassSnapshot,
  boundedRead,
  isQuantumDeadlineExceeded,
  runInTaskQuantumScope,
} from "../core/scheduling/pass-snapshot";
import { HostFacade } from "../core/host/host-facade";
import { LANE_PRIORITY_TASK } from "../core/scheduling/lane-priorities";
import { readProcessSubset } from "../core/machine/host-process-listing";
import { observeAssignedThread } from "../core/dispatch/run-launch/assigned-thread";
import type { LaunchThreadContext } from "../core/dispatch/launch";
import { fakeAdapter, submission } from "./support/fakes";
import {
  longToolHistory,
  toolTimelinePage,
  toolTimelineTail,
} from "./support/tool-timeline";
import { runSchema, type Task } from "../shared/contracts";

const HOST = "host-1";
const HEAD = "a".repeat(40);

function runningShellEntry(callId = "call-1", timestamp?: string) {
  return {
    timestamp: timestamp ?? new Date(Date.now() - 20 * 60_000).toISOString(),
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
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
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
  assert.equal(a.state, "listed");
  assert.equal(b.state, "listed");
  assert.deepEqual(a.processes, firstBatch);
  assert.deepEqual(b.processes, firstBatch);
  assert.equal(a.fromPassSnapshot, true);

  snapshot.expire();
  assert.equal(snapshot.active, false);
  const afterExpiry = await snapshot.processes(HOST, read, 500);
  assert.equal(calls, 2, "an expired snapshot never serves stale data");
  assert.equal(afterExpiry.state, "listed");
  assert.deepEqual(afterExpiry.processes, secondBatch);
  assert.equal(afterExpiry.fromPassSnapshot, false);
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

test("a process snapshot predating a new child or idle transition never clears an owned-tool hold", async (t) => {
  const runUuid = "11111111-1111-4111-8111-111111111111";
  const providerPid = 5000;
  const helperPid = 5001;
  const emptyTree: HostProcessFact[] = [
    {
      pid: providerPid,
      ppid: 1,
      pgid: providerPid,
      uid: 501,
      startIdentity: "provider-start",
      command: "node provider-app",
      cwd: "/tmp/synthetic-race",
    },
    {
      pid: helperPid,
      ppid: providerPid,
      pgid: providerPid,
      uid: 501,
      startIdentity: "helper-start",
      command: `node mcp-report.mjs /tmp/tickets/mcp-${runUuid}.json`,
      cwd: "/tmp/synthetic-race",
    },
  ];

  // At host-pass time, the worker is STILL ACTIVE; between host-pass capture
  // and task-quantum owned-tool proof, the worker launches a shell child and
  // finishes its turn. The cached empty tree MUST NOT clear the hold.
  let idleNow = false;
  let shellStartedAt = new Date().toISOString();
  const f = engineFixture(t, {
    hostProcessListing: async () => emptyTree,
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-race",
            status: "running",
            active: true,
            activeTurnId: "turn-1",
            permissions: false,
            error: "",
            updatedAt: new Date(Date.now() - 5_000).toISOString(),
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-race",
      status: idleNow ? "idle" : "running",
      active: !idleNow,
      activeTurnId: idleNow ? null : "turn-1",
      permissions: false,
      error: "",
      updatedAt: new Date().toISOString(),
    }),
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-race", shellStartedAt)]),
  });

  const inserted = f.store.insert(
    submission({ submissionId: "sub-race", title: "Race task" }),
    HOST,
    "handoff",
    HEAD,
  );
  const updated = f.store.update(inserted.id, {
    phase: "needs_attention",
    workspaceId: "ws-race",
    directory: "/tmp/synthetic-race",
    agentId: "agent-race",
    runId: runUuid,
    reason: "Awaiting tool proof",
  });
  f.store.putRun(
    runSchema.parse({
      id: runUuid,
      taskId: updated.id,
      role: "revision",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-race",
      workspaceId: "ws-race",
      hostId: HOST,
      profile: null,
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );

  // Start a pass snapshot: pre-process inventory sees agent active, then
  // processSnapshot captures the empty tree.
  const snap = f.engine.resolution.beginPassSnapshot();
  f.engine.resolution.recordPassHostInventory(
    HOST,
    new Map([
      [
        "agent-race",
        {
          id: "agent-race",
          workspaceId: "ws-race",
          status: "running",
          active: true,
          activeTurnId: "turn-1",
          permissions: false,
          error: "",
          updatedAt: new Date(Date.now() - 5_000).toISOString(),
        },
      ],
    ]),
  );
  await f.engine.resolution.primePassProcesses(HOST);

  // Now the worker spawns a shell child and becomes idle AFTER the snapshot.
  await new Promise((resolve) => setTimeout(resolve, 10));
  shellStartedAt = new Date().toISOString();
  idleNow = true;

  const hold = await f.engine.resolution.ownedToolHold("agent-race", {
    taskId: updated.id,
    runId: runUuid,
    runIds: [runUuid],
    workspaceId: "ws-race",
    requireCompleteEvidence: true,
  });
  f.engine.resolution.endPassSnapshot(snap);

  assert.equal(
    hold.kind,
    "deferred",
    `pre-idle pass process snapshot must defer, got: ${JSON.stringify(hold)}`,
  );
  assert.match(
    hold.reason,
    /predates|before the participant was proven inactive/i,
  );
  assert.equal(
    f.store
      .events(updated.id)
      .filter((event) => event.kind === "owned_tool_settled").length,
    0,
    "owned_tool_settled must NOT be recorded from a pre-idle process snapshot",
  );
});

test("a creation message appended between pre-closure read and closure is never settled as absent", async (t) => {
  const runId = "22222222-2222-4222-8222-222222222222";
  const agentId = "agent-delivery-race";
  const workspaceId = "ws-delivery-race";
  let closed = false;
  let messageAppended = false;
  let timelineReads = 0;

  const f = engineFixture(t, {
    originAgent: async (id: string) => ({
      id,
      workspaceId,
      archived: false,
      deleted: false,
    }),
    observe: async (id: string) => ({
      id,
      workspaceId,
      status: closed ? "closed" : "running",
      active: !closed,
      activeTurnId: closed ? null : "turn-live",
      permissions: false,
      error: "",
      updatedAt: new Date().toISOString(),
    }),
    agentTimelinePage: async () => {
      timelineReads++;
      return toolTimelinePage(
        messageAppended
          ? [
              {
                timestamp: new Date().toISOString(),
                item: {
                  type: "user_message",
                  messageId: `ns-run-${runId}`,
                  text: "creation prompt",
                },
              },
            ]
          : [],
      );
    },
  });

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-delivery-race",
      title: "Delivery race",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "needs_attention",
    workspaceId,
    directory: "/tmp/synthetic-delivery-race",
    agentId,
    runId,
    reason: "Uncertain released run",
  });
  f.store.putRun(
    runSchema.parse({
      id: runId,
      taskId: task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId,
      workspaceId,
      hostId: HOST,
      profile: null,
      status: "uncertain",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: null,
      completion: null,
      released: true,
    }),
  );

  // Pass 1: agent is still live during HostPass; HostPass must NOT prime a
  // pre-closure page for it. Even if some other reader cached an empty page
  // before closure, reconciling after closure must never record
  // `run_delivery_not_delivered`.
  const snap1 = f.engine.resolution.beginPassSnapshot();
  await f.engine.resolution.readPassTimelinePage(agentId, 100, HOST);
  assert.equal(timelineReads, 1);

  // Now the host appends the creation message and closes the agent.
  messageAppended = true;
  closed = true;

  await assert.rejects(
    f.engine.resolution.reconcileUncertainRunDelivery(task.id, runId),
    /predates agent closure/,
    "reconciliation must refuse negative settlement from a pre-closure cached page",
  );
  f.engine.resolution.endPassSnapshot(snap1);

  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "run_delivery_not_delivered").length,
    0,
    "run_delivery_not_delivered must never be recorded from a pre-closure page",
  );

  // Pass 2: agent is closed, so HostPass proves closure first and primes the
  // post-closure page containing the creation message -> reconciled as delivered!
  await f.engine.auditPass(true);
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "run_delivery_reconciled").length,
    1,
    "next pass observes the post-closure message and settles delivery as reconciled",
  );
});

test("a quantum with a 60 s process read returns with unknown without clearing the hold", async (t) => {
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (slowTimer) clearTimeout(slowTimer);
  });

  let attempts = 0;
  const f = engineFixture(t, {
    hostProcessListing: () => {
      attempts++;
      return new Promise<HostProcessFact[]>((resolve) => {
        slowTimer = setTimeout(() => resolve([]), 60_000);
        slowTimer.unref?.();
      });
    },
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-slow")]),
  });
  f.engine.resolution.passProcessReadTimeoutMs = 40;
  f.engine.resolution.quantumReadTimeoutMs = 40;

  const { task, runId, agentId } = seedFinishedWorkerTask(f.store, "slow-proc");

  const hold = await f.engine.resolution.ownedToolHold(agentId, {
    taskId: task.id,
    runId,
    runIds: [runId],
    workspaceId: task.workspaceId!,
    requireCompleteEvidence: true,
  });

  assert.equal(attempts, 1, "slow process listing was attempted");
  assert.equal(
    hold.kind,
    "deferred",
    `slow process read must return deferred rather than clearing, got: ${JSON.stringify(hold)}`,
  );
  assert.ok(
    hold.kind === "deferred" &&
      /unreadable|unknown|timed out/i.test(hold.reason),
    `slow process read must return deferred reason, got: ${JSON.stringify(hold)}`,
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
  // A limit-200 tool read also covers a subsequent limit-100 read for the same agent in the same pass.
  const [p1, p2] = await Promise.all([
    f.engine.resolution.readPassTimelinePage("agent-x", 200, HOST),
    f.engine.resolution.readPassTimelinePage("agent-x", 100, HOST),
  ]);
  assert.equal(
    timelineCalls,
    1,
    "wider timeline page is shared across readers in one pass",
  );
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

test("slow forge externalMerge read inside a task quantum returns unknown instead of claiming PR open", async (t) => {
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

  const recovered = await f.engine.resolution.recoverExternalMerge(
    f.store.task(task.id),
  );

  assert.equal(recovered, false);
  assert.equal(
    f.store.task(task.id).resolution.attention,
    true,
    "a timed-out forge read is unknown, not 'PR is open', so attention stays set",
  );
});

test("retained reviewer observation and retained-thread dispatch return inside deadline when host or process reads hang", async (t) => {
  let observeTimer: ReturnType<typeof setTimeout> | undefined;
  let processTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (observeTimer) clearTimeout(observeTimer);
    if (processTimer) clearTimeout(processTimer);
  });

  const f = engineFixture(t, {
    observe: () =>
      new Promise<AgentObservation>((resolve) => {
        observeTimer = setTimeout(
          () =>
            resolve({
              id: "agent-rev",
              workspaceId: "ws-rev",
              status: "closed",
              active: false,
              activeTurnId: null,
              permissions: false,
              error: "",
            }),
          60_000,
        );
        observeTimer.unref?.();
      }),
    hostProcessListing: () =>
      new Promise<HostProcessFact[]>((resolve) => {
        processTimer = setTimeout(() => resolve([]), 60_000);
        processTimer.unref?.();
      }),
  });
  f.engine.resolution.quantumReadTimeoutMs = 30;
  f.engine.resolution.passProcessReadTimeoutMs = 30;

  const inserted = f.store.insert(
    submission({ submissionId: "sub-rev-hang", title: "Retained reviewer" }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "reviewing",
    workspaceId: "ws-rev",
    directory: "/tmp/synthetic-rev",
    agentId: "agent-worker",
    runId: "run-worker",
    resolution: {
      ...inserted.resolution,
      currentRunId: "run-rev",
      reviewerAgentId: "agent-rev",
    },
  });
  f.store.putRun(
    runSchema.parse({
      id: "run-rev",
      taskId: task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-rev",
      workspaceId: "ws-rev",
      hostId: HOST,
      profile: null,
      status: "stopped",
      createdAt: new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: new Date().toISOString(),
      completion: null,
      released: false,
      reviewCheckpoints: [
        {
          ordinal: 1,
          head: HEAD,
          at: new Date().toISOString(),
          runId: "run-rev",
          path: "/tmp/synthetic-rev/checkpoint-1.json",
          checkpoint: {
            covered: ["core/scheduling/pass-snapshot.ts"],
            remaining: ["core/scheduling/host-pass.ts"],
          },
        },
      ],
    }),
  );

  // Retained reviewer check must settle cleanly on observe timeout without marking closed.
  await f.engine.reconcileClosedRetainedReviewer(task.id);
  assert.equal(f.store.run("run-rev")?.retainedAgentClosedAt ?? null, null);

  // Retained-thread dispatch with hung observe must record a lifecycle wait and return handled.
  const waits: string[] = [];
  const ctx = {
    adapter: f.adapter,
    host: f.engine.host,
    store: f.store,
    quantumReadTimeoutMs: 30,
    readPassProcesses: (hostId?: string | null) =>
      f.engine.resolution.readPassProcesses(hostId),
    waiting: (_task: Task, reason: string) => {
      waits.push(reason);
    },
  } as unknown as LaunchThreadContext;
  const assigned = await observeAssignedThread(
    ctx,
    task,
    "reviewer",
    "agent-rev",
    "ws-rev",
    () => false,
  );
  assert.deepEqual(assigned, { kind: "handled" });
  assert.ok(
    waits.some((reason) => /unknown|timed out/i.test(reason)),
    `expected unknown wait on observe timeout, got: ${waits.join("; ")}`,
  );
});

test("a slow host warming backlog hits its per-host budget and stops without stalling later reads", async (t) => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  let timelineCalls = 0;
  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: `ws-${id}`,
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ]),
      ),
    agentTimelinePage: () => {
      timelineCalls++;
      return new Promise<TimelinePage | null>((resolve) => {
        const timer = setTimeout(() => resolve(toolTimelinePage([])), 60_000);
        timer.unref?.();
        timers.push(timer);
      });
    },
  });
  f.engine.resolution.hostPassWarmBudgetMs = 40;
  f.engine.resolution.quantumReadTimeoutMs = 40;

  // Seed 12 tasks on the slow host; warming must stop once the budget is spent.
  for (let i = 0; i < 12; i++) seedFinishedWorkerTask(f.store, `backlog-${i}`);

  const result = await f.engine.auditPass(true);
  assert.equal(result.fault, null);
  assert.equal(result.covered, true);
  assert.ok(
    timelineCalls <= 3,
    `warming budget must cap slow timeline reads instead of walking all 12 serially, saw ${timelineCalls}`,
  );
});

test("a warmed empty tool page never clears a lease after a newer turn changes updatedAt", async (t) => {
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const t1 = new Date(Date.now() - 5_000).toISOString();
  let currentUpdatedAt = t0;

  const f = engineFixture(t, {
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-warmed",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: currentUpdatedAt,
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
  });
  const { task, runId, agentId } = seedFinishedWorkerTask(f.store, "warmed");

  // Warm the empty tool page while the participant is idle at `t0`.
  const snap = f.engine.resolution.beginPassSnapshot();
  await f.engine.resolution.primePassTimelinePage(agentId, 200, HOST, {
    coveredObservation: { updatedAt: t0, status: "idle", archived: false },
  });

  // Between warming and the merge lease check, the participant runs another
  // turn and returns to idle at `t1`.
  currentUpdatedAt = t1;

  const hold = await f.engine.resolution.ownedToolHold(agentId, {
    taskId: task.id,
    runId,
    runIds: [runId],
    workspaceId: task.workspaceId!,
    requireCompleteEvidence: true,
  });
  f.engine.resolution.endPassSnapshot(snap);

  assert.equal(
    hold.kind,
    "deferred",
    `warmed empty page must not clear after a newer turn, got: ${JSON.stringify(hold)}`,
  );
  assert.ok(
    hold.kind === "deferred" &&
      /predates the participant's latest observation/i.test(hold.reason),
    `warmed empty page must not clear after a newer turn, got: ${JSON.stringify(hold)}`,
  );
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "owned_tool_settled").length,
    0,
  );
});

test("an archived participant omitted from live inventory clears scratch process proof via host pass terminal lookup", async (t) => {
  const agentId = "agent-archived";
  const workspaceId = "ws-archived";
  const runId = "33333333-3333-4333-8333-333333333333";
  let processListings = 0;

  const f = engineFixture(t, {
    // Paseo live inventory deliberately omits archived agents.
    observationInventory: async () => new Map<string, AgentObservation>(),
    originAgent: async (id: string) => ({
      id,
      workspaceId,
      archived: true,
      deleted: false,
    }),
    observe: async (id: string) => ({
      id,
      workspaceId,
      status: "closed",
      archived: true,
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    }),
    hostProcessListing: async () => {
      processListings++;
      return [];
    },
    noLiveWorkspaceProcesses: async (
      _ws: string,
      _runs: readonly string[],
      _runtime?: unknown,
      prelisted?: HostProcessFact[] | null,
    ) => {
      assert.ok(
        Array.isArray(prelisted),
        "noLiveWorkspaceProcesses receives the shared pass process list without rescanning",
      );
      return null;
    },
  });

  const inserted = f.store.insert(
    submission({ submissionId: "sub-archived", title: "Archived participant" }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "needs_attention",
    workspaceId,
    directory: "/tmp/synthetic-archived",
    temporaryDirectory: "/tmp/synthetic-archived-scratch",
    agentId,
    runId,
    reason: "Waiting on retired custody proof",
  });
  f.store.putRun(
    runSchema.parse({
      id: runId,
      taskId: task.id,
      role: "revision",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId,
      workspaceId,
      hostId: HOST,
      temporaryDirectory: "/tmp/synthetic-archived-scratch",
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

  let holdDuringPass: Awaited<
    ReturnType<typeof f.engine.resolution.ownedToolHold>
  > | null = null;
  const originalQuantum = f.engine.taskQuantum.bind(f.engine);
  f.engine.taskQuantum = async (taskId: string) => {
    if (taskId === task.id) {
      holdDuringPass = await f.engine.resolution.ownedToolHold(agentId, {
        requireCompleteEvidence: true,
        allowRetired: true,
        runId,
        runIds: [runId],
        taskId: task.id,
        workspaceId,
      });
    }
    return originalQuantum(taskId);
  };

  await f.engine.auditPass(true);
  assert.deepEqual(
    holdDuringPass,
    { kind: "clear" },
    "archived participant omitted from live inventory clears via pre-process exact terminal lookup",
  );
  assert.equal(
    processListings,
    1,
    "process table was scanned once for the pass and reused by noLiveWorkspaceProcesses",
  );
});

test("a closed resumable thread that resumes and closes again cannot reuse an earlier closure page for negative delivery", async (t) => {
  const runId = "44444444-4444-4444-8444-444444444444";
  const agentId = "agent-resumable-closed";
  const workspaceId = "ws-resumable-closed";
  const firstClosureAt = new Date(Date.now() - 30_000).toISOString();
  const secondClosureAt = new Date(Date.now() - 1_000).toISOString();

  const f = engineFixture(t, {
    originAgent: async (id: string) => ({
      id,
      workspaceId,
      archived: false,
      deleted: false,
    }),
    observe: async (id: string) => ({
      id,
      workspaceId,
      status: "closed",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: secondClosureAt,
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
  });

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-resumable-closed",
      title: "Resumable closed delivery",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "needs_attention",
    workspaceId,
    directory: "/tmp/synthetic-resumable-closed",
    agentId,
    runId,
    reason: "Uncertain released run",
  });
  f.store.putRun(
    runSchema.parse({
      id: runId,
      taskId: task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId,
      workspaceId,
      hostId: HOST,
      profile: null,
      status: "uncertain",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: null,
      completion: null,
      released: true,
    }),
  );

  // Pass snapshot holds a page proven terminal at `firstClosureAt`, while the
  // current closed observation reports `secondClosureAt` after a resumed turn.
  const snap = f.engine.resolution.beginPassSnapshot();
  await f.engine.resolution.primePassTimelinePage(agentId, 100, HOST, {
    provenTerminal: {
      archived: false,
      workspaceId,
      closedUpdatedAt: firstClosureAt,
    },
  });

  await assert.rejects(
    f.engine.resolution.reconcileUncertainRunDelivery(task.id, runId),
    /predates agent closure/,
    "negative settlement must refuse a page from an earlier closure of a resumable thread",
  );
  f.engine.resolution.endPassSnapshot(snap);

  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "run_delivery_not_delivered").length,
    0,
  );
});

test("supersededIdleFence bounds hung observe, and sealed host passes treat task-lane timeline misses as unknown", async (t) => {
  let observeTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (observeTimer) clearTimeout(observeTimer);
  });

  let timelineCalls = 0;
  const f = engineFixture(t, {
    observe: () =>
      new Promise<AgentObservation>((resolve) => {
        observeTimer = setTimeout(
          () =>
            resolve({
              id: "agent-superseded",
              workspaceId: "ws-superseded",
              status: "idle",
              active: false,
              activeTurnId: null,
              permissions: false,
              error: "",
            }),
          60_000,
        );
        observeTimer.unref?.();
      }),
    originAgent: () =>
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 60_000);
        timer.unref?.();
        t.after(() => clearTimeout(timer));
      }),
    agentTimelinePage: async () => {
      timelineCalls++;
      return toolTimelinePage([]);
    },
  });
  f.engine.resolution.quantumReadTimeoutMs = 30;

  const { task } = seedFinishedWorkerTask(f.store, "superseded");
  const run = runSchema.parse({
    id: "run-superseded",
    taskId: task.id,
    role: "reviewer",
    generation: 1,
    head: HEAD,
    base: HEAD,
    agentId: "agent-superseded",
    workspaceId: "ws-superseded",
    hostId: HOST,
    profile: null,
    status: "stopped",
    createdAt: new Date().toISOString(),
    lastObservedAt: new Date().toISOString(),
    active: false,
    idleSince: new Date().toISOString(),
    completion: null,
    released: false,
  });
  f.store.putRun(run);

  // `supersededIdleFence` must return an explicit unobservable hold inside the deadline.
  const fence = await (
    f.engine as unknown as {
      runRelease: {
        supersededIdleFence(r: typeof run): Promise<string | null>;
      };
    }
  ).runRelease.supersededIdleFence(run);
  assert.equal(fence, "its agent is unobservable");

  // Once a host is sealed after HostPass warming, task-lane timeline misses
  // return explicit unknown without issuing any timeline RPC.
  const snap = f.engine.resolution.beginPassSnapshot();
  f.engine.resolution.sealPassHost(HOST);
  const miss = await f.engine.resolution.readPassTimelinePage(
    "agent-unprimed",
    200,
    HOST,
  );
  f.engine.resolution.endPassSnapshot(snap);
  assert.equal(miss.state, "unknown");
  assert.equal(
    timelineCalls,
    0,
    "sealed host pass must not start a new timeline RPC on a task-lane miss",
  );
});

test("persistently slow first warming candidate does not starve a healthy candidate across passes", async (t) => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  const runSlow = "55555555-5555-4555-8555-555555555555";
  const runFast = "66666666-6666-4666-8666-666666666666";
  const f = engineFixture(t, {
    originAgent: async (id: string) => {
      if (id === "agent-slow-first") {
        return new Promise((resolve) => {
          const timer = setTimeout(
            () =>
              resolve({
                id,
                workspaceId: "ws-slow-first",
                archived: true,
                deleted: false,
              }),
            60_000,
          );
          timer.unref?.();
          timers.push(timer);
        });
      }
      return {
        id,
        workspaceId: "ws-fast-second",
        archived: true,
        deleted: false,
      };
    },
    agentTimelinePage: async (id: string) => {
      if (id === "agent-fast-second") {
        return toolTimelinePage([
          {
            timestamp: new Date().toISOString(),
            item: {
              type: "user_message",
              messageId: `ns-run-${runFast}`,
              text: "prompt",
            },
          },
        ]);
      }
      return toolTimelinePage([]);
    },
  });
  f.engine.resolution.hostPassWarmBudgetMs = 60;
  f.engine.resolution.quantumReadTimeoutMs = 40;

  const slowInserted = f.store.insert(
    submission({ submissionId: "sub-slow-first", title: "Slow first" }),
    HOST,
    "handoff",
    HEAD,
  );
  const slowTask = f.store.update(slowInserted.id, {
    phase: "needs_attention",
    workspaceId: "ws-slow-first",
    directory: "/tmp/synthetic-slow-first",
    agentId: "agent-slow-first",
    runId: runSlow,
  });
  f.store.putRun(
    runSchema.parse({
      id: runSlow,
      taskId: slowTask.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-slow-first",
      workspaceId: "ws-slow-first",
      hostId: HOST,
      profile: null,
      status: "uncertain",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: null,
      completion: null,
      released: true,
    }),
  );

  const fastInserted = f.store.insert(
    submission({ submissionId: "sub-fast-second", title: "Fast second" }),
    HOST,
    "handoff",
    HEAD,
  );
  const fastTask = f.store.update(fastInserted.id, {
    phase: "needs_attention",
    workspaceId: "ws-fast-second",
    directory: "/tmp/synthetic-fast-second",
    agentId: "agent-fast-second",
    runId: runFast,
  });
  f.store.putRun(
    runSchema.parse({
      id: runFast,
      taskId: fastTask.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-fast-second",
      workspaceId: "ws-fast-second",
      hostId: HOST,
      profile: null,
      status: "uncertain",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: null,
      completion: null,
      released: true,
    }),
  );

  // Run two passes: rotating candidate order guarantees the healthy second
  // task settles even while the first candidate hangs every pass.
  await f.engine.auditPass(true);
  await f.engine.auditPass(true);

  assert.equal(
    f.store
      .events(fastTask.id)
      .filter((event) => event.kind === "run_delivery_reconciled").length,
    1,
    "healthy candidate settles across passes without being starved by a persistently slow first candidate",
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

test("timing: sweep merge quantum with a 60 s process double records unknown hold inside its bound", async (t) => {
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (slowTimer) clearTimeout(slowTimer);
  });

  let processListingAttempts = 0;
  let mergeAttempts = 0;
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-timing-merge",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-timing-merge",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt,
    }),
    hostProcessListing: () => {
      processListingAttempts++;
      return new Promise<HostProcessFact[]>((resolve) => {
        slowTimer = setTimeout(() => resolve([]), 60_000);
        slowTimer.unref?.();
      });
    },
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-timing-merge")]),
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during merge verification");
    },
    merge: async () => {
      mergeAttempts++;
      return "merged-commit";
    },
  });
  f.store.setMeta("paused", false);
  f.engine.resolution.passProcessReadTimeoutMs = 250;
  f.engine.resolution.quantumReadTimeoutMs = 250;
  f.engine.resolution.hostPassWarmBudgetMs = 500;

  // Seed a real `merging` task whose production quantum enters
  // `resolution.advance` -> `mergeGates.advanceMerging` -> `executionLease` -> `ownedToolHold`.
  const inserted = f.store.insert(
    submission({
      submissionId: "sub-timing-merge",
      title: "Timing merge task",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-timing-merge",
    directory: "/tmp/synthetic-timing-merge",
    agentId: "agent-timing-merge",
    runId: "run-timing-merge",
    prUrl: "https://github.com/example/repo/pull/99",
    prHead: HEAD,
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: updatedAt },
      mergeIntent: true,
      mergeHead: HEAD,
      mergeRequestedAt: updatedAt,
      review: {
        eventId: "ev-timing-merge",
        taskId: inserted.id,
        runId: "rev-timing-merge",
        reviewId: 901,
        status: "ready_to_merge",
        head: HEAD,
        summary: "ok",
      },
    },
  });

  const started = performance.now();
  const pass = await f.engine.auditPass(true);
  const elapsedMs = performance.now() - started;

  const after = f.store.task(task.id);
  assert.equal(pass.fault, null, "audit pass completed without engine fault");
  assert.equal(pass.covered, true, "audit pass covered the target task");
  assert.equal(
    processListingAttempts,
    1,
    "the slow 60 s process listing double was attempted once for the pass",
  );
  assert.equal(
    mergeAttempts,
    0,
    "production merge path did not merge past an unknown process proof",
  );
  assert.equal(after.phase, "merging");
  assert.equal(
    after.resolution.stop,
    null,
    "unknown/timed-out process read in executionLease must defer without recording an operator_needed stop",
  );
  assert.match(
    after.reason,
    /Merge waits for participant agent-timing-merge:.*unreadable|unknown|timed out/i,
    `production quantum must record the unknown owned-tool merge wait itself, got: ${after.reason}`,
  );
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "owned_tool_settled").length,
    0,
    "a timed-out process read must never settle the owned-tool hold",
  );
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

test("an unbound launch reservation without an agentId does not abort the host pass or fleet sweep", async (t) => {
  const warmedAgents: string[] = [];
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: `ws-${id.replace(/^agent-/, "")}`,
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt,
          },
        ]),
      ),
    originAgent: async (id: string) => ({
      id,
      workspaceId: `ws-${id.replace(/^agent-/, "")}`,
      archived: false,
      deleted: false,
    }),
    agentTimelinePage: async (id: string) => {
      warmedAgents.push(id);
      return toolTimelinePage([]);
    },
    hostProcessListing: async () => [],
  });

  // Task 1 has an unbound reviewer launch reservation (agentId: null, released: false).
  const unbound = seedFinishedWorkerTask(f.store, "unbound-intent");
  f.store.update(unbound.task.id, { phase: "reviewing" });
  f.store.putRun(
    runSchema.parse({
      id: "run-unbound-reviewer",
      taskId: unbound.task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: null,
      workspaceId: "ws-unbound-intent",
      hostId: HOST,
      profile: null,
      status: "intent",
      createdAt: updatedAt,
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );

  // Task 2 is a normal task on the same host that should still be warmed.
  const healthy = seedFinishedWorkerTask(f.store, "healthy-sibling");

  const pass = await f.engine.auditPass(true);
  assert.equal(
    pass.fault,
    null,
    "unbound reservation must not fault the sweep",
  );
  assert.equal(pass.covered, true, "sweep still covers all tasks");
  assert.equal(f.store.getMeta("hostPassError"), "");
  assert.ok(
    warmedAgents.includes(healthy.agentId),
    "healthy sibling task is still warmed in the same host pass",
  );
});

test("bounded tool projection defers when a newer turn advances updatedAt after the host pass snapshot", async (t) => {
  const t1 = new Date(Date.now() - 60_000).toISOString();
  let currentUpdatedAt = t1;
  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-bounded-fresh",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: t1,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-bounded-fresh",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: currentUpdatedAt,
    }),
    agentTimelinePage: async () => ({
      entries: [],
      hasOlder: true,
      gap: false,
      staleCursor: false,
      reset: false,
      hasNewer: false,
      epoch: "agent-bounded-fresh",
      startCursor: null,
      endCursor: null,
      projection: "bounded" as const,
      pendingBackgroundTasks: [],
    }),
    hostProcessListing: async () => [],
    noLiveWorkspaceProcesses: async () => null,
  });

  const seeded = seedFinishedWorkerTask(f.store, "bounded-fresh");
  f.store.update(seeded.task.id, {
    directory: "/tmp/synthetic-bounded-fresh",
  });
  const seededRun = f.store.run(seeded.runId)!;
  f.store.putRun({
    ...seededRun,
    temporaryDirectory: "/tmp/synthetic-bounded-fresh-scratch",
  });

  const snapshot = f.engine.resolution.beginPassSnapshot();
  try {
    await (
      f.engine as unknown as {
        sweep: { hostPass: { run(host: string): Promise<unknown> } };
      }
    ).sweep.hostPass.run(HOST);
    // Simulate a new turn completing after the host pass captured the bounded
    // window and process table.
    currentUpdatedAt = new Date(Date.now() + 5_000).toISOString();
    const hold = await f.engine.resolution.ownedToolHold(seeded.agentId, {
      requireCompleteEvidence: true,
      runId: seeded.runId,
      runIds: [seeded.runId],
      taskId: seeded.task.id,
      workspaceId: "ws-bounded-fresh",
    });
    assert.equal(
      hold.kind,
      "deferred",
      "bounded tool proof must defer when fresh observation has a newer updatedAt than the pass snapshot",
    );
    assert.match(hold.reason, /predates|active after the pass process snapshot/i);
  } finally {
    snapshot.expire();
  }
});

test("unstamped tool evidence never clears a hold or reads a timeline on the task lane", async (t) => {
  const t1 = new Date(Date.now() - 60_000).toISOString();
  let timelineCalls = 0;
  let boundedMode = true;
  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-unstamped-tool",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: t1,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-unstamped-tool",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      // Intentionally omit updatedAt to simulate an unstamped observation.
    }),
    agentTimelinePage: async () => {
      timelineCalls++;
      return boundedMode
        ? {
            entries: [],
            hasOlder: true,
            gap: false,
            staleCursor: false,
            reset: false,
            hasNewer: false,
            epoch: "agent-unstamped-tool",
            startCursor: null,
            endCursor: null,
            projection: "bounded" as const,
            pendingBackgroundTasks: [],
          }
        : toolTimelinePage([]);
    },
    hostProcessListing: async () => [],
    noLiveWorkspaceProcesses: async () => null,
  });

  const seeded = seedFinishedWorkerTask(f.store, "unstamped-tool");
  f.store.update(seeded.task.id, {
    directory: "/tmp/synthetic-unstamped-tool",
  });
  const seededRun = f.store.run(seeded.runId)!;
  f.store.putRun({
    ...seededRun,
    temporaryDirectory: "/tmp/synthetic-unstamped-tool-scratch",
  });

  // 1. An unstamped observation cannot establish process snapshot freshness.
  const snap1 = f.engine.resolution.beginPassSnapshot();
  try {
    await (
      f.engine as unknown as {
        sweep: { hostPass: { run(host: string): Promise<unknown> } };
      }
    ).sweep.hostPass.run(HOST);
    const callsAfterWarm = timelineCalls;
    const hold = await f.engine.resolution.ownedToolHold(seeded.agentId, {
      requireCompleteEvidence: true,
      runId: seeded.runId,
      runIds: [seeded.runId],
      taskId: seeded.task.id,
      workspaceId: "ws-unstamped-tool",
    });
    assert.equal(hold.kind, "deferred", "unstamped process proof must defer");
    assert.match(hold.reason, /positive activity stamp|active after the pass process/i);
    assert.equal(
      timelineCalls,
      callsAfterWarm,
      "sealed host pass must not issue task-lane timeline RPCs",
    );
  } finally {
    snap1.expire();
  }

  // 2. Complete empty page with unstamped fresh observation also defers without
  // issuing any direct timeline RPC inside the task lane.
  boundedMode = false;
  const snap2 = f.engine.resolution.beginPassSnapshot();
  try {
    await (
      f.engine as unknown as {
        sweep: { hostPass: { run(host: string): Promise<unknown> } };
      }
    ).sweep.hostPass.run(HOST);
    const callsAfterWarm = timelineCalls;
    const hold = await f.engine.resolution.ownedToolHold(seeded.agentId, {
      requireCompleteEvidence: true,
      runId: seeded.runId,
      runIds: [seeded.runId],
      taskId: seeded.task.id,
      workspaceId: "ws-unstamped-tool",
    });
    assert.equal(hold.kind, "deferred", "unstamped complete tool page must defer");
    assert.match(hold.reason, /positive activity stamp|predates/i);
    assert.equal(
      timelineCalls,
      callsAfterWarm,
      "unstamped complete-page fallback must never issue task-lane timeline RPCs",
    );
  } finally {
    snap2.expire();
  }
});

test("two missing closure stamps never authorize durable run_delivery_not_delivered from a pass snapshot", async (t) => {
  const f = engineFixture(t, {
    originAgent: async (id: string) => ({
      id,
      workspaceId: "ws-unstamped-close",
      archived: false,
      deleted: false,
    }),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-unstamped-close",
      status: "closed",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      // Intentionally omit updatedAt (missing closure stamp).
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
  });

  const seeded = seedFinishedWorkerTask(f.store, "unstamped-close");
  f.store.putRun(
    runSchema.parse({
      id: "run-unstamped-close",
      taskId: seeded.task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-unstamped-close",
      workspaceId: "ws-unstamped-close",
      hostId: HOST,
      profile: null,
      status: "uncertain",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: true,
    }),
  );

  const snapshot = f.engine.resolution.beginPassSnapshot();
  try {
    await f.engine.resolution.primePassTimelinePage(
      "agent-unstamped-close",
      100,
      HOST,
      {
        provenTerminal: {
          archived: false,
          workspaceId: "ws-unstamped-close",
          closedUpdatedAt: null,
        },
      },
    );
    await assert.rejects(
      () =>
        f.engine.resolution.reconcileUncertainRunDelivery(
          seeded.task.id,
          "run-unstamped-close",
        ),
      /predates agent closure/i,
      "missing closure stamps must not compare equal to authorize durable negative delivery",
    );
    assert.equal(
      f.store
        .events(seeded.task.id)
        .filter((e) => e.kind === "run_delivery_not_delivered").length,
      0,
    );
  } finally {
    snapshot.expire();
  }
});

test("worker reconcileObservation bounds hung observe, superseded runs share and rotate one budget, and released-delivery + workspaceAvailable are bounded", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  const observedOrder: string[] = [];
  let originCalls = 0;
  let workspaceAvailCalls = 0;
  const f = engineFixture(t, {
    observe: (id: string) => {
      observedOrder.push(id);
      if (id === "agent-sup-healthy") {
        return Promise.resolve({
          id,
          workspaceId: "ws-rotate-sup",
          status: "closed",
          active: false,
          activeTurnId: null,
          permissions: false,
          error: "",
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        });
      }
      return new Promise<AgentObservation>((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              id: "late",
              workspaceId: "ws-late",
              status: "idle",
              active: false,
              activeTurnId: null,
              permissions: false,
              error: "",
            }),
          60_000,
        );
        timer.unref?.();
        timers.push(timer);
      });
    },
    originAgent: () => {
      originCalls++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 60_000);
        timer.unref?.();
        timers.push(timer);
      });
    },
    agentTimelinePage: async () => toolTimelinePage([]),
    workspaceAvailable: () => {
      workspaceAvailCalls++;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), 60_000);
        timer.unref?.();
        timers.push(timer);
      });
    },
  });
  f.engine.resolution.quantumReadTimeoutMs = 60;

  // 1. Working task with hung host.observe defers cleanly without throwing.
  const working = f.store.insert(
    submission({
      submissionId: "sub-hung-worker",
      title: "Hung worker observe",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  f.store.update(working.id, {
    phase: "working",
    workspaceId: "ws-hung-worker",
    directory: "/tmp/synthetic-hung-worker",
    agentId: "agent-hung-worker",
    runId: "run-hung-worker",
  });
  await f.engine.reconcile(f.store.task(working.id));
  assert.equal(
    f.store.task(working.id).phase,
    "working",
    "timed-out worker observation defers cleanly without changing phase",
  );

  // 2. Seven eligible superseded runs share ONE quantum budget instead of observing all 7.
  const multi = seedFinishedWorkerTask(f.store, "multi-superseded");
  for (let i = 0; i < 7; i++) {
    f.store.putRun(
      runSchema.parse({
        id: `run-sup-${i}`,
        taskId: multi.task.id,
        role: "reviewer",
        generation: i + 1,
        head: HEAD,
        base: HEAD,
        agentId: `agent-sup-${i}`,
        workspaceId: "ws-multi-superseded",
        hostId: HOST,
        profile: null,
        status: "running",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        lastObservedAt: null,
        active: false,
        idleSince: null,
        completion: null,
        released: false,
      }),
    );
  }
  const callsBefore = observedOrder.length;
  const settled = await f.engine.settleSupersededIdleRuns(
    multi.task.id,
    "shared budget test",
  );
  assert.equal(settled, 0);
  assert.ok(
    observedOrder.length - callsBefore < 7,
    `budget expiry should stop before observing all 7 runs, observed ${observedOrder.length - callsBefore}`,
  );

  // 3. Rotation prevents a persistently slow first superseded run from starving a healthy second run.
  const rot = seedFinishedWorkerTask(f.store, "rotate-sup");
  f.store.putRun(
    runSchema.parse({
      id: "run-sup-slow",
      taskId: rot.task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-sup-slow",
      workspaceId: "ws-rotate-sup",
      hostId: HOST,
      profile: null,
      status: "running",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );
  f.store.putRun(
    runSchema.parse({
      id: "run-sup-healthy",
      taskId: rot.task.id,
      role: "reviewer",
      generation: 2,
      head: HEAD,
      base: HEAD,
      agentId: "agent-sup-healthy",
      workspaceId: "ws-rotate-sup",
      hostId: HOST,
      profile: null,
      status: "running",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );
  await f.engine.settleSupersededIdleRuns(rot.task.id, "pass 1");
  const pass2Settled = await f.engine.settleSupersededIdleRuns(
    rot.task.id,
    "pass 2",
  );
  assert.equal(
    pass2Settled,
    1,
    "second pass rotates past the slow first run and settles the healthy second run",
  );
  assert.equal(f.store.run("run-sup-healthy")?.status, "superseded");

  // 4. Multiple released uncertain deliveries share ONE quantum budget, and
  // hung workspaceAvailable on ready_for_review attention returns inside bound.
  const attn = f.store.insert(
    submission({
      submissionId: "sub-hung-delivery-ws",
      title: "Hung delivery and workspaceAvailable",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  f.store.update(attn.id, {
    phase: "needs_attention",
    workspaceId: "ws-hung-delivery",
    directory: "/tmp/synthetic-hung-delivery",
    agentId: "agent-hung-delivery",
    runId: "run-hung-delivery",
    completion: {
      eventId: "ev-ready-attn",
      taskId: attn.id,
      runId: "run-hung-delivery",
      status: "ready_for_review",
      summary: "ready",
      prNumber: 1,
      head: HEAD,
    },
  });
  for (let i = 0; i < 6; i++) {
    f.store.putRun(
      runSchema.parse({
        id: `run-rel-uncertain-${i}`,
        taskId: attn.id,
        role: "reviewer",
        generation: i + 1,
        head: HEAD,
        base: HEAD,
        agentId: `agent-rel-uncertain-${i}`,
        workspaceId: "ws-hung-delivery",
        hostId: HOST,
        profile: null,
        status: "uncertain",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        lastObservedAt: null,
        active: false,
        idleSince: null,
        completion: null,
        released: true,
      }),
    );
  }
  const originsBefore = originCalls;
  await f.engine.taskQuantum(attn.id);
  assert.equal(
    workspaceAvailCalls,
    1,
    "workspaceAvailable was attempted once and bounded",
  );
  assert.ok(
    originCalls - originsBefore < 6,
    `released delivery loop must share one budget and stop before all 6 hung origins, called ${originCalls - originsBefore}`,
  );
});

test("stable idle tool backlog does not starve shell peeks, and unknown shell peek defers stalled_turn attention", async (t) => {
  const staleAt = new Date(Date.now() - 45 * 60_000).toISOString();
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const shellWarmed: string[] = [];

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          id === "agent-running-shell"
            ? {
                id,
                workspaceId: "ws-running-shell",
                status: "running",
                active: true,
                activeTurnId: "turn-shell-1",
                permissions: false,
                error: "",
                turnStartedAt: staleAt,
                updatedAt: staleAt,
              }
            : {
                id,
                workspaceId: `ws-${id.replace(/^agent-/, "")}`,
                status: "idle",
                active: false,
                activeTurnId: null,
                permissions: false,
                error: "",
                updatedAt: idleAt,
              },
        ]),
      ),
    agentTimelinePage: async () => toolTimelinePage([]),
    agentTimeline: async (id: string) => {
      shellWarmed.push(id);
      return [runningShellEntry("call-long-shell", staleAt)];
    },
    hostProcessListing: async () => [],
  });

  // Seed 10 idle tool candidates (more than HOST_PASS_WARM_CANDIDATE_CAP = 8).
  for (let i = 0; i < 10; i++) {
    seedFinishedWorkerTask(f.store, `idle-backlog-${i}`);
  }
  // Seed 1 running task whose shell peek is needed to prevent false stall attention.
  const runningTask = f.store.insert(
    submission({
      submissionId: "sub-running-shell",
      title: "Running shell task",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  f.store.update(runningTask.id, {
    phase: "working",
    workspaceId: "ws-running-shell",
    directory: "/tmp/synthetic-running-shell",
    agentId: "agent-running-shell",
    runId: "run-running-shell",
  });

  // 1. Round-robin warming must include the shell candidate despite 10 idle tool candidates.
  const snap1 = f.engine.resolution.beginPassSnapshot();
  try {
    await (
      f.engine as unknown as {
        sweep: { hostPass: { run(host: string): Promise<unknown> } };
      }
    ).sweep.hostPass.run(HOST);
    assert.ok(
      shellWarmed.includes("agent-running-shell"),
      "interleaved warming must warm the shell peek despite 10 idle tool candidates",
    );
  } finally {
    snap1.expire();
  }

  // 2. When a sealed pass snapshot returns unknown for a shell peek, Stalls.check
  // must NOT raise stalled_turn attention.
  const snap2 = f.engine.resolution.beginPassSnapshot();
  try {
    f.engine.resolution.sealPassHost(HOST);
    const notice = await f.engine.resolution.stalls.check(
      f.store.task(runningTask.id),
      null,
      {
        id: "agent-running-shell",
        workspaceId: "ws-running-shell",
        status: "running",
        active: true,
        activeTurnId: "turn-shell-1",
        permissions: false,
        error: "",
        turnStartedAt: staleAt,
        updatedAt: staleAt,
      },
    );
    assert.equal(notice, null);
    assert.equal(
      f.store.task(runningTask.id).resolution.incident,
      null,
      "unknown shell peek must defer stalled_turn attention instead of treating unknown as no live tool",
    );
  } finally {
    snap2.expire();
  }
});

test("hung-tool path shares the host-pass process snapshot and defers on a slow listing", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  const quietAt = new Date(Date.now() - 40 * 60_000).toISOString();
  let processCalls = 0;
  let slowListing = true;
  const f = engineFixture(t, {
    observationInventory: async () =>
      new Map<string, AgentObservation>([
        [
          "agent-hung-tool",
          {
            id: "agent-hung-tool",
            workspaceId: "ws-hung-tool",
            status: "running",
            active: true,
            activeTurnId: "turn-hung-1",
            permissions: false,
            error: "",
            turnStartedAt: quietAt,
            updatedAt: quietAt,
          },
        ],
      ]),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-hung-tool",
      status: "running",
      active: true,
      activeTurnId: "turn-hung-1",
      permissions: false,
      error: "",
      turnStartedAt: quietAt,
      updatedAt: quietAt,
    }),
    agentTimeline: async () => [
      {
        timestamp: quietAt,
        turnId: "turn-hung-1",
        item: {
          type: "tool_call",
          callId: "call-quiet-1",
          status: "running",
          name: "Bash",
          detail: {
            type: "shell",
            command: "sleep 999",
            startedAt: quietAt,
            lastOutputAt: quietAt,
          },
        },
      },
    ],
    hostProcessListing: () => {
      processCalls++;
      if (!slowListing) return Promise.resolve([]);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), 60_000);
        timer.unref?.();
        timers.push(timer);
      });
    },
  });
  f.engine.resolution.passProcessReadTimeoutMs = 40;
  f.engine.resolution.quantumReadTimeoutMs = 40;

  const task = f.store.insert(
    submission({
      submissionId: "sub-hung-tool-slow",
      title: "Hung tool slow process listing",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  f.store.update(task.id, {
    phase: "working",
    workspaceId: "ws-hung-tool",
    directory: "/tmp/synthetic-hung-tool",
    agentId: "agent-hung-tool",
    runId: "run-hung-tool",
  });

  // 1. With a slow hostProcessListing, the host pass bounds the read once and
  // HungTools.settle reuses the unknown snapshot without starting a second direct
  // listing, recording hung_tool_unterminated, or raising stalled_turn attention.
  await f.engine.auditPass(true);
  assert.equal(
    processCalls,
    1,
    "HostPass reads hostProcessListing once; HungTools.settle must not start its own direct listing",
  );
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((e) => e.kind === "hung_tool_unterminated").length,
    0,
    "timed-out process snapshot must defer hung-tool settlement rather than recording hung_tool_unterminated",
  );
  assert.equal(
    f.store.task(task.id).resolution.attention,
    false,
    "deferred hung-tool check must not unblock stalled_turn attention",
  );

  // 2. When hostProcessListing answers cleanly in a later pass, HungTools.settle
  // still shares the single host-pass snapshot (1 listing call for the pass).
  slowListing = false;
  f.engine.resolution.stalls.peekTtlMs = 0;
  const callsBeforeFastPass = processCalls;
  await f.engine.auditPass(true);
  assert.equal(
    processCalls - callsBeforeFastPass,
    1,
    "normal hung-tool pass must reuse the host-pass process snapshot rather than re-listing",
  );
});

test("wake-triggered task quantum primes expensive reads outside the task lane and defers on missing or slow evidence", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  const idleAt = new Date(Date.now() - 60_000).toISOString();
  let observeCalls = 0;
  let processCalls = 0;
  let timelineCalls = 0;
  let timelinePageCalls = 0;
  let timelinePageCallsInQuantum = 0;
  let processCallsInQuantum = 0;
  let inQuantum = false;
  let mergeCalls = 0;
  let slowTimelinePage = false;

  const f = engineFixture(t, {
    observe: async (id: string) => {
      observeCalls++;
      return {
        id,
        workspaceId: "ws-wake-defer",
        status: "idle",
        active: false,
        activeTurnId: null,
        permissions: false,
        error: "",
        updatedAt: idleAt,
      };
    },
    hostProcessListing: async () => {
      processCalls++;
      if (inQuantum) processCallsInQuantum++;
      return [];
    },
    agentTimeline: async () => {
      timelineCalls++;
      return [];
    },
    agentTimelinePage: async () => {
      timelinePageCalls++;
      if (inQuantum) timelinePageCallsInQuantum++;
      if (slowTimelinePage) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(toolTimelinePage([])), 60_000);
          timer.unref?.();
          timers.push(timer);
        });
      }
      return toolTimelinePage([]);
    },
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during wake defer test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  const origTaskQuantum = f.engine.taskQuantum.bind(f.engine);
  f.engine.taskQuantum = async (id: string) => {
    inQuantum = true;
    try {
      return await origTaskQuantum(id);
    } finally {
      inQuantum = false;
    }
  };
  f.store.setMeta("paused", false);
  f.engine.hostHealth.answered(HOST);
  f.engine.resolution.quantumReadTimeoutMs = 40;
  f.engine.resolution.hostPassWarmBudgetMs = 60;

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-wake-defer",
      title: "Wake defer task",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-wake-defer",
    directory: "/tmp/synthetic-wake-defer",
    agentId: "agent-wake-defer",
    runId: "run-wake-defer",
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/91",
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: true,
      mergeHead: HEAD,
      mergeRequestedAt: idleAt,
      review: {
        eventId: "ev-wake-defer",
        taskId: inserted.id,
        runId: "rev-wake-defer",
        reviewId: 91,
        status: "ready_to_merge",
        head: HEAD,
        summary: "ok",
      },
    },
  });

  // 1. Direct scheduleTaskQuantum without a host pass performs zero direct
  // process/timeline reads and defers the merge cleanly.
  await f.engine.scheduleTaskQuantum(task.id);
  assert.ok(observeCalls >= 1, "scheduleTaskQuantum must enter executionLease");
  assert.equal(processCalls, 0);
  assert.equal(timelineCalls, 0);
  assert.equal(timelinePageCalls, 0);
  assert.equal(mergeCalls, 0);
  assert.match(
    f.store.task(task.id).reason,
    /was not captured in a host pass|inconclusive/i,
  );

  // 2. Callback wake (`wakeTask`) with a slow 60 s timeline page runs its
  // bounded prefetch OUTSIDE the exclusive task lane, seals the host, and
  // executes zero timeline/process reads inside taskQuantum.
  slowTimelinePage = true;
  await f.engine.wakeTask(task.id);
  assert.equal(
    timelinePageCallsInQuantum,
    0,
    "wakeTask must never start agentTimelinePage inside the exclusive task lane",
  );
  assert.equal(
    processCallsInQuantum,
    0,
    "wakeTask must never start hostProcessListing inside the exclusive task lane",
  );
  assert.equal(
    mergeCalls,
    0,
    "merge must defer when wake host-side prefetch times out",
  );
});

test("task quantum shares one read-phase budget across serial participant observations and nested ownedToolHold", async (t) => {
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  let observeCalls = 0;
  let mergeCalls = 0;

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-serial-budget",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: idleAt,
          },
        ]),
      ),
    observe: async (id: string) => {
      observeCalls++;
      // Each individual observation succeeds inside quantumReadTimeoutMs (150 ms),
      // so per-read timeouts alone cannot cap a task with many participants.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        id,
        workspaceId: "ws-serial-budget",
        status: "idle",
        active: false,
        activeTurnId: null,
        permissions: false,
        error: "",
        updatedAt: idleAt,
      };
    },
    agentTimelinePage: async () => toolTimelinePage([]),
    hostProcessListing: async () => [],
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during wake defer test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  // Per-read timeout (150 ms) allows each 60 ms observe to succeed, while the
  // quantum-wide read budget (200 ms) caps the cumulative read phase well before
  // all 6 participants * 2 reads (12 * 60 ms = 720 ms) can run.
  f.engine.resolution.quantumReadTimeoutMs = 150;
  f.engine.resolution.quantumReadBudgetMs = 200;

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-serial-budget",
      title: "Serial budget task",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  f.store.setMeta("paused", false);
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-serial-budget",
    directory: "/tmp/synthetic-serial-budget",
    agentId: "agent-serial-main",
    runId: "run-serial-main",
    retiredWorkers: Array.from({ length: 5 }, (_, i) => ({
      agentId: `agent-serial-${i}`,
      runId: `run-serial-${i}`,
      profile: {
        id: "claude:sonnet",
        name: "Claude Sonnet",
        provider: "claude",
        model: "sonnet",
        notes: "",
        available: true,
        problem: "",
        supportedThinking: [],
      },
      reason: "rotated",
      hostId: HOST,
    })),
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/92",
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: true,
      mergeHead: HEAD,
      mergeRequestedAt: idleAt,
      review: {
        eventId: "ev-serial-budget",
        taskId: inserted.id,
        runId: "rev-serial-budget",
        reviewId: 92,
        status: "ready_to_merge",
        head: HEAD,
        summary: "ok",
      },
    },
  });

  // Prime all 6 participants' complete tool pages inside a host pass, then run
  // the task quantum so executionLease + nested ownedToolHold share one budget.
  const snap = f.engine.resolution.beginPassSnapshot();
  try {
    for (const id of [
      "agent-serial-main",
      "agent-serial-0",
      "agent-serial-1",
      "agent-serial-2",
      "agent-serial-3",
      "agent-serial-4",
    ]) {
      await f.engine.resolution.primePassTimelinePage(id, 200, HOST, {
        coveredObservation: {
          updatedAt: idleAt,
          status: "idle",
          archived: false,
        },
      });
    }
    f.engine.resolution.sealPassHost(HOST);
    await f.engine.taskQuantum(task.id);
  } finally {
    snap.expire();
  }

  assert.equal(
    mergeCalls,
    0,
    "exhausting the quantum read budget must hold the merge conservatively",
  );
  assert.match(
    f.store.task(task.id).reason,
    /Merge waits for participant/i,
    "executionLease must record the participant wait when the quantum read budget expires",
  );
  assert.ok(
    observeCalls > 0 && observeCalls < 12,
    `quantum-wide read budget must stop serial observations well before all 12 participant/tool reads, ran ${observeCalls}`,
  );
});

test("task-scope lookups stay strictly cache-only when unsealed or post-reap, and settleStrayTool defers verification to the next host pass", async (t) => {
  let processListCalls = 0;
  let timelineCalls = 0;
  let timelinePageCalls = 0;
  let mergeCalls = 0;
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const strayDir = mkdtempSync(join(tmpdir(), "ns-reap-defer-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd: strayDir,
    stdio: "ignore",
    detached: true,
  });
  t.after(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
    rmSync(strayDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-unsealed-reap",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: idleAt,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-unsealed-reap",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: idleAt,
    }),
    agentTimeline: async () => {
      timelineCalls++;
      return [];
    },
    agentTimelinePage: async () => {
      timelinePageCalls++;
      return toolTimelinePage([runningShellEntry("call-reap-stray", idleAt)]);
    },
    hostProcessListing: async (): Promise<HostProcessFact[]> => {
      processListCalls++;
      const listing = await readProcessSubset([child.pid!]);
      if (listing.state === "listed" && listing.processes.length > 0)
        return listing.processes;
      return [];
    },
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during reap defer test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  f.store.setMeta("paused", false);

  // Part A: Inside a task quantum, an unsealed PassSnapshot (e.g., while a
  // concurrent sweep is still warming) and an invalidated process entry must
  // never execute host RPCs on the task lane.
  const snap = f.engine.resolution.beginPassSnapshot();
  try {
    await runInTaskQuantumScope(
      5_000,
      async () => {
        const proc = await f.engine.resolution.readPassProcesses(HOST);
        assert.equal(proc.state, "unknown");
        const tl = await f.engine.resolution.readPassTimeline(
          "agent-unsealed",
          HOST,
          200,
        );
        assert.equal(tl.state, "unknown");
        const page = await f.engine.resolution.readPassTimelinePage(
          "agent-unsealed",
          200,
          HOST,
        );
        assert.equal(page.state, "unknown");
      },
      snap,
    );
    assert.equal(
      processListCalls,
      0,
      "unsealed pass snapshot must not start hostProcessListing on the task lane",
    );
    assert.equal(
      timelineCalls,
      0,
      "unsealed pass snapshot must not start agentTimeline on the task lane",
    );
    assert.equal(
      timelinePageCalls,
      0,
      "unsealed pass snapshot must not start agentTimelinePage on the task lane",
    );

    // Prime processes, seal, invalidate, and confirm task-scope lookup stays cache-only.
    await f.engine.resolution.primePassProcesses(HOST);
    f.engine.resolution.sealPassHost(HOST);
    assert.equal(processListCalls, 1);
    snap.invalidateProcesses(HOST);
    await runInTaskQuantumScope(
      5_000,
      async () => {
        const procAfter = await f.engine.resolution.readPassProcesses(HOST);
        assert.equal(procAfter.state, "unknown");
      },
      snap,
    );
    assert.equal(
      processListCalls,
      1,
      "invalidated process snapshot must not re-scan hostProcessListing on the task lane",
    );
  } finally {
    snap.expire();
  }

  // Part B: End-to-end settleStrayTool inside a task quantum reaps the stray
  // process and defers post-reap verification to the next host pass without
  // re-scanning hostProcessListing on the task lane.
  processListCalls = 0;
  timelinePageCalls = 0;
  (f.engine.resolution as { graceMs: number }).graceMs = 0;
  const inserted = f.store.insert(
    submission({
      submissionId: "sub-unsealed-reap",
      title: "Post-reap defer task",
      skipPRReview: true,
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-unsealed-reap",
    directory: strayDir,
    agentId: "agent-unsealed-reap",
    runId: "run-unsealed-reap",
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/93",
    completion: {
      eventId: "ev-comp-unsealed-reap",
      taskId: inserted.id,
      runId: "run-unsealed-reap",
      status: "ready_for_review",
      head: HEAD,
      prNumber: 93,
      summary: "done",
    },
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: false,
      review: {
        eventId: "ev-unsealed-reap",
        taskId: inserted.id,
        runId: "rev-unsealed-reap",
        reviewId: 93,
        status: "ready_to_merge",
        head: HEAD,
        summary: "ok",
      },
    },
  });

  // Reaping needs a current process match and a participant proved inactive
  // before this pass captures it.
  f.engine.resolution.requestPassProof(HOST, task.agentId!);
  await f.engine.auditPass(true);
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "participant_tool_reaped").length,
    1,
    `participant_tool_reaped event is recorded (reason: ${f.store.task(task.id).reason}, events: ${JSON.stringify(f.store.events(task.id).map((e) => [e.kind, e.detail]))})`,
  );
  assert.equal(
    processListCalls,
    1,
    "post-reap settleStrayTool must not re-scan hostProcessListing on the task lane",
  );
  assert.equal(
    mergeCalls,
    0,
    "post-reap quantum waits for the next host pass to verify the process tree is clear",
  );
  assert.match(
    f.store.task(task.id).reason,
    /reaped stray participant process; waiting for the next host pass/i,
  );
});

test("retained-run observation and creation lookup respect the quantum read deadline and preserve pending state", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  let observeCalls = 0;
  let findRunAgentsCalls = 0;
  const f = engineFixture(t, {
    observe: () => {
      observeCalls++;
      return new Promise<AgentObservation>((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              id: "agent-hung-obs",
              workspaceId: "ws-hung-obs",
              status: "running",
              active: true,
              activeTurnId: "turn-1",
              permissions: false,
              error: "",
            }),
          60_000,
        );
        timer.unref?.();
        timers.push(timer);
      });
    },
    findRunAgents: () => {
      findRunAgentsCalls++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), 60_000);
        timer.unref?.();
        timers.push(timer);
      });
    },
  });
  f.store.setMeta("paused", false);
  f.engine.hostHealth.answered(HOST);
  f.engine.resolution.quantumReadTimeoutMs = 40;
  f.engine.resolution.quantumReadBudgetMs = 80;

  // Part A: Observation.observe fallback (e.g. callback prelude without pass inventory)
  // bounds a hung host.observe inside the shared quantum deadline.
  const obsInserted = f.store.insert(
    submission({
      submissionId: "sub-hung-obs",
      title: "Hung retained-run observation",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const obsTask = f.store.update(obsInserted.id, {
    phase: "reviewing",
    workspaceId: "ws-hung-obs",
    directory: "/tmp/synthetic-hung-obs",
    agentId: "agent-worker-obs",
    runId: "run-worker-obs",
  });
  f.store.putRun(
    runSchema.parse({
      id: "run-reviewer-hung-obs",
      taskId: obsTask.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-hung-obs",
      workspaceId: "ws-hung-obs",
      hostId: HOST,
      profile: null,
      status: "running",
      createdAt: new Date(Date.now() - 25_000).toISOString(),
      lastObservedAt: new Date(Date.now() - 25_000).toISOString(),
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );

  await runInTaskQuantumScope(80, async () => {
    await f.engine.resolution.observation.observe(null, obsTask.id);
  });
  assert.equal(observeCalls, 1, "fallback host.observe was attempted once");
  assert.equal(
    f.store.run("run-reviewer-hung-obs")?.released,
    false,
    "timed-out retained-run observation must preserve the pending run",
  );

  // Part B: Uncertain creation lookup bounds a hung findRunAgents inside the
  // quantum deadline and preserves the creation intent.
  const lookupInserted = f.store.insert(
    submission({
      submissionId: "sub-hung-lookup",
      title: "Hung creation lookup",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const lookupTask = f.store.update(lookupInserted.id, {
    phase: "reviewing",
    workspaceId: "ws-hung-lookup",
    directory: "/tmp/synthetic-hung-lookup",
    agentId: "agent-worker-lookup",
    runId: "run-worker-lookup",
  });
  f.store.putRun(
    runSchema.parse({
      id: "run-intent-hung-lookup",
      taskId: lookupTask.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: null,
      workspaceId: "ws-hung-lookup",
      hostId: HOST,
      profile: null,
      status: "intent",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );

  await runInTaskQuantumScope(80, async () => {
    await f.engine.resolution.observation.observe(null);
  });
  assert.equal(findRunAgentsCalls, 1, "findRunAgents was attempted once");
  const intentRunAfter = f.store.run("run-intent-hung-lookup");
  assert.equal(
    intentRunAfter?.status,
    "intent",
    "timed-out creation lookup must preserve the pending creation intent",
  );
  assert.equal(intentRunAfter?.released, false);
  assert.match(
    f.store.task(lookupTask.id).reason,
    /timed out|unreadable|creation lookup|deadline exceeded/i,
  );
});

test("healthy task with 10 idle participants completes in one pass via both host pass and wake prefetch without 8-page starvation", async (t) => {
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const warmedAgents = new Set<string>();
  let mergeCalls = 0;

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-ten-participants",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: idleAt,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-ten-participants",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: idleAt,
    }),
    agentTimelinePage: async (id: string) => {
      warmedAgents.add(id);
      return toolTimelinePage([]);
    },
    hostProcessListing: async () => [],
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during reap defer test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  f.store.setMeta("paused", false);

  const seedTenParticipantMergingTask = (
    slug: string,
    prNumber: number,
    repoPath = `/repo-${slug}`,
  ) => {
    const inserted = f.store.insert(
      submission({
        submissionId: `sub-${slug}`,
        title: `Ten-participant task ${slug}`,
        repoPath,
        skipPRReview: true,
      }),
      HOST,
      "handoff",
      HEAD,
    );
    return f.store.update(inserted.id, {
      phase: "merging",
      workspaceId: "ws-ten-participants",
      directory: `/tmp/synthetic-${slug}`,
      agentId: `agent-${slug}-main`,
      runId: `run-${slug}-main`,
      retiredWorkers: Array.from({ length: 9 }, (_, i) => ({
        agentId: `agent-${slug}-retired-${i}`,
        runId: `run-${slug}-retired-${i}`,
        profile: {
          id: "claude:sonnet",
          name: "Claude Sonnet",
          provider: "claude",
          model: "sonnet",
          notes: "",
          available: true,
          problem: "",
          supportedThinking: [],
        },
        reason: "rotated",
        hostId: HOST,
      })),
      prHead: HEAD,
      prUrl: `https://github.com/example/repo/pull/${prNumber}`,
      completion: {
        eventId: `ev-comp-${slug}`,
        taskId: inserted.id,
        runId: `run-${slug}-main`,
        status: "ready_for_review",
        head: HEAD,
        prNumber,
        summary: "done",
      },
      reason: "Ready to merge",
      resolution: {
        ...inserted.resolution,
        integrationTurn: { sequence: 1, acceptedAt: idleAt },
        mergeIntent: false,
        review: {
          eventId: `ev-${slug}`,
          taskId: inserted.id,
          runId: `rev-${slug}`,
          reviewId: prNumber,
          status: "ready_to_merge",
          head: HEAD,
          summary: "ok",
        },
      },
    });
  };

  // Part A: Host pass warms all 10 participants of the primary task in one pass.
  const hostPassTask = seedTenParticipantMergingTask("host-pass-10", 94);
  await f.engine.auditPass(true);
  assert.equal(
    mergeCalls,
    1,
    `host pass must warm all 10 participants of one task so it merges in a single pass (phase: ${f.store.task(hostPassTask.id).phase}, reason: ${f.store.task(hostPassTask.id).reason}, warmed: ${warmedAgents.size}, events: ${JSON.stringify(f.store.events(hostPassTask.id).map((e) => [e.kind, e.detail]))})`,
  );
  assert.equal(
    warmedAgents.size,
    10,
    "all 10 participants were warmed in the host pass",
  );

  // Part B: Wake prefetch warms all 10 participants without slicing at 8.
  warmedAgents.clear();
  mergeCalls = 0;
  const wakeTaskObj = seedTenParticipantMergingTask("wake-10", 95);
  await f.engine.wakeTask(wakeTaskObj.id);
  assert.equal(
    mergeCalls,
    1,
    `wake prefetch must warm all 10 participants without truncating at 8 (phase: ${f.store.task(wakeTaskObj.id).phase}, reason: ${f.store.task(wakeTaskObj.id).reason}, warmed: ${warmedAgents.size}, events: ${JSON.stringify(f.store.events(wakeTaskObj.id).map((e) => [e.kind, e.detail]))})`,
  );
  assert.equal(
    warmedAgents.size,
    10,
    "all 10 participants were warmed in wake prefetch",
  );
});

test("wake prefetch expands a partial first tool page (200) to a complete second page (400) and merges cleanly", async (t) => {
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const requestedLimits: number[] = [];
  let mergeCalls = 0;

  const history250 = longToolHistory(250);
  const f = engineFixture(t, {
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-wake-expand",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: idleAt,
    }),
    agentTimelinePage: async (_id: string, limit: number) => {
      requestedLimits.push(limit);
      return toolTimelineTail(history250, limit);
    },
    hostProcessListing: async () => [],
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during reap defer test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  f.store.setMeta("paused", false);
  f.engine.hostHealth.answered(HOST);

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-wake-expand",
      title: "Wake partial page expansion",
      skipPRReview: true,
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-wake-expand",
    directory: "/tmp/synthetic-wake-expand",
    agentId: "agent-wake-expand",
    runId: "run-wake-expand",
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/96",
    completion: {
      eventId: "ev-comp-wake-expand",
      taskId: inserted.id,
      runId: "run-wake-expand",
      status: "ready_for_review",
      head: HEAD,
      prNumber: 96,
      summary: "done",
    },
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: false,
      review: {
        eventId: "ev-wake-expand",
        taskId: inserted.id,
        runId: "rev-wake-expand",
        reviewId: 96,
        status: "ready_to_merge",
        head: HEAD,
        summary: "ok",
      },
    },
  });

  await f.engine.wakeTask(task.id);

  assert.deepEqual(
    requestedLimits,
    [200, 400],
    "wake prefetch must expand from 200 to 400 when the first page hasOlder: true",
  );
  assert.equal(
    mergeCalls,
    1,
    `task merges cleanly using the expanded 400-entry page from wake prefetch (phase: ${f.store.task(task.id).phase}, reason: ${f.store.task(task.id).reason}, events: ${JSON.stringify(f.store.events(task.id).map((e) => [e.kind, e.detail]))})`,
  );
});

test("quantum deadline choke point bounds every slow host and forge port, blocks in-quantum process scans, and preserves durable intents", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  const hang = <T>(fallback: T) =>
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), 60_000);
      timer.unref?.();
      timers.push(timer);
    });

  let processListingCalls = 0;
  let observeCalls = 0;
  let originAgentCalls = 0;
  let mergeGateCalls = 0;
  const f = engineFixture(t, {
    observe: () => {
      observeCalls++;
      return hang<AgentObservation>({
        id: "agent-all-slow",
        workspaceId: "ws-all-slow",
        status: "idle",
        active: false,
        activeTurnId: null,
        permissions: false,
        error: "",
      });
    },
    originAgent: () => {
      originAgentCalls++;
      return hang({
        id: "agent-all-slow",
        workspaceId: "ws-all-slow",
        archived: false,
        deleted: false,
      });
    },
    agentTimeline: () => hang([]),
    agentTimelinePage: () => hang(toolTimelinePage([])),
    findRunAgents: () => hang([]),
    archiveAgent: () => hang(undefined),
    deleteAgent: () => hang(undefined),
    workspaceAvailable: () => hang(true),
    observationInventory: () => hang(new Map()),
    listLiveAgents: () => hang([]),
    hostProcessListing: () => {
      processListingCalls++;
      return hang<HostProcessFact[]>([]);
    },
    mergeGate: () => {
      mergeGateCalls++;
      return hang({ head: HEAD, base: "main", wait: "" });
    },
    merge: () => hang("merged-commit"),
    createRun: () => {
      throw new Error("unexpected createRun when all ports are slow");
    },
  });
  f.store.setMeta("paused", false);
  f.engine.hostHealth.answered(HOST);
  f.engine.resolution.quantumReadTimeoutMs = 50;
  f.engine.resolution.quantumReadBudgetMs = 80;

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-all-slow",
      title: "All host ports slow",
      skipPRReview: true,
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-all-slow",
    directory: "/tmp/synthetic-all-slow",
    agentId: "agent-all-slow",
    runId: "run-all-slow",
    retiredWorkers: [
      {
        agentId: "agent-all-slow-retired",
        runId: "run-all-slow-retired",
        profile: {
          id: "claude:sonnet",
          name: "Claude Sonnet",
          provider: "claude",
          model: "sonnet",
          notes: "",
          available: true,
          problem: "",
          supportedThinking: [],
        },
        reason: "rotated",
        hostId: HOST,
      },
    ],
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/97",
    completion: {
      eventId: "ev-comp-all-slow",
      taskId: inserted.id,
      runId: "run-all-slow",
      status: "ready_for_review",
      head: HEAD,
      prNumber: 97,
      summary: "done",
    },
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: false,
    },
  });
  const archiveKey = f.store.threadArchiveKey("agent-all-slow-retired", HOST)!;
  f.store.putThreadArchiveEffect(archiveKey, "agent-all-slow-retired", {
    status: "ready",
    at: idleAt,
    op: "archive",
  });

  await f.engine.taskQuantum(task.id);

  assert.equal(
    processListingCalls,
    0,
    "in-quantum hostProcessListing must never execute",
  );
  assert.ok(
    observeCalls + originAgentCalls + mergeGateCalls > 0,
    "task quantum exercised host/forge ports before the choke point deferred",
  );
  assert.equal(
    f.store.task(task.id).resolution.stop,
    null,
    "quantum deadline expiry must defer without recording a task stop",
  );
  assert.equal(
    f.store.getMeta<{ status: string }>(archiveKey)?.status,
    "ready",
    "durable archive intent is preserved when the quantum deadline expires",
  );
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "thread_archive_reconcile_error")
      .length,
    0,
    "quantum deadline expiry must not record thread_archive_reconcile_error",
  );
});

test("archive reconciliation bounds slow replacement/archive reads and skips inline process scans inside a task quantum", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  let processCallsInQuantum = 0;
  let inQuantum = false;
  let originCalls = 0;
  const idleAt = new Date(Date.now() - 60_000).toISOString();

  // Part A: Slow archive-state / replacement observation inside Observation.observe
  // is bounded by the quantum deadline choke point and preserves the run.
  const fSlow = engineFixture(t, {
    observe: () =>
      new Promise<AgentObservation>((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              id: "agent-replaced-rev",
              workspaceId: "ws-archive-slow",
              status: "idle",
              active: false,
              activeTurnId: null,
              permissions: false,
              error: "",
            }),
          60_000,
        );
        timer.unref?.();
        timers.push(timer);
      }),
    originAgent: () => {
      originCalls++;
      return new Promise((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              id: "agent-replaced-rev",
              workspaceId: "ws-archive-slow",
              archived: false,
              deleted: false,
            }),
          60_000,
        );
        timer.unref?.();
        timers.push(timer);
      });
    },
  });
  fSlow.store.setMeta("paused", false);
  fSlow.engine.hostHealth.answered(HOST);
  const slowInserted = fSlow.store.insert(
    submission({
      submissionId: "sub-archive-slow",
      title: "Slow archive observation",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const slowTask = fSlow.store.update(slowInserted.id, {
    phase: "reviewing",
    workspaceId: "ws-archive-slow",
    directory: "/tmp/synthetic-archive-slow",
    agentId: "agent-worker-slow",
    runId: "run-worker-slow",
  });
  fSlow.store.putRun(
    runSchema.parse({
      id: "run-superseded-slow",
      taskId: slowTask.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: "agent-replaced-rev",
      workspaceId: "ws-archive-slow",
      hostId: HOST,
      profile: null,
      status: "superseded",
      createdAt: idleAt,
      lastObservedAt: idleAt,
      active: false,
      idleSince: idleAt,
      completion: null,
      released: false,
    }),
  );

  await runInTaskQuantumScope(60, async () => {
    await fSlow.engine.resolution.observation.observe(null);
  });
  assert.ok(
    originCalls >= 1,
    "releaseUnreachableRun invoked originAgent under the quantum choke point",
  );
  assert.equal(
    fSlow.store.run("run-superseded-slow")?.released,
    false,
    "timed-out archive-state observation preserves the pending run",
  );

  // Part B: Already-archived superseded worker with pending cleanup settles its
  // archive effect in quantumFinish without running an inline hostProcessListing.
  const fArch = engineFixture(t, {
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-arch-worker",
      status: "closed",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      archived: true,
      updatedAt: idleAt,
      labels: { "nucleus.task": archTaskId },
    }),
    originAgent: async (id: string) => ({
      id,
      workspaceId: "ws-arch-worker",
      archived: true,
      deleted: false,
    }),
    archiveAgent: async () => {},
    deleteAgent: async () => {},
    hostProcessListing: async () => {
      if (inQuantum) processCallsInQuantum++;
      return [];
    },
  });
  fArch.store.setMeta("paused", false);
  fArch.engine.hostHealth.answered(HOST);
  const archInserted = fArch.store.insert(
    submission({
      submissionId: "sub-arch-worker",
      title: "Archived superseded worker",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const archTaskId = archInserted.id;
  fArch.store.update(archTaskId, {
    phase: "working",
    workspaceId: "ws-arch-worker",
    directory: "/tmp/synthetic-arch-worker",
    agentId: "agent-arch-current",
    runId: "run-arch-current",
    retiredWorkers: [
      {
        agentId: "agent-arch-old",
        runId: "run-arch-old",
        profile: {
          id: "claude:sonnet",
          name: "Claude Sonnet",
          provider: "claude",
          model: "sonnet",
          notes: "",
          available: true,
          problem: "",
          supportedThinking: [],
        },
        reason: "rotated",
        hostId: HOST,
      },
    ],
  });

  inQuantum = true;
  try {
    await runInTaskQuantumScope(5_000, async () => {
      await fArch.engine.quantumFinish(archTaskId);
    });
  } finally {
    inQuantum = false;
  }

  const archKey = fArch.store.threadArchiveKey("agent-arch-old", HOST)!;
  assert.equal(
    fArch.store.getMeta<{ status: string }>(archKey)?.status,
    "archived",
    "already-archived superseded worker settles its archive effect in quantumFinish",
  );
  assert.equal(
    processCallsInQuantum,
    0,
    "settleArchive inside quantumFinish must never run hostProcessListing inline",
  );
});

test("healthy task with 10 archived participants omitted from live inventory merges in one audit pass", async (t) => {
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const originLookups = new Set<string>();
  let mergeCalls = 0;

  const f = engineFixture(t, {
    // Live inventory omits archived agents (like Paseo's live inventory).
    observationInventory: async () => new Map<string, AgentObservation>(),
    originAgent: async (id: string) => {
      originLookups.add(id);
      return {
        id,
        workspaceId: "ws-ten-archived",
        archived: true,
        deleted: false,
      };
    },
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-ten-archived",
      status: "closed",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      archived: true,
      updatedAt: idleAt,
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
    hostProcessListing: async () => [],
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during archived-10 merge test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  f.store.setMeta("paused", false);

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-ten-archived",
      title: "Ten archived participants",
      repoPath: "/repo-ten-archived",
      skipPRReview: true,
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-ten-archived",
    directory: "/tmp/synthetic-ten-archived",
    agentId: "agent-arch10-main",
    runId: "run-arch10-main",
    retiredWorkers: Array.from({ length: 9 }, (_, i) => ({
      agentId: `agent-arch10-retired-${i}`,
      runId: `run-arch10-retired-${i}`,
      profile: {
        id: "claude:sonnet",
        name: "Claude Sonnet",
        provider: "claude",
        model: "sonnet",
        notes: "",
        available: true,
        problem: "",
        supportedThinking: [],
      },
      reason: "rotated",
      hostId: HOST,
    })),
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/98",
    completion: {
      eventId: "ev-comp-ten-archived",
      taskId: inserted.id,
      runId: "run-arch10-main",
      status: "ready_for_review",
      head: HEAD,
      prNumber: 98,
      summary: "done",
    },
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: false,
    },
  });

  await f.engine.auditPass(true);
  for (const id of [
    "agent-arch10-main",
    ...Array.from({ length: 9 }, (_, i) => `agent-arch10-retired-${i}`),
  ]) {
    assert.ok(
      originLookups.has(id),
      `archived participant ${id} received pre-process terminal observation in one pass`,
    );
  }
  assert.equal(
    mergeCalls,
    1,
    `task with 10 archived participants merges in a single audit pass (reason: ${f.store.task(task.id).reason})`,
  );
});

test("a slow process table scan does not exhaust the independent timeline warming budget for healthy tasks on the same host", async (t) => {
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  let processListingCalls = 0;
  let timelinePageCalls = 0;
  let mergeCalls = 0;

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-slow-proc-fast-tl",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: idleAt,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-slow-proc-fast-tl",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: idleAt,
    }),
    hostProcessListing: async () => {
      processListingCalls++;
      // Takes 100 ms: longer than hostPassWarmBudgetMs (60 ms), but inside
      // passProcessReadTimeoutMs (200 ms), mirroring an 11 s scan vs 10 s / 15 s defaults.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [];
    },
    agentTimelinePage: async () => {
      timelinePageCalls++;
      return toolTimelinePage([]);
    },
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "",
    }),
    createRun: async () => {
      throw new Error("unexpected createRun during slow-process test");
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
  });
  f.store.setMeta("paused", false);
  f.engine.resolution.hostPassWarmBudgetMs = 60;
  f.engine.resolution.passProcessReadTimeoutMs = 200;

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-slow-proc-fast-tl",
      title: "Healthy timeline task beside slow process scan",
      repoPath: "/repo-slow-proc-fast-tl",
      skipPRReview: true,
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "merging",
    workspaceId: "ws-slow-proc-fast-tl",
    directory: "/tmp/synthetic-slow-proc-fast-tl",
    agentId: "agent-slow-proc-fast-tl",
    runId: "run-slow-proc-fast-tl",
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/99",
    completion: {
      eventId: "ev-comp-slow-proc-fast-tl",
      taskId: inserted.id,
      runId: "run-slow-proc-fast-tl",
      status: "ready_for_review",
      head: HEAD,
      prNumber: 99,
      summary: "done",
    },
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      integrationTurn: { sequence: 1, acceptedAt: idleAt },
      mergeIntent: false,
    },
  });

  await f.engine.auditPass(true);
  assert.equal(processListingCalls, 1, "slow process scan completed once");
  assert.ok(
    timelinePageCalls >= 1,
    "timeline warming still ran after the slow process scan completed",
  );
  assert.equal(
    mergeCalls,
    1,
    `healthy timeline-dependent task advances and merges despite slow process scan (reason: ${f.store.task(task.id).reason})`,
  );
});

test("audit branch-PR recovery runs inside the task-lane quantum deadline and releases the lane for queued callers", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  const idleAt = new Date(Date.now() - 60_000).toISOString();
  let findOpenBranchPrCalls = 0;
  let lookupResolved = false;
  let signalLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    signalLookupStarted = resolve;
  });

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-branch-pr-hang",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: idleAt,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-branch-pr-hang",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: idleAt,
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
    hostProcessListing: async () => [],
    findOpenBranchPr: () => {
      findOpenBranchPrCalls++;
      signalLookupStarted();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          lookupResolved = true;
          resolve([]);
        }, 60_000);
        timer.unref?.();
        timers.push(timer);
      });
    },
  });
  f.store.setMeta("paused", false);
  (f.engine as { idleGraceMs: number }).idleGraceMs = 0;
  f.engine.resolution.quantumReadTimeoutMs = 50;
  f.engine.resolution.quantumReadBudgetMs = 60;

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-branch-pr-hang",
      title: "Branch PR lookup hang in audit",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = f.store.update(inserted.id, {
    phase: "working",
    workspaceId: "ws-branch-pr-hang",
    directory: "/tmp/synthetic-branch-pr-hang",
    branch: "ns-branch-pr-hang",
    agentId: "agent-branch-pr-hang",
    runId: "run-branch-pr-hang",
    idleSince: idleAt,
    lastObservedAt: idleAt,
    lastAgentStatus: "idle",
    agentActive: false,
  });

  // Start the real audit pass and wait until findOpenBranchPr is in flight on
  // the exclusive `task:<id>` lane.
  const passPromise = f.engine.auditPass(true);
  await lookupStarted;

  // Queue a second caller from this independent top-level context (NOT inside
  // the task lane) so LaneScheduler genuinely queues it behind the in-flight
  // branch-PR lookup rather than running it inline.
  let queuedCallerRan = false;
  let lookupResolvedWhenCallerRan = true;
  const queuedLanePromise = f.engine.scheduleLane(
    `task:${task.id}`,
    LANE_PRIORITY_TASK,
    () => {
      queuedCallerRan = true;
      lookupResolvedWhenCallerRan = lookupResolved;
    },
  );
  // Immediately after scheduling, the caller must still be queued while the
  // branch-PR lookup holds the lane.
  assert.equal(
    queuedCallerRan,
    false,
    "second caller from independent context must queue behind the active task lane rather than running inline",
  );

  await Promise.all([passPromise, queuedLanePromise]);

  assert.ok(
    findOpenBranchPrCalls >= 1,
    "real audit route called findOpenBranchPr",
  );
  assert.equal(
    queuedCallerRan,
    true,
    "queued caller on the same exclusive task:<id> lane ran after the unknown branch-PR lookup deferred",
  );
  assert.equal(
    lookupResolvedWhenCallerRan,
    false,
    "queued caller ran while the hung branch-PR lookup promise was still unresolved",
  );
  assert.equal(
    f.store.task(task.id).resolution.attention,
    false,
    "quantum deadline expiry in branch-PR lookup must defer without escalating attention",
  );
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "observation_outage").length,
    0,
    "branch-PR recovery must not hit the 120 s observation_outage bound",
  );
});

test("merge reconciliation defers on quantum deadline expiry without mutating pending/uncertain guarded retry or escalating", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const oldRequestedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  let mergedLookupCalls = 0;

  const f = engineFixture(t, {
    observationInventory: async (ids: readonly string[]) =>
      new Map<string, AgentObservation>(
        ids.map((id) => [
          id,
          {
            id,
            workspaceId: "ws-merge-defer",
            status: "idle",
            active: false,
            activeTurnId: null,
            permissions: false,
            error: "",
            updatedAt: idleAt,
          },
        ]),
      ),
    observe: async (id: string) => ({
      id,
      workspaceId: "ws-merge-defer",
      status: "idle",
      active: false,
      activeTurnId: null,
      permissions: false,
      error: "",
      updatedAt: idleAt,
    }),
    agentTimelinePage: async () => toolTimelinePage([]),
    hostProcessListing: async () => [],
    merged: () => {
      mergedLookupCalls++;
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ merged: false, head: HEAD }),
          60_000,
        );
        timer.unref?.();
        timers.push(timer);
      });
    },
    createRun: async () => {
      throw new Error("unexpected createRun during merge reconciliation defer");
    },
  });
  f.store.setMeta("paused", false);
  f.engine.hostHealth.answered(HOST);
  f.engine.resolution.quantumReadTimeoutMs = 50;
  f.engine.resolution.quantumReadBudgetMs = 80;

  const seedMergingRetryTask = (
    slug: string,
    prNumber: number,
    retryOutcome: "pending" | "uncertain",
  ) => {
    const inserted = f.store.insert(
      submission({
        submissionId: `sub-${slug}`,
        title: `Merge defer ${slug}`,
        repoPath: `/repo-${slug}`,
        skipPRReview: true,
      }),
      HOST,
      "handoff",
      HEAD,
    );
    return f.store.update(inserted.id, {
      phase: "merging",
      workspaceId: "ws-merge-defer",
      directory: `/tmp/synthetic-${slug}`,
      agentId: `agent-${slug}`,
      runId: `run-${slug}`,
      prHead: HEAD,
      prUrl: `https://github.com/example/repo/pull/${prNumber}`,
      completion: {
        eventId: `ev-comp-${slug}`,
        taskId: inserted.id,
        runId: `run-${slug}`,
        status: "ready_for_review",
        head: HEAD,
        prNumber,
        summary: "done",
      },
      reason: "Reconciling merge intent",
      resolution: {
        ...inserted.resolution,
        integrationTurn: { sequence: 1, acceptedAt: oldRequestedAt },
        mergeIntent: true,
        mergeHead: HEAD,
        mergeRequestedAt: oldRequestedAt,
        mergeResponseOutcome: "uncertain",
        mergeRetryAt: oldRequestedAt,
        mergeRetryOutcome: retryOutcome,
      },
    });
  };

  const pendingTask = seedMergingRetryTask("merge-pending", 101, "pending");
  const uncertainTask = seedMergingRetryTask(
    "merge-uncertain",
    102,
    "uncertain",
  );

  // Run through a full audit pass so executionLease passes with warmed tool
  // pages and reaches reconcileMergeIntent -> adapter.merged under the quantum deadline.
  await f.engine.auditPass(true);

  assert.ok(
    mergedLookupCalls >= 2,
    `both tasks reached adapter.merged inside reconcileMergeIntent, got ${mergedLookupCalls}`,
  );
  const pendingAfter = f.store.task(pendingTask.id);
  assert.equal(
    pendingAfter.resolution.mergeIntent,
    true,
    "pending guarded retry keeps durable mergeIntent",
  );
  assert.equal(
    pendingAfter.resolution.mergeRetryOutcome,
    "pending",
    "quantum deadline expiry must not flip mergeRetryOutcome from pending to uncertain",
  );
  assert.equal(
    pendingAfter.resolution.attention,
    false,
    "pending guarded retry must not escalate on quantum deadline expiry",
  );
  assert.equal(pendingAfter.resolution.stop, null);

  const uncertainAfter = f.store.task(uncertainTask.id);
  assert.equal(
    uncertainAfter.resolution.mergeIntent,
    true,
    "uncertain guarded retry keeps durable mergeIntent",
  );
  assert.equal(
    uncertainAfter.resolution.mergeRetryOutcome,
    "uncertain",
    "uncertain guarded retry preserves its retry outcome",
  );
  assert.equal(
    uncertainAfter.resolution.attention,
    false,
    "uncertain guarded retry must not escalate on quantum deadline expiry",
  );
  assert.equal(uncertainAfter.resolution.stop, null);
});

test("already-expired quantum scope rejects before invoking native host or forge reads and mutations", async (t) => {
  let observeCalls = 0;
  let originAgentCalls = 0;
  let findOpenBranchPrCalls = 0;
  let archiveAgentCalls = 0;
  let mergeCalls = 0;
  let createRunCalls = 0;

  const f = engineFixture(t, {
    observe: async (id: string) => {
      observeCalls++;
      return {
        id,
        workspaceId: "ws-expired",
        status: "idle",
        active: false,
        activeTurnId: null,
        permissions: false,
        error: "",
      };
    },
    originAgent: async (id: string) => {
      originAgentCalls++;
      return {
        id,
        workspaceId: "ws-expired",
        archived: false,
        deleted: false,
      };
    },
    findOpenBranchPr: async () => {
      findOpenBranchPrCalls++;
      return [];
    },
    archiveAgent: async () => {
      archiveAgentCalls++;
    },
    merge: async () => {
      mergeCalls++;
      return "merged-commit";
    },
    createRun: async () => {
      createRunCalls++;
      return { id: "agent-new", workspaceId: "ws-expired" };
    },
  });
  const inserted = f.store.insert(
    submission({
      submissionId: "sub-expired-scope",
      title: "Expired scope pre-send guard",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const run = runSchema.parse({
    id: "run-expired-scope",
    taskId: inserted.id,
    role: "reviewer",
    generation: 1,
    head: HEAD,
    base: HEAD,
    agentId: null,
    workspaceId: "ws-expired",
    hostId: HOST,
    profile: null,
    status: "intent",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: false,
  });

  const rawFacade = new HostFacade({ adapter: f.adapter });
  await runInTaskQuantumScope(0, async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => f.engine.host.observe("agent-expired"),
      () => rawFacade.originAgent("agent-expired"),
      () => f.engine.adapter.findOpenBranchPr!(inserted),
      () => f.engine.host.archiveAgent("agent-expired"),
      () =>
        (
          f.engine.adapter as unknown as {
            merge: (t: Task, allowed: () => boolean) => Promise<unknown>;
          }
        ).merge(inserted, () => true),
      () => f.engine.adapter.createRun!(inserted, run, "prompt"),
    ];
    for (const invoke of calls) {
      await assert.rejects(invoke, (error: unknown) => {
        assert.ok(
          isQuantumDeadlineExceeded(error),
          `expected QuantumDeadlineExceededError, got ${String(error)}`,
        );
        assert.equal(
          error.preSend,
          true,
          "already-expired scope must report definite preSend: true",
        );
        return true;
      });
    }
  });

  assert.equal(observeCalls, 0, "expired scope must not invoke native observe");
  assert.equal(
    originAgentCalls,
    0,
    "expired scope must not invoke native originAgent via HostFacade",
  );
  assert.equal(
    findOpenBranchPrCalls,
    0,
    "expired scope must not invoke native findOpenBranchPr",
  );
  assert.equal(
    archiveAgentCalls,
    0,
    "expired scope must not invoke native archiveAgent mutation",
  );
  assert.equal(
    mergeCalls,
    0,
    "expired scope must not invoke native merge mutation",
  );
  assert.equal(
    createRunCalls,
    0,
    "expired scope must not invoke native createRun mutation",
  );
});

test("settleArchive preserves durable intent when confirmation expires after mutation succeeds, and synchronous adapter members stay synchronous in an expired scope", async (t) => {
  const { settleArchive } = await import(
    "../core/workspaces/thread-archive-effect"
  );
  let archiveSendCalls = 0;
  let originCalls = 0;

  const f = engineFixture(t, {
    originAgent: async (id: string) => {
      originCalls++;
      return {
        id,
        workspaceId: "ws-confirm-expire",
        archived: false,
        deleted: false,
      };
    },
    archiveAgent: async () => {
      archiveSendCalls++;
      // Advance past the 20 ms quantum deadline synchronously before resolving
      // so the mutation itself returns cleanly (`mutationCompleted = true`) and
      // the following confirmation `originAgent` deterministically hits an
      // already-expired scope (`preSend: true` for the confirmation read).
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* busy-wait 25 ms so the mutation resolves before any timer fires */
      }
    },
    workspaceIdAccepted: (id: unknown) => id === "ws-ok",
    hostLoad: () => ({ load: 1.5, cpus: 8 }),
    runTemporaryDirectory: (runId: string) => `/synthetic/scratch/${runId}`,
    scratchNamespaceFor: (taskArg: Task) => `ns-${taskArg.id}`,
    isConnected: () => true,
    worktreeValidation: () => ({ state: "missing" as const, reason: "none" }),
  });

  const inserted = f.store.insert(
    submission({
      submissionId: "sub-confirm-expire",
      title: "Archive confirmation expiry",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const key = f.store.threadArchiveKey("agent-confirm-expire", HOST)!;
  const readyEffect = {
    status: "ready" as const,
    at: new Date().toISOString(),
    op: "archive" as const,
  };
  f.store.putThreadArchiveEffect(key, "agent-confirm-expire", readyEffect);

  // Pass 1: mutation runs and succeeds, then confirmation `originAgent` sees an
  // already-expired scope (`preSend: true` for read). The effect MUST stay
  // `intent` (never reverted to `ready`).
  await runInTaskQuantumScope(20, async () => {
    await settleArchive(
      f.store,
      f.engine.adapter,
      inserted.id,
      "agent-confirm-expire",
      key,
      true,
      readyEffect,
    );
  });
  assert.equal(archiveSendCalls, 1, "archive mutation was sent once");
  assert.equal(
    f.store.getMeta<{ status: string }>(key)?.status,
    "intent",
    "expired confirmation read after mutation return must keep durable intent, never revert to ready",
  );

  // Pass 2: subsequent pass observes the thread still live and MUST send
  // nothing while the prior mutation's outcome remains unknown.
  const storedIntent = f.store.getMeta<{ status: "intent"; at: string }>(key)!;
  await settleArchive(
    f.store,
    f.engine.adapter,
    inserted.id,
    "agent-confirm-expire",
    key,
    false,
    storedIntent,
  );
  assert.equal(
    archiveSendCalls,
    1,
    "subsequent pass must not re-send archive while prior mutation outcome is unknown",
  );
  assert.equal(
    f.store.getMeta<{ status: string }>(key)?.status,
    "uncertain",
    "subsequent pass transitions prior live intent to uncertain without re-sending",
  );
  assert.ok(originCalls >= 2);

  // Part B: Synchronous adapter members return plain values unchanged in an
  // already-expired quantum scope (never rejected promises).
  await runInTaskQuantumScope(0, async () => {
    assert.equal(f.engine.adapter.workspaceIdAccepted?.("ws-ok"), true);
    assert.equal(f.engine.adapter.workspaceIdAccepted?.("ws-bad"), false);
    assert.deepEqual(f.engine.adapter.hostLoad?.(), { load: 1.5, cpus: 8 });
    assert.equal(
      f.engine.adapter.runTemporaryDirectory?.("run-123", inserted),
      "/synthetic/scratch/run-123",
    );
    assert.equal(
      f.engine.adapter.scratchNamespaceFor?.(inserted),
      `ns-${inserted.id}`,
    );
    assert.equal(f.engine.adapter.isConnected?.(), true);
    assert.deepEqual(
      f.engine.adapter.worktreeValidation?.("/tmp/synthetic", [
        ["effigy", "check"],
      ]),
      { state: "missing", reason: "none" },
    );
  });
});

test("launch delivery, worker creation, and permission denial handle pre-send and post-send quantum deadline expiries cleanly", async (t) => {
  const {
    denyPendingPermission,
    PERMISSION_DENIAL_REFUSED,
    PERMISSION_DENIED,
  } = await import("../core/recovery/permission-policy");
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  let createAgentCalls = 0;
  let createRunCalls = 0;
  let sendRunCalls = 0;
  let answerPermissionCalls = 0;
  let slowCreateRun = false;

  let expireBeforeCreateAgent = false;
  const f = engineFixture(t, {
    verifyWorkspace: async () => "ns-worker-presend",
    readStash: async () => {
      if (expireBeforeCreateAgent) {
        const until = Date.now() + 220;
        while (Date.now() < until) {
          /* advance past 200 ms scope so createAgent itself hits preSend: true */
        }
      }
      return [];
    },
    createAgent: async () => {
      createAgentCalls++;
      return { id: "agent-created", workspaceId: "ws-launch-defer" };
    },
    createRun: () => {
      createRunCalls++;
      if (slowCreateRun) {
        return new Promise((resolve) => {
          const timer = setTimeout(
            () =>
              resolve({ id: "agent-run-late", workspaceId: "ws-launch-defer" }),
            60_000,
          );
          timer.unref?.();
          timers.push(timer);
        });
      }
      return Promise.resolve({
        id: "agent-run-fast",
        workspaceId: "ws-launch-defer",
      });
    },
    sendRun: async () => {
      sendRunCalls++;
    },
    answerNativePermission: async () => {
      answerPermissionCalls++;
    },
  });
  f.store.setMeta("paused", false);
  f.engine.hostHealth.answered(HOST);

  // Part A: RunLaunchDeliver with pre-send expired scope on sendRun releases
  // the unsent run cleanly without marking `uncertain`, `exact_lookup`, or stop.
  const sendInserted = f.store.insert(
    submission({
      submissionId: "sub-deliver-presend",
      title: "Deliver pre-send expired",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const sendTask = f.store.update(sendInserted.id, {
    phase: "reviewing",
    workspaceId: "ws-launch-defer",
    directory: "/tmp/synthetic-launch-defer",
    agentId: "agent-worker-defer",
    runId: "run-worker-defer",
    prHead: HEAD,
    prUrl: "https://github.com/example/repo/pull/105",
  });
  const sendRun = runSchema.parse({
    id: "run-send-presend",
    taskId: sendTask.id,
    role: "reviewer",
    generation: 1,
    head: HEAD,
    base: HEAD,
    agentId: "agent-rev-existing",
    workspaceId: "ws-launch-defer",
    hostId: HOST,
    profile: null,
    status: "intent",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.store.putRun(sendRun);
  f.store.update(sendTask.id, {
    resolution: { ...sendTask.resolution, currentRunId: sendRun.id },
  });

  await runInTaskQuantumScope(0, async () => {
    await f.engine.resolution.dispatchLaunch.deliver.deliverLaunchRun(
      f.store.task(sendTask.id),
      "reviewer",
      {
        agentId: "agent-rev-existing",
        profile: null,
        group: null,
        workspaceId: "ws-launch-defer",
        firstReviewEntryWorker: false,
        nonDeliveryReplacement: false,
        run: sendRun,
        token: "tok-send",
      },
    );
  });
  assert.equal(sendRunCalls, 0, "expired scope must not invoke native sendRun");
  const sendRunAfter = f.store.run(sendRun.id)!;
  assert.equal(
    sendRunAfter.status,
    "superseded",
    "pre-send expired sendRun releases the unsent run instead of marking uncertain",
  );
  assert.equal(sendRunAfter.released, true);
  assert.equal(f.store.task(sendTask.id).resolution.currentRunId, null);
  assert.equal(f.store.task(sendTask.id).resolution.stop, null);
  assert.equal(f.store.task(sendTask.id).resolution.incident, null);

  // Part B: RunLaunchDeliver with post-send timeout on createRun preserves
  // durable `uncertain` status WITHOUT recording a stop.
  slowCreateRun = true;
  const createRunRow = runSchema.parse({
    id: "run-create-postsend",
    taskId: sendTask.id,
    role: "reviewer",
    generation: 1,
    head: HEAD,
    base: HEAD,
    agentId: null,
    workspaceId: "ws-launch-defer",
    hostId: HOST,
    profile: null,
    status: "intent",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: null,
    completion: null,
    released: false,
  });
  f.store.putRun(createRunRow);
  f.store.update(sendTask.id, {
    resolution: {
      ...f.store.task(sendTask.id).resolution,
      currentRunId: createRunRow.id,
    },
  });

  await runInTaskQuantumScope(40, async () => {
    await f.engine.resolution.dispatchLaunch.deliver.deliverLaunchRun(
      f.store.task(sendTask.id),
      "reviewer",
      {
        agentId: null,
        profile: null,
        group: null,
        workspaceId: "ws-launch-defer",
        firstReviewEntryWorker: false,
        nonDeliveryReplacement: false,
        run: createRunRow,
        token: "tok-create",
      },
    );
  });
  assert.equal(createRunCalls, 1, "post-send createRun started before expiry");
  assert.equal(
    f.store.run(createRunRow.id)?.status,
    "uncertain",
    "post-send createRun timeout preserves durable uncertain run",
  );
  assert.equal(
    f.store.task(sendTask.id).resolution.stop,
    null,
    "post-send createRun timeout must not record a stop",
  );

  // Part C: denyPendingPermission hitting a pre-send expired scope records
  // PERMISSION_DENIAL_REFUSED (not UNKNOWN), so a subsequent pass retries and succeeds.
  const permInserted = f.store.insert(
    submission({
      submissionId: "sub-perm-presend",
      title: "Permission denial pre-send expired",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const permTask = f.store.update(permInserted.id, {
    phase: "working",
    workspaceId: "ws-perm-defer",
    directory: "/tmp/synthetic-perm-defer",
    agentId: "agent-perm-defer",
    runId: "run-perm-defer",
  });
  const permState: AgentObservation = {
    id: "agent-perm-defer",
    workspaceId: "ws-perm-defer",
    status: "running",
    active: true,
    activeTurnId: "turn-1",
    permissions: true,
    pendingRequest: { id: "req-1", kind: "permission", firstLine: null },
    error: "",
  };
  await runInTaskQuantumScope(0, async () => {
    const ok = await denyPendingPermission(
      f.engine.resolution,
      permTask,
      null,
      permState,
    );
    assert.equal(ok, false);
  });
  assert.equal(
    answerPermissionCalls,
    0,
    "expired scope must not invoke native answerNativePermission",
  );
  assert.equal(
    f.store
      .events(permTask.id)
      .filter((e) => e.kind === PERMISSION_DENIAL_REFUSED).length,
    1,
    "pre-send expired scope records PERMISSION_DENIAL_REFUSED instead of permanently blocking with UNKNOWN",
  );

  // Subsequent pass with budget succeeds and sends the denial once.
  const retriedOk = await denyPendingPermission(
    f.engine.resolution,
    f.store.task(permTask.id),
    null,
    permState,
  );
  assert.equal(retriedOk, true, "next pass retries and succeeds");
  assert.equal(answerPermissionCalls, 1);
  assert.equal(
    f.store.events(permTask.id).filter((e) => e.kind === PERMISSION_DENIED)
      .length,
    1,
  );

  // Part D: WorkerLauncher hitting a pre-send expired scope on createAgent
  // releases the unsent worker reservation without recording `exact_lookup` or a stop.
  const workerProfile = {
    id: "claude:sonnet",
    name: "Claude Sonnet",
    provider: "claude",
    model: "sonnet",
    notes: "",
    available: true,
    problem: "",
    supportedThinking: [],
  };
  f.engine.profiles = [workerProfile];
  const workerInserted = f.store.insert(
    submission({
      submissionId: "sub-worker-presend",
      title: "Worker createAgent pre-send expired",
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const workerTask = f.store.update(workerInserted.id, {
    phase: "dispatching",
    workspaceId: "ws-launch-defer",
    directory: "/tmp/synthetic-launch-defer",
    branch: "ns-worker-presend",
    profile: workerProfile,
  });
  expireBeforeCreateAgent = true;
  await runInTaskQuantumScope(200, async () => {
    await f.engine.launchAgent(workerTask);
  });
  assert.equal(
    createAgentCalls,
    0,
    "expired scope must not invoke native createAgent",
  );
  const workerAfter = f.store.task(workerTask.id);
  assert.equal(
    workerAfter.agentIntent,
    false,
    "pre-send expired createAgent releases agentIntent cleanly",
  );
  assert.equal(workerAfter.runId, null);
  assert.equal(workerAfter.resolution.incident, null);
  assert.equal(workerAfter.resolution.stop, null);
});

test("ownedToolHold and executionLease return typed deferred on all four paths under timeout and uncaptured snapshot, while a real live tool still holds", async (t) => {
  const idleAt = new Date(Date.now() - 60_000).toISOString();
  const baseObs = (
    id: string,
    workspaceId: string,
    extra: Partial<AgentObservation> = {},
  ): AgentObservation => ({
    id,
    workspaceId,
    status: "idle",
    active: false,
    activeTurnId: null,
    permissions: false,
    error: "",
    updatedAt: idleAt,
    ...extra,
  });

  // Helper to seed a task ready for executionLease checks.
  const seedLeaseTask = (
    f: ReturnType<typeof engineFixture>,
    slug: string,
    agentId: string,
    workspaceId: string,
    runId: string,
  ) => {
    const inserted = f.store.insert(
      submission({ submissionId: `sub-${slug}`, title: `Lease ${slug}` }),
      HOST,
      "handoff",
      HEAD,
    );
    const task = f.store.update(inserted.id, {
      phase: "verifying",
      workspaceId,
      directory: `/tmp/synthetic-${slug}`,
      temporaryDirectory: `/tmp/synthetic-${slug}-scratch`,
      agentId,
      runId,
      reason: "Waiting for execution lease",
    });
    f.store.putRun(
      runSchema.parse({
        id: runId,
        taskId: task.id,
        role: "revision",
        generation: 1,
        head: HEAD,
        base: HEAD,
        agentId,
        workspaceId,
        hostId: HOST,
        temporaryDirectory: `/tmp/synthetic-${slug}-scratch`,
        profile: null,
        status: "finished",
        createdAt: idleAt,
        lastObservedAt: idleAt,
        active: false,
        idleSince: idleAt,
        completion: null,
        released: true,
      }),
    );
    return f.store.task(task.id);
  };

  // --- Path 1: verifyOwnedWorkspaceAndScratchProcesses (retired participant) ---
  {
    let slowProcess = false;
    let slowWorkspaceProbe = false;
    const f = engineFixture(t, {
      observe: async (id: string) =>
        baseObs(id, "ws-p1", { status: "closed", archived: true }),
      originAgent: async (id: string) => ({
        id,
        workspaceId: "ws-p1",
        archived: true,
        deleted: false,
      }),
      hostProcessListing: async () => {
        if (slowProcess) await new Promise(() => {});
        return [];
      },
      noLiveWorkspaceProcesses: async () => {
        if (slowWorkspaceProbe) await new Promise(() => {});
        return null;
      },
    });
    f.engine.resolution.quantumReadTimeoutMs = 40;
    f.engine.resolution.passProcessReadTimeoutMs = 40;
    const runId = "11111111-1111-4111-8111-111111111001";
    const task = seedLeaseTask(f, "p1", "agent-p1", "ws-p1", runId);

    // 1a. Uncaptured pass snapshot inside task quantum
    const uncaptured = await runInTaskQuantumScope(500, () =>
      f.engine.resolution.ownedToolHold("agent-p1", {
        requireCompleteEvidence: true,
        allowRetired: true,
        runId,
        runIds: [runId],
        taskId: task.id,
        workspaceId: "ws-p1",
      }),
    );
    assert.equal(uncaptured.kind, "deferred");
    const leaseUncaptured = await runInTaskQuantumScope(500, () =>
      f.engine.resolution.executionLease(f.store.task(task.id)),
    );
    assert.equal(leaseUncaptured, false);
    assert.equal(f.store.task(task.id).resolution.stop, null);

    // 1b. Quantum timeout on process listing & workspace probe
    slowProcess = true;
    const timedOutProc = await f.engine.resolution.ownedToolHold("agent-p1", {
      requireCompleteEvidence: true,
      allowRetired: true,
      runId,
      runIds: [runId],
      taskId: task.id,
      workspaceId: "ws-p1",
    });
    assert.equal(timedOutProc.kind, "deferred");
    const leaseTimedOutProc = await f.engine.resolution.executionLease(
      f.store.task(task.id),
    );
    assert.equal(leaseTimedOutProc, false);
    assert.equal(f.store.task(task.id).resolution.stop, null);

    slowProcess = false;
    slowWorkspaceProbe = true;
    const timedOutProbe = await f.engine.resolution.ownedToolHold("agent-p1", {
      requireCompleteEvidence: true,
      allowRetired: true,
      runId,
      runIds: [runId],
      taskId: task.id,
      workspaceId: "ws-p1",
    });
    assert.equal(timedOutProbe.kind, "deferred");
    const leaseTimedOutProbe = await f.engine.resolution.executionLease(
      f.store.task(task.id),
    );
    assert.equal(leaseTimedOutProbe, false);
    assert.equal(f.store.task(task.id).resolution.stop, null);
  }

  // --- Path 2: boundedToolHold ---
  {
    let observeCall = 0;
    let slowSecondObserve = false;
    const boundedPage: TimelinePage = {
      entries: [],
      hasOlder: true,
      gap: false,
      staleCursor: false,
      reset: false,
      hasNewer: false,
      epoch: "agent-p2",
      startCursor: null,
      endCursor: null,
      projection: "bounded",
      pendingBackgroundTasks: [],
    };
    const f = engineFixture(t, {
      observe: async (id: string) => {
        observeCall++;
        if (slowSecondObserve && observeCall >= 2) await new Promise(() => {});
        return baseObs(id, "ws-p2");
      },
      agentTimelinePage: async () => boundedPage,
      hostProcessListing: async () => [],
      noLiveWorkspaceProcesses: async () => null,
    });
    f.engine.resolution.quantumReadTimeoutMs = 40;
    f.engine.resolution.passProcessReadTimeoutMs = 40;
    const runId = "11111111-1111-4111-8111-111111111002";
    const task = seedLeaseTask(f, "p2", "agent-p2", "ws-p2", runId);

    // 2a. Quantum timeout on observe inside boundedToolHold
    slowSecondObserve = true;
    observeCall = 1; // next call (inside boundedToolHold) hangs
    const timedOutBounded = await f.engine.resolution.ownedToolHold(
      "agent-p2",
      {
        requireCompleteEvidence: true,
        runId,
        runIds: [runId],
        taskId: task.id,
        workspaceId: "ws-p2",
      },
    );
    assert.equal(timedOutBounded.kind, "deferred");

    observeCall = 0; // 1st observe in executionLease succeeds; 2nd in boundedToolHold hangs
    const leaseTimedOutBounded = await f.engine.resolution.executionLease(
      f.store.task(task.id),
    );
    assert.equal(leaseTimedOutBounded, false);
    assert.equal(f.store.task(task.id).resolution.stop, null);

    // 2b. Uncaptured pass process snapshot inside boundedToolHold's processProof
    slowSecondObserve = false;
    const snap = f.engine.resolution.beginPassSnapshot();
    try {
      snap.storeTimelinePage(HOST, "agent-p2", 200, {
        state: "ok",
        value: boundedPage,
        capturedAt: Date.now(),
        fromPassSnapshot: true,
        coveredObservation: { updatedAt: idleAt, status: "idle" },
      });
      snap.sealHost(HOST); // process listing was never captured in this pass
      const uncapturedBounded = await runInTaskQuantumScope(
        500,
        () =>
          f.engine.resolution.ownedToolHold("agent-p2", {
            requireCompleteEvidence: true,
            runId,
            runIds: [runId],
            taskId: task.id,
            workspaceId: "ws-p2",
          }),
        snap,
      );
      assert.equal(uncapturedBounded.kind, "deferred");
      const leaseUncapturedBounded = await runInTaskQuantumScope(
        500,
        () => f.engine.resolution.executionLease(f.store.task(task.id)),
        snap,
      );
      assert.equal(leaseUncapturedBounded, false);
      assert.equal(f.store.task(task.id).resolution.stop, null);
    } finally {
      f.engine.resolution.endPassSnapshot(snap);
    }
  }

  // --- Path 3: observedTurnState (warmed complete page + post-timeline) ---
  {
    let observeCall = 0;
    let slowSecondObserve = false;
    const f = engineFixture(t, {
      observe: async (id: string) => {
        observeCall++;
        if (slowSecondObserve && observeCall >= 2) await new Promise(() => {});
        return baseObs(id, "ws-p3");
      },
      agentTimelinePage: async () => toolTimelinePage([]),
    });
    f.engine.resolution.quantumReadTimeoutMs = 40;
    const runId = "11111111-1111-4111-8111-111111111003";
    const task = seedLeaseTask(f, "p3", "agent-p3", "ws-p3", runId);

    const snap = f.engine.resolution.beginPassSnapshot();
    try {
      snap.storeTimelinePage(HOST, "agent-p3", 200, {
        state: "ok",
        value: toolTimelinePage([]),
        capturedAt: Date.now(),
        fromPassSnapshot: true,
        coveredObservation: { updatedAt: idleAt, status: "idle" },
      });
      snap.sealHost(HOST);
      slowSecondObserve = true;
      observeCall = 1; // next call (warmed-page observedTurnState) hangs
      const timedOutWarmed = await runInTaskQuantumScope(
        500,
        () =>
          f.engine.resolution.ownedToolHold("agent-p3", {
            requireCompleteEvidence: true,
            runId,
            runIds: [runId],
            taskId: task.id,
            workspaceId: "ws-p3",
          }),
        snap,
      );
      assert.equal(timedOutWarmed.kind, "deferred");

      observeCall = 0; // 1st in executionLease succeeds; 2nd in warmed-page observedTurnState hangs
      const leaseTimedOutWarmed = await runInTaskQuantumScope(
        500,
        () => f.engine.resolution.executionLease(f.store.task(task.id)),
        snap,
      );
      assert.equal(leaseTimedOutWarmed, false);
      assert.equal(f.store.task(task.id).resolution.stop, null);
    } finally {
      f.engine.resolution.endPassSnapshot(snap);
    }
  }

  // --- Path 4: readToolTimeline (uncaptured snapshot & quantum timeout) ---
  {
    let slowTimeline = false;
    const f = engineFixture(t, {
      observe: async (id: string) => baseObs(id, "ws-p4"),
      agentTimelinePage: async () => {
        if (slowTimeline) await new Promise(() => {});
        return toolTimelinePage([]);
      },
    });
    f.engine.resolution.quantumReadTimeoutMs = 40;
    const runId = "11111111-1111-4111-8111-111111111004";
    const task = seedLeaseTask(f, "p4", "agent-p4", "ws-p4", runId);

    // 4a. Uncaptured timeline snapshot in task quantum
    const uncapturedTimeline = await runInTaskQuantumScope(500, () =>
      f.engine.resolution.ownedToolHold("agent-p4", {
        requireCompleteEvidence: true,
        runId,
        runIds: [runId],
        taskId: task.id,
        workspaceId: "ws-p4",
      }),
    );
    assert.equal(uncapturedTimeline.kind, "deferred");
    const leaseUncapturedTimeline = await runInTaskQuantumScope(500, () =>
      f.engine.resolution.executionLease(f.store.task(task.id)),
    );
    assert.equal(leaseUncapturedTimeline, false);
    assert.equal(f.store.task(task.id).resolution.stop, null);

    // 4b. Quantum timeout inside readToolTimeline
    slowTimeline = true;
    const timedOutTimeline = await f.engine.resolution.ownedToolHold(
      "agent-p4",
      {
        requireCompleteEvidence: true,
        runId,
        runIds: [runId],
        taskId: task.id,
        workspaceId: "ws-p4",
      },
    );
    assert.equal(timedOutTimeline.kind, "deferred");
    const leaseTimedOutTimeline = await f.engine.resolution.executionLease(
      f.store.task(task.id),
    );
    assert.equal(leaseTimedOutTimeline, false);
    assert.equal(f.store.task(task.id).resolution.stop, null);
  }

  // --- Control: a real live tool still returns kind "hold" and records operator_needed ---
  {
    const runId = "11111111-1111-4111-8111-111111111005";
    const f = engineFixture(t, {
      observe: async (id: string) => baseObs(id, "ws-p5"),
      agentTimelinePage: async () =>
        toolTimelinePage([
          {
            timestamp: idleAt,
            turnId: "turn-live",
            item: {
              type: "tool_call",
              callId: "live-shell",
              name: "Bash",
              status: "running",
              detail: { type: "shell", command: "sleep 999" },
            },
          },
        ]),
      hostProcessListing: async () => [
        {
          pid: 700,
          ppid: 1,
          pgid: 700,
          uid: 501,
          startIdentity: "700@a",
          command: "claude",
          cwd: null,
        },
        {
          pid: 701,
          ppid: 700,
          pgid: 700,
          uid: 501,
          startIdentity: "701@a",
          command: `node /p/mcp-report.mjs /tickets/mcp-${runId}.json`,
          cwd: null,
        },
        {
          pid: 702,
          ppid: 700,
          pgid: 700,
          uid: 501,
          startIdentity: "702@a",
          command: "sleep 999",
          cwd: null,
        },
      ],
    });
    const task = seedLeaseTask(f, "p5", "agent-p5", "ws-p5", runId);
    const liveHold = await f.engine.resolution.ownedToolHold("agent-p5", {
      requireCompleteEvidence: true,
      runId,
      runIds: [runId],
      taskId: task.id,
      workspaceId: "ws-p5",
    });
    assert.equal(liveHold.kind, "hold");
    if (liveHold.kind === "hold")
      assert.match(liveHold.reason, /descendant pid 702 remains/);

    (f.engine.resolution as unknown as { graceMs: number }).graceMs = 0;
    const leaseLive = await f.engine.resolution.executionLease(
      f.store.task(task.id),
    );
    assert.equal(leaseLive, false);
    assert.equal(
      f.store.task(task.id).resolution.stop?.reason,
      "operator_needed",
      "a real live tool still holds and records operator_needed",
    );
  }
});
