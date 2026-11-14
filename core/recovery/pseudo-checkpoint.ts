import { CHECKPOINT_BUDGET } from '../../shared/contracts';
import type { Task } from '../../shared/contracts';

/** Project-a #1980: with its checkpoint budget spent, a long pre-PR worker reported
 * error as a pseudo-checkpoint ('assessment incomplete; not a provider/external
 * blocker') and recovery resumed it in an endless chunk loop, because a
 * successful resume resets the coordinator budget and each new chunk summary
 * changes the recovery fingerprint. */
const PSEUDO_CHECKPOINT_INCOMPLETE_RE = /assessment incomplete|incomplete|remaining work|unfinished|not complete|more work/i;
const PSEUDO_CHECKPOINT_NO_FAILURE_RE = /not a (provider|external|blocker|failure)|no (provider|external|blocker|failure)|not caused by|no execution failure/i;
/** Explicit execution-failure evidence always wins over the incomplete signals
 * above: a summary that names a failure stays on the normal recovery path
 * even when it also says the work is incomplete. The no-failure disclaimer is
 * scrubbed from the evidence first, so `no execution failure` never vetoes
 * while a genuine `timed out` or `error occurred` in the same summary does. */
const EXECUTION_FAILURE_RE = /\bfail\w*|\berrors?|\btime\s?-?outs?|\btimed\s?-?out|traceback|\bexception\b|panic|\bcrashed\b|\bbroke(n)?\b|exit( code)?\s+[1-9]|\b(cannot|unable to|refused|denied|forbidden|permission denied)\b/i;
/** True for a pre-PR blocked/error report that self-declares 'incomplete' with
 * no execution failure after the checkpoint budget was spent. */
export const isPseudoCheckpointError = (task: Task): boolean => {
  if (task.checkpoints.records.length < CHECKPOINT_BUDGET) return false;
  if (!['blocked', 'error'].includes(task.phase)) return false;
  const completion = task.completion;
  if (!completion || !['blocked', 'error'].includes(completion.status)) return false;
  if (completion.providerUnavailable) return false;
  if (task.completion?.prNumber || task.prUrl || task.prHead || task.resumePrNumber) return false;
  const evidence = `${completion.summary} ${task.reason}`;
  // Scrub the no-failure disclaimer before looking for failure words, so
  // `no execution failure` never vetoes while a genuine `timed out` or
  // `error occurred` elsewhere in the same summary still does.
  const scrubbed = evidence.replace(/not a (provider|external|blocker|failure)|no (provider|external|blocker|failure)|not caused by|no execution failure/gi, ' ');
  if (EXECUTION_FAILURE_RE.test(scrubbed)) return false;
  return PSEUDO_CHECKPOINT_INCOMPLETE_RE.test(evidence) && PSEUDO_CHECKPOINT_NO_FAILURE_RE.test(evidence);
};
/** Pre-PR resumes already granted after the budget-exhausting checkpoint. */
export const postBudgetPrePrResumes = (events: { id: number; kind: string }[]): number => {
  const accepted = events.filter(event => event.kind === 'progress_checkpoint');
  if (accepted.length < CHECKPOINT_BUDGET) return 0;
  const budgetId = accepted[CHECKPOINT_BUDGET - 1]!.id;
  return events.filter(event => event.kind === 'worker_resume_requested' && event.id > budgetId).length;
};
export const pseudoCheckpointEscalation = (task: Task): string => {
  const summary = task.completion && ['blocked', 'error'].includes(task.completion.status) ? task.completion.summary : task.reason;
  return `Worker error after its checkpoint budget was spent reads as a pseudo-checkpoint, not an execution failure ('${summary.slice(0, 500)}'); the task already resumed pre-PR once, so Queue escalated to the planner instead of resuming again. Self-assessed context pressure is not an execution failure. Continue the approved work; use a progress checkpoint only where that run permits it and its existing allowance remains. A genuine provider or runtime limit needs the observed error, not a promised fresh session.`;
};
