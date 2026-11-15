import type { Run, Task } from "../../shared/contracts";
import type { BuildOutputDisclosureSubject } from "../../shared/build-output-disclosure";
import { isTerminalPhase } from "../../shared/task-state";

/**
 * The runs a task detail shows, split by the one fact that changes how they
 * read: whether the run has been released. Live runs lead the tab; released
 * runs are the history behind the "Earlier runs" disclosure, in the order the
 * detail read them.
 */
export type TaskRunPartition = { live: Run[]; earlier: Run[] };

export function taskRunPartition(runs: readonly Run[]): TaskRunPartition {
  return { live: runs.filter(run => !run.released), earlier: runs.filter(run => run.released) };
}

/**
 * Which workspace and run the task's run-bound build output disclosure is
 * about. A terminal task has settled its workspace cleanup, so it reads the
 * records without naming a silent run; a live task names the run its
 * completion recorded, when it has one.
 */
export function buildOutputCleanupSubject(
  task: Pick<Task, "workspaceId" | "phase" | "completion">,
): BuildOutputDisclosureSubject {
  return {
    workspaceId: task.workspaceId,
    runId: isTerminalPhase(task.phase) ? null : task.completion?.runId ?? null,
  };
}
