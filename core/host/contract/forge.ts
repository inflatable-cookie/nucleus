import type { VerifiedPr } from '../types';
import type { Task } from '../../../shared/contracts';

/** The forge reads a task needs for review and merge: the pull request, its identity, the inspected revision head, continued progress, the open pull request on a branch, and a cancelled workspace pull request. */
export interface HostForgeReads {
  verifyPr(task: Task, number: number): Promise<VerifiedPr>;
  verifyPrIdentity?(task: Task, number: number, options?: { allowDraft?: boolean }): Promise<VerifiedPr>;
  verifyInspectedRevisionHead?(task: Task, number: number, expectedHead: string): Promise<void>;
  verifyContinuedProgress?(task: Task, number: number, expectedHead: string, ancestors: readonly string[], options?: {requireClean?: boolean}): Promise<void>;
  findOpenBranchPr?(task: Task): Promise<{ number: number; url: string; head: string }[]>;
  /** Include drafts and PRs targeting any base; report-only completion refuses all open PRs for this branch. */
  findAnyOpenBranchPr?(task: Task): Promise<{ number: number; url: string }[]>;
  verifyCancelledWorkspacePr?(task: Task): Promise<void>;
}
