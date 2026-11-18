/**
 * The runtime's lifecycle state machine: phase, the detached bootstrap, the
 * catalog refresh and refresh-on-secondary-arrival.
 *
 * Composition stays with `QueueRuntime`, which owns the store, engine, adapters,
 * endpoints and timers. This owner decides when those are ready, retries the
 * connect with bounds, and records the facts a first-cutover start owes its
 * operator: why it is not ready, and whether a host identity conflict is real
 * (a typed fact from the code that observed it, never re-derived from
 * `startError` text).
 */
import type { PrState } from "../core/forge/pr-status";
import type { Engine } from "../core/engine";
import type { Store } from "../core/store/store";
import type { Adapter } from "../core/host/adapter";
import type { Admission } from "../core/host/admission";
import type { HostRegistry } from "../core/host/host-registry";
import type { ParticipantTickets } from "../core/dispatch/participant-tickets";
import type { Task } from "../shared/contracts";
import type { T3HostConnection } from "./t3code-host";
import type { HostSession, RegisteredHost } from "./host-connections";
import { PrStates, type PrStateFacts } from "./runtime-pr-states";

/**
 * Bound on a post-connect bootstrap step. Only the connect used to be bounded, so a
 * stalled catalog refresh or reconciliation drain hung the shared bootstrap promise
 * with no retry and nothing reported.
 */
export const BOOTSTRAP_STEP_TIMEOUT_MS = 60_000;
/**
 * A bootstrap step that reports progress is timed out only after this long
 * without any, and never runs past the cap: the first reconciliation after a
 * roll walks the whole fleet and can take minutes on a busy host while every
 * quantum completes (2026-10-21: four rolls reported a 60 s timeout that then
 * cleared on its own).
 */
export const BOOTSTRAP_PROGRESS_CAP_MS = 10 * 60_000;

export type RuntimePhase =
  | "constructing"
  | "starting"
  | "ready"
  | "draining"
  | "stopped";

/**
 * A conflict between the configured daemon and the host this store already
 * recorded. `bootstrap` observes it and records this fact; health reads the
 * fact, so no surface has to parse `startError` for the word "identity".
 */
export interface HostIdentityConflict {
  kind: "identity" | "admission";
  /** The host the store had recorded when the conflict was observed; null when none was recorded. */
  hostId: string | null;
  message: string;
  at: string;
}

/** The conflict's own error type, so the catch records a typed fact rather than matching text. */
class HostIdentityConflictError extends Error {
  readonly kind: HostIdentityConflict["kind"];
  constructor(kind: HostIdentityConflict["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

interface BootstrapStepSettlement {
  /** A value that changes while the step makes progress; the timeout then bounds a stall, not the whole step. */
  progress?(): unknown;
  onTimeout?(error: Error): void;
  onLateSuccess?(): void;
  onLateFailure?(error: Error): void;
}

interface PostBootstrapDiagnostic {
  attemptId: number;
  message: string;
  startErrorRevision: number;
}

/** The runtime ports the lifecycle state machine reads and writes. */
export interface RuntimeLifecycleOwner {
  readonly store: Store;
  readonly engine: Engine;
  /** The primary adapter: its connect is what bootstrap bounds. */
  readonly adapter: Adapter;
  readonly admission: Admission;
  readonly hostRegistry: HostRegistry<RegisteredHost>;
  /** The host seam's own connection rule, which also retires a stale session claim. */
  connected(): boolean;
  readonly plannerTickets: ParticipantTickets;
  readonly t3Host: () => T3HostConnection | null;
  /** Adopt the stored T3Code connection if the operator route changed it (nucleus#1330). */
  refreshT3Settings(): void;
  /** The configured daemon endpoint this runtime is meant to own. */
  readonly daemonUrl: string;
  /** Bounded daemon-connect window. */
  readonly connectTimeoutMs: number;
  /** The host identity the adapter reports; a change means another host's tasks. */
  readonly paseoHostId: string;
  /** The primary session claim, owned by the host-connection seam and written there too. */
  hostSession: HostSession | null;
  /** Set when the host seam latched an idle shutdown; bootstrap stops retrying then. */
  readonly idleShutdownLatched: boolean;
  /** The display-only PR-state forge read. */
  readPrStates(tasks: Task[]): Promise<Record<string, PrState>>;
}

export class RuntimeLifecycle {
  phase: RuntimePhase = "constructing";
  /** Set by drain; nothing schedules, reads or publishes after it. */
  closing = false;
  bootstrapped = false;
  /** Detached startup bootstrap; settles when the first connect attempt (or a later retry) finishes. */
  bootstrap: Promise<void> | null = null;
  bootstrapRunning: Promise<void> | null = null;
  bootstrapStartedAt: string | null = null;
  lastStoreAccessAt: string | null = null;
  /** The typed host identity conflict, cleared by the refresh that settles it. */
  identityConflict: HostIdentityConflict | null = null;

  private readonly owner: RuntimeLifecycleOwner;
  private readonly prStates: PrStates;
  private bootstrapSettled = false;
  private bootstrapAttemptId = 0;
  private postBootstrapDiagnostic: PostBootstrapDiagnostic | null = null;
  private startErrorValue = "";
  private startErrorRevision = 0;
  private refreshing: Promise<void> | null = null;
  /** A secondary host's last known connection state, for the arrival refresh below. */
  private secondaryOnline = false;

  constructor(owner: RuntimeLifecycleOwner) {
    this.owner = owner;
    this.prStates = new PrStates({
      tasks: () => owner.store.prStateTasks(),
      read: (tasks) => owner.readPrStates(tasks),
      closing: () => this.closing,
      changed: () => owner.store.advanceRevision(),
    });
  }

  /** The catalog pass drain must quiesce before it releases the store. */
  get pendingRefresh(): Promise<void> | null {
    return this.refreshing;
  }
  get bootstrapCompleted(): boolean {
    return this.bootstrapSettled;
  }

  get startError(): string {
    return this.startErrorValue;
  }
  set startError(value: string) {
    this.startErrorValue = value;
    this.startErrorRevision++;
  }

  /** The board's PR-state map: the last successful read; empty only before the first one. */
  prStateMap(): Record<string, PrState> {
    return this.prStates.states();
  }
  /** The latest PR-state read outcome, for health: unknown stays unknown and names itself. */
  prStateFacts(): PrStateFacts {
    return this.prStates.facts();
  }

  beginStart(): void {
    this.phase = "starting";
  }
  markReady(): void {
    this.phase = "ready";
  }
  beginDrain(): void {
    this.closing = true;
    this.phase = "draining";
  }
  markStopped(): void {
    this.phase = "stopped";
  }
  /** Ready only while started, not closing; health's single answer to "is it serving". */
  get ready(): boolean {
    return this.phase === "ready" && !this.closing;
  }

  markStoreAccess(): void {
    this.lastStoreAccessAt = new Date().toISOString();
  }

  /** Start the detached bootstrap; a failure is recorded and the next timer tick retries it. */
  startBootstrap(): void {
    this.bootstrap = this.ensureBootstrap().then(
      () => undefined,
      (error) => {
        this.startError =
          error instanceof Error ? error.message : String(error);
        console.error("Nucleus startup:", this.startError);
      },
    );
  }

  /**
   * Maintenance self-heal for a bootstrap that has never completed: the periodic
   * timers and `queue.refresh` call this, so a transient daemon outage at startup
   * (or later) resumes reconciliation and accepted durable operations without an
   * operator action.
   */
  async ensureBootstrap(): Promise<boolean> {
    if (this.closing || this.owner.idleShutdownLatched) return false;
    // The operator's install route may have written or dropped the T3Code
    // connection while this process ran; adopting it here is what makes the
    // connection appear without a service restart (nucleus#1330).
    this.owner.refreshT3Settings();
    // The legacy primary identity is recorded first; a secondary reconnect
    // remains independent of primary availability after that first bootstrap.
    // A secondary host coming online owes one catalog refresh so its own
    // routing snapshot exists before any host-bound dispatch; later refreshes
    // ride the periodic profile pass. The chain runs on every bootstrap tick
    // and must never reject unhandled (a disconnected primary rejects refresh),
    // so the transition-guarded refresh is caught here.
    void this.owner.t3Host()
      ?.ensureConnected()
      .then(() => this.owner.plannerTickets.ensure())
      .then(() => this.refreshOnSecondaryArrival())
      .catch(() => {
        /* the next tick reconnects; the catalog rides the periodic profile pass */
      });
    if (this.bootstrapped && this.owner.connected()) {
      await this.owner.plannerTickets.ensure();
      return true;
    }
    if (this.bootstrapRunning)
      return this.bootstrapRunning.then(
        () => this.bootstrapped,
        () => this.bootstrapped,
      );
    const attemptId = ++this.bootstrapAttemptId;
    this.bootstrapStartedAt = new Date().toISOString();
    this.bootstrapRunning = (async () => {
      let reconciliationTimedOut = false;
      try {
        await this.boundedConnect();
        if (this.closing) return;
        const observed = this.owner.paseoHostId;
        if (!this.owner.hostSession) {
          const recorded = this.owner.hostRegistry.primary()?.id;
          if (recorded && recorded !== observed)
            throw this.refusal(
              "Configured daemon identity changed; existing tasks belong to another host",
            );
          const token = this.owner.hostRegistry.connect(
            observed,
            this.owner.daemonUrl,
            { adapter: this.owner.adapter, admission: this.owner.admission },
            () => {
              const previousHost = this.owner.hostRegistry.primary()?.id;
              if (previousHost && previousHost !== observed)
                throw this.refusal(
                  "Configured daemon identity changed; existing tasks belong to another host",
                );
              const admission = this.owner.hostRegistry.resource(
                observed,
                () => this.owner.admission,
              );
              if (admission !== this.owner.admission)
                throw new HostIdentityConflictError(
                  "admission",
                  "Host admission identity conflicts with the selected adapter",
                );
            },
          );
          this.owner.hostSession = { id: observed, token };
        } else if (this.owner.hostSession.id !== observed) {
          throw this.refusal(
            "Configured daemon identity changed; existing tasks belong to another host",
          );
        }
        void this.owner.t3Host()?.ensureConnected();
        await this.boundedBootstrapStep(
          "Daemon catalog refresh",
          this.refresh(),
        );
        await this.owner.plannerTickets.ensure();
        if (this.closing) return;
        this.owner.engine.resumeBulkDispositions();
        // Bootstrap unfinished durable operations from their stored identity; an
        // uncertain external effect is reconciled by its own gates, never reissued
        // blindly.
        await this.owner.engine.hooks
          .disposeLegacyWarmCheckouts()
          .catch((error) =>
            console.error("Legacy warm checkout disposal:", String(error)),
          );
        this.bootstrapped = true;
        const reconcileInterrupted = !this.bootstrapSettled;
        this.bootstrapSettled = true;
        this.owner.engine.resumeOperations(reconcileInterrupted);
        this.clearStartError();
        if (!this.closing)
          await this.boundedBootstrapStep(
            "Post-bootstrap reconciliation",
            this.owner.engine.wake(),
            BOOTSTRAP_STEP_TIMEOUT_MS,
            {
              progress: () => this.owner.engine.progressMark(),
              onTimeout: (error) => {
                reconciliationTimedOut = true;
                this.recordPostBootstrapTimeout(attemptId, error);
              },
              onLateSuccess: () =>
                this.settlePostBootstrapDiagnostic(attemptId, { ok: true }),
              onLateFailure: (error) =>
                this.settlePostBootstrapDiagnostic(attemptId, {
                  ok: false,
                  error,
                }),
            },
          );
      } catch (error) {
        if (error instanceof HostIdentityConflictError)
          this.recordHostConflict(error);
        if (!reconciliationTimedOut)
          this.startError =
            error instanceof Error ? error.message : String(error);
        throw error;
      }
    })().finally(() => {
      this.bootstrapRunning = null;
    });
    try {
      await this.bootstrapRunning;
    } catch {
      // The caller (timer or start) records the error via startError; the next
      // timer tick retries the whole bootstrap.
    }
    return this.bootstrapped;
  }

  /**
   * One catalog refresh. The runtime's sweep and profile cadence call it, and
   * bootstrap awaits it; coalesced so a tick and a control share one pass.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.owner.engine.refresh();
      this.prStates.refresh();
      if (!this.postBootstrapDiagnostic) this.clearStartError();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * One catalog refresh when a secondary host actually comes online, so its
   * own routing snapshot exists before any host-bound dispatch; steady-state
   * ticks and a disconnected primary change nothing and reject nothing
   * (nucleus#1139 review). Later refreshes ride the periodic profile pass.
   */
  async refreshOnSecondaryArrival(): Promise<void> {
    const online = this.owner.t3Host()?.status().connected === true;
    if (!online || this.secondaryOnline) {
      this.secondaryOnline = online;
      return;
    }
    await this.refresh();
    this.secondaryOnline = true;
  }

  /** Bind a step's outcome to a bound in time; a stalled step fails, retries, and says so. */
  private boundedBootstrapStep<T>(
    step: string,
    work: Promise<T>,
    timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS,
    settlement?: BootstrapStepSettlement,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const startedAt = Date.now();
      let mark = settlement?.progress?.();
      let timer: NodeJS.Timeout;
      let rearmed = false;
      // With a progress signal the timeout bounds a stall: each window that saw
      // progress re-arms it, up to the cap, so a long pass that keeps finishing
      // quanta is not reported as hung. Without one it bounds the whole step.
      const arm = (delayMs = timeoutMs) => {
        timer = setTimeout(() => {
          let progressed = false;
          if (settlement?.progress) {
            const next = settlement.progress();
            progressed = next !== mark;
            mark = next;
            // Re-arm for at most what is left of the cap, so a late window never extends it.
            const remaining =
              BOOTSTRAP_PROGRESS_CAP_MS - (Date.now() - startedAt);
            if (progressed && remaining > 0) {
              rearmed = true;
              arm(Math.min(timeoutMs, remaining));
              return;
            }
          }
          timedOut = true;
          const elapsed = Date.now() - startedAt;
          const capped =
            Boolean(settlement?.progress) &&
            elapsed >= BOOTSTRAP_PROGRESS_CAP_MS;
          const error = new Error(
            progressed || capped
              ? `${step} did not settle inside ${BOOTSTRAP_PROGRESS_CAP_MS} ms`
              : rearmed
                ? `${step} made no progress for ${timeoutMs} ms (running ${elapsed} ms)`
                : `${step} did not settle inside ${timeoutMs} ms`,
          );
          settlement?.onTimeout?.(error);
          reject(error);
        }, delayMs);
        if (typeof timer.unref === "function") timer.unref();
      };
      arm();
      work.then(
        (value) => {
          clearTimeout(timer);
          if (timedOut) settlement?.onLateSuccess?.();
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          const failure =
            error instanceof Error ? error : new Error(String(error));
          if (timedOut) settlement?.onLateFailure?.(failure);
          reject(failure);
        },
      );
    });
  }

  private recordPostBootstrapTimeout(attemptId: number, error: Error): void {
    this.startError = error.message;
    this.postBootstrapDiagnostic = {
      attemptId,
      message: error.message,
      startErrorRevision: this.startErrorRevision,
    };
  }

  private settlePostBootstrapDiagnostic(
    attemptId: number,
    outcome: { ok: true } | { ok: false; error: Error },
  ): void {
    const diagnostic = this.postBootstrapDiagnostic;
    if (!diagnostic || diagnostic.attemptId !== attemptId) return;
    if (
      this.startErrorRevision !== diagnostic.startErrorRevision ||
      this.startError !== diagnostic.message
    ) {
      this.postBootstrapDiagnostic = null;
      return;
    }
    if (outcome.ok) {
      this.postBootstrapDiagnostic = null;
      this.clearStartError();
    } else {
      this.startError = outcome.error.message;
      this.postBootstrapDiagnostic = {
        attemptId,
        message: outcome.error.message,
        startErrorRevision: this.startErrorRevision,
      };
    }
  }

  /** A completed full wake is an owned followup that can settle an older timeout. */
  wakeAndSettlePostBootstrapTimeout(): Promise<void> {
    const diagnostic = this.postBootstrapDiagnostic;
    const work = this.owner.engine.wake();
    if (!diagnostic)
      return work.catch(() => {
        /* recorded as engineError */
      });
    return work.then(
      () => {
        this.settlePostBootstrapDiagnostic(diagnostic.attemptId, { ok: true });
      },
      (error) => {
        // Every caller is fire-and-forget: the diagnostic and engineError record the failure.
        this.settlePostBootstrapDiagnostic(diagnostic.attemptId, {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );
  }

  /** Connect with a hard bound so an unreachable daemon cannot block lifecycle. */
  private boundedConnect(): Promise<void> {
    const timeoutMs = this.owner.connectTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Daemon connection did not settle inside ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );
      if (typeof timer.unref === "function") timer.unref();
      (this.owner.adapter as unknown as { connect(): Promise<void> })
        .connect()
        .then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
  }

  /** A conflict born of the configured daemon disagreeing with the recorded host. */
  private refusal(message: string): HostIdentityConflictError {
    return new HostIdentityConflictError("identity", message);
  }

  private recordHostConflict(error: HostIdentityConflictError): void {
    this.identityConflict = {
      kind: error.kind,
      hostId: this.owner.hostRegistry.primary()?.id ?? null,
      message: error.message,
      at: new Date().toISOString(),
    };
  }

  /** A settled start error is also a settled conflict; both are the same readiness fact. */
  private clearStartError(): void {
    this.identityConflict = null;
    this.startError = "";
  }
}
