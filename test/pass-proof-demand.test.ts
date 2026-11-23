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
import {
  HOST_PASS_WARM_CANDIDATE_CAP,
  runInTaskQuantumScope,
} from "../core/scheduling/pass-snapshot";
import { PASS_DEMAND_BATCH_SIZE, PassDemand } from "../core/scheduling/pass-demand";
import { fakeAdapter, submission } from "./support/fakes";
import { runSchema, type Task } from "../shared/contracts";

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
    archived?: ReadonlySet<string>;
    beforeObserve?: (agentId: string) => void;
    beforePage?: (agentId: string) => void;
    shellReads?: string[];
  },
) {
  const store = new Store(":memory:");
  const pageReads: string[] = [];
  const inventoryIds: string[] = [];
  const merged: string[] = [];
  const adapter = fakeAdapter({
    hostId: HOST,
    supportsCoordinatorRecovery: false,
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
      archived: options.archived?.has(id) ?? false,
      deleted: false,
    }),
    observe: async (id: string) => {
      options.beforeObserve?.(id);
      const observation = idle(id, options.workspaces.get(id) ?? "");
      return options.archived?.has(id)
        ? { ...observation, status: "closed", archived: true }
        : observation;
    },
    agentTimelinePage: async (id: string) => {
      pageReads.push(id);
      options.beforePage?.(id);
      if (options.archived?.has(id)) throw Error("thread is no longer observed");
      return boundedPage(id);
    },
    agentTimeline: options.shellReads && (async (id: string) => {
      options.shellReads?.push(id);
      return [];
    }),
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

test("a merging task can advance with retained idle participants outside the warm inventory", async (t) => {
  const workspaces = new Map<string, string>();
  const f = fixture(t, { workspaces });
  const seeded = seedMergingTask(f.store, "idle-retained");
  for (const [id, ws] of participantWorkspaces(seeded)) workspaces.set(id, ws);

  await f.engine.auditPass(true);
  assert.ok(
    !f.inventoryIds.includes(seeded.workerId),
    "the task-row worker is not an observation target, as in the live shape",
  );
  assert.deepEqual(
    f.merged,
    [seeded.task.id],
    `the merge advances in one pass (reason: ${f.store.task(seeded.task.id).reason})`,
  );
});

test("a quantum read of a pass timeline page registers demand", async (t: TestContext) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new Engine(store, fakeAdapter({}) as unknown as Adapter, 60_000);
  const resolution = engine.resolution;
  const read = await runInTaskQuantumScope(30_000, () =>
    resolution.readPassTimelinePage("agent-continuation", 20, HOST));
  assert.equal(read.state, "unknown", "outside a pass the quantum gets no live read");
  assert.deepEqual(resolution.takePassProofs(HOST), [
    { agentId: "agent-continuation", page: "timeline" },
  ]);
});

test("continuously renewed pass demand advances even when each pass can serve only its first entry", () => {
  const demand = new PassDemand();
  const agents = Array.from({ length: PASS_DEMAND_BATCH_SIZE + 2 }, (_, index) =>
    `participant-${index}`,
  );
  const first = [];
  for (const _ of agents) {
    for (const id of agents) demand.request(HOST, id, "owned-tools");
    first.push(demand.take(HOST)[0]?.agentId);
  }
  assert.deepEqual(first, agents);
  const pending = demand.take(HOST);
  assert.equal(pending.length, PASS_DEMAND_BATCH_SIZE);
  for (const { agentId } of pending) demand.served(HOST, agentId);
  const remaining = demand.take(HOST);
  assert.equal(remaining.length, 2, "unserved demand survives without renewal");
  for (const { agentId } of remaining) demand.served(HOST, agentId);
  assert.deepEqual(demand.take(HOST), []);
});

test("a served demand disappears from the sweep when no task renews it", async (t) => {
  const f = fixture(t, { workspaces: new Map() });
  seedMergingTask(f.store, "one-shot-demand");
  f.engine.taskQuantum = async () => {};
  const agentId = "requested-once";
  f.engine.resolution.requestPassProof(HOST, agentId, "timeline");

  assert.equal((await f.engine.auditPass(true)).fault, null);
  assert.ok(f.pageReads.includes(agentId));
  assert.equal((await f.engine.auditPass(true)).fault, null);
  assert.equal(f.pageReads.filter((id) => id === agentId).length, 1);
  assert.deepEqual(f.engine.resolution.takePassProofs(HOST), []);
});

for (const duration of ["fast", "slow"]) {
  test(`a sustained backlog of ${duration} demands leaves room for shell reads`, async (t) => {
    const workspaces = new Map<string, string>();
    const shellReads: string[] = [];
    const warmBudgetMs = 10_000;
    let nowMs = Date.now();
    t.mock.method(Date, "now", () => nowMs);
    const agents = new Set(
      Array.from({ length: HOST_PASS_WARM_CANDIDATE_CAP + 4 }, (_, i) =>
        `requested-${i}`,
      ),
    );
    const f = fixture(t, {
      workspaces,
      shellReads,
      beforePage(id) {
        if (duration === "slow" && agents.has(id)) nowMs += warmBudgetMs / 2;
      },
    });
    f.engine.resolution.hostPassWarmBudgetMs = warmBudgetMs;
    f.engine.taskQuantum = async () => {};
    const shell = seedMergingTask(f.store, "protected-shell");
    for (const [id, workspace] of participantWorkspaces(shell))
      workspaces.set(id, workspace);
    f.store.update(shell.task.id, { phase: "working", completion: null });

    for (let pass = 0; pass < 3; pass++) {
      f.pageReads.length = 0;
      shellReads.length = 0;
      for (const agentId of agents)
        f.engine.resolution.requestPassProof(HOST, agentId, "timeline");
      assert.equal((await f.engine.auditPass(true)).fault, null);
      assert.ok(agents.has(f.pageReads[0] ?? ""), "demand gets first use of its reservation");
      assert.ok(shellReads.includes(shell.workerId), "shell had a warmed timeline");
    }
  });
}
