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
 * observation, host loss, or a new dispatching thread. A generation fence keeps
 * an older in-flight inventory from restoring an invalidated entry.
 */
export class ResponsibleThreadCache {
  private readonly entries = new Map<string, ResponsibleShortlist>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, Promise<ResponsibleShortlist>>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  invalidate(projectKey: string): void {
    this.entries.delete(projectKey);
    this.pending.delete(projectKey);
    this.generations.set(projectKey, (this.generations.get(projectKey) ?? 0) + 1);
  }

  invalidateAll(): void {
    for (const key of new Set([...this.entries.keys(), ...this.pending.keys()])) this.invalidate(key);
  }

  async resolve(projectKey: string, hosts: readonly ResponsibleHost[]): Promise<ResponsibleShortlist> {
    const cached = this.entries.get(projectKey);
    if (cached && this.clock() - cached.observedAt < this.ttlMs) return cached;
    const current = this.pending.get(projectKey);
    if (current) return current;
    const generation = this.generations.get(projectKey) ?? 0;
    const read = this.collect(hosts).then(result => {
      if ((this.generations.get(projectKey) ?? 0) !== generation)
        throw new Error('Responsible thread inventory was invalidated');
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
