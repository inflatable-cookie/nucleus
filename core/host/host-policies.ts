import { AgentPolicy } from "../dispatch/agent-policy";
import { ReviewPolicy } from "../review/review-policy";
import { OwnedWorkspaceArchive } from '../workspaces/owned-workspace-archive';
import { ExternalWorkspaceArchive } from '../workspaces/external-workspace-archive-policy';
import { sendRunVia } from '../dispatch/run-launch/send';
import { createRunVia } from '../dispatch/run-launch/create';
import { ArchiveNotDeliveredError } from '../workspaces/archive-delivery';
import { purgeReportingFiles, reportingFallback } from "../intake/reporting-files";
import type { Run } from "../../shared/contracts";
import * as forge from "../forge/index";
import type { VerifiedPr } from "../forge/index";
import type { ResolutionAdapter } from "../resolution";
import { ProvenPreSendRefusalError } from "../recovery/task-reasons";
import type { Profile, ReviewEntryInput, StashEntry, Task } from "../../shared/contracts";
import type { HostAgentSpec, HostCatalog, HostCatalogOptions, HostFeature, HostModel, HostProvider, HostWorkspaceRef, NativeDecisionInput } from "../../shared/host";
import type { NucleusProfile } from "../../shared/profiles";
import { git } from "../git/index";
import {
  type OrphanWorkspace, type WorkspaceCreationState,
} from "../workspaces/workspace-allocation";
import { WorkspaceLifecycle } from '../workspaces/workspace-lifecycle';
import { WorkspaceContinuation } from '../workspaces/workspace-continuation';
import type { ProcessSearch } from "../machine/process-identity";
import {capPaseoTitle,taskWorkspaceTitle} from '../workspaces/workspace-title';
import type { RecoveryDispatchSnapshot } from '../recovery/recovery-context';
import type { OwnerReviewContext } from '../review/owner-review-context';
import { type BuildOutputCleanupHooks } from '../workspaces/worktree-cleanup';
import { classifyOrphanWorktree, type WorkspaceDiscard } from '../workspaces/orphan-worktree';
import { writeMcpBinding, writeRunTicket, type CreationOwner } from "../dispatch/agent-creation";
import { mcpBindingPathFromHostRecord } from "../intake/report-binding";
import type { WorktreeValidationScan } from '../workspaces/worktree-validation';
import { MachinePorts } from '../machine/machine-ports';
import type { RunPresenceDaemon } from '../telemetry/live-run-presence';
import type { RunUsageSource, RunUsageStream, RunUsageStreamEvent } from '../telemetry/run-usage';
import type { Adapter, AgentObservation, OriginAgent, ExternalWorkspaceArchiveInput, ExternalWorkspaceSourceExpectation } from "./adapter";
import type { WorkspaceLifecycleHost } from '../workspaces/workspace-lifecycle';
import type { WorkspaceContinuationHost } from '../workspaces/workspace-continuation';
import type { OwnedWorkspaceArchiveHost } from '../workspaces/owned-workspace-archive';
import type { ExternalWorkspaceArchiveHost } from '../workspaces/external-workspace-archive-policy';
import type { AgentPolicyHost } from '../dispatch/agent-policy';
import type { ReviewPolicyHost } from '../review/review-policy';

/** Core policy delegates, injected when the service composes a host. */
export abstract class HostPolicies extends MachinePorts {
  abstract readonly socketPath: string;
  abstract readonly helperPath: string;
  abstract readonly reportingViaMcp: boolean;
  abstract readonly admissionLaunchEnv: Record<string,string>;
  abstract readonly testPlacement: WorkspaceLifecycleHost['testPlacement'];
  abstract readonly workspaceHost: WorkspaceLifecycleHost['workspaceHost'] & WorkspaceContinuationHost['workspaceHost'] & OwnedWorkspaceArchiveHost['workspaceHost'] & ExternalWorkspaceArchiveHost['workspaceHost'] & ReviewPolicyHost['workspaceHost'];
  abstract readonly messageHost: ReviewPolicyHost['messageHost'];
  abstract observe: ReviewPolicyHost['observe'];
  abstract originAgent: ReviewPolicyHost['originAgent'];
  abstract unsupportedMcp: AgentPolicyHost['unsupportedMcp'];
  abstract nativeAgentCreate: AgentPolicyHost['nativeAgentCreate'];
  abstract agentTimelinePage: OwnedWorkspaceArchiveHost['agentTimelinePage'];
  scanForWorktreeAdd?: (targetPath: string) => ProcessSearch;
  workspaceCreationProgress?: WorkspaceLifecycleHost['workspaceCreationProgress'];

  private agentPolicyCache: AgentPolicy | null = null;

  private get agentPolicy() { return this.agentPolicyCache ??= new AgentPolicy(this); }

  private reviewPolicyCache: ReviewPolicy | null = null;

  private get reviewPolicy() { return this.reviewPolicyCache ??= new ReviewPolicy(this); }

  /**
   * Queue's callback facts for a launch (`server/agent-creation.ts`), read per
   * call: a fresh object over the adapter's current values, never captured.
   */
  creationOwner(): CreationOwner {
    return { socketPath: this.socketPath, helperPath: this.helperPath, reportingViaMcp: this.reportingViaMcp,
      admissionLaunchEnv: this.admissionLaunchEnv, scratchPlacement: task => this.scratchPlacement(task) };
  }

  binding(key:string,task:Task,runId:string,token:string) { return writeMcpBinding(this.creationOwner(), key, task, runId, token); }

  /**
   * Core's workspace lifecycle policy (`core/workspaces/workspace-lifecycle.ts`) over this
   * host: storage preflight, the owned path and data-dir proofs, creation and
   * recovery. Built once and read at each call — the data home, the test
   * placement, the process scan, the progress hook and the daemon surface — so a
   * test's override and a replaced daemon are both seen, and nothing captures
   * the host.
   */
  private workspaceLifecycleCache: WorkspaceLifecycle | null = null;

  private get workspaceLifecycle(): WorkspaceLifecycle { return this.workspaceLifecycleCache ??= new WorkspaceLifecycle(this); }

  preflightWorkspaceStorage(task: Task): Promise<void> { return this.workspaceLifecycle.preflightWorkspaceStorage(task); }

  /** The orphan proof; replaceable only so tests can act inside its await. */
  classifyOrphan = classifyOrphanWorktree;

  /**
   * The machine seams the policy re-enters: it calls these through this adapter at
   * every internal site, so a test's instance override of `dataDir`, `placement`
   * or an owned-path proof still governs the whole operation, as it did when the
   * policy lived here. Each is a plain return of the policy's own call.
   */
  dataDir() { return this.workspaceLifecycle.dataDir(); }

  placement() { return this.workspaceLifecycle.placement(); }

  ownedPathFor(task: Task) { return this.workspaceLifecycle.ownedPathFor(task); }

  ownedDataDirFor(task: Task, directory: string) { return this.workspaceLifecycle.ownedDataDirFor(task, directory); }

  /**
   * Only a creation in progress reports steps. A reconciliation's inspection stays silent:
   * a progress write moves the task's version, and the replay it decides fences on that version.
   */
  inspectWorkspaceCreation(task: Task, options: { skipProcessScan?: boolean; skipRemoteCheck?: boolean; progress?: boolean } = {}): Promise<WorkspaceCreationState> {
    return this.workspaceLifecycle.inspectWorkspaceCreation(task, options);
  }

  populateTaskWorktree(task: Task) { return this.workspaceLifecycle.populateTaskWorktree(task); }

  createWorkspace(task: Task, options: { freshlyPopulated?: boolean } = {}) { return this.workspaceLifecycle.createWorkspace(task, options); }

  /**
   * Core's retained and closeout workspace policy (`core/workspaces/workspace-continuation.ts`)
   * over this host: the continuation preflight, the process proof and the
   * closeout workspace's identity and source proof. Built once and read at each
   * call, so a test's replaced placement, owned path, process table or daemon
   * surface is the one used, and nothing captures the host.
   */
  private ownedWorkspaceArchiveCache: OwnedWorkspaceArchive | null = null;

  private get ownedWorkspaceArchive(): OwnedWorkspaceArchive { return this.ownedWorkspaceArchiveCache ??= new OwnedWorkspaceArchive(this); }

  private workspaceArchiveCache: ExternalWorkspaceArchive | null = null;

  private get workspaceArchive(): ExternalWorkspaceArchive { return this.workspaceArchiveCache ??= new ExternalWorkspaceArchive(this); }

  private workspaceContinuationCache: WorkspaceContinuation | null = null;

  private get workspaceContinuation(): WorkspaceContinuation { return this.workspaceContinuationCache ??= new WorkspaceContinuation(this); }

  noLiveWorkspaceProcesses(workspaceId: string, runIds: readonly string[]): Promise<string | null> {
    return this.workspaceContinuation.noLiveWorkspaceProcesses(workspaceId, runIds);
  }

  inspectOrphanWorkspace(task: Task): Promise<OrphanWorkspace | null> { return this.workspaceLifecycle.inspectOrphanWorkspace(task); }

  removeOrphanWorkspace(task: Task, orphan: OrphanWorkspace): Promise<void> { return this.workspaceLifecycle.removeOrphanWorkspace(task, orphan); }

  recoverTaskWorkspace(task: Task, options?: { target?: 'pr_head' | 'branch' }): Promise<{ id: string; directory: string }> { return this.workspaceLifecycle.recoverTaskWorkspace(task, options); }

  findWorkspaces(task: Task) { return this.workspaceLifecycle.findWorkspaces(task); }

  purgeReportingFiles(taskId:string,runIds:string[]) {
    return purgeReportingFiles(this.helperPath,taskId,runIds);
  }

  /** Check the exact retained task worktree before a deferred worker message is delivered. */
  preflightWorkerContinuation(task: Task): Promise<{ available: true } | { available: false; reason: string }> {
    return this.workspaceContinuation.preflightWorkerContinuation(task);
  }

  createCloseoutWorkspace(task:Task) { return this.workspaceContinuation.createCloseoutWorkspace(task); }

  findCloseoutWorkspaces(task:Task) { return this.workspaceContinuation.findCloseoutWorkspaces(task); }

  verifyCloseoutWorkspace(task:Task,id:string,directory:string) { return this.workspaceContinuation.verifyCloseoutWorkspace(task,id,directory); }

  archiveTaskWorkspace(task:Task,id:string,directory:string,expectedHead:string,allowed:()=>boolean,uncertain:boolean,requirePublished=false,attachedAgentIds:ReadonlySet<string>=new Set(),requireDirectory=false,allowIdleForeignThreads=false,buildOutputCleanup?:BuildOutputCleanupHooks,reviewRun?:Run,discard?:WorkspaceDiscard|null,primaryArchived?:()=>boolean) {
    return this.ownedWorkspaceArchive.archiveTaskWorkspace(task,id,directory,expectedHead,allowed,uncertain,requirePublished,attachedAgentIds,requireDirectory,allowIdleForeignThreads,buildOutputCleanup,reviewRun,discard,primaryArchived);
  }

  externalWorkspaceCatalog(directory: string) { return this.workspaceArchive.externalWorkspaceCatalog(directory); }

  archiveExternalWorkspace(input: ExternalWorkspaceArchiveInput) { return this.workspaceArchive.archiveExternalWorkspace(input); }

  proveExternalWorktreeSource(directory: string, expected: ExternalWorkspaceSourceExpectation) { return this.workspaceArchive.proveExternalWorktreeSource(directory, expected); }

  catalogEntryPresent(workspace: HostWorkspaceRef) { return this.workspaceArchive.catalogEntryPresent(workspace); }

  preservedGitIdentity(directory: string) { return this.workspaceArchive.preservedGitIdentity(directory); }

  createAgent(task: Task, token: string, prompt: string, legacyPrompt = prompt) { return this.agentPolicy.createAgent(task,token,prompt,legacyPrompt); }

  /**
   * Spec 058 slice 4: prove the registering thread is live and resolve the
   * worktree it is already in. The caller keeps its thread and workspace;
   * Queue only records the binding. A thread already owned by a Queue task
   * cannot register again.
   */
  inspectRegistration(callerAgentId: string) { return this.reviewPolicy.inspectRegistration(callerAgentId); }

  inspectReviewEntry(input:ReviewEntryInput,taskId?:string,originProof?:Parameters<ReviewPolicy['inspectReviewEntry']>[2]) { return this.reviewPolicy.inspectReviewEntry(input,taskId,originProof); }

  prepareRegistration(task: Task, token: string) {
    this.ticket(task, { id: task.runId! } as Run, token);
  }

  protected ticket(task: Task, run: Run, token: string) { return writeRunTicket(this.creationOwner(), task, run, token); }

  createRun(task: Task, run: Run, token: string, context: RecoveryDispatchSnapshot | null = null, ownerContext: OwnerReviewContext | null = null,
    guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }) {
    return createRunVia({ creationOwner: () => this.creationOwner(), guardedNativeAgentCreate: (spec, mcp, retry) => this.guardedNativeAgentCreate(spec, mcp, retry), unsupportedMcp: error => this.unsupportedMcp(error) }, task, run, token, context, ownerContext, guard);
  }

  /** One run attempt: a refused guard is a proven pre-send refusal, checked before the attempt facts are built. */
  guardedNativeAgentCreate(spec: HostAgentSpec, mcp: boolean, retry: boolean) { return this.agentPolicy.guardedNativeAgentCreate(spec,mcp,retry); }

  sendRun(task: Task, run: Run, token: string, context: RecoveryDispatchSnapshot | null = null, ownerContext: OwnerReviewContext | null = null, guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }) {
    const owner = this;
    return sendRunVia({ get helperPath() { return owner.helperPath; }, scratchPlacement: task => this.scratchPlacement(task), retainedAgentRef: id => this.messageHost.retainedAgentRef(id), binding: (key, task, runId, token) => this.binding(key, task, runId, token), ticket: (task, run, token) => this.ticket(task, run, token), continueReviewer: (task, run, messageId, text, allowed, stillAllowed, beforeSend) => this.continueReviewer(task, run, messageId, text, allowed, stillAllowed, beforeSend) }, task, run, token, context, ownerContext, guard);
  }

  verifyReview(task: Task, run: Run, result: import("../../shared/contracts").Completion, reviewer?: import("../forge/index").ReviewerSetting) { return this.reviewPolicy.verifyReview(task,run,result,reviewer); }

  reportingFallback(run:Run) {
    return reportingFallback(this.helperPath,run);
  }

  /** Continue the exact retained worker in its recorded workspace and branch. */
  continueWorker(task: Task, intentId: string, text: string, issueBinding?: () => { runId: string; token: string }) { return this.reviewPolicy.continueWorker(task,intentId,text,issueBinding); }

  continueRun(run: Run, messageId: string, text: string) { return this.reviewPolicy.continueRun(run,messageId,text); }

  continueReviewer(task: Task, run: Run, messageId: string, text: string, allowed: () => Promise<boolean>, stillAllowed: () => boolean, beforeSend?: () => void) { return this.reviewPolicy.continueReviewer(task,run,messageId,text,allowed,stillAllowed,beforeSend); }
}
