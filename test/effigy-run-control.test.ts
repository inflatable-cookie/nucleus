import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Store } from "../core/store/store";
import { HostRunScheduler } from "../core/host-runs/host-run-scheduler";
import { EffigyAdmissionEndpoint } from "../service/callbacks/effigy-admission-endpoint";
import { defaultAdmissionHookCommand, queueOwnedAdmissionEnvironment } from "../core/qa/effigy-admission";
import {
  EffigyRunControl,
  classifyEffigyRunHelp,
  classifyEffigyStatusPayload,
  classifyEffigyStructuredStatus,
  effigyStructuredStatusError,
  hostSignalName,
  unwrapEffigyRunRecord,
  EFFIGY_EXIT_HELD_TASK_LOCK,
} from "../core/qa/effigy-run-control";
import { effigyArtifactDigests } from "../core/qa/effigy-runtime";

test("capability comes from run --help, never the version string", () => {
  assert.equal(classifyEffigyRunHelp("Usage: effigy run --run-id <key>\n  logs --follow --stdout-offset"), "v015-run-control");
  assert.equal(classifyEffigyRunHelp("effigy v0.14.1\n--host-run-request-id <uuid>\nEFFIGY_HOST_SCHEDULER"), "v014-host-run");
  assert.equal(classifyEffigyRunHelp("effigy v0.14.1"), "unknown");
});

/** One `effigy.command.v1` envelope around an `effigy.run.v1` record. */
function runEnvelope(run: Record<string, unknown>): Record<string, unknown> {
  return { schema: "effigy.command.v1", schema_version: 1, ok: true, warnings: [], result: { schema: "effigy.run.v1", schema_version: 1, run } };
}

/** A producer record in the shipped shape (`status.rs` RunView, plus `run_json`'s task). */
function closedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return runEnvelope({
    evidence_source: "checkout-journal",
    run_id: "run-1",
    task: "qa:stage:rust",
    state: "succeeded",
    phase: "closed",
    exit_code: 0,
    cleanup: "complete",
    started_at_epoch_ms: 1_700_000_000_000,
    finished_at_epoch_ms: 1_700_000_001_500,
    duration_ms: 1_500,
    ...overrides,
  });
}

test("status classification keeps exit 75 as a held lock and expired keys as expiry", () => {
  assert.equal(classifyEffigyStatusPayload({}, EFFIGY_EXIT_HELD_TASK_LOCK).kind, "held-lock");
  assert.equal(classifyEffigyStatusPayload({ state: "expired", error: "retention" }, 2).kind, "expired");
  assert.equal(classifyEffigyStatusPayload({ state: "running" }, 0).kind, "live");
  // A closed row with no producer closure fields is not closure: the old
  // `terminal` answer settled on the exit code alone.
  assert.equal(classifyEffigyStatusPayload({ state: "settled", exit_code: 3 }, 0).kind, "unclosed");
});

test("only a checkout-journal record with complete cleanup closes, and its exit code is the verdict", () => {
  const live = runEnvelope({ state: "running", exit_code: null, run_id: "run-live", phase: "starting" });
  assert.equal(unwrapEffigyRunRecord(live)?.state, "running");
  assert.equal(classifyEffigyStatusPayload(live, 0).kind, "live");

  const closed = classifyEffigyStatusPayload(closedRun(), 0, { runId: "run-1", selector: "qa:stage:rust" });
  assert.equal(closed.kind, "closed");
  if (closed.kind === "closed") {
    assert.equal(closed.outcome, "passed");
    assert.equal(closed.exitCode, 0);
    assert.equal(closed.signal, null, "no signal is invented for an exit code");
    assert.equal(closed.closure.selector, "qa:stage:rust");
    assert.equal(closed.closure.endedAt, new Date(1_700_000_001_500).toISOString(), "the producer's own end time");
    assert.equal(closed.closure.durationMs, 1_500);
  }
  const failed = classifyEffigyStatusPayload(closedRun({ state: "failed", exit_code: 7 }), 0);
  assert.equal(failed.kind, "closed");
  if (failed.kind === "closed") assert.deepEqual([failed.outcome, failed.exitCode, failed.signal], ["failed", 7, null]);
});

test("the producer's numeric signal maps to this host's name, and only when it reported one", () => {
  const cancelled = classifyEffigyStatusPayload(closedRun({ state: "cancelled", exit_code: 143, signal: 15 }), 0);
  assert.equal(cancelled.kind, "closed");
  if (cancelled.kind === "closed") {
    assert.equal(cancelled.outcome, "failed", "a signalled workload never passes");
    assert.equal(cancelled.signal, "SIGTERM");
    assert.equal(cancelled.exitCode, null, "Contract 010 carries one of exit code and signal");
    assert.equal(cancelled.closure.signal, 15, "the producer's own number stays on the evidence");
  }
  assert.equal(hostSignalName(9), "SIGKILL");
  assert.equal(hostSignalName(0), null);
  // A number this host cannot name keeps the producer's own exit code rather
  // than inventing a name for it.
  let unnamedSignal = 200;
  while (hostSignalName(unnamedSignal) !== null) unnamedSignal += 1;
  const exotic = classifyEffigyStatusPayload(closedRun({ state: "cancelled", exit_code: 128 + unnamedSignal, signal: unnamedSignal }), 0);
  assert.equal(exotic.kind, "closed");
  if (exotic.kind === "closed") assert.deepEqual([exotic.signal, exotic.exitCode], [null, 128 + unnamedSignal]);
});

test("an interrupted run with cleanup complete closes as failed, with the producer's own code or none", () => {
  // Tom, 2026-10-27: "Retire on `interrupted`". It never passes, and nothing is invented.
  const withCode = classifyEffigyStatusPayload(closedRun({ state: "interrupted", exit_code: 1 }), 0, { runId: "run-1", selector: "qa:stage:rust" });
  assert.equal(withCode.kind, "closed");
  if (withCode.kind === "closed") assert.deepEqual([withCode.outcome, withCode.exitCode, withCode.signal], ["failed", 1, null]);
  const bare = classifyEffigyStatusPayload(closedRun({ state: "interrupted", exit_code: undefined }), 0, { runId: "run-1", selector: "qa:stage:rust" });
  assert.equal(bare.kind, "closed");
  if (bare.kind === "closed") assert.deepEqual([bare.outcome, bare.exitCode, bare.signal], ["failed", null, null]);
  // Cleanup still has to be complete: an interrupted run with residue holds.
  const residue = classifyEffigyStatusPayload(closedRun({ state: "interrupted", cleanup: "incomplete" }), 0, { runId: "run-1", selector: "qa:stage:rust" });
  assert.equal(residue.kind, "unclosed");
  if (residue.kind === "unclosed") assert.equal(residue.cause, "cleanup-incomplete");
});

test("malformed or contradictory producer exit and signal evidence holds, never a bare closure", () => {
  // Review 5664858628: a present value Queue cannot read as a number is not the
  // absent null, so it can neither stand in for a bare `interrupted` closure nor
  // be dropped into null/null on a retirement record.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a string exit code", { state: "interrupted", exit_code: "1" }],
    ["a string signal", { state: "interrupted", exit_code: 1, signal: "SIGTERM" }],
    ["a boolean signal", { state: "cancelled", exit_code: 143, signal: true }],
    ["an object exit code", { state: "failed", exit_code: { code: 7 } }],
    ["an array signal", { state: "interrupted", exit_code: undefined, signal: [15] }],
    ["a non-finite exit code", { state: "failed", exit_code: Number.POSITIVE_INFINITY }],
    ["a fractional exit code", { state: "failed", exit_code: 1.5 }],
    ["a zero signal", { state: "cancelled", exit_code: 143, signal: 0 }],
    ["a negative signal", { state: "interrupted", exit_code: undefined, signal: -15 }],
    ["contradictory exit codes", { state: "failed", exit_code: 7, exitCode: 8 }],
    ["a malformed fallback exit code", { state: "interrupted", exit_code: 1, exitCode: "1" }],
  ];
  for (const [what, overrides] of cases) {
    const observation = classifyEffigyStatusPayload(closedRun(overrides), 0, { runId: "run-1", selector: "qa:stage:rust" });
    assert.equal(observation.kind, "unclosed", `${what} must hold`);
    if (observation.kind === "unclosed") {
      assert.equal(observation.cause, "verdict-unknown");
      assert.match(observation.reason, /cannot carry as the producer's own verdict/, what);
      assert.match(observation.reason, /run-1/, `${what}: the hold names the run`);
    }
  }
  // What the producer reported stays in the hold's reason instead of vanishing.
  const named = classifyEffigyStatusPayload(closedRun({ state: "interrupted", exit_code: "1" }), 0);
  if (named.kind === "unclosed") assert.match(named.reason, /exit code "1" \(string\)/);
  // A value the producer genuinely did not report is still a bare closure.
  for (const absent of [undefined, null]) {
    const bare = classifyEffigyStatusPayload(closedRun({ state: "interrupted", exit_code: absent, signal: absent }), 0);
    assert.equal(bare.kind, "closed", `an absent ${String(absent)} is the producer reporting nothing`);
    if (bare.kind === "closed") assert.deepEqual([bare.outcome, bare.exitCode, bare.signal], ["failed", null, null]);
  }
});

test("every field that could close a reservation is checked, and a missing one holds", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["live-foreground", { evidence_source: "live-foreground", cleanup: undefined, exit_code: undefined }],
    ["not-journal-backed", { evidence_source: undefined }],
    ["cleanup-incomplete", { cleanup: "incomplete" }],
    ["cleanup-absent", { cleanup: undefined }],
    ["cleanup-unknown", { cleanup: "pending" }],
    ["run-id-mismatch", { run_id: "run-other" }],
    ["selector-mismatch", { task: "qa:stage:go" }],
    ["verdict-unknown", { state: "not-started", cleanup: "complete" }],
    ["verdict-unknown", { state: "failed-cleanup", cleanup: "complete" }],
    ["verdict-unknown", { state: "succeeded", exit_code: undefined, cleanup: "complete" }],
  ];
  for (const [cause, overrides] of cases) {
    const observation = classifyEffigyStatusPayload(closedRun(overrides), 0, { runId: "run-1", selector: "qa:stage:rust" });
    assert.equal(observation.kind, "unclosed", `${cause} must not close the reservation (${JSON.stringify(overrides)})`);
    if (observation.kind === "unclosed") {
      assert.equal(observation.cause, cause);
      assert.ok(observation.reason.length > 20, "each hold states its own reason");
    }
  }
  // The exact-run binding also refuses a record with no run id at all.
  const unnamed = classifyEffigyStatusPayload(closedRun({ run_id: undefined }), 0, { runId: "run-1", selector: "qa:stage:rust" });
  assert.equal(unnamed.kind, "unclosed");
  if (unnamed.kind === "unclosed") assert.equal(unnamed.cause, "run-id-mismatch");
});

test("the producer's structured state outranks its text, so not-recorded is never expiry", () => {
  const notRecorded = {
    schema: "effigy.command.v1", schema_version: 1, ok: false, result: null, warnings: [],
    error: {
      kind: "RunnerError",
      message: "run `foreground-1`: not recorded (foreground or expired); no live holder or retained journal record was found",
      details: { schema: "effigy.run.v1", schema_version: 1, selector: "foreground-1", state: "not-found", recording: "not-recorded" },
    },
  };
  assert.deepEqual(effigyStructuredStatusError(notRecorded)?.state, "not-found");
  assert.deepEqual(effigyStructuredStatusError(notRecorded)?.recording, "not-recorded");
  // Both structured fields: the producer found no foreground holder and no
  // journal record. That is absence (Spec 035, "Retired runs age out, and dead
  // foreground runs retire"), never expiry and never a workload verdict.
  const absent = classifyEffigyStructuredStatus(notRecorded);
  assert.equal(absent?.kind, "absent", "both structured fields read as absence, not expiry");
  if (absent?.kind === "absent") assert.match(absent.reason, /not recorded \(foreground or expired\)/);
  // Either field alone is not enough: it stays an absence of evidence.
  const half = (details: Record<string, string>) => ({ ok: false, result: null, error: { message: "run `x`: lookup", details } });
  assert.equal(classifyEffigyStructuredStatus(half({ state: "not-found" }))?.kind, "unknown");
  assert.equal(classifyEffigyStructuredStatus(half({ recording: "not-recorded" }))?.kind, "unknown");
  assert.equal(classifyEffigyStructuredStatus(half({ state: "not-found", recording: "unknown" }))?.kind, "unknown");

  // The same text beside a state that names expiry is expiry, and the wording
  // "expired" beside a not-recorded state does not become one.
  const expired = {
    ok: false, result: null,
    error: { message: "run `old-1`: journal key aged out of retention", details: { state: "expired", recording: "retention-expired" } },
  };
  assert.equal(classifyEffigyStructuredStatus(expired)?.kind, "expired");
  const mixed = {
    ok: false, result: null,
    error: { message: "run `x`: not recorded (foreground or expired)", details: { state: "not-found", recording: "not-recorded" } },
  };
  assert.equal(classifyEffigyStructuredStatus(mixed)?.kind, "absent", "the word expired in the message never outranks the structured fields");

  // A successful envelope has no structured verdict; an uninterpretable refusal
  // is an unknown answer, never a result.
  assert.equal(classifyEffigyStructuredStatus({ ok: true, result: { run: { state: "running" } } }), null);
  assert.equal(classifyEffigyStructuredStatus({ ok: false, error: { message: "host is busy" } })?.kind, "unknown");
  assert.equal(classifyEffigyStructuredStatus("not an envelope"), null);
});

test("follow args resume at exact per-stream byte offsets", () => {
  // Argument construction only: `logsFollowArgs` spawns nothing and verifies no bytes.
  const client = new EffigyRunControl({ runtime: { path: "effigy", sha256: "0".repeat(64) }, cwd: tmpdir() });
  assert.deepEqual(client.logsFollowArgs("ci-1234", { stdout: 5120, stderr: 96 }), [
    "run", "logs", "ci-1234", "--follow", "--stdout-offset", "5120", "--stderr-offset", "96",
  ]);
  assert.throws(() => client.logsFollowArgs("bad id", { stdout: 0, stderr: 0 }));
});

test("repeated before and after checks share one read per stable identity, and a rebuild after the spawn is provenance, not a refusal", async t => {
  const dir = mkdtempSync(join(tmpdir(), "effigy-cost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const countFile = join(dir, "spawns");
  const lineCount = () => existsSync(countFile) ? readFileSync(countFile, "utf8").split("\n").filter(Boolean).length : 0;
  const closed = JSON.stringify(runEnvelope({
    evidence_source: "checkout-journal", run_id: "run-1", task: "qa:stage:rust", state: "succeeded", phase: "closed",
    exit_code: 0, cleanup: "complete", started_at_epoch_ms: 1_700_000_000_000, finished_at_epoch_ms: 1_700_000_001_500, duration_ms: 1_500,
  }));
  const binary = join(dir, "effigy");
  const script = `#!/bin/sh
printf '1\\n' >> '${countFile}'
if [ "$2" = "status" ]; then
  echo '${closed}'
  exit 0
fi
echo "unexpected $*" >&2
exit 2
`;
  writeFileSync(binary, script);
  chmodSync(binary, 0o755);
  const client = new EffigyRunControl({
    runtime: { path: binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") },
    cwd: dir,
    timeoutMs: 5_000,
  });

  // Six verifications (before and after each of three calls), one read.
  effigyArtifactDigests.resetCosts();
  for (let call = 0; call < 3; call++) assert.equal((await client.status("run-1")).kind, "closed");
  assert.equal(lineCount(), 3, "each status really ran the artifact: the counting is of real spawns");
  const costs = effigyArtifactDigests.costs();
  assert.equal(costs.hashed, 1, "six before/after verifications read the unchanged artifact once");
  assert.equal(costs.reused, 5, "every later verification is answered from that identity");
  assert.equal(costs.bytesRead, Buffer.byteLength(script));

  // Effigy rebuilt in place by the spawn itself: the same path is still the
  // workload's own Effigy, so its answer stands and the change is provenance
  // (Spec 035, Tom 2026-10-26). Only an unusable executable refuses.
  const replacement = join(dir, "next-effigy");
  writeFileSync(replacement, `#!/bin/sh\nif [ "$2" = "status" ]; then echo '${closed}'; exit 0; fi\nexit 2\n`);
  chmodSync(replacement, 0o755);
  const swapping = join(dir, "effigy-swap");
  writeFileSync(swapping, `#!/bin/sh
if [ "$2" = "status" ]; then
  cp '${replacement}' '${swapping}.next' && chmod 755 '${swapping}.next' && mv '${swapping}.next' '${swapping}'
  echo '${closed}'
  exit 0
fi
exit 2
`);
  chmodSync(swapping, 0o755);
  const swapped = new EffigyRunControl({
    runtime: { path: swapping, sha256: createHash("sha256").update(readFileSync(swapping)).digest("hex") },
    cwd: dir,
    timeoutMs: 5_000,
  });
  assert.equal((await swapped.status("run-1")).kind, "closed", "an answer read across a rebuild stands");
  assert.match(swapped.drift ?? "", /now hashes/, "and the rebuild is recorded as drift");
  assert.equal(await swapped.identityRefusal(), null, "a rebuilt executable is not a refusal");
  assert.equal((await swapped.status("run-1")).kind, "closed", "the next call runs the rebuilt executable");
  rmSync(swapping);
  const gone = await swapped.status("run-1");
  assert.equal(gone.kind, "unknown", "a missing executable refuses before it spawns");
  if (gone.kind === "unknown") assert.match(gone.reason, /is unavailable/);
});

test("a fake v0.15 binary reports status, expired bytes and journal unavailability", async t => {
  const dir = mkdtempSync(join(tmpdir(), "fake-effigy-"));
  const binary = join(dir, "effigy");
  writeFileSync(binary, `#!/bin/sh
cmd="$1 $2"
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  echo "effigy run --run-id <key>"
  echo "  logs --follow --stdout-offset --stderr-offset"
  exit 0
fi
if [ "$2" = "status" ]; then
  key="$3"
  if [ "$key" = "held" ]; then echo "task lock held" >&2; exit 75; fi
  if [ "$key" = "expired" ]; then echo '{"state":"expired","error":"run key aged out of journal retention"}'; exit 2; fi
  if [ "$key" = "not-recorded" ]; then
    echo '{"schema":"effigy.command.v1","ok":false,"result":null,"error":{"kind":"RunnerError","message":"run x: not recorded (foreground or expired); no live holder or retained journal record was found","details":{"state":"not-found","recording":"not-recorded"}}}'
    exit 1
  fi
  if [ "$key" = "journal-text-expired" ]; then echo 'run key aged out of journal retention' >&2; exit 2; fi
  if [ "$key" = "gone-journal" ]; then echo "unreadable journal" >&2; exit 2; fi
  echo '{"schema":"effigy.command.v1","ok":true,"result":{"schema":"effigy.run.v1","run":{"evidence_source":"checkout-journal","run_id":"'"$key"'","task":"qa:stage:rust","state":"succeeded","phase":"closed","exit_code":0,"cleanup":"complete","started_at_epoch_ms":1700000000000,"finished_at_epoch_ms":1700000001500,"duration_ms":1500}}}'
  exit 0
fi
if [ "$2" = "logs" ]; then
  if echo "$*" | grep -q expired-bytes; then echo "expired log bytes" >&2; exit 2; fi
  echo "log-body"
  exit 7
fi
echo "unexpected $*" >&2
exit 2
`);
  chmodSync(binary, 0o755);
  t.after(() => {});
  const client = new EffigyRunControl({
    runtime: { path: binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") },
    cwd: dir,
    timeoutMs: 5_000,
  });
  assert.equal(await client.probeCapability(), "v015-run-control");
  assert.equal((await client.status("held")).kind, "held-lock");
  assert.equal((await client.status("expired")).kind, "expired");
  const notRecorded = await client.status("not-recorded");
  assert.equal(notRecorded.kind, "absent", "the producer's not-found + not-recorded answer is absence, never expiry");
  if (notRecorded.kind === "absent") assert.match(notRecorded.reason, /not recorded \(foreground or expired\)/);
  // A build that gives only text keeps its text reading: no structure, no guess.
  assert.equal((await client.status("journal-text-expired")).kind, "expired");
  assert.equal((await client.status("gone-journal")).kind, "unknown");
  const settled = await client.status("ok-run");
  assert.equal(settled.kind, "closed", "the fake producer's journal record closes the run");
  if (settled.kind === "closed") assert.equal(settled.outcome, "passed");
  const logs = await client.followLogs("expired-bytes", { stdout: 10, stderr: 0 });
  assert.equal(logs.expired, true);
  const follow = await client.followLogs("ok-run", { stdout: 0, stderr: 0 });
  assert.equal(follow.exitCode, 7);
});

const PINNED_EFFIGY = process.env.NUCLEUS_TEST_PINNED_EFFIGY ?? "";
const PINNED_SHA256 = "e4e2d223542ac81c310bab9ac66da757e59ec946a19a4f9294c8aa0ed50f03c4";

test("pinned development Effigy binary admits through the Queue hook in a private HOME", async t => {
  if (!existsSync(PINNED_EFFIGY)) {
    t.skip("pinned development Effigy binary is not on this host");
    return;
  }
  const bytes = readFileSync(PINNED_EFFIGY);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, PINNED_SHA256, "pinned development artifact hash must match the early-implementation pin");
  const home = mkdtempSync(join(tmpdir(), "effigy-dev-home-"));
  const project = mkdtempSync(join(tmpdir(), "effigy-dev-project-"));
  writeFileSync(join(project, "effigy.toml"), `[tasks.heavy-true]
admission = "heavy"
run = "true"
`);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const scheduler = new HostRunScheduler(store, {
    capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }),
  });
  // The workload this hook runs is the pinned artifact itself, so the admission
  // binds before it reserves and the test proves the real default route.
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    stateDir: join(home, "host-run"), watchMs: 50,
    effigyRuntime: { path: PINNED_EFFIGY, sha256: PINNED_SHA256 },
  });
  await endpoint.start();
  t.after(async () => { await endpoint.stop(); });
  const admission = queueOwnedAdmissionEnvironment({
    hookCommand: defaultAdmissionHookCommand(),
    socketPath: endpoint.socketPath,
  });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(PINNED_EFFIGY, ["heavy-true"], {
      cwd: project,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: home,
        LANG: "C",
        ...admission,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 20_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(error) }); });
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const reservations = scheduler.list().filter(run => run.submissionSource === "admission");
  assert.ok(reservations.length >= 1, "the hook reserved Queue capacity for the heavy run");
  assert.equal(reservations[0].effigyRuntime?.sha256, PINNED_SHA256,
    "the reservation was written already bound to the workload's own bytes");
  assert.equal(reservations[0].effigyRuntimeRefusal, undefined);
});

const QUALIFIED_EFFIGY = process.env.NUCLEUS_TEST_QUALIFIED_EFFIGY ?? "";
const QUALIFIED_SHA256 = "dc6a6e9e3829b553d61358db0875ee2fc5d107cd15194a257a6c4560edde8eae";

let qualifiedHashChecked = false;
function requireQualifiedCandidate(): string {
  if (!existsSync(QUALIFIED_EFFIGY))
    throw new Error(`qualified Effigy candidate missing at ${QUALIFIED_EFFIGY}`);
  if (!qualifiedHashChecked) {
    const hash = createHash("sha256").update(readFileSync(QUALIFIED_EFFIGY)).digest("hex");
    assert.equal(hash, QUALIFIED_SHA256, "qualified candidate bytes must match owner packet 8c63bcb9");
    qualifiedHashChecked = true;
  }
  return QUALIFIED_EFFIGY;
}

function privateEffigyEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    PATH: "/usr/bin:/bin",
    ...extra,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function countingHook(countFile: string, hookCommand: string): string {
  return `printf '1\\n' >> ${shellSingleQuote(countFile)}; ${hookCommand}`;
}

function hookCallCount(countFile: string): number {
  if (!existsSync(countFile)) return 0;
  return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
}

function admissionReservations(scheduler: HostRunScheduler) {
  return scheduler.list().filter(run => run.submissionSource === "admission");
}

/**
 * The reservations this endpoint still charges: a producer-closed admission
 * keeps its row (unknown outcome and custody) but its accounting is retired, so
 * a live-slot count is the charged ones.
 */
function chargedAdmissions(scheduler: HostRunScheduler) {
  return admissionReservations(scheduler).filter(run => scheduler.accountingStatus(run.id)?.accounting === "charged");
}

const allRetired = (scheduler: HostRunScheduler) =>
  admissionReservations(scheduler).every(run => scheduler.accountingStatus(run.id)?.accounting === "retired");

/**
 * One reservation's status, read by its own exact Effigy run id and selector —
 * the route the endpoint takes. A key is not an identity here: a reused or
 * changed key never closes the reservation.
 */
async function statusForReservation(
  scheduler: HostRunScheduler,
  home: string,
  selector: string,
): Promise<Awaited<ReturnType<EffigyRunControl["status"]>>> {
  const record = admissionReservations(scheduler).find(run => run.selector === selector);
  assert.ok(record, `an admission reservation for ${selector} exists`);
  assert.ok(record.effigyRunId, `the ${selector} reservation binds its Effigy run id`);
  const client = new EffigyRunControl({
    runtime: { path: record.effigyRuntime!.path, sha256: record.effigyRuntime!.sha256 },
    cwd: record.repository.path,
    env: privateEffigyEnv(home),
    timeoutMs: 8_000,
  });
  return client.status(record.effigyRunId!, { runId: record.effigyRunId!, selector: record.selector });
}

/** Bounded failure diagnostic: each reservation's state, binding and journal events. */
function reservationSummary(scheduler: HostRunScheduler): string {
  return admissionReservations(scheduler).map(run =>
    `${run.state}/${run.effigyRuntime ? "bound" : "unbound"}/${scheduler.store.hostRunJournal(run.id).map(row => row.event).join("+")}`,
  ).join(" | ");
}

/** Every reservation's journal event names, for a bounded failure diagnostic. */
function journalEventNames(scheduler: HostRunScheduler): string[] {
  return admissionReservations(scheduler).flatMap(run =>
    scheduler.store.hostRunJournal(run.id).map(row => `${run.id}:${row.event}`));
}

/**
 * End the admission hook for the newest reservation the way Effigy's run close
 * does, so the endpoint's "hook died" observe path is deterministic under load.
 * The workload's own Effigy process has already exited by the time a test calls
 * this, so the run's recorded outcome is final.
 */
function endAdmissionHook(scheduler: HostRunScheduler): void {
  const pid = admissionReservations(scheduler)[0]?.pid;
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function waitUntil(probe: () => boolean, ms: number, label: string | (() => string)): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (probe()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

function spawnTracked(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  t: { after: (fn: () => void) => void },
): { child: ChildProcess; stdout: () => string; stderr: () => string; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> } {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += chunk; });
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, options.timeoutMs);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(resolve => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on("error", error => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}` });
    });
  });
  return { child, stdout: () => stdout, stderr: () => stderr, done };
}

async function isolatedQualifiedEndpoint(t: { after: (fn: () => void | Promise<void>) => void }, home: string, project: string) {
  const store = new Store(":memory:");
  const scheduler = new HostRunScheduler(store, {
    capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }),
  });
  const runtimePath = requireQualifiedCandidate();
  // The production route: the endpoint runs the declared artifact for both the
  // admitted workload's image and the observation, with no injected observer.
  // The observation reads the run journal from the workload's private host
  // environment; nothing here may touch the operator's own Effigy state.
  const endpoint = new EffigyAdmissionEndpoint(scheduler, {
    // Short state dir: macOS unix sockets cap sun_path at 104 bytes.
    stateDir: join(home, "s"),
    watchMs: 50,
    effigyRuntime: { path: runtimePath, sha256: QUALIFIED_SHA256 },
    environment: privateEffigyEnv(home),
  });
  await endpoint.start();
  // Stop the endpoint before the store closes: a watch tick over a closed store
  // is shutdown noise, not a lifecycle result.
  t.after(async () => { await endpoint.stop(); });
  t.after(() => store.close());
  return { scheduler, endpoint };
}

test("the qualified candidate's own not-recorded answer is absence, not expiry", async t => {
  if (!existsSync(QUALIFIED_EFFIGY)) {
    t.skip("qualified Effigy candidate is not on this host");
    return;
  }
  requireQualifiedCandidate();
  const home = mkdtempSync(join(tmpdir(), "eqnr-h-"));
  const project = mkdtempSync(join(tmpdir(), "eqnr-p-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });
  const client = new EffigyRunControl({
    runtime: { path: QUALIFIED_EFFIGY, sha256: QUALIFIED_SHA256 },
    cwd: project,
    env: privateEffigyEnv(home),
    timeoutMs: 15_000,
  });
  // The exact qualified bytes, in a checkout with no foreground holder and no
  // journal row for this id, answer structured not-found + not-recorded: the
  // producer looked for a held foreground gate and a journal record and found
  // neither. Absence, never expiry and never a statement that the workload ended.
  const observation = await client.status("foreground-not-recorded-414");
  assert.equal(observation.kind, "absent", JSON.stringify(observation));
  if (observation.kind === "absent") {
    assert.match(observation.reason, /not recorded \(foreground or expired\)/);
    assert.match(observation.reason, /no live holder or retained journal record/);
  }
});

test("qualified candidate denies unreachable Queue and does not run the workload", async t => {
  const binary = requireQualifiedCandidate();
  const home = mkdtempSync(join(tmpdir(), "eqd-h-"));
  const project = mkdtempSync(join(tmpdir(), "eqd-p-"));
  const countFile = join(home, "hook-count");
  writeFileSync(join(project, "effigy.toml"), `[tasks.heavy-marker]
admission = "heavy"
run = "sh -c 'echo RAN > MARKER'"
`);
  const hook = countingHook(countFile, defaultAdmissionHookCommand());
  const result = await spawnTracked(binary, ["heavy-marker"], {
    cwd: project,
    env: privateEffigyEnv(home, {
      EFFIGY_ADMISSION_HOOK: hook,
      QUEUE_ADMISSION_SOCKET: join(home, "no-such-admission.sock"),
      EFFIGY_ADMISSION_HOOK_TIMEOUT_MS: "3600000",
    }),
    timeoutMs: 15_000,
  }, t).done;
  assert.notEqual(result.code, 0, result.stderr || result.stdout);
  assert.match(`${result.stderr}\n${result.stdout}`, /not admitted|deny Queue admission service unreachable/i);
  assert.equal(existsSync(join(project, "MARKER")), false, "denied heavy work must not run the task command");
  assert.equal(hookCallCount(countFile), 1, "the hook still ran and denied");
});

test("qualified candidate admits, holds the slot until the producer closes, and nested heavy takes one reservation", async t => {
  const binary = requireQualifiedCandidate();
  const home = mkdtempSync(join(tmpdir(), "eqa-h-"));
  const project = mkdtempSync(join(tmpdir(), "eqa-p-"));
  const countFile = join(home, "hook-count");
  writeFileSync(join(project, "effigy.toml"), `[tasks.held]
admission = "heavy"
run = "sh -c 'echo start > STARTED; sleep 2; echo done > DONE'"

[tasks.child]
admission = "heavy"
run = "sh -c 'echo nested-child > CHILD'"

[tasks.parent]
admission = "heavy"
run = [{ task = "child" }]
`);
  const { scheduler, endpoint } = await isolatedQualifiedEndpoint(t, home, project);
  const probe = new EffigyRunControl({
    runtime: { path: binary, sha256: QUALIFIED_SHA256 }, cwd: project, env: privateEffigyEnv(home), timeoutMs: 8_000,
  });
  assert.equal(await probe.probeCapability(), "v015-run-control");
  const admission = queueOwnedAdmissionEnvironment({
    hookCommand: countingHook(countFile, defaultAdmissionHookCommand()),
    socketPath: endpoint.socketPath,
  });

  const held = spawnTracked(binary, ["--run-id", "held-slot-1", "held"], {
    cwd: project,
    env: privateEffigyEnv(home, admission),
    timeoutMs: 20_000,
  }, t);
  await waitUntil(() => existsSync(join(project, "STARTED")), 8_000, "held workload started");
  const live = admissionReservations(scheduler);
  assert.equal(live.length, 1, "exactly one admission reservation while the run is live");
  assert.ok(live[0].state === "running" || live[0].state === "admitted", `reservation ${live[0].state}`);
  await waitUntil(() => Boolean(admissionReservations(scheduler)[0]?.effigyRuntime), 8_000,
    `reservation bound to the declared artifact (${JSON.stringify(admissionReservations(scheduler)[0]?.effigyRuntimeRefusal ?? null)})`);
  const binding = admissionReservations(scheduler)[0].effigyRuntime!;
  assert.equal(binding.sha256, QUALIFIED_SHA256, "the binding is the qualified candidate's exact bytes");
  assert.equal(binding.path, realpathSync(binary));
  assert.equal(binding.workloadPath, realpathSync(binary), "the admitted workload ran that same image");
  const heldResult = await held.done;
  assert.equal(heldResult.code, 0, heldResult.stderr || heldResult.stdout);
  assert.equal(existsSync(join(project, "DONE")), true);
  endAdmissionHook(scheduler);
  await waitUntil(() => allRetired(scheduler), 8_000,
    () => `held reservation retired (${reservationSummary(scheduler)} ${JSON.stringify(journalEventNames(scheduler))})`);
  const heldStatus = await statusForReservation(scheduler, home, "held");
  assert.equal(heldStatus.kind, "closed", `the candidate's journal record closes the reservation (${JSON.stringify(heldStatus)})`);
  if (heldStatus.kind === "closed") {
    assert.equal(heldStatus.outcome, "passed");
    assert.equal(heldStatus.closure.state, "succeeded");
    assert.equal(heldStatus.closure.exitCode, 0);
  }

  const nested = spawnTracked(binary, ["--run-id", "nested-1", "parent"], {
    cwd: project,
    env: privateEffigyEnv(home, admission),
    timeoutMs: 15_000,
  }, t);
  await waitUntil(() => existsSync(join(project, "CHILD")), 8_000, "nested heavy child ran");
  const nestedLive = chargedAdmissions(scheduler);
  assert.equal(nestedLive.length, 1, "nested child must not take a second live reservation");
  const nestedResult = await nested.done;
  assert.equal(nestedResult.code, 0, nestedResult.stderr || nestedResult.stdout);
  endAdmissionHook(scheduler);
  await waitUntil(() => allRetired(scheduler), 8_000,
    () => `nested reservation retired (${reservationSummary(scheduler)} ${JSON.stringify(journalEventNames(scheduler))})`);
  assert.equal(admissionReservations(scheduler).length, 2, "held + parent group; nested child did not reserve");
  assert.equal(hookCallCount(countFile), 2, "parent group admitted once; nested child did not take a second hook");
});

test("qualified candidate cancel and crash retire the accounting with the real Effigy verdict", async t => {
  const binary = requireQualifiedCandidate();
  const home = mkdtempSync(join(tmpdir(), "eqs-h-"));
  const project = mkdtempSync(join(tmpdir(), "eqs-p-"));
  writeFileSync(join(project, "effigy.toml"), `[tasks.long]
admission = "heavy"
run = "sh -c 'echo started > STARTED; sleep 30; echo should-not-finish > LATE'"

[tasks.crash]
admission = "heavy"
run = "sh -c 'exit 17'"
`);
  const { scheduler, endpoint } = await isolatedQualifiedEndpoint(t, home, project);
  const admission = queueOwnedAdmissionEnvironment({
    hookCommand: defaultAdmissionHookCommand(),
    socketPath: endpoint.socketPath,
  });
  const env = privateEffigyEnv(home, admission);

  const longRun = spawnTracked(binary, ["--run-id", "cancel-1", "long"], {
    cwd: project, env, timeoutMs: 25_000,
  }, t);
  await waitUntil(() => existsSync(join(project, "STARTED")), 8_000, "cancel workload started");
  const stop = await spawnTracked(binary, ["run", "stop", "cancel-1", "--wait-ms", "8000"], {
    cwd: project, env, timeoutMs: 12_000,
  }, t).done;
  assert.equal(stop.code, 0, stop.stderr || stop.stdout);
  const longResult = await longRun.done;
  assert.notEqual(longResult.code, 0, "stopped run must not look like success");
  endAdmissionHook(scheduler);
  assert.equal(existsSync(join(project, "LATE")), false);
  await waitUntil(() => allRetired(scheduler), 8_000,
    () => `cancel reservation retired (${reservationSummary(scheduler)} ${JSON.stringify(journalEventNames(scheduler))})`);
  const cancelled = await statusForReservation(scheduler, home, "long");
  assert.equal(cancelled.kind, "closed", `a stopped candidate run keeps its producer closure (${JSON.stringify(cancelled)})`);
  if (cancelled.kind === "closed") {
    assert.equal(cancelled.closure.state, "cancelled");
    assert.equal(cancelled.outcome, "failed");
    // Whatever is carried is the producer's own answer: its numeric signal when
    // it reported one, else its own exit code. Queue never fills either in.
    assert.equal((cancelled.exitCode === null) !== (cancelled.signal === null), true,
      `exactly one of exit code and signal is carried (${JSON.stringify(cancelled)})`);
    if (cancelled.signal !== null) assert.match(cancelled.signal, /^SIG/);
    else assert.notEqual(cancelled.exitCode, 0);
  }

  const crash = await spawnTracked(binary, ["--run-id", "crash-1", "crash"], {
    cwd: project, env, timeoutMs: 15_000,
  }, t).done;
  assert.equal(crash.code, 17, crash.stderr || crash.stdout);
  endAdmissionHook(scheduler);
  await waitUntil(() => allRetired(scheduler), 8_000,
    () => `crash reservation retired (${reservationSummary(scheduler)} ${JSON.stringify(journalEventNames(scheduler))})`);
  const crashed = await statusForReservation(scheduler, home, "crash");
  assert.equal(crashed.kind, "closed");
  if (crashed.kind === "closed") assert.equal(crashed.exitCode, 17);
});

test("qualified candidate lost follow reattaches at delivered offsets and keeps the real exit", async t => {
  const binary = requireQualifiedCandidate();
  const home = mkdtempSync(join(tmpdir(), "eqf-h-"));
  const project = mkdtempSync(join(tmpdir(), "eqf-p-"));
  writeFileSync(join(project, "effigy.toml"), `[tasks.follow]
admission = "heavy"
run = "sh -c 'echo alpha; sleep 3; echo beta; exit 9'"
`);
  const { scheduler, endpoint } = await isolatedQualifiedEndpoint(t, home, project);
  const admission = queueOwnedAdmissionEnvironment({
    hookCommand: defaultAdmissionHookCommand(),
    socketPath: endpoint.socketPath,
  });
  const env = privateEffigyEnv(home, admission);
  const run = spawnTracked(binary, ["--run-id", "follow-1", "follow"], {
    cwd: project, env, timeoutMs: 20_000,
  }, t);
  await waitUntil(() => admissionReservations(scheduler).length >= 1, 8_000, "follow run reserved capacity");
  const first = spawnTracked(binary, ["run", "logs", "follow-1", "--follow"], {
    cwd: project, env, timeoutMs: 15_000,
  }, t);
  await waitUntil(() => first.stdout().includes("alpha"), 8_000, `first follow received alpha (stdout=${JSON.stringify(first.stdout())})`);
  const delivered = Buffer.byteLength(first.stdout());
  first.child.kill("SIGKILL");
  await first.done;
  const second = await spawnTracked(binary, [
    "run", "logs", "follow-1", "--follow",
    "--stdout-offset", String(delivered),
    "--stderr-offset", "0",
  ], { cwd: project, env, timeoutMs: 15_000 }, t).done;
  const runResult = await run.done;
  assert.equal(runResult.code, 9, runResult.stderr || runResult.stdout);
  endAdmissionHook(scheduler);
  assert.match(second.stdout, /beta/);
  assert.equal(second.stdout.includes("alpha"), false, "reattach must resume at the delivered offset, not replay");
  assert.equal(second.code, 9, second.stderr || second.stdout);
  await waitUntil(() => allRetired(scheduler), 8_000,
    () => `follow reservation retired (${reservationSummary(scheduler)} ${JSON.stringify(journalEventNames(scheduler))})`);
});

