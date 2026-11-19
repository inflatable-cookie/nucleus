import { formatAgentId } from '../../shared/agent-identity';

/** A host-qualified, live thread eligible to receive cross-project messages. */
export interface ResponsibleThread {
  agentId: string;
  hostId: string;
  lastInteraction: string | null;
}

/** Facts supplied by a host inventory and the project/task registry. */
export interface ResponsibleThreadFact {
  nativeId: string;
  lastInteraction: string | null;
  belongsToProject: boolean;
  taskRole: boolean;
  closed: boolean;
  registeredHint: boolean;
}

export interface ResponsibleHost {
  id: string;
  inventory(): Promise<readonly ResponsibleThreadFact[]>;
}

export interface ResponsibleShortlist {
  threads: ResponsibleThread[];
  observedAt: number;
}

const DEFAULT_TTL_MS = 3 * 60_000;
const DEFAULT_HOST_TIMEOUT_MS = 2_000;

/**
 * The cache owns no host state. Callers invalidate on delivery failure, a closed
 * observation, host loss, or a new dispatching thread. An identity fence keeps
 * an older in-flight inventory from restoring an invalidated entry.
 */
export class ResponsibleThreadCache {
  private readonly entries = new Map<string, ResponsibleShortlist>();
  private readonly pending = new Map<string, Promise<ResponsibleShortlist | null>>();
  private readonly needsInventory = new WeakSet<ResponsibleShortlist>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  peek(projectKey: string): ResponsibleShortlist | null {
    const cached = this.entries.get(projectKey);
    return cached && this.clock() - cached.observedAt < this.ttlMs ? cached : null;
  }

  invalidate(projectKey: string): void {
    this.entries.delete(projectKey);
    this.pending.delete(projectKey);
  }

  invalidateMatching(agentId: string): void {
    for (const [key, shortlist] of this.entries) {
      if (shortlist.threads.some(thread => thread.agentId === agentId)) this.invalidate(key);
    }
  }

  /** Retain the survivors for synchronous readers while requiring a new inventory. */
  discardClosed(projectKey: string, shortlist: ResponsibleShortlist, closed: ReadonlySet<string>): ResponsibleShortlist {
    const replacement = { ...shortlist, threads: shortlist.threads.filter(thread => !closed.has(thread.agentId)) };
    this.needsInventory.add(replacement);
    this.entries.set(projectKey, replacement);
    return replacement;
  }

  async resolve(projectKey: string, hosts: readonly ResponsibleHost[]): Promise<ResponsibleShortlist | null> {
    const cached = this.peek(projectKey);
    if (cached && !this.needsInventory.has(cached)) return cached;
    const current = this.pending.get(projectKey);
    if (current) return current;
    const read = this.collect(hosts).then(result => {
      if (this.pending.get(projectKey) !== read) return null;
      this.entries.set(projectKey, result);
      return result;
    }).finally(() => {
      if (this.pending.get(projectKey) === read) this.pending.delete(projectKey);
    });
    this.pending.set(projectKey, read);
    return read;
  }

  private async collect(hosts: readonly ResponsibleHost[]): Promise<ResponsibleShortlist> {
    const inventories = await Promise.all(hosts.map(async host => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const facts = await Promise.race([
          host.inventory(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Host inventory timed out')), this.hostTimeoutMs); }),
        ]);
        return facts.filter(fact => fact.belongsToProject && !fact.taskRole && !fact.closed)
          .map(fact => ({ ...fact, hostId: host.id, agentId: formatAgentId(host.id, fact.nativeId) }));
      } catch {
        return [];
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
    const threads = inventories.flat().sort((a, b) =>
      Number(b.registeredHint) - Number(a.registeredHint)
      || (b.lastInteraction ?? '').localeCompare(a.lastInteraction ?? '')
      || a.agentId.localeCompare(b.agentId))
      .map(({ agentId, hostId, lastInteraction }) => ({ agentId, hostId, lastInteraction }));
    return { threads, observedAt: this.clock() };
  }
}
