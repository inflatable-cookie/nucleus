import { admitPhaseFacts } from "../../scheduling/phase-latency";
import type { LaunchReserveContext } from "../launch";
import type { Run, Task } from "../../../shared/contracts";
import {
  isDispositionActive,
  workerExclusionRefusal,
} from "../../../shared/contracts";
import { dispatchBlocked, DISPATCH_HELD_REASON } from "../capacity";
import { blockingRecoveryEffectsRefusal } from "../../recovery/recovery-effects";
import {
  proofSingleFlightRefusal,
  ProofSingleFlightError,
} from "../../qa/proof-admission";
import { proofExecutor } from "../../recovery/task-reasons";
import type {
  ReservationOptions,
  ReservationSelection,
  ReservationSource,
} from "./reservation-source";

/** What the admission re-checks and records inside one transaction. */
export interface ReservationAdmission {
  task: Task;
  role: Run["role"];
  run: Run;
  options: ReservationOptions;
  source: ReservationSource;
  selection: ReservationSelection;
  handoverReview: boolean;
}
/** A refused admission wrote nothing; an accepted one names the task it wrote and the runs it superseded. */
export type ReservationSettlement =
  | { reserved: false }
  | { reserved: true; task: Task; settled: string[] };

/**
 * The reservation transaction: every check the launch made outside is re-proved
 * against the current row here, then the run intent, credential, task update
 * and slot charge land together. A rival intent that landed first refuses here,
 * before anything is sent.
 */
export class RunReservationAdmission {
  constructor(readonly resolution: LaunchReserveContext) {}
  get store() {
    return this.resolution.store;
  }

  admit(input: ReservationAdmission): ReservationSettlement {
    const { role, run, options, source: s, selection } = input;
    const {
      agentId,
      profile,
      group,
      coordinatorRouteSwitch,
      replacingReviewer,
      orphanRuns,
      threadBusy,
    } = selection;
    let t = input.task;
    let settled: string[] = [];
    const reserved = this.store.transaction(() => {
      const latest = this.store.task(t.id);
      // Task 560: the durable single-flight reservation, first in the
      // transaction so a concurrent trigger that lost the race refuses with
      // this reason instead of a generic reservation-changed error. The run
      // intent below is recorded before the adapter call, so a rival intent
      // that landed first owns the task: this dispatch refuses here, before
      // anything is sent, whether the rival came from a restart, the advance
      // loop or a concurrent owner control.
      if (proofExecutor(role)) {
        const singleFlight = proofSingleFlightRefusal(
          latest,
          this.store.runs(t.id),
          run.head,
        );
        if (singleFlight) throw new ProofSingleFlightError(singleFlight);
      }
      if (
        input.handoverReview &&
        (latest.prHead !== run.head ||
          latest.directory !== t.directory ||
          latest.entrypoint !== "review")
      )
        throw Error(
          "The review source changed before the reviewer run was reserved; no reviewer was created",
        );
      if (
        run.ordinaryDetached &&
        (latest.version !== s.sourceVersion ||
          this.resolution.ordinaryReviewRuns(t.id) !== s.ordinaryRuns ||
          latest.prHead !== run.head ||
          dispatchBlocked(latest) ||
          isDispositionActive(latest))
      ) {
        this.resolution.waiting(
          latest,
          "Ordinary review source reservation changed during canonical admission; rechecking before dispatch",
          "lifecycle",
        );
        return false;
      }

      if (
        latest.resolution.currentRunId !== t.resolution.currentRunId ||
        (agentId && threadBusy(agentId))
      )
        return false;
      if (
        coordinatorRouteSwitch &&
        (latest.coordinatorGeneration !== t.coordinatorGeneration ||
          latest.coordinatorAgentId !== t.coordinatorAgentId ||
          JSON.stringify(latest.profileRequests?.coordinator) !==
            JSON.stringify(t.profileRequests?.coordinator))
      )
        return false;
      if (
        (role === "reviewer" || role === "revision" || proofExecutor(role)) &&
        dispatchBlocked(latest)
      ) {
        this.resolution.waiting(latest, DISPATCH_HELD_REASON, "held");
        return false;
      }
      if (
        proofExecutor(role) &&
        (latest.version !== s.sourceVersion ||
          JSON.stringify(this.store.runs(t.id)) !== s.sourceRuns ||
          (latest.proofOnly ? latest.proofOnly.commit : latest.prHead) !==
            run.head ||
          latest.proofExecution?.selector !== run.proofExecution?.selector ||
          latest.proofExecution?.inputs?.join(",") !==
            run.proofExecution?.inputs?.join(","))
      )
        throw Error(
          "Proof-execution source or brief reservation changed during admission",
        );
      if (role === "revision") {
        const exclusion = workerExclusionRefusal(latest, agentId, profile?.id);
        if (exclusion) {
          if (!latest.failoverReason)
            this.store.update(
              latest.id,
              { failoverReason: exclusion },
              "excluded_worker_revision_refused",
              exclusion,
            );
          return false;
        }
      }
      const latestWait = this.resolution.slotAdmissionReason(latest);
      if (latestWait) {
        this.resolution.waiting(latest, latestWait, "capacity");
        return false;
      }
      const decided = s.source.continuedPr?.decided;
      if (
        s.source.continuedPr?.progressRunId &&
        (this.resolution.progressEffectsPending(latest) ||
          this.resolution.paused())
      ) {
        const effectWait = blockingRecoveryEffectsRefusal(this.store, latest, {
          noticeKinds: "all",
        });
        this.resolution.waiting(
          latest,
          `Retained progress continuation waits: ${effectWait ?? "operations, hooks or notices are unsettled"}`,
          "lifecycle",
        );
        return false;
      }
      if (
        s.source.continuedPr &&
        (!decided ||
          latest.version !== decided.version ||
          JSON.stringify(this.store.runs(t.id)) !== decided.runs ||
          !this.resolution.bindContinuedPrInTx(
            t.id,
            s.source.continuedPr,
            `revision dispatch ${run.id}`,
          ))
      )
        return false;
      if (agentId)
        settled = this.resolution.supersedeOrphans(t.id, orphanRuns(agentId));
      // Replace the deferred coordinator binding and advance its callback fence
      // atomically with the new run. The live predecessor kept its generation
      // until release; the replacement task and run must now agree.
      if (coordinatorRouteSwitch)
        run.generation = latest.coordinatorGeneration + 1;
      this.store.setCredential(run.id, s.token);
      this.store.putRun(run);
      const dispatchReason =
        role === "revision" && s.revisionCause === "non_delivery"
          ? "Dispatching non-delivery follow-up; it does not consume a semantic revision round"
          : role === "revision" && s.revisionCause === "unfinished"
            ? "Dispatching unfinished-work follow-up; it does not consume a semantic revision round"
            : role === "revision" && s.revisionCause === "consult"
              ? "Dispatching reviewer-consult continuation with its advice; it does not consume a semantic revision round"
              : `Dispatching ${role}`;
      if (role === "reviewer" && !agentId && profile && !options.profile)
        t = this.resolution.recordCriticalReviewFallback(
          this.store.task(t.id),
          profile,
        );
      this.resolution.update(
        t,
        {
          currentRunId: run.id,
          stalledTurnStop: null,
          restartSlotHold: null,
          ...(role === "reviewer" && run.reviewReason
            ? { pendingReviewReason: null }
            : {}),
          ...(role === "reviewer" && run.proofRetry
            ? { proofRetry: null }
            : {}),
          ...(role === "revision"
            ? {
                pendingWorkerInstruction: null,
                revisionRuns:
                  t.resolution.revisionRuns + (s.countsReviewRound ? 1 : 0),
                ...(s.reviewEventId
                  ? { countedReviewEventId: s.reviewEventId }
                  : {}),
                revisionResumeUnpublished: false,
                pendingRevisionCause: null,
                ...(s.pendingPrePrInstruction
                  ? { prePrResumeInstruction: null }
                  : {}),
                ...(s.pendingInstruction
                  ? {
                      revisionInstruction: {
                        ...s.pendingInstruction,
                        runId: run.id,
                      },
                    }
                  : {}),
              }
            : {}),
          ...(replacingReviewer
            ? {
                reviewerAgentId: null,
                reviewerProfile: null,
                review: null,
                roleReplacements: t.resolution.roleReplacements + 1,
              }
            : {}),
        },
        {
          phase:
            role === "reviewer"
              ? "reviewing"
              : role === "revision"
                ? "changes_requested"
                : proofExecutor(role)
                  ? t.phase
                  : "closing",
          reason: dispatchReason,
          ...(role === "revision"
            ? {
                stashBaseline: s.stash
                  ? { runId: run.id, entries: s.stash }
                  : null,
              }
            : {}),
          ...(coordinatorRouteSwitch
            ? { coordinatorAgentId: "", coordinatorGeneration: run.generation }
            : {}),
        },
        "run_intent",
      );
      admitPhaseFacts(this.store, t.id);
      if (replacingReviewer)
        this.store.event(
          t.id,
          "role_replacement",
          `reviewer: retained profile unavailable; replacement ${profile!.name || profile!.id}`,
        );
      if (group) this.store.chargeAssignment(group, profile!.id);
      return true;
    });
    return reserved
      ? { reserved: true, task: t, settled }
      : { reserved: false };
  }
}
