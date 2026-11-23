import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store, operationIdForKey, operationInputHash } from "../core/store/store";
import { Engine } from "../core/engine";
import type {
  Adapter,
  AgentObservation,
  HostProcessFact,
  TimelinePage,
} from "../core/host";
import {
  currentTaskQuantumScope,
  HOST_PASS_WARM_CANDIDATE_CAP,
  runInTaskQuantumScope,
} from "../core/scheduling/pass-snapshot";
import { fakeAdapter, submission } from "./support/fakes";
import { runSchema, type Task } from "../shared/contracts";
import { taskControlOperation } from "../core/verbs/task-control-key";
import { readHostReadTransientEpisode } from "../core/recovery/host-read-transient";
import { taskProgressDigest } from "../core/recovery/coordinator-report";
import { boundDrainProjection } from "../core/closeout/queue-drain";
import { HostReadRefusalError } from "../core/host/errors";

const HOST = "host-1";
const HEAD = "a".repeat(40);
const IDLE_AT = new Date(Date.now() - 10 * 60_000).toISOString();

/** The bounded window a T3 thread answers for a long history: no live call in view. */
function boundedPage(agentId: string): TimelinePage {
  return {
    entries: [],
    hasOlder: true,
    hasNewer: false,
    gap: false,
    staleCursor: false,
    reset: false,
    epoch: agentId,
    startCursor: null,
    endCursor: null,
    projection: "bounded",
    pendingBackgroundTasks: [],
  };
}

function idle(id: string, workspaceId: string): AgentObservation {
  return {
    id,
    workspaceId,
    status: "idle",
    active: false,
    activeTurnId: null,
    permissions: false,
    error: "",
    updatedAt: IDLE_AT,
  };
}

/**
 * A reviewed merging task as the store holds it after review: the task-row worker
 * has no Run row, the retained reviewer's run is released and finished, and both
 * are idle in the task workspace. Neither is an observation target, so the pass
 * inventory never answers for them.
 */
function seedMergingTask(store: Store, slug: string): {
  task: Task;
  workerId: string;
  reviewerId: string;
  workspaceId: string;
} {
  const workspaceId = `ws-${slug}`;
  const workerId = `thread:delegated-task:ns-agent-${slug}`;
  const reviewerId = `thread:delegated-task:ns-run-${slug}-review`;
  const inserted = store.insert(
    submission({
      submissionId: `sub-${slug}`,
      title: `Merging ${slug}`,
      repoPath: `/repo-${slug}`,
      skipPRReview: true,
    }),
    HOST,
    "handoff",
    HEAD,
  );
  const task = store.update(inserted.id, {
    phase: "merging",
    workspaceId,
    directory: `/tmp/synthetic-${slug}`,
    temporaryDirectory: `/tmp/synthetic-${slug}-scratch`,
    agentId: workerId,
    runId: `run-${slug}`,
    prHead: HEAD,
    prUrl: `https://github.com/example/${slug}/pull/7`,
    completion: {
      eventId: `ev-${slug}`,
      taskId: inserted.id,
      runId: `run-${slug}`,
      status: "ready_for_review",
      head: HEAD,
      prNumber: 7,
      summary: "done",
    },
    reason: "Ready to merge",
    resolution: {
      ...inserted.resolution,
      reviewerAgentId: reviewerId,
      integrationTurn: { sequence: 1, acceptedAt: IDLE_AT },
      mergeIntent: false,
    },
  });
  store.putRun(
    runSchema.parse({
      id: `run-${slug}-review`,
      taskId: task.id,
      role: "reviewer",
      generation: 1,
      head: HEAD,
      base: HEAD,
      agentId: reviewerId,
      workspaceId,
      hostId: HOST,
      profile: null,
      status: "finished",
      createdAt: IDLE_AT,
      lastObservedAt: IDLE_AT,
      active: false,
      idleSince: IDLE_AT,
      completion: null,
      released: true,
      temporaryDirectory: `/tmp/synthetic-${slug}-review-scratch`,
    }),
  );
  return { task: store.task(task.id), workerId, reviewerId, workspaceId };
}

function fixture(
  t: TestContext,
  options: {
    processes?: () => HostProcessFact[];
    workspaces: Map<string, string>;
    recovery?: boolean;
    beforeObserve?: (agentId: string) => void;
  },
) {
  const store = new Store(":memory:");
  const pageReads: string[] = [];
  const inventoryIds: string[] = [];
  const merged: string[] = [];
  const adapter = fakeAdapter({
    hostId: HOST,
    supportsCoordinatorRecovery: options.recovery ?? false,
    observationInventory: async (ids: readonly string[]) => {
      inventoryIds.push(...ids);
      return new Map(
        ids.map((id) => [id, idle(id, options.workspaces.get(id) ?? "")]),
      );
    },
    originAgent: async (id: string) => ({
      id,
      workspaceId: options.workspaces.get(id) ?? "",
      title: id,
      archived: false,
      deleted: false,
    }),
    observe: async (id: string) => {
      options.beforeObserve?.(id);
      return idle(id, options.workspaces.get(id) ?? "");
    },
    agentTimelinePage: async (id: string) => {
      pageReads.push(id);
      return boundedPage(id);
    },
    hostProcessListing: async () => options.processes?.() ?? [],
    noLiveWorkspaceProcesses: async () => null,
    mergeGate: async () => ({ head: HEAD, base: "main", wait: "" }),
    createRun: async () => {
      throw new Error("unexpected createRun while merging");
    },
    merge: async (task: Task) => {
      merged.push(task.id);
    },
  });
  const engine = new Engine(store, adapter as unknown as Adapter, 60_000);
  store.setMeta("paused", false);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  return { store, engine, pageReads, inventoryIds, merged };
}

function participantWorkspaces(
  ...seeded: Array<ReturnType<typeof seedMergingTask>>
) {
  const workspaces = new Map<string, string>();
  for (const item of seeded) {
    workspaces.set(item.workerId, item.workspaceId);
    workspaces.set(item.reviewerId, item.workspaceId);
  }
  return workspaces;
}

test("a merging task with retained idle participants outside the inventory clears its proof and merges within two passes", async (t) => {
  const workspaces = new Map<string, string>();
  const f = fixture(t, { workspaces });
  const seeded = seedMergingTask(f.store, "idle-retained");
  for (const [id, ws] of participantWorkspaces(seeded)) workspaces.set(id, ws);

  await f.engine.auditPass(true);
  assert.ok(
    !f.inventoryIds.includes(seeded.workerId),
    "the task-row worker is not an observation target, as in the live shape",
  );
  // The freshness rule still holds: the first pass's snapshot predates any
  // inactivity proof for the worker, so it never clears the lease.
  assert.deepEqual(f.merged, []);
  assert.match(
    f.store.task(seeded.task.id).reason,
    /captured before the participant was proven inactive/,
  );
  await f.engine.auditPass(true);
  assert.deepEqual(
    f.merged,
    [seeded.task.id],
    `the proof converges within two passes (reason: ${f.store.task(seeded.task.id).reason})`,
  );
});

test("a live process in a retained participant's scratch directory still holds the merge after demand-driven observation", async (t) => {
  const workspaces = new Map<string, string>();
  const f = fixture(t, {
    workspaces,
    processes: () => [
      {
        pid: 4242,
        ppid: 1,
        pgid: 4242,
        uid: 501,
        state: "S",
        startIdentity: "start-4242",
        command: "sleep 600",
        cwd: "/tmp/synthetic-live-child-scratch",
      },
    ],
  });
  const seeded = seedMergingTask(f.store, "live-child");
  for (const [id, ws] of participantWorkspaces(seeded)) workspaces.set(id, ws);

  for (let pass = 0; pass < 3; pass++) await f.engine.auditPass(true);
  assert.deepEqual(f.merged, [], "a live scratch process never clears");
  assert.match(
    f.store.task(seeded.task.id).reason,
    /process 4242 remains in the task workspace process tree/,
  );
});

test("pages a quantum could not read are warmed first on the next pass, past the warm cap", async (t) => {
  const workspaces = new Map<string, string>();
  const f = fixture(t, { workspaces });
  const count = HOST_PASS_WARM_CANDIDATE_CAP + 4;
  const seeded = Array.from({ length: count }, (_, i) =>
    seedMergingTask(f.store, `crowd-${i}`),
  );
  for (const [id, ws] of participantWorkspaces(...seeded))
    workspaces.set(id, ws);

  await f.engine.auditPass(true);
  const firstPass = new Set(f.pageReads);
  const starved = seeded
    .flatMap((item) => [item.workerId, item.reviewerId])
    .filter((id) => !firstPass.has(id));
  assert.ok(
    starved.length > 0,
    "the first pass's warm cap leaves some participants' pages uncaptured",
  );
  f.pageReads.length = 0;

  await f.engine.auditPass(true);
  const secondPass = new Set(f.pageReads);
  for (const id of starved)
    assert.ok(
      secondPass.has(id),
      `${id} was demanded and warmed on the next pass`,
    );
  assert.equal(
    f.merged.length,
    count,
    `every merging task merges within two passes (merged ${f.merged.length} of ${count})`,
  );
});

test("any quantum read of a pass timeline page registers demand, not only the owned-tool proof", async (t: TestContext) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new Engine(store, fakeAdapter({}) as unknown as Adapter, 60_000);
  const resolution = engine.resolution;
  const read = await runInTaskQuantumScope(30_000, () =>
    resolution.readPassTimelinePage("agent-continuation", 20, HOST));
  assert.equal(read.state, "unknown", "outside a pass the quantum gets no live read");
  assert.deepEqual(resolution.takePassProofs(HOST, new Set(["agent-continuation"])), ["agent-continuation"]);
});

function seedOwnedToolHold(store: Store, workspaces: Map<string, string>) {
  const seeded = seedMergingTask(store, "owned-tool-retry");
  for (const [id, ws] of participantWorkspaces(seeded)) workspaces.set(id, ws);
  const task = store.update(seeded.task.id, {
    phase: "needs_attention",
    reason: "Owned-tool evidence was incomplete",
  });
  store.event(task.id, "owned_tool_hold", JSON.stringify({
    runId: task.runId,
    reason: task.reason,
  }));
  return { task, effect: `owned_tool.${task.runId}` };
}

function ownedToolRetry(task: Task, effect: string) {
  return {
    ...taskControlOperation({
      taskId: task.id,
      version: task.version,
      action: "retry_effect",
      effect,
      reason: "Recheck the owned tool",
    }),
    kind: "task_control" as const,
  };
}

test("a deferred durable owned-tool retry waits for the host pass and is audited as applied", async (t) => {
  const workspaces = new Map<string, string>();
  const { store, engine, pageReads } = fixture(t, { workspaces });
  const { task, effect } = seedOwnedToolHold(store, workspaces);
  store.setMeta("hostReadTransientMaxAttempts", 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const accepted = await engine.startOperation(ownedToolRetry(task, effect));
  assert.ok("accepted" in accepted);
  const id = accepted.operation.id;
  await engine.quiesce();
  assert.equal(store.operation(id)?.state, "pending");
  assert.equal(readHostReadTransientEpisode(store, id, "op")?.retryOnPass, true);
  assert.deepEqual(store.verbOutcomes(""), []);
  assert.deepEqual(pageReads, [], "the task lane does not read a timeline");

  t.mock.timers.tick(10_000);
  await engine.scheduleOperation(id);
  await engine.quiesce();
  assert.equal(store.operation(id)?.state, "pending");
  assert.equal(readHostReadTransientEpisode(store, id, "op")?.attempts, 1);
  t.mock.timers.reset();

  assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.operation(id)?.state, "succeeded", store.operation(id)?.diagnostic);
  assert.deepEqual(store.verbOutcomes("").map(({ action, outcome, source }) => ({ action, outcome, source })), [
    { action: "retry_effect", outcome: "applied", source: "owner" },
  ]);
});

test("a paused queue drains after it serves an accepted owned-tool proof retry", async (t) => {
  const workspaces = new Map<string, string>();
  let failRetryRead = false;
  const { store, engine } = fixture(t, {
    workspaces,
    beforeObserve() {
      if (!failRetryRead || !currentTaskQuantumScope()?.snapshot) return;
      failRetryRead = false;
      throw new HostReadRefusalError("The participant inventory changed during the retry");
    },
  });
  const { task, effect } = seedOwnedToolHold(store, workspaces);
  store.setMeta("paused", true);
  const accepted = await engine.startOperation(ownedToolRetry(task, effect));
  assert.ok("accepted" in accepted);
  await engine.quiesce();
  assert.equal(store.operation(accepted.operation.id)?.state, "pending");
  assert.equal(boundDrainProjection(store).drained, false);
  failRetryRead = true;
  assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.operation(accepted.operation.id)?.state, "pending");
  assert.equal(readHostReadTransientEpisode(store, accepted.operation.id, "op")?.retryOnPass, true);
  assert.equal((await engine.auditPass(true)).fault, null);
  if (store.operation(accepted.operation.id)?.state === "pending")
    assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.operation(accepted.operation.id)?.state, "succeeded");
  assert.equal(store.getMeta("paused"), true);
  assert.equal(boundDrainProjection(store).drained, true);
});

test("older pending operations do not crowd out a pass-proof retry", async (t) => {
  const workspaces = new Map<string, string>();
  const { store, engine } = fixture(t, { workspaces });
  const { task, effect } = seedOwnedToolHold(store, workspaces);
  store.setMeta("operationLimit", 256);
  for (let i = 0; i < 205; i++) {
    const key = `older-operation-${i}`;
    store.putOperation({
      id: operationIdForKey(key), key, kind: "submit", inputHash: operationInputHash({}),
      state: "pending", taskId: null, expectedVersion: null, createdAt: IDLE_AT,
      repoPath: null, submissionId: null,
      startedAt: null, settledAt: null, attempts: 0, diagnostic: "", result: null,
      effect: null,
    }, {});
  }
  const accepted = await engine.startOperation(ownedToolRetry(task, effect));
  assert.ok("accepted" in accepted);
  const id = accepted.operation.id;
  await engine.quiesce();
  assert.equal(store.operation(id)?.state, "pending");
  assert.ok(!store.operations({ states: ["pending"] }).some((operation) => operation.id === id));
  assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.operation(id)?.state, "succeeded");
});

test("a transient host read leaves the owner audit to the successful operation", async (t) => {
  const workspaces = new Map<string, string>();
  const { store, engine } = fixture(t, { workspaces });
  const apply = engine.performTaskControlApplied.bind(engine);
  engine.performTaskControlApplied = async () => {
    engine.performTaskControlApplied = apply;
    throw new HostReadRefusalError("The participant inventory changed during the read");
  };
  const { task, effect } = seedOwnedToolHold(store, workspaces);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const accepted = await engine.startOperation(ownedToolRetry(task, effect));
  assert.ok("accepted" in accepted);
  const id = accepted.operation.id;
  await engine.quiesce();
  assert.equal(store.operation(id)?.state, "pending");
  assert.match(store.operation(id)?.diagnostic ?? "", /inventory changed/);
  assert.deepEqual(store.verbOutcomes(""), []);
  // Older builds could have recorded the transient error under this durable key.
  store.recordVerbOutcome(task.id, "retry_effect", "refused", "owner", {}, `operation:${id}`);
  await engine.scheduleOperation(id);
  assert.equal(readHostReadTransientEpisode(store, id, "op")?.retryOnPass, true);
  t.mock.timers.reset();
  assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.operation(id)?.state, "succeeded");
  assert.deepEqual(store.verbOutcomes("").map(({ outcome }) => outcome), ["applied"]);
});

test("a coordinator's accepted owned-tool retry stays pending through a second transient host read", async (t) => {
  const workspaces = new Map<string, string>();
  const { store, engine } = fixture(t, { workspaces, recovery: true });
  const { task, effect } = seedOwnedToolHold(store, workspaces);
  const runId = "coordinator-run";
  const agentId = "coordinator-agent";
  const binding = {
    eventId: "coordinator-report",
    runId,
    reportStatus: "recovered",
    coordinatorAction: { verb: "retry_effect", effect, reason: "Check the tool again" },
    summary: "Check the tool again",
    status: "pending",
  } as const;
  assert.ok(task.workspaceId);
  workspaces.set(agentId, task.workspaceId);
  const current = store.update(task.id, {
    coordinatorAgentId: agentId,
    coordinatorGeneration: 1,
    resolution: {
      ...task.resolution,
      recoveryActive: true,
      coordinatorWorkspaceId: task.workspaceId,
      recovery: {
        id: "episode",
        key: "owned-tool-hold",
        generation: 1,
        runId,
        agentId,
        status: "running",
        summary: "",
        idleSince: null,
        incidentId: null,
        progress: taskProgressDigest(task),
        action: binding,
      },
    },
  });
  const run = runSchema.parse({
    id: runId, taskId: task.id, role: "recovery", generation: 1,
    head: HEAD, base: HEAD, agentId, workspaceId: task.workspaceId,
    hostId: HOST, profile: null, status: "running", createdAt: IDLE_AT,
    lastObservedAt: IDLE_AT, idleSince: IDLE_AT, active: false, released: false,
    completion: {
      eventId: binding.eventId, taskId: task.id, runId, status: "recovered",
      summary: binding.summary, coordinatorAction: binding.coordinatorAction,
      coordinatorGeneration: 1,
    },
  });
  store.putRun(run);
  await runInTaskQuantumScope(30_000, () => engine.applyCoordinatorAction(current, run, binding));
  assert.equal(store.task(task.id).resolution.recovery?.action?.status, "pending");
  assert.equal(store.run(runId)?.released, false);
  assert.deepEqual(store.verbOutcomes(""), []);
  assert.equal(store.eventsAll(task.id).filter((event) => event.kind === "run_result_deferred").length, 1);

  const apply = engine.performTaskControl.bind(engine);
  engine.performTaskControl = async () => {
    engine.performTaskControl = apply;
    throw new HostReadRefusalError("The participant inventory changed during the read");
  };
  assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.task(task.id).resolution.recovery?.action?.status, "pending");
  assert.equal(store.run(runId)?.released, false);
  assert.deepEqual(store.verbOutcomes(""), []);
  assert.equal(store.eventsAll(task.id).filter((event) => event.kind === "run_result_deferred").length, 2);

  assert.equal((await engine.auditPass(true)).fault, null);
  if (store.task(task.id).resolution.recovery?.action?.status === "pending")
    assert.equal((await engine.auditPass(true)).fault, null);
  assert.equal(store.task(task.id).resolution.recovery?.action?.status, "applied", store.task(task.id).reason);
  assert.deepEqual(store.verbOutcomes("").map(({ outcome, source }) => ({ outcome, source })), [
    { outcome: "applied", source: "coordinator" },
  ]);
});
