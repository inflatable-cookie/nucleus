/**
 * The text a task row records as its reason, and the named readers of the text a
 * controller later decides from. A reason is durable state: the board, task
 * detail, the stop beside it and the owner verbs all show or read it, so each
 * sentence is written here once, and a module that has to read one calls the
 * named check here instead of composing the text again.
 */

export const RECOVERY_ESCALATION_FAILURE_PREFIX = 'Coordinator recovery could not safely continue: ';
/** A coordinator run that could not be created at all: the episode escalates with the failure text. */
export const RECOVERY_CREATION_FAILURE_PREFIX = 'Coordinator recovery unavailable: ';
/** Every wait the transient same-thread provider resume records starts with this. */
export const TRANSIENT_PROVIDER_WAIT = 'Transient provider error';
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
export const NO_RESOLUTION_ACTION = 'No resolution action needs retry';
export const ACCEPTED_PR_RECONCILIATION_REASON = 'Operator requested accepted-PR workspace reconciliation';
/**
 * The two stops a callback reminder writes for one role: the thread stopped
 * without its callback, or its one reminder expired first. The reminder writes
 * the first; the lifecycle pass reads either as the same run-scoped fact, so the
 * sentence pair has one owner here instead of a copy at its reader.
 */
export const missingCallbackStopReason = (role: string) => `The ${role} thread stopped without a callback; inspect the thread`;
export const expiredCallbackReminderReason = (role: string) => `The ${role} callback reminder expired`;
/** The one reason a completion callback's moved PR head records; retry routing reads it as a fact. */
export const PR_HEAD_CHANGED_REASON = 'PR head changed after the completion callback';
/** The visible reason a failed external-merge probe parks with; its pre-attention state is recorded for recovery. */
export const EXTERNAL_MERGE_CHECK_REASON_PREFIX = 'External merge check:';
/** The reason the external-merge probe writes when a transient check clears without a merge. */
export const EXTERNAL_MERGE_CHECK_RECOVERED_REASON = 'External merge check recovered; resuming task';
export const MERGE_HELD_REASON = 'Merge held by operator; release to continue';
/**
 * The syncing wait that refreshes the integration base before a closeout retry.
 * Four closeout paths record it and the participant lease reads it to excuse a
 * held stale-base hook from the merge fence, so it is one named reason.
 */
export const CLOSEOUT_BASE_REFRESH_REASON = 'Refreshing main before retrying closeout';
export const OPERATOR_WORKER_REMAP_REASON = 'Operator-approved retained worker remap';
export const OPERATOR_STOPPED_REVISION_REMAP_REASON = 'Operator-approved stopped revision replacement';
export const OPERATOR_STOPPED_WORKER_REMAP_REASON = 'Operator-approved stopped pre-PR worker replacement';
export const OPERATOR_RETAINED_WORKER_REPLACEMENT_REASON = 'Operator-approved retained worker replacement';
/** Spec 036: operator role reassignment after worker intent. The worker half
 * reuses the retained-worker replacement path, so this reason counts as an
 * operator-approved replacement everywhere that reason does. */
export const OPERATOR_ROLE_REASSIGNMENT_REASON = 'Operator-approved role reassignment';
/** A named-profile control before the catalog loads: retryable, never a false "not found". */
export const PROFILE_CATALOG_LOADING_REFUSAL = "The daemon profile catalog is still loading after service start; retry shortly";
/** The lifecycle wait while the profile catalog has not loaded since the service started. */
export const PROFILE_CATALOG_PENDING_REASON = "Waiting for the daemon profile catalog to load after service start";

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

/** The one writer of an escalation's failure summary. */
export const escalationSummary = (failure: string): string => `${RECOVERY_ESCALATION_FAILURE_PREFIX}${failure}`;
/** The one writer of a creation-failure summary; its reader is `creationFailureDetail`. */
export const creationFailureSummary = (failure: string): string => `${RECOVERY_CREATION_FAILURE_PREFIX}${failure}`;
/** The one reader of a creation-failure summary: the failure text, or null when the summary is another kind. */
export const creationFailureDetail = (summary: string): string | null =>
  summary.startsWith(RECOVERY_CREATION_FAILURE_PREFIX) ? summary.slice(RECOVERY_CREATION_FAILURE_PREFIX.length) : null;
/**
 * The exact summary a recovery records when it finds no resolution action at an
 * accepted head. Written here with the other recovery text and read only by
 * `noActionEscalationAtAcceptedHead`.
 */
export const NO_ACTION_ESCALATION_SUMMARY = escalationSummary(NO_RESOLUTION_ACTION);
