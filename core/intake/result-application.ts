import { propagateQuantumDeferral } from "../scheduling/pass-snapshot";
import { settleReportedReviewerTurn } from "./reported-turn";
import { isDeepStrictEqual } from "node:util";
import { resultApplied, recordResultApplied } from "./applied-result";
import {
  REVISION_BUDGET,
  awaitingProofRoute,
  awaitingProofText,
  awaitingProofTexts,
  holdsOf,
  isDispositionActive,
  type AwaitingProof,
  type Completion,
  type Run,
  type Task,
} from "../../shared/contracts";
import {
  authorModelKey,
  queueAuthorModelKey,
  taskAuthorModelKeys,
} from "../../shared/authors";
import {
  escalationWaitDetail,
  plannerEscalations,
  reviewerConsults,
  revisionCapCauseId,
  revisionCapEscalationQuestion,
  type LadderEvent,
} from "../questions/ladder";
import {
  MERGE_CONFLICT_REASON,
  isCanonicalPrSource,
  isFailedChecksReason,
  isForgeCheckProofText,
  taskPrNumber,
  type PublicationOutcome,
  type ReviewerSetting,
  type VerifiedPr,
} from "../forge/index";
import {
  classifyGitTransientFailure,
  gitDeliveryUnknown,
  ReviewPublicationTransientError,
} from "../forge/forge-health";
import { WorkerSourceRefusal } from "../git/index";
import { reattachStoredTaskCheckout } from "../git/checkout-reattach";
import { hookHoldReason } from "../hooks/hooks";
import {
  consecutiveNonDeliveries,
  continuationInstruction,
  unfinishedContinuationEvents,
} from "../recovery/non-delivery";
import { automaticRetryForbidden } from "../../shared/automatic-retry";
import { runBindsCurrentWork } from "../../shared/task-view";
import {
  assertOrdinaryReviewIdentity,
  ordinaryReviewSource,
} from "../review/ordinary-review";
import { ProofExecutionRefusal } from "../qa/proof-refusal";
import { verifyProofSource } from "../qa/proof-source";
import { proofWorkerRequests } from "../qa/proof-wait";
import type { Resolution } from "../resolution";
import {
  classifyReviewPublication,
  recordedPublicationId,
  retainReviewPublication,
  reviewPublicationKey,
  reviewVerdictApplied,
} from "../review/review-publication";
import { reviewerSettingOf } from "../review/reviewer-setting";
import { reviewRecordFor } from "../review/review-verdicts";
import { digest, now, type Store } from "../store/store";
import {
  coordinative,
  proofExecutor,
} from "../recovery/task-reasons";
import {
  observationAdvanceSince,
  runsUnchangedSince,
} from "../recovery/observation-advance";
import {
  isOwnerRoutedReviewer,
  reviewerIndependence,
} from "../dispatch/routing";
import {
  escalationWaitState,
  type EscalationWait,
} from "../questions/ladder/hold";
import { closeEscalationFollowups } from "../questions/ladder/continuation";
import { matchingInactiveParticipant } from "./run-settlement";
import { settlementHeld } from "../closeout/queue-drain";
import { reviewInProgress } from "../review/review-continuation";
import { settleProofExecution, type ProofOutcome } from "./proof-settlement";
import { settleReportReady } from "./report-ready";
import { openHostOutage } from "../scheduling/host-outage";

/** Publication may add an ID after the authenticated callback was received. */
function authenticatedReviewResult(
  store: ResultApplicationContext["store"],
  taskId: string,
  completion: Completion,
): boolean {
  const receipt = store.db
    .prepare(
      "SELECT hash,response FROM receipts WHERE id=? AND task=? AND run=?",
    )
    .get(completion.eventId, taskId, completion.runId) as
    | { hash: string; response: string }
    | undefined;
  const {
    reviewId: _reviewId,
    reviewCommentId: _reviewCommentId,
    ...withoutPublication
  } = completion;
  let accepted = false;
  try {
    accepted = JSON.parse(receipt?.response ?? "null")?.accepted === true;
  } catch {
    return false;
  }
  return Boolean(
    receipt &&
      accepted &&
      [
        completion,
        withoutPublication,
        {
          ...withoutPublication,
          ...(completion.reviewId !== undefined
            ? { reviewId: completion.reviewId }
            : {}),
        },
        {
          ...withoutPublication,
          ...(completion.reviewCommentId !== undefined
            ? { reviewCommentId: completion.reviewCommentId }
            : {}),
        },
      ].some((value) => receipt.hash === digest(JSON.stringify(value))),
  );
}

type PublishedReview = {
  kind: "ready";
  run: Run;
  completion: Completion;
  prNumber: number;
  reviewer: ReviewerSetting | null;
  publicationId: number;
  settledWaits: { id: string; resolved: boolean }[];
  settlesIncident: boolean;
};
type PublishedReviewDecision =
  | PublishedReview
  | { kind: "none" }
  /**
   * `permanent`: no later fact can make this run's report apply (it was
   * published in a form the repository's policy refuses, or its reviewer
   * authored the work). Every other refusal waits on its named owner.
   */
  | { kind: "blocked"; refusal: string; permanent?: undefined }
  | { kind: "blocked"; refusal: string; permanent: true; run: Run };
type PublishedReviewApplication =
  | { kind: "applied" }
  | { kind: "blocked"; refusal: string };
type ReviewVerdictAdmission =
  | { refusal: string; independence?: true }
  | { current: Task; latestRun: Run; runs: Run[] };
type ReviewVerification =
  | {
      kind: "published";
      admit: () => PublishedReview | { kind: "blocked"; refusal: string };
    }
  | { kind: "ordinary"; reviewer: ReviewerSetting | null; id: number | void };

function reviewDispatchRefusal(hold: { owner: string; reason: string }): string {
  return `Dispatch is held by ${hold.owner}: ${hold.reason}. Its owner must release the hold`;
}

function hasPublicationEvidence(store: Store, run: Run): boolean {
  return (
    run.completion?.reviewId != null ||
    run.completion?.reviewCommentId != null ||
    recordedPublicationId(store, run.id, "review") !== null ||
    recordedPublicationId(store, run.id, "comment") !== null
  );
}

/** Check stored authorship before sending or adopting a forge review. */
function recordedReviewIndependence(
  task: Task,
  run: Run,
  runs: readonly Run[],
): { permanent: boolean; refusal: string } | null {
  const revisions = runs.filter((candidate) => candidate.role === "revision");
  const external = task.resolution.externalOwnerRevisions ?? [];
  if (
    run.agentId &&
    [
      task.agentId,
      ...task.retiredWorkers.map((worker) => worker.agentId),
      ...revisions.map((revision) => revision.agentId),
      ...task.proofExecutions.map((proof) => proof.agentId),
      ...(external.length ? [task.originAgentId] : []),
      ...external.flatMap((receipt) => [
        receipt.actor.agentId,
        receipt.ownerScope?.ownerAgentId,
      ]),
    ].includes(run.agentId)
  )
    return {
      permanent: true,
      refusal: "The reviewer authored this task. The review lifecycle owner must establish independent review",
    };
  if (!run.profile) return null;
  const authors = taskAuthorModelKeys(task, revisions);
  const currentAuthor = queueAuthorModelKey(task);
  const requested = task.profileRequests?.reviewer;
  const independence = reviewerIndependence({
    site: "verify",
    authors,
    currentAuthorModels:
      currentAuthor === null ? authors : new Set([currentAuthor]),
    reviewerModel: authorModelKey(run.profile.model),
    namedRequired:
      requested?.required === true && requested.profileId === run.profile.id,
    ownerRouted: isOwnerRoutedReviewer(task, run.profile.id),
  });
  return independence === "collision"
    ? {
        permanent: false,
        refusal: "The recorded models conflict with the review independence policy. The review lifecycle owner must reconcile them",
      }
    : null;
}

/** Read the ladder's durable wait records, including the format used before stop fields were recorded. */
function reviewLadderWait(
  store: Store,
  task: Task,
): {
  refusal: string | null;
  settledStop: boolean;
  settledWaits: PublishedReview["settledWaits"];
} {
  const events = store.eventsAll(task.id);
  const waits = new Map<string, (typeof events)[number]>();
  const settled = new Set<string>();
  const settledWaits: PublishedReview["settledWaits"] = [];
  let settledStop = false;
  for (const event of events) {
    if (event.kind === "planner_escalation_wait")
      waits.set(event.detail.split(":", 1)[0]!, event);
  }
  for (const [id, event] of waits) {
    const afterWait = events.filter(
      (later) => later.id > event.id && later.detail.startsWith(`${id}:`),
    );
    const retired = afterWait.some((later) =>
      [
        "planner_escalation_woke",
        "planner_escalation_wait_superseded",
      ].includes(later.kind),
    );
    const resolved = afterWait.some(
      (later) => later.kind === "planner_escalation_resolved",
    );
    let wait: EscalationWait | null = null;
    try {
      wait = JSON.parse(event.detail.slice(id.length + 2));
    } catch {
      /* unreadable wait stays for its owner */
    }
    const due = wait?.kind === "time" && Date.parse(wait.target) <= Date.now();
    if (!retired && !resolved && !due)
      return {
        refusal: `The planner ladder still owns escalation ${id}'s wait`,
        settledStop,
        settledWaits,
      };
    if (!retired) {
      settledWaits.push({ id, resolved });
      settled.add(id);
    }
    if (wait?.kind === "time" || wait?.kind === "decision") {
      const { stopReason } = escalationWaitState(id, wait);
      settledStop ||=
        task.resolution.stop?.reason === stopReason &&
        task.resolution.stop.fact?.subject === id;
    }
  }
  const open = plannerEscalations(events).find(
    (item) => !item.answered && !settled.has(item.id),
  );
  const consult = reviewerConsults(events).findLast(
    (item) => !item.answered && !item.unknown,
  );
  return {
    refusal: open
      ? `The planner ladder still owns escalation ${open.id}`
      : consult
        ? escalationWaitDetail.reviewer(consult.id)
        : null,
    settledStop,
    settledWaits,
  };
}

/** The stored admission for a published verdict. All three entry points use this read. */
export function publishedReviewDecision(
  store: Store,
  task: Task,
): PublishedReviewDecision {
  // Receipt-only qualification and review of a recorded external merge keep their own lifecycle.
  if (
    task.entrypoint === "proof" ||
    task.resolution.unreviewedMerge ||
    task.removedAt ||
    (!task.resolution.currentRunId &&
      (!task.resolution.reviewerAgentId || !task.prHead)) ||
    task.resolution.mergedCommit ||
    ["done", "cancelled"].includes(task.phase)
  )
    return { kind: "none" };
  const runs = store.runs(task.id);
  const { currentRunId, reviewerAgentId, incident, recovery, stop } =
    task.resolution;
  const latestReader = runs.findLast((run) => run.role === "reviewer");
  const run = currentRunId
    ? runs.find((item) => item.id === currentRunId)
    : latestReader;
  if (
    !run ||
    run.role !== "reviewer" ||
    !run.released ||
    run.status !== "finished" ||
    run.replacedAt ||
    !run.completion ||
    !["ready_to_merge", "changes_required"].includes(run.completion.status) ||
    (!currentRunId &&
      (run.head !== task.prHead || run.agentId !== reviewerAgentId)) ||
    resultApplied(store, task.id, run.id) ||
    (!currentRunId && task.resolution.review?.runId === run.id) ||
    !hasPublicationEvidence(store, run)
  )
    return { kind: "none" };

  const blocked = (refusal: string): PublishedReviewDecision => ({
    kind: "blocked",
    refusal,
  });
  const refusedForever = (refusal: string): PublishedReviewDecision => ({
    kind: "blocked",
    refusal,
    permanent: true,
    run,
  });
  const later = runs.slice(runs.indexOf(run) + 1).find(
    (item) =>
      item.role === "revision" ||
      (item.role === "reviewer" &&
        // Re-adoption binds the result as current and settles the reportless
        // replacement. Its history cannot block publication reconciliation.
        !(
          currentRunId === run.id &&
          item.released &&
          !item.completion &&
          item.status === "superseded"
        )),
  );
  if (later)
    return blocked(
      `The ${later.role} run ${later.id} is newer than this verdict. The retained participants own the current source`,
    );
  const c = run.completion;
  const prNumber =
    task.reviewEntry?.prNumber ??
    task.resumePrNumber ??
    task.completion?.prNumber;
  if (
    !prNumber ||
    !task.prUrl?.endsWith(`/pull/${prNumber}`) ||
    !task.prHead ||
    run.head !== task.prHead ||
    c.head !== run.head ||
    (c.prNumber !== undefined && c.prNumber !== prNumber)
  )
    return blocked(
      "The forge and task owner must reconcile the canonical PR and exact verdict head",
    );
  if (
    run.taskId !== task.id ||
    c.taskId !== task.id ||
    c.runId !== run.id ||
    !run.agentId ||
    run.agentId !== reviewerAgentId ||
    !task.workspaceId ||
    run.workspaceId !== task.workspaceId ||
    (run.hostId && run.hostId !== task.hostId) ||
    (run.profile &&
      task.resolution.reviewerProfile &&
      run.profile.id !== task.resolution.reviewerProfile.id)
  )
    return blocked(
      "The retained reviewer run, host or workspace binding changed. The review lifecycle owner must reconcile it",
    );

  const independence = recordedReviewIndependence(task, run, runs);
  if (independence)
    return independence.permanent
      ? refusedForever(independence.refusal)
      : blocked(independence.refusal);
  if (!authenticatedReviewResult(store, task.id, c))
    return blocked(
      "Callback intake has no authenticated accepted receipt for this verdict",
    );

  const reviewer = reviewerSettingOf(store, task);
  const kind = reviewer ? "review" : "comment";
  const id = reviewer ? c.reviewId : c.reviewCommentId;
  const otherId = reviewer ? c.reviewCommentId : c.reviewId;
  // Publication writes its ID before intake enriches the completion. The receipt
  // still authenticates the original completion across that crash boundary.
  const publicationId = id ?? recordedPublicationId(store, run.id, kind);
  if (
    otherId != null ||
    typeof publicationId !== "number" ||
    !Number.isSafeInteger(publicationId) ||
    publicationId <= 0
  )
    // The report carries only the other publication form (or an invalid ID), and
    // Nucleus publishes only from an unpublished report: no later fact gives it one.
    return refusedForever(
      `Review publication must prove a ${kind} ID under the current repository policy`,
    );
  const completion =
    id === publicationId
      ? c
      : reviewer
        ? { ...c, reviewId: publicationId }
        : { ...c, reviewCommentId: publicationId };
  if (store.getMeta(reviewPublicationKey(run.id)) != null) {
    const publication = classifyReviewPublication(store, task, {
      ...run,
      completion,
    });
    if (publication.state !== "settled")
      return blocked(
        `Review publication must reconcile its evidence: ${publication.reason}`,
      );
  }

  if (isDispositionActive(task) || task.resolution.mergeIntent)
    return blocked("The disposition or merge owner still owns this task");
  const { dispatch: hold, merge: mergeHold } = holdsOf(task);
  if (hold) return blocked(reviewDispatchRefusal(hold));
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
    return blocked("The prerequisite wait owner must release the task");
  // Spec 069 §3: the host wait is read from the host's open outage record; a
  // wait an older service stored on the row still holds until it is settled.
  const waitingHost =
    task.resolution.hostWait?.hostId ??
    (task.hostId && openHostOutage(store, task.hostId) ? task.hostId : null);
  if (waitingHost)
    return blocked(`The host observer must settle the wait for ${waitingHost}`);
  const ladder = reviewLadderWait(store, task);
  if (ladder.refusal) return blocked(ladder.refusal);

  const pendingRun = runs.find((item) => !item.released);
  if (pendingRun)
    return blocked(
      `The ${pendingRun.role} run ${pendingRun.id} still owns work. Its participant must settle before applying the verdict`,
    );
  const ownIncident =
    incident?.runId === run.id && incident.role === "reviewer";
  // A workspace or earlier-run incident is obsolete once the work it named
  // released or the initial worker's ready report bound the PR. A separate
  // planner wait, stop or pending recovery action still has its own gate.
  const settlesIncident = Boolean(
    incident &&
      (ownIncident ||
        !runBindsCurrentWork(runs, incident.runId) ||
        (incident.runId === task.runId &&
          task.completion?.runId === incident.runId &&
          task.completion.status === "ready_for_review")),
  );
  if (
    task.resolution.recoveryActive ||
    recovery?.action?.status === "pending" ||
    (recovery &&
      recovery.status !== "resolved" &&
      (!settlesIncident || recovery.incidentId !== incident?.id))
  )
    return blocked(
      "The recovery owner must settle the current recovery episode",
    );
  if (incident && incident.status !== "resolved" && !settlesIncident)
    return blocked(
      `The recovery owner must settle the independent ${incident.role} incident ${incident.id}`,
    );
  const stall = task.resolution.stalledTurnStop;
  if (task.pausedStop || (stall && stall.status !== "completed"))
    return blocked(
      "The stop owner must settle the outstanding participant stop",
    );
  const ownStop =
    ownIncident &&
    stop &&
    !stop.holderAgentId &&
    stop.incidentId === incident.id;
  if (
    stop &&
    !ladder.settledStop &&
    ![
      "lifecycle",
      "external_unavailable",
      "capacity",
      "route_unavailable",
      "provider_unavailable",
    ].includes(stop.reason) &&
    !(stop.reason === "held" && mergeHold) &&
    !(ownStop && ["operator_needed", "run_stalled"].includes(stop.reason))
  )
    return blocked(
      `The ${stop.holderAgentId ?? "stop owner"} must settle the ${stop.reason} stop: ${stop.detail}`,
    );
  return {
    kind: "ready",
    run,
    completion,
    prNumber,
    reviewer,
    publicationId,
    settledWaits: ladder.settledWaits,
    settlesIncident,
  };
}

/**
 * Which owner advances one completed run, decided from its role alone. Every
 * other role is a closeout step; the manual verification coordinator is retired
 * (Spec 058 cutover 2) and its stored rows are refused rather than misread.
 */
export function advanceOwner(
  run: Pick<Run, "role">,
): "reviewer" | "revision" | "retired_verification" | "closeout" {
  if (run.role === "reviewer") return "reviewer";
  if (run.role === "revision") return "revision";
  if (run.role === "verification") return "retired_verification";
  return "closeout";
}

/** Apply a released result. */
export type ResultApplicationContext = Pick<
  Resolution,
  | "adapter"
  | "advanceCloseoutResult"
  | "attention"
  | "hooks"
  | "host"
  | "lease"
  | "leaseDeclineText"
  | "openPlannerEscalation"
  | "graceMs"
  | "onTaskHost"
  | "ordinaryRoundCustody"
  | "participantLease"
  | "recordBlockedPrIdentity"
  | "responsibleBlockerLadder"
  | "responsiblePrReportRefused"
  | "reviewerSetting"
  | "settleAttentionEpisode"
  | "settleAutomaticReplayHold"
  | "stopped"
  | "store"
  | "suppressAutomaticRetry"
  | "update"
  | "waiting"
>;

export class ResultApplication {
  constructor(readonly resolution: ResultApplicationContext) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  /**
   * A participant still in its turn holds a result's application, and that hold
   * is a visible wait like every launch's lease decline (nucleus#1100). Silent,
   * it left a released revision's ready result in changes_requested with no run,
   * stop or wait for 20 minutes while its worker's thread stayed active
   * (bovine-accelerator#6935, Spec 068 §4).
   */
  private leaseDeclineWait(taskId: string) {
    return (
      agentId: string,
      state: Parameters<ResultApplicationContext["leaseDeclineText"]>[2],
    ) => {
      if (settlementHeld(this.store, this.resolution.stopped())) return;
      const current = this.store.task(taskId);
      this.resolution.waiting(
        current,
        this.resolution.leaseDeclineText(current, agentId, state),
        "lifecycle",
      );
    };
  }
  /**
   * A reported verdict admission refuses forever stops governing the task. It is
   * never applied: the report is recorded as superseded, naming the refusal, and
   * the reviewer run releases its hold on the task (its binding and retained
   * reviewer), so the phase's ordinary next step admits a fresh reviewer whose
   * run records the repository's publication form. No verdict is accepted, so
   * merge still needs a valid exact-head review. Returns whether it superseded.
   */
  supersedeRefusedReport(task: Task, run: Run, refusal: string): boolean {
    return this.store.transaction(() => {
      const current = this.store.task(task.id);
      if (
        current.version !== task.version ||
        resultApplied(this.store, task.id, run.id)
      )
        return false;
      const { resolution } = current;
      const ownStop =
        resolution.stop?.reason === "lifecycle" &&
        resolution.stop.detail === refusal;
      this.resolution.update(
        current,
        {
          ...(resolution.currentRunId === run.id ? { currentRunId: null } : {}),
          ...(resolution.reviewerAgentId === run.agentId
            ? { reviewerAgentId: null, reviewerProfile: null }
            : {}),
          ...(ownStop ? { stop: null } : {}),
        },
        {},
        "reported_verdict_superseded",
        `${run.id} ${run.completion?.status ?? "report"} at ${run.head}: ${refusal}. The report is never applied; a fresh review is admitted`.slice(
          0,
          4000,
        ),
      );
      recordResultApplied(this.store, task.id, run.id);
      return true;
    });
  }
  /** Verify a recorded publication and commit its verdict, with no publish or dispatch. */
  async applyPublishedReview(
    t: Task,
    decision: PublishedReview,
  ): Promise<PublishedReviewApplication> {
    const { run, completion, reviewer, prNumber, publicationId } = decision;
    const runs = this.store.runs(t.id);
    const changed =
      "Task changed during published review verification. Read next again";
    const recheck = ():
      | { task: Task; decision: PublishedReview }
      | { refusal: string } => {
      const task = this.store.task(t.id);
      if (this.resolution.stopped())
        return { refusal: "The scheduler is stopped" };
      const current = publishedReviewDecision(this.store, task);
      if (current.kind === "blocked") return { refusal: current.refusal };
      if (
        current.kind !== "ready" ||
        !observationAdvanceSince(task, t.version) ||
        !runsUnchangedSince(runs, this.store.runs(t.id)) ||
        current.run.id !== run.id ||
        current.prNumber !== prNumber ||
        current.publicationId !== publicationId ||
        !isDeepStrictEqual(current.reviewer, reviewer) ||
        !isDeepStrictEqual(current.completion, completion)
      )
        return { refusal: changed };
      return { task, decision: current };
    };
    const blocked = (refusal: string) => ({
      kind: "blocked" as const,
      refusal,
    });
    const admitted = recheck();
    if ("refusal" in admitted) return blocked(admitted.refusal);
    const gate = this.reviewVerdictGate(t, run, completion, {
      reapplied: true,
      reviewer,
      published: true,
    });
    const verdict = gate.read();
    if ("refusal" in verdict) return blocked(verdict.refusal);
    const verifyReview = this.adapter.verifyReview;
    if (!verifyReview)
      return blocked(
        "The review lifecycle owner has no forge publication verifier on this host",
      );
    const verifyPr = this.adapter.verifyPrIdentity ?? this.adapter.verifyPr;
    const pr = await verifyPr.call(this.adapter, t, prNumber);
    if (!isCanonicalPrSource(pr, prNumber))
      return blocked(
        `The forge must prove the canonical source repository for PR #${prNumber}`,
      );
    if (pr.url !== t.prUrl || pr.head !== run.head)
      return blocked(
        "The forge reports a changed PR identity or head. Read next again",
      );
    const verifiedId = await verifyReview.call(
      this.adapter,
      t,
      run,
      completion,
      reviewer ?? undefined,
    );
    if (verifiedId !== undefined && verifiedId !== publicationId)
      return blocked(
        "The forge observed a different publication ID. The review publication owner must reconcile it",
      );

    const participants = new Map([
      [t.agentId, run.workspaceId],
      [run.agentId, run.workspaceId],
    ]);
    // Retained ordinary rounds keep the prior receipt and the exact source.
    if (run.ordinaryDetached) {
      const prior = runs.find((item) => item.id === run.priorRunId);
      if (
        !prior?.released ||
        prior.status !== "finished" ||
        prior.workspaceId !== run.workspaceId ||
        !prior.completion ||
        !authenticatedReviewResult(this.store, t.id, prior.completion)
      )
        return blocked(
          "The review lifecycle owner must prove custody from the preceding ordinary round",
        );
      if (this.adapter.observeParticipant) {
        if (!prior.explicitlyReleasedAt)
          participants.set(prior.agentId, prior.workspaceId);
        for (const worker of t.retiredWorkers) {
          const previous = runs.find((item) => item.id === worker.runId);
          if (!previous?.explicitlyReleasedAt && !participants.has(worker.agentId))
            participants.set(worker.agentId, previous?.workspaceId ?? run.workspaceId);
        }
      }
    }
    for (const [agentId, workspaceId] of participants) {
      if (!agentId) continue;
      if (this.adapter.observeParticipant) {
        const issue = await this.resolution.participantLease.exactCustodyIssue(
          t, agentId, workspaceId,
        );
        if (issue !== null) return blocked(`Retained participant ${agentId}: ${issue}`);
        continue;
      }
      const state = await this.resolution.host.observe(agentId);
      if (state.workspaceId !== run.workspaceId)
        return blocked(
          `Agent workspace changed; lease is not safe for retained participant ${agentId}`,
        );
      if (
        !matchingInactiveParticipant(
          { agentId, workspaceId: run.workspaceId },
          state,
        )
      )
        return blocked(
          `The retained participant ${agentId} must be observed idle and permission-free in its workspace`,
        );
    }
    if (run.ordinaryDetached) {
      // One reattach step returns a checkout an earlier round left detached to
      // its task branch before this pass proves the source and commits the
      // verdict: it moves no commit either way, and the proofs below require the
      // attached branch.
      await reattachStoredTaskCheckout(this.store, t.id, run.id);
      await ordinaryReviewSource(t, run.head);
      const custody = recheck();
      if ("refusal" in custody) return blocked(custody.refusal);
      assertOrdinaryReviewIdentity(this.store.task(t.id), run.head);
    }
    await gate.observe();
    return this.commitReviewerVerdict(t, run, completion, true, gate, {
      kind: "published",
      admit: () => {
        const boundary = recheck();
        if ("refusal" in boundary) return blocked(boundary.refusal);
        const settledId = retainReviewPublication(
          this.store,
          boundary.task,
          run,
          completion,
          reviewer,
          publicationId,
        );
        if (settledId !== publicationId)
          throw Error("Retained review publication changed during application");
        if (completion !== run.completion)
          this.store.putRun({ ...this.store.run(run.id)!, completion });
        for (const { id, resolved } of boundary.decision.settledWaits) {
          const detail = `${id}: completed wait retired with application of the published review`;
          this.store.event(t.id, "planner_escalation_wait_superseded", detail);
          if (!resolved)
            this.store.event(t.id, "planner_escalation_resolved", detail);
          closeEscalationFollowups(this.store, t.id, id);
        }
        return boundary.decision;
      },
    });
  }

  /** Published verdicts use current facts. Unpublished replay keeps its existing admission. */
  async reapplyPendingReview(t: Task): Promise<"none" | "applied" | "blocked"> {
    const published = publishedReviewDecision(this.store, t);
    if (published.kind === "blocked") return "blocked";
    if (published.kind === "ready")
      return (await this.applyPublishedReview(t, published)).kind;
    // An interrupted projection can retain the current round's authenticated
    // result on the task while its run still looks checkpointed. Restore that
    // result to ordinary release and intake; the checkpoint authorizes no send.
    const current = t.resolution.currentRunId
      ? this.store.run(t.resolution.currentRunId)
      : null;
    const saved = t.resolution.review;
    if (
      current &&
      reviewInProgress(current) &&
      saved &&
      saved.taskId === t.id &&
      saved.runId === current.id &&
      saved.head === current.head &&
      saved.head === t.prHead &&
      current.agentId === t.resolution.reviewerAgentId &&
      ["ready_to_merge", "changes_required", "blocked", "error"].includes(
        saved.status,
      ) &&
      authenticatedReviewResult(this.store, t.id, saved)
    ) {
      this.store.putRun({ ...current, completion: saved });
      this.store.event(t.id, "review_result_restored", current.id);
    }
    const runs = this.store.runs(t.id),
      events = this.store.eventsAll(t.id);
    const unappliedReview = runs.find((run) => {
      if (
        run.role !== "reviewer" ||
        !run.released ||
        run.status !== "finished" ||
        run.replacedAt ||
        !run.completion ||
        !["ready_to_merge", "changes_required"].includes(
          run.completion.status,
        ) ||
        (!t.resolution.unreviewedMerge &&
          t.entrypoint !== "proof" &&
          hasPublicationEvidence(this.store, run)) ||
        !run.agentId ||
        run.agentId !== t.resolution.reviewerAgentId ||
        run.completion.taskId !== t.id ||
        run.completion.runId !== run.id ||
        run.completion.head !== t.prHead ||
        run.head !== t.prHead ||
        runs
          .slice(runs.indexOf(run) + 1)
          .some(
            (later) =>
              later.role === "reviewer" &&
              later.agentId === run.agentId &&
              later.head === t.prHead,
          ) ||
        (t.resolution.currentRunId !== null &&
          t.resolution.currentRunId !== run.id) ||
        t.resolution.review?.runId === run.id ||
        events.some(
          (event) =>
            ["review_result_applied", "review_reapplied"].includes(
              event.kind,
            ) && event.detail === run.id,
        )
      )
        return false;
      return true;
    });
    if (!unappliedReview?.completion) return "none";
    const eligible = (() => {
      const reviewingSlot =
        t.phase === "reviewing" &&
        !t.resolution.attention &&
        t.resolution.currentRunId === null;
      const completion = unappliedReview.completion!;
      const publicationId = this.resolution.reviewerSetting(t)
        ? completion.reviewId
        : completion.reviewCommentId;
      const publicationEvent =
        publicationId === undefined
          ? null
          : events.find(
              (event) =>
                event.kind === "review_published" &&
                event.detail ===
                  `${this.resolution.reviewerSetting(t) ? "PR review" : "PR comment"} ${publicationId}`,
            );
      const incident = t.resolution.incident;
      const completedEvent = events.find(
        (event) =>
          ["run_completion", "run_completion_corrected"].includes(event.kind) &&
          event.detail === `${unappliedReview.role}: ${completion.summary}`,
      );
      const unresolvedPublication =
        !publicationEvent &&
        Boolean(this.store.getMeta(`reviewPublication:${unappliedReview.id}`));
      const unresolvedEscalation =
        !publicationEvent &&
        plannerEscalations(events as LadderEvent[])
          // An escalation raised for this same interrupted application is part
          // of its recovery path. A different unanswered planner question still
          // owns the task and must not be bypassed by replaying the verdict.
          .some(
            (escalation) =>
              !escalation.answered &&
              !escalation.unknown &&
              escalation.cause !== incident?.fingerprint,
          );
      const ownerStoppedRun = events.some(
        (event) =>
          event.kind === "owner_stopped" &&
          Date.parse(event.at) >= Date.parse(unappliedReview.createdAt),
      );
      const interruptedApplication =
        ["reviewing", "needs_attention"].includes(t.phase) &&
        (t.resolution.currentRunId === null ||
          t.resolution.currentRunId === unappliedReview.id) &&
        Boolean(
          incident?.runId === unappliedReview.id &&
            completedEvent &&
            Date.parse(incident.createdAt) >= Date.parse(completedEvent.at) &&
            (!publicationEvent ||
              Date.parse(incident.createdAt) >=
                Date.parse(publicationEvent.at)) &&
            !unresolvedPublication &&
            !unresolvedEscalation &&
            !ownerStoppedRun,
        );
      return reviewingSlot || interruptedApplication;
    })();
    if (!eligible) return "blocked";
    // This path can apply a finished callback before the ordinary run
    // reconciler. Keep the same participant lease in front of its transition.
    try {
      // This exact recovery episode was created by the interrupted review
      // application and will be fenced by that application. It no longer owns
      // work in this transition; all other live participants still need proof.
      const incident = t.resolution.incident;
      const recoveryRunId =
        incident?.runId === unappliedReview.id &&
        t.resolution.recovery?.incidentId === incident.id
          ? t.resolution.recovery.runId
          : null;
      const leased = await this.resolution.lease(
        t,
        this.leaseDeclineWait(t.id),
        recoveryRunId ?? undefined,
      );
      if (!leased || settlementHeld(this.store, this.resolution.stopped()))
        return "blocked";
    } catch (error) {
      propagateQuantumDeferral(error);
      this.resolution.attention(
        this.store.task(t.id),
        error instanceof Error ? error.message : String(error),
      );
      return "blocked";
    }
    const completion = unappliedReview.completion;
    if (!authenticatedReviewResult(this.store, t.id, completion))
      return "blocked";
    return (await this.advanceReviewerResult(
      t,
      unappliedReview,
      completion,
      true,
    ))
      ? "applied"
      : "blocked";
  }
  async advanceCompletedRun(t: Task, run: Run): Promise<void> {
    if (
      !run.released ||
      !run.completion ||
      resultApplied(this.store, t.id, run.id)
    )
      return;
    const published = publishedReviewDecision(
      this.store,
      this.store.task(t.id),
    );
    if (published.kind !== "none") {
      if (published.kind === "ready" && published.run.id === run.id)
        await this.applyPublishedReview(this.store.task(t.id), published);
      return;
    }
    let c = run.completion;
    if (run.ordinaryDetached) {
      // A pass that read this reviewer as current before another pass settled it
      // has nothing left to do, and must never stop a turn for it.
      if (
        run.role === "reviewer" &&
        this.store.task(t.id).resolution.currentRunId !== run.id
      )
        return;
      // Spec 068 §3: a reviewer that already reported owns no live work; its
      // leftover turn is driven to settlement instead of failing custody.
      if (
        (await settleReportedReviewerTurn(this.resolution, t, run)) ===
        "waiting"
      )
        return;
      await this.resolution.ordinaryRoundCustody(t, run, true);
      // The reattach step returns a checkout an earlier round left detached to
      // its task branch before this pass proves the source it advances: it moves
      // no commit, and the ordinary source proof requires the attached branch.
      await reattachStoredTaskCheckout(this.store, t.id, run.id);
      await ordinaryReviewSource(t, run.head);
      assertOrdinaryReviewIdentity(this.store.task(t.id), run.head);
    }
    // A pass that read this reviewer as current before another pass settled it
    // has nothing left to do, and must not clear whichever run is current now.
    if (
      run.role === "reviewer" &&
      this.store.task(t.id).resolution.currentRunId !== run.id
    )
      return;
    if (
      run.role === "reviewer" &&
      t.resolution.pendingRevisionCause === "continuation"
    )
      t = this.resolution.update(t, { pendingRevisionCause: null });
    if (
      coordinative(run) &&
      run.generation !== this.store.task(t.id).coordinatorGeneration
    ) {
      this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (
          latest.resolution.currentRunId !== run.id ||
          resultApplied(this.store, t.id, run.id)
        )
          return;
        this.resolution.update(latest, { currentRunId: null });
        recordResultApplied(this.store, t.id, run.id);
      });
      return;
    }
    if (proofExecutor(run.role)) {
      await this.advanceProofExecutionResult(t, run, c);
      return;
    }
    if (
      run.role === "reviewer" &&
      c.sourceApproved &&
      c.awaitingProofs?.length &&
      c.head === t.prHead
    ) {
      // Spec 058 (task 533): a responsible task sends each named proof to whoever can
      // produce it before any operator question: an author proof returns to the
      // author, an environment fault gets one clean retry, and only external proofs
      // park the wait.
      this.store.transaction(() => {
        const current = this.store.task(t.id);
        if (
          resultApplied(this.store, t.id, run.id) ||
          current.resolution.currentRunId !== run.id
        )
          return;
        this.routeAwaitingProofs(current, run, c);
        recordResultApplied(this.store, t.id, run.id);
      });
      return;
    }
    if (c.status === "blocked" || c.status === "error") {
      if (
        run.role === "revision" &&
        c.prNumber &&
        !t.prUrl &&
        !t.prHead &&
        !t.resumePrNumber
      )
        t = await this.resolution.recordBlockedPrIdentity(
          t,
          c.prNumber,
          "Blocked revision report",
        );
      if (
        resultApplied(this.store, t.id, run.id) ||
        this.store.task(t.id).resolution.currentRunId !== run.id
      )
        return;
      // Task 576: an unfinished revision return with new commits continues the same
      // round automatically, even past the revision count: it is progress inside an
      // owner-approved round, not a new review round, so it consumes no budget.
      // Each continuation dispatches a new revision at the new head, so this repeats
      // while every return shows new commits; a return with no progress falls
      // through to the #575 non-delivery path below.
      const unfinished =
        run.role === "revision"
          ? unfinishedContinuationEvents(this.store.eventsAll(t.id)).find(
              (item) => item.runId === run.id,
            )
          : undefined;
      if (unfinished) {
        const current = this.store.task(t.id);
        // Task 645: the owner's no-automatic-retry rule suppresses the
        // continuation and hands the kept result to the planner ladder.
        if (automaticRetryForbidden(current, this.store.runs(current.id))) {
          this.store.transaction(() => {
            const latest = this.store.task(t.id);
            if (
              resultApplied(this.store, t.id, run.id) ||
              latest.resolution.currentRunId !== run.id
            )
              return;
            this.resolution.update(
              latest,
              { currentRunId: null, integrationTurn: null },
              { phase: c.status as "blocked" | "error", reason: c.summary },
            );
            this.resolution.suppressAutomaticRetry(
              this.store.task(t.id),
              "unfinished",
              c.summary,
              run.id,
            );
            recordResultApplied(this.store, t.id, run.id);
          });
          return;
        }
        const instruction = continuationInstruction(unfinished);
        this.store.transaction(() => {
          const latest = this.store.task(t.id);
          if (
            resultApplied(this.store, t.id, run.id) ||
            latest.resolution.currentRunId !== run.id
          )
            return;
          const resolution = {
            ...latest.resolution,
            currentRunId: null,
            integrationTurn: null,
            attention: false,
            pendingRevisionCause: "unfinished" as const,
            pendingWorkerInstruction: instruction,
          };
          this.resolution.update(
            latest,
            resolution,
            { phase: "changes_requested", reason: instruction },
            "unfinished_pushback",
            `${run.id}: same retained worker continues the unfinished round`,
          );
          recordResultApplied(this.store, t.id, run.id);
        });
        return;
      }
      const nonDeliveries = consecutiveNonDeliveries(
        this.store.eventsAll(t.id),
      );
      const nonDelivery = nonDeliveries.find((item) => item.runId === run.id);
      if (nonDelivery && nonDeliveries.length <= 2) {
        const current = this.store.task(t.id);
        // Task 645: the owner's no-automatic-retry rule suppresses the
        // continuation and the provider-routed retry, and hands the kept
        // result to the planner ladder instead.
        if (automaticRetryForbidden(current, this.store.runs(current.id))) {
          this.store.transaction(() => {
            const latest = this.store.task(t.id);
            if (
              resultApplied(this.store, t.id, run.id) ||
              latest.resolution.currentRunId !== run.id
            )
              return;
            this.resolution.update(
              latest,
              { currentRunId: null, integrationTurn: null },
              { phase: c.status as "blocked" | "error", reason: c.summary },
            );
            this.resolution.suppressAutomaticRetry(
              this.store.task(t.id),
              "non_delivery",
              c.summary,
              run.id,
            );
            recordResultApplied(this.store, t.id, run.id);
          });
          return;
        }
        const second = nonDeliveries.length === 2;
        const instruction = second
          ? "Continue the approved task from the retained worktree and existing PR. The prior attempt reported no external blocker and produced no change; this attempt uses another eligible provider at the same capability. Decide within the brief, implement, and record decisions in the PR. Report blocked only for an external cause, naming it."
          : "You reported no external blocker and produced no change. Under the ownership rule, decide within the brief and implement; record decisions in the PR. Report blocked only for an external cause, naming it.";
        this.store.transaction(() => {
          const latest = this.store.task(t.id);
          if (
            resultApplied(this.store, t.id, run.id) ||
            latest.resolution.currentRunId !== run.id
          )
            return;
          const resolution = {
            ...latest.resolution,
            currentRunId: null,
            integrationTurn: null,
            attention: false,
            pendingRevisionCause: "non_delivery" as const,
            pendingWorkerInstruction: instruction,
            ...(second ? { nonDeliveryRoutePending: true } : {}),
          };
          this.resolution.update(
            latest,
            resolution,
            {
              phase: "changes_requested",
              reason: second
                ? "Second non-delivery: Nucleus is routing the next attempt to another eligible provider at the same capability"
                : "Non-delivery: returning the retained worker to the brief for one continuation",
            },
            second ? "non_delivery_provider_routed" : "non_delivery_pushback",
            `${run.id}: ${instruction}`,
          );
          recordResultApplied(this.store, t.id, run.id);
        });
        return;
      }
      // Retain the new non-approval before an awaited notification hook can hold
      // the transition. An older approval must not remain the current review.
      // The original run completion keeps the findings as immutable evidence;
      // the accepted-verdict history is untouched.
      if (
        run.role === "reviewer" &&
        (t.resolution.review?.eventId !== c.eventId ||
          t.resolution.review.runId !== run.id)
      )
        t = this.resolution.update(
          t,
          { review: c, integrationTurn: null },
          {},
          "blocked_review_evidence",
          run.id,
        );
      const hookState = this.resolution.hooks
        ? await this.resolution.hooks.emit("task.blocked", t, {
            event: "task.blocked",
            summary: c.summary,
            delivery: {
              prUrl: t.prUrl,
              prNumber: c.prNumber ?? null,
              head: t.prHead,
              review: t.resolution.review?.summary ?? null,
              summary: c.summary,
            },
          })
        : null;
      if (
        resultApplied(this.store, t.id, run.id) ||
        this.store.task(t.id).resolution.currentRunId !== run.id
      )
        return;
      if (hookState?.hold) {
        this.resolution.attention(
          this.store.task(t.id),
          hookHoldReason(hookState),
        );
        return;
      }
      if (hookState)
        t = this.resolution.settleAutomaticReplayHold(
          this.store.task(t.id),
          hookState.records,
          "task.blocked",
        );
      // Spec 058 slice 17: past the ownership rungs and with the repository hook
      // settled, a responsible task's blocked revision climbs the ladder instead of
      // parking for the operator: consult, then planner escalation. A provider
      // failure never enters the ladder.
      const applied = this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (
          resultApplied(this.store, t.id, run.id) ||
          latest.resolution.currentRunId !== run.id
        )
          return false;
        this.resolution.update(
          latest,
          { currentRunId: null, integrationTurn: null },
          { phase: c.status as "blocked" | "error", reason: c.summary },
        );
        recordResultApplied(this.store, t.id, run.id);
        return true;
      });
      if (!applied) return;
      if (t.responsible)
        await this.resolution.responsibleBlockerLadder(this.store.task(t.id), {
          source:
            run.role === "revision"
              ? "revision"
              : run.role === "reviewer"
                ? "reviewer"
                : run.role === "recovery"
                  ? "recovery"
                  : run.role === "closeout"
                    ? "closeout"
                    : "worker",
          runId: run.id,
          completion: c,
        });
      return;
    }
    if (
      !(await this.resolution.lease(t, this.leaseDeclineWait(t.id), run.id)) ||
      settlementHeld(this.store, this.resolution.stopped())
    )
      return;
    switch (advanceOwner(run)) {
      case "reviewer":
        await this.advanceReviewerResult(t, run, c);
        return;
      case "revision":
        await this.advanceRevisionResult(t, run, c);
        return;
      case "retired_verification":
        // The manual verification coordinator is retired (Spec 058 cutover 2); no
        // verification run is launched any more. A stored row that still carries
        // one must not be misread as a closeout: refuse it and let recovery sweep
        // the run.
        throw new Error(
          "The manual verification coordinator is retired; a verification run cannot advance the task",
        );
      case "closeout":
        await this.resolution.advanceCloseoutResult(t, run, c);
        return;
    }
  }
  /**
   * Task 405: settle one proof-only execution. The evidence it produced is
   * recorded whatever happened, and it is never a review, never a pass and never
   * a merge: the task returns to the phase it was activated from so the ordinary
   * independent review still has to run at the same exact head. Source drift
   * marks the evidence stale without erasing it, and a failed or unreadable
   * source never becomes a pass.
   */
  async advanceProofExecutionResult(
    t: Task,
    run: Run,
    c: Completion,
  ): Promise<void> {
    const binding = run.proofExecution;
    if (!binding)
      throw new Error("A proof executor completed without its bound subject");
    const current = this.store.task(t.id);
    let outcome: ProofOutcome =
      c.status === "proof_executed"
        ? c.proofResult?.status === "passed"
          ? "passed"
          : "failed"
        : "unknown";
    let drift = "";
    if (outcome === "passed") {
      try {
        const source = await verifyProofSource(current, run.head);
        if (source.tree !== binding.tree) {
          outcome = "stale";
          drift = "the checked-out tree differs from the reserved tree";
        }
      } catch (error) {
        // A moved or dirty checkout is drift; an unreadable one is unknown, never a pass.
        outcome =
          error instanceof ProofExecutionRefusal &&
          ["source_moved", "source_branch", "source_dirty"].includes(error.code)
            ? "stale"
            : "unknown";
        drift = error instanceof Error ? error.message : String(error);
      }
      if (settlementHeld(this.store, this.resolution.stopped())) return;
    }
    this.store.transaction(() =>
      settleProofExecution(this.resolution, {
        task: t,
        run,
        completion: c,
        outcome,
        evidence: [
          c.summary,
          c.proofResult?.evidence,
          drift ? `Source proof: ${drift}` : "",
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000),
        selectorStart: c.proofResult ? "started" : "unknown",
        ...(c.proofResult
          ? { selectorStartEvidence: c.proofResult.evidence || c.summary }
          : {}),
      }),
    );
  }
  /**
   * Spec 058 (task 533): route every proof a source-approving reviewer named to
   * whoever can produce it, before any operator question. The tag picks only the
   * route, never approval, and the retained reviewer still judges the arriving
   * evidence at the exact head (its next turn is the evidence-only round).
   */
  routeAwaitingProofs(t: Task, run: Run, c: Completion): void {
    // The callback refuses an approval with no proofs or at any head but the run's.
    const head = c.head!;
    // Spec 058 (task 539): a bare proof has no tag, so it gets one author round at this
    // head before it can reach the operator. A proof the worker already had at this
    // head is external: the round was spent, and the repeat goes to the operator.
    const sent = proofWorkerRequests(this.store, t.id, head);
    // Papercut c0fb3df9: a forge CI check is never an awaiting proof. Record it
    // as CI and let the merge gate's required-check wait cover it.
    const forgeNoted: string[] = [];
    for (const proof of c.awaitingProofs!) {
      const text = awaitingProofText(proof);
      if (isForgeCheckProofText(text) && !forgeNoted.includes(text)) {
        forgeNoted.push(text);
        this.store.event(
          t.id,
          "proof_forge_check_noted",
          `${head}: ${text.slice(0, 2000)} — recorded as CI; the merge gate's required-check wait covers it`,
        );
      }
    }
    const remaining = c.awaitingProofs!.filter(
      (proof) => !isForgeCheckProofText(awaitingProofText(proof)),
    );
    if (!remaining.length && forgeNoted.length) {
      // Source is approved and the only named proofs are CI checks: no proof
      // question, and the merge gate enforces the checks. Store the approval
      // as ready (with no awaiting proofs) so verification can proceed to the gate.
      // The caller holds the transaction and records the result; mirror the
      // other branches and only update here. awaitingProofs is optional with
      // min 1, so an empty list must be omitted, not stored.
      const { awaitingProofs: _dropped, ...rest } = c;
      const converted = { ...rest, status: "ready_to_merge" as const };
      this.resolution.update(
        t,
        {
          currentRunId: null,
          review: converted,
          integrationTurn: null,
          proofRetry: null,
        },
        {
          phase: "verifying",
          reason: `Source approved at ${head}; ${forgeNoted.join(", ").slice(0, 2000)} recorded as CI and covered by the merge gate`,
        },
        "source_approved_ci_noted",
        run.id,
      );
      return;
    }
    const proofs: AwaitingProof[] = remaining.map((proof) => {
      const text = awaitingProofText(proof);
      const tagged = typeof proof === "string" ? "author" : proof.route;
      return tagged === "author" && sent.has(text)
        ? { proof: text, route: "external" }
        : { proof: text, route: tagged };
    });
    const route = (kind: "author" | "environment" | "external") =>
      proofs.filter((proof) => awaitingProofRoute(proof) === kind);
    const environment = route("environment"),
      author = route("author"),
      external = route("external");
    // A check that faulted before any assertion in the reviewer's own run is not a
    // proof about the source: it gets one clean retry at this head, and a repeat is
    // external. A reviewer run already carrying the retry proves the allowance is spent.
    const retried = this.store
      .runs(t.id)
      .some(
        (item) => item.role === "reviewer" && item.proofRetry?.head === head,
      );
    if (
      environment.length &&
      !retried &&
      automaticRetryForbidden(t, this.store.runs(t.id))
    ) {
      const named = awaitingProofTexts(environment).join(", ");
      const evidence = `Reviewer ${run.id} completed source approval at ${head}, blocked by environment proof ${named}; verdict: ${c.reviewText?.trim() || c.summary}`;
      this.resolution.update(
        t,
        {
          currentRunId: null,
          review: c,
          integrationTurn: null,
          proofRetry: null,
        },
        {
          phase: "blocked",
          reason: `Automatic reviewer environment retry suppressed by the owner; completed verdict retained at ${head}`,
        },
        "source_awaiting_proof",
        run.id,
      );
      this.resolution.suppressAutomaticRetry(
        this.store.task(t.id),
        "reviewer_environment",
        evidence,
        run.id,
      );
      return;
    }
    // Author-producible evidence is the largest group and costs no operator turn, so
    // it is sent first; the reviewer's next evidence-only turn returns any remaining
    // environment or external proof, and an environment retry still precedes a park.
    if (author.length) {
      const named = awaitingProofTexts(author).join("; ").slice(0, 9000);
      const instruction = `The reviewer approved the source at ${head} but named proofs only you can produce. Produce that evidence, record each proof's exact command and its observed result as author evidence on the PR, and return ready_for_review at ${head} (or at the head you push for it) so the retained reviewer judges it. Change the source only if a proof shows a defect, and never describe an unrun check as passed. Proofs: ${named}`;
      this.resolution.update(
        t,
        {
          currentRunId: null,
          review: c,
          integrationTurn: null,
          proofRetry: null,
          pendingWorkerInstruction: instruction,
        },
        {
          phase: "changes_requested",
          reason: `Source approved at ${head}; the author must produce the named proofs: ${named.slice(0, 3000)}`,
        },
        "author_proof_requested",
        run.id,
      );
      for (const text of awaitingProofTexts(author))
        this.store.event(t.id, "proof_worker_requested", `${head}: ${text}`);
      return;
    }
    if (environment.length && !retried) {
      this.resolution.update(
        t,
        {
          currentRunId: null,
          review: null,
          integrationTurn: null,
          proofRetry: {
            runId: run.id,
            head,
            proofs: awaitingProofTexts(environment),
            at: now(),
          },
        },
        {
          phase: "reviewing",
          reason: `Reviewer checks faulted before any assertion at ${head}; one clean-environment retry, then the operator: ${awaitingProofTexts(environment).join(", ").slice(0, 3000)}`,
        },
        "reviewer_environment_retry",
        run.id,
      );
      return;
    }
    // Only proofs another system or the operator can produce are left. A spent
    // environment retry is external now, so the park and its question say so.
    const parked: AwaitingProof[] = [
      ...external,
      ...environment.map((proof) => ({
        proof: awaitingProofText(proof),
        route: "external" as const,
      })),
    ];
    const reason = `Source approved at ${head}; awaiting proof: ${awaitingProofTexts(parked).join(", ").slice(0, 3000)}`;
    this.resolution.update(
      t,
      {
        currentRunId: null,
        review: { ...c, awaitingProofs: parked },
        integrationTurn: null,
        proofRetry: null,
      },
      { phase: "blocked", reason },
      "source_awaiting_proof",
      run.id,
    );
    this.resolution.waiting(this.store.task(t.id), reason, "awaiting_proof");
  }
  /**
   * One reviewer run's verdict applies once, whatever passes overlap (task 740).
   * The fence is the durable record written in the same transaction as the
   * verdict's state, so it holds across passes, connections and restarts and does
   * not rely on the task lane. A pass that loses to it changes and writes nothing,
   * and a failure it meets on the way is no longer about this task.
   */
  async advanceReviewerResult(
    t: Task,
    run: Run,
    c: Completion,
    reapplied = false,
  ): Promise<boolean> {
    if (this.verdictApplied(t.id, run.id)) return false;
    try {
      return await this.applyReviewerResult(t, run, c, reapplied);
    } catch (error) {
      if (!this.verdictApplied(t.id, run.id)) throw error;
      return false;
    }
  }
  verdictApplied(taskId: string, runId: string): boolean {
    return (
      resultApplied(this.store, taskId, runId) ||
      reviewVerdictApplied(this.store, taskId, runId) ||
      this.store.task(taskId).proofOnlyResult?.reviewerRunId === runId
    );
  }
  /** Runs inside the transaction that writes the result, so its fence read and that write are one step. */
  closeProofOnlyQualification(t: Task, run: Run, c: Completion): void {
    if (this.verdictApplied(t.id, run.id)) return;
    const current = this.store.task(t.id);
    const receipt = current.proofExecutions.at(-1);
    if (
      !current.proofOnly ||
      !current.proofExecution ||
      !receipt ||
      receipt.head !== current.proofOnly.commit ||
      receipt.selector !== current.proofExecution.selector ||
      receipt.status === "running" ||
      current.resolution.reviewerAgentId !== run.agentId ||
      run.head !== current.proofOnly.commit
    )
      throw new Error(
        "Proof-only review requires the exact settled receipt and its retained reviewer at the merged commit",
      );
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    // Task 560: historical evidence is never a pass. A receipt recorded from
    // a superseded run's late report (or its timeline alone) can never
    // satisfy proof-only closeout, whatever it claims: a ready_to_merge
    // verdict resting on it alone closes the qualification failed, and the
    // judgment about the evidence stays in the retained history.
    const historical = receipt.historical === true;
    const passed =
      receipt.status === "passed" &&
      !historical &&
      c.status === "ready_to_merge";
    const reviewRecord = reviewRecordFor(run, c, now());
    const reviews = reviewRecord
      ? [...current.resolution.reviews, reviewRecord]
      : current.resolution.reviews;
    const evidence = [
      `Qualification result ${passed ? "passed" : "failed"}; executor receipt status ${receipt.status}: ${receipt.selector} at ${receipt.head}; executor run ${receipt.runId}.`,
      ...(historical
        ? [
            `Receipt ${receipt.runId} is historical evidence only (a superseded run's late report or its timeline); it is never a pass and cannot satisfy closeout.`,
          ]
        : []),
      `Reviewer verdict ${c.status}: ${c.reviewText?.trim() || c.summary}`,
      receipt.evidence,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
    const result = {
      status: passed ? ("passed" as const) : ("failed" as const),
      commit: current.proofOnly.commit,
      selector: current.proofExecution.selector,
      executionRunId: receipt.runId,
      reviewerRunId: run.id,
      evidence,
    };
    const reason = passed
      ? `Proof-only qualification passed at ${result.commit}; receipt ${receipt.runId} was accepted by retained reviewer ${run.id}`
      : historical
        ? `Proof-only qualification failed at ${result.commit}; receipt ${receipt.runId} is historical evidence only and can never be credited a pass`
        : `Proof-only qualification failed at ${result.commit}; receipt ${receipt.runId} and reviewer findings are retained for the planner`;
    this.resolution.update(
      current,
      {
        currentRunId: null,
        review: c,
        integrationTurn: null,
        reviews,
        pendingReviewReason: null,
      },
      { phase: "done", reason, proofOnlyResult: result },
      "proof_only_qualification_closed",
      JSON.stringify({ ...result, status: result.status }),
    );
    recordResultApplied(this.store, t.id, run.id);
  }
  async applyReviewerResult(
    t: Task,
    run: Run,
    c: Completion,
    reapplied: boolean,
  ): Promise<boolean> {
    if (t.entrypoint === "proof") {
      this.store.transaction(() => this.closeProofOnlyQualification(t, run, c));
      return this.verdictApplied(t.id, run.id);
    }
    // The verdict applies on the task branch at the head the round read. The one
    // reattach step returns a checkout an earlier round left detached before this
    // body publishes, verifies or commits it — for this run's own round, and
    // moving no commit — so a restored or replayed verdict never leaves the
    // checkout detached (Spec 068 §4).
    if (
      t.prHead &&
      !t.resolution.unreviewedMerge &&
      (t.prHead !== run.head || c.head !== run.head)
    )
      throw Error("Review is stale for the current PR head");
    await reattachStoredTaskCheckout(this.store, t.id, run.id);
    const reviewer = this.resolution.reviewerSetting(t);
    const gate = this.reviewVerdictGate(t, run, c, { reapplied, reviewer });
    const admission = gate.read();
    if ("refusal" in admission) {
      if (admission.independence) throw Error(admission.refusal);
      return false;
    }
    // Spec 033: a formal review id is its own evidence, never a comment id.
    const publicationId = (completion: Completion) =>
      reviewer ? completion.reviewId : completion.reviewCommentId;
    const publicationRecord = this.store.getMeta(`reviewPublication:${run.id}`);
    if (!publicationId(c) && (reapplied ? !publicationRecord : true)) {
      if (!c.reviewText || !this.adapter.publishReview)
        throw Error("Review publication is unavailable");
      // Task 704: the adapter publishes single-flight per run and reports whether
      // this pass posted. A repeat that reuses a recorded publication is silent:
      // no extra `review_published` event.
      let outcome: number | PublicationOutcome;
      try {
        outcome = await this.adapter.publishReview(
          this.store,
          t,
          run,
          c.status,
          c.reviewText,
          gate.allowed,
          reviewer ?? undefined,
        );
      } catch (error) {
        if (!gate.allowed()) return false;
        if (
          gitDeliveryUnknown(error) &&
          classifyGitTransientFailure(error) === "network" &&
          this.store.getMeta(`reviewPublication:${run.id}`)
        )
          throw new ReviewPublicationTransientError(error);
        throw error;
      }
      const post = gate.read();
      if ("refusal" in post) return false;
      const id = typeof outcome === "number" ? outcome : outcome.id;
      const published = typeof outcome === "number" || outcome.published;
      c = reviewer ? { ...c, reviewId: id } : { ...c, reviewCommentId: id };
      this.store.putRun({ ...post.latestRun, completion: c });
      if (published)
        this.store.event(
          t.id,
          "review_published",
          `${reviewer ? "PR review" : "PR comment"} ${id}`,
        );
    }
    const verifiedId = await this.adapter.verifyReview!(
      t,
      run,
      c,
      reviewer ?? undefined,
    );
    await gate.observe();
    const applied = this.commitReviewerVerdict(t, run, c, reapplied, gate, {
      kind: "ordinary",
      reviewer,
      id: verifiedId,
    });
    return applied.kind === "applied";
  }

  /** Recheck the same admission at the forge boundary and inside the verdict transaction. */
  reviewVerdictGate(
    task: Task,
    run: Run,
    completion: Completion,
    options: {
      reapplied: boolean;
      reviewer: ReviewerSetting | null;
      published?: boolean;
    },
  ) {
    const { reapplied, reviewer, published = false } = options;
    let observedVersion: number | null | undefined;
    const changed = {
      refusal: "Task changed during review verification. Read next again",
    };
    const read = (): ReviewVerdictAdmission => {
      const current = this.store.task(task.id);
      const latestRun = this.store.run(run.id);
      const { currentRunId, integrationTurn, mergeIntent } = current.resolution;
      const { dispatch } = holdsOf(current);
      if (dispatch) return { refusal: reviewDispatchRefusal(dispatch) };
      if (
        settlementHeld(this.store, this.resolution.stopped()) ||
        this.verdictApplied(task.id, run.id) ||
        current.removedAt ||
        isDispositionActive(current) ||
        currentRunId !== task.resolution.currentRunId ||
        (currentRunId !== run.id && !(reapplied && currentRunId === null)) ||
        current.resolution.reviewerAgentId !== task.resolution.reviewerAgentId ||
        current.resolution.mergedCommit !== task.resolution.mergedCommit ||
        current.prHead !== task.prHead ||
        (!current.resolution.unreviewedMerge &&
          current.prHead &&
          (current.prHead !== run.head || completion.head !== run.head)) ||
        integrationTurn ||
        mergeIntent ||
        !latestRun?.released ||
        latestRun.status !== "finished" ||
        latestRun.replacedAt ||
        latestRun.taskId !== task.id ||
        latestRun.role !== "reviewer" ||
        latestRun.agentId !== run.agentId ||
        latestRun.head !== run.head ||
        latestRun.workspaceId !== run.workspaceId ||
        latestRun.hostId !== run.hostId ||
        !isDeepStrictEqual(latestRun.profile, run.profile) ||
        completion.taskId !== task.id ||
        completion.runId !== run.id ||
        latestRun.completion?.eventId !== completion.eventId ||
        latestRun.completion.head !== completion.head ||
        latestRun.completion.status !== completion.status ||
        (!reapplied && reviewLadderWait(this.store, current).refusal) ||
        !isDeepStrictEqual(reviewerSettingOf(this.store, current), reviewer) ||
        observedVersion === null ||
        (observedVersion !== undefined &&
          !observationAdvanceSince(current, observedVersion))
      )
        return changed;
      const runs = this.store.runs(task.id);
      if (
        currentRunId === null &&
        runs.findLast((candidate) => candidate.role === "reviewer")?.id !== run.id
      )
        return changed;
      if (
        reapplied && !published &&
        (current.resolution.review?.runId === run.id ||
          current.prHead !== run.head ||
          current.phase !== task.phase ||
          current.resolution.reviewerAgentId !== run.agentId ||
          completion.head !== current.prHead)
      )
        return changed;
      const independence = recordedReviewIndependence(current, latestRun, runs);
      if (independence)
        return { refusal: independence.refusal, independence: true };
      return { current, latestRun, runs };
    };
    const observe = async () => {
      observedVersion = undefined;
      const admitted = read();
      if ("refusal" in admitted) {
        observedVersion = null;
        return;
      }
      await this.adapter.assertReviewIndependence?.(
        admitted.current,
        admitted.latestRun,
      );
      observedVersion = admitted.current.version;
    };
    const allowed = Object.assign(() => !("refusal" in read()), { observe });
    return { read, observe, allowed };
  }

  /** Commit the verdict and its verified evidence together. */
  private commitReviewerVerdict(
    t: Task,
    run: Run,
    completion: Completion,
    reapplied: boolean,
    gate: ReturnType<ResultApplication["reviewVerdictGate"]>,
    verification: ReviewVerification,
  ): PublishedReviewApplication {
    return this.store.transaction(() => {
      const admitted = gate.read();
      if ("refusal" in admitted)
        return { kind: "blocked", refusal: admitted.refusal };
      const { current, latestRun, runs } = admitted;
      const published =
        verification.kind === "published" ? verification.admit() : null;
      if (published?.kind === "blocked") return published;

      let c = completion;
      if (verification.kind === "ordinary") {
        const { reviewer, id } = verification;
        // Spec 033: formal review and comment IDs prove different publication forms.
        const reportedId = reviewer ? c.reviewId : c.reviewCommentId;
        const verifiedId = id || reportedId;
        if (verifiedId) {
          // Task 704: keep the earliest publication carrying this run's marker.
          const settledId = retainReviewPublication(
            this.store,
            current,
            run,
            c,
            reviewer,
            verifiedId,
          );
          if (settledId !== reportedId) {
            c = reviewer
              ? { ...c, reviewId: settledId }
              : { ...c, reviewCommentId: settledId };
            this.store.putRun({ ...latestRun, completion: c });
          }
          if (verifiedId !== reportedId)
            this.store.event(
              t.id,
              "review_reconciled",
              `${reviewer ? "PR review" : "PR comment"} ${verifiedId}`,
            );
        }
      }
      // This verdict settles the review. Displaced runs can release, and their
      // verdict-only credentials can no longer win at this head.
      for (const replaced of runs) {
        if (
          replaced.id !== run.id &&
          replaced.replacedAt &&
          !replaced.released &&
          !replaced.completion
        )
          this.store.putRun({ ...replaced, released: true });
      }
      const recovery = current.resolution.recovery;
      const incident = current.resolution.incident;
      const ownRecovery =
        recovery &&
        published?.settlesIncident &&
        recovery.incidentId === incident?.id;
      const settlesAttention = Boolean(
        reapplied &&
          (published
            ? current.resolution.attention ||
              (published.settlesIncident && incident?.status !== "resolved") ||
              (ownRecovery && recovery.status !== "resolved")
            : current.resolution.attention && incident?.runId === run.id),
      );
      const recoveryRunId =
        settlesAttention &&
        recovery?.incidentId === current.resolution.incident?.id
          ? recovery?.runId
          : null;
      const recoveryRun = recoveryRunId ? this.store.run(recoveryRunId) : null;
      const supersedeRecovery = Boolean(recoveryRun && !recoveryRun.released);
      const stopFromIncident = Boolean(
        settlesAttention &&
          current.resolution.stop &&
          current.resolution.incident &&
          !published &&
          Date.parse(current.resolution.stop.since) >=
            Date.parse(current.resolution.incident.createdAt),
      );
      const settledDetail = published
        ? "Accepted review verdict applied"
        : "Accepted review verdict applied after transient failure";
      const settledReview: Partial<Task["resolution"]> = settlesAttention
        ? {
            attention: false,
            ...(published || stopFromIncident ? { stop: null } : {}),
            recoveryActive: false,
            ...(incident && (!published || published.settlesIncident)
              ? {
                  incident: {
                    ...incident,
                    status: "resolved",
                    detail: settledDetail,
                    updatedAt: now(),
                  },
                }
              : {}),
            ...(recovery && (!published || ownRecovery)
              ? {
                  recovery: {
                    ...recovery,
                    status: "resolved",
                    summary: settledDetail,
                    idleSince: null,
                    action: null,
                  },
                }
              : {}),
          }
        : {};
      if (supersedeRecovery)
        this.store.putRun({
          ...recoveryRun!,
          status: "superseded",
          released: true,
        });
      // Spec 037: an accepted review with verdicts appends one immutable
      // record. A review without verdicts leaves the task record unchanged.
      const reviewRecord = reviewRecordFor(run, c, now());
      const reviews = reviewRecord
        ? [...current.resolution.reviews, reviewRecord]
        : current.resolution.reviews;
      if (c.status === "changes_required")
        this.store.event(
          t.id,
          "review_revision_classified",
          `review ${run.id}: semantic review revision`,
        );
      // The lifetime cap counts review rounds (one per changes_required review);
      // author continuations inside a round never counted, and an upgrade does
      // not reset the count.
      // Task 576: the cap is reached only by a new substantive changes_required
      // review beyond the cap. A review that already parked the task (same
      // event id, however it is delivered) never parks it again on its own;
      // the next new review parks again.
      if (
        c.status === "changes_required" &&
        current.resolution.revisionRuns >= REVISION_BUDGET &&
        current.resolution.capParkedReviewEventId !== c.eventId
      ) {
        // Spec 058 slice 17: the cap park escalates to the project planner as a
        // delegated decision instead of the owner disposition. The final review
        // remains evidence; the planner's answer applies through the ordinary verbs.
        const runs = current.resolution.revisionRuns;
        const cause = revisionCapCauseId(current.id, runs);
        const ladderReason = `Revision budget exhausted after ${runs} review rounds; the project planner decides the next approach`;
        this.resolution.update(
          current,
          {
            ...(published ? settledReview : {}),
            currentRunId: null,
            review: c,
            integrationTurn: null,
            reviews,
            pendingRevisionCause: null,
            capParkedReviewEventId: c.eventId,
          },
          { phase: "needs_attention", reason: ladderReason },
          "revision_budget_exhausted",
        );
        this.store.event(t.id, "review_result_applied", run.id);
        recordResultApplied(this.store, t.id, run.id);
        if (reapplied) this.store.event(t.id, "review_reapplied", run.id);
        if (published && settlesAttention)
          this.resolution.settleAttentionEpisode(
            t.id,
            "Accepted review verdict applied",
          );
        const question = revisionCapEscalationQuestion(
          current,
          runs,
          c.summary,
        );
        this.resolution.openPlannerEscalation(this.store.task(t.id), {
          cause,
          runId: null,
          question,
          payload: { cause, runId: null, revisionCap: runs, question },
        });
        return { kind: "applied" };
      }
      const sequence =
        c.status === "ready_to_merge"
          ? this.store.nextIntegrationSequence(t.repoPath)
          : null;
      this.resolution.update(
        current,
        {
          currentRunId: null,
          review: c,
          integrationTurn: sequence ? { sequence, acceptedAt: now() } : null,
          reviews,
          pendingRevisionCause: null,
          ...settledReview,
          ...(c.status === "changes_required"
            ? { pendingWorkerInstruction: c.summary }
            : {}),
        },
        {
          phase:
            c.status === "changes_required" ? "changes_requested" : "verifying",
          reason: c.summary,
          ...(supersedeRecovery
            ? { coordinatorGeneration: current.coordinatorGeneration + 1 }
            : {}),
        },
      );
      this.store.event(t.id, "review_result_applied", run.id);
      recordResultApplied(this.store, t.id, run.id);
      if (reapplied) this.store.event(t.id, "review_reapplied", run.id);
      if (settlesAttention)
        this.resolution.settleAttentionEpisode(t.id, settledDetail);
      return { kind: "applied" };
    });
  }
  /** Return an authenticated ready report rejected by checkout/PR verification to its worker. */
  responsiblePrReportRefused(
    t: Task,
    runId: string,
    prNumber: number,
    error: unknown,
  ): boolean {
    // The checkout and PR-identity refusals are typed where they are thrown; no
    // message ever decides a route here.
    if (!(error instanceof WorkerSourceRefusal)) return false;
    const identityRefusal = error.code === "pr_identity";
    const instruction = identityRefusal
      ? `Nucleus refused PR #${prNumber}: ${error.message}. Keep the exact task branch ${t.branch}, close or correct the mismatched PR, open a replacement PR targeting ${t.baseBranch}, then report ready_for_review with its number.`
      : `Nucleus refused ready_for_review because: ${error.message}. Resolve the named checkout condition (remove or ignore metadata files; preserve source files), then report ready_for_review again with the same PR #${prNumber}.`;
    this.resolution.update(
      t,
      {
        currentRunId: null,
        ...(identityRefusal ? { revisionPrRepair: true } : {}),
        pendingWorkerInstruction: instruction,
      },
      { phase: "changes_requested", reason: instruction },
      "responsible_pr_report_refused",
      `${runId}: PR #${prNumber}; returned to the responsible worker`,
    );
    return true;
  }
  async advanceRevisionResult(t: Task, run: Run, c: Completion): Promise<void> {
    if (resultApplied(this.store, t.id, run.id)) return;
    // report_ready settles through the same owner the intake path uses; only the
    // release differs, and advanceCompletedRun is already past it.
    if (c.status === "report_ready") {
      this.store.transaction(() => {
        settleReportReady(this.resolution, t, run, c);
      });
      return;
    }
    const establishesFirstPr = !t.resumePrNumber && !t.completion?.prNumber;
    const effectivePr =
      t.resolution.revisionPrRepair || establishesFirstPr
        ? c.prNumber!
        : taskPrNumber(t);
    let pr: VerifiedPr;
    try {
      pr = await this.adapter.verifyPr(t, effectivePr);
    } catch (error) {
      propagateQuantumDeferral(error);
      const handled = this.store.transaction(() => {
        const latest = this.store.task(t.id);
        if (
          resultApplied(this.store, t.id, run.id) ||
          latest.resolution.currentRunId !== run.id
        )
          return true;
        if (
          !this.resolution.responsiblePrReportRefused(
            latest,
            run.id,
            effectivePr,
            error,
          )
        )
          return false;
        recordResultApplied(this.store, t.id, run.id);
        return true;
      });
      if (handled) return;
      throw error;
    }
    if (settlementHeld(this.store, this.resolution.stopped())) return;
    this.store.transaction(() => {
      const latest = this.store.task(t.id);
      if (
        resultApplied(this.store, t.id, run.id) ||
        latest.resolution.currentRunId !== run.id
      )
        return;
      recordResultApplied(this.store, t.id, run.id);
      // A mechanical conflict return at the identical Git head changes no
      // reviewed bytes. Keep the authentic approval and recheck merge gates,
      // rather than buying another review of the same unresolved conflict.
      const review = latest.resolution.review;
      const approval = review ? this.store.run(review.runId) : null;
      // A revision that returned the identical approved head while the accepted
      // exact-head review and its published approval stand changed no reviewed
      // bytes, whatever refused the merge. Queue #394 covers the failed-check
      // form of that return and the merge conflict's existing form below.
      const unchangedApprovedReturn = Boolean(
        run.head === pr.head &&
          c.status === "ready_for_review" &&
          latest.prHead === pr.head &&
          latest.resolution.currentRunId === run.id &&
          review?.status === "ready_to_merge" &&
          review.head === pr.head &&
          (review.reviewId ?? review.reviewCommentId) &&
          approval?.role === "reviewer" &&
          approval.status === "finished" &&
          approval.released &&
          approval.completion?.eventId === review.eventId &&
          approval.completion.head === pr.head,
      );
      // The two mechanical returns differ only in the cause the task names; the
      // transition, the fence and the gate recheck are one rule.
      const mechanical = !unchangedApprovedReturn
        ? null
        : isFailedChecksReason(run.instruction)
          ? {
              event: "unchanged_check_revision",
              reason: `Unchanged reviewed head after a failed required check; rechecking the merge gates without another review. Unmet check: ${run.instruction}`,
            }
          : run.instruction === MERGE_CONFLICT_REASON
            ? {
                event: "unchanged_conflict_revision",
                reason:
                  "Merge-conflict revision returned unchanged approved head; rechecking merge prerequisites without another review",
              }
            : null;
      if (mechanical) {
        this.resolution.update(
          latest,
          {
            currentRunId: null,
            mechanicalVerification: null,
            revisionPrRepair: false,
            integrationTurn: {
              sequence: this.store.nextIntegrationSequence(latest.repoPath),
              acceptedAt: now(),
            },
          },
          {
            phase: "verifying",
            completion: c,
            prHead: pr.head,
            prUrl: pr.url,
            reason: mechanical.reason,
          },
          mechanical.event,
        );
        return;
      }
      this.resolution.update(
        latest,
        {
          currentRunId: null,
          review: null,
          revisionPrRepair: false,
          integrationTurn: null,
        },
        {
          phase: "awaiting_review",
          completion: c,
          prHead: pr.head,
          prUrl: pr.url,
          ...(establishesFirstPr ? { resumePrNumber: effectivePr } : {}),
          reason: c.summary,
        },
      );
    });
  }
}
