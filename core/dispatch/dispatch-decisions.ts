import type { Task } from '../../shared/contracts';
import { isDispositionActive } from '../../shared/contracts';
import { boardDispatchHoldApplies } from '../../shared/board-dispatch-hold';
import { dispatchBlocked } from './capacity';

/**
 * The first dispatch stop, evaluated as each fact becomes available. One ordered
 * rule, so a pass that reads its facts in stages cannot disagree with itself
 * about which stop is current.
 */
export function dispatchGate(facts: { transientWaiting?: boolean; task?: Task; stopped?: boolean; paused?: boolean; dispatchHeld?: boolean; catalogKnown?: boolean; dependencyWait?: string; capacity?: string; selectionAvailable?: boolean }): string {
  if (facts.transientWaiting) return "transient";
  if (facts.task && (facts.task.phase !== "queued" || dispatchBlocked(facts.task) || isDispositionActive(facts.task))) return "task";
  if (facts.stopped || facts.paused) return "paused";
  if (facts.task && facts.dispatchHeld && boardDispatchHoldApplies(facts.task)) return "dispatch held";
  if (facts.catalogKnown === false) return "catalog";
  if (facts.dependencyWait) return "dependency";
  if (facts.capacity) return "capacity";
  if (facts.selectionAvailable === false) return "route";
  return "";
}

/** Decide whether host pressure delays a new workspace at this instant. */
export function decideWorkspacePressureWait(task: Pick<Task, 'workspaceId' | 'queuePriority'>, host: { load: number; cpus: number } | undefined, next: number, now: number): string {
  if (task.workspaceId || task.queuePriority > 0 || !host || host.load <= host.cpus || next <= now) return "";
  return `Workspace creation paced under host pressure (${host.load.toFixed(1)} load / ${host.cpus} CPUs); waiting for the admission gap to pass`;
}
