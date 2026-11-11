import { digest } from '../store/store';
import type { Run, Task } from '../../shared/contracts';

/**
 * The release GO of a proof-only qualification is one fact, read everywhere the
 * task's wait is decided: the operator question that asks it (operator-question),
 * the blocker ladder that must not climb past it, the owner verb views and the
 * control entry. Keeping the derivation here lets those readers import it without
 * a cycle through operator-question and owner-verbs.
 */
export const proofOnlyGoQuestionId = (task: Pick<Task, 'id' | 'proofOnly'>): string =>
  digest(['operator-question', task.id, 'proof_only_release_go', task.proofOnly?.commit ?? 'missing'].join(':'));

/** Why every verb that would start or re-drive a run refuses while the GO is open. */
export const PROOF_GO_WAIT_REFUSAL = "The release GO for this proof-only qualification is the operator's; the task waits on that answer and no run starts before it";
/**
 * The owner controls a GO wait holds back. A route or restart would start another
 * reviewer run on a task that only needs the GO; a move or retry would start or
 * re-drive work the GO has not authorized. `proof` is the GO's own control, and
 * `stop` or `complete` only end the wait, so neither is listed.
 */
export const PROOF_GO_WAIT_VERBS: ReadonlySet<string> = new Set(['route', 'restart', 'move', 'retry_effect']);

/**
 * The question id while the release GO is open, or null. Open means: the task is
 * blocked at its merged commit, its GO-gate reviewer parked on the GO, and no
 * executor has run. The question stays open until it is answered and its proof
 * applied, or unknown; an answer whose delivery was refused for a busy worker is
 * still open, because the GO has to be retried.
 */
export function openProofOnlyGo(
  task: Pick<Task, 'id' | 'phase' | 'proofOnly' | 'requiresOperatorGo' | 'proofExecutions'>,
  runs: Run[],
  events: ReadonlyArray<{ kind: string; detail: string }>,
): string | null {
  const commit = task.proofOnly?.commit;
  if (!commit || !task.requiresOperatorGo || task.phase !== 'blocked') return null;
  if (task.proofExecutions.length || runs.some(run => run.role === 'executor')) return null;
  const reviewer = runs.findLast(run => run.role === 'reviewer');
  if (!reviewer || reviewer.completion?.status !== 'blocked'
    || !reviewer.instruction?.includes("Queue obtains the operator's release GO")) return null;
  const id = proofOnlyGoQuestionId(task);
  const answered = events.some(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${id}:`));
  const busyRefusal = events.some(event => event.kind === 'operator_question_refused' && event.detail.startsWith(`${id}:`)
    && /worker running|capacity/i.test(event.detail));
  const applied = events.some(event => event.kind === 'operator_question_applied' && event.detail.startsWith(`${id}:`));
  // Unknown delivery remains terminal: Queue must never infer an answer it could not observe.
  if (events.some(event => event.kind === 'operator_question_unknown' && event.detail.startsWith(`${id}:`))
    || (answered && (!busyRefusal || applied))) return null;
  return id;
}
