import { budgetOutageIntervals } from "../scheduling/host-outage";
import type { Profile, Run, Task } from "../../shared/contracts";
import {
  isDispositionActive,
  workerExclusionRefusal,
} from "../../shared/contracts";
import { budgetPauseDetail, taskBudget } from "../../shared/task-budget";
import {
  revisionAllowanceExhausted,
  revisionCapHoldDetail,
} from "../../shared/task-activity";
import {
  escalationWaitDetail,
  findOpenPlannerEscalation,
  revisionCapCauseId,
  revisionCapEscalationQuestion,
  type LadderEvent,
} from "../questions/ladder";
import { proofExecutor } from "../recovery/task-reasons";
import { dispatchBlocked, DISPATCH_HELD_REASON } from "./capacity";
import {
  proofSingleFlightRefusal,
  ProofSingleFlightError,
} from "../qa/proof-admission";
import {
  reviewAuthorizationRequired,
  reviewContinuationWait,
} from "../review/review-continuation";
import type { ProofActivation, Resolution } from "../resolution";
import { RunLaunchSource } from "./run-launch/source";
import { RunLaunchThread } from "./run-launch/thread";
import { RunLaunchReserve } from "./run-launch/reserve";
import { RunLaunchDeliver } from "./run-launch/deliver";

export type LaunchSourceContext = Pick<
  Resolution,
  | "adapter"
  | "bindReportedHeadForReview"
  | "continuedPrBinding"
  | "continuedProgressWait"
  | "ordinaryRoundCustody"
  | "paused"
  | "preferredHostKindsForTask"
  | "profiles"
  | "retainedWorkerProfileIssue"
  | "selectLaunchThread"
  | "store"
  | "update"
  | "usageCeilingNote"
  | "waiting"
  | "workerContinuation"
  | "workerHostCatalogs"
>;
export type LaunchThreadContext = Pick<
  Resolution,
  | "adapter"
  | "assertReviewProfileIndependent"
  | "attention"
  | "authorAgentIds"
  | "host"
  | "openPlannerEscalation"
  | "orphanRuns"
  | "paused"
  | "profiles"
  | "requiredRouteNote"
  | "reserveLaunchRun"
  | "resolveWithdrawnPending"
  | "retainedProfileIssue"
  | "reviewerCapabilityIssue"
  | "select"
  | "retainedRouteIssue"
  | "store"
  | "update"
  | "usageCeilingNote"
  | "waiting"
>;
export type LaunchReserveContext = Pick<
  Resolution,
  | "adapter"
  | "advanceAttempt"
  | "bindContinuedPrInTx"
  | "continuedProgressWait"
  | "deliverLaunchRun"
  | "launchingRuns"
  | "ordinaryReviewRuns"
  | "paused"
  | "progressEffectsPending"
  | "recordCriticalReviewFallback"
  | "retryContext"
  | "reviewerSetting"
  | "slotAdmissionReason"
  | "store"
  | "supersedeOrphans"
  | "update"
  | "waiting"
>;
export type LaunchDeliverContext = Pick<
  Resolution,
  | "adapter"
  | "assertReviewProfileIndependent"
  | "clearHostReadTransient"
  | "ensureIncident"
  | "ordinaryReviewRuns"
  | "ordinaryRoundCustody"
  | "paused"
  | "store"
  | "update"
  | "waiting"
>;
export type DispatchLaunchContext = Pick<
  Resolution,
  | "catalogKnown"
  | "claimIntegrationTurn"
  | "extendTaskBudgetAutomatically"
  | "launch"
  | "lease"
  | "leaseDeclineText"
  | "openPlannerEscalation"
  | "paused"
  | "responsibleJointQuestion"
  | "retireGoneRetainedWorker"
  | "slotAdmissionReason"
  | "startsNoRuns"
  | "store"
  | "waiting"
> & { pauseForPrerequisiteWait(task: Task): boolean } & LaunchSourceContext &
  LaunchThreadContext &
  LaunchReserveContext &
  LaunchDeliverContext;

/** Dispatch sequencing with live adapter and shell delegates supplied at composition. */
export class DispatchLaunch {
  readonly source = new RunLaunchSource(this.context);
  readonly thread = new RunLaunchThread(this.context);
  readonly reserve = new RunLaunchReserve(this.context);
  readonly deliver = new RunLaunchDeliver(this.context);
  constructor(readonly context: DispatchLaunchContext) {}
  /**
   * A revision launch held at the cap goes straight to the planner ladder, as the
   * cap park does: it joins the cap's open escalation, or opens a new occurrence of
   * it when the last one was settled without a round. The escalated stop is a
   * waiting stop, so no coordinator is launched for a decision only the planner
   * can make.
   */
  private holdAtRevisionCap(task: Task): void {
    const store = this.context.store;
    const revisionRuns = task.resolution.revisionRuns;
    const cause = revisionCapCauseId(task.id, revisionRuns);
    const open = findOpenPlannerEscalation(store.eventsAll(task.id) as LadderEvent[], cause);
    if (open) {
      if (task.resolution.stop?.reason !== "escalated")
        this.context.waiting(
          task,
          `${escalationWaitDetail.planner(open.id)}; reported cause: ${revisionCapHoldDetail(task)}`,
          "escalated",
        );
      return;
    }
    const findings =
      store.runs(task.id).findLast((run) => run.role === "reviewer" && run.completion?.status === "changes_required")
        ?.completion?.summary ?? "not recorded";
    const question = revisionCapEscalationQuestion(task, revisionRuns, findings);
    this.context.openPlannerEscalation(task, {
      cause,
      runId: null,
      question,
      payload: { cause, runId: null, revisionCap: revisionRuns, question },
      causeDetail: revisionCapHoldDetail(task),
    });
  }
  async launch(
    t: Task,
    role: Run["role"],
    options: {
      profile?: Profile;
      instruction?: string;
      proof?: ProofActivation;
    } = {},
  ) {
    // The manual verification coordinator is retired (Spec 058 cutover 2): no
    // path may create a verification run again. Stored rows keep parsing.
    if (role === "verification")
      throw new Error(
        "The manual verification coordinator is retired; no verification run is launched",
      );
    // An unloaded catalog is unknown availability: wait for the first refresh
    // instead of parking the retained profile as unavailable (consumer #660).
    if (!this.context.catalogKnown()) {
      this.context.waiting(
        t,
        "Waiting for the daemon profile catalog to load after service start",
        "lifecycle",
      );
      return;
    }
    // Spec 058 budgets: a task over either limit starts no new run. The pause is
    // a stop the operator answers; the run in flight, if any, already finished.
    // Spec 068 Decision 1: the first spend is extended once by Nucleus itself, so
    // only a second spend stops here and asks.
    {
      const measure = () => {
        const current = this.context.store.task(t.id);
        return taskBudget(
          current,
          this.context.store.runs(t.id),
          Date.now(),
          this.context.store.eventsAll(t.id),
          this.context.store.canonicalRepository(
            current.repoPath,
            current.repository,
          ),
          budgetOutageIntervals(this.context.store, current.hostId),
        );
      };
      let budget = measure();
      if (
        budget.exhausted &&
        this.context.extendTaskBudgetAutomatically(t.id)
      ) {
        t = this.context.store.task(t.id);
        budget = measure();
      }
      if (budget.exhausted) {
        this.context.waiting(t, budgetPauseDetail(budget), "budget");
        return;
      }
    }
    // Spec 058 revision cap: the one enforcement point. A revision launch past the
    // cap holds, however the task reached changes_requested (phase.set, an orphan
    // readmission or a verb), until an author round starts or a planner, the
    // operator or a delegated answer accepts one (`revisionAllowanceExhausted`).
    if (role === "revision") {
      const current = this.context.store.task(t.id);
      if (
        revisionAllowanceExhausted(
          current,
          this.context.store.runs(t.id),
          this.context.store.eventsAll(t.id),
        )
      ) {
        this.holdAtRevisionCap(current);
        return;
      }
    }
    if (
      reviewAuthorizationRequired(
        this.context.store.task(t.id),
        this.context.store,
      )
    ) {
      const wait = reviewContinuationWait(
        this.context.store.task(t.id),
        this.context.store,
      );
      this.context.waiting(t, wait.reason, wait.stop);
      return;
    }
    if (isDispositionActive(t))
      throw new Error(
        "Disposition fence is active; no replacement runs are launched",
      );
    if (
      (role === "reviewer" || role === "revision" || proofExecutor(role)) &&
      dispatchBlocked(t)
    ) {
      this.context.waiting(t, DISPATCH_HELD_REASON, "held");
      return;
    }
    if (
      (role === "reviewer" || role === "revision" || proofExecutor(role)) &&
      this.context.pauseForPrerequisiteWait(t)
    )
      return;
    // Spec 068 §3: a retained worker whose thread its host positively reports
    // gone can never take this revision. Retire it with that proof, so the
    // revision continues on a fresh worker instead of waiting on the dead thread.
    if (role === "revision" && t.agentId)
      await this.context.retireGoneRetainedWorker?.(t);
    t = this.context.store.task(t.id);
    // A stale pending Nucleus question found at dispatch is resolved, not
    // waited on (papercut ee9fc161): a withdrawn question never stalls the
    // launch behind the participant lease. The helper records a short
    // resolving wait when it sends a dismiss or cancel; the next pass
    // launches once the host clears the stale request.
    if (
      (role === "revision" || role === "reviewer") &&
      (await this.context.resolveWithdrawnPending(t))
    )
      return;
    if (role === "closeout" && !this.context.claimIntegrationTurn(t)) return;
    t = this.context.store.task(t.id);
    if (
      !(await this.context.lease(t, (agentId, state) => {
        // Every role's lease decline is a visible wait (nucleus#1100): name the
        // participant that still owns work, its owner and the verbs that exit the
        // wait, so a launch that starts nothing never reads as success. The
        // participant lease no longer polls runs whose completion is recorded;
        // their remaining fences record their own waits.
        if (!this.context.paused())
          this.context.waiting(
            t,
            this.context.leaseDeclineText(t, agentId, state),
            "lifecycle",
          );
      })) ||
      this.context.startsNoRuns()
    )
      return;
    const admissionWait = this.context.slotAdmissionReason(t);
    if (admissionWait) {
      this.context.waiting(t, admissionWait, "capacity");
      return;
    }
    if (role === "revision") {
      if (await this.context.responsibleJointQuestion(t)) return;
    }
    if (role === "revision") {
      // One refusal text for a durable worker exclusion: shared/task-view.ts owns
      // it, the reservation reads the same rule inside its transaction.
      const exclusion = workerExclusionRefusal(t, t.agentId, t.profile?.id);
      if (exclusion) {
        if (!t.failoverReason)
          this.context.store.update(
            t.id,
            { failoverReason: exclusion },
            "excluded_worker_revision_refused",
            exclusion,
          );
        return;
      }
    }
    return await this.source.prepareLaunchSource(t, role, options);
  }
  /**
   * Task 405: one owner-activated author-side proof execution. It reuses the
   * ordinary dispatch funnel (forge identity, source proof, profile selection,
   * slot admission, lease, agent creation) and refuses when no executor was
   * actually reserved, so a capacity or profile wait never silently strands an
   * activation that already recorded the allowance.
   */
  async proofExecution(
    t: Task,
    activation: ProofActivation,
    profile?: Profile,
  ): Promise<Task> {
    // Task 560: single-flight before the funnel. The reservation transaction
    // below re-checks authoritatively; this fast refusal keeps a second
    // trigger from ever reaching the adapter call.
    const current = this.context.store.task(t.id);
    const head = current.proofOnly?.commit ?? current.prHead;
    if (head) {
      const refusal = proofSingleFlightRefusal(
        current,
        this.context.store.runs(t.id),
        head,
      );
      if (refusal) throw new ProofSingleFlightError(refusal);
    }
    await this.context.launch(t, "executor", {
      proof: activation,
      ...(profile ? { profile } : {}),
    });
    const after = this.context.store.task(t.id);
    const run = after.resolution.currentRunId
      ? this.context.store.run(after.resolution.currentRunId)
      : null;
    if (!run || run.role !== "executor")
      throw new Error(`Proof execution was not dispatched: ${after.reason}`);
    return after;
  }
}
