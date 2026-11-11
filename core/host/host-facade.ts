import type { Profile, Task } from '../../shared/contracts';
import type {
  AgentId, AnsweredQuestion, Host, HostCapabilities, HostCatalog, HostCatalogOptions, HostLiveAgent, HostMessage,
  HostObservation, HostTimelineEntry, HostTimelinePage, HostWorkspaceCatalog, NativeQuestion, OriginAgent, RequestId,
  Workspace, WorkspaceId,
} from '../../shared/host';
import type { Adapter } from './adapter';

/**
 * The `Host` contract over the adapter an owner holds right now.
 *
 * Late-bound: the owner (an `Engine` or `Resolution`) is kept, and each call
 * reads `owner.adapter` at that moment. Nothing captures the adapter, so test
 * overrides and any later swap of the admitted adapter are seen by the next
 * call. Each method is a plain return delegate, never an async wrapper, so no
 * microtask turn is added and the adapter's own promise is the one returned.
 *
 * An adapter method that is optional for its host is refused here as a
 * rejection naming the missing capability. A façade never invents a value for
 * an absent method: a caller that needs the fallback keeps its presence check.
 *
 * Only the methods in `HostFacadeMethod` have a delegate in this step. The rest
 * of `Host` either has no adapter method of the same meaning yet (create and
 * archive with a different input, decisions) or is optional on `Host` itself.
 */
export class HostFacade implements Pick<Host, HostFacadeMethod> {
  constructor(private readonly owner: { readonly adapter: Adapter }) {}

  catalog(options?: HostCatalogOptions): Promise<HostCatalog> {
    const { adapter } = this.owner;
    const read = adapter.catalog;
    if (!read) return refused('This host does not report a catalog');
    return read.call(adapter, options);
  }

  profiles(): Promise<Profile[]> {
    const { adapter } = this.owner;
    const read = adapter.profiles;
    if (!read) return refused('This host cannot read profiles');
    return read.call(adapter);
  }

  capabilities(): HostCapabilities {
    const { adapter } = this.owner;
    if (adapter.capabilities) return adapter.capabilities();
    return { reportingViaMcp: adapter.reportingViaMcp === true, supportsCoordinatorRecovery: adapter.supportsCoordinatorRecovery === true };
  }

  findWorkspaces(task: Task): Promise<Workspace[]> {
    return this.owner.adapter.findWorkspaces(task);
  }

  workspaceAvailable(id: WorkspaceId): Promise<boolean> {
    const { adapter } = this.owner;
    const read = adapter.workspaceAvailable;
    if (!read) return refused('This host cannot report workspace availability');
    return read.call(adapter, id);
  }

  workspaceCatalog(directory: string): Promise<HostWorkspaceCatalog> {
    const { adapter } = this.owner;
    const read = adapter.externalWorkspaceCatalog;
    if (!read) return refused('This host cannot read a workspace catalog');
    return read.call(adapter, directory);
  }

  workspaceArchived(id: WorkspaceId): Promise<boolean> {
    const { adapter } = this.owner;
    const read = adapter.taskWorkspaceArchived;
    if (!read) return refused('This host cannot report workspace archive state');
    return read.call(adapter, id);
  }

  originAgent(id: AgentId): Promise<OriginAgent | null> {
    const { adapter } = this.owner;
    const read = adapter.originAgent;
    if (!read) return refused('This host cannot read an origin agent');
    return read.call(adapter, id);
  }

  observe(id: AgentId): Promise<HostObservation> {
    return this.owner.adapter.observe(id);
  }

  observationInventory(ids: readonly AgentId[]): Promise<ReadonlyMap<AgentId, HostObservation> | null> {
    const { adapter } = this.owner;
    const read = adapter.observationInventory;
    if (!read) return refused('This host cannot read an observation inventory');
    return read.call(adapter, ids);
  }

  listLiveAgents(): Promise<HostLiveAgent[]> {
    const { adapter } = this.owner;
    const read = adapter.listLiveAgents;
    if (!read) return refused('This host cannot list live agents');
    return read.call(adapter);
  }

  agentTimelinePage(id: AgentId, limit?: number): Promise<HostTimelinePage | null> {
    const { adapter } = this.owner;
    const read = adapter.agentTimelinePage;
    if (!read) return refused('This host cannot read agent timelines');
    return read.call(adapter, id, limit);
  }

  agentTimeline(id: AgentId, limit?: number): Promise<HostTimelineEntry[] | null> {
    const { adapter } = this.owner;
    const read = adapter.agentTimeline;
    if (!read) return refused('This host cannot read agent timelines');
    return read.call(adapter, id, limit);
  }

  stopAgentTurn(id: AgentId): Promise<void> {
    const { adapter } = this.owner;
    const read = adapter.stopAgentTurn;
    if (!read) return refused('This host cannot stop an agent turn');
    return read.call(adapter, id);
  }

  archiveAgent(id: AgentId): Promise<void> {
    return this.owner.adapter.archiveAgent(id);
  }

  /**
   * Optional on `Host`: present exactly when the adapter has a usage stream, so a
   * caller's presence check reads the same fact it read on the adapter. Each read
   * returns a fresh delegate over the adapter at that moment; the stream is opened
   * by the adapter's own call, with no await in front of it.
   */
  get subscribeRunUsage(): Host["subscribeRunUsage"] {
    const { adapter } = this.owner;
    const read = adapter.subscribeRunUsage;
    if (!read) return undefined;
    return (id, handler) => read.call(adapter, id, handler);
  }

  sendMessage(id: AgentId, input: HostMessage): Promise<void> {
    const { adapter } = this.owner;
    const read = adapter.notify;
    if (!read) return refused('This host cannot send messages');
    return read.call(adapter, id, input.messageId, input.text, input.sourceAgentId);
  }

  enqueueMessage(id: AgentId, input: HostMessage): Promise<void> {
    const { adapter } = this.owner;
    const read = adapter.enqueueMessage;
    if (!read) return refused('This host cannot queue a message behind the current step');
    return read.call(adapter, id, input.messageId, input.text, input.sourceAgentId);
  }

  interruptAndContinue(id: AgentId, messageId: RequestId, text: string): Promise<void> {
    const { adapter } = this.owner;
    const read = adapter.interruptAndContinue;
    if (!read) return refused('This host cannot interrupt and continue an agent');
    return read.call(adapter, id, messageId, text);
  }

  pendingQuestions(id: AgentId): Promise<NativeQuestion[]> {
    const { adapter } = this.owner;
    const read = adapter.pendingQuestions;
    if (!read) return refused('This host cannot read native questions');
    return read.call(adapter, id);
  }

  answeredQuestions(id: AgentId): Promise<AnsweredQuestion[]> {
    const { adapter } = this.owner;
    const read = adapter.answeredQuestions;
    if (!read) return refused('This host cannot read answered questions');
    return read.call(adapter, id);
  }

  answerNativeQuestion(agent: AgentId, workspace: WorkspaceId, request: RequestId, answers: Record<string, string>): Promise<void> {
    const { adapter } = this.owner;
    const read = adapter.answerNativeQuestion;
    if (!read) return refused('This host cannot answer native questions');
    return read.call(adapter, agent, workspace, request, answers);
  }

  dismissNativeQuestion(agent: AgentId, workspace: WorkspaceId, request: RequestId): Promise<void> {
    const { adapter } = this.owner;
    const read = adapter.dismissNativeQuestion;
    if (!read) return refused('This host cannot dismiss native questions');
    return read.call(adapter, agent, workspace, request);
  }
}

/** The methods this façade implements; `Host` keeps the rest as the contract for later rows. */
export type HostFacadeMethod =
  | 'catalog' | 'profiles' | 'capabilities'
  | 'findWorkspaces' | 'workspaceAvailable' | 'workspaceCatalog' | 'workspaceArchived'
  | 'originAgent' | 'observe' | 'observationInventory' | 'listLiveAgents'
  | 'agentTimelinePage' | 'agentTimeline' | 'stopAgentTurn' | 'archiveAgent' | 'subscribeRunUsage'
  | 'sendMessage' | 'enqueueMessage' | 'interruptAndContinue'
  | 'pendingQuestions' | 'answeredQuestions' | 'answerNativeQuestion' | 'dismissNativeQuestion';

function refused(reason: string): Promise<never> {
  return Promise.reject(new Error(reason));
}

