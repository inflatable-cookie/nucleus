import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { NO_HISTORY_CPU_SHARE, HostRunScheduler, HISTORY_MEMORY_MARGIN, classifyHostRun, type HostRunSubmission } from "../core/host-runs/host-run-scheduler";
import { hostRunRecordSchema, hostRunSettlementSchema, hostRunResultSchema } from "../shared/contracts";

const repository = { origin: "https://github.com/example/host-runs", path: "/repo/host-runs" };
const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });
/**
 * One heavy CPU: an unmeasured run reserves at most half the CPU capacity
 * (NO_HISTORY_CPU_SHARE, never below one), so on this host it takes the whole
 * box. The rows that model a full box queueing behind another use it.
 */
const singleCpu = () => ({ ...capacity(), cpuCapacity: 1 });
const input = (id: string, overrides: Partial<HostRunSubmission> = {}): HostRunSubmission => ({
  id, epoch: 1, caller: `test:${id}`, repository, selector: "qa", runClass: "heavy", classSource: "default",
  priority: "milestone", runTimeoutMs: 30 * 60_000, ...overrides,
});
const result = (id: string, epoch: number, startedAt: string, endedAt: string, wallMs: number, cpuMs: number | null = 100) => hostRunResultSchema.parse({
  format: "host.run.result", version: 1, runId: id, epoch, pgid: 9000, startIdentity: `identity-${id}`,
  exitCode: 0, signal: null, startedAt, endedAt, wallMs, cpuMs, escapedDescendants: [],
});
const passed = (id: string, epoch: number, startedAt: string, endedAt: string, wallMs: number, cpuMs: number | null = 100, containers: Array<{ runtime: string; id: string; removed: boolean | "unknown" }> = []) => hostRunSettlementSchema.parse({
  format: "host.run.settlement", version: 1, runId: id, outcome: "passed", launched: true, settledAt: endedAt,
  result: result(id, epoch, startedAt, endedAt, wallMs, cpuMs), containers,
});
const launchHandler = (scheduler: HostRunScheduler, launched: string[], positions: number[] = []) => ({
  launch: (run: { id: string }) => { scheduler.markLaunched(run.id); launched.push(run.id); },
  position: (position: number) => { positions.push(position); },
});
const testStore = (t: any) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
};

// Spec 035 / contract 010 acceptance row 1.
test("010 row 1: the second heavy run queues and launches after the first settles", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: singleCpu });
  const launched: string[] = [], positions: number[] = [];
  scheduler.submit(input("first"), launchHandler(scheduler, launched));
  const second = scheduler.submit(input("second"), launchHandler(scheduler, launched, positions));
  assert.equal(scheduler.get("first")?.state, "running");
  assert.equal(second.state, "queued");
  assert.deepEqual(positions, [1]);
  assert.equal(scheduler.get("second")?.position, 1);

  const startedAt = scheduler.get("first")!.launchedAt!;
  const endedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  scheduler.settle("first", passed("first", 1, startedAt, endedAt, 60_000));
  assert.deepEqual(launched, ["first", "second"]);
  assert.equal(scheduler.get("second")?.state, "running");
  const journal = store.hostRunJournal("second").map(row => row.event);
  assert.ok(journal.indexOf("request") < journal.indexOf("decision"));
  assert.ok((store.hostRunJournal("second").find(row => row.event === "decision")?.data as any).capacitySample);
});

test("older held reservations remain in admission samples and the Pipeline list beyond recent history", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: singleCpu });
  scheduler.submit(input("old-held", { budgetFallback: { cpu: 3, memoryBytes: 100 } }), launchHandler(scheduler, []));
  const launched = scheduler.get("old-held")!;
  scheduler.settle("old-held", passed(launched.id, launched.epoch, launched.launchedAt!, new Date(Date.parse(launched.launchedAt!) + 100).toISOString(), 100, 100,
    [{ runtime: "test", id: "old-container", removed: false }]));
  const held = scheduler.get("old-held")!;
  assert.equal(held.capacityReleasedAt, null);

  const at = new Date().toISOString();
  const fillerSettlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: "filler-0",
    outcome: "capacity_timeout", launched: false, settledAt: at, result: null, containers: [] });
  const filler = hostRunRecordSchema.parse({ ...held, id: "filler-0", caller: "test:filler-0",
    repository: { origin: "https://github.com/example/fillers", path: "/repo/fillers" }, state: "settled",
    submittedAt: at, capacityDeadlineAt: at, admittedAt: null, launchedAt: null, settledAt: at,
    settlement: fillerSettlement, wallMs: null, cpuMs: null, containers: [], capacityReleasedAt: at,
    capacityReleaseReason: "capacity deadline expired before launch", capacityReleaseKind: "automatic" });
  const insert = store.db.prepare("INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)");
  store.transaction(() => {
    for (let index = 0; index < 10_001; index++) {
      const id = `released-filler-${index}`;
      insert.run(id, filler.repository.origin, filler.state, JSON.stringify({ ...filler, id, caller: `test:${id}`,
        settlement: { ...filler.settlement!, runId: id } }));
    }
  });

  assert.ok(scheduler.list(1).some(run => run.id === "old-held"), "the UI feed keeps held rows outside its recent-history window");
  const queued = scheduler.submit(input("after-old-held", { budgetFallback: { cpu: 2, memoryBytes: 100 } }), launchHandler(scheduler, []));
  assert.equal(queued.state, "queued", "the old held reservation still consumes its CPU budget");
  assert.equal(queued.capacitySample?.reservedCpu, 1, "the held run's capped no-history reservation (one CPU)");
});

test("a stale queued epoch is neither admitted nor attached after authority advances", t => {
  let cpuCapacity = 1;
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: () => ({ ...capacity(), cpuCapacity }) });
  const launched: string[] = [];
  const blocker = scheduler.submit(input("epoch-blocker", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchHandler(scheduler, launched));
  assert.equal(blocker.state, "running");
  const stale = scheduler.submit(input("epoch-queued", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchHandler(scheduler, launched));
  assert.equal(stale.state, "queued");

  cpuCapacity = 4;
  store.setMeta("hostRunAuthority", { holder: "queue", epoch: 2, endpoint: null });
  scheduler.tick();

  assert.equal(scheduler.get("epoch-queued")?.state, "queued");
  assert.deepEqual(launched, ["epoch-blocker"]);
  assert.throws(() => scheduler.attach("epoch-queued", launchHandler(scheduler, launched)), /stale_epoch/);
  assert.throws(() => scheduler.cancelQueued("epoch-queued", "stale cancel", 1), /stale_epoch/);
  assert.equal(store.hostRunJournal("epoch-queued").some(row => (row.data as any).method === "host.run.cancel"), false);
  assert.deepEqual(launched, ["epoch-blocker"]);
});

test("an admitted run rechecks its epoch at the durable launch boundary", async t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  const launched: string[] = [];
  let allowLaunch!: () => void;
  const gate = new Promise<void>(resolve => { allowLaunch = resolve; });
  let launchError: unknown;
  let finished!: () => void;
  const launchFinished = new Promise<void>(resolve => { finished = resolve; });
  scheduler.submit(input("epoch-admitted", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), {
    launch: async run => {
      await gate;
      try { scheduler.markLaunched(run.id); launched.push(run.id); }
      catch (error) { launchError = error; }
      finally { finished(); }
    },
  });
  assert.equal(scheduler.get("epoch-admitted")?.state, "admitted");
  store.setMeta("hostRunAuthority", { holder: "queue", epoch: 2, endpoint: null });
  allowLaunch();
  await launchFinished;

  assert.match(String(launchError), /stale_epoch/);
  assert.deepEqual(launched, []);
  assert.equal(scheduler.get("epoch-admitted")?.state, "admitted");
});

// Spec 035 / contract 010 acceptance row 2.
test("010 row 2: capacity deadline settles an unlaunched hold", t => {
  let clock = Date.parse("2026-09-30T10:00:00.000Z");
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: singleCpu, now: () => clock, capacityDeadlineMs: 60_000 });
  const launched: string[] = [];
  scheduler.submit(input("blocker", { submittedAt: new Date(clock).toISOString() }), launchHandler(scheduler, launched));
  scheduler.submit(input("expires", { submittedAt: new Date(clock).toISOString() }), launchHandler(scheduler, launched));
  clock += 60_001;
  scheduler.tick();
  const expired = scheduler.get("expires")!;
  assert.equal(expired.state, "settled");
  assert.equal(expired.settlement?.outcome, "capacity_timeout");
  assert.equal(expired.settlement?.launched, false);
  assert.deepEqual(launched, ["blocker"]);
});

// Spec 035 / contract 010 acceptance row 3.
test("010 row 3: the run timeout starts after a 25-minute capacity wait", t => {
  let clock = Date.parse("2026-09-30T10:00:00.000Z");
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: singleCpu, now: () => clock });
  const launched: string[] = [];
  scheduler.submit(input("blocker", { submittedAt: new Date(clock).toISOString() }), launchHandler(scheduler, launched));
  scheduler.submit(input("delayed", { submittedAt: new Date(clock).toISOString() }), launchHandler(scheduler, launched));
  clock += 25 * 60_000;
  const blockerStart = scheduler.get("blocker")!.launchedAt!;
  scheduler.settle("blocker", passed("blocker", 1, blockerStart, new Date(clock).toISOString(), 25 * 60_000));
  const delayed = scheduler.get("delayed")!;
  assert.equal(Date.parse(delayed.launchedAt!) - Date.parse(delayed.submittedAt), 25 * 60_000);
  assert.equal(delayed.runTimeoutMs, 30 * 60_000);
  clock += 10 * 60_000;
  const finishedAt = new Date(clock).toISOString();
  scheduler.settle("delayed", passed("delayed", 1, delayed.launchedAt!, finishedAt, 10 * 60_000));
  assert.equal(scheduler.get("delayed")?.settlement?.outcome, "passed");
  assert.deepEqual(launched, ["blocker", "delayed"]);
});

// Spec 035 / contract 010 acceptance row 10.
test("010 row 10: selector history supplies p95 CPU and wall, otherwise the submitted budget applies", t => {
  let clock = Date.parse("2026-09-30T10:00:00.000Z");
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity, now: () => clock });
  for (let sample = 1; sample <= 20; sample++) {
    const id = `history-${sample}`;
    const submittedAt = new Date(clock).toISOString();
    scheduler.submit(input(id, { submittedAt }), { launch: run => { scheduler.markLaunched(run.id); } });
    const launchedAt = scheduler.get(id)!.launchedAt!;
    const endedAt = new Date(clock + 1_000).toISOString();
    scheduler.settle(id, passed(id, 1, launchedAt, endedAt, 1_000, sample * 100), { wallMs: 1_000, cpuMs: sample * 100 });
    clock += 1_001;
  }
  const historical = scheduler.submit(input("measured", { submittedAt: new Date(clock).toISOString() }), { launch: run => { scheduler.markLaunched(run.id); } });
  assert.equal(historical.budget.source, "history");
  assert.equal(historical.budget.cpu, 1.9);
  assert.equal(historical.budget.wallMs, 1_000);

  const fallback = scheduler.submit(input("no-history", { selector: "ci:fresh", submittedAt: new Date(clock).toISOString(), budgetFallback: { cpu: 1, memoryBytes: 256_000_000 } }), { launch: run => { scheduler.markLaunched(run.id); } });
  assert.equal(fallback.budget.source, "fallback");
  assert.deepEqual(fallback.budget, { cpu: 1, memoryBytes: 256_000_000, wallMs: null, source: "fallback" });
});

test("010 row 10: legacy Spec 031 telemetry is matched by exact repository and selector", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  const insert = store.db.prepare("INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?)");
  for (let sample = 1; sample <= 20; sample++) {
    const row = { id: `legacy-qa-${sample}`, key: repository.origin, repository, selector: "qa", argv: ["effigy", "qa"], durationMs: 5000,
      admission: { wallMs: 1000, cpuUserMs: sample * 100, cpuSystemMs: 0, peakRssBytes: sample * 1_000_000 } };
    insert.run(row.id, repository.origin, JSON.stringify(row));
  }
  const wrongSelector = { id: "legacy-qa-short", key: repository.origin, repository, selector: "qa:short", argv: ["effigy", "qa:short"], durationMs: 9000,
    admission: { wallMs: 1000, cpuUserMs: 99_000, cpuSystemMs: 0, peakRssBytes: 99_000_000 } };
  insert.run(wrongSelector.id, repository.origin, JSON.stringify(wrongSelector));
  const run = scheduler.submit(input("legacy-history", { selector: "qa", budgetFallback: { cpu: 1, memoryBytes: 256_000_000 } }),
    { launch: current => { scheduler.markLaunched(current.id); } });
  assert.equal(run.budget.cpu, 1.9);
  assert.equal(run.budget.wallMs, 1000);
  // Task 191: the history memory budget is the observed p95 peak (19 MiB) with a margin.
  assert.equal(run.budget.memoryBytes, Math.ceil(19_000_000 * HISTORY_MEMORY_MARGIN));
});

test("task 191: a legacy peakRss sample at whole-host capacity is discarded, and history memory stays below capacity", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  const insert = store.db.prepare("INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?)");
  // One poisoned sample at the whole host capacity (the 64 GiB milestone QA 73c12ae3
  // recorded, likely a sampler summing shared or virtual memory), beside real peaks.
  for (const [index, peakRssBytes] of [10_000_000, 12_000_000, 68_719_476_736].entries()) {
    const row = { id: `poisoned-qa-${index}`, key: repository.origin, repository, selector: "qa", argv: ["effigy", "qa"], durationMs: 5000,
      admission: { wallMs: 1000, cpuUserMs: 500, cpuSystemMs: 0, peakRssBytes } };
    insert.run(row.id, repository.origin, JSON.stringify(row));
  }
  const run = scheduler.submit(input("poisoned-history", { selector: "qa", budgetFallback: { cpu: 1, memoryBytes: 256_000_000 } }),
    { launch: current => { scheduler.markLaunched(current.id); } });
  assert.equal(run.budget.source, "history");
  assert.ok(run.budget.memoryBytes < 8_000_000_000, `one run must not reserve the whole host capacity (got ${run.budget.memoryBytes})`);
  assert.equal(run.budget.memoryBytes, Math.ceil(12_000_000 * HISTORY_MEMORY_MARGIN));
});

test("task 191: a history memory peak above host capacity clamps strictly below it", t => {
  const store = testStore(t);
  const tiny = () => ({ cpuCapacity: 4, memoryCapacityBytes: 100_000_000, freeMemoryBytes: 100_000_000, loadAverage: [0, 0, 0] });
  const scheduler = new HostRunScheduler(store, { capacity: tiny });
  const insert = store.db.prepare("INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?)");
  // Every sample is legitimate but near capacity; the margin would push past it.
  for (let sample = 0; sample < 5; sample++) {
    const row = { id: `near-cap-${sample}`, key: repository.origin, repository, selector: "qa", argv: ["effigy", "qa"], durationMs: 5000,
      admission: { wallMs: 1000, cpuUserMs: 500, cpuSystemMs: 0, peakRssBytes: 95_000_000 } };
    insert.run(row.id, repository.origin, JSON.stringify(row));
  }
  const run = scheduler.submit(input("near-cap", { selector: "qa", budgetFallback: { cpu: 1, memoryBytes: 256_000_000 } }),
    { launch: current => { scheduler.markLaunched(current.id); } });
  assert.equal(run.budget.source, "history");
  assert.equal(run.budget.memoryBytes, 50_000_000);
});

test("task 191: at 64GiB capacity, poisoned or absent RSS leaves a second heavy run admittable", t => {
  const big = () => ({ cpuCapacity: 4, memoryCapacityBytes: 68_719_476_736, freeMemoryBytes: 68_719_476_736, loadAverage: [0, 0, 0] });
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: big });
  const insert = store.db.prepare("INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?)");
  // Five legacy samples all at whole-host capacity: every one is discarded.
  for (let sample = 0; sample < 5; sample++) {
    const row = { id: `all-poisoned-${sample}`, key: repository.origin, repository, selector: "qa", argv: ["effigy", "qa"], durationMs: 5000,
      admission: { wallMs: 1000, cpuUserMs: 90, cpuSystemMs: 0, peakRssBytes: 68_719_476_736 } };
    insert.run(row.id, repository.origin, JSON.stringify(row));
  }
  const first = scheduler.submit(input("poisoned-first"), { launch: run => { scheduler.markLaunched(run.id); } });
  assert.ok(first.budget.memoryBytes <= 34_359_738_368, `one run must not reserve the whole 64GiB budget (got ${first.budget.memoryBytes})`);
  const second = scheduler.submit(input("poisoned-second", { budgetFallback: { cpu: 1, memoryBytes: 256_000_000 } }),
    { launch: run => { scheduler.markLaunched(run.id); } });
  assert.equal(second.state, "running", "a 256MiB heavy run still fits beside the poisoned-budget run");
});

test("task 191: CPU-only host-run history without RSS still leaves room for a second heavy run", t => {
  const big = () => ({ cpuCapacity: 4, memoryCapacityBytes: 68_719_476_736, freeMemoryBytes: 68_719_476_736, loadAverage: [0, 0, 0] });
  let clock = Date.parse("2026-10-05T00:00:00.000Z");
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: big, now: () => clock });
  const launched: string[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const id = `cpu-only-${sample}`;
    const submittedAt = new Date(clock).toISOString();
    const endedAt = new Date(clock + 1_000).toISOString();
    scheduler.submit(input(id, { submittedAt }), { launch: run => { scheduler.markLaunched(run.id); launched.push(run.id); } });
    const active = scheduler.get(id)!;
    scheduler.settle(id, passed(id, 1, active.launchedAt!, endedAt, 1_000, 90));
    clock += 1_001;
  }
  const next = scheduler.submit(input("cpu-only-next"), { launch: run => { scheduler.markLaunched(run.id); launched.push(run.id); } });
  assert.ok(next.budget.memoryBytes <= 34_359_738_368, `CPU-only history must not reserve the whole budget (got ${next.budget.memoryBytes})`);
  const buddy = scheduler.submit(input("cpu-only-buddy", { budgetFallback: { cpu: 1, memoryBytes: 256_000_000 } }),
    { launch: run => { scheduler.markLaunched(run.id); launched.push(run.id); } });
  assert.equal(buddy.state, "running", "a 256MiB heavy run still fits beside a CPU-only-history run");
});

test("host journal keeps the submission request and a stable client request ID across restart", async t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  scheduler.submit(input("journaled", { caller: "queue:qa:host-run-journal", priority: "milestone" }), { launch: () => {} });
  const journal = store.hostRunJournal("journaled");
  const request = journal.find(row => row.event === "request")!.data as { method: string; input: { caller: string; clientRequestId: string } };
  assert.equal(request.method, "host.run.submit");
  assert.equal(request.input.caller, "queue:qa:host-run-journal");
  assert.equal(typeof request.input.clientRequestId, "string");
  assert.equal(scheduler.get("journaled")?.clientRequestId, request.input.clientRequestId);
  const restarted = new HostRunScheduler(store, { capacity });
  assert.equal(restarted.submit(input("journaled", { caller: "queue:qa:host-run-journal", priority: "milestone" }), { launch: () => {} }).clientRequestId,
    request.input.clientRequestId, "a restart reuses the client request ID stored on the run");
});


test("rejected prelaunch runs settle with the unlaunched contract envelope and terminal facts", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity: () => ({ ...capacity(), cpuCapacity: 1 }) });
  const blocker = scheduler.submit(input("reject-blocker", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchHandler(scheduler, []));
  const queued = scheduler.submit(input("reject-me", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchHandler(scheduler, []));
  assert.equal(blocker.state, "running");
  assert.equal(queued.state, "queued");

  const rejected = scheduler.rejectBeforeLaunch(queued.id, "candidate preparation failed");
  assert.equal(rejected.state, "settled");
  assert.equal(rejected.settlement?.outcome, "cancelled");
  assert.equal(rejected.settlement?.launched, false);
  const journal = store.hostRunJournal(queued.id);
  assert.ok(journal.some(row => row.event === "decision" && (row.data as any).decision === "reject"));
  assert.ok(journal.some(row => row.event === "settlement" && (row.data as any).settlement?.format === "host.run.settlement"));
  assert.ok(journal.some(row => row.event === "capacity_release"));
});

test("a launch callback failure before the durable launch boundary is settled as an unlaunched rejection", async t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  scheduler.submit(input("launch-reject"), { launch: async () => { throw new Error("launch preparation failed"); } });
  await new Promise<void>(resolve => setImmediate(resolve));

  const run = scheduler.get("launch-reject")!;
  assert.equal(run.state, "settled");
  assert.equal(run.settlement?.outcome, "cancelled");
  assert.equal(run.settlement?.launched, false);
  assert.equal(store.hostRunJournal(run.id).some(row => row.event === "launch"), false);
  assert.ok(store.hostRunJournal(run.id).some(row => row.event === "settlement"));
});

test("an error after the launch boundary stays reserved until result reconciliation", async t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  scheduler.submit(input("launch-uncertain"), { launch: async run => {
    scheduler.markLaunched(run.id);
    throw new Error("supervisor handoff uncertain");
  } });
  await new Promise<void>(resolve => setImmediate(resolve));

  const run = scheduler.get("launch-uncertain")!;
  assert.equal(run.state, "running");
  assert.equal(run.settlement, null);
  assert.equal(run.capacityReleasedAt, null);
  assert.ok(store.hostRunJournal(run.id).some(row => row.event === "launch_failure"));
});

test("container and escaped-descendant holds release with recorded operator reasons", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  const launched: string[] = [];
  scheduler.submit(input("container-owner"), launchHandler(scheduler, launched));
  const run = scheduler.get("container-owner")!;
  scheduler.settle(run.id, passed(run.id, 1, run.launchedAt!, new Date(Date.parse(run.launchedAt!) + 10).toISOString(), 10, 1,
    [{ runtime: "docker", id: "container-1", removed: "unknown" }]));
  scheduler.submit(input("waiting"), launchHandler(scheduler, launched));
  const removal = { factId: "fact-remove-1", observedAt: new Date().toISOString(), runId: run.id, epoch: 1, runtime: "docker", containerId: "container-1", event: "removed" as const, removed: true as const };
  scheduler.reportContainerFact(removal);
  const afterFirst = scheduler.get(run.id)!;
  scheduler.reportContainerFact(removal);
  assert.deepEqual(scheduler.get(run.id)!.containers, afterFirst.containers);
  scheduler.reportContainerFact({ ...removal, factId: "fact-start-late", event: "started", removed: undefined });
  assert.equal(scheduler.get(run.id)!.containers[0]!.removed, true);
  assert.equal(scheduler.get("waiting")?.state, "running");
  const waiting = scheduler.get("waiting")!;
  scheduler.settle(waiting.id, passed(waiting.id, 1, waiting.launchedAt!, new Date(Date.parse(waiting.launchedAt!) + 10).toISOString(), 10, 1));

  scheduler.submit(input("operator-owner"), launchHandler(scheduler, launched));
  const operatorRun = scheduler.get("operator-owner")!;
  scheduler.settle(operatorRun.id, passed(operatorRun.id, 1, operatorRun.launchedAt!, new Date(Date.parse(operatorRun.launchedAt!) + 10).toISOString(), 10, 1,
    [{ runtime: "docker", id: "container-2", removed: false }]));
  const released = scheduler.releaseCapacity(operatorRun.id, "Container stopped by the operator and verified absent");
  assert.ok(released.capacityReleasedAt);
  assert.equal(released.capacityReleaseReason, "Container stopped by the operator and verified absent");
  assert.ok(store.hostRunJournal(operatorRun.id).some(row => row.event === "capacity_release" && (row.data as any).operator === true));

  scheduler.submit(input("final-removal"), launchHandler(scheduler, launched));
  const finalRun = scheduler.get("final-removal")!;
  const started = { factId: "fact-start-2", observedAt: new Date().toISOString(), runId: finalRun.id, epoch: 1,
    runtime: "docker", containerId: "container-final", event: "started" as const };
  scheduler.reportContainerFact(started);
  scheduler.reportContainerFact({ ...started, factId: "fact-remove-2", event: "removed", removed: true });
  const endedAt = new Date(Date.parse(finalRun.launchedAt!) + 100).toISOString();
  const settled = scheduler.settle(finalRun.id, passed(finalRun.id, 1, finalRun.launchedAt!, endedAt, 100, 1,
    [{ runtime: "docker", id: "container-final", removed: false }]));
  assert.equal(settled.containers[0]?.removed, true);
  assert.equal(settled.settlement?.containers[0]?.removed, true);
});

test("an operator can release escaped-descendant capacity with a recorded reason", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  scheduler.submit(input("escaped-operator"), launchHandler(scheduler, []));
  const escapedRun = scheduler.get("escaped-operator")!;
  const escapedEnd = new Date(Date.parse(escapedRun.launchedAt!) + 10).toISOString();
  const escapedResult = hostRunResultSchema.parse({ ...result(escapedRun.id, 1, escapedRun.launchedAt!, escapedEnd, 10),
    escapedDescendants: [{ pid: 9001, startIdentity: "9001@escaped" }] });
  scheduler.settle(escapedRun.id, hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1,
    runId: escapedRun.id, outcome: "passed", launched: true, settledAt: escapedEnd, result: escapedResult, containers: [] }));
  assert.equal(scheduler.get(escapedRun.id)?.capacityReleasedAt, null);

  const reason = "Operator reviewed the escaped process and accepts the remaining load";
  const released = scheduler.releaseCapacity(escapedRun.id, reason);
  assert.equal(released.capacityReleaseKind, "operator");
  assert.equal(released.capacityReleaseReason, reason);
  assert.ok(store.hostRunJournal(escapedRun.id).some(row => row.event === "capacity_release"
    && (row.data as any).operator === true && (row.data as any).reason === reason));
});

test("a delayed container start reacquires capacity after escaped descendants are proven dead", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  scheduler.submit(input("escaped-then-container"), launchHandler(scheduler, []));
  const run = scheduler.get("escaped-then-container")!;
  const endedAt = new Date(Date.parse(run.launchedAt!) + 10).toISOString();
  const escaped = [{ pid: 9002, startIdentity: "9002@escaped" }];
  const escapedResult = hostRunResultSchema.parse({ ...result(run.id, 1, run.launchedAt!, endedAt, 10), escapedDescendants: escaped });
  scheduler.settle(run.id, hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1,
    runId: run.id, outcome: "passed", launched: true, settledAt: endedAt, result: escapedResult, containers: [] }));
  scheduler.markEscapedDescendantsDead(run.id, escaped);
  assert.ok(scheduler.get(run.id)?.capacityReleasedAt);

  scheduler.reportContainerFact({ factId: "late-container-start", observedAt: new Date().toISOString(), runId: run.id,
    epoch: run.epoch, runtime: "docker", containerId: "late-container", event: "started" });
  assert.equal(scheduler.get(run.id)?.capacityReleasedAt, null);
  assert.equal(scheduler.list().some(item => item.id === run.id), true);
});

test("classification follows literal included task tables and defaults filtered test to light", async t => {
  const dir = await mkdtemp(join(tmpdir(), "host-run-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "effigy.toml"), 'include = ["tasks.toml"]\n');
  await writeFile(join(dir, "tasks.toml"), '[tasks."qa:short"]\nadmission = "light"\n');
  assert.deepEqual(classifyHostRun(dir, "qa:short"), { runClass: "light", classSource: "manifest" });
  assert.deepEqual(classifyHostRun(dir, "test", true), { runClass: "light", classSource: "default" });
  assert.deepEqual(classifyHostRun(dir, "test"), { runClass: "heavy", classSource: "default" });
});

test("a run with no CPU history reserves at most half the CPU, default or declared, so two unmeasured runs fit side by side (Tom, 2026-10-21)", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  const launched: string[] = [];
  const first = scheduler.submit(input("unmeasured-a", { selector: "proof:a" }), { launch: run => { launched.push(run.id); scheduler.markLaunched(run.id); } });
  const second = scheduler.submit(input("unmeasured-b", { selector: "proof:b", budgetFallback: { cpu: 4, memoryBytes: 8_000_000_000 } }), { launch: run => { launched.push(run.id); scheduler.markLaunched(run.id); } });
  assert.deepEqual([first.budget.cpu, first.budget.source], [4 * NO_HISTORY_CPU_SHARE, "fallback"]);
  assert.deepEqual(launched, ["unmeasured-a", "unmeasured-b"], "neither reserves the whole box");
  assert.equal(second.budget.cpu, 2, "a declared whole-box envelope is capped at half");
  const small = scheduler.submit(input("unmeasured-small", { selector: "proof:small", budgetFallback: { cpu: 0.5, memoryBytes: 1_000_000 } }), { launch: run => { scheduler.markLaunched(run.id); } });
  assert.equal(small.budget.cpu, 0.5, "a smaller declared envelope is used as given");
});

test("a measured history above the heavy CPU capacity is budgeted at capacity, so the run can still be admitted", t => {
  const store = testStore(t), scheduler = new HostRunScheduler(store, { capacity });
  for (let sample = 1; sample <= 5; sample++) {
    const id = `wide-${sample}`;
    scheduler.submit(input(id, { selector: "qa:wide" }), { launch: run => { scheduler.markLaunched(run.id); } });
    const launchedAt = scheduler.get(id)!.launchedAt!;
    const endedAt = new Date(Date.parse(launchedAt) + 1_000).toISOString();
    scheduler.settle(id, passed(id, 1, launchedAt, endedAt, 1_000, 12_000), { wallMs: 1_000, cpuMs: 12_000 });
  }
  const wide = scheduler.submit(input("wide-next", { selector: "qa:wide" }), { launch: run => { scheduler.markLaunched(run.id); } });
  assert.deepEqual([wide.budget.cpu, wide.budget.source], [4, "history"], "12 cores measured, 4 budgeted");
  assert.ok(scheduler.get("wide-next")!.launchedAt, "and it is admitted");
});
