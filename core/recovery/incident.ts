import { digest, latestRunCompletion } from "../store/store";
import { normalizeTelemetryCause } from "../telemetry/telemetry";
import type { Incident, Run, Task } from "../../shared/contracts";
import type { IncidentCause } from "../../shared/incident";

/** Lifecycle role of the run a fault belongs to; revision work is worker work. */
export const incidentRoleFromRun: Record<Run["role"], Incident["role"]> = {
  reviewer: "reviewer", revision: "worker", verification: "coordinator", closeout: "closeout", recovery: "recovery", executor: "reviewer",
};

export function incidentRole(task: Task, run: Run | null): Incident["role"] {
  if (run) return incidentRoleFromRun[run.role];
  // An open creation intent is worker work regardless of the attention phase it sits in.
  if (task.agentIntent && !task.agentId) return "worker";
  if (["dispatching", "working", "changes_requested", "blocked", "error"].includes(task.phase)) return "worker";
  // A callback-free initial worker landed in attention is still worker work, so
  // the attention phase rule keeps one incident identity across the transition
  // instead of re-attributing the same fault on the next observation.
  if (task.phase === "needs_attention" && !task.completion && !task.resolution.currentRunId && (task.agentId || task.runId)) return "worker";
  if (["awaiting_review", "reviewing"].includes(task.phase)) return "reviewer";
  if (task.phase === "closing") return "closeout";
  if (["verifying", "merging", "syncing"].includes(task.phase)) return "coordinator";
  return "unknown";
}

/** Pending-check wording changes as GitHub moves a job between queued and running.
 * Bind those observations to the reviewed head, not incidental status text. */
function requiredCheckCause(task: Task, reason: string): string | null {
  if (!task.prHead || !/(?:PR checks are pending|required checks? .*pending|required check .*pending past its deadline)/i.test(reason)) return null;
  return `required_check_pending:${task.prHead}`;
}

/** Derive the stable identity parts for one fault: task, lifecycle role, run and normalized cause. */
export function incidentKey(task: Task, run: Run | null, reason: string, runs: Run[] = [], explicitCause?: IncidentCause): { role: Incident["role"]; runId: string | null; cause: string; id: string } {
  const role = incidentRole(task, run);
  const runId = run?.id ?? task.runId ?? null;
  // An accepted blocked or error result is the cause; its absence of a callback is not.
  const result = latestRunCompletion(runs, ["blocked", "error"]) ?? (task.completion && ["blocked", "error"].includes(task.completion.status) ? task.completion : null);
  const cause = result && role === "worker" ? `worker_${result.status}` : explicitCause ?? requiredCheckCause(task, reason) ?? normalizeTelemetryCause(reason);
  return { role, runId, cause, id: digest(`${task.id}:${role}:${runId ?? ""}:${cause}`) };
}

/**
 * True when a resumed or revision run of the same retained worker delivered an
 * accepted result. The superseded initial run's missing result can never
 * arrive, so it must reconcile instead of reminding and escalating.
 */
export function supersededWorkerResult(task: Task, runs: Run[]): boolean {
  return Boolean(task.agentId) && runs.some(run => run.role === "revision" && run.completion && run.agentId === task.agentId);
}

/**
 * True while an automatic reconciliation step is inside its bounded window and
 * coordinator attention must wait. Expired or handoff incidents never block.
 */
export function automaticIncidentPending(incident: Incident | null, graceMs: number, at = Date.now()): boolean {
  if (!incident || incident.status !== "reconciling") return false;
  if (incident.action === "exact_lookup") return at - Date.parse(incident.createdAt) < graceMs;
  if (incident.action === "callback_reminder") return at - Date.parse(incident.updatedAt) < graceMs;
  return false;
}
