import {
  DEFAULT_HOST_CALL_LIMIT,
  MAX_HOST_CALL_LIMIT,
} from "../../shared/contracts";
import {
  queueOperationSchema,
  DEFAULT_OPERATION_LIMIT,
  MAX_OPERATION_LIMIT,
  OPERATION_BACKPRESSURE_RETRY_MS,
  type OperationAcceptance,
  type QueueOperation,
} from "../../shared/operations";
import {
  StoreCore,
  now,
  operationIdForKey,
} from "./store-core";

interface OperationTaskAccess {
  taskChanged(taskId: string): void;
  numberForCached(taskId: string): { number: number; reference: string } | null;
}

/**
 * Durable operations: the journal of accepted caller keys, their reads, their
 * writes and the bounded limits that admit new work. The board's pending
 * submissions live in
 * `StorePendingSubmissions`.
 */
export class StoreOperations {
  constructor(
    private readonly core: StoreCore,
    private readonly access: OperationTaskAccess,
  ) {}

  /** The stored row with its task's current number attached; a row without a task is returned as stored. */
  numberedOperation(data: string): QueueOperation {
    const operation = queueOperationSchema.parse(JSON.parse(data));
    if (!operation.result?.taskId) return operation;
    const number = this.access.numberForCached(operation.result.taskId);
    return number
      ? { ...operation, result: { ...operation.result, ...number } }
      : operation;
  }

  operationForKey(key: string): QueueOperation | null {
    const row = this.core.db
      .prepare("SELECT data FROM operations WHERE key=?")
      .get(key);
    return row ? this.numberedOperation(String(row.data)) : null;
  }

  operation(id: string): QueueOperation | null {
    const row = this.core.db
      .prepare("SELECT data FROM operations WHERE id=?")
      .get(id);
    return row ? this.numberedOperation(String(row.data)) : null;
  }

  /** Stored command payload for an accepted operation; never leaves the server boundary. */
  operationPayload(id: string): unknown {
    const row = this.core.db
      .prepare("SELECT payload FROM operations WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.payload)) : null;
  }

  /** Bounded operation reads; only unfinished work is scanned by default. */
  operations(
    filter: {
      states?: QueueOperation["state"][];
      taskId?: string;
      limit?: number;
    } = {},
  ): QueueOperation[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.states?.length) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      params.push(...filter.states);
    }
    if (filter.taskId) {
      clauses.push("taskId=?");
      params.push(filter.taskId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.core.db
      .prepare(`SELECT data FROM operations${where} ORDER BY rowid LIMIT ?`)
      .all(...params, limit)
      .map((row) => this.numberedOperation(String(row.data)));
  }

  /** Complete task-scoped read for recovery gates; inspection pages cannot prove absence. */
  unfinishedTaskOperations(taskId: string): QueueOperation[] {
    return this.core.db
      .prepare(
        "SELECT data FROM operations WHERE taskId=? AND state IN ('pending','running','needs_attention') ORDER BY rowid",
      )
      .all(taskId)
      .map((row) => this.numberedOperation(String(row.data)));
  }

  /** Exact source lookup must not lose unknown delivery behind the bounded inspection page. */
  unfinishedSourcePromotion(source: {
    kind: "lead" | "papercut";
    id: string;
    repository: string;
    version: number | null;
    digest: string;
  }): QueueOperation | null {
    const row = this.core.db
      .prepare(
        `SELECT data FROM operations WHERE kind='source_promote'
      AND state IN ('pending','running','needs_attention')
      AND json_extract(payload,'$.source.kind')=? AND json_extract(payload,'$.source.id')=?
      AND json_extract(payload,'$.source.repository')=? AND json_extract(payload,'$.source.version') IS ?
      AND json_extract(payload,'$.source.digest')=? ORDER BY rowid LIMIT 1`,
      )
      .get(
        source.kind,
        source.id,
        source.repository,
        source.version,
        source.digest,
      );
    return row ? this.numberedOperation(String(row.data)) : null;
  }

  /** Source promotions whose running delivery was interrupted and needs store-based reconciliation. */
  sourcePromotionsForReconciliation(): QueueOperation[] {
    return this.core.db
      .prepare(
        "SELECT data FROM operations WHERE kind='source_promote' AND state IN ('running','needs_attention') ORDER BY rowid",
      )
      .all()
      .map((row) => this.numberedOperation(String(row.data)));
  }

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
    return this.core.db
      .prepare(
        "SELECT data FROM operations WHERE state != 'failed' AND (json_extract(data,'$.submissionId')=? OR state IN ('pending','running','needs_attention')) ORDER BY rowid",
      )
      .all(submissionId)
      .map((row) => this.numberedOperation(String(row.data)));
  }

  /** Unfinished operation count used for admission and compact UI state. */
  operationBacklog(): number {
    return Number(
      this.core.db
        .prepare(
          "SELECT COUNT(*) AS n FROM operations WHERE state IN ('pending','running')",
        )
        .get()!.n,
    );
  }

  configuredOperationLimit(): number {
    const configured = this.core.getMeta<number>("operationLimit");
    return configured === undefined
      ? DEFAULT_OPERATION_LIMIT
      : Math.min(Math.max(configured, 1), MAX_OPERATION_LIMIT);
  }

  /**
   * Operator ceiling on concurrent calls to each host (Spec 012): default sized to
   * a host's interactive capacity and bounded 1-32. Every host's admission reads
   * it live, so a saved change applies without a restart, and each host still
   * holds its own partition of the bound. The canonical `hostCallLimit` is the only
   * authority once it has been saved; the legacy `paseoCallLimit` mirror is read
   * only before that first save (a store saved by a Paseo-era build).
   */
  configuredHostCallLimit(): number {
    const canonical = this.core.getMeta<number>("hostCallLimit");
    const configured = canonical ?? this.core.getMeta<number>("paseoCallLimit");
    if (
      configured === undefined ||
      configured === null ||
      !Number.isFinite(configured)
    )
      return DEFAULT_HOST_CALL_LIMIT;
    return Math.min(Math.max(Math.trunc(configured), 1), MAX_HOST_CALL_LIMIT);
  }

  putOperation(operation: QueueOperation, payload?: unknown): QueueOperation {
    let next = queueOperationSchema.parse(operation);
    const previous = this.core.db
      .prepare("SELECT taskId,data FROM operations WHERE id=?")
      .get(next.id);
    const previousTaskId = previous?.taskId;
    const previousData = previous
      ? (JSON.parse(String(previous.data)) as {
          hostId?: unknown;
          hostSelection?: QueueOperation["hostSelection"];
        })
      : undefined;
    const previousHost: unknown = previousData?.hostId;
    if (typeof previousHost === "string" && previousHost)
      next = { ...next, hostId: previousHost };
    else if (previous && next.hostId)
      throw new Error(
        "Operation host cannot be assigned by an ordinary update",
      );
    if (previousData?.hostSelection)
      next = { ...next, hostSelection: previousData.hostSelection };
    else if (previous && next.hostSelection)
      throw new Error(
        "Operation host selection cannot be assigned by an ordinary update",
      );
    const stored = payload === undefined ? null : JSON.stringify(payload);
    this.core.db
      .prepare(
        `INSERT INTO operations(id,key,kind,inputHash,state,taskId,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,taskId=excluded.taskId,data=excluded.data${payload === undefined ? "" : ",payload=excluded.payload"}`,
      )
      .run(
        next.id,
        next.key,
        next.kind,
        next.inputHash,
        next.state,
        next.taskId,
        next.createdAt,
        stored ?? "null",
        JSON.stringify(next),
      );
    this.core.advanceRevision();
    if (previousTaskId) this.access.taskChanged(String(previousTaskId));
    if (next.taskId && next.taskId !== previousTaskId)
      this.access.taskChanged(next.taskId);
    return next;
  }

  /**
   * Idempotent acceptance in one short transaction. Repeating the same key and
   * normalized input reopens a definite failure or returns the same operation;
   * reusing the key with different input fails closed before any remote work.
   * Saturation returns typed backpressure instead of storing an unserviceable operation.
   */
  acceptOperation(
    input: {
      key: string;
      kind: QueueOperation["kind"];
      inputHash: string;
      taskId?: string | null;
      expectedVersion?: number | null;
      repoPath?: string | null;
      submissionId?: string | null;
      hostId?: string;
      hostSelection?: QueueOperation["hostSelection"];
      payload: unknown;
    },
    at = now(),
  ): OperationAcceptance {
    const id = operationIdForKey(input.key);
    return this.core.transaction(() => {
      const row = this.core.db
        .prepare("SELECT data FROM operations WHERE key=?")
        .get(input.key);
      if (row) {
        const existing = this.numberedOperation(String(row.data));
        if (existing.inputHash !== input.inputHash)
          throw new Error("Operation key already used with different input");
        if (
          existing.state !== "failed" ||
          existing.settlement?.kind === "superseded"
        )
          return { accepted: true as const, operation: existing };
        const saturated = this.backpressure();
        if (saturated) return saturated;
        const reopened = this.putOperation({
          ...existing,
          state: "pending",
          startedAt: null,
          settledAt: null,
          diagnostic: "",
          result: null,
          effect: null,
          preSendBoundaryStartedAt: null,
        });
        return { accepted: true as const, operation: reopened };
      }
      const saturated = this.backpressure();
      if (saturated) return saturated;
      const operation = queueOperationSchema.parse({
        id,
        key: input.key,
        kind: input.kind,
        inputHash: input.inputHash,
        state: "pending",
        ...(input.hostId ? { hostId: input.hostId } : {}),
        ...(input.hostSelection ? { hostSelection: input.hostSelection } : {}),
        taskId: input.taskId ?? null,
        expectedVersion: input.expectedVersion ?? null,
        repoPath: input.repoPath ?? null,
        submissionId: input.submissionId ?? null,
        createdAt: at,
      });
      this.putOperation(operation, input.payload);
      return { accepted: true as const, operation };
    });
  }

  /** The typed refusal to admit work while the unfinished backlog is at its bound; null when there is room. */
  private backpressure(): OperationAcceptance | null {
    const limit = this.configuredOperationLimit();
    const backlog = this.operationBacklog();
    if (backlog < limit) return null;
    return {
      backpressured: true as const,
      pending: backlog,
      retryAfterMs: OPERATION_BACKPRESSURE_RETRY_MS,
      reason: `Queue operation backlog ${backlog} reached the configured bound of ${limit}; retry after the queue drains`,
    };
  }
}
