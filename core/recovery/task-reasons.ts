import { parseAgentId, sameCallerIdentity } from '../../shared/agent-identity';
import { hostKindOf } from '../../shared/host-kind';
import { ProvenPreSendRefusalError } from '../host/errors';
export { ProvenPreSendRefusalError } from '../host/errors';
/**
 * Reasons, refusal errors and small helpers the daemon's owners share. A leaf:
 * it imports no daemon module by value except `capacity`, which imports only
 * `shared/`, so anything can import it without closing a cycle.
 */
import { RETAINED_WORKER_PROFILE_REASON, holdsOf, isDispositionActive, type Completion, type Run, type Task } from '../../shared/contracts';
import { DISPATCH_HELD_REASON } from '../dispatch/capacity';
import type { Adapter } from '../host/adapter';
import type { Store } from '../store/store';

export const RECOVERY_ESCALATION_FAILURE_PREFIX = 'Coordinator recovery could not safely continue: ';
/** A coordinator run that could not be created at all: the episode escalates with the failure text. */
export const RECOVERY_CREATION_FAILURE_PREFIX = 'Coordinator recovery unavailable: ';
/** A policy observation is only usable while the settings row it read has not changed; a moving row is re-observed this many times before Queue holds visibly. */
const MERGE_GATE_SETTINGS_ATTEMPTS = 3;
/** Every wait the transient same-thread provider resume records starts with this. */
const TRANSIENT_PROVIDER_WAIT = 'Transient provider error';
const stages = ['awaiting_review', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing', 'done'];
/** An observed agent is live while it runs, initializes or waits on a permission. */
export const observedActive = (s: Awaited<ReturnType<Adapter['observe']>>) => s.active || s.permissions || ['running', 'initializing'].includes(s.status);
const active = observedActive;
const assignedThreadWaitReason = (state: Awaited<ReturnType<Adapter['observe']>>) => {
  if (state.permissions) {
    const request = state.pendingRequest;
    return request
      ? `Assigned thread has pending ${request.kind === 'question' ? 'question' : 'permission'} ${request.id}${request.firstLine ? `: ${request.firstLine}` : ''}`
      : 'Assigned thread has a pending permission response';
  }
  if (state.active || ['running', 'initializing'].includes(state.status)) {
    return state.activeTurnId
      ? `Assigned thread has active turn ${state.activeTurnId}`
      : `Assigned thread is active (${state.status})`;
  }
  return `Assigned thread is not resumable (${state.status})`;
};
const coordinative = (r: Run) => r.role === 'closeout' || r.role === 'recovery';
/** A proof-only executor run is a resolution creation: its own absent-creation recovery uses `restart`. */
const proofExecutor = (role: Run['role'] | string) => role === 'executor';

/** A ready review approves only a named exact PR head. Owner acceptances are separate. */
export function readyReviewAtHead(t: Pick<Task, 'prHead' | 'resolution'>, head = t.prHead): boolean {
  return Boolean(head && t.resolution.review?.status === 'ready_to_merge' && t.resolution.review.head === head);
}

/** True when this head has an applied ready_to_merge verdict or an owner source acceptance. */
export function appliedMergeVerdict(t: Task, head: string | null | undefined): boolean {
  if (!head) return false;
  if (readyReviewAtHead(t, head)) return true;
  return (t.resolution.ownerAcceptances ?? []).some(entry => entry.head === head && (entry.kind === 'operator_source' || entry.kind === 'reviewed'));
}

/** Record that this merge had no applied verdict, without clearing a prior true. */
function mergedWithNonePatch(t: Task, head: string | null | undefined): { mergedWithNone?: true } {
  return t.resolution.mergedWithNone || appliedMergeVerdict(t, head) ? {} : { mergedWithNone: true };
}
/** The retained-run gate fires before retry makes any continuation changes. */
export class RetainedRunRefusal extends Error {}
export const ABSENT_WORKER_REASON = 'Agent creation is uncertain or placement differs; no replacement launched';
/** A classified provider startup failure with no bound agent; only its exact-lookup retry may consume it. */
export const PRE_AGENT_LAUNCH_FAILURE_REASON = 'Transient worker launch failed before an agent was created';
/**
 * The reason the automatic absent-worker path writes once its one replacement is spent.
 * An operator may still mint a worker in the retained workspace, and must be able to
 * recognise this state - the automatic path may not, or the budget would be bypassed.
 */
export const ABSENT_WORKER_REPLACEMENT_REASON = 'A replacement worker creation also proved absent after an exact lookup; coordinator attention required';
export const ABSENT_RESOLUTION_REASON = 'Run creation is uncertain; no duplicate agent will be created';
/** Spec 058: the stop a responsible task holds while its one joint question awaits the operator. */
export const RESPONSIBLE_QUESTION_WAIT = 'Waiting for the operator to answer the joint worker/reviewer question on the third non-converging review round';
const NO_RESOLUTION_ACTION = 'No resolution action needs retry';
/**
 * A task parked because its retained worker's profile is unavailable: the park
 * itself, or a blocked/errored escalation recorded after that park and after
 * the last worker request. Only a remap (the parked restart) resumes it, so
 * `next` and the handler both send restart there (review #539).
 */
/**
 * The task reason every stop writer records for one stop: the full trimmed text,
 * or the stop's own detail when the text is empty. The stop record's detail is
 * capped at 4000 characters; the reason is not, and it must not differ by writer,
 * or two writers recording one long reason rewrite the task on every pass
 * (consumer #660: a 5208-character blocked summary, a 2.3 MB row rewritten every ~19 s).
 */
export function visibleTaskReason(text: string, stop: { detail: string }): string {
  return text.trim() || stop.detail;
}
export function retainedProfileRemapPark(t: Task, events: Array<{ id: number; kind: string; detail: string }>): boolean {
  if (t.reason.startsWith(RETAINED_WORKER_PROFILE_REASON)) return true;
  if (!['blocked', 'error'].includes(t.phase) || t.resolution.recovery?.status !== 'escalated') return false;
  const latest = (match: (event: { kind: string; detail: string }) => boolean) => events.reduce((max, event) => match(event) ? Math.max(max, event.id) : max, -1);
  const park = latest(event => event.kind === 'needs_attention' && event.detail.startsWith(RETAINED_WORKER_PROFILE_REASON));
  return park >= 0 && park > latest(event => ['worker_resume_requested', 'revision_requested'].includes(event.kind));
}
/**
 * A recovery's no-action finding at an accepted reviewed head: nothing is left
 * to retry, so answering the escalation lets the verification gate run (Spec
 * 016 rule 6). Shared by the answer and `next`, so both agree.
 */
export function noActionEscalationAtAcceptedHead(t: Task): boolean {
  return t.phase === 'verifying' && !t.resolution.attention && !t.resolution.currentRunId &&
    t.completion?.status === 'ready_for_review' && Boolean(t.prHead) &&
    readyReviewAtHead(t) &&
    t.resolution.recovery?.status === 'escalated' &&
    t.resolution.recovery.summary === `${RECOVERY_ESCALATION_FAILURE_PREFIX}${NO_RESOLUTION_ACTION}` &&
    t.resolution.incident?.status === 'escalated' &&
    t.resolution.recovery.incidentId === t.resolution.incident.id;
}
/** Automatic closeout refreshes allowed per merge before the hold parks for a human. */
const CLOSEOUT_REFRESH_LIMIT = 2;
export const ACCEPTED_PR_RECONCILIATION_REASON = 'Operator requested accepted-PR workspace reconciliation';
/** The visible reason a failed external-merge probe parks with; its pre-attention state is recorded for recovery. */
export const EXTERNAL_MERGE_CHECK_REASON_PREFIX = 'External merge check:';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/**
 * How often the automatic external-merge probe may ask the forge about one
 * unchanged task. The probe is a control-class admission and a GitHub REST call,
 * and nothing about an unchanged run, head, PR or phase makes a repeat inside
 * this window more truthful; a changed lifecycle identity, an explicit owner
 * retry or verification path and a parked check strand each read immediately.
 */
export const EXTERNAL_MERGE_PROBE_MS = 2 * 60_000;
/** How many tasks' probe stamps are remembered; a bounded map cannot grow with history. */
const EXTERNAL_MERGE_PROBE_LIMIT = 512;
/**
 * How long one lifecycle pass's worktree-validation scan may answer for the same
 * worktree evidence, and the hard ceiling on any shared answer (task 450).
 *
 * A `ps -A` / `lsof` scan is a bounded pass cost, not a per-read one: within one
 * pass the same worktree and selector argv are one question, so they are asked
 * once. The next pass reads again, and the contexts that decide a consequential
 * action — a recovery launch, a retained-thread revision,
 * an owner verb — ask freshly whatever else the pass has seen. `0` disables
 * sharing and reproduces the previous per-read shape in tests.
 */
export const VALIDATION_SCAN_PASS_MAX_MS = 5_000;
/** How many worktree scans one pass may keep; the map is cleared by every pass, so this only bounds a fleet-sized pass. */
const VALIDATION_SCAN_PASS_LIMIT = 256;
/** The reason the external-merge probe writes when a transient check clears without a merge. */
export const EXTERNAL_MERGE_CHECK_RECOVERED_REASON = 'External merge check recovered; resuming task';
export const MERGE_HELD_REASON = 'Merge held by operator; release to continue';
/**
 * The held wait a merge fence's own kind names: a merge hold keeps the merge
 * wording, while an owner stop reads as the dispatch hold it placed.
 */
export const mergeFenceReason = (task: Parameters<typeof holdsOf>[0]): string =>
  holdsOf(task).merge ? MERGE_HELD_REASON : DISPATCH_HELD_REASON;
export const OPERATOR_WORKER_REMAP_REASON = 'Operator-approved retained worker remap';
export const OPERATOR_STOPPED_REVISION_REMAP_REASON = 'Operator-approved stopped revision replacement';
export const OPERATOR_STOPPED_WORKER_REMAP_REASON = 'Operator-approved stopped pre-PR worker replacement';
export const OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON = 'Operator-approved retained worker replacement';
/** Spec 036: operator role reassignment after worker intent. The worker half
 * reuses the retained-worker replacement path, so this reason counts as an
 * operator-approved replacement everywhere that reason does. */
export const OPERATOR_ROLE_REASSIGNMENT_REASON = 'Operator-approved role reassignment';
/** An operator-approved replacement excludes the retained worker; only the replacement path may act on it. */
export const operatorReplacementPending = (t: Task) =>
  [OPERATOR_WORKER_REMAP_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON, OPERATOR_STOPPED_WORKER_REMAP_REASON, OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON, OPERATOR_ROLE_REASSIGNMENT_REASON].some(reason => t.failoverReason.startsWith(reason));
/**
 * The retained initial worker's own binding under an owner-armed replacement that
 * has not retired it yet (Spec 050). The owner's fresh restart or `route now`
 * moves the task to `changes_requested` before the recovery pass retires the
 * worker, so exactly that window still accepts that worker's genuine
 * authenticated result — from the completion handler and the authenticated report
 * bridge alike. It requires the task to still bind the same initial run and agent,
 * no recorded result, an operator-armed replacement with its recorded profile, no
 * other current run and no live revision of that worker. A retired, replaced,
 * released, superseded or foreign binding never matches, and an automatic
 * provider faults are handled by their dedicated recovery path.
 */
export function ownerArmedRetainedWorker(t: Task, runs: Run[]): boolean {
  if (t.phase !== 'changes_requested' || !t.agentId || !t.runId || t.completion || t.removedAt) return false;
  if (!t.failoverReason || !t.replacementProfile) return false;
  if (![OPERATOR_WORKER_REMAP_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON, OPERATOR_STOPPED_WORKER_REMAP_REASON,
    OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON, OPERATOR_ROLE_REASSIGNMENT_REASON].some(reason => t.failoverReason.startsWith(reason))) return false;
  if (isDispositionActive(t) || t.resolution.currentRunId) return false;
  return !runs.some(run => !run.released && run.role === 'revision' && run.agentId === t.agentId);
}
const resolutionCreationRoles = new Set<Run['role']>(['reviewer', 'closeout', 'executor']);
export const revisionPhases: Task['phase'][] = ['awaiting_review', 'report_ready', 'reviewing', 'changes_requested', 'blocked', 'error', 'needs_attention', 'verifying'];
/** The same accepted-review test `rereview` uses: a recorded `ready_to_merge` or `changes_required`. */
export const isAcceptedReview = (review: Completion | null | undefined): review is Completion =>
  Boolean(review && ['ready_to_merge', 'changes_required'].includes(review.status));
/** Durable, run-scoped proof that a reviewer refusal was seen but no eligible replacement existed yet. */
const reviewerRefusalKey = (runId: string) => `reviewerRefusal:${runId}`;
/**
 * One recorded unverifiable refusal read, as `<runId>: <gap>` (papercut fe93582a). The provider-refusal
 * check is a live read whose content either proves the refusal or does not; a read that cannot settle —
 * a timeline without the run's own dispatch message (the pi provider), an unreachable older page, a gap
 * or an unreadable ordering — is never evidence, and it is not a reason to wait forever either. The
 * recorded gap is the durable count: a bounded number of reads, then the ordinary stopped-without-verdict
 * path owns the run and no further read is spent on it.
 */
const PROVIDER_REFUSAL_UNVERIFIED = 'provider_refusal_unverified';
/** Reads of the reviewer's own timeline allowed before the ordinary path takes the run. */
const UNVERIFIABLE_REFUSAL_READ_LIMIT = 2;
function reminderClock(events: Array<{ kind: string; detail: string; at: string }>, runId: string): string | null {
  const reminder = events.find(event => event.kind === 'callback_reminder' && event.detail === runId);
  if (!reminder) return null;
  const extended = events.find(event => event.kind === 'callback_reminder_extended' && event.detail === runId);
  if (extended && Date.parse(extended.at) > Date.parse(reminder.at)) return extended.at;
  return reminder.at;
}
function repositoryQaArgv(store: Store, task: Pick<Task, 'repoPath' | 'directory'>): string[][] {
  const row = store.repositoryFor(task.repoPath)
    ?? store.repositories().find(settings => settings.repository.path === task.repoPath || settings.repository.path === task.directory)
    ?? null;
  return qaArgvLists(row?.qa ?? null);
}
function qaArgvLists(qa: { argv?: string[]; stages?: Array<{ argv: string[] }> } | null): string[][] {
  if (!qa) return [];
  if (qa.stages?.length) return qa.stages.map(stage => stage.argv);
  return qa.argv ? [qa.argv] : [];
}
// A lane that is still advancing. An escalation on one of these phases is not
// answerable evidence yet, whatever the incident record says (Spec 016 rule 6).
const workingLanes = new Set<Task['phase']>(['dispatching', 'working', 'awaiting_review', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing']);

/** Round 4: the refusal for a coordinator report with no structured action, naming the exact shape. */
export function coordinatorActionShapeRefusal(why: string): string {
  return `A coordinator report needs one structured coordinatorAction object (${why}). Report again with the action in that field, not in summary text, for example `
    + `{"status":"recovered","summary":"…","coordinatorAction":{"verb":"move","to":"merge","reason":"…"}}. `
    + `Verbs: restart {role?, instruction?, fresh?}, route {role, profileId, thinkingOptionId?, now?}, move {to, instruction?}, retry_effect {effect?}, `
    + `each with reason and status recovered; or {"verb":"cannot","reason":"…"} with status blocked or error.`;
}

/** Run identities for a participant can live in run rows or only in task-row bindings. */
export function participantToolRunIds(task: Task, runs: Run[], agentId: string, workspaceId: string): string[] {
  const ids = new Set<string>();
  // Run rows are returned in creation order. Keep the newest ticket first so
  // provider process proof uses the current helper where an older run was
  // superseded but its agent remains the same.
  if (task.agentId === agentId && task.workspaceId === workspaceId && task.runId) ids.add(task.runId);
  for (const run of [...runs].reverse()) if (run.agentId === agentId && run.workspaceId === workspaceId) ids.add(run.id);
  for (const worker of [...task.retiredWorkers].reverse()) {
    if (worker.agentId !== agentId) continue;
    const run = runs.find(item => item.id === worker.runId);
    if ((run?.workspaceId || task.workspaceId) === workspaceId) ids.add(worker.runId);
  }
  return [...ids];
}


/** An escalation ends with its task: a merge or an ending leaves nothing for its answer to do. */
const escalationOutlived = (task: Task): boolean =>
  ['done', 'cancelled'].includes(task.phase) || Boolean(task.resolution.mergedCommit || task.resolution.mergeIntent);

/** Queue planner ids are stored as full UUIDs; callers sometimes arrive as the 8-char prefix. */
function plannerIdMatches(planner: string | undefined, caller: string): boolean {
  if (!planner) return false;
  if (sameCallerIdentity(planner, caller)) return true;
  const plannerRef = parseAgentId(planner), callerRef = parseAgentId(caller);
  if (plannerRef && callerRef && plannerRef.hostId !== callerRef.hostId) return false;
  if (plannerRef && !callerRef && hostKindOf(plannerRef.hostId) !== 'paseo'
    || callerRef && !plannerRef && hostKindOf(callerRef.hostId) !== 'paseo') return false;
  planner = plannerRef?.nativeAgentId ?? planner;
  caller = callerRef?.nativeAgentId ?? caller;
  if (!/^[0-9a-f-]+$/i.test(planner) || !/^[0-9a-f-]+$/i.test(caller)) return false;
  const a = planner.replace(/-/g, '').toLowerCase();
  const b = caller.replace(/-/g, '').toLowerCase();
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 8 && longer.startsWith(shorter);
}

/** A named-profile control before the catalog loads: retryable, never a false "not found". */
export const PROFILE_CATALOG_LOADING_REFUSAL = "The daemon profile catalog is still loading after service start; retry shortly";
/** The lifecycle wait while the profile catalog has not loaded since the service started. */
export const PROFILE_CATALOG_PENDING_REASON = "Waiting for the daemon profile catalog to load after service start";
export {
  MERGE_GATE_SETTINGS_ATTEMPTS, TRANSIENT_PROVIDER_WAIT, stages, active, assignedThreadWaitReason, coordinative, proofExecutor,
  mergedWithNonePatch, NO_RESOLUTION_ACTION, CLOSEOUT_REFRESH_LIMIT, message, EXTERNAL_MERGE_PROBE_LIMIT, VALIDATION_SCAN_PASS_LIMIT,
  resolutionCreationRoles, reviewerRefusalKey, PROVIDER_REFUSAL_UNVERIFIED, UNVERIFIABLE_REFUSAL_READ_LIMIT, reminderClock,
  repositoryQaArgv, workingLanes, escalationOutlived, plannerIdMatches,
};
