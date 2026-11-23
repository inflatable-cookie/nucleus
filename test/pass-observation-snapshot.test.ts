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

  assert.ok(
    hold && /predates the participant's latest observation/i.test(hold),
    `warmed empty page must not clear after a newer turn, got: ${hold}`,
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

  let holdDuringPass: string | null = "not-checked";
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
  assert.equal(
    holdDuringPass,
    null,
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

test("bounded tool projection holds when a newer turn advances updatedAt after the host pass snapshot", async (t) => {
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
    await f.engine.hostPass.run(HOST);
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
    assert.ok(
      hold,
      "bounded tool proof must hold when fresh observation has a newer updatedAt than the pass snapshot",
    );
    assert.match(hold, /predates|active after the pass process snapshot/i);
  } finally {
    snapshot.expire();
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

test("worker reconcileObservation bounds hung observe and settleSupersededIdleRuns shares one quantum budget across runs", async (t) => {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });

  let observeCalls = 0;
  const f = engineFixture(t, {
    observe: () => {
      observeCalls++;
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
    originAgent: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 60_000);
        timer.unref?.();
        timers.push(timer);
      }),
  });
  f.engine.resolution.quantumReadTimeoutMs = 100;

  // 1. Working task with hung host.observe returns inside quantum deadline.
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

  const workerStart = performance.now();
  await f.engine.reconcile(f.store.task(working.id));
  const workerElapsed = performance.now() - workerStart;
  assert.ok(
    workerElapsed < 2_000,
    `reconcileObservation with hung observe should return inside bound, took ${workerElapsed.toFixed(1)} ms`,
  );

  // 2. Seven eligible superseded runs share ONE quantum budget instead of 7 * 2 * budget.
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
  const callsBefore = observeCalls;
  const supStart = performance.now();
  const settled = await f.engine.settleSupersededIdleRuns(
    multi.task.id,
    "shared budget test",
  );
  const supElapsed = performance.now() - supStart;
  assert.equal(settled, 0);
  assert.ok(
    supElapsed < 2_000,
    `7 slow superseded runs must share one quantum budget, took ${supElapsed.toFixed(1)} ms`,
  );
  assert.ok(
    observeCalls - callsBefore < 7,
    `budget expiry should stop before observing all 7 runs, observed ${observeCalls - callsBefore}`,
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
    await f.engine.hostPass.run(HOST);
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
