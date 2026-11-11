/**
 * Queue's v0.15 Effigy run-control client (Spec 035).
 *
 * Capability is probed from `effigy run --help` (`--run-id`, `run logs`), never
 * from `--version` or PATH alone. Installed v0.14.1 stays on contract 010 until
 * an explicit operator cutover. Exit 75 is a held task lock only; 77 has no
 * scheduler meaning. A key whose journal row has aged out of the newest-20
 * settled runs is retention expiry, not proven non-execution: Queue never
 * resubmits that key as a fresh run. The producer's structured
 * `error.details.state`/`recording` is read before any text match, so its
 * "not recorded (foreground or expired)" answer is an absence of evidence
 * (`unknown`, custody retained), never expiry.
 *
 * `status` reports the producer's one positive closure (Spec 035, "Producer
 * closure"): a `checkout-journal` record for the exact run id and selector whose
 * `cleanup` is `complete`. `exit_code` and `signal` are that record's workload
 * verdict and nothing more; every other answer is an `unclosed` hold that names
 * the exact field which refused it. Queue maps the producer's numeric signal to
 * this host's own name for the verdict reading and never invents one — and it
 * writes no Contract 010 settlement from it: an admission is observed, not
 * supervised, so closure retires the reservation's accounting and leaves its
 * outcome and custody UNKNOWN ("Automatic accounting on producer cleanup").
 *
 * Every call is bound to one recorded Effigy runtime (`runtime`): its path is
 * verified before each spawn and again after it, so a missing, unreadable or
 * non-executable artifact refuses instead of spawning a substitute. `status`
 * then reports `unknown` (custody is retained), `followLogs` reports the
 * refusal and spawns nothing, and `probeCapability` reports `unknown`. Bytes
 * that changed since binding (Effigy rebuilt in place) are not a refusal: the
 * same path still observes, the call's answer stands, and the change is kept
 * in `drift` as provenance (Spec 035, Tom 2026-10-26).
 */
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import {
  verifyEffigyRuntime,
  type EffigyRuntimeIdentity,
  type EffigyRuntimeVerification,
} from "./effigy-runtime";

export const EFFIGY_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const EFFIGY_EXIT_HELD_TASK_LOCK = 75;

export type EffigyRunCapability = "v015-run-control" | "v014-host-run" | "unknown";

/**
 * Why a producer record does not close a reservation. Each cause is a distinct
 * visible hold: the run is not observed to have closed its custody, so its
 * capacity stays held and the row records exactly which field refused it.
 */
export type EffigyClosureRefusal =
  | "not-journal-backed"
  | "live-foreground"
  | "cleanup-incomplete"
  | "cleanup-absent"
  | "cleanup-unknown"
  | "run-id-mismatch"
  | "selector-mismatch"
  | "verdict-unknown";

/**
 * The producer's own record for one exact run, as `run status --json` reports it
 * at qualified `efc1478` (`src/runner/task_engine/status.rs` RunView): the
 * evidence source, the run id and selector it was admitted for, the workload
 * verdict (`exit_code`/numeric `signal`), the cleanup closure and the
 * producer's own timestamps. Queue consumes only these shipped fields; nothing
 * here is inferred from exit 75, a pid, a hook's death or elapsed time.
 */
export interface EffigyProducerClosure {
  runId: string;
  selector: string | null;
  state: string;
  exitCode: number | null;
  /** The producer's numeric POSIX signal, or null when it reported none. */
  signal: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

/**
 * What one `run status` call says about a reservation's custody.
 *
 * `closed` is the ONLY positive closure: the producer reported a
 * `checkout-journal` record for the exact run whose `cleanup` is `complete`.
 * `exitCode`/`signal` are that record's workload verdict as Contract 010's result
 * would carry it (one of the two, never both, never invented); the producer's own
 * report stays in `closure`. Closure is producer evidence: it retires the
 * reservation's accounting and writes no result. Every other answer keeps
 * custody: `unclosed` names the exact field that refused.
 */
export type EffigyRunObservation =
  | {
    kind: "closed";
    closure: EffigyProducerClosure;
    /** The workload verdict: passed only for the producer's own success. */
    outcome: "passed" | "failed";
    /** The producer's `exit_code`, or null when its signal is carried instead. */
    exitCode: number | null;
    /** Host POSIX name for the producer's numeric signal, or null. */
    signal: string | null;
  }
  | { kind: "unclosed"; cause: EffigyClosureRefusal; reason: string }
  | { kind: "live"; state: string }
  | { kind: "unknown"; reason: string }
  /**
   * The producer's structured `not-found` AND `not-recorded` for this run id:
   * at the qualified producer, its held-gate inventory found no foreground
   * holder of the run and its journal has no record (Spec 035, "Retired runs age
   * out, and dead foreground runs retire"). Absence of a holder, never proof the
   * workload ended or that nothing escaped.
   */
  | { kind: "absent"; reason: string; message: string }
  | { kind: "expired"; reason: string }
  | { kind: "held-lock"; reason: string };

/** The exact reservation a status answer must name to close it. */
export interface EffigyStatusExpectation {
  /** The Effigy run id the reservation was admitted under. */
  runId?: string;
  /** The selector (`task`) the reservation was admitted for. */
  selector?: string;
}

export interface EffigyRunControlOptions {
  /** The executable Queue runs: the workload's own Effigy, with its bytes at binding. */
  runtime: EffigyRuntimeIdentity;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: typeof spawn;
}

export function assertEffigyRunId(runId: string): string {
  if (!EFFIGY_RUN_ID_PATTERN.test(runId)) throw new Error(`Effigy --run-id must be 1–128 of A–Z a–z 0–9 . _ : - (got ${JSON.stringify(runId)})`);
  return runId;
}

export function classifyEffigyRunHelp(helpText: string): EffigyRunCapability {
  const textValue = helpText.toLowerCase();
  const hasRunId = /--run-id/.test(textValue);
  const hasFollowLogs = /--follow/.test(textValue) && (/\brun\s+logs\b/.test(textValue) || /\blogs\b/.test(textValue));
  if (hasRunId && hasFollowLogs) return "v015-run-control";
  if (/host-run-request-id|host_run_token|effigy_host_scheduler/.test(textValue)) return "v014-host-run";
  return "unknown";
}

/**
 * Candidate `run status --json` wraps `effigy.run.v1` in `effigy.command.v1`.
 * A live run sends `exit_code: null`; that is not a terminal observation.
 */
export function unwrapEffigyRunRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const result = row.result;
  if (result && typeof result === "object") {
    const inner = result as Record<string, unknown>;
    if (inner.run && typeof inner.run === "object") return inner.run as Record<string, unknown>;
    return inner;
  }
  if (row.run && typeof row.run === "object") return row.run as Record<string, unknown>;
  return row;
}

const LIVE_STATES = /^(running|starting|admitted|queued|waiting|pending|stopping|active)$/;
/** The producer states that report a workload verdict, not just a closed row. */
const VERDICT_STATES = new Set(["succeeded", "failed", "cancelled", "canceled", "timed-out", "timed_out"]);
/** Producer states that answer about a closed run (`status.rs` closed_state). */
const CLOSED_STATES = new Set([
  ...VERDICT_STATES, "failed-cleanup", "interrupted", "not-started", "unknown",
  // Older or unshipped spellings still answer about a closed row; they are held
  // for their verdict, never closed on a state name alone.
  "settled", "terminal", "exited", "passed", "complete",
]);

/**
 * Positive producer closure (Spec 035, "Producer closure"): a `checkout-journal`
 * record for the exact run and selector whose `cleanup` is `complete`. Exit code
 * and signal are read from that record as the workload verdict only; they never
 * close a reservation by themselves, and no field Queue did not receive is
 * filled in for them. The observer keeps this closure as producer evidence,
 * retires the reservation's accounting on it and writes no Contract 010 result.
 */
export function classifyEffigyStatusPayload(
  payload: unknown,
  exitCode: number | null,
  expectation: EffigyStatusExpectation = {},
): EffigyRunObservation {
  if (exitCode === EFFIGY_EXIT_HELD_TASK_LOCK)
    return { kind: "held-lock", reason: "Effigy exit 75 is a held task lock" };
  const row = unwrapEffigyRunRecord(payload);
  if (row) {
    const state = String(row.state ?? row.status ?? "");
    const stateLc = state.toLowerCase();
    const message = String(row.error ?? row.reason ?? row.message ?? "");
    if (/expired|retention/.test(message) || stateLc === "expired")
      return { kind: "expired", reason: message || "run key aged out of journal retention" };
    if (LIVE_STATES.test(stateLc)) return { kind: "live", state: state || "running" };
    const exitEvidence = producerNumber(row, ["exit_code", "exitCode"], "exit code", Number.isInteger);
    const signalEvidence = producerNumber(row, ["signal"], "signal", value => Number.isInteger(value) && value > 0);
    if ("unreadable" in exitEvidence || "unreadable" in signalEvidence) {
      // A value the producer *did* report and Queue cannot carry as its own
      // numeric verdict is not an absent one: collapsing it to null would let an
      // invalid record stand in for a bare closure, and a bare `interrupted`
      // record retires accounting. Malformed or contradictory verdict evidence
      // holds instead.
      const unreadable = [exitEvidence, signalEvidence]
        .flatMap(evidence => "unreadable" in evidence ? [evidence.unreadable] : [])
        .join(" and ");
      return {
        kind: "unclosed", cause: "verdict-unknown",
        reason: `Effigy reported ${unreadable} for run ${typeof row.run_id === "string" && row.run_id ? row.run_id : "(unnamed)"} (state "${state || "unknown"}"); a present value Nucleus cannot carry as the producer's own verdict is not an absent one, so there is no verdict to record and nothing is recorded as closure`,
      };
    }
    const observedExit = exitEvidence.value;
    const observedSignal = signalEvidence.value;
    if (!state && observedExit === null && observedSignal === null) {
      if (exitCode === 0) return { kind: "unknown", reason: "run status produced no recognised payload" };
      return { kind: "unknown", reason: `run status exited ${exitCode ?? "without a code"}` };
    }
    if (!CLOSED_STATES.has(stateLc) && observedExit === null && observedSignal === null)
      return { kind: "live", state: state || "running" };

    const evidence = String(row.evidence_source ?? "").trim().toLowerCase();
    const closure: EffigyProducerClosure = {
      runId: typeof row.run_id === "string" ? row.run_id : "",
      selector: typeof row.task === "string" ? row.task : null,
      state: state || "unknown",
      exitCode: observedExit,
      signal: observedSignal,
      startedAt: isoFromEpochMs(row.started_at_epoch_ms),
      endedAt: isoFromEpochMs(row.finished_at_epoch_ms),
      durationMs: numberOrNull(row.duration_ms),
    };
    if (evidence !== "checkout-journal")
      return evidence === "live-foreground"
        ? {
          kind: "unclosed", cause: "live-foreground",
          reason: `Effigy reports the run only as live foreground custody (state "${closure.state}"); a foreground run keeps no durable closure, so nothing is recorded as closure`,
        }
        : {
          kind: "unclosed", cause: "not-journal-backed",
          reason: `Effigy did not report a checkout-journal record for run ${closure.runId || "(unnamed)"} (evidence source ${evidence || "missing"}); nothing is recorded as closure`,
        };
    if (!closure.runId || (expectation.runId !== undefined && closure.runId !== expectation.runId))
      return {
        kind: "unclosed", cause: "run-id-mismatch",
        reason: `Effigy reported run ${closure.runId || "(unnamed)"} where the reservation binds ${expectation.runId ?? "an exact run id"}; a changed or reused key never closes this reservation`,
      };
    if (closure.selector === null || (expectation.selector !== undefined && closure.selector !== expectation.selector))
      return {
        kind: "unclosed", cause: "selector-mismatch",
        reason: `Effigy reported the run for selector ${JSON.stringify(closure.selector)} where this reservation was admitted for ${JSON.stringify(expectation.selector ?? "an unnamed selector")}; a run of another task never closes this reservation`,
      };
    const cleanup = row.cleanup === undefined || row.cleanup === null ? "" : String(row.cleanup).trim().toLowerCase();
    if (cleanup === "")
      return {
        kind: "unclosed", cause: "cleanup-absent",
        reason: `Effigy reported no cleanup field for run ${closure.runId} (state "${closure.state}"); an absent cleanup never proves closure, so nothing is recorded as closure`,
      };
    if (cleanup === "incomplete")
      return {
        kind: "unclosed", cause: "cleanup-incomplete",
        reason: `Effigy reports cleanup incomplete for run ${closure.runId} (state "${closure.state}"); residue keeps the reservation held`,
      };
    if (cleanup !== "complete")
      return {
        kind: "unclosed", cause: "cleanup-unknown",
        reason: `Effigy reported cleanup ${JSON.stringify(cleanup)} for run ${closure.runId}; only a reported complete cleanup closes a reservation`,
      };
    // Tom, 2026-10-27: an `interrupted` run whose cleanup is complete is closed.
    // Nothing of it is left to hold, and it never passed; the producer's own
    // exit code or signal stays on the evidence when it reported one.
    const interrupted = stateLc === "interrupted";
    if (!VERDICT_STATES.has(stateLc) && !interrupted)
      return {
        kind: "unclosed", cause: "verdict-unknown",
        reason: `Effigy closed run ${closure.runId} with cleanup complete but state "${closure.state}", which is not a workload verdict; nothing is recorded as closure`,
      };
    // A cancelled workload reports both its numeric signal and the producer's own
    // 128+signal exit code. Contract 010 carries exactly one: a signal this host
    // can name is the truthful one, else the producer's own exit code is.
    const signalName = observedSignal === null ? null : hostSignalName(observedSignal);
    const carriedExit = signalName === null ? observedExit : null;
    if (carriedExit === null && signalName === null && !interrupted)
      return {
        kind: "unclosed", cause: "verdict-unknown",
        reason: `Effigy closed run ${closure.runId} (state "${closure.state}", cleanup complete) without an exit code or signal; there is no verdict to record, so nothing is recorded as closure`,
      };
    const outcome = stateLc === "succeeded" && observedExit === 0 ? "passed" : "failed";
    return { kind: "closed", closure, outcome, exitCode: carriedExit, signal: signalName };
  }
  if (exitCode === 0) return { kind: "unknown", reason: "run status produced no recognised payload" };
  return { kind: "unknown", reason: `run status exited ${exitCode ?? "without a code"}` };
}

/**
 * The host's own name for a signal number. Queue only ever maps a number the
 * producer reported; a number this host cannot name stays the producer's own
 * exit code rather than becoming an invented name.
 */
export function hostSignalName(signal: number): string | null {
  if (!Number.isInteger(signal) || signal <= 0) return null;
  let name: string | null = null;
  for (const [candidate, number] of Object.entries(hostSignals)) {
    if (number !== signal) continue;
    if (name === null || candidate < name) name = candidate;
  }
  return name;
}

const hostSignals: Record<string, number> = Object.fromEntries(
  Object.entries(osConstants.signals).filter(([, number]) => typeof number === "number"),
) as Record<string, number>;

function isoFromEpochMs(value: unknown): string | null {
  const ms = numberOrNull(value);
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One numeric field as the producer reported it: the number, `null` when the
 * record carries no value at all, or what it did report when Queue cannot carry
 * it. Absent and unreadable stay distinct, because only an absent value is the
 * producer saying it has nothing to report.
 */
type ProducerNumber = { value: number | null } | { unreadable: string };

function producerNumber(
  row: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  carryable: (value: number) => boolean,
): ProducerNumber {
  let value: number | null = null;
  let seen = false;
  for (const key of keys) {
    const raw = row[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !carryable(raw))
      return { unreadable: `${label} ${describeReported(raw)}` };
    if (seen && raw !== value) return { unreadable: `${label} ${value} and ${raw} (contradictory)` };
    value = raw;
    seen = true;
  }
  return { value };
}

/** The reported value for a hold's reason, short and never interpreted. */
function describeReported(value: unknown): string {
  const json = JSON.stringify(value);
  const text = json === undefined ? String(value) : json;
  return `${text.length > 60 ? `${text.slice(0, 60)}…` : text} (${Array.isArray(value) ? "array" : typeof value})`;
}

/**
 * One `run status --json` refusal, as the producer structured it. The
 * `effigy.command.v1` envelope carries `error.details.state` and
 * `error.details.recording` beside its message; those fields, not the wording,
 * decide whether a key is gone because it expired.
 */
export interface EffigyStructuredStatusError {
  state: string;
  recording: string;
  message: string;
}

export function effigyStructuredStatusError(payload: unknown): EffigyStructuredStatusError | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (row.ok !== false) return null;
  const error = row.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : {};
  const state = String(details.state ?? "").trim().toLowerCase();
  const recording = String(details.recording ?? "").trim().toLowerCase();
  const message = String(record.message ?? "").trim();
  if (!state && !recording && !message) return null;
  return { state, recording, message };
}

/**
 * The producer's structured answer, read before any text match.
 *
 * `recording: "not-recorded"` with `state: "not-found"` is what a foreground
 * Effigy run leaves behind: the producer kept no journal row and holds no live
 * holder, and its own message says so — "not recorded (foreground or expired)".
 * The producer cannot tell a foreground run from an expired key there, so
 * neither can Queue: that answer is `unknown` (custody retained), never
 * `expired`, and never proof about the workload. Only a structured expiry
 * (`state`/`recording` naming expiry or retention) is `expired`.
 */
export function classifyEffigyStructuredStatus(payload: unknown): EffigyRunObservation | null {
  const structured = effigyStructuredStatusError(payload);
  if (!structured) return null;
  const { state, recording, message } = structured;
  if (/expired|retention/.test(state) || /expired|retention/.test(recording))
    return { kind: "expired", reason: message || `Effigy reports the run journal entry is ${state || recording}` };
  // Both structured fields, exactly: the producer looked for a foreground
  // holder and a journal record of this run and found neither. One field alone
  // stays an absence of evidence.
  if (state === "not-found" && recording === "not-recorded")
    return { kind: "absent", message, reason: message || "Effigy has no foreground holder or journal record of this run (state not-found, recording not-recorded)" };
  if (state === "not-found" || recording === "not-recorded")
    return {
      kind: "unknown",
      reason: message || `Effigy has no live holder or retained journal record (state ${state || "unknown"}, recording ${recording || "unknown"})`,
    };
  // Any other refusal is an answer Queue may not interpret as a result.
  return { kind: "unknown", reason: message || `Effigy reports state ${state || "unknown"}, recording ${recording || "unknown"}` };
}

export class EffigyRunControl {
  constructor(private readonly options: EffigyRunControlOptions) {}

  async probeCapability(): Promise<EffigyRunCapability> {
    const call = await this.runVerified(["run", "--help"]);
    if (call.refusal) return "unknown";
    const help = `${call.stdout}\n${call.stderr}`;
    return classifyEffigyRunHelp(help);
  }

  /**
   * Why the bound runtime cannot run right now; null when it can. Bytes that
   * changed since binding (Effigy rebuilt in place) are not a refusal: the same
   * path is still the workload's own Effigy, and the drift is kept in `drift`
   * as provenance (Spec 035, Tom 2026-10-26).
   */
  async identityRefusal(): Promise<string | null> {
    let verification: EffigyRuntimeVerification;
    try {
      verification = await verifyEffigyRuntime(this.options.runtime);
    } catch (error) {
      return `Effigy runtime ${this.options.runtime.path} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (verification.kind === "unavailable") return `Effigy runtime ${this.options.runtime.path} is unavailable: ${verification.reason}`;
    this.drift = verification.kind === "drift" ? verification.reason : this.drift;
    return null;
  }
  /** The latest observed change of the bound executable's bytes since binding, if any: provenance only. */
  drift: string | null = null;

  /**
   * One exact run's status. `expectation` names the reservation's own run id and
   * selector, so a record for another run (a changed selector, a reused key) is
   * refused rather than closing this reservation.
   */
  async status(runId: string, expectation: EffigyStatusExpectation = {}): Promise<EffigyRunObservation> {
    assertEffigyRunId(runId);
    const result = await this.runVerified(["run", "status", runId, "--json"]);
    if (result.refusal) return { kind: "unknown", reason: result.refusal };
    if (result.exitCode === EFFIGY_EXIT_HELD_TASK_LOCK)
      return { kind: "held-lock", reason: result.stderr.trim() || "Effigy exit 75 is a held task lock" };
    const output = `${result.stdout}\n${result.stderr}`;
    let payload: unknown = null;
    let parsed = false;
    const trimmed = result.stdout.trim();
    if (trimmed) {
      try { payload = JSON.parse(trimmed); parsed = true; }
      catch { /* no envelope: the producer's own text is the only evidence left */ }
    }
    // Structured state and recording come first: a message that mentions expiry
    // must never outrank the fields that say what the producer actually found.
    const structured = classifyEffigyStructuredStatus(payload);
    if (structured) return structured;
    if (/journal.*(unavail|unreadable|missing)|unreadable journal/i.test(output))
      return { kind: "unknown", reason: result.stderr.trim() || "Effigy journal is unavailable" };
    if (/expired|retention/i.test(output))
      return { kind: "expired", reason: result.stderr.trim() || "run key aged out of journal retention" };
    if (trimmed && !parsed) return { kind: "unknown", reason: "run status JSON was unreadable" };
    return classifyEffigyStatusPayload(payload, result.exitCode, { ...expectation, runId: expectation.runId ?? runId });
  }

  logsFollowArgs(runId: string, offsets: { stdout: number; stderr: number }): string[] {
    assertEffigyRunId(runId);
    return [
      "run", "logs", runId, "--follow",
      "--stdout-offset", String(offsets.stdout),
      "--stderr-offset", String(offsets.stderr),
    ];
  }

  async followLogs(runId: string, offsets: { stdout: number; stderr: number }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    expired: boolean;
    journalUnavailable: boolean;
    /** Non-null when the bound runtime refused, so its answer may not be used. */
    identityRefusal: string | null;
  }> {
    const result = await this.runVerified(this.logsFollowArgs(runId, offsets));
    if (result.refusal)
      return { exitCode: null, stdout: "", stderr: result.refusal, expired: false, journalUnavailable: false, identityRefusal: result.refusal };
    const combined = `${result.stdout}\n${result.stderr}`;
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      expired: /expired/.test(combined),
      journalUnavailable: /journal.*(unavail|unreadable|missing)|unreadable journal/i.test(combined),
      identityRefusal: null,
    };
  }

  /**
   * One run-control call whose answer is only usable while the bound path is
   * still a runnable executable: verified before the spawn and again once the
   * child has closed, so a path that vanishes or is re-pointed in between cannot
   * answer for the run. Bytes that changed in place are recorded as provenance
   * and the answer stands.
   */
  private async runVerified(args: string[]): Promise<{
    refusal: string | null;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }> {
    const before = await this.identityRefusal();
    if (before) return { refusal: before, exitCode: null, stdout: "", stderr: before };
    const result = await this.run(args, { allowFailure: true });
    const after = await this.identityRefusal();
    if (after)
      return {
        refusal: `Effigy runtime ${this.options.runtime.path} became unavailable during the call: ${after}`,
        exitCode: null, stdout: "", stderr: after,
      };
    return { refusal: null, ...result };
  }

  private run(args: string[], options: { allowFailure?: boolean } = {}): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }> {
    const spawnImpl = this.options.spawn ?? spawn;
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const child = spawnImpl(this.options.runtime.path, args, {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        reject(new Error(`effigy ${args.join(" ")} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      const stdout = collectStream(child.stdout);
      const stderr = collectStream(child.stderr);
      child.once("error", error => {
        clearTimeout(timer);
        if (options.allowFailure) resolve({ exitCode: null, stdout: stdout.value, stderr: stderr.value });
        else reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: signal ? null : code, stdout: stdout.value, stderr: stderr.value });
      });
    });
  }
}

function collectStream(stream: NodeJS.ReadableStream | null): { value: string } {
  const collected = { value: "" };
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => { collected.value += chunk; });
  return collected;
}
