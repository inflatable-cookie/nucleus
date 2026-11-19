import type { Task } from '../../../shared/contracts';
import type { TaskAttention } from '../../../shared/task-attention';

/** How a task's threads are presented to the operator: the task's one row and thread titles. */
export interface HostThreadPresentation {
  /**
   * One host pass opens with the tasks this host still works on. A host that keeps
   * its own thread records uses them as the pass's facts: a thread whose task is
   * over stops being observed, and every read in the pass is shared across its
   * consumers instead of paid for separately by each one. Presentation only; no
   * thread, task or delivery fact is decided here. `endHostPass` closes the pass.
   */
  beginHostPass?(tasks: readonly Task[]): Promise<void> | void;
  /** The pass closed: the next one reads afresh. */
  endHostPass?(): Promise<void> | void;
  /**
   * Put the task's one row where the one attention projection says it belongs
   * (nucleus#1366): a person who must act gets the row surfaced, a task that waits
   * on nothing Nucleus runs gets it snoozed, and a running role is left alone. The
   * host never settles a task thread (Tom, 2026-11-19); a row an operator settled by
   * hand is theirs and is left exactly as it is. Presentation only: an unknown or
   * refused command never changes the task and is never resent blindly.
   */
  reconcileTaskRow?(taskId: string, attention: TaskAttention): Promise<void>;
  /** Reconcile native thread titles from task identity during the ordinary host sweep. */
  reconcileThreadTitles?(tasks: readonly Task[]): Promise<void>;
}
