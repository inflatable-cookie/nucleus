import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { mergeReviewerCalibration, reviewerCalibrationFacts, telemetrySnapshot } from "../core/telemetry/telemetry";
import { runSchema, submissionSchema, taskSchema, telemetry as telemetryRpc } from "../shared/contracts";
import { disabledShadowReviewPlan, shadowReviewPlanSchema, telemetrySnapshotSchema } from "../shared/telemetry";

const start = Date.parse("2026-09-13T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const head = (seed: string) => seed.padEnd(40, "0").slice(0, 40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-reviewer-calibration-")), store = new Store(join(dir, "queue.sqlite"));
  const add = (id: string, scope: "general" | "mechanical" | "complex" = "general") => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: "/repo-a", scope, planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", "a".repeat(40));
  const replaceTask = (id: string, changes: Record<string, unknown>) => {
    const task = taskSchema.parse({ ...store.task(id), ...changes });
    store.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), id); return task;
  };
  const run = (id: string, taskId: string, extra: Record<string, unknown>) => store.putRun(runSchema.parse({
    id, taskId, role: "reviewer", generation: 1, head: head("a"), base: head("a"), agentId: null, workspaceId: "workspace",
    profileGroup: null, profile: null, status: "finished", createdAt: iso(10_000), lastObservedAt: iso(20_000),
    active: false, idleSince: iso(20_000), completion: null, released: true, ...extra,
  }));
  const event = (taskId: string, offset: number, kind: string, detail = "") =>
    store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)").run(taskId, iso(offset), kind, detail);
  return { store, add, replaceTask, run, event, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const reviewerProfile = (id: string, provider: string, model: string) => ({ id, name: id, provider, model, notes: "", available: true, problem: "", supportedThinking: [] });

test("verdicts link reviewer identity and exact head, and rounds attribute to the latest prior verdict", () => {
  const f = fixture(); try {
    const original = f.add("calibration");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(90_000), finishedAt: iso(90_000), phase: "done", reason: "Done" });
    // First reviewer blocks at head one; a semantic revision returns; a fresh reviewer approves the changed head.
    f.run("review-1", task.id, { createdAt: iso(10_000), head: head("1"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e1", taskId: task.id, runId: "review-1", status: "changes_required", summary: "Findings at the reviewed head" } });
    f.run("revision-1", task.id, { role: "revision", createdAt: iso(30_000), head: head("2"), revisionCause: "review" });
    f.run("review-2", task.id, { createdAt: iso(50_000), head: head("2"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e2", taskId: task.id, runId: "review-2", status: "ready_to_merge", summary: "Approved" } });
    const facts = reviewerCalibrationFacts(task, f.store.eventsAll(task.id), f.store.runs(task.id));
    assert.equal(facts.verdicts.length, 2);
    assert.deepEqual(facts.verdicts[0], { at: iso(10_000), runId: "review-1", head: head("1"), verdict: "changes_required", exact: true,
      reviewer: { agentId: "agent-a", profileId: "reviewer-a", profileName: "reviewer-a", provider: "provider-a", model: "model-a", profileGroup: "review-pool" } });
    assert.equal(facts.verdicts[1].verdict, "approved"); assert.equal(facts.verdicts[1].exact, true);
    assert.equal(facts.rounds.length, 1); assert.equal(facts.rounds[0].kind, "review"); assert.equal(facts.rounds[0].verdictIndex, 0);
    const merged = mergeReviewerCalibration([{ task, telemetry: {} as never, reviewer: facts }]);
    assert.equal(merged.verdicts, 2); assert.equal(merged.approved, 1); assert.equal(merged.changesRequired, 1);
    assert.equal(merged.exactVerdicts, 2); assert.equal(merged.partialVerdicts, 0); assert.equal(merged.exactApproved, 1);
    assert.equal(merged.revisionRounds, 1); assert.equal(merged.partialRevisionRounds, 0); assert.equal(merged.resolvedRounds, 1);
    assert.ok(Math.abs(merged.revisionReturnRate! - 1 / 2) < 1e-9); assert.equal(merged.resolutionRate, 1); assert.ok(Math.abs(merged.refusalRate!) < 1e-9);
    assert.deepEqual(merged.reviewers.map(row => [row.key, row.verdicts, row.revisionRounds, row.resolvedRounds]), [["reviewer-a", 2, 1, 1]]);
    assert.equal(merged.evidence, "exact");
  } finally { f.close(); }
});

test("multiple rounds, unchanged heads, pre-merge refusals and unrelated incidents stay separate signals", () => {
  const f = fixture(); try {
    const original = f.add("gates");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(120_000), finishedAt: iso(120_000), phase: "done", reason: "Done" });
    // Round one: approve at head one, repository pre-merge gate refuses the same unchanged head.
    f.run("review-1", task.id, { createdAt: iso(10_000), head: head("1"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e1", taskId: task.id, runId: "review-1", status: "ready_to_merge", summary: "Approved" } });
    f.event(task.id, 20_000, "pre_merge_refused", `gate ${head("1")}: policy refused the reviewed head`);
    f.run("revision-1", task.id, { role: "revision", createdAt: iso(25_000), head: head("2"), revisionCause: "pre_merge" });
    // Round two: a different reviewer approves the changed head; merge verifies, then one semantic and one operational incident land post-merge.
    f.run("review-2", task.id, { createdAt: iso(40_000), head: head("2"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-b", "provider-b", "model-b"), agentId: "agent-b", completion: { eventId: "e2", taskId: task.id, runId: "review-2", status: "ready_to_merge", summary: "Approved" } });
    f.event(task.id, 60_000, "merge_verified", head("2"));
    // A second semantic round later in the task's history still attributes by ordering.
    f.run("revision-2", task.id, { role: "revision", createdAt: iso(50_000), head: head("3"), revisionCause: "review" });
    f.event(task.id, 70_000, "incident", JSON.stringify({ id: "semantic-post", role: "worker", runId: null, cause: "repository_identity" }));
    // Unrelated operational incident before the merge must not join the post-merge cohort.
    f.event(task.id, 15_000, "incident", JSON.stringify({ id: "operational-pre", role: "worker", runId: "worker", cause: "provider_unavailable" }));
    f.event(task.id, 80_000, "incident", JSON.stringify({ id: "operational-post", role: "coordinator", runId: null, cause: "missing_callback" }));
    // Duplicate observations of the same post-merge identity stay one incident.
    f.event(task.id, 85_000, "incident", JSON.stringify({ id: "operational-post", role: "coordinator", runId: null, cause: "missing_callback" }));
    const snapshot = telemetrySnapshot(f.store, { window: "all", groupBy: "none" }, new Date(iso(200_000)));
    const calibration = snapshot.groups[0].reviewerCalibration;
    assert.equal(calibration.verdicts, 2); assert.equal(calibration.approved, 2); assert.equal(calibration.changesRequired, 0);
    assert.equal(calibration.exactVerdicts, 2); assert.equal(calibration.partialVerdicts, 0);
    assert.equal(calibration.revisionRounds, 2); assert.equal(calibration.partialRevisionRounds, 0);
    assert.equal(calibration.resolvedRounds, 1); // round one was re-reviewed and approved; the final approval resolved it
    assert.equal(calibration.preMergeRefusals, 1); assert.ok(Math.abs(calibration.refusalRate! - 1 / 2) < 1e-9);
    assert.equal(calibration.postMergeIncidents, 2); assert.equal(calibration.postMergeSemanticIncidents, 1); assert.equal(calibration.postMergeOperationalIncidents, 1);
    assert.deepEqual(calibration.reviewers.map(row => [row.key, row.revisionRounds, row.preMergeRefusals, row.postMergeIncidents]),
      [["reviewer-a", 1, 1, 0], ["reviewer-b", 1, 0, 2]]);
    assert.equal(calibration.evidence, "exact");
  } finally { f.close(); }
});

test("historical gaps stay partial and out of the denominators that need the missing edge", () => {
  const f = fixture(); try {
    const original = f.add("legacy");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(60_000), finishedAt: iso(60_000), phase: "done", reason: "Done" });
    // A legacy reviewer verdict without any stored reviewer profile stays partial.
    f.run("legacy-review", task.id, { createdAt: iso(10_000), head: head("1"), agentId: "legacy-agent", completion: { eventId: "e1", taskId: task.id, runId: "legacy-review", status: "ready_to_merge", summary: "Approved" } });
    // A revision round without a stored cause marker reconstructs partially and is never guessed.
    f.run("legacy-revision", task.id, { role: "revision", createdAt: iso(20_000), head: head("1") });
    const facts = reviewerCalibrationFacts(task, f.store.eventsAll(task.id), f.store.runs(task.id));
    assert.equal(facts.verdicts.length, 1); assert.equal(facts.verdicts[0].exact, false);
    assert.equal(facts.rounds.length, 1); assert.equal(facts.rounds[0].partial, true); assert.equal(facts.rounds[0].kind, "review");
    const merged = mergeReviewerCalibration([{ task, telemetry: {} as never, reviewer: facts }]);
    assert.equal(merged.verdicts, 1); assert.equal(merged.partialVerdicts, 1); assert.equal(merged.exactVerdicts, 0); assert.equal(merged.exactApproved, 0);
    assert.equal(merged.revisionRounds, 1); assert.equal(merged.partialRevisionRounds, 1);
    assert.equal(merged.revisionReturnRate, null); assert.equal(merged.refusalRate, null); assert.equal(merged.resolutionRate, null);
    // A partial verdict never joins a per-reviewer row and never feeds a rate.
    assert.deepEqual(merged.reviewers, []);
    assert.equal(merged.evidence, "partial");
  } finally { f.close(); }
});

test("two rounds under one verdict stay within one and a blocking re-review does not resolve", () => {
  const f = fixture(); try {
    const original = f.add("repeat");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(120_000), finishedAt: iso(120_000), phase: "done", reason: "Done" });
    // Regression oracle for the live overflow: one exact verdict receives two revision rounds.
    f.run("review-1", task.id, { createdAt: iso(10_000), head: head("1"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e1", taskId: task.id, runId: "review-1", status: "changes_required", summary: "Findings" } });
    f.run("revision-1", task.id, { role: "revision", createdAt: iso(20_000), head: head("2"), revisionCause: "review" });
    f.run("revision-2", task.id, { role: "revision", createdAt: iso(25_000), head: head("2"), revisionCause: "review" });
    f.run("review-2", task.id, { createdAt: iso(40_000), head: head("2"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e2", taskId: task.id, runId: "review-2", status: "ready_to_merge", summary: "Approved" } });
    // A second chain where the only re-review after the round blocks again.
    f.run("review-3", task.id, { createdAt: iso(50_000), head: head("3"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e3", taskId: task.id, runId: "review-3", status: "changes_required", summary: "More findings" } });
    f.run("revision-3", task.id, { role: "revision", createdAt: iso(60_000), head: head("4"), revisionCause: "review" });
    f.run("review-4", task.id, { createdAt: iso(70_000), head: head("4"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e4", taskId: task.id, runId: "review-4", status: "changes_required", summary: "Still blocked" } });
    f.run("review-5", task.id, { createdAt: iso(80_000), head: head("5"), profileGroup: "review-pool", profile: reviewerProfile("reviewer-a", "provider-a", "model-a"), agentId: "agent-a", completion: { eventId: "e5", taskId: task.id, runId: "review-5", status: "ready_to_merge", summary: "Approved" } });
    const facts = reviewerCalibrationFacts(task, f.store.eventsAll(task.id), f.store.runs(task.id));
    const merged = mergeReviewerCalibration([{ task, telemetry: {} as never, reviewer: facts }]);
    assert.equal(merged.exactVerdicts, 5); assert.equal(merged.revisionRounds, 3); assert.equal(merged.partialRevisionRounds, 0);
    // Distinct-verdict share: two of five exact verdicts returned rounds (one with two), never above one.
    assert.ok(Math.abs(merged.revisionReturnRate! - 2 / 5) < 1e-9);
    // Rounds one and two resolve through review-2; round three's next verdict blocks again, so the
    // later final approval does not retroactively resolve it.
    assert.equal(merged.resolvedRounds, 2); assert.ok(Math.abs(merged.resolutionRate! - 2 / 3) < 1e-9);
    assert.ok(Math.abs(merged.refusalRate!) < 1e-9);
    assert.deepEqual(merged.reviewers.map(row => [row.key, row.verdicts, row.revisionRounds, row.resolvedRounds]), [["reviewer-a", 5, 3, 2]]);
    // The strict snapshot schema survives the live-data overflow shape: many rounds under few verdicts.
    const snapshot = telemetrySnapshot(f.store, { window: "all", groupBy: "repository" }, new Date(iso(200_000)));
    const calibration = snapshot.groups[0].reviewerCalibration;
    assert.equal(calibration.revisionRounds, 3);
    assert.ok(calibration.revisionReturnRate !== null && calibration.revisionReturnRate <= 1);
    assert.ok(calibration.resolutionRate !== null && calibration.resolutionRate <= 1);
  } finally { f.close(); }
});

test("reviewer filters stay distinct from worker routing and RPC shapes stay strict", () => {
  const f = fixture(); try {
    const build = (id: string, group: string, reviewerProvider: string, workerGroup: string) => {
      const original = f.add(id), task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(60_000), finishedAt: iso(60_000), phase: "done", reason: "Done", profileGroup: workerGroup });
      f.run(`review-${id}`, task.id, { createdAt: iso(10_000), head: head(id), profileGroup: group, profile: reviewerProfile(`reviewer-${id}`, reviewerProvider, "model"), agentId: `agent-${id}`, completion: { eventId: "e", taskId: task.id, runId: `review-${id}`, status: "ready_to_merge", summary: "Approved" } });
      return task;
    };
    build("one", "review-one", "provider-one", "worker-a");
    build("two", "review-two", "provider-two", "worker-b");
    const dimensions = telemetrySnapshot(f.store, { window: "all", groupBy: "none" }, new Date(iso(200_000)));
    assert.deepEqual(dimensions.reviewerProviders, ["provider-one", "provider-two"]);
    assert.deepEqual(dimensions.reviewerProfiles, ["reviewer-one", "reviewer-two"]);
    assert.deepEqual(dimensions.reviewerProfileGroups, ["review-one", "review-two"]);
    // The worker profile-group filter still keys on worker routing only.
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", profileGroup: "worker-a" }, new Date(iso(200_000))).matchingTasks, 1);
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", reviewerProvider: "provider-two" }, new Date(iso(200_000))).matchingTasks, 1);
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", reviewerProfile: "reviewer-one" }, new Date(iso(200_000))).matchingTasks, 1);
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", reviewerProfileGroup: "review-two" }, new Date(iso(200_000))).matchingTasks, 1);
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", reviewerProvider: "provider-three" }, new Date(iso(200_000))).matchingTasks, 0);
    // A partial verdict with only an agent id is advertised and resolvable by the profile filter.
    const partial = f.add("partial-filter"), partialTask = f.replaceTask(partial.id, { createdAt: iso(0), updatedAt: iso(60_000), finishedAt: iso(60_000), phase: "done", reason: "Done" });
    f.run("review-partial-filter", partialTask.id, { createdAt: iso(10_000), head: head("p"), agentId: "agent-c", completion: { eventId: "e", taskId: partialTask.id, runId: "review-partial-filter", status: "ready_to_merge", summary: "Approved" } });
    const withPartial = telemetrySnapshot(f.store, { window: "all", groupBy: "none" }, new Date(iso(200_000)));
    assert.ok(withPartial.reviewerProfiles.includes("agent-c"));
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", reviewerProfile: "agent-c" }, new Date(iso(200_000))).matchingTasks, 1);
    assert.equal(telemetrySnapshot(f.store, { window: "all", groupBy: "none", reviewerProfile: "reviewer-one" }, new Date(iso(200_000))).matchingTasks, 1);
    assert.deepEqual(telemetryRpc.input.parse({ reviewerProvider: "provider-one", reviewerProfile: "reviewer-one", reviewerProfileGroup: "review-one" }),
      { reviewerProvider: "provider-one", reviewerProfile: "reviewer-one", reviewerProfileGroup: "review-one", window: "30d", groupBy: "none" });
    const parsed = telemetrySnapshotSchema.parse(dimensions);
    assert.deepEqual(parsed.shadowPlan, disabledShadowReviewPlan);
    assert.equal(shadowReviewPlanSchema.parse(disabledShadowReviewPlan).enabled, false);
    assert.equal(disabledShadowReviewPlan.eligibility, "deferred_to_operator_authorization");
    assert.equal(shadowReviewPlanSchema.parse(disabledShadowReviewPlan).startsAt, null);
    assert.doesNotThrow(() => telemetrySnapshotSchema.parse({ ...dimensions, shadowPlan: shadowReviewPlanSchema.parse({ ...disabledShadowReviewPlan }) }));
  } finally { f.close(); }
});
