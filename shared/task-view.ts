import { sameCallerIdentity } from './agent-identity';
import type { Task, Run, Project, RepositorySettings, TaskDetail, TaskSummary, Completion, CompletionPolicy, CompletionMembership, WorkerExclusion, OwnerAcceptanceRecord, HoldKind, UnchangedBoard, AwaitingProof, ProofRoute } from "./contracts";
import type { Incident } from "./incident";
import { isDispositionComplete } from "./disposition";
import { holdsOf, syncHoldProjection, taskHoldKind, holdOwnerOf, taskOwner, holdFencesView, holdEscalated, isOperatorOrigin } from "./holds";
import { deriveWaitState, type WaitStateContext } from "./wait-state";
import { taskBudget, taskBudgetBoardView, type BudgetEvent, type TaskBudgetView } from "./task-budget";
import { reportHeadline, TASK_PROGRESSING_REASON } from "./task-detail-summary";
import { taskSummarySchema } from "./schema/task-view";
import { DISPATCH_WAIT_REASON, isWaitingTaskStop, type TaskStopRecord, type TaskStopKind } from "./task-stop";
export * from "./task-stop";

/**
 * The completion membership a `done` transition freezes from recorded task
 * history: the opted-in origin entry, the immutable creator nominations and the
 * self-service subscriptions, with a `subscribed: false` entry removing a
 * recipient and its workspace staying the recorded one, deduplicated by agent
 * and sorted. One fact with one owner (Spec 040): the freeze, the recovery
 * preflight's remaining-responsibility check and the completion receipt all read
 * this function instead of restating the rules.
 *
 * An origin entry is keyed by the creator and delivered to the task's current
 * owner (`originRecipient`); every other creator or self entry is delivered to
 * its recorded recipient.
 */
export function completionMembership(policy: CompletionPolicy): CompletionMembership[] {
  const members = new Map<string, {agentId:string;workspaceId:string;sources:Set<"origin"|"creator"|"self">;originEntry:boolean}>();
  const add = (agentId:string, workspaceId:string, source:"origin"|"creator"|"self", originEntry=false) => {
    const key = [...members.keys()].find(id => sameCallerIdentity(id,agentId)) ?? agentId;
    const member=members.get(key)??{agentId:key,workspaceId,sources:new Set(),originEntry:false};
    member.workspaceId=workspaceId;member.sources.add(source);member.originEntry ||= originEntry;members.set(key,member);
  };
  // The owner's entry is keyed by the creator and delivered to whoever owns the
  // task now (`originEntry`). A creator that nominated itself, or the owner's own
  // subscription choice, is that same entry, never a literal copy of a thread that
  // may since have handed the task on (Tom, 2026-10-26: one owner field).
  const owner=taskOwner(policy),origin=policy.originAgentId,ownerEntry=(agentId:string)=>sameCallerIdentity(agentId,origin)||sameCallerIdentity(agentId,owner);
  if(policy.notifyOriginOnCloseout && policy.originWorkspaceId)add(origin,policy.originWorkspaceId,"origin",true);
  for(const recipient of policy.creatorCompletionRecipients){
    if(ownerEntry(recipient.agentId))add(origin,policy.originWorkspaceId??recipient.workspaceId,"creator",true);
    else add(recipient.agentId,recipient.workspaceId,"creator");
  }
  for(const override of policy.completionSubscriptionOverrides){
    const key=ownerEntry(override.agentId)?origin:override.agentId;
    if(override.subscribed)add(key,key===origin?policy.originWorkspaceId??override.workspaceId:override.workspaceId,"self",key===origin);
    else for (const id of members.keys()) if (sameCallerIdentity(id,key)) members.delete(id);
  }
  return [...members.values()].sort((a,b)=>a.agentId.localeCompare(b.agentId)).map(member=>({
    agentId:member.agentId,workspaceId:member.workspaceId,sources:[...member.sources].sort() as ("origin"|"creator"|"self")[],originEntry:member.originEntry,
  }));
}

/**
 * A bare string has no route of its own. The reviewer-side router gives it one
 * author round at its head (task 539); this reads it as external for a parked
 * record, which is what a bare string meant before the route existed.
 */
export const awaitingProofRoute = (proof: AwaitingProof): ProofRoute => typeof proof === 'string' ? 'external' : proof.route;

export const awaitingProofText = (proof: AwaitingProof): string => typeof proof === 'string' ? proof : proof.proof;

export const awaitingProofTexts = (proofs: readonly AwaitingProof[] | null | undefined): string[] => (proofs ?? []).map(awaitingProofText);

export function workerExclusionFor(task: Pick<Task, "workerExclusions">, agentId: string | null | undefined, profileId: string | null | undefined): WorkerExclusion | null {
  return task.workerExclusions.find(exclusion => Boolean(exclusion.agentId && exclusion.agentId === agentId)
    || Boolean(exclusion.profileId && exclusion.profileId === profileId)) ?? null;
}

export function workerProfileIsExcluded(task: Pick<Task, "workerExclusions">, profileId: string): boolean {
  return task.workerExclusions.some(exclusion => exclusion.profileId === profileId);
}

/**
 * The task fields the acceptance helper reads; a full task or a test shape satisfies it.
 */
type AcceptanceTask = Pick<Task, "prHead" | "reviewEntry" | "resumePrNumber" | "completion" | "resolution">;


/**
 * The qualified owner acceptance that authorizes merging right now, or null.
 * It must still bind the task's current PR head and the recorded review's exact
 * identity, so a changed head or a re-reviewed task leaves only history.
 */
export function qualifiedOwnerAcceptance(task: AcceptanceTask): OwnerAcceptanceRecord | null {
  const review = task.resolution.review;
  if (!review || !task.prHead) return null;
  const prNumber = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber ?? null;
  for (const record of [...(task.resolution.ownerAcceptances ?? [])].reverse()) {
    if (record.kind !== "reviewed" || !record.review) continue;
    if (record.head !== task.prHead || record.prNumber !== prNumber) continue;
    const bound = record.review;
    if (bound.runId !== review.runId || bound.eventId !== review.eventId || bound.head !== review.head || bound.status !== review.status) continue;
    return record;
  }
  return null;
}


/**
 * The explicit operator source acceptance (2026-10-20) that authorizes merging
 * right now, or null. It binds only the exact current PR head and PR number —
 * never a review identity — so a changed head leaves only history and a new
 * head needs a fresh disposition.
 */
export function operatorSourceAcceptance(task: AcceptanceTask): OwnerAcceptanceRecord | null {
  if (!task.prHead) return null;
  const prNumber = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber ?? null;
  for (const record of [...(task.resolution.ownerAcceptances ?? [])].reverse()) {
    if (record.kind !== "operator_source" || record.head !== task.prHead || record.prNumber !== prNumber) continue;
    return record;
  }
  return null;
}


/** The kinds of recorded evidence that let a merge count for a task (task 993). */
export type MergeEvidenceKind = "ready_to_merge" | "source_approved" | "owner_reviewed" | "operator_source";

/**
 * The recorded review evidence at one exact head that lets a merge count for
 * the task whose head was reviewed (task 993), or null. The same accepted set
 * the merge gates read, judged at the merged head instead of the stored head:
 * an exact-head `ready_to_merge` verdict, a reviewer source approval awaiting
 * its proof at that head, the qualified owner acceptance bound to the recorded
 * review, or an explicit operator source acceptance. A verdict at another head
 * is history, never this head's evidence.
 */
export function mergeReviewEvidenceAt(task: AcceptanceTask, head: string): { kind: MergeEvidenceKind; detail: string } | null {
  const review = task.resolution.review;
  if (review?.status === "ready_to_merge" && review.head === head)
    return { kind: "ready_to_merge", detail: `the recorded ready_to_merge review of run ${review.runId} at ${head}` };
  if (review?.sourceApproved === true && review.awaitingProofs?.length && review.head === head)
    return { kind: "source_approved", detail: `the recorded reviewer source approval at ${head}, awaiting its proof(s): ${awaitingProofTexts(review.awaitingProofs).join("; ")}` };
  const atHead: AcceptanceTask = { ...task, prHead: head };
  const reviewed = qualifiedOwnerAcceptance(atHead);
  if (reviewed) return { kind: "owner_reviewed", detail: `the qualified owner acceptance at ${head} (${reviewed.reason.slice(0, 200)})` };
  const source = operatorSourceAcceptance(atHead);
  if (source) return { kind: "operator_source", detail: `the operator source acceptance at ${head}${source.missingEvidence ? ` (missing evidence recorded: ${source.missingEvidence.slice(0, 200)})` : ""}` };
  return null;
}

/**
 * The recorded stop that is still current. A `held` record belongs to the
 * fences: once none is left it is history, never a hold, and the next stop in
 * precedence shows instead. Release retires it in the same write; rows released
 * before that read the same way without being rewritten.
 */
export function currentTaskStop(task: Task, budget?: TaskBudgetView | null): TaskStopRecord | null {
  const stop = task.resolution.stop;
  // A budget pause is current only while the measured budget still shows it: the
  // pause's condition is the figure every gate and view reads (nucleus#1187), so a
  // pause the figure no longer supports is not the task's stop.
  if (stop?.reason === "budget" && budget && !budget.exhausted) return null;
  if (stop?.reason !== "held") return stop;
  const fences = holdsOf(task);
  return fences.dispatch || fences.merge ? stop : null;
}

/**
 * The reason a read shows for the task's current state (papercut 703b4aa3). A
 * recorded budget pause the measured budget no longer shows is not the task's
 * reason any more: oxide#083 kept reading "Budget reached" after the pause's own
 * figure had cleared. What the task is doing instead is the wait its phase carries
 * — dispatch for a queued task, progress for any other — so the reason, the stop
 * and the board badge never contradict each other (nucleus#1187).
 */
export function taskVisibleReason(task: Task, budget: TaskBudgetView | null | undefined): string {
  const stop = task.resolution.stop;
  if (stop?.reason !== "budget" || !budget || budget.exhausted) return task.reason;
  return task.phase === "queued" ? DISPATCH_WAIT_REASON : TASK_PROGRESSING_REASON;
}

/**
 * Whether a durable record that names a run still binds the task's current work.
 *
 * One rule for every read: an incident, notice, delivery, effect or recorded
 * result that names a released run names superseded work. A released run is
 * never a current participant, so such a record can never refuse, reclassify or
 * supply the actionable text for the current work; its own record, its history
 * and any unknown-delivery evidence stay readable and are never resent. A record
 * naming no run, or an identity this task cannot read, keeps its existing
 * handling: absence of proof is never a newer binding.
 */
export function runBindsCurrentWork(runs: Run[], runId: string | null | undefined): boolean {
  if (!runId) return true;
  const run = runs.find(candidate => candidate.id === runId);
  return !run || !run.released;
}

/** Whether an open incident still names the current work; a released run's fault is history. */
export function incidentBindsCurrentWork(task: Task, runs: Run[] = [], incident: Incident | null | undefined = task.resolution.incident): boolean {
  if (!incident || incident.status === "resolved") return false;
  return runBindsCurrentWork(runs, incident.runId);
}

/** Whether a recovery episode still owns the current work; a resolved episode is history. */
export function episodeBindsCurrentWork(task: Task): boolean {
  const recovery = task.resolution.recovery;
  return Boolean(recovery && recovery.status !== "resolved");
}

/**
 * The one stop or wait a task is in, in `task.next`'s precedence order: hold
 * fence, unresolved incident, owning recovery, attention park, a stopped or
 * checkpointed run, then a wait. Null while the task progresses. The full
 * reason, owner and evidence live in `task.next`; this names the category.
 */
export function taskStopKind(task: Task, runs: Run[] = [], budget?: TaskBudgetView | null): TaskStopKind | null {
  const fences = holdsOf(task);
  if (fences.dispatch || fences.merge) return "hold";
  const stop = currentTaskStop(task, budget);
  if (stop) {
    if (stop.reason === "run_stalled") return "run";
    if (isWaitingTaskStop(stop.reason)) return "wait";
    return "attention";
  }
  if (incidentBindsCurrentWork(task, runs)) return "incident";
  if (episodeBindsCurrentWork(task)) return "recovery";
  if (task.phase === "needs_attention") return "attention";
  // A checkpointed reviewer or a reported block is the stop even before any
  // incident bookkeeping exists; the runs are the evidence, never a flag pair.
  if (runs.some(run => run.role === "reviewer" && !run.released && !run.completion && (run.reviewCheckpoints?.length ?? 0) > 0)) return "run";
  if (["blocked", "error"].includes(task.phase) && task.completion) return "run";
  if (task.prerequisiteWait && !task.prerequisiteWait.releasedAt) return "wait";
  if (task.phase === "queued") return "wait";
  return null;
}

/**
 * Add the bounded, derived hold and wait fields at the task detail boundary.
 * Spec 043 (a): the wait state is a read, never a scheduling decision.
 */
export function taskDetailView(task: Task, context: WaitStateContext = {}, runs: Run[] = [], events: BudgetEvent[] = [], repository?: Pick<RepositorySettings, "affectedTests"> | null): TaskDetail {
  const holds = holdsOf(task);
  // One measurement: the budget this view shows is the one the gates read, and the
  // stop and reason it reports follow that same figure (nucleus#1187).
  const budget = !['done', 'cancelled'].includes(task.phase) ? taskBudget(task, runs, Date.now(), events, repository) : null;
  const reason = taskVisibleReason(task, budget);
  const holdKind = taskHoldKind(task);
  const waitState = deriveWaitState({
    phase: task.phase, reason, holdKind, holdOwner: holdOwnerOf(task, holds.merge?.owner ?? task.holdOwner),
    originAgentId: taskOwner(task), mergeHeld: Boolean(holds.merge),
  }, context);
  const stop = currentTaskStop(task, budget);
  return { ...task, reason, resolution: stop === task.resolution.stop ? task.resolution : { ...task.resolution, stop }, holds: syncHoldProjection(holds).holds, ...(holdKind ? { holdKind } : {}), ...(waitState ? { waitState } : {}), ...(budget ? { budget } : {}) };
}

export function taskHasUnreleasedRun(task: Task, hasUnreleasedResolutionRun = false): boolean {
  // A completed disposition proves its owned worker threads were drained. Older
  // task projections can still retain agentIntent/runId, or a run row that never got
  // an agent, so neither may resurrect a slot after cancellation has settled. Checked
  // first: cancelled project-a #1636 held a project slot for a week through a stuck
  // unreleased recovery run (2026-09-26 to 2026-10-03).
  if (isDispositionComplete(task) && ["done", "cancelled"].includes(task.phase)) return false;
  if (hasUnreleasedResolutionRun) return true;
  return task.agentActive === true || Boolean(task.agentIntent &&
    (!task.agentId || task.agentActive !== false && task.completion === null));
}

/**
 * Spec 058 (task 629; Tom, 2026-11-03): a run holds a capacity slot only while
 * its agent is live or starting. Settled (released, finished, superseded) and
 * reported (completion recorded, release pending) runs hold nothing, and an
 * agent observed gone (`active === false`) holds nothing. An unreleased intent with no agent
 * yet is starting; an uncertain run with no bound agent is still unsettled
 * unknown delivery, so it keeps holding until the settlement sweep releases it.
 */
export function runHoldsSlot(run: Run): boolean {
  if (run.released || run.status === "finished" || run.status === "superseded" || run.completion) return false;
  if (run.active === false) return false;
  return run.agentId != null || run.status === "intent" || run.status === "uncertain";
}

export function isParkedTask(task: Task, hasUnreleasedResolutionRun = false): boolean {
  return ["needs_attention", "awaiting_review", "changes_requested", "verifying"].includes(task.phase) &&
    !taskHasUnreleasedRun(task, hasUnreleasedResolutionRun) && !task.resolution.recoveryActive && !task.resolution.mergeIntent;
}

/** Task numbers are shown zero-filled to at least three digits (004, 049, 1631); storage stays an integer. */
export const formatTaskNumber = (number: number) => String(number).padStart(3, "0");

export const taskNumberLabel = (task: Pick<Task, "number" | "reference">, repositoryNeeded: boolean) =>
  task.number ? repositoryNeeded ? task.reference ?? `#${formatTaskNumber(task.number)}` : `#${formatTaskNumber(task.number)}` : "";

export function summarizeTask(task: Task, includeRepository = false, hasUnreleasedResolutionRun = false, waitContext: WaitStateContext = {}, taskRuns: Run[] = [], waitingOn?: string, defaultHostId?: string, events: BudgetEvent[] = [], repository?: Pick<RepositorySettings, "affectedTests"> | null): TaskSummary {
  const holds = holdsOf(task);
  // The board reads the same budget figure the gates do, and its stop and reason
  // follow that figure (nucleus#1187).
  const budget = !["done", "cancelled"].includes(task.phase) ? taskBudget(task, taskRuns, Date.now(), events, repository) : null;
  const reason = taskVisibleReason(task, budget);
  const stop = taskStopKind(task, taskRuns, budget), stopRecord = currentTaskStop(task, budget);
  const waitState = deriveWaitState({
    phase: task.phase, reason, holdKind: taskHoldKind(task), holdOwner: holdOwnerOf(task, holds.merge?.owner ?? task.holdOwner),
    originAgentId: taskOwner(task), mergeHeld: Boolean(holds.merge),
  }, waitContext);
  // Keep a short board reason plus the wait label and actor class. Full stop,
  // hold and wait detail, prerequisite occupant lists and long instructions
  // remain available from task detail.
  const boardWaitState = waitState ? {
    state: waitState.state,
    owner: waitState.state === "waiting_prerequisite" && waitState.owner !== "operator" && waitState.owner !== "Queue" ? "prerequisites" : waitState.owner,
    nextAction: waitState.state === "waiting_prerequisite"
      ? waitState.owner === "operator" ? "Correct the prerequisite list" : "Wait for prerequisites to finish"
      : waitState.nextAction.slice(0, 120),
    ...(waitState.decisionId ? { decisionId: waitState.decisionId } : {}),
  } : null;
  const fences = holdFencesView(task);
  return taskSummarySchema.parse({
    ...(boardWaitState ? { waitState: boardWaitState } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    id: task.id, title: task.title, repoPath: task.repoPath, ...(includeRepository ? { repository: task.repository || task.repoPath } : {}), version: task.version, number: task.number, reference: task.reference, entrypoint:task.entrypoint,
    ...(defaultHostId && task.hostId === defaultHostId ? {} : { hostId: task.hostId }),
    ...((() => { const ids = [...new Set([task.agentId, ...taskRuns.filter(run => !run.released && run.role === "reviewer" && (!run.hostId || run.hostId === task.hostId)).map(run => run.agentId)].filter((id): id is string => Boolean(id)))]; return ids.length ? { questionAgentIds: ids } : {}; })()),
    ...(task.interactive ? { interactive: true as const } : {}),
    phase: task.phase, reason: reason.slice(0, 160), held: task.held,
    ...(taskHoldKind(task) ? { holdKind: taskHoldKind(task)! } : {}),
    ...(fences ? { holds: fences } : {}),
    ...(task.held ? { hold: { owner: holdOwnerOf(task, task.holdOwner).slice(0, 80), reason: (task.holdReason ?? "not recorded").slice(0, 160), since: task.holdAt, ...(task.holdBlocking ? { blockingSince: task.holdBlocking.since } : {}) } } : {}),
    ...(holdEscalated(task) ? { holdEscalated: true } : {}),
    ...(stop ? { stop } : {}),
    ...(stopRecord ? { stopRecord: { ...stopRecord, detail: stopRecord.detail.slice(0, 160) } } : {}),
    ...(task.resolution.hostWait ? { hostWait: { hostId: task.resolution.hostWait.hostId, since: task.resolution.hostWait.since } } : {}),
    ...(task.completion ? { headline: reportHeadline(task.completion) } : {}),
    ...(budget ? { budget: taskBudgetBoardView(budget) } : {}),
    parked: isParkedTask(task, hasUnreleasedResolutionRun),
    dependsOn: task.dependsOn, queuePriority: task.queuePriority,
    ...(task.profile ? { profile: { name: task.profile.name } } : {}), ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    ...(task.resumePrNumber !== null ? { resumePrNumber: task.resumePrNumber } : {}),
    ...(task.completion?.prNumber ? { completionPrNumber: task.completion.prNumber } : {}),
    ...(task.originError ? { originError: task.originError } : {}), ...(task.originLookupError ? { originLookupError: task.originLookupError } : {}),
    lanes: task.lanes, ...(task.disposition ? { disposition: { kind: task.disposition.kind, status: task.disposition.status, reason: task.disposition.reason.slice(0, 160) } } : {}),
    ...(task.profileRequests?.worker?.profileId ? { workerRequest: task.profileRequests.worker.profileId } : {}),
    ...(task.profileRequests?.reviewer?.profileId ? { reviewerRequest: task.profileRequests.reviewer.profileId } : {}),
    resolution: { ...(task.resolution.attention ? { attention: true as const } : {}), ...(task.resolution.mergedCommit ? { mergedCommit: task.resolution.mergedCommit } : {}),
      ...(task.resolution.workspaceArchiveRetries[0] ? { archiveRetry: { ...task.resolution.workspaceArchiveRetries[0], workspaceId: task.resolution.workspaceArchiveRetries[0].workspaceId.slice(0, 80), error: task.resolution.workspaceArchiveRetries[0].error.slice(0, 160) } } : {}),
      escalated: task.resolution.incident?.status === "escalated" || task.resolution.recovery?.status === "escalated" || undefined },
    ...(task.pausedStop || taskRuns.some(run => !run.released && !run.completion && run.pausedStop) ? { pausedStop: true as const } : {}),
  });
}

/**
 * Compact board projection: one bounded summary per visible task. It includes
 * open work, routing faults and terminal archive retries, so a board snapshot
 * never carries full task payloads. This is the projection the native UI uses.
 */
/**
 * Spec 043 (a): `decisionByTask` maps one task to its open Spec 032 decision so a
 * linked decision marks the task `needs_operator_input` without exporting the
 * decision itself in the compact board projection.
 */
export function visibleTaskSummaries(
  tasks: Task[], projects: Project[] = [], runs: Run[] = [],
  decisionByTask: ReadonlyMap<string, string> = new Map(),
  waitContextByTask: ReadonlyMap<string, WaitStateContext> = new Map(),
  defaultHostId?: string,
  eventsByTask: ReadonlyMap<string, BudgetEvent[]> = new Map(),
  repositorySettingsByTask: ReadonlyMap<string, Pick<RepositorySettings, "affectedTests"> | null> = new Map(),
): TaskSummary[] {
  const visible = tasks.filter(task => !["done", "cancelled"].includes(task.phase) || Boolean(task.originError || task.originLookupError || task.resolution.workspaceArchiveRetries.length));
  const identities = new Map<string, Set<string>>();
  const references = new Map(tasks.map(task => [task.id, task.phase === "done" ? "" : task.reference || (task.number ? `#${formatTaskNumber(task.number)}` : "")]));
  for (const task of visible) {
    const found = identities.get(task.repoPath) ?? new Set<string>();
    found.add(task.repository || task.repoPath);
    identities.set(task.repoPath, found);
  }
  return visible.map(task => {
    const pathIdentifiesMember = projects.some(project => project.repositories.some(repo => repo.path === task.repoPath &&
      (!task.repository || !repo.origin || repo.origin === task.repository)));
    const taskRuns = runs.filter(run => run.taskId === task.id);
    const hasUnreleasedRun = taskRuns.some(run => !run.released);
    const until = task.holdUntil?.kind === "task" ? references.get(task.holdUntil.taskId) : undefined;
    // The reference token is short; an unbounded `[\w.-]+` scan over a long
    // reason backtracks quadratically and stalls the board build. The cheap
    // '#' probe skips the regex entirely when no reference can be present.
    const reasonText = task.holdReason ?? task.reason;
    const reasonRef = reasonText.includes("#") ? reasonText.match(/(?:[\w.-]{1,40}#\d{1,9}|#\d{1,9})/)?.[0] : undefined;
    const waitContext = waitContextByTask.get(task.id);
    const firstWaitingId = waitContext?.dependencyWait ? reasonText.match(/\(([0-9a-f-]{36})\):/i)?.[1] : undefined;
    const dependency = firstWaitingId ? references.get(firstWaitingId) : waitContext?.dependencyWait ? task.dependsOn.map(id => references.get(id)).find(Boolean) : undefined;
    const summary = summarizeTask(task, !pathIdentifiesMember || (identities.get(task.repoPath)?.size ?? 0) > 1, hasUnreleasedRun,
      { ...waitContext, decisionId: decisionByTask.get(task.id) ?? null }, taskRuns, until || reasonRef || dependency || undefined, defaultHostId, eventsByTask.get(task.id) ?? [], repositorySettingsByTask.get(task.id));
    const owner = summary.waitState?.state === "merge_hold"
      ? summary.holds?.merge?.owner ?? summary.holds?.dispatch?.owner
      : summary.holds?.dispatch?.owner ?? summary.holds?.merge?.owner;
    const project = projects.find(candidate => candidate.repositories.some(repo => repo.path === task.repoPath));
    const displayOwner = owner ? isOperatorOrigin(owner) ? "you"
      : project?.planner?.agentId === owner ? `${project.name} planner` : "a planner thread" : undefined;
    const escalationHolder = summary.stopRecord?.detail.match(/Waiting with the planner or task owner\s+([0-9a-f-]{36})\s*:/i)?.[1];
    const stopDisplayOwner = escalationHolder
      ? project?.planner?.agentId === escalationHolder ? `${project.name} planner`
        : taskOwner(task) === escalationHolder ? isOperatorOrigin(escalationHolder) ? "you" : "the task owner"
          : "a planner thread"
      : undefined;
    return { ...summary, ...(displayOwner ? { holdDisplayOwner: displayOwner } : {}), ...(stopDisplayOwner ? { stopDisplayOwner } : {}) };
  });
}

/** Drop full verdict evidence from bounded task projections; `queue.detail` retains the immutable records. */
export function compactTaskVerdicts(task: Task): Task {
  const compactCompletion = (completion: Completion | null): Completion | null =>
    completion?.verdicts?.length ? { ...completion, verdicts: [] } : completion;
  const resolution = task.resolution;
  return {
    ...task,
    completion: compactCompletion(task.completion),
    resolution: {
      ...resolution,
      review: compactCompletion(resolution.review),
      verification: compactCompletion(resolution.verification),
      reviews: resolution.reviews.map(review => ({ ...review, verdicts: [] })),
      reviewSupersessions: resolution.reviewSupersessions.map(record => ({
        ...record, review: compactCompletion(record.review)!, verification: compactCompletion(record.verification),
      })),
    },
  };
}

/** Drop instruction-sized fields that belong on `queue.detail`. */
export function compactLiveTask(task: Task): Omit<Task, "handoffText" | "brief" | "briefVersions" | "laneContext" | "laneDocumentPins"> & { holdKind?: HoldKind } {
  const compactTask = compactTaskVerdicts(task);
  const { handoffText: _handoffText, brief: _brief, briefVersions: _briefVersions, laneContext: _laneContext, laneDocumentPins: _laneDocumentPins, ...compact } = compactTask;
  const holdKind = taskHoldKind(task);
  return holdKind ? { ...compact, holdKind } : compact;
}

export function isUnchangedBoard(value: unknown): value is UnchangedBoard {
  return typeof value === "object" && value !== null && "unchanged" in value && (value as { unchanged: unknown }).unchanged === true;
}
