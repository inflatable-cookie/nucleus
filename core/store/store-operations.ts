import { noticeSchema, agentMessageRecordSchema, DEFAULT_PASEO_CALL_LIMIT, MAX_PASEO_CALL_LIMIT, submissionSchema, pendingSubmissionSchema, type PendingSubmission, type Run, type Notice, type AgentMessageRecord, type Task, type RepositorySettings } from "../../shared/contracts";
import { hookRecordSchema, type HookRecord } from "../../shared/hooks";
import { queueOperationSchema, DEFAULT_OPERATION_LIMIT, MAX_OPERATION_LIMIT, OPERATION_BACKPRESSURE_RETRY_MS, type OperationAcceptance, type QueueOperation } from "../../shared/operations";
import { taskControlInputSchema } from "../../shared/contracts";
import { StoreCore, now, digest, operationInputHash } from "./store-core";

/** Stable operation ID for a caller key; deterministic so a lost response reconciles the same record. */
export const operationIdForKey = (key: string) => digest(`operation\n${key}`);

/** Normalized input digest used to fence idempotent acceptance. */
export { operationInputHash } from "./store-core";

/** Every earlier attempt must retain its own definite execution receipt. */
export function provedPreSendHistory(operation: QueueOperation, count: number): boolean {
  const history = operation.preSendHistory ?? [];
  return history.length === count && history.every((entry, index) => {
    const receipt = entry.receipt, effect = entry.effect;
    return receipt.operationId === operation.id && receipt.inputHash === operation.inputHash
      && receipt.taskId === operation.taskId && receipt.expectedVersion === operation.expectedVersion
      && receipt.attempt === index + 1 && receipt.effect.status === "intent"
      && entry.diagnostic === receipt.diagnostic && effect !== null
      && effect.kind === receipt.effect.kind && effect.target === receipt.effect.target && effect.intentAt === receipt.effect.intentAt
      && effect.result === receipt.diagnostic.slice(0, 2000)
      && (effect.status === "reconciled" || effect.status === "uncertain" && entry.reconciledAt !== null);
  });
}
interface OperationTaskAccess {
  taskChanged(taskId: string): void;
  numberForCached(taskId: string): { number: number; reference: string } | null;
  runs(taskId?: string): Run[];
  task(id: string): Task;
  canonicalRepository(repoPath: string, origin?: string | null): RepositorySettings | null;
}
export class StoreOperations {
  constructor(private readonly core: StoreCore, private readonly access: OperationTaskAccess) {}

  notices(taskId?: string): Notice[] { return (taskId ? this.core.db.prepare("SELECT data FROM notices WHERE taskId=? ORDER BY rowid").all(taskId) : this.core.db.prepare("SELECT data FROM notices ORDER BY rowid").all()).map(r => noticeSchema.parse(JSON.parse(String(r.data)))); }

  unsettledNoticeCount(): number {
    return Number(this.core.db.prepare("SELECT COUNT(*) AS count FROM notices WHERE json_extract(data, '$.status') IN ('pending','intent','uncertain')").get()?.count ?? 0);
  }

  putNotice(n: Notice) { this.core.db.prepare("INSERT INTO notices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(n.id, n.taskId, JSON.stringify(n)); this.core.advanceRevision(); this.access.taskChanged(n.taskId); }

  /** Spec 058 rollout step 3: a task's worker messages, sent and received, oldest first. */
  messages(taskId: string): AgentMessageRecord[] {
    return (this.core.db.prepare("SELECT data FROM task_messages WHERE fromTaskId=? OR toTaskId=? ORDER BY rowid").all(taskId, taskId) as { data: string }[])
      .map(row => agentMessageRecordSchema.parse(JSON.parse(String(row.data))));
  }

  /** Every message still waiting for its recipient role's next turn, oldest first. */
  queuedMessages(): AgentMessageRecord[] {
    return (this.core.db.prepare("SELECT data FROM task_messages WHERE json_extract(data,'$.status')='queued' ORDER BY rowid").all() as { data: string }[])
      .map(row => agentMessageRecordSchema.parse(JSON.parse(String(row.data))));
  }

  message(id: string): AgentMessageRecord | null {
    const row = this.core.db.prepare("SELECT data FROM task_messages WHERE id=?").get(id) as { data: string } | undefined;
    return row ? agentMessageRecordSchema.parse(JSON.parse(String(row.data))) : null;
  }

  putMessage(record: AgentMessageRecord) {
    this.core.db.prepare("INSERT INTO task_messages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(record.id, record.fromTaskId, record.toTaskId, JSON.stringify(record));
    this.core.advanceRevision();
    this.access.taskChanged(record.fromTaskId);
    this.access.taskChanged(record.toTaskId);
  }

  /** One rowid-ordered page of hook events, for callers that hand the event loop back between pages. */
  hookEventsPage(afterRowid: number, limit: number, throughRowid = Number.MAX_SAFE_INTEGER): { records: HookRecord[]; lastRowid: number } {
    const rows = this.core.db.prepare("SELECT rowid AS rid, data FROM hook_events WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(afterRowid, throughRowid, limit);
    return { records: rows.map(row => hookRecordSchema.parse(JSON.parse(String(row.data)))), lastRowid: rows.length ? Number(rows[rows.length - 1].rid) : afterRowid };
  }

  hookEvents(taskId?: string): HookRecord[] {
    const rows = taskId ? this.core.db.prepare("SELECT data FROM hook_events WHERE taskId=? ORDER BY rowid").all(taskId) : this.core.db.prepare("SELECT data FROM hook_events ORDER BY rowid").all();
    return rows.map(row => hookRecordSchema.parse(JSON.parse(String(row.data))));
  }

  hookEvent(id: string): HookRecord | null { const row = this.core.db.prepare("SELECT data FROM hook_events WHERE id=?").get(id); return row ? hookRecordSchema.parse(JSON.parse(String(row.data))) : null; }

  /**
   * Remove reconciled orphan occurrences in bounded transactions. The reaper collects them
   * while it walks the table, so a store with thousands of legacy orphans pays a handful of
   * commits instead of one durable write per row.
   */
  deleteHookEvents(ids: readonly string[], batch = 500): number {
    let removed = 0;
    for (let start = 0; start < ids.length; start += batch) {
      const slice = ids.slice(start, start + batch);
      removed += this.core.transaction(() => {
        const remove = this.core.db.prepare("DELETE FROM hook_events WHERE id=?");
        let count = 0;
        for (const id of slice) count += Number(remove.run(id).changes);
        return count;
      });
    }
    return removed;
  }

  putHookEvent(record: HookRecord) {
    this.core.db.prepare("INSERT INTO hook_events VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(record.id, record.taskId, `${record.hookId}:${record.event}`, record.eventId, JSON.stringify(record));
    this.core.advanceTelemetryRevision(); this.access.taskChanged(record.taskId);
  }

  /** One durable operation by its stable caller key. */
  numberedOperation(data: string): QueueOperation {
    const operation = queueOperationSchema.parse(JSON.parse(data));
    if (!operation.result?.taskId) return operation;
    const number = this.access.numberForCached(operation.result.taskId);
    return number ? { ...operation, result: { ...operation.result, ...number } } : operation;
  }

  operationForKey(key: string): QueueOperation | null {
    const row = this.core.db.prepare("SELECT data FROM operations WHERE key=?").get(key);
    return row ? this.numberedOperation(String(row.data)) : null;
  }

  operation(id: string): QueueOperation | null {
    const row = this.core.db.prepare("SELECT data FROM operations WHERE id=?").get(id);
    return row ? this.numberedOperation(String(row.data)) : null;
  }

  /** Stored command payload for an accepted operation; never leaves the server boundary. */
  operationPayload(id: string): unknown {
    const row = this.core.db.prepare("SELECT payload FROM operations WHERE id=?").get(id);
    return row ? JSON.parse(String(row.payload)) : null;
  }

  /**
   * Legacy rows from before the pre-send receipt existed (effigy#528, Queue #544):
   * Queue's own fence refusal was recorded as an uncertain effect, so the
   * refusal fenced the ordinary paths it was protecting. Relabel exactly that
   * population from the operation journal — never a caller's word: the
   * diagnostic must be one of Queue's own fence-refusal messages for a run
   * this task still names, and the journal must show no boundary, no retry, no
   * bound delivery and the refusal's own effect shape. Anything else stays
   * uncertain. Only the label changes; the control is never re-run.
   */
  private reconcileLegacyPreSendRefusal(operation: QueueOperation, inputHash: string): QueueOperation {
    const payload = this.operationPayload(operation.id) as { type?: unknown; control?: unknown } | null;
    const parsed = taskControlInputSchema.safeParse(payload?.control);
    const effect = operation.effect;
    // An already-relabelled refusal is history; repeating the reconcile is idempotent.
    if (operation.state === "failed" && !operation.result && !operation.preSendReceipt && !operation.preSendBoundaryStartedAt
      && operation.inputHash === inputHash && operationInputHash(payload) === inputHash)
      return operation;
    if (operation.state !== "needs_attention" || operation.result || operation.attempts !== 1
      || operation.preSendBoundaryStartedAt || payload?.type !== "task_control" || !parsed.success
      || operation.id !== operationIdForKey(operation.key) || operation.inputHash !== inputHash || operationInputHash(payload) !== inputHash
      || parsed.data.taskId !== operation.taskId || parsed.data.version !== operation.expectedVersion
      || !effect || effect.kind !== "task_control" || effect.target !== parsed.data.action || effect.status !== "uncertain"
      || effect.result !== operation.diagnostic.slice(0, 2000)
      || this.access.runs(operation.taskId!).some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === operation.id)))
      throw new Error("Operation, request, attempt or effect evidence conflicts; delivery remains uncertain");
    // The fence messages are authored in `runFenceRefusal` and `VerbFences`'s
    // `verbRunFenceRefusal`; a fenced run of this task must still be named by
    // the exact text, so the diagnostic cannot be any other failure's prose.
    const fence = /^A ([a-z]+) run \(([^)]+)\) (?:holds a durable side effect Queue will not act over blindly \(.+\); (?:restart re-creates it under the same run, or wait for reconciliation to settle it|wait for that delivery or effect to settle, or retry_effect it)|still owns this task: .+)$/.exec(operation.diagnostic);
    const named = fence && this.access.runs(operation.taskId!).find(run => run.id === fence[2] && run.role === fence[1]);
    if (!fence || !named)
      throw new Error("The diagnostic is not one of Queue's own pre-send refusal messages; delivery remains uncertain");
    return this.putOperation({ ...operation, state: "failed", preSendReconciledAt: now() });
  }

  /** Settle only an execution-authored no-send receipt; never re-run the control. */
  reconcileTaskControlPreSend(id: string, inputHash: string): QueueOperation {
    return this.core.transaction(() => {
      const operation = this.operation(id);
      if (!operation || operation.kind !== "task_control") throw new Error("Task-control operation not found");
      const proof = operation.preSendReceipt;
      if (!proof) return this.reconcileLegacyPreSendRefusal(operation, inputHash);
      if (operation.state === "failed") {
        if (inputHash !== operation.inputHash || proof.operationId !== id || proof.inputHash !== inputHash)
          throw new Error("Input or receipt identity does not match the already-failed operation");
        return operation;
      }
      const payload = this.operationPayload(id) as { type?: unknown; control?: unknown } | null;
      const parsed = taskControlInputSchema.safeParse(payload?.control);
      const effect = operation.effect;
      if (operation.state !== "needs_attention" || operation.result || !parsed.success || payload?.type !== "task_control"
        || operation.id !== operationIdForKey(operation.key) || operation.inputHash !== inputHash || operationInputHash(payload) !== inputHash
        || proof.operationId !== id || proof.inputHash !== inputHash || proof.taskId !== operation.taskId
        || proof.expectedVersion !== operation.expectedVersion || parsed.data.taskId !== operation.taskId
        || parsed.data.version !== operation.expectedVersion || parsed.data.action !== "restart"
        || proof.attempt !== operation.attempts || !provedPreSendHistory(operation, operation.attempts - 1)
        || !effect || effect.kind !== "task_control" || effect.target !== parsed.data.action || effect.status !== "uncertain"
        || proof.effect.kind !== effect.kind || proof.effect.target !== effect.target || proof.effect.intentAt !== effect.intentAt
        || proof.effect.status !== "intent" || operation.diagnostic !== proof.diagnostic || effect.result !== proof.diagnostic.slice(0, 2000))
        throw new Error("Operation, request, attempt or effect evidence conflicts; delivery remains uncertain");
      if (this.access.runs(operation.taskId!).some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === id)))
        throw new Error("A reviewer delivery is bound to this operation; delivery remains uncertain");
      if (digest(JSON.stringify(this.access.task(operation.taskId!))) !== proof.taskEvidenceHash
        || digest(JSON.stringify(this.access.runs(operation.taskId!))) !== proof.runEvidenceHash)
        throw new Error("Task or run evidence changed since the refusal; delivery remains uncertain");
      return this.putOperation({ ...operation, state: "failed", preSendReconciledAt: now() });
    });
  }

  /** Bounded operation reads; only unfinished work is scanned by default. */
  operations(filter: { states?: QueueOperation["state"][]; taskId?: string; limit?: number } = {}): QueueOperation[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const clauses: string[] = []; const params: string[] = [];
    if (filter.states?.length) { clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`); params.push(...filter.states); }
    if (filter.taskId) { clauses.push("taskId=?"); params.push(filter.taskId); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.core.db.prepare(`SELECT data FROM operations${where} ORDER BY rowid LIMIT ?`).all(...params, limit)
      .map(row => this.numberedOperation(String(row.data)));
  }

  /** Exact source lookup must not lose unknown delivery behind the bounded inspection page. */
  unfinishedSourcePromotion(source: { kind: "lead" | "papercut"; id: string; repository: string; version: number | null; digest: string }): QueueOperation | null {
    const row = this.core.db.prepare(`SELECT data FROM operations WHERE kind='source_promote'
      AND state IN ('pending','running','needs_attention')
      AND json_extract(payload,'$.source.kind')=? AND json_extract(payload,'$.source.id')=?
      AND json_extract(payload,'$.source.repository')=? AND json_extract(payload,'$.source.version') IS ?
      AND json_extract(payload,'$.source.digest')=? ORDER BY rowid LIMIT 1`)
      .get(source.kind, source.id, source.repository, source.version, source.digest);
    return row ? this.numberedOperation(String(row.data)) : null;
  }

  /** Source promotions whose running delivery was interrupted and needs store-based reconciliation. */
  sourcePromotionsForReconciliation(): QueueOperation[] {
    return this.core.db.prepare("SELECT data FROM operations WHERE kind='source_promote' AND state IN ('running','needs_attention') ORDER BY rowid")
      .all().map(row => this.numberedOperation(String(row.data)));
  }

  /** Unfinished operation count used for admission and compact UI state. */
  /**
   * Operations that can still bind, or that already name this submission, for an
   * absence proof. Unfinished work is bounded by the operation limit; settled
   * history for other submissions is deliberately not scanned here.
   */
  operationsForAbsenceProof(submissionId: string): QueueOperation[] {
    // Audit B10: the stored submission identity has an expression index, so SQLite answers
    // the two OR branches with MULTI-INDEX OR (`operations_submission` and `operations_state`)
    // instead of scanning every retained operation. Settled history for any other submission
    // is never read, and the rows returned are exactly the pre-change query's rows.
    return this.core.db.prepare("SELECT data FROM operations WHERE state != 'failed' AND (json_extract(data,'$.submissionId')=? OR state IN ('pending','running','needs_attention')) ORDER BY rowid")
      .all(submissionId).map(row => this.numberedOperation(String(row.data)));
  }

  operationBacklog(): number {
    return Number(this.core.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE state IN ('pending','running')").get()!.n);
  }

  /**
   * Spec 026: accepted submissions whose task does not exist yet, so the board
   * shows a "submitting" card before the task appears. The submission's task
   * identity removes the card the moment it exists.
   *
   * Paged by rowid so no read cap can hide a pending submission from the board or
   * from a project-removal blocker scan (Spec 027).
   */
  pendingSubmissions(): PendingSubmission[] {
    const known = this.core.db.prepare("SELECT 1 FROM tasks WHERE submission=? UNION ALL SELECT 1 FROM tombstones WHERE submission=? LIMIT 1");
    const cards: PendingSubmission[] = [];
    let after = 0;
    while (true) {
      const page = this.core.db.prepare("SELECT rowid AS rid, data FROM operations WHERE state IN ('pending','running') AND kind IN ('submit','review_entry') AND rowid>? ORDER BY rowid LIMIT 500").all(after);
      if (!page.length) break;
      after = Number(page[page.length - 1].rid);
      for (const row of page) {
        const operation = this.numberedOperation(String(row.data));
        if (operation.kind !== "submit" && operation.kind !== "review_entry") continue;
        if (operation.taskId || !operation.submissionId || known.get(operation.submissionId, operation.submissionId)) continue;
        const payload = this.operationPayload(operation.id) as { submission?: unknown; input?: { submission?: unknown } } | null;
        const parsed = submissionSchema.safeParse(payload?.submission ?? payload?.input?.submission);
        if (!parsed.success) continue;
        const repository = this.access.canonicalRepository(parsed.data.repoPath)?.repository.origin ?? null;
        cards.push(pendingSubmissionSchema.parse({
          id: operation.id, submissionId: operation.submissionId, title: parsed.data.title,
          repoPath: parsed.data.repoPath, repository, lanes: parsed.data.lanes,
          state: operation.state, createdAt: operation.createdAt,
        }));
      }
    }
    return cards;
  }

  configuredOperationLimit(): number {
    const configured = this.core.getMeta<number>("operationLimit");
    return configured === undefined ? DEFAULT_OPERATION_LIMIT : Math.min(Math.max(configured, 1), MAX_OPERATION_LIMIT);
  }

  /**
   * Operator bound on concurrent Paseo daemon calls (Spec 012): default sized to
   * Paseo's interactive capacity and bounded 1-32. The admission controller reads
   * it live, so a saved change applies without a restart.
   */
  configuredPaseoCallLimit(): number {
    const configured = this.core.getMeta<number>("paseoCallLimit");
    if (configured === undefined || !Number.isFinite(configured)) return DEFAULT_PASEO_CALL_LIMIT;
    return Math.min(Math.max(Math.trunc(configured), 1), MAX_PASEO_CALL_LIMIT);
  }

  putOperation(operation: QueueOperation, payload?: unknown): QueueOperation {
    let next = queueOperationSchema.parse(operation);
    const previous = this.core.db.prepare("SELECT taskId,data FROM operations WHERE id=?").get(next.id);
    const previousTaskId = previous?.taskId;
    const previousData = previous ? JSON.parse(String(previous.data)) as {hostId?: unknown; hostSelection?: QueueOperation['hostSelection']} : undefined;
    const previousHost: unknown = previousData?.hostId;
    if (typeof previousHost === "string" && previousHost) next = { ...next, hostId: previousHost };
    else if (previous && next.hostId) throw new Error("Operation host cannot be assigned by an ordinary update");
    if (previousData?.hostSelection) next = { ...next, hostSelection: previousData.hostSelection };
    else if (previous && next.hostSelection) throw new Error('Operation host selection cannot be assigned by an ordinary update');
    const stored = payload === undefined ? null : JSON.stringify(payload);
    this.core.db.prepare(`INSERT INTO operations(id,key,kind,inputHash,state,taskId,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,taskId=excluded.taskId,data=excluded.data${payload === undefined ? "" : ",payload=excluded.payload"}`)
      .run(next.id, next.key, next.kind, next.inputHash, next.state, next.taskId, next.createdAt, stored ?? "null", JSON.stringify(next));
    this.core.advanceRevision();
    if (previousTaskId) this.access.taskChanged(String(previousTaskId));
    if (next.taskId && next.taskId !== previousTaskId) this.access.taskChanged(next.taskId);
    return next;
  }

  /**
   * Idempotent acceptance in one short transaction. Repeating the same key and
   * normalized input reopens a definite failure or returns the same operation;
   * reusing the key with different input fails closed before any remote work.
   * Saturation returns typed backpressure instead of storing an unserviceable operation.
   */
  acceptOperation(input: { key: string; kind: QueueOperation["kind"]; inputHash: string; taskId?: string | null; expectedVersion?: number | null; repoPath?: string | null; submissionId?: string | null; hostId?: string; hostSelection?: QueueOperation['hostSelection']; payload: unknown }, at = now()): OperationAcceptance {
    const id = operationIdForKey(input.key);
    return this.core.transaction(() => {
      const row = this.core.db.prepare("SELECT data FROM operations WHERE key=?").get(input.key);
      if (row) {
        const existing = this.numberedOperation(String(row.data));
        if (existing.inputHash !== input.inputHash) throw new Error("Operation key already used with different input");
        if (existing.state === "failed") {
          const limit = this.configuredOperationLimit();
          const backlog = this.operationBacklog();
          if (backlog >= limit) return { backpressured: true as const, pending: backlog, retryAfterMs: OPERATION_BACKPRESSURE_RETRY_MS, reason: `Queue operation backlog ${backlog} reached the configured bound of ${limit}; retry after the queue drains` };
          const history = existing.preSendReceipt ? [...(existing.preSendHistory ?? []), {
            receipt: existing.preSendReceipt, effect: existing.effect, diagnostic: existing.diagnostic,
            settledAt: existing.settledAt, reconciledAt: existing.preSendReconciledAt ?? null,
          }] : existing.preSendHistory;
          if (existing.preSendReceipt && (!provedPreSendHistory({ ...existing, preSendHistory: history }, existing.attempts)
              || existing.id !== operationIdForKey(existing.key) || operationInputHash(input.payload) !== existing.inputHash
              || operationInputHash(this.operationPayload(existing.id)) !== existing.inputHash
              || this.access.runs(existing.taskId!).some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === existing.id))))
            throw new Error("The previous pre-send receipt or delivery evidence conflicts; no retry was admitted");
          const reopened = this.putOperation({ ...existing, state: "pending", startedAt: null, settledAt: null,
            diagnostic: "", result: null, effect: null, preSendBoundaryStartedAt: null,
            preSendReceipt: null, preSendReconciledAt: null, ...(history ? { preSendHistory: history } : {}) });
          return { accepted: true as const, operation: reopened };
        }
        return { accepted: true as const, operation: existing };
      }
      const limit = this.configuredOperationLimit();
      const backlog = this.operationBacklog();
      if (backlog >= limit) return { backpressured: true as const, pending: backlog, retryAfterMs: OPERATION_BACKPRESSURE_RETRY_MS, reason: `Queue operation backlog ${backlog} reached the configured bound of ${limit}; retry after the queue drains` };
      const operation = queueOperationSchema.parse({
        id, key: input.key, kind: input.kind, inputHash: input.inputHash, state: "pending",
        ...(input.hostId ? { hostId: input.hostId } : {}),
        ...(input.hostSelection ? { hostSelection: input.hostSelection } : {}),
        taskId: input.taskId ?? null, expectedVersion: input.expectedVersion ?? null,
        repoPath: input.repoPath ?? null, submissionId: input.submissionId ?? null, createdAt: at,
      });
      this.putOperation(operation, input.payload);
      return { accepted: true as const, operation };
    });
  }
}
