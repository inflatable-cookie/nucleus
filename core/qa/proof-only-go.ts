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

/** The recorded answer event that names this qualification's release GO. */
export function proofOnlyGoAnsweredEvent<T extends { kind: string; detail: string }>(
  events: ReadonlyArray<T>, questionId: string,
): T | null {
  return events.find(event => event.kind === 'operator_question_answered'
    && event.detail.startsWith(`${questionId}: GO — run the qualification`)) ?? null;
}

/**
 * The reviewer run that parked on the GO: the proof-only reviewer that the
 * reservation recorded before any receipt existed, reporting blocked. The fact
 * is the run's own typed `proofOnly` intent, never the wording of the prompt the
 * reviewer was handed, so re-wording that prompt cannot silently close the wait.
 * The caller's other guards already prove the task holds no receipt and no
 * executor ran.
 */
const parkedOnProofGo = (run: Run): boolean => run.proofOnly === true && run.completion?.status === 'blocked';

/**
 * The refusal Nucleus records when the operator's GO answer reached the task but
 * could not be applied yet because the task's own worker was busy. Both the GO
 * wait here and the resume sweep in the question service read this one rule, so
 * the accepted answer is retried rather than asked again.
 */
export const busyGoAnswerRefusal = (refusalDetail: string): boolean => /worker running|capacity/i.test(refusalDetail);

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
  if (!reviewer || !parkedOnProofGo(reviewer)) return null;
  const id = proofOnlyGoQuestionId(task);
  const answered = events.some(event => event.kind === 'operator_question_answered' && event.detail.startsWith(`${id}:`));
  const busyRefusal = events.some(event => event.kind === 'operator_question_refused' && event.detail.startsWith(`${id}:`)
    && busyGoAnswerRefusal(event.detail));
  const applied = events.some(event => event.kind === 'operator_question_applied' && event.detail.startsWith(`${id}:`));
  // Unknown delivery remains terminal: Queue must never infer an answer it could not observe.
  if (events.some(event => event.kind === 'operator_question_unknown' && event.detail.startsWith(`${id}:`))
    || (answered && (!busyRefusal || applied))) return null;
  return id;
}
