/**
 * Queue-owned Unix socket for Effigy admission hooks. This is not contract 010
 * and is not a catalogue RPC: callers are the hook process Queue launched, on
 * the same uid, talking NDJSON over `run/admission.sock`.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import {
  hostRunAccountingRetirementSchema,
  type HostRunAccountingProducerRecord,
  type HostRunInternalRecord,
} from "../../shared/contracts";
import { HostRunScheduler, type HostRunHandler } from "../../core/host-runs/host-run-scheduler";
import { hostRunAdmissionSocketPath } from "../../core/host-runs/host-run-paths";
import { pidAlive } from "../../core/machine/process-identity";
import { hostRunProcessStartIdentity, startIdentityMatches } from "../../core/machine/start-identity";
import {
  ADMISSION_CALLER,
  admissionReservationId,
  parseEffigyAdmissionRequest,
  type AdmissionObservation,
  type EffigyAdmissionRequest,
} from "../../core/qa/effigy-admission";
import { AdmissionRpcMetricsRecorder, type AdmissionRpcMethod, type AdmissionRpcMetrics } from "../../core/qa/effigy-admission-metrics";
import { EffigyRunControl, type EffigyRunObservation } from "../../core/qa/effigy-run-control";
import {
  EFFIGY_RUNTIME_ANCESTOR_LIMIT,
  bindEffigyRuntime,
  type EffigyRuntimeAncestor,
  type EffigyRuntimeBinding,
  type EffigyRuntimeSettings,
  type EffigyVersion,
} from "../../core/qa/effigy-runtime";

export const ADMISSION_WATCH_MS = 1_000;
/**
 * How often an operator-retired reservation is still observed for the producer's
 * late evidence (Spec 035, "Retired rows are observed on a bounded slow
 * cadence"). Minutes, not seconds: the row's accounting is already retired, so
 * the remaining question is a slow one and must not cost one-second status work
 * plus a hash of a large immutable artifact.
 */
export const ADMISSION_RETIRED_WATCH_MS = 5 * 60_000;
/**
 * How long a live admission hook's start identity may stand, once it has been
 * proved at that exact pid and recorded identity, before the endpoint reads it
 * again (Spec 035, "A live hook's identity is re-read on a bounded cadence").
 *
 * The cheap kernel liveness test still runs on every watch tick; this bounds
 * only the expensive half — a `ps -o lstart=` spawn on macOS, once per watched
 * tick per live row before this bound existed. Twenty seconds is inside the
 * bracketed 15-30 s: a pid reused inside that window can delay the recognition
 * of the reuse by at most this much and never by more, and a proof never
 * outlives the binding it was made for. `0` re-reads on every tick (the
 * previous shape).
 */
export const ADMISSION_HOOK_IDENTITY_REVALIDATE_MS = 20_000;
const MAX_REQUEST_BYTES = 64 * 1024;

const rpcRequestSchema = z.object({
  id: z.string().min(1).max(80),
  method: z.enum(["reserve", "status", "confirm", "bind-hook"]),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();

const bindParamsSchema = z.object({
  reservationId: z.string().min(1).max(160),
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
}).strict();

const reservationParamsSchema = z.object({
  reservationId: z.string().min(1).max(160),
}).strict();

const ancestrySchema = z.array(z.object({
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1).max(200),
}).strict()).max(EFFIGY_RUNTIME_ANCESTOR_LIMIT);

/**
 * The hook adds its attested ancestry beside the producer's unchanged request
 * (`effigy.admission-request.v1`). Unknown fields fail closed.
 */
const reserveParamsSchema = z.object({
  request: z.unknown(),
  ancestry: ancestrySchema.optional(),
}).strict();

export interface EffigyAdmissionEndpointOptions {
  socketPath?: string;
  stateDir?: string;
  now?: () => number;
  watchMs?: number;
  /** Timer seam for deterministic watch cadence tests. */
  watchTimer?: { set: (callback: () => void, delay: number) => NodeJS.Timeout; clear: (timer: NodeJS.Timeout) => void };
  /** How often a row whose accounting an operator already retired is observed. */
  retiredWatchMs?: number;
  /**
   * How long a proved live hook identity may answer without another OS read
   * (`ADMISSION_HOOK_IDENTITY_REVALIDATE_MS`). `0` re-reads every tick.
   */
  hookIdentityRevalidateMs?: number;
  /** Test seam for the hook's liveness test; production asks the kernel (ESRCH is the only dead answer). */
  hookAlive?: (pid: number) => boolean;
  /** Test seam for the hook's contract 010 start identity; production reads this host. */
  hookStartIdentity?: (pid: number) => string;
  /**
   * Effigy runtime settings (host settings `effigyRuntime`): an optional
   * `minVersion` floor. Absent is the normal state: the workload's own Effigy is
   * bound from its attested ancestry (Spec 035, Tom 2026-10-26). Read once, at
   * service construction.
   */
  effigyRuntime?: EffigyRuntimeSettings | null;
  /** Test seam for asking an ancestor image for its Effigy version; production runs `<image> --version`. */
  effigyVersion?: (path: string) => EffigyVersion | null | Promise<EffigyVersion | null>;
  /**
   * The environment the admitted workload ran in: Queue reads the run journal
   * from that host environment. Production leaves this unset (the service's own
   * environment, which is the one the daemon launches workers under).
   */
  environment?: NodeJS.ProcessEnv;
  afterBind?: (socketPath: string) => void;
}

interface Watch {
  reservationId: string;
  timer: NodeJS.Timeout;
}

export class EffigyAdmissionEndpoint {
  readonly socketPath: string;
  private server: Server | null = null;
  private boundIno: number | null = null;
  private stopping = false;
  private readonly sockets = new Set<Socket>();
  private readonly watches = new Map<string, Watch>();
  /** Each reservation's already-noted reason keys, so a stuck row notes a cause once. */
  private readonly notedReasons = new Map<string, Set<string>>();
  /** Reservations with an observation in flight. */
  private readonly reconciling = new Set<string>();
  /** Bounded, memory-only admission RPC metrics; no timer, row or journal entry. */
  private readonly metrics: AdmissionRpcMetricsRecorder;
  private readonly nowMs: () => number;
  private readonly watchTimer: NonNullable<EffigyAdmissionEndpointOptions["watchTimer"]>;
  private readonly watchMs: number;
  private readonly retiredWatchMs: number;
  private readonly hookIdentityRevalidateMs: number;
  private readonly hookAlive: (pid: number) => boolean;
  private readonly hookStartIdentity: (pid: number) => string;
  /**
   * One proved live hook identity per watched reservation: the pid, epoch and
   * recorded identity it was proved for, and when. Only a positively matched
   * read is ever kept, entries are dropped with their watch, and an entry for a
   * binding that moved is never consulted, so this map cannot outgrow the
   * watches and can never hold a history of dead or unknown hooks.
   */
  private readonly hookIdentityProofs = new Map<string, { pid: number; epoch: number; startIdentity: string; at: number }>();
  private readonly effigyRuntime: EffigyRuntimeSettings | null;
  private readonly effigyVersion: ((path: string) => EffigyVersion | null | Promise<EffigyVersion | null>) | undefined;
  private readonly environment: NodeJS.ProcessEnv | undefined;
  private readonly afterBind: ((socketPath: string) => void) | undefined;

  constructor(readonly scheduler: HostRunScheduler, options: EffigyAdmissionEndpointOptions = {}) {
    const stateDir = options.stateDir;
    this.socketPath = options.socketPath ?? (stateDir ? hostRunAdmissionSocketPath(stateDir) : "");
    if (!this.socketPath) throw new Error("Effigy admission endpoint requires socketPath or stateDir");
    this.nowMs = options.now ?? Date.now;
    this.metrics = new AdmissionRpcMetricsRecorder(this.nowMs);
    this.watchTimer = options.watchTimer ?? { set: setTimeout, clear: clearTimeout };
    this.watchMs = options.watchMs ?? ADMISSION_WATCH_MS;
    this.retiredWatchMs = options.retiredWatchMs ?? ADMISSION_RETIRED_WATCH_MS;
    this.hookIdentityRevalidateMs = options.hookIdentityRevalidateMs ?? ADMISSION_HOOK_IDENTITY_REVALIDATE_MS;
    this.hookAlive = options.hookAlive ?? pidAlive;
    this.hookStartIdentity = options.hookStartIdentity ?? (pid => hostRunProcessStartIdentity(pid));
    this.effigyRuntime = options.effigyRuntime ?? null;
    this.effigyVersion = options.effigyVersion;
    this.environment = options.environment;
    this.afterBind = options.afterBind;
  }

  serving(): boolean {
    if (!this.server || this.boundIno === null) return false;
    try { return lstatSync(this.socketPath).ino === this.boundIno; } catch { return false; }
  }

  /**
   * Bounded admission RPC metrics for `service.health` (Spec 035, "Admission RPC
   * metrics"): dispatch latency, reply delivery and confirm cadence, all
   * collected when a request arrived and published without a per-run label.
   * `serving` is this endpoint's own socket truth, so zero counts can never read
   * as "no requests" when the socket is not bound at all.
   */
  rpcMetrics(): AdmissionRpcMetrics & { serving: boolean } {
    return { serving: this.serving(), ...this.metrics.snapshot() };
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.ensureServing();
    if (!this.serving()) throw new Error(`Admission socket did not bind: ${this.socketPath}`);
    this.reattachWatches();
  }

  async ensureServing(): Promise<boolean> {
    if (this.stopping) return false;
    if (this.server && this.serving()) return true;
    if (this.server) await this.stopListen();
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.socketPath)) {
      const live = await socketAnswers(this.socketPath, 250);
      if (live) return false;
      try { unlinkSync(this.socketPath); } catch { /* gone between probe and unlink */ }
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer(socket => this.onConnection(socket));
      server.on("error", reject);
      server.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o700);
          this.boundIno = lstatSync(this.socketPath).ino;
          this.server = server;
          this.afterBind?.(this.socketPath);
          resolve();
        } catch (error) { reject(error); }
      });
    });
    return this.serving();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const watch of this.watches.values()) this.watchTimer.clear(watch.timer);
    this.watches.clear();
    this.hookIdentityProofs.clear();
    await this.stopListen();
  }

  /**
   * Reserve host capacity for one admission, or refuse before reserving.
   *
   * The workload's own Effigy is bound from its attested ancestry first (and
   * held to any configured `minVersion`). An admission Queue cannot observe is refused with the
   * binding reason and writes no reservation, so no capacity is ever held for a
   * run no observer can read; a bindable one is submitted already bound, in the
   * same durable write. The refusal uses the existing `settled` observation the
   * hook already denies on, so the wire shape is unchanged.
   */
  async reserve(request: EffigyAdmissionRequest, ancestry: readonly EffigyRuntimeAncestor[] = []): Promise<{ observation: AdmissionObservation; reservationId: string | null }> {
    const nested = this.nestedAlreadyReserved(request);
    if (nested === "own") {
      const reservationId = admissionReservationId(request.run_id);
      return { reservationId, observation: this.observationOf(this.scheduler.get(reservationId)!) };
    }
    if (nested) return { reservationId: null, observation: { kind: "nested" } };
    const binding = await this.runtimeBinding(ancestry);
    if (binding.kind === "unbound")
      return { reservationId: null, observation: { kind: "settled", reason: `admission refused: ${binding.reason}` } };
    const reservationId = admissionReservationId(request.run_id);
    try {
      const epoch = this.scheduler.authority().epoch;
      const record = this.scheduler.submit({
        id: reservationId,
        epoch,
        submissionSource: "admission",
        caller: ADMISSION_CALLER,
        repository: { origin: null, path: request.root },
        selector: request.task,
        runClass: "heavy",
        classSource: "manifest",
        priority: "interactive",
        runTimeoutMs: 24 * 60 * 60_000,
        effigyRunId: request.run_id,
        effigyRuntimeBinding: binding,
      }, this.holdHandler());
      return { reservationId, observation: this.observationOf(record) };
    } catch (error) {
      return { reservationId: null, observation: { kind: "error", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /** The workload's own Effigy, found from its attested ancestry, or why none can be bound. */
  private runtimeBinding(ancestry: readonly EffigyRuntimeAncestor[]): Promise<EffigyRuntimeBinding> {
    return bindEffigyRuntime({ settings: this.effigyRuntime, ancestry, ...(this.effigyVersion ? { probeVersion: this.effigyVersion } : {}) }).catch((error): EffigyRuntimeBinding => ({
      kind: "unbound",
      reason: `Effigy runtime binding failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }

  status(reservationId: string): AdmissionObservation {
    const record = this.scheduler.get(reservationId);
    if (!record || record.submissionSource !== "admission") return { kind: "unknown" };
    return this.observationOf(record);
  }

  confirm(reservationId: string): AdmissionObservation {
    const observation = this.status(reservationId);
    // Task 447: the interval between two confirms this service processed is the
    // one place a late confirm is visible without a history scan.
    this.metrics.recordConfirm(reservationId, this.nowMs());
    if (observation.kind === "queued" || observation.kind === "admitted" || observation.kind === "running") {
      this.scheduler.note(reservationId, "admission_confirm", { at: new Date(this.nowMs()).toISOString() });
    }
    return observation;
  }

  bindHook(reservationId: string, pid: number, startIdentity: string): AdmissionObservation {
    const record = this.scheduler.get(reservationId);
    if (!record || record.submissionSource !== "admission") return { kind: "unknown" };
    if (record.state === "settled") return this.observationOf(record);
    try {
      this.scheduler.bindProcess(reservationId, { pid, processGroupId: pid, startIdentity });
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    // A new binding is a new identity question: no proof made for the previous
    // pid or start identity may answer for this one.
    this.forgetHookIdentity(reservationId);
    this.watchReservation(reservationId);
    return this.observationOf(this.scheduler.get(reservationId)!);
  }

  private nestedAlreadyReserved(request: EffigyAdmissionRequest): HostRunInternalRecord | "own" | null {
    const ownId = admissionReservationId(request.run_id);
    const own = this.scheduler.get(ownId);
    if (own && own.submissionSource === "admission" && own.state !== "settled") return "own";
    return this.scheduler.liveQueueOrClientRunAt(request.cwd) ?? this.scheduler.liveQueueOrClientRunAt(request.root);
  }

  private observationOf(record: HostRunInternalRecord): AdmissionObservation {
    if (record.state === "queued") return { kind: "queued", position: record.position };
    if (record.state === "admitted") return { kind: "admitted" };
    if (record.state === "running") return { kind: "running" };
    const reason = record.settlement?.outcome === "capacity_timeout"
      ? "capacity deadline expired before admission"
      : record.capacityReleaseReason ?? `reservation settled (${record.settlement?.outcome ?? "settled"})`;
    return { kind: "settled", reason };
  }

  private holdHandler(): HostRunHandler {
    return {
      launch: run => {
        this.scheduler.markLaunched(run.id);
        this.watchReservation(run.id);
      },
    };
  }

  private reattachWatches(): void {
    for (const run of this.scheduler.list(10_000)) {
      if (run.submissionSource === "admission" && (run.state === "queued" || run.state === "admitted" || run.state === "running")) {
        this.scheduler.attach(run.id, this.holdHandler());
        // The cadence is decided from the durable row here too, so a restarted
        // service does not turn every retired row back into one-second work.
        this.watchReservation(run.id);
      }
    }
  }

  /**
   * Arm one reservation's next observation. Each tick schedules the one after it
   * from the row's current cadence, so a row that becomes operator-retired slows
   * down at its next tick and a row whose evidence is final stops instead of
   * waking again (Spec 035, "Retired rows are observed on a bounded slow
   * cadence").
   */
  private watchReservation(reservationId: string): void {
    if (this.watches.has(reservationId) || this.stopping) return;
    const next = this.watchCadence(reservationId);
    if (next.kind === "stop") return;
    this.scheduleWatch(reservationId, next.delayMs);
  }

  private scheduleWatch(reservationId: string, delayMs: number): void {
    if (this.stopping) return;
    // One unreadable tick (a draining store, a raced row) is retried on the next
    // tick: it never settles, releases or refuses capacity by itself.
    const timer = this.watchTimer.set(() => {
      void this.reconcile(reservationId).catch(() => { /* retried next tick */ });
    }, delayMs);
    timer.unref?.();
    this.watches.set(reservationId, { reservationId, timer });
  }

  /**
   * What this reservation's watch does next, decided from the durable row and its
   * stored retirement rather than from what a timer remembers.
   *
   * No retirement, a retirement this build cannot read, and one bound to another
   * id or epoch all keep the ordinary watch: an unreadable or stale retirement is
   * never read as "nothing left to observe". Both automatic retirement formats
   * carry the run's final evidence, so the watch stops — and the scheduler's sweep
   * settles the row through the ordinary path once its hook is gone (Spec 035, "A
   * reservation settles when its recorded process is gone"). An
   * operator retirement retires the ACCOUNTING only — the producer's own record of
   * that run may still arrive as late evidence — so it keeps a watch on the
   * bounded slow cadence instead of one-second status and hash work.
   */
  private watchCadence(reservationId: string): { kind: "stop" } | { kind: "watch"; delayMs: number } {
    const record = this.scheduler.get(reservationId);
    if (!record || record.submissionSource !== "admission" || record.state === "settled") return { kind: "stop" };
    const stored = this.scheduler.store.hostRunAccountingDispositionRaw(reservationId);
    if (stored === undefined) return { kind: "watch", delayMs: this.watchMs };
    const retirement = hostRunAccountingRetirementSchema.safeParse(stored);
    if (!retirement.success || retirement.data.runId !== record.id || retirement.data.epoch !== record.epoch)
      return { kind: "watch", delayMs: this.watchMs };
    if (retirement.data.format !== "queue.host-run.accounting-disposition") return { kind: "stop" };
    return { kind: "watch", delayMs: this.retiredWatchMs };
  }

  private stopWatch(reservationId: string): void {
    const watch = this.watches.get(reservationId);
    if (!watch) return;
    this.watchTimer.clear(watch.timer);
    this.watches.delete(reservationId);
    this.hookIdentityProofs.delete(reservationId);
    this.notedReasons.delete(reservationId);
    this.metrics.forgetReservation(reservationId);
  }

  /**
   * One observation per reservation in flight. Reading a run costs a status call
   * plus a digest of the artifact, which can outlast the watch interval; without
   * this guard the ticks pile up and the same run is observed many times over.
   */
  private async reconcile(reservationId: string): Promise<void> {
    if (this.reconciling.has(reservationId)) return;
    this.reconciling.add(reservationId);
    try { await this.reconcileOnce(reservationId); }
    finally {
      this.reconciling.delete(reservationId);
      // The next delay comes from the row as it is now, so a retirement recorded
      // during this tick slows the watch at once and a stop stays a stop.
      if (!this.stopping && this.watches.has(reservationId)) {
        const next = this.watchCadence(reservationId);
        if (next.kind === "watch") this.scheduleWatch(reservationId, next.delayMs);
        else this.stopWatch(reservationId);
      }
    }
  }

  private async reconcileOnce(reservationId: string): Promise<void> {
    const record = this.scheduler.get(reservationId);
    if (!record || record.submissionSource !== "admission") { this.stopWatch(reservationId); return; }
    if (record.state === "settled") { this.stopWatch(reservationId); return; }
    // A run whose accounting retirement is its final evidence has nothing left to
    // observe, so a restarted service does not re-read it either: the scheduler's
    // sweep settles it through the ordinary path. An operator-retired row is still
    // observed — its producer record may be the late evidence worth keeping — on
    // the slow cadence decided above.
    if (this.watchCadence(reservationId).kind === "stop") { this.stopWatch(reservationId); return; }
    const death = this.hookDeath(record);
    if (death === "alive") return;
    if (death === "unknown") {
      // Not even the launcher's liveness is proven, so nothing here may observe,
      // settle or release: the row keeps its slot and records that reason once.
      this.noteReason(record, "effigy_observation_refused", "hook-liveness-unknown", this.hookLivenessUnknownReason(record));
      return;
    }
    if (record.state === "queued" || record.state === "admitted") {
      try { this.scheduler.cancelQueued(record.id, "admission hook died before admit", record.epoch); }
      catch { /* already settled or stale epoch */ }
      this.stopWatch(reservationId);
      return;
    }
    // The producer's own answer is read first: the reservation's recorded process
    // is gone, so the watch ends either way, and the answer it holds is the one
    // piece of real evidence about the run (Spec 035, "A reservation settles when
    // its recorded process is gone").
    const observation = await this.observeEffigy(record);
    if (observation.kind === "unknown") {
      // Retained custody needs a visible cause: note why the run could not be
      // observed, once per distinct reason. The exit is unobservable, not absent,
      // so the settlement below names it as the reason and invents nothing.
      this.noteReason(record, "effigy_observation_refused", observation.kind, observation.reason);
    } else if (observation.kind === "absent") {
      // Tom, 2026-10-25: "Auto-free them (Recommended)". The hook is gone by its
      // recorded identity and the producer holds no foreground gate and no journal
      // record of this run in its own checkout, so its accounting retires; its
      // outcome and custody stay unknown (Spec 035, "Retired runs age out, and
      // dead foreground runs retire").
      this.retireAccountingOnForegroundAbsence(record.id, observation);
    } else if (observation.kind !== "closed") {
      // A hold is never silent: the launcher is gone and the producer did not
      // report this run closed, so the row records exactly why it keeps its
      // capacity. A live holder, a held lock and a retention expiry are the
      // producer's own answer that the run has not ended, so the reservation
      // keeps its slot until its recorded deadline (Spec 035, "Producer closure"
      // and "A foreground run with no record").
      const retained = retainedObservation(observation);
      this.noteReason(record, "effigy_observation_retained", retained.kind, retained.reason);
      return;
    } else {
      const observedAt = new Date(this.nowMs()).toISOString();
      const producer = producerRecord(record, observation, observedAt);
      if (!producer) {
        // `observeEffigy` refuses a reservation with no bound runtime, so this is
        // defence in depth: an unattributable record is noted and the settlement
        // below still names only what Queue observed itself.
        this.noteReason(record, "effigy_observation_refused", "runtime-absent",
          `producer closed Effigy run ${observation.closure.runId} but reservation ${record.id} recorded no bound Effigy runtime; its evidence cannot be attributed`);
      } else {
        this.recordProducerClosure(record, producer);
        this.retireAccountingOnProducerClosure(record, producer);
      }
    }
    // The recorded process is gone, so the reservation settles through the one
    // ordinary path: `lost`, custody unknown, with the producer answer above
    // kept as its evidence. A settled row is no longer live work.
    this.scheduler.settleAbandonedAdmission(record.id);
    this.stopWatch(reservationId);
  }

  /**
   * The launcher's liveness, proved by pid plus contract 010 start identity.
   *
   * The kernel liveness test is cheap and runs on every tick; the start-identity
   * read is the expensive half (a `ps` spawn on macOS), so a hook already proved
   * live at this exact pid, epoch and recorded identity is not read again until
   * `hookIdentityRevalidateMs` expires. What that defers is only the recognition
   * of a pid reused inside that bound; the row is never retired, observed or
   * settled on the proof, because `dead` and `unknown` are never remembered and
   * a proof only ever answers `alive`. A binding that moved (pid, epoch or
   * recorded identity), a pid whose liveness the kernel no longer reports, an
   * unreadable identity and an `@unknown` recorded identity all go back to a
   * fresh read, and nothing here reads an unknown as absence or as permission.
   */
  private hookDeath(record: HostRunInternalRecord): "alive" | "dead" | "unknown" {
    if (!record.pid || !record.startIdentity) return "unknown";
    if (record.startIdentity.endsWith("@unknown")) return "unknown";
    if (!this.hookAlive(record.pid)) { this.forgetHookIdentity(record.id); return "dead"; }
    const proof = this.hookIdentityProofs.get(record.id);
    if (proof && proof.pid === record.pid && proof.epoch === record.epoch && proof.startIdentity === record.startIdentity
      && this.nowMs() - proof.at < this.hookIdentityRevalidateMs) return "alive";
    const liveIdentity = this.hookStartIdentity(record.pid);
    if (liveIdentity.endsWith("@unknown")) { this.forgetHookIdentity(record.id); return "unknown"; }
    if (!startIdentityMatches(record.startIdentity, liveIdentity)) { this.forgetHookIdentity(record.id); return "dead"; }
    this.hookIdentityProofs.set(record.id, {
      pid: record.pid, epoch: record.epoch, startIdentity: record.startIdentity, at: this.nowMs(),
    });
    return "alive";
  }

  /** A proof never outlives the watch it was made for, or the binding it proved. */
  private forgetHookIdentity(reservationId: string): void {
    this.hookIdentityProofs.delete(reservationId);
  }

  /**
   * One durable note per reservation and exact dedupe key. A tick that sees the
   * same answer or hold again adds nothing; a cause that changed (an unreadable
   * journal, then a structured not-found, then a real expiry) records each cause
   * once, so the row always carries everything it observed.
   */
  private noteOnce(record: HostRunInternalRecord, event: string, key: string, data: Record<string, unknown>): void {
    const dedupeKey = `${event}\u0000${key}`;
    let noted = this.notedReasons.get(record.id);
    if (!noted) { noted = new Set(); this.notedReasons.set(record.id, noted); }
    if (noted.has(dedupeKey)) return;
    noted.add(dedupeKey);
    try {
      this.scheduler.note(record.id, event, {
        ...data,
        observedAt: new Date(this.nowMs()).toISOString(),
        runtimePath: record.effigyRuntime?.path ?? null,
        runtimeSha256: record.effigyRuntime?.sha256 ?? null,
        bindingRefusal: record.effigyRuntimeRefusal ?? null,
      });
    } catch { /* a settled or unreadable row needs no note */ }
  }

  /** A hold or refusal, once per note kind and exact reason. */
  private noteReason(record: HostRunInternalRecord, event: string, kind: string, reason: string): void {
    this.noteOnce(record, event, `${kind}\u0000${reason}`, { kind, reason });
  }

  /**
   * The producer's own closure and verdict, kept as exactly that evidence and
   * nothing more (Spec 035, "Producer closure"): the run id and selector this
   * reservation was admitted for, its `checkout-journal` source, `cleanup:
   * complete`, the verdict state Queue read and the producer's own numeric exit
   * code and signal. One note per exact answer, decided against the durable
   * journal so a repeated tick, a restarted service and a reattached watch add
   * nothing while a changed answer is recorded as itself.
   */
  private recordProducerClosure(record: HostRunInternalRecord, producer: HostRunAccountingProducerRecord): void {
    if (this.producerClosureRecorded(record, producer)) return;
    this.noteOnce(record, "effigy_observation", JSON.stringify(producer), {
      runId: producer.runId,
      selector: producer.selector,
      evidenceSource: producer.evidenceSource,
      cleanup: producer.cleanup,
      state: producer.state,
      exitCode: producer.exitCode,
      signal: producer.signal,
      outcome: producer.verdict,
    });
  }

  /** True when this exact producer answer is already on the row as `effigy_observation`. */
  private producerClosureRecorded(record: HostRunInternalRecord, producer: HostRunAccountingProducerRecord): boolean {
    return this.scheduler.store.hostRunJournal(record.id).some(entry => {
      if (entry.event !== "effigy_observation") return false;
      const noted = entry.data as Record<string, unknown>;
      return noted.runId === producer.runId && noted.selector === producer.selector
        && noted.evidenceSource === producer.evidenceSource && noted.cleanup === producer.cleanup
        && noted.state === producer.state && noted.exitCode === producer.exitCode
        && noted.signal === producer.signal && noted.outcome === producer.verdict;
    });
  }

  /**
   * Retire this reservation's ACCOUNTING on the producer's cleanup closure
   * (Spec 035, "Automatic accounting on producer cleanup").
   *
   * It is an accounting decision and nothing else: the row keeps its state and
   * custody and no settlement is written, because Queue supervised no admitted
   * command and observed no container, escaped descendant or process group. The
   * retirement names the exact producer record and the operator's policy ruling;
   * it never claims an operator accepted this run. A refused or failed write
   * keeps the slot and records why, once per reason, so nothing is silently
   * freed or silently stuck.
   */
  private retireAccountingOnProducerClosure(record: HostRunInternalRecord, producer: HostRunAccountingProducerRecord): void {
    try {
      this.scheduler.retireAccountingOnProducerCleanup({ runId: record.id, producer });
      this.stopWatch(record.id);
    } catch (error) {
      this.noteReason(record, "effigy_observation_refused", "accounting-retirement-refused",
        `producer closed Effigy run ${producer.runId} (checkout-journal cleanup complete) but this reservation's accounting was not retired: ${error instanceof Error ? error.message : String(error)}; nothing was retired`);
    }
  }

  /**
   * Retire this reservation's ACCOUNTING because its admission hook is dead and
   * the producer reports no foreground holder and no journal record of its run.
   *
   * The await before this read the producer, so the row is read again here: the
   * evidence binds the row's current epoch, its recorded hook identity, its own
   * Effigy run id, selector and checkout, and the bound runtime bytes that
   * answered. Anything that moved holds, visibly, and the scheduler re-checks
   * every binding inside its transaction. Accounting only: no settlement,
   * cleanup or custody claim, and a stray process may survive (accepted risk).
   */
  private retireAccountingOnForegroundAbsence(reservationId: string, observation: Extract<EffigyRunObservation, { kind: "absent" }>): void {
    const record = this.scheduler.get(reservationId);
    if (!record || record.state !== "running") return;
    const runtime = record.effigyRuntime;
    if (!record.effigyRunId || !runtime || !record.pid || !record.startIdentity || this.hookDeath(record) !== "dead") {
      this.noteReason(record, "effigy_observation_refused", "absence-evidence-incomplete",
        `Effigy reports no foreground holder or journal record for reservation ${reservationId}, but its run id, bound runtime or dead hook identity is no longer readable; nothing was retired`);
      return;
    }
    try {
      this.scheduler.retireAccountingOnForegroundAbsence({ runId: record.id, absence: {
        runId: record.effigyRunId, selector: record.selector, state: "not-found", recording: "not-recorded",
        message: observation.message.slice(0, 4000), checkout: record.repository.path,
        runtimePath: runtime.path, runtimeSha256: runtime.sha256,
        hook: { pid: record.pid, startIdentity: record.startIdentity },
        observedAt: new Date(this.nowMs()).toISOString(),
      } });
      this.stopWatch(record.id);
    } catch (error) {
      this.noteReason(record, "effigy_observation_refused", "accounting-retirement-refused",
        `Effigy reports no foreground holder or journal record for run ${record.effigyRunId} and the admission hook is gone, but this reservation's accounting was not retired: ${error instanceof Error ? error.message : String(error)}; nothing was retired`);
    }
  }

  /** Why the launcher's own liveness cannot be proven, so nothing may be settled. */
  private hookLivenessUnknownReason(record: HostRunInternalRecord): string {
    if (!record.pid || !record.startIdentity)
      return `the admission hook is not bound yet (reservation ${record.state}); its liveness cannot be proven`;
    if (record.startIdentity.endsWith("@unknown"))
      return `admission hook pid ${record.pid} has an unreadable start identity; its liveness cannot be proven`;
    return `admission hook pid ${record.pid} identity could not be re-read; its liveness cannot be proven`;
  }

  private async observeEffigy(record: HostRunInternalRecord): Promise<EffigyRunObservation> {
    const runId = record.effigyRunId;
    if (!runId) return { kind: "unknown", reason: "admission record has no Effigy run id" };
    const runtime = record.effigyRuntime;
    if (!runtime)
      return {
        kind: "unknown",
        reason: `admission run ${record.id} has no verified Effigy runtime identity${record.effigyRuntimeRefusal ? `: ${record.effigyRuntimeRefusal}` : ""}`,
      };
    try {
      const client = new EffigyRunControl({
        runtime: { path: runtime.path, sha256: runtime.sha256 },
        cwd: record.repository.path,
        ...(this.environment ? { env: this.environment } : {}),
        timeoutMs: 8_000,
      });
      const observation = await client.status(runId, { runId, selector: record.selector });
      // Effigy rebuilt in place since binding is provenance, never a refusal (Spec 035).
      if (client.drift) this.noteReason(record, "effigy_runtime_drift", "rebuilt-since-binding", client.drift);
      return observation;
    } catch (error) {
      return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      void this.reply(socket, line).catch(() => { /* the caller is gone; nothing to answer */ });
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  private async reply(socket: Socket, line: string): Promise<void> {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch {
      this.metrics.recordRejected();
      this.replyLine(socket, { id: null, ok: false, error: { code: "malformed", message: "request is not JSON" } });
      return;
    }
    const request = rpcRequestSchema.safeParse(parsed);
    if (!request.success) {
      this.metrics.recordRejected();
      this.replyLine(socket, { id: (parsed as { id?: unknown })?.id ?? null, ok: false, error: { code: "malformed", message: "invalid admission request" } });
      return;
    }
    const { id, method, params } = request.data;
    const startedAt = process.hrtime.bigint();
    this.metrics.recordRequest(method);
    try {
      const result = await this.dispatch(method, params);
      this.metrics.recordProcessing(method, elapsedMs(startedAt));
      this.replyLine(socket, { id, ok: true, result }, method);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics.recordProcessing(method, elapsedMs(startedAt));
      this.metrics.recordError(method);
      this.replyLine(socket, { id, ok: false, error: { code: "error", message } }, method);
    }
  }

  /**
   * One reply line, and whether it reached the socket at all. The callback
   * reports a flush failure; a caller that already closed is the one case the
   * service can see, and a reply written into an abandoned socket is left to the
   * hook's own bound rather than guessed at here.
   */
  private replyLine(socket: Socket, payload: unknown, method?: AdmissionRpcMethod): void {
    const line = `${JSON.stringify(payload)}\n`;
    if (socket.destroyed || !socket.writable) {
      if (method) this.metrics.recordReply(method, false);
      return;
    }
    try {
      socket.write(line, error => {
        if (method) this.metrics.recordReply(method, !error);
      });
    } catch {
      if (method) this.metrics.recordReply(method, false);
    }
  }

  private async dispatch(method: "reserve" | "status" | "confirm" | "bind-hook", params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "reserve") return this.reserveRpc(params);
    if (method === "status") {
      const { reservationId } = reservationParamsSchema.parse(params);
      return { reservationId, observation: this.status(reservationId) };
    }
    if (method === "confirm") {
      const { reservationId } = reservationParamsSchema.parse(params);
      return { reservationId, observation: this.confirm(reservationId) };
    }
    const bind = bindParamsSchema.parse(params);
    return { reservationId: bind.reservationId, observation: this.bindHook(bind.reservationId, bind.pid, bind.startIdentity) };
  }

  private async reserveRpc(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!("request" in params)) {
      // Legacy shape: the producer's request sent bare as the params object. It
      // attests no ancestry, so its workload cannot be bound or observed: the
      // reserve refuses with that reason and writes no reservation.
      const parsed = parseEffigyAdmissionRequest(JSON.stringify(params));
      if (!parsed.ok) return { observation: { kind: "malformed", message: parsed.reason }, reservationId: null };
      return this.reserve(parsed.request);
    }
    const envelope = reserveParamsSchema.safeParse(params);
    if (!envelope.success) {
      const issue = envelope.error.issues[0];
      return {
        observation: { kind: "malformed", message: `malformed reserve params: ${issue?.path.join(".") || "params"} ${issue?.message ?? "invalid"}` },
        reservationId: null,
      };
    }
    const body = envelope.data.request;
    const raw = typeof body === "string" ? body : JSON.stringify(body ?? null);
    const parsed = parseEffigyAdmissionRequest(raw);
    if (!parsed.ok) return { observation: { kind: "malformed", message: parsed.reason }, reservationId: null };
    return this.reserve(parsed.request, envelope.data.ancestry ?? []);
  }

  private async stopListen(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    this.boundIno = null;
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath); } catch { /* already gone */ }
  }
}

/**
 * The producer's own record for one closed reservation, as the evidence this
 * admission keeps (Spec 035, "Producer closure").
 *
 * It is exactly what the bound observer read for this reservation, plus the
 * bytes that answered: the run id and selector the record named, its
 * `checkout-journal` source, `cleanup: complete`, the workload verdict state with
 * Queue's reading of it, and the producer's own numeric exit code and signal.
 *
 * It is not a Contract 010 result. Queue supervised no admitted command, so it
 * holds no process group, start identity, container or escaped-descendant fact
 * for this run, and an empty inventory would state nothing about what outlived
 * it. The admission hook's pid is not the workload's group either.
 */
function producerRecord(
  record: HostRunInternalRecord,
  observation: Extract<EffigyRunObservation, { kind: "closed" }>,
  observedAt: string,
): HostRunAccountingProducerRecord | null {
  const closure = observation.closure;
  const runtime = record.effigyRuntime;
  if (!runtime) return null;
  return {
    runId: closure.runId,
    selector: closure.selector ?? record.selector,
    evidenceSource: "checkout-journal",
    cleanup: "complete",
    state: closure.state,
    exitCode: closure.exitCode,
    signal: closure.signal,
    startedAt: closure.startedAt,
    endedAt: closure.endedAt,
    durationMs: closure.durationMs,
    runtimePath: runtime.path,
    runtimeSha256: runtime.sha256,
    verdict: observation.outcome,
    observedAt,
  };
}

/**
 * Why a row whose launcher is gone still holds capacity: the exact answer the
 * producer gave, stated as the reason on the row rather than left implicit in a
 * tick that returned. An `unclosed` record keeps its own cause, so a missing
 * cleanup, an incomplete one, a foreground-only record and a run of another
 * selector each read differently in the journal.
 */
function retainedObservation(observation: Exclude<EffigyRunObservation, { kind: "closed" | "unknown" | "absent" }>): { kind: string; reason: string } {
  if (observation.kind === "unclosed") return { kind: observation.cause, reason: observation.reason };
  if (observation.kind === "live")
    return {
      kind: observation.kind,
      reason: `Effigy run status reports state "${observation.state}"; the admission hook is gone, so capacity is held`,
    };
  return { kind: observation.kind, reason: `${observation.reason}; the admission hook is gone, so capacity is held` };
}

export function socketAnswers(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolvePromise => {
    if (!existsSync(socketPath)) { resolvePromise(false); return; }
    const probe = connect(socketPath);
    const done = (live: boolean) => { clearTimeout(timer); probe.destroy(); resolvePromise(live); };
    const timer = setTimeout(() => done(false), timeoutMs);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/** Monotonic server-side dispatch duration in milliseconds (metrics only, never a durable clock). */
function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}
