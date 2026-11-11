import type { Completion, ReviewRecord, ReviewVerdict, Run, Task } from '../../shared/contracts';

/**
 * Structured reviewer verdicts are ordinary evidence on a reviewer completion:
 * a bounded, id-unique list recorded immutably with the reviewer's run, exact
 * head and published review identity. Brief frontmatter no longer opts into
 * them or gates a merge on them (Spec 058 cutover 2): a brief states its
 * outcome and acceptance in prose, a needed hold uses `mergeHold`, and the
 * retired keys are refused at submission while stored rows keep parsing.
 */

/**
 * Validation shared by the report bridge and the completion gate: verdicts
 * belong to reviewer reports, and the reviewer's responsibility declaration
 * must match the status it reported.
 */
export function assertReviewResponsibility(input: { status: string; verdicts?: ReviewVerdict[]; reviewResponsibility?: Completion['reviewResponsibility'] }, run: Run | null) {
  const responsibility = input.reviewResponsibility;
  if (responsibility && run?.role !== 'reviewer') throw new Error('Review responsibility is only accepted for reviewer reports');
  if (run?.role === 'reviewer') {
    if (responsibility && input.status === 'ready_to_merge')
      throw new Error('ready_to_merge must omit reviewResponsibility; approval carries no responsibility. Unfinished coverage is review_in_progress with reviewResponsibility reviewer.');
    if (run.reviewResponsibilityRequired && ['changes_required', 'blocked', 'error'].includes(input.status) && !responsibility)
      throw new Error('Name reviewResponsibility: author for a concrete author defect, reviewer for unfinished coverage, or environment for an external impediment. Unfinished reading must report review_in_progress with a checkpoint on this same run.');
    if (responsibility === 'reviewer' && input.status !== 'review_in_progress')
      throw new Error('Unfinished reviewer coverage is not an author defect or a verdict. Report review_in_progress with covered/remaining/notes and no verdicts on this same run.');
    if (responsibility === 'author' && input.status !== 'changes_required')
      throw new Error('Author responsibility requires changes_required with the concrete author defect');
    if (responsibility === 'environment' && !['blocked', 'error'].includes(input.status))
      throw new Error('Environment responsibility requires blocked or error with the actual impediment');
  }
  if (input.verdicts !== undefined && run?.role !== 'reviewer') throw new Error('Verdicts are only accepted for reviewer reports');
}

/**
 * The immutable record to append for one accepted reviewer verdict. Returns null
 * when the review recorded no verdicts, so a review without them leaves the task
 * record unchanged.
 */
export function reviewRecordFor(run: Run, completion: Completion, at: string): ReviewRecord | null {
  if (!completion.verdicts?.length
      || (completion.status !== 'ready_to_merge' && completion.status !== 'changes_required')) return null;
  return {
    runId: run.id, agentId: run.agentId, head: run.head, status: completion.status,
    reviewId: completion.reviewId ?? null, reviewCommentId: completion.reviewCommentId ?? null,
    at, verdicts: completion.verdicts ?? [],
  };
}

/** The latest record with verdicts, preferring the applied review to history. */
export function latestReviewVerdictRecord(task: Pick<Task, 'resolution'>): Pick<ReviewRecord, 'reviewId' | 'reviewCommentId' | 'verdicts'> | null {
  const resolution = task.resolution;
  if (!resolution) return null;
  if (resolution.review?.verdicts?.length) return {
    reviewId: resolution.review.reviewId ?? null,
    reviewCommentId: resolution.review.reviewCommentId ?? null,
    verdicts: resolution.review.verdicts,
  };
  const records = resolution.reviews ?? [];
  for (let index = records.length - 1; index >= 0; index -= 1) if (records[index].verdicts.length) return records[index];
  return null;
}

/** Latest verdict list for prompts; no record keeps the prompt unchanged. */
export function latestReviewVerdicts(task: Pick<Task, 'resolution'>): ReviewVerdict[] {
  return latestReviewVerdictRecord(task)?.verdicts ?? [];
}

