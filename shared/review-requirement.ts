import type { Task } from './contracts';

/**
 * Whether a merge needs an independent exact-head review. A submission that
 * skipped PR review still requires one when the repository opts into a reviewer
 * identity (Spec 033). One owner for the rule the review lifecycle and the
 * merge gate both read.
 */
export const reviewRequiredFor = (task: Pick<Task, 'skipPRReview'>, reviewer: unknown): boolean =>
  !task.skipPRReview || Boolean(reviewer);
