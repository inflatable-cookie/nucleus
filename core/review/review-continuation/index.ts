/**
 * The continuation composition: one authorized reviewer turn, from the gate to a
 * durable delivery. The checkpoint file and proof are `checkpoints.ts`'s, the
 * retained reader's state is `reader.ts`'s, delivery identity and stop proof are
 * `delivery.ts`'s and the result fence is `result-fence.ts`'s; this module
 * composes them and owns the public surface every caller imports.
 */
import { stopClearedPatch } from "../../../shared/task-stop";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { TaskChangedRefusal } from "../../../shared/task-version";
import { HOST_KIND_LABELS, hostKindOf } from "../../../shared/host-kind";
import {
  type ReviewCheckpointRecord,
  type ReviewDeliveryAuthorization,
  type Run,
  type Task,
} from "../../../shared/contracts";
import { briefDigest, currentBrief } from "../../planning/brief";
import { taskPrNumber } from "../../forge/index";
import { now, type Store } from "../../store/store";
import { operatorReviewContinuationPrompt } from "../../dispatch/prompts";
import { runTicketPath } from "../../dispatch/agent-creation";
import type { AgentObservation } from "../../host/adapter";
import type { Adapter } from "../../host/adapter";
import type { HostFacade } from "../../host/host-facade";
import type { ContinuationFences } from "../../verbs/verb-fences";
import { reviewerRuntimeChanged } from "../reviewer-runtime";
import { matchingInactiveParticipant } from "../../intake/run-settlement";
import { ProvenPreSendRefusalError } from "../../recovery/task-reasons";
import { reviewCheckpointRefusal } from "./checkpoints";
import {
  latestDeliveredReviewTurn,
  reviewAuthorizationId,
  reviewDeliveryId,
  reviewDeliveryReason,
  reviewStopOccurrences,
  stoppedDeliveryResume,
  type StoppedDeliveryResume,
} from "./delivery";
import {
  REVIEW_AGENT_CLOSED,
  REVIEW_AGENT_ERRORED,
  reviewContinuationLimit,
  reviewContinuationWait,
  reviewInProgress,
} from "./reader";
import { ordinaryReviewSource } from "../ordinary-review";
import { reattachStoredTaskCheckout } from "../../git/checkout-reattach";
import { reviewContinuationLocalRefusal } from "./gate";

export * from "./checkpoints";
export * from "./delivery";
export * from "./gate";
export * from "./reader";
export * from "./result-fence";

export interface ReviewContinuationContext {
  readonly store: Store;
  readonly adapter: Pick<
    Adapter,
    "verifyPr" | "verifyPrIdentity" | "continueReviewer" | "helperPath"
  > & { hostId?: string };
  /** The task-owner host binding every agent-naming call reads (#1154). */
  onTaskHost: <T>(
    owner: { hostId?: string | null } | null | undefined,
    work: () => T,
  ) => T;
  readonly host: Pick<HostFacade, "observe">;
  paused(): boolean;
  settleVerbFences: ContinuationFences["settleContinuationFences"];
  assertReviewProfileIndependent(task: Task, run: Run): void;
  stopResumeState: ReviewContinuations["stopResumeState"];
  reviewContinuationGate: ReviewContinuations["reviewContinuationGate"];
  assertIdleReviewerObservation: ReviewContinuations["assertIdleReviewerObservation"];
  inspectReviewContinuation: ReviewContinuations["inspectReviewContinuation"];
  admitReviewContinuation: ReviewContinuations["admitReviewContinuation"];
  assertReviewCheckpointProvenance: ReviewContinuations["assertReviewCheckpointProvenance"];
}

/** One authorized reviewer turn. Same-name `Resolution` methods delegate here. */
export class ReviewContinuations {
  constructor(readonly resolution: ReviewContinuationContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }

  /** The current reviewer run when it holds a durable progress checkpoint; null otherwise. */
  reviewContinuationOwner(t: Task): Run | null {
    const run = t.resolution.currentRunId
      ? this.store.run(t.resolution.currentRunId)
      : null;
    return reviewInProgress(run) ? run : null;
  }

  /**
   * The stop-backed resume the latest checkpoint of one run currently
   * authorizes, when the caller's checkpoint is that latest one. The identity is
   * derived here, never supplied by a caller.
   */
  stopResumeState(input: {
    taskId: string;
    runId: string;
    checkpointOrdinal: number;
  }): StoppedDeliveryResume {
    const initialRun = this.store.run(input.runId);
    const delivered = initialRun ? latestDeliveredReviewTurn(initialRun) : null;
    if (
      !initialRun ||
      !delivered ||
      delivered.checkpointOrdinal !== input.checkpointOrdinal
    )
      return { kind: "none" };
    return stoppedDeliveryResume(
      this.store,
      this.store.task(input.taskId),
      initialRun,
      delivered,
    );
  }

  async inspectReviewContinuation(
    input: {
      taskId: string;
      version: number;
      runId: string;
      head: string;
      checkpointOrdinal: number;
      reason: string;
      instruction: string;
    },
    operationId: string,
  ): Promise<Task | null> {
    if (!operationId)
      throw new Error(
        "Reviewer continuation requires its durable operation identity",
      );
    const initialRun = this.store.run(input.runId);
    // An unproven or ambiguous stop is inspect-only, with its own reason: it is
    // never silently treated as "no stop" and replaced by the spent delivery.
    const stopped = this.resolution.stopResumeState(input);
    if (stopped.kind === "refused") throw new Error(stopped.reason);
    const resumeStop =
      stopped.kind === "resume"
        ? { eventId: stopped.eventId, at: stopped.at }
        : null;
    // A recorded stop-backed delivery keeps its own identity after the turn it
    // resumed: the stop occurrence is no longer "after the latest delivery", so
    // a replay of the same intent is found by the stop occurrence it recorded
    // rather than by the plain checkpoint identity.
    //
    // Only that stop occurrence's own delivery can be its replay (Tom,
    // 2026-10-27). The historical stop that produced an earlier resumed delivery
    // belongs to that earlier effect: a second, later stop must reserve its own
    // new continuation, never reconcile the first one.
    const stopOccurrences =
      initialRun && !resumeStop
        ? reviewStopOccurrences(
            this.store,
            this.store.task(input.taskId),
            initialRun,
          )
        : [];
    // Newest first: the most recent stop occurrence is the one whose recorded
    // delivery (if any) is this intent's replay.
    const candidates = resumeStop
      ? [resumeStop]
      : [...stopOccurrences].reverse();
    const recorded = candidates
      .map((stop) => ({
        stop,
        delivery: initialRun?.reviewDeliveries?.find(
          (item) =>
            item.checkpointOrdinal === input.checkpointOrdinal &&
            item.deliveryId === reviewDeliveryId(input, stop),
        ),
      }))
      .find((entry) => entry.delivery);
    const record = recorded?.delivery;
    // A new stop occurrence is its own authorization: only the delivery it already
    // recorded can be its replay. The plain checkpoint delivery is the *previous*
    // turn, not this intent.
    const prior =
      record ??
      (resumeStop
        ? undefined
        : initialRun?.reviewDeliveries?.find(
            (item) => item.deliveryId === reviewDeliveryId(input),
          ));
    const recordedStop = recorded?.stop ?? resumeStop;
    const deliveryId = prior?.deliveryId ?? reviewDeliveryId(input, resumeStop);
    const authorizationId = reviewAuthorizationId(input, recordedStop);
    if (prior) {
      if (prior.status === "refused") {
        if (input.version !== this.store.task(input.taskId).version)
          throw new Error(
            "Task version is stale after a proven pre-send refusal; refresh task detail before a fresh operator authorization",
          );
      } else {
        if (prior.authorizationId !== authorizationId)
          throw new Error(
            prior.status === "delivered"
              ? `Checkpoint ${prior.checkpointOrdinal} on run ${input.runId} already has its delivered continuation (${prior.deliveryId}); no second turn is sent for it. Route the reviewer to a profile with capacity (route role=reviewer, with now to replace the run) or start a fresh reviewer at the same head (restart role=reviewer fresh)`
              : "This checkpoint already has a different durable operator authorization; no second delivery is allowed",
          );
        if (
          prior.operationId !== operationId &&
          input.version !== this.store.task(input.taskId).version
        )
          throw new Error(
            "Task version is stale for same-intent delivery inspection; refresh task detail",
          );
        if (prior.status === "delivered") return this.store.task(input.taskId);
        throw new Error(
          `Reviewer delivery ${deliveryId} is uncertain. Use record.clear kind=effect id=review-delivery.${deliveryId}`,
        );
      }
    }

    return null;
  }

  async admitReviewContinuation(
    input: {
      taskId: string;
      version: number;
      runId: string;
      head: string;
      checkpointOrdinal: number;
      reason: string;
      instruction: string;
      settleFences?: { runIds: string[]; displacedRunIds?: string[] };
    },
    operationId: string,
  ) {
    try {
      const checkpoint = this.resolution.reviewContinuationGate(
        input,
        input.version,
        operationId,
        { settle: input.settleFences },
      );
      const { task, run } = checkpoint;
      const recheck = () => {
        const current = this.resolution.reviewContinuationGate(
          input,
          input.version,
          operationId,
          { settle: input.settleFences },
        );
        if (!isDeepStrictEqual(current.run, run))
          throw Error(
            "The reviewer run changed during continuation admission; no delivery was sent",
          );
      };
      const number = taskPrNumber(task);
      if (
        !number ||
        !task.prUrl ||
        !task.prHead ||
        task.prHead !== run.head ||
        input.head !== run.head
      )
        throw new Error(
          "Reviewer continuation requires the same recorded open PR and full exact head",
        );
      const verifyPr = run.ordinaryDetached
        ? async (task: Task, number: number) => {
            await reattachStoredTaskCheckout(this.store, run.taskId, run.id);
            await ordinaryReviewSource(task, run.head);
            if (!this.adapter.verifyPrIdentity)
              throw Error(
                "Ordinary review canonical PR observation unavailable",
              );
            const pr = await this.adapter.verifyPrIdentity(task, number);
            await ordinaryReviewSource(task, run.head);
            return pr;
          }
        : this.adapter.verifyPr;
      const continueReviewer = this.adapter.continueReviewer;
      if (!verifyPr || !continueReviewer) {
        const hostLabel =
          HOST_KIND_LABELS[hostKindOf(task.hostId ?? this.adapter.hostId)];
        throw new Error(
          `${hostLabel} cannot prove and deliver a permission-free same-run reviewer continuation; no delivery was sent`,
        );
      }
      const verified = await verifyPr(task, number);
      recheck();
      if (
        verified.url !== task.prUrl ||
        verified.head !== run.head ||
        verified.head !== input.head
      ) {
        throw new Error(
          "Open PR, task and reviewer heads do not match; no reviewer delivery was sent",
        );
      }
      const observed = await this.resolution.onTaskHost(task, () =>
        this.resolution.host.observe(run.agentId!),
      );
      recheck();
      this.resolution.assertIdleReviewerObservation(task, run, observed);
      return { ...checkpoint, number, verifyPr, continueReviewer };
    } catch (error) {
      throw error instanceof ProvenPreSendRefusalError
        ? error
        : new ProvenPreSendRefusalError(
            error instanceof Error ? error.message : String(error),
          );
    }
  }

  /**
   * Deliver one operator-authorized continuation to the exact checkpointed
   * reviewer. Reservation is durable before messaging; every ambiguous outcome
   * is reconciled from a matching timeline message or authenticated callback,
   * and is never replayed.
   */
  async continueReview(
    input: {
      taskId: string;
      version: number;
      runId: string;
      head: string;
      checkpointOrdinal: number;
      reason: string;
      instruction: string;
      settleFences?: {
        detail: string;
        runIds: string[];
        displacedRunIds?: string[];
      };
    },
    operationId: string,
  ): Promise<Task> {
    if (await this.resolution.inspectReviewContinuation(input, operationId))
      return this.store.task(input.taskId);
    let deliveryId = reviewDeliveryId(input);
    // Earlier same-intent inspection stays outside this boundary: an existing
    // unknown send is never reclassified by a new preflight refusal.
    let reservedRunId: string | undefined;
    let adapterInvoked = false,
      adapterRefused = false;
    try {
      const {
        task,
        run,
        record,
        briefVersion,
        number,
        verifyPr,
        continueReviewer,
        resumeStop,
      } = await this.resolution.admitReviewContinuation(input, operationId);
      // The admitted turn's own identity: a stop-backed resume carries the
      // individual owner-stop occurrence, so its replay reconciles instead of
      // sending and a second resume needs a second explicit stop.
      deliveryId = reviewDeliveryId(input, resumeStop);
      const authorizationId = reviewAuthorizationId(input, resumeStop);
      const currentBriefVersion = currentBrief(task);
      const authorization: ReviewDeliveryAuthorization = {
        authorizationId,
        operationId,
        deliveryId,
        taskId: task.id,
        runId: run.id,
        head: run.head,
        checkpointOrdinal: record.ordinal,
        taskVersion: input.version,
        briefVersion: briefVersion?.version ?? null,
        briefDigest: briefVersion ? briefDigest(briefVersion.text) : null,
        reason: input.reason.trim(),
        instruction: input.instruction.trim(),
        createdAt: now(),
        status: "reserved",
        evidence: "",
        observedAt: null,
      };
      if (
        (currentBriefVersion?.version ?? null) !== authorization.briefVersion ||
        (currentBriefVersion ? briefDigest(currentBriefVersion.text) : null) !==
          authorization.briefDigest
      )
        throw new Error(
          "Nucleus-held brief changed before reviewer authorization was reserved",
        );
      const reservation = this.store.transaction(() => {
        const fresh = this.resolution.reviewContinuationGate(
          input,
          input.version,
          operationId,
          { settle: input.settleFences },
        );
        if (
          (fresh.resumeStop?.eventId ?? null) !== (resumeStop?.eventId ?? null)
        )
          throw new Error(
            "The stopped review turn changed during admission; refresh the task and explicitly authorize the latest checkpoint",
          );
        const latestRun = this.store.run(run.id)!;
        this.resolution.assertReviewCheckpointProvenance(
          fresh.task,
          latestRun,
          fresh.record,
        );
        const deliveries = [...(latestRun.reviewDeliveries ?? [])];
        const existingIndex = deliveries.findIndex(
          (item) => item.deliveryId === deliveryId,
        );
        if (existingIndex >= 0) {
          if (deliveries[existingIndex].status !== "refused")
            throw new Error(
              "Reviewer delivery changed after refusal inspection; no second delivery was reserved",
            );
          // A positive pre-send refusal proves this message ID was never delivered.
          // Keep its refusal event as audit evidence, but allow a fresh operator
          // authorization to reserve the same checkpoint-bound delivery identity.
          deliveries[existingIndex] = authorization;
        } else deliveries.push(authorization);
        // Spec 050 (#3569): the fences this continuation obsoletes settle in the
        // same transaction as the reservation, so a refused continuation changes
        // nothing. The strict re-gate proves the settled world still matches.
        let expectedVersion = input.version;
        if (input.settleFences) {
          this.resolution.settleVerbFences(task.id, input.settleFences);
          expectedVersion = this.store.task(task.id).version;
          this.resolution.reviewContinuationGate(
            input,
            expectedVersion,
            operationId,
          );
        }
        const nextRun = { ...latestRun, reviewDeliveries: deliveries };
        this.store.putRun(nextRun);
        const nextTask = this.store.update(
          task.id,
          {
            reason: reviewDeliveryReason(deliveryId, "reserved"),
            ...stopClearedPatch(
              this.store.task(task.id),
              reviewDeliveryReason(deliveryId, "reserved"),
            ),
          },
          "review_delivery_reserved",
          authorizationId,
          expectedVersion,
        );
        return { task: nextTask, run: nextRun };
      });
      reservedRunId = reservation.run.id;
      const reservationVersion = reservation.task.version;
      const reservedGate = () =>
        this.resolution.reviewContinuationGate(
          input,
          reservationVersion,
          operationId,
        );
      const allowed = async () => {
        try {
          const before = reservedGate();
          const pr = await verifyPr(before.task, number);
          const after = reservedGate();
          return (
            pr.url === after.task.prUrl &&
            pr.head === after.run.head &&
            pr.head === input.head
          );
        } catch {
          return false;
        }
      };
      const stillAllowed = () => {
        try {
          this.store.transaction(() => {
            reservedGate();
          });
          return true;
        } catch {
          return false;
        }
      };
      const {
        task: sendTask,
        run: sendRun,
        record: sendCheckpoint,
      } = reservedGate();
      let callback: { helper: string; ticket: string } | undefined;
      if (sendTask.hostId?.startsWith("bb:")) {
        const helper = this.adapter.helperPath;
        const ticket =
          helper && runTicketPath({ helperPath: helper }, sendRun.id);
        let bound = false;
        try {
          const record = JSON.parse(readFileSync(ticket!, "utf8"));
          bound =
            record.taskId === sendTask.id &&
            record.runId === sendRun.id &&
            typeof record.token === "string" &&
            Boolean(record.token) &&
            existsSync(helper!);
        } catch {
          /* no authenticated exact-run callback */
        }
        if (!helper || !ticket || !bound)
          throw new ProvenPreSendRefusalError(
            "BB reviewer continuation waits: the current run callback helper or ticket is unavailable",
          );
        callback = { helper, ticket };
      }
      const prompt = operatorReviewContinuationPrompt(
        sendTask,
        sendRun,
        sendCheckpoint,
        authorization,
        reviewContinuationLimit(this.store),
        callback,
      );
      adapterInvoked = true;
      const result = await continueReviewer(
        sendTask,
        sendRun,
        deliveryId,
        prompt,
        allowed,
        stillAllowed,
      );
      if (!result.sent) {
        adapterRefused = true;
        this.settleReviewDelivery(
          sendRun.id,
          deliveryId,
          "refused",
          result.reason,
        );
        throw new ProvenPreSendRefusalError(result.reason);
      }
      this.settleReviewDelivery(
        sendRun.id,
        deliveryId,
        "delivered",
        `Host accepted message ${deliveryId}`,
      );
      return this.store.task(task.id);
    } catch (error) {
      if (!adapterInvoked || adapterRefused) {
        if (reservedRunId)
          this.settleReviewDelivery(
            reservedRunId,
            deliveryId,
            "refused",
            String(error),
          );
        throw error instanceof ProvenPreSendRefusalError
          ? error
          : new ProvenPreSendRefusalError(
              error instanceof Error ? error.message : String(error),
            );
      }
      // Even a transport exception can follow a successful remote enqueue.
      // Marking uncertain is durable; operation replay will inspect evidence only.
      this.settleReviewDelivery(
        reservedRunId!,
        deliveryId,
        "uncertain",
        String(error).slice(0, 1600),
      );
      throw new Error(
        `Reviewer delivery ${deliveryId} has an uncertain send outcome; inspect the same reviewer thread, never resend (${String(error).slice(0, 500)})`,
      );
    }
  }

  /** Record the adapter's answer for the exact send this continuation reserved. */
  settleReviewDelivery(
    runId: string,
    deliveryId: string,
    status: ReviewDeliveryAuthorization["status"],
    evidence: string,
  ) {
    this.store.transaction(() => {
      const run = this.store.run(runId);
      if (!run)
        throw new Error(
          "Reviewer run disappeared while settling its delivery intent",
        );
      const deliveries = [...(run.reviewDeliveries ?? [])],
        index = deliveries.findIndex((item) => item.deliveryId === deliveryId);
      if (index < 0)
        throw new Error(
          "Reviewer delivery intent disappeared before settlement",
        );
      const previous = deliveries[index];
      if (previous.status === "delivered" || previous.status === "refused" || previous.status === status) return;
      deliveries[index] = {
        ...previous,
        status,
        evidence: evidence.slice(0, 2000),
        observedAt: now(),
      };
      const repin =
        status === "delivered" &&
        previous.briefVersion !== null
          ? { briefVersion: previous.briefVersion }
          : {};
      const current = this.store.task(run.taskId);
      const resumed =
        status === "delivered" &&
        run.status === "stopped" &&
        !run.completion &&
        !run.released &&
        current.resolution.currentRunId === run.id;
      this.store.putRun({
        ...run,
        ...(resumed ? { status: "running" as const } : {}),
        reviewDeliveries: deliveries,
        ...repin,
      });
      const reason =
        status === "uncertain"
          ? reviewDeliveryReason(deliveryId, "uncertain")
          : status === "delivered"
            ? reviewContinuationWait(current, this.store).reason
            : `Reviewer delivery ${deliveryId} was refused before send: ${evidence.slice(0, 600)}`;
      if (
        current.reasonFact?.code === "review_delivery" &&
        current.reasonFact.subject === deliveryId
      )
        this.store.update(
          current.id,
          { reason, ...stopClearedPatch(this.store.task(current.id), reason) },
          `review_delivery_${status}`,
          `${deliveryId}: ${evidence.slice(0, 1200)}`,
        );
      else
        this.store.event(
          current.id,
          `review_delivery_${status}`,
          `${deliveryId}: ${evidence.slice(0, 1200)}`,
        );
    });
  }

  reviewContinuationGate(
    input: {
      taskId: string;
      version: number;
      runId: string;
      head: string;
      checkpointOrdinal: number;
    },
    expectedVersion: number,
    operationId: string,
    options: { settle?: { runIds: string[]; displacedRunIds?: string[] } } = {},
  ) {
    const task = this.store.task(input.taskId),
      run = this.store.run(input.runId);
    if (task.removedAt || task.version !== expectedVersion)
      throw new TaskChangedRefusal(
        "Task changed; refresh before continuing reviewer progress",
        expectedVersion,
        task.version,
      );
    // Every unreleased run the settling transition displaces is as settled as a
    // finished one for this gate: the continuation's own transaction releases it.
    const settling = options.settle
      ? {
          runIds: [
            ...options.settle.runIds,
            ...(options.settle.displacedRunIds ?? []),
          ],
        }
      : undefined;
    const local = reviewContinuationLocalRefusal(this.store, task, run, input, {
      settling,
      paused: this.resolution.paused(),
      ownerStopYields:
        (input as { ownerStopYields?: boolean }).ownerStopYields === true,
      provenance: (current, record) =>
        this.resolution.assertReviewCheckpointProvenance(current, run!, record),
    });
    if ("refusal" in local) throw new Error(local.refusal);
    this.resolution.assertReviewProfileIndependent(task, run!);
    return {
      task,
      run: run!,
      record: local.record,
      briefVersion: local.briefVersion,
      resumeStop: local.resumeStop,
    };
  }

  /** Recheck the exact authenticated receipt and owner-only checkpoint file. */
  assertReviewCheckpointProvenance(
    task: Task,
    run: Run,
    record: ReviewCheckpointRecord,
  ): string {
    const refusal = reviewCheckpointRefusal(this.store, task, run, record);
    if (refusal) throw new Error(refusal);
    return record.eventId!;
  }

  assertIdleReviewerObservation(
    task: Task,
    run: Run,
    observed: AgentObservation,
  ) {
    // A closed session is a positive terminal observation, not a busy reviewer:
    // the same-run continuation can never land on it, and the supported recovery
    // is the existing fresh reviewer (restart role=reviewer fresh) at the
    // same exact head. An errored agent with no active turn and no pending
    // permission is the same dead weight, so it takes the same exit with its
    // own reason (matchingInactiveParticipant admits error wherever it admits
    // closed).
    if (matchingInactiveParticipant(run, observed, ["closed"]))
      throw new Error(
        observed.status === "error"
          ? REVIEW_AGENT_ERRORED
          : REVIEW_AGENT_CLOSED,
      );
    if (!matchingInactiveParticipant(run, observed, ["idle"]))
      throw new Error(
        "The original reviewer is active, initializing, closed, unavailable or awaiting permission; no delivery was sent",
      );
    if (!run.profile || reviewerRuntimeChanged(run.profile, observed))
      throw new Error(
        "The original reviewer workspace/model is unknown or changed; no delivery was sent",
      );
  }
}
