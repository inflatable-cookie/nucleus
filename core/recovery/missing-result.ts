import type { Run, Task } from "../../shared/contracts";
import { supersededWorkerResult } from "./incident";

export type MissingResult = {
  role: "worker" | "revision" | "reviewer";
  runId: string;
  prUrl: string | null;
};

const STOPPED = new Set(["idle", "error", "closed"]);

/** A worker, revision or reviewer run that stopped without an accepted report. */
export function missingResult(task: Task, runs: Run[]): MissingResult | null {
  const currentId = task.resolution.currentRunId;
  const current = currentId ? runs.find(run => run.id === currentId) : undefined;
  if (current && !current.completion && !current.released && current.idleSince && (current.role === "reviewer" || current.role === "revision")) {
    return { role: current.role, runId: current.id, prUrl: task.prUrl };
  }
  if (task.completion || currentId || !task.runId || !task.idleSince) return null;
  if (task.lastAgentStatus && !STOPPED.has(task.lastAgentStatus)) return null;
  // A later accepted revision result from the same retained worker supersedes
  // the initial run's missing result; it can never arrive.
  if (supersededWorkerResult(task, runs)) return null;
  return { role: "worker", runId: task.runId, prUrl: task.prUrl };
}
