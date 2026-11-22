import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { chooseProfile } from "../core/dispatch/routing";
import {
  poolSchema,
  submissionSchema,
  type PoolEntry,
  type Profile,
  type ProfileWeight,
  type Task,
} from "../shared/contracts";
import { profile } from "./support/fakes";

// nucleus#1558: steeper weight stops (50/75/100/150/200%) and rotation within each role.
// Every case runs the real chooseProfile against a stored pool and the stored assignment
// history, the way dispatch reads them: store.rotationCounts(role) feeds both windows.

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "queue-rotation-by-role-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Store(join(dir, "queue.sqlite"));
}

const workerTask = (): Task =>
  submissionSchema.parse({
    submissionId: "rotation",
    title: "Rotation fixture",
    repoPath: "/repo",
    planningCommit: "a".repeat(40),
    handoffPath: "handoff.md",
    originAgentId: "origin",
    complexity: "medium",
  }) as Task;

/** Worker-bracket profiles, one subscription group each, stored as the pool the store reads. */
function seed(store: Store, entries: Array<{ id: string; weight: ProfileWeight }>) {
  const profiles: Profile[] = entries.map(({ id }) => profile(id));
  const pool: PoolEntry[] = entries.map(({ id, weight }) =>
    poolSchema.parse({
      profileId: id,
      enabled: true,
      group: id,
      roles: ["worker", "reviewer"],
      weight,
      scopes: ["general"],
      capability: "worker",
    }),
  );
  store.setMeta("pool", pool);
  return { profiles, pool };
}

/** One worker selection through the real selector, then the charge dispatch records for it. */
function pickWorker(store: Store, profiles: Profile[], pool: PoolEntry[]): string {
  const rotation = store.rotationCounts("worker");
  const chosen = chooseProfile(
    workerTask(),
    profiles,
    pool,
    rotation.counts,
    new Set(),
    "worker",
    rotation.recent,
    "normal",
  );
  assert.ok(chosen, "a worker profile is chosen");
  store.chargeAssignment(chosen.entry.group, chosen.profile.id, "worker");
  return chosen.profile.id;
}

function runSequence(store: Store, profiles: Profile[], pool: PoolEntry[], picks: number) {
  const tally: Record<string, number> = {};
  for (let i = 0; i < picks; i += 1) {
    const id = pickWorker(store, profiles, pool);
    tally[id] = (tally[id] ?? 0) + 1;
  }
  return tally;
}

test("a most-weighted profile with many reviewer runs is still picked ahead of a fewer-weighted worker-only profile", (t) => {
  const store = fixture(t);
  try {
    const { profiles, pool } = seed(store, [
      { id: "sol", weight: "most" },
      { id: "neon", weight: "fewer" },
    ]);
    // Sol reviewed eleven times and has never worked; Neon has one recent worker turn.
    for (let i = 0; i < 11; i += 1) store.chargeAssignment("sol", "sol", "reviewer");
    store.chargeAssignment("neon", "neon", "worker");

    assert.equal(
      store.rotationCounts("worker").recent["profile:sol"],
      undefined,
      "Sol's reviewer runs are not in the worker window",
    );
    assert.equal(
      store.rotationCounts("reviewer").recent["profile:sol"],
      11,
      "Sol's reviewer runs stay in the reviewer window",
    );
    assert.equal(
      chooseProfile(
        workerTask(),
        profiles,
        pool,
        store.rotationCounts("worker").counts,
        new Set(),
        "worker",
        store.rotationCounts("worker").recent,
        "normal",
      )?.profile.id,
      "sol",
      "Sol is picked ahead of Neon, whose one worker turn weighs more against its share",
    );
    assert.equal(
      store.counts()["profile:sol"],
      11,
      "the lifetime profile total still counts every role",
    );
    assert.equal(
      Object.keys(store.counts()).some((key) => key.startsWith("role:")),
      false,
      "role-keyed rotation rows stay out of the board's assignment totals",
    );
  } finally {
    store.close();
  }
});

test("over a 60-pick worker sequence, most against fewer converges near 200 to 75", (t) => {
  const store = fixture(t);
  try {
    const { profiles, pool } = seed(store, [
      { id: "heavy", weight: "most" },
      { id: "light", weight: "fewer" },
    ]);
    const tally = runSequence(store, profiles, pool, 60);
    // Ideal split over 60 picks is 200:75, so 43.6 and 16.4.
    assert.ok(tally.heavy >= 42 && tally.heavy <= 46, `most gets ${tally.heavy} of 60, near 43.6`);
    assert.ok(tally.light >= 14 && tally.light <= 18, `fewer gets ${tally.light} of 60, near 16.4`);
    assert.equal(tally.heavy + tally.light, 60);
  } finally {
    store.close();
  }
});

test("default-weight profiles rotate evenly", (t) => {
  const store = fixture(t);
  try {
    const { profiles, pool } = seed(store, [
      { id: "glm", weight: "default" },
      { id: "deepseek", weight: "default" },
      { id: "haiku", weight: "default" },
    ]);
    assert.deepEqual(runSequence(store, profiles, pool, 60), { glm: 20, deepseek: 20, haiku: 20 });
  } finally {
    store.close();
  }
});

test("a weight never removes a kept profile", (t) => {
  const alone = fixture(t);
  try {
    const only = seed(alone, [{ id: "fewest-only", weight: "fewest" }]);
    assert.equal(
      pickWorker(alone, only.profiles, only.pool),
      "fewest-only",
      "the only profile at the tier is picked at the fewest stop",
    );
  } finally {
    alone.close();
  }

  const set = fixture(t);
  try {
    const { profiles, pool } = seed(set, [
      { id: "most", weight: "most" },
      { id: "fewest", weight: "fewest" },
    ]);
    const tally = runSequence(set, profiles, pool, 60);
    // Ideal split is 0.5:2.5 over 60 picks, so about 12 for fewest.
    assert.ok(tally.fewest >= 9, `fewest keeps its rotation share: ${tally.fewest} of 60`);
    assert.equal(tally.most + tally.fewest, 60);
  } finally {
    set.close();
  }
});
