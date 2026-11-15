import type { Completion, Run, Task } from '../../shared/contracts';
import { isAcceptedReview, retainedProfileRemapPark } from './task-reasons';
import type { Store } from '../store/store';

/**
 * The recorded evidence retry routing reads before it decides: accepted reviews
 * at a head, a head the retained worker advanced after one, the retained
 * worker's own remap park, and the one stopped revision that may be resumed.
 *
 * Reads only. Every function takes the store it reads and returns a typed fact,
 * so the orchestration decides nothing from event prose and reads nothing twice.
 */
export type RetryEvidenceStore = Pick<Store, 'events' | 'run' | 'runs'>;

/** The retained worker remap park, when the task holds one that a fresh instruction can resume. */
export function retainedWorkerRemap(store: RetryEvidenceStore, t: Task, retainedWorkerIssue: string | null) {
  const taskEvents = store.events(t.id);
  // Store.events is newest-first, so the first matching event is the current continuation.
  const pendingWorkerEvent = taskEvents.find(event => ['worker_resume_requested', 'revision_requested'].includes(event.kind));
  const retainedProfileIncident = retainedProfileRemapPark(t, taskEvents);
  return retainedProfileIncident && retainedWorkerIssue && t.agentId && t.workspaceId && t.profile && !t.resolution.currentRunId
    ? { pendingWorkerEvent, retainedWorkerIssue } : null;
}

/** The accepted review both exact-head readers start from, with the run that recorded it. */
function acceptedReview(t: Task, runs: Run[]): { review: Completion; reviewRun: Run | undefined } | null {
  const reviewRun = runs.filter(run => run.role === 'reviewer' && isAcceptedReview(run.completion))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const review = isAcceptedReview(t.resolution.review) ? t.resolution.review : reviewRun?.completion ?? null;
  return review ? { review, reviewRun } : null;
}

/** When the accepted review's recording run was created, from either the run row or its record. */
function reviewCreatedAt(review: Completion, reviewRun: Run | undefined, runs: Run[]): string | undefined {
  return (reviewRun && reviewRun.id === review.runId ? reviewRun : runs.find(run => run.id === review.runId))?.createdAt;
}

/**
 * Spec 044 / project-a #1863: an accepted review whose head still equals the task PR head,
 * with no later run completion at a different head. Used to return a blocked revision or
 * recovery to review when the operator supplies a reviewer instruction.
 */
export function acceptedReviewAtUnchangedHead(store: RetryEvidenceStore, t: Task): Completion | null {
  const runs = store.runs(t.id);
  const accepted = acceptedReview(t, runs);
  if (!accepted?.review.head || accepted.review.head !== t.prHead) return null;
  const createdAt = reviewCreatedAt(accepted.review, accepted.reviewRun, runs);
  for (const run of runs) {
    if (run.id === accepted.review.runId) continue;
    if (createdAt && Date.parse(run.createdAt) < Date.parse(createdAt)) continue;
    const laterHead = run.completion?.head;
    if (laterHead && laterHead !== accepted.review.head) return null;
  }
  return accepted.review;
}

/**
 * Project-a #1900: with an operator reviewer instruction, a head the retained worker advanced
 * after the accepted review still returns the task to fresh review. The candidate is the latest
 * head reported by a later revision run of the retained worker (same agent and workspace), and
 * every other later run completion must report a head the retained worker also reported, so a
 * recovery restating the same pushed head is not an independent change. The engine verifies
 * GitHub's open PR head equals the candidate before routing, so any other head change refuses.
 */
export function retainedWorkerAdvancedReviewHead(store: RetryEvidenceStore, t: Task): { review: Completion; head: string } | null {
  const runs = store.runs(t.id);
  const accepted = acceptedReview(t, runs);
  if (!accepted?.review.head) return null;
  const createdAt = reviewCreatedAt(accepted.review, accepted.reviewRun, runs);
  const changed = runs.filter(run => {
    if (run.id === accepted.review.runId) return false;
    if (createdAt && Date.parse(run.createdAt) < Date.parse(createdAt)) return false;
    return Boolean(run.completion?.head && run.completion.head !== accepted.review.head);
  });
  const advanced = changed.filter(run => run.role === 'revision' && run.agentId === t.agentId && run.workspaceId === t.workspaceId);
  if (!advanced.length) return null;
  const retainedHeads = new Set(advanced.map(run => run.completion!.head));
  if (changed.some(run => !retainedHeads.has(run.completion!.head))) return null;
  const latest = advanced.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1)!;
  return { review: accepted.review, head: latest.completion!.head! };
}

/** The unreleased current revision, or null when another lease still holds. */
export function stoppedRevisionWithoutCallback(t: Task, runs: Run[]): Run | null {
  const run = runs.find(run => run.id === t.resolution.currentRunId) ?? null;
  if (!run || run.role !== 'revision' || run.completion || run.released) return null;
  if (run.agentId !== t.agentId || run.workspaceId !== t.workspaceId) return null;
  if (runs.some(other => other.id !== run.id && other.role !== 'recovery' && !other.released)) return null;
  return run;
}
