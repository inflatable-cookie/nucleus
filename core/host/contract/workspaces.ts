import type { OrphanWorkspace, WorkspaceCreationState } from '../types';
import type { ReviewEntryInput, StashEntry, Task } from '../../../shared/contracts';
import type { AgentObservation } from './observation';
import type { OriginAgent } from './identity';

/** The task workspace lifecycle: validation and storage preflight, creation, inspection, recovery, title, lookup and removal, the source proofs a continuation needs, the checkout identity proofs, and the review-entry workspace. */
export interface HostWorkspaces {
  validate(task: Task): Promise<string>;
  preflightWorkspaceStorage?(task: Task): Promise<void>;
  createReviewEntryWorkspace?(spec: {requestId:string;title:string;repoPath:string;prNumber:number}):Promise<{id:string}>;
  createWorkspace(task: Task, options?: { freshlyPopulated?: boolean }): Promise<{ id: string; directory: string }>;
  /** Queue-owned gitBulk populate; admission must not wrap this. */
  populateTaskWorktree?(task: Task): Promise<{ directory: string; populated: boolean; budgetMs: number; elapsedMs: number }>;
  inspectWorkspaceCreation?(task: Task, options?: { skipProcessScan?: boolean; skipRemoteCheck?: boolean; progress?: boolean }): Promise<WorkspaceCreationState>;
  /**
   * Re-create a lost task workspace. The default target is the accepted PR head;
   * `target: 'branch'` reads the queue branch on origin, which a worker
   * continuation resumes from.
   */
  /**
   * Re-create a lost task workspace. The default target is the accepted PR head;
   * `target: 'branch'` reads the queue branch on origin, which a worker
   * continuation resumes from.
   */
  recoverTaskWorkspace?(task: Task, options?: { target?: 'pr_head' | 'branch' }): Promise<{ id: string; directory: string }>;
  setTaskWorkspaceTitle?(task:Task,title:string,requestId:string,uncertain:boolean):Promise<void>;
  findWorkspaces(task: Task): Promise<{ id: string; directory: string }[]>;
  /** Read-only: a Queue-owned unpublished populate leftover or a locked-initializing Paseo leftover with a base-identical unpublished branch. */
  removeOrphanWorkspace?(task: Task, orphan: OrphanWorkspace): Promise<void>;
  /** One-minute load average and logical CPU count; creation defers while load exceeds CPUs. */
  workspaceAvailable?(id:string):Promise<boolean>;
  verifyResume?(task: Task): Promise<void | string>;
  verifyCheckpoint?(task: Task, head: string): Promise<void>;
  verifyReplacementSource?(task: Task, head: string): Promise<void>;
  /** Fresh, uncached check that the retained worker's registered worktree still belongs to this task. */
  preflightWorkerContinuation?(task: Task): Promise<{ available: true } | { available: false; reason: string }>;
  verifyCleanQueueWorktree?(task: Task): Promise<void>;
  /** Exact clean planning-head proof for owner acceptance of a report-only task. */
  /** Read the shared stash list; recorded when a worker or revision run is created. */
  /** Exact clean planning-head proof for owner acceptance of a report-only task. */
  /** Read the shared stash list; recorded when a worker or revision run is created. */
  readStash?(directory: string): Promise<StashEntry[]>;
  verifyWorkspace(task: Task, directory: string): Promise<string>;
  inspectReviewEntry?(input:ReviewEntryInput,taskId?:string,originProof?:{origin:OriginAgent;state:AgentObservation}):Promise<{directory:string;originWorkspaceId:string;busyReason:string;busyTransient?:boolean}>;
  scratchNamespaceFor?(task: Task): string;
}
