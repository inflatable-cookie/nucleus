import type {
  HostObservation,
  HostTimelineEntry,
  HostTimelinePage,
} from "../../shared/host";
import type { HostProcessListRead } from "../machine/host-process-listing";

/**
 * Default deadline for a single host process-table read (Spec 068 §6).
 * Well inside the 120 s task quantum bound so a slow `ps`/`lsof`/env walk
 * settles as `unknown` instead of holding a task lane.
 */
export const PASS_PROCESS_READ_DEADLINE_MS = 15_000;

/**
 * Default deadline for any read taken inside a task quantum (Spec 066 R1,
 * Spec 068 §6): forge probes, participant observes, and timeline reads return
 * `unknown` when missed instead of hanging the quantum.
 */
export const QUANTUM_READ_DEADLINE_MS = 10_000;

/**
 * Total per-host budget for warming timeline snapshots during one host pass.
 * Keeps a slow host's backlog from delaying healthy hosts' task visits.
 */
export const HOST_PASS_WARM_BUDGET_MS = 10_000;

/** Maximum number of timeline warming reads one host pass attempts per host. */
export const HOST_PASS_WARM_CANDIDATE_CAP = 8;

/** Typed result of one bounded read: either the observed value or `unknown` on timeout. */
export type BoundedReadResult<T> =
  | { state: "ok"; value: T }
  | { state: "unknown"; reason: string };

/** Process-table read annotated with capture time and snapshot provenance. */
export type PassProcessRead = HostProcessListRead & {
  /** Wall-clock ms when the underlying listing read began. */
  capturedAt: number;
  /** True when served from a shared pass snapshot rather than an inline read. */
  fromPassSnapshot: boolean;
};

/**
 * Proof that a cached timeline page was captured after the agent was terminal
 * in its workspace. For a non-archived (`closed`) resumable thread, `closedUpdatedAt`
 * ties the page to that exact closure so a later resume + re-close cannot reuse it.
 */
export type ProvenTerminalSnapshot = {
  archived: boolean;
  workspaceId: string;
  closedUpdatedAt?: string | null;
};

/** Participant observation identity covered by a warmed tool-timeline page. */
export type CoveredObservationSnapshot = {
  updatedAt?: string | null;
  status?: string;
  archived?: boolean;
};

/** Timeline-page read annotated with snapshot provenance, capture time and freshness proofs. */
export type PassTimelinePageRead =
  BoundedReadResult<HostTimelinePage | null> & {
    capturedAt?: number;
    fromPassSnapshot: boolean;
    provenTerminal?: ProvenTerminalSnapshot;
    coveredObservation?: CoveredObservationSnapshot;
  };

/**
 * Run `work()` under `deadlineMs`. A deadline miss resolves as `{ state: "unknown", reason }`
 * rather than throwing, so callers treat timeout as an explicit unknown fact (Spec 066 R1).
 * A genuine error thrown by `work()` before the deadline propagates so transport and refusal
 * classifiers keep their own semantics; a late rejection after timeout is swallowed so it
 * never surfaces as an unhandled rejection.
 */
export async function boundedRead<T>(
  label: string,
  work: () => Promise<T>,
  deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
): Promise<BoundedReadResult<T>> {
  const boundMs = Math.max(0, deadlineMs);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Invoke `work()` synchronously so caller stack frames stay intact and no
  // extra microtask turn sits ahead of the underlying host/process call.
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
  // Prevent a late rejection after the deadline has already settled from
  // escaping as an unhandled rejection.
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending.then((value): BoundedReadResult<T> => {
        settled = true;
        return { state: "ok", value };
      }),
      new Promise<BoundedReadResult<T>>((resolve) => {
        timer = setTimeout(() => {
          settled = true;
          resolve({
            state: "unknown",
            reason: `${label} timed out after ${boundMs} ms`,
          });
        }, boundMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!settled) {
      /* work rejected before deadline; caller receives the rejection */
    }
  }
}

/** Normalize a host id into a stable snapshot key. */
function hostKeyOf(hostId?: string | null): string {
  return hostId ?? "";
}

type CachedTimelinePageEntry = {
  limit: number | undefined;
  promise: Promise<PassTimelinePageRead>;
  settled?: PassTimelinePageRead;
};

/**
 * One sweep pass's shared observation snapshot (Spec 068 §6, Spec 066 R1).
 *
 * Process-table and timeline reads collected during a host pass are shared
 * across every task quantum in that pass for the same host. Once a host pass
 * finishes (`sealHost`), task-lane timeline misses return explicit `unknown`
 * rather than starting new timeline RPCs on exclusive task lanes. The pass
 * expires the snapshot when it finishes so stale reads never cross passes.
 */
export class PassSnapshot {
  private isActive = true;
  private readonly hostInventories = new Map<
    string,
    Map<string, HostObservation>
  >();
  private readonly processReads = new Map<string, Promise<PassProcessRead>>();
  private readonly timelineReads = new Map<
    string,
    Promise<BoundedReadResult<HostTimelineEntry[] | null>>
  >();
  private readonly timelinePageReads = new Map<
    string,
    CachedTimelinePageEntry[]
  >();
  private readonly timelineBudgetExhausted = new Map<string, string>();
  private readonly sealedHosts = new Set<string>();

  /** True only while the owning sweep pass is still running. */
  get active(): boolean {
    return this.isActive;
  }

  /** End this pass's validity window and drop all cached observations. */
  expire(): void {
    this.isActive = false;
    this.hostInventories.clear();
    this.processReads.clear();
    this.timelineReads.clear();
    this.timelinePageReads.clear();
    this.timelineBudgetExhausted.clear();
    this.sealedHosts.clear();
  }

  /**
   * Seal a host after its `HostPass` completes priming. Task quanta on a sealed
   * host read only cached timeline snapshots and receive explicit `unknown` on
   * cache misses instead of issuing new timeline RPCs in task lanes.
   */
  sealHost(hostId: string | null | undefined): void {
    if (!this.isActive) return;
    this.sealedHosts.add(hostKeyOf(hostId));
  }

  /**
   * Record one host's pre-process observation inventory for this pass.
   * Because `HostPass` reads `observationInventory` before `processSnapshot`,
   * any agent already observed idle/closed/gone here was inactive before the
   * process table was captured.
   */
  recordHostInventory(
    hostId: string | null | undefined,
    inventory: ReadonlyMap<string, HostObservation> | null,
  ): void {
    if (!this.isActive || !inventory) return;
    const key = hostKeyOf(hostId);
    const merged =
      this.hostInventories.get(key) ?? new Map<string, HostObservation>();
    for (const [id, obs] of inventory) merged.set(id, obs);
    this.hostInventories.set(key, merged);
  }

  /**
   * Record one exact pre-process observation (such as an archived or gone
   * retained participant omitted from live inventory) before `processSnapshot`.
   */
  recordHostObservation(
    hostId: string | null | undefined,
    agentId: string,
    observation: HostObservation,
  ): void {
    if (!this.isActive) return;
    const key = hostKeyOf(hostId);
    const map =
      this.hostInventories.get(key) ?? new Map<string, HostObservation>();
    map.set(agentId, observation);
    this.hostInventories.set(key, map);
  }

  /** The pre-process observation for `agentId` on `hostId`, or null if none was captured. */
  observedBeforeProcessSnapshot(
    hostId: string | null | undefined,
    agentId: string,
  ): HostObservation | null {
    if (!this.isActive) return null;
    return this.hostInventories.get(hostKeyOf(hostId))?.get(agentId) ?? null;
  }

  /** Record that this host spent its timeline-warming budget for this pass. */
  markTimelineBudgetExhausted(
    hostId: string | null | undefined,
    reason: string,
  ): void {
    if (!this.isActive) return;
    this.timelineBudgetExhausted.set(hostKeyOf(hostId), reason);
  }

  /** Reason this host's timeline warming budget was spent in this pass, or null. */
  timelineBudgetExhaustedReason(hostId?: string | null): string | null {
    if (!this.isActive) return null;
    return this.timelineBudgetExhausted.get(hostKeyOf(hostId)) ?? null;
  }

  /**
   * Read or share this host's bounded process-table snapshot for this pass.
   * An expired snapshot never serves cached data and falls through to a fresh
   * bounded read.
   */
  processes(
    hostId: string | null | undefined,
    read: () => Promise<HostProcessListRead>,
    deadlineMs: number = PASS_PROCESS_READ_DEADLINE_MS,
  ): Promise<PassProcessRead> {
    const run = (fromPassSnapshot: boolean): Promise<PassProcessRead> => {
      const capturedAt = Date.now();
      return boundedRead("host process listing", read, deadlineMs).then(
        (result) =>
          result.state === "ok"
            ? { ...result.value, capturedAt, fromPassSnapshot }
            : {
                state: "unknown",
                reason: result.reason,
                capturedAt,
                fromPassSnapshot,
              },
        (error) => ({
          state: "unknown",
          reason: `host process listing failed: ${error instanceof Error ? error.message : String(error)}`,
          capturedAt,
          fromPassSnapshot,
        }),
      );
    };
    if (!this.isActive) return run(false);
    const key = hostKeyOf(hostId);
    const existing = this.processReads.get(key);
    if (existing) return existing;
    const promise = run(true);
    this.processReads.set(key, promise);
    return promise;
  }

  /**
   * Drop one host's cached process table after an in-pass mutation (such as
   * reaping stray task processes) so a post-mutation verification reads fresh
   * process state.
   */
  invalidateProcesses(hostId?: string | null): void {
    this.processReads.delete(hostKeyOf(hostId));
  }

  /**
   * Read or share one agent's bounded timeline snapshot for this pass.
   * On a sealed host, a cache miss returns explicit `unknown` without starting
   * an inline RPC in the task lane.
   */
  timeline(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    read: () => Promise<HostTimelineEntry[] | null>,
    deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
    options: { allowMissFetch?: boolean } = {},
  ): Promise<BoundedReadResult<HostTimelineEntry[] | null>> {
    const run = () => boundedRead("agent timeline", read, deadlineMs);
    if (!this.isActive) return run();
    const hostKey = hostKeyOf(hostId);
    const key = `${hostKey}\0${agentId}\0${limit ?? ""}`;
    const existing = this.timelineReads.get(key);
    if (existing) return existing;
    const exhausted = this.timelineBudgetExhausted.get(hostKey);
    if (exhausted)
      return Promise.resolve({ state: "unknown", reason: exhausted });
    if (this.sealedHosts.has(hostKey) && !options.allowMissFetch) {
      return Promise.resolve({
        state: "unknown",
        reason:
          "agent timeline was not captured in this host pass; waiting for the next pass",
      });
    }
    const promise = run().catch((error) => {
      if (this.timelineReads.get(key) === promise)
        this.timelineReads.delete(key);
      throw error;
    });
    this.timelineReads.set(key, promise);
    return promise;
  }

  /**
   * Store an already-read (e.g. expanded) timeline page into this pass snapshot
   * for `agentId` on `hostId`.
   */
  storeTimelinePage(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    settled: PassTimelinePageRead,
  ): void {
    if (!this.isActive) return;
    const hostKey = hostKeyOf(hostId);
    const agentKey = `${hostKey}\0${agentId}`;
    const entries = this.timelinePageReads.get(agentKey) ?? [];
    entries.push({
      limit,
      promise: Promise.resolve(settled),
      settled,
    });
    this.timelinePageReads.set(agentKey, entries);
  }

  /**
   * Read or share one agent's bounded timeline page snapshot for this pass.
   * A cached page for the same `(host, agentId)` covers a request when either
   * its limit matches, its settled page is complete (`hasOlder === false`, no
   * gap/reset/staleCursor), or its limit is at least as wide as requested.
   * On a sealed host, a cache miss returns explicit `unknown` instead of
   * starting a timeline RPC in the task lane.
   */
  timelinePage(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    read: () => Promise<HostTimelinePage | null>,
    deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
    options: {
      provenTerminal?: ProvenTerminalSnapshot;
      coveredObservation?: CoveredObservationSnapshot;
      allowMissFetch?: boolean;
    } = {},
  ): Promise<PassTimelinePageRead> {
    const run = (fromPassSnapshot: boolean): Promise<PassTimelinePageRead> => {
      const capturedAt = Date.now();
      return boundedRead("agent timeline page", read, deadlineMs).then(
        (result) => ({
          ...result,
          capturedAt,
          fromPassSnapshot,
          ...(options.provenTerminal
            ? { provenTerminal: options.provenTerminal }
            : {}),
          ...(options.coveredObservation
            ? { coveredObservation: options.coveredObservation }
            : {}),
        }),
      );
    };
    if (!this.isActive) return run(false);
    const hostKey = hostKeyOf(hostId);
    const agentKey = `${hostKey}\0${agentId}`;
    const entries = this.timelinePageReads.get(agentKey) ?? [];
    const compatible = (entry: CachedTimelinePageEntry): boolean => {
      if (options.provenTerminal && !entry.settled?.provenTerminal)
        return false;
      if (options.coveredObservation && !entry.settled?.coveredObservation)
        return false;
      return true;
    };
    const match =
      entries.find((entry) => compatible(entry) && entry.limit === limit) ??
      entries.find((entry) => {
        if (!compatible(entry)) return false;
        if (
          limit !== undefined &&
          entry.limit !== undefined &&
          entry.limit >= limit
        )
          return true;
        const page =
          entry.settled?.state === "ok" ? entry.settled.value : undefined;
        return Boolean(
          page &&
            page.hasOlder === false &&
            !page.gap &&
            !page.staleCursor &&
            !page.reset,
        );
      });
    if (match) return match.promise;
    const exhausted = this.timelineBudgetExhausted.get(hostKey);
    if (exhausted)
      return Promise.resolve({
        state: "unknown",
        reason: exhausted,
        fromPassSnapshot: true,
      });
    if (this.sealedHosts.has(hostKey) && !options.allowMissFetch) {
      return Promise.resolve({
        state: "unknown",
        reason:
          "agent timeline page was not captured in this host pass; waiting for the next pass",
        fromPassSnapshot: true,
      });
    }
    const entry: CachedTimelinePageEntry = {
      limit,
      promise: Promise.resolve({
        state: "unknown",
        reason: "pending",
        fromPassSnapshot: true,
      }),
    };
    const promise = run(false).then(
      (settled) => {
        const cached: PassTimelinePageRead = {
          ...settled,
          fromPassSnapshot: true,
        };
        entry.settled = cached;
        return settled;
      },
      (error) => {
        const list = this.timelinePageReads.get(agentKey);
        if (list) {
          const next = list.filter((item) => item !== entry);
          if (next.length) this.timelinePageReads.set(agentKey, next);
          else this.timelinePageReads.delete(agentKey);
        }
        throw error;
      },
    );
    entry.promise = promise.then((settled) => ({
      ...settled,
      fromPassSnapshot: true,
    }));
    void entry.promise.catch(() => {});
    if (options.coveredObservation || options.provenTerminal)
      entries.unshift(entry);
    else entries.push(entry);
    this.timelinePageReads.set(agentKey, entries);
    return promise;
  }
}
