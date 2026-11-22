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

/** Proof that a cached timeline page was captured after the agent was terminal in its workspace. */
export type ProvenTerminalSnapshot = {
  archived: boolean;
  workspaceId: string;
};

/** Timeline-page read annotated with snapshot provenance and terminal proof. */
export type PassTimelinePageRead =
  BoundedReadResult<HostTimelinePage | null> & {
    fromPassSnapshot: boolean;
    provenTerminal?: ProvenTerminalSnapshot;
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
  const pending = Promise.resolve().then(work);
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
 * Process-table and timeline reads collected during a host pass (or coalesced
 * on first demand within that pass) are shared across every task quantum in
 * that pass for the same host. The pass expires the snapshot when it finishes,
 * so a later pass or an out-of-pass quantum never reads stale data.
 */
export class PassSnapshot {
  private isActive = true;
  private readonly hostInventories = new Map<
    string,
    ReadonlyMap<string, HostObservation>
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
    this.hostInventories.set(hostKeyOf(hostId), inventory);
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
   * Transport/refusal errors are not cached as values: if the underlying read
   * rejects before the deadline, the entry is evicted so a caller's own error
   * classification sees it.
   */
  timeline(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    read: () => Promise<HostTimelineEntry[] | null>,
    deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
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
    const promise = run().catch((error) => {
      if (this.timelineReads.get(key) === promise)
        this.timelineReads.delete(key);
      throw error;
    });
    this.timelineReads.set(key, promise);
    return promise;
  }

  /**
   * Read or share one agent's bounded timeline page snapshot for this pass.
   * A cached page for the same `(host, agentId)` covers a request when either
   * its limit matches, its settled page is complete (`hasOlder === false`, no
   * gap/reset/staleCursor), or its limit is at least as wide as requested.
   * Transport/refusal errors are evicted on rejection rather than cached.
   */
  timelinePage(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    read: () => Promise<HostTimelinePage | null>,
    deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
    options: { provenTerminal?: ProvenTerminalSnapshot } = {},
  ): Promise<PassTimelinePageRead> {
    const run = (fromPassSnapshot: boolean): Promise<PassTimelinePageRead> =>
      boundedRead("agent timeline page", read, deadlineMs).then((result) => ({
        ...result,
        fromPassSnapshot,
        ...(options.provenTerminal
          ? { provenTerminal: options.provenTerminal }
          : {}),
      }));
    if (!this.isActive) return run(false);
    const hostKey = hostKeyOf(hostId);
    const agentKey = `${hostKey}\0${agentId}`;
    const entries = this.timelinePageReads.get(agentKey) ?? [];
    // Reuse a matching or wider/complete cached page for the same agent in this pass.
    // When the caller supplies a terminal proof (e.g. HostPass warming after proving
    // closure), only reuse an entry that already carries a terminal proof so we never
    // mask a post-closure page behind an earlier pre-closure one.
    const match = entries.find((entry) => {
      if (options.provenTerminal && !entry.settled?.provenTerminal)
        return false;
      if (entry.limit === limit) return true;
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
    const entry: CachedTimelinePageEntry = {
      limit,
      promise: Promise.resolve({
        state: "unknown",
        reason: "pending",
        fromPassSnapshot: true,
      }),
    };
    const promise = run(true).then(
      (settled) => {
        entry.settled = settled;
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
    entry.promise = promise;
    entries.push(entry);
    this.timelinePageReads.set(agentKey, entries);
    return promise;
  }
}
