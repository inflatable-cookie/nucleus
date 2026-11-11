import {
  hostRunCapacitySampleSchema, hostRunInternalRecordSchema, hostRunSettlementSchema,
  type HostRunInternalRecord
} from "../../shared/contracts";
import type { HostRunHandler } from "./host-run-scheduler-types";
import type { Store } from "../store/store";
import { now } from "../store/store";

type HostRunCapacitySample = ReturnType<typeof hostRunCapacitySampleSchema.parse>;

interface HostRunLaunchContext {
  store: Store;
  assertCurrentEpoch(epoch: number): void;
  nowMs: () => number;
  launchPredicate: (run: HostRunInternalRecord) => boolean;
  trackLive(run: HostRunInternalRecord): void;
  sampleCapacity(runs: HostRunInternalRecord[]): HostRunCapacitySample;
  handlers: Map<string, HostRunHandler>;
  clearDeadline(id: string): void;
  pump(): void;
  currentEpoch(epoch: number): boolean;
  launching: Set<string>;
  failLaunch(id: string, error: unknown): void;
  rejectBeforeLaunch(id: string, reason: string): HostRunInternalRecord;
  recordEvent(run: HostRunInternalRecord, event: string, data: Record<string, unknown>, at?: string): void;
}

export class HostRunLaunch {
  constructor(private readonly context: HostRunLaunchContext) {}

  /** Durable launch boundary. Call immediately before the supervisor/process side effect. */
  markLaunched(id: string, canLaunch?: (run: HostRunInternalRecord) => boolean): HostRunInternalRecord {
    let updated: HostRunInternalRecord | null = null;
    this.context.store.transaction(() => {
      const current = this.context.store.hostRun(id);
      if (!current || current.state !== "admitted") throw new Error(`Host run ${id} is not admitted`);
      this.context.assertCurrentEpoch(current.epoch);
      const at = new Date(this.context.nowMs()).toISOString();
      if (!this.context.launchPredicate(current) || (canLaunch && !canLaunch(current))) {
        const settlement = hostRunSettlementSchema.parse({ format: "host.run.settlement", version: 1, runId: id,
          outcome: "cancelled", launched: false, settledAt: at, result: null, containers: [] });
        updated = hostRunInternalRecordSchema.parse({ ...current, state: "settled", position: null, settledAt: at, settlement,
          capacityReleasedAt: at, capacityReleaseReason: "launch was fenced before the host process started", capacityReleaseKind: "automatic" });
        this.context.store.putHostRun(updated);
        this.context.trackLive(updated);
        for (const [event, data] of [
          ["decision", { decision: "reject", reason: "launch_fenced", capacitySample: this.context.sampleCapacity(this.context.store.hostRunCapacityCandidates()) }],
          ["settlement", { settlement }],
          ["capacity_release", { reason: "launch was fenced before the host process started", releasedAt: at }],
        ] as const) {
          this.context.store.appendHostRunJournal(id, event, { runId: id, epoch: current.epoch, ...data }, at);
        }
      } else {
        updated = hostRunInternalRecordSchema.parse({ ...current, state: "running", launchedAt: at });
        this.context.store.putHostRun(updated);
        this.context.trackLive(updated);
        const journalData = { runId: id, epoch: current.epoch, launchedAt: at };
        this.context.store.appendHostRunJournal(id, "launch", journalData, at);
      }
    });
    const launched = updated as HostRunInternalRecord | null;
    if (!launched) throw new Error(`Host run ${id} launch did not settle`);
    if (launched.state === "settled") {
      this.context.handlers.get(id)?.terminal?.(launched);
      this.context.handlers.delete(id);
      this.context.clearDeadline(id);
      this.context.pump();
    } else this.context.clearDeadline(id);
    return launched;
  }
  startLaunch(run: HostRunInternalRecord, handler: HostRunHandler): void {
    const current = this.context.store.hostRun(run.id);
    if (!current || current.state !== "admitted" || !this.context.currentEpoch(current.epoch) || this.context.launching.has(run.id)) return;
    this.context.launching.add(current.id);
    void Promise.resolve(handler.launch(current)).catch(error => this.context.failLaunch(current.id, error)).finally(() => this.context.launching.delete(current.id));
  }
  failLaunch(id: string, error: unknown): void {
    const current = this.context.store.hostRun(id);
    if (!current || current.state === "settled" || !this.context.currentEpoch(current.epoch)) return;
    if (current.state === "admitted") {
      this.context.rejectBeforeLaunch(id, String(error));
      return;
    }
    const failedAt = now();
    try {
      this.context.recordEvent(current, "launch_failure", { error: String(error).slice(0, 2000), launched: true,
        reconciliationRequired: "No host result proves this run stopped" }, failedAt);
    } catch (persistError) {
      if (!this.context.currentEpoch(current.epoch)) return;
      throw persistError;
    }
  }
}
