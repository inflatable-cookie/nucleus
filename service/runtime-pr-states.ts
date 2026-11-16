/**
 * The display-only PR-state observation: the board's `prStates` badges.
 *
 * A read is one fact about the fleet's pull requests, never merge or review
 * authority. This owner keeps the last successful map and the outcome of the
 * latest attempt, so a failed read is an explicit unknown that names its reason
 * instead of publishing an empty map that reads as "no open pull requests"
 * (blind calibration #1263 of `service/runtime-owner.ts`).
 */
import type { PrState } from "../core/forge/pr-status";
import type { Task } from "../shared/contracts";

/** The latest read outcome. The map is the last one that read successfully and survives a failure. */
export type PrStateRead =
  | { state: "known"; readAt: string }
  | {
      state: "unknown";
      readAt: string | null;
      reason: string;
      lastKnownAt: string | null;
    };

/** What `service.health` reports about the observation: an unknown read is named, never an empty map. */
export interface PrStateFacts {
  state: "known" | "unknown";
  /** Why the latest attempt is unknown; null when it succeeded. */
  reason: string | null;
  /** When the latest attempt ran; null before the first one. */
  readAt: string | null;
  /** When the map was last read successfully; null when it never was. */
  lastKnownAt: string | null;
}

/** The read's ports: the tasks worth reading, the forge read, publication and its clock. */
export interface PrStatesContext {
  /** Tasks whose PR state is worth reading (display only). */
  tasks(): Task[];
  /** One forge read; it rejects when the read as a whole did not settle. */
  read(tasks: Task[]): Promise<Record<string, PrState>>;
  /** The closing runtime publishes nothing more. */
  closing(): boolean;
  /** A published map changed: the board's durable revision advances. */
  changed(): void;
  /** Fixture clock; production uses wall time. */
  now?(): Date;
}

export class PrStates {
  private readonly context: PrStatesContext;
  private statesValue: Record<string, PrState> = {};
  private readValue: PrStateRead = {
    state: "unknown",
    readAt: null,
    reason: "PR states have not been read yet",
    lastKnownAt: null,
  };
  private lastKnownAt: string | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(context: PrStatesContext) {
    this.context = context;
  }

  /** The map the board shows: the last successful read, empty only before the first one. */
  states(): Record<string, PrState> {
    return this.statesValue;
  }

  /** The latest outcome, for `service.health`; a failed read stays unknown and names its reason. */
  facts(): PrStateFacts {
    const read = this.readValue;
    return read.state === "known"
      ? {
          state: "known",
          reason: null,
          readAt: read.readAt,
          lastKnownAt: this.lastKnownAt,
        }
      : {
          state: "unknown",
          reason: read.reason,
          readAt: read.readAt,
          lastKnownAt: read.lastKnownAt,
        };
  }

  /**
   * One coalesced read. A failure keeps the last known map in place: replacing it
   * with an empty one would report every open pull request as absent.
   */
  refresh(): void {
    if (this.refreshing || this.context.closing()) return;
    this.refreshing = this.context
      .read(this.context.tasks())
      .then(
        (states) => this.publish(states),
        (error) => this.fail(error),
      )
      .finally(() => {
        this.refreshing = null;
      });
  }

  private publish(states: Record<string, PrState>): void {
    if (this.context.closing()) return;
    const at = this.clock();
    this.lastKnownAt = at;
    this.readValue = { state: "known", readAt: at };
    if (JSON.stringify(states) === JSON.stringify(this.statesValue)) return;
    this.statesValue = states;
    this.context.changed();
  }

  private fail(error: unknown): void {
    if (this.context.closing()) return;
    // The map stays at its last known states; the unknown is the read itself and is named.
    this.readValue = {
      state: "unknown",
      readAt: this.clock(),
      reason: error instanceof Error ? error.message : String(error),
      lastKnownAt: this.lastKnownAt,
    };
  }

  private clock(): string {
    return (this.context.now?.() ?? new Date()).toISOString();
  }
}
