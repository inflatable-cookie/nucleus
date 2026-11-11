import type { Adapter } from '../../core/host';
import { ProvenPreSendRefusalError } from '../../core/host';
import { MachinePorts } from '../../core/machine/machine-ports';
import { AgentPolicy } from '../../core/dispatch/agent-policy';
import { createRunVia } from '../../core/dispatch/run-launch/create';
import { WorkspaceLifecycle, type WorkspaceLifecycleHost } from '../../core/workspaces/workspace-lifecycle';
import type { CreationOwner, RecoveryDispatchSnapshot, OwnerReviewContext } from '../../core/host/types';
import type { HostAgentSpec, HostCapabilities, HostPermissionDecision, HostWorkspaceSpec } from '../../shared/host';
import type { Run, Task } from '../../shared/contracts';
import type { AgentPolicyHost } from '../../core/dispatch/agent-policy';
import { T3CodeHost, type T3CodeConfig } from './adapter';

export { T3CodeHost, type T3CodeConfig } from './adapter';
export { T3CompatibilityError } from './contracts';
export { T3RpcError } from './rpc';
export function createHost(config: T3CodeConfig): T3CodeHost { return new T3CodeHost(config); }

export type T3Reporting = { socketPath: string; helperPath: string; admissionLaunchEnv?: Record<string, string> };

/** Workflow adapter: Nucleus git/forge, helper reporting, T3 native threads. */
class T3Adapter extends MachinePorts implements WorkspaceLifecycleHost, AgentPolicyHost {
  readonly reportingViaMcp = false;
  readonly supportsCoordinatorRecovery = false;
  readonly socketPath: string;
  readonly helperPath: string;
  readonly admissionLaunchEnv: Record<string, string>;
  readonly testPlacement?: WorkspaceLifecycleHost['testPlacement'];
  workspaceCreationProgress?: WorkspaceLifecycleHost['workspaceCreationProgress'];
  private readonly native: T3CodeHost;
  constructor(native: T3CodeHost, reporting?: T3Reporting) {
    super();
    this.native = native;
    this.socketPath = reporting?.socketPath ?? '';
    this.helperPath = reporting?.helperPath ?? '';
    this.admissionLaunchEnv = reporting?.admissionLaunchEnv ?? {};
  }
  get hostId() { return this.native.hostId; }
  capabilities() { return { ...this.native.capabilities(), lifecycleDispatch: true }; }
  creationOwner(): CreationOwner {
    return { socketPath: this.socketPath, helperPath: this.helperPath, reportingViaMcp: false,
      admissionLaunchEnv: this.admissionLaunchEnv, perThreadEnvironment: false, scratchPlacement: task => this.scratchPlacement(task) };
  }
  private requireHelper(): void {
    if (!this.helperPath || !this.socketPath) throw new ProvenPreSendRefusalError('T3Code lifecycle dispatch requires the Nucleus helper path');
  }
  nativeAgentCreate(spec: HostAgentSpec, mcp: boolean, _retry: boolean) {
    if (mcp) throw new ProvenPreSendRefusalError('T3Code does not support per-thread MCP reporting');
    return this.native.createAgent(spec);
  }
  unsupportedMcp(_error: unknown) { return false; }
  private get agentPolicy() { return this.agentPolicyCache ??= new AgentPolicy(this); }
  private agentPolicyCache: AgentPolicy | null = null;
  createAgent(task: Task, token: string, prompt: string, legacyPrompt = prompt) {
    this.requireHelper();
    return this.agentPolicy.createAgent(task, token, prompt, legacyPrompt);
  }
  createRun(task: Task, run: Run, token: string, context: RecoveryDispatchSnapshot | null = null, ownerContext: OwnerReviewContext | null = null,
    guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean }) {
    this.requireHelper();
    return createRunVia({ creationOwner: () => this.creationOwner(),
      guardedNativeAgentCreate: (spec, mcp, retry) => this.agentPolicy.guardedNativeAgentCreate(spec, mcp, retry),
      unsupportedMcp: error => this.unsupportedMcp(error) }, task, run, token, context, ownerContext, guard);
  }
  readonly workspaceHost = {
    workspaceInventory: async () => Object.values(this.native.state.read().workspaces).map(w => ({
      id: w.id, projectRootPath: w.directory, workspaceDirectory: w.directory,
    })),
    repositoryProject: (root: string) => this.native.repositoryProject(root),
    createWorkspace: (spec: HostWorkspaceSpec) => this.native.createWorkspace(spec),
  };
  private get workspaceLifecycle(): WorkspaceLifecycle { return this.workspaceLifecycleCache ??= new WorkspaceLifecycle(this); }
  private workspaceLifecycleCache: WorkspaceLifecycle | null = null;
  dataDir() { return this.workspaceLifecycle.dataDir(); }
  placement() { return this.workspaceLifecycle.placement(); }
  ownedPathFor(task: Task) { return this.workspaceLifecycle.ownedPathFor(task); }
  ownedDataDirFor(task: Task, directory: string) { return this.workspaceLifecycle.ownedDataDirFor(task, directory); }
  inspectWorkspaceCreation(task: Task, options?: { skipProcessScan?: boolean; skipRemoteCheck?: boolean; progress?: boolean }) {
    return this.workspaceLifecycle.inspectWorkspaceCreation(task, options);
  }
  inspectOrphanWorkspace(task: Task) { return this.workspaceLifecycle.inspectOrphanWorkspace(task); }
  createWorkspace(task: Task, options?: { freshlyPopulated?: boolean }) { return this.workspaceLifecycle.createWorkspace(task, options); }
  populateTaskWorktree(task: Task) { return this.workspaceLifecycle.populateTaskWorktree(task); }
  recoverTaskWorkspace(task: Task, options?: { target?: 'pr_head' | 'branch' }) { return this.workspaceLifecycle.recoverTaskWorkspace(task, options); }
  removeOrphanWorkspace(task: Task, orphan: Parameters<WorkspaceLifecycle['removeOrphanWorkspace']>[1]) {
    return this.workspaceLifecycle.removeOrphanWorkspace(task, orphan);
  }
  preflightWorkspaceStorage(task: Task) { return this.workspaceLifecycle.preflightWorkspaceStorage(task); }
  findWorkspaces(task: Task) { return this.native.findWorkspaces(task); }
  findAgents(task: Task) { return this.native.findAgents({ 'nucleus.task': task.id }); }
  observe(id: string) { return this.native.observe(id); }
  observationInventory(ids: readonly string[]) { return this.native.observationInventory(ids); }
  originAgent(id: string) { return this.native.originAgent(id); }
  listLiveAgents() { return this.native.listLiveAgents(); }
  workspaceAvailable(id: string) { return this.native.workspaceAvailable(id); }
  workspaceIdAccepted(id: unknown) { return this.native.workspaceIdAccepted(id); }
  profiles() { return this.native.profiles(); }
  catalog() { return this.native.catalog(); }
  notify(id: string, messageId: string, text: string) { return this.native.sendMessage(id, { messageId, text }); }
  stopAgentTurn(id: string) { return this.native.stopAgentTurn(id); }
  archiveAgent(id: string) { return this.native.archiveAgent(id); }
  agentTimelinePage(id: string, limit?: number) { return this.native.agentTimelinePage(id, limit); }
  agentTimeline(id: string, limit?: number) { return this.native.agentTimeline(id, limit); }
  pendingQuestions(id: string) { return this.native.pendingQuestions(id); }
  answeredQuestions(id: string) { return this.native.answeredQuestions(id); }
  answerNativeQuestion(agent: string, workspace: string, request: string, answers: Record<string, string>) {
    return this.native.answerNativeQuestion(agent, workspace, request, answers);
  }
  answerNativePermission(agent: string, workspace: string, request: string, decision: HostPermissionDecision, intentId: string) {
    return this.native.respondRuntimeRequest(agent, workspace, request, { decision }, intentId);
  }
  dismissNativeQuestion(agent: string, workspace: string, request: string) {
    return this.native.dismissNativeQuestion(agent, workspace, request);
  }
}

export function createAdapter(host: T3CodeHost, reporting?: T3Reporting): Adapter & { readonly hostId: string; capabilities(): HostCapabilities } {
  return new T3Adapter(host, reporting);
}
