/**
 * Task 560: the single-flight and exact-head admission rules for an
 * author-side proof execution. Every dispatch path (and the reservation
 * transaction) asks this owner before anything is sent, so a second dispatch
 * while an executor run for the task is unreleased, or while a proof execution
 * at that head is already recorded, refuses here.
 */
import type { Run, Task } from '../../shared/contracts';
import { QUALIFICATION_FOUNDATION_INCOMPLETE } from '../host-runs/qualification-binding';
import { proofExecutions, spentProofExecution } from './proof-records';

/**
 * The single-flight refusal as its own error, so a dispatch path that expected
 * to lose the race recognises it without matching refusal text.
 */
export class ProofSingleFlightError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = 'ProofSingleFlightError';
  }
}

/**
 * Spec 064 P1: qualification mode is declared, never entered, while its foundation
 * is incomplete. Every proof-execution entry — the activation table the owner verb
 * and preview read, and the dispatch funnel itself — asks this before anything is
 * dispatched, so an opted-in declaration cannot reach an ordinary executor
 * activation and be read as a running proof.
 */
export function qualificationModeRefusal(task: Pick<Task, 'proofExecution'>): string | null {
  if (task.proofExecution?.qualification !== true) return null;
  return `${QUALIFICATION_FOUNDATION_INCOMPLETE}: this proof execution declares qualification mode, and real qualification proof mode is refused before any dispatch until Spec 064 P4-P7 land their named missing-input refusal`;
}

/**
 * The proof-only dispatch path and the in-review proof path both go through it:
 * a second dispatch while an executor run for the task is unreleased, or while a
 * proof execution at that head is already recorded, refuses before anything is
 * sent.
 */
export function proofSingleFlightRefusal(
  task: Pick<Task, 'entrypoint' | 'proofOnly' | 'proofExecutions'>,
  runs: Pick<Run, 'id' | 'role' | 'head' | 'released' | 'status' | 'completion'>[],
  head: string,
): string | null {
  const executors = runs.filter(run => run.role === 'executor');
  const live = executors.find(run => !run.released);
  if (live) return `An author-side proof execution is already dispatched and unreleased (${live.id}); inspect it with task.detail`;
  if (task.entrypoint === 'proof' && task.proofOnly) {
    const spent = spentProofExecution(task, runs);
    const previous = executors[0] ?? null;
    if (spent || previous)
      return `This proof-only qualification already spent its one execution (${spent ? `${spent.runId}, ${spent.status}` : `${previous!.id}, ${previous!.status}`}); it is never repeated, refunded or reset. Inspect it with task.detail`;
    return null;
  }
  if (proofExecutions(task).some(proof => proof.head === head) || executors.some(run => run.head === head))
    return `An author-side proof execution was already reserved at ${head}; inspect it with task.detail`;
  return null;
}

/**
 * nucleus#1195: the executor run that still owns the lane. While it is unreleased
 * and current, its receipt is the next move: no recovery episode opens and no
 * retry fence or escalation is charged for proof execution. A historical executor
 * the task has moved past is not this run.
 */
export function unreleasedExecutorRun<T extends Pick<Run, 'id' | 'role' | 'released'>>(runs: readonly T[], currentRunId?: string | null): T | null {
  const live = runs.filter(run => run.role === 'executor' && !run.released
    && (currentRunId === undefined || run.id === currentRunId));
  return live.length === 1 ? live[0]! : null;
}

/** A proof execution is still running: the current executor run is unreleased with no result recorded yet. */
export const proofExecutionRunning = (runs: readonly Pick<Run, 'id' | 'role' | 'released' | 'completion'>[], currentRunId?: string | null): boolean =>
  runs.some(run => run.role === 'executor' && !run.released && !run.completion
    && (currentRunId === undefined || run.id === currentRunId));

/**
 * nucleus#1195: the one live proof executor whose report never arrived. A proof
 * execution is single-flight, so a task holds at most one unreleased executor
 * run; the shape is that run itself — unreleased, bound to its agent, and no
 * result recorded. `restart role=executor` asks exactly this run to resend its
 * report on its existing credential, and nothing here re-runs the selector.
 */
export function unreportedExecutorRun<T extends Pick<Run, 'id' | 'role' | 'agentId' | 'released' | 'completion'>>(runs: readonly T[], currentRunId?: string | null): T | null {
  const live = runs.filter(run => run.role === 'executor' && !run.released
    && (currentRunId === undefined || run.id === currentRunId));
  if (live.length !== 1) return null;
  const run = live[0]!;
  return run.completion || !run.agentId ? null : run;
}

/** A proof may be repeated only after a recorded author revision and source approval at a new exact head. */
export function proofHeadAdmission(task: Task, runs: Pick<Run, 'id' | 'role' | 'head' | 'released' | 'completion' | 'proofExecution'>[], head: string): string | null {
  if (proofExecutions(task).some(proof => proof.head === head)
    || runs.some(run => run.role === 'executor' && run.head === head))
    return `An author-side proof execution was already reserved at ${head}; inspect it with task.detail`;
  const history = proofExecutions(task).length > 0 || runs.some(run => run.role === 'executor');
  if (!history) return null;
  const review = task.resolution.review;
  const approved = (review?.sourceApproved === true || review?.status === 'ready_to_merge') && review.head === head
    && runs.some(run => run.role === 'reviewer' && run.id === review.runId && run.released
      && (run.completion?.sourceApproved === true || run.completion?.status === 'ready_to_merge')
      && run.completion.head === head);
  if (!approved) return `A new proof execution requires the retained reviewer’s authenticated source approval at ${head}`;
  const reviewerIndex = runs.findIndex(run => run.role === 'reviewer' && run.id === review.runId);
  const priorRevisions = runs.slice(0, reviewerIndex).filter(run => run.role === 'revision' && run.released
    && run.completion?.status === 'ready_for_review');
  const latestPriorRevision = priorRevisions.at(-1);
  const revised = runs.some(run => run.role === 'revision' && run.released && run.completion?.status === 'ready_for_review'
      && run.completion.head === head)
    || (latestPriorRevision !== undefined && task.prHead === head && latestPriorRevision.completion?.head == null);
  if (!revised) return `A new proof execution requires an authenticated author revision at ${head}`;
  return null;
}

/** A reserved selector is immutable; its input hashes can be re-declared only for a qualified new head. */
export function proofInputRedeclarationAllowed(task: Task, runs: Pick<Run, 'id' | 'role' | 'head' | 'released' | 'completion' | 'proofExecution'>[], head: string): boolean {
  return proofHeadAdmission(task, runs, head) === null
    && !runs.some(run => run.role === 'executor' && !run.released);
}
