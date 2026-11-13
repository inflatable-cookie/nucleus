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
import type { Adapter } from "./adapter";
import { isTransportFailure } from "../../shared/transport";
import { HostCallAbandonedError } from "./errors";
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
  /**
   * Bound on one admitted host call. Past it the call is abandoned as unknown,
   * its slot is freed, and the caller hears the abandonment instead of waiting
   * forever (see `HostCallAbandonedError`). Defaults to sixty seconds.
   */
  callDeadlineMs?: number;
  /** Classes whose calls legitimately run for minutes and are never abandoned. */
  deadlineExemptClasses?: readonly AdmissionClass[];
  /** An in-flight call older than this is named in the snapshot and logged. */
  heldSlotWarnMs?: number;
  /** Where a queued or held-slot line goes; the service log by default. */
  log?: (line: string) => void;
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
const DEFAULT_CALL_DEADLINE_MS = 60_000;
const DEFAULT_HELD_SLOT_WARN_MS = 5_000;
/**
 * Effects that legitimately hold their slot for minutes: a workspace archive
 * (median 238 s on 2026-11-05) and a workspace creation/clone. Abandoning one
 * mid-flight would free a bound that is protecting Paseo, so they keep their
 * slot until the effect settles. Everything else — a read, a control, a
 * callback, a title — must answer or be abandoned.
 */
const DEADLINE_EXEMPT: readonly AdmissionClass[] = ["cleanup", "workspace"];
/** How often one still-held slot is re-logged while it keeps holding its slot. */
const HELD_SLOT_LOG_INTERVAL_MS = 30_000;

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
interface ActiveCall { cls: AdmissionClass; holder: string; started: number; breaker: boolean; deadlineMs: number | null }
interface SlowSample { cls: AdmissionClass; ms: number; at: number; breaker: boolean }

interface Gate { limit: number; running: number; waiting: ((release: () => void) => void)[]; completed: number; coalesced: number }

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export class Admission {
  private readonly gates = new Map<AdmissionClass, Gate>();
  private readonly inflight = new Map<string, Promise<unknown>>();
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
  private abandonedCount = 0;
  private lastAbandoned: ActiveCall | null = null;
  private abandonedAt = 0;
  private readonly heldSlotLoggedAt = new Map<string, number>();
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
  private readonly callDeadlineMs: number;
  private readonly deadlineExempt: ReadonlySet<AdmissionClass>;
  private readonly heldSlotWarnMs: number;
  private readonly log: (line: string) => void;
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
    this.callDeadlineMs = options.callDeadlineMs ?? DEFAULT_CALL_DEADLINE_MS;
    this.deadlineExempt = new Set(options.deadlineExemptClasses ?? DEADLINE_EXEMPT);
    this.heldSlotWarnMs = options.heldSlotWarnMs ?? DEFAULT_HELD_SLOT_WARN_MS;
    this.log = options.log ?? (line => console.error(line));
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

  /** One Paseo request's latency sample and pending call, settled on every outcome. */
  private async sample<T>(cls: AdmissionClass, request: () => Promise<T>, breaker = true, holder: string = cls): Promise<T> {
    const call: ActiveCall = { cls, holder, started: this.now(), breaker, deadlineMs: this.deadlineFor(cls) };
    this.activeCalls.add(call);
    let successful = false;
    try {
      const result = await this.withinDeadline(call, request);
      successful = true;
      return result;
    } finally {
      this.activeCalls.delete(call);
      this.record(cls, this.now() - call.started, successful, breaker);
    }
  }

  /** The deadline for one class, or null when its effects legitimately run for minutes. */
  private deadlineFor(cls: AdmissionClass): number | null {
    return this.deadlineExempt.has(cls) ? null : this.callDeadlineMs;
  }

  /**
   * Hold one pending call under its deadline. A call past the bound is abandoned
   * as unknown — never resent, never read as success — and the slot it holds is
   * released when the caller's own `finally` runs. The abandoned request may
   * still settle later on the host; that late answer is not this caller's.
   */
  private withinDeadline<T>(call: ActiveCall, work: () => Promise<T>): Promise<T> {
    const deadlineMs = call.deadlineMs;
    if (deadlineMs === null) return work();
    let timer: NodeJS.Timeout | null = null;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timer = null;
        const ageMs = this.now() - call.started;
        this.abandonedCount++;
        this.lastAbandoned = call;
        this.abandonedAt = this.now();
        this.log(`Paseo ${call.cls} call ${call.holder} abandoned as unknown after ${Math.round(ageMs)} ms (deadline ${deadlineMs} ms): its admission slot is free and the call is not resent`);
        reject(new HostCallAbandonedError({ call: call.cls, holder: call.holder, ageMs, deadlineMs }));
      }, deadlineMs);
      timer.unref?.();
    });
    return Promise.race([work(), expiry]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** Active calls at or past `thresholdMs`, oldest first, bounded to five. */
  private heldSlots(thresholdMs = this.heldSlotWarnMs): ActiveCall[] {
    return [...this.activeCalls]
      .filter(call => this.now() - call.started >= thresholdMs)
      .sort((left, right) => left.started - right.started)
      .slice(0, 5);
  }

  private heldSlotView(call: ActiveCall, at = this.now()) {
    return { cls: call.cls, holder: call.holder, ageMs: Math.max(0, at - call.started), deadlineMs: call.deadlineMs, breaker: call.breaker };
  }

  /**
   * Log one wait for a slot, naming who was holding it when the caller queued and
   * for how long. Bounded per holder, and silent for waits under the threshold.
   */
  private noteWait(cls: AdmissionClass, holder: string, waitMs: number, blockedBy: ActiveCall | undefined, queuedAtWait: number, runningAtWait: number) {
    if (waitMs < this.heldSlotWarnMs) return;
    const key = `${cls}:${holder}`;
    const at = this.now();
    const last = this.heldSlotLoggedAt.get(key) ?? 0;
    if (at - last < HELD_SLOT_LOG_INTERVAL_MS) return;
    if (this.heldSlotLoggedAt.size > 64) this.heldSlotLoggedAt.clear();
    this.heldSlotLoggedAt.set(key, at);
    this.log(`Paseo ${cls} call ${holder} waited ${Math.round(waitMs)} ms for a slot`
      + `${blockedBy ? `; oldest held slot: ${blockedBy.cls} ${blockedBy.holder} for ${Math.round(at - blockedBy.started)} ms${blockedBy.deadlineMs === null ? " (no deadline: it is never abandoned)" : ` (deadline ${blockedBy.deadlineMs} ms)`}` : ""}`
      + `; ${queuedAtWait} queued behind ${runningAtWait}/${this.totalLimit} in flight when it queued`);
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
  run<T>(cls: AdmissionClass, work: () => Promise<T>, key?: string, options: { innerTiming?: boolean; breakerExempt?: boolean; holder?: string; onWaiting?: () => void; onAdmitted?: (waitMs: number) => void } = {}): Promise<T> {
    const breaker = options.breakerExempt !== true;
    // The holder names the effect and its identity, so a stuck slot is attributable.
    const holder = options.holder ?? key ?? cls;
    return this.withKey(cls, key, async () => {
      options.onWaiting?.();
      const waitingAt = this.now();
      // Capture who this call would wait behind before the release that admits it
      // removes the holder from the ledger.
      const blockedBy = this.heldSlots()[0];
      const queuedAtWait = this.totalWaiting.length;
      const runningAtWait = this.totalRunning;
      const releaseClass = await this.acquire(cls);
      const releaseTotal = await this.acquireTotal(cls);
      try {
        options.onAdmitted?.(this.now() - waitingAt);
        this.noteWait(cls, holder, this.now() - waitingAt, blockedBy, queuedAtWait, runningAtWait);
        // Recheck after waiting for admission. No effect started yet.
        this.admitHousekeeping(cls);
        const call: ActiveCall = { cls, holder, started: this.now(), breaker, deadlineMs: this.deadlineFor(cls) };
        let open = true;
        // A request started after the effect settles is not this effect's.
        const record: PaseoCallRecorder | undefined = options.innerTiming
          ? request => (open ? this.sample(cls, request, breaker, holder) : request())
          : undefined;
        if (!record) this.activeCalls.add(call);
        let successful = false;
        try {
          // A tracked effect is bounded as a whole; an inner-timed one is bounded
          // per Paseo request inside it (`sample`), never on its own Git work.
          const result = record ? await withPaseoCallTiming(record, work) : await this.withinDeadline(call, () => withPaseoCallTiming(undefined, work));
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
      heldSlots: this.heldSlots().map(call => this.heldSlotView(call)),
      abandoned: { count: this.abandonedCount, last: this.lastAbandoned ? this.heldSlotView(this.lastAbandoned, this.abandonedAt) : null },
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
  const call = <T>(cls: AdmissionClass, name: string, key: (args: unknown[]) => string | undefined, invalidate?: (args: unknown[], result: T) => void) => {
    const fn = held[name];
    if (typeof fn !== "function") return undefined;
    return (...args: unknown[]) => {
      const identity = key(args);
      return admission.run(cls, () => (fn as (...a: unknown[]) => Promise<T>).apply(raw, args), identity, { innerTiming: INNER_TIMED.has(name), breakerExempt: BREAKER_EXEMPT.has(name), holder: identity ?? name })
        .then(result => { invalidate?.(args, result); return result; });
    };
  };
  const taskKey = (prefix: string) => (args: unknown[]) => {
    const task = args[0] as { id?: string; workspaceId?: string | null } | undefined;
    return task?.id ? `${prefix}:${task.id}` : undefined;
  };
  const idKey = (prefix: string) => (args: unknown[]) => (typeof args[0] === "string" ? `${prefix}:${args[0]}` : undefined);
  const overrides: Record<string, unknown> = {};
  const set = (name: string, fn: unknown) => { if (fn) overrides[name] = fn; };

  set("observe", (id: string) => admission.observe(id, () => raw.observe(id)));
  // Spec 058 slice 1: establishing a run's usage stream is one observation-class Paseo call.
  set("subscribeRunUsage", call("observation", "subscribeRunUsage", idKey("subscribeRunUsage")));
  // Audit A6: the pass inventory is one inventory-class read, admitted and
  // measured like every other bounded Paseo call.
  set("observationInventory", call("inventory", "observationInventory", () => "observationInventory"));
  set("workspaceAvailable", raw.workspaceAvailable && ((id: string) => admission.observeWorkspace(id, () => raw.workspaceAvailable!(id))));
  set("preflightWorkerContinuation", call("observation", "preflightWorkerContinuation", taskKey("preflightWorkerContinuation")));
  set("profiles", call("inventory", "profiles", () => "profiles"));
  // The host catalog and the one-time host-profile import are the same class of
  // bounded host inventory read as `profiles`.
  set("catalog", call("inventory", "catalog", () => "catalog"));
  set("hostProfiles", call("inventory", "hostProfiles", () => "hostProfiles"));
  set('answerNativePermission', call('control', 'answerNativePermission', args =>
    typeof args[4] === 'string' ? `answerNativePermission:${JSON.stringify(args)}` : undefined,
  args => { if (typeof args[0] === 'string') admission.invalidate(args[0]); }));
  set("originAgent", call("inventory", "originAgent", idKey("originAgent"), (_args, result) => {
    const agent = result as { workspaceId?: string | null } | null;
    if (agent?.workspaceId) admission.invalidateWorkspace(agent.workspaceId);
  }));
  set("listLiveAgents", call("inventory", "listLiveAgents", () => "listLiveAgents"));
  set("findWorkspaces", call("inventory", "findWorkspaces", taskKey("findWorkspaces")));
  set("findCloseoutWorkspaces", call("inventory", "findCloseoutWorkspaces", taskKey("findCloseoutWorkspaces")));
  set("findAgents", call("inventory", "findAgents", taskKey("findAgents")));
  set("findRunAgents", call("inventory", "findRunAgents", (args) => {
    const run = args[0] as { id?: string } | undefined;
    return run?.id ? `findRunAgents:${run.id}` : undefined;
  }));
  set("findOpenBranchPr", call("control", "findOpenBranchPr", taskKey("findOpenBranchPr")));
  set("findAnyOpenBranchPr", call("control", "findAnyOpenBranchPr", taskKey("findAnyOpenBranchPr")));
  // populateTaskWorktree is Git bulk work and stays unwrapped: wrapping it as
  // class workspace would hold the sole slot for minutes and trip the Paseo
  // degraded breaker on a healthy large checkout.
  set("createWorkspace", (task: { id?: string } | undefined, ...args: unknown[]) => {
    let startedAt = 0, admitted = false;
    const report = raw.workspaceCreationProgress;
    return admission.run("workspace", () => (held.createWorkspace as (...input: unknown[]) => Promise<{ id?: string } | undefined>).apply(raw, [task, ...args]),
      task?.id ? `createWorkspace:${task.id}` : undefined, {
        innerTiming: true,
        holder: task?.id ? `createWorkspace ${task.id}` : "createWorkspace",
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
  set("recoverTaskWorkspace", call("workspace", "recoverTaskWorkspace", taskKey("recoverTaskWorkspace")));
  set("createCloseoutWorkspace", call("workspace", "createCloseoutWorkspace", taskKey("createCloseoutWorkspace")));
  set("setTaskWorkspaceTitle", call("title", "setTaskWorkspaceTitle", taskKey("title"), (args) => {
    const task = args[0] as { workspaceId?: string | null } | undefined;
    if (task?.workspaceId) admission.invalidateWorkspace(task.workspaceId);
  }));
  set("archiveTaskWorkspace", call("cleanup", "archiveTaskWorkspace", (args) => (typeof args[1] === "string" ? `archiveWorkspace:${args[1]}` : undefined), (args) => {
    const id = args[1];
    if (typeof id === "string") admission.invalidateWorkspace(id);
  }));
  set("archiveExternalWorkspace", call("cleanup", "archiveExternalWorkspace", (args) => {
    const input = args[0] as { workspaceId?: string } | undefined;
    return input?.workspaceId ? `archiveWorkspace:${input.workspaceId}` : undefined;
  }, (args) => {
    const input = args[0] as { workspaceId?: string } | undefined;
    if (input?.workspaceId) admission.invalidateWorkspace(input.workspaceId);
  }));
  set("reconcileSettledThreads", call("cleanup", "reconcileSettledThreads", () => "reconcileSettledThreads"));
  set("archiveAgent", call("cleanup", "archiveAgent", idKey("archiveAgent"), (args) => {
    if (typeof args[0] === "string") admission.invalidate(args[0]);
  }));
  set("createAgent", call("control", "createAgent", taskKey("createAgent"), (_args, result) => {
    const agent = result as { id?: string } | undefined;
    if (agent?.id) admission.invalidate(agent.id);
  }));
  set("createRun", call("control", "createRun", (args) => {
    const run = args[1] as { id?: string } | undefined;
    return run?.id ? `createRun:${run.id}` : undefined;
  }, (_args, result) => {
    const agent = result as { id?: string } | undefined;
    if (agent?.id) admission.invalidate(agent.id);
  }));
  set("sendRun", call("callback", "sendRun", (args) => {
    const run = args[1] as { id?: string } | undefined;
    return run?.id ? `sendRun:${run.id}` : undefined;
  }, (args) => {
    const run = args[1] as { agentId?: string | null } | undefined;
    if (run?.agentId) admission.invalidate(run.agentId);
  }));
  set("continueWorker", call("callback", "continueWorker", taskKey("continueWorker"), (args) => {
    const task = args[0] as { agentId?: string | null } | undefined;
    if (task?.agentId) admission.invalidate(task.agentId);
  }));
  set("continueRun", call("callback", "continueRun", (args) => {
    const run = args[0] as { id?: string; agentId?: string | null } | undefined;
    const messageId = args[1];
    return run?.id && typeof messageId === "string" ? `continueRun:${run.id}:${messageId}` : undefined;
  }, (args) => {
    const run = args[0] as { agentId?: string | null } | undefined;
    if (run?.agentId) admission.invalidate(run.agentId);
  }));
  set("interruptAndContinue", call("control", "interruptAndContinue", (args) => {
    const agentId = args[0];
    const messageId = args[1];
    return typeof agentId === "string" && typeof messageId === "string" ? `interruptAndContinue:${agentId}:${messageId}` : undefined;
  }, (args) => {
    if (typeof args[0] === "string") admission.invalidate(args[0]);
  }));
  set("notify", call("callback", "notify", idKey("notify"), (args) => {
    if (typeof args[0] === "string") admission.invalidate(args[0]);
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
