/**
 * The runtime's health projection: the facts an operator or the bridge reads to
 * decide whether this process is serving, and what it does not know.
 *
 * It owns presentation, not behaviour: reads go to the owners that hold the
 * fact (store, board, admission, event-loop monitor, endpoint), and every
 * answer that is genuinely unknown is typed and named rather than reported as
 * empty or null-as-absent (blind calibration #1263 of
 * `service/runtime-owner.ts`).
 */
import type { HookCleanupHealth } from "../core/hooks/hook-cleanup";
import type { HostRunOutputFailureSummary } from "../core/host-runs/host-run-output-failures";
import type { Admission } from "../core/host/admission";
import type { HostRegistry } from "../core/host/host-registry";
import type { Engine } from "../core/engine";
import { phaseLatency } from "../core/scheduling/phase-latency";
import { mergeFenced } from "../shared/contracts";
import { hostKindOf } from "../shared/host-kind";
import type { BbHostStatus } from "./bb-host";
import type { BbPluginRollRecord } from "../shared/bb-plugin-roll";
import type { CapacityChangeJournal } from "../core/dispatch/capacity-changes";
import type { AdmissionRpcMetrics } from "../core/qa/effigy-admission-metrics";
import type {
  EventLoopDelayMonitor,
  EventLoopDelayReport,
} from "../core/telemetry/event-loop-delay";
import type { Store } from "../core/store/store";
import type { BoundRun } from "../shared/contracts";
import { threadRetentionHealth } from "../core/workspaces/thread-retention";
import type { ThreadRetentionHealth } from "../core/workspaces/thread-retention";
import type { HostAdmission, ReconciliationSweep } from "../shared/telemetry";
import type { HostRunEndpoint } from "./callbacks/host-run-endpoint";
import type { RegisteredHost } from "./host-connections";
import type {
  RuntimeLifecycle,
  HostIdentityConflict,
  RuntimePhase,
} from "./runtime-lifecycle";
import type { PrStateFacts } from "./runtime-pr-states";
import type { StoreMaintenance } from "./store-maintenance";
import type { T3HostConnection } from "./t3code-host";

/** One host's presented state. `conflict` comes from a typed fact, never from error text. */
export interface HostHealth {
  id: string;
  state: "online" | "offline" | "conflict" | "unknown";
  reason: string;
}

/**
 * The retained-output failure set as the endpoint reports it. A set this
 * process could not read stays `unknown` with its reason: publishing null would
 * read as "nothing unresolved" (blind calibration #1263).
 */
export interface RetentionFailureEvidence {
  state: "clear" | "unresolved" | "unknown";
  /** The bounded summary when the set is unresolved; null otherwise. */
  summary: HostRunOutputFailureSummary | null;
  /** Why the set is unknown; null otherwise. */
  reason: string | null;
}

export interface RuntimeHealth {
  phase: RuntimePhase;
  ready: boolean;
  startError: string;
  /** Set while the plugin's presence is lost and a host is still connected; empty otherwise. */
  pluginPresenceError?: string;
  engineError: string;
  retentionError: string;
  /**
   * Orchestration contract, "Archived thread retention": the window in force and
   * each host's last pass (when, how many removed, how many remain, and any
   * failure), so a pass that stops running cannot go stale silently. Null before
   * the first pass of this store.
   */
  threadRetention?: ThreadRetentionHealth | null;
  /** Why the last retention pass could not run at all; empty when it did. */
  threadRetentionError?: string;
  hookCleanup?: HookCleanupHealth | null;
  paused: boolean;
  drained: boolean;
  boundRuns: BoundRun[];
  hostId: string;
  connected: boolean;
  hosts?: HostHealth[];
  /**
   * A typed conflict between the configured daemon and the recorded host. Health
   * reads this fact instead of matching `startError` text; null when none is
   * observed, or once a refresh settles it.
   */
  hostIdentityConflict: HostIdentityConflict | null;
  t3code?: ReturnType<T3HostConnection["status"]>;
  /**
   * Spec 062 phase 1: the BB host's registered identity, the version diagnostics its
   * executor announced, its heartbeat and — while it is offline — the field that refused it.
   */
  bb?: BbHostStatus;
  /**
   * The BB plugin step the last landed roll ran (nucleus#1339), read from its
   * owner-only record beside the roll record: a failed install names its cause
   * here, so health reports it without reading the roll prose. Absent before any
   * landed roll has run the step, and on a machine the step left alone.
   */
  bbPlugin?: BbPluginRollRecord;
  schema: number | null;
  lastStoreAccessAt: string | null;
  taskIdentities: number;
  /** Queue-observed outbound Paseo admission: depth, coalescing, waits and backpressure. */
  admission: HostAdmission;
  /** Durable cursor evidence for the bounded safety sweep. */
  reconciliation: ReconciliationSweep;
  /** Task facts that have waited over 30 seconds for a Nucleus lane. */
  slowPhaseWaits?: {
    taskId: string;
    reference: string | null;
    since: string;
    cause: string;
    elapsedMs: number;
  }[];
  /**
   * Whether the post-connect bootstrap is pending and since when. A bootstrap that
   * hangs is otherwise invisible: health reported ready throughout the wedge that
   * stopped reconciliation for thirteen minutes.
   */
  bootstrap: { pending: boolean; startedAt: string | null };
  /**
   * The display-only PR-state read: an unknown read names its reason and keeps
   * the last successful map's age, instead of presenting an empty map.
   */
  prStateRead: PrStateFacts;
  /** Event-loop delay of the runtime thread, which serves the host-run endpoint and every store read. */
  eventLoop: EventLoopDelayReport;
  /**
   * Contract-010 endpoint state. The process serving `queue-service.sock` must
   * always serve the host-run endpoint or report itself unhealthy (2026-10-04,
   * a roll fallback that left it unbound machine-wide).
   */
  hostRunEndpoint: {
    serving: boolean;
    error: string;
    heavyFollowers: number;
    retentionError?: string;
    /**
     * Unresolved retained-output expiries: the exact durable total, its sighting
     * window and a bounded named sample, or the reason the set is unknown. A
     * truncated summary names how many more rows it withheld; the count is
     * always the stored size (task 444). Null only when this process does not
     * serve the endpoint at all.
     */
    retentionFailures?: RetentionFailureEvidence | null;
  } | null;
  /** Settings-only capacity writes: the applied-change record's compact state; the full read is `queue.capacity-state`. */
  capacityAuthority?: {
    changes: number;
    lastChangeAt: string | null;
    lastSurface: string | null;
  };
  /**
   * Bounded admission RPC metrics (Spec 035, "Admission RPC metrics"): the
   * service's own dispatch latency, reply delivery and the intervals between
   * confirms it processed, so a late still-queued confirm can be diagnosed from
   * health instead of a journal scan. Memory-only; `serving` is the admission
   * socket's own truth, and the field is null when this process does not serve
   * that socket at all.
   */
  admissionRpc?: (AdmissionRpcMetrics & { serving: boolean }) | null;
  /**
   * Whether live-run terminal/label presence projection is active, or why it is
   * inactive (for example when no connected host exposes a native terminal/label
   * presence surface). Never silently omitted.
   */
  liveRunPresence?: {
    active: boolean;
    reason: string;
    unsupportedHosts?: string[];
  };
  /**
   * Spec 028: the store's compaction facts and the last durable maintenance record.
   * `autoVacuum` is 0 until the one-shot conversion lands, so a store that never
   * converted says so here instead of being silently unable to return freed pages.
   * `state` distinguishes a positively verified conversion (`converted`) from a rewrite
   * that is in the store but was never verified (`landed`) and from an attempt that did
   * not land (`refused`/`failed`), so health can never read a landed rewrite as verified.
   */
  storeCompaction?: {
    autoVacuum: number;
    freePages: number;
    fileBytes: number;
    state: "running" | "converted" | "landed" | "refused" | "failed" | null;
    attempts: number;
    reason: string | null;
    at: string | null;
    verification?: "verified" | "changed" | "not-run" | null;
    fingerprint?: string | null;
    settledFrom?: "running" | "landed" | "refused" | "failed" | null;
  };
}

/** The owners health reads and the runtime's own answers it needs. */
export interface RuntimeHealthContext {
  readonly store: Store;
  readonly engine: Engine;
  readonly lifecycle: RuntimeLifecycle;
  readonly hostRegistry: HostRegistry<RegisteredHost>;
  readonly t3Host: () => T3HostConnection | null;
  /** The BB host's registration, identity and heartbeat (Spec 062, phase 1). */
  bb(): BbHostStatus;
  /** The last landed roll's BB plugin step (nucleus#1339), or null before one ran. */
  bbPluginRoll?: () => BbPluginRollRecord | null;
  readonly admission: Admission;
  readonly capacityChanges: CapacityChangeJournal;
  readonly maintenance: StoreMaintenance;
  readonly eventLoopDelay: EventLoopDelayMonitor;
  /** The host seam's fleet answer; the same call readiness uses. */
  anyHostConnected(): boolean;
  /** The board's drain projection: whether this runtime is drained and its bound runs. */
  drainProjection(): { drained: boolean; boundRuns: BoundRun[] };
  /** Set while the plugin's presence is lost and a host is still connected. */
  pluginPresenceFaultMessage(): string;
  /** Whether the live-run presence projection is active, or why it is inactive. */
  liveRunPresenceStatus?: () => {
    active: boolean;
    reason: string;
    unsupportedHosts?: string[];
  };
  /** The claimed primary session's host id, when one is claimed. */
  hostSessionId(): string | null;
  readonly serveHostRunEndpoint: boolean;
  /** The endpoint this process owns, or null before it is bound or when disabled. */
  hostRunEndpoint(): HostRunEndpoint | null;
  /** Why the host-run endpoint is not serving; empty while it serves or when disabled. */
  hostRunEndpointError(): string;
  /** The admission socket's own RPC metrics, when this process serves it. */
  admissionRpcMetrics(): (AdmissionRpcMetrics & { serving: boolean }) | null;
}

/** The facts the host projection reads; typed so a conflict never has to be inferred from text. */
export interface HostStateFacts {
  known: ReadonlyArray<{ id: string }>;
  online(id: string): boolean;
  /**
   * The Paseo entry's id, the one host the legacy unqualified facts belong to. It is
   * never "whichever host registered first": a secondary host (a BB plugin can connect
   * before the daemon bootstrap) must not be presented as the primary.
   */
  primaryId: string | null;
  /** Why the BB host is offline; health names the field that refused it. */
  bbOfflineReason?: string;
  /** The secondary host's own status, when this runtime runs a T3 session. */
  t3:
    | { id: string | null; error: string; threadShapePending: boolean }
    | undefined;
  identityConflict: HostIdentityConflict | null;
  startError: string;
  /**
   * The primary host's own connect fault (nucleus#1449). It is that host's reason,
   * never the board's: a live secondary host owns readiness while the primary is
   * offline, and its work waits for it.
   */
  primaryFault?: string | null;
}

/**
 * Present each known host. A host is `conflict` only when the typed fact names
 * it; an unattributed conflict stays in `hostIdentityConflict` rather than being
 * guessed onto a host, and `startError` is display text only.
 */
export function projectHostStates(facts: HostStateFacts): HostHealth[] {
  const { known, t3, identityConflict, startError, primaryId, primaryFault } =
    facts;
  if (!known.length)
    return [
      {
        id: "unknown",
        state: "unknown",
        reason: startError || "Host identity is unknown",
      },
    ];
  return known.map((host) => {
    if (facts.online(host.id)) {
      return {
        id: host.id,
        state: "online",
        reason:
          host.id === t3?.id && t3.threadShapePending
            ? "thread shape pending first thread"
            : "",
      };
    }
    return {
      id: host.id,
      state: identityConflict?.hostId === host.id ? "conflict" : "offline",
      reason:
        host.id === t3?.id
          ? t3.error || "T3Code is offline"
          : host.id === primaryId
            ? primaryFault || startError || "Host is offline"
            : hostKindOf(host.id) === "bb"
              ? facts.bbOfflineReason || "BB plugin is not connected"
              : "Host is offline",
    };
  });
}

/**
 * Read the endpoint's retained-output failure set. A read that throws is
 * `unknown` with its reason, never a null that reads as an all-clear; null is
 * reserved for "this process does not serve the endpoint".
 */
export function retentionFailureEvidence(
  endpoint: { retentionFailureSummary(): HostRunOutputFailureSummary } | null,
): RetentionFailureEvidence | null {
  if (!endpoint) return null;
  try {
    const summary = endpoint.retentionFailureSummary();
    return summary.count > 0 || summary.unreadable !== undefined
      ? { state: "unresolved", summary, reason: null }
      : { state: "clear", summary: null, reason: null };
  } catch (error) {
    return {
      state: "unknown",
      summary: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Only facts queued for a Nucleus lane are waits here; external work is not. */
export function slowPhaseWaits(
  store: Store,
  at = Date.now(),
): NonNullable<RuntimeHealth["slowPhaseWaits"]> {
  return store
    .maintenanceTasks()
    .flatMap((task) => {
      const pending = phaseLatency(store, task.id).pending;
      const integrationWait = ["verifying", "merging"].includes(task.phase);
      const integrationHeld =
        integrationWait &&
        mergeFenced(task) &&
        !task.resolution.mergeIntent &&
        !task.resolution.mergedCommit;
      const unreleasedCallback = (key: string) =>
        key.startsWith("callback:") &&
        store
          .runs(task.id)
          .some(
            (run) =>
              !run.released &&
              run.completion?.eventId === key.slice("callback:".length),
          );
      return pending
        .filter((wait) => {
          if (integrationHeld && !unreleasedCallback(wait.key)) return false;
          if (!wait.key.startsWith("callback:")) return true;
          const eventId = wait.key.slice("callback:".length);
          const run = store
            .runs(task.id)
            .find(
              (item) => item.completion?.eventId === eventId && !item.released,
            );
          return !(
            run?.active &&
            run.lastObservedAt &&
            Date.parse(run.lastObservedAt) >= Date.parse(wait.since) &&
            at - Date.parse(run.lastObservedAt) < 16_000
          );
        })
        .map((wait) => {
          // A released operator fence starts a new admission opportunity; do not
          // attribute the preceding external wait to Nucleus after it is lifted.
          const released =
            integrationWait && !unreleasedCallback(wait.key)
              ? store
                  .eventsAll(task.id)
                  .filter(
                    (event) =>
                      (["merge_release", "release"].includes(event.kind) ||
                        (event.kind === "hold_auto_released" &&
                          /^(merge|dispatch);/.test(event.detail))) &&
                      Date.parse(event.at) > Date.parse(wait.since) &&
                      Date.parse(event.at) <= at,
                  )
                  .at(-1)
              : undefined;
          const since = released?.at ?? wait.since;
          return {
            taskId: task.id,
            reference: task.reference ?? null,
            since,
            cause: wait.cause,
            elapsedMs: Math.max(0, at - Date.parse(since)),
          };
        })
        .filter((wait) => wait.elapsedMs > 30_000);
    })
    .sort((a, b) => b.elapsedMs - a.elapsedMs);
}

export class RuntimeHealthProjection {
  private readonly context: RuntimeHealthContext;

  constructor(context: RuntimeHealthContext) {
    this.context = context;
  }

  /**
   * Each known host's presented state: the one projection `service.health`'s
   * `hosts` and Settings → Hosts (`host.list`) both read, so they never disagree.
   */
  hostStates(
    t3 = this.context.t3Host()?.status(),
    bb = this.context.bb(),
  ): HostHealth[] {
    const { hostRegistry, lifecycle } = this.context;
    return projectHostStates({
      known: hostRegistry.known(),
      online: (id) => Boolean(hostRegistry.get(id)),
      primaryId: hostRegistry.legacyPaseoPrimary()?.id ?? null,
      bbOfflineReason: bb.offlineReason,
      t3: t3
        ? {
            id: t3.id,
            error: t3.error,
            threadShapePending: t3.threadShapePending,
          }
        : undefined,
      identityConflict: lifecycle.identityConflict,
      startError: lifecycle.startError,
      primaryFault: lifecycle.primaryFault?.message ?? null,
    });
  }

  health(): RuntimeHealth {
    const { store, hostRegistry, lifecycle } = this.context;
    const t3 = this.context.t3Host()?.status();
    const bb = this.context.bb();
    const bbPlugin = this.context.bbPluginRoll?.() ?? null;
    const endpoint = this.context.hostRunEndpoint();
    return {
      phase: lifecycle.phase,
      ready: lifecycle.ready,
      startError: lifecycle.startError,
      pluginPresenceError:
        this.context.pluginPresenceFaultMessage() || undefined,
      engineError: store.getMeta<string>("engineError") ?? "",
      retentionError: store.getMeta<string>("retentionError") ?? "",
      threadRetention: threadRetentionHealth(store),
      threadRetentionError: store.getMeta<string>("threadRetentionError") ?? "",
      hookCleanup: store.getMeta<HookCleanupHealth>("hookCleanup") ?? null,
      paused: store.getMeta<boolean>("paused") ?? true,
      ...this.context.drainProjection(),
      hostId:
        this.context.hostSessionId() ||
        hostRegistry.legacyPaseoPrimary()?.id ||
        hostRegistry.onlineIds()[0] ||
        hostRegistry.known()[0]?.id ||
        "unknown",
      connected: this.context.anyHostConnected(),
      hostIdentityConflict: lifecycle.identityConflict,
      ...(t3 ? { t3code: t3 } : {}),
      ...(bb.hosts.length || bb.offlineReason || bb.lastRefusal ? { bb } : {}),
      ...(bbPlugin ? { bbPlugin } : {}),
      hosts: this.hostStates(t3, bb),
      bootstrap: {
        pending: Boolean(lifecycle.bootstrapRunning),
        startedAt: lifecycle.bootstrapStartedAt,
      },
      prStateRead: lifecycle.prStateFacts(),
      hostRunEndpoint: this.context.serveHostRunEndpoint
        ? {
            serving: endpoint?.serving() ?? false,
            error: this.context.hostRunEndpointError(),
            heavyFollowers: endpoint?.heavyFollowerCount() ?? 0,
            retentionError: endpoint?.retentionError() ?? "",
            retentionFailures: retentionFailureEvidence(endpoint),
          }
        : null,
      schema: store.getMeta<number>("schema") ?? null,
      lastStoreAccessAt: lifecycle.lastStoreAccessAt,
      taskIdentities: store.countTasks(),
      admission: this.context.admission.snapshot(),
      admissionRpc: this.context.serveHostRunEndpoint
        ? this.context.admissionRpcMetrics()
        : null,
      reconciliation: this.context.engine.reconciliationSnapshot(),
      slowPhaseWaits: slowPhaseWaits(store),
      eventLoop: this.context.eventLoopDelay.report(),
      capacityAuthority: (() => {
        const state = this.context.capacityChanges.state();
        const last = state.changes.at(-1) ?? null;
        return {
          changes: state.changes.length,
          lastChangeAt: last?.at ?? null,
          lastSurface: last?.surface ?? null,
        };
      })(),
      ...(this.context.liveRunPresenceStatus
        ? { liveRunPresence: this.context.liveRunPresenceStatus() }
        : {}),
      storeCompaction: this.context.maintenance.compactionHealth(),
    };
  }
}
