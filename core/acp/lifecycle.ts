/**
 * Spec 065: the task's lifecycle as text the ACP agent shows.
 *
 * The agent has no model, so every word it says about the task comes from here. The
 * text is read from the task row, is bounded, and names only facts the board already
 * shows: the task reference, what it is doing now (`shared/task-state`'s one label),
 * its hold, and the PR it has opened.
 *
 * A signature decides when a line is worth sending again: unchanged state produces
 * no message, so a held turn stays quiet instead of repeating itself every poll.
 */
import { isTerminalPhase, taskStateLabel } from "../../shared/task-state";
import type { Task } from "../../shared/contracts";

/** The task's name in text: its durable reference when it has one, else its number or id. */
export function acpTaskName(task: Pick<Task, "reference" | "number" | "title" | "id">): string {
  if (task.reference) return task.reference;
  if (typeof task.number === "number") return `task ${task.number}`;
  return task.title ? `task “${task.title.slice(0, 80)}”` : `task ${task.id}`;
}

/**
 * One line: what the task is doing now. `taskStateLabel` already owns the phase,
 * hold and wait wording, so this adds only the reference and the PR.
 */
export function acpLifecycleLine(task: Task): string {
  const pr = task.prUrl ? ` · ${task.prUrl}` : task.prHead ? ` · head ${task.prHead.slice(0, 12)}` : "";
  return `${acpTaskName(task)} · ${taskStateLabel(task)}${pr}`;
}

/**
 * What changed since the last line: the same facts the line shows, gathered once so
 * a caller cannot compare one field and report another. The version is included, so
 * any substantive task write is a change even when the label reads the same.
 */
export function acpLifecycleSignature(task: Task): string {
  return [
    task.phase, task.version, taskStateLabel(task), task.prUrl ?? "", task.prHead ?? "", task.held ? "held" : "",
  ].join("\u0000");
}

/** Whether the task has finished, which releases the session's turn. */
export const acpTaskFinished = (task: Pick<Task, "phase">): boolean => isTerminalPhase(task.phase);

/** The line a session shows when its task finished. */
export function acpFinishedLine(task: Task): string {
  return `${acpTaskName(task)} finished · ${taskStateLabel(task)}`;
}
