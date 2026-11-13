/**
 * Bounded Paseo admission (Contract 007 / Spec 013 "Incremental reconciliation").
 *
 * Queue treats every Paseo SDK read and mutation as a bounded external effect.
 * This module gives each outbound call an explicit admission class, coalesces
 * equivalent in-flight work by identity, caches stable idle observations for a
 * short bounded interval, records Queue-observed latency per class and trips a
 * visible degraded-state circuit breaker when Paseo is slow.
 *
 * The breaker defers new workspace creation and nonessential workspace
 * mutation; it never drops durable Queue intent, never infers success from a
 * timeout and never lengthens an RPC window to hide pressure. See
 * `docs/knowledge/contracts/service-boundary.md`.
 */
import { createHash } from "node:crypto";
import type { Adapter } from "./adapter";
import { isTransportFailure } from "../../shared/transport";
import { withPaseoCallTiming, type PaseoCallRecorder } from "../../shared/host-call-timing";
import { DEFAULT_GLOBAL_LIMIT } from "../../shared/contracts";
import {
  type AdmissionClass, type PaseoAdmission,
} from "../../shared/telemetry";

export interface AdmissionOptions {
  /** Per-class concurrency bounds; defaults keep callbacks and controls ahead of observation and cleanup. */
  limits?: Partial<Record<AdmissionClass, number>>;
  /** Total in-flight bound across every class. A function is read live, so an operator change applies without a restart. */
  totalLimit?: number | (() => number);
  /** Minimum delay between starts across all Paseo calls. */
  startIntervalMs?: number;
  /** Stable-idle observation cache window; defaults to two seconds. */
  observationCacheMs?: number;
  /** Latency samples retained per class. */
  latencyWindow?: number;
  /** Queue-observed latency at or above this counts as a slow sample. */
  degradedLatencyMs?: number;
  /** Consecutive healthy samples required to clear degraded admission. */
  degradedExitSamples?: number;
  /** Quiet period after slow work settles before successful probes may clear pressure. */
  degradedCooldownMs?: number;
  /** Queue-owned nonterminal workspaces admitted before new creation waits. */
  workspaceBudget?: number | (() => number);
  now?: () => number;
}

export const CLEANUP_CONCURRENCY = 4;
const DEFAULT_LIMITS: Record<AdmissionClass, number> = {
  callback: 4, control: 2, observation: 2, title: 1, cleanup: CLEANUP_CONCURRENCY, inventory: 1, workspace: 1,
};
const PRIORITY: Record<AdmissionClass, number> = {
  callback: 0, control: 1, workspace: 2, observation: 3, inventory: 4, title: 5, cleanup: 6,
};
/** Classes whose slowness degrades Paseo: observation, workspace mutation, titles and cleanup. */
const CRITICAL: readonly AdmissionClass[] = ["observation", "workspace", "title", "cleanup", "inventory"];
const SLOW_WINDOW_MS = 60_000;
const SLOW_TRIP_SAMPLES = 3;

/** Typed refusal the engine converts into "wait and retry", never operator attention. */
export class AdmissionDeferred extends Error {
  constructor(readonly code: "backpressure" | "workspace_budget", message: string) { super(message); }
}
/** Prefix of a breaker deferral, as stored in a durable retry record's reason. */
export const BACKPRESSURE_DEFERRAL = "Paseo admission backpressure: ";
/** A stored retry reason that records only a breaker deferral: no call reached Paseo. */
export const isBackpressureDeferral = (reason: string | null | undefined) => Boolean(reason?.startsWith(BACKPRESSURE_DEFERRAL));

interface CacheEntry { at: number; value: unknown; workspaceId: string }
/** One pending Paseo request. `breaker` is false for work the breaker never reads as pressure. */
interface ActiveCall { cls: AdmissionClass; started: number; breaker: boolean }
interface SlowSample { cls: AdmissionClass; ms: number; at: number; breaker: boolean }

interface Gate { limit: number; running: number; waiting: ((release: () => void) => void)[]; completed: number; coalesced: number }

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

const unsupportedRequestPart = Symbol("unsupported request identity part");
const functionIdentities = new WeakMap<Function, number>();
let nextFunctionIdentity = 0;

/** Encode every request argument, retaining opaque callback identity without retaining payload text in the admission map. */
function requestIdentityValue(value: unknown, ancestors = new WeakSet<object>()): unknown | typeof unsupportedRequestPart {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "function") {
    let identity = functionIdentities.get(value);
    if (identity === undefined) { identity = ++nextFunctionIdentity; functionIdentities.set(value, identity); }
    return ["function", identity];
  }
  if (typeof value !== "object") return unsupportedRequestPart;
  if (ancestors.has(value)) return unsupportedRequestPart;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? unsupportedRequestPart : ["date", value.toISOString()];

  ancestors.add(value);
  let encoded: unknown | typeof unsupportedRequestPart = undefined;
  if (Array.isArray(value)) {
    const items = value.map(item => requestIdentityValue(item, ancestors));
    encoded = items.includes(unsupportedRequestPart) ? unsupportedRequestPart : ["array", items];
  } else if (value instanceof Set) {
    const items = [...value].map(item => requestIdentityValue(item, ancestors));
    encoded = items.includes(unsupportedRequestPart) ? unsupportedRequestPart
      : ["set", items.map(item => JSON.stringify(item)).sort()];
  } else if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => [requestIdentityValue(key, ancestors), requestIdentityValue(item, ancestors)] as const);
    encoded = entries.some(([key, item]) => key === unsupportedRequestPart || item === unsupportedRequestPart) ? unsupportedRequestPart
      : ["map", entries.map(([key, item]) => JSON.stringify([key, item])).sort()];
  } else {
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (prototype !== Object.prototype && prototype !== null || keys.some(key => typeof key !== "string")) {
      encoded = unsupportedRequestPart;
    } else {
      const record: [string, unknown][] = [];
      for (const key of (keys as string[]).sort()) {
        const item = requestIdentityValue((value as Record<string, unknown>)[key], ancestors);
        if (item === unsupportedRequestPart) { encoded = unsupportedRequestPart; break; }
        record.push([key, item]);
      }
      if (encoded === undefined) encoded = ["object", record];
    }
  }
  ancestors.delete(value);
  return encoded;
}

function requestIdentity(prefix: string, args: unknown[]): string | undefined {
  const value = requestIdentityValue(args);
  if (value === unsupportedRequestPart) return undefined;
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class Admission {
  private readonly gates = new Map<AdmissionClass, Gate>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly notifyTails = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, CacheEntry>();
  private observationEpoch = 0;
  private readonly latencies = new Map<AdmissionClass, number[]>();
  private readonly slowSamples: SlowSample[] = [];
  private totalRunning = 0;
  private readonly totalWaiting: { cls: AdmissionClass; sequence: number; resolve: (release: () => void) => void }[] = [];
  private totalSequence = 0;
  private nextStartAt = 0;
  private totalTimer: NodeJS.Timeout | null = null;
  private degraded = false;
  private degradedSince: string | null = null;
  private degradedReason = "";
  private healthySamples = 0;
  private recoveryAfter = 0;
  private readonly activeCalls = new Set<ActiveCall>();
  private cacheHits = 0;
  private workspaceDeferrals = 0;
  private lifecycleSignals = 0;
  private workspaces = 0;
  private readonly limits: Record<AdmissionClass, number>;
  private readonly totalLimitSource: number | (() => number);
  /**
   * The operator's concurrent-Paseo-call bound. Read on every pump so a saved
   * setting takes effect live; it is the one bound the Settings view owns.
   */
  get totalLimit(): number {
    const value = typeof this.totalLimitSource === "function" ? this.totalLimitSource() : this.totalLimitSource;
    return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
  }
  private readonly startIntervalMs: number;
  private readonly observationCacheMs: number;
  private readonly latencyWindow: number;
  private readonly degradedLatencyMs: number;
  private readonly degradedExitSamples: number;
  private readonly degradedCooldownMs: number;
  private readonly workspaceBudgetSource: number | (() => number);
  get workspaceBudget(): number {
    return typeof this.workspaceBudgetSource === "function" ? this.workspaceBudgetSource() : this.workspaceBudgetSource;
  }
  private readonly now: () => number;

  constructor(options: AdmissionOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.totalLimitSource = options.totalLimit ?? 6;
    this.startIntervalMs = options.startIntervalMs ?? 125;
    this.observationCacheMs = options.observationCacheMs ?? 2_000;
    this.latencyWindow = options.latencyWindow ?? 64;
    this.degradedLatencyMs = options.degradedLatencyMs ?? 10_000;
    this.degradedExitSamples = options.degradedExitSamples ?? 3;
    this.degradedCooldownMs = options.degradedCooldownMs ?? 30_000;
    this.workspaceBudgetSource = options.workspaceBudget ?? DEFAULT_GLOBAL_LIMIT;
    this.now = options.now ?? Date.now;
    for (const cls of Object.keys(this.limits) as AdmissionClass[]) {
      this.gates.set(cls, { limit: this.limits[cls], running: 0, waiting: [], completed: 0, coalesced: 0 });
      this.latencies.set(cls, []);
    }
  }

  /** True while Queue-observed Paseo latency holds admission in degraded state. */
  get degradedNow(): boolean { return this.degraded; }

  private trip(reason: string) {
    if (!this.degraded) this.degradedSince = new Date(this.now()).toISOString();
    this.degraded = true;
    this.degradedReason = reason;
    this.healthySamples = 0;
    this.recoveryAfter = this.now() + this.degradedCooldownMs;
  }

  /**
   * The oldest overdue request. `breakerOnly` restricts it to requests the
   * breaker reads, which is what holds recovery: a workspace archive running
   * for minutes is not evidence that Paseo stopped answering.
   */
  private slowInFlight(breakerOnly = false): ActiveCall | undefined {
    return [...this.activeCalls].find(call => (!breakerOnly || call.breaker) && this.now() - call.started >= this.degradedLatencyMs);
  }

  private recentSlowSamples() {
    const cutoff = this.now() - SLOW_WINDOW_MS;
    while (this.slowSamples.length && this.slowSamples[0]!.at < cutoff) this.slowSamples.shift();
    return this.slowSamples;
  }

  private admitHousekeeping(cls: AdmissionClass) {
    if ((cls === "title" || cls === "cleanup") && this.degradedNow)
      throw new AdmissionDeferred("backpressure", `${BACKPRESSURE_DEFERRAL}${this.degradedReason}`);
  }

  private gate(cls: AdmissionClass): Gate {
    const gate = this.gates.get(cls);
    if (!gate) throw new Error(`Unknown admission class ${cls}`);
    return gate;
  }

  private acquireTotal(cls: AdmissionClass): Promise<() => void> {
    return new Promise<() => void>(resolve => {
      this.totalWaiting.push({ cls, sequence: this.totalSequence++, resolve });
      this.pumpTotal();
    });
  }

  /** Start admitted calls at a bounded rate, favoring delivery over housekeeping. */
  private pumpTotal() {
    if (this.totalTimer || this.totalRunning >= this.totalLimit || !this.totalWaiting.length) return;
    const delay = Math.max(0, this.nextStartAt - this.now());
    if (delay > 0) {
      this.totalTimer = setTimeout(() => { this.totalTimer = null; this.pumpTotal(); }, delay);
      return;
    }
    let selected = 0;
    for (let index = 1; index < this.totalWaiting.length; index++) {
      const candidate = this.totalWaiting[index]!, current = this.totalWaiting[selected]!;
      if (PRIORITY[candidate.cls] < PRIORITY[current.cls] || PRIORITY[candidate.cls] === PRIORITY[current.cls] && candidate.sequence < current.sequence) selected = index;
    }
    const [{ resolve }] = this.totalWaiting.splice(selected, 1);
    this.totalRunning++;
    this.nextStartAt = this.now() + this.startIntervalMs;
    resolve(this.totalRelease());
    this.pumpTotal();
  }

  private totalRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.totalRunning--;
      this.pumpTotal();
    };
  }

  private acquire(cls: AdmissionClass): Promise<() => void> {
    const gate = this.gate(cls);
    if (gate.running < gate.limit) { gate.running++; return Promise.resolve(this.classRelease(gate)); }
    return new Promise<() => void>(resolve => gate.waiting.push(resolve));
  }

  private classRelease(gate: Gate): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = gate.waiting.shift();
      if (next) next(this.classRelease(gate));
      else gate.running--;
    };
  }

  /** Share one in-flight effect for an identical identity instead of requesting it twice. */
  private withKey<T>(cls: AdmissionClass, key: string | undefined, work: () => Promise<T>): Promise<T> {
    if (!key) return work();
    const existing = this.inflight.get(key);
    if (existing) { this.gate(cls).coalesced++; return existing as Promise<T>; }
    const promise = work().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Serialize distinct messages to one retained thread, while identical calls still coalesce above. */
  private orderedNotify<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.notifyTails.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.notifyTails.set(agentId, current);
    void current.finally(() => { if (this.notifyTails.get(agentId) === current) this.notifyTails.delete(agentId); }).catch(() => undefined);
    return current;
  }

  /** Coalesce an identical notification, then admit distinct notifications in target order. */
  notify<T>(agentId: string, requestIdentity: string | undefined, work: () => Promise<T>): Promise<T> {
    return this.withKey("callback", requestIdentity,
      () => this.orderedNotify(agentId, () => this.run("callback", work)));
  }

  /** One Paseo request's latency sample and pending call, settled on every outcome. */
  private async sample<T>(cls: AdmissionClass, request: () => Promise<T>, breaker = true): Promise<T> {
    const call: ActiveCall = { cls, started: this.now(), breaker };
    this.activeCalls.add(call);
    let successful = false;
    try {
      const result = await request();
      successful = true;
      return result;
    } finally {
      this.activeCalls.delete(call);
      this.record(cls, this.now() - call.started, successful, breaker);
    }
  }

  /**
   * Run one bounded admitted effect. `key` names an equivalent identity: a
   * concurrent call with the same key shares this effect rather than doubling it.
   * With `innerTiming`, the effect keeps its gate, slot, key and refusals, but
   * only the Paseo requests inside it are latency samples and pending calls:
   * its own Git and filesystem work is not Paseo latency (Tom, 2026-10-23:
   * "Paseo calls only").
   * With `breakerExempt`, those samples still record latency and still hold
   * their slot and pending state, but the breaker neither trips nor recovers on
   * them: a workspace archive legitimately runs for minutes, so its duration is
   * not evidence about whether Paseo is answering (Tom, 2026-11-05).
   */
  run<T>(cls: AdmissionClass, work: () => Promise<T>, key?: string, options: { innerTiming?: boolean; breakerExempt?: boolean; onWaiting?: () => void; onAdmitted?: (waitMs: number) => void } = {}): Promise<T> {
    const breaker = options.breakerExempt !== true;
    return this.withKey(cls, key, async () => {
      options.onWaiting?.();
      const waitingAt = this.now();
      const releaseClass = await this.acquire(cls);
      const releaseTotal = await this.acquireTotal(cls);
      try {
        options.onAdmitted?.(this.now() - waitingAt);
        // Recheck after waiting for admission. No effect started yet.
        this.admitHousekeeping(cls);
        const call: ActiveCall = { cls, started: this.now(), breaker };
        let open = true;
        // A request started after the effect settles is not this effect's.
        const record: PaseoCallRecorder | undefined = options.innerTiming
          ? request => (open ? this.sample(cls, request, breaker) : request())
          : undefined;
        if (!record) this.activeCalls.add(call);
        let successful = false;
        try {
          const result = await withPaseoCallTiming(record, work);
          successful = true;
          return result;
        } catch (error) {
          if (isTransportFailure(error)) this.trip(`Paseo ${cls} transport is unavailable`);
          throw error;
        } finally {
          open = false;
          this.gate(cls).completed++;
          if (!record) {
            this.activeCalls.delete(call);
            this.record(cls, this.now() - call.started, successful, breaker);
          }
        }
      } finally {
        releaseClass();
        releaseTotal();
      }
    });
  }

  /**
   * Coalesced, briefly cached observation of stable idle state. Active,
   * permission-waiting and unknown states are never cached: only a settled
   * quiet identity may answer from memory, and every send, creation or
   * lifecycle signal invalidates it.
   */
  async observe<T extends { active: boolean; permissions: boolean; status: string; workspaceId?: string | null }>(id: string, work: () => Promise<T>): Promise<T> {
    return this.cached("observe", id, work, value =>
      !value.active && !value.permissions && ["idle", "closed", "error"].includes(value.status) ? value.workspaceId ?? "" : null);
  }

  /** Coalesced, briefly cached workspace availability read. */
  observeWorkspace(id: string, work: () => Promise<boolean>): Promise<boolean> {
    return this.cached("workspaceAvailable", id, work, value => (value ? id : null));
  }

  private async cached<T>(namespace: string, id: string, work: () => Promise<T>, stable: (value: T) => string | null): Promise<T> {
    const key = `${namespace}:${id}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at <= this.observationCacheMs) { this.cacheHits++; return hit.value as T; }
    const epoch = this.observationEpoch;
    const value = await this.run("observation", work, key);
    if (epoch !== this.observationEpoch) return value; // A signal during the read must prevent stale repopulation.
    const workspaceId = stable(value);
    if (workspaceId !== null) this.cache.set(key, { at: this.now(), value, workspaceId });
    else this.cache.delete(key);
    return value;
  }

  /** Drop cached evidence for one agent identity after Queue sends or creates work. */
  invalidate(identity: string) {
    if (!identity) return;
    this.observationEpoch++;
    for (const key of [...this.cache.keys()]) {
      if (key === `observe:${identity}` || key === `workspaceAvailable:${identity}`) this.cache.delete(key);
    }
  }

  /** Drop every cached observation recorded inside one workspace. */
  invalidateWorkspace(workspaceId: string) {
    if (!workspaceId) return;
    this.observationEpoch++;
    for (const [key, entry] of [...this.cache.entries()]) if (entry.workspaceId === workspaceId) this.cache.delete(key);
  }

  /** A Paseo lifecycle signal is a scheduling hint: it invalidates cached evidence for that identity. */
  noteLifecycleSignal(input: { agentId?: string | null; workspaceId?: string | null }) {
    this.lifecycleSignals++;
    if (input.agentId) this.invalidate(input.agentId);
    if (input.workspaceId) this.invalidateWorkspace(input.workspaceId);
  }

  /**
   * Decide whether a new Queue-owned workspace may be created now. Durable
   * intent is recorded by the caller only after this admits, so a deferral
   * leaves the task queued and visible rather than minting an uncertain
   * creation that needs attention.
   */
  workspaceAdmissionReason(active: number): string {
    if (this.degradedNow) return `Paseo admission breaker: ${this.degradedReason}; re-check after ${new Date(this.recoveryAfter).toISOString()} with healthy samples`;
    if (active >= this.workspaceBudget) return `Queue workspace admission budget reached (${active}/${this.workspaceBudget}); waiting for a retained workspace to finish`;
    return "";
  }
  workspaceAdmission(active: number): { admitted: true } | { admitted: false; reason: string } {
    this.workspaces = active;
    const reason = this.workspaceAdmissionReason(active);
    if (!reason) return { admitted: true };
    this.workspaceDeferrals++;
    return { admitted: false, reason };
  }

  private record(cls: AdmissionClass, ms: number, successful: boolean, breaker: boolean) {
    const samples = this.latencies.get(cls)!;
    samples.push(ms);
    if (samples.length > this.latencyWindow) samples.splice(0, samples.length - this.latencyWindow);
    if (ms >= this.degradedLatencyMs) {
      const recent = this.recentSlowSamples();
      recent.push({ cls, ms, at: this.now(), breaker });
      // Breaker-exempt work (a workspace archive) is visible here and in
      // `snapshot`, but it neither trips the breaker nor clears it.
      const critical = recent.filter(sample => sample.breaker && CRITICAL.includes(sample.cls));
      if (breaker && CRITICAL.includes(cls) && critical.length >= SLOW_TRIP_SAMPLES)
        this.trip(`${critical.length} slow critical Paseo calls in ${SLOW_WINDOW_MS / 1000}s: ${critical.slice(-SLOW_TRIP_SAMPLES).map(sample => `${sample.cls} ${Math.round(sample.ms)} ms`).join(", ")} (threshold ${this.degradedLatencyMs} ms)`);
      return;
    }
    if (!breaker || !CRITICAL.includes(cls)) return;
    if (!successful || !this.degraded || this.now() < this.recoveryAfter || this.slowInFlight(true) || ms >= this.degradedLatencyMs / 2) return;
    this.healthySamples++;
    if (this.healthySamples >= this.degradedExitSamples) {
      this.degraded = false; this.degradedSince = null; this.degradedReason = ""; this.healthySamples = 0;
    }
  }

  snapshot(): PaseoAdmission {
    // A breaker-counting pending call is reported first; a breaker-exempt archive
    // still shows while it holds its slot, and says why it cannot trip.
    const pending = this.slowInFlight(true) ?? this.slowInFlight();
    const latest = this.recentSlowSamples().at(-1);
    const exemption = (breaker: boolean) => breaker ? "" : "; a workspace archive is breaker-exempt";
    const warning = pending
      ? `Paseo ${pending.cls} call pending for ${Math.round(this.now() - pending.started)} ms (threshold ${this.degradedLatencyMs} ms${exemption(pending.breaker)})`
      : latest ? `Paseo ${latest.cls} call observed at ${Math.round(latest.ms)} ms (threshold ${this.degradedLatencyMs} ms${exemption(latest.breaker)})` : "";
    const state = (cls: AdmissionClass) => {
      const gate = this.gate(cls);
      const awaitingTotal = this.totalWaiting.filter(entry => entry.cls === cls).length;
      return { limit: gate.limit, running: gate.running - awaitingTotal, waiting: gate.waiting.length + awaitingTotal, completed: gate.completed, coalesced: gate.coalesced };
    };
    const latency = (cls: AdmissionClass) => {
      const samples = this.latencies.get(cls)!;
      return { samples: samples.length, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), maxMs: samples.length ? Math.max(...samples) : null };
    };
    return {
      callback: state("callback"), control: state("control"), observation: state("observation"),
      title: state("title"), cleanup: state("cleanup"), inventory: state("inventory"), workspace: state("workspace"),
      latency: {
        callback: latency("callback"), control: latency("control"), observation: latency("observation"),
        title: latency("title"), cleanup: latency("cleanup"), inventory: latency("inventory"), workspace: latency("workspace"),
      },
      observationCacheEntries: this.cache.size, observationCacheHits: this.cacheHits,
      workspaceBudget: this.workspaceBudget, workspaces: this.workspaces, workspaceDeferrals: this.workspaceDeferrals,
      lifecycleSignals: this.lifecycleSignals,
      backpressure: { degraded: this.degraded, since: this.degradedSince, reason: this.degradedReason, warning, healthySamples: this.healthySamples, thresholdMs: this.degradedLatencyMs },
    };
  }
}

const ADMISSION = Symbol("nucleus.admission");

type Admitted = Adapter & { [ADMISSION]: Admission };

/** Read the admission controller attached to a previously wrapped adapter. */
export function admissionOf(adapter: Adapter): Admission | null {
  return (adapter as Partial<Admitted>)[ADMISSION] ?? null;
}

/**
 * Wrap an adapter so every outbound Paseo call passes through one admission
 * controller. Methods that are not classified forward unchanged, so identity,
 * fakes and optional adapter capabilities are preserved exactly.
 */
/**
 * Composite effects whose local work or accumulated pagination must not read
 * as one slow Paseo request. Each request inside is timed alone (Tom,
 * 2026-10-23: "Paseo calls only", for archives).
 */
const INNER_TIMED: ReadonlySet<string> = new Set(["archiveTaskWorkspace", "archiveExternalWorkspace", "observationInventory"]);
/**
 * A workspace archive is the one Paseo effect that legitimately runs for
 * minutes (median 238 s, max 1,432 s on 2026-11-05). Its requests keep their
 * cleanup slot, latency sample and pending state, but its duration is not
 * evidence that Paseo stopped answering, so it neither trips the breaker nor
 * holds its recovery. Archive threads, which answer in under a second, still
 * count.
 */
const BREAKER_EXEMPT: ReadonlySet<string> = new Set(["archiveTaskWorkspace", "archiveExternalWorkspace"]);

export function admitAdapter(raw: Adapter, admission: Admission): Adapter {
  const held = raw as unknown as Record<string, unknown>;
  const call = <T>(cls: AdmissionClass, name: string, key: (args: unknown[]) => string | undefined, invalidate?: (args: unknown[], result: T) => void, orderedTarget?: (args: unknown[]) => string | undefined) => {
    const fn = held[name];
    if (typeof fn !== "function") return undefined;
    return (...args: unknown[]) => {
      const requestKey = key(args);
      const invoke = () => admission.run(cls, () => (fn as (...a: unknown[]) => Promise<T>).apply(raw, args), requestKey, { innerTiming: INNER_TIMED.has(name), breakerExempt: BREAKER_EXEMPT.has(name) });
      const target = orderedTarget?.(args);
      return (target === undefined ? invoke() : admission.notify(target, requestKey, invoke))
        .then(result => { invalidate?.(args, result); return result; });
    };
  };
  const overrides: Record<string, unknown> = {};
  const set = (name: string, fn: unknown) => { if (fn) overrides[name] = fn; };

  set("observe", (id: string) => admission.observe(id, () => raw.observe(id)));
  // Spec 058 slice 1: establishing a run's usage stream is one observation-class Paseo call.
  set("subscribeRunUsage", call("observation", "subscribeRunUsage", args => requestIdentity("subscribeRunUsage", args)));
  // Audit A6: the pass inventory is one inventory-class read, admitted and
  // measured like every other bounded Paseo call.
  set("observationInventory", call("inventory", "observationInventory", args => requestIdentity("observationInventory", args)));
  set("workspaceAvailable", raw.workspaceAvailable && ((id: string) => admission.observeWorkspace(id, () => raw.workspaceAvailable!(id))));
  set("preflightWorkerContinuation", call("observation", "preflightWorkerContinuation", args => requestIdentity("preflightWorkerContinuation", args)));
  set("profiles", call("inventory", "profiles", args => requestIdentity("profiles", args)));
  // The host catalog and the one-time host-profile import are the same class of
  // bounded host inventory read as `profiles`.
  set("catalog", call("inventory", "catalog", args => requestIdentity("catalog", args)));
  set("hostProfiles", call("inventory", "hostProfiles", args => requestIdentity("hostProfiles", args)));
  set('answerNativePermission', call('control', 'answerNativePermission', args =>
    typeof args[4] === 'string' ? requestIdentity('answerNativePermission', args) : undefined,
  args => { if (typeof args[0] === 'string') admission.invalidate(args[0]); }));
  set("originAgent", call("inventory", "originAgent", args => requestIdentity("originAgent", args), (_args, result) => {
    const agent = result as { workspaceId?: string | null } | null;
    if (agent?.workspaceId) admission.invalidateWorkspace(agent.workspaceId);
  }));
  set("listLiveAgents", call("inventory", "listLiveAgents", args => requestIdentity("listLiveAgents", args)));
  set("findWorkspaces", call("inventory", "findWorkspaces", args => requestIdentity("findWorkspaces", args)));
  set("findCloseoutWorkspaces", call("inventory", "findCloseoutWorkspaces", args => requestIdentity("findCloseoutWorkspaces", args)));
  set("findAgents", call("inventory", "findAgents", args => requestIdentity("findAgents", args)));
  set("findRunAgents", call("inventory", "findRunAgents", args => requestIdentity("findRunAgents", args)));
  set("findOpenBranchPr", call("control", "findOpenBranchPr", args => requestIdentity("findOpenBranchPr", args)));
  set("findAnyOpenBranchPr", call("control", "findAnyOpenBranchPr", args => requestIdentity("findAnyOpenBranchPr", args)));
  // populateTaskWorktree is Git bulk work and stays unwrapped: wrapping it as
  // class workspace would hold the sole slot for minutes and trip the Paseo
  // degraded breaker on a healthy large checkout.
  set("createWorkspace", (task: { id?: string } | undefined, ...args: unknown[]) => {
    let startedAt = 0, admitted = false;
    const report = raw.workspaceCreationProgress;
    return admission.run("workspace", () => (held.createWorkspace as (...input: unknown[]) => Promise<{ id?: string } | undefined>).apply(raw, [task, ...args]),
      task?.id ? requestIdentity("createWorkspace", [task, ...args]) : undefined, {
        innerTiming: true,
        onWaiting: () => { startedAt = Date.now(); if (task?.id) report?.(task.id, "paseo_admission_wait", "started"); },
        onAdmitted: waitMs => { admitted = true; if (task?.id) report?.(task.id, "paseo_admission_wait", "finished", waitMs, "ok"); },
      }).then(result => {
        const workspace = result as { id?: string } | undefined;
        if (workspace?.id) admission.invalidateWorkspace(workspace.id);
        return result;
      }, error => {
        if (task?.id && startedAt && !admitted) report?.(task.id, "paseo_admission_wait", "finished", Date.now() - startedAt, "failed");
        throw error;
      });
  });
  set("recoverTaskWorkspace", call("workspace", "recoverTaskWorkspace", args => requestIdentity("recoverTaskWorkspace", args)));
  set("createCloseoutWorkspace", call("workspace", "createCloseoutWorkspace", args => requestIdentity("createCloseoutWorkspace", args)));
  set("setTaskWorkspaceTitle", call("title", "setTaskWorkspaceTitle", args => requestIdentity("setTaskWorkspaceTitle", args), (args) => {
    const task = args[0] as { workspaceId?: string | null } | undefined;
    if (task?.workspaceId) admission.invalidateWorkspace(task.workspaceId);
  }));
  set("archiveTaskWorkspace", call("cleanup", "archiveTaskWorkspace", args => requestIdentity("archiveTaskWorkspace", args), (args) => {
    const id = args[1];
    if (typeof id === "string") admission.invalidateWorkspace(id);
  }));
  set("archiveExternalWorkspace", call("cleanup", "archiveExternalWorkspace", args => requestIdentity("archiveExternalWorkspace", args), (args) => {
    const input = args[0] as { workspaceId?: string } | undefined;
    if (input?.workspaceId) admission.invalidateWorkspace(input.workspaceId);
  }));
  set("reconcileSettledThreads", call("cleanup", "reconcileSettledThreads", args => requestIdentity("reconcileSettledThreads", args)));
  set("archiveAgent", call("cleanup", "archiveAgent", args => requestIdentity("archiveAgent", args), (args) => {
    if (typeof args[0] === "string") admission.invalidate(args[0]);
  }));
  set("createAgent", call("control", "createAgent", args => requestIdentity("createAgent", args), (_args, result) => {
    const agent = result as { id?: string } | undefined;
    if (agent?.id) admission.invalidate(agent.id);
  }));
  set("createRun", call("control", "createRun", args => requestIdentity("createRun", args), (_args, result) => {
    const agent = result as { id?: string } | undefined;
    if (agent?.id) admission.invalidate(agent.id);
  }));
  set("sendRun", call("callback", "sendRun", args => requestIdentity("sendRun", args), (args) => {
    const run = args[1] as { agentId?: string | null } | undefined;
    if (run?.agentId) admission.invalidate(run.agentId);
  }));
  set("continueWorker", call("callback", "continueWorker", args => requestIdentity("continueWorker", args), (args) => {
    const task = args[0] as { agentId?: string | null } | undefined;
    if (task?.agentId) admission.invalidate(task.agentId);
  }));
  set("continueRun", call("callback", "continueRun", args => requestIdentity("continueRun", args), (args) => {
    const run = args[0] as { agentId?: string | null } | undefined;
    if (run?.agentId) admission.invalidate(run.agentId);
  }));
  set("interruptAndContinue", call("control", "interruptAndContinue", args => requestIdentity("interruptAndContinue", args), (args) => {
    if (typeof args[0] === "string") admission.invalidate(args[0]);
  }));
  set("steerOrNotify", call("callback", "steerOrNotify", args => requestIdentity("steerOrNotify", args), (args) => {
    if (typeof args[0] === "string") admission.invalidate(args[0]);
  }, args => typeof args[0] === "string" ? args[0] : undefined));
  const rawNotify = held.notify;
  if (typeof rawNotify === "function") set("notify", (agentId: string, messageId: string, text: string, sourceAgentId?: string) =>
    admission.notify(agentId, requestIdentity("notify", [agentId, messageId, text, sourceAgentId]),
      () => (rawNotify as (...args: unknown[]) => Promise<void>).apply(raw, [agentId, messageId, text, sourceAgentId])).then(result => {
      admission.invalidate(agentId);
      return result;
    }));
  for (const name of [
    "validate", "verifyWorkspace", "verifyResume", "verifyCheckpoint", "verifyCleanQueueWorktree",
    "verifyPr", "verifyPrIdentity", "verifyInspectedRevisionHead", "verifyReview",
    "mergeGate", "merge", "merged", "syncMain", "publishReview", "externalMerge", "verifyCloseout", "verifyCloseoutWorkspace",
  ]) set(name, call("control", name, () => undefined));

  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === ADMISSION) return admission;
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      const override = overrides[prop];
      if (override) return override;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Adapter;
}
