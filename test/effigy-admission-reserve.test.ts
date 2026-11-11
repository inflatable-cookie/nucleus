/**
 * Spec 035 "Runtime identity": Queue refuses an Effigy admission before it
 * reserves capacity when the admitted workload cannot be bound to the trusted
 * declared artifact.
 *
 * The defect these tests pin down is the reserve boundary: it submitted to the
 * scheduler first and bound the runtime afterwards, so a run nothing could
 * observe held a slot with an `effigyRuntimeRefusal` and no way to settle. Every
 * refusal below is driven through the real public `reserve` RPC on the
 * endpoint's own socket (and, for the hook, a real hook process), and is
 * expected to write no reservation and hold no capacity at all.
 *
 * The declared artifact is the node binary running these tests, and this process
 * is a live image of exactly those bytes, so a bindable case binds for real:
 * real path, real digest and a real contract-010 start identity, with no seam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { admissionReservationId, defaultAdmissionHookPath, defaultAdmissionTsxLoader } from "../core/qa/effigy-admission";
import { admissionRpc } from "../core/qa/effigy-admission-hook";
import { hostRunIdentityMetaKey } from "../core/host-runs/host-run-identity";
import { hostRunProcessStartIdentity } from "../core/machine/start-identity";
import { parseEffigyVersion, type EffigyRuntimeAncestor, type EffigyRuntimeSettings } from "../core/qa/effigy-runtime";

const request = (runId: string, cwd: string) => ({
  schema: "effigy.admission-request.v1" as const, run_id: runId, task: "qa:ci:fast", class: "heavy" as const, cwd, root: cwd,
});

const NODE_PATH = realpathSync(process.execPath);
const NODE_SHA256 = createHash("sha256").update(readFileSync(NODE_PATH)).digest("hex");
/** This build of node stands in for the workload's Effigy: asked by its real path, it answers as one. */
const SELF_EFFIGY = (path: string) => path === NODE_PATH ? parseEffigyVersion("effigy v0.14.1+local.test") : null;
const selfAncestry = (): EffigyRuntimeAncestor[] =>
  [{ pid: process.pid, startIdentity: hostRunProcessStartIdentity(process.pid) }];

function isolatedScheduler(t: { after: (fn: () => void) => void }, cpu = 4): HostRunScheduler {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return new HostRunScheduler(store, {
    capacity: () => ({ cpuCapacity: cpu, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }),
  });
}

async function isolatedEndpoint(
  t: { after: (fn: () => void | Promise<void>) => void },
  scheduler: HostRunScheduler,
  effigyRuntime: EffigyRuntimeSettings | null,
  effigyVersion: ((path: string) => ReturnType<typeof parseEffigyVersion>) | null = SELF_EFFIGY,
): Promise<{ root: string; endpoint: EffigyAdmissionEndpoint }> {
  const root = mkdtempSync(join(tmpdir(), "queue-reserve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(root, "host-run"), watchMs: 50,
    ...(effigyRuntime ? { effigyRuntime } : { effigyRuntime: null }),
    ...(effigyVersion ? { effigyVersion } : {}),
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  return { root, endpoint };
}

/** A pid this process started and reaped, so it is alive to nobody. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  return pid;
}

const reserve = (endpoint: EffigyAdmissionEndpoint, params: Record<string, unknown>) =>
  admissionRpc(endpoint.socketPath, "reserve", params) as Promise<{
    ok: boolean;
    result?: { reservationId?: string | null; observation?: { kind: string; reason?: string; message?: string } };
    error?: { message?: string };
  }>;

const refusalReason = (response: Awaited<ReturnType<typeof reserve>>) => {
  assert.equal(response.ok, true, response.error?.message);
  assert.equal(response.result?.reservationId ?? null, null, "a refused admission has no reservation id");
  assert.equal(response.result?.observation?.kind, "settled", "the refusal uses the existing denial observation");
  return response.result?.observation?.reason ?? "";
};

/** No reservation row, no capacity, and no internal identity for a refused run. */
function assertNothingReserved(scheduler: HostRunScheduler, runId: string): void {
  assert.deepEqual(scheduler.list(), [], "the refused admission holds no slot");
  assert.deepEqual(scheduler.store.hostRuns(10), [], "and wrote no reservation row");
  assert.equal(scheduler.store.getMeta(hostRunIdentityMetaKey(admissionReservationId(runId))), undefined,
    "and wrote no admission identity");
}

test("a workload with no ancestor that answers as Effigy refuses before it reserves any capacity", async t => {
  const scheduler = isolatedScheduler(t);
  // No probe seam: this node process, asked `--version`, does not answer as Effigy.
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, null, null);
  const response = await reserve(endpoint, { request: request("not-effigy-run", root), ancestry: selfAncestry() });
  assert.match(refusalReason(response), /^admission refused: the admitted workload has no identifiable Effigy ancestor/);
  assert.match(refusalReason(response), /does not answer as Effigy/);
  assertNothingReserved(scheduler, "not-effigy-run");
});

test("the legacy bare-params reserve refuses: it attests no ancestor, so it can never be bound", async t => {
  const scheduler = isolatedScheduler(t);
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, null);
  // The old hook shape sends the producer's request bare as the params object.
  const response = await reserve(endpoint, request("legacy-run", root));
  assert.match(refusalReason(response), /admission refused: the admission hook attested no ancestor process/);
  assertNothingReserved(scheduler, "legacy-run");
});

test("an Effigy below the configured minVersion is refused, naming its version and image", async t => {
  const scheduler = isolatedScheduler(t);
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, { minVersion: "0.15.0" });
  const reason = refusalReason(await reserve(endpoint, { request: request("old-run", root), ancestry: selfAncestry() }));
  assert.match(reason, /admission refused: the workload runs Effigy 0\.14\.1\+local\.test \(.+\), below the configured minimum 0\.15\.0/);
  assertNothingReserved(scheduler, "old-run");
});

test("a retired exact-bytes declaration is ignored: the workload's own Effigy binds", async t => {
  const scheduler = isolatedScheduler(t);
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, { path: "/nonexistent/effigy", sha256: "b".repeat(64), minVersion: "0.14.1" });
  const response = await reserve(endpoint, { request: request("legacy-pin-run", root), ancestry: selfAncestry() });
  const id = response.result?.reservationId;
  assert.ok(id, "bound and reserved");
  assert.equal(scheduler.get(id!)?.effigyRuntime?.path, NODE_PATH);
  assert.equal(scheduler.get(id!)?.effigyRuntime?.sha256, NODE_SHA256);
  assert.equal(scheduler.get(id!)?.effigyRuntime?.version, "0.14.1+local.test");
});

test("a gone or reused ancestor is never trusted", async t => {
  const scheduler = isolatedScheduler(t);
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, null);

  const gone = await deadPid();
  const goneReason = refusalReason(await reserve(endpoint, {
    request: request("gone-ancestor-run", root),
    ancestry: [{ pid: gone, startIdentity: `${gone}@1999-01-01T00:00:00Z` }],
  }));
  assert.match(goneReason, /admission refused: .*gone or reused/);
  assertNothingReserved(scheduler, "gone-ancestor-run");

  // A live pid whose start identity differs is a recycled pid, not our workload.
  const reusedReason = refusalReason(await reserve(endpoint, {
    request: request("reused-ancestor-run", root),
    ancestry: [{ pid: process.pid, startIdentity: `${process.pid}@1999-01-01T00:00:00Z` }],
  }));
  assert.match(reusedReason, /admission refused: .*gone or reused/);
  assertNothingReserved(scheduler, "reused-ancestor-run");
});

test("a bindable admission reserves once, already bound in the reservation's own write", async t => {
  const scheduler = isolatedScheduler(t);
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, null);
  const body = request("bound-run", root);

  const first = await reserve(endpoint, { request: body, ancestry: selfAncestry() });
  assert.equal(first.ok, true);
  const id = first.result?.reservationId;
  assert.ok(id, `bindable admission reserved (${JSON.stringify(first.result?.observation)})`);
  assert.ok(first.result?.observation?.kind === "admitted" || first.result?.observation?.kind === "running");

  const record = scheduler.get(id!)!;
  assert.equal(record.effigyRuntime?.sha256, NODE_SHA256, "the reservation carries the verified binding");
  assert.equal(record.effigyRuntime?.path, NODE_PATH);
  assert.equal(record.effigyRuntime?.workloadPath, NODE_PATH);
  assert.equal(record.effigyRuntimeRefusal, undefined);
  const journal = scheduler.store.hostRunJournal(id!);
  assert.equal(journal.filter(row => row.event === "effigy_runtime_bind").length, 1);
  assert.equal(journal.filter(row => row.event === "effigy_runtime_unbound").length, 0);
  const bind = journal.find(row => row.event === "effigy_runtime_bind")!.data as { path: string; sha256: string; workloadPath: string };
  assert.deepEqual([bind.path, bind.sha256, bind.workloadPath], [NODE_PATH, NODE_SHA256, NODE_PATH]);
  const identity = scheduler.store.getMeta(hostRunIdentityMetaKey(id!)) as { effigyRuntime?: { sha256: string } };
  assert.equal(identity.effigyRuntime?.sha256, NODE_SHA256, "the binding is part of the admission identity beside the row");

  // Lost reply: the same run reserves again and gets its own live reservation.
  const again = await reserve(endpoint, { request: body, ancestry: selfAncestry() });
  assert.equal(again.result?.reservationId, id, "a retried reserve returns the reservation it already wrote");
  assert.equal(scheduler.list().length, 1, "the run id still keys one reservation");
  assert.equal(scheduler.store.hostRunJournal(id!).filter(row => row.event === "effigy_runtime_bind").length, 1,
    "a retry writes no second binding");
});

test("a retried reserve after a refusal refuses again with the same reason", async t => {
  const scheduler = isolatedScheduler(t);
  const { root, endpoint } = await isolatedEndpoint(t, scheduler, null, null);
  const body = request("retry-refused-run", root);
  const first = refusalReason(await reserve(endpoint, { request: body, ancestry: selfAncestry() }));
  const second = refusalReason(await reserve(endpoint, { request: body, ancestry: selfAncestry() }));
  assert.equal(second, first, "the refusal is deterministic for the same workload");
  assertNothingReserved(scheduler, "retry-refused-run");
});

test("nested work is admitted without a reservation and without a binding", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "queue-reserve-nested-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const scheduler = isolatedScheduler(t, 1);
  scheduler.submit({
    id: "qa-parent", epoch: 1, submissionSource: "queue", caller: "queue:validation:test",
    repository: { origin: null, path: cwd }, selector: "qa:changed", runClass: "heavy", classSource: "manifest",
    priority: "validation", runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 100 },
  }, { launch: run => { scheduler.markLaunched(run.id); } });
  assert.equal(scheduler.get("qa-parent")?.state, "running");

  // No Effigy ancestor at all: a nested admission is not a reservation, so it
  // needs no runtime to bind and must still be admitted without a second slot.
  const { endpoint } = await isolatedEndpoint(t, scheduler, null, null);
  const nested = await reserve(endpoint, { request: request("nested-run", cwd), ancestry: selfAncestry() });
  assert.equal(nested.ok, true);
  assert.equal(nested.result?.reservationId ?? null, null);
  assert.equal(nested.result?.observation?.kind, "nested");
  assert.equal(scheduler.list().filter(run => run.submissionSource === "admission").length, 0);
  assert.equal(scheduler.store.hostRuns(10).filter(run => run.submissionSource === "admission").length, 0);
});

test("a real hook process denies an unobservable admission and writes nothing", async t => {
  const scheduler = isolatedScheduler(t);
  // No probe seam: the hook's ancestors (node, this test runner) do not answer as Effigy.
  const { endpoint } = await isolatedEndpoint(t, scheduler, null, null);
  const cwd = mkdtempSync(join(tmpdir(), "queue-reserve-hook-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--import", defaultAdmissionTsxLoader(), defaultAdmissionHookPath()], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "C",
      EFFIGY_ADMISSION_REQUEST: JSON.stringify(request("hook-refused-run", cwd)),
      QUEUE_ADMISSION_SOCKET: endpoint.socketPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve({ code: null, signal: "SIGKILL" }); }, 30_000);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const result = await closed;
  assert.equal(result.code, 0, `the hook denies cleanly (stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)})`);
  assert.match(stdout, /^deny admission refused: the admitted workload has no identifiable Effigy ancestor; .*does not answer as Effigy.*\n$/);
  assertNothingReserved(scheduler, "hook-refused-run");
});
