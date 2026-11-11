/**
 * Spec 058 slice 1: one push stream per unreleased run agent. The sweep tick opens and
 * closes streams; events arrive over the stream and are recorded on the run. Nothing
 * here polls Paseo or changes dispatch, routing, budgets or refusals.
 */
import type { Store } from "../store/store";
import type { Run } from "../../shared/contracts";
import { applyRunUsageEvent, type RunUsageEvent, type RunUsageSource, type RunUsageStream, type RunUsageStreamEvent } from "./run-usage";

interface Tracked { agentId: string; hostId?: string; stream: RunUsageStream | null }

export class RunUsageTracker {
  private readonly tracked = new Map<string, Tracked>();
  /** Runs whose stream lost an event to a failed write; the next open records that gap. */
  private readonly owedGap = new Set<string>();
  private readonly startedAt: number;

  constructor(private readonly store: Store, private readonly source: RunUsageSource, private readonly clock: () => Date = () => new Date(),
    private readonly sourceForRun?: (run: Run) => RunUsageSource | undefined) {
    this.startedAt = this.clock().getTime();
  }

  /**
   * Reconcile streams with the unreleased runs that have agents. A run whose agent
   * changed or whose run settled closes its stream. A stream the daemon released is
   * marked a gap and reopened on this same pass, so a lost stream is never silent.
   */
  sync(): void {
    if (!this.sourceForRun && !this.source.subscribeRunUsage) return;
    // The store's in-memory set of unreleased retained runs: no SQL scan per sweep tick.
    const live = new Map(this.store.pendingRuns().filter(run => !run.released && run.agentId !== null).map(run => [run.id, run] as const));
    for (const [runId, entry] of [...this.tracked]) {
      const run = live.get(runId);
      if (!run || run.agentId !== entry.agentId || run.hostId !== entry.hostId || this.sourceForRun && !this.sourceForRun(run)) this.release(runId);
      else if (entry.stream && entry.stream.subscriptionId === null) { this.release(runId); this.gap(runId); }
    }
    for (const run of live.values()) if (!this.tracked.has(run.id)) this.open(run);
  }

  /** Close every stream. The runtime calls this on shutdown, before the store closes. */
  close(): void {
    for (const runId of [...this.tracked.keys()]) this.release(runId);
  }

  private open(run: Run): void {
    const source = this.sourceForRun ? this.sourceForRun(run) : this.source;
    if (!source?.subscribeRunUsage) return;
    const entry: Tracked = { agentId: run.agentId!, hostId: run.hostId, stream: null };
    this.tracked.set(run.id, entry);
    // A run dispatched before this process started may have turns Queue never observed.
    const predatesProcess = Date.parse(run.createdAt) < this.startedAt;
    source.subscribeRunUsage(entry.agentId, event => this.record(run.id, event)).then(stream => {
      if (this.tracked.get(run.id) !== entry) { stream(); return; }
      entry.stream = stream;
      const owed = this.owedGap.delete(run.id);
      if (predatesProcess || owed) this.gap(run.id);
    }).catch(() => {
      // Establishment failed: the run stays partial and the next pass tries again.
      if (this.tracked.get(run.id) === entry) { this.tracked.delete(run.id); this.gap(run.id); }
    });
  }

  private release(runId: string): void {
    const entry = this.tracked.get(runId);
    if (!entry) return;
    this.tracked.delete(runId);
    entry.stream?.();
  }

  private gap(runId: string): void {
    this.store.updateRunUsage(runId, usage => applyRunUsageEvent(usage, { type: "gap" }, this.at()));
  }

  private record(runId: string, streamed: RunUsageStreamEvent): void {
    const event = toUsageEvent(streamed.event);
    if (!event) return;
    try {
      this.store.updateRunUsage(runId, usage => applyRunUsageEvent(usage, event, this.at()));
    } catch {
      // The store is closing or unavailable: this event is lost. The stream closes and
      // the next pass reopens it with a gap owed, so the run reads partial, not complete.
      this.owedGap.add(runId);
      this.release(runId);
    }
  }

  private at(): string {
    return this.clock().toISOString();
  }
}

/** Map a stream item to the reducer's events; anything else (a message, an unknown type) is ignored. */
function toUsageEvent(event: RunUsageStreamEvent["event"]): RunUsageEvent | null {
  switch (event.type) {
    case "replacement":
    case "subscription_restored":
      return { type: "gap" };
    case "turn_started":
      return { type: "turn_started", turnId: event.turnId };
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
      return { type: event.type, turnId: event.turnId, usage: event.usage };
    case "usage_updated":
      return event.usage ? { type: "usage_updated", usage: event.usage } : null;
    default:
      return null;
  }
}
