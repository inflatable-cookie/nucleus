import type { RecoveryDispatchSnapshot, OwnerReviewContext } from '../types';
import type { Run, Task } from '../../../shared/contracts';

/** How one run becomes a native thread: creation with its progress, the credential cleanup after it, and the run scratch directory its prompt names. */
export interface HostRunCreation {
  createRun?(task: Task, run: Run, token: string, context?: import('../types').RecoveryDispatchSnapshot | null, ownerContext?: import('../types').OwnerReviewContext | null, guard?: { allowed(): Promise<boolean>; stillAllowed(): boolean }, affectedTestsCommand?: string): Promise<{ id: string; workspaceId: string | null }>;
  /** Engine hook for per-step creation timings and the visible wait reason. */
  workspaceCreationProgress?: (taskId: string, step: string, status: "started" | "finished" | "skipped", elapsedMs?: number, outcome?: "ok" | "failed") => void;
  purgeReportingFiles?(taskId:string,runIds:string[]):void;
  runTemporaryDirectory?(runId: string, task?: Task): string;
}
