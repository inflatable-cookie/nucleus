import { AsyncLocalStorage } from "node:async_hooks";
import type {
  HostObservation,
  HostTimelineEntry,
  HostTimelinePage,
} from "../../shared/host";
import type { HostProcessListRead } from "../machine/host-process-listing";
import type { ObservedTurnState } from "../recovery/stall";

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
 * Default total read-phase budget for one task quantum (Spec 068 §6).
 * Caps the cumulative time spent on serial participant observations and nested
 * reads inside a single quantum well inside the 120 s task-lane bound.
 */
export const QUANTUM_TOTAL_READ_BUDGET_MS = 30_000;

/**
 * Shared read-phase scope carried across one exclusive task quantum (`task:<id>`).
 * Every `boundedRead` inside the quantum shares `deadlineAt`, and expensive
 * reads use pass snapshots. A custody check may use a bounded direct process
 * listing when the pass did not capture one.
 */
export interface TaskQuantumReadScope {
  readonly deadlineAt: number;
  readonly inTaskQuantum: boolean;
  readonly snapshot?: PassSnapshot;
}

const quantumReadScope = new AsyncLocalStorage<
  TaskQuantumReadScope | undefined
>();

/**
 * Execute `work` inside one task quantum's shared read-phase scope.
 * Re-entrant by default: if already inside a quantum scope, preserves the
 * outer deadline unless `fresh: true` starts a brand-new quantum scope.
 */
export function runInTaskQuantumScope<T>(
  budgetMs: number,
  work: () => Promise<T>,
  snapshot?: PassSnapshot,
  fresh = false,
): Promise<T> {
  const existing = fresh ? undefined : quantumReadScope.getStore();
  if (existing) {
    if (snapshot && !existing.snapshot) {
      return quantumReadScope.run({ ...existing, snapshot }, work);
    }
    return work();
  }
  return quantumReadScope.run(
    {
      deadlineAt: Date.now() + Math.max(0, budgetMs),
      inTaskQuantum: true,
      ...(snapshot ? { snapshot } : {}),
    },
    work,
  );
}

/** Exit any inherited task-quantum scope (e.g. for host-side wake prefetch). */
export function runOutsideTaskQuantumScope<T>(work: () => T): T {
  return quantumReadScope.run(undefined, work);
}

/** The active task quantum's read scope, or undefined outside a task quantum. */
export function currentTaskQuantumScope(): TaskQuantumReadScope | undefined {
  return quantumReadScope.getStore();
}

/**
 * Typed unknown/deferred error thrown at the host/forge boundary when a call
 * inside a task quantum outlives the quantum's remaining deadline (Spec 068 §6,
 * Spec 066 R1). Decisions treat this as unknown and defer: durable intents stay
 * intact, nothing is settled as absent or clear, and no stop is recorded.
 */
export class QuantumDeadlineExceededError extends Error {
  readonly label: string;
  readonly unknown = true as const;
  /** True when the quantum budget was already spent before the native call started. */
  readonly preSend: boolean;
  constructor(label: string, detail?: string, preSend = false) {
    super(detail ?? `${label} deferred: task quantum deadline exceeded`);
    this.name = "QuantumDeadlineExceededError";
    this.label = label;
    this.preSend = preSend;
  }
}

export function isQuantumDeadlineExceeded(
  error: unknown,
): error is QuantumDeadlineExceededError {
  return (
    error instanceof QuantumDeadlineExceededError ||
    (error instanceof Error && error.name === "QuantumDeadlineExceededError")
  );
}

/**
 * Typed sentinel thrown by pass-snapshot-backed timeline adapters when a
 * timeline page was not captured in the host pass, exceeded its pass budget,
 * or timed out inside `PassSnapshot`. Consumers carry this as a typed
 * `deferred` result instead of re-deriving deferral from error text.
 */
export class DeferredPassReadError extends Error {
  readonly unknown = true as const;
  constructor(reason: string) {
    super(reason);
    this.name = "DeferredPassReadError";
  }
}

/**
 * Check whether the active task quantum's deadline is already expired BEFORE
 * invoking a native host/forge call. Returns a pre-send
 * `QuantumDeadlineExceededError` when expired, or `null` when time remains or
 * outside a task quantum.
 */
export function expiredQuantumDeadlineError(
  label: string,
): QuantumDeadlineExceededError | null {
  const scope = quantumReadScope.getStore();
  if (!scope?.inTaskQuantum) return null;
  if (scope.deadlineAt - Date.now() <= 0) {
    return new QuantumDeadlineExceededError(
      label,
      `${label} deferred before send: task quantum deadline exceeded`,
      true,
    );
  }
  return null;
}

/**
 * Enforce the active task quantum's deadline lazily at a single boundary choke
 * point (routing proxy / host facade). If the quantum budget is already spent,
 * rejects with a pre-send `QuantumDeadlineExceededError` WITHOUT invoking
 * `invoke()`. Otherwise invokes `invoke()` and races it against the remaining
 * budget, rejecting with a post-send `QuantumDeadlineExceededError` on expiry.
 */
export function runUnderQuantumDeadline<T>(
  label: string,
  invoke: () => Promise<T>,
): Promise<T> {
  const expired = expiredQuantumDeadlineError(label);
  if (expired) return Promise.reject(expired);
  let promise: Promise<T>;
  try {
    promise = invoke();
  } catch (error) {
    return Promise.reject(error);
  }
  return raceQuantumDeadline(label, promise);
}

/**
 * Race an already-started promise against the active task quantum's remaining
 * deadline. Callers at host/forge boundaries should prefer
 * `runUnderQuantumDeadline` so expired scopes never start the native call.
 */
export function raceQuantumDeadline<T>(
  label: string,
  promise: Promise<T>,
): Promise<T> {
  const scope = quantumReadScope.getStore();
  if (!scope?.inTaskQuantum) return promise;
  const remaining = scope.deadlineAt - Date.now();
  if (remaining <= 0) {
    promise.catch(() => {});
    return Promise.reject(
      new QuantumDeadlineExceededError(
        label,
        `${label} deferred: task quantum deadline exceeded`,
        false,
      ),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  promise.catch(() => {
    /* swallow late rejection after quantum deadline expiry */
  });
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(
        new QuantumDeadlineExceededError(
          label,
          `${label} deferred: task quantum deadline exceeded (${remaining} ms remaining)`,
          false,
        ),
      );
    }, remaining);
    timer.unref?.();
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        if (!expired) resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        if (!expired) reject(error);
      },
    );
  });
}

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
  /** True when the listing was deferred (quantum deadline/timeout or uncaptured pass snapshot). */
  deferred?: boolean;
  /** No listing was attempted for this host in the pass. */
  missingFromPass?: true;
  /** Pre-scan evidence for this participant when reusing a direct listing. */
  directBeforeScan?: ObservedTurnState | null;
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

/** A matching observation still needs process proof before it can settle tools. */
export function isTerminalParticipant(
  observation: Partial<
    Pick<
      HostObservation,
      "active" | "activeTurnId" | "permissions" | "status" | "archived"
    >
  > | null | undefined,
): boolean {
  return Boolean(
    observation &&
    observation.active === false &&
    observation.activeTurnId === null &&
    observation.permissions === false &&
    (observation.archived === true ||
      observation.status === "closed" ||
      observation.status === "gone"),
  );
}

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
  const scope = quantumReadScope.getStore();
  let boundMs = Math.max(0, deadlineMs);
  if (scope) {
    const remaining = scope.deadlineAt - Date.now();
    if (remaining <= 0) {
      return {
        state: "unknown",
        reason: `${label} skipped: task quantum read budget exhausted`,
      };
    }
    boundMs = Math.min(boundMs, remaining);
  }
  if (boundMs <= 0) {
    return {
      state: "unknown",
      reason: `${label} timed out after 0 ms`,
    };
  }
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Invoke `work()` synchronously so caller stack frames stay intact and no
  // extra microtask turn sits ahead of the underlying host/process call.
  let pending: Promise<T>;
  try {
    pending = Promise.resolve(work());
  } catch (error) {
    if (isQuantumDeadlineExceeded(error)) {
      return { state: "unknown", reason: error.message };
    }
    return Promise.reject(error);
  }
  // Prevent a late rejection after the deadline has already settled from
  // escaping as an unhandled rejection.
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending.then(
        (value): BoundedReadResult<T> => {
          settled = true;
          return { state: "ok", value };
        },
        (error): BoundedReadResult<T> => {
          if (isQuantumDeadlineExceeded(error)) {
            settled = true;
            return { state: "unknown", reason: error.message };
          }
          throw error;
        },
      ),
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
  private readonly directProcessReads = new Map<string, {
    read: Promise<PassProcessRead>;
    beforeScan: ReadonlyMap<string, ObservedTurnState>;
    invalidated?: true;
  }>();
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
  private readonly completedHostPasses = new Set<string>();

  /** True only while the owning sweep pass is still running. */
  get active(): boolean {
    return this.isActive;
  }

  /** End this pass's validity window and drop all cached observations. */
  expire(): void {
    this.isActive = false;
    this.hostInventories.clear();
    this.processReads.clear();
    this.directProcessReads.clear();
    this.timelineReads.clear();
    this.timelinePageReads.clear();
    this.timelineBudgetExhausted.clear();
    this.sealedHosts.clear();
    this.completedHostPasses.clear();
  }

  /** Actual host passes that finished warming without a host fault. */
  completeHostPass(hostId: string): void {
    if (this.isActive) this.completedHostPasses.add(hostId);
  }

  hostPassCompleted(hostId: string | null | undefined): boolean {
    return Boolean(hostId && this.completedHostPasses.has(hostId));
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
    options: { allowMissFetch?: boolean; cacheOnly?: boolean } = {},
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
                deferred: true,
              },
        (error) => ({
          state: "unknown",
          reason: `host process listing failed: ${error instanceof Error ? error.message : String(error)}`,
          capturedAt,
          fromPassSnapshot,
          ...(isQuantumDeadlineExceeded(error) ? { deferred: true } : {}),
        }),
      );
    };
    if (!this.isActive) return run(false);
    const key = hostKeyOf(hostId);
    const existing = this.processReads.get(key);
    if (existing) return existing;
    if (
      (options.cacheOnly || this.sealedHosts.has(key)) &&
      !options.allowMissFetch
    ) {
      return Promise.resolve({
        state: "unknown",
        reason:
          "host process listing was not captured in this host pass; waiting for the next pass",
        capturedAt: Date.now(),
        fromPassSnapshot: true,
        deferred: true,
        missingFromPass: true,
      });
    }
    const promise = run(true);
    this.processReads.set(key, promise);
    return promise;
  }

  /**
   * Drop one host's cached process table after an in-pass mutation (such as
   * reaping stray task processes) so stale pre-reap process facts are never
   * reused by later tasks in the same pass.
   */
  invalidateProcesses(hostId?: string | null): void {
    const key = hostKeyOf(hostId);
    this.processReads.delete(key);
    const direct = this.directProcessReads.get(key);
    if (direct) direct.invalidated = true;
  }

  /** Share the direct read without lending one participant's inactivity to another. */
  directProcesses(
    hostId: string | null | undefined,
    agentId: string,
    participant: ObservedTurnState | null | undefined,
    read: () => Promise<PassProcessRead>,
  ): Promise<PassProcessRead> {
    if (!this.isActive) return read();
    const key = hostKeyOf(hostId);
    const cached = this.directProcessReads.get(key);
    if (cached)
      return cached.read.then((scan): PassProcessRead => {
        if (cached.invalidated)
          return {
            state: "unknown",
            reason: "the direct process listing was invalidated; waiting for the next host pass",
            capturedAt: scan.capturedAt,
            fromPassSnapshot: true,
            deferred: true,
          };
        return {
          ...scan,
          fromPassSnapshot: true,
          directBeforeScan: cached.beforeScan.get(agentId) ?? null,
        };
      });
    const beforeScan = new Map<string, ObservedTurnState>(this.hostInventories.get(key));
    if (participant) beforeScan.set(agentId, participant);
    const listing = read();
    this.directProcessReads.set(key, { read: listing, beforeScan });
    return listing;
  }

  /**
   * Read or share one agent's bounded timeline snapshot for this pass.
   * On a sealed host or in cache-only task-quantum mode, a cache miss returns
   * explicit `unknown` without starting an inline RPC in the task lane.
   */
  timeline(
    hostId: string | null | undefined,
    agentId: string,
    limit: number | undefined,
    read: () => Promise<HostTimelineEntry[] | null>,
    deadlineMs: number = QUANTUM_READ_DEADLINE_MS,
    options: { allowMissFetch?: boolean; cacheOnly?: boolean } = {},
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
    if (
      (options.cacheOnly || this.sealedHosts.has(hostKey)) &&
      !options.allowMissFetch
    ) {
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
      requireCoveredObservation?: boolean;
      allowMissFetch?: boolean;
      cacheOnly?: boolean;
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
      if (options.cacheOnly && entry.settled?.state === "unknown")
        return true;
      if (options.provenTerminal && !entry.settled?.provenTerminal)
        return false;
      if (
        (options.coveredObservation || options.requireCoveredObservation) &&
        !entry.settled?.coveredObservation
      )
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
    if (
      (options.cacheOnly || this.sealedHosts.has(hostKey)) &&
      !options.allowMissFetch
    ) {
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
