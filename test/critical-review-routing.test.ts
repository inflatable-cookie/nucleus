import { profile } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { criticalReviewerMeets } from "../core/dispatch/routing";
import {
  parseNorthstarDocument,
  submissionQueueFields,
} from "../core/planning/handoff";
import {
  OPERATOR_BOARD_CALLER,
  poolSchema,
  submissionSchema,
  taskControlInputSchema,
  type Profile,
  type PoolEntry,
} from "../shared/contracts";
import type { Adapter } from "../core/host";


const profiles = [
  profile("worker"),
  profile("cheap"),
  profile("peer"),
  profile("frontier"),
  profile("worker-alias", "test/worker"),
];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "critical-review-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const pool = profiles.map((p, i) =>
    poolSchema.parse({
      profileId: p.id,
      enabled: true,
      group: p.id,
      roles: ["worker", "reviewer"],
      weight: 1,
      scopes: ["general"],
      capability: ["high", "low", "high", "very_high", "high"][i],
      cost: i === 3 ? "very_high" : "low",
    }),
  );
  store.setMeta("pool", pool);
  const initial = store.insert(
    submissionSchema.parse({
      submissionId: "critical",
      title: "Critical review",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "h",
      originAgentId: "origin",
      critical: true,
      complexity: "very_low",
    }),
    "host",
    "",
    "a".repeat(40),
  );
  const task = store.update(initial.id, {
    profile: profiles[0],
    workerModel: "worker",
    workerModels: ["worker"],
    agentId: "author",
  });
  const engine = new Engine(store, {} as Adapter, 0);
  engine.profiles = profiles;
  return { store, engine, task, pool };
}

test("critical is one optional brief boolean, retained on task and writable through set_routing", () => {
  const metadata = parseNorthstarDocument(
    "---\ntitle: Critical\nqueue:\n  critical: true\n---\nReview this carefully.\n",
    "draft",
  );
  assert.equal(submissionQueueFields(metadata.queue).critical, true);
  assert.throws(() =>
    parseNorthstarDocument(
      "---\ntitle: Critical\nqueue:\n  critical: high\n---\nBody\n",
      "draft",
    ),
  );
  assert.equal(
    taskControlInputSchema.parse({
      action: "set_routing",
      taskId: "task",
      version: 1,
      critical: true,
      reason: "Operator requests rigour",
    }).critical,
    true,
  );
  const f = fixture();
  try {
    assert.equal(f.store.task(f.task.id).critical, true);
  } finally {
    f.store.close();
  }
});

test("critical automatic selection requires peer capability and different model from every author", () => {
  const f = fixture();
  try {
    assert.equal(
      f.engine.resolution.select(f.task, "reviewer")?.profile.id,
      "peer",
    );
    const priorPeerAuthor = { ...f.task, workerModels: ["worker", "peer"] };
    assert.equal(
      f.engine.resolution.select(priorPeerAuthor, "reviewer")?.profile.id,
      "cheap",
      "frontier needs sign-off, and prior author cannot review",
    );
    assert.equal(
      f.engine.resolution.select(
        {
          ...f.task,
          profile: profiles[3],
          workerModel: "frontier",
          workerModels: ["worker", "frontier"],
        },
        "reviewer",
      )?.profile.id,
      "cheap",
      "a stronger rerouted worker rejudges fresh selection and falls back",
    );
  } finally {
    f.store.close();
  }
});

test("unrated worker/reviewer and unsigned frontier cannot prove critical capability; fallback proceeds and records on task", () => {
  const f = fixture();
  try {
    const entries: PoolEntry[] = f.pool.map((e) =>
      e.profileId === "peer" ? { ...e, capability: null } : e,
    );
    f.store.setMeta("pool", entries);
    const chosen = f.engine.resolution.select(f.task, "reviewer")!;
    assert.equal(chosen.profile.id, "cheap");
    assert.equal(criticalReviewerMeets(f.task, chosen.profile, entries), false);
    const record = (
      f.engine.resolution as unknown as {
        recordCriticalReviewFallback: (
          task: typeof f.task,
          profile: Profile,
        ) => typeof f.task;
      }
    ).recordCriticalReviewFallback(f.task, chosen.profile);
    assert.equal(record.resolution.criticalReviewFallbacks.length, 1);
    assert.equal(
      f.store.task(f.task.id).resolution.criticalReviewFallbacks[0]
        .reviewerProfileId,
      "cheap",
    );
    assert.match(
      record.resolution.criticalReviewFallbacks[0].reason,
      /ordinary reviewer selection/,
    );
    assert.equal(
      criticalReviewerMeets(
        f.task,
        profiles[2],
        f.pool.map((e) =>
          e.profileId === "worker" ? { ...e, capability: null } : e,
        ),
      ),
      false,
    );
  } finally {
    f.store.close();
  }
});

test("ordinary tasks keep ordinary routing and critical selection respects availability and usage gates", () => {
  const f = fixture();
  try {
    assert.equal(
      f.engine.resolution.select({ ...f.task, critical: false }, "reviewer")
        ?.profile.id,
      "cheap",
    );
    assert.equal(
      f.engine.resolution.select(f.task, "reviewer", ["peer"])?.profile.id,
      "cheap",
    );
    assert.equal(
      f.engine.resolution.select(
        f.task,
        "reviewer",
        ["peer"],
        new Set(),
        "maximum",
      )?.profile.id,
      "frontier",
    );
  } finally {
    f.store.close();
  }
});

test("only planner or operator may change critical after dispatch", async () => {
  const f = fixture();
  try {
    const current = () => f.store.task(f.task.id);
    const control = (critical: boolean, caller: string) =>
      f.engine.performTaskControl(
        taskControlInputSchema.parse({
          taskId: f.task.id,
          version: current().version,
          action: "set_routing",
          critical,
          caller,
          reason: "Change review rigour",
        }),
      );
    await assert.rejects(
      control(false, "author"),
      /Only the planner or operator/,
    );
    assert.equal(current().critical, true);
    await control(false, OPERATOR_BOARD_CALLER);
    assert.equal(current().critical, false);
    f.store.upsertProject({
      key: "critical-project",
      name: "Critical",
      repositories: [{ origin: null, path: "/repo" }],
    });
    f.store.setProjectPlanner({
      key: "critical-project",
      agentId: "planner",
      setBy: "operator",
    });
    await control(true, "planner");
    assert.equal(current().critical, true);
    await control(false, "planner");
    assert.equal(current().critical, false);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
