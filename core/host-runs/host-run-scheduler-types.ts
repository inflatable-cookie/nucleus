import type { HostRunInternalRecord, HostRunPriority } from "../../shared/contracts";
import type { EffigyRuntimeBinding } from "../qa/effigy-runtime";

export type HostRunEvent = { journalId: number; runId: string; event: string; at: string; data: Record<string, unknown> };
export type HostRunHandler = {
  launch: (run: HostRunInternalRecord) => Promise<void> | void;
  terminal?: (run: HostRunInternalRecord) => Promise<void> | void;
  position?: (position: number, run: HostRunInternalRecord) => Promise<void> | void;
};

export interface HostRunSchedulerOptions {
  now?: () => number;
  capacity?: () => { cpuCapacity: number; memoryCapacityBytes: number; freeMemoryBytes?: number; loadAverage?: number[] };
  capacityDeadlineMs?: number;
  /** Test seam for the admission hook's kernel liveness; production asks this host (ESRCH is the only dead answer). */
  hookAlive?: (pid: number) => boolean;
  /** Test seam for the admission hook's contract 010 start identity; production reads this host. */
  hookStartIdentity?: (pid: number) => string;
}

export interface HostRunSubmission {
  id: string;
  epoch: number;
  submissionSource?: "queue" | "client" | "admission";
  caller: string;
  clientRequestId?: string;
  /** Effigy kernel run id when this row is an admission reservation. */
  effigyRunId?: string;
  /**
   * A runtime binding verified before the reservation was accepted. It is
   * written with the row in the same durable write, so an admission is never
   * observable-but-unbound at any instant (Spec 035, "Runtime identity").
   */
  effigyRuntimeBinding?: Extract<EffigyRuntimeBinding, { kind: "bound" }>;
  repository: { origin: string | null; path: string };
  selector: string;
  runClass: "heavy" | "light";
  classSource: "manifest" | "default";
  priority: HostRunPriority;
  runTimeoutMs: number;
  /** Client-protocol v1 capacity deadline; the scheduler default applies when absent. */
  capacityDeadlineMs?: number;
  budgetFallback?: { cpu: number; memoryBytes: number };
  submittedAt?: string;
}

