import {
  type HostRunInternalRecord,
  type HostRunPriority
} from "../../shared/contracts";
import type { HostRunHandler } from "./host-run-scheduler-types";
import type { Store } from "../store/store";

const AGING_STEP_MS = 5 * 60_000;
const repoKey = (repository: HostRunInternalRecord["repository"]) => repository.origin ?? repository.path;

interface HostRunQueueOrderContext {
  store: Store;
  handlers: Map<string, HostRunHandler>;
  nowMs: () => number;
  priorityValue(priority: HostRunPriority): number;
}

export class HostRunQueueOrder {
  constructor(private readonly context: HostRunQueueOrderContext) {}
  orderedQueued(): HostRunInternalRecord[] {
    const queued = this.context.store.hostRunsByStates(["queued"]).filter(run => this.context.handlers.has(run.id));
    // Audit A7: an empty pump reads no history at all; a busy one asks SQL for the
    // last launch per repository instead of parsing every run row for one maximum.
    const served = new Map<string, number>();
    if (queued.length) for (const row of this.context.store.hostRunServedLaunches()) {
      const key = row.origin ?? row.path;
      if (!key) continue;
      const at = Date.parse(row.launchedAt);
      if (!Number.isFinite(at)) continue;
      served.set(key, Math.max(served.get(key) ?? 0, at));
    }
    return queued.sort((left, right) => {
      const leftAge = Math.floor(Math.max(0, this.context.nowMs() - Date.parse(left.submittedAt)) / AGING_STEP_MS);
      const rightAge = Math.floor(Math.max(0, this.context.nowMs() - Date.parse(right.submittedAt)) / AGING_STEP_MS);
      const rank = this.context.priorityValue(right.priority) + rightAge - this.context.priorityValue(left.priority) - leftAge;
      return rank || (served.get(repoKey(left.repository)) ?? 0) - (served.get(repoKey(right.repository)) ?? 0)
        || Date.parse(left.submittedAt) - Date.parse(right.submittedAt) || left.id.localeCompare(right.id);
    });
  }
  priorityValue(priority: HostRunPriority): number { return priority === "milestone" ? 3 : priority === "validation" ? 2 : 1; }
}
