/**
 * Queue-private admission RPC metrics (Spec 035, "Admission RPC metrics").
 *
 * The question these numbers answer is narrow: when a heavy admission sat in a
 * still-queued wait for eighteen minutes and was then denied, was the service
 * slow to answer, did it answer replies the hook never received, or were the
 * hook's own confirms arriving late? Every number below is memory-only and
 * collected when a request arrives, so a service health read costs nothing and
 * no per-beat row, journal entry or watch is added.
 *
 * What each part measures — and deliberately does not:
 * - `processing` is the service's own dispatch duration, measured on the
 *   service thread from the parsed request line to the reply being handed to
 *   the socket. It is server processing only.
 * - `delivery` counts reply lines the service wrote and lines it could not hand
 *   to the socket at all (the client was already gone). A reply written into a
 *   socket the client had already abandoned is indistinguishable on this side,
 *   so the hook's own bound stays the only authority on its timeouts.
 * - `confirmCadence` is the interval between two confirms this service processed
 *   for the same reservation on its own clock. A late confirm shows here as a
 *   gap without reading any history, and it is a service-side inference of the
 *   hook's cadence, not a client roundtrip measurement.
 *
 * No run id, reservation id, selector, path, credential, output or environment
 * value is published, and no map here grows without a bound: the per-reservation
 * confirm clock keeps at most `ADMISSION_RPC_TRACKED_RESERVATIONS` entries, the
 * oldest dropped first, and each latency window keeps its last
 * `ADMISSION_RPC_SAMPLE_WINDOW` samples.
 */
import { ADMISSION_CONFIRM_INTERVAL_MS, ADMISSION_LIVENESS_MS } from "./effigy-admission";

export const ADMISSION_RPC_METHODS = ["reserve", "status", "confirm", "bind-hook"] as const;
export type AdmissionRpcMethod = (typeof ADMISSION_RPC_METHODS)[number];

/** Latency samples retained per method and for the confirm cadence. */
export const ADMISSION_RPC_SAMPLE_WINDOW = 64;
/** Reservations whose last confirm arrival is remembered for the cadence gap. */
export const ADMISSION_RPC_TRACKED_RESERVATIONS = 512;

/** The same bounded latency shape the Paseo admission classes publish. */
export interface AdmissionRpcLatency {
  /** Samples retained in this window (at most `ADMISSION_RPC_SAMPLE_WINDOW`). */
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface AdmissionRpcMethodMetrics {
  /** Request lines this service read and recognised for this method. */
  requests: number;
  /** Reply lines handed to the socket. */
  replies: number;
  /** Replies this service could not hand to the socket: the caller was gone. */
  undelivered: number;
  /** Dispatches that threw instead of returning an observation. */
  errors: number;
  /** Server dispatch duration, this method only. */
  processing: AdmissionRpcLatency;
}

export interface AdmissionRpcMetrics {
  since: string;
  /** Request lines that named no supported method. */
  rejected: number;
  methods: Record<AdmissionRpcMethod, AdmissionRpcMethodMetrics>;
  confirmCadence: {
    /** Intervals observed between two confirms for one live reservation. */
    gaps: number;
    maxGapMs: number | null;
    /** Gaps longer than the 5 s confirmation cadence. */
    overCadence: number;
    /** Gaps longer than the 60 s liveness window: the service was not confirming. */
    overLiveness: number;
    gap: AdmissionRpcLatency;
  };
  /** Fixed statements of what these numbers measure, so health cannot read as inferred truth. */
  notes: string[];
}

const NOTES: readonly string[] = [
  "processing: server dispatch duration on the service thread, from the parsed request line to the reply handed to the socket",
  "delivery: replies this service could not hand to the socket; a reply the caller had already abandoned is not observable from this side",
  "confirmCadence: intervals between confirms this service processed for one reservation, measured on the service clock; a service-side inference of hook cadence, not a client roundtrip",
  "not measured here: client roundtrip latency and client timeouts; the admission hook's own 2 s bound is the only authority on those",
];

interface MethodState {
  requests: number;
  replies: number;
  undelivered: number;
  errors: number;
  samples: number[];
}

function emptyMethodState(): MethodState {
  return { requests: 0, replies: 0, undelivered: 0, errors: 0, samples: [] };
}

/**
 * Bounded, memory-only admission RPC metrics for one endpoint instance. A
 * restarted service publishes numbers from its own start; nothing is stored.
 */
export class AdmissionRpcMetricsRecorder {
  readonly sinceMs: number;
  private rejected = 0;
  private readonly methods = new Map<AdmissionRpcMethod, MethodState>(
    ADMISSION_RPC_METHODS.map(method => [method, emptyMethodState()]),
  );
  private readonly confirmLastAtMs = new Map<string, number>();
  private confirmGaps = 0;
  private maxGapMs: number | null = null;
  private overCadence = 0;
  private overLiveness = 0;
  private readonly gapSamples: number[] = [];

  constructor(
    private readonly now: () => number,
    private readonly overCadenceMs = ADMISSION_CONFIRM_INTERVAL_MS,
    private readonly overLivenessMs = ADMISSION_LIVENESS_MS,
  ) {
    this.sinceMs = now();
  }

  recordRequest(method: AdmissionRpcMethod): void {
    this.state(method).requests++;
  }

  recordRejected(): void {
    this.rejected++;
  }

  /** Monotonic server dispatch duration for this method. */
  recordProcessing(method: AdmissionRpcMethod, ms: number): void {
    pushBounded(this.state(method).samples, ms);
  }

  /** Whether the reply line reached the socket at all. */
  recordReply(method: AdmissionRpcMethod, delivered: boolean): void {
    const state = this.state(method);
    if (delivered) state.replies++;
    else state.undelivered++;
  }

  recordError(method: AdmissionRpcMethod): void {
    this.state(method).errors++;
  }

  /**
   * One confirm the service answered for `reservationId`, on the service clock.
   * The gap is only recorded between two confirms for the same live
   * reservation; a reservation this service stopped observing is forgotten here
   * too, so the map stays bounded by live reservations and by its own cap.
   */
  recordConfirm(reservationId: string, atMs: number): void {
    const previous = this.confirmLastAtMs.get(reservationId);
    this.confirmLastAtMs.delete(reservationId);
    this.confirmLastAtMs.set(reservationId, atMs);
    while (this.confirmLastAtMs.size > ADMISSION_RPC_TRACKED_RESERVATIONS) {
      const oldest = this.confirmLastAtMs.keys().next();
      if (oldest.done) break;
      this.confirmLastAtMs.delete(oldest.value);
    }
    if (previous === undefined) return;
    const gap = atMs - previous;
    // A clock that stepped backwards is not a gap; it is not evidence of late confirms.
    if (gap < 0) return;
    this.confirmGaps++;
    this.maxGapMs = this.maxGapMs === null ? gap : Math.max(this.maxGapMs, gap);
    if (gap > this.overCadenceMs) this.overCadence++;
    if (gap > this.overLivenessMs) this.overLiveness++;
    pushBounded(this.gapSamples, gap);
  }

  /** The service stopped observing this reservation, so its confirm clock is dropped. */
  forgetReservation(reservationId: string): void {
    this.confirmLastAtMs.delete(reservationId);
  }

  snapshot(): AdmissionRpcMetrics {
    const methods = {} as Record<AdmissionRpcMethod, AdmissionRpcMethodMetrics>;
    for (const method of ADMISSION_RPC_METHODS) {
      const state = this.state(method);
      methods[method] = {
        requests: state.requests,
        replies: state.replies,
        undelivered: state.undelivered,
        errors: state.errors,
        processing: latency(state.samples),
      };
    }
    return {
      since: new Date(this.sinceMs).toISOString(),
      rejected: this.rejected,
      methods,
      confirmCadence: {
        gaps: this.confirmGaps,
        maxGapMs: this.maxGapMs,
        overCadence: this.overCadence,
        overLiveness: this.overLiveness,
        gap: latency(this.gapSamples),
      },
      notes: [...NOTES],
    };
  }

  private state(method: AdmissionRpcMethod): MethodState {
    let state = this.methods.get(method);
    if (!state) {
      state = emptyMethodState();
      this.methods.set(method, state);
    }
    return state;
  }
}

function pushBounded(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > ADMISSION_RPC_SAMPLE_WINDOW) samples.splice(0, samples.length - ADMISSION_RPC_SAMPLE_WINDOW);
}

function latency(samples: readonly number[]): AdmissionRpcLatency {
  return {
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.length ? Math.max(...samples) : null,
  };
}

function percentile(samples: readonly number[], fraction: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
