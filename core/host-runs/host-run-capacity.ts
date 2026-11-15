import { cpus, freemem, loadavg, totalmem } from "node:os";
import {
  boundCpuCoverage,
  hostRunCapacitySampleSchema,
  type HostRunCpuCoverage,
  type HostRunInternalRecord
} from "../../shared/contracts";
import {
  hostRunAccountingRetirementOf
} from "./host-run-accounting";
import { hostRunCpuCoverageMetaKey, hostRunCpuCoverageMetaSchema } from "./host-run-cpu-coverage";
import type { HostRunSchedulerOptions } from "./host-run-scheduler-types";
import type { Store } from "../store/store";
import { settledHostRunHoldsCapacity } from "../../shared/host-run-capacity";

type HostRunCapacitySample = ReturnType<typeof hostRunCapacitySampleSchema.parse>;

const sameRepository = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
/**
 * Task 191: no single run reserves more than this share of host memory
 * capacity. A history fallback of the whole capacity — or poisoned samples
 * that leave no valid peak — can otherwise pin every other heavy run.
 */
export const HISTORY_MEMORY_SHARE_CAP = 0.5;
/**
 * A run with no CPU history reserves at most this share of the heavy CPU
 * capacity, whether its fallback is Queue's default or the envelope a client
 * declared (Effigy declares the whole box), so one unmeasured run never locks
 * every other run out (Tom, 2026-10-21: "Approve both"). A smaller declared
 * envelope is used as given. Memory keeps its own share cap.
 */
export const NO_HISTORY_CPU_SHARE = 0.5;
/** Nearest-rank p95; exported so admission decisions can be falsified directly. */
export function percentile95(values: number[]): number | null {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
}

/** Selector command shape used by host-run history and Effigy task tables. */
export function selectorForArgv(argv: string[], fallback: "qa" | "validation"): string {
  const command = argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (command === "effigy") return (argv[1] || fallback).trim();
  return fallback === "qa" ? "qa" : argv.join(" ").trim() || "validation";
}

/** The envelope a run gets when it declares none and has no history: a share of the CPU, the memory capacity (share-capped later). */
export function defaultBudgetFallback(capacity: { cpuCapacity: number; memoryCapacityBytes: number }): { cpu: number; memoryBytes: number } {
  return { cpu: Math.max(1, capacity.cpuCapacity * NO_HISTORY_CPU_SHARE), memoryBytes: capacity.memoryCapacityBytes };
}

export function defaultHostCapacity() {
  const logicalCpu = Math.max(1, cpus().length);
  const memory = totalmem();
  // Effigy's published default leaves at least half of the measured host
  // budget for interactive work. Queue uses the same headroom in step (a).
  return { cpuCapacity: Math.max(1, logicalCpu / 2), memoryCapacityBytes: Math.max(1, Math.floor(memory / 2)), freeMemoryBytes: freemem(), loadAverage: loadavg() };
}

interface HostRunCapacityContext {
  capacity: NonNullable<HostRunSchedulerOptions["capacity"]>;
  reservesCapacity(run: HostRunInternalRecord): boolean;
  nowMs: () => number;
  hasUnresolvedEscapedDescendants(run: HostRunInternalRecord): boolean;
  store: Store;
  historicalSamples(repository: HostRunInternalRecord["repository"], selector: string): Array<{ cpuMs: number | null; wallMs: number }>;
}

export class HostRunCapacity {
  constructor(private readonly context: HostRunCapacityContext) {}
  sampleCapacity(runs: HostRunInternalRecord[]): HostRunCapacitySample {
    const measured = this.context.capacity();
    const active = runs.filter(run => this.context.reservesCapacity(run));
    return {
      sampledAt: new Date(this.context.nowMs()).toISOString(),
      cpuCapacity: measured.cpuCapacity,
      memoryCapacityBytes: measured.memoryCapacityBytes,
      reservedCpu: active.reduce((sum, run) => sum + run.budget.cpu, 0),
      reservedMemoryBytes: active.reduce((sum, run) => sum + run.budget.memoryBytes, 0),
      freeMemoryBytes: measured.freeMemoryBytes ?? measured.memoryCapacityBytes,
      loadAverage: measured.loadAverage ?? [],
    };
  }
  reservesCapacity(run: HostRunInternalRecord): boolean {
    const holds = run.state === "running" || run.state === "admitted"
      || (run.state === "settled" && settledHostRunHoldsCapacity(run));
    if (!holds) return false;
    // A durable accounting retirement retires this reservation's charge and keeps
    // it retired through later authentic evidence, whichever basis retired it:
    // physical containers, descendants and workspace custody stay recorded and
    // enforced elsewhere.
    return !hostRunAccountingRetirementOf(this.context.store, run);
  }
  hasUnresolvedEscapedDescendants(run: HostRunInternalRecord): boolean {
    return Boolean(run.settlement?.result?.escapedDescendants.length && !run.escapedDescendantsProvenDeadAt);
  }
  resolveBudget(repository: HostRunInternalRecord["repository"], selector: string, fallback: { cpu: number; memoryBytes: number }, capacityBytes?: number, cpuCapacity?: number): HostRunInternalRecord["budget"] {
    const history = this.context.historicalSamples(repository, selector);
    const cpuRatios: number[] = [];
    for (const item of history) if (positive(item.cpuMs) && positive(item.wallMs)) cpuRatios.push(item.cpuMs / item.wallMs);
    const cpuP95 = percentile95(cpuRatios);
    const wallP95 = percentile95(history.map(item => item.wallMs));
    // Host-run history records CPU and wall samples. Memory stays on the
    // declared fallback budget, capped so one run cannot reserve the machine.
    const clampMemory = (value: number): number =>
      capacityBytes ? Math.min(value, Math.max(1, Math.floor(capacityBytes * HISTORY_MEMORY_SHARE_CAP))) : value;
    if (cpuP95) {
      const memory = clampMemory(fallback.memoryBytes);
      // A measured tree can average more cores than the heavy capacity (half the
      // logical cores); a budget above capacity could never be admitted.
      const cpu = cpuCapacity ? Math.min(cpuP95, cpuCapacity) : cpuP95;
      return { cpu, memoryBytes: memory, wallMs: wallP95 ? Math.ceil(wallP95) : null, source: "history" };
    }
    const cpu = cpuCapacity ? Math.min(fallback.cpu, Math.max(1, cpuCapacity * NO_HISTORY_CPU_SHARE)) : fallback.cpu;
    return { cpu, memoryBytes: clampMemory(fallback.memoryBytes),
      wallMs: wallP95 ? Math.ceil(wallP95) : null, source: "fallback" };
  }
  historicalSamples(repository: HostRunInternalRecord["repository"], selector: string): Array<{ cpuMs: number | null; wallMs: number }> {
    const keys = new Set([repository.origin, repository.path].filter(Boolean).map(value => value!.toLowerCase()));
    const output: Array<{ cpuMs: number | null; wallMs: number }> = [];
    // Audit A7: only this selector's rows for these repositories, filtered in SQL
    // by the indexed selector, instead of parsing every host-run row on each submit.
    const hostRuns = this.context.store.hostRunSelectorSamples([...keys], selector);
    for (const run of hostRuns) {
      if (![run.repository.origin, run.repository.path].some(value => value && [...keys].some(key => sameRepository(value, key))) || run.selector !== selector || !positive(run.wallMs)) continue;
      output.push({ cpuMs: positive(run.cpuMs) ? run.cpuMs : null, wallMs: run.wallMs });
    }
    return output;
  }

  /**
   * Internal read of a settled run's CPU reason: present only when the stored
   * reason names this row's epoch and cpuMs and agrees with it. Never on the wire.
   */
  cpuCoverage(id: string): HostRunCpuCoverage | undefined {
    const run = this.context.store.hostRun(id);
    if (!run || run.state !== "settled") return undefined;
    let stored: unknown;
    try { stored = this.context.store.getMeta(hostRunCpuCoverageMetaKey(id)); } catch { return undefined; }
    const parsed = hostRunCpuCoverageMetaSchema.safeParse(stored);
    if (!parsed.success || parsed.data.epoch !== run.epoch || parsed.data.cpuMs !== run.cpuMs) return undefined;
    return boundCpuCoverage(run.cpuMs, parsed.data.cpuCoverage);
  }
}
