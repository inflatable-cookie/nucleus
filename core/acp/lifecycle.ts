/**
 * Spec 065: the task's lifecycle as text the ACP agent shows.
 *
 * The agent has no model, so every word it says about the task comes from here. The
 * text is read from the task row, is bounded, and names only facts the board already
 * shows: the task reference, what it is doing now (`shared/task-state`'s one label),
 * and the PR it has opened.
 *
 * A line is a milestone, not a snapshot. Its signature is the label and the PR link
 * the operator can see, so a write that changes neither (a version bump, a phase
 * re-entry that reads the same, a poll) sends nothing. The task reference is named on
 * the session's first line only, and the PR link is shown once; later lines refer to
 * the PR by number.
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
 * What a session has already shown about this task. A line leaves out what the
 * thread already displays: the reference after its first line, and a PR link after
 * the link itself. A reattached session passes no memory, so it shows everything.
 */
export interface AcpLineMemory {
  /** Whether the task reference was already shown on this session. */
  named: boolean;
  /** The PR link already shown on this session, if any. */
  prUrl: string | null;
}

/** The PR's number in text (`PR #276`), read from its URL; null when the URL has none. */
export function acpPrRef(prUrl: string): string | null {
  const number = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  return number ? `PR #${number}` : null;
}

/**
 * One line: what the task is doing now. `taskStateLabel` already owns the phase,
 * hold and wait wording. The reference and the PR link are added only where the
 * session has not shown them yet.
 */
export function acpLifecycleLine(task: Task, memory: AcpLineMemory = { named: false, prUrl: null }): string {
  const label = taskStateLabel(task);
  const head = memory.named ? label : `${acpTaskName(task)} · ${label}`;
  if (!task.prUrl) return head;
  const pr = memory.prUrl === task.prUrl ? acpPrRef(task.prUrl) : task.prUrl;
  return pr ? `${head} · ${pr}` : head;
}

/**
 * What changed since the last line, as the words the line would show. Only the
 * label and the PR link count: the version, the raw phase and the head SHA change
 * without changing anything the operator reads, so they never send a line.
 */
export function acpLifecycleSignature(task: Task): string {
  return [taskStateLabel(task), task.prUrl ?? ""].join("\u0000");
}

/** Whether the task has finished, which releases the session's turn. */
export const acpTaskFinished = (task: Pick<Task, "phase">): boolean => isTerminalPhase(task.phase);

/** The line a session shows when its task finished. */
export function acpFinishedLine(task: Task): string {
  return `${acpTaskName(task)} finished · ${taskStateLabel(task)}`;
}
