import type { Run, Task } from "../../shared/contracts";
import { taskHasPr } from "../forge/index";

/**
 * Spec 051: an interactive task's operator session is open until its worker
 * submits. Any submission evidence closes it for good, including across a
 * replacement worker: a completion, any PR evidence (a failover keeps
 * `resumePrNumber`), a review, or a revision or reviewer run.
 */
export const interactiveSessionOpen = (task: Task, runs: readonly Run[] = []): boolean =>
  task.interactive === true && !task.completion && !taskHasPr(task) && !task.resolution.review
  && !runs.some(run => run.role === "revision" || run.role === "reviewer");
