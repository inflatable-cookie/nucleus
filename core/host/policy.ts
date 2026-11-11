import type { Completion, Run, Task } from '../../shared/contracts';
import type { HostAgentSpec, HostWorkspaceRef } from '../../shared/host';
import type { Adapter, ExternalWorkspaceArchiveInput, ExternalWorkspaceArchiveOutcome, ExternalWorkspaceCatalog, ExternalWorkspaceSourceExpectation, ExternalWorktreeSource } from './index';
import type { CreationOwner, OwnerReviewContext, RecoveryDispatchSnapshot, RegistrationAdapter, ReviewerSetting, RunScratchPlacement } from './types';

/** Core-owned policy operations supplied when the service composes a host. */
export interface HostPolicyPort extends Required<Pick<Adapter,
  'validate' | 'verifyWorkspace' | 'verifyPr' | 'verifyPrIdentity' | 'verifyInspectedRevisionHead'
  | 'verifyContinuedProgress' | 'findOpenBranchPr' | 'findAnyOpenBranchPr' | 'verifyCancelledWorkspacePr'
  | 'verifyResume' | 'verifyCheckpoint' | 'verifyReplacementSource' | 'verifyCleanQueueWorktree'
  | 'readStash' | 'runTemporaryDirectory' | 'hostLoad' | 'worktreeValidation' | 'hostProcessListing'
  | 'preflightWorkspaceStorage' | 'inspectWorkspaceCreation' | 'populateTaskWorktree' | 'createWorkspace'
  | 'removeOrphanWorkspace' | 'recoverTaskWorkspace' | 'findWorkspaces' | 'purgeReportingFiles'
  | 'preflightWorkerContinuation' | 'archiveTaskWorkspace' | 'createAgent' | 'inspectReviewEntry'
  | 'reportingFallback' | 'continueWorker' | 'continueRun' | 'continueReviewer'>> {
  creationOwner(): CreationOwner;
  binding(key: string, task: Task, runId: string, token: string): string;
  dataDir(): string;
  placement(): { dataDir: string; retainedDataDirs?: string[]; admit(path: string): void } | null;
  ownedPathFor(task: Task): Promise<string>;
  ownedDataDirFor(task: Task, directory: string): Promise<string | null>;
  classifyOrphan(input: { directory: string; repoPath: string; dataDir: string; taskId: string; continuing?: boolean }): Promise<{ orphaned: true; adminDir: string; detail: string } | { orphaned: false }>;
  inspectOrphanWorkspace(task: Task): Promise<import('./types').OrphanWorkspace | null>;
  noLiveWorkspaceProcesses(workspaceId: string, runIds: readonly string[]): Promise<string | null>;
  createCloseoutWorkspace(task: Task): Promise<{ id: string; directory: string }>;
  findCloseoutWorkspaces(task: Task): Promise<{ id: string; directory: string }[]>;
  verifyCloseoutWorkspace(task: Task, id: string, directory: string): Promise<void>;
  externalWorkspaceCatalog(directory: string): Promise<ExternalWorkspaceCatalog>;
  archiveExternalWorkspace(input: ExternalWorkspaceArchiveInput): Promise<ExternalWorkspaceArchiveOutcome>;
  proveExternalWorktreeSource(directory: string, expected: ExternalWorkspaceSourceExpectation): Promise<{ source: ExternalWorktreeSource } | { reason: string }>;
  catalogEntryPresent(workspace: HostWorkspaceRef): Promise<boolean>;
  preservedGitIdentity(directory: string): Promise<string | null>;
  inspectRegistration: RegistrationAdapter['inspectRegistration'];
  prepareRegistration(task: Task, token: string): void;
  createRun(task: Task, run: Run, token: string, context?: RecoveryDispatchSnapshot | null, ownerContext?: OwnerReviewContext | null, guard?: { allowed(): Promise<boolean>; stillAllowed(): boolean }): Promise<{ id: string; workspaceId: string | null }>;
  guardedNativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean): Promise<{ id: string; workspaceId: string | null }>;
  sendRun(task: Task, run: Run, token: string, context?: RecoveryDispatchSnapshot | null, ownerContext?: OwnerReviewContext | null, guard?: { allowed(): Promise<boolean>; stillAllowed(): boolean }): Promise<void>;
  verifyReview(task: Task, run: Run, result: Completion, reviewer?: ReviewerSetting): Promise<number | void>;
  scratchNamespaceFor?: (task: Task) => string;
  runScratch: RunScratchPlacement;
  scratchPlacement(task?: Task): RunScratchPlacement;
}

export type HostPolicyConstructor = new () => HostPolicyPort;
