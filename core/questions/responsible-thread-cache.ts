import { formatAgentId } from "../../shared/agent-identity";
import type { ResponsibleThreadReason } from "../../shared/responsible-thread";

/** A host-qualified, live thread eligible to receive cross-project messages. */
export interface ResponsibleThread {
  agentId: string;
  hostId: string;
  lastInteraction: string | null;
  /** Every reason this thread is a candidate, strongest first; `project.get` shows them. */
  reasons: ResponsibleThreadReason[];
}

/** Facts supplied by a host inventory and the project/task registry. */
export interface ResponsibleThreadFact {
  nativeId: string;
  lastInteraction: string | null;
  /** The project's registered `project.set-planner` thread. */
  registeredPlanner: boolean;
  /** A thread `agent.register` names on the project. */
  registeredAgent: boolean;
  /** The thread dispatched or owns tasks in the project. */
  dispatcher: boolean;
  /** The thread works in a project checkout or linked worktree. */
  repositoryWorker: boolean;
  taskRole: boolean;
  closed: boolean;
}

export interface ResponsibleHost {
  id: string;
  inventory(): Promise<readonly ResponsibleThreadFact[]>;
}

export interface ResponsibleShortlist {
  threads: ResponsibleThread[];
  observedAt: number;
  /** True when at least one online host failed or timed out during inventory, so absence is not proved. */
  incomplete?: boolean;
}

/**
 * How one shortlisted thread answered its last observation. Only `gone` drops a
 * candidate from the shortlist; `unverified` (a slow or failed read, or a host
 * that could not answer) keeps its rank, and `unroutable` (the host named a
 * different thread) is never picked (Tom, 2026-11-19; nucleus#1383).
 */
export type ResponsibleObservationState =
  | "routable"
  | "unverified"
  | "unroutable";

export interface ResponsibleObservation {
  state: ResponsibleObservationState;
  /** Why the thread is not verified or not routable; null when routable. */
  detail: string | null;
  /** When the observation finished. */
  observedAt: string;
}

/** A shortlisted thread with its last observation; `project.get` shows every one of these. */
export interface ResponsibleCandidate extends ResponsibleThread {
  observation: ResponsibleObservation | null;
}

/**
 * The bound on one planner-thread read on a busy Paseo daemon. A read that does
 * not finish in time is unverified, never gone, so a busy planner keeps its rank.
 */
export const RESPONSIBLE_OBSERVATION_MS = 5_000;

const DEFAULT_TTL_MS = 3 * 60_000;
const DEFAULT_HOST_TIMEOUT_MS = 5_000;

/**
 * Registration outranks dispatch, dispatch outranks a bare repository worker,
 * and a live registered planner outranks every other candidate however recently
 * it was active. Within one rank the most recent interaction wins.
 */
export const RESPONSIBLE_THREAD_RANK: Record<ResponsibleThreadReason, number> =
  {
    "registered-planner": 3,
    dispatcher: 2,
    "registered-agent": 1,
    "repository-worker": 0,
  };

function reasonsOf(fact: ResponsibleThreadFact): ResponsibleThreadReason[] {
  return [
    ...(fact.registeredPlanner ? ["registered-planner" as const] : []),
    ...(fact.dispatcher ? ["dispatcher" as const] : []),
    ...(fact.registeredAgent ? ["registered-agent" as const] : []),
    ...(fact.repositoryWorker ? ["repository-worker" as const] : []),
  ];
}

/**
 * An explicit registration is a candidate even when the thread carries a task
 * label: the operator named it, so it is not merely a busy worker.
 */
function candidate(
  fact: ResponsibleThreadFact,
  reasons: readonly ResponsibleThreadReason[],
): boolean {
  if (fact.closed || !reasons.length) return false;
  return !fact.taskRole || fact.registeredPlanner || fact.registeredAgent;
}

function rank(reasons: readonly ResponsibleThreadReason[]): number {
  return reasons.reduce(
    (highest, reason) => Math.max(highest, RESPONSIBLE_THREAD_RANK[reason]),
    -1,
  );
}

/**
 * The cache owns no host state. Callers invalidate on delivery failure, a closed
 * observation, host loss, or a new dispatching thread. An identity fence keeps
 * an older in-flight inventory from restoring an invalidated entry.
 */
export class ResponsibleThreadCache {
  private readonly entries = new Map<string, ResponsibleShortlist>();
  private readonly pending = new Map<
    string,
    Promise<ResponsibleShortlist | null>
  >();
  private readonly needsInventory = new WeakSet<ResponsibleShortlist>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly hostTimeoutMs = DEFAULT_HOST_TIMEOUT_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  peek(projectKey: string): ResponsibleShortlist | null {
    const cached = this.entries.get(projectKey);
    return cached && this.clock() - cached.observedAt < this.ttlMs
      ? cached
      : null;
  }

  invalidate(projectKey: string): void {
    this.entries.delete(projectKey);
    this.pending.delete(projectKey);
  }

  invalidateMatching(agentId: string): void {
    for (const [key, shortlist] of this.entries) {
      if (shortlist.threads.some((thread) => thread.agentId === agentId))
        this.invalidate(key);
    }
  }

  /** Retain the survivors for synchronous readers while requiring a new inventory. */
  discardClosed(
    projectKey: string,
    shortlist: ResponsibleShortlist,
    closed: ReadonlySet<string>,
  ): ResponsibleShortlist {
    const replacement = {
      ...shortlist,
      threads: shortlist.threads.filter(
        (thread) => !closed.has(thread.agentId),
      ),
    };
    this.needsInventory.add(replacement);
    this.entries.set(projectKey, replacement);
    return replacement;
  }

  async resolve(
    projectKey: string,
    hosts: readonly ResponsibleHost[],
  ): Promise<ResponsibleShortlist | null> {
    const cached = this.peek(projectKey);
    if (cached && !this.needsInventory.has(cached)) return cached;
    const current = this.pending.get(projectKey);
    if (current) return current;
    const read = this.collect(hosts)
      .then((shortlist) => {
        if (this.pending.get(projectKey) !== read) return null;
        if (shortlist.incomplete) this.needsInventory.add(shortlist);
        this.entries.set(projectKey, shortlist);
        return shortlist;
      })
      .finally(() => {
        if (this.pending.get(projectKey) === read)
          this.pending.delete(projectKey);
      });
    this.pending.set(projectKey, read);
    return read;
  }

  private async collect(
    hosts: readonly ResponsibleHost[],
  ): Promise<ResponsibleShortlist> {
    let incomplete = false;
    const inventories = await Promise.all(
      hosts.map(async (host) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const facts = await Promise.race([
            host.inventory(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Host inventory timed out")),
                this.hostTimeoutMs,
              );
            }),
          ]);
          return facts
            .map((fact) => ({ fact, reasons: reasonsOf(fact) }))
            .filter(({ fact, reasons }) => candidate(fact, reasons))
            .map(({ fact, reasons }) => ({
              ...fact,
              reasons,
              hostId: host.id,
              agentId: formatAgentId(host.id, fact.nativeId),
            }));
        } catch {
          incomplete = true;
          return [];
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    const threads = inventories
      .flat()
      .sort(
        (a, b) =>
          rank(b.reasons) - rank(a.reasons) ||
          (b.lastInteraction ?? "").localeCompare(a.lastInteraction ?? "") ||
          a.agentId.localeCompare(b.agentId),
      )
      .map(({ agentId, hostId, lastInteraction, reasons }) => ({
        agentId,
        hostId,
        lastInteraction,
        reasons,
      }));
    return {
      threads,
      observedAt: this.clock(),
      ...(incomplete ? { incomplete: true } : {}),
    };
  }
}
