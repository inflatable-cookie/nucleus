import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { taskControlTelemetry } from "../core/telemetry/telemetry";
import { submissionSchema } from "../shared/contracts";
import { telemetrySnapshotSchema } from "../shared/telemetry";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-control-telemetry-")), path = join(dir, "queue.sqlite");
  let store = new Store(path);
  const add = (id: string, repoPath: string) => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath, planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", "a".repeat(40));
  const reopen = () => { store.close(); store = new Store(path); return store; };
  return { get store() { return store; }, add, reopen, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a stray legacy refusal table on an admitted store is never folded, read or dropped (round 4; the pre-schema-49 fold retired by PR #747's schema floor)", () => {
  const f = fixture(); try {
    f.store.db.exec("CREATE TABLE verb_refusals(id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL)");
    const at = new Date().toISOString();
    f.store.db.prepare("INSERT INTO verb_refusals(taskId,at,action,detail) VALUES(?,?,?,?)").run("t1", at, "stop", JSON.stringify({ caller: "owner-1", coordinatorRun: null, reason: "Owner refusal" }));
    f.store.db.prepare("INSERT INTO verb_refusals(taskId,at,action,detail) VALUES(?,?,?,?)").run("t2", at, "move", JSON.stringify({ caller: null, coordinatorRun: "run-9", reason: "Coordinator refusal" }));
    const store = f.reopen();
    // PR #747 replaced the stepwise migrations with native schema admission: a store old enough to carry verb_refusals refuses at the schema floor ("use an older build"), so no admitted store can ever hit the fold. Admission is additive — an unknown table is left in place, unread, on every reopen.
    assert.deepEqual(store.verbOutcomes("1970-01-01T00:00:00.000Z"), [], "legacy refusal rows never reach verb_outcomes");
    f.reopen();
    assert.ok(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verb_refusals'").get(), "additive admission never drops a table it does not know");
    assert.equal(f.store.verbOutcomes("1970-01-01T00:00:00.000Z").length, 0, "no fold ever runs, on any reopen");
  } finally { f.close(); }
});

test("task control telemetry separates owner and coordinator rates, groups masked reasons and honours window and repository (round 4)", () => {
  const f = fixture(); try {
    const a = f.add("a", "/repo-a"), b = f.add("b", "/repo-b");
    const { store } = f;
    store.recordVerbOutcome(a.id, "restart", "applied", "owner", { caller: "o" });
    store.recordVerbOutcome(a.id, "move", "refused", "owner", { caller: "o", reason: "Task changed at version 12 (run 3f2a9c1d-1111-2222-3333-444455556666)" });
    store.recordVerbOutcome(b.id, "move", "refused", "owner", { caller: "o", reason: "Task changed at version 13 (run 9e8d7c6b-1111-2222-3333-444455556666)" });
    for (let index = 0; index < 9; index++) store.recordVerbOutcome(b.id, "move", "applied", "coordinator", { coordinatorRun: `r${index}` });
    store.recordVerbOutcome(b.id, "route", "refused", "coordinator", { coordinatorRun: "r9", reason: "A coordinator route never names a very_high-cost profile" });
    // An outcome older than the window is not counted.
    store.db.prepare("UPDATE verb_outcomes SET at=? WHERE action='restart'").run(new Date(Date.now() - 2 * 86_400_000).toISOString());

    const day = taskControlTelemetry(store, { window: "24h" });
    assert.equal(day.windowDays, 1);
    assert.deepEqual(day.owner, { applied: 0, refused: 2, refusalRate: 1 });
    assert.deepEqual(day.coordinator, { applied: 9, refused: 1, refusalRate: 0.1 });
    assert.deepEqual(day.topRefusals[0], { source: "owner", action: "move", reason: "Task changed at version # (run …)", count: 2 }, "identities and numbers are masked so one cause groups");
    assert.deepEqual(day.byAction.find(item => item.source === "coordinator" && item.action === "move"), { source: "coordinator", action: "move", applied: 9, refused: 0 });

    const all = taskControlTelemetry(store, { window: "all" });
    assert.equal(all.windowDays, 30, "every window is capped at the 30-day retention");
    assert.deepEqual(all.owner, { applied: 1, refused: 2, refusalRate: 2 / 3 });

    const repoA = taskControlTelemetry(store, { window: "7d", repoPath: "/repo-a" });
    assert.deepEqual(repoA.owner, { applied: 1, refused: 1, refusalRate: 0.5 });
    assert.deepEqual(repoA.coordinator, { applied: 0, refused: 0, refusalRate: null });
    assert.ok(telemetrySnapshotSchema.shape.controls.parse(repoA));
  } finally { f.close(); }
});

test("an outcome older than 30 days is pruned on the next write (round 4)", () => {
  const f = fixture(); try {
    f.store.recordVerbOutcome("t", "stop", "applied", "owner", {});
    f.store.db.prepare("UPDATE verb_outcomes SET at=?").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    f.store.recordVerbOutcome("t", "move", "applied", "owner", {});
    assert.deepEqual(f.store.verbOutcomes("1970-01-01T00:00:00.000Z").map(row => row.action), ["move"]);
  } finally { f.close(); }
});

test("a keyed outcome is recorded once, so an operation replay or a second settlement path never counts twice (review #537)", () => {
  const f = fixture(); try {
    f.store.recordVerbOutcome("t", "complete", "applied", "owner", {}, "operation:op-1");
    f.store.recordVerbOutcome("t", "complete", "applied", "owner", {}, "operation:op-1");
    f.store.recordVerbOutcome("t", "restart", "refused", "coordinator", { reason: "generation changed" }, "coordinator:event-1");
    f.store.recordVerbOutcome("t", "restart", "refused", "coordinator", { reason: "moved on" }, "coordinator:event-1");
    f.store.recordVerbOutcome("t", "stop", "applied", "owner", {});
    f.store.recordVerbOutcome("t", "stop", "applied", "owner", {});
    assert.deepEqual(f.store.verbOutcomes("1970-01-01T00:00:00.000Z").map(row => [row.action, row.detail.reason ?? null]),
      [["complete", null], ["restart", "generation changed"], ["stop", null], ["stop", null]], "unkeyed calls are separate controls");
  } finally { f.close(); }
});
