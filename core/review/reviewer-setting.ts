import type { Task } from '../../shared/contracts';
import { reviewRequiredFor } from '../../shared/review-requirement';
import type { ReviewerSetting } from '../forge/index';
import type { Store } from '../store/store';

/** The repository's opted-in reviewer identity, or null for the ordinary comment path. */
export const reviewerSettingOf = (store: Pick<Store, 'canonicalRepository'>, task: Pick<Task, 'repoPath' | 'repository'>): ReviewerSetting | null =>
  store.canonicalRepository(task.repoPath, task.repository)?.reviewer ?? null;

/**
 * Whether the task needs an independent exact-head review before merge: a
 * submission that skipped PR review still needs one when its repository opts
 * into a reviewer identity (Spec 033).
 */
export const reviewRequiredForTask = (store: Pick<Store, 'canonicalRepository'>, task: Task): boolean =>
  reviewRequiredFor(task, reviewerSettingOf(store, task));
