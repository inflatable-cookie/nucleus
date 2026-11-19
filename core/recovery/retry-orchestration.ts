import type { Resolution } from "../resolution";
import { now } from "../store/store";
import {
  runHoldsSlot,
  type Completion,
  type Run,
  type Task,
} from "../../shared/contracts";
import { occupiesSlot } from "../dispatch/capacity";
import {
  RetainedRunRefusal,
  ACCEPTED_PR_RECONCILIATION_REASON,
  NO_RESOLUTION_ACTION,
  OPERATOR_WORKER_REMAP_REASON,
  readyReviewAtHead,
} from "./task-reasons";
import {
  reviewAuthorizationRequired,
  REVIEW_AUTHORIZATION_REQUIRED,
} from "../review/review-continuation";
import { RETAINED_PREREQUISITE_REFUSAL } from "../verbs/verb-refusal-text";
import { pidAlive } from "../machine/process-identity";
import { taskHasPr } from "../forge/index";
import {
  blockedRetryRoute,
  retryAdmission,
  retryRoute,
  retrySpecialRoute,
  revisionRoute,
  resumeRoute,
} from "./retry-routes";
import {
  acceptedReviewAtUnchangedHead,
  retainedWorkerAdvancedReviewHead,
  retainedWorkerRemap,
  stoppedRevisionWithoutCallback,
} from "./retry-evidence";

/** Where a restart sends a parked task. */
export type RetryRoutesContext = Pick<
  Resolution,
  | "adapter"
  | "closeout"
  | "operatorReturn"
  | "retainedWorkerProfileIssue"
  | "retry"
  | "reviewContinuationOwner"
  | "settleVerbFences"
  | "store"
  | "update"
  | "validationAlive"
>;

/**
 * Applies retry decisions in one order: authorization, admission, retained-run
 * reconciliation, then exactly one route (a special branch, a remap, a revision,
 * a worker resume, the accepted-PR reconciliation, a blocked result's route,
 * closeout or an ordinary resolution check). The decisions themselves are in
 * `retry-routes` and the recorded evidence in `retry-evidence`, so this class
 * reads no store fact to decide where a retry goes and holds no second copy of
 * any rule.
 */
export class RetryRoutes {
  constructor(readonly resolution: RetryRoutesContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }

  /**
   * The continuation a replacement worker resumes: a fresh owner instruction,
   * else the latest pending one, the last worker request, the review or the
   * last result (consumer-b #181: a stale pending one never wins over a fresh one).
   */
  workerContinuation(t: Task, instruction?: string): string {
    const pendingWorkerEvent = this.store
      .events(t.id)
      .find((event) =>
        ["worker_resume_requested", "revision_requested"].includes(event.kind),
      );
    const priorEvent =
      pendingWorkerEvent &&
      !/^(?:Operator-directed resume returned|Recovery-directed resume returned)/.test(
        pendingWorkerEvent.detail,
      )
        ? pendingWorkerEvent.detail.replace(/^Worker action requested:\s*/, "")
        : null;
    return (
      instruction?.trim() ||
      t.resolution.pendingWorkerInstruction ||
      t.resolution.prePrResumeInstruction ||
      priorEvent ||
      t.resolution.review?.summary ||
      t.completion?.summary ||
      "Continue the existing task under the approved instruction"
    );
  }

  private retainedWorkerRemap(t: Task) {
    return retainedWorkerRemap(
      this.store,
      t,
      this.resolution.retainedWorkerProfileIssue(t),
    );
  }

  /** Spec 044 / project-a #1863: the accepted review still at the task PR head, if any. */
  acceptedReviewAtUnchangedHead(t: Task): Completion | null {
    return acceptedReviewAtUnchangedHead(this.store, t);
  }

  /** Project-a #1900: the head the retained worker advanced after that accepted review. */
  retainedWorkerAdvancedReviewHead(
    t: Task,
  ): { review: Completion; head: string } | null {
    return retainedWorkerAdvancedReviewHead(this.store, t);
  }

  retry(
    t: Task,
    revise = false,
    instruction?: string,
    operator = false,
    resumeUnpublished = false,
    prePr = false,
    scopedInstruction?: string,
    reviewerInstruction?: string,
  ) {
    return this.prepareRetry(
      t,
      revise,
      instruction,
      operator,
      resumeUnpublished,
      prePr,
      scopedInstruction,
      reviewerInstruction,
    )();
  }

  prepareRetry(
    t: Task,
    revise = false,
    instruction?: string,
    operator = false,
    resumeUnpublished = false,
    prePr = false,
    scopedInstruction?: string,
    reviewerInstruction?: string,
    settleRunIds: string[] = [],
  ): () => Task {
    if (
      reviewAuthorizationRequired(this.store.task(t.id), this.store) &&
      !operator
    )
      throw new Error(REVIEW_AUTHORIZATION_REQUIRED);
    const admission = retryAdmission(t, {
      stage: "instruction",
      revise,
      operator,
      instruction,
      reviewerInstruction,
      remap: Boolean(
        !revise &&
          instruction !== undefined &&
          operator &&
          this.retainedWorkerRemap(t),
      ),
    });
    if (admission) throw new Error(admission);
    const allRuns = this.store
        .runs(t.id)
        .map((run) =>
          settleRunIds.includes(run.id) ? { ...run, released: true } : run,
        ),
      runs = allRuns.filter((r) => r.role !== "recovery");
    if (allRuns.some((r) => !r.released)) {
      const stopped = stoppedRevisionWithoutCallback(t, allRuns);
      if (!stopped || !this.resolution.validationAlive(t))
        throw new RetainedRunRefusal(
          "Resolve the retained thread or uncertain delivery first; no prompt will be resent blindly",
        );
      // A restart of a stopped identity confirmation keeps the read-only intent
      // that run was reserved for; it never becomes an implementation revision.
      const resumeIntent =
        resumeUnpublished || Boolean(stopped.identityConfirmation);
      this.prepareRetry(
        {
          ...t,
          resolution: { ...t.resolution, currentRunId: null, attention: false },
        },
        revise,
        instruction,
        operator,
        resumeIntent,
        prePr,
        scopedInstruction,
        reviewerInstruction,
        [...settleRunIds, stopped.id],
      );
      return () =>
        this.resolution.retry(
          this.releaseStoppedRevision(t, stopped),
          revise,
          instruction,
          operator,
          resumeIntent,
          prePr,
          scopedInstruction,
          reviewerInstruction,
        );
    }
    if (t.resolution.mergedCommit) {
      if (revise || instruction !== undefined || reviewerInstruction !== undefined)
        throw new Error('The task PR has merged; there is no worker or reviewer instruction to deliver');
      const refresh = retryRoute(t, runs, false) === 'closeout';
      return () => this.resolution.closeout.continueRecordedMerge(this.store.task(t.id), { kind: 'retry', refresh });
    }
    if (reviewerInstruction !== undefined) {
      const refusal = retryAdmission(t, {
        stage: "reviewer-delivery",
        revise,
        operator,
        instruction,
        reviewerInstruction,
        remap: Boolean(this.retainedWorkerRemap(t)),
      });
      if (refusal) throw new Error(refusal);
    }
    const mergeRoute = retrySpecialRoute(t, "merge", operator, revise, null);
    if (typeof mergeRoute === "object") throw new Error(mergeRoute.refuse);
    if (mergeRoute === "merge") {
      return () =>
        this.resolution.update(
          t,
          { attention: false },
          {
            phase: "merging",
            reason: "Operator requested another read-only merge outcome check",
          },
          "uncertain_merge_operator_retry",
        );
    }
    const acceptedRevision = t.resolution.currentRunId
      ? this.store.run(t.resolution.currentRunId)
      : null;
    const staleRevisionHead =
      retrySpecialRoute(t, "revision", operator, revise, acceptedRevision) ===
      "revision";
    if (staleRevisionHead) {
      return () =>
        this.resolution.update(
          t,
          {
            attention: false,
            integrationTurn: null,
            pendingWorkerInstruction:
              acceptedRevision!.instruction ??
              acceptedRevision!.completion!.summary,
          },
          {
            phase: "changes_requested",
            reason:
              "Reconciling accepted revision completion at the current PR head",
          },
          "revision_completion_retry",
        );
    }
    const heldRun = t.resolution.currentRunId
      ? this.store.run(t.resolution.currentRunId)
      : null;
    const acceptedHookRetry =
      retrySpecialRoute(t, "hook", operator, revise, heldRun) === "hook";
    if (acceptedHookRetry) {
      return () =>
        this.resolution.update(
          t,
          {
            currentRunId: null,
            attention: false,
            mechanicalVerification: null,
            integrationTurn: null,
          },
          {
            phase: "verifying",
            reason:
              "Operator requested pre-merge re-evaluation at the accepted reviewed head",
          },
          "pre_merge_retry_requested",
        );
    }
    const remap = operator ? this.retainedWorkerRemap(t) : null;
    if (remap) {
      const { retainedWorkerIssue } = remap;
      // An operator's fresh instruction wins over the last pending one, which can be stale
      // (consumer-b #181, 2026-09-28: a spent device-flow instruction became the continuation).
      const pending = this.workerContinuation(t, instruction);
      const failoverReason =
        `${OPERATOR_WORKER_REMAP_REASON} (${retainedWorkerIssue}). Continue the existing task: ${pending}`.slice(
          0,
          2000,
        );
      return () =>
        this.resolution.update(
          t,
          {
            currentRunId: null,
            attention: false,
            integrationTurn: null,
            recoveryActive: false,
            recoveryAttempts: 0,
            recovery: null,
            pendingWorkerInstruction: pending,
          },
          {
            phase: "changes_requested",
            failoverReason,
            replacementProfile: t.replacementProfile ?? null,
            reason:
              "Operator-approved worker remap; selecting an eligible replacement",
          },
          "worker_remap_requested",
        );
    }
    const profileRoute = retrySpecialRoute(
      t,
      "profile",
      operator,
      revise,
      null,
    );
    if (typeof profileRoute === "object") throw new Error(profileRoute.refuse);
    if (profileRoute === "profile") {
      const prior = this.store
        .runs(t.id)
        .filter((run) => run.role === "revision")
        .at(-1);
      return () =>
        this.resolution.update(
          t,
          {
            currentRunId: null,
            attention: false,
            integrationTurn: null,
            pendingWorkerInstruction:
              t.resolution.pendingWorkerInstruction ??
              prior?.instruction ??
              t.resolution.review?.summary ??
              "Continue the existing task under the approved instruction",
          },
          {
            phase: "changes_requested",
            reason:
              "Operator requested retained worker profile eligibility recheck",
          },
          "retained_worker_retry",
        );
    }
    const route = retryRoute(t, runs, revise);
    if (route === "revision") {
      const options = {
        instruction,
        scopedInstruction,
        operator,
        prePr,
        resumeUnpublished,
        reviewOwner: Boolean(this.resolution.reviewContinuationOwner(t)),
      };
      let decision = revisionRoute(t, runs, options);
      if (decision.kind === "need-time")
        decision = revisionRoute(t, runs, { ...options, createdAt: now() });
      if (decision.kind === "refuse") throw new Error(decision.message);
      if (decision.kind !== "revision")
        throw new Error("Revision time did not settle");
      return () =>
        decision.via === "operator"
          ? this.resolution.operatorReturn(
              t,
              decision.changes,
              decision.patch,
              decision.event,
              "Operator-directed revision returned the retained worker to work",
              decision.patch.reason,
            )
          : this.resolution.update(
              t,
              decision.changes,
              decision.patch,
              decision.event,
            );
    }
    if (route === "worker") {
      // Spec 058 task 577: a stopped pre-callback worker resumes on its
      // retained thread; Queue never replaces it without a failure or an
      // approved model change. The continuation is the recorded pending
      // instruction or the task's own continuation.
      const action =
        instruction?.trim() ||
        t.resolution.pendingWorkerInstruction ||
        t.resolution.prePrResumeInstruction ||
        this.workerContinuation(t);
      const changes = {
        currentRunId: null,
        review: null,
        attention: false,
        integrationTurn: null,
        stalledTurnStop: null,
        prePrResumeInstruction: action,
        pendingWorkerInstruction: action,
      };
      return () =>
        operator
          ? this.resolution.operatorReturn(
              t,
              changes,
              { phase: "changes_requested", reason: action },
              "worker_resume_requested",
              "Operator-directed resume returned the retained worker to work",
              `Worker action requested: ${action}`,
            )
          : this.resolution.update(
              t,
              { ...changes, recoveryAttempts: 0, recoveryActive: false },
              { phase: "changes_requested", reason: action },
              "worker_resume_requested",
            );
    }
    // project-a #1672: coordinator retry of revision-budget exhaustion with a ready_for_review
    // completion at the accepted PR used to skip this path (operator-only) and throw
    // NO_RESOLUTION_ACTION. An owner's parked restart takes this same reconciliation
    // to awaiting_review.
    if (route === "accepted-pr") {
      const reviewed = readyReviewAtHead(t);
      // The reconciliation that ends in awaiting_review must carry the reviewer instruction too;
      // otherwise the fresh reviewer is dispatched with an empty reviewReason (project-a #1897).
      const pendingReview =
        !reviewed && reviewerInstruction !== undefined
          ? { pendingReviewReason: reviewerInstruction }
          : {};
      return () =>
        reviewed
          ? this.resolution.update(
              t,
              {
                attention: false,
                mechanicalVerification: null,
                integrationTurn: null,
              },
              {
                phase: "verifying",
                reason: `${operator ? "Operator" : "Coordinator"} requested pre-merge re-evaluation at the accepted reviewed head`,
              },
              "pre_merge_retry_requested",
            )
          : this.resolution.update(
              t,
              { attention: false, ...pendingReview },
              { reason: ACCEPTED_PR_RECONCILIATION_REASON },
              "task_workspace_recovery_requested",
            );
    }
    if (route === "blocked") {
      // Read exact-head evidence only for the reviewer-instruction route that needs it.
      let decision = blockedRetryRoute(
        t,
        runs,
        reviewerInstruction,
        false,
        null,
      );
      if (decision.kind === "needs-review-evidence") {
        const accepted = Boolean(this.acceptedReviewAtUnchangedHead(t));
        const advanced = accepted
          ? null
          : this.retainedWorkerAdvancedReviewHead(t);
        decision = blockedRetryRoute(
          t,
          runs,
          reviewerInstruction,
          accepted,
          advanced?.head ?? null,
        );
      }
      if (decision.kind === "refuse") throw new Error(decision.message);
      if (decision.kind !== "route")
        throw new Error(
          "A reviewer instruction requires a blocked or errored reviewer result that returns the task to review",
        );
      const { phase, reconciledReviewHead } = decision;
      // An operator retry answers the escalation, so it ends that recovery episode: the next,
      // unrelated fault gets its own coordinator budget. Carrying it over escalated a later
      // reviewer crash with no coordinator at all (project-a #1655, 2026-09-28).
      const episodeEnd = operator
        ? { recoveryActive: false, recoveryAttempts: 0, recovery: null }
        : {};
      const pendingReview =
        reviewerInstruction !== undefined
          ? { pendingReviewReason: reviewerInstruction }
          : {};
      const explicitContinuation =
        t.resolution.pendingWorkerInstruction ??
        t.resolution.prePrResumeInstruction ??
        (t.resolution.revisionInstruction?.runId === null
          ? t.resolution.revisionInstruction.text
          : null);
      const retryContinuation =
        phase === "changes_requested"
          ? (explicitContinuation ??
            "Continue the existing task under its current approved instruction source and within its approved scope.")
          : null;
      return () => {
        if (reconciledReviewHead)
          this.store.event(
            t.id,
            "review_head_reconciled",
            `Reviewer instruction returned the task to review at the retained worker's pushed head ${reconciledReviewHead} (accepted review ${t.resolution.review?.head ?? "unknown"}); recorded without reset or history rewrite`,
          );
        return this.resolution.update(
          t,
          {
            currentRunId: null,
            attention: false,
            integrationTurn: null,
            ...episodeEnd,
            ...pendingReview,
            // A blocked result is routing/diagnostic evidence. It must not replace a pending
            // explicit continuation or become the next run's authorized action by itself.
            ...(retryContinuation
              ? { pendingWorkerInstruction: retryContinuation }
              : {}),
          },
          {
            phase,
            reason: "Retry requested after resolving the blocker",
            ...(reconciledReviewHead ? { prHead: reconciledReviewHead } : {}),
          },
          "resolution_retry",
        );
      };
    }
    if (route === "no-action") throw new Error(NO_RESOLUTION_ACTION);
    // A held project validation is a failure to run, not a verdict. The gate reuses a settled
    // result for the same candidate so automatic passes never loop; an operator retry clears a
    // hold so the validation actually runs again.
    // A running record whose process is gone (or was never recorded) is lost with a restart; an
    // operator retry clears it too. A live process keeps it: its result is still coming.
    const heldOrLost =
      t.resolution.projectValidation?.state === "hold" ||
      (t.resolution.projectValidation?.state === "running" &&
        !(
          t.resolution.projectValidation.pid &&
          pidAlive(t.resolution.projectValidation.pid)
        ));
    const rerunHeldValidation = operator && heldOrLost;
    return () =>
      this.resolution.update(
        t,
        {
          attention: false,
          ...(rerunHeldValidation ? { projectValidation: null } : {}),
          ...(t.resolution.mergeIntent
            ? {}
            : { integrationTurn: null }),
        },
        { reason: "Resolution check retry requested" },
        "resolution_retry",
      );
  }

  resumeWorkerContinuation(
    t: Task,
    operator: boolean,
    continueWorker: (task: Task) => Task,
  ): Task {
    const apply = () => {
      let current = this.store.task(t.id);
      if (current.prerequisiteWait && !current.prerequisiteWait.releasedAt)
        throw new Error(RETAINED_PREREQUISITE_REFUSAL);
      const continued = continueWorker(current);
      current = this.store.task(t.id);
      if (current.prerequisiteWait?.releasedAt)
        return this.store.update(
          current.id,
          { prerequisiteWait: null },
          "prerequisite_wait_resumed",
          `${operator ? "Operator" : "Recovery"} explicitly resumed the task after the prerequisite notice`,
        );
      return continued;
    };
    return this.store.db.isTransaction
      ? apply()
      : this.store.transaction(apply);
  }

  resumeWorker(t: Task, instruction: string, operator = false) {
    return this.prepareResumeWorker(t, instruction, operator)();
  }

  prepareResumeWorker(
    t: Task,
    instruction: string,
    operator = false,
    settleRunIds: string[] = [],
  ): () => Task {
    if (this.resolution.reviewContinuationOwner(t))
      throw new Error(
        "A reviewer continuation owns this task; wait for its verdict or resolve the reviewer thread instead of returning the task to the worker",
      );
    if (t.prerequisiteWait && !t.prerequisiteWait.releasedAt)
      throw new Error(RETAINED_PREREQUISITE_REFUSAL);
    const runs = this.store
      .runs(t.id)
      .map((run) =>
        settleRunIds.includes(run.id) ? { ...run, released: true } : run,
      );
    const stoppedRevision = stoppedRevisionWithoutCallback(t, runs);
    let decision = resumeRoute(
      t,
      runs,
      instruction,
      operator,
      stoppedRevision,
      undefined,
    );
    if (decision.kind === "check-validation")
      decision = resumeRoute(
        t,
        runs,
        instruction,
        operator,
        stoppedRevision,
        Boolean(this.resolution.validationAlive(t)),
      );
    if (decision.kind === "refuse") throw new Error(decision.message);
    if (decision.kind === "stopped") {
      const hasPr = taskHasPr(t);
      const resumeIntent = Boolean(decision.run.identityConfirmation);
      this.prepareRetry(
        {
          ...t,
          resolution: { ...t.resolution, currentRunId: null, attention: false },
        },
        true,
        instruction,
        operator,
        resumeIntent,
        !hasPr,
        undefined,
        undefined,
        [...settleRunIds, decision.run.id],
      );
      return () =>
        this.resumeWorkerContinuation(
          this.releaseStoppedRevision(t, decision.run),
          operator,
          (current) =>
            this.resolution.retry(
              current,
              true,
              instruction,
              operator,
              resumeIntent,
              !hasPr,
            ),
        );
    }
    if (decision.kind !== "resume")
      throw new Error("Worker resume validation did not settle");
    const action = decision.action;
    const changes = {
      currentRunId: null,
      review: null,
      attention: false,
      integrationTurn: null,
      stalledTurnStop: null,
      prePrResumeInstruction: action,
      pendingWorkerInstruction: action,
    };
    return () =>
      this.resumeWorkerContinuation(t, operator, (current) =>
        operator
          ? this.resolution.operatorReturn(
              current,
              changes,
              { phase: "changes_requested", reason: action },
              "worker_resume_requested",
              "Operator-directed resume returned the retained worker to work",
              `Worker action requested: ${action}`,
            )
          : this.resolution.update(
              current,
              { ...changes, recoveryAttempts: 0, recoveryActive: false },
              { phase: "changes_requested", reason: action },
              "worker_resume_requested",
            ),
      );
  }

  private releaseStoppedRevision(t: Task, run: Run): Task {
    const apply = () => {
      this.adapter.purgeReportingFiles?.(t.id, [run.id]);
      this.store.deleteCredential(run.id);
      this.store.putRun({ ...run, status: "superseded", released: true });
      return this.resolution.update(
        t,
        { currentRunId: null, attention: false },
        {},
        "stopped_revision_released_for_live_validation",
      );
    };
    return this.store.db.isTransaction
      ? apply()
      : this.store.transaction(apply);
  }

  /**
   * Spec 050 `restart`: release one retained stopped revision run and hand the
   * same retained worker a continuation, without requiring the escalated
   * missing-callback recovery record the narrow control needed first. The
   * caller has already observed the retained worker stopped.
   */
  admitStoppedRevision(
    t: Task,
    instruction: string,
    prePr: boolean,
    settleRunIds: string[] = [],
  ): Run {
    const runs = this.store
      .runs(t.id)
      .map((run) =>
        settleRunIds.includes(run.id) ? { ...run, released: true } : run,
      );
    const stopped =
      stoppedRevisionWithoutCallback(t, runs) ??
      runs.findLast(
        (run) =>
          run.role === "revision" &&
          !run.completion &&
          !run.released &&
          run.agentId === t.agentId &&
          run.workspaceId === t.workspaceId,
      ) ??
      null;
    if (!stopped)
      throw new Error("No retained stopped revision run to restart");
    // The read-only identity confirmation re-arms as the same intent; an ordinary
    // stopped revision keeps implementation authority.
    const resumeIntent = Boolean(stopped.identityConfirmation);
    this.prepareRetry(
      {
        ...t,
        resolution: {
          ...t.resolution,
          currentRunId: null,
          attention: false,
          recoveryActive: false,
          recovery: null,
          stalledTurnStop: null,
        },
      },
      true,
      instruction,
      true,
      resumeIntent,
      prePr,
      undefined,
      undefined,
      [...settleRunIds, stopped.id],
    );
    return stopped;
  }

  restartStoppedRevision(
    t: Task,
    instruction: string,
    prePr: boolean,
    settleFences?: {
      detail: string;
      runIds: string[];
      displacedRunIds?: string[];
    },
  ): Task {
    return this.store.transaction(() => {
      // Spec 050 (#3569): the restart settles its armed fences atomically with
      // the restart; a refusal inside rolls both back.
      const before = this.store.task(t.id);
      const occupying = occupiesSlot(before, this.store.runs(t.id));
      const holdFrom =
        this.store.runs(t.id).find(runHoldsSlot)?.id ??
        before.resolution.currentRunId ??
        before.runId;
      if (settleFences) this.resolution.settleVerbFences(t.id, settleFences);
      const stopped = this.admitStoppedRevision(
        this.store.task(t.id),
        instruction,
        prePr,
      );
      const resumeIntent = Boolean(stopped.identityConfirmation);
      this.adapter.purgeReportingFiles?.(t.id, [stopped.id]);
      this.store.deleteCredential(stopped.id);
      this.store.putRun({
        ...stopped,
        status: "superseded",
        released: true,
        active: false,
      });
      const current = this.store.task(t.id);
      this.resolution.update(
        current,
        {
          currentRunId: null,
          attention: false,
          recoveryActive: false,
          recovery: null,
          stalledTurnStop: null,
        },
        {},
        "stopped_revision_restarted",
      );
      const continued = this.resolution.retry(
        this.store.task(t.id),
        true,
        instruction,
        true,
        resumeIntent,
        prePr,
      );
      return occupying && holdFrom && !continued.resolution.restartSlotHold
        ? this.resolution.update(
            continued,
            {
              restartSlotHold: {
                role: "worker",
                at: now(),
                fromRunId: holdFrom,
              },
            },
            {},
            "restart_worker_slot_hold",
          )
        : continued;
    });
  }
}
