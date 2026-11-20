import type {
  Completion,
  Task,
  TaskControlInput,
} from "../../../shared/contracts";
import type { Resolution } from "../../resolution";
import { attentionUnknownEscalation } from "./attention";
import { continueWorkerAfterLadder, settleLadderControl } from "./continuation";
import { establishEscalationWait, type EscalationWait } from "./hold";
import {
  classifyEscalationToOperator,
  operatorDecisionApplied,
  reconcileLegacyPlaceholderDecisions,
  type OperatorEscalationHandoff,
} from "./operator";
import {
  escalateRefusedCoordinator,
  holdProofOnlyGoWait,
  openReviewContinuationEscalation,
  responsibleBlockerLadder,
  settleCompletedExecutorBlocker,
  suppressAutomaticRetry,
  type BlockerLadderInput,
} from "./park";
import type { PlannerEscalation } from "./records";
import { resumeDelegations, resumeEscalationWaits } from "./resume";
import {
  openPlannerEscalation,
  routePlannerEscalation,
  routePlannerEscalationReturn,
  type OpenEscalationInput,
} from "./routing";

/**
 * The blocker ladder: worker, reviewer second opinion, planner, operator. Tom,
 * 2026-11-02: "Workers are supposed to handle blockers wherever possible, should
 * use the reviewer thread as a second opinion where needed, escalate to the
 * planner automatically when _really_ stuck and only bother me if all else fails."
 *
 * This class is the ladder's public surface and its in-flight state only. Each
 * mechanism has one owner beside it: the durable records (`records.ts`), the cause
 * identities (`causes.ts`), the questions and replies (`questions.ts`,
 * `replies.ts`), the waits (`waits.ts`), the pass decisions (`pass.ts`), the park
 * (`park.ts`), the routing (`routing.ts`), the operator rung (`operator.ts`) and
 * restart (`resume.ts`). The caller records every durable intent before any send;
 * unknown delivery is never retried.
 */
export class Ladder {
  constructor(readonly resolution: Resolution) {}
  get store() {
    return this.resolution.store;
  }
  get adapter() {
    return this.resolution.adapter;
  }
  /** Spec 058 slice 17: the ladder sends this process is driving, so a rerun never double-sends. */
  readonly routingEscalations = new Set<string>();
  /** Escalations whose unknown-delivery attention is being delivered now, so a pass cannot double-send. */
  readonly attentioningEscalations = new Set<string>();
  runReviewerConsult(
    t: Task,
    input: { id: string; reviewer: string | null; question: string },
  ): Promise<void> {
    return this.resolution.reviewerConsult.runReviewerConsult(t, input);
  }
  applyDelegatedEscalationAnswer(
    taskId: string,
    id: string,
    questionId: string,
    answer: string,
    who: string,
  ): Promise<string | null> {
    return this.resolution.escalationSettlement.applyDelegatedEscalationAnswer(
      taskId,
      id,
      questionId,
      answer,
      who,
    );
  }
  /**
   * Papercut 2ef86450: an escalation whose delivery is unknown is never resent, but
   * once it outlives the stall threshold the task surfaces as visible attention
   * (owner, question, exits) and the project planner hears about it once on the
   * agent channel. The stop is re-asserted each ladder pass; the message is not.
   */
  attentionUnknownEscalation(
    t: Task,
    escalation: Pick<PlannerEscalation, "id" | "question">,
  ): void {
    return attentionUnknownEscalation(this, t, escalation);
  }
  resumeDelegations(task: Task): void {
    return resumeDelegations(this, task);
  }
  resumeEscalationWaits(task: Task): Promise<void> {
    return resumeEscalationWaits(this, task);
  }
  /** The wait event and the actual task stop are one durable state transition. */
  establishEscalationWait(
    taskId: string,
    id: string,
    wait: EscalationWait,
    afterEventId = 0,
  ): boolean {
    return establishEscalationWait(this, taskId, id, wait, afterEventId);
  }
  /**
   * Spec 058 slice 17 (task 584): the blocker ladder for a stuck responsible task.
   * Returns true when the ladder owns the park, so the caller writes no ordinary
   * blocked stop.
   */
  responsibleBlockerLadder(
    t: Task,
    input: BlockerLadderInput,
  ): Promise<boolean> {
    return responsibleBlockerLadder(this, t, input);
  }
  /** effigy#697: while a proof-only release GO is open the task waits on the operator. */
  holdProofOnlyGoWait(t: Task): boolean {
    return holdProofOnlyGoWait(this, t);
  }
  /** Run the executor rung after its completion transaction commits. */
  settleCompletedExecutorBlocker(input: Completion): Promise<void> {
    return settleCompletedExecutorBlocker(this, input);
  }
  /** Keep a completed result and hand a forbidden automatic relaunch to the planner. */
  suppressAutomaticRetry(
    t: Task,
    site: string,
    evidence: string,
    runId: string | null = null,
  ): boolean {
    return suppressAutomaticRetry(this, t, site, evidence, runId);
  }
  /** A reviewer-checkpoint stop escalates through the planner ladder, once per reader. */
  openReviewContinuationEscalation(
    t: Task,
    state: "exhausted" | "closed",
    detail = "",
  ): string {
    return openReviewContinuationEscalation(this, t, state, detail);
  }
  /** A second refused coordinator choice reaches the existing planner ladder. */
  escalateRefusedCoordinator(t: Task, reason: string): void {
    return escalateRefusedCoordinator(this, t, reason);
  }
  /** Record the durable escalation intent, park the task with the planner, then route the delegate. */
  openPlannerEscalation(t: Task, input: OpenEscalationInput): void {
    return openPlannerEscalation(this, t, input);
  }
  /** Route one recorded escalation to the project planner, then a decider. */
  routePlannerEscalation(t: Task, id: string, question: string): Promise<void> {
    return routePlannerEscalation(this, t, id, question);
  }
  /** Route a returned escalation occurrence back through the planner ladder. */
  routePlannerEscalationReturn(t: Task, id: string): Promise<void> {
    return routePlannerEscalationReturn(this, t, id);
  }
  /** Withdraw any still-open legacy placeholder ladder decisions and return their occurrence to the planner. */
  reconcileLegacyPlaceholderDecisions(t: Task): void {
    return reconcileLegacyPlaceholderDecisions(this, t);
  }
  /** Classify an escalation: concrete operator choices reach Tom; bare classifications return to the planner. */
  classifyEscalationToOperator(
    t: Task,
    id: string,
    reason: string,
    who: string,
    handoff?: OperatorEscalationHandoff,
  ): void {
    return classifyEscalationToOperator(this, t, id, reason, who, handoff);
  }
  /** Whether an escalation's operator decision is recorded, linked and holding the task. */
  operatorDecisionApplied(taskId: string, id: string): boolean {
    return operatorDecisionApplied(this, taskId, id);
  }
  /** The one continuation shape both ladder exits use: the same retained worker continues. */
  continueWorkerAfterLadder(
    t: Task,
    input: {
      instruction: string;
      event: string;
      reason: string;
      detail: string;
    },
  ): void {
    return continueWorkerAfterLadder(this, t, input);
  }
  /** An ordinary owner control that moved a parked task answers the escalations it stepped over. */
  settleLadderControl(
    before: Task,
    after: Task,
    action: TaskControlInput["action"],
  ): void {
    return settleLadderControl(this, before, after, action);
  }
}
