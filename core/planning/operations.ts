import { PlanningRepairs } from "./planning-repairs";
import { operationFailureSettlement, typedPreSendRefusal } from "./operation-failure";
export { operationFailureSettlement } from "./operation-failure";
export type { OperationFailureSettlement } from "./operation-failure";
import { currentServiceBuildId } from "../../shared/service/build";
import { pidAlive } from '../machine/process-identity';
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Task } from "../../shared/contracts";
import { leadCheckOperationPayloadSchema, reviewEntryInputSchema, sourcePromotionOperationPayloadSchema, submissionRecordFromLegacy, submissionSchema, taskControlInputSchema, type Submission } from "../../shared/contracts";
import { OPERATION_COMPATIBILITY_WAIT_MS, operationIsSettled, type OperationAcceptance, type OperationResult, type QueueOperation } from "../../shared/operations";
import { repositoryRekeyInputSchema, type RepositoryRekeyInput } from "../../shared/repository-rekey";
import { isTransportFailure } from "../../shared/transport";
import type { IdentitySource } from "../../shared/host-kind";
import { validateCompletionRecipients } from "../scheduling/cohort";
import type { Engine } from "../engine";
import { SubmissionUnavailableError, validateSubmission, verifyPublishedPlanning } from "../git/index";
import { isStaleIntegrationBaseRefusal } from "../hooks/hooks";
import { LANE_PRIORITY_OPERATION } from "../scheduling/lane-priorities";
import { repositoryOrigin } from "./lanes";
import type { Adapter } from "../host/adapter";
import { STEPS_RETIRED_REASON } from "../recovery/retired-steps";
import { bindReviewEntry, type ReviewEntryAdapter } from "../review/review-entry";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { stageDeclarationFromBrief } from "../stages";
import { digest, now, operationIdForKey, operationInputHash, provedPreSendHistory } from "../store/store";
import { hostIndependentControlRefusal } from "../host/host-independent-refusals";
import { ParkedRestartPreSendRefusal } from "../verbs/restart";

const activeSourcePromotions = new Set<string>();
const sourceOwnerKey = (id: string) => `sourcePromotionOwner:${id}`;

export const SOURCE_PROMOTION_NOT_DELIVERED = "Source promotion reconciled after restart: no task or source insert was committed";
/** Deterministic rejection vs. uncertain external outcome, for the operation state. */
/** Lane key for an accepted operation: task-scoped commands share the task's exclusive lane. */
function operationLaneKey(payload: unknown, operation: QueueOperation): string {
  const leadCheckId = (payload as { type?: string; id?: string } | null)?.type === "lead_check"
    ? (payload as { id?: string }).id : undefined;
  if (leadCheckId) return `lead:${leadCheckId}`;
  const controlTaskId = (payload as { control?: { taskId?: string } } | null)?.control?.taskId;
  const removeTaskId = (payload as { type?: string; taskId?: string } | null)?.type === "task_remove"
    ? (payload as { taskId?: string }).taskId : undefined;
  // Spec 056: a re-key serializes with another re-key of the same namespace, and
  // its own transaction re-checks every precondition against concurrent writers.
  const rekeySource = (payload as { type?: string; input?: { source?: string } } | null)?.type === "repository_rekey"
    ? (payload as { input?: { source?: string } }).input?.source : undefined;
  if (rekeySource) return `repository-rekey:${rekeySource}`;
  const taskId = operation.taskId ?? controlTaskId ?? removeTaskId ?? null;
  return taskId ? `task:${taskId}` : `operation:${operation.id}`;
}
/** One removal payload shape, shared by refusal and execution. */
const taskRemoveOperationPayloadSchema = z.object({ type: z.literal("task_remove"), taskId: z.string().min(1).max(160), version: z.number().int().positive() }).strict();

/**
 * Durable operations: accept, schedule, run and settle a generic operation,
 * submission intake, and the pre-dispatch repairs (dispatch base re-record,
 * validation retry). Same-name `Engine` methods delegate here.
 */
export class Operations {
  private readonly activeOperations = new Set<string>();
  private sourcePromotionHandler: ((payload: unknown, hostId?: string, selection?: QueueOperation['hostSelection']) => Promise<OperationResult>) | null = null;
  private leadCheckHandler: ((payload: unknown, operationId: string) => Promise<OperationResult>) | null = null;
  private repositoryRekeyHandler: ((input: RepositoryRekeyInput) => OperationResult | Promise<OperationResult>) | null = null;
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get adapter() { return this.engine.adapter; }
  get resolution() { return this.engine.resolution; }
  get hooks() { return this.engine.hooks; }
  setSourcePromotionHandler(handler: (payload: unknown, hostId?: string, selection?: QueueOperation['hostSelection']) => Promise<OperationResult>): void {
    this.sourcePromotionHandler = handler;
  }
  setLeadCheckHandler(handler: (payload: unknown, operationId: string) => Promise<OperationResult>): void {
    this.leadCheckHandler = handler;
  }
  /** Spec 056: the one repository namespace re-key handler, a single store transaction. */
  setRepositoryRekeyHandler(handler: (input: RepositoryRekeyInput) => OperationResult | Promise<OperationResult>): void {
    this.repositoryRekeyHandler = handler;
  }
  /**
   * Accept one durable generic operation and schedule its bounded lane. Local
   * shape validation happens before acceptance (the caller parsed the payload);
   * remote validation runs from the operation so a lost response reconciles by
   * operation identity instead of creating a second effect.
   */
  async startOperation(input: { key: string; kind: QueueOperation["kind"]; payload: unknown; taskId?: string; expectedVersion?: number; repoPath?: string; submissionId?: string; hostId?: string; deferSchedule?: boolean }): Promise<OperationAcceptance> {
    // Normalize task identity from the payload so the durable record and its
    // lane key are the same whether or not the caller repeated the fields.
    const control = (input.payload as { control?: { taskId?: string; version?: number } } | null)?.control;
    const removal = (input.payload as { type?: string; taskId?: string; version?: number } | null)?.type === "task_remove"
      ? (input.payload as { taskId?: string; version?: number }) : undefined;
    const payload = input.payload as { submission?: { submissionId?: string; repoPath?: string }; input?: { submission?: { submissionId?: string; repoPath?: string } } } | null;
    const submission = payload?.submission ?? payload?.input?.submission;
    if (input.taskId !== undefined && control?.taskId !== undefined && input.taskId !== control.taskId) throw new Error("Operation taskId does not match its payload");
    if (input.expectedVersion !== undefined && control?.version !== undefined && input.expectedVersion !== control.version) throw new Error("Operation expectedVersion does not match its payload");
    if (input.taskId !== undefined && removal?.taskId !== undefined && input.taskId !== removal.taskId) throw new Error("Operation taskId does not match its payload");
    if (input.expectedVersion !== undefined && removal?.version !== undefined && input.expectedVersion !== removal.version) throw new Error("Operation expectedVersion does not match its payload");
    if (input.repoPath !== undefined && submission?.repoPath !== undefined && input.repoPath !== submission.repoPath) throw new Error("Operation repoPath does not match its payload");
    if (input.submissionId !== undefined && submission?.submissionId !== undefined && input.submissionId !== submission.submissionId) throw new Error("Operation submissionId does not match its payload");
    const previous = this.store.operationForKey(input.key);
    if (input.hostId && previous && previous.hostId !== input.hostId) throw new Error("Operation host does not match its recorded selection");
    const repoPath = input.repoPath ?? submission?.repoPath ?? undefined;
    const promotion = (input.payload as { source?: { repository?: string } } | null)?.source;
    const repositoryOriginForSelection = promotion?.repository
      ?? (repoPath ? await repositoryOrigin(repoPath).catch(() => null) : null);
    const hostId = previous ? previous.hostId : (input.taskId || control?.taskId || removal?.taskId
      ? this.store.task((input.taskId ?? control?.taskId ?? removal?.taskId)!).hostId || undefined
      : this.engine.selectIngressHost(input.hostId, repoPath, repositoryOriginForSelection));
    const taskId = input.taskId ?? control?.taskId ?? removal?.taskId;
    const hostSelection = previous ? previous.hostSelection : taskId ? this.store.task(taskId).hostSelection
      : hostId ? { hostId, basis: input.hostId ? 'explicit' as const : repoPath || repositoryOriginForSelection ? 'repository_host' as const : 'sole_online_host' as const,
        ...((repoPath || repositoryOriginForSelection) && !input.hostId ? { reason: `Repository hostKind ${this.store.canonicalRepository(repoPath ?? '', repositoryOriginForSelection)?.hostKind ?? 'paseo'}` } : {}) } : undefined;
    if (!previous && !hostId && ["submit", "review_entry", "source_promote"].includes(input.kind))
      throw new Error("Host identity is unknown or ambiguous; select a registered host");
    const acceptance = this.store.acceptOperation({
      key: input.key, kind: input.kind, inputHash: operationInputHash(input.payload),
      hostId, hostSelection,
      taskId: input.taskId ?? control?.taskId ?? removal?.taskId ?? null,
      expectedVersion: input.expectedVersion ?? control?.version ?? removal?.version ?? null,
      repoPath: input.repoPath ?? submission?.repoPath ?? null,
      submissionId: input.submissionId ?? submission?.submissionId ?? null, payload: input.payload,
    });
    if ("accepted" in acceptance && !operationIsSettled(acceptance.operation.state) && !input.deferSchedule) this.engine.scheduleOperation(acceptance.operation.id);
    return acceptance;
  }
  scheduleAcceptedOperation(operationId: string): void { this.engine.scheduleOperation(operationId); }
  /** One acceptance path; legacy handoff operations already performed pushed-state preflight. */
  startSubmission(submission: Submission, requirePushedPlanning = false): Promise<OperationAcceptance> {
    const key = `submit:${submission.submissionId}`;
    const alreadyAccepted = Boolean(this.store.operation(operationIdForKey(key))) || Boolean(this.store.existing(submission));
    if (!alreadyAccepted && submission.responsible === false) throw new Error("responsible: false is no longer supported; every task runs the responsible lifecycle");
    if (!alreadyAccepted && submission.manualVerification === true) throw new Error("manualVerification is no longer available; every task runs the responsible lifecycle");
    if (!alreadyAccepted && (submission.reviewVerdicts !== undefined || submission.reviewPassGate !== undefined)) throw new Error("reviewVerdicts and reviewPassGate are no longer available; state the outcome and acceptance in prose in the brief, and use mergeHold for a needed hold");
    const legacy = { type: "submit" as const, submission };
    const pushed = { ...legacy, requirePushedPlanning: true };
    const prior = this.store.operation(operationIdForKey(key));
    // Either API may reconcile the other, but a retry cannot remove an accepted gate.
    const payload = prior?.inputHash === operationInputHash(pushed) || requirePushedPlanning && prior?.inputHash !== operationInputHash(legacy)
      ? pushed : legacy;
    return this.engine.startOperation({ key, kind: "submit", payload, submissionId: submission.submissionId, repoPath: submission.repoPath, hostId: submission.hostId });
  }
  /** Only read-only submission validation may resume after transient dependency failures. */
  resumeSubmissions(): void {
    for (const operation of this.store.operations({ states: ["pending"] }))
      if (operation.kind === "submit" || operation.kind === "review_entry") this.engine.scheduleOperation(operation.id);
  }
  operationStatus(operationId: string): QueueOperation {
    let operation = this.store.operation(operationId);
    if (!operation) throw new Error("Operation not found");
    if (operation.kind === 'source_promote' && operation.state === 'needs_attention') {
      this.reconcileSourcePromotion(operation);
      operation = this.store.operation(operationId)!;
    }
    return operation;
  }
  /** Bounded compatibility wait used by the legacy synchronous RPCs. */
  async awaitOperation(operationId: string, timeoutMs = OPERATION_COMPATIBILITY_WAIT_MS): Promise<QueueOperation> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const operation = this.store.operation(operationId);
      if (!operation) throw new Error("Operation not found");
      if (operationIsSettled(operation.state)) return operation;
      if (this.engine.stopped || Date.now() >= deadline) return operation;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  }
  /** Restart bootstrap: reconcile exactly the unfinished durable operations, never a new effect. */
  resumeOperations(reconcileInterrupted = true): void {
    if (reconcileInterrupted) {
      for (const operation of this.store.sourcePromotionsForReconciliation()) this.engine.reconcileSourcePromotion(operation);
    } else {
      // A reconnect does not stop handlers already in this process. Their commit
      // remains possible until the owning lane settles, so absence is not proof.
      this.store.transaction(() => {
        for (const operation of this.store.sourcePromotionsForReconciliation()) {
          const current = this.store.operation(operation.id);
          if (current?.state !== 'running' || current.effect?.kind !== 'source_promotion'
            || !['intent', 'uncertain'].includes(current.effect.status)) continue;
          const diagnostic = 'Source promotion is still in flight after host reconnect; its outcome is uncertain';
          this.store.putOperation({ ...current, diagnostic, effect: { ...current.effect, status: 'uncertain', result: diagnostic, resultAt: now() } });
        }
      });
    }
    for (const operation of this.store.operations({ states: ["pending", "running"] })) this.engine.scheduleOperation(operation.id);
  }
  /** A source insert and its lead target commit in one store transaction, so the target is an absence proof. */
  reconcileSourcePromotion(operation: QueueOperation): void {
    if (this.activeOperations.has(operation.id)) {
      this.store.transaction(() => {
        const current = this.store.operation(operation.id);
        if (current?.state !== 'running' || current.effect?.kind !== 'source_promotion') return;
        const diagnostic = 'Source promotion is still in flight; its outcome is uncertain';
        this.store.putOperation({ ...current, diagnostic, effect: { ...current.effect, status: 'uncertain', result: diagnostic, resultAt: now() } });
      });
      return;
    }
    if (operation.kind !== "source_promote" || !operation.effect || operation.effect.kind !== "source_promotion"
      || !["intent", "uncertain"].includes(operation.effect.status)) return;
    try {
      const payload = sourcePromotionOperationPayloadSchema.parse(this.store.operationPayload(operation.id));
      this.store.transaction(() => {
        const current = this.store.operation(operation.id);
        if (!current || current.kind !== "source_promote" || !["running", "needs_attention"].includes(current.state)
          || !current.effect || current.effect.kind !== "source_promotion"
          || current.effect.target !== current.id || !["intent", "uncertain"].includes(current.effect.status)
          || operationIdForKey(current.key) !== current.id || operationInputHash(payload) !== current.inputHash) return;
        const effect = current.effect;
        const result = this.store.sourcePromotionResult(payload.source, payload.source.repository,
          payload.source.version, payload.source.digest);
        if (result) {
          this.store.putOperation({ ...current, state: "succeeded", result, settledAt: now(), diagnostic: "",
            effect: { ...effect, status: "reconciled", result: "Committed task found from source identity", resultAt: now() } });
        } else {
          const owner = this.store.getMeta(sourceOwnerKey(current.id)) as { pid?: unknown } | null;
          const pid = typeof owner?.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
          // A recorded owner that is this process is proved not to be mid-commit
          // once no lane here is running it: the insert only happens inside that
          // operation's own handler, so absence now is absence for good.
          const idleHere = pid === process.pid && !activeSourcePromotions.has(current.id);
          const absent = pid !== null && (!pidAlive(pid) || idleHere);
          if (!absent) {
            const diagnostic = 'Source promotion outcome is uncertain: its executing process may still commit';
            this.store.putOperation({ ...current, state: current.state === 'running' && activeSourcePromotions.has(current.id) ? 'running' : 'needs_attention',
              diagnostic, effect: { ...effect, status: 'uncertain', result: diagnostic, resultAt: now() } });
            return;
          }
          this.store.putOperation({ ...current, state: "failed", result: null, settledAt: now(), diagnostic: SOURCE_PROMOTION_NOT_DELIVERED,
            effect: { ...effect, status: "reconciled", result: SOURCE_PROMOTION_NOT_DELIVERED, resultAt: now() } });
        }
      });
    } catch { /* Ambiguous source history remains in attention for operator resolution. */ }
  }
  scheduleOperation(id: string): void {
    const operation = this.store.operation(id);
    if (!operation || operationIsSettled(operation.state)) return;
    if (this.engine.ownerSettledOperation(operation.taskId, id)) return;
    // A task-scoped command shares the task's exclusive lane so it is FIFO with
    // that task's lifecycle quanta and its nested control runs inline.
    const key = operationLaneKey(this.store.operationPayload(id), operation);
    void this.engine.cleanContext(() => this.engine.scheduleLane(key, LANE_PRIORITY_OPERATION, () => this.engine.runOperation(id))).catch(() => { /* recorded on the operation record */ });
  }
  async runOperation(id: string): Promise<void> {
    if (this.activeOperations.has(id)) return;
    const existing = this.store.operation(id);
    if (existing?.kind === 'source_promote' && existing.state === 'running' && existing.effect?.kind === 'source_promotion') {
      // A running intent may belong to another still-live service. Observe its
      // result or leave it uncertain; scheduling is never permission to resend.
      this.reconcileSourcePromotion(existing);
      return;
    }
    this.activeOperations.add(id);
    const isPromotion = this.store.operation(id)?.kind === 'source_promote';
    if (isPromotion) activeSourcePromotions.add(id);
    try { await this.runOperationOnce(id); }
    finally { this.activeOperations.delete(id); if (isPromotion) activeSourcePromotions.delete(id); }
  }
  private async runOperationOnce(id: string): Promise<void> {
    let pending = this.store.operation(id);
    if (!pending || operationIsSettled(pending.state)) return;
    if (this.engine.gitTransientWaiting(id, true)) return;
    if (this.engine.ownerSettledOperation(pending.taskId, id)) return;
    // A local transition can commit its existing operation result and effect in
    // the same transaction. After interruption, settle that result without
    // repeating the transition or any of its effects.
    if(pending.state==='running' && !pending.preSendBoundaryStartedAt && !pending.preSendReceipt
      && pending.result && pending.effect?.status==='reconciled'){
      this.store.putOperation({...pending,state:'succeeded',settledAt:now(),diagnostic:''});
      return;
    }
    if (pending.preSendReceipt) {
      // A crash after the receipt must never execute the control again.
      const proof = pending.preSendReceipt;
      const matches = proof.operationId === pending.id && proof.inputHash === pending.inputHash && proof.attempt === pending.attempts
        && isDeepStrictEqual(proof.effect, pending.effect);
      this.store.putOperation({ ...pending, state: "needs_attention", settledAt: now(),
        diagnostic: matches ? proof.diagnostic : pending.diagnostic || "Interrupted pre-send receipt conflicts with the operation; inspect its evidence",
        effect: matches ? { ...proof.effect, status: "uncertain", result: proof.diagnostic.slice(0, 2000), resultAt: now() } : pending.effect });
      return;
    }
    if (pending.preSendBoundaryStartedAt) {
      this.store.putOperation({ ...pending, state: "needs_attention", settledAt: now(),
        diagnostic: pending.diagnostic || "The task-control boundary was interrupted without a pre-send receipt; delivery remains uncertain" });
      return;
    }
    if ((pending.kind === "submit" || pending.kind === "review_entry") && !this.engine.submissionReady()) {
      const diagnostic = `${pending.kind === "review_entry" ? "Review entry" : "Submission"} accepted; waiting for Paseo readiness before validation`;
      if (pending.state !== "pending" || pending.diagnostic !== diagnostic)
        this.store.putOperation({ ...pending, state: "pending", settledAt: null, diagnostic });
      return;
    }
    const pendingHost = pending.hostId;
    if (["submit", "review_entry", "source_promote", "task_control", "task_remove"].includes(pending.kind)
      && (!pendingHost || !this.engine.withHost(pendingHost, () => this.engine.hostAvailable(pendingHost)))) {
      // #927: a control that is already invalid refuses on the store facts now,
      // not when the recorded host returns. The wait holds only a control that
      // would otherwise be accepted. Nothing was written for the refusal, so it
      // settles definite with no effect and needs no pre-send receipt.
      const refusal = this.hostIndependentRefusal(pending);
      if (refusal) {
        this.store.putOperation({ ...pending, state: "failed", settledAt: now(), diagnostic: refusal.slice(0, 4000),
          effect: pending.effect ? { ...pending.effect, status: "reconciled", result: refusal.slice(0, 2000), resultAt: now() } : null });
        return;
      }
      const diagnostic = pending.hostId ? `Waiting for host ${pending.hostId}` : "Waiting for a proven host identity";
      if (pending.state !== "pending" || pending.diagnostic !== diagnostic)
        this.store.putOperation({ ...pending, state: "pending", settledAt: null, diagnostic });
      return;
    }
    // A legacy operation with a recorded host may predate selection evidence.
    // Reaching here proves that exact host is online; preserve the intent ID.
    if (pending.hostId && !pending.hostSelection && this.engine.withHost(pending.hostId, () => this.engine.hostAvailable(pending!.hostId!))) {
      const host = pending.hostId;
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE operations SET data=json_set(data,'$.hostSelection',json(?)) WHERE id=? AND json_type(data,'$.hostSelection') IS NULL AND json_extract(data,'$.hostId')=?")
          .run(JSON.stringify({hostId:host,basis:'migrated',reason:'Recorded operation host is online'}), id, host);
      });
      pending = this.store.operation(id)!;
    }
    const payload = this.store.operationPayload(id);
    const effect = pending.effect ?? this.engine.effectIntentFor(pending);
    let running = this.store.transaction(() => {
      if (pending!.kind === 'source_promote') this.store.setMeta(sourceOwnerKey(id), { pid: process.pid });
      return this.store.putOperation({ ...pending!, state: "running", startedAt: pending!.startedAt ?? now(), attempts: pending!.attempts + 1, effect });
    });
    try {
      const result = running.hostId
        ? await this.engine.withHost(running.hostId, () => this.engine.performOperation(running, payload))
        : await this.engine.performOperation(running, payload);
      // Re-read: the handler may have advanced the task, and the settled record
      // must reflect the observed identity rather than the intent's snapshot.
      this.store.deleteMeta(this.engine.transientKey(id));
      const settled = this.store.operation(id) ?? running;
      // A submit creates its task, so the top-level identity is only known here; mirror it
      // so callers need not dig into result.taskId.
      this.store.putOperation({ ...settled, taskId: settled.taskId ?? result.taskId ?? null, state: "succeeded", settledAt: now(), diagnostic: "", result,
        effect: effect ? { ...effect, status: "reconciled", result: result.taskId ?? "", resultAt: now() } : null });
      // A restart's first wake can reach integration while this operation still
      // owns its durable effect. Recheck after settlement, when that fence lifts.
      if (running.kind === "task_control" && result.taskId &&
        (payload as { control?: { action?: string } } | null)?.control?.action === "restart")
        void this.engine.cleanContext(() => this.engine.wakeTask(result.taskId!));
    } catch (error) {
      // A handler may atomically commit its durable operation with its local
      // transition. A later reporting failure cannot undo that committed result.
      const committed=this.store.operation(id);
      const message = error instanceof Error ? error.message : String(error);
      const currentOperation = this.store.operation(id);
      const controlPayload = payload as { type?: unknown; control?: unknown } | null;
      const parsedControl = taskControlInputSchema.safeParse(controlPayload?.control);
      const settledBefore = currentOperation ?? running;
      // A parked restart's refusal is proved by read-only verification or a
      // transaction that rolls back, so its evidence hashes must still describe
      // the task and its runs, and nothing may have been bound or sent.
      const parkedRestartProven = error instanceof ParkedRestartPreSendRefusal && running.kind === "task_control" && running.taskId && running.expectedVersion && effect
          && currentOperation?.state === "running" && currentOperation.attempts === running.attempts && currentOperation.inputHash === running.inputHash
          && provedPreSendHistory(currentOperation, running.attempts - 1)
          && currentOperation.preSendBoundaryStartedAt && isDeepStrictEqual(currentOperation.effect, effect)
          && operationIdForKey(running.key) === running.id && operationInputHash(payload) === running.inputHash
          && controlPayload?.type === "task_control" && parsedControl.success && parsedControl.data.action === "restart"
          && parsedControl.data.taskId === running.taskId && parsedControl.data.version === running.expectedVersion
          && effect.kind === "task_control" && effect.target === "restart" && effect.status === "intent"
          && !this.store.runs(running.taskId).some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === id))
          && digest(JSON.stringify(this.store.task(running.taskId))) === error.taskEvidenceHash
          && digest(JSON.stringify(this.store.runs(running.taskId))) === error.runEvidenceHash;
      // Every other typed pre-send refusal of a task control is the same proof:
      // Queue's own gate answered from store reads before anything was bound or
      // sent (fence and validation refusals; papercut 4b285a6e), so its receipt
      // is reconcilable and an interrupted writer stays fenced. Only an effect
      // whose adapter call may have started is left without one.
      const typedRefusalProven = running.kind === "task_control" && running.taskId && running.expectedVersion && effect
          && typedPreSendRefusal(error)
          && currentOperation?.state === "running" && currentOperation.attempts === running.attempts && currentOperation.inputHash === running.inputHash
          && !currentOperation.preSendBoundaryStartedAt
          && provedPreSendHistory(currentOperation, running.attempts - 1)
          && isDeepStrictEqual(currentOperation.effect, effect)
          && operationIdForKey(running.key) === running.id && operationInputHash(payload) === running.inputHash
          && controlPayload?.type === "task_control" && parsedControl.success
          && parsedControl.data.taskId === running.taskId && parsedControl.data.version === running.expectedVersion
          && effect.kind === "task_control" && effect.target === parsedControl.data.action && effect.status === "intent"
          && !this.store.runs(running.taskId).some(run => run.reviewDeliveries?.some(delivery => delivery.operationId === id));
      const refusedOwnedToolRetry = running.kind === "task_control" && parsedControl.success
        && parsedControl.data.action === "retry_effect" && typeof parsedControl.data.effect === "string"
        && parsedControl.data.effect.startsWith("owned_tool.") && /^Owned-tool hold .+ remains:/.test(message)
        && !currentOperation?.preSendBoundaryStartedAt;
      const settlement = operationFailureSettlement({
        committed: Boolean(committed?.result && committed.effect?.status==='reconciled' && !committed.preSendBoundaryStartedAt && !committed.preSendReceipt),
        submissionDeferrable: pending.kind === "submit" || pending.kind === "review_entry",
        validationUnavailable: isTransportFailure(error) || error instanceof SubmissionUnavailableError,
        parkedRestartProven: Boolean(parkedRestartProven),
        typedRefusalProven: Boolean(typedRefusalProven),
        typedPreSendRefusal: typedPreSendRefusal(error),
        preSendBoundaryStarted: Boolean(currentOperation?.preSendBoundaryStartedAt),
        ownedToolRetryRefused: refusedOwnedToolRetry,
        sourcePromotionAbsent: running.kind === 'source_promote' && effect?.kind === 'source_promotion'
          && currentOperation?.state === 'running' && currentOperation.attempts === running.attempts && currentOperation.inputHash === running.inputHash
          && operationIdForKey(running.key) === running.id && operationInputHash(payload) === running.inputHash
          && this.sourcePromotionUncommitted(payload),
        effectChangedSinceIntent: Boolean(settledBefore.preSendBoundaryStartedAt && !isDeepStrictEqual(settledBefore.effect, effect)),
        hasEffect: Boolean(effect),
        message,
      }, () => this.engine.deferGitTransient(id, error, true));
      if (settlement.kind === "already_committed") {
        this.store.putOperation({...committed!,state:'succeeded',settledAt:now(),diagnostic:''});
        return;
      }
      if (settlement.kind === "defer_git_transient") return;
      if (settlement.kind === "defer_validation") {
        this.store.putOperation({ ...(this.store.operation(id) ?? running), state: "pending", settledAt: null,
          diagnostic: `${pending.kind === "review_entry" ? "Review-entry" : "Submission"} validation deferred: ${message}`.slice(0, 4000) });
        return;
      }
      if (settlement.receipt === "parked_restart" && parkedRestartProven && currentOperation && effect && running.taskId && running.expectedVersion
          && error instanceof ParkedRestartPreSendRefusal) {
        try {
          const receipt = { operationId: running.id, inputHash: running.inputHash, taskId: running.taskId,
            expectedVersion: running.expectedVersion, attempt: running.attempts, boundary: "parked-restart-rollback-v1" as const,
            buildId: this.engine.currentServiceBuildId(), taskEvidenceHash: error.taskEvidenceHash, runEvidenceHash: error.runEvidenceHash,
            diagnostic: message.slice(0, 4000), effect, recordedAt: now() };
          running = this.store.putOperation({ ...currentOperation, preSendReceipt: receipt });
        } catch { /* Without the durable receipt the refusal remains uncertain. */ }
      }
      // The two receipts are mutually exclusive: the parked restart's proof needs
      // a crossed send boundary (`currentOperation.preSendBoundaryStartedAt`) and
      // every other typed refusal's proof needs none, so settlement names at most
      // one of them. A parked receipt that could not be written still settles
      // definite; there is no second receipt to fall back to.
      if (settlement.receipt === "typed_refusal" && typedRefusalProven && currentOperation && effect && running.taskId && running.expectedVersion) {
        try {
          const receipt = { operationId: running.id, inputHash: running.inputHash, taskId: running.taskId,
            expectedVersion: running.expectedVersion, attempt: running.attempts, boundary: "pre-send-refusal-v1" as const,
            buildId: this.engine.currentServiceBuildId(),
            taskEvidenceHash: digest(JSON.stringify(this.store.task(running.taskId))),
            runEvidenceHash: digest(JSON.stringify(this.store.runs(running.taskId))),
            diagnostic: message.slice(0, 4000), effect, recordedAt: now() };
          running = this.store.putOperation({ ...currentOperation, preSendReceipt: receipt });
        } catch { /* Without the durable receipt the refusal still settles definite. */ }
      }
      const settled = this.store.operation(id) ?? running;
      const effectStatus = settlement.effect;
      this.store.putOperation({ ...settled, state: settlement.state, settledAt: now(), diagnostic: message.slice(0, 4000),
        effect: effectStatus === "keep" ? settled.effect
          : effect && (effectStatus === "reconciled" || effectStatus === "uncertain")
            ? { ...effect, status: effectStatus, result: message.slice(0, 2000), resultAt: now() } : null });
    }
  }
  /**
   * A source promotion's insert and its source target commit in one store
   * transaction, so a missing target read back after the handler threw proves
   * the insert never happened. An unreadable or ambiguous history answers
   * `false`: only a clean absence is proof.
   */
  private sourcePromotionUncommitted(payload: unknown): boolean {
    const parsed = sourcePromotionOperationPayloadSchema.safeParse(payload);
    if (!parsed.success) return false;
    const { source } = parsed.data;
    try {
      return this.store.sourcePromotionResult({ kind: source.kind, id: source.id }, source.repository,
        source.version, source.digest) === null;
    } catch { return false; }
  }
  /**
   * #927: the refusals a durable operation owes before it may wait for its
   * offline recorded host, read from the store as it stands. `null` means the
   * operation is valid so far and waits, exactly as #912 recorded it.
   */
  private hostIndependentRefusal(pending: QueueOperation): string | null {
    if (pending.kind === "task_control") {
      const payload = this.store.operationPayload(pending.id) as { control?: unknown; authenticatedForceRunId?: string } | null;
      const parsed = taskControlInputSchema.safeParse(payload?.control);
      if (!parsed.success) return null;
      const forceRunId = payload?.authenticatedForceRunId;
      // A self-force reads the authenticated run scope the perform step enters,
      // so the same scope is entered here and proved against the recorded grant
      // first: an unauthorized force refuses now, not when its host returns.
      if (forceRunId) {
        if (this.store.getMeta(`selfForceGrant:${pending.inputHash}`) !== forceRunId) return 'Missing authenticated force grant';
        return this.engine.selfForceRunId.run(forceRunId, () => hostIndependentControlRefusal(this.engine, parsed.data, pending.id));
      }
      return hostIndependentControlRefusal(this.engine, parsed.data, pending.id);
    }
    if (pending.kind === "task_remove") {
      const removal = taskRemoveOperationPayloadSchema.safeParse(this.store.operationPayload(pending.id));
      return removal.success ? this.engine.removalRefusal(removal.data.taskId, removal.data.version) : null;
    }
    return null;
  }
  ownerSettledOperation(taskId: string | null, id: string): boolean {
    if (!taskId) return false;
    try { return this.store.task(taskId).resolution.ownerSettlements.some(record =>
      record.effect === `operation.${id}` || record.effect === `task_control_operation.${id}`); }
    catch { return false; }
  }
  effectIntentFor(operation: QueueOperation): QueueOperation["effect"] {
    if (operation.kind === "source_promote") {
      sourcePromotionOperationPayloadSchema.parse(this.store.operationPayload(operation.id));
      return { kind: "source_promotion", target: operation.id,
        intentAt: now(), status: "intent", result: null, resultAt: null };
    }
    if (operation.kind !== "task_control" && operation.kind !== "task_remove") return null;
    const payload = this.store.operationPayload(operation.id) as { control?: { action?: string }; taskId?: string } | null;
    if (operation.kind === "task_remove")
      return { kind: "task_remove", target: payload?.taskId ?? operation.taskId ?? "", intentAt: now(), status: "intent", result: null, resultAt: null };
    const control = payload as { control?: { action?: string } } | null;
    return { kind: "task_control", target: control?.control?.action ?? "", intentAt: now(), status: "intent", result: null, resultAt: null };
  }
  rerecordPlanningBase(input: Parameters<PlanningRepairs["rerecordPlanningBase"]>[0]) {
    return new PlanningRepairs(this.engine).rerecordPlanningBase(input);
  }
  retryValidation(input: Parameters<PlanningRepairs["retryValidation"]>[0]) {
    return new PlanningRepairs(this.engine).retryValidation(input);
  }

  async performOperation(operation: QueueOperation, payload: unknown): Promise<OperationResult> {
    const selection = operation.hostSelection ?? (operation.hostId ? { hostId: operation.hostId, basis: 'migrated' as const, reason: 'Inherited from recorded operation host' } : undefined);
    if (operation.kind === "lead_check") {
      if (!this.leadCheckHandler) throw new Error("Lead check handler is unavailable");
      return this.leadCheckHandler(leadCheckOperationPayloadSchema.parse(payload), operation.id);
    }
    if (operation.kind === "source_promote") {
      if (!this.sourcePromotionHandler) throw new Error("Source promotion handler is unavailable");
      return this.sourcePromotionHandler(sourcePromotionOperationPayloadSchema.parse(payload), operation.hostId, selection);
    }
    if (operation.kind === "repository_rekey") {
      if (!this.repositoryRekeyHandler) throw new Error("Repository re-key handler is unavailable");
      const input = repositoryRekeyInputSchema.parse((payload as { input?: unknown } | null)?.input);
      return this.repositoryRekeyHandler(input);
    }
    if (operation.kind === "submit") {
      const parsed = submissionSchema.parse(submissionRecordFromLegacy((payload as { submission?: unknown } | null)?.submission, "submit operation"));
      return this.engine.performSubmit(parsed, Boolean((payload as { requirePushedPlanning?: boolean }).requirePushedPlanning), undefined, operation.hostId, selection);
    }
    if(operation.kind==="review_entry"){
      const input=reviewEntryInputSchema.parse((payload as {input?:unknown}|null)?.input);
      if(!this.adapter.inspectReviewEntry||!this.adapter.originAgent)throw Error('Review entry is unavailable on this adapter');
      const routingConflict=this.engine.independentReviewRoutingRefusal({...input.submission,declaredAuthorModels:input.authorDeclaration.models});
      if(routingConflict)throw new Error(routingConflict);
      const originHostId = await this.engine.identifyOriginHost(input.submission.originAgentId, input.submission.originIdentity);
      if (!originHostId) throw new SubmissionUnavailableError("Review-entry origin host is unknown or ambiguous");
      const target = this.adapter as Adapter & ReviewEntryAdapter;
      const reviewAdapter = originHostId === operation.hostId ? target : new Proxy(target, { get: (adapter, property, receiver) => {
        if (property !== 'inspectReviewEntry') return Reflect.get(adapter, property, receiver);
        return async (reviewInput: import('../../shared/contracts').ReviewEntryInput, taskId?: string) => {
          const proof = await this.engine.withHost(originHostId, async () => {
            const origin = await this.engine.host.originAgent(reviewInput.submission.originAgentId);
            if (!origin || origin.archived || !origin.workspaceId) throw new Error('Review entry requires a live originating thread');
            return { origin, state: await this.engine.host.observe(origin.id) };
          });
          return adapter.inspectReviewEntry(reviewInput, taskId, proof);
        };
      } });
      const task=await bindReviewEntry(this.store,reviewAdapter,{...operation,hostSelection:selection},input,originHostId,async id => {
        const identitySource = id === input.submission.originAgentId ? input.submission.originIdentity : undefined;
        const host = await this.engine.identifyOriginHost(id, identitySource);
        if (!host) throw new SubmissionUnavailableError("Review-entry origin host is unknown or ambiguous");
        return this.engine.withHost(host, () => this.engine.host.originAgent(id));
      });
      return {taskId:task.id,taskVersion:task.version,phase:task.phase,number:task.number,reference:task.reference};
    }
    if (operation.kind === "task_remove") {
      // Removal performs its remote effects (thread observation, workspace
      // archive, Effigy runtime-scope capture and retirement) here, inside the
      // durable operation lane and after its intent persisted, so a slow
      // retirement settles the operation instead of timing out the caller.
      // An already-removed task returns as removed, so replay is idempotent.
      const remove = taskRemoveOperationPayloadSchema.parse(payload);
      const task = await this.engine.removeTask(remove.taskId, remove.version);
      return { taskId: task.id, taskVersion: task.version, phase: task.phase, number: task.number, reference: task.reference };
    }
    const control = taskControlInputSchema.parse((payload as { control?: unknown } | null)?.control);
    const forceRunId = (payload as {authenticatedForceRunId?: string}).authenticatedForceRunId;
    if (forceRunId && this.store.getMeta(`selfForceGrant:${operation.inputHash}`) !== forceRunId) throw new DurableFenceRefusal('Missing authenticated force grant');
    const task = forceRunId ? await this.engine.selfForceRunId.run(forceRunId, () => this.engine.performTaskControl(control, operation.id))
      : await this.engine.performTaskControl(control, operation.id);
    return { taskId: task.id, taskVersion: task.version, phase: task.phase, number: task.number, reference: task.reference };
  }
  async submitPlanningSource(submission: Submission, source: { kind:"lead"|"papercut"; id:string; repository:string; digest:string; expectedSource:string }, initial: Partial<Task> = {}, hostId?: string, identitySource?: IdentitySource): Promise<OperationResult> {
    return this.engine.performSubmit(submission, false, { source, initial, ...(identitySource ? { identitySource } : {}) }, hostId);
  }
  async performSubmit(submission: Submission, requirePushedPlanning = false, promotion?: {source:{kind:"lead"|"papercut";id:string;repository:string;digest:string;expectedSource:string}; initial?: Partial<Task>; identitySource?: IdentitySource}, hostId?: string, hostSelection?: QueueOperation['hostSelection']): Promise<OperationResult> {
    const originForSelection = promotion?.source.repository ?? await repositoryOrigin(submission.repoPath).catch(() => null);
    hostId ??= this.engine.selectIngressHost(submission.hostId, submission.repoPath, originForSelection);
    // A replay after a lost response resolves the durable submission identity
    // before any remote validation or insertion.
    const existing = promotion ? null : this.store.existing(submission);
    if (existing) return { taskId: existing.id, taskVersion: existing.version, phase: existing.phase, number: existing.number, reference: existing.reference };
    if (submission.responsible === false) throw new Error("responsible: false is no longer supported; every task runs the responsible lifecycle");
    if (submission.manualVerification === true) throw new Error("manualVerification is no longer available; every task runs the responsible lifecycle");
    if (submission.reviewVerdicts !== undefined || submission.reviewPassGate !== undefined) throw new Error("reviewVerdicts and reviewPassGate are no longer available; state the outcome and acceptance in prose in the brief, and use mergeHold for a needed hold");
    if (submission.brief && stageDeclarationFromBrief(submission.brief.text)) throw new Error(STEPS_RETIRED_REASON);
    const origin = await repositoryOrigin(submission.repoPath);
    if (requirePushedPlanning) await verifyPublishedPlanning(submission);
    const validated = await validateSubmission(submission);
    const raced = promotion ? null : this.store.existing(submission);
    if (raced) return { taskId: raced.id, taskVersion: raced.version, phase: raced.phase, number: raced.number, reference: raced.reference };
    this.store.requireSubmissionLanes(submission, origin);
    const routingConflict = this.engine.independentReviewRoutingRefusal(submission);
    if (routingConflict) throw new Error(routingConflict);
    // Resolving recipients is a live agent lookup, so only a submission that actually
    // notifies needs it. Doing it unconditionally put a daemon round trip - and its 15 s
    // liveness timeout - in front of every accepted handoff, so a flapping transport failed
    // the submission and left no task at all.
    const needsRecipients = Boolean(submission.notifyOriginOnCloseout) || submission.completionNotificationAgentIds.length > 0;
    // The origin identity's own source proved its host; it is evidence about that
    // identity only, so an offline host that has no part in it cannot turn a
    // decidable origin into an ambiguous one.
    const originIdentity = promotion?.identitySource ?? submission.originIdentity;
    const originHostId = await this.engine.identifyOriginHost(submission.originAgentId, originIdentity);
    if (needsRecipients && !originHostId) throw new SubmissionUnavailableError("Origin host is unknown or ambiguous");
    const resolved = needsRecipients ? await validateCompletionRecipients(submission, async id => {
      const identitySource = id === submission.originAgentId ? originIdentity : undefined;
      const host = await this.engine.identifyOriginHost(id, identitySource);
      if (!host) throw new SubmissionUnavailableError("Completion recipient host is unknown or ambiguous");
      return this.engine.withHost(host, () => this.engine.host.originAgent(id));
    }) : null;
    // A parsed refusal is a ruling and stops the submission. An operational failure - the
    // transport, a stale integration base - is not: the task is created queued and the same
    // hook runs again at dispatch.
    try {
      await this.hooks.previewPreDispatch(submission, validated.handoffText, validated.planningBase);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!isTransportFailure(error) && !isStaleIntegrationBaseRefusal(message)) throw error;
    }
    const initial = {
      ...(resolved ? { creatorCompletionRecipients: resolved.recipients } : {}),
      ...(promotion ? promotion.initial ?? {} : {}),
      ...(hostSelection ? { hostSelection } : {}),
      originHostId,
    };
    const inserted = promotion
      ? this.store.promoteSource({kind:promotion.source.kind,id:promotion.source.id},promotion.source.repository,promotion.source.digest,promotion.source.expectedSource,submission,hostId ?? "",validated.planningBase,origin,initial)
      : this.store.insert(submission, hostId ?? "", validated.handoffText, validated.planningBase, initial, undefined, origin);
    if ("taskId" in inserted) return inserted;
    const task = this.store.update(inserted.id, { originWorkspaceId: resolved?.origin?.workspaceId ?? null });
    void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(task.repoPath));
    return { taskId: task.id, taskVersion: task.version, phase: task.phase, number: task.number, reference: task.reference };
  }
}
