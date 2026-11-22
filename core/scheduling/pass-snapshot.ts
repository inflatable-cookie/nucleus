import type { HostTimelineEntry, HostTimelinePage } from "../../shared/host";
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

/** Typed result of one bounded read: either the observed value or `unknown` on timeout. */
export type BoundedReadResult<T> =
  | { state: "ok"; value: T }
  | { state: "unknown"; reason: string };

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
  private readonly processReads = new Map<
    string,
    Promise<HostProcessListRead>
  >();
  private readonly timelineReads = new Map<
    string,
    Promise<BoundedReadResult<HostTimelineEntry[] | null>>
  >();
  private readonly timelinePageReads = new Map<
    string,
    Promise<BoundedReadResult<HostTimelinePage | null>>
  >();

  /** True only while the owning sweep pass is still running. */
  get active(): boolean {
    return this.isActive;
  }

  /** End this pass's validity window and drop all cached observations. */
  expire(): void {
    this.isActive = false;
    this.processReads.clear();
    this.timelineReads.clear();
    this.timelinePageReads.clear();
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
  ): Promise<HostProcessListRead> {
    const run = (): Promise<HostProcessListRead> =>
      boundedRead("host process listing", read, deadlineMs).then(
        (result) =>
          result.state === "ok"
            ? result.value
            : { state: "unknown", reason: result.reason },
        (error) => ({
          state: "unknown",
          reason: `host process listing failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    if (!this.isActive) return run();
    const key = hostKeyOf(hostId);
    const existing = this.processReads.get(key);
    if (existing) return existing;
    const promise = run();
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
    const key = `${hostKeyOf(hostId)}\0${agentId}\0${limit ?? ""}`;
    const existing = this.timelineReads.get(key);
    if (existing) return existing;
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
   * Transport/refusal errors are evicted on rejection rather than cached.
   */
  timelinePage(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    read: () => Promise<HostTimelinePage | null>,
    deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
  ): Promise<BoundedReadResult<HostTimelinePage | null>> {
    const run = () => boundedRead("agent timeline page", read, deadlineMs);
    if (!this.isActive) return run();
    const key = `${hostKeyOf(hostId)}\0${agentId}\0${limit ?? ""}`;
    const existing = this.timelinePageReads.get(key);
    if (existing) return existing;
    const promise = run().catch((error) => {
      if (this.timelinePageReads.get(key) === promise)
        this.timelinePageReads.delete(key);
      throw error;
    });
    this.timelinePageReads.set(key, promise);
    return promise;
  }
}
