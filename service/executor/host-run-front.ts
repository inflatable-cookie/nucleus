import { runtimeEntry } from "../../shared/runtime.mjs";
/**
 * Parent side of the host-run front worker (Spec 035, "Accepts off the runtime
 * loop"). The worker owns the public contract-010 listener and pipes accepted
 * clients to this runtime's private inner socket; see
 * `service/executor/host-run-front-worker.ts` for the thread itself.
 *
 * This handle keeps the worker's last reported state (bound inode and the bind,
 * answer and swap instants), asks it to re-assert a lost live path, and settles
 * it on stop. Nothing here synthesizes evidence: an accepting front is only
 * evidence that connects succeed, so the endpoint still publishes authority and
 * health from its own bound inner socket and a front fault is reported, never
 * hidden.
 */
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { hostRunInnerSocketPath } from "../../core/host-runs/host-run-paths";

export interface HostRunFrontOptions {
  stateDir: string;
  /** The contract socket path; the worker refuses anything but the derived path. */
  socketPath: string;
  /**
   * The warm standby's make-before-break bind (Spec 035, "Endpoint across a
   * roll"): take the live path from the outgoing process deliberately, instead
   * of refusing a live holder and clearing a stale socket as a fresh bind does.
   */
  takeLivePath?: boolean;
  /** Test seam: cadence of the private-connection retry while the runtime is not listening. */
  innerRetryMs?: number;
  /** Test seam: bound on holding a client whose private connection never succeeds. */
  innerWaitMs?: number;
  /** Test seam: chmod the live path after the swap, before the chain check. */
  testAfterBindChmod?: number;
}

export interface HostRunFrontState {
  /** The live path currently names this front's listening inode. */
  serving: boolean;
  /** Why this front is not serving, or null. */
  error: string | null;
  /** Inode of the socket this front bound; null before its first bind. */
  ino: number | null;
  /** Contract-010 evidence instants; the parent journals them. */
  boundAt: string | null;
  answeredAt: string | null;
  swappedAt: string | null;
  /** Clients the front closed because the private socket never answered. */
  abandoned: number;
  /** Clients this front currently holds open (piped or waiting for the runtime). */
  held: number;
  /** The last ensure replaced the live path's inode (a reassert, not a no-op). */
  rebound: boolean;
}

const WORKER_URL = new URL(runtimeEntry("./host-run-front-worker.ts"), import.meta.url);
/** A front that has not bound inside this budget did not start. */
const BIND_BUDGET_MS = 30_000;
/** An ensure round trip that does not answer inside this budget is reported, not waited on. */
const ENSURE_BUDGET_MS = 30_000;
/** A stopping front gets this long to close its listener before it is terminated. */
const STOP_GRACE_MS = 5_000;

interface StateFrame extends HostRunFrontState { kind: "state" | "bound"; request?: number }

interface PendingEnsure { resolve: (state: HostRunFrontState) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const emptyState = (): HostRunFrontState => ({ serving: false, error: null, ino: null, boundAt: null, answeredAt: null, swappedAt: null, abandoned: 0, held: 0, rebound: false });

export class HostRunFront {
  private readonly snapshot: HostRunFrontState = emptyState();
  private readonly acceptedListeners: Array<() => void> = [];
  private readonly pendingEnsures = new Map<number, PendingEnsure>();
  private nextEnsureId = 1;
  private bindWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private stopWaiter: (() => void) | null = null;
  private exited = false;
  private stopping = false;

  private constructor(
    private readonly worker: Worker,
    readonly stateDir: string,
    readonly socketPath: string,
    readonly innerToken: string,
  ) {
    worker.on("message", frame => this.receive(frame as Record<string, unknown>));
    worker.on("error", error => this.fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", code => {
      this.exited = true;
      if (!this.stopping) this.fail(new Error(`Host-run front worker exited unexpectedly (code ${code})`));
      for (const pending of this.pendingEnsures.values()) { clearTimeout(pending.timer); pending.reject(new Error("Host-run front worker is gone")); }
      this.pendingEnsures.clear();
      const stopped = this.stopWaiter;
      this.stopWaiter = null;
      stopped?.();
    });
  }

  /**
   * Start a front for one state directory. Resolves once the worker has bound
   * and swapped its socket onto the live contract path; rejects with the
   * worker's own refusal (a live holder, a failed chain check) otherwise.
   */
  static start(options: HostRunFrontOptions): Promise<HostRunFront> {
    const innerToken = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const worker = new Worker(WORKER_URL, {
      workerData: {
        stateDir: options.stateDir,
        socketPath: options.socketPath,
        innerToken,
        ...(options.takeLivePath ? { takeLivePath: true } : {}),
        ...(options.innerRetryMs !== undefined ? { innerRetryMs: options.innerRetryMs } : {}),
        ...(options.innerWaitMs !== undefined ? { innerWaitMs: options.innerWaitMs } : {}),
        ...(options.testAfterBindChmod !== undefined ? { testAfterBindChmod: options.testAfterBindChmod } : {}),
      },
    });
    // Deliberately referenced: the accepting owner lives exactly as long as the
    // endpoint that started or adopted it, which settles it on stop.
    const front = new HostRunFront(worker, options.stateDir, options.socketPath, innerToken);
    return new Promise<HostRunFront>((resolve, reject) => {
      const timer = setTimeout(() => {
        front.bindWaiters = [];
        void front.stop();
        reject(new Error(`Host-run front did not bind ${options.socketPath} inside ${BIND_BUDGET_MS} ms`));
      }, BIND_BUDGET_MS);
      timer.unref?.();
      const settle = (error?: Error) => {
        clearTimeout(timer);
        front.bindWaiters = [];
        if (!error) { resolve(front); return; }
        // A front that never bound has no live path to keep: settle the thread so
        // a refused bind leaves no listener, socket or worker behind.
        void front.stop();
        reject(error);
      };
      front.bindWaiters.push({ resolve: () => settle(), reject: (error: Error) => settle(error) });
    });
  }

  /** Where this process's private runtime socket lives. */
  innerSocketPath(): string { return hostRunInnerSocketPath(this.stateDir, this.innerToken); }

  /** The front's last reported state; `serving` is computed on the live path by the caller. */
  state(): HostRunFrontState { return { ...this.snapshot }; }

  /** True once the worker exited; the endpoint then reports the fault instead of serving. */
  dead(): boolean { return this.exited; }

  /** Called on the first client accepted since each bind (contract-010 answer evidence). */
  onAccepted(listener: () => void): void { this.acceptedListeners.push(listener); }

  /**
   * Ask the worker to re-assert the live path (or bind when it never did) and
   * report whether it had to replace its inode. Serialized: one ensure at a time.
   */
  ensure(): Promise<HostRunFrontState> {
    if (this.exited) return Promise.reject(this.snapshot.error ? new Error(this.snapshot.error) : new Error("Host-run front worker is gone"));
    const id = this.nextEnsureId++;
    return new Promise<HostRunFrontState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEnsures.delete(id);
        reject(new Error(`Host-run front did not answer an ensure inside ${ENSURE_BUDGET_MS} ms`));
      }, ENSURE_BUDGET_MS);
      timer.unref?.();
      this.pendingEnsures.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ kind: "ensure", id }); }
      catch (error) {
        clearTimeout(timer);
        this.pendingEnsures.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Close the public listener, drop held clients and settle the worker thread. */
  stop(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.stopping = true;
    if (this.exited) return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.stopWaiter = null;
        resolve();
      };
      this.stopWaiter = finish;
      const grace = setTimeout(() => { void this.worker.terminate().then(finish, finish); }, STOP_GRACE_MS);
      grace.unref?.();
      try { this.worker.postMessage({ kind: "stop" }); }
      catch { void this.worker.terminate().then(finish, finish); }
    });
  }

  private receive(frame: Record<string, unknown>): void {
    const kind = frame.kind;
    if (kind === "bound" || kind === "state") {
      this.absorb(frame as unknown as StateFrame);
      if (kind === "bound") {
        for (const waiter of this.bindWaiters.splice(0)) waiter.resolve();
      }
      const pending = typeof frame.request === "number" ? this.pendingEnsures.get(frame.request) : undefined;
      if (pending) {
        this.pendingEnsures.delete(frame.request as number);
        clearTimeout(pending.timer);
        pending.resolve(this.state());
      }
      return;
    }
    if (kind === "accepted") { for (const listener of this.acceptedListeners) listener(); return; }
    if (kind === "abandoned") {
      this.snapshot.abandoned = Number(frame.count ?? this.snapshot.abandoned);
      console.error(`Host-run front closed ${this.snapshot.abandoned} client(s) whose private runtime socket never answered`);
      return;
    }
    if (kind === "fault") this.fail(new Error(String(frame.message ?? "Host-run front failed")));
  }

  private absorb(frame: StateFrame): void {
    this.snapshot.serving = frame.serving === true;
    this.snapshot.error = typeof frame.error === "string" ? frame.error : null;
    this.snapshot.ino = typeof frame.ino === "number" ? frame.ino : null;
    this.snapshot.boundAt = typeof frame.boundAt === "string" ? frame.boundAt : null;
    this.snapshot.answeredAt = typeof frame.answeredAt === "string" ? frame.answeredAt : null;
    this.snapshot.swappedAt = typeof frame.swappedAt === "string" ? frame.swappedAt : null;
    this.snapshot.abandoned = Number(frame.abandoned ?? this.snapshot.abandoned);
    this.snapshot.held = Number(frame.held ?? this.snapshot.held);
    this.snapshot.rebound = frame.rebound === true;
  }

  private fail(error: Error): void {
    if (!this.snapshot.error) this.snapshot.error = error.message;
    this.snapshot.serving = false;
    const waiters = this.bindWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}
