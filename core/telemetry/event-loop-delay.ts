import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface EventLoopDelayReport {
  /** Seconds the reported window covers. */
  windowSeconds: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Worst delay since the monitor started. */
  maxSinceStartMs: number;
}

const WINDOW_MS = 60_000;
const MIN_REPORT_MS = 15_000;
const RESOLUTION_MS = 10;
const excessMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e4) / 100 - RESOLUTION_MS);
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Event-loop delay of the thread that constructs it. In the standalone service
 * that is the runtime executor worker, which also serves the host-run endpoint,
 * so a synchronous store read shows up here as delay before it shows up as a
 * slow endpoint reply. Reports the last full window (or the current one once it
 * is long enough), so a single health read is never empty or a few seconds wide.
 */
export class EventLoopDelayMonitor {
  private histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  private windowStartedAt = Date.now();
  private previous: EventLoopDelayReport | null = null;
  private maxSinceStart = 0;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.windowStartedAt = Date.now();
    this.histogram.enable();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.histogram.disable();
  }

  report(now = Date.now()): EventLoopDelayReport {
    const age = now - this.windowStartedAt;
    const current = this.read(age);
    if (age >= WINDOW_MS) {
      this.previous = current;
      this.histogram.reset();
      this.windowStartedAt = now;
    }
    return age >= MIN_REPORT_MS || !this.previous ? current : this.previous;
  }

  private read(ageMs: number): EventLoopDelayReport {
    const empty = this.histogram.count === 0;
    // The histogram records timer lateness with its resolution folded in; report the excess.
    const max = empty ? 0 : round2(excessMs(this.histogram.max));
    this.maxSinceStart = Math.max(this.maxSinceStart, max);
    return {
      windowSeconds: Math.round(ageMs / 1000),
      p50Ms: empty ? 0 : round2(excessMs(this.histogram.percentile(50))),
      p99Ms: empty ? 0 : round2(excessMs(this.histogram.percentile(99))),
      maxMs: max,
      maxSinceStartMs: this.maxSinceStart,
    };
  }
}
