/**
 * An isolated accept probe on its own event loop (test-only fixture for
 * `test/host-run-accept-isolation.test.ts` and the front-worker tests).
 *
 * The probe's whole point is that it keeps sampling while the test process's
 * runtime thread is deliberately blocked (`Atomics.wait`), so its samples and its
 * held client's reply instants come from its own monotonic clock and are mapped
 * onto the test's clock through the constant wall-to-monotonic offset published at
 * startup. Nothing is synthesized: only completed connects become samples, and a
 * reply that never arrives stays `null`.
 */
import { Worker } from "node:worker_threads";

export interface ProbeSample { at: number; ok: boolean; code?: string }

export interface HeldClientObservation {
  /** When the held client's connect completed, on the test's clock. */
  connectedAt: number | null;
  /** When its request line was written. */
  wroteAt: number | null;
  /** When its reply line arrived. */
  replyAt: number | null;
  /** The reply line, verbatim, or null. */
  line: string | null;
  /** The connect error code, or the socket error, or null. */
  error: string | null;
}

export interface AcceptProbe {
  samples: ProbeSample[];
  /** The held client's observation; only complete after `stop()`. */
  held(): HeldClientObservation;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

const WORKER_URL = new URL("./accept-probe.worker.mjs", import.meta.url);
const STOP_GRACE_MS = 5_000;
const READY_BUDGET_MS = 10_000;

interface RawHeld { connectedAt: number | null; wroteAt: number | null; replyAt: number | null; line: string | null; error: string | null }

export function startAcceptProbe(
  socketPath: string,
  options: { probeMs?: number; holdAfterMs?: number; request?: unknown } = {},
): Promise<AcceptProbe> {
  const mainWallOffset = Date.now() - performance.now();
  let workerWallOffset: number | null = null;
  const samples: ProbeSample[] = [];
  let sentCount = 0;
  let rawHeld: RawHeld = { connectedAt: null, wroteAt: null, replyAt: null, line: null, error: null };
  let stopped = false;
  let stopRequested = false;
  let failure: Error | null = null;
  const startWaiters: Array<() => void> = [];
  const flushWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let stopWaiter: (() => void) | null = null;

  const worker = new Worker(WORKER_URL, {
    workerData: {
      socketPath,
      probeMs: options.probeMs ?? 4,
      holdAfterMs: options.holdAfterMs ?? 100,
      request: `${JSON.stringify(options.request ?? { v: 1, id: "held-probe", method: "status", epoch: 1, body: {} })}\n`,
    },
  });

  const fail = (error: Error) => {
    if (failure || stopped) return;
    failure = error;
    for (const waiter of startWaiters.splice(0)) waiter();
    for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
    const pendingStop = stopWaiter;
    stopWaiter = null;
    pendingStop?.();
  };

  const map = (at: number | null) => (at === null || workerWallOffset === null ? null : at + workerWallOffset - mainWallOffset);

  worker.on("message", message => {
    try {
      if (message.type === "ready") {
        if (typeof message.wallOffset !== "number") throw new Error("accept probe handshake without a clock offset");
        workerWallOffset = message.wallOffset;
        clearTimeout(readyBudget);
        for (const waiter of startWaiters.splice(0)) waiter();
        return;
      }
      if (message.type === "samples") {
        if (message.from !== sentCount) throw new Error(`accept probe lost samples: worker sent from ${message.from}, expected ${sentCount}`);
        if (workerWallOffset === null) throw new Error("accept probe delivered samples before the clock handshake");
        sentCount += message.samples.length;
        for (const sample of message.samples) samples.push({ at: sample.at + workerWallOffset - mainWallOffset, ok: sample.ok, code: sample.code });
        flushWaiters.shift()?.resolve();
        return;
      }
      if (message.type === "held") {
        rawHeld = message.held as RawHeld;
        return;
      }
      if (message.type === "stopped") {
        const pendingStop = stopWaiter;
        stopWaiter = null;
        pendingStop?.();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  worker.on("error", error => fail(error instanceof Error ? error : new Error(String(error))));
  worker.on("exit", code => {
    if (!stopRequested) fail(new Error(`accept probe exited unexpectedly (code ${code})`));
    const pendingStop = stopWaiter;
    stopWaiter = null;
    pendingStop?.();
  });

  const readyBudget = setTimeout(() => fail(new Error("accept probe did not report ready")), READY_BUDGET_MS);
  readyBudget.unref?.();

  const started = new Promise<void>((resolve, reject) => {
    startWaiters.push(() => { if (failure) reject(failure ?? new Error("accept probe failed")); else resolve(); });
  });

  return started.then(() => ({
    samples,
    held(): HeldClientObservation {
      return {
        connectedAt: map(rawHeld.connectedAt),
        wroteAt: map(rawHeld.wroteAt),
        replyAt: map(rawHeld.replyAt),
        line: rawHeld.line,
        error: rawHeld.error,
      };
    },
    flush(): Promise<void> {
      if (failure) return Promise.reject(failure);
      if (stopped) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        flushWaiters.push({ resolve, reject });
        worker.postMessage({ type: "flush" });
      });
    },
    stop(): Promise<void> {
      if (stopped) return Promise.resolve();
      stopped = true;
      return new Promise<void>(resolve => {
        stopWaiter = () => resolve();
        worker.postMessage({ type: "stop" });
        const grace = setTimeout(() => {
          const pendingStop = stopWaiter;
          stopWaiter = null;
          void worker.terminate();
          pendingStop?.();
        }, STOP_GRACE_MS);
        grace.unref?.();
      });
    },
  }));
}
