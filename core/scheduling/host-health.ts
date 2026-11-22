import { isHostOperationTimeout } from "../host/errors";
import { isTransportFailure } from "../../shared/transport";
import { hostDisplayLabel } from "../../shared/host-outage";
import type { HostOutages } from "./host-outage";

/**
 * Spec 069 §2: what one host's connection says about it.
 *
 * - `up`: connected, and its host passes answer.
 * - `degraded`: connected, but its last few host passes each hung or failed at
 *   the transport.
 * - `down`: the connection is lost. Each connection owns its own short heartbeat
 *   window (T3 closes its socket after two missed heartbeats), so a lost
 *   connection is already the window's verdict.
 * - `unknown`: not yet seen connected since this service started.
 */
export type HostHealthState = "up" | "degraded" | "down" | "unknown";

export type HostHealthReading = {
  state: HostHealthState;
  /** When the host entered this state. */
  since: string;
  /** The last hung or transport-failed call on the connection, for diagnostics only. */
  detail: string | null;
};

/** How long a service start waits for a host to connect before it reads as down. */
export const HOST_HEALTH_STARTUP_GRACE_MS = 5 * 60_000;
/** Consecutive failed host passes that make a connected host degraded. */
export const HOST_DEGRADED_AFTER_FAILED_PASSES = 3;

type Entry = {
  state: HostHealthState;
  since: number;
  /** Consecutive host passes whose own steps hung or failed at the transport. */
  failedPasses: number;
  /** The last hung or failed call; diagnostics only, never a state change. */
  detail: string | null;
  /** First dispatches to this host in flight now, by task id. */
  launching: Set<string>;
};

/**
 * The one owner of each host's health (Spec 069 §2). It reads only the
 * connection's own signals: the registry claim and the socket state behind it.
 *
 * - A single call outcome never changes state (Spec 067 batch 5: "not one call");
 *   it is kept only as diagnostic detail.
 * - A connected host is `degraded` only after three consecutive host passes whose
 *   own steps hung or failed at the transport; the first clean pass makes it `up`.
 * - Nothing a call, a pass or a task record says can make a host `down`.
 *
 * Readings are in memory. The durable host-outage record is written only when a
 * host moves into or out of `down`, so an outage costs one write however many
 * passes, calls or tasks observe it. A fresh service starts every host at
 * `unknown`: until the host has been seen connected (or the startup grace ends)
 * nothing is written for its tasks.
 */
export class HostHealth {
  /**
   * The service start's connect window. The engine alone has no start to wait
   * out, so it begins at 0; the service runtime sets the real window.
   */
  startupGraceMs = 0;
  private readonly startedAt = Date.now();
  private readonly hosts = new Map<string, Entry>();

  constructor(
    /** The connection's own reading: a live registry claim on an open socket. */
    private readonly connected: (hostId: string) => boolean,
    private readonly outages: HostOutages,
  ) {}

  /** Read one host's connection now and move its state, writing only on a `down` transition. */
  read(hostId: string, at = Date.now()): HostHealthReading {
    const entry = this.entry(hostId, at);
    let next: HostHealthState;
    if (this.connected(hostId)) {
      // A new connection starts clean: an earlier session's failed passes say
      // nothing about this one.
      if (entry.state === "down" || entry.state === "unknown") {
        entry.failedPasses = 0;
        entry.detail = null;
      }
      next =
        entry.failedPasses >= HOST_DEGRADED_AFTER_FAILED_PASSES
          ? "degraded"
          : "up";
    } else
      next =
        entry.state === "unknown" && at - this.startedAt < this.startupGraceMs
          ? "unknown"
          : "down";
    this.move(hostId, entry, next, at);
    return this.reading(entry);
  }

  /** Connected now, whether `up` or `degraded`: running and observed work goes on. */
  connectedNow(hostId: string): boolean {
    const state = this.read(hostId).state;
    return state === "up" || state === "degraded";
  }

  /**
   * One call on this host timed out or failed at the transport. It fails only its
   * own step and never changes the host's state; the detail is kept for
   * diagnostics. Self-inflicted load (our own queue's abandonment or pending cap)
   * is not about the host and is ignored.
   */
  callFailed(hostId: string, error: unknown, at = Date.now()): void {
    if (!hostCallFault(error)) return;
    // Settle the connection first, so a fresh connection's reset keeps this detail.
    this.read(hostId, at);
    this.entry(hostId, at).detail = callFaultDetail(error);
  }

  /**
   * A host pass whose own step hung or failed at the transport. A pass that failed
   * on our own queue's load is neutral: it neither advances nor resets the count.
   */
  passFailed(hostId: string, error: unknown, at = Date.now()): void {
    if (selfInflicted(error)) {
      this.read(hostId, at);
      return;
    }
    if (!hostCallFault(error)) return this.answered(hostId, at);
    this.read(hostId, at);
    const entry = this.entry(hostId, at);
    entry.failedPasses++;
    entry.detail = callFaultDetail(error);
    this.read(hostId, at);
  }

  /** A clean host pass: the first healthy reading resets the count and clears `degraded`. */
  answered(hostId: string, at = Date.now()): void {
    const entry = this.hosts.get(hostId);
    if (entry) {
      entry.failedPasses = 0;
      entry.detail = null;
    }
    this.read(hostId, at);
  }

  /**
   * The one launch rule. An `up` host admits every first dispatch; a `degraded`
   * host admits one at a time, so a hung host cannot absorb many while a busy but
   * healthy one keeps flowing; a `down` or `unknown` host admits none. Returns the
   * wait a never-started task shows, or null when it may launch. `taskId` is the
   * task asking, which never waits on its own launch.
   */
  launchWait(hostId: string, taskId?: string, at = Date.now()): string | null {
    const health = this.read(hostId, at);
    if (health.state === "up") return null;
    if (health.state === "degraded") {
      const others = [...this.entry(hostId, at).launching].filter(
        (id) => id !== taskId,
      );
      if (!others.length) return null;
    }
    return healthWait(hostId, health);
  }

  /** Record a first dispatch to this host as in flight; `launchSettled` ends it. */
  launchStarted(hostId: string, taskId: string, at = Date.now()): void {
    this.entry(hostId, at).launching.add(taskId);
  }

  /** The task's first dispatch returned, launched or not. */
  launchSettled(taskId: string): void {
    for (const entry of this.hosts.values()) entry.launching.delete(taskId);
  }

  private entry(hostId: string, at: number): Entry {
    let entry = this.hosts.get(hostId);
    if (!entry) {
      entry = {
        state: "unknown",
        since: at,
        failedPasses: 0,
        detail: null,
        launching: new Set(),
      };
      this.hosts.set(hostId, entry);
    }
    return entry;
  }

  private move(
    hostId: string,
    entry: Entry,
    next: HostHealthState,
    at: number,
  ): void {
    if (entry.state === next) return;
    const previous = entry.state;
    entry.state = next;
    entry.since = at;
    if (next === "down") this.outages.observe(hostId, false, iso(at));
    // Leaving `down`, or a first reading after a restart that inherited an outage
    // record, closes it; `unknown` writes nothing either way.
    else if (next !== "unknown" && previous !== "up" && previous !== "degraded")
      this.outages.observe(hostId, true, iso(at));
  }

  private reading(entry: Entry): HostHealthReading {
    const connected = entry.state === "up" || entry.state === "degraded";
    return {
      state: entry.state,
      since: iso(entry.since),
      detail: connected ? entry.detail : null,
    };
  }
}

/**
 * The wait a never-started task shows for a host that does not admit it now. It
 * carries no call error text, so it is stable for the episode; the error stays in
 * the health reading's `detail`.
 */
export function healthWait(hostId: string, health: HostHealthReading): string {
  const host = hostDisplayLabel(hostId);
  switch (health.state) {
    case "unknown":
      return `Waiting for ${host} to connect after the service start`;
    case "degraded":
      return `Waiting for ${host}: its calls are not answering, so it takes one launch at a time`;
    default:
      return `Waiting for ${host} to reconnect`;
  }
}

/** Errors that measure Nucleus's own queue, not the host. */
const SELF_INFLICTED = new Set([
  "HostExecutorUnavailableError",
  "HostCallAbandonedError",
]);

function selfInflicted(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8) return false;
  if (SELF_INFLICTED.has(error.name)) return true;
  return error.cause !== error && selfInflicted(error.cause, depth + 1);
}

/** A hung call or a transport failure on the host: what a failed host pass counts. */
function hostCallFault(error: unknown): boolean {
  if (selfInflicted(error)) return false;
  return (
    isHostOperationTimeout(error) ||
    (error instanceof Error && error.name === "HostTransportFault") ||
    isTransportFailure(error)
  );
}

function callFaultDetail(error: unknown): string {
  const leaf = (value: unknown): unknown =>
    value instanceof Error && value.name === "HostTransportFault" && value.cause
      ? leaf(value.cause)
      : value;
  const source = leaf(error);
  return (source instanceof Error ? source.message : String(source)).slice(
    0,
    300,
  );
}

const iso = (at: number) => new Date(at).toISOString();
