import { waitsForSettlement } from "../../shared/service/settlement-wait";
import { runtimeEntry } from "../../shared/runtime.mjs";
/**
 * Persistence executor host (g01.027 — Spec 013 "Asynchronous persistence").
 *
 * One service-local worker thread inside the standalone service owns the
 * SQLite `DatabaseSync`, every record validation and the whole Queue runtime
 * (engine, Paseo adapter, callbacks). The request loop never touches
 * SQLite: catalogue methods are forwarded as promises, health and the
 * revisioned compact board projection are answered from executor-pushed
 * in-memory snapshots, and saturation returns typed backpressure instead of
 * extending a timeout.
 *
 * The worker publishes a fresh snapshot before it answers any request whose
 * store revision advanced, so a completed mutation can never be observed
 * through a stale cached projection, and a delayed database operation inside
 * the executor cannot delay `service.health` or a cached board read.
 */
import { Worker } from "node:worker_threads";
import type { HostSettings, RuntimeHealth } from "../runtime-owner";
import { isUnchangedBoard, type UiBoard } from "../../shared/contracts";
import type { CatalogueSurface } from "../../shared/web-surface";
import { ProtocolError } from "../../shared/service/protocol";
import { defaultDataDir, SPAWN_TOKEN_ENV, STANDBY_WAIT_MS, startupExtensionMs } from "../install/standby";

export interface ExecutorOptions {
  /** Cloneable runtime-owner options; handler functions stay on the worker side. */
  owner: {
    dataDir?: string;
    paseoHome?: string;
    sourcePath?: string;
    settings?: HostSettings;
    timers?: boolean;
    admission?: import("../../core/host/admission").AdmissionOptions;
    connectTimeoutMs?: number;
    hostRunEndpoint?: boolean;
    hostRunStateDir?: string;
  };
  /** Named adapter/store fixture from the worker registry; fixtures only. */
  fixture?: string;
  /** Structured-cloneable fixture state; fixtures only. */
  fixtureState?: Record<string, unknown>;
  /** Enables the bounded debug channel used by fixtures to seed and inspect the executor store. */
  debug?: boolean;
  /** Warm standby: the worker loads its modules, prewarms the store read-only, then waits for this service pid to exit before it opens the store writable. */
  standbyFor?: number;
  /** A request outstanding longer than this is named in health and logged. Defaults to five seconds. */
  heldSlotWarnMs?: number;
  /** Where a held-slot line goes; the service log by default. */
  log?: (line: string) => void;
}

export interface ExecutorSnapshot {
  revision: number;
  health: RuntimeHealth;
  board: UiBoard | null;
}

interface SerializedError { code: string; message: string }

/**
 * The retained cause while the executor cannot serve health or a cached board.
 * `exited` and `error` are terminal for the worker; `projection` means the worker
 * lives but its last publication failed and nothing fresh has published since.
 * Message and stack are bounded so health and the diagnostic record stay small.
 */
export interface ExecutorFault {
  kind: "exited" | "error" | "projection";
  at: string;
  exitCode: number | null;
  message: string;
  stack: string;
  /** Consecutive failed publications; 1 for a terminal fault. */
  repeats: number;
}

type WorkerMessage =
  | { kind: "boot"; ok: boolean; error?: SerializedError }
  | { kind: "reply"; id: number; ok: boolean; result?: unknown; error?: SerializedError; timing?: { queueMs: number; handlerMs: number; publicationMs: number } }
  | { kind: "snapshot"; revision: number; health: RuntimeHealth; board?: UiBoard }
  | { kind: "projection"; at: string; message: string; stack: string };

export interface ExecutorRequestTiming {
  method: string; at: string; outcome: "ok" | "error" | "timeout" | "unavailable";
  totalMs: number; queueMs: number | null; handlerMs: number | null; publicationMs: number | null; returnMs: number | null;
}

/**
 * One request still holding the executor's single thread, with the age that
 * makes a starved read diagnosable. The executor serves every catalogue read on
 * that thread, so this is the slot a read waits behind.
 */
export interface ExecutorHeldSlot { method: string; ageMs: number; startedAt: string }
export interface ExecutorHeldSlots {
  /** Requests outstanding past the warning threshold, oldest first, bounded to five. */
  held: ExecutorHeldSlot[];
  /** Requests outstanding right now and how many arrived after the oldest one started. */
  inFlight: number;
  waiting: number;
  thresholdMs: number;
}

type RequestKind = "rpc" | "call" | "drain" | "debug";

const BOOT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;
const DRAIN_TIMEOUT_MS = 45_000;
const MAX_EXECUTOR_IN_FLIGHT = 96;
const MAX_FAULT_MESSAGE = 512;
const MAX_FAULT_STACK = 2_000;
const DEFAULT_HELD_SLOT_WARN_MS = 5_000;
/** One still-held request is re-logged at most this often while it keeps the thread. */
const HELD_SLOT_LOG_INTERVAL_MS = 30_000;

function boundedText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The label one request is named by in health and in the held-slot log. */
function debugLabel(payload: { op?: unknown }, kind: RequestKind): string {
  const op = payload.op as { target?: unknown; method?: unknown; action?: unknown } | undefined;
  if (kind === "debug" && op && typeof op.target === "string") {
    const detail = typeof op.method === "string" ? op.method : typeof op.action === "string" ? op.action : "";
    return detail ? `debug:${op.target}.${detail}` : `debug:${op.target}`;
  }
  return kind;
}

/** The bounded stack retained with a fault, appended to the refusal so the cause survives the RPC reply. */
function stackSuffix(fault: ExecutorFault): string {
  return fault.stack ? `\nStack: ${fault.stack}` : "";
}

/** Deserialized error from the executor, carrying its typed service code. */
export class ExecutorError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class PersistenceExecutor {
  private worker: Worker | null = null;
  private bootPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; startedAt: number; method: string; timer?: NodeJS.Timeout }>();
  private readonly recentTimings: ExecutorRequestTiming[] = [];
  private readonly heldSlotLoggedAt = new Map<string, number>();
  private readonly heldSlotWarnMs: number;
  private readonly log: (line: string) => void;
  private heldSlotTimer: NodeJS.Timeout | null = null;

  /**
   * What is holding the executor right now, and what is queued behind it. This
   * is read on the service request loop, so it stays answerable even while the
   * executor thread is blocked: `service.health` names the holder and its age.
   */
  heldSlotEvidence(): ExecutorHeldSlots {
    const at = performance.now();
    const outstanding = [...this.pending.values()]
      .map(entry => ({ method: entry.method, ageMs: Math.max(0, at - entry.startedAt), startedAt: new Date(performance.timeOrigin + entry.startedAt).toISOString() }))
      .sort((left, right) => right.ageMs - left.ageMs);
    const oldestAge = outstanding[0]?.ageMs ?? 0;
    return {
      held: outstanding.filter(slot => slot.ageMs >= this.heldSlotWarnMs).slice(0, 5),
      inFlight: outstanding.length,
      waiting: outstanding.filter(slot => slot.ageMs < oldestAge).length,
      thresholdMs: this.heldSlotWarnMs,
    };
  }

  requestTimings() { return { inFlight: this.inFlight, recent: [...this.recentTimings], held: this.heldSlotEvidence() }; }
  private recordTiming(pending: { startedAt: number; method: string }, outcome: ExecutorRequestTiming["outcome"], timing?: { queueMs: number; handlerMs: number; publicationMs: number }) {
    const totalMs=performance.now()-pending.startedAt;
    this.recentTimings.push({ method: pending.method, at: new Date().toISOString(), outcome, totalMs,
      queueMs: timing?.queueMs ?? null, handlerMs: timing?.handlerMs ?? null, publicationMs: timing?.publicationMs ?? null,
      returnMs: timing ? Math.max(0,totalMs-timing.queueMs-timing.handlerMs-timing.publicationMs) : null });
    if(this.recentTimings.length>32)this.recentTimings.shift();
  }
  private inFlight = 0;
  /** True once the worker is gone, deliberately (terminate) or by fault. */
  private dead = false;
  private faultState: ExecutorFault | null = null;
  private readonly snapshot: ExecutorSnapshot = { revision: -1, health: emptyHealth(), board: null };
  /** Invoked once when the worker dies unexpectedly; the service fails closed and records the cause. */
  onFailure: ((fault: ExecutorFault) => void) | null = null;
  /** Called after every executor-pushed snapshot; the web board's live channel subscribes here. */
  private readonly snapshotListeners = new Set<() => void>();

  constructor(private readonly options: ExecutorOptions) {
    this.heldSlotWarnMs = options.heldSlotWarnMs ?? DEFAULT_HELD_SLOT_WARN_MS;
    this.log = options.log ?? (line => console.error(line));
  }

  /**
   * Say who is holding the executor and for how long, once per holder per
   * interval. A read that has to queue is otherwise silent until the client's
   * own timeout, which is what made the 2026-11-13 wedge need a restart to
   * diagnose.
   */
  private noteHeldSlots(): void {
    const evidence = this.heldSlotEvidence();
    if (!evidence.held.length) return;
    const at = Date.now();
    for (const slot of evidence.held) {
      const last = this.heldSlotLoggedAt.get(slot.method) ?? 0;
      if (at - last < HELD_SLOT_LOG_INTERVAL_MS) continue;
      if (this.heldSlotLoggedAt.size > 64) this.heldSlotLoggedAt.clear();
      this.heldSlotLoggedAt.set(slot.method, at);
      this.log(`Queue service request ${slot.method} has held the executor for ${Math.round(slot.ageMs)} ms`
        + `${evidence.waiting ? `; ${evidence.waiting} request(s) are queued behind it` : ""}`
        + `; service.health.requestTimings.held names it`);
    }
  }

  /** Spawn the executor and wait for its first published snapshot. */
  boot(): Promise<void> {
    return this.bootPromise ?? this.startWorker();
  }

  private startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      // While the executor thread is blocked, this loop is the only thing still
      // running: it is what can say who is holding the thread and for how long.
      this.startHeldSlotWatch();
      const worker = new Worker(new URL(runtimeEntry("./executor-worker.ts"), import.meta.url), {
        workerData: {
          owner: { ...this.options.owner, admission: this.options.owner.admission },
          fixture: this.options.fixture,
          fixtureState: this.options.fixtureState ?? {},
          debug: this.options.debug === true,
          standbyFor: this.options.standbyFor,
        },
      });
      this.worker = worker;
      // Boot settles exactly once: a worker that errors or exits before its first
      // snapshot rejects now instead of waiting out the boot timeout.
      let booted = false;
      const settleBoot = (error?: Error) => {
        if (booted) return;
        booted = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      // Time this spawn reports spending on its bounded start-up work (a store migration, then
      // the store-maintenance window) does not count against the boot bound.
      const bootStartedAt = Date.now(), bootBudget = BOOT_TIMEOUT_MS + (this.options.standbyFor ? STANDBY_WAIT_MS : 0);
      const dataDir = this.options.owner.dataDir ?? defaultDataDir();
      const bootDeadline = () => bootStartedAt + bootBudget + startupExtensionMs(dataDir, process.pid, process.env[SPAWN_TOKEN_ENV]);
      let timer: NodeJS.Timeout;
      const arm = () => {
        timer = setTimeout(() => {
          if (Date.now() < bootDeadline()) { arm(); return; }
          this.terminate();
          settleBoot(new ProtocolError("timeout", `Persistence executor did not publish a snapshot inside ${BOOT_TIMEOUT_MS} ms`));
        }, Math.max(1, bootDeadline() - Date.now()));
        if (typeof timer.unref === "function") timer.unref();
      };
      arm();
      worker.on("message", message => {
        const frame = message as WorkerMessage;
        if (frame.kind === "boot") {
          if (frame.ok) { settleBoot(); return; }
          this.terminate();
          settleBoot(new ExecutorError(frame.error?.code ?? "internal", frame.error?.message ?? "Persistence executor failed to boot"));
          return;
        }
        this.receive(frame);
      });
      worker.on("error", error => {
        this.fail(error, null);
        settleBoot(new ProtocolError("unavailable", `Persistence executor failed to boot: ${this.faultState?.message ?? "unknown error"}`));
      });
      worker.on("exit", code => {
        // Only a deliberate terminate() marks the worker dead first. Any other exit,
        // including code 0, is a loss: pending requests reject and the cause is kept.
        if (!this.dead) this.fail(new Error(`Persistence executor exited unexpectedly (code ${code})`), code);
        this.dead = true;
        settleBoot(new ProtocolError("unavailable", `Persistence executor exited before publishing a snapshot (code ${code})`));
      });
    });
  }

  private receive(frame: WorkerMessage) {
    if (frame.kind === "snapshot") {
      this.snapshot.revision = frame.revision;
      this.snapshot.health = frame.health;
      if (isUnchangedBoard(frame.board)) {
        const { unchanged: _, ...counters } = frame.board;
        if (this.snapshot.board) this.snapshot.board = { ...this.snapshot.board, ...counters };
      } else if (frame.board) this.snapshot.board = frame.board;
      // A completed publication is the only thing that clears a projection fault.
      if (!this.dead && this.faultState?.kind === "projection") this.faultState = null;
      for (const listener of this.snapshotListeners) {
        try { listener(); } catch { /* a subscriber never changes publication */ }
      }
      return;
    }
    if (frame.kind === "projection") {
      if (this.dead) return;
      const repeats = this.faultState?.kind === "projection" ? this.faultState.repeats + 1 : 1;
      this.faultState = { kind: "projection", at: frame.at, exitCode: null, message: boundedText(frame.message, MAX_FAULT_MESSAGE), stack: boundedText(frame.stack, MAX_FAULT_STACK), repeats };
      return;
    }
    if (frame.kind !== "reply") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    this.recordTiming(pending, frame.ok ? "ok" : "error", frame.timing);
    this.inFlight--;
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new ExecutorError(frame.error?.code ?? "internal", frame.error?.message ?? "Persistence executor call failed"));
  }

  private fail(error: unknown, exitCode: number | null) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const wasDead = this.dead;
    this.dead = true;
    if (wasDead) return;
    this.faultState = {
      kind: exitCode === null ? "error" : "exited", at: new Date().toISOString(), exitCode,
      message: boundedText(failure.message, MAX_FAULT_MESSAGE), stack: boundedText(failure.stack ?? "", MAX_FAULT_STACK), repeats: 1,
    };
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      this.recordTiming(pending, "unavailable");
      this.inFlight--;
      pending.reject(new ProtocolError("unavailable", `Persistence executor is gone: ${failure.message}`));
    }
    try { this.onFailure?.(this.faultState); }
    catch { /* the diagnostic hook never changes the fail-closed state */ }
  }

  /**
   * Why health and cached board reads must not answer, or null while the worker
   * is live and its last publication succeeded. Requests use the same gate.
   */
  unavailableReason(): string | null {
    const fault = this.faultState;
    if (fault?.kind === "projection") {
      return `Persistence projection is not publishing (${fault.repeats} consecutive failure${fault.repeats === 1 ? "" : "s"}; last at ${fault.at}): ${fault.message}. Health and the cached board are withheld until a fresh projection publishes.${stackSuffix(fault)}`;
    }
    if (fault) return `Persistence executor is gone (${fault.kind} at ${fault.at}${fault.exitCode === null ? "" : `, exit code ${fault.exitCode}`}): ${fault.message}${stackSuffix(fault)}`;
    if (this.dead) return "Persistence executor was terminated";
    return null;
  }

  /** The retained fault, or null. Cleared only by a fresh successful publication of a live worker. */
  fault(): ExecutorFault | null {
    return this.faultState;
  }

  /** Subscribe to executor-pushed snapshots; returns the unsubscribe. */
  onSnapshot(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => { this.snapshotListeners.delete(listener); };
  }

  private send(kind: RequestKind, payload: { method?: string; input?: unknown; handler?: string; op?: unknown; via?: CatalogueSurface }, timeoutMs: number): Promise<unknown> {
    if (this.dead) throw new ProtocolError("unavailable", this.unavailableReason() ?? "Persistence executor is gone");
    if (this.inFlight >= MAX_EXECUTOR_IN_FLIGHT) {
      // Typed backpressure (Spec 013): saturation is visible, never a longer timeout.
      throw new ProtocolError("busy", `Persistence executor has ${this.inFlight} in-flight operations at its bound of ${MAX_EXECUTOR_IN_FLIGHT}; retry after the executor drains`);
    }
    const id = this.nextId++;
    this.inFlight++;
    return new Promise((resolve, reject) => {
      const pendingEntry = { resolve, reject, startedAt: performance.now(), method: payload.method ?? payload.handler ?? debugLabel(payload, kind), timer: undefined as NodeJS.Timeout | undefined };
      this.pending.set(id, pendingEntry);
      const timer = kind === "rpc" && waitsForSettlement(payload.method, payload.input) ? undefined : setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.recordTiming(pending, "timeout");
        this.inFlight--;
        reject(new ProtocolError("timeout", `Persistence executor call did not settle inside ${timeoutMs} ms`));
      }, timeoutMs);
      pendingEntry.timer = timer;
      timer?.unref();
      try { this.worker!.postMessage({ kind, id, ...payload, sentAt: performance.timeOrigin + performance.now() }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.recordTiming(pendingEntry, "unavailable");
        this.inFlight--;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** One catalogue RPC, validated inside the executor. `via` rides along for the dispatch point's Settings-only capacity rule; `key` records the request in the ledger when the caller named one. */
  rpc(method: string, input: unknown, via?: CatalogueSurface, key?: string): Promise<unknown> {
    return this.send("rpc", { method, input, ...(via ? { via } : {}), ...(key ? { key } : {}) }, CALL_TIMEOUT_MS);
  }

  /** One owner handler that is not on the public catalogue (lifecycle hints). */
  callHandler(handler: string, input: unknown): Promise<unknown> {
    return this.send("call", { handler, input }, CALL_TIMEOUT_MS);
  }

  /** Fixture-only debug channel for seeding and inspecting the executor store. */
  debug(op: unknown): Promise<unknown> {
    if (!this.options.debug) throw new ProtocolError("method_unknown", "The debug channel is disabled");
    return this.send("debug", { op }, CALL_TIMEOUT_MS);
  }

  /** Drain the executor to a durable safe point; bounded so release never hangs. */
  async drain(): Promise<void> {
    if (this.dead) return;
    try {
      await this.send("drain", {}, DRAIN_TIMEOUT_MS);
    } catch (error) {
      // A drain that did not settle is abandoned, never retried blindly: the
      // durable safe point is whatever the engine already committed.
      this.terminate();
      throw error;
    }
    this.terminate();
  }

  terminate() {
    this.dead = true;
    this.stopHeldSlotWatch();
    const worker = this.worker;
    this.worker = null;
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      this.recordTiming(pending, "unavailable");
      this.inFlight--;
      pending.reject(new ProtocolError("unavailable", "Persistence executor was terminated"));
    }
    if (worker) void worker.terminate();
  }

  /** Latest executor-published snapshot. */
  current(): ExecutorSnapshot {
    return this.snapshot;
  }

  private startHeldSlotWatch(): void {
    if (this.heldSlotTimer) return;
    this.heldSlotTimer = setInterval(() => this.noteHeldSlots(), Math.max(50, Math.min(1_000, this.heldSlotWarnMs)));
    if (typeof this.heldSlotTimer.unref === "function") this.heldSlotTimer.unref();
  }

  private stopHeldSlotWatch(): void {
    if (!this.heldSlotTimer) return;
    clearInterval(this.heldSlotTimer);
    this.heldSlotTimer = null;
  }
}

function emptyHealth(): RuntimeHealth {
  return {
    phase: "constructing", ready: false, startError: "", engineError: "", retentionError: "",
    paused: true, drained: false, boundRuns: [], hostId: "", connected: false, schema: null, lastStoreAccessAt: null,
    taskIdentities: 0, admission: {} as RuntimeHealth["admission"], reconciliation: {} as RuntimeHealth["reconciliation"],
    bootstrap: { pending: false, startedAt: null },
    eventLoop: { windowSeconds: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, maxSinceStartMs: 0 },
    hostRunEndpoint: null,
    admissionRpc: null,
  };
}
