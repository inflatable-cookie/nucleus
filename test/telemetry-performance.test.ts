import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store, digest } from "../core/store/store";
import { createTelemetrySnapshotCache } from "../core/telemetry/telemetry";
import { taskSchema } from "../shared/contracts";
import { telemetrySnapshotSchema } from "../shared/telemetry";
import { timingTest, performanceAssert } from './support/timing';
import { cpuTimeMs, cpuSample } from './support/cpu-time';

/**
 * Spec 009 performance oracle. The fixture is comparable to the observed live store:
 * at least 250 tasks, 50,000 lifecycle facts and enough payload to exercise a roughly
 * 48 MB database. The oracle reports measured values and fails rather than extending
 * any RPC timeout.
 */
const TASK_COUNT = 250;
const EVENTS_PER_TASK = 204;
const FACT_COUNT = TASK_COUNT * EVENTS_PER_TASK;
const TASK_PAYLOAD_BYTES = 12_000;
const REPOS = ["/repo-alpha", "/repo-beta", "/repo-gamma", "/repo-delta", "/repo-epsilon"];
const CAPABILITIES = ["general", "mechanical", "complex"] as const;

function filler(seed: number, length: number) {
  let value = (seed + 1) >>> 0, text = "";
  while (text.length < length) { value = (value * 1664525 + 1013904223) >>> 0; text += `${value.toString(36)}-`; }
  return text.slice(0, length);
}

interface Fixture { store: Store; directory: string; dbPath: string; bytes: number; facts: number; generatedAt: number; close: () => void }

function buildFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ns-telemetry-perf-"));
  const dbPath = join(directory, "queue.sqlite");
  const store = new Store(dbPath);
  const start = Date.parse("2026-08-01T00:00:00.000Z");
  const iso = (value: number) => new Date(start + value).toISOString();
  const insertTask = store.db.prepare("INSERT INTO tasks VALUES(?,?,?,?)");
  const insertEvent = store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)");
  const insertRun = store.db.prepare("INSERT INTO runs VALUES(?,?,?)");

  store.transaction(() => {
    for (let index = 0; index < TASK_COUNT; index++) {
      const created = index * 90_000, isExact = index % 5 !== 0, isAttention = index % 11 === 0, isRevision = index % 7 === 0;
      const id = `perf-task-${index}`;
      const task = taskSchema.parse({
        submissionId: `perf-${index}`, title: `perf task ${index}`, repoPath: REPOS[index % REPOS.length], scope: CAPABILITIES[index % 3],
        planningCommit: "a".repeat(40), handoffPath: `docs/handoffs/perf-${index}.md`, originAgentId: "perf-origin",
        id, hostId: "perf-host", createdAt: iso(created), updatedAt: iso(created + 60_000), version: 3,
        phase: isAttention ? "needs_attention" : "done", reason: isAttention ? "Provider timeout during reviewer creation" : "Done",
        held: false, handoffText: filler(index * 7, TASK_PAYLOAD_BYTES), planningBase: "a".repeat(40),
        workspaceId: `workspace-${index}`, directory: null, branch: `ns-perf-${index}`, agentId: null, runId: null, profile: null,
        workspaceIntent: false, agentIntent: false, lastAgentStatus: null, idleSince: null, completion: null,
        agentActive: null, lastObservedAt: null, profileGroup: `group-${index % 4}`, prUrl: null, prHead: null, coordinatorGeneration: 1,
      });
      insertTask.run(id, task.submissionId, digest(`perf-${index}`), JSON.stringify(task));

      const rows: [number, string, string][] = [[created, ...(isExact ? ["telemetry_stage", "capacity_wait"] : ["submitted", `Origin: perf-origin; planning ${"a".repeat(40)}`]) as [string, string]]];
      const stages: [number, string, string][] = isExact
        ? [[2_000, "telemetry_stage", "creation"], [5_000, "telemetry_stage", "worker_active"], [20_000, "telemetry_stage", "review"], [30_000, "telemetry_stage", "verification"], [40_000, "telemetry_stage", "merge"], [45_000, "telemetry_stage", "synchronization"], [50_000, "telemetry_stage", "closeout"], [60_000, "telemetry_stage", "complete"]]
        : [[5_000, "dispatch_intent", "creation"], [20_000, "agent_created", "worker"], [40_000, "completion_received", "ready_for_review"], [50_000, "workspace_released", "ready_for_review"], [55_000, "merge_intent", "merge"], [58_000, "main_synchronized", "sync"], [60_000, "closed_out", "done"]];
      for (const [offset, kind, detail] of stages) rows.push([created + offset, kind, detail]);
      if (isAttention) rows.push(
        [created + 25_000, "needs_attention", "Provider MonthlyLimit credit exhausted during reviewer creation"],
        [created + 26_000, "incident", JSON.stringify({ id: `perf-incident-${index}`, role: "reviewer", runId: null, cause: "provider_unavailable" })],
        [created + 27_000, "telemetry_recovery", JSON.stringify({ runId: `perf-recovery-${index}`, targetRole: "reviewer", cause: "MonthlyLimit provider credit exhausted" })],
      );
      if (isRevision) rows.push([created + 28_000, "revision_requested", "Reviewer findings returned to the retained worker"]);
      if (index % 13 === 0) rows.push([created + 29_000, "disposition_requested", "supersede requested by bulk perf-operation: operator control: duplicate work"]);
      if (index % 17 === 0) {
        const hookId = (index.toString(16).padStart(2, "0")).repeat(24).slice(0, 48);
        rows.push([created + 30_000, "hook_execution_started", `generic task.closeout ${hookId} attempt 1`], [created + 31_000, "hook_failed", `generic task.closeout ${hookId}: failed`]);
      }
      while (rows.length < EVENTS_PER_TASK) {
        const position = rows.length;
        rows.push([created + 1_000 + position, "state", filler(index * 1_000 + position, 120 + ((index * 7 + position * 13) % 1_400))]);
      }
      for (const [offset, kind, detail] of rows) insertEvent.run(id, iso(offset), kind, detail);

      if (isAttention || isRevision) {
        const role = isRevision && !isAttention ? "revision" : "recovery";
        insertRun.run(`perf-run-${index}`, id, JSON.stringify({
          id: `perf-run-${index}`, taskId: id, role, generation: 1, head: "b".repeat(40), base: "a".repeat(40),
          agentId: `perf-agent-${index}`, workspaceId: `workspace-${index}`, profileGroup: `group-${index % 4}`, profile: null,
          status: "finished", createdAt: iso(created + 27_000), lastObservedAt: iso(created + 35_000), active: false, idleSince: iso(created + 35_000),
          completion: { eventId: `perf-event-${index}`, taskId: id, runId: `perf-run-${index}`, status: isRevision ? "changes_required" : "escalate", summary: filler(index, 900) },
          released: true, ...(isRevision && !isAttention ? { revisionCause: "review" } : {}),
        }));
      }
    }
  });
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytes = statSync(dbPath).size;
  const facts = Number(store.db.prepare("SELECT COUNT(*) AS n FROM events").get()!.n);
  return { store, directory, dbPath, bytes, facts, generatedAt: start + TASK_COUNT * 90_000 + 120_000, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function startCpuSliceMonitor(intervalMs = 10) {
  const samples: number[] = [];
  let previous = process.cpuUsage();
  const timer = setInterval(() => { samples.push(cpuTimeMs(previous)); previous = process.cpuUsage(); }, intervalMs);
  return { stop: () => { clearInterval(timer); return samples; } };
}

timingTest("shared telemetry base meets the cold, warm and unrelated-RPC responsiveness oracle", async () => {
  const fixture = buildFixture();
  try {
    assert.ok(fixture.facts >= 50_000, `fixture must carry at least 50,000 lifecycle facts, measured ${fixture.facts}`);
    assert.ok(fixture.bytes >= 40 * 1024 * 1024, `fixture must exercise a roughly 48 MB database, measured ${(fixture.bytes / 1024 / 1024).toFixed(1)} MB`);
    let clock = fixture.generatedAt, builds = 0;
    const original = fixture.store.telemetryFactChunks.bind(fixture.store);
    fixture.store.telemetryFactChunks = (page?: number) => { builds += 1; return original(page); };
    const cached = createTelemetrySnapshotCache(fixture.store, { maxAgeMs: 15_000, now: () => clock });

    // A normal queue.ui-snapshot re-reads durable task state; run its core work on the same loop as the build.
    const uiSnapshotProbe = () => new Promise<number>(resolve => {
      setImmediate(() => { resolve(cpuSample(() => fixture.store.tasks()).ms); });
    });

    const cpuSlices = startCpuSliceMonitor();
    let building = true;
    const probeSamples: number[] = [];
    const probing = (async () => { while (building) probeSamples.push(await uiSnapshotProbe()); })();
    const coldStarted = process.cpuUsage();
    const cold = await cached({ window: "all", groupBy: "scope" });
    const coldCpuMs = cpuTimeMs(coldStarted);
    building = false;
    await probing;
    const cpuSliceSamples = cpuSlices.stop();
    assert.equal(cold.matchingTasks, TASK_COUNT);
    assert.doesNotThrow(() => telemetrySnapshotSchema.parse(cold));
    assert.equal(builds, 1);
    performanceAssert(coldCpuMs <= 5_000, `cold base construction and first aggregate took ${coldCpuMs.toFixed(0)} ms`);
    const cpuSliceP95 = percentile(cpuSliceSamples, 0.95);
    performanceAssert(cpuSliceP95 < 100, `event-loop CPU p95 during cold construction was ${cpuSliceP95.toFixed(1)} ms`);
    const probeMaxCpuMs = Math.max(0, ...probeSamples);
    performanceAssert(probeMaxCpuMs < 250, `queue.ui-snapshot probe took ${probeMaxCpuMs.toFixed(0)} ms during cold construction`);

    // Fifty varied warm filters must stay inside the 100 ms p95 budget without rebuilding the base.
    const warmLatency: number[] = [];
    for (let index = 0; index < 50; index++) {
      const filter = {
        window: "all" as const,
        groupBy: (["none", "repository", "scope", "profile_group", "closeout_authority"] as const)[index % 5],
        ...(index % 3 === 0 ? { repoPath: REPOS[index % REPOS.length] } : {}),
        ...(index % 2 === 0 ? { scope: CAPABILITIES[index % CAPABILITIES.length] } : {}),
        ...(index % 4 === 0 ? { profileGroup: `group-${index % 4}` } : {}),
      };
      const started = process.cpuUsage();
      await cached(filter);
      warmLatency.push(cpuTimeMs(started));
    }
    const warmCpuP95 = percentile(warmLatency, 0.95);
    assert.equal(builds, 1, "warm filters must reuse the one base");
    performanceAssert(warmCpuP95 <= 100, `warm filter p95 was ${warmCpuP95.toFixed(1)} ms`);

    // Concurrent cold filters coalesce into a single construction after a durable mutation.
    clock += 1_000;
    fixture.store.event(`perf-task-0`, "state", "durable mutation invalidates the shared base");
    const concurrent = await Promise.all([
      cached({ window: "all", groupBy: "none" }),
      cached({ window: "all", groupBy: "repository", repoPath: REPOS[0] }),
      cached({ window: "all", groupBy: "profile_group" }),
      cached({ window: "all", groupBy: "closeout_authority" }),
    ]);
    assert.equal(builds, 2, "concurrent cold filters must construct exactly one base");
    assert.equal(new Set(concurrent.map(item => item.generatedAt)).size, 1);
    assert.equal(concurrent[1].matchingTasks, TASK_COUNT / REPOS.length);

    console.log(`telemetry oracle: fixture ${fixture.facts} facts / ${(fixture.bytes / 1024 / 1024).toFixed(1)} MB; cold ${coldCpuMs.toFixed(0)} ms; lag p95 ${cpuSliceP95.toFixed(1)} ms; ui-snapshot probe max ${probeMaxCpuMs.toFixed(0)} ms; warm p95 ${warmCpuP95.toFixed(1)} ms; builds ${builds}`);
  } finally { fixture.close(); }
});

timingTest('cold telemetry yields to cached detail and durable acceptance on the same executor loop', async t => {
  const fixture=buildFixture();
  const {createTaskDetailCache}=await import('../core/telemetry/task-detail');
  const {createUiSnapshotFactsCache}=await import('../core/telemetry/ui-snapshot');
  try{
    const detail=createTaskDetailCache(fixture.store),board=createUiSnapshotFactsCache(fixture.store);
    board(); // Warm the board snapshot before measuring the selected task's detail cache.
    let detailReads=0;const events=fixture.store.eventsAll.bind(fixture.store);
    fixture.store.eventsAll=id=>{detailReads++;return events(id);};
    detail('perf-task-0');
    const cached=createTelemetrySnapshotCache(fixture.store);
    const latency:number[]=[];let finished=false;const start=process.cpuUsage();
    const cold=cached({window:'all'}).finally(()=>{finished=true;});
    let count=0;
    while(!finished){
      await new Promise<void>(resolve=>setImmediate(resolve));
      const began=process.cpuUsage();
      detail('perf-task-0');board();
      const receipt=fixture.store.acceptOperation({key:'contention-fixture',kind:'submit',inputHash:'a'.repeat(64),payload:{}});
      assert.ok('accepted' in receipt);latency.push(cpuTimeMs(began));count++;
    }
    await cold;
    assert.ok(count>1,'cold construction must yield repeatedly to unrelated requests');
    assert.equal(detailReads,1,'unrelated acceptance must not reload selected-task evidence');
    assert.equal(fixture.store.operations().length,1,'repeated receipt checks preserve one identity');
    const worst=Math.max(...latency);performanceAssert(worst<250,`detail/board/acceptance probe took ${worst.toFixed(1)} ms`);
    t.diagnostic(JSON.stringify({facts:fixture.facts,coldCpuMs:cpuTimeMs(start),concurrentProbes:count,probeP95Ms:percentile(latency,.95),probeMaxMs:worst,detailEvidenceReads:detailReads}));
  }finally{fixture.close();}
});

test('task lookup indexes upgrade an existing store without rewriting evidence', t => {
  const fixture = buildFixture();
  let reopened: Store | undefined;
  try {
    const db = fixture.store.db;
    const before = fixture.store.eventsAll('perf-task-0');
    for (const table of ['events', 'runs', 'notices']) db.exec(`DROP INDEX ${table}_task`);
    const measure = () => {
      const start = performance.now();
      for (let i = 0; i < 30; i++) fixture.store.eventsAll(`perf-task-${i}`);
      return performance.now() - start;
    };
    const unindexedMs = measure();
    fixture.store.close();
    reopened = new Store(fixture.dbPath);
    assert.deepEqual(reopened.eventsAll('perf-task-0'), before);
    assert.equal(reopened.tasks().length, TASK_COUNT);
    for (const table of ['events', 'runs', 'notices']) {
      const order = table === 'events' ? 'id' : 'rowid';
      const plan = reopened.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE taskId=? ORDER BY ${order}`).all('perf-task-0');
      assert.match(JSON.stringify(plan), new RegExp(`SEARCH ${table} USING INDEX ${table}_task`));
      assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
    }
    const start = performance.now();
    for (let i = 0; i < 30; i++) reopened.eventsAll(`perf-task-${i}`);
    t.diagnostic(JSON.stringify({ facts: fixture.facts, unindexedMs, indexedMs: performance.now() - start }));
  } finally { reopened?.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});
