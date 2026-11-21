import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { enginePorts } from "../core/port-context";
import { SweepMaintenance } from "../core/scheduling/sweep-maintenance";
import type { Adapter } from "../core/host";
import { createTelemetrySnapshotCache, telemetrySnapshot } from "../core/telemetry/telemetry";
import { runSchema, submissionSchema, taskSchema } from "../shared/contracts";
import {
  retainedTaskTelemetrySchema, telemetryScreenWindows, telemetrySnapshotSchema,
  type TelemetrySnapshot,
} from "../shared/telemetry";

/**
 * Task 1496: compact telemetry outlives the 4-day detailed purge for a rolling 90-day
 * cohort window. A purge never changes what the aggregate reports at a fixed query time.
 */
const DAY = 86_400_000, HOUR = 3_600_000, MINUTE = 60_000;
const start = Date.parse("2026-09-13T10:00:00.000Z");
const iso = (offset: number) => new Date(start + offset).toISOString();
const queryAt = start + 10 * DAY;
const head = (seed: string) => seed.padEnd(40, "0").slice(0, 40);
const profile = (id: string, provider: string) => ({ id, name: id, provider, model: `${provider}-model`, notes: "", available: true, problem: "", supportedThinking: [] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-telemetry-retention-")), path = join(dir, "queue.sqlite");
  let store = new Store(path);
  const add = (id: string, repoPath = "/repo-a", scope: "general" | "mechanical" | "complex" = "general") => store.insert(submissionSchema.parse({
    submissionId: id, title: `SECRET-TITLE ${id}`, repoPath, scope, planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin-SECRET",
  }), "host", `SECRET-BRIEF ${id}`, "a".repeat(40));
  const replaceTask = (id: string, changes: Record<string, unknown>) => {
    const task = taskSchema.parse({ ...store.task(id), ...changes });
    store.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), id);
    return task;
  };
  const finish = (id: string, created: number, finished: number | null, phase: string, extra: Record<string, unknown> = {}) =>
    replaceTask(id, { createdAt: iso(created), updatedAt: iso(finished ?? created), finishedAt: finished === null ? null : iso(finished), phase, reason: phase, ...extra });
  // Settled history as retention finds it: the run rows are written directly, so no live
  // release side effect (runtime retirement, credential) is pending on the fixture task.
  const run = (id: string, taskId: string, extra: Record<string, unknown>) => store.db.prepare("INSERT INTO runs VALUES(?,?,?)").run(id, taskId, JSON.stringify(runSchema.parse({
    id, taskId, role: "reviewer", generation: 1, head: head("c0ffee"), base: head("a"), agentId: null, workspaceId: "workspace-SECRET",
    profileGroup: null, profile: null, status: "finished", createdAt: iso(0), lastObservedAt: iso(0),
    active: false, idleSince: iso(0), completion: null, released: true, ...extra,
  })));
  const events = (taskId: string, rows: [number, string, string][]) => {
    store.db.prepare("DELETE FROM events WHERE taskId=?").run(taskId);
    for (const [offset, kind, detail] of rows) store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)").run(taskId, iso(offset), kind, detail);
  };
  const notice = (id: string, taskId: string) => store.db.prepare("INSERT INTO notices VALUES(?,?,?)")
    .run(id, taskId, JSON.stringify({ id, taskId, agentId: "agent-SECRET-origin", text: "SECRET-NOTICE body", status: "delivered", error: "", kind: "attention" }));
  return {
    get store() { return store; }, add, replaceTask, finish, run, events, notice, path,
    reopen() { store.close(); store = new Store(path); },
    records() { return (store.db.prepare("SELECT taskId,data FROM task_telemetry_retained ORDER BY taskId").all() as { taskId: string; data: string }[]); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;

/**
 * Mixed history: three settled tasks old enough to purge (exact, partial reconstruction,
 * reviewer and recovery evidence, usage), a recent finished task, an unfinished task, a
 * removed task and a gated task that the purge must keep.
 */
function populate(f: Fixture) {
  const a = f.add("alpha"), b = f.add("beta", "/repo-b", "mechanical"), c = f.add("gamma", "/repo-a", "complex");
  const recent = f.add("recent"), open = f.add("open", "/repo-b"), removed = f.add("removed"), gated = f.add("gated");
  f.finish(a.id, 0, HOUR, "done", { complexity: "high", profileGroup: "worker-pool", profile: profile("worker-w", "provider-w") });
  f.events(a.id, [[0, "telemetry_stage", "capacity_wait"], [5 * MINUTE, "telemetry_stage", "worker_active"], [20 * MINUTE, "telemetry_stage", "review_wait"],
    [25 * MINUTE, "telemetry_stage", "review"], [40 * MINUTE, "telemetry_stage", "merge"], [45 * MINUTE, "merge_verified", "SECRET-EVENT merged"],
    [50 * MINUTE, "incident", JSON.stringify({ id: "incident-SECRET-1", role: "reviewer", runId: "run-SECRET-review-1", cause: "provider_unavailable" })],
    [52 * MINUTE, "operator_control", "hold"], [HOUR, "telemetry_stage", "complete"]]);
  f.run("run-SECRET-worker-1", a.id, { role: "verification", createdAt: iso(5 * MINUTE), profileGroup: "worker-pool", profile: profile("worker-w", "provider-w"), agentId: "agent-SECRET-worker",
    usage: { turns: 4, reportedTurns: 4, inputTokens: 1000, cachedInputTokens: 500, outputTokens: 300, wallMs: 90_000, peakContextTokens: null, lastTurnId: null, openTurnId: null, openTurnAt: null, partial: false } });
  f.run("run-SECRET-review-1", a.id, { createdAt: iso(25 * MINUTE), profileGroup: "review-pool", profile: profile("reviewer-a", "provider-r"), agentId: "agent-SECRET-a",
    completion: { eventId: "e1", taskId: a.id, runId: "run-SECRET-review-1", status: "changes_required", summary: "SECRET-SUMMARY findings" } });
  f.run("run-SECRET-revision-1", a.id, { role: "revision", createdAt: iso(30 * MINUTE), revisionCause: "review" });
  f.run("run-SECRET-review-2", a.id, { createdAt: iso(35 * MINUTE), profileGroup: "review-pool", profile: profile("reviewer-a", "provider-r"), agentId: "agent-SECRET-a",
    completion: { eventId: "e2", taskId: a.id, runId: "run-SECRET-review-2", status: "ready_to_merge", summary: "SECRET-SUMMARY approved" } });
  f.run("run-SECRET-recovery-1", a.id, { role: "recovery", createdAt: iso(48 * MINUTE),
    completion: { eventId: "e3", taskId: a.id, runId: "run-SECRET-recovery-1", status: "escalate", summary: "SECRET-SUMMARY MonthlyLimit provider credit exhausted" } });
  f.notice("notice-SECRET-1", a.id);
  // Legacy history without stage instrumentation: reconstructed and partial.
  f.finish(b.id, 2 * HOUR, 3 * HOUR, "cancelled", { complexity: "low" });
  f.events(b.id, [[2 * HOUR, "submitted", "SECRET-EVENT origin"], [3 * HOUR, "cancel", "SECRET-EVENT cancelled"]]);
  f.finish(c.id, DAY, DAY + 2 * HOUR, "done", { complexity: "high", profileGroup: "worker-pool" });
  f.events(c.id, [[DAY, "telemetry_stage", "capacity_wait"], [DAY + 30 * MINUTE, "telemetry_stage", "worker_active"], [DAY + 2 * HOUR, "telemetry_stage", "complete"]]);
  f.run("run-SECRET-worker-3", c.id, { role: "verification", createdAt: iso(DAY + 30 * MINUTE),
    usage: { turns: 2, reportedTurns: 2, inputTokens: 4000, cachedInputTokens: 0, outputTokens: 900, wallMs: 40_000, peakContextTokens: null, lastTurnId: null, openTurnId: null, openTurnAt: null, partial: false } });
  f.finish(recent.id, 7 * DAY, 7 * DAY + HOUR, "done");
  f.events(recent.id, [[7 * DAY, "telemetry_stage", "capacity_wait"], [7 * DAY + HOUR, "telemetry_stage", "complete"]]);
  f.finish(open.id, 9 * DAY + 12 * HOUR, null, "working");
  f.events(open.id, [[9 * DAY + 12 * HOUR, "telemetry_stage", "worker_active"]]);
  f.finish(removed.id, 3 * HOUR, 4 * HOUR, "done", { removedAt: iso(4 * HOUR) });
  f.finish(gated.id, 4 * HOUR, 5 * HOUR, "done");
  f.events(gated.id, [[4 * HOUR, "telemetry_stage", "capacity_wait"], [5 * HOUR, "telemetry_stage", "complete"]]);
  f.run("run-SECRET-gated", gated.id, { role: "verification", createdAt: iso(4 * HOUR), released: false, status: "running" });
  return { a, b, c, recent, open, removed, gated };
}

const FILTERS = [
  { window: "24h" }, { window: "7d", groupBy: "profile_group" }, { window: "30d" }, { window: "90d", groupBy: "repository" },
  { window: "all", groupBy: "scope" }, { window: "30d", groupBy: "closeout_authority" }, { window: "30d", repoPath: "/repo-a" },
  { window: "30d", scope: "mechanical" }, { window: "30d", profileGroup: "worker-pool" }, { window: "30d", reviewerProvider: "provider-r" },
  { window: "30d", reviewerProfile: "reviewer-a" }, { window: "30d", reviewerProfileGroup: "review-pool" },
  { window: "30d", interventionRole: "reviewer" }, { window: "30d", interventionProvider: "provider-w" },
  // Inclusive cohort boundary exactly at beta's creation time.
  { window: "30d", createdAfter: iso(2 * HOUR) },
] as const;

/** Every reported metric except the coverage source split and the agent identity a record never keeps. */
function comparable(snapshot: TelemetrySnapshot) {
  const { coverage: _coverage, ...rest } = snapshot;
  return JSON.parse(JSON.stringify({ ...rest, groups: rest.groups.map(group => ({ ...group,
    reviewerCalibration: { ...group.reviewerCalibration, reviewers: group.reviewerCalibration.reviewers.map(row => ({ ...row, agentId: null })) } })) }));
}
const snapshots = (store: Store) => FILTERS.map(filter => telemetrySnapshot(store, filter, new Date(queryAt)));

test("a real purge reports the same filtered metrics at a fixed query time, through batches, reopen and replay", () => {
  const f = fixture(); try {
    const ids = populate(f);
    const before = snapshots(f.store);
    // The scenario actually exercises the measured surfaces.
    const all = before[2];
    assert.equal(all.matchingTasks, 6);
    assert.equal(all.groups[0].reviewerCalibration.verdicts, 2);
    assert.equal(all.groups[0].interventions.recoveryRuns, 1);
    assert.ok(all.groups[0].total.partialCount >= 1, "partial reconstruction is part of the cohort");
    assert.ok(all.usageByComplexity.some(row => row.effectiveTokens.count === 2));
    assert.equal(before[14].matchingTasks, 5, "createdAfter is inclusive");
    assert.equal(all.coverage.retainedTasks, 0);

    const purged = f.store.purgeOldTasks(queryAt, undefined, { batch: 1 });
    assert.equal(f.store.getMeta("telemetryCaptureError"), "");
    assert.deepEqual(new Set(purged), new Set([ids.a.id, ids.b.id, ids.c.id, ids.removed.id]));
    assert.equal(f.store.task(ids.gated.id).phase, "done", "a gated task keeps its history");
    assert.deepEqual(f.records().map(row => row.taskId).sort(), [ids.a.id, ids.b.id, ids.c.id].sort(), "the removed task never contributed and carries no record");
    const after = snapshots(f.store);
    for (let index = 0; index < FILTERS.length; index++)
      assert.deepEqual(comparable(after[index]), comparable(before[index]), `filter ${JSON.stringify(FILTERS[index])}`);
    assert.equal(after[2].coverage.retainedTasks, 3);
    assert.equal(after[2].coverage.liveTasks, 3);
    assert.equal(after[2].coverage.liveTasks + after[2].coverage.retainedTasks, after[2].matchingTasks);
    for (const snapshot of after) assert.doesNotThrow(() => telemetrySnapshotSchema.parse(snapshot));

    // Reopen and replay: the pass converges without duplicate samples.
    f.reopen();
    const records = f.records();
    assert.deepEqual(f.store.purgeOldTasks(queryAt), []);
    assert.deepEqual(f.records(), records);
    const replayed = snapshots(f.store);
    for (let index = 0; index < FILTERS.length; index++) assert.deepEqual(comparable(replayed[index]), comparable(before[index]));
  } finally { f.close(); }
});

test("an interrupted pass commits capture and deletion together and the next pass converges", () => {
  const f = fixture(); try {
    const ids = populate(f);
    const before = snapshots(f.store);
    let calls = 0;
    assert.throws(() => f.store.purgeOldTasks(queryAt, () => { if (++calls === 2) throw new Error("interrupted"); }, { batch: 1 }), /interrupted/);
    // The first batch committed both; the interrupted batch committed neither.
    assert.equal(f.records().length, 1);
    assert.throws(() => f.store.task(ids.a.id), /purged/);
    assert.equal(f.store.task(ids.b.id).phase, "cancelled");
    for (let index = 0; index < FILTERS.length; index++) assert.deepEqual(comparable(snapshots(f.store)[index]), comparable(before[index]));
    f.store.purgeOldTasks(queryAt, undefined, { batch: 2 });
    assert.equal(f.records().length, 3);
    for (let index = 0; index < FILTERS.length; index++) assert.deepEqual(comparable(snapshots(f.store)[index]), comparable(before[index]));
  } finally { f.close(); }
});

test("a capture fault keeps the task's history and surfaces in retention health", async t => {
  const store = new Store(":memory:");
  const engine = new Engine(store, {} as Adapter, 60_000);
  t.after(async () => { await engine.stop(); store.close(); });
  store.setMeta("paused", false);
  (engine as unknown as Record<string, unknown>).migrateProjectOwnersToPlanners = async () => {};
  (engine as unknown as Record<string, unknown>).removeSiblings = async () => {};
  const maintenance = new SweepMaintenance(enginePorts(engine,
    ["adapter", "hostAvailable", "hostIds", "migrateProjectOwnersToPlanners", "removeSiblings", "stopped", "store", "withHost"], []));
  const task = store.insert(submissionSchema.parse({ submissionId: "fault", title: "fault", repoPath: "/repo-a", scope: "general", planningCommit: "a".repeat(40), handoffPath: "h.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40));
  const finished = taskSchema.parse({ ...store.task(task.id), phase: "done", reason: "Done", createdAt: iso(0), updatedAt: iso(HOUR), finishedAt: iso(HOUR) });
  store.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(finished), task.id);
  const outcomes = (store as unknown as { outcomesStore: { telemetryFactsForTask: (id: string) => unknown } }).outcomesStore;
  const original = outcomes.telemetryFactsForTask.bind(outcomes);
  outcomes.telemetryFactsForTask = () => { throw new Error("capture unavailable"); };
  await maintenance.run(queryAt);
  assert.equal(store.task(task.id).phase, "done", "history is never deleted unsummarized");
  assert.match(store.getMeta<string>("retentionError") ?? "", /Telemetry capture failed for 1 finished task; their history is kept/);
  // The fault clears with the next successful pass, and the history then purges with its record.
  outcomes.telemetryFactsForTask = original;
  await maintenance.run(queryAt + DAY);
  assert.throws(() => store.task(task.id), /purged/);
  assert.equal(store.getMeta<string>("retentionError"), "");
  assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM task_telemetry_retained").get()!.n), 1);
});

test("retained records expire outside the 90-day cohort window without touching detailed retention", () => {
  const f = fixture(); try {
    const ids = populate(f);
    f.store.purgeOldTasks(queryAt);
    assert.equal(f.records().length, 3);
    // Alpha and beta were created on day 0, gamma on day 1.
    assert.equal(f.store.expireRetainedTelemetry(start + 90 * DAY), 0, "day 90 still holds the day-0 cohort");
    assert.equal(f.store.expireRetainedTelemetry(start + 90 * DAY + 3 * HOUR, 1), 2, "bounded batches drain the expired cohort");
    assert.deepEqual(f.records().map(row => row.taskId), [ids.c.id]);
    assert.ok(f.store.taskReference(ids.a.id).purgedAt, "the tombstone is untouched");
    const at = new Date(start + 90 * DAY + 3 * HOUR);
    const wide = telemetrySnapshot(f.store, { window: "90d" }, at);
    assert.equal(wide.coverage.retainedTasks, 1);
    assert.equal(wide.coverage.partial, false, "the 90-day window is complete once compact capture predates it");
  } finally { f.close(); }
});

test("coverage labels windows wider than retained history as partial and never invents it", () => {
  const f = fixture(); try {
    populate(f);
    // A fresh store that never purged is complete for every window, including the RPC-only `all`.
    const fresh = telemetrySnapshot(f.store, { window: "all" }, new Date(queryAt));
    assert.equal(fresh.coverage.partial, false);
    assert.equal(fresh.coverage.completeFrom, null);
    assert.equal(fresh.coverage.windowStart, null);
    // A legacy pass purged history without records: coverage starts 4 days before it.
    const legacyPass = start + 6 * DAY;
    f.store.setMeta("lastRetentionAt", legacyPass);
    const rollout = (filter: Record<string, unknown>) => telemetrySnapshot(f.store, filter, new Date(queryAt)).coverage;
    assert.equal(rollout({ window: "7d" }).completeFrom, new Date(legacyPass - 4 * DAY).toISOString());
    assert.equal(rollout({ window: "7d" }).partial, false);
    assert.equal(rollout({ window: "30d" }).partial, true);
    assert.equal(rollout({ window: "90d" }).partial, true);
    assert.equal(rollout({ window: "30d", createdAfter: iso(5 * DAY) }).partial, false, "a cohort boundary inside coverage is complete");
    assert.equal(rollout({ window: "30d" }).controlsPartial, false);
    assert.equal(rollout({ window: "90d" }).controlsPartial, true, "the task-control series stays 30 days");
    assert.equal(rollout({ window: "90d" }).controlsWindowDays, 30);
    // The first capturing pass fixes the marker; later passes never move coverage earlier or later.
    f.store.purgeOldTasks(queryAt);
    assert.equal(f.store.retainedTelemetryCoverage().coverageFrom, new Date(legacyPass - 4 * DAY).toISOString());
    f.store.purgeOldTasks(queryAt + DAY);
    assert.equal(f.store.retainedTelemetryCoverage().coverageFrom, new Date(legacyPass - 4 * DAY).toISOString());
    // Without a legacy pass, coverage is complete but `all` reaches past the 90-day window.
    const g = fixture(); try {
      g.store.purgeOldTasks(queryAt);
      assert.deepEqual(g.store.retainedTelemetryCoverage(), { coverageFrom: null, active: true });
      assert.equal(telemetrySnapshot(g.store, { window: "90d" }, new Date(queryAt)).coverage.partial, false);
      assert.equal(telemetrySnapshot(g.store, { window: "all" }, new Date(queryAt)).coverage.partial, true);
    } finally { g.close(); }
  } finally { f.close(); }
});

test("seeding captures still-present finished history in bounded passes without double counting", () => {
  const f = fixture(); try {
    const ids = populate(f);
    const before = snapshots(f.store);
    const first = f.store.seedRetainedTelemetry(queryAt, 2);
    assert.equal(first.seeded, 2);
    f.store.seedRetainedTelemetry(queryAt, 2);
    f.store.seedRetainedTelemetry(queryAt, 2);
    f.store.seedRetainedTelemetry(queryAt, 2);
    // Every finished, non-removed task with a finish time is seeded; the removed and unfinished are not.
    const seeded = f.records().map(row => row.taskId).sort();
    assert.deepEqual(seeded, [ids.a.id, ids.b.id, ids.c.id, ids.recent.id, ids.gated.id].sort());
    const during = snapshots(f.store);
    for (let index = 0; index < FILTERS.length; index++) assert.deepEqual(comparable(during[index]), comparable(before[index]));
    assert.equal(during[2].coverage.retainedTasks, 0, "a seeded task with detailed history contributes once, live");
    // A seeded task that is later removed loses its record when it purges.
    f.replaceTask(ids.recent.id, { removedAt: iso(7 * DAY + 2 * HOUR), finishedAt: iso(7 * DAY + 2 * HOUR) });
    f.store.purgeOldTasks(queryAt + 5 * DAY);
    assert.ok(!f.records().some(row => row.taskId === ids.recent.id));
  } finally { f.close(); }
});

test("retained records carry no source text, identities or credentials", () => {
  const f = fixture(); try {
    populate(f);
    f.store.purgeOldTasks(queryAt);
    const rows = f.records();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.doesNotThrow(() => retainedTaskTelemetrySchema.parse(JSON.parse(row.data)));
      assert.doesNotMatch(row.data, /SECRET/, "titles, briefs, summaries, events, notices, run, agent and workspace identities stay out");
      assert.doesNotMatch(row.data, new RegExp(head("c0ffee")), "commit identities stay out");
      assert.doesNotMatch(row.data, /handoff|agentId|workspaceId|runId|credential/i);
    }
  } finally { f.close(); }
});

test("reviewer attribution that needs an agent identity becomes unavailable with honest denominators", () => {
  const f = fixture(); try {
    const task = f.add("legacy-review");
    f.finish(task.id, 0, HOUR, "done");
    f.events(task.id, [[0, "telemetry_stage", "review"], [HOUR, "telemetry_stage", "complete"]]);
    f.run("run-SECRET-legacy", task.id, { createdAt: iso(10 * MINUTE), agentId: "agent-SECRET-legacy",
      completion: { eventId: "e9", taskId: task.id, runId: "run-SECRET-legacy", status: "ready_to_merge", summary: "approved" } });
    const before = telemetrySnapshot(f.store, { window: "30d" }, new Date(queryAt));
    assert.deepEqual(before.reviewerProfiles, ["agent-SECRET-legacy"]);
    f.store.purgeOldTasks(queryAt);
    const after = telemetrySnapshot(f.store, { window: "30d" }, new Date(queryAt));
    assert.deepEqual(after.reviewerProfiles, ["Unattributed reviewer"]);
    assert.equal(after.coverage.reviewerAttributionUnavailable, 1);
    const [beforeGroup, afterGroup] = [before.groups[0].reviewerCalibration, after.groups[0].reviewerCalibration];
    assert.equal(afterGroup.verdicts, beforeGroup.verdicts);
    assert.equal(afterGroup.partialVerdicts, beforeGroup.partialVerdicts);
    assert.equal(afterGroup.exactVerdicts, 0);
    assert.equal(afterGroup.revisionReturnRate, null, "a partial verdict never joins a rate denominator");
    assert.equal(telemetrySnapshot(f.store, { window: "30d", reviewerProfile: "agent-SECRET-legacy" }, new Date(queryAt)).matchingTasks, 0);
  } finally { f.close(); }
});

test("the cached base reads retained records once per revision and rebuilds after a purge", async () => {
  const f = fixture(); try {
    populate(f);
    let clock = queryAt;
    const cached = createTelemetrySnapshotCache(f.store, { now: () => clock, maxAgeMs: 60_000 });
    const before = await cached({ window: "30d" });
    f.store.purgeOldTasks(queryAt);
    clock += 1;
    const after = await cached({ window: "30d" });
    assert.notEqual(after.generatedAt, before.generatedAt, "a purge advances the telemetry revision");
    assert.equal(after.coverage.retainedTasks, 3);
    assert.equal(after.matchingTasks, before.matchingTasks);
  } finally { f.close(); }
});

test("the Telemetry screen offers 24h, 7d, 30d and 90d and retires All", () => {
  assert.deepEqual([...telemetryScreenWindows], ["24h", "7d", "30d", "90d"]);
  const ui = readFileSync(new URL("../client/settings-telemetry.tsx", import.meta.url), "utf8");
  assert.match(ui, /telemetryScreenWindows\.map\(value=>/);
  assert.doesNotMatch(ui, /"90d","all"/);
  assert.match(ui, /accessibilityLabel="Telemetry coverage"/);
});
