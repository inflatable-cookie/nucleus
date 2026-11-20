import { taskControlInputSchema } from "../../shared/contracts";
import { type QueueOperation } from "../../shared/operations";
import { type Run, type Task } from "../../shared/contracts";
import {
  digest,
  now,
  operationIdForKey,
  operationInputHash,
  StoreCore,
} from "./store-core";

/** Every earlier attempt must retain its own definite execution receipt. */
export function provedPreSendHistory(
  operation: QueueOperation,
  count: number,
): boolean {
  const history = operation.preSendHistory ?? [];
  return (
    history.length === count &&
    history.every((entry, index) => {
      const receipt = entry.receipt,
        effect = entry.effect;
      return (
        receipt.operationId === operation.id &&
        receipt.inputHash === operation.inputHash &&
        receipt.taskId === operation.taskId &&
        receipt.expectedVersion === operation.expectedVersion &&
        receipt.attempt === index + 1 &&
        receipt.effect.status === "intent" &&
        entry.diagnostic === receipt.diagnostic &&
        effect !== null &&
        effect.kind === receipt.effect.kind &&
        effect.target === receipt.effect.target &&
        effect.intentAt === receipt.effect.intentAt &&
        effect.result === receipt.diagnostic.slice(0, 2000) &&
        (effect.status === "reconciled" ||
          (effect.status === "uncertain" && entry.reconciledAt !== null))
      );
    })
  );
}

/** The operation's stored ID is the one its caller key derives. */
export const operationIdMatchesKey = (
  operation: Pick<QueueOperation, "id" | "key">,
) => operation.id === operationIdForKey(operation.key);

/** The stored payload is the exact request the operation's input hash names. */
export const payloadMatchesInputHash = (payload: unknown, inputHash: string) =>
  operationInputHash(payload) === inputHash;

/** A reviewer delivery bound to this operation proves the control reached a run, so no pre-send settlement may apply. */
const hasReviewerDelivery = (runs: Run[], operationId: string) =>
  runs.some((run) =>
    run.reviewDeliveries?.some(
      (delivery) => delivery.operationId === operationId,
    ),
  );

/** Replay identity for the operation attempt the sweep refused. */
export const preSendSettlementIdentity = (operation: QueueOperation): string =>
  JSON.stringify([
    operation.id,
    operation.inputHash,
    operation.attempts,
    operation.effect?.intentAt,
  ]);

/** One row of the task's own journal, as the no-write proof reads it. */
export interface JournalEvent {
  id: number;
  at: string;
  kind: string;
  detail: string;
}

/**
 * Nucleus#1428: the no-write proof for an uncertain move to merge. Every store
 * write and every stop intent a move makes is journaled, so an attempt whose
 * own window (`startedAt` to `settledAt`) holds no task event provably wrote and
 * sent nothing, and an observation timeout inside it changes nothing. A later
 * owner move at the same head is corroboration only, never the proof: it can
 * neither establish absence nor replace the window. Returns the evidence line,
 * or null when any shape, boundary or journal fact is missing.
 */
export function unwrittenMergeMoveProof(
  operation: QueueOperation,
  payload: unknown,
  events: readonly JournalEvent[],
): string | null {
  if (
    operation.kind !== "task_control" ||
    operation.state !== "needs_attention" ||
    operation.result ||
    operation.preSendReceipt ||
    operation.preSendBoundaryStartedAt ||
    operation.attempts !== 1 ||
    !operation.taskId ||
    !operation.startedAt ||
    !operation.settledAt ||
    !operationIdMatchesKey(operation) ||
    !payloadMatchesInputHash(payload, operation.inputHash)
  )
    return null;
  const body = payload as { type?: unknown; control?: unknown } | null;
  const parsed = taskControlInputSchema.safeParse(body?.control);
  const effect = operation.effect;
  if (
    body?.type !== "task_control" ||
    !parsed.success ||
    parsed.data.action !== "move" ||
    parsed.data.to !== "merge" ||
    parsed.data.taskId !== operation.taskId ||
    parsed.data.version !== operation.expectedVersion ||
    !effect ||
    effect.kind !== "task_control" ||
    effect.target !== "move" ||
    effect.status !== "uncertain" ||
    effect.result !== operation.diagnostic.slice(0, 2000)
  )
    return null;
  const started = Date.parse(operation.startedAt);
  const settled = Date.parse(operation.settledAt);
  if (!Number.isFinite(started) || !Number.isFinite(settled) || settled < started)
    return null;
  const journaled = events.some((event) => {
    const at = Date.parse(event.at);
    return at >= started && at <= settled;
  });
  if (journaled) return null;
  return `no task event was recorded between ${operation.startedAt} and ${operation.settledAt}, so the observation failed before any write or stop`;
}

/** The first move-to-merge the owner recorded after an attempt settled: corroboration only. */
function laterMergeMove(
  events: readonly JournalEvent[],
  settledAt: string | null,
): { eventId: number; at: string } | null {
  const after = settledAt ? Date.parse(settledAt) : Number.NaN;
  if (!Number.isFinite(after)) return null;
  for (const event of events) {
    if (
      Date.parse(event.at) <= after ||
      (event.kind !== "move_merge_requested" && event.kind !== "owner_control")
    )
      continue;
    try {
      const value = JSON.parse(event.detail) as { verb?: unknown; to?: unknown };
      if (value.verb === "move" && value.to === "merge")
        return { eventId: event.id, at: event.at };
    } catch {
      /* a non-JSON detail is not a move record */
    }
  }
  return null;
}

interface PreSendAccess {
  operation(id: string): QueueOperation | null;
  operationPayload(id: string): unknown;
  putOperation(operation: QueueOperation): QueueOperation;
  runs(taskId?: string): Run[];
  task(id: string): Task;
  eventsAll(taskId: string): JournalEvent[];
  event(taskId: string, kind: string, detail: string): void;
}

export class StorePreSend {
  constructor(
    private readonly core: StoreCore,
    private readonly access: PreSendAccess,
  ) {}

  /** Settle only an execution-authored no-send receipt; never re-run the control. */
  reconcileTaskControlPreSend(id: string, inputHash: string): QueueOperation {
    return this.core.transaction(() => {
      const operation = this.access.operation(id);
      if (!operation || operation.kind !== "task_control")
        throw new Error("Task-control operation not found");
      const proof = operation.preSendReceipt;
      if (!proof)
        return this.reconcileLegacyPreSendRefusal(operation, inputHash);
      if (operation.state === "failed") {
        if (
          inputHash !== operation.inputHash ||
          proof.operationId !== id ||
          proof.inputHash !== inputHash
        )
          throw new Error(
            "Input or receipt identity does not match the already-failed operation",
          );
        return operation;
      }
      const refusal = this.receiptRefusal(operation, inputHash);
      if (refusal) throw Error(refusal);
      return this.settleReceipt(operation);
    });
  }

  /** Consume a receipt under the task lane, without reopening the original request. */
  settleTaskControlPreSend(id: string, taskId: string): QueueOperation | null {
    if (!this.core.db.isTransaction)
      return this.core.transaction(() =>
        this.settleTaskControlPreSend(id, taskId),
      );
    const operation = this.access.operation(id);
    if (
      operation?.kind !== "task_control" ||
      operation.state !== "needs_attention" ||
      operation.taskId !== taskId ||
      !operation.preSendReceipt ||
      this.receiptRefusal(operation, operation.inputHash)
    )
      return null;
    const settled = this.settleReceipt(operation);
    this.core.event(
      taskId,
      "operation_pre_send_refused",
      preSendSettlementIdentity(operation),
    );
    return settled;
  }

  /** The no-write evidence for an uncertain move to merge, or null (nucleus#1428). */
  unwrittenMergeMoveProof(id: string): string | null {
    const operation = this.access.operation(id);
    if (!operation?.taskId) return null;
    return unwrittenMergeMoveProof(
      operation,
      this.access.operationPayload(id),
      this.access.eventsAll(operation.taskId),
    );
  }

  /**
   * Settle a proven no-write move to merge as failed, keeping its evidence and
   * the owner's later move as corroboration. The control is never re-run; a
   * changed identity or missing proof refuses and changes nothing.
   */
  reconcileUnwrittenMergeMove(id: string, inputHash: string): QueueOperation {
    return this.core.transaction(() => {
      const operation = this.access.operation(id);
      if (!operation || operation.kind !== "task_control" || operation.inputHash !== inputHash || !operation.taskId)
        throw new Error("Task-control operation not found or its input changed");
      const proof = this.unwrittenMergeMoveProof(id);
      if (!proof)
        throw new Error("Operation evidence does not prove that no write was sent; delivery remains uncertain");
      const at = now();
      const later = laterMergeMove(this.access.eventsAll(operation.taskId), operation.settledAt);
      const settled = this.access.putOperation({
        ...operation,
        state: "failed",
        preSendReconciledAt: at,
        effect: operation.effect
          ? { ...operation.effect, status: "reconciled", result: proof.slice(0, 2000), resultAt: at }
          : null,
      });
      this.access.event(
        operation.taskId,
        "operation_pre_send_reconciled",
        JSON.stringify({ operationId: id, inputHash, proof, laterMove: later }).slice(0, 4000),
      );
      return settled;
    });
  }

  private settleReceipt(operation: QueueOperation): QueueOperation {
    return this.access.putOperation({
      ...operation,
      state: "failed",
      preSendReconciledAt: now(),
    });
  }

  private receiptRefusal(
    operation: QueueOperation,
    inputHash: string,
  ): string | null {
    const { id, preSendReceipt: proof } = operation;
    if (!proof) return "No execution receipt; delivery remains uncertain";
    const payload = this.access.operationPayload(id) as {
      type?: unknown;
      control?: unknown;
    } | null;
    const parsed = taskControlInputSchema.safeParse(payload?.control);
    const effect = operation.effect;
    if (
      operation.state !== "needs_attention" ||
      operation.result ||
      !parsed.success ||
      payload?.type !== "task_control" ||
      !operationIdMatchesKey(operation) ||
      operation.inputHash !== inputHash ||
      !payloadMatchesInputHash(payload, inputHash) ||
      proof.operationId !== id ||
      proof.inputHash !== inputHash ||
      proof.taskId !== operation.taskId ||
      proof.expectedVersion !== operation.expectedVersion ||
      parsed.data.taskId !== operation.taskId ||
      parsed.data.version !== operation.expectedVersion ||
      (proof.boundary === "parked-restart-rollback-v1"
        ? parsed.data.action !== "restart" ||
          !operation.preSendBoundaryStartedAt
        : Boolean(operation.preSendBoundaryStartedAt)) ||
      proof.attempt !== operation.attempts ||
      !provedPreSendHistory(operation, operation.attempts - 1) ||
      !effect ||
      effect.kind !== "task_control" ||
      effect.target !== parsed.data.action ||
      effect.status !== "uncertain" ||
      proof.effect.kind !== effect.kind ||
      proof.effect.target !== effect.target ||
      proof.effect.intentAt !== effect.intentAt ||
      proof.effect.status !== "intent" ||
      operation.diagnostic !== proof.diagnostic ||
      effect.result !== proof.diagnostic.slice(0, 2000)
    )
      return "Operation, request, attempt or effect evidence conflicts; delivery remains uncertain";
    if (hasReviewerDelivery(this.access.runs(operation.taskId!), id))
      return "A reviewer delivery is bound to this operation; delivery remains uncertain";
    const task = this.access.task(operation.taskId!);
    if (
      (operation.hostId && operation.hostId !== task.hostId) ||
      digest(JSON.stringify(task)) !== proof.taskEvidenceHash ||
      digest(JSON.stringify(this.access.runs(operation.taskId!))) !==
        proof.runEvidenceHash
    )
      return "Task or run evidence changed since the refusal; delivery remains uncertain";
    return null;
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
  private reconcileLegacyPreSendRefusal(
    operation: QueueOperation,
    inputHash: string,
  ): QueueOperation {
    const payload = this.access.operationPayload(operation.id) as {
      type?: unknown;
      control?: unknown;
    } | null;
    const parsed = taskControlInputSchema.safeParse(payload?.control);
    const effect = operation.effect;
    // An already-relabelled refusal is history; repeating the reconcile is idempotent.
    if (
      operation.state === "failed" &&
      !operation.result &&
      !operation.preSendReceipt &&
      !operation.preSendBoundaryStartedAt &&
      operation.inputHash === inputHash &&
      payloadMatchesInputHash(payload, inputHash)
    )
      return operation;
    if (
      operation.state !== "needs_attention" ||
      operation.result ||
      operation.attempts !== 1 ||
      operation.preSendBoundaryStartedAt ||
      payload?.type !== "task_control" ||
      !parsed.success ||
      !operationIdMatchesKey(operation) ||
      operation.inputHash !== inputHash ||
      !payloadMatchesInputHash(payload, inputHash) ||
      parsed.data.taskId !== operation.taskId ||
      parsed.data.version !== operation.expectedVersion ||
      !effect ||
      effect.kind !== "task_control" ||
      effect.target !== parsed.data.action ||
      effect.status !== "uncertain" ||
      effect.result !== operation.diagnostic.slice(0, 2000) ||
      hasReviewerDelivery(this.access.runs(operation.taskId!), operation.id)
    )
      throw new Error(
        "Operation, request, attempt or effect evidence conflicts; delivery remains uncertain",
      );
    // The fence messages are authored in `runFenceRefusal` and `VerbFences`'s
    // `verbRunFenceRefusal`; a fenced run of this task must still be named by
    // the exact text, so the diagnostic cannot be any other failure's prose.
    const fence =
      /^A ([a-z]+) run \(([^)]+)\) (?:holds a durable side effect Queue will not act over blindly \(.+\); (?:restart re-creates it under the same run, or wait for reconciliation to settle it|wait for that delivery or effect to settle, or retry_effect it)|still owns this task: .+)$/.exec(
        operation.diagnostic,
      );
    const named =
      fence &&
      this.access
        .runs(operation.taskId!)
        .find((run) => run.id === fence[2] && run.role === fence[1]);
    if (!fence || !named)
      throw new Error(
        "The diagnostic is not one of Queue's own pre-send refusal messages; delivery remains uncertain",
      );
    return this.access.putOperation({
      ...operation,
      state: "failed",
      preSendReconciledAt: now(),
    });
  }
}

/** Exposed for the acceptance path, which checks the same identity and reviewer-delivery facts before a retry. */
export { hasReviewerDelivery };
