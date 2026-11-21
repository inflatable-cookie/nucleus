import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";

// nucleus#1502: role-tagged assignment history for the Profiles usage view. Each role
// keeps its own bounded window; the All window and routing stay on the shared history.

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "queue-role-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "queue.sqlite");
}

test("heavy worker traffic does not evict coordinator or reviewer samples", (t) => {
  const path = fixture(t);
  const store = new Store(path);
  try {
    store.chargeAssignment("codex", "coord", "coordinator");
    store.chargeAssignment("codex", "rev", "reviewer");
    for (let i = 0; i < 120; i += 1)
      store.chargeAssignment("codex", "work", "worker");

    assert.deepEqual(
      store.recentRoleUsage("coordinator"),
      {
        counts: { "profile:coord": 1 },
        sample: 1,
      },
      "one coordinator charge stays in its own window",
    );
    assert.deepEqual(
      store.recentRoleUsage("reviewer"),
      {
        counts: { "profile:rev": 1 },
        sample: 1,
      },
      "one reviewer charge stays in its own window",
    );
    assert.deepEqual(
      store.recentRoleUsage("worker"),
      {
        counts: { "profile:work": 50 },
        sample: 50,
        // the worker window holds only the newest 50 worker charges
      },
      "the worker window is bounded at 50",
    );
    assert.equal(
      store.recentSample(),
      50,
      "the All window stays at its shared 50",
    );
  } finally {
    store.close();
  }
});

test("each role window is bounded at its own 50 charges", (t) => {
  const path = fixture(t);
  const store = new Store(path);
  try {
    for (let i = 0; i < 60; i += 1)
      store.chargeAssignment("codex", "rev", "reviewer");
    assert.equal(store.recentRoleUsage("reviewer").sample, 50);
    assert.equal(store.recentRoleUsage("worker").sample, 0);
  } finally {
    store.close();
  }
});

test("untagged history still counts in All and never reaches a role window", (t) => {
  const path = fixture(t);
  const store = new Store(path);
  try {
    store.chargeAssignment("codex", "old");
    store.chargeAssignment("codex", "old");
    store.chargeAssignment("codex", "new", "worker");

    assert.equal(
      store.recentCounts()["profile:old"],
      2,
      "untagged rows count in All",
    );
    assert.equal(store.recentCounts()["profile:new"], 1);
    assert.equal(
      store.recentSample(),
      3,
      "All sample is the real size while history is short",
    );
    assert.deepEqual(
      store.recentRoleUsage("worker"),
      {
        counts: { "profile:new": 1 },
        sample: 1,
      },
      "the role window starts with newly tagged rows only",
    );
    assert.deepEqual(store.recentRoleUsage("reviewer"), {
      counts: {},
      sample: 0,
    });
  } finally {
    store.close();
  }
});

test("one charge stays one assignment: group and profile totals move once", (t) => {
  const path = fixture(t);
  const store = new Store(path);
  try {
    store.chargeAssignment("codex", "a", "worker");
    store.chargeAssignment("codex", "a");
    assert.equal(
      store.counts()["profile:a"],
      2,
      "totals count each charge once",
    );
    assert.equal(store.counts()["codex"], 2);
    assert.equal(
      store.recentRoleUsage("worker").sample,
      1,
      "the tagged charge is the only worker row",
    );
  } finally {
    store.close();
  }
});

test("role history survives a restart", (t) => {
  const path = fixture(t);
  const first = new Store(path);
  first.chargeAssignment("codex", "coord", "coordinator");
  first.chargeAssignment("codex", "work", "worker");
  first.close();

  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.recentRoleUsage("coordinator"), {
      counts: { "profile:coord": 1 },
      sample: 1,
    });
    assert.equal(reopened.recentRoleUsage("worker").sample, 1);
    assert.equal(reopened.recentSample(), 2);
  } finally {
    reopened.close();
  }
});

test("an empty history reads as an empty window for every role", (t) => {
  const path = fixture(t);
  const store = new Store(path);
  try {
    assert.equal(store.recentSample(), 0);
    for (const role of ["worker", "reviewer", "coordinator"] as const)
      assert.deepEqual(store.recentRoleUsage(role), { counts: {}, sample: 0 });
  } finally {
    store.close();
  }
});
