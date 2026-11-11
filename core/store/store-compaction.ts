/**
 * Store compaction (Spec 028 revision "lighter backups and a compacting store";
 * audit B9, Tom's 2026-10-25 "Shrink the DB file" ruling a1a817c3; corrected by
 * Spec 028 revision "every writer stays out, and the outcome says what happened").
 *
 * A store this build creates starts in incremental auto-vacuum
 * (`server/store.ts`), so freed pages are released by the bounded reclamation
 * after the hourly and daily prune passes. A store that predates the change is
 * `auto_vacuum=0`: SQLite can only change the mode with one full `VACUUM`, which
 * rewrites the whole file. This module owns that one conversion, once, as
 * service code:
 *
 *  1. **Intent is durable before anything is touched**, and so is the evidence a
 *     later start needs to tell the truth about an attempt whose process died.
 *  2. **Nothing is touched until the recovery route and the space are proved.** A
 *     verified, recoverable snapshot (the operator's own `backup.now` route) must
 *     exist, the store must pass `integrity_check`, there must be room for the
 *     rewrite, and the estimated blocked interval must fit the stated bound.
 *  3. **Every other writer is out for the whole window, and that is proved.** The
 *     window leaves WAL for a rollback journal (a live reader or writer makes that
 *     fail, so the gate is before anything is touched), then holds SQLite's
 *     exclusive file lock on the store for the rest of the window, through the
 *     `VACUUM` and through verification. A momentary lock probe is not the
 *     guarantee: while the window holds the lock, a competing connection — in this
 *     process or another — is refused outright, and a probe connection must be
 *     refused before and after the rewrite or the attempt is abandoned.
 *  4. **Preservation is verified from the rows, not from their width.** The
 *     pre-window canonical content digest of every authoritative logical row and
 *     setting (`Store.contentFingerprint`) is recorded durably; the post-rewrite
 *     digest must equal it, so a same-length edit inside a value is a failure
 *     rather than a pass.
 *  5. **The outcome distinguishes the three cases it can be in.** A conversion is
 *     `converted` only when the rewrite landed *and* the content verified. A
 *     rewrite that landed without verification is `landed` — never `converted`,
 *     never described as leaving the store unchanged — and settling it on a later
 *     start from the store's mode alone records the same `landed`, keeping the dead
 *     attempt's evidence. A rewrite that did not land is `failed`/`refused` and is
 *     the only case that may say the store was not rewritten.
 *
 * The conversion is attempted only by the service, at start, before it begins
 * serving: that is the one window in which no Queue writer can be in flight. The
 * operator's pause key is never read as a gate and never written: pausing Queue
 * stays the operator's action, and a maintenance window neither sets nor clears
 * it.
 */
import { z } from "zod";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AUTO_VACUUM_INCREMENTAL, CURRENT_SCHEMA, STORE_COMPACTION_META_KEY, type ContentFingerprint, type Store,
} from "./store";

/**
 * The largest blocked interval the conversion may hold the service for (two minutes).
 * It sits inside the service layer's own durable maintenance admission for a
 * replacement (`MAINTENANCE_READINESS_CAP_MS` in `server/service/standby.ts`), so
 * the conversion is never a window the surrounding roll cannot wait out.
 */
export const COMPACTION_MAX_BLOCKED_MS = 120_000;
/**
 * A conservative floor for the rewrite, in bytes per millisecond, used to bound the
 * blocked interval *before* the file is touched. The bench recorded in
 * `evidence/store-compaction-20261025.json` measured about 60 MiB/s on isolated stores;
 * this floor is 24 MiB/s, so the estimate errs long and the live 1.05 GB store still
 * fits the bound.
 */
const COMPACTION_BYTES_PER_MS = 24 * 1024 * 1024 / 1000;
/** Reading the store twice for `integrity_check` and checkpointing are slower per byte. */
const COMPACTION_CHECK_BYTES_PER_MS = 64 * 1024 * 1024 / 1000;
/**
 * A floor for the canonical content verification, in bytes per millisecond. The bench
 * measured 150-200 MB/s of stored content per pass (`contentFingerprint` reads the rows,
 * not the file's free pages), so this floor is a three-times margin below the slowest
 * measured pass; the estimate counts one pass before the rewrite and one after it.
 */
export const COMPACTION_VERIFY_BYTES_PER_MS = 64 * 1024 * 1024 / 1000;
/** Fixed start-up work inside the window: the probes, the fingerprint and the record. */
const COMPACTION_FIXED_MS = 5_000;
/** The rewrite needs room for the old file and the new one, plus headroom for the WAL and the snapshot. */
const COMPACTION_HEADROOM_BYTES = 256 * 1024 * 1024;
/** One shot means bounded attempts: a refusing precondition may retry after a cooldown. */
export const COMPACTION_MAX_ATTEMPTS = 3;
const COMPACTION_RETRY_AFTER_MS = 60 * 60 * 1000;

const storeFactsSchema = z.object({
  fileBytes: z.number().int().min(0), walBytes: z.number().int().min(0), pageSize: z.number().int().min(0),
  pageCount: z.number().int().min(0), freePages: z.number().int().min(0), autoVacuum: z.number().int().min(0),
}).strict();

/**
 * What preservation verification did for this attempt. `verified` means the canonical
 * content digest taken after the rewrite equals the one recorded before it (so the rewrite
 * landed *and* the logical rows verified). `changed` means the rewrite landed but the rows
 * or settings are not what they were. `not-run` means the attempt never got to verify, so
 * nothing may be claimed about preservation.
 */
const compactionVerificationSchema = z.object({
  content: z.enum(["verified", "changed", "not-run"]),
  /** Rows and stored content bytes the post-rewrite digest covered, when it ran. */
  rows: z.number().int().min(0).nullable(), bytes: z.number().int().min(0).nullable(),
  tookMs: z.number().int().min(0).nullable(),
  reason: z.string().max(400).nullable(),
}).strict();
type CompactionVerification = z.infer<typeof compactionVerificationSchema>;

/**
 * The window's own exclusion evidence: what the rollback-journal gate returned, whether
 * SQLite's exclusive file lock was taken and retained, and whether a competing connection
 * was refused before and after the rewrite. This is the instrumented proof that no writer
 * could reach the store, recorded next to the attempt instead of inferred afterwards.
 */
const compactionExclusionSchema = z.object({
  journalMode: z.string().max(20).nullable(),
  exclusive: z.boolean(),
  probeBefore: z.boolean().nullable(), probeAfter: z.boolean().nullable(),
  reason: z.string().max(400).nullable(),
}).strict();
type CompactionExclusion = z.infer<typeof compactionExclusionSchema>;

/** The compact facts of an earlier attempt, kept when a later start settles it. */
const compactionPriorSchema = z.object({
  state: z.enum(["running", "converted", "landed", "refused", "failed"]),
  at: z.string(), attempts: z.number().int().min(1),
  reason: z.string().max(400).nullable(), snapshot: z.string().max(200).nullable(),
  fingerprint: z.string().max(64).nullable(), blockedMs: z.number().int().min(0).nullable(),
  verification: compactionVerificationSchema.nullable(),
}).strict();
type CompactionPrior = z.infer<typeof compactionPriorSchema>;

/**
 * The durable one-shot record.
 *
 * - `running`: the intent was written and the outcome is unknown until the store is read.
 * - `converted`: the rewrite landed **and** the canonical content verified.
 * - `landed`: the rewrite is present in the store (`auto_vacuum=2`) but preservation was
 *   not positively verified — the attempt died before verification, a later start settled
 *   it from the store's mode alone, or verification found a difference. Final: an already
 *   incremental store is never rewritten again, and a mode alone never mints a verified
 *   success.
 * - `refused`: a precondition failed before the file was touched.
 * - `failed`: an attempt failed and the rewrite did not land; the store still reads
 *   `auto_vacuum=0`, so it holds the rows it held before.
 *
 * A damaged record is read as absent, so it never blocks a start.
 */
export const storeCompactionRecordSchema = z.object({
  version: z.literal(1),
  state: z.enum(["running", "converted", "landed", "refused", "failed"]),
  /** What asked for the attempt; only `service-start` in production. */
  trigger: z.string().min(1).max(40),
  attempts: z.number().int().min(1),
  /** When this state was written, and the window's own bounds when one ran. */
  at: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  before: storeFactsSchema.nullable(), after: storeFactsSchema.nullable(),
  requiredFreeBytes: z.number().int().min(0).nullable(), freeBytes: z.number().int().min(0).nullable(),
  estimatedBlockedMs: z.number().int().min(0).nullable(), blockedMs: z.number().int().min(0).nullable(),
  /** The verified snapshot's file name (never a path) and the pre-rewrite content digest. */
  snapshot: z.string().max(200).nullable(), fingerprint: z.string().max(64).nullable(),
  verification: compactionVerificationSchema.nullable().default(null),
  exclusion: compactionExclusionSchema.nullable().default(null),
  /** The state a later start settled this record from, and the evidence it inherited. */
  settledFrom: z.enum(["running", "landed", "refused", "failed"]).nullable().default(null),
  prior: compactionPriorSchema.nullable().default(null),
  reason: z.string().max(400).nullable(),
}).strict();
type StoreCompactionRecord = z.infer<typeof storeCompactionRecordSchema>;

export interface StoreCompactionDeps {
  /** Take one verified, recoverable snapshot and name it; a throw refuses the conversion. */
  snapshot(): Promise<{ name: string; bytes: number }>;
  /** Bytes available on the filesystem that holds the store. */
  freeBytes(): number;
  clock?: () => string;
  /** One line for the service log; never used to record state. */
  log?(message: string): void;
  /** Fixture seam: fail the window at a fixed point, after the intent and before an outcome. */
  failConversion?: "before-vacuum" | "after-vacuum" | "changed-store" | "same-length-change" | "fts-optimize";
  /**
   * Fixture seam: runs inside the window after the exclusive lock is taken and before the
   * rewrite, so a test can try a competing write and prove the window refused it.
   */
  duringWindow?(attempt: () => boolean): void;
  /** Fixture seam: override the blocked-interval bound a store too large for the window is refused on. */
  maxBlockedMs?: number;
  /** Fixture seam: run only the pre-rewrite steps and return the content digest they would record. */
  observeFingerprint?(): ContentFingerprint;
}

/** Free bytes on the filesystem holding `path`, from the operating system. */
export function freeBytesOn(path: string): number {
  const facts = statfsSync(dirname(path), { bigint: true });
  return Number(facts.bavail * facts.bsize);
}

/** Free space the rewrite needs: the file it copies, the copy, the WAL, and headroom. */
export function requiredFreeBytes(facts: { fileBytes: number; walBytes: number }, snapshotBytes: number): number {
  return facts.fileBytes * 2 + facts.walBytes + snapshotBytes + COMPACTION_HEADROOM_BYTES;
}

/**
 * The blocked interval this store would cost, from the bench's measured-rate floors: the
 * rewrite, two `integrity_check` reads, and the canonical content verification's pass
 * before and after the rewrite.
 */
export function estimatedBlockedMs(facts: { fileBytes: number }): number {
  return Math.ceil(
    facts.fileBytes / COMPACTION_BYTES_PER_MS
    + (2 * facts.fileBytes) / COMPACTION_CHECK_BYTES_PER_MS
    + (2 * facts.fileBytes) / COMPACTION_VERIFY_BYTES_PER_MS) + COMPACTION_FIXED_MS;
}

/** The last record, or null when none was written or the stored one is damaged. */
export function readCompactionRecord(store: Store): StoreCompactionRecord | null {
  let value: unknown;
  try { value = store.getMeta<unknown>(STORE_COMPACTION_META_KEY); } catch { return null; }
  const parsed = storeCompactionRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * True when an attempt should run now. A record that is not final is always settled from
 * the store, including when the store already reads `auto_vacuum=2`: a `running` record (an
 * attempt whose process died) or a `failed` one whose rewrite nevertheless landed is
 * recorded truthfully by `run()` without a second rewrite (Spec 028 acceptance 11/13).
 * `converted` and `landed` are final: an incremental store is never rewritten to clean up
 * its health, and only a `refused`/`failed` record on a store that still reads `0` may
 * retry, after the cooldown and inside the bounded attempt count.
 */
export function compactionDue(store: Store, at = Date.now()): boolean {
  const facts = store.storeFacts();
  const incremental = facts.autoVacuum === AUTO_VACUUM_INCREMENTAL;
  const record = readCompactionRecord(store);
  if (!record) return !incremental;
  if (record.state === "converted" || record.state === "landed") return false;
  // Unknown delivery is settled on every start; nothing else may stop that.
  if (record.state === "running") return true;
  // The rewrite is present but the record is not final: settle it, never rewrite it.
  if (incremental) return true;
  if (record.attempts >= COMPACTION_MAX_ATTEMPTS) return false;
  const previous = Date.parse(record.at);
  return !Number.isFinite(previous) || at - previous >= COMPACTION_RETRY_AFTER_MS;
}

interface CompactionRun {
  record: StoreCompactionRecord;
  /** True only when this call ran the pragma and the `VACUUM` and verified the result. */
  converted: boolean;
}

/** The service-owned, one-shot conversion of an auto_vacuum=0 store to incremental. */
export class StoreCompactor {
  private readonly clock: () => string;
  constructor(private readonly store: Store, private readonly deps: StoreCompactionDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  /** The durable record as it stands, or null. */
  record(): StoreCompactionRecord | null { return readCompactionRecord(this.store); }

  /** Whether an attempt is due now; reads one pragma and at most one meta row. */
  due(at = Date.now()): boolean { return compactionDue(this.store, at); }

  /** Run one attempt when one is due; otherwise return the record unchanged (or null). */
  async runIfDue(trigger = "service-start"): Promise<CompactionRun | null> {
    if (!this.due()) {
      const record = this.record();
      return record ? { record, converted: false } : null;
    }
    return this.run(trigger);
  }

  /**
   * One attempt. Every path writes a durable record; none throws for an operational
   * failure, because a failed conversion is a state the operator must be able to read,
   * not a start-up fault that hides the store.
   */
  async run(trigger = "service-start"): Promise<CompactionRun> {
    const before = this.store.storeFacts();
    const previous = this.record();
    const attempts = (previous?.attempts ?? 0) + 1;
    // Already incremental: the conversion is present in the store. This attempt rewrites
    // nothing, and the store's mode is not evidence that its rows survived: a landed rewrite
    // whose verification never ran stays `landed` with the dead attempt's evidence beside it.
    if (before.autoVacuum === AUTO_VACUUM_INCREMENTAL) return { record: this.settleLanded(trigger, before, previous), converted: false };
    const refuse = (reason: string, extra: Partial<StoreCompactionRecord> = {}) =>
      ({ record: this.write({ state: "refused", trigger, attempts, before, reason, prior: priorOf(previous), ...extra }), converted: false });
    if (attempts > COMPACTION_MAX_ATTEMPTS) return refuse("the bounded attempt count is spent; the store was not rewritten and keeps working as it did");
    // The ruling's order: the rewrite comes after every preceding storage fix and its schema
    // steps are in place, so the store it rewrites is the one this build reads.
    const schema = this.store.getMeta<number>("schema") ?? null;
    if (schema !== CURRENT_SCHEMA)
      return refuse(`the store's schema (${String(schema)}) is not current (${CURRENT_SCHEMA}); migrations run first`);
    // The blocked interval is bounded before the file is touched: a store too large for the
    // stated window is left as it is and said so, never converted on a guess.
    const estimate = estimatedBlockedMs(before);
    const maxBlockedMs = this.deps.maxBlockedMs ?? COMPACTION_MAX_BLOCKED_MS;
    if (estimate > maxBlockedMs)
      return refuse(`the estimated blocked interval (${estimate} ms, including content verification) exceeds the ${maxBlockedMs} ms bound; the store was not rewritten`, { estimatedBlockedMs: estimate });
    const preRequired = requiredFreeBytes(before, 0);
    const preFree = this.deps.freeBytes();
    if (preFree < preRequired)
      return refuse(`insufficient free space before the snapshot: ${preFree} bytes available, ${preRequired} required; the store was not rewritten`, { requiredFreeBytes: preRequired, freeBytes: preFree, estimatedBlockedMs: estimate });
    // A verified, recoverable snapshot is the recovery route for the rewrite; without it
    // nothing is touched, so a failed conversion can always be restored.
    let snapshot: { name: string; bytes: number };
    try { snapshot = await this.deps.snapshot(); }
    catch (error) { return refuse(`no verified snapshot: ${message(error)}; the store was not rewritten`, { requiredFreeBytes: preRequired, freeBytes: preFree, estimatedBlockedMs: estimate, prior: priorOf(previous) }); }
    const required = requiredFreeBytes(before, snapshot.bytes);
    const free = this.deps.freeBytes();
    if (free < required)
      return refuse(`insufficient free space after the snapshot: ${free} bytes available, ${required} required; the store was not rewritten`, { requiredFreeBytes: required, freeBytes: free, estimatedBlockedMs: estimate, snapshot: snapshot.name });
    const startedAt = this.clock();
    // Durable intent. From here a restart reads the store to settle the outcome. The protected
    // before boundary — the content digest of every authoritative row and setting — is taken
    // and recorded *inside* the window below, once no other connection can commit.
    this.write({ state: "running", trigger, attempts, startedAt, before, requiredFreeBytes: required, freeBytes: free,
      estimatedBlockedMs: estimate, snapshot: snapshot.name, fingerprint: null, reason: null,
      after: null, blockedMs: null, finishedAt: null, verification: null, exclusion: null, settledFrom: null, prior: priorOf(previous) });
    const exclusion: CompactionExclusion = { journalMode: null, exclusive: false, probeBefore: null, probeAfter: null, reason: null };
    const intent = { state: "running" as const, trigger, attempts, startedAt, before, requiredFreeBytes: required, freeBytes: free,
      estimatedBlockedMs: estimate, snapshot: snapshot.name };
    const evidence: WindowEvidence = { verification: { content: "not-run", rows: null, bytes: null, tookMs: null, reason: null }, fingerprint: null };
    const windowStarted = performance.now();
    let failure: string | null = null;
    let refused = false;
    try {
      this.store.beginMaintenanceWindow();
      try {
        this.convert(intent, exclusion, evidence);
      } finally {
        this.store.endMaintenanceWindow();
      }
    } catch (error) { failure = message(error); refused = error instanceof StoreWindowRefused; exclusion.reason = bound(failure); }
    const verification = evidence.verification;
    const blockedMs = Math.round(performance.now() - windowStarted);
    const after = this.store.storeFacts();
    const landed = after.autoVacuum === AUTO_VACUUM_INCREMENTAL;
    if (!landed) {
      if (refused) {
        // The window could not be proved before anything was touched: the store holds exactly
        // the rows it held, and the only evidence is what the window saw while it tried.
        const record = this.write({ state: "refused", trigger, attempts, startedAt, before, after,
          requiredFreeBytes: required, freeBytes: free, estimatedBlockedMs: estimate, blockedMs,
          snapshot: snapshot.name, fingerprint: evidence.fingerprint, finishedAt: this.clock(), exclusion,
          verification, prior: priorOf(previous),
          reason: bound(`${failure ?? "the quiet window could not be proved"}; the store was not rewritten (auto_vacuum is still 0) and holds the rows it held before`) });
        this.deps.log?.(`compaction refused: ${record.reason}`);
        return { record, converted: false };
      }
      // Nothing was rewritten: `VACUUM` runs in its own transaction, so a store that still
      // reads 0 holds the rows it held before. Only this case may say so.
      const record = this.write({ state: "failed", trigger, attempts, startedAt, before, after,
        requiredFreeBytes: required, freeBytes: free, estimatedBlockedMs: estimate, blockedMs,
        snapshot: snapshot.name, fingerprint: evidence.fingerprint, finishedAt: this.clock(), exclusion,
        verification: { ...verification, content: "not-run" }, prior: priorOf(previous),
        reason: bound(`${failure ?? "the conversion did not take effect"}; the store was not rewritten (auto_vacuum is still 0) and holds the rows it held before`) });
      this.deps.log?.(`compaction failed: ${record.reason}`);
      return { record, converted: false };
    }
    if (failure === null && verification.content === "verified") {
      const record = this.write({ state: "converted", trigger, attempts, startedAt, before, after,
        requiredFreeBytes: required, freeBytes: free, estimatedBlockedMs: estimate, blockedMs,
        snapshot: snapshot.name, fingerprint: evidence.fingerprint, finishedAt: this.clock(), exclusion, verification,
        settledFrom: null, prior: priorOf(previous), reason: null });
      this.deps.log?.(`store converted to incremental auto-vacuum and verified (${before.fileBytes} -> ${after.fileBytes} bytes, ${blockedMs} ms, ${verification.rows ?? 0} rows)`);
      return { record, converted: true };
    }
    // The rewrite landed. Its rows are not proven unchanged, so the record says exactly that
    // and never appends "unchanged": mode 2 proves the conversion, not the content.
    const detail = failure ?? verification.reason ?? "preservation was not verified";
    const record = this.write({ state: "landed", trigger, attempts, startedAt, before, after,
      requiredFreeBytes: required, freeBytes: free, estimatedBlockedMs: estimate, blockedMs,
      snapshot: snapshot.name, fingerprint: evidence.fingerprint, finishedAt: this.clock(), exclusion,
      verification: verification.content === "verified" ? { ...verification, content: "not-run", reason: detail } : verification,
      settledFrom: null, prior: priorOf(previous),
      reason: bound(`the rewrite landed (auto_vacuum=2) but preservation was not verified: ${detail}; the store is usable and its records are not proven unchanged`) });
    this.deps.log?.(`compaction landed without verification: ${record.reason}`);
    return { record, converted: false };
  }

  /**
   * A later start finds a non-final record whose rewrite is already present. The store's mode
   * proves the conversion landed; it proves nothing about the records, and content that moved
   * since then is ordinary work, so no verification can be recovered after the fact. The
   * earlier attempt's reason, snapshot and digest stay in the record: this start neither
   * erases the failure nor mints a verified success from the mode.
   */
  private settleLanded(trigger: string, before: ReturnType<Store["storeFacts"]>, previous: StoreCompactionRecord | null): StoreCompactionRecord {
    if (previous?.state === "converted") return previous;
    const settledFrom = previous?.state ?? null;
    return this.write({ state: "landed", trigger, attempts: Math.max(1, previous?.attempts ?? 1), before: previous?.before ?? before,
      after: before, snapshot: previous?.snapshot ?? null, fingerprint: previous?.fingerprint ?? null,
      estimatedBlockedMs: previous?.estimatedBlockedMs ?? null, blockedMs: previous?.blockedMs ?? null,
      startedAt: previous?.startedAt ?? null, finishedAt: previous?.finishedAt ?? this.clock(),
      exclusion: previous?.exclusion ?? null,
      verification: previous?.verification ?? { content: "not-run", rows: null, bytes: null, tookMs: null,
        reason: "no preservation verification ran for the settled attempt" },
      settledFrom, prior: priorOf(previous),
      reason: bound(`the rewrite is present in the store (auto_vacuum=2) but preservation was never verified: ${previous?.reason ?? "the attempt ended before verification"}; the store's mode proves the conversion landed, not that its records are unchanged`) });
  }

  /**
   * The quiet window's own steps. Callers hold `Store.beginMaintenanceWindow`, so this
   * process's write funnels are closed and this synchronous turn is the only code that can
   * write. The window then takes and *keeps* SQLite's exclusive lock on the store, so a
   * competing connection — in this process or another — is refused for the whole rewrite and
   * its verification; a probe connection must be refused before and after the rewrite.
   */
  private convert(intent: Record<string, unknown>, exclusion: CompactionExclusion, evidence: WindowEvidence): void {
    const db = this.store.db;
    if (db.isTransaction) throw new Error("refusing to convert a store from inside an open transaction");
    if (this.store.autoVacuumMode() === AUTO_VACUUM_INCREMENTAL) throw new Error("the store is already incremental; no rewrite is needed");
    const checkpoint = this.store.checkpointWal();
    if (checkpoint.busy !== 0) throw new StoreWindowRefused(`a writer or reader is still active (checkpoint busy=${checkpoint.busy})`);
    try {
      // The gate. Leaving WAL for a rollback journal needs exclusive access to the file, so a
      // live reader or writer anywhere fails here, before the pragma and before any lock this
      // window would keep. This is what makes the exclusion below takeable, and its failure is
      // the refusal, not a probe that is retried in a loop.
      const journal = db.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode?: string } | undefined;
      exclusion.journalMode = String(journal?.journal_mode ?? "");
      if (exclusion.journalMode !== "delete")
        throw new StoreWindowRefused(`the store refused exclusive access (journal_mode=${exclusion.journalMode || "unknown"}); another connection may hold it`);
      // Hold the exclusive file lock for the rest of the window. In this locking mode SQLite
      // keeps the lock the first write transaction takes, so it never releases it between the
      // `VACUUM` and the checks below; nothing else can read or write the store until the
      // restore in this method's `finally`.
      db.exec("PRAGMA locking_mode=EXCLUSIVE");
      db.exec("BEGIN IMMEDIATE");
      db.exec("COMMIT");
      exclusion.exclusive = String((db.prepare("PRAGMA locking_mode").get() as { locking_mode?: string } | undefined)?.locking_mode ?? "") === "exclusive";
      if (!exclusion.exclusive) throw new StoreWindowRefused("SQLite did not retain its exclusive lock on the store");
      exclusion.probeBefore = competingWriterRefused(this.store.path);
      if (!exclusion.probeBefore) throw new StoreWindowRefused("a competing connection could still open the store for writing; the window is not exclusive");
      const integrityBefore = integrityCheck(db);
      if (integrityBefore !== "ok") throw new StoreWindowRefused(`the store did not pass integrity_check before conversion: ${integrityBefore}`);
      // Fixture seam: the window is exclusive now, so a competing write attempt must be refused.
      this.deps.duringWindow?.(() => competingWriterRefused(this.store.path));
      // The protected before boundary: every authoritative logical row and setting, by exact
      // stored bytes, read and recorded durably while no other connection can commit. A crash
      // from here leaves a `running` record that names the digest the attempt started from.
      const fingerprint = this.store.contentFingerprint();
      evidence.fingerprint = fingerprint.digest;
      this.recordInWindow({ ...intent, fingerprint: fingerprint.digest });
      try {
        // SQLite converts on the next VACUUM; the pragma on its own changes nothing else.
        db.exec("PRAGMA auto_vacuum=INCREMENTAL");
        if (this.deps.failConversion === "before-vacuum") throw new Error("fixture: conversion failed before VACUUM (disk full or interruption)");
        db.exec("VACUUM");
        if (this.deps.failConversion === "after-vacuum") throw new Error("fixture: conversion interrupted after VACUUM, before verification");
        // Fixture seams for a foreign writer that reached the rows despite the window: the
        // same connection writes on purpose, which is the only way to reach the file while the
        // window holds it. Both change content without changing any stored width.
        if (this.deps.failConversion === "changed-store")
          db.prepare("INSERT INTO meta(key,value) VALUES('compactionFixtureChange',?)").run(JSON.stringify("written while the store was being converted"));
        if (this.deps.failConversion === "same-length-change")
          db.prepare("UPDATE meta SET value=? WHERE key='pool'").run(JSON.stringify([{ profile: "other", enabled: false, count: 4 }]));
        // Fixture seam: FTS's own shadow segments are rebuilt, which changes their representation
        // while the logical rows they index stay the same.
        if (this.deps.failConversion === "fts-optimize")
          db.exec("INSERT INTO outcomes_fts(outcomes_fts) VALUES('optimize')");
        if (this.store.autoVacuumMode() !== AUTO_VACUUM_INCREMENTAL) throw new Error("VACUUM did not leave the store in incremental auto-vacuum");
        const integrityAfter = integrityCheck(db);
        if (integrityAfter !== "ok") throw new Error(`the converted store did not pass integrity_check: ${integrityAfter}`);
      } finally {
        exclusion.probeAfter = competingWriterRefused(this.store.path);
      }
      // Every authoritative logical row and setting, by exact stored bytes: the rewrite may
      // move pages, never a value. The evidence is written down before it can fail, so a
      // failure carries what the check saw.
      const after = this.store.contentFingerprint();
      evidence.verification = { content: "verified", rows: after.rows, bytes: after.bytes, tookMs: after.ms, reason: null };
      if (after.digest !== fingerprint.digest) {
        evidence.verification = { ...evidence.verification, content: "changed",
          reason: `the store's logical content changed across the rewrite (${fingerprint.rows} rows/${fingerprint.bytes} bytes recorded, ${after.rows} rows/${after.bytes} bytes after)` };
        throw new Error(String(evidence.verification.reason));
      }
      if (exclusion.probeAfter !== true) {
        evidence.verification = { ...evidence.verification, content: "not-run",
          reason: "the window's exclusive lock could not be proved after the rewrite" };
      }
      this.store.checkpointWal();
    } finally {
      // Always give the store back: the journal mode this build and every reader expect, and
      // no retained file lock. A failure here leaves the connection usable in rollback mode,
      // which the next open restores to WAL exactly as every open does.
      releaseExclusive(this.store);
    }
  }

  /**
   * Record a fact from inside the window. The window's own writes are the exception the
   * store's closed funnels are closed *for*, so this one statement goes to the connection
   * directly: the digest a rewrite started from has to be durable before the rewrite.
   */
  private recordInWindow(input: Partial<StoreCompactionRecord>): StoreCompactionRecord {
    const record = this.parseRecord(input);
    this.store.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(STORE_COMPACTION_META_KEY, JSON.stringify(record));
    return record;
  }

  private write(input: Partial<StoreCompactionRecord>): StoreCompactionRecord {
    const record = this.parseRecord(input);
    this.store.setMeta(STORE_COMPACTION_META_KEY, record);
    return record;
  }

  private parseRecord(input: Partial<StoreCompactionRecord>): StoreCompactionRecord {
    return storeCompactionRecordSchema.parse({
      version: 1, state: "refused", trigger: "service-start", attempts: 1,
      at: this.clock(), startedAt: null, finishedAt: null, before: null, after: null,
      requiredFreeBytes: null, freeBytes: null, estimatedBlockedMs: null, blockedMs: null,
      snapshot: null, fingerprint: null, verification: null, exclusion: null, settledFrom: null, prior: null,
      reason: null, ...input,
    });
  }
}

/**
 * A window that could not be proved before anything was touched. It is a refusal, not a
 * failure: the store still reads `auto_vacuum=0` and holds exactly the rows it held.
 */
class StoreWindowRefused extends Error {
  constructor(message: string) { super(message); this.name = "StoreWindowRefused"; }
}

/** What the window learned, so a failure still records what the checks saw. */
interface WindowEvidence { verification: CompactionVerification; fingerprint: string | null }

/** The compact facts of the previous record, bounded: the evidence a later start keeps. */
function priorOf(previous: StoreCompactionRecord | null): CompactionPrior | null {
  if (!previous) return null;
  return { state: previous.state, at: previous.at, attempts: previous.attempts, reason: previous.reason,
    snapshot: previous.snapshot, fingerprint: previous.fingerprint, blockedMs: previous.blockedMs,
    verification: previous.verification ?? null };
}

/** A record's reason is bounded by its schema; the tail is dropped rather than the cause. */
const bound = (reason: string) => reason.length <= 400 ? reason : `${reason.slice(0, 397)}...`;

/** `PRAGMA integrity_check`'s single row, as text. */
function integrityCheck(db: Store["db"]): string {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
  return rows.map(row => String(Object.values(row)[0] ?? "")).join("; ") || "no result";
}

/**
 * Ask the store, from a second connection, for a write lock. While this window holds
 * SQLite's exclusive lock the request must be refused, so `true` means the window really is
 * exclusive. The probe takes no lock when it is refused and rolls back if it ever is granted,
 * so it can never be the writer it exists to rule out.
 */
function competingWriterRefused(path: string): boolean {
  if (path === ":memory:") return true;
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(path);
    probe.exec("PRAGMA busy_timeout=0");
    try { probe.exec("BEGIN IMMEDIATE"); }
    catch { return true; }
    try { probe.exec("ROLLBACK"); } catch { /* a granted lock nobody keeps */ }
    return false;
  } catch {
    // A store that cannot be opened at all is equally not writable by a competing connection.
    return true;
  } finally {
    try { probe?.close(); } catch { /* already closed */ }
  }
}

/** Put the journal mode and locking mode back so the service and every reader keep working. */
function releaseExclusive(store: Store): void {
  const db = store.db;
  try { db.exec("PRAGMA locking_mode=NORMAL"); } catch { /* the lock is released with the connection either way */ }
  try {
    const mode = db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: string } | undefined;
    if (String(mode?.journal_mode ?? "") !== "wal") db.exec("PRAGMA journal_mode=WAL");
  } catch { /* the next open sets WAL on this store as it does for every open */ }
  try { store.checkpointWal(); } catch { /* a reader may keep the WAL in place; the next pass truncates it */ }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
