import { RuntimeRepositories, type RepositoriesContext } from "../core/runtime/repositories";
/**
 * Contract 010's host-run record, and Queue's own admission identity, are
 * different things kept on different surfaces (task 409, Spec 035).
 *
 * Nucleus decodes `host.run.list` and `host.run.capacity.release` with a strict
 * pinned record: a two-valued `submissionSource` and no Effigy run id, runtime
 * binding or refusal. The builds that added admission wrote those fields into
 * the record itself, so the record, its stored row and the method digests
 * stopped being contract 010 — a strict client fences the call instead of
 * reading a reservation.
 *
 * These tests use the frozen pinned shapes only (never Nucleus at runtime).
 * They pin what actually crosses the boundary: the serialized `host.run.list`
 * and `host.run.capacity.release` payloads and the stored row, the pre-fix
 * record as the falsification that it could not have been compatible, and the
 * internal identity — durable beside the row, epoch-bound, conservative when
 * missing or stale — that keeps admission observable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { HostRunEndpoint } from "../service/callbacks/host-run-endpoint";
import { EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { QueueRuntime } from "../service/runtime-owner";
import {
  HOST_RUN_IDENTITY_META_PREFIX, hostRunIdentityMetaKey, publicHostRunRecord,
} from "../core/host-runs/host-run-identity";
import { admissionReservationId } from "../core/qa/effigy-admission";
import { parseEffigyVersion } from "../core/qa/effigy-runtime";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import {
  hostRunCapacityRelease, hostRunCapacityReleaseInputSchema, hostRunInternalRecordSchema, hostRunList, hostRunRecordSchema,
  hostRunSettlementSchema, type HostRunInternalRecord,
} from "../shared/contracts";
import { contractDigest, rpcContractDigest } from "../shared/rpc-contracts";
import {
  frozenHostRunRecordSchema, frozenHostRunSettlementSchema,
} from "./support/contract-010-frozen";

const AT = "2026-10-25T10:00:00.000Z";
const repository = { origin: "https://github.com/example/wire", path: "/repo/wire" };
// The declared artifact these tests bind is the node binary running them: real
// bytes at a real path, which this process itself is a live image of.
const declaration = {
  path: realpathSync(process.execPath),
  sha256: createHash("sha256").update(readFileSync(realpathSync(process.execPath))).digest("hex"),
};
const selfAncestry = () => [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }];
const capacity = () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });

const request = (runId: string, cwd: string) => ({
  schema: "effigy.admission-request.v1" as const, run_id: runId, task: "qa:ci:fast", class: "heavy" as const, cwd, root: cwd,
});

/** The pinned Contract 010 definition of `host.run.capacity.release`'s input (unchanged by this task). */
const pinnedCapacityReleaseInput = z.object({
  runId: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(4000),
}).strict();

async function harness(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "host-run-wire-"));
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, { capacity });
  const endpoint = new EffigyAdmissionEndpoint(scheduler, { stateDir: join(dir, "host-run"), watchMs: 20,
    // This build of node stands in for the workload's Effigy: asked by its real path, it answers as one.
    effigyVersion: path => path === declaration.path ? parseEffigyVersion("effigy v0.14.1+local.test") : null });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); scheduler.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, scheduler, endpoint };
}

/** One admission reservation, bound to the declared artifact by its own reserve and launched. */
async function reserve(h: { scheduler: HostRunScheduler; endpoint: EffigyAdmissionEndpoint }, runId: string) {
  const reserved = await h.endpoint.reserve(request(runId, `/repo/wire/${runId}`), selfAncestry());
  assert.ok(reserved.reservationId, `reservation accepted (${JSON.stringify(reserved.observation)})`);
  const run = h.scheduler.get(reserved.reservationId!)!;
  assert.equal(run.effigyRuntime?.sha256, declaration.sha256, "the reservation is written already bound");
  assert.equal(run.state, "running", "the reservation was admitted and launched");
  return run;
}

/** The real `queue.` methods that carry the record, called on their real bodies. */
function publicRouter(h: { scheduler: HostRunScheduler }) {
  return { repositories: new RuntimeRepositories({
    markStoreAccess() {},
    hostRuns: {
      list: () => h.scheduler.list(),
      releaseCapacity: (id: string, reason: string) => h.scheduler.releaseCapacity(id, reason),
    },
  } as RepositoriesContext) };
}

const listHostRuns = (h: { scheduler: HostRunScheduler }) =>
  (QueueRuntime.prototype.listHostRuns as unknown as (this: unknown) => unknown[]).call(publicRouter(h));
const releaseHostRunCapacity = (h: { scheduler: HostRunScheduler }, input: { runId: string; reason: string }) =>
  (QueueRuntime.prototype.releaseHostRunCapacity as unknown as (this: unknown, input: { runId: string; reason: string }) => unknown)
    .call(publicRouter(h), input);

test("the pinned host-run record and the two affected method digests are the frozen contract 010 definitions", () => {
  assert.deepEqual(z.toJSONSchema(hostRunRecordSchema, { io: "input" }), z.toJSONSchema(frozenHostRunRecordSchema, { io: "input" }));
  const pinnedList = { input: z.object({}).strict(), output: z.array(frozenHostRunRecordSchema) };
  const pinnedRelease = { input: pinnedCapacityReleaseInput, output: frozenHostRunRecordSchema };
  assert.equal(contractDigest(pinnedList, "host.run.list"), rpcContractDigest("host.run.list"));
  assert.equal(contractDigest(pinnedRelease, "host.run.capacity.release"), rpcContractDigest("host.run.capacity.release"));
  // The input half of the release method is unchanged: it is still what this
  // build parses, and it is the pinned input the digest above uses.
  assert.deepEqual(z.toJSONSchema(hostRunCapacityReleaseInputSchema, { io: "input" }), z.toJSONSchema(pinnedCapacityReleaseInput, { io: "input" }));

  // The shipped pre-fix record (frozen shape plus the four identity fields) is
  // a different contract: the digests could never have matched, which is the
  // incompatibility this task removes, not a claim that other methods changed.
  const shipped = frozenHostRunRecordSchema.extend({
    submissionSource: z.enum(["queue", "client", "admission"]).optional(),
    effigyRunId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
    effigyRuntime: z.object({
      path: z.string().min(1).max(4096), sha256: z.string().regex(/^[0-9a-f]{64}$/),
      workloadPath: z.string().min(1).max(4096), boundAt: z.string().datetime(),
    }).strict().optional(),
    effigyRuntimeRefusal: z.string().trim().min(1).max(2000).optional(),
  }).strict();
  assert.notEqual(contractDigest({ input: z.object({}).strict(), output: z.array(shipped) }, "host.run.list"),
    rpcContractDigest("host.run.list"), "adding the identity fields back changes the method digest");
});

test("host.run.list and host.run.capacity.release emit the pinned record for an admission reservation, and the identity stays internal", async t => {
  const h = await harness(t);
  const run = await reserve(h, "wire-run-1");
  assert.equal(run.submissionSource, "admission");
  assert.equal(run.effigyRunId, "wire-run-1");

  // The real `listHostRuns` body, over real scheduler records.
  const listed = listHostRuns(h);
  assert.equal(hostRunList.output.safeParse(listed).success, true, "the RPC output parses with this build's contract");
  const serialized = JSON.parse(JSON.stringify(listed)) as HostRunInternalRecord[];
  for (const record of serialized) {
    assert.equal(frozenHostRunRecordSchema.safeParse(record).success, true, "the serialized record is contract 010's");
    assert.deepEqual(["submissionSource", "effigyRunId", "effigyRuntime", "effigyRuntimeRefusal"].filter(key => key in record), []);
  }
  // The falsification: the same actual record as the shipped build emitted it
  // (the scheduler record, which carries the identity) is refused by the exact
  // strict decoder Nucleus pins, so this could not simply be left alone.
  const internal = h.scheduler.list().find(candidate => candidate.id === run.id)!;
  assert.equal(frozenHostRunRecordSchema.safeParse(JSON.parse(JSON.stringify(internal))).success, false);

  // The row keeps the pinned shape too; the identity lives beside it.
  const row = h.store.db.prepare("SELECT data FROM host_run_records WHERE id=?").get(run.id) as { data: string };
  const storedRow = JSON.parse(row.data) as Record<string, unknown>;
  assert.equal(frozenHostRunRecordSchema.safeParse(storedRow).success, true);
  const identity = h.store.getMeta(hostRunIdentityMetaKey(run.id)) as Record<string, unknown>;
  assert.equal(identity.epoch, run.epoch);
  assert.equal(identity.submissionSource, "admission");
  assert.equal(identity.effigyRunId, "wire-run-1");
  const bound = identity.effigyRuntime as { path: string; sha256: string; workloadPath: string; boundAt: string };
  assert.deepEqual([bound.path, bound.sha256, bound.workloadPath], [declaration.path, declaration.sha256, declaration.path]);
  assert.equal(Number.isNaN(Date.parse(bound.boundAt)), false, "the bound time is the binding's own timestamp");

  // The endpoint's own status view never carries it either.
  const view = (HostRunEndpoint.prototype as unknown as { runView: (run: unknown) => unknown }).runView(internal);
  assert.deepEqual(["submissionSource", "effigyRunId", "effigyRuntime", "effigyRuntimeRefusal"].filter(key => key in (view as object)), []);

  // A settled reservation that still holds container capacity: the operator
  // release is the other affected method, and it emits the pinned record too.
  const settlement = hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: run.id, outcome: "failed", launched: true, settledAt: AT,
    result: { format: "host.run.result", version: 1, runId: run.id, epoch: run.epoch, pgid: 4242, startIdentity: "4242@2026-10-25T10:00:00Z",
      exitCode: 1, signal: null, startedAt: run.launchedAt ?? AT, endedAt: AT, wallMs: 1000, cpuMs: null, escapedDescendants: [] },
    containers: [{ runtime: "docker", id: "container-1", removed: false }],
  });
  const settled = h.scheduler.settle(run.id, settlement, { wallMs: 1000, cpuMs: null });
  assert.equal(settled.capacityReleasedAt, null, "the open container still holds capacity");
  assert.equal(h.store.getMeta(hostRunIdentityMetaKey(run.id)) !== undefined, true, "settling keeps the identity");
  const released = releaseHostRunCapacity(h, { runId: run.id, reason: "operator confirmed the container is gone" });
  assert.equal(hostRunCapacityRelease.output.safeParse(released).success, true);
  assert.equal(frozenHostRunRecordSchema.safeParse(JSON.parse(JSON.stringify(released))).success, true);
  assert.equal("effigyRuntime" in (released as object), false);
  assert.equal((released as { capacityReleaseKind: string }).capacityReleaseKind, "operator");
});

test("identity is durable beside the row and never applied when it is missing, stale or unreadable", async t => {
  const dir = mkdtempSync(join(tmpdir(), "host-run-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  const record = (runId: string): HostRunInternalRecord => hostRunInternalRecordSchema.parse({
    id: runId, epoch: 1, submissionSource: "admission", effigyRunId: runId, caller: "queue:effigy-admission",
    clientRequestId: `request-${runId}`, repository, selector: "qa:ci:fast", runClass: "heavy", classSource: "manifest",
    priority: "interactive", state: "running", submittedAt: AT, capacityDeadlineAt: AT, runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000_000 }, budget: { cpu: 1, memoryBytes: 1_000_000, wallMs: null, source: "fallback" },
    position: null, admittedAt: AT, launchedAt: AT, settledAt: null, capacitySample: null,
    pid: 4242, processGroupId: 4242, startIdentity: "4242@2026-10-25T10:00:00Z", settlement: null,
    wallMs: null, cpuMs: null, containers: [], capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
    effigyRuntime: { path: declaration.path, sha256: declaration.sha256, workloadPath: declaration.path, boundAt: AT },
  });

  let store = new Store(path);
  try {
    store.putHostRun(record("durable-run"));
    // A failed identity write takes the row with it: one durable unit, no
    // unmarked reservation left behind and no identity without its row.
    store.db.exec(`CREATE TEMP TRIGGER refuse_identity_write BEFORE INSERT ON meta
      WHEN NEW.key = '${hostRunIdentityMetaKey("failed-write-run")}'
      BEGIN SELECT RAISE(ABORT, 'meta write refused'); END`);
    assert.throws(() => store.putHostRun(record("failed-write-run")), /meta write refused/);
    store.db.exec("DROP TRIGGER refuse_identity_write");
    assert.equal(store.hostRun("failed-write-run"), null, "the row did not commit without its identity");
  } finally { store.close(); }

  store = new Store(path);
  try {
    // Recovery after a restart reads the same identity beside the same row.
    assert.equal(store.hostRun("durable-run")?.effigyRuntime?.sha256, declaration.sha256);
    assert.equal(store.hostRun("durable-run")?.submissionSource, "admission");

    // Missing: never observed, never released, never settled on a guess.
    store.db.prepare("DELETE FROM meta WHERE key=?").run(hostRunIdentityMetaKey("durable-run"));
    const missing = store.hostRun("durable-run")!;
    assert.equal(missing.submissionSource, undefined, "an unmarked row claims no source");
    assert.equal(missing.effigyRuntime, undefined);
    assert.equal(missing.state, "running");
    assert.equal(missing.capacityReleasedAt, null);

    // Stale: an identity for another epoch is not migrated onto this row.
    store.putHostRun({ ...record("durable-run"), epoch: 2, effigyRuntimeRefusal: undefined } as HostRunInternalRecord);
    store.setMeta(hostRunIdentityMetaKey("durable-run"), {
      epoch: 1, submissionSource: "admission", effigyRunId: "durable-run",
      effigyRuntime: { path: declaration.path, sha256: declaration.sha256, workloadPath: declaration.path, boundAt: AT },
    });
    assert.equal(store.hostRun("durable-run")?.effigyRuntime, undefined, "a stale identity is absent");
    assert.equal(store.hostRun("durable-run")?.submissionSource, undefined);

    // Unreadable: a corrupt value is absent, not partially trusted.
    store.db.prepare("UPDATE meta SET value=? WHERE key=?").run("{not json", hostRunIdentityMetaKey("durable-run"));
    assert.equal(store.hostRun("durable-run")?.effigyRuntime, undefined);

    // Settlement itself never needs the identity: an unbound run still settles
    // through the ordinary scheduler path, and no identity is invented.
    store.putHostRun(record("unbound-run"));
    store.db.prepare("DELETE FROM meta WHERE key=?").run(hostRunIdentityMetaKey("unbound-run"));
    const scheduler = new HostRunScheduler(store, { capacity });
    t.after(() => scheduler.stop());
    const settlement = hostRunSettlementSchema.parse({
      format: "host.run.settlement", version: 1, runId: "unbound-run", outcome: "passed", launched: true, settledAt: AT,
      result: { format: "host.run.result", version: 1, runId: "unbound-run", epoch: 1, pgid: 4242, startIdentity: "4242@2026-10-25T10:00:00Z",
        exitCode: 0, signal: null, startedAt: AT, endedAt: AT, wallMs: 1000, cpuMs: null, escapedDescendants: [] },
      containers: [],
    });
    const settled = scheduler.settle("unbound-run", settlement, { wallMs: 1000, cpuMs: null });
    assert.equal(settled.state, "settled");
    assert.equal(settled.effigyRuntime, undefined);
    assert.equal(frozenHostRunRecordSchema.safeParse(JSON.parse(JSON.stringify(publicHostRunRecord(settled)))).success, true);
  } finally { store.close(); }
});

test("a row written by the build that carried the identity in the record is read, and projected on its next write", async t => {
  const dir = mkdtempSync(join(tmpdir(), "host-run-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dirStore = new Store(join(dir, "queue.sqlite"));
  const scheduler = new HostRunScheduler(dirStore, { capacity });
  t.after(() => { scheduler.stop(); dirStore.close(); });
  const legacy = hostRunInternalRecordSchema.parse({
    id: admissionReservationId("legacy-wire-run"), epoch: 1, submissionSource: "admission", effigyRunId: "legacy-wire-run",
    caller: "queue:effigy-admission", clientRequestId: "legacy-request", repository, selector: "qa:ci:fast",
    runClass: "heavy", classSource: "manifest", priority: "interactive", state: "running",
    submittedAt: AT, capacityDeadlineAt: AT, runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000_000 }, budget: { cpu: 1, memoryBytes: 1_000_000, wallMs: null, source: "fallback" },
    position: null, admittedAt: AT, launchedAt: AT, settledAt: null, capacitySample: null,
    pid: 4242, processGroupId: 4242, startIdentity: "4242@2026-10-25T10:00:00Z", settlement: null,
    wallMs: null, cpuMs: null, containers: [], capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null,
    effigyRuntime: { path: declaration.path, sha256: declaration.sha256, workloadPath: declaration.path, boundAt: AT },
  });
  const row = (data: unknown) => JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  dirStore.db.prepare("INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)")
    .run(legacy.id, repository.path, legacy.state, JSON.stringify(legacy));

  // This build reads it, so an upgrade keeps a live reservation observable.
  const read = scheduler.get(legacy.id)!;
  assert.equal(read.submissionSource, "admission");
  assert.equal(read.effigyRuntime?.sha256, declaration.sha256);
  // The honest limitation: an older strict reader cannot parse that row. This
  // task does not rewrite history, so such rows stay as they were written.
  assert.equal(frozenHostRunRecordSchema.safeParse(row(legacy)).success, false);

  // The next ordinary transition projects the row onto the pinned shape and
  // moves the identity beside it.
  scheduler.updateProcess(legacy.id, { pid: 4243, processGroupId: 4243, startIdentity: "4243@2026-10-25T10:00:00Z" });
  const stored = dirStore.db.prepare("SELECT data FROM host_run_records WHERE id=?").get(legacy.id) as { data: string };
  assert.equal(frozenHostRunRecordSchema.safeParse(JSON.parse(stored.data)).success, true);
  assert.equal("effigyRuntime" in (JSON.parse(stored.data) as object), false);
  assert.equal((dirStore.getMeta(hostRunIdentityMetaKey(legacy.id)) as { effigyRuntime?: { sha256: string } }).effigyRuntime?.sha256, declaration.sha256);
});

test("journal keeps the identity out of the pinned request and record shapes", async t => {
  const h = await harness(t);
  const run = await reserve(h, "stream-run-1");

  // Journal: the pinned `host.run.submit` request input is exactly the request,
  // and Queue's own source/run correlation is durable beside it.
  const journal = h.store.hostRunJournal(run.id);
  const submission = journal.find(entry => entry.event === "request")!.data as { method: string; input: Record<string, unknown>; submissionSource?: string; effigyRunId?: string };
  assert.equal(submission.method, "host.run.submit");
  assert.deepEqual(["submissionSource", "effigyRunId"].filter(key => key in submission.input), []);
  assert.equal(submission.submissionSource, "admission");
  assert.equal(submission.effigyRunId, "stream-run-1");
  const bind = journal.find(entry => entry.event === "effigy_runtime_bind")!.data as { path: string; sha256: string; workloadPid: number };
  assert.equal(bind.path, declaration.path, "the journal keeps the exact declared artifact");
  assert.equal(bind.sha256, declaration.sha256);

  h.scheduler.settle(run.id, hostRunSettlementSchema.parse({
    format: "host.run.settlement", version: 1, runId: run.id, outcome: "passed", launched: true, settledAt: AT,
    result: { format: "host.run.result", version: 1, runId: run.id, epoch: run.epoch, pgid: 4242, startIdentity: "4242@2026-10-25T10:00:00Z",
      exitCode: 0, signal: null, startedAt: run.launchedAt ?? AT, endedAt: AT, wallMs: 1000, cpuMs: null, escapedDescendants: [] },
    containers: [],
  }), { wallMs: 1000, cpuMs: null });

  const settled = h.store.hostRunJournal(run.id).find(entry => entry.event === "settlement")!.data as { settlement?: unknown };
  assert.equal(frozenHostRunSettlementSchema.safeParse(settled.settlement).success, true);
  assert.equal(/effigyRuntime|effigyRunId|submissionSource/.test(JSON.stringify(settled)), false, "no record identity in the settlement journal");
  assert.equal(HOST_RUN_IDENTITY_META_PREFIX, "hostRunIdentity:");
});
