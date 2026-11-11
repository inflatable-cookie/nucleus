import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { createTelemetrySnapshotCache, deriveTaskTelemetry, normalizeTelemetryCause, telemetrySnapshot } from "../core/telemetry/telemetry";
import { detail as detailRpc, runSchema, submissionSchema, taskSchema, telemetry as telemetryRpc } from "../shared/contracts";
import { hookRecordSchema } from "../shared/hooks";
import { compactTelemetrySummary, formatTelemetryDuration, headlineFacts, taskTelemetrySchema, telemetryHeadlineSchema, telemetrySnapshotSchema } from "../shared/telemetry";

const start = Date.parse("2026-09-13T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-telemetry-")), store = new Store(join(dir, "queue.sqlite"));
  const add = (id: string, repoPath = "/repo-a", scope: "general" | "mechanical" | "complex" = "general") => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath, scope, planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", "a".repeat(40));
  const replaceTask = (id: string, changes: Record<string, unknown>) => {
    const task = taskSchema.parse({ ...store.task(id), ...changes });
    store.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), id); return task;
  };
  const setEvents = (id: string, rows: Array<[number, string, string?]>) => {
    store.db.prepare("DELETE FROM events WHERE taskId=?").run(id);
    for (const [offset, kind, detail = ""] of rows) store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)").run(id, iso(offset), kind, detail);
  };
  return { store, add, replaceTask, setEvents, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("telemetry bounds historical group and filter rows while retaining exact aggregates", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 120; i++) {
      const task = f.add(`history-${i}`, `/repo-${i}`);
      f.store.update(task.id, { phase: "done" });
    }
    const grouped = telemetrySnapshot(f.store, { window: "all", groupBy: "repository" });
    assert.equal(grouped.matchingTasks, 120);
    assert.equal(grouped.groups.length, 100);
    assert.equal(grouped.omittedGroups, 20);
    assert.equal(grouped.repositories.length, 100);
    assert.ok(grouped.truncatedDimensions.includes("repositories"));
    const full = telemetrySnapshot(f.store, { window: "all", groupBy: "none" });
    assert.equal(full.groups[0].completedCount, 120);
    const exact = telemetrySnapshot(f.store, { window: "all", repoPath: "/repo-119", groupBy: "repository" });
    assert.equal(exact.groups[0].completedCount, 1);
    assert.equal(exact.omittedGroups, 0);
  } finally { f.close(); }
});

test("exact stage events separate waiting, active work and current age", () => {
  const f = fixture(); try {
    const original = f.add("exact");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(130_000), finishedAt: iso(130_000), phase: "done", reason: "Done" });
    f.setEvents(task.id, [
      [0, "telemetry_stage", "capacity_wait"], [10_000, "telemetry_stage", "creation"], [20_000, "telemetry_stage", "worker_active"],
      [50_000, "telemetry_stage", "worker_release_wait"], [60_000, "telemetry_stage", "review"], [80_000, "telemetry_stage", "verification"],
      [90_000, "telemetry_stage", "merge"], [100_000, "telemetry_stage", "synchronization"], [110_000, "telemetry_stage", "closeout"], [130_000, "telemetry_stage", "complete"],
    ]);
    const result = deriveTaskTelemetry(task, f.store.eventsAll(task.id), [], [], [], new Date(iso(200_000)));
    assert.equal(result.evidence, "exact"); assert.equal(result.totalElapsedMs, 130_000);
    assert.equal(result.waitingMs, 20_000); assert.equal(result.activeMs, 110_000); assert.equal(result.currentStage, "complete"); assert.equal(result.currentStageAgeMs, 0);
    assert.doesNotThrow(() => taskTelemetrySchema.parse(result));
  } finally { f.close(); }
});

test("store instruments new and changed lifecycle stages with exact boundaries", () => {
  const f = fixture(); try {
    let task = f.add("instrumented");
    task = f.store.update(task.id, { reason: "Waiting for prerequisites: fixture" });
    task = f.store.update(task.id, { held: true });
    task = f.store.update(task.id, { held: false, phase: "dispatching", reason: "Creating workspace" });
    f.store.update(task.id, { phase: "working", reason: "Worker running" });
    assert.deepEqual(f.store.eventsAll(task.id).filter(event => event.kind === "telemetry_stage").map(event => event.detail),
      ["capacity_wait", "prerequisite_wait", "held_wait", "creation", "worker_active"]);
  } finally { f.close(); }
});
test("review wait and reviewer activity have separate exact boundaries", () => {
  const f = fixture(); try {
    let task = f.add("review-boundary");
    task = f.store.update(task.id, { phase: "awaiting_review" });
    task = f.store.update(task.id, { phase: "reviewing" });
    assert.deepEqual(f.store.eventsAll(task.id).filter(event => event.kind === "telemetry_stage").map(event => event.detail),
      ["capacity_wait", "review_wait", "review"]);
    assert.equal(deriveTaskTelemetry(task, f.store.eventsAll(task.id), [], [], [], new Date()).currentStage, "review");
  } finally { f.close(); }
});

test("historical event reconstruction stays useful and marks timing partial", () => {
  const f = fixture(); try {
    const original = f.add("legacy");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(90_000), finishedAt: iso(90_000), phase: "done", reason: "Done" });
    f.setEvents(task.id, [[0, "submitted"], [10_000, "dispatch_intent"], [20_000, "agent_created"], [50_000, "completion_received"], [60_000, "workspace_released", "ready_for_review"], [70_000, "merge_intent"], [80_000, "main_synchronized"], [90_000, "closed_out"]]);
    const result = deriveTaskTelemetry(task, f.store.eventsAll(task.id), [], [], [], new Date(iso(100_000)));
    assert.equal(result.evidence, "partial"); assert.equal(result.totalElapsedMs, 90_000);
    assert.ok(result.stages.every(stage => stage.partial)); assert.equal(result.currentStage, "complete");
  } finally { f.close(); }
});

test("recovery, creation, hook and operator interventions are attributed from durable facts", () => {
  const f = fixture(); try {
    const original = f.add("interventions");
    const task = f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(80_000), phase: "needs_attention", reason: "Provider timeout during reviewer creation", profileGroup: "group-a" });
    const hookId = "h".repeat(48);
    f.setEvents(task.id, [[0, "telemetry_stage", "capacity_wait"], [10_000, "telemetry_stage", "attention"], [11_000, "needs_attention", "Reviewer MonthlyLimit credit exhausted during creation"], [11_500, "incident", JSON.stringify({id:"review-incident",role:"reviewer",runId:"uncertain",cause:"provider_unavailable"})], [12_000, "recovery_pending"],
      [12_000, "telemetry_recovery", JSON.stringify({runId:"recovery",targetRole:"reviewer",cause:"MonthlyLimit provider credit exhausted"})], [13_000, "operator_control", "retry_resolution"], [14_000, "operator_control", "retry_absent_resolution"], [15_000, "recovery_escalated"],
      [40_000, "hook_execution_started", `generic task.closeout ${hookId} attempt 1`], [43_000, "hook_blocked", `generic task.closeout ${hookId}: blocked`],
      [44_000, "hook_execution_started", `generic task.closeout ${hookId} attempt 2`], [48_000, "hook_failed", `generic task.closeout ${hookId}: failed`],
      [49_000, "hook_execution_started", `generic task.closeout ${hookId} attempt 3`], [50_000, "hook_uncertain", `generic task.closeout ${hookId}: uncertain`]]);
    f.store.putRun(runSchema.parse({ id: "recovery", taskId: task.id, role: "recovery", generation: 1, head: "a".repeat(40), base: "a".repeat(40), agentId: "agent", workspaceId: "workspace", profileGroup: "group-b", profile: null, status: "finished", createdAt: iso(12_000), lastObservedAt: iso(20_000), active: false, idleSince: iso(20_000), completion: { eventId: "event", taskId: task.id, runId: "recovery", status: "escalate", summary: "Reviewer provider timeout" }, released: true }));
    f.store.putRun(runSchema.parse({ id: "uncertain", taskId: task.id, role: "reviewer", generation: 1, head: "a".repeat(40), base: "a".repeat(40), agentId: null, workspaceId: "workspace", profileGroup: "review-pool", profile: { id:"reviewer",name:"Reviewer",provider:"review-provider",model:"review-model",notes:"",available:true,problem:"",supportedThinking:[] }, status: "uncertain", createdAt: iso(5_000), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false }));
    f.store.putRun(runSchema.parse({ id: "revision", taskId: task.id, role: "revision", generation: 1, head: "a".repeat(40), base: "a".repeat(40), agentId: "worker", workspaceId: "workspace", profile: null, status: "finished", createdAt: iso(30_000), lastObservedAt: iso(40_000), active: false, idleSince: iso(40_000), completion: null, released: true }));
    const hook = hookRecordSchema.parse({ id: "hook", taskId: task.id, hookId: "generic", event: "task.closeout", eventId: hookId, occurrence: 1, mode: "integration_write", delivery: "required", state: "uncertain", manifest: { path: ".paseo/queue.json", commit: "a".repeat(40), digest: `sha256:${"b".repeat(64)}` }, executable: { path: ".paseo/hook", commit: "a".repeat(40), digest: `sha256:${"c".repeat(64)}` }, instruction: null, baseBranch: "main", baseCommit: "a".repeat(40), attempt: 3, argv: [], timeoutMs: 1000, maxOutputBytes: 1024, allowedPaths: ["docs/"], commitSubject: { prefix: "hook", maxBytes: 80 }, eventDigest: "d".repeat(64), eventPayload: null, workspace: null, processId: null, result: null, commit: null, remote: null, summary: "uncertain", error: "uncertain", reconciledAt: iso(50_000), createdAt: iso(40_000), updatedAt: iso(50_000) });
    f.store.putHookEvent(hook);
    const result = deriveTaskTelemetry(task, f.store.eventsAll(task.id), f.store.runs(task.id), [], [hook], new Date(iso(80_000)));
    assert.equal(result.interventions.recoveryRuns, 1); assert.deepEqual(result.interventions.recoveries[0], { targetRole: "reviewer", provider: "review-provider", profileGroup: "review-pool", status: "escalate", cause: "provider_unavailable", count: 1 });
    assert.deepEqual(result.interventions.incidents, [{ role:"reviewer", provider:"review-provider", profileGroup:"review-pool", cause:"provider_unavailable", count:1 }]);
    assert.equal(result.interventions.uncertainCreations, 1); assert.equal(result.interventions.absentCreations, 1);
    assert.equal(result.interventions.hookHolds, 2); assert.equal(result.interventions.hookRetries, 2); assert.equal(result.interventions.revisions, 1); assert.equal(result.interventions.escalations, 1);
    assert.deepEqual(result.stages.find(stage => stage.stage === "repository_hook"), { stage: "repository_hook", category: "active", elapsedMs: 8_000, partial: false, supplemental: true });
    assert.deepEqual(result.interventions.operatorActions, [{ key: "retry_absent_resolution", count: 1 }, { key: "retry_resolution", count: 1 }]);
  } finally { f.close(); }
});

test("aggregate telemetry filters and groups without inventing empty percentiles", () => {
  const f = fixture(); try {
    for (const [id, repo, scope, group, total, created] of [["a", "/repo-a", "general", "pool-a", 60_000, 0], ["b", "/repo-b", "complex", "pool-b", 120_000, 10_000]] as const) {
      const original = f.add(id, repo, scope), task = f.replaceTask(original.id, { createdAt: iso(created), updatedAt: iso(created+total), finishedAt: iso(created+total), phase: "done", reason: "Done", profileGroup: group });
      f.setEvents(task.id, [[created, "telemetry_stage", "capacity_wait"], [created+total / 2, "telemetry_stage", "worker_active"],
        ...(id === "b" ? [[created+total/2+1, "incident", JSON.stringify({id:"review-b",role:"reviewer",runId:"review-b",cause:"missing_callback"})] as [number,string,string]] : []),
        [created+total, "telemetry_stage", "complete"]]);
      if(id === "b")f.store.putRun(runSchema.parse({id:"review-b",taskId:task.id,role:"reviewer",generation:1,head:"a".repeat(40),base:"a".repeat(40),agentId:"reviewer-b",workspaceId:"workspace",profileGroup:"review-b",profile:{id:"review-b",name:"Review B",provider:"provider-b",model:"model-b",notes:"",available:true,problem:"",supportedThinking:[]},status:"finished",createdAt:iso(created+total/2),lastObservedAt:iso(created+total),active:false,idleSince:iso(created+total),completion:null,released:true}));
    }
    const grouped = telemetrySnapshot(f.store, { window: "all", groupBy: "repository" }, new Date(iso(200_000)));
    assert.equal(grouped.matchingTasks, 2); assert.equal(grouped.groups.length, 2); assert.equal(grouped.groups[0].completionRate, 1);
    const closeout = telemetrySnapshot(f.store, { window: "all", groupBy: "closeout_authority", closeoutAuthority: "none" }, new Date(iso(200_000)));
    assert.equal(closeout.matchingTasks, 2); assert.equal(closeout.groups[0].key, "none"); assert.equal(closeout.groups[0].closeoutAuthorities.none, 2);
    const filtered = telemetrySnapshot(f.store, { window: "all", groupBy: "none", scope: "complex", profileGroup: "pool-b" }, new Date(iso(200_000)));
    assert.equal(filtered.matchingTasks, 1); assert.equal(filtered.groups[0].total.p50Ms, 120_000); assert.equal(filtered.groups[0].total.p95Ms, 120_000);
    const cohort = telemetrySnapshot(f.store, { window:"all", groupBy:"none", createdAfter:iso(5_000) }, new Date(iso(200_000)));
    assert.equal(cohort.matchingTasks,1);assert.equal(cohort.groups[0].total.p50Ms,120_000);
    const attributed = telemetrySnapshot(f.store, {window:"all",groupBy:"none",interventionRole:"reviewer",interventionProvider:"provider-b"},new Date(iso(200_000)));
    assert.equal(attributed.matchingTasks,1);assert.equal(attributed.groups[0].interventions.incidents[0].profileGroup,"review-b");
    const empty = telemetrySnapshot(f.store, { window: "24h", groupBy: "none", repoPath: "/missing" }, new Date(iso(200_000)));
    assert.equal(empty.matchingTasks, 0); assert.deepEqual(empty.groups, []); assert.doesNotThrow(() => telemetrySnapshotSchema.parse(grouped));
  } finally { f.close(); }
});

test("aggregate telemetry cache reuses one base until a write or age expires it", async () => {
  const f = fixture(); try {
    let at = start + 200_000, builds = 0;
    const original = f.store.telemetryFactChunks.bind(f.store);
    f.store.telemetryFactChunks = (page?: number) => { builds += 1; return original(page); };
    const cached = createTelemetrySnapshotCache(f.store, { maxAgeMs: 1_000, now: () => at });
    f.add("before-cache");
    const first = await cached({ groupBy: "none", window: "all" });
    assert.equal(first.matchingTasks, 1);
    const reused = await cached({ window: "all", groupBy: "scope" });
    assert.notStrictEqual(reused, first);
    assert.equal(reused.generatedAt, first.generatedAt);
    assert.equal(reused.matchingTasks, 1);
    assert.equal(builds, 1);
    f.add("inside-cache");
    const afterWrite = await cached({ window: "all", groupBy: "none" });
    assert.equal(afterWrite.matchingTasks, 2);
    assert.equal(builds, 2);
    at += 1_001;
    const refreshed = await cached({ window: "all", groupBy: "none" });
    assert.notEqual(refreshed.generatedAt, afterWrite.generatedAt);
    assert.equal(refreshed.matchingTasks, 2);
    assert.equal(builds, 3);
  } finally { f.close(); }
});

test("a durable telemetry mutation invalidates the shared base exactly once", async () => {
  const f = fixture(); try {
    let builds = 0;
    const cached = createTelemetrySnapshotCache(f.store, { maxAgeMs: 60_000 });
    const original = f.store.telemetryFactChunks.bind(f.store);
    f.store.telemetryFactChunks = (page?: number) => { builds += 1; return original(page); };
    const task = f.add("revision-a");
    const first = await cached({ window: "all", groupBy: "none" });
    assert.equal(first.matchingTasks, 1);
    const stable = await cached({ window: "all", groupBy: "scope" });
    assert.equal(stable.generatedAt, first.generatedAt);
    assert.equal(builds, 1);
    f.store.setMeta("unrelatedSetting", { note: "telemetry does not read this" });
    const unrelated = await cached({ window: "all", groupBy: "none" });
    assert.equal(unrelated.generatedAt, first.generatedAt);
    assert.equal(builds, 1);
    const revision = f.store.telemetryRevision();
    f.store.event(task.id, "state", "durable telemetry fact");
    assert.equal(f.store.telemetryRevision(), revision + 1);
    const afterWrite = await cached({ window: "all", groupBy: "none" });
    assert.notEqual(afterWrite.generatedAt, first.generatedAt);
    assert.equal(builds, 2);
    const reused = await cached({ window: "all", groupBy: "none" });
    assert.equal(reused.generatedAt, afterWrite.generatedAt);
    assert.equal(builds, 2);
  } finally { f.close(); }
});

test("concurrent cold filter requests coalesce into one base construction", async () => {
  const f = fixture(); try {
    let builds = 0;
    const original = f.store.telemetryFactChunks.bind(f.store);
    f.store.telemetryFactChunks = (page?: number) => { builds += 1; return original(page); };
    for (const [id, repo] of [["one", "/repo-a"], ["two", "/repo-b"]] as const) f.add(id, repo);
    const cached = createTelemetrySnapshotCache(f.store, { maxAgeMs: 60_000 });
    const [all, repoA, repoB] = await Promise.all([
      cached({ window: "all", groupBy: "none" }), cached({ window: "all", groupBy: "repository", repoPath: "/repo-a" }), cached({ window: "all", groupBy: "scope" }),
    ]);
    assert.equal(builds, 1);
    assert.equal(all.matchingTasks, 2); assert.equal(repoA.matchingTasks, 1); assert.equal(repoA.groups[0].key, "/repo-a"); assert.equal(repoB.matchingTasks, 2);
  } finally { f.close(); }
});

test("headline categories separate delivery exceptions, semantic review and operator administration", () => {
  const f = fixture(); try {
    const build = (id: string) => { const original = f.add(id); return f.replaceTask(original.id, { createdAt: iso(0), updatedAt: iso(60_000), finishedAt: iso(60_000), phase: "done", reason: "Done" }); };
    const run = (id: string, taskId: string, extra: Record<string, unknown>) => f.store.putRun(runSchema.parse({ id, taskId, role: "revision", generation: 1, head: "a".repeat(40), base: "a".repeat(40), agentId: "worker", workspaceId: "workspace", profileGroup: null, profile: null, status: "finished", createdAt: iso(20_000), lastObservedAt: iso(30_000), active: false, idleSince: iso(30_000), completion: null, released: true, ...extra }));
    const delivery = build("delivery"), semantic = build("semantic"), admin = build("admin");
    run("recovery", delivery.id, { role: "recovery", revisionCause: undefined, completion: { eventId: "event", taskId: delivery.id, runId: "recovery", status: "escalate", summary: "Workspace state left the retained worker" } });
    run("semantic-revision", semantic.id, { revisionCause: "review" });
    run("administrative-revision", admin.id, { revisionCause: "administrative" });
    f.store.event(admin.id, "disposition_requested", "supersede requested by bulk op-1: operator control: duplicate work");

    const snapshot = telemetrySnapshot(f.store, { window: "all", groupBy: "none" }, new Date(iso(120_000)));
    const group = snapshot.groups[0];
    assert.deepEqual(group.headline, {
      deliveryExceptions: { taskCount: 1, factCount: 1, rate: 1 / 3 },
      semanticReview: { taskCount: 1, factCount: 1, rate: 1 / 3 },
      operatorAdministration: { taskCount: 1, factCount: 2, rate: 1 / 3 },
    });
    // The legacy raw rate keeps every overlapping fact instead of presenting a category as a unique total.
    assert.equal(group.interventionTaskCount, 3); assert.equal(group.interventionRate, 1);

    const telemetryFor = (task: ReturnType<typeof build>) => deriveTaskTelemetry(task, f.store.eventsAll(task.id), f.store.runs(task.id), f.store.notices(task.id), f.store.hookEvents(task.id), new Date(iso(120_000)));
    assert.deepEqual(headlineFacts(telemetryFor(delivery).interventions), { deliveryExceptions: 1, semanticReview: 0, operatorAdministration: 0 });
    assert.deepEqual(headlineFacts(telemetryFor(semantic).interventions), { deliveryExceptions: 0, semanticReview: 1, operatorAdministration: 0 });
    assert.deepEqual(headlineFacts(telemetryFor(admin).interventions), { deliveryExceptions: 0, semanticReview: 0, operatorAdministration: 2 });
    assert.equal(telemetryFor(admin).interventions.revisions, 0);
  } finally { f.close(); }
});

test("shared-base filtering matches direct derivation and keeps evidence labels", () => {
  const f = fixture(); try {
    const exact = f.replaceTask(f.add("base-exact").id, { createdAt: iso(0), updatedAt: iso(60_000), finishedAt: iso(60_000), phase: "done", reason: "Done" });
    f.setEvents(exact.id, [[0, "telemetry_stage", "capacity_wait"], [30_000, "telemetry_stage", "worker_active"], [60_000, "telemetry_stage", "complete"]]);
    const legacy = f.replaceTask(f.add("base-legacy", "/repo-b").id, { createdAt: iso(10_000), updatedAt: iso(70_000), finishedAt: iso(70_000), phase: "done", reason: "Done" });
    f.setEvents(legacy.id, [[10_000, "submitted"], [20_000, "agent_created"], [70_000, "closed_out"]]);
    const snapshot = telemetrySnapshot(f.store, { window: "all", groupBy: "scope" }, new Date(iso(120_000)));
    const direct = [exact, legacy].map(task => deriveTaskTelemetry(task, f.store.eventsAll(task.id), f.store.runs(task.id), f.store.notices(task.id), f.store.hookEvents(task.id), new Date(iso(120_000))));
    assert.equal(snapshot.matchingTasks, 2); assert.equal(snapshot.groups.length, 1);
    assert.equal(snapshot.groups[0].evidence, "mixed");
    assert.equal(snapshot.groups[0].total.count, 2);
    assert.equal(snapshot.groups[0].total.partialCount, 1);
    assert.equal(snapshot.groups[0].total.p50Ms, Math.min(...direct.map(item => item.totalElapsedMs)));
    assert.equal(snapshot.groups[0].total.p95Ms, Math.max(...direct.map(item => item.totalElapsedMs)));
    assert.deepEqual([...new Set(direct.map(item => item.evidence))].sort(), ["exact", "partial"]);
  } finally { f.close(); }
});

test("age expiry rebuilds the shared base for unfinished tasks without a durable write", async () => {
  const f = fixture(); try {
    let at = start + 200_000;
    const task = f.replaceTask(f.add("aging").id, { createdAt: iso(0), updatedAt: iso(0), finishedAt: null, phase: "queued", reason: "Waiting for dispatch" });
    f.setEvents(task.id, [[0, "telemetry_stage", "capacity_wait"]]);
    const revision = f.store.telemetryRevision();
    const cached = createTelemetrySnapshotCache(f.store, { maxAgeMs: 15_000, now: () => at });
    const first = await cached({ window: "all", groupBy: "none" });
    at += 5_000;
    const withinAge = await cached({ window: "all", groupBy: "none" });
    assert.equal(withinAge.generatedAt, first.generatedAt);
    at += 10_001;
    const refreshed = await cached({ window: "all", groupBy: "none" });
    assert.notEqual(refreshed.generatedAt, first.generatedAt);
    assert.equal(f.store.telemetryRevision(), revision);
    const early = deriveTaskTelemetry(task, f.store.eventsAll(task.id), [], [], [], new Date(iso(200_000)));
    const late = deriveTaskTelemetry(task, f.store.eventsAll(task.id), [], [], [], new Date(iso(215_001)));
    assert.equal(early.currentStage, "capacity_wait");
    assert.equal(early.currentStageAgeMs, 200_000);
    assert.equal(late.currentStageAgeMs, 215_001);
  } finally { f.close(); }
});

test("generic detail and aggregate RPC contracts expose strict telemetry shapes", () => {
  const f = fixture(); try {
    const task = f.add("rpc"), events = f.store.eventsAll(task.id);
    const taskTelemetry = deriveTaskTelemetry(task, events, [], [], [], new Date(task.createdAt));
    assert.doesNotThrow(() => detailRpc.output.parse({ task, events, runs: [], notices: [], dependencies: [], hooks: [], telemetry: taskTelemetry }));
    assert.deepEqual(telemetryRpc.input.parse({ repoPath: "/repo-a" }), { repoPath: "/repo-a", window: "30d", groupBy: "none" });
    assert.deepEqual(telemetryRpc.input.parse({ createdAfter:iso(1),interventionRole:"reviewer",interventionProvider:"provider-b" }),
      {createdAfter:iso(1),interventionRole:"reviewer",interventionProvider:"provider-b",window:"30d",groupBy:"none"});
    assert.throws(() => telemetryRpc.input.parse({ window: "forever" }));
    assert.doesNotThrow(() => telemetryRpc.output.parse(telemetrySnapshot(f.store, { window: "all", groupBy: "none" }, new Date(task.createdAt))));
  } finally { f.close(); }
});

test("duration labels keep the compact task summary readable", () => {
  assert.equal(formatTelemetryDuration(12_000), "12s"); assert.equal(formatTelemetryDuration(90_000), "2m");
  assert.equal(formatTelemetryDuration(7_200_000), "2.0h"); assert.equal(formatTelemetryDuration(172_800_000), "2.0d");
  assert.equal(normalizeTelemetryCause("MonthlyLimit provider credit exhausted"), "provider_unavailable");
});

test("telemetry cause matches whole words, so unstopped is not stopped", () => {
  assert.equal(normalizeTelemetryCause("Worker stopped without a callback"), "missing_callback");
  assert.equal(normalizeTelemetryCause("Accepted summary: the unstopped run reported done"), "other");
  assert.equal(normalizeTelemetryCause("the agent went idle"), "missing_callback");
});

test("compact task detail summary renders honest timing and evidence labels", () => {
  const summary = compactTelemetrySummary(taskTelemetrySchema.parse({
    taskId: "summary", generatedAt: iso(20_000), evidence: "partial", totalElapsedMs: 20_000,
    waitingMs: 10_000, activeMs: 5_000, interventionMs: 5_000, currentStage: "attention", currentStageAgeMs: 5_000, closeoutAuthority: "pending",
    stages: [], interventions: { recoveryRuns: 1, recoveries: [], uncertainCreations: 0, absentCreations: 0,
      attentionNotices: 0, escalations: 0, hookHolds: 0, hookRetries: 0, revisions: 0, replacements: 0, operatorActions: [] },
  }));
  assert.deepEqual(summary.metrics, [
    { label: "Total", value: "20s" }, { label: "Waiting", value: "10s" }, { label: "Active", value: "5s" },
    { label: "Current", value: "Attention and recovery · 5s" }, { label: "Closeout", value: "Pending" }, { label: "Interventions", value: "1" },
  ]);
  assert.match(summary.evidence, /Partial historical timing/);
});
