import { RETAINED_PREREQUISITE_REFUSAL, NO_RESOLUTION_RUN_REFUSAL, restartTerminalRefusal } from "./verb-refusal-text";
import { DISPOSITION_CONTROL_REFUSAL, parkedRestartRefusal } from "./control-refusals";
import { z } from "zod";
import { reviewAllowanceText } from "../../shared/contracts";
import { holdsOf, incidentBindsCurrentWork, isDispositionActive, isDispositionComplete, taskControlInputSchema, type Run, type Task, type TaskControlInput } from "../../shared/contracts";
import { retainedProfileRemapPark } from "../recovery/task-reasons";
import { reviewContinuationLocalRefusal } from "../review/review-continuation";
import { OWNER_STOP_HOLD_PREFIX } from "../merge/merge-hold";
import type { AgentObservation } from "../host/adapter";
import { reviewerIdentityAtHead, reviewContinuationLimit, reviewResultFencesRun } from "../review/review-continuation";
import { runFenceRefusal, runSettlement } from "../intake/run-settlement";
import { ownerStoppedRunIds, neverDispatched, workerBlockedOnOwnRun, prIdentity, escalatedEpisode, escalationBackedByLiveWork, retainedWorkerDeliveryRefusal, replacementAllowanceNote } from './owner-facts';
import type { OwnerVerbFacts } from './owner-facts';
import { verbInput, restartRoles } from './owner-shared';
import type { RestartRole, OwnerVerb } from './owner-shared';
import { unreportedExecutorRun } from '../qa/proof-execution';

/**
 * Round 4 (Tom, 2026-10-19): what `restart` does when no run of the role needs
 * one. It re-runs a parked step: a never-dispatched park, a blocked task behind
 * its retained PR, or a parked resolution check. Or it answers an escalation
 * with the restart's reason once nothing live backs it (owner-only). Store
 * reads only; the engine dispatches the same result, so `next` and the handler
 * agree.
 */
type ParkedRestart =
  | { kind: "retry" | "answer"; note?: string }
  | { refusal: string };

/**
 * Whether `restart` takes the parked step instead of the role's run shape. A
 * parked task with no current run is restarted from its parked result, not
 * from an older run: a historical stopped reviewer is not the target, so the
 * parked step and its exact PR-head checks apply (project-a #1863, #1900), and a
 * task parked past work (a syncing task whose sync failed) rechecks that step
 * rather than restarting its worker.
 */
const RESOLUTION_PHASES = ["awaiting_review", "reviewing", "verifying", "merging", "syncing", "closing"];

/**
 * A worker role-shape this task cannot serve at all: there is no retained worker,
 * workspace and route to act on. The parked step is then the only path, so its own
 * refusal is the truthful answer and must not be replaced by a misleading
 * worker-route error in either the view or the applied control.
 */
export function unservedParkedStep(task: Task, shape: RestartShape | null): boolean {
  const workerShape = shape !== null && ["retained_worker", "blocked_worker", "blocked_with_pr", "stopped_revision"].includes(shape);
  return workerShape && !(task.agentId && task.workspaceId && task.profile);
}

export function restartTakesParkedStep(task: Task, shape: RestartShape | null, facts: OwnerVerbFacts,
  options: { explicitRole?: boolean } = {}): boolean {
  if (!shape) return true;
  if (shape === "owner_stopped_worker") return false;
  const stoppedByOwner = ownerStoppedRunIds(facts.events);
  if (shape === "retained_worker" && task.runId && stoppedByOwner.has(task.runId)) return false;
  if (shape === "stopped_revision") {
    const revision = facts.runs.findLast(run => run.role === "revision" && !run.released && run.agentId === task.agentId);
    if (revision && stoppedByOwner.has(revision.id)) return false;
  }
  if (task.resolution.currentRunId) return false;
  // A worker shape the task cannot serve is not the target either: a task with
  // no retained worker (a review entry whose reviewer blocked), or one parked
  // for a worker-profile remap, which only the parked step performs (review #539).
  const workerShape = ["retained_worker", "blocked_worker", "blocked_with_pr"].includes(shape);
  const unservedWorker = workerShape && (!(task.agentId && task.workspaceId && task.profile) || retainedProfileRemapPark(task, facts.events));
  const historical = shape === "stopped_reviewer" || unservedWorker
    || RESOLUTION_PHASES.includes(task.phase) && !["stalled_run", "checkpoint_reviewer", "absent_resolution", "coordinator"].includes(shape);
  if (!historical) return false;
  const parked = parkedRestart(facts);
  return "kind" in parked && parked.kind === "retry";
}

export function parkedRestart(facts: OwnerVerbFacts): ParkedRestart {
  const { task, runs } = facts;
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
    return { refusal: RETAINED_PREREQUISITE_REFUSAL };
  if (task.phase === "needs_attention" && (neverDispatched(facts) || task.resolution.attention)) return { kind: "retry" };
  if (["blocked", "error"].includes(task.phase)) {
    const last = runs.filter(run => run.role !== "recovery").at(-1);
    if (!workerBlockedOnOwnRun(task, facts) && !last?.completion) return { refusal: NO_RESOLUTION_RUN_REFUSAL };
    if (!prIdentity(task)) return { refusal: "The blocked result carries no retained PR; restart the pre-PR worker instead" };
    return { kind: "retry" };
  }
  // Any other phase parked in attention with no live run rechecks its repaired
  // condition through the same handler (a syncing task whose sync failed).
  const current = task.resolution.currentRunId ? runs.find(run => run.id === task.resolution.currentRunId) : undefined;
  const live = runs.find(run => !run.released && run.id !== facts.reportingRunId);
  if (task.resolution.attention && !["done", "cancelled"].includes(task.phase) && !isDispositionComplete(task)
    && !live && !(current && !current.completion)) return { kind: "retry" };
  if (escalatedEpisode(task, runs)) {
    if (live) return { refusal: `An unreleased ${live.role} run still owns this task; settle that run before resolving the recorded recovery episode` };
    if (escalationBackedByLiveWork(task, runs)) return { refusal: "The recorded recovery episode is still backed by the task's own work or fault; finish the task or clear its fault before resolving the episode" };
    return { kind: "answer" };
  }
  return { refusal: `Nothing is parked while the task is ${task.phase}` };
}

/**
 * The role `restart` acts on when the owner names none (Spec 050): the role of
 * the task's active run, else reviewer while a review is live, else the worker.
 */
export function deriveRestartRole(task: Task, runs: Run[]): RestartRole {
  const current = task.resolution.currentRunId ? runs.find(run => run.id === task.resolution.currentRunId) ?? null : null;
  if (current && !current.released && ["recovery", "closeout"].includes(current.role)) return "coordinator";
  // nucleus#1195: a live proof executor that has not reported is owed a report,
  // not a worker or review continuation; its own run owns the next move.
  if (unreportedExecutorRun(runs)) return "executor";
  // Task 405: an absent proof-execution creation resumes through the same
  // absent-resolution restart path; its own run carries the return phase.
  if (current && !current.released && current.role === "executor") return "reviewer";
  if (task.phase === "reviewing" || task.phase === "awaiting_review") return "reviewer";
  return "worker";
}

/**
 * The restartable state of one role, derived from the task's recorded facts
 * (store reads only). The engine dispatches the same shapes, so the read view
 * and the applied control select the same path. A retained-worker candidate
 * still needs the shared eligibility check and fresh backend observation.
 */
export type RestartShape =
  | "pre_dispatch" | "absent_worker" | "blocked_worker" | "blocked_with_pr"
  | "stopped_revision" | "stalled_run" | "retained_worker" | "owner_stopped_worker"
  | "checkpoint_reviewer" | "stopped_reviewer" | "absent_resolution" | "coordinator"
  | "unreported_executor";

/**
 * Whether a reviewer run can be the run a relaunch keeps or continues. A
 * superseded run is history whatever its lease says: a relaunch never re-binds
 * it, and its lease is settled (or reported) as a fence by the same path. A
 * stopped reader that was never superseded keeps its existing place, so an
 * explicitly stopped reader may still continue at the same head.
 */
export function isReviewerRelaunchTarget(run: Run): boolean {
  return run.role === "reviewer" && !run.completion && run.status !== "superseded";
}

/** A reviewer run that is superseded history: never a relaunch target, only a lease to settle or fence. */
export function settledReviewerHistory(run: Run): boolean {
  return run.role === "reviewer" && !run.completion && run.status === "superseded";
}

/** A new run cannot reuse the retained plain-handover reader's run-bound view. */
export function plainHandoverFreshRestart(task:Task,runs:Run[]):string|null {
  if(!task.reviewEntry)return null;
  const reader=(task.resolution.currentRunId?runs.find(run=>run.id===task.resolution.currentRunId):null)
    ??runs.findLast(run=>isReviewerRelaunchTarget(run));
  if(!reader||reader.role!=='reviewer'||reader.completion||!reader.agentId||(reader.reviewCheckpoints?.length??0)>0)return null;
  return `Reviewer ${reader.id} has no checkpoint to continue on its existing run; it has no pinned view. Use restart role=reviewer fresh to deliberately start a new reader and view; the old run stays history.`;
}

const restartResolutionRoles = ["reviewer", "closeout", "recovery", "executor"] as const;

export function restartShape(task: Task, runs: Run[], role: RestartRole, events: OwnerVerbFacts["events"] = []): RestartShape | null {
  const current = task.resolution.currentRunId ? runs.find(run => run.id === task.resolution.currentRunId) ?? null : null;
  const incident = task.resolution.incident;
  const fault = incident && incident.status !== "resolved" && incidentBindsCurrentWork(task, runs) ? incident : null;
  // nucleus#1195: the proof execution role has exactly one continuation shape —
  // an unreleased executor whose result never arrived.
  if (role === "executor") return unreportedExecutorRun(runs) ? "unreported_executor" : null;
  if (role === "worker") {
    const ownerStopped = ownerStoppedRunIds(events);
    // A stall whose stop is already confirmed is no longer a live stop: the run
    // has been released and the shape that matters is the continuation.
    const stalledStop = task.resolution.stalledTurnStop;
    if (fault?.cause === "stalled_turn" && stalledStop?.status !== "stopped" && stalledStop?.status !== "completed") return "stalled_run";
    if (task.agentIntent && !task.agentId) return "absent_worker";
    // A task with no live worker and no PR can always be returned to dispatch,
    // even when a previous owner move left a historical runId or a nonstandard
    // phase such as changes_requested. Uncertain worker creation remains its
    // own shape above; every other unreleased run still owns the task.
    if (!task.agentId && !task.agentIntent && !runs.some(run => !run.released)
      && !task.resolution.currentRunId && !task.resolution.recoveryActive
      && !task.completion && !prIdentity(task) && !task.resumePrNumber && task.phase !== "queued") return "pre_dispatch";
    const stoppedRevision = runs.findLast(run => run.role === "revision" && !run.completion && !run.released
      && run.agentId === task.agentId && run.workspaceId === task.workspaceId);
    if (stoppedRevision && (["changes_requested", "needs_attention", "blocked", "error"].includes(task.phase)
      || ownerStopped.has(stoppedRevision.id) && task.lastAgentStatus === "idle" && task.agentActive === false))
      return "stopped_revision";
    // The initial worker has no Run row. A stop audit must name its exact run,
    // and Queue's latest observation must positively show the bound thread idle.
    if (task.phase === "working" && task.runId && ownerStopped.has(task.runId) && task.agentId && task.workspaceId
      && task.profile && !runs.some(run => run.id === task.runId) && task.lastAgentStatus === "idle" && task.agentActive === false
      ) return "owner_stopped_worker";
    if (["blocked", "error"].includes(task.phase))
      return prIdentity(task) || task.completion?.prNumber || task.resumePrNumber ? "blocked_with_pr" : "blocked_worker";
    if (task.agentId && task.workspaceId && task.profile
      && (task.phase === "changes_requested" || (task.phase === "needs_attention" && !task.resolution.currentRunId))) return "retained_worker";
    return null;
  }
  if (role === "reviewer") {
    // A stalled live reviewer is stopped through the durable targeted stop, like a worker.
    const stalledStop = task.resolution.stalledTurnStop;
    if (fault?.cause === "stalled_turn" && stalledStop?.status !== "stopped" && stalledStop?.status !== "completed") return "stalled_run";
    if (current && current.role === "reviewer" && !current.released && !current.completion
      && (current.reviewCheckpoints?.length ?? 0) > 0) return "checkpoint_reviewer";
    const absent = runs.find(run => !run.released && !run.agentId && run.status === "uncertain"
      && restartResolutionRoles.includes(run.role as typeof restartResolutionRoles[number]));
    if (absent) return "absent_resolution";
    // Only a run the store reads as stopped can be replaced fresh. A live,
    // healthy reviewer turn is never a restart target, and a superseded run is
    // history: the shape still names the stopped-reviewer state so the verb can
    // act, but the run itself is never the target a relaunch keeps.
    const stopped = runs.findLast(run => isReviewerRelaunchTarget(run)
      && (run.status === "finished" || (run.status === "running" && run.active !== true)
        || (run.status === "uncertain" && run.agentId && run.active !== true)));
    const stoppedHistory = runs.some(settledReviewerHistory);
    if ((stopped || stoppedHistory) && ["reviewing", "awaiting_review", "needs_attention", "blocked", "error"].includes(task.phase)) return "stopped_reviewer";
    return null;
  }
  const recovery = task.resolution.recovery;
  const agentlessRecovery = recovery?.status === "escalated" && runs.find(run => run.id === recovery.runId
    && run.role === "recovery" && !run.released && !run.agentId && !run.completion && ["intent", "uncertain"].includes(run.status));
  if (agentlessRecovery) return "coordinator";
  const absent = runs.find(run => !run.released && !run.agentId && run.status === "uncertain"
    && restartResolutionRoles.includes(run.role as typeof restartResolutionRoles[number]));
  if (absent) return "absent_resolution";
  const stoppedRecovery = runs.findLast(run => ["recovery", "closeout"].includes(run.role) && !run.completion
    && (run.released || run.status === "superseded"));
  if (stoppedRecovery) return "coordinator";
  if (task.resolution.recovery && task.resolution.recovery.status !== "resolved") return "coordinator";
  return null;
}

/** A definite refusal before a restart has changed state or sent anything. */
export class RestartRefusal extends Error {}

/**
 * Local prerequisites shared by next and ordinary worker restart. Saved
 * activity names a required observation; only that fresh observation authorizes
 * the handler or refuses the intent for current activity.
 * Stalled-stop and absent-creation recovery have their own lifecycle proofs.
 */
export function workerRestartRefusal(facts: OwnerVerbFacts, shape: RestartShape, observed?: AgentObservation): string | null {
  if (!["blocked_worker", "retained_worker", "blocked_with_pr", "stopped_revision", "owner_stopped_worker"].includes(shape)) return null;
  const { task } = facts;
  if (!task.agentId || !task.workspaceId || !task.profile)
    return "Worker restart requires the retained worker, workspace and route";
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt)
    return RETAINED_PREREQUISITE_REFUSAL;
  const delivery = retainedWorkerDeliveryRefusal(facts);
  if (delivery) return delivery;

  if (observed && (observed.id !== task.agentId || observed.workspaceId !== task.workspaceId))
    return "The retained worker's agent or workspace identity changed; inspect placement before restarting";
  if (observed?.permissions)
    return "The retained worker is waiting on a permission request; resolve it before restarting";
  // A read-only plan names the observation execution must perform. Cached
  // worker activity cannot refuse an intent before that fresh read.
  if (!observed) return null;
  if (observed.active || observed.activeTurnId || ['running', 'initializing'].includes(observed.status))
    return "The retained worker is active or awaiting a response; wait for idle, or use route now to stop and replace it. Route without now selects a subsequent run";
  if (!['idle', 'error', 'closed'].includes(observed.status))
    return `The retained worker is not proven idle (status: ${observed.status}); wait for a supported idle observation before restarting`;
  return null;
}

/**
 * The retained-continuation plan one checkpointed reviewer offers: the run, its
 * latest checkpoint, whether execution records the verb for later (paused or
 * held) or delivers now, the observation it must still make, and the fence it
 * would be refused by. `restart role=reviewer` and the preserving
 * `move to=review` read this one derivation, so the move can never advertise a
 * continuation its delegated restart would refuse (review 5672912042).
 */
type RetainedContinuationPlan =
  | { kind: "refused"; refusal: string }
  | { kind: "fresh_only"; note: string }
  | { kind: "ready"; current: Run; checkpoint: NonNullable<Run["reviewCheckpoints"]>[number]; note?: string; deferred: boolean };

/** The owner-facing line for the last reading refused past the allowance; empty when none was refused. */
function rejectedReadingNote(run: Run): string {
  const reading = run.reviewRejectedReadings?.at(-1);
  if (!reading) return "";
  const { covered, remaining } = reading.checkpoint;
  return ` The last reading refused past the allowance (${covered.length} covered, ${remaining.length} remaining items, at ${reading.at}) is kept on run ${run.id} as evidence, not as a checkpoint, and grants no continuation.`;
}

export function retainedContinuationPlan(facts: OwnerVerbFacts): RetainedContinuationPlan | null {
  const { task, runs } = facts;
  const current = runs.find(run => run.id === task.resolution.currentRunId);
  const checkpoint = current?.reviewCheckpoints?.at(-1);
  if (!current || !checkpoint || current.role !== "reviewer") return null;
  // The same identity result the move reads: a reviewer whose source, receipt or
  // brief binding cannot be proved is refused here, never silently treated as
  // absent, and `next` never throws for it.
  const identity = reviewerIdentityAtHead(task, facts.store, current.head);
  if (identity.kind === "refused") return { kind: "refused", refusal: identity.refusal };
  // Only an incident bound to the current work fences the reader: one recorded
  // against a released run was superseded by the run that replaced it
  // (papercuts 89643af2, 6ff5e903). Its record stays readable and the owner's
  // own verb settles it with everything else it supersedes.
  if (incidentBindsCurrentWork(task, runs) && task.resolution.incident?.status === "reconciling")
    return { kind: "refused", refusal: "Automatic reconciliation still owns the task incident; continue the review after it settles" };
  if (reviewResultFencesRun(facts.store, task, current))
    return { kind: "fresh_only", note: `A recorded ${task.resolution.review?.status} result at ${task.resolution.review?.head ?? "an unproved head"} fences checkpoint ${checkpoint.ordinal} on run ${current.id}; continue with restart role=reviewer fresh or move to=review fresh.` };
  // Two established causes make the retained-agent continuation impossible: the
  // checkpoint budget is spent, or the reviewer's own agent was positively
  // observed closed. Both keep the lease and the saved progress, and both are
  // recovered by the existing fresh-review verbs at the same exact head.
  if (current.reviewBudgetExhaustedAt || current.retainedAgentClosedAt)
    return { kind: "fresh_only", note: `${current.reviewBudgetExhaustedAt
      ? "The reviewer spent its checkpoint budget and stopped"
      : `The reviewer's agent was observed closed${current.retainedAgentClosedAt ? ` at ${current.retainedAgentClosedAt}` : ""}`} with checkpoint ${checkpoint.ordinal} at ${current.head} still saved on run ${current.id} (agent ${current.agentId ?? "unknown"}). A same-agent continuation cannot land; this restarts with a fresh reviewer at the same recorded head. move to=review preserves the readers it can continue, so it refuses this one and names this restart; route role=reviewer with now also replaces it deliberately.${rejectedReadingNote(current)}` };
  // The handler records the continuation while a dispatch hold stands. The
  // owner's own stop hold yields to that owner's restart
  // (`dispatchWaitsFor`): in the yielding case `continueRetainedReviewer` runs
  // admission immediately, so the view must run the same gate and never offer a
  // continuation the apply would refuse (review 5674217621). The continuation's
  // own transition settles the episode the checkpoint awaits and any finished run
  // of another role, so only the reviewer itself fences here; every other
  // unreleased run is derived through the same settlement rule execution uses.
  const dispatch = holdsOf(task).dispatch;
  const ownerStopYields = Boolean(dispatch?.reason.startsWith(OWNER_STOP_HOLD_PREFIX));
  const deferred = Boolean(dispatch) && !ownerStopYields;
  if (deferred) return { kind: "ready", current, checkpoint, deferred };
  const recovery = task.resolution.recovery;
  const episodeRunId = recovery && recovery.status !== "resolved" ? recovery.runId ?? null : null;
  const settling: string[] = [];
  const observing: string[] = [];
  for (const run of runs) {
    if (run.released || run.id === current.id || run.role === "reviewer") continue;
    const settlement = runSettlement(facts, run, { direct: run.id === episodeRunId && Boolean(run.completion) });
    if (settlement.kind === "fences") return { kind: "refused", refusal: runFenceRefusal(run, settlement.why) };
    if (settlement.kind === "observes") observing.push(`${run.role} run ${run.id} (agent ${run.agentId ?? 'unbound'}, workspace ${run.workspaceId})`);
    settling.push(run.id);
  }
  let local: ReturnType<typeof reviewContinuationLocalRefusal>;
  try {
    local = reviewContinuationLocalRefusal(facts.store, task, current, { runId: current.id, head: current.head, checkpointOrdinal: checkpoint.ordinal },
      { settling: { runIds: settling }, paused: false, ownerStopYields: true });
  } catch (error) {
    // A binding that cannot be read is a refusal for the view, never a thrown read.
    return { kind: "refused", refusal: `the reviewer's continuation binding cannot be proved: ${error instanceof Error ? error.message : String(error)}` };
  }
  if ("refusal" in local) return { kind: "refused", refusal: local.refusal };
  return { kind: "ready", current, checkpoint, deferred: false,
    ...(observing.length ? { note: `Nucleus freshly observes ${observing.join('; ')} before continuing the reviewer. A changed identity, live turn, pending permission, tool or effect can refuse settlement; saved activity alone cannot.` } : {}) };
}

/**
 * `restart` (Spec 050): get a stopped, stalled or checkpointed run going again
 * with one owner call. The role is derived from the phase when omitted. Queue
 * settles the fences the restart supersedes, stops or releases the old run and
 * starts the next one: the same agent continuing by default, or a fresh agent
 * on the role's current route when `fresh` is set. Every identity is derived
 * here; the owner supplies only a reason and, optionally, an instruction.
 */
export const restart: OwnerVerb = {
  verb: "restart",
  action: "restart",
  input: verbInput({
    role: z.enum(restartRoles).optional(),
    instruction: z.string().trim().min(1).max(12000).optional(),
    fresh: z.boolean().optional(),
    reason: z.string().trim().min(1).max(4000),
  }),
  applicable: (facts) => {
    const { task, runs } = facts;
    if (isDispositionActive(task)) return { available: false, refusal: DISPOSITION_CONTROL_REFUSAL };
    if (["done", "cancelled"].includes(task.phase) || task.resolution.mergedCommit) {
      // A finished or merged task restarts no run. A merged one still re-runs its
      // parked step (a closeout resynchronization), and an escalation left on
      // either is still the owner's to answer, with the restart's reason.
      const parked = parkedRestart(facts);
      if ("kind" in parked && (parked.kind === "answer" || task.resolution.mergedCommit && !["done", "cancelled"].includes(task.phase)))
        return { available: true, fill: ["reason"], args: { taskId: task.id, version: task.version } };
      return { available: false, refusal: restartTerminalRefusal(task, "refusal" in parked ? parked.refusal : undefined) };
    }
    const role = deriveRestartRole(task, runs);
    const shape = restartShape(task, runs, role, facts.events);
    // nucleus#1195: one bounded continuation asks a live proof executor whose
    // result never arrived to resend that report on its existing run and
    // credential. It re-runs no selector and starts no run, so the view names the
    // fresh observation execution makes and the one request already sent.
    if (shape === "unreported_executor") {
      const executor = unreportedExecutorRun(runs)!;
      const asked = facts.events.some(event => event.kind === "executor_report_request_sent" && event.detail.startsWith(`${executor.id}:`));
      return asked
        ? { available: false, refusal: `The re-report request for proof executor run ${executor.id} was already sent; its result is still outstanding. Inspect the executor's thread, or use tell role=executor` }
        : { available: true, fill: ["reason"], args: { taskId: task.id, version: task.version, role: "executor" },
            note: `Asks the same proof executor (run ${executor.id}, agent ${executor.agentId}) to resend its report only, on its existing run credential. Nucleus freshly observes the executor first: a live turn or an unreadable identity refuses before anything is sent. The selector is never re-run and no run is started.` };
    }
    if (!shape || restartTakesParkedStep(task, shape, facts)) {
      const parked = parkedRestart(facts);
      if ("refusal" in parked)
        return { available: false, refusal: parkedRestartRefusal(role, parked.refusal) };
      return { available: true, fill: ["reason"], args: { taskId: task.id, version: task.version }, ...(parked.note ? { note: parked.note } : {}) };
    }
    // No worker shape can act on a task with no retained worker/route: surface the
    // parked step's own refusal rather than a misleading role-shape one.
    if (shape && unservedParkedStep(task, shape)) {
      const parked = parkedRestart(facts);
      if ("refusal" in parked)
        return { available: false, refusal: parkedRestartRefusal(role, parked.refusal) };
    }
    let observationNote: string | undefined;
    if (shape === "checkpoint_reviewer") {
      // The same plan a preserving `move to=review` reads: one derivation, so the
      // two views cannot advertise different answers for the same checkpoint.
      const plan = retainedContinuationPlan(facts);
      if (plan?.kind === "refused") return { available: false, refusal: plan.refusal };
      if (plan?.kind === "fresh_only") return {
        available: true, fill: ["reason"],
        args: { taskId: task.id, version: task.version, role: "reviewer", fresh: true },
        note: plan.note,
      };
      if (plan?.kind === "ready") observationNote = [`Checkpoint allowance: ${reviewAllowanceText(plan.checkpoint.ordinal, reviewContinuationLimit(facts.store))}.`, plan.note].filter(Boolean).join(" ");
    }
    if(shape==='stopped_reviewer'){
      const uncertain = runs.findLast(run => run.role === 'reviewer' && !run.completion && run.status === 'uncertain' && run.agentId);
      if (uncertain) return { available: true, fill: ['reason'], args: { taskId: task.id, version: task.version, role: 'reviewer', fresh: true },
        note: `First reconcile the uncertain dispatch for reviewer run ${uncertain.id}: Nucleus reads the closed/archived agent's timeline for ns-run-${uncertain.id}; a present message or unreadable evidence keeps the fence. If absent, this starts a fresh reviewer at the same head.` };
      const note=plainHandoverFreshRestart(task,runs);
      if(note)return {available:true,fill:['reason'],args:{taskId:task.id,version:task.version,role:'reviewer',fresh:true},note};
    }
    const refusal = workerRestartRefusal(facts, shape);
    if (refusal) return { available: false, refusal };
    if (["blocked_worker", "retained_worker", "blocked_with_pr", "stopped_revision"].includes(shape))
      observationNote = `Nucleus freshly observes retained worker ${task.agentId} in workspace ${task.workspaceId} before restarting. An active turn, pending permission or changed identity refuses the action; saved activity alone cannot.`;
    // At the worker ceiling, only an operator-relayed fresh worker restart can
    // arm another replacement. The note reports that exit; reviewer and
    // coordinator shapes carry no worker allowance.
    const allowanceNote = ["blocked_worker", "retained_worker", "blocked_with_pr", "stopped_revision"].includes(shape ?? "")
      ? [observationNote, replacementAllowanceNote(task)].filter(Boolean).join(" ") || undefined
      : observationNote;
    // Tom, 2026-10-23 ("Worker continues"): on a blocked or errored task with a
    // PR, a restart without a role resumes into review, and an explicit
    // role "worker" continues the retained worker on its PR. The offered args
    // keep the default, so a caller copying them gets today's outcome.
    if (shape === "blocked_with_pr")
      return { available: true, fill: ["reason"], args: { taskId: task.id, version: task.version },
        note: 'Without a role this resumes from the run that blocked: the worker\'s own block returns to the worker, a reviewer\'s or another resolution run\'s resumes into review or its step. Add role: "worker" (optionally with an instruction, or fresh: true for a fresh worker on its route) to continue the retained worker on its PR in every case.' + (allowanceNote ? ` ${allowanceNote}` : '') };
    return { available: true, fill: ["reason"], args: { taskId: task.id, version: task.version, role }, ...(allowanceNote ? { note: allowanceNote } : {}) };
  },
  apply: (call, args) => call(taskControlInputSchema.parse({ action: "restart", ...args }) as TaskControlInput),
};

