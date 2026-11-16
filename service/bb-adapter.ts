import { HostPolicies } from '../core/host/host-policies';
import type { Adapter, HostPolicyConstructor } from '../core/host';
import { ProvenPreSendRefusalError } from '../core/host/errors';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';
import type { HostAgentSpec, HostWorkspaceRef, HostWorkspaceSpec } from '../shared/host';
import type { Task, Run } from '../shared/contracts';
import { runTicketPath } from '../core/dispatch/agent-creation';
import { parseAgentId } from '../shared/agent-identity';
import { join } from 'node:path';
import { bbVocabulary } from '../hosts/bb/vocabulary';
import { BbThreads, emptyBbThreadState, type BbThreadState, type BbWorkspaceRecord } from '../hosts/bb/threads';
import type { Store } from '../core/store/store';
import type { HostOperationName, HostOperationOutcome } from '../shared/host-operation';

export interface BbWorkspaces extends Pick<Adapter, 'createWorkspace' | 'findWorkspaces' | 'workspaceAvailable' | 'workspaceIdAccepted' | 'taskWorkspaceArchived'> {
  workspaceRef(id: string): HostWorkspaceRef;
  repositoryProject(root: string): Promise<{ projectId?: string; workspaceRoot: string }>;
}

/** Compose core's worktree, launch/ticket and forge policies with BB's native operations. */
export function composeBbAdapter(input: {
  hostId: string; connected(): boolean; dataDir: string; store: Store; workspaces: BbWorkspaces;
  operation(op: HostOperationName, value: unknown): Promise<HostOperationOutcome>;
  notSent(error: unknown): boolean;
  records(): Record<string, BbWorkspaceRecord>; put(record: BbWorkspaceRecord): void;
}): Adapter {
  const { workspaces, store, hostId } = input;
  async function nativeWorkspaceThreads() {
    const rows = await threads.inventoryRows();
    const handles = Object.values(input.records());
    return rows.map(row => {
      const workspace = handles.find(w => w.environmentId === row.environmentId && w.directory === row.environmentPath);
      return { id: row.threadId, workspaceId: workspace?.id ?? null, labels: threads.agents().find(a => a.id === row.threadId)?.labels,
        archived: row.archivedAt !== null, status: row.archivedAt !== null ? 'closed' : row.status,
        activeTurn: ['pending', 'active', 'starting', 'stopping'].includes(row.status) ||
          ['provisioning', 'waiting-for-host'].includes(row.displayStatus) || row.queuedWork === 'waiting' ? {} : null,
        pendingPermissionKinds: row.interactions.filter(i => ['pending', 'resolving'].includes(i.status)).map(i => i.kind) };
    });
  }
  const helperPath = join(input.dataDir, 'worker-report.mjs');
  const threads = new BbThreads({
    hostId, operation: input.operation, helperPath, ticketPath: id => runTicketPath({ helperPath }, id),
    state: () => store.getMeta<BbThreadState>('bbThreads') ?? emptyBbThreadState(), save: state => store.setMeta('bbThreads', state),
    workspace: id => input.records()[id], putWorkspace: input.put, notSent: input.notSent,
    parent(taskId) {
      const task = store.task(taskId);
      const planner = task.plannerAgentId ?? store.projectPlannerRecipient(store.projectFor(task.repoPath, task.repository));
      const identity = planner && parseAgentId(planner);
      if (!identity || identity.hostId !== hostId) throw new ProvenPreSendRefusalError('BB dispatch needs a planner thread on this BB host');
      return identity.nativeAgentId;
    },
  });
  class BbAdapter extends (HostPolicies as unknown as HostPolicyConstructor) {
    readonly hostId = hostId;
    readonly vocabulary = bbVocabulary;
    readonly helperPath = helperPath;
    readonly socketPath = join(input.dataDir, 'callback.sock');
    readonly reportingViaMcp = false;
    readonly supportsCoordinatorRecovery = true;
    readonly admissionLaunchEnv = {};
    readonly testPlacement = undefined;
    isConnected() { return input.connected(); }
    capabilities() { return { reportingViaMcp: false, supportsCoordinatorRecovery: true, lifecycleDispatch: true, perThreadEnvironment: false, repositorySharedWorkspaces: false }; }
    creationOwner() { return { ...super.creationOwner(), perThreadEnvironment: false as const }; }
    nativeAgentCreate(spec: HostAgentSpec, mcp: boolean) {
      if (!input.dataDir || mcp) throw new ProvenPreSendRefusalError('BB dispatch requires helper reporting');
      return threads.createAgent(spec);
    }
    unsupportedMcp() { return false; }
    get workspaceHost() {
      return {
        workspaceInventory: async () => Object.values(input.records()).filter(w => !w.archivedAt).map(w => ({ id: w.id, projectRootPath: w.directory, workspaceDirectory: w.directory })),
        repositoryProject: (root: string) => workspaces.repositoryProject(root),
        createWorkspace: (spec: HostWorkspaceSpec) => workspaces.createWorkspace({ directory: spec.directory, repoPath: spec.project?.workspaceRoot ?? spec.directory, title: spec.title } as Task),
        workspaceRef: (id: string) => workspaces.workspaceRef(id), workspaceIdAccepted: workspaces.workspaceIdAccepted,
        createCloseoutWorkspace: async () => { throw new ProvenPreSendRefusalError('BB closeout workspace registration is unavailable'); },
        archiveThreadPage: async (options: { filter: { includeArchived: boolean } }) => {
          const rows = await nativeWorkspaceThreads();
          return { entries: rows.filter(r => options.filter.includeArchived || !r.archived).map(r => ({ agent: { ...r, archivedAt: r.archived ? true : null, pendingPermissions: r.pendingPermissionKinds } })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        workspaceThreads: async (ids: readonly string[]) => ({ ok: true as const, threads: (await nativeWorkspaceThreads()).filter(r => r.workspaceId && ids.includes(r.workspaceId)) }),
        workspaceTerminals: async () => ({ ok: false as const, reason: 'BB terminal inventory is not a lifecycle fact' }),
        activeThreads: async () => (await nativeWorkspaceThreads()).filter(r => r.activeTurn),
      };
    }
    get messageHost() {
      return { retainedAgentRef: (id: string) => {
        let observed: Awaited<ReturnType<BbThreads['observe']>> | null = null;
        return { get workspaceId() { return observed?.workspaceId ?? null; }, get archivedAt() { return observed?.status === 'closed' ? true : null; },
          get status() { return observed?.status ?? null; }, get activeTurn() { return observed?.active ? {} : null; },
          get pendingPermissions() { return observed?.pendingPermissionKinds ?? null; }, get runtimeInfo() { return observed ? { provider: observed.provider, model: observed.model, modeId: observed.modeId, thinkingOptionId: observed.thinkingOptionId } : null; },
          refresh: async () => { observed = await threads.observe(id); return observed; }, current: () => observed,
          send: async (text: string, options: { messageId: string }) => threads.send(id, text, options.messageId),
        };
      } };
    }
    notify(id: string, messageId: string, text: string) { return threads.send(id, text, messageId); }
    findWorkspaces = (task: Task) => workspaces.findWorkspaces(task);
    workspaceAvailable(id: string) { return workspaces.workspaceAvailable!(id); }
    workspaceIdAccepted(id: unknown) { return workspaces.workspaceIdAccepted!(id); }
    taskWorkspaceArchived(id: string) { return workspaces.taskWorkspaceArchived!(id); }
    findAgents(task: Task) { return task.runId ? threads.findAgents(task.id, task.runId) : Promise.resolve([]); }
    findRunAgents(run: Run) { return threads.findAgents(run.taskId, run.id); }
    observe(id: string) { return threads.observe(id); }
    observationInventory(ids: readonly string[]) { return threads.observationInventory(ids); }
    async originAgent(id: string) {
      const row = await threads.observe(id);
      return { id, workspaceId: row.workspaceId, title: '', archived: row.status === 'closed', labels: row.labels };
    }
    stopAgentTurn(id: string) { return threads.stopAgentTurn(id); }
    archiveAgent(id: string) { return threads.archiveAgent(id); }
    catalog() { return threads.catalog(); }
    async profiles() { return []; }
    agentTimelinePage(id: string) { return threads.timeline(id); }
    async agentTimeline(id: string) { try { return (await threads.timeline(id)).entries; } catch { return null; } }
    async setTaskWorkspaceTitle(task: Task, title: string, requestId: string, _uncertain: boolean) {
      if (!task.agentId) return;
      const step = await this.step(task);
      await threads.title(task.agentId, `${title}${step ? ` · ${step}` : ''}`.slice(0, 200), requestId);
    }
    private async step(task: Task) {
      const participants = store.runs(task.id).filter(r => !r.released && r.agentId && r.role !== 'revision');
      for (const run of participants) {
        const observation = await threads.observe(run.agentId!);
        if (observation.permissions) return `${run.role} needs input`;
        if (observation.error) return `blocked: ${run.role}`;
        if (observation.active) return run.role === 'reviewer' ? 'reviewing' : run.role;
      }
      if (task.agentId) {
        const worker = await threads.observe(task.agentId);
        if (worker.permissions) return 'worker needs input';
        if (worker.error) return 'blocked: worker';
      }
      return '';
    }
    async reconcileThreadTitles(tasks: readonly Task[]) {
      for (const task of tasks) {
        // BB keeps released support roles visible, but a replaced worker is owed
        // archive as soon as its run and native turn have both ended.
        for (const retired of task.retiredWorkers) {
          if (store.unreleasedRunsForAgent(retired.agentId, hostId).length) continue;
          try { await threads.archiveAgent(retired.agentId); }
          catch { /* The durable intent and fresh turn/cascade reads govern the next sweep. */ }
        }
        if (!task.agentId || task.phase === 'done') continue;
        try { const title = taskWorkspaceTitle(task); await this.setTaskWorkspaceTitle(task, title, `${task.id}:${task.version}`, false); }
        catch { /* An unreadable row or unknown write is observation-only on the next sweep. */ }
      }
    }
  }
  return new BbAdapter() as unknown as Adapter;
}
