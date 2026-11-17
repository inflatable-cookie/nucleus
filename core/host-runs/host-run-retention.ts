import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  join,
} from "node:path";
import {
  type HostRunInternalRecord,
  type ProjectQaRun,
} from "../../shared/contracts";
import type { RepositoryRekeyReceipt } from "../../shared/repository-rekey";
import {
  HOST_RUN_RETENTION_CURSOR_META,
  HOST_RUN_RETENTION_ERROR_META,
  HOST_RUN_RETENTION_SWEEP_PAGE,
  HostRunRetainedStream,
  RetainedOutputSettlement,
  errorText,
} from "./host-run-endpoint-types";
import {
  openVerifiedOwnedFile,
  readCheckedHostRunFile,
  removeVerifiedOwnedFile,
  strictTraversalCheck,
  writeVerifiedOwnedFile,
} from "./host-run-files";
import {
  HOST_RUN_OUTPUT_FAILURE_DUE_PAGE,
  HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES,
  hostRunOutputFailureSummary as buildHostRunOutputFailureSummary,
  retentionRetryDelayMs,
  type HostRunOutputFailure,
  type HostRunOutputFailureSummary,
} from "./host-run-output-failures";
import {
  classifyProjectValidationOutputOwnership,
  classifyRetainedOutputOwnership,
  type RetainedOutputOwnership,
} from "./host-run-output-ownership";
import type { HostRunScheduler } from "./host-run-scheduler";
import {
  hostRunOutputRetentionSchema,
  type HostRunOutputRetention,
} from "./host-run-wire";
import {
  HISTORY_RETENTION_MS,
} from "../store/store";

interface HostRunRetentionContext {
  scheduler: HostRunScheduler;
  nowMs: () => number;
  outputRetentionMs: number;
  stateDir: string;
}

export class HostRunRetention {
  constructor(private readonly context: HostRunRetentionContext) {}

  /**
   * Why the retained-output sweep is not clean, empty when no run's expiry is
   * unresolved. A failure leaves that run's retained bytes in place, names the
   * run, and survives later successful rows and pages: only the run's own later
   * success removes its entry (tasks 443, 444). The rendered summary is bounded;
   * the durable failure rows it counts are not.
   */
  retentionError(): string {
    return this.renderRetentionFailures(this.retentionSweepError);
  }

  /**
   * The durable retained-output failure set as an exact total and a bounded
   * named sample (task 444). Read-only evidence for `service.health`; the run
   * identities, reasons and retry history stay in their own durable table.
   *
   * A set that cannot be read returns `unreadable` rather than throwing or
   * reading as an empty set: the count is unknown, so the structured health
   * field must not look like an all-clear while the store is failing.
   */
  retentionFailureSummary(): HostRunOutputFailureSummary {
    const store = this.context.scheduler.store;
    try {
      return buildHostRunOutputFailureSummary(
        store.hostRunOutputFailureTotals(),
        store.hostRunOutputFailures(HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES),
      );
    } catch (error) {
      return {
        count: 0, firstSeen: null, lastSeen: null, examples: [], examplesOmitted: 0,
        unreadable: `the retained-output failure records could not be read (${errorText(error)})`,
      };
    }
  }

  /**
   * Audit A7: one bounded page of the output-retention sweep, continued by a
   * durable rowid cursor so a restart resumes instead of starting over. A row
   * that settles after this page already passed its rowid is reached when the
   * cursor wraps at the end; a 1 h retention does not need a full scan a minute.
   *
   * Task 443: a row whose expiry cannot be established no longer pins the page.
   * Every attempted row is independent, and a refusal is recorded against that
   * run alone — its identity, its epoch, the reason, when it was first and last
   * seen, and its next bounded retry — before the cursor moves. The set is
   * durable, so a restart or a cursor wrap keeps it; a later successful row or
   * page cannot clear another run's entry, and only the run's own later success
   * removes it. Rows the page did not reach are retried from the set on their own
   * cadence, so a failing run is neither starved behind the cursor nor retried
   * once per pass. A pass that cannot store the failure set leaves the cursor
   * where it was: a cursor that moved past an unrecorded failure would lose it.
   */
  sweepRetainedOutput(): void {
    const previous = this.storedRetentionCursor();
    const nowMs = this.context.nowMs();
    const attempted = new Set<string>();
    let persistenceError = "";
    // One pass reads the re-key receipts at most once, and only if a row needs
    // them to place its caller's key (task 445).
    this.retentionRekeyCache = null;

    let page: { rows: HostRunInternalRecord[]; lastRowid: number; complete: boolean } | null = null;
    try { page = this.context.scheduler.store.hostRunSettledSweepPage(previous, HOST_RUN_RETENTION_SWEEP_PAGE); }
    catch (error) { persistenceError = `the retention sweep could not read its page: ${errorText(error)}`; }
    for (const run of page?.rows ?? []) {
      if (attempted.has(run.id)) continue;
      attempted.add(run.id);
      // Every row on the page is attempted even after another row's write was
      // refused: a short-circuit here would skip retiring the rest of the page.
      const attemptError = this.attemptRecordedRetention(run, nowMs);
      if (attemptError !== "") persistenceError ||= attemptError;
    }

    // A recorded failure the page did not reach gets its own bounded attempt. The
    // due rows are an index range read, so this pass never parses the whole set;
    // a run the page already attempted is skipped because that attempt was its
    // retry, and its stored next retry now lies ahead.
    let due: HostRunOutputFailure[] = [];
    try { due = this.context.scheduler.store.hostRunOutputFailuresDue(new Date(nowMs).toISOString(), HOST_RUN_OUTPUT_FAILURE_DUE_PAGE); }
    catch (error) { persistenceError ||= `the due retained-output failures could not be read: ${errorText(error)}`; }
    for (const entry of due) {
      if (attempted.has(entry.runId)) continue;
      let run: HostRunInternalRecord | null = null;
      let lookupError = "";
      try { run = this.context.scheduler.get(entry.runId); } catch (error) { lookupError = errorText(error); }
      // A row that is gone, unreadable, or whose epoch changed is not the run this
      // entry describes: keep it visible and record what was observed, never
      // resolve it.
      const attemptError = lookupError !== "" ? this.staleRetentionFailure(entry, nowMs, `the host run could not be read (${lookupError})`)
        : !run || run.epoch !== entry.epoch ? this.staleRetentionFailure(entry, nowMs,
          !run ? "the host run is gone (identity changed or purged)" : `the host run is now epoch ${run.epoch}`)
          : this.attemptRetention(run, entry, nowMs);
      if (attemptError !== "") persistenceError ||= attemptError;
    }

    // The cursor moves only once every failure this pass attempted is durable:
    // a refused write leaves the page where it was, so no run is skipped
    // unrecorded and recoverable progress is never lost.
    let cursor = previous;
    if (persistenceError === "" && page) {
      cursor = page.complete ? 0 : page.lastRowid;
      if (cursor !== previous) {
        try { this.context.scheduler.store.setMeta(HOST_RUN_RETENTION_CURSOR_META, cursor); }
        catch (error) { cursor = previous; persistenceError ||= `the retention cursor could not be stored: ${errorText(error)}`; }
      }
    }
    this.retentionSweepCursor = cursor;
    this.retentionSweepError = persistenceError;
    this.storeRetentionSummary();
  }

  /** The durable sweep cursor, falling back to this process's last value. */
  storedRetentionCursor(): number {
    try {
      const stored = this.context.scheduler.store.getMeta<unknown>(HOST_RUN_RETENTION_CURSOR_META);
      if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) return stored;
    } catch { /* an unreadable cursor restarts the cycle rather than skipping rows */ }
    return this.retentionSweepCursor;
  }

  /**
   * One page row's attempt: read its own durable failure first, then apply it. A
   * row whose failure record cannot be read is not attempted and reports why, so
   * this pass never moves the cursor past it.
   */
  attemptRecordedRetention(run: HostRunInternalRecord, nowMs: number): string {
    let recorded: HostRunOutputFailure | null;
    try { recorded = this.context.scheduler.store.hostRunOutputFailure(run.id); }
    catch (error) { return `the retained-output failure record for ${run.id} is unreadable: ${errorText(error)}`; }
    return this.attemptRetention(run, recorded, nowMs);
  }

  /**
   * One run's expiry attempt. A success clears only this run's own entry; a
   * refusal records it here, and only here. A recorded row is only re-attempted
   * once its own next retry is due, so a wrap, a page or a fixed clock cannot
   * hammer it. A run whose output is positively owned by another Queue producer
   * is reclassified instead (task 444 amendment): its durable failure is cleared
   * with evidence, and it is never recorded as a generic host-run failure again.
   * Returns the pass error text, empty when the attempt left nothing unresolved.
   */
  attemptRetention(run: HostRunInternalRecord, recorded: HostRunOutputFailure | null, nowMs: number): string {
    // Lean store 2 (task 987): a run settled past the history retention has no output left to
    // establish, so its failure settles here instead of retrying every 10 minutes.
    if (run.state === "settled" && run.settledAt && nowMs - Date.parse(run.settledAt) > HISTORY_RETENTION_MS) {
      if (!recorded) return "";
      try { this.context.scheduler.store.deleteHostRunOutputFailure(run.id); }
      catch (error) { return `the settled retained-output failure for ${run.id} could not be cleared: ${errorText(error)}`; }
      return "";
    }
    if (!this.outputExpired(run)) return ""; // Nothing to maintain yet; the entry (if any) stays visible.
    // The recorded cadence owns the next attempt, whichever epoch it names.
    if (recorded && Date.parse(recorded.nextRetryAt) > nowMs) return "";
    // A recorded failure that names another epoch is not this row's failure: the
    // remembered identity cannot be verified against the row that replaced it, so
    // keep it visible as recorded and never re-bind it to the new epoch.
    if (recorded && recorded.epoch !== run.epoch)
      return this.staleRetentionFailure(recorded, nowMs, `the host run is now epoch ${run.epoch}`);
    let settlement: RetainedOutputSettlement;
    try { settlement = this.settleRetainedOutput(run); }
    catch (error) { settlement = { outcome: "unavailable", reason: `Retained output unavailable: ${errorText(error)}` }; }
    if (settlement.outcome === "expired" || settlement.outcome === "nothing_retained") {
      if (!recorded) return "";
      try { this.context.scheduler.store.deleteHostRunOutputFailure(run.id); }
      catch (error) { return `the resolved retained-output failure for ${run.id} could not be cleared: ${errorText(error)}`; }
      return "";
    }
    const ownership = this.retainedOutputOwnership(run, settlement);
    if (ownership.owner === "project_qa") {
      const observedAt = new Date(nowMs).toISOString();
      // A run that never became a failure needs no correction and no evidence:
      // this pass simply established who owns its output.
      if (!recorded) return "";
      try {
        this.context.scheduler.store.recordHostRunOutputReclassification({
          runId: run.id, epoch: run.epoch, owner: "project_qa", qaRunId: ownership.qaRunId,
          key: ownership.key, repository: ownership.repository, caller: ownership.caller,
          detail: ownership.detail, at: observedAt,
        });
      } catch (error) { return `the retained-output reclassification for ${run.id} could not be stored: ${errorText(error)}`; }
      try { this.context.scheduler.store.deleteHostRunOutputFailure(run.id); }
      catch (error) { return `the reclassified retained-output failure for ${run.id} could not be cleared: ${errorText(error)}`; }
      return "";
    }
    if (ownership.owner === "project_validation") {
      const observedAt = new Date(nowMs).toISOString();
      if (!recorded) return "";
      try {
        this.context.scheduler.store.recordHostRunOutputReclassification({
          runId: run.id, epoch: run.epoch, owner: "project_validation", taskId: ownership.taskId, head: ownership.head,
          repository: ownership.repository, caller: ownership.caller, detail: ownership.detail, at: observedAt,
        });
      } catch (error) { return `the retained-output reclassification for ${run.id} could not be stored: ${errorText(error)}`; }
      try { this.context.scheduler.store.deleteHostRunOutputFailure(run.id); }
      catch (error) { return `the reclassified retained-output failure for ${run.id} could not be cleared: ${errorText(error)}`; }
      return "";
    }
    const prior = recorded !== null && recorded.epoch === run.epoch ? recorded : null;
    const attempts = (prior ? prior.attempts : 0) + 1;
    const observedAt = new Date(nowMs).toISOString();
    const ownershipNote = ownership.owner === "unknown" && ownership.reason !== "" ? `; output ownership is unknown: ${ownership.reason}` : "";
    try {
      this.context.scheduler.store.putHostRunOutputFailure({
        runId: run.id, epoch: run.epoch,
        firstSeen: prior ? prior.firstSeen : observedAt,
        lastSeen: observedAt, attempts,
        nextRetryAt: new Date(nowMs + retentionRetryDelayMs(attempts)).toISOString(),
        reason: `${settlement.reason}${ownershipNote}`.slice(0, 400),
        ...(settlement.streams ? { streams: settlement.streams } : {}),
      });
    } catch (error) { return `the retained-output failure for ${run.id} could not be stored: ${errorText(error)}`; }
    return "";
  }

  /**
   * Who owns an unavailable run's output. Classification is only attempted for
   * the shape it can explain — a launched run whose generic streams were both
   * observed absent — and it reads the durable Project QA record itself, so a
   * store fault becomes `unknown` rather than a guessed owner.
   */
  retainedOutputOwnership(run: HostRunInternalRecord, settlement: RetainedOutputSettlement): RetainedOutputOwnership {
    const streams = settlement.outcome === "unavailable" ? settlement.streams : undefined;
    if (!streams || streams.stdout.state !== "absent" || streams.stderr.state !== "absent") return { owner: "unknown", reason: "" };
    // Merge-time project validation is the other Queue producer with its own
    // supervisor; a caller of its shape never has a Project QA record.
    const validation = classifyProjectValidationOutputOwnership({
      run: { id: run.id, epoch: run.epoch, caller: run.caller, repository: run.repository, submissionSource: run.submissionSource },
      streams,
      queueSubmitted: () => this.context.scheduler.store.hostRunSubmittedByQueue(run.id),
      recorded: (taskId, head) => this.context.scheduler.store.projectValidationRecordsRun(taskId, run.id, run.epoch, head),
    });
    if (validation) return validation;
    let qaRun: ProjectQaRun | null = null;
    try { qaRun = this.context.scheduler.store.qaRun(run.id); }
    catch (error) { return { owner: "unknown", reason: `the Project QA record could not be read (${errorText(error)})` }; }
    return classifyRetainedOutputOwnership({
      run: { id: run.id, epoch: run.epoch, caller: run.caller, repository: run.repository }, qaRun, streams,
      rekeys: () => this.retentionRekeys(),
    });
  }

  /**
   * Task 445: the applied repository re-key receipts, read at most once per sweep
   * pass and only when some row's current key cannot name its own caller. The
   * table holds one row per applied step, so this is a bounded read of operation
   * evidence, never a host-history scan; a read that fails is reported as the
   * reason ownership is unknown rather than as an absence of evidence.
   */
  retentionRekeys(): readonly RepositoryRekeyReceipt[] {
    // One read per pass, including a refusal: a broken read is the same reason for
    // every row it was needed for, and re-reading it per row would turn a store
    // fault into a scan.
    if (this.retentionRekeyCache) {
      if ("receipts" in this.retentionRekeyCache) return this.retentionRekeyCache.receipts;
      throw new Error(this.retentionRekeyCache.error);
    }
    try {
      const receipts = this.context.scheduler.store.repositoryRekeys();
      this.retentionRekeyCache = { receipts };
      return receipts;
    } catch (error) {
      this.retentionRekeyCache = { error: errorText(error) };
      throw error;
    }
  }

  /** Keep a recorded failure that no longer names a current row, and say what was observed. */
  staleRetentionFailure(entry: HostRunOutputFailure, nowMs: number, reason: string): string {
    const observedAt = new Date(nowMs).toISOString();
    const attempts = entry.attempts + 1;
    try {
      this.context.scheduler.store.putHostRunOutputFailure({
        ...entry, lastSeen: observedAt, attempts,
        nextRetryAt: new Date(nowMs + retentionRetryDelayMs(attempts)).toISOString(),
        reason: `Retained output cannot be verified: ${reason}`.slice(0, 400),
      });
    } catch (error) { return `the retained-output failure for ${entry.runId} could not be stored: ${errorText(error)}`; }
    return "";
  }

  /**
   * The bounded health summary: the exact durable total, then the named runs the
   * summary limit can show. When the set is larger than the limit the text says
   * how many more are recorded — a summary bound, never a storage bound — so a
   * truncated answer cannot read as an all-clear or as dropped identities.
   */
  renderRetentionFailures(persistenceError = ""): string {
    const parts: string[] = [];
    if (persistenceError !== "") parts.push(persistenceError);
    const summary = this.retentionFailureSummary();
    if (summary.unreadable !== undefined) parts.push(summary.unreadable);
    if (summary.count > 0) {
      const more = summary.examplesOmitted > 0
        ? ` (${summary.examplesOmitted} more recorded durably, not named in this ${summary.examples.length}-run summary)`
        : "";
      parts.push(`${summary.count} retained-output failure${summary.count === 1 ? "" : "s"}${more}: ${summary.examples
        .map(entry => `${entry.runId}: ${entry.reason}`).join("; ")}`);
    }
    return parts.join("; ").slice(0, 500);
  }

  /** Mirror the rendered summary in the existing durable error key, only when it changed. */
  storeRetentionSummary(): void {
    const rendered = this.renderRetentionFailures(this.retentionSweepError);
    if (this.retentionSummaryStored === rendered) return;
    try {
      this.context.scheduler.store.setMeta(HOST_RUN_RETENTION_ERROR_META, rendered);
      this.retentionSummaryStored = rendered;
    } catch { /* the failure rows themselves are already durable; retried next pass */ }
  }

  /**
   * The first retained byte of a stream; everything once the retention hour has
   * passed. An unknown or genuinely absent stream is not a zero-length one, so
   * the caller receives the refusal instead of a fabricated offset.
   */
  retainedFrom(run: HostRunInternalRecord, stream: "stdout" | "stderr"): number {
    if (!this.outputExpired(run)) return 0;
    const settlement = this.settleRetainedOutput(run);
    if (settlement.outcome !== "expired") throw new Error(settlement.reason);
    return settlement.marker.sizes[stream];
  }

  /** True once a settled run is past contract 010's one-hour output retention. */
  outputExpired(run: HostRunInternalRecord): boolean {
    if (!run.settledAt) return false;
    const settledMs = Date.parse(run.settledAt);
    return Number.isFinite(settledMs) && this.context.nowMs() - settledMs > this.context.outputRetentionMs;
  }

  /**
   * Establish what can honestly be said about a run's expired output.
   *
   * - `expired`: both streams were readable, so contract 010's marker holds their
   *   true byte counts and the bytes are removed (or were already, when an
   *   earlier pass wrote the marker).
   * - `nothing_retained`: no output was ever observed, so nothing is missing —
   *   the run recorded no launch (the supervisor is the only writer of these
   *   files), or it settled lost with no result and no process Queue ever saw
   *   start (the loss is already the run's recorded outcome). No marker or byte
   *   count is invented.
   * - `unavailable`: the bytes may have existed but cannot be established now.
   *   Nothing is written and nothing is removed; the caller records the reason
   *   and the per-stream observation. Present-day absence is reported as absence,
   *   never as "never written" and never as an empty stream.
   */
  settleRetainedOutput(run: HostRunInternalRecord): RetainedOutputSettlement {
    const stored = this.readRetentionMarker(run.id);
    if (stored.state === "marker") return { outcome: "expired", marker: stored.marker };
    if (stored.state === "unreadable")
      return { outcome: "unavailable", reason: `Retained output unavailable: ${stored.reason}; the expired byte counts are unknown` };
    const stdout = this.probeRetainedStream(run.id, "stdout");
    const stderr = this.probeRetainedStream(run.id, "stderr");
    const streams = { stdout, stderr };
    const refused = ([stdout, stderr] as const).find(probe => probe.state === "unreadable");
    if (refused) return { outcome: "unavailable", reason: `Retained output unavailable: ${refused.reason}`, streams };
    if (stdout.state === "present" && stderr.state === "present") {
      const marker: HostRunOutputRetention = {
        format: "host.run.output.retention", version: 1, runId: run.id,
        expiredAt: new Date(this.context.nowMs()).toISOString(), sizes: { stdout: stdout.size!, stderr: stderr.size! },
      };
      // The marker is written before the bytes go, so a crash here still leaves
      // `availableFrom` correct for a later attach.
      writeVerifiedOwnedFile(this.context.stateDir, ["runs", run.id, "output.retention.json"], JSON.stringify(marker), 0o600);
      const root = realpathSync(this.context.stateDir);
      for (const stream of ["stdout", "stderr"] as const) {
        try { removeVerifiedOwnedFile(root, ["runs", run.id, stream]); }
        catch { /* already gone, or the chain check refused; the marker still reports it */ }
      }
      return { outcome: "expired", marker };
    }
    if (stdout.state === "absent" && stderr.state === "absent") {
      if (run.launchedAt == null)
        return { outcome: "nothing_retained", reason: `the run never launched, so no output stream was written (${stdout.reason}, ${stderr.reason})` };
      // Tom, 2026-10-27: a lost run is not a retention failure. Its settlement
      // already records the loss; with no result and no process Queue ever saw
      // start, there is no observed output to expire and nothing to recover.
      if (run.settlement?.outcome === "lost" && run.settlement.result == null
          && run.pid == null && run.processGroupId == null && run.startIdentity == null)
        return { outcome: "nothing_retained", reason: `the run settled lost with no result and no recorded process, so no output was observed to expire (${stdout.reason}, ${stderr.reason})` };
      return { outcome: "unavailable", streams,
        reason: `Retained output is absent for a launched run (${stdout.reason}, ${stderr.reason}); the expired byte counts are unknown` };
    }
    const present = `${stdout.state === "present" ? `stdout is ${stdout.size} bytes` : stdout.state === "absent" ? `stdout is absent (${stdout.reason})` : stdout.reason}`;
    const other = `${stderr.state === "present" ? `stderr is ${stderr.size} bytes` : stderr.state === "absent" ? `stderr is absent (${stderr.reason})` : stderr.reason}`;
    return { outcome: "unavailable", streams,
      reason: `Retained output is partial (${present}, ${other}); expiring one stream would lose the other's offset` };
  }

  /**
   * The expired-output marker, with an honest absent/unreadable split: a marker
   * that exists but cannot be read or that names another run is evidence, never
   * a licence to re-derive the gone bytes' offsets from whatever is left.
   */
  readRetentionMarker(runId: string): { state: "absent" } | { state: "marker"; marker: HostRunOutputRetention } | { state: "unreadable"; reason: string } {
    const parts = ["runs", runId, "output.retention.json"];
    const directory = this.probeRetainedRunDirectory(runId);
    if (directory.state === "unreadable") return { state: "unreadable", reason: `the run directory ${directory.reason}` };
    if (directory.state === "absent") return { state: "absent" };
    try { lstatSync(join(realpathSync(this.context.stateDir), ...parts)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
      return { state: "unreadable", reason: `the retention marker is unreadable (${errorText(error)})` };
    }
    const raw = readCheckedHostRunFile(this.context.stateDir, parts);
    if (!raw) return { state: "unreadable", reason: "the retention marker fails the owned-subtree checks" };
    try {
      const marker = hostRunOutputRetentionSchema.parse(JSON.parse(raw.toString("utf8")));
      if (marker.runId !== runId) return { state: "unreadable", reason: `the retention marker names run ${marker.runId}` };
      return { state: "marker", marker };
    } catch { return { state: "unreadable", reason: "the retention marker is corrupt" }; }
  }

  /** Contract 010's owned, symlink-refusing chain to one run's directory. */
  probeRetainedRunDirectory(runId: string): { state: "present" } | { state: "absent" } | { state: "unreadable"; reason: string } {
    try {
      const root = realpathSync(this.context.stateDir);
      strictTraversalCheck(lstatSync(root), "root", root);
      let current = root;
      for (const part of ["runs", runId]) {
        current = join(current, part);
        strictTraversalCheck(lstatSync(current), "directory", current);
      }
      return { state: "present" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent" };
      return { state: "unreadable", reason: `failed the owned-subtree check (${errorText(error)})` };
    }
  }

  /**
   * One retained stream, distinguishing what a null size used to collapse: an
   * absent path, a readable file's true size (zero included), and a refused read.
   */
  probeRetainedStream(runId: string, stream: "stdout" | "stderr"): HostRunRetainedStream {
    const directory = this.probeRetainedRunDirectory(runId);
    if (directory.state === "unreadable") return { state: "unreadable", reason: `the run directory ${directory.reason}` };
    if (directory.state === "absent") return { state: "absent", reason: "the run directory is gone" };
    const path = join(realpathSync(this.context.stateDir), "runs", runId, stream);
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) return { state: "unreadable", reason: `${stream} is a symlink` };
      if (!info.isFile()) return { state: "unreadable", reason: `${stream} is not a regular file` };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { state: "absent", reason: `no ${stream} file` };
      return { state: "unreadable", reason: `${stream} is unreadable (${errorText(error)})` };
    }
    let fd: number | null = null;
    try {
      fd = openVerifiedOwnedFile(this.context.stateDir, ["runs", runId, stream], constants.O_RDONLY, 0o600);
      return { state: "present", size: fstatSync(fd).size };
    } catch (error) { return { state: "unreadable", reason: `${stream} is unreadable (${errorText(error)})` }; }
    finally { if (fd !== null) closeSync(fd); }
  }

  readOutputRetention(runId: string): HostRunOutputRetention | null {
    const raw = readCheckedHostRunFile(this.context.stateDir, ["runs", runId, "output.retention.json"]);
    if (!raw) return null;
    try {
      const marker = hostRunOutputRetentionSchema.parse(JSON.parse(raw.toString("utf8")));
      return marker.runId === runId ? marker : null;
    } catch { return null; }
  }

  /** Retention sweep progress and its last failure; the sweep is restart-safe through the stored cursor. */
  retentionSweepCursor = 0;

  /** Why the last pass could not read or store what it needed; the failures themselves are on disk. */
  retentionSweepError = "";

  /** The summary last written to the durable error key, so an unchanged pass writes nothing. */
  retentionSummaryStored: string | null = null;

  /** Applied re-key receipts, read once per pass for the caller-provenance check (task 445). */
  retentionRekeyCache: { receipts: RepositoryRekeyReceipt[] } | { error: string } | null = null;
}
