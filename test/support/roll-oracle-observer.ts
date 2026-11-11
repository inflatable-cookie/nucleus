/**
 * Real-socket probe on its own event loop (test-only observer for the roll
 * oracles). The probe previously ran on the test executor's event loop beside
 * bridge and fixture orchestration, so a main-thread stall — a bridge hashing
 * its whole backend build identity, a board publish — paused the probe itself
 * and the window then failed the 100 ms coverage bound on code-owned silence
 * with no endpoint refusal behind it (2026-10-21 review, 102/534 ms and
 * 120/190 ms coverage gaps).
 *
 * The worker performs the same real connects at the same cadence and records
 * each sample on its own monotonic clock. Timestamps are mapped onto the
 * test's clock through each context's constant wall-to-monotonic offset, so
 * values stay monotonic and comparable; the mapping is exact unless the wall
 * clock is stepped between spawn and stop, which would show as an impossible
 * sample order and fail the observation honestly. Nothing here synthesizes or
 * drops evidence: samples accrue for the whole observer lifetime, flushes are
 * incremental and index-checked, a still-pending connect at stop is simply
 * unobserved, and silence beyond the coverage bound still fails the window.
 */
import { Worker } from "node:worker_threads";

export interface ProbeSample { at: number; ok: boolean; code?: string }

export interface ProbeObserver {
  /** Every observed sample of this observer's lifetime, in observation order. */
  samples: ProbeSample[];
  /** Wait until every sample observed so far has been delivered to `samples`. */
  flush(): Promise<void>;
  /** Stop the probe, deliver remaining samples and settle the worker. Idempotent. */
  stop(): Promise<void>;
}

const WORKER_URL = new URL("./probe-observer.worker.mjs", import.meta.url);
/** How long a stopping worker may finish its pending connect before it is terminated. */
const STOP_GRACE_MS = 2_000;
/** A worker that never becomes ready must not hang the test. */
const READY_BUDGET_MS = 10_000;

interface ProbeWorkerMessage {
  type: "ready" | "samples" | "stopped";
  wallOffset?: number;
  from?: number;
  samples?: Array<{ at: number; ok: boolean; code?: string }>;
}

export function startProbeObserver(socketPath: string): Promise<ProbeObserver> {
  const mainWallOffset = Date.now() - performance.now();
  let workerWallOffset: number | null = null;
  const samples: ProbeSample[] = [];
  let sentCount = 0;
  let stopped = false;
  let stopRequested = false;
  let failure: Error | null = null;
  const startWaiters: Array<() => void> = [];
  const flushWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let stopWaiter: (() => void) | null = null;

  const worker = new Worker(WORKER_URL, { workerData: { socketPath } });
  worker.unref();

  const fail = (error: Error) => {
    if (failure || stopped) return;
    failure = error;
    for (const waiter of startWaiters.splice(0)) waiter();
    for (const waiter of flushWaiters.splice(0)) waiter.reject(error);
    const pendingStop = stopWaiter;
    stopWaiter = null;
    pendingStop?.();
  };

  const absorb = (incoming: { from: number; samples: Array<{ at: number; ok: boolean; code?: string }> }) => {
    if (incoming.from !== sentCount) throw new Error(`probe observer lost samples: worker sent from ${incoming.from}, expected ${sentCount}`);
    if (workerWallOffset === null) throw new Error("probe observer delivered samples before the clock handshake");
    sentCount += incoming.samples.length;
    for (const sample of incoming.samples) {
      samples.push({ at: sample.at + workerWallOffset - mainWallOffset, ok: sample.ok, code: sample.code });
    }
  };

  worker.on("message", (message: ProbeWorkerMessage) => {
    try {
      if (message.type === "ready") {
        if (typeof message.wallOffset !== "number") throw new Error("probe observer handshake without a clock offset");
        workerWallOffset = message.wallOffset;
        const readyTimeout = readyBudget;
        clearTimeout(readyTimeout);
        for (const waiter of startWaiters.splice(0)) waiter();
        return;
      }
      if (message.type === "samples") {
        absorb({ from: message.from ?? -1, samples: message.samples ?? [] });
        flushWaiters.shift()?.resolve();
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
    if (!stopRequested) fail(new Error(`probe observer exited unexpectedly (code ${code})`));
    const pendingStop = stopWaiter;
    stopWaiter = null;
    pendingStop?.();
  });

  const readyBudget = setTimeout(() => fail(new Error("probe observer did not report ready")), READY_BUDGET_MS);
  readyBudget.unref();

  const started = new Promise<void>((resolve, reject) => {
    startWaiters.push(() => { if (failure) reject(failure); else resolve(); });
  });

  return started.then(() => ({
    samples,
    flush(): Promise<void> {
      if (failure) return Promise.reject(failure);
      if (stopped) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        // The worker answers flushes in message order, so concurrent callers
        // resolve FIFO against incremental, index-checked deliveries.
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
          worker.terminate();
          pendingStop?.();
        }, STOP_GRACE_MS);
        grace.unref();
      });
    },
  }));
}
