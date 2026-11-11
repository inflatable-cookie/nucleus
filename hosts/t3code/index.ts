import type { Adapter, HostPolicyConstructor, HostPolicyPort, HostWorktreeWorkspaceSpec } from '../../core/host';
import { ProvenPreSendRefusalError } from '../../core/host';
import type { HostAgentSpec, HostCapabilities, HostPermissionDecision, HostWorkspaceSpec } from '../../shared/host';
import type { Run, Task } from '../../shared/contracts';
import { T3CodeHost, type T3CodeConfig } from './adapter';

export { T3CodeHost, type T3CodeConfig } from './adapter';
export { T3CompatibilityError } from './contracts';
export { T3RpcError } from './rpc';
export function createHost(config: T3CodeConfig): T3CodeHost { return new T3CodeHost(config); }

export type T3Reporting = {
  socketPath: string;
  helperPath: string;
  admissionLaunchEnv?: Record<string, string>;
  testPlacement?: { dataDir: string; retainedDataDirs?: string[]; admit: (path: string) => void };
};

/** Workflow adapter: Nucleus git/forge via HostPolicies, helper reporting, T3 native threads. */
export function t3AdapterClass(Policy: HostPolicyConstructor) {
  return class T3Adapter extends Policy {
    readonly reportingViaMcp = false;
    readonly supportsCoordinatorRecovery = true;
    readonly socketPath: string;
    readonly helperPath: string;
    readonly admissionLaunchEnv: Record<string, string>;
    readonly testPlacement?: { dataDir: string; retainedDataDirs?: string[]; admit: (path: string) => void };
    private readonly native: T3CodeHost;
    constructor(native: T3CodeHost, reporting?: T3Reporting) {
      super();
      this.native = native;
      this.socketPath = reporting?.socketPath ?? '';
      this.helperPath = reporting?.helperPath ?? '';
      this.admissionLaunchEnv = reporting?.admissionLaunchEnv ?? {};
      this.testPlacement = reporting?.testPlacement;
      const inheritedCreateAgent = this.createAgent.bind(this);
      this.createAgent = (task, token, prompt, legacyPrompt = prompt) => {
        this.requireHelper();
        return inheritedCreateAgent(task, token, prompt, legacyPrompt);
      };
    }
    get hostId() { return this.native.hostId; }
    capabilities() { return { ...this.native.capabilities(), lifecycleDispatch: true, supportsCoordinatorRecovery: true }; }
    creationOwner() {
      return { ...super.creationOwner(), perThreadEnvironment: false as const };
    }
    private requireHelper(): void {
      if (!this.helperPath || !this.socketPath) throw new ProvenPreSendRefusalError('T3Code lifecycle dispatch requires the Nucleus helper path');
    }
    nativeAgentCreate(spec: HostAgentSpec, mcp: boolean, _retry: boolean) {
      if (mcp) throw new ProvenPreSendRefusalError('T3Code does not support per-thread MCP reporting');
      return this.native.createAgent(spec);
    }
    unsupportedMcp(_error: unknown) { return false; }
    createRun(...args: Parameters<HostPolicyPort['createRun']>) {
      this.requireHelper();
      return super.createRun(...args);
    }
    sendRun(...args: Parameters<HostPolicyPort['sendRun']>) {
      this.requireHelper();
      return super.sendRun(...args);
    }
    get workspaceHost() {
      const native = this.native;
      return {
        workspaceInventory: async () => Object.values(native.state.read().workspaces).map(w => ({
          id: w.id, projectRootPath: w.directory, workspaceDirectory: w.directory,
        })),
        repositoryProject: (root: string) => native.repositoryProject(root),
        createWorkspace: (spec: HostWorkspaceSpec) => native.createWorkspace(spec),
        workspaceRef: (id: string) => native.workspaceRef(id),
        createCloseoutWorkspace: (_spec: HostWorktreeWorkspaceSpec) => {
          throw new ProvenPreSendRefusalError('T3Code does not support closeout worktree registration');
        },
        workspaceIdAccepted: (id: unknown) => native.workspaceIdAccepted(id),
        archiveThreadPage: async (options: { filter: { includeArchived: boolean; projectKeys?: string[] }; page: { limit: number; cursor?: string } }) => {
          const ids = Object.keys(native.state.read().workspaces);
          const listed = await native.workspaceThreads(ids);
          const threads = options.filter.includeArchived ? listed.threads : listed.threads.filter(t => !t.archived);
          return { entries: threads.map(t => ({ agent: {
            id: t.id, workspaceId: t.workspaceId, labels: t.labels, status: t.status,
            archivedAt: t.archived ? true : null, activeTurn: t.activeTurn, pendingPermissions: t.pendingPermissionKinds,
          } })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        workspaceThreads: (ids: readonly string[]) => native.workspaceThreads(ids),
        workspaceTerminals: (id: string) => native.workspaceTerminals(id),
        activeThreads: () => native.activeThreads(),
      };
    }
    get messageHost() {
      const native = this.native;
      return { retainedAgentRef: (id: string) => native.retainedAgentRef(id) };
    }
    findWorkspaces = (task: Task) => this.native.findWorkspaces(task);
    findAgents(task: Task) { return this.native.findAgents({ 'nucleus.task': task.id }); }
    findRunAgents(run: Run) { return this.native.findAgents({ 'nucleus.run': run.id, 'nucleus.task': run.taskId }); }
    /**
     * T3 has no Paseo identity. Core's consult prompt names `question.answer`
     * with the reissued run ticket; this send does not rewrite it. T3-hosted
     * planners are out of trial; missing `askPlanner` becomes a board decision.
     */
    async askReviewer(reviewer: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }) {
      await this.native.sendMessage(reviewer, { messageId: input.messageId, text: input.prompt });
      return null;
    }
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
  };
}

export function createAdapter(Policy: HostPolicyConstructor, host: T3CodeHost, reporting?: T3Reporting): Adapter & HostPolicyPort & {
  readonly hostId: string;
  capabilities(): HostCapabilities;
  findRunAgents(run: Run): Promise<{ id: string; workspaceId: string | null }[]>;
} {
  const T3Adapter = t3AdapterClass(Policy);
  return new T3Adapter(host, reporting);
}
