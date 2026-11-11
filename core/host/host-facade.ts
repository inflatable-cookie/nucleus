import { callerNativeId, foreignIdentityRefusal, parseAgentId } from '../../shared/agent-identity';
import type { Profile, Task } from '../../shared/contracts';
import type {
  AgentId, AnsweredQuestion, Host, HostCapabilities, HostCatalog, HostCatalogOptions, HostLiveAgent, HostMessage,
  HostObservation, HostTimelineEntry, HostTimelinePage, HostWorkspaceCatalog, NativeQuestion, OriginAgent, RequestId, HostPermissionDecision,
  Workspace, WorkspaceId,
} from '../../shared/host';
import type { Adapter } from './adapter';

/**
 * What an owner contributes to cross-host identity routing. An owner that can
 * re-bind the transport context (`Engine`, `Resolution`) carries `withHost` and
 * an `hostOnline` read that is independent of the active host context; a bare
 * `{ adapter }` owner carries neither, so a foreign identity refuses instead.
 */
export interface HostRoutingOwner {
  readonly adapter: Adapter;
  readonly activeHostId?: string;
  readonly withHost?: <T>(hostId: string, fn: () => T) => T;
  /** Registered and connected, read without the ambient host context. */
  readonly hostOnline?: (hostId: string) => boolean;
}

/**
 * The `Host` contract over the adapter an owner holds right now.
 *
 * Late-bound: the owner (an `Engine` or `Resolution`) is kept, and each call
 * reads `owner.adapter` at that moment. Nothing captures the adapter, so test
 * overrides and any later swap of the admitted adapter are seen by the next
 * call. Each method is a plain return delegate, never an async wrapper, so no
 * microtask turn is added and the adapter's own promise is the one returned.
 *
 * A call that names an agent goes to that agent's own host (`#route`): an
 * identity qualified for another registered host is served there, so a host
 * call is never unwrapped against the wrong transport. Refused only when the
 * identity's host is unknown or offline, naming it.
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
  constructor(private readonly owner: HostRoutingOwner) {}

  /** The host the facade is bound to right now: the ambient context, else the adapter's own. */
  #boundHost(): string | undefined {
    return this.owner.activeHostId ?? (this.owner.adapter as Adapter & { hostId?: string }).hostId;
  }

  /**
   * Read an agent-naming adapter method for `id` on the host that identity
   * belongs to. The bound host unwraps in place with no added turn; another
   * registered host receives the routed read inside its own context; an unknown
   * or offline host refuses, named.
   */
  #route<T>(id: AgentId, read: (adapter: Adapter, nativeId: string) => Promise<T>): Promise<T> {
    const parsed = parseAgentId(id);
    if (!parsed) return read(this.owner.adapter, id);
    const bound = this.#boundHost();
    if (!bound || parsed.hostId === bound) return read(this.owner.adapter, callerNativeId(id, bound));
    if (!this.owner.withHost || (this.owner.hostOnline && !this.owner.hostOnline(parsed.hostId)))
      throw new Error(foreignIdentityRefusal(parsed.hostId));
    return this.owner.withHost(parsed.hostId, () => read(this.owner.adapter, parsed.nativeAgentId));
  }

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
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.originAgent;
      if (!read) return refused('This host cannot read an origin agent');
      return read.call(adapter, nativeId);
    });
  }

  observe(id: AgentId): Promise<HostObservation> {
    return this.#route(id, (adapter, nativeId) => adapter.observe(nativeId));
  }

  observationInventory(ids: readonly AgentId[]): Promise<ReadonlyMap<AgentId, HostObservation> | null> {
    const { adapter } = this.owner;
    const read = adapter.observationInventory;
    if (!read) return refused('This host cannot read an observation inventory');
    if (!ids.some(id => parseAgentId(id))) return read.call(adapter, ids);
    // One inventory across hosts: each qualified identity is read on its own
    // host, and the caller's qualified keys are rebuilt over the merged map.
    const bound = this.#boundHost();
    const groups = new Map<string, { qualified: AgentId[]; native: string[] }>();
    const groupFor = (host: string) => groups.get(host) ?? groups.set(host, { qualified: [] as AgentId[], native: [] as string[] }).get(host)!;
    for (const id of ids) {
      const parsed = parseAgentId(id);
      if (!parsed) { const group = groupFor(bound ?? ''); group.qualified.push(id); group.native.push(id); continue; }
      if (!bound || parsed.hostId === bound) { const group = groupFor(bound ?? ''); group.qualified.push(id); group.native.push(parsed.nativeAgentId); continue; }
      if (this.owner.withHost && this.owner.hostOnline?.(parsed.hostId) !== false) {
        const group = groupFor(parsed.hostId); group.qualified.push(id); group.native.push(parsed.nativeAgentId); continue;
      }
      throw new Error(foreignIdentityRefusal(parsed.hostId));
    }
    const reads = [...groups.entries()].map(([host, group]) => {
      // The method is looked up inside each group read, never captured: on an
      // Engine the adapter is a transport proxy bound at property-access time,
      // so a captured reference would serve every group from the ambient
      // transport — exactly the unwrap-against-the-wrong-host this class fix
      // removes.
      const call = () => {
        const groupRead = this.owner.adapter.observationInventory;
        if (!groupRead) return refused('This host cannot read an observation inventory');
        return groupRead.call(this.owner.adapter, group.native)
          .then(result => result ? new Map(group.qualified.flatMap((id, i) => {
            const observation = result.get(group.native[i]!); return observation ? [[id, observation] as const] : []; })) as ReadonlyMap<AgentId, HostObservation>
          : null);
      };
      return !host || host === bound ? call() : this.owner.withHost!(host, call);
    });
    if (reads.length === 1) return reads[0]!;
    return Promise.all(reads).then(results => results.every(result => result !== null)
      ? new Map(results.flatMap(result => [...result!])) : null);
  }

  listLiveAgents(): Promise<HostLiveAgent[]> {
    const { adapter } = this.owner;
    const read = adapter.listLiveAgents;
    if (!read) return refused('This host cannot list live agents');
    return read.call(adapter);
  }

  agentTimelinePage(id: AgentId, limit?: number): Promise<HostTimelinePage | null> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.agentTimelinePage;
      if (!read) return refused('This host cannot read agent timelines');
      return read.call(adapter, nativeId, limit);
    });
  }

  agentTimeline(id: AgentId, limit?: number): Promise<HostTimelineEntry[] | null> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.agentTimeline;
      if (!read) return refused('This host cannot read agent timelines');
      return read.call(adapter, nativeId, limit);
    });
  }

  stopAgentTurn(id: AgentId): Promise<void> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.stopAgentTurn;
      if (!read) return refused('This host cannot stop an agent turn');
      return read.call(adapter, nativeId);
    });
  }

  archiveAgent(id: AgentId): Promise<void> {
    return this.#route(id, (adapter, nativeId) => adapter.archiveAgent(nativeId));
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
    return (id, handler) => this.#route(id, (routed, nativeId) => {
      const stream = routed.subscribeRunUsage;
      if (!stream) return refused('This host cannot report run usage');
      return stream.call(routed, nativeId, handler);
    });
  }

  sendMessage(id: AgentId, input: HostMessage): Promise<void> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.notify;
      if (!read) return refused('This host cannot send messages');
      // A source on the routed host is unwrapped for it; a source on yet another
      // host cannot be unwrapped there and rides out (the ask route drops it too).
      const source = this.#sourceForHost(input.sourceAgentId, adapter);
      return read.call(adapter, nativeId, input.messageId, input.text, source);
    });
  }

  enqueueMessage(id: AgentId, input: HostMessage): Promise<void> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.enqueueMessage;
      if (!read) return refused('This host cannot queue a message behind the current step');
      const source = this.#sourceForHost(input.sourceAgentId, adapter);
      return read.call(adapter, nativeId, input.messageId, input.text, source);
    });
  }

  interruptAndContinue(id: AgentId, messageId: RequestId, text: string): Promise<void> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.interruptAndContinue;
      if (!read) return refused('This host cannot interrupt and continue an agent');
      return read.call(adapter, nativeId, messageId, text);
    });
  }

  pendingQuestions(id: AgentId): Promise<NativeQuestion[]> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.pendingQuestions;
      if (!read) return refused('This host cannot read native questions');
      return read.call(adapter, nativeId);
    });
  }

  answeredQuestions(id: AgentId): Promise<AnsweredQuestion[]> {
    return this.#route(id, (adapter, nativeId) => {
      const read = adapter.answeredQuestions;
      if (!read) return refused('This host cannot read answered questions');
      return read.call(adapter, nativeId);
    });
  }

  answerNativeQuestion(agent: AgentId, workspace: WorkspaceId, request: RequestId, answers: Record<string, string>): Promise<void> {
    return this.#route(agent, (adapter, nativeId) => {
      const read = adapter.answerNativeQuestion;
      if (!read) return refused('This host cannot answer native questions');
      return read.call(adapter, nativeId, workspace, request, answers);
    });
  }

  answerNativePermission(agent: AgentId, workspace: WorkspaceId, request: RequestId, decision: HostPermissionDecision, intentId: RequestId): Promise<void> {
    return this.#route(agent, (adapter, nativeId) => {
      const read = adapter.answerNativePermission;
      if (!read) return refused('This host cannot answer native permissions');
      return read.call(adapter, nativeId, workspace, request, decision, intentId);
    });
  }

  dismissNativeQuestion(agent: AgentId, workspace: WorkspaceId, request: RequestId): Promise<void> {
    return this.#route(agent, (adapter, nativeId) => {
      const read = adapter.dismissNativeQuestion;
      if (!read) return refused('This host cannot dismiss native questions');
      return read.call(adapter, nativeId, workspace, request);
    });
  }

  /** The optional message source, unwrapped only for the host that receives the send. */
  #sourceForHost(sourceAgentId: AgentId | undefined, adapter: Adapter): string | undefined {
    if (sourceAgentId === undefined) return undefined;
    const parsed = parseAgentId(sourceAgentId);
    if (!parsed) return sourceAgentId;
    const host = (adapter as Adapter & { hostId?: string }).hostId ?? this.#boundHost();
    if (!host || parsed.hostId === host) return callerNativeId(sourceAgentId, host);
    // A source on another known host cannot be unwrapped by the receiving host;
    // the send rides out without it (the delegated ask route drops it too).
    if (this.owner.hostOnline?.(parsed.hostId)) return undefined;
    throw new Error(foreignIdentityRefusal(parsed.hostId));
  }
}

/** The methods this façade implements; `Host` keeps the rest as the contract for later rows. */
export type HostFacadeMethod =
  | 'catalog' | 'profiles' | 'capabilities'
  | 'findWorkspaces' | 'workspaceAvailable' | 'workspaceCatalog' | 'workspaceArchived'
  | 'originAgent' | 'observe' | 'observationInventory' | 'listLiveAgents'
  | 'agentTimelinePage' | 'agentTimeline' | 'stopAgentTurn' | 'archiveAgent' | 'subscribeRunUsage'
  | 'sendMessage' | 'enqueueMessage' | 'interruptAndContinue'
  | 'pendingQuestions' | 'answeredQuestions' | 'answerNativeQuestion' | 'answerNativePermission' | 'dismissNativeQuestion';

function refused(reason: string): Promise<never> {
  return Promise.reject(new Error(reason));
}

