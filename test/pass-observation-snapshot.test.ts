import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import type {
  Adapter,
  AgentObservation,
  HostProcessFact,
  TimelinePage,
} from "../core/host";
import { PassSnapshot, boundedRead } from "../core/scheduling/pass-snapshot";
import { observeAssignedThread } from "../core/dispatch/run-launch/assigned-thread";
import type { LaunchThreadContext } from "../core/dispatch/launch";
import { fakeAdapter, submission } from "./support/fakes";
import { toolTimelinePage } from "./support/tool-timeline";
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

  assert.ok(
    hold && /predates|before the participant was proven inactive/i.test(hold),
    `pre-idle pass process snapshot must keep lease held, got: ${hold}`,
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

test("timing: sweep task quantum with a 60 s process double completes inside its bound with unknown hold", async (t) => {
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => {
    if (slowTimer) clearTimeout(slowTimer);
  });

  let processListingAttempts = 0;
  const f = engineFixture(t, {
    hostProcessListing: () => {
      processListingAttempts++;
      return new Promise<HostProcessFact[]>((resolve) => {
        slowTimer = setTimeout(() => resolve([]), 60_000);
        slowTimer.unref?.();
      });
    },
    agentTimelinePage: async () =>
      toolTimelinePage([runningShellEntry("call-timing")]),
  });
  f.engine.resolution.passProcessReadTimeoutMs = 250;
  f.engine.resolution.quantumReadTimeoutMs = 250;

  const { task, runId, agentId } = seedFinishedWorkerTask(
    f.store,
    "timing-slow",
  );

  let quantumCompleted = false;
  let observedHold: string | null = null;
  const originalQuantum = f.engine.taskQuantum.bind(f.engine);
  f.engine.taskQuantum = async (taskId: string) => {
    await originalQuantum(taskId);
    if (taskId === task.id) {
      observedHold = await f.engine.resolution.ownedToolHold(agentId, {
        taskId: task.id,
        runId,
        runIds: [runId],
        workspaceId: task.workspaceId!,
        requireCompleteEvidence: true,
      });
      quantumCompleted = true;
    }
  };

  const started = performance.now();
  const pass = await f.engine.auditPass(true);
  const elapsedMs = performance.now() - started;

  assert.equal(pass.fault, null, "audit pass completed without engine fault");
  assert.equal(pass.covered, true, "audit pass covered the target task");
  assert.equal(
    processListingAttempts,
    1,
    "the slow 60 s process listing double was attempted once for the pass",
  );
  assert.equal(
    quantumCompleted,
    true,
    "the target task quantum ran and completed",
  );
  assert.ok(
    observedHold && /unreadable|unknown|timed out/i.test(observedHold),
    `target quantum must hold with unknown/unreadable process fact, got: ${observedHold}`,
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
