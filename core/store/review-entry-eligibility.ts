import { hookStateIsTerminal,type HookRecord } from "../../shared/hooks";
import { operationIsSettled,type QueueOperation } from "../../shared/operations";
import type { Task,Run } from "../../shared/contracts";
import type { VerifiedEnclosingOperation } from "../planning/enclosing-operation";

/**
 * The stored facts the review-entry eligibility reads: runs of any role, the task's
 * operations and its hook deliveries. Narrow on purpose — a boundary can only widen by
 * reading a new fact here, where the review-entry rule sees it.
 */
export interface ReviewEntryFacts {
  runsOf(taskId: string): Run[];
  operation(id: string): QueueOperation | null;
  operations(filter: { states?: QueueOperation["state"][]; taskId?: string }): QueueOperation[];
  hookEvents(taskId?: string): HookRecord[];
}

  /**
   * The structural fact behind the pre-dispatch dependency and closeout
   * boundaries: a queued
   * review-entry task bound to its external workspace at intake,
   * with no run of any role ever (released, superseded and cancelled history
   * included), no execution participant and nothing execution-, review- or
   * delivery-shaped recorded. Intake's settled operation and bound workspace
   * are provenance, never dispatch. Every other shape of ambiguity refuses.
   *
   * `enclosing` (task 404) is the one internally authenticated durable
   * invocation executing `move to=closeout`, proved by
   * `verifyEnclosingOperation`: Queue persists that operation before the engine
   * performs it, so it is the admitted control itself, not a competing writer.
   * Nothing else is exempt — a stale, foreign, settled or changed invocation
   * excludes nothing, and the 401 dependency boundary never passes one.
   */
export function reviewEntryUnrun(facts: ReviewEntryFacts, task: Task, enclosing?: VerifiedEnclosingOperation): boolean {
    const entry = task.reviewEntry;
    if (!entry || task.entrypoint !== "review" || task.phase !== "queued" || task.removedAt) return false;
    // The bound workspace is the external one recorded at intake, and no review
    // admission has dispatched a reader yet (admission records `dispatchBase`).
    if (!task.workspaceId || task.workspaceId !== entry.workspaceId || !task.directory || entry.dispatchBase !== null) return false;
    if (entry.directory && task.directory !== entry.directory) return false;
    // No run of any role ever existed, released or superseded history included.
    if (facts.runsOf(task.id).length) return false;
    // The settled intake operation is the provenance that created this task; a
    // still-running intake or any other unfinished operation is work in flight.
    const intake = facts.operation(entry.operationId);
    if (intake && !operationIsSettled(intake.state)) return false;
    if (facts.operations({ taskId: task.id, states: ["pending", "running", "needs_attention"] })
      .some(operation => operation.id !== enclosing?.operationId)) return false;
    // No hook delivery is outstanding.
    if (facts.hookEvents(task.id).some(hook => !hookStateIsTerminal(hook.state))) return false;
    const resolution = task.resolution;
    // No current or prior execution participant or pending agent intent.
    if (task.agentId || task.runId || task.agentIntent || task.lastAgentStatus || task.workerModel || task.workerModels.length
      || task.retiredWorkers.length || resolution.currentRunId || resolution.reviewerAgentId || resolution.reviewerProfile) return false;
    // No completion, checkpoint, merge intent or accepted review/owner credit.
    // (A source pin and its pending review reason are not credit; each boundary
    // below reads them separately.)
    if (task.completion || task.checkpoints.records.length || task.checkpoints.intent) return false;
    if (resolution.review || resolution.reviews.length || resolution.reviewSupersessions.length
      || resolution.ownerAcceptances.length || resolution.mechanicalVerification) return false;
    if (resolution.mergeIntent || resolution.mergeHead || resolution.mergeBase || resolution.mergeRequestedAt
      || resolution.mergedCommit || resolution.syncedCommit) return false;
    // No unknown delivery or durable side effect.
    if (resolution.workspaceRetirement || resolution.closeoutWorkspaceIntent || resolution.archiveIntentWorkspaceId
      || resolution.workspaceArchiveRetries.length || resolution.runtimeRetirements.length || resolution.buildOutputCleanups.length
      || resolution.finishedHook || resolution.hostProcessSweep || resolution.mergeResponseOutcome === "uncertain") return false;
    // No attention, recovery or recorded work instruction is outstanding.
    if (resolution.incident || resolution.recovery || resolution.recoveryActive || resolution.stalledTurnStop
      || resolution.attention || resolution.deferredVerb || resolution.pendingWorkerInstruction
      || resolution.revisionInstruction || resolution.prePrResumeInstruction) return false;
    return true;
  }
  /**
   * A queued review-entry task binds an existing external workspace at intake,
   * so its `workspaceId` is provenance rather than a dispatch (task 401). The
   * pre-dispatch dependency correction stays available until anything about
   * this task has run, been dispatched or is still pending. A legacy owner-head
   * receipt and its pending review reason remain recorded source decisions, so
   * the dependency boundary still refuses them. Current controls cannot create
   * either; no supplied input overrides proof of no dispatch.
   */
export function reviewEntryBeforeFirstRun(facts: ReviewEntryFacts, task: Task): boolean {
    if (!reviewEntryUnrun(facts, task)) return false;
    const resolution = task.resolution;
    return !(resolution.externalOwnerRevisions?.length || resolution.pendingReviewReason);
  }
  /**
   * The same unrun review-entry fact, read by the owner closeout
   * reconciliation (task 408): a queued review-entry task that never dispatched
   * is the one shape whose own PR may have merged outside Queue before any
   * reviewer existed. The dependency correction and external-merge
   * reconciliation both read `reviewEntryUnrun`, so no second
   * boundary can drift from them. `enclosing` is the authenticated
   * durable invocation executing this control (task 404).
   */
