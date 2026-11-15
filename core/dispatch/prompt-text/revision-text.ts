/**
 * What a revision, an identity confirmation and an interactive worker are told:
 * the continuation action and the review findings it addresses, the recorded
 * basis of an external merge, the durable worker exclusions, the interactive
 * session block, and the brief's report-only policy as a typed record.
 */
import { mergeReviewEvidenceAt, type Task } from '../../../shared/contracts';
import { currentBrief } from '../../planning/brief';
import { heldBriefQueuePolicy } from '../../planning/handoff';

/**
 * Spec 050 follow-up (papercut, Tom 2026-10-23): a revision also resumes for
 * reasons that are not review findings — an owner restart, a stopped worker, a
 * conflict or a failed check. Only an actual review requesting changes is a
 * finding, so a review-less continuation never renders an empty findings line,
 * `undefined`, or a claim that a review defect exists.
 */
export function revisionReviewFindings(task: Pick<Task, 'resolution'>): string | null {
  const summary = task.resolution.review?.summary?.trim();
  return summary ? summary : null;
}

/**
 * Task 993: the code gate, not this prompt, decides whether an observed
 * external merge counts. The prompt describes the recorded basis the gate
 * accepted the merge on — review evidence at the merged head, or the recorded
 * no-verdict basis for an explicitly skipped-review submission or an operator
 * `move to=closeout` acceptance — and asks the coordinator to close out
 * against that record; a contradiction between the record and the forge stays
 * a blocked report. The no-evidence bases are the gate's own accepted routes
 * (review 5829659690): a closeout must never block on their absence.
 */
export function externalMergeCloseoutBlock(task: Task): string {
  const head = task.resolution.mergeHead ?? task.prHead;
  const evidence = head ? mergeReviewEvidenceAt(task, head) : null;
  if (evidence) return `This PR was merged outside the plugin. The merge is an observed fact, not review or acceptance approval by itself. Nucleus accepted it only because recorded review evidence binds the merged head: ${evidence.detail}. Record that evidence faithfully in the closeout documents; do not infer approval from merged status, and report blocked if the recorded evidence contradicts the repository. `;
  const basis = task.skipPRReview
    ? 'the submission explicitly skipped PR review, so no review evidence binds the merged head and none is required'
    : 'the merge is recorded as accepted without an applied verdict (mergedWithNone): the explicit operator acceptance of this external merge through move to=closeout, not review evidence, is its recorded basis';
  return `This PR was merged outside the plugin. The merge is an observed fact, not review or acceptance approval by itself. Nucleus accepted it without review evidence: ${basis}. That recorded basis is the acceptance evidence for this closeout: record it faithfully in the closeout documents, do not infer review approval from merged status, and report blocked only if the task's records or the repository contradict it. `;
}

/** The neutral continuation action for a revision with no explicit instruction and no review findings. */
const REVIEWLESS_CONTINUATION_ACTION = 'Continue the existing task within its approved scope';

/** The default action for a revision that carries no explicit instruction. */
export function revisionContinuationAction(task: Pick<Task, 'resolution'>): string {
  return revisionReviewFindings(task) && task.resolution.review?.status === 'changes_required'
    ? 'Continue the existing task and address the public review findings within the approved scope'
    : REVIEWLESS_CONTINUATION_ACTION;
}

export const workerExclusionBlock = (task: Task) => (task.workerExclusions ?? []).length
  ? `Durable planner/operator worker exclusions for this task:\n${task.workerExclusions.map(exclusion => `- ${exclusion.agentId ? `agent ${exclusion.agentId}` : `profile ${exclusion.profileId}`}: ${exclusion.reason}`).join('\n')}\nNucleus will not give an excluded worker another turn. When a changes-requested revision targets an excluded retained worker, Nucleus selects an eligible replacement; do not choose a profile or ask the excluded worker to continue.\n`
  : '';

/**
 * Spec 051: an interactive worker builds the first tranche, then works with the
 * operator in its own thread, and reports only when the operator says submit.
 * The operator's in-thread instructions carry the authority to change scope.
 */
export function interactiveWorkerBlock(task: Task, session: boolean) {
  if (!session) return '';
  const source = currentBrief(task) ? 'brief' : 'handoff';
  return `
INTERACTIVE TASK. The operator asked for this task to be interactive:
1. Implement the first tranche the ${source} describes, then end your turn WITHOUT reporting to Nucleus: summarize what you built, how to run and try it, and what you would do next.
2. The operator then works with you in this thread: testing, asking for changes, refining. Their direct instructions in this thread are your authority, including changes to scope beyond the ${source}. If an instruction would break a fixed rule below, say so and ask.
3. Do not report ready_for_review, progress_checkpoint, blocked or error while the session is interactive; Nucleus refuses a checkpoint during it. If you are stuck, or context pressure or a failure stops you, tell the operator in this thread. The one exception is your own provider's quota exhaustion, reported as described below.
4. When the operator tells you to submit: commit, push ${task.branch}, open the PR as described below, and report ready_for_review with its prNumber. That report ends the interactive session; independent review follows.
Fixed rules the operator's instructions do not override: stay on ${task.branch} in this workspace, never merge, never dispatch other workers or coordinators, never use git stash, and never report readiness the operator has not asked for.
`;
}

/** The brief's queue policy as the prompts read it: report-only, or why it could not be read. */
export interface BriefReportPolicy { readonly reportOnly: boolean; readonly refusal: string | null; }

/**
 * Read the brief's report-only opt-in. A brief whose frontmatter cannot be
 * parsed is a refusal this record names: it never reads as a plain "no", which
 * would deliver a PR for a task whose brief asked for a lane report.
 */
export function briefReportPolicy(task: Task): BriefReportPolicy {
  const brief = currentBrief(task);
  if (!brief) return { reportOnly: false, refusal: null };
  try { return { reportOnly: Boolean(heldBriefQueuePolicy(brief.text).reportOnly), refusal: null }; }
  catch (error) { return { reportOnly: false, refusal: error instanceof Error ? error.message : String(error) }; }
}
/** True only when the brief opts into report-only delivery; an unreadable policy is not an opt-in. */
export const briefReportOnly = (task: Task): boolean => briefReportPolicy(task).reportOnly;
/** The line naming a brief whose report-only policy could not be read; empty when it was read. */
export function reportPolicyNotice(policy: BriefReportPolicy): string {
  return policy.refusal
    ? `The Nucleus-held brief's queue.reportOnly policy could not be read (${policy.refusal}). Nucleus therefore treats this task as an ordinary change: deliver a PR and report ready_for_review, and do not write a report to a lane document.\n`
    : '';
}
