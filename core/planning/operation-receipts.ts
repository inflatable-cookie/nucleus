import { isDeepStrictEqual } from "node:util";
import { taskControlInputSchema } from "../../shared/contracts";
import type { OperationEffect, QueueOperation } from "../../shared/operations";
import { digest, now, operationIdForKey, operationInputHash, provedPreSendHistory } from "../store/store";
import { ParkedRestartPreSendRefusal } from "../verbs/restart";
import { typedPreSendRefusal } from "./operation-failure";
import { isHostConnectionRefusal } from "../host/errors";

/** The receipt one refused operation records to prove it crossed no send boundary. */
export type PreSendReceipt = NonNullable<QueueOperation["preSendReceipt"]>;

/** The store facts a receipt proof reads: the task and its runs, and nothing else. */
export interface ReceiptProofStore {
  task(id: string): unknown;
  runs(taskId: string): readonly { reviewDeliveries?: readonly { operationId?: string }[] }[];
}

export interface ReceiptProofFacts {
  store: ReceiptProofStore;
  /** The build that answered, recorded on the receipt; read only when one is written. */
  buildId: () => string;
  /** The attempt that just failed, as it was put running. */
  running: QueueOperation;
  /** The record as it stands after the failure, re-read by the caller. */
  current: QueueOperation | null;
  payload: unknown;
  /** The effect this attempt was started with; absent for an operation without one. */
  effect: OperationEffect | null;
  error: unknown;
  message: string;
}

/**
 * What one failed attempt proves about its own pre-send state. `typedRefusal`
 * is Queue's own gate answering before anything was bound or sent, whatever the
 * diagnostic says; a receipt is recorded only when the whole proof holds.
 */
export interface ReceiptProof {
  /** `none` means nothing proved that this attempt stayed inside the boundary. */
  kind: "none" | "parked_restart" | "typed_refusal";
  typedRefusal: boolean;
  /** The receipt to record, present exactly when a kind names one. */
  receipt: PreSendReceipt | null;
}

/**
 * The pre-send receipt one refused task control may record, from the facts after
 * its throw (Spec 050 owner verbs; papercut 4b285a6e). A parked restart's own
 * rollback receipt carries the task and run evidence it verified; every other
 * typed refusal is proved from the store as it stands now. An interrupted writer
 * that crossed the boundary without one of those proofs gets no receipt, so it
 * stays fenced as uncertain.
 */
export function preSendReceiptProof(facts: ReceiptProofFacts): ReceiptProof {
  // A host connection refusal proves only that the refusing call sent nothing.
  // Once this attempt crossed its pre-send boundary, an earlier send may have
  // landed, so it is no pre-send proof and the attempt stays uncertain.
  const typedRefusal = typedPreSendRefusal(facts.error)
    && !(isHostConnectionRefusal(facts.error) && Boolean(facts.current?.preSendBoundaryStartedAt));
  const none: ReceiptProof = { kind: "none", typedRefusal, receipt: null };
  const effect = facts.effect;
  if (!effect) return none;
  const target = taskControlTarget(facts.running, facts.payload);
  if (!target || effect.target !== target || !attemptUnchanged(facts)) return none;
  try {
    const base = {
      operationId: facts.running.id, inputHash: facts.running.inputHash,
      taskId: facts.running.taskId!, expectedVersion: facts.running.expectedVersion!,
      attempt: facts.running.attempts, buildId: facts.buildId(),
      diagnostic: facts.message.slice(0, 4000), effect, recordedAt: now(),
    };
    if (facts.current?.preSendBoundaryStartedAt) {
      if (!(facts.error instanceof ParkedRestartPreSendRefusal)) return none;
      // Its evidence hashes must still describe the task and its runs.
      const taskEvidenceHash = digest(JSON.stringify(facts.store.task(facts.running.taskId!)));
      const runEvidenceHash = digest(JSON.stringify(facts.store.runs(facts.running.taskId!)));
      if (taskEvidenceHash !== facts.error.taskEvidenceHash || runEvidenceHash !== facts.error.runEvidenceHash) return none;
      return { kind: "parked_restart", typedRefusal, receipt: { ...base, boundary: "parked-restart-rollback-v1", taskEvidenceHash, runEvidenceHash } };
    }
    if (!typedRefusal) return none;
    return { kind: "typed_refusal", typedRefusal, receipt: { ...base, boundary: "pre-send-refusal-v1",
      taskEvidenceHash: digest(JSON.stringify(facts.store.task(facts.running.taskId!))),
      runEvidenceHash: digest(JSON.stringify(facts.store.runs(facts.running.taskId!))) } };
  } catch {
    // A receipt that cannot be built is no receipt: the refusal still settles
    // definite and the interrupted writer stays fenced.
    return none;
  }
}

/**
 * The control action this payload names for this exact task version, when it
 * names one. A receipt binds a restart or a control to the record it answered.
 */
function taskControlTarget(running: QueueOperation, payload: unknown): string | null {
  if (running.kind !== "task_control" || !running.taskId || !running.expectedVersion) return null;
  const body = payload as { type?: unknown; control?: unknown } | null;
  if (body?.type !== "task_control") return null;
  const control = taskControlInputSchema.safeParse(body.control);
  if (!control.success || control.data.taskId !== running.taskId || control.data.version !== running.expectedVersion) return null;
  return control.data.action;}

/**
 * Every proof both receipts share: the record is still this attempt's, its
 * payload still hashes to the recorded input, the effect is the one intent it
 * was put running with, and no run already carries this operation's delivery.
 */
function attemptUnchanged(facts: ReceiptProofFacts): boolean {
  const current = facts.current, effect = facts.effect;
  if (!current || !effect || effect.kind !== "task_control" || effect.status !== "intent") return false;
  return current.state === "running" && current.attempts === facts.running.attempts
    && current.inputHash === facts.running.inputHash
    && provedPreSendHistory(current, facts.running.attempts - 1)
    && isDeepStrictEqual(current.effect, effect)
    && operationIdForKey(facts.running.key) === facts.running.id
    && operationInputHash(facts.payload) === facts.running.inputHash
    && !facts.store.runs(facts.running.taskId!).some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === facts.running.id));
}
