import { realpathSync } from "node:fs";
import { z } from "zod";
import { hostRunAccountingDispositionSchema, hostRunAccountingRetirementSchema, hostRunEscapedDescendantSchema, hostRunInternalRecordSchema, projectQaRunSchema, qaFenceRecordSchema, type HostRunAccountingRetirement, type HostRunInternalRecord, type HostRunRecord, type ProjectQaRun, type QaFence, type QaFenceRecord, type QaFenceView, type QaInventoryItem, type Task } from "../../shared/contracts";
import { HOST_RUN_IDENTITY_META_PREFIX, hostRunIdentityMetaKey, hostRunIdentityOf, hostRunWithIdentity, parseHostRunRow, publicHostRunRecord, } from "../host-runs/host-run-identity";
import { hostRunAccountingDispositionMetaKey } from "../host-runs/host-run-meta-keys";
import { HOST_RUN_OUTPUT_FAILURE_DUE_PAGE, HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES, HOST_RUN_OUTPUT_RECLASSIFICATION_LIMIT, HOST_RUN_OUTPUT_RECLASSIFICATIONS_META, hostRunOutputFailureSchema, hostRunOutputReclassificationLogSchema, hostRunOutputReclassificationSchema, parseHostRunOutputFailureRow, type HostRunOutputFailure, type HostRunOutputReclassification, type HostRunOutputReclassificationLog, } from "../host-runs/host-run-output-failures";
import { redactHostRunData } from "../host-runs/host-run-redact";
import { projectValidationSchedulerEvidence } from "../qa/project-validation-caller";
import { HOST_RUN_SELECTOR, HOST_RUN_VALID_DATA, now, StoreCore } from "./store-core";

export class StoreHostRuns {
  constructor(private readonly core: StoreCore) {}

  /**
   * Commit one host-run row. The row keeps the pinned contract 010 shape; the
   * run's internal admission identity is written beside it in the same
   * transaction, so a failed identity write rolls the row back instead of
   * leaving an unmarked reservation behind.
   */
  putHostRun(run: HostRunRecord | HostRunInternalRecord): HostRunInternalRecord {
    const parsed = hostRunInternalRecordSchema.parse(run);
    const write = () => {
      const stored = publicHostRunRecord(parsed);
      this.core.db.prepare("INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET repository=excluded.repository,state=excluded.state,data=excluded.data")
        .run(stored.id, stored.repository.origin ?? stored.repository.path, stored.state, JSON.stringify(redactHostRunData(stored)));
      const identity = hostRunIdentityOf(parsed);
      if (identity) this.core.setMeta(hostRunIdentityMetaKey(stored.id), identity);
      return parsed;
    };
    return this.core.db.isTransaction ? write() : this.core.transaction(write);
  }

  hostRun(id: string): HostRunInternalRecord | null {
    const row = this.core.db.prepare("SELECT data FROM host_run_records WHERE id=?").get(id);
    return row ? hostRunWithIdentity(parseHostRunRow(row.data), this.hostRunIdentity(id)) : null;
  }

  /** One run's internal identity; absent when missing, unreadable or never written. */
  private hostRunIdentity(id: string): unknown {
    const row = this.core.db.prepare("SELECT value FROM meta WHERE key=?").get(hostRunIdentityMetaKey(id)) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(String(row.value)); } catch { return undefined; }
  }

  /**
   * One run's stored accounting retirement: undefined when absent, and the stored
   * value otherwise (unreadable JSON is deliberately not swallowed here: the
   * accounting reader binds it by run and epoch and treats anything it cannot
   * bind as charged). The sidecar holds either basis — the operator's exact-run
   * disposition or the automatic producer-cleanup retirement.
   */
  hostRunAccountingDispositionRaw(id: string): unknown {
    const row = this.core.db.prepare("SELECT value FROM meta WHERE key=?").get(hostRunAccountingDispositionMetaKey(id)) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(String(row.value)); } catch { return { unreadable: true }; }
  }

  /**
   * The accounting retirement that applies to this row, or undefined. It applies
   * only when it is readable, names this row and carries the row's own epoch;
   * anything stale, unreadable or half-written is absent, so the row stays
   * charged and keeps its workspace rather than a damaged key releasing either.
   */
  hostRunAccountingRetirement(record: HostRunInternalRecord): HostRunAccountingRetirement | undefined {
    const raw = this.hostRunAccountingDispositionRaw(record.id);
    if (raw === undefined) return undefined;
    const parsed = hostRunAccountingRetirementSchema.safeParse(raw);
    if (!parsed.success || parsed.data.runId !== record.id || parsed.data.epoch !== record.epoch) return undefined;
    return parsed.data;
  }

  /** Every run's internal identity, read once for a list; an unreadable one is absent, never partial. */
  private hostRunIdentities(): Map<string, unknown> {
    const identities = new Map<string, unknown>();
    for (const row of this.core.db.prepare("SELECT key,value FROM meta WHERE key GLOB ?").all(`${HOST_RUN_IDENTITY_META_PREFIX}*`) as Array<{ key: string; value: string }>) {
      const runId = String(row.key).slice(HOST_RUN_IDENTITY_META_PREFIX.length);
      try { identities.set(runId, JSON.parse(String(row.value))); } catch { /* an unreadable identity is absent */ }
    }
    return identities;
  }

  hostRuns(limit = 250): HostRunInternalRecord[] {
    return this.hostRunRows(this.core.db.prepare("SELECT data FROM host_run_records ORDER BY rowid DESC LIMIT ?").all(limit));
  }

  /**
   * The oldest host run that still holds a workspace: queued, admitted or
   * running, or settled while its capacity is still reserved (a known escaped
   * descendant is alive or its liveness is unknown, so it may still write).
   * Matching is canonical and path-bounded: the directory or anything under it,
   * by its recorded and its real path, never a sibling sharing a name prefix.
   * Workspace cleanup and archive both wait on it: a detached run whose client
   * left still executes there (Project-e 096: run-bound cleanup removed
   * rust/target under a live cargo test).
   *
   * A run whose capacity accounting is retired no longer holds it, whichever
   * basis retired it: the producer's own cleanup closure or the operator's
   * exact-run disposition. Both leave the row `running` with its outcome and
   * custody unknown, so without this a retired run held its task's workspace
   * forever (Tom, 2026-10-25: "Both release"; Spec 035, "Workspace release on
   * retired accounting"). An unreadable retirement keeps the hold.
   */
  hostRunHoldingWorkspace(directory: string): HostRunInternalRecord | null {
    const roots = new Set<string>();
    const add = (path: string) => { const trimmed = path.replace(/\/+$/, ""); if (trimmed) roots.add(trimmed); };
    add(directory);
    // Native realpath returns the filesystem's own spelling, so a case alias on a
    // case-insensitive volume resolves to the same root without lowercasing paths
    // on case-sensitive ones (review #564).
    try { add(realpathSync.native(directory)); } catch { /* a removed directory keeps its recorded path */ }
    const inside = (path: string | null | undefined) => {
      if (!path) return false;
      const candidates = [path.replace(/\/+$/, "")];
      try { candidates.push(realpathSync.native(path).replace(/\/+$/, "")); } catch { /* recorded path only */ }
      return candidates.some(candidate => [...roots].some(root => candidate === root || candidate.startsWith(`${root}/`)));
    };
    const rows = this.core.db.prepare(`SELECT data FROM host_run_records
      WHERE state IN ('queued','admitted','running')
        OR (state='settled' AND json_extract(data,'$.capacityReleasedAt') IS NULL)
      ORDER BY rowid`).all();
    for (const record of this.hostRunRows(rows))
      if (inside(record.repository.path) && !this.hostRunAccountingRetirement(record)) return record;
    return null;
  }

  /** All rows that can still reserve host capacity, independent of recent-history limits. */
  hostRunCapacityCandidates(): HostRunInternalRecord[] {
    return this.hostRunRows(this.core.db.prepare(`SELECT data FROM host_run_records
      WHERE state IN ('admitted','running')
        OR (state='settled' AND json_extract(data,'$.capacityReleasedAt') IS NULL)
      ORDER BY rowid DESC`).all());
  }

  /**
   * The last launch instant per repository, grouped in SQL for the scheduler's
   * served-fairness order (audit A7). An idle pump reads nothing at all and a
   * busy one never parses the whole history table; no row is rewritten.
   */
  hostRunServedLaunches(): Array<{ origin: string | null; path: string | null; launchedAt: string }> {
    return (this.core.db.prepare(`SELECT json_extract(data,'$.repository.origin') AS origin,
        json_extract(data,'$.repository.path') AS path, MAX(json_extract(data,'$.launchedAt')) AS launchedAt
      FROM host_run_records WHERE json_extract(data,'$.launchedAt') IS NOT NULL
      GROUP BY json_extract(data,'$.repository.origin'), json_extract(data,'$.repository.path')`).all() as Array<{ origin: unknown; path: unknown; launchedAt: unknown }>)
      .map(row => ({ origin: typeof row.origin === "string" ? row.origin : null, path: typeof row.path === "string" ? row.path : null, launchedAt: String(row.launchedAt) }));
  }

  /** Which of these ids already exist as host runs, in one bounded query per chunk (audit A7). */
  hostRunIdsAmong(ids: readonly string[]): Set<string> {
    const wanted = [...new Set(ids.filter(id => typeof id === "string" && id))];
    const found = new Set<string>();
    for (let start = 0; start < wanted.length; start += 400) {
      const chunk = wanted.slice(start, start + 400);
      for (const row of this.core.db.prepare(`SELECT id FROM host_run_records WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk))
        found.add(String((row as { id: string }).id));
    }
    return found;
  }

  /**
   * One bounded settled-row page for the output-retention sweep, read by rowid
   * after a durable cursor (audit A7): the sweep advances across passes instead
   * of parsing every run row on every pass. `complete` says the page reached the
   * current end, where the caller wraps the cursor to the start.
   */
  hostRunSettledSweepPage(afterRowid: number, limit: number): { rows: HostRunInternalRecord[]; lastRowid: number; complete: boolean } {
    const rows = this.core.db.prepare(`SELECT rowid AS rid, data FROM host_run_records
      WHERE rowid > ? AND json_extract(data,'$.settledAt') IS NOT NULL ORDER BY rowid LIMIT ?`)
      .all(Math.max(0, Math.trunc(afterRowid)), Math.max(1, Math.trunc(limit))) as Array<{ rid: number; data: unknown }>;
    return { rows: this.hostRunRows(rows), lastRowid: rows.length ? Number(rows[rows.length - 1]!.rid) : Math.max(0, Math.trunc(afterRowid)), complete: rows.length < Math.max(1, Math.trunc(limit)) };
  }

  /**
   * Task 444: one run's durable retained-output failure, or null when it has
   * none. A row that no longer parses throws instead of reading as resolved, so
   * a corrupt identity can never become an all-clear.
   */
  hostRunOutputFailure(runId: string): HostRunOutputFailure | null {
    const row = this.core.db.prepare(`SELECT runId,epoch,firstSeen,lastSeen,attempts,nextRetryAt,reason,streams
      FROM host_run_output_failures WHERE runId=?`).get(runId) as Record<string, unknown> | undefined;
    return row ? parseHostRunOutputFailureRow(row) : null;
  }

  /**
   * The oldest stored failures, in establishment order: the bounded named sample
   * a health summary may show. The total comes from `hostRunOutputFailureTotals`,
   * so a sample is never mistaken for the size of the set.
   */
  hostRunOutputFailures(limit = HOST_RUN_OUTPUT_FAILURE_SUMMARY_EXAMPLES): HostRunOutputFailure[] {
    return (this.core.db.prepare(`SELECT runId,epoch,firstSeen,lastSeen,attempts,nextRetryAt,reason,streams
      FROM host_run_output_failures ORDER BY firstSeen, runId LIMIT ?`).all(Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>)
      .map(parseHostRunOutputFailureRow);
  }

  /**
   * The failures whose own bounded retry is due, oldest retry first. This is an
   * index range read on `nextRetryAt`, so a maintenance tick retries a bounded
   * due page and never parses the whole set to find it.
   */
  hostRunOutputFailuresDue(at: string, limit = HOST_RUN_OUTPUT_FAILURE_DUE_PAGE): HostRunOutputFailure[] {
    return (this.core.db.prepare(`SELECT runId,epoch,firstSeen,lastSeen,attempts,nextRetryAt,reason,streams
      FROM host_run_output_failures WHERE nextRetryAt <= ? ORDER BY nextRetryAt, runId LIMIT ?`)
      .all(at, Math.max(1, Math.trunc(limit))) as Array<Record<string, unknown>>).map(parseHostRunOutputFailureRow);
  }

  /** The exact stored total and its first/last sighting, from one aggregate read. */
  hostRunOutputFailureTotals(): { count: number; firstSeen: string | null; lastSeen: string | null } {
    const row = this.core.db.prepare(`SELECT COUNT(*) AS count, MIN(firstSeen) AS firstSeen, MAX(lastSeen) AS lastSeen
      FROM host_run_output_failures`).get() as { count: unknown; firstSeen: unknown; lastSeen: unknown } | undefined;
    const count = Number(row?.count ?? 0);
    return {
      count: Number.isFinite(count) ? count : 0,
      firstSeen: typeof row?.firstSeen === "string" ? row.firstSeen : null,
      lastSeen: typeof row?.lastSeen === "string" ? row.lastSeen : null,
    };
  }

  /** Store one failure durably before any cursor moves past the row that owns it. */
  putHostRunOutputFailure(failure: HostRunOutputFailure): void {
    const parsed = hostRunOutputFailureSchema.parse(failure);
    this.core.db.prepare(`INSERT INTO host_run_output_failures(runId,epoch,firstSeen,lastSeen,attempts,nextRetryAt,reason,streams)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(runId) DO UPDATE SET epoch=excluded.epoch, firstSeen=excluded.firstSeen, lastSeen=excluded.lastSeen,
        attempts=excluded.attempts, nextRetryAt=excluded.nextRetryAt, reason=excluded.reason, streams=excluded.streams`)
      .run(parsed.runId, parsed.epoch, parsed.firstSeen, parsed.lastSeen, parsed.attempts, parsed.nextRetryAt,
        parsed.reason, parsed.streams ? JSON.stringify(parsed.streams) : null);
  }

  /** Remove exactly one run's failure, when that run's own expiry is established. */
  deleteHostRunOutputFailure(runId: string): void {
    this.core.db.prepare("DELETE FROM host_run_output_failures WHERE runId=?").run(runId);
  }

  /**
   * Task 444: bounded durable evidence of each false-positive failure cleared by
   * positive output ownership. A total plus the most recent entries; an
   * unreadable log is replaced rather than trusted, because the durable failure
   * set — not this evidence — decides what is unresolved.
   */
  recordHostRunOutputReclassification(entry: HostRunOutputReclassification): void {
    const parsed = hostRunOutputReclassificationSchema.parse(entry);
    const stored = this.hostRunOutputReclassifications();
    if (stored.recent.some(item => item.runId === parsed.runId && item.epoch === parsed.epoch && item.owner === parsed.owner)) return;
    const log: HostRunOutputReclassificationLog = hostRunOutputReclassificationLogSchema.parse({
      format: "host.run.output.owner-reclassifications", version: 1, updatedAt: parsed.at, total: stored.total + 1,
      recent: [...stored.recent, parsed].slice(-HOST_RUN_OUTPUT_RECLASSIFICATION_LIMIT),
    });
    this.core.setMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META, log);
  }

  /**
   * Does this task durably record scheduling project validation as exactly this
   * host run, at exactly this epoch and head? Either its live validation pin
   * names all three, or its `project_validation_scheduler_recorded` event does.
   * The pin moves on with each later validation; the event stays, and it is
   * written as one exact string naming the run, epoch and head so it can never
   * be re-read as evidence for another head or a changed epoch.
   */
  projectValidationRecordsRun(taskId: string, runId: string, epoch: number, head: string): boolean {
    const row = this.core.db.prepare("SELECT data FROM tasks WHERE id=?").get(taskId) as { data: string } | undefined;
    if (!row) return false;
    const pin = (JSON.parse(row.data) as Task).resolution?.projectValidation;
    if (pin && pin.hostRunId === runId && pin.hostRunEpoch === epoch && pin.head === head) return true;
    return this.core.db.prepare("SELECT 1 FROM events WHERE taskId=? AND kind='project_validation_scheduler_recorded' AND detail=? LIMIT 1")
      .get(taskId, projectValidationSchedulerEvidence(runId, epoch, head)) !== undefined;
  }

  /**
   * Positive proof that a host run came through Queue's own submit path, for a
   * row written before the pinned record carried `submissionSource`: Queue's
   * submit journals a `host.run.submit` request and the client endpoint journals
   * `host.run.client.submit`. An admission reservation carries its source beside
   * the row instead, so it is already labelled and never reaches this read. A
   * journal that shows the client method, neither method, or cannot be read
   * proves nothing, so it is never Queue's.
   */
  hostRunSubmittedByQueue(runId: string): boolean {
    const journal = this.hostRunJournal(runId);
    const method = (entry: { event: string; data: unknown }): unknown =>
      entry.event === "request" ? (entry.data as { method?: unknown } | null)?.method : undefined;
    if (journal.some(entry => method(entry) === "host.run.client.submit")) return false;
    return journal.some(entry => method(entry) === "host.run.submit");
  }

  /** The reclassification evidence: its exact total and its bounded recent entries. */
  hostRunOutputReclassifications(): { total: number; recent: HostRunOutputReclassification[] } {
    const stored = this.core.getMeta<unknown>(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META);
    if (stored === undefined || stored === null) return { total: 0, recent: [] };
    const parsed = hostRunOutputReclassificationLogSchema.safeParse(stored);
    return parsed.success ? { total: parsed.data.total, recent: parsed.data.recent } : { total: 0, recent: [] };
  }

  /**
   * Settled rows still holding capacity for escaped descendants not yet proven
   * dead: the QA re-attachment candidates, selected in SQL rather than by parsing
   * every run row (audit A7). A row that is released or proven dead is absent.
   */
  hostRunsAwaitingEscapedDescendants(): HostRunInternalRecord[] {
    return this.hostRunRows(this.core.db.prepare(`SELECT data FROM host_run_records
      WHERE state='settled' AND json_extract(data,'$.capacityReleasedAt') IS NULL
        AND json_extract(data,'$.escapedDescendantsProvenDeadAt') IS NULL
        AND json_array_length(json_extract(data,'$.settlement.result.escapedDescendants')) > 0
      ORDER BY rowid DESC`).all());
  }

  /**
   * Historical budget samples for one selector in the given repositories, filtered
   * in SQL by the indexed selector and the repository keys (audit A7), so a submit
   * parses only the rows it can use instead of the whole history table.
   */
  hostRunSelectorSamples(repositoryKeys: readonly string[], selector: string): HostRunInternalRecord[] {
    const keys = [...new Set(repositoryKeys.filter(key => typeof key === "string" && key).map(key => key.toLowerCase()))];
    if (!keys.length) return [];
    const placeholders = keys.map(() => "?").join(",");
    return this.core.db.prepare(`SELECT data FROM host_run_records
      WHERE ${HOST_RUN_SELECTOR} = ?
        AND (lower(json_extract(${HOST_RUN_VALID_DATA},'$.repository.origin')) IN (${placeholders})
          OR lower(json_extract(${HOST_RUN_VALID_DATA},'$.repository.path')) IN (${placeholders}))`)
      .all(selector, ...keys, ...keys).map(row => parseHostRunRow((row as { data: unknown }).data));
  }

  /** All pending rows, used for scheduler deadlines and queue ordering rather than history views. */
  hostRunsByStates(states: HostRunInternalRecord["state"][]): HostRunInternalRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return this.hostRunRows(this.core.db.prepare(`SELECT data FROM host_run_records WHERE state IN (${placeholders}) ORDER BY rowid DESC`).all(...states));
  }

  /**
   * Rows plus their identities, for a list read: the identity query runs once,
   * and a row whose identity is missing or stale keeps only its own fields.
   */
  private hostRunRows(rows: unknown[]): HostRunInternalRecord[] {
    if (!rows.length) return [];
    const identities = this.hostRunIdentities();
    return rows.map(row => {
      const record = parseHostRunRow((row as { data: unknown }).data);
      return hostRunWithIdentity(record, identities.get(record.id));
    });
  }

  appendHostRunJournal(runId: string, event: string, data: unknown, at = now()): number {
    const write = () => Number(this.core.db.prepare("INSERT INTO host_run_journal(run_id,event,at,data) VALUES(?,?,?,?)").run(runId, event, at, JSON.stringify(event === "request" || event === "submission" ? redactHostRunData(data) : data)).lastInsertRowid);
    return this.core.db.isTransaction ? write() : this.core.transaction(write);
  }

  hostRunJournal(runId: string): Array<{ event: string; at: string; data: unknown }> {
    return this.core.db.prepare("SELECT event,at,data FROM host_run_journal WHERE run_id=? ORDER BY id").all(runId)
      .map(row => ({ event: String(row.event), at: String(row.at), data: JSON.parse(String(row.data)) }));
  }

  /** Papercut 26636095: the stored QA admission fence record; revision 0 with no fence when never written. */
  qaFenceRecord(): QaFenceRecord {
    // Decoded here, never through getMeta: an unreadable record must not throw
    // from board state or admission, and must not read as "no fence" either.
    const row = this.core.db.prepare("SELECT value FROM meta WHERE key='qaAdmissionFence'").get() as { value: string } | undefined;
    if (!row) return { revision: 0, fence: null, clearedAt: null, clearedBy: null, history: [] };
    let value: unknown;
    try { value = JSON.parse(row.value); } catch { value = undefined; }
    const parsed = qaFenceRecordSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    // Fail closed: admissions stay fenced until the operator writes revision 0 over it.
    return { revision: 0, clearedAt: null, clearedBy: null, history: [], fence: { id: "unreadable", until: "9999-12-31T23:59:59.000Z",
      reason: "The stored QA fence record is unreadable; new QA admissions stay fenced until the operator sets or clears the fence",
      setAt: "1970-01-01T00:00:00.000Z", setBy: { caller: "queue", kind: "unreadable_record", note: null } } };
  }

  /** The fence in force: the stored fence until its absolute `until` passes. Expiry writes nothing. */
  qaFenceInForce(at = Date.now()): QaFence | null {
    const fence = this.qaFenceRecord().fence;
    return fence && Date.parse(fence.until) > at ? fence : null;
  }

  qaFenceView(at = Date.now()): QaFenceView {
    const record = this.qaFenceRecord(), fence = this.qaFenceInForce(at);
    return { revision: record.revision, fence, expired: record.fence && !fence ? record.fence : null };
  }

  writeQaFence(record: QaFenceRecord): void { this.core.setMeta("qaAdmissionFence", qaFenceRecordSchema.parse(record)); }

  /**
   * Every unsettled QA custody item on the host, read from all rows rather than
   * the latest-per-repository index: QA runs not finished, finished runs with an
   * escaped descendant no exit proof covers, requests still preparing (an
   * unresolved delivery stays visible however old), and milestone host runs
   * still queued, admitted, running or holding capacity after settling. Every
   * JSON read is guarded (`json_extract` only inside `CASE WHEN json_valid`, and
   * guarded parses in code): a row that cannot be decoded is listed as
   * unreadable, never dropped, and the read never throws.
   */
  qaUnsettledInventory(): QaInventoryItem[] {
    const items: QaInventoryItem[] = [];
    const text = (value: unknown) => typeof value === "string" ? value : "";
    const decode = (value: unknown): unknown => { try { return JSON.parse(String(value)); } catch { return undefined; } };
    // The proof covers only the identities its host run recorded: a later
    // retry's new escapee is not covered by an older proof, and a malformed
    // proof proves nothing.
    const hostRow = this.core.db.prepare("SELECT data FROM host_run_records WHERE id=?");
    const provenDead = (run: ProjectQaRun): boolean => {
      const host = decode((hostRow.get(run.id) as { data: string } | undefined)?.data) as
        { escapedDescendantsProvenDeadAt?: unknown; settlement?: { result?: { escapedDescendants?: unknown } } } | undefined;
      if (!host || typeof host !== "object" || typeof host.escapedDescendantsProvenDeadAt !== "string") return false;
      const proven = z.array(hostRunEscapedDescendantSchema).safeParse(host.settlement?.result?.escapedDescendants);
      if (!proven.success) return false;
      const covered = new Set(proven.data.map(entry => `${entry.pid}:${entry.startIdentity}`));
      return run.escapedDescendants.every(entry => covered.has(`${entry.pid}:${entry.startIdentity}`));
    };
    for (const row of this.core.db.prepare(`SELECT id, repository, data FROM project_qa_runs
      WHERE NOT json_valid(data) OR CASE WHEN json_valid(data) THEN
        json_extract(data,'$.state') IN ('queued','running') OR json_extract(data,'$.finishedAt') IS NULL
        OR json_type(data,'$.escapedDescendants')='array' AND json_array_length(data,'$.escapedDescendants') > 0 END
      ORDER BY rowid`).all()) {
      const parsed = projectQaRunSchema.safeParse(decode(row.data));
      if (!parsed.success) {
        items.push({ kind: "qa_run", id: String(row.id), repository: String(row.repository), state: "unreadable", detail: "The stored QA run does not decode; treat it as unsettled" });
        continue;
      }
      const run = parsed.data, finished = !["queued", "running"].includes(run.state) && run.finishedAt !== null;
      if (finished && provenDead(run)) continue;
      items.push({ kind: "qa_run", id: run.id, repository: run.key, state: run.state,
        detail: finished
          ? `Finished with ${run.escapedDescendants.length} escaped descendant${run.escapedDescendants.length === 1 ? "" : "s"} and no durable proof they exited`
          : `${run.baseBranch} at ${run.base.slice(0, 12)}` });
    }
    for (const row of this.core.db.prepare(`SELECT key, value FROM meta WHERE key GLOB 'projectQaRequest:*'
      AND (NOT json_valid(value) OR CASE WHEN json_valid(value) THEN json_extract(value,'$.state')='preparing' END) ORDER BY key`).all()) {
      const decoded = decode(row.value);
      const request = (decoded && typeof decoded === "object" ? decoded : {}) as Record<string, unknown>;
      const readable = Boolean(decoded && typeof decoded === "object");
      const input = (request.input && typeof request.input === "object" ? request.input : {}) as Record<string, unknown>;
      items.push({ kind: "qa_request", id: text(request.id) || String(row.key).slice("projectQaRequest:".length),
        repository: text(input.repository), state: readable ? "preparing" : "unreadable",
        detail: readable
          ? `Received ${text(request.receivedAt) || "at an unknown time"} by owner ${text(request.ownerInstance) || "unknown"} (pid ${typeof request.ownerPid === "number" ? request.ownerPid : "unknown"}); its delivery is unresolved`
          : "The stored QA request does not decode; treat its delivery as unresolved" });
    }
    for (const row of this.core.db.prepare(`SELECT id, repository, state, data FROM host_run_records
      WHERE NOT json_valid(data) OR CASE WHEN json_valid(data) THEN json_extract(data,'$.priority')='milestone'
        AND (state IN ('queued','admitted','running') OR (state='settled' AND json_extract(data,'$.capacityReleasedAt') IS NULL)) END
      ORDER BY rowid`).all()) {
      const readable = decode(row.data) !== undefined;
      const settled = row.state === "settled";
      // An unsettled milestone run whose accounting an operator retired is still
      // listed: it never stops being an unresolved runtime custody item.
      const stored = readable ? hostRunInternalRecordSchema.safeParse(decode(row.data)) : null;
      const storedDisposition = stored?.success
        ? hostRunAccountingDispositionSchema.safeParse(this.hostRunAccountingDispositionRaw(stored.data.id)) : null;
      const retired = Boolean(stored?.success && storedDisposition?.success
        && storedDisposition.data.runId === stored.data.id && storedDisposition.data.epoch === stored.data.epoch);
      items.push({ kind: "host_run", id: String(row.id), repository: String(row.repository), state: readable ? String(row.state) : "unreadable",
        detail: !readable ? "The stored host run does not decode; treat it as holding capacity"
          : settled ? "Settled but still holding host capacity (open containers or escaped descendants)"
            : retired ? "Milestone host run is unsettled; an operator retired its accounting, and its runtime outcome and custody stay unknown"
              : "Milestone host run not yet settled" });
    }
    return items;
  }
}
