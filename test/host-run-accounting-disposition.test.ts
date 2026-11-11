import { RuntimeRepositories, type RepositoriesContext } from "../core/runtime/repositories";
/**
 * Spec 035, "Operator accounting disposition".
 *
 * These tests use the real public owner route (`QueueRuntime`'s own method
 * bodies) over real scheduler records, not engine- or store-only calls. They
 * cover the shape that had no supported exit — a launched admission reservation
 * with no trusted runtime binding, still running with unknown outcome and still
 * charged — and pin what the disposition does and does not release: accounting
 * stops, and outcome, settlement, custody, containers, workspace, history and
 * every pinned contract 010 shape stay exactly as they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HISTORY_RETENTION_MS, Store } from "../core/store/store";
import { HostRunScheduler, type HostRunSubmission } from "../core/host-runs/host-run-scheduler";
import { QueueRuntime } from "../service/runtime-owner";
import {
  HOST_RUN_ACCOUNTING_DISPOSITION_META_PREFIX, hostRunAccountingDispositionMetaKey, hostRunAccountingInputHash,
  hostRunPublicDigest,
} from "../core/host-runs/host-run-accounting";
import {
  hostRunAccountingDispose, hostRunAccountingStatus, hostRunCapacityReleaseInputSchema, hostRunList,
  hostRunRecordSchema, hostRunResultSchema, hostRunSettlementSchema, type HostRunAccountingDisposeInput,
  type HostRunAccountingList, type HostRunAccountingStatusInput, type HostRunInternalRecord,
} from "../shared/contracts";
import { contractDigest, rpcContractDigest } from "../shared/rpc-contracts";
import { frozenHostRunRecordSchema, frozenHostRunSettlementSchema } from "./support/contract-010-frozen";

const repository = { origin: "https://github.com/example/accounting", path: "/repo/accounting" };
const capacity = (cpuCapacity = 4) => () => ({ cpuCapacity, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });
const input = (id: string, overrides: Partial<HostRunSubmission> = {}): HostRunSubmission => ({
  id, epoch: 1, caller: `test:${id}`, repository, selector: "qa", runClass: "heavy", classSource: "default",
  priority: "milestone", runTimeoutMs: 30 * 60_000, submissionSource: "admission", effigyRunId: id,
  budgetFallback: { cpu: 1, memoryBytes: 100 }, ...overrides,
});
const launchedHandler = (scheduler: HostRunScheduler) => ({
  launch: (run: { id: string }) => { scheduler.markLaunched(run.id); },
});

function harness(t: any, cpuCapacity = 4) {
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity: capacity(cpuCapacity) });
  t.after(() => { scheduler.stop(); store.close(); });
  return { store, scheduler };
}

/**
 * The Project-E 182 shape: an admission reservation that was admitted and launched
 * with no trusted runtime binding, so it is running with unknown outcome and no
 * observation route that could ever produce a real terminal result.
 */
function unboundReservation(h: { store: Store; scheduler: HostRunScheduler }, id: string, overrides: Partial<HostRunSubmission> = {}) {
  h.scheduler.submit(input(id, overrides), launchedHandler(h.scheduler));
  const run = h.scheduler.get(id)!;
  h.scheduler.bindEffigyRuntime(id, { kind: "unbound", reason: "no trusted Effigy runtime binding was recorded for this reservation" });
  return h.scheduler.get(id)!;
}

/** Host-run-only context for the real public delegates; store access marking is inert. */
function publicRouter(h: { scheduler: HostRunScheduler }) {
  return { repositories: new RuntimeRepositories({
    markStoreAccess() {},
    hostRuns: h.scheduler,
  } as unknown as RepositoriesContext) };
}
const publicList = (h: { scheduler: HostRunScheduler }) =>
  (QueueRuntime.prototype.listHostRuns as unknown as (this: unknown) => unknown[]).call(publicRouter(h));
const publicStatus = (h: { scheduler: HostRunScheduler }, runId: string) =>
  (QueueRuntime.prototype.hostRunAccountingStatus as unknown as (this: unknown, input: HostRunAccountingStatusInput) => unknown)
    .call(publicRouter(h), { runId });
const publicDispose = (h: { scheduler: HostRunScheduler }, body: HostRunAccountingDisposeInput) =>
  (QueueRuntime.prototype.disposeHostRunAccounting as unknown as (this: unknown, input: HostRunAccountingDisposeInput) => unknown)
    .call(publicRouter(h), body);

function disposeBody(h: { scheduler: HostRunScheduler }, run: HostRunInternalRecord, overrides: Partial<HostRunAccountingDisposeInput> = {}): HostRunAccountingDisposeInput {
  const status = (QueueRuntime.prototype.hostRunAccountingStatus as unknown as (this: unknown, input: { runId: string }) => { runDigest: string })
    .call(publicRouter(h), { runId: run.id });
  return {
    runId: run.id,
    operationId: `accounting-${run.id}`,
    expectedEpoch: 1,
    expectedRunDigest: status.runDigest,
    authority: { caller: "operator (board)" },
    acceptance: { scope: "exact_run", runId: run.id, epoch: 1, unknownOutcomeRetained: true,
      reason: "Retire this reservation's accounting; its outcome and runtime custody stay unknown" },
    reason: "Operator retires the unverifiable reservation's accounting, not its outcome",
    ...overrides,
  };
}

const summary = (h: { scheduler: HostRunScheduler }) => h.scheduler.summary();
const violation = (fn: () => unknown, pattern: RegExp) => {
  let error: unknown = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error, "the call refused");
  assert.match(error.message, pattern);
};

const lateSettlement = (run: HostRunInternalRecord, endedAt: string, containers: Array<{ runtime: string; id: string; removed: boolean | "unknown" }> = []) =>
  hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: run.id, outcome: "failed", launched: true, settledAt: endedAt,
    result: hostRunResultSchema.parse({
      format: "host.run.result", version: 1, runId: run.id, epoch: run.epoch, pgid: 9001, startIdentity: "9001@2026-10-25T10:00:00Z",
      exitCode: 1, signal: null, startedAt: run.launchedAt!, endedAt, wallMs: 5000, cpuMs: 10, escapedDescendants: [],
    }),
    containers,
  });

// The parent falsification: today's surface refuses the unsettled row and there
// is no independent accounting exit, so the slot stays charged forever.
test("the settled-only release surface still refuses a running reservation and leaves accounting charged", t => {
  const h = harness(t);
  const run = unboundReservation(h, "project-e-shape");
  assert.equal(run.state, "running");
  assert.equal(summary(h).reservedCpu, 1, "the unknown reservation is charged");

  violation(() => h.scheduler.releaseCapacity(run.id, "operator releases the container"), /only after the host run settles/);
  violation(() => (QueueRuntime.prototype.releaseHostRunCapacity as unknown as (this: unknown, input: { runId: string; reason: string }) => unknown)
    .call(publicRouter(h), { runId: run.id, reason: "operator releases the container" }), /only after the host run settles/);
  assert.equal(summary(h).reservedCpu, 1, "nothing released the accounting");
  assert.equal(h.store.hostRunAccountingDispositionRaw(run.id), undefined);
  assert.equal(h.store.hostRunJournal(run.id).some(entry => entry.event === "accounting_disposition"), false);
});

test("a row written by a build with no admission identity at all can still be disposed of", t => {
  // The oldest shape: no `submissionSource`, no Effigy run id, no binding. Queue
  // reads it as its own reservation and it is just as unobservable.
  const h = harness(t);
  h.scheduler.submit(input("legacy-unmarked", { submissionSource: undefined, effigyRunId: undefined }), launchedHandler(h.scheduler));
  const legacy = h.scheduler.get("legacy-unmarked")!;
  assert.equal(legacy.submissionSource, "queue");
  assert.equal(legacy.effigyRuntime, undefined);
  assert.equal(summary(h).reservedCpu, 1);
  const view = publicDispose(h, disposeBody(h, legacy)) as { accounting: string; disposition: { observed: { effigyRunId: string | null } } };
  assert.equal(view.accounting, "retired");
  assert.equal(view.disposition.observed.effigyRunId, null);
  assert.equal(summary(h).reservedCpu, 0);
  assert.equal(h.scheduler.get(legacy.id)!.state, "running");
});

test("the public owner route retires an old unbound running row's accounting and nothing else", t => {
  const h = harness(t);
  const run = unboundReservation(h, "project-e-4cc8e391");
  const before = publicStatus(h, run.id) as { accounting: string; runDigest: string; record: Record<string, unknown> };
  assert.equal(before.accounting, "charged");
  assert.equal(before.runDigest, hostRunPublicDigest(run));

  const view = publicDispose(h, disposeBody(h, run)) as {
    accounting: string; disposition: Record<string, any> | null; dispositionReadable: boolean;
    record: Record<string, any>; runDigest: string;
  };
  assert.equal(hostRunAccountingDispose.output.safeParse(view).success, true, "the real output parses");
  assert.equal(view.accounting, "retired");
  assert.equal(view.dispositionReadable, true);
  assert.equal(view.disposition?.disposition, "accounting_retired");
  assert.equal(view.disposition?.authority.role, "operator");
  assert.equal(view.disposition?.acceptance.scope, "exact_run");
  assert.equal(view.disposition?.acceptance.unknownOutcomeRetained, true);
  assert.equal(view.disposition?.observed.state, "running");
  assert.equal(view.disposition?.observed.effigyRuntime, null);
  assert.equal(view.disposition?.observed.effigyRuntimeRefusal, "no trusted Effigy runtime binding was recorded for this reservation");

  // No invented terminal, cancellation, custody or physical credit.
  assert.equal(view.record.state, "running");
  assert.equal(view.record.settledAt, null);
  assert.equal(view.record.settlement, null);
  assert.equal(view.record.capacityReleasedAt, null);
  assert.equal(view.record.capacityReleaseKind, null);
  assert.equal(view.record.launchedAt, run.launchedAt);
  assert.deepEqual(view.record.containers, []);
  const stored = h.scheduler.get(run.id)!;
  assert.equal(stored.state, "running");
  assert.equal(stored.settlement, null);
  assert.equal(stored.capacityReleasedAt, null);
  assert.ok(stored.effigyRuntimeRefusal, "the original refusal is preserved, not erased");

  // Accounting stops exactly at the disposition; nothing physical changed.
  assert.equal(summary(h).reservedCpu, 0);
  assert.equal(summary(h).reservedMemoryBytes, 0);
  assert.equal(summary(h).running, 1, "it is still a running run, not a settled one");
  assert.equal(h.store.hostRunJournal(run.id).some(entry => entry.event === "settlement"), false);
  assert.equal(h.store.hostRunJournal(run.id).some(entry => entry.event === "capacity_release"), false);
  assert.equal(h.store.hostRunJournal(run.id).filter(entry => entry.event === "accounting_disposition").length, 1);
  const fact = h.store.hostRunJournal(run.id).find(entry => entry.event === "accounting_disposition")!.data as Record<string, any>;
  assert.equal(fact.disposition, "accounting_retired");
  assert.equal(fact.acceptance.unknownOutcomeRetained, true);
  assert.equal(fact.observed.state, "running");

  // The row stays visible; it no longer holds its workspace (Tom, 2026-10-25:
  // "Both release"), so its task can archive while custody stays unknown.
  assert.ok((publicList(h) as Array<{ id: string }>).some(record => record.id === run.id));
  assert.equal(h.store.hostRunHoldingWorkspace(repository.path), null);
  const inventory = h.store.qaUnsettledInventory().find(item => item.kind === "host_run" && item.id === run.id);
  assert.ok(inventory, "the unsettled run is still an inventory item");
  assert.match(inventory!.detail, /retired its accounting.*custody stay unknown/);
});

test("authority and the separate exact-run acceptance are both required, and a forged relay refuses", t => {
  const h = harness(t);
  const run = unboundReservation(h, "authority");

  violation(() => publicDispose(h, disposeBody(h, run, { authority: { caller: "some-agent" } })), /needs the operator at the board/);
  violation(() => publicDispose(h, disposeBody(h, run, { authority: { caller: "operator (board)", relayed: true, note: "the operator said to" } })),
    /names the relaying caller, not the operator/);
  violation(() => publicDispose(h, disposeBody(h, run, { authority: { caller: "relay-agent", relayed: true } })), /requires the operator's authorization note/);
  violation(() => publicDispose(h, disposeBody(h, run, { authority: { caller: "relay-agent", note: "note without relayed" } })),
    /A note records a relayed authorization/);
  violation(() => publicDispose(h, disposeBody(h, run, {
    acceptance: { scope: "exact_run", runId: "another-run", epoch: 1, unknownOutcomeRetained: true, reason: "accept" },
  })), /names a different host run/);
  violation(() => publicDispose(h, disposeBody(h, run, {
    acceptance: { scope: "exact_run", runId: run.id, epoch: 2, unknownOutcomeRetained: true, reason: "accept" },
  })), /names another epoch/);
  violation(() => publicDispose(h, disposeBody(h, run, { expectedEpoch: 2 })), /stale_epoch/);
  violation(() => publicDispose(h, disposeBody(h, run, { expectedRunDigest: "a".repeat(64) })), /changed since it was read/);
  // The acceptance cannot be omitted or watered down: it is a separate explicit
  // exact-run risk acceptance, not the authority's by-product.
  const noAcceptance = disposeBody(h, run) as Record<string, unknown>;
  delete noAcceptance.acceptance;
  violation(() => publicDispose(h, noAcceptance as unknown as HostRunAccountingDisposeInput), /acceptance/i);
  violation(() => publicDispose(h, disposeBody(h, run, {
    acceptance: { scope: "exact_run", runId: run.id, epoch: 1, unknownOutcomeRetained: false as never, reason: "accept" },
  })), /acceptance/i);
  assert.equal(summary(h).reservedCpu, 1, "no refusal released accounting");
  assert.equal(h.store.hostRunAccountingDispositionRaw(run.id), undefined);
  assert.equal(h.store.hostRunJournal(run.id).some(entry => entry.event === "accounting_disposition"), false);

  // A truthful relay with the operator's note is authority.
  const relayed = publicDispose(h, disposeBody(h, run, {
    authority: { caller: "relay-agent", relayed: true, note: "Tom: retire that reservation's accounting, outcome stays unknown" },
  })) as { accounting: string; disposition: { authority: { role: string; caller: string; note: string | null } } };
  assert.equal(relayed.accounting, "retired");
  assert.deepEqual([relayed.disposition.authority.role, relayed.disposition.authority.caller],
    ["authorized_relay", "relay-agent"]);
  assert.match(relayed.disposition.authority.note!, /^Tom: retire/);
});

test("only a launched reservation with unknown outcome can be disposed of, and a known effect refuses", t => {
  // A queued reservation is not charged yet and has an ordinary path.
  const queuedStore = harness(t, 1);
  queuedStore.scheduler.submit(input("blocker", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchedHandler(queuedStore.scheduler));
  queuedStore.scheduler.submit(input("waiting", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchedHandler(queuedStore.scheduler));
  const queued = queuedStore.scheduler.get("waiting")!;
  assert.equal(queued.state, "queued");
  violation(() => publicDispose(queuedStore, disposeBody(queuedStore, queued)), /launched reservation whose outcome is unknown/);
  assert.equal(queuedStore.store.hostRunAccountingDispositionRaw(queued.id), undefined);

  // A known settlement is not unknown, and keeps its ordinary path.
  const h = harness(t);
  const settled = unboundReservation(h, "settled-known");
  const at = new Date(Date.parse(settled.launchedAt!) + 1000).toISOString();
  h.scheduler.settle(settled.id, lateSettlement(settled, at));
  const settledNow = h.scheduler.get(settled.id)!;
  violation(() => publicDispose(h, disposeBody(h, settledNow)), /already has a settlement/);
  assert.equal(h.store.hostRunAccountingDispositionRaw(settled.id), undefined);
});

test("an unknown concurrent effect on the row refuses on the version the operator read", t => {
  const h = harness(t);
  const run = unboundReservation(h, "concurrent");
  const read = disposeBody(h, run);
  // A container report arrives between the operator's read and their decision.
  h.scheduler.reportContainerFact({ factId: "concurrent-container", observedAt: new Date().toISOString(), runId: run.id,
    epoch: run.epoch, runtime: "docker", containerId: "container-1", event: "started" });
  violation(() => publicDispose(h, read), /changed since it was read/);
  assert.equal(summary(h).reservedCpu, 1);
  assert.equal(h.store.hostRunAccountingDispositionRaw(run.id), undefined);
  // A fresh read and decision goes through, and the container stays recorded.
  const view = publicDispose(h, disposeBody(h, run)) as { record: { containers: Array<{ containerId: string }> } };
  assert.equal(view.record.containers[0]?.containerId, "container-1");
  assert.equal(summary(h).reservedCpu, 0);
});

test("an admitted reservation that never launched keeps its ordinary path", t => {
  const h = harness(t);
  h.scheduler.submit(input("admitted"), { launch: () => { /* the launch never crosses its durable boundary */ } });
  const admitted = h.scheduler.get("admitted")!;
  assert.equal(admitted.state, "admitted");
  assert.equal(summary(h).reservedCpu, 1, "an admitted row is charged until it launches or settles");
  violation(() => publicDispose(h, disposeBody(h, admitted)), /never launched/);
  assert.equal(h.store.hostRunAccountingDispositionRaw(admitted.id), undefined);
});

test("a lost reply is observed through the same operation; a mutated retry and a second operation refuse", t => {
  const h = harness(t);
  const run = unboundReservation(h, "idempotent");
  const body = disposeBody(h, run);
  const first = publicDispose(h, body) as { accounting: string; disposition: { disposedAt: string; operationId: string } };
  assert.equal(first.accounting, "retired");
  const journalCount = () => h.store.hostRunJournal(run.id).filter(entry => entry.event === "accounting_disposition").length;
  assert.equal(journalCount(), 1);

  // The retry is the observation, not a replay: same disposition, one fact.
  const retried = publicDispose(h, body) as typeof first;
  assert.equal(retried.accounting, "retired");
  assert.equal(retried.disposition.disposedAt, first.disposition.disposedAt);
  assert.equal(retried.disposition.operationId, first.disposition.operationId);
  assert.equal(journalCount(), 1);
  assert.equal(h.store.hostRunAccountingDispositionRaw(run.id) !== undefined, true);

  // A mutated retry under the same operation id is not the same input.
  violation(() => publicDispose(h, { ...body, reason: "a different reason after a lost reply" }), /already belongs to a different input/);
  // A second operation does not dispose of it again either.
  violation(() => publicDispose(h, { ...body, operationId: "accounting-second-op" }), /already retired for this run by operation/);
  assert.equal(journalCount(), 1);
  assert.equal(summary(h).reservedCpu, 0);
});

test("retiring accounting frees the slot another admission was queued for, and the disposed run stays unknown", t => {
  const h = harness(t, 1);
  const holder = unboundReservation(h, "holder");
  h.scheduler.submit(input("next", { budgetFallback: { cpu: 1, memoryBytes: 100 } }), launchedHandler(h.scheduler));
  assert.equal(h.scheduler.get("next")!.state, "queued");
  assert.equal(h.scheduler.get("next")!.position, 1);

  publicDispose(h, disposeBody(h, holder));
  assert.equal(h.scheduler.get("next")!.state, "running", "the freed accounting admitted the queued run");
  const still = h.scheduler.get(holder.id)!;
  assert.equal(still.state, "running");
  assert.equal(still.settlement, null);
  assert.equal(summary(h).reservedCpu, 1, "one live reservation is now charged: the newly admitted one");
});

test("late genuine terminal evidence reconciles without resurrecting, recharging or laundering the UNKNOWN", t => {
  const h = harness(t);
  const run = unboundReservation(h, "late-terminal");
  const disposed = publicDispose(h, disposeBody(h, run)) as { disposition: { disposedAt: string } };

  const endedAt = new Date(Date.parse(run.launchedAt!) + 5000).toISOString();
  const settled = h.scheduler.settle(run.id, lateSettlement(run, endedAt, [{ runtime: "docker", id: "container-late", removed: false }]));
  assert.equal(settled.state, "settled");
  assert.equal(settled.settlement?.outcome, "failed");
  assert.equal(settled.settlement?.result?.exitCode, 1);
  assert.equal(settled.settlement?.launched, true);
  assert.equal(settled.capacityReleasedAt, null, "the open container still holds custody");
  assert.equal(summary(h).reservedCpu, 0, "the retired accounting does not resume charging");

  const after = h.scheduler.get(run.id)!;
  assert.equal(after.state, "settled");
  assert.equal(summary(h).running, 0);
  assert.equal(publicStatus(h, "no-such-run"), null, "an unknown run has no accounting view");
  const status = publicStatus(h, run.id) as { accounting: string; disposition: { disposedAt: string } | null };
  assert.equal(status.accounting, "retired");
  assert.equal(status.disposition?.disposedAt, disposed.disposition.disposedAt, "the original disposition is history, not rewritten");
  // The earlier UNKNOWN is not laundered into a success, and the late failure is
  // not undone: the row keeps its real observed result.
  assert.equal(after.settlement?.result?.exitCode, 1);
  // The operator's separate settled-custody surface still owns the container.
  const released = h.scheduler.releaseCapacity(run.id, "operator confirmed the late container is gone");
  assert.equal(released.capacityReleaseKind, "operator");
  assert.equal(summary(h).reservedCpu, 0);
  assert.equal(h.scheduler.get(run.id)!.settlement?.result?.exitCode, 1, "releasing custody never rewrites the result");
});

test("a settled run's accounting disposition survives a restart and keeps the slot retired", t => {
  const dir = mkdtempSync(join(tmpdir(), "host-run-accounting-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.db");
  const first = new Store(path);
  const scheduler = new HostRunScheduler(first, { capacity: capacity() });
  scheduler.submit(input("persisted"), launchedHandler(scheduler));
  const run = scheduler.get("persisted")!;
  scheduler.bindEffigyRuntime(run.id, { kind: "unbound", reason: "unbound" });
  const body = disposeBody({ scheduler }, run);
  scheduler.disposeAccounting(body);
  assert.equal(scheduler.summary().reservedCpu, 0);
  scheduler.stop();
  first.close();

  const second = new Store(path);
  const reopened = new HostRunScheduler(second, { capacity: capacity() });
  t.after(() => { reopened.stop(); second.close(); });
  const status = reopened.accountingStatus(run.id)!;
  assert.equal(status.accounting, "retired");
  assert.equal(status.record.state, "running");
  assert.equal(reopened.summary().reservedCpu, 0, "the charge does not come back after a restart");
  // The same operation is observable on the reopened store too.
  assert.equal(reopened.disposeAccounting(body).disposition?.operationId, body.operationId);
  assert.equal(second.hostRunJournal(run.id).filter(entry => entry.event === "accounting_disposition").length, 1);
  // Late evidence after the restart still does not recharge the retired slot.
  const endedAt = new Date(Date.parse(run.launchedAt!) + 10).toISOString();
  reopened.settle(run.id, lateSettlement(run, endedAt, [{ runtime: "docker", id: "late", removed: false }]));
  assert.equal(reopened.summary().reservedCpu, 0);
});

test("the pinned contract 010 record, both method digests and the frozen decoder stay exactly compatible", t => {
  const h = harness(t);
  const run = unboundReservation(h, "pinned");
  publicDispose(h, disposeBody(h, run));

  const listed = publicList(h) as HostRunInternalRecord[];
  assert.equal(hostRunList.output.safeParse(listed).success, true);
  for (const record of listed) {
    const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    assert.equal(frozenHostRunRecordSchema.safeParse(serialized).success, true, "the serialized record is contract 010's");
    assert.deepEqual(["effigyRuntime", "effigyRunId", "accounting", "disposition", "runDigest"].filter(key => key in serialized), []);
  }
  const row = h.store.db.prepare("SELECT data FROM host_run_records WHERE id=?").get(run.id) as { data: string };
  const storedRow = JSON.parse(row.data) as Record<string, unknown>;
  assert.equal(frozenHostRunRecordSchema.safeParse(storedRow).success, true, "the stored row keeps the pinned shape");
  assert.deepEqual(z.toJSONSchema(hostRunRecordSchema, { io: "input" }), z.toJSONSchema(frozenHostRunRecordSchema, { io: "input" }));
  const pinnedRelease = { input: hostRunCapacityReleaseInputSchema, output: frozenHostRunRecordSchema };
  assert.equal(contractDigest(pinnedRelease, "host.run.capacity.release"), rpcContractDigest("host.run.capacity.release"));
  const pinnedList = { input: z.object({}).strict(), output: z.array(frozenHostRunRecordSchema) };
  assert.equal(contractDigest(pinnedList, "host.run.list"), rpcContractDigest("host.run.list"));
  // The pinned release method keeps its own settled-only meaning: the
  // disposition never makes a running row look settled to it.
  violation(() => h.scheduler.releaseCapacity(run.id, "release"), /only after the host run settles/);
  // The disposition is never a settlement shape either.
  assert.equal(frozenHostRunSettlementSchema.safeParse((h.scheduler.get(run.id) as { settlement: unknown }).settlement).success, false);
});

test("journal keeps the disposition out of every pinned record shape and adds no fact type", t => {
  const h = harness(t);
  const run = unboundReservation(h, "streamed");
  publicDispose(h, disposeBody(h, run));
  const journal = h.store.hostRunJournal(run.id);
  const disposition = journal.find(entry => entry.event === "accounting_disposition")!;
  const data = disposition.data as { disposition?: string; epoch?: number; record?: unknown; capacityReleasedAt?: unknown };
  assert.equal(data.disposition, "accounting_retired", "the disposition is a host-run journal event, not a new record type");
  assert.equal(data.epoch, run.epoch);
  assert.deepEqual(["record", "capacityReleasedAt"].filter(key => key in data), []);
  // The pinned submit request is untouched.
  const request = journal.find(entry => entry.event === "request")!.data as { input: Record<string, unknown> };
  assert.deepEqual(["accounting", "disposition", "expectedRunDigest"].filter(key => key in request.input), []);
  assert.equal(HOST_RUN_ACCOUNTING_DISPOSITION_META_PREFIX, "hostRunAccountingDisposition:");
});

test("an unreadable or stale stored disposition is charged, never a silent release", t => {
  const h = harness(t);
  const run = unboundReservation(h, "unreadable");
  h.store.setMeta(hostRunAccountingDispositionMetaKey(run.id), { broken: true });
  const status = publicStatus(h, run.id) as { accounting: string; dispositionReadable: boolean; disposition: unknown };
  assert.equal(status.accounting, "charged", "an unreadable disposition does not free the slot");
  assert.equal(status.dispositionReadable, false);
  assert.equal(status.disposition, null);
  assert.equal(summary(h).reservedCpu, 1);
  violation(() => publicDispose(h, disposeBody(h, run)), /cannot be read against its epoch/);

  // A disposition that names another epoch is stale evidence, not a release.
  const other = unboundReservation(h, "stale-epoch");
  const body = disposeBody(h, other);
  publicDispose(h, body);
  const stored = h.store.hostRunAccountingDispositionRaw(other.id) as Record<string, unknown>;
  h.store.setMeta(hostRunAccountingDispositionMetaKey(other.id), { ...stored, epoch: 9 });
  assert.equal((publicStatus(h, other.id) as { accounting: string }).accounting, "charged");
  assert.equal(summary(h).reservedCpu, 2, "both defensively charged rows still count");
});

test("the digest is the pinned record's, and the disposition records the exact input and evidence", t => {
  const h = harness(t);
  const run = unboundReservation(h, "evidence");
  const body = disposeBody(h, run);
  publicDispose(h, body);
  const stored = h.store.hostRunAccountingDispositionRaw(run.id) as Record<string, any>;
  assert.equal(stored.runId, run.id);
  assert.equal(stored.epoch, run.epoch);
  assert.equal(stored.inputHash, hostRunAccountingInputHash(body));
  assert.equal(stored.expectedRunDigest, hostRunPublicDigest(run));
  assert.equal(stored.observed.budget.cpu, run.budget.cpu);
  assert.equal(stored.observed.launchedAt, run.launchedAt);
  assert.equal(stored.observed.settledAt, null);
  assert.equal(stored.acceptance.reason, body.acceptance.reason);
  assert.equal(Number.isNaN(Date.parse(stored.disposedAt)), false);
  assert.equal(hostRunAccountingDispose.output.safeParse(publicStatus(h, run.id)).success, true);
});

const publicAccountingList = (h: { scheduler: HostRunScheduler }) =>
  (QueueRuntime.prototype.hostRunAccountingList as unknown as (this: unknown) => HostRunAccountingList).call(publicRouter(h));

// Spec 035 "Retired runs on the board": the bounded bulk read the board uses
// beside the pinned list. Only a readable retirement bound to the run's id and
// epoch reads retired; any other stored record reads unreadable; charged and
// settled rows are absent; the pinned list is byte-for-byte what it was.
test("the bulk accounting read names exactly the retired runs, by id and epoch, and leaves the pinned list alone", t => {
  const h = harness(t, 8);
  const retired = unboundReservation(h, "retired-run");
  const charged = unboundReservation(h, "charged-run");
  const damaged = unboundReservation(h, "damaged-run");
  const otherEpoch = unboundReservation(h, "other-epoch-run");
  const pinnedBefore = JSON.stringify(publicList(h));
  assert.deepEqual(publicAccountingList(h).entries, [], "nothing is retired yet");

  publicDispose(h, disposeBody(h, retired));
  h.store.setMeta(hostRunAccountingDispositionMetaKey(damaged.id), { unreadable: true });
  const valid = h.store.hostRunAccountingDispositionRaw(retired.id) as Record<string, unknown>;
  h.store.setMeta(hostRunAccountingDispositionMetaKey(otherEpoch.id), { ...valid, runId: otherEpoch.id, epoch: otherEpoch.epoch + 1 });

  const list = publicAccountingList(h);
  assert.equal(list.complete, true);
  const byId = new Map(list.entries.map(entry => [entry.runId, entry]));
  assert.deepEqual(byId.get(retired.id), { runId: retired.id, epoch: retired.epoch, accounting: "retired",
    format: "queue.host-run.accounting-disposition", disposedAt: (valid as { disposedAt: string }).disposedAt, producer: null });
  assert.equal(byId.get(damaged.id)?.accounting, "unreadable", "an unreadable record keeps the run charged and visible");
  assert.equal(byId.get(otherEpoch.id)?.accounting, "unreadable", "another epoch's retirement does not retire this row");
  assert.equal(byId.has(charged.id), false, "a charged run with no record is not listed");
  assert.equal(JSON.stringify(publicList(h)), pinnedBefore, "the pinned host.run.list is unchanged");
  assert.equal(h.scheduler.get(retired.id)!.state, "running", "the retired row is not rewritten");

  // A bounded read says when it did not return every candidate.
  const bounded = h.scheduler.accountingList(1);
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.complete, false);
});

const RUNTIME_PATH = "/fixture/effigy";
const RUNTIME_SHA256 = "a".repeat(64);

function boundReservation(h: { store: Store; scheduler: HostRunScheduler }, id: string, overrides: Partial<HostRunSubmission> = {}) {
  h.scheduler.submit(input(id, {
    effigyRunId: id,
    effigyRuntimeBinding: {
      kind: "bound",
      identity: { path: RUNTIME_PATH, sha256: RUNTIME_SHA256 },
      version: "0.14.1",
      workloadPath: RUNTIME_PATH,
      workloadPid: 4242,
      workloadStartIdentity: "4242@2026-10-25T10:00:00Z",
    },
    ...overrides,
  }), launchedHandler(h.scheduler));
  return h.scheduler.get(id)!;
}

// Spec 035 "Retired runs age out, and dead foreground runs retire" (Tom,
// 2026-10-25: "Age out at 4 days"): a retired row stays force-visible beyond
// ordinary history only for HISTORY_RETENTION_MS after its own disposedAt; a
// still-charged admitted, running or queued row stays visible however old.
// Nothing is rewritten. Age is keyed on disposedAt, never submittedAt.
test("a retired run leaves the run list four days after disposedAt, while charged running and queued rows stay", t => {
  let clock = Date.parse("2026-10-25T10:00:00.000Z");
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity: capacity(6), now: () => clock });
  t.after(() => { scheduler.stop(); store.close(); });
  const h = { store, scheduler };
  const ids = (limit: number) => scheduler.list(limit).map(run => run.id).sort();
  // submittedAt is five days before dispose, so a submittedAt-keyed age-out
  // would already hide a retirement written at `clock`. The capacity deadline
  // is far enough out that pump on dispose does not timeout the waiter.
  const submittedAt = new Date(clock - HISTORY_RETENTION_MS - 24 * 60 * 60 * 1000).toISOString();
  const stale = { submittedAt, capacityDeadlineMs: HISTORY_RETENTION_MS * 3 };
  unboundReservation(h, "running-charged", stale);
  const operatorRetired = unboundReservation(h, "operator-retired", stale);
  const producerRetired = boundReservation(h, "producer-retired", stale);
  const absenceRetired = boundReservation(h, "absence-retired", stale);
  const unreadable = unboundReservation(h, "unreadable-retired", stale);
  const otherEpoch = unboundReservation(h, "other-epoch-retired", stale);
  h.scheduler.submit(input("queued-charged", { budgetFallback: { cpu: 1, memoryBytes: 100 }, ...stale }), launchedHandler(h.scheduler));
  const queued = h.scheduler.get("queued-charged")!;
  assert.equal(queued.state, "queued");
  assert.equal(queued.submittedAt, submittedAt);
  assert.equal(scheduler.accountingStatus(queued.id)!.accounting, "charged");
  h.store.setMeta(hostRunAccountingDispositionMetaKey(unreadable.id), { unreadable: true });
  const hook = { pid: 5151, startIdentity: "5151@2026-10-25T10:00:00Z" };
  h.scheduler.bindProcess(absenceRetired.id, { pid: hook.pid, processGroupId: hook.pid, startIdentity: hook.startIdentity });

  assert.equal(operatorRetired.submittedAt, submittedAt);
  assert.equal(h.scheduler.get("queued-charged")!.state, "queued");
  assert.ok(ids(0).includes("queued-charged"), "a still-charged queued reservation stays listed however old");
  assert.ok(ids(0).includes("running-charged"), "a still-charged running row stays listed however old");
  assert.ok(ids(0).includes("unreadable-retired"), "an unreadable retirement stays charged and listed");

  publicDispose(h, disposeBody(h, operatorRetired));
  h.scheduler.retireAccountingOnProducerCleanup({
    runId: producerRetired.id,
    producer: {
      runId: producerRetired.id, selector: producerRetired.selector, evidenceSource: "checkout-journal", cleanup: "complete",
      state: "failed", exitCode: 7, signal: null, startedAt: null, endedAt: null, durationMs: null,
      runtimePath: RUNTIME_PATH, runtimeSha256: RUNTIME_SHA256, verdict: "failed",
      observedAt: new Date(clock).toISOString(),
    },
  });
  h.scheduler.retireAccountingOnForegroundAbsence({
    runId: absenceRetired.id,
    absence: {
      runId: absenceRetired.effigyRunId!, selector: absenceRetired.selector, state: "not-found", recording: "not-recorded",
      message: "not recorded (foreground or expired); no live holder or retained journal record was found",
      checkout: absenceRetired.repository.path, runtimePath: RUNTIME_PATH, runtimeSha256: RUNTIME_SHA256, hook,
      observedAt: new Date(clock).toISOString(),
    },
  });
  const operatorStored = h.store.hostRunAccountingDispositionRaw(operatorRetired.id) as { disposedAt: string };
  h.store.setMeta(hostRunAccountingDispositionMetaKey(otherEpoch.id), {
    ...(h.store.hostRunAccountingDispositionRaw(operatorRetired.id) as Record<string, unknown>),
    runId: otherEpoch.id, epoch: otherEpoch.epoch + 1,
  });
  assert.notEqual(operatorStored.disposedAt, submittedAt, "disposedAt is later than submittedAt");
  assert.equal(scheduler.accountingStatus(operatorRetired.id)!.accounting, "retired");
  assert.equal(scheduler.accountingStatus(producerRetired.id)!.accounting, "retired");
  assert.equal(scheduler.accountingStatus(absenceRetired.id)!.accounting, "retired");
  assert.equal(scheduler.accountingStatus(unreadable.id)!.accounting, "charged");
  assert.equal(scheduler.accountingStatus(otherEpoch.id)!.accounting, "charged");
  const listedAfterDispose = ids(0);
  for (const id of ["operator-retired", "producer-retired", "absence-retired", "running-charged", "queued-charged", "unreadable-retired", "other-epoch-retired"]) {
    assert.ok(listedAfterDispose.includes(id), `${id} is listed at dispose time, five days after submit`);
  }

  const disposedAtMs = Date.parse(operatorStored.disposedAt);
  clock = disposedAtMs + HISTORY_RETENTION_MS - 1000;
  assert.ok(ids(0).includes("operator-retired"), "one second before four days the retired run is still listed");
  clock = disposedAtMs + HISTORY_RETENTION_MS;
  const atBoundary = ids(0);
  assert.ok(atBoundary.includes("operator-retired"), "at exactly four days from disposedAt the retired run is still listed");
  assert.ok(atBoundary.includes("producer-retired"));
  assert.ok(atBoundary.includes("absence-retired"));
  clock = disposedAtMs + HISTORY_RETENTION_MS + 1;
  const afterBoundary = ids(0);
  assert.equal(afterBoundary.includes("operator-retired"), false, "one millisecond past four days the operator retirement ages out");
  assert.equal(afterBoundary.includes("producer-retired"), false, "the producer-cleanup basis ages out from its own disposedAt");
  assert.equal(afterBoundary.includes("absence-retired"), false, "the foreground-absent basis ages out from its own disposedAt");
  for (const id of ["running-charged", "queued-charged", "unreadable-retired", "other-epoch-retired"]) {
    assert.ok(afterBoundary.includes(id), `${id} stays listed after the retired rows age out`);
  }
  const agedOutBulk = scheduler.accountingList(undefined, 0).entries.map(entry => entry.runId);
  assert.equal(agedOutBulk.includes("operator-retired"), false, "the bulk read covers only the listed runs, so the aged-out runs leave it too");
  assert.equal(agedOutBulk.includes("producer-retired"), false);
  assert.equal(agedOutBulk.includes("absence-retired"), false);
  const recency = new Map(scheduler.accountingList().entries.map(entry => [entry.runId, entry]));
  assert.equal(recency.get("operator-retired")?.accounting, "retired", "while ordinary recency lists them, the read still names the retired rows");
  assert.equal(recency.get("producer-retired")?.accounting, "retired");
  assert.equal(recency.get("absence-retired")?.accounting, "retired");
  assert.equal(recency.get("unreadable-retired")?.accounting, "unreadable");
  assert.equal(recency.get("other-epoch-retired")?.accounting, "unreadable");
  assert.ok(ids(250).includes("operator-retired"), "ordinary recency still lists a retired row while it is recent");
  assert.equal(scheduler.get(operatorRetired.id)!.state, "running", "the row is not rewritten");
  assert.ok(store.hostRunAccountingDispositionRaw(operatorRetired.id), "its retirement record is kept");
});
