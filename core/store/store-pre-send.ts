import { taskControlInputSchema } from "../../shared/contracts";
import { type QueueOperation } from "../../shared/operations";
import { type Run, type Task } from "../../shared/contracts";
import { digest, now, operationIdForKey, operationInputHash, StoreCore } from "./store-core";

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

/** The operation's stored ID is the one its caller key derives. */
export const operationIdMatchesKey = (operation: Pick<QueueOperation, "id" | "key">) => operation.id === operationIdForKey(operation.key);

/** The stored payload is the exact request the operation's input hash names. */
export const payloadMatchesInputHash = (payload: unknown, inputHash: string) => operationInputHash(payload) === inputHash;

/** A reviewer delivery bound to this operation proves the control reached a run, so no pre-send settlement may apply. */
const hasReviewerDelivery = (runs: Run[], operationId: string) =>
  runs.some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === operationId));

/**
 * The pre-send receipt settlement for one task-control operation: it relabels only
 * an execution-authored no-send refusal as failed, and never re-runs the control.
 */
interface PreSendAccess {
  operation(id: string): QueueOperation | null;
  operationPayload(id: string): unknown;
  putOperation(operation: QueueOperation): QueueOperation;
  runs(taskId?: string): Run[];
  task(id: string): Task;
}

export class StorePreSend {
  constructor(private readonly core: StoreCore, private readonly access: PreSendAccess) {}

  /** Settle only an execution-authored no-send receipt; never re-run the control. */
  reconcileTaskControlPreSend(id: string, inputHash: string): QueueOperation {
    return this.core.transaction(() => {
      const operation = this.access.operation(id);
      if (!operation || operation.kind !== "task_control") throw new Error("Task-control operation not found");
      const proof = operation.preSendReceipt;
      if (!proof) return this.reconcileLegacyPreSendRefusal(operation, inputHash);
      if (operation.state === "failed") {
        if (inputHash !== operation.inputHash || proof.operationId !== id || proof.inputHash !== inputHash)
          throw new Error("Input or receipt identity does not match the already-failed operation");
        return operation;
      }
      const payload = this.access.operationPayload(id) as { type?: unknown; control?: unknown } | null;
      const parsed = taskControlInputSchema.safeParse(payload?.control);
      const effect = operation.effect;
      if (operation.state !== "needs_attention" || operation.result || !parsed.success || payload?.type !== "task_control"
        || !operationIdMatchesKey(operation) || operation.inputHash !== inputHash || !payloadMatchesInputHash(payload, inputHash)
        || proof.operationId !== id || proof.inputHash !== inputHash || proof.taskId !== operation.taskId
        || proof.expectedVersion !== operation.expectedVersion || parsed.data.taskId !== operation.taskId
        || parsed.data.version !== operation.expectedVersion || parsed.data.action !== "restart"
        || proof.attempt !== operation.attempts || !provedPreSendHistory(operation, operation.attempts - 1)
        || !effect || effect.kind !== "task_control" || effect.target !== parsed.data.action || effect.status !== "uncertain"
        || proof.effect.kind !== effect.kind || proof.effect.target !== effect.target || proof.effect.intentAt !== effect.intentAt
        || proof.effect.status !== "intent" || operation.diagnostic !== proof.diagnostic || effect.result !== proof.diagnostic.slice(0, 2000))
        throw new Error("Operation, request, attempt or effect evidence conflicts; delivery remains uncertain");
      if (hasReviewerDelivery(this.access.runs(operation.taskId!), id))
        throw new Error("A reviewer delivery is bound to this operation; delivery remains uncertain");
      if (digest(JSON.stringify(this.access.task(operation.taskId!))) !== proof.taskEvidenceHash
        || digest(JSON.stringify(this.access.runs(operation.taskId!))) !== proof.runEvidenceHash)
        throw new Error("Task or run evidence changed since the refusal; delivery remains uncertain");
      return this.access.putOperation({ ...operation, state: "failed", preSendReconciledAt: now() });
    });
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
    const payload = this.access.operationPayload(operation.id) as { type?: unknown; control?: unknown } | null;
    const parsed = taskControlInputSchema.safeParse(payload?.control);
    const effect = operation.effect;
    // An already-relabelled refusal is history; repeating the reconcile is idempotent.
    if (operation.state === "failed" && !operation.result && !operation.preSendReceipt && !operation.preSendBoundaryStartedAt
      && operation.inputHash === inputHash && payloadMatchesInputHash(payload, inputHash))
      return operation;
    if (operation.state !== "needs_attention" || operation.result || operation.attempts !== 1
      || operation.preSendBoundaryStartedAt || payload?.type !== "task_control" || !parsed.success
      || !operationIdMatchesKey(operation) || operation.inputHash !== inputHash || !payloadMatchesInputHash(payload, inputHash)
      || parsed.data.taskId !== operation.taskId || parsed.data.version !== operation.expectedVersion
      || !effect || effect.kind !== "task_control" || effect.target !== parsed.data.action || effect.status !== "uncertain"
      || effect.result !== operation.diagnostic.slice(0, 2000)
      || hasReviewerDelivery(this.access.runs(operation.taskId!), operation.id))
      throw new Error("Operation, request, attempt or effect evidence conflicts; delivery remains uncertain");
    // The fence messages are authored in `runFenceRefusal` and `VerbFences`'s
    // `verbRunFenceRefusal`; a fenced run of this task must still be named by
    // the exact text, so the diagnostic cannot be any other failure's prose.
    const fence = /^A ([a-z]+) run \(([^)]+)\) (?:holds a durable side effect Queue will not act over blindly \(.+\); (?:restart re-creates it under the same run, or wait for reconciliation to settle it|wait for that delivery or effect to settle, or retry_effect it)|still owns this task: .+)$/.exec(operation.diagnostic);
    const named = fence && this.access.runs(operation.taskId!).find(run => run.id === fence[2] && run.role === fence[1]);
    if (!fence || !named)
      throw new Error("The diagnostic is not one of Queue's own pre-send refusal messages; delivery remains uncertain");
    return this.access.putOperation({ ...operation, state: "failed", preSendReconciledAt: now() });
  }
}

/** Exposed for the acceptance path, which checks the same identity and reviewer-delivery facts before a retry. */
export { hasReviewerDelivery };
