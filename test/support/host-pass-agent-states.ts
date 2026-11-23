import type { AgentObservation } from "../../core/host";

/** Host activity changes on fixture writes and remains stable across reads. */
export class HostPassAgentStates extends Map<string, AgentObservation> {
  private latestActivityAt = 0;
  private readonly activityAt = new Map<string, string>();

  override set(id: string, state: AgentObservation): this {
    // Leave room for several synthetic updates within one wall-clock millisecond.
    this.latestActivityAt = Math.max(Date.now() - 1000, this.latestActivityAt + 1);
    this.activityAt.set(id, new Date(this.latestActivityAt).toISOString());
    return super.set(id, state);
  }

  withActivityStamp(state: AgentObservation): AgentObservation {
    // Explicit witnesses, including undefined in negative cases, belong to the test.
    if ("updatedAt" in state || !this.has(state.id)) return state;
    return { ...state, updatedAt: this.activityAt.get(state.id) };
  }
}
