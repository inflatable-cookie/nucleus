import type { Completion, Run, Task } from "../../shared/contracts";

export type ReportRunBinding =
  | "current"
  | "correcting_block"
  | "superseded_executor"
  | "finished_task"
  | "merge_retired_recovery"
  | "stale";

/** One classification for authenticated report runs, shared by the bridge and completion intake. */
export function reportRunBinding(
  task: Task,
  run: Run,
  input: Pick<Completion, "status">,
): ReportRunBinding {
  const currentRunId =
    run.role === "recovery"
      ? task.resolution.recovery?.runId
      : task.resolution.currentRunId;
  const correctingBlock =
    run.role !== "recovery" &&
    !run.released &&
    currentRunId === run.id &&
    Boolean(
      run.completion &&
        ["blocked", "error"].includes(run.completion.status) &&
        !["blocked", "error"].includes(input.status),
    );
  if (
    run.taskId === task.id &&
    run.role === "recovery" &&
    run.mergeRetirement &&
    !run.completion
  )
    return "merge_retired_recovery";
  if (
    run.role === "executor" &&
    run.taskId === task.id &&
    (run.released || currentRunId !== run.id)
  )
    return "superseded_executor";
  if (
    run.role !== "executor" &&
    run.taskId === task.id &&
    ["done", "cancelled"].includes(task.phase)
  )
    return "finished_task";
  if (
    run.taskId !== task.id ||
    currentRunId !== run.id ||
    run.released ||
    (run.completion && !correctingBlock) ||
    (["closeout", "recovery"].includes(run.role) &&
      run.generation !== task.coordinatorGeneration)
  )
    return "stale";
  return correctingBlock ? "correcting_block" : "current";
}
