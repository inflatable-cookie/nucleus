import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema, taskControlInputSchema, type Completion } from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import { proofWaitApplies } from "../core/resolution";

const head = "a".repeat(40),
  commit = "b".repeat(40);
const OPEN_PR = "PR must be open, ready, and match the task branch and base";
const blockedReview = (taskId: string): Completion => ({
  eventId: "blocked-review",
  taskId,
  runId: "blocked-review-run",
  status: "blocked",
  summary: "Source approved; awaiting post-merge proof",
  head,
  sourceApproved: true,
  awaitingProofs: [{ proof: "post-merge-proof", route: "external" }],
  reviewResponsibility: "environment",
});

async function closeoutFixture(opts: { merged?: boolean; review?: Completion } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "force-closeout-")), "queue.sqlite"));
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Merged blocked task",
      repoPath: "/repo",
      planningCommit: commit,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    commit,
  );
  let observations = 0;
  const remote = { merged: opts.merged !== false };
  const adapter = {
    merged: async () => (remote.merged ? { merged: true, commit, head, base: "main" } : { merged: false, commit: null, head, base: "main" }),
    syncMain: async () => commit,
    verifyPrIdentity: async () => { throw Error(OPEN_PR); },
    verifyPr: async () => { throw Error(OPEN_PR); },
    observe: async () => {
      observations++;
      throw Error("participant unavailable");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta("paused", false);
  store.update(task.id, {
    phase: "needs_attention",
    agentId: "worker",
    workspaceId: "ws",
    prHead: head,
    resumePrNumber: 7,
    resolution: {
      ...store.task(task.id).resolution,
      attention: true,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      ...(opts.review ? { review: opts.review } : {}),
    },
  });
  const current = () => store.task(task.id);
  const forceCloseout = () => engine.performTaskControl(taskControlInputSchema.parse({
    taskId: task.id, version: current().version, action: "move", to: "closeout", force: true,
    caller: "operator (board)", reason: "GitHub confirms merge",
  }));
  const finish = async () => {
    const resolution = engine.resolution as unknown as {
      advance(task: ReturnType<typeof current>): Promise<void>;
      advanceSyncing(task: ReturnType<typeof current>): Promise<void>;
      advanceClosing(task: ReturnType<typeof current>): Promise<void>;
      closeoutAuthority(task: ReturnType<typeof current>): Promise<"queue">;
    };
    resolution.closeoutAuthority = async () => "queue";
    (engine as unknown as { stopped: boolean }).stopped = false;
    await resolution.advance(current());
    if (current().phase === "syncing") await resolution.advanceSyncing(current());
    if (current().phase === "closing") await resolution.advanceClosing(current());
  };
  return { store, engine, task: current, forceCloseout, finish, observations: () => observations, remote };
}

test("one forced move lets a merged task with an unobservable participant finish closeout", async () => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-closeout-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Merged blocked task",
      repoPath: "/repo",
      planningCommit: commit,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    commit,
  );
  let observations = 0;
  const adapter = {
    merged: async () => ({ merged: true, commit, head, base: "main" }),
    syncMain: async () => commit,
    observe: async () => {
      observations++;
      throw Error("participant unavailable");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta("paused", false);
  try {
    store.update(task.id, {
      phase: "needs_attention",
      agentId: "worker",
      workspaceId: "ws",
      prHead: head,
      resumePrNumber: 7,
      resolution: {
        ...store.task(task.id).resolution,
        attention: true,
        integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      },
    });
    const moved = await engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: store.task(task.id).version,
        action: "move",
        to: "closeout",
        force: true,
        caller: "operator (board)",
        reason: "GitHub confirms merge",
      }),
    );
    assert.equal(moved.resolution.integrationTurn, null);
    assert.match(moved.reason, /uncertain/);
    assert.ok(
      store
        .eventsAll(task.id)
        .some((event) => event.kind === "owner_force_uncertain_participant"),
    );
    const resolution = engine.resolution as unknown as {
      advanceSyncing(task: typeof moved): Promise<void>;
      advanceClosing(task: typeof moved): Promise<void>;
      closeoutAuthority(task: typeof moved): Promise<"queue">;
    };
    resolution.closeoutAuthority = async () => "queue";
    (engine as unknown as { stopped: boolean }).stopped = false;
    await resolution.advanceSyncing(store.task(task.id));
    assert.equal(
      store.task(task.id).phase,
      "closing",
      store.task(task.id).reason,
    );
    await resolution.advanceClosing(store.task(task.id));
    assert.equal(store.task(task.id).phase, "done");
    assert.equal(observations, 1);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("a merged PR with a blocked source-approved review closes out and records mergedWithNone", async () => {
  const f = await closeoutFixture({ review: blockedReview("pending") });
  try {
    f.store.update(f.task().id, { resolution: { ...f.task().resolution, review: blockedReview(f.task().id) } });
    assert.equal(proofWaitApplies(f.task()), true);
    const moved = await f.forceCloseout();
    assert.equal(moved.phase, "syncing");
    assert.equal(moved.resolution.mergedCommit, commit);
    assert.equal(moved.resolution.mergedWithNone, true);
    assert.equal(moved.resolution.review?.status, "blocked");
    assert.equal(proofWaitApplies(moved), false);
    await f.finish();
    assert.equal(f.task().phase, "done", f.task().reason);
    assert.equal(f.task().resolution.mergedWithNone, true);
    assert.equal(f.task().resolution.review?.status, "blocked", "the reviewer record stays as reported");
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("an ordinary accepted merge still closes out without mergedWithNone", async () => {
  const review: Completion = {
    eventId: "accepted-review", taskId: "pending", runId: "accepted-review-run",
    status: "ready_to_merge", summary: "Ready", head,
  };
  const f = await closeoutFixture({ review });
  try {
    f.store.update(f.task().id, { resolution: { ...f.task().resolution, review: { ...review, taskId: f.task().id } } });
    const moved = await f.forceCloseout();
    assert.equal(moved.resolution.mergedCommit, commit);
    assert.equal(moved.resolution.mergedWithNone, false);
    await f.finish();
    assert.equal(f.task().phase, "done", f.task().reason);
    assert.equal(f.task().resolution.mergedWithNone, false);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("an unmerged PR still refuses forced closeout", async () => {
  const f = await closeoutFixture({ merged: false, review: blockedReview("pending") });
  try {
    f.store.update(f.task().id, { resolution: { ...f.task().resolution, review: blockedReview(f.task().id) } });
    const before = f.task();
    await assert.rejects(f.forceCloseout(), /not confirmed merged/);
    assert.equal(f.task().version, before.version);
    assert.equal(f.task().resolution.mergedCommit, null);
    assert.equal(proofWaitApplies(f.task()), true);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
