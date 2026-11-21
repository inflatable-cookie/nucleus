import {
  activeSourcePromotions,
  sourceOwnerKey,
  reconcileSourcePromotion,
} from "./source-promotion-reconcile";
export { SOURCE_PROMOTION_NOT_DELIVERED } from "./source-promotion-reconcile";
import { isTransportFailure } from "../../shared/transport";
import { HostReadRefusalError } from "../host";
import { assertSupportedSubmission, PlanningSubmission } from "./submission";
import { PlanningRepairs } from "./planning-repairs";
import { operationFailureSettlement } from "./operation-failure";
import { preSendReceiptProof } from "./operation-receipts";
export { operationFailureSettlement } from "./operation-failure";
export type { OperationFailureSettlement } from "./operation-failure";
import { currentServiceBuildId } from "../../shared/service/build";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Task } from "../../shared/contracts";
import {
  leadCheckOperationPayloadSchema,
  reviewEntryInputSchema,
  sourcePromotionOperationPayloadSchema,
  submissionRecordFromLegacy,
  submissionSchema,
  taskControlInputSchema,
  type Submission,
} from "../../shared/contracts";
import {
  OPERATION_COMPATIBILITY_WAIT_MS,
  operationIsSettled,
  type OperationAcceptance,
  type OperationResult,
  type QueueOperation,
} from "../../shared/operations";
import {
  repositoryRekeyInputSchema,
  type RepositoryRekeyInput,
} from "../../shared/repository-rekey";
import { hostKindOf, type IdentitySource } from "../../shared/host-kind";
import { ProtocolError } from "../../shared/service/protocol";
import { assertBbSubmissionIngressAvailable } from "./submission-routing";
import type { Engine } from "../engine";
import { SubmissionUnavailableError } from "../git/index";
import { LANE_PRIORITY_OPERATION } from "../scheduling/lane-priorities";
import { repositoryOrigin } from "./lanes";
import type { Adapter } from "../host/adapter";
import {
  bindReviewEntry,
  unavailableReviewEntry,
  type ReviewEntryAdapter,
} from "../review/review-entry";
import {
  originReviewProof,
  withOriginReviewAdapter,
} from "../review/origin-review-adapter";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { now, operationIdForKey, operationInputHash } from "../store/store";
import { hostIndependentControlRefusal } from "../host/host-independent-refusals";

/** One removal payload shape, shared by refusal and execution. */
const taskRemoveOperationPayloadSchema = z
  .object({
    type: z.literal("task_remove"),
    taskId: z.string().min(1).max(160),
    version: z.number().int().positive(),
  })
  .strict();
/** One re-key payload shape, shared by the lane key and the perform step. */
const repositoryRekeyOperationPayloadSchema = z
  .object({
    type: z.literal("repository_rekey"),
    input: repositoryRekeyInputSchema,
  })
  .strict();

/**
 * Lane key for an accepted operation: task-scoped commands share the task's
 * exclusive lane. Each small payload shape is decoded by its own schema, so the
 * key never re-derives a fact from an untyped cast; a submission's payload is
 * never parsed here, only its recorded task identity is read.
 */
function operationLaneKey(payload: unknown, operation: QueueOperation): string {
  const type = (payload as { type?: unknown } | null)?.type;
  if (type === "lead_check") {
    const leadCheck = leadCheckOperationPayloadSchema.safeParse(payload);
    if (leadCheck.success) return `lead:${leadCheck.data.id}`;
  }
  // Spec 056: a re-key serializes with another re-key of the same namespace, and
  // its own transaction re-checks every precondition against concurrent writers.
  if (type === "repository_rekey") {
    const rekey = repositoryRekeyOperationPayloadSchema.safeParse(payload);
    if (rekey.success) return `repository-rekey:${rekey.data.input.source}`;
  }
  const control = taskControlInputSchema.safeParse(
    (payload as { control?: unknown } | null)?.control,
  );
  const removal = taskRemoveOperationPayloadSchema.safeParse(payload);
  const taskId =
    operation.taskId ??
    (control.success ? control.data.taskId : undefined) ??
    (removal.success ? removal.data.taskId : undefined) ??
    null;
  return taskId ? `task:${taskId}` : `operation:${operation.id}`;
}

/**
 * Durable operations: accept, schedule, run and settle a generic operation,
 * submission intake, and the pre-dispatch repairs (dispatch base re-record,
 * validation retry). Same-name `Engine` methods delegate here.
 */
export class Operations {
  private readonly activeOperations = new Set<string>();
  private sourcePromotionHandler:
    | ((
        payload: unknown,
        hostId?: string,
        selection?: QueueOperation["hostSelection"],
      ) => Promise<OperationResult>)
    | null = null;
  private leadCheckHandler:
    | ((payload: unknown, operationId: string) => Promise<OperationResult>)
    | null = null;
  private repositoryRekeyHandler:
    | ((
        input: RepositoryRekeyInput,
      ) => OperationResult | Promise<OperationResult>)
    | null = null;
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }
  get adapter() {
    return this.engine.adapter;
  }
  get resolution() {
    return this.engine.resolution;
  }
  get hooks() {
    return this.engine.hooks;
  }
  setSourcePromotionHandler(
    handler: (
      payload: unknown,
      hostId?: string,
      selection?: QueueOperation["hostSelection"],
    ) => Promise<OperationResult>,
  ): void {
    this.sourcePromotionHandler = handler;
  }
  setLeadCheckHandler(
    handler: (
      payload: unknown,
      operationId: string,
    ) => Promise<OperationResult>,
  ): void {
    this.leadCheckHandler = handler;
  }
  /** Spec 056: the one repository namespace re-key handler, a single store transaction. */
  setRepositoryRekeyHandler(
    handler: (
      input: RepositoryRekeyInput,
    ) => OperationResult | Promise<OperationResult>,
  ): void {
    this.repositoryRekeyHandler = handler;
  }
  /**
   * Accept one durable generic operation and schedule its bounded lane. Local
   * shape validation happens before acceptance (the caller parsed the payload);
   * remote validation runs from the operation so a lost response reconciles by
   * operation identity instead of creating a second effect.
   */
  async startOperation(input: {
    key: string;
    kind: QueueOperation["kind"];
    payload: unknown;
    taskId?: string;
    expectedVersion?: number;
    repoPath?: string;
    submissionId?: string;
    hostId?: string;
    deferSchedule?: boolean;
  }): Promise<OperationAcceptance> {
    // Normalize task identity from the payload so the durable record and its
    // lane key are the same whether or not the caller repeated the fields.
    const control = (
      input.payload as {
        control?: { taskId?: string; version?: number };
      } | null
    )?.control;
    const removal =
      (
        input.payload as {
          type?: string;
          taskId?: string;
          version?: number;
        } | null
      )?.type === "task_remove"
        ? (input.payload as { taskId?: string; version?: number })
        : undefined;
    const payload = input.payload as {
      submission?: { submissionId?: string; repoPath?: string };
      input?: { submission?: { submissionId?: string; repoPath?: string } };
    } | null;
    const submission = payload?.submission ?? payload?.input?.submission;
    if (
      input.taskId !== undefined &&
      control?.taskId !== undefined &&
      input.taskId !== control.taskId
    )
      throw new Error("Operation taskId does not match its payload");
    if (
      input.expectedVersion !== undefined &&
      control?.version !== undefined &&
      input.expectedVersion !== control.version
    )
      throw new Error("Operation expectedVersion does not match its payload");
    if (
      input.taskId !== undefined &&
      removal?.taskId !== undefined &&
      input.taskId !== removal.taskId
    )
      throw new Error("Operation taskId does not match its payload");
    if (
      input.expectedVersion !== undefined &&
      removal?.version !== undefined &&
      input.expectedVersion !== removal.version
    )
      throw new Error("Operation expectedVersion does not match its payload");
    if (
      input.repoPath !== undefined &&
      submission?.repoPath !== undefined &&
      input.repoPath !== submission.repoPath
    )
      throw new Error("Operation repoPath does not match its payload");
    if (
      input.submissionId !== undefined &&
      submission?.submissionId !== undefined &&
      input.submissionId !== submission.submissionId
    )
      throw new Error("Operation submissionId does not match its payload");
    const previous = this.store.operationForKey(input.key);
    const repoPath = input.repoPath ?? submission?.repoPath ?? undefined;
    const promotion = (
      input.payload as { source?: { repository?: string } } | null
    )?.source;
    const repositoryOriginForSelection =
      promotion?.repository ??
      (repoPath ? await repositoryOrigin(repoPath).catch(() => null) : null);
    const taskId = input.taskId ?? control?.taskId ?? removal?.taskId;
    const promotionIdentityHostId = (
      input.payload as {
        request?: { identitySource?: { hostId?: string } };
      } | null
    )?.request?.identitySource?.hostId;
    const plannerHostId =
      (submission as { originIdentity?: { hostId?: string } } | undefined)
        ?.originIdentity?.hostId ??
      (input.payload as { identitySource?: { hostId?: string } } | null)
        ?.identitySource?.hostId ??
      promotionIdentityHostId;
    const submissionKind = [
      "submit",
      "review_entry",
      "source_promote",
    ].includes(input.kind);
    // A BB submission's caller host is ingress identity; the accepted operation
    // records the separately selected work host. Permit that mismatch only when
    // the retry carries the exact same payload and BB caller identity.
    const sameBbIngressReplay = Boolean(
      previous &&
        submissionKind &&
        input.hostId &&
        input.hostId === plannerHostId &&
        hostKindOf(input.hostId) === "bb" &&
        previous.kind === input.kind &&
        previous.inputHash === operationInputHash(input.payload),
    );
    if (
      input.hostId &&
      previous &&
      previous.hostId !== input.hostId &&
      !sameBbIngressReplay
    )
      throw new Error("Operation host does not match its recorded selection");
    const ingressSelection = previous
      ? undefined
      : taskId
        ? undefined
        : (this.engine.selectIngressSelection(
            input.hostId,
            repoPath,
            repositoryOriginForSelection,
            plannerHostId,
          ) ??
          (() => {
            // Older host ports and focused operation fixtures provide only an ID.
            // Preserve that compatibility while the runtime's full port records provenance.
            const hostId = this.engine.selectIngressHost(
              input.hostId,
              repoPath,
              repositoryOriginForSelection,
              plannerHostId,
            );
            return hostId
              ? {
                  hostId,
                  basis: input.hostId
                    ? ("explicit" as const)
                    : repoPath || repositoryOriginForSelection
                      ? ("repository_host" as const)
                      : ("sole_online_host" as const),
                }
              : undefined;
          })());
    const bbIngressHostId =
      !previous && submissionKind
        ? assertBbSubmissionIngressAvailable(
            this.engine,
            input.hostId,
            plannerHostId,
          )
        : undefined;

    // BB proves the authenticated caller's ingress identity. Persist the
    // repository/default work-host selection on the operation and promoted task,
    // including an explicitly configured BB work host. If no route is configured,
    // do not infer task work from the caller's BB identity: use the existing
    // unambiguous non-BB fallback or require a setting.
    let selected = ingressSelection;
    if (!previous && submissionKind && bbIngressHostId) {
      const explicitWorkHost =
        input.hostId && hostKindOf(input.hostId) !== "bb"
          ? input.hostId
          : undefined;
      let workSelection: typeof ingressSelection = undefined;
      try {
        workSelection = this.engine.selectIngressSelection(
          explicitWorkHost,
          repoPath,
          repositoryOriginForSelection,
        );
      } catch (error) {
        // With no repository/default route the ingress selector intentionally
        // falls back to the caller. Do not infer a BB task-work route from that
        // identity; use the one unambiguous online non-BB host if available.
        const bbWasOnlyRoute =
          ingressSelection?.hostId === bbIngressHostId &&
          (ingressSelection.basis === "planner_host" ||
            ingressSelection.basis === "explicit");
        if (!bbWasOnlyRoute) throw error;
        const workHosts = this.engine
          .hostIds()
          .filter(
            (id) =>
              hostKindOf(id) !== "bb" && this.engine.hostIngressAvailable(id),
          );
        if (workHosts.length === 1)
          workSelection = { hostId: workHosts[0]!, basis: "sole_online_host" };
        else if (workHosts.length > 1)
          throw new ProtocolError(
            "invalid_input",
            "No repository host or operator default selects a unique task work host",
          );
      }
      if (!workSelection) {
        const workHosts = this.engine
          .hostIds()
          .filter(
            (id) =>
              hostKindOf(id) !== "bb" && this.engine.hostIngressAvailable(id),
          );
        if (workHosts.length === 1)
          workSelection = { hostId: workHosts[0]!, basis: "sole_online_host" };
        else if (workHosts.length > 1)
          throw new ProtocolError(
            "invalid_input",
            "No repository host or operator default selects a unique task work host",
          );
      }
      if (!workSelection)
        throw new ProtocolError(
          "invalid_input",
          `BB ingress ${bbIngressHostId} is online, but no repository or operator-default work host is registered`,
        );
      selected = workSelection;
    }
    const hostId = previous
      ? previous.hostId
      : taskId
        ? this.store.task(taskId).hostId || undefined
        : selected?.hostId;
    const hostSelection = previous
      ? previous.hostSelection
      : taskId
        ? this.store.task(taskId).hostSelection
        : selected;
    if (
      !previous &&
      !hostId &&
      ["submit", "review_entry", "source_promote"].includes(input.kind)
    )
      throw new Error(
        "Host identity is unknown or ambiguous; select a registered host",
      );
    if (
      !previous &&
      hostId &&
      hostKindOf(hostId) === "bb" &&
      !this.engine.hostIngressAvailable(hostId) &&
      ["submit", "review_entry", "source_promote"].includes(input.kind)
    )
      throw new ProtocolError(
        "invalid_input",
        `Selected submission host ${hostId} is offline or unavailable for ingress`,
      );
    const acceptance = this.store.acceptOperation({
      key: input.key,
      kind: input.kind,
      inputHash: operationInputHash(input.payload),
      hostId,
      hostSelection,
      taskId: input.taskId ?? control?.taskId ?? removal?.taskId ?? null,
      expectedVersion:
        input.expectedVersion ?? control?.version ?? removal?.version ?? null,
      repoPath: input.repoPath ?? submission?.repoPath ?? null,
      submissionId: input.submissionId ?? submission?.submissionId ?? null,
      payload: input.payload,
    });
    if (
      "accepted" in acceptance &&
      !operationIsSettled(acceptance.operation.state) &&
      !input.deferSchedule
    )
      this.engine.scheduleOperation(acceptance.operation.id);
    return acceptance;
  }
  scheduleAcceptedOperation(operationId: string): void {
    this.engine.scheduleOperation(operationId);
  }
  /** One acceptance path; legacy handoff operations already performed pushed-state preflight. */
  startSubmission(
    submission: Submission,
    requirePushedPlanning = false,
  ): Promise<OperationAcceptance> {
    const key = `submit:${submission.submissionId}`;
    const alreadyAccepted =
      Boolean(this.store.operation(operationIdForKey(key))) ||
      Boolean(this.store.existing(submission));
    if (!alreadyAccepted) assertSupportedSubmission(submission);
    const legacy = { type: "submit" as const, submission };
    const pushed = { ...legacy, requirePushedPlanning: true };
    const prior = this.store.operation(operationIdForKey(key));
    // Either API may reconcile the other, but a retry cannot remove an accepted gate.
    const payload =
      prior?.inputHash === operationInputHash(pushed) ||
      (requirePushedPlanning && prior?.inputHash !== operationInputHash(legacy))
        ? pushed
        : legacy;
    return this.engine.startOperation({
      key,
      kind: "submit",
      payload,
      submissionId: submission.submissionId,
      repoPath: submission.repoPath,
      hostId: submission.hostId,
    });
  }
  /** Only read-only submission validation may resume after transient dependency failures. */
  resumeSubmissions(): void {
    for (const operation of this.store.operations({ states: ["pending"] }))
      if (operation.kind === "submit" || operation.kind === "review_entry")
        this.engine.scheduleOperation(operation.id);
  }
  operationStatus(operationId: string): QueueOperation {
    let operation = this.store.operation(operationId);
    if (!operation) throw new Error("Operation not found");
    if (
      operation.kind === "source_promote" &&
      operation.state === "needs_attention"
    ) {
      this.reconcileSourcePromotion(operation);
      operation = this.store.operation(operationId)!;
    }
    return operation;
  }
  /** Bounded compatibility wait used by the legacy synchronous RPCs. */
  async awaitOperation(
    operationId: string,
    timeoutMs = OPERATION_COMPATIBILITY_WAIT_MS,
  ): Promise<QueueOperation> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const operation = this.store.operation(operationId);
      if (!operation) throw new Error("Operation not found");
      if (operationIsSettled(operation.state)) return operation;
      if (this.engine.stopped || Date.now() >= deadline) return operation;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  /** Restart bootstrap: reconcile exactly the unfinished durable operations, never a new effect. */
  resumeOperations(reconcileInterrupted = true): void {
    if (reconcileInterrupted) {
      for (const operation of this.store.sourcePromotionsForReconciliation())
        this.engine.reconcileSourcePromotion(operation);
    } else {
      // A reconnect does not stop handlers already in this process. Their commit
      // remains possible until the owning lane settles, so absence is not proof.
      this.store.transaction(() => {
        for (const operation of this.store.sourcePromotionsForReconciliation()) {
          const current = this.store.operation(operation.id);
          if (
            current?.state !== "running" ||
            current.effect?.kind !== "source_promotion" ||
            !["intent", "uncertain"].includes(current.effect.status)
          )
            continue;
          const diagnostic =
            "Source promotion is still in flight after host reconnect; its outcome is uncertain";
          this.store.putOperation({
            ...current,
            diagnostic,
            effect: {
              ...current.effect,
              status: "uncertain",
              result: diagnostic,
              resultAt: now(),
            },
          });
        }
      });
    }
    for (const operation of this.store.operations({
      states: ["pending", "running"],
    }))
      this.engine.scheduleOperation(operation.id);
    this.engine.resumeHostReadTransients();
    if (
      !this.engine.stopped &&
      this.store.pendingDecisionDeliveries().length > 0
    ) {
      void this.engine.scheduleDecisionNotices().catch(() => {
        /* decision delivery records its own wait or fault */
      });
    }
  }
  reconcileSourcePromotion(operation: QueueOperation): void {
    reconcileSourcePromotion(this.store, operation, this.activeOperations);
  }
  scheduleOperation(id: string): void {
    const operation = this.store.operation(id);
    if (!operation || operationIsSettled(operation.state)) return;
    if (this.engine.ownerSettledOperation(operation.taskId, id)) return;
    // A task-scoped command shares the task's exclusive lane so it is FIFO with
    // that task's lifecycle quanta and its nested control runs inline.
    const key = operationLaneKey(this.store.operationPayload(id), operation);
    void this.engine
      .cleanContext(() =>
        this.engine.scheduleLane(
          key,
          LANE_PRIORITY_OPERATION,
          () => this.engine.runOperation(id),
          { coalesce: `operation:${id}` },
        ),
      )
      .catch(() => {
        /* recorded on the operation record */
      });
  }
  async runOperation(id: string): Promise<void> {
    if (this.activeOperations.has(id)) return;
    const existing = this.store.operation(id);
    if (
      existing?.kind === "source_promote" &&
      existing.state === "running" &&
      existing.effect?.kind === "source_promotion"
    ) {
      // A running intent may belong to another still-live service. Observe its
      // result or leave it uncertain; scheduling is never permission to resend.
      this.reconcileSourcePromotion(existing);
      return;
    }
    this.activeOperations.add(id);
    const isPromotion = this.store.operation(id)?.kind === "source_promote";
    if (isPromotion) activeSourcePromotions.add(id);
    try {
      await this.runOperationOnce(id);
    } finally {
      this.activeOperations.delete(id);
      if (isPromotion) activeSourcePromotions.delete(id);
    }
  }
  private async runOperationOnce(id: string): Promise<void> {
    let pending = this.store.operation(id);
    if (!pending || operationIsSettled(pending.state)) return;
    if (this.engine.gitTransientWaiting(id, true)) return;
    if (this.engine.ownerSettledOperation(pending.taskId, id)) return;
    // A local transition can commit its existing operation result and effect in
    // the same transaction. After interruption, settle that result without
    // repeating the transition or any of its effects.
    if (
      pending.state === "running" &&
      (!pending.preSendBoundaryStartedAt ||
        (pending.kind === "task_control" &&
          pending.effect?.kind === "task_control" &&
          pending.effect.target === "restart" &&
          pending.effect.result === `parent-unarchive:${pending.id}`)) &&
      !pending.preSendReceipt &&
      pending.result &&
      pending.effect?.status === "reconciled"
    ) {
      this.store.putOperation({
        ...pending,
        state: "succeeded",
        settledAt: now(),
        diagnostic: "",
      });
      return;
    }
    if (pending.preSendReceipt) {
      // A crash after the receipt must never execute the control again.
      const proof = pending.preSendReceipt;
      const matches =
        proof.operationId === pending.id &&
        proof.inputHash === pending.inputHash &&
        proof.attempt === pending.attempts &&
        isDeepStrictEqual(proof.effect, pending.effect);
      this.store.putOperation({
        ...pending,
        state: "needs_attention",
        settledAt: now(),
        diagnostic: matches
          ? proof.diagnostic
          : pending.diagnostic ||
            "Interrupted pre-send receipt conflicts with the operation; inspect its evidence",
        effect: matches
          ? {
              ...proof.effect,
              status: "uncertain",
              result: proof.diagnostic.slice(0, 2000),
              resultAt: now(),
            }
          : pending.effect,
      });
      return;
    }
    if (
      pending.preSendBoundaryStartedAt &&
      (await this.resumeParentRestore(pending))
    )
      return;
    if (pending.preSendBoundaryStartedAt) {
      this.store.putOperation({
        ...pending,
        state: "needs_attention",
        settledAt: now(),
        diagnostic:
          pending.diagnostic ||
          "The task-control boundary was interrupted without a pre-send receipt; delivery remains uncertain",
      });
      return;
    }
    if (
      (pending.kind === "submit" || pending.kind === "review_entry") &&
      !this.engine.submissionReady()
    ) {
      const diagnostic = `${pending.kind === "review_entry" ? "Review entry" : "Submission"} accepted; waiting for host readiness before validation`;
      if (pending.state !== "pending" || pending.diagnostic !== diagnostic)
        this.store.putOperation({
          ...pending,
          state: "pending",
          settledAt: null,
          diagnostic,
        });
      return;
    }
    const pendingHost = pending.hostId;
    if (
      [
        "submit",
        "review_entry",
        "source_promote",
        "task_control",
        "task_remove",
      ].includes(pending.kind) &&
      (!pendingHost ||
        !this.engine.withHost(pendingHost, () =>
          this.engine.hostAvailable(pendingHost),
        ))
    ) {
      // #927: a control that is already invalid refuses on the store facts now,
      // not when the recorded host returns. The wait holds only a control that
      // would otherwise be accepted. Nothing was written for the refusal, so it
      // settles definite with no effect and needs no pre-send receipt.
      const refusal = this.hostIndependentRefusal(pending);
      if (refusal) {
        this.store.putOperation({
          ...pending,
          state: "failed",
          settledAt: now(),
          diagnostic: refusal.slice(0, 4000),
          effect: pending.effect
            ? {
                ...pending.effect,
                status: "reconciled",
                result: refusal.slice(0, 2000),
                resultAt: now(),
              }
            : null,
        });
        return;
      }
      const diagnostic = pending.hostId
        ? `Waiting for host ${pending.hostId}`
        : "Waiting for a proven host identity";
      if (pending.state !== "pending" || pending.diagnostic !== diagnostic)
        this.store.putOperation({
          ...pending,
          state: "pending",
          settledAt: null,
          diagnostic,
        });
      return;
    }
    // A legacy operation with a recorded host may predate selection evidence.
    // Reaching here proves that exact host is online; preserve the intent ID.
    if (
      pending.hostId &&
      !pending.hostSelection &&
      this.engine.withHost(pending.hostId, () =>
        this.engine.hostAvailable(pending!.hostId!),
      )
    ) {
      const host = pending.hostId;
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE operations SET data=json_set(data,'$.hostSelection',json(?)) WHERE id=? AND json_type(data,'$.hostSelection') IS NULL AND json_extract(data,'$.hostId')=?",
          )
          .run(
            JSON.stringify({
              hostId: host,
              basis: "migrated",
              reason: "Recorded operation host is online",
            }),
            id,
            host,
          );
      });
      pending = this.store.operation(id)!;
    }
    const payload = this.store.operationPayload(id);
    const effect = pending.effect ?? this.engine.effectIntentFor(pending);
    let running = this.store.transaction(() => {
      if (pending!.kind === "source_promote")
        this.store.setMeta(sourceOwnerKey(id), { pid: process.pid });
      return this.store.putOperation({
        ...pending!,
        state: "running",
        startedAt: pending!.startedAt ?? now(),
        attempts: pending!.attempts + 1,
        effect,
      });
    });
    try {
      const result = running.hostId
        ? await this.engine.withHost(running.hostId, () =>
            this.engine.performOperation(running, payload),
          )
        : await this.engine.performOperation(running, payload);
      // Re-read: the handler may have advanced the task, and the settled record
      // must reflect the observed identity rather than the intent's snapshot.
      this.store.deleteMeta(this.engine.transientKey(id));
      this.engine.clearHostReadTransient(id, "op");
      const targetTaskId = running.taskId ?? result.taskId ?? null;
      if (targetTaskId)
        this.engine.clearHostReadTransient(targetTaskId, "task");
      const settled = this.store.operation(id) ?? running;
      // A submit creates its task, so the top-level identity is only known here; mirror it
      // so callers need not dig into result.taskId.
      this.store.putOperation({
        ...settled,
        taskId: settled.taskId ?? result.taskId ?? null,
        state: "succeeded",
        settledAt: now(),
        diagnostic: "",
        result,
        effect: effect
          ? {
              ...effect,
              status: "reconciled",
              result: result.taskId ?? "",
              resultAt: now(),
            }
          : null,
      });
      // A restart's first wake can reach integration while this operation still
      // owns its durable effect. Recheck after settlement, when that fence lifts.
      if (
        running.kind === "task_control" &&
        result.taskId &&
        (payload as { control?: { action?: string } } | null)?.control
          ?.action === "restart"
      )
        void this.engine.cleanContext(() =>
          this.engine.wakeTask(result.taskId!),
        );
    } catch (error) {
      // A handler may atomically commit its durable operation with its local
      // transition. A later reporting failure cannot undo that committed result.
      const committed = this.store.operation(id);
      const message = error instanceof Error ? error.message : String(error);
      const currentOperation = this.store.operation(id);
      // A parent restore has its own exact intent. Preserve the operation until
      // that intent can be observed, rather than classifying a lost reply as a
      // refusal or replaying the restart.
      if (
        currentOperation?.preSendBoundaryStartedAt &&
        (await this.holdParentRestore(currentOperation))
      )
        return;
      // A proved pre-send transient host read failure never crossed the send
      // boundary: retain the authorized operation without consuming attempts or
      // recording a refusal, and retry automatically until settled or exhausted.
      if (
        !currentOperation?.preSendBoundaryStartedAt &&
        error instanceof HostReadRefusalError &&
        pending.kind !== "task_remove"
      ) {
        if (currentOperation)
          this.store.putOperation({
            ...currentOperation,
            attempts: Math.max(0, running.attempts - 1),
          });
        this.engine.deferHostReadTransient(
          id,
          error,
          true,
          `${pending.kind} pre-send check`,
        );
        return;
      }
      const controlPayload = payload as {
        type?: unknown;
        control?: unknown;
      } | null;
      const parsedControl = taskControlInputSchema.safeParse(
        controlPayload?.control,
      );
      const settledBefore = currentOperation ?? running;
      // One proof decides whether this refusal may record a pre-send receipt:
      // the parked restart's own rollback evidence, or Queue's own gate answering
      // before anything was bound or sent (papercut 4b285a6e).
      const receiptProof = preSendReceiptProof({
        store: this.store,
        buildId: () => this.engine.currentServiceBuildId(),
        running,
        current: currentOperation,
        payload,
        effect,
        error,
        message,
      });
      const refusedOwnedToolRetry =
        running.kind === "task_control" &&
        parsedControl.success &&
        parsedControl.data.action === "retry_effect" &&
        typeof parsedControl.data.effect === "string" &&
        parsedControl.data.effect.startsWith("owned_tool.") &&
        /^Owned-tool hold .+ remains:/.test(message) &&
        !currentOperation?.preSendBoundaryStartedAt;
      const settlement = operationFailureSettlement(
        {
          committed: Boolean(
            committed?.result &&
              committed.effect?.status === "reconciled" &&
              (!committed.preSendBoundaryStartedAt ||
                (committed.kind === "task_control" &&
                  committed.effect?.kind === "task_control" &&
                  committed.effect.target === "restart" &&
                  committed.effect.result ===
                    `parent-unarchive:${committed.id}`)) &&
              !committed.preSendReceipt,
          ),
          submissionDeferrable:
            pending.kind === "submit" || pending.kind === "review_entry",
          validationUnavailable:
            isTransportFailure(error) ||
            error instanceof SubmissionUnavailableError,
          parkedRestartProven: receiptProof.kind === "parked_restart",
          typedRefusalProven: receiptProof.kind === "typed_refusal",
          typedPreSendRefusal: receiptProof.typedRefusal,
          preSendBoundaryStarted: Boolean(
            currentOperation?.preSendBoundaryStartedAt,
          ),
          ownedToolRetryRefused: refusedOwnedToolRetry,
          sourcePromotionAbsent:
            running.kind === "source_promote" &&
            effect?.kind === "source_promotion" &&
            currentOperation?.state === "running" &&
            currentOperation.attempts === running.attempts &&
            currentOperation.inputHash === running.inputHash &&
            operationIdForKey(running.key) === running.id &&
            operationInputHash(payload) === running.inputHash &&
            this.sourcePromotionUncommitted(payload),
          effectChangedSinceIntent: Boolean(
            settledBefore.preSendBoundaryStartedAt &&
              !isDeepStrictEqual(settledBefore.effect, effect),
          ),
          hasEffect: Boolean(effect),
          message,
        },
        () => this.engine.deferGitTransient(id, error, true),
      );
      if (settlement.kind === "already_committed") {
        this.store.putOperation({
          ...committed!,
          state: "succeeded",
          settledAt: now(),
          diagnostic: "",
        });
        return;
      }
      if (settlement.kind === "defer_git_transient") return;
      if (settlement.kind === "defer_validation") {
        this.store.putOperation({
          ...(this.store.operation(id) ?? running),
          state: "pending",
          settledAt: null,
          diagnostic:
            `${pending.kind === "review_entry" ? "Review-entry" : "Submission"} validation deferred: ${message}`.slice(
              0,
              4000,
            ),
        });
        return;
      }
      // The two receipts are mutually exclusive: the parked restart's proof needs
      // a crossed send boundary (`currentOperation.preSendBoundaryStartedAt`) and
      // every other typed refusal's proof needs none, so the proof names at most
      // one of them. A receipt that could not be written still settles definite;
      // there is no second receipt to fall back to.
      if (settlement.receipt && receiptProof.receipt && currentOperation) {
        try {
          this.store.putOperation({
            ...currentOperation,
            preSendReceipt: receiptProof.receipt,
          });
        } catch {
          /* Without the durable receipt the refusal remains definite and unfenced. */
        }
      }
      const settled = this.store.operation(id) ?? running;
      const effectStatus = settlement.effect;
      this.store.putOperation({
        ...settled,
        state: settlement.state,
        settledAt: now(),
        diagnostic: message.slice(0, 4000),
        effect:
          effectStatus === "keep"
            ? settled.effect
            : effect &&
                (effectStatus === "reconciled" || effectStatus === "uncertain")
              ? {
                  ...effect,
                  status: effectStatus,
                  result: message.slice(0, 2000),
                  resultAt: now(),
                }
              : null,
      });
    }
  }
  /** The original worker restart and host are the only owners of this observation. */
  private async parentRestoreObservation(
    operation: QueueOperation,
  ): Promise<
    | "not_found"
    | "live"
    | "archived"
    | "deleted"
    | "mismatched"
    | "unobservable"
  > {
    if (
      operation.kind !== "task_control" ||
      !operation.taskId ||
      !operation.hostId ||
      operation.id !== operationIdForKey(operation.key)
    )
      return "not_found";
    const payload = this.store.operationPayload(operation.id) as {
      type?: unknown;
      control?: unknown;
    } | null;
    const parsed = taskControlInputSchema.safeParse(payload?.control);
    if (
      !payload ||
      payload.type !== "task_control" ||
      operationInputHash(payload) !== operation.inputHash ||
      !parsed.success ||
      parsed.data.action !== "restart" ||
      parsed.data.taskId !== operation.taskId ||
      parsed.data.version !== operation.expectedVersion
    )
      return "not_found";
    const task = this.store.taskOrNull(operation.taskId);
    if (!task || task.hostId !== operation.hostId) return "not_found";
    if (
      !this.engine.withHost(operation.hostId, () =>
        this.engine.hostAvailable(operation.hostId!),
      )
    )
      return operation.effect?.result === `parent-unarchive:${operation.id}`
        ? "unobservable"
        : "not_found";
    return this.engine.withHost(operation.hostId, async () => {
      const observe = this.engine.adapter.observeTaskParentRestore;
      const result = observe
        ? await observe.call(this.engine.adapter, task, operation.id)
        : "not_found";
      return result === "not_found" &&
        operation.effect?.result === `parent-unarchive:${operation.id}`
        ? "unobservable"
        : result;
    });
  }

  private parentRestoreWait(
    operation: QueueOperation,
    observed: "archived" | "deleted" | "mismatched" | "unobservable",
  ): void {
    const reason =
      observed === "archived"
        ? "Parent unarchive delivery remains unknown; the same parent is still archived"
        : observed === "unobservable"
          ? "Parent unarchive delivery remains unknown; the same parent cannot be observed"
          : `Parent unarchive cannot be reconciled: the same parent is ${observed}; inspect its retained binding`;
    const attention = observed === "deleted" || observed === "mismatched";
    this.store.putOperation({
      ...operation,
      state: attention ? "needs_attention" : "pending",
      settledAt: attention ? now() : null,
      diagnostic: reason,
    });
  }

  private async holdParentRestore(operation: QueueOperation): Promise<boolean> {
    const observed = await this.parentRestoreObservation(operation).catch(() =>
      operation.effect?.result === `parent-unarchive:${operation.id}`
        ? ("unobservable" as const)
        : ("not_found" as const),
    );
    if (observed === "not_found") return false;
    if (observed === "live") {
      this.store.putOperation({
        ...operation,
        state: "pending",
        settledAt: null,
        diagnostic: "Parent restored; restart admission awaits reconciliation",
      });
      setTimeout(() => this.engine.scheduleOperation(operation.id), 0);
    } else this.parentRestoreWait(operation, observed);
    return true;
  }

  private async resumeParentRestore(
    operation: QueueOperation,
  ): Promise<boolean> {
    const observed = await this.parentRestoreObservation(operation).catch(() =>
      operation.effect?.result === `parent-unarchive:${operation.id}`
        ? ("unobservable" as const)
        : ("not_found" as const),
    );
    if (observed === "not_found") return false;
    if (observed !== "live") {
      this.parentRestoreWait(operation, observed);
      return true;
    }
    if (operation.result && operation.effect?.status === "reconciled") {
      this.store.putOperation({
        ...operation,
        state: "succeeded",
        settledAt: now(),
        diagnostic: "",
      });
      return true;
    }
    const payload = this.store.operationPayload(operation.id) as {
      control: unknown;
    };
    const input = taskControlInputSchema.parse(payload.control);
    this.store.putOperation({
      ...operation,
      state: "running",
      settledAt: null,
    });
    try {
      const task = await this.engine.withHost(operation.hostId!, () =>
        this.engine.restartControls.resumeRestoredWorker(input, operation.id),
      );
      const committed = this.store.operation(operation.id)!;
      if (!committed.result || committed.effect?.status !== "reconciled")
        throw Error("Restart admission did not commit its operation result");
      this.store.putOperation({
        ...committed,
        state: "succeeded",
        settledAt: now(),
        diagnostic: "",
      });
      void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    } catch (error) {
      const current = this.store.operation(operation.id)!;
      this.store.putOperation({
        ...current,
        state: "needs_attention",
        settledAt: now(),
        diagnostic:
          `Parent was restored, but restart admission did not settle: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4000,
          ),
      });
    }
    return true;
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
      return (
        this.store.sourcePromotionResult(
          { kind: source.kind, id: source.id },
          source.repository,
          source.version,
          source.digest,
        ) === null
      );
    } catch {
      return false;
    }
  }
  /**
   * #927: the refusals a durable operation owes before it may wait for its
   * offline recorded host, read from the store as it stands. `null` means the
   * operation is valid so far and waits, exactly as #912 recorded it.
   */
  private hostIndependentRefusal(pending: QueueOperation): string | null {
    if (pending.kind === "task_control") {
      const payload = this.store.operationPayload(pending.id) as {
        control?: unknown;
        authenticatedForceRunId?: string;
      } | null;
      const parsed = taskControlInputSchema.safeParse(payload?.control);
      if (!parsed.success) return null;
      const forceRunId = payload?.authenticatedForceRunId;
      // A self-force reads the authenticated run scope the perform step enters,
      // so the same scope is entered here and proved against the recorded grant
      // first: an unauthorized force refuses now, not when its host returns.
      if (forceRunId) {
        if (
          this.store.getMeta(`selfForceGrant:${pending.inputHash}`) !==
          forceRunId
        )
          return "Missing authenticated force grant";
        return this.engine.selfForceRunId.run(forceRunId, () =>
          hostIndependentControlRefusal(this.engine, parsed.data, pending.id),
        );
      }
      return hostIndependentControlRefusal(
        this.engine,
        parsed.data,
        pending.id,
      );
    }
    if (pending.kind === "task_remove") {
      const removal = taskRemoveOperationPayloadSchema.safeParse(
        this.store.operationPayload(pending.id),
      );
      return removal.success
        ? this.engine.removalRefusal(removal.data.taskId, removal.data.version)
        : null;
    }
    return null;
  }
  ownerSettledOperation(taskId: string | null, id: string): boolean {
    if (!taskId) return false;
    try {
      return this.store
        .task(taskId)
        .resolution.ownerSettlements.some(
          (record) =>
            record.effect === `operation.${id}` ||
            record.effect === `task_control_operation.${id}`,
        );
    } catch {
      return false;
    }
  }
  effectIntentFor(operation: QueueOperation): QueueOperation["effect"] {
    if (operation.kind === "source_promote") {
      sourcePromotionOperationPayloadSchema.parse(
        this.store.operationPayload(operation.id),
      );
      return {
        kind: "source_promotion",
        target: operation.id,
        intentAt: now(),
        status: "intent",
        result: null,
        resultAt: null,
      };
    }
    if (operation.kind !== "task_control" && operation.kind !== "task_remove")
      return null;
    const payload = this.store.operationPayload(operation.id) as {
      control?: { action?: string };
      taskId?: string;
    } | null;
    if (operation.kind === "task_remove")
      return {
        kind: "task_remove",
        target: payload?.taskId ?? operation.taskId ?? "",
        intentAt: now(),
        status: "intent",
        result: null,
        resultAt: null,
      };
    const control = payload as { control?: { action?: string } } | null;
    return {
      kind: "task_control",
      target: control?.control?.action ?? "",
      intentAt: now(),
      status: "intent",
      result: null,
      resultAt: null,
    };
  }
  rerecordPlanningBase(
    input: Parameters<PlanningRepairs["rerecordPlanningBase"]>[0],
  ) {
    return new PlanningRepairs(this.engine).rerecordPlanningBase(input);
  }
  retryValidation(input: Parameters<PlanningRepairs["retryValidation"]>[0]) {
    return new PlanningRepairs(this.engine).retryValidation(input);
  }

  async performOperation(
    operation: QueueOperation,
    payload: unknown,
  ): Promise<OperationResult> {
    const selection =
      operation.hostSelection ??
      (operation.hostId
        ? {
            hostId: operation.hostId,
            basis: "migrated" as const,
            reason: "Inherited from recorded operation host",
          }
        : undefined);
    if (operation.kind === "lead_check") {
      if (!this.leadCheckHandler)
        throw new Error("Lead check handler is unavailable");
      return this.leadCheckHandler(
        leadCheckOperationPayloadSchema.parse(payload),
        operation.id,
      );
    }
    if (operation.kind === "source_promote") {
      if (!this.sourcePromotionHandler)
        throw new Error("Source promotion handler is unavailable");
      return this.sourcePromotionHandler(
        sourcePromotionOperationPayloadSchema.parse(payload),
        operation.hostId,
        selection,
      );
    }
    if (operation.kind === "repository_rekey") {
      if (!this.repositoryRekeyHandler)
        throw new Error("Repository re-key handler is unavailable");
      return this.repositoryRekeyHandler(
        repositoryRekeyOperationPayloadSchema.parse(payload).input,
      );
    }
    if (operation.kind === "submit") {
      const parsed = submissionSchema.parse(
        submissionRecordFromLegacy(
          (payload as { submission?: unknown } | null)?.submission,
          "submit operation",
        ),
      );
      return this.engine.performSubmit(
        parsed,
        Boolean(
          (payload as { requirePushedPlanning?: boolean })
            .requirePushedPlanning,
        ),
        undefined,
        operation.hostId,
        selection,
      );
    }
    if (operation.kind === "review_entry") {
      const input = reviewEntryInputSchema.parse(
        (payload as { input?: unknown } | null)?.input,
      );
      if (!this.adapter.inspectReviewEntry || !this.adapter.originAgent)
        throw unavailableReviewEntry(this.adapter.hostId);
      const routingConflict = this.engine.independentReviewRoutingRefusal({
        ...input.submission,
        declaredAuthorModels: input.authorDeclaration.models,
      });
      if (routingConflict) throw new Error(routingConflict);
      const originHostId = await this.engine.identifyOriginHost(
        input.submission.originAgentId,
        input.submission.originIdentity,
      );
      if (!originHostId)
        throw new SubmissionUnavailableError(
          "Review-entry origin host is unknown or ambiguous",
        );
      const target = this.adapter as Adapter & ReviewEntryAdapter;
      const reviewAdapter =
        originHostId === operation.hostId
          ? target
          : withOriginReviewAdapter(target, async (reviewInput, taskId) => {
              const proof = await originReviewProof(
                this.engine.host,
                this.engine.withHost.bind(this.engine),
                originHostId,
                reviewInput.submission.originAgentId,
              );
              return target.inspectReviewEntry(reviewInput, taskId, proof);
            });
      const task = await bindReviewEntry(
        this.store,
        reviewAdapter,
        { ...operation, hostSelection: selection },
        input,
        originHostId,
        async (id) => {
          const identitySource =
            id === input.submission.originAgentId
              ? input.submission.originIdentity
              : undefined;
          const host = await this.engine.identifyOriginHost(id, identitySource);
          if (!host)
            throw new SubmissionUnavailableError(
              "Review-entry origin host is unknown or ambiguous",
            );
          return this.engine.withHost(host, () =>
            this.engine.host.originAgent(id),
          );
        },
      );
      return {
        taskId: task.id,
        taskVersion: task.version,
        phase: task.phase,
        number: task.number,
        reference: task.reference,
      };
    }
    if (operation.kind === "task_remove") {
      // Removal performs its remote effects (thread observation, workspace
      // archive, Effigy runtime-scope capture and retirement) here, inside the
      // durable operation lane and after its intent persisted, so a slow
      // retirement settles the operation instead of timing out the caller.
      // An already-removed task returns as removed, so replay is idempotent.
      const remove = taskRemoveOperationPayloadSchema.parse(payload);
      const task = await this.engine.removeTask(remove.taskId, remove.version);
      return {
        taskId: task.id,
        taskVersion: task.version,
        phase: task.phase,
        number: task.number,
        reference: task.reference,
      };
    }
    const control = taskControlInputSchema.parse(
      (payload as { control?: unknown } | null)?.control,
    );
    const forceRunId = (payload as { authenticatedForceRunId?: string })
      .authenticatedForceRunId;
    if (
      forceRunId &&
      this.store.getMeta(`selfForceGrant:${operation.inputHash}`) !== forceRunId
    )
      throw new DurableFenceRefusal("Missing authenticated force grant");
    const task = forceRunId
      ? await this.engine.selfForceRunId.run(forceRunId, () =>
          this.engine.performTaskControl(control, operation.id),
        )
      : await this.engine.performTaskControl(control, operation.id);
    return {
      taskId: task.id,
      taskVersion: task.version,
      phase: task.phase,
      number: task.number,
      reference: task.reference,
    };
  }
  async submitPlanningSource(
    submission: Submission,
    source: {
      kind: "lead" | "papercut";
      id: string;
      repository: string;
      digest: string;
      expectedSource: string;
    },
    initial: Partial<Task> = {},
    hostId?: string,
    identitySource?: IdentitySource,
  ): Promise<OperationResult> {
    return this.engine.performSubmit(
      submission,
      false,
      { source, initial, ...(identitySource ? { identitySource } : {}) },
      hostId,
    );
  }
  performSubmit(...args: Parameters<PlanningSubmission["performSubmit"]>) {
    return new PlanningSubmission(this.engine).performSubmit(...args);
  }
}
