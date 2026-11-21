import type { Task } from "../../../shared/contracts";
import type { TaskAttention } from "../../../shared/task-attention";

/**
 * What one task row's visibility is, as a host's own durable snooze ownership and
 * a fresh native read prove it (nucleus#1417). Only the exact occurrence the host
 * wrote on a verified task row is Nucleus-owned: an operator's snooze, a horizon
 * the operator replaced, a manual settle and an unreadable row are never read as
 * one (Tom's ruling, 2026-11-20; nucleus#1445).
 */
export type RowSnoozeVisibility =
  /** No row here, a row this host never snoozed, or one the host reads shown. */
  | { kind: "clear" }
  /** The host reads the row snoozed and it recorded that snooze. */
  | {
      kind: "snoozed";
      threadId: string;
      episodeStartedAt: string;
      cause: string;
    }
  /** The host's row state could not be read; the recorded snooze is the evidence. */
  | {
      kind: "unknown";
      threadId: string;
      episodeStartedAt: string;
      cause: string;
      reason: string;
    };

/**
 * One task row a host pass presents: the task and the one attention projection that
 * decides its row (nucleus#1366). The pass derives the whole set before it writes
 * anything, so every consumer of a row reads the same fact (nucleus#1443).
 */
export interface TaskRowProjection {
  readonly task: Task;
  readonly attention: TaskAttention;
}

/**
 * One finished parent a host pass could not archive (nucleus#1459). The typed state
 * names why, so the sweep records a reason the operator can act on instead of leaving
 * a done task's parent silently in the host's snoozed list:
 *
 * - `unknown` — the archive command's delivery is unknown and is read, never resent
 *   blind; the next pass settles it from the same thread's archive fact.
 * - `refused` — a proven pre-send refusal. Nothing reached the host, and the same
 *   command identity may be sent again on a later pass.
 * - `unobserved` — the host accepted the archive, but the same thread is not archived;
 *   a settled receipt is never sent twice, so this is a person's own action to see.
 * - `mismatched` — the binding does not positively name this task's own parent thread.
 * - `shared` — two task records claim the same parent thread.
 * - `read_failed` — the host could not answer this parent's state this pass.
 */
export interface ParentArchiveWait {
  readonly taskId: string;
  readonly threadId: string;
  readonly state:
    | "unknown"
    | "refused"
    | "unobserved"
    | "mismatched"
    | "shared"
    | "read_failed";
  readonly reason: string;
}

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
  /**
   * The task row's visibility now (nucleus#1417): whether a Nucleus-owned snooze
   * still hides it, how long that continuous episode has run, and whether the
   * host can read its own row at all. A host that keeps no such fact (Paseo)
   * omits the method; the hidden-row notice is then never raised for it.
   */
  rowSnoozeVisibility?(taskId: string): Promise<RowSnoozeVisibility>;
  /**
   * Reconcile native thread titles from task identity during the ordinary host
   * sweep. `rows` is the pass's complete set of task rows, derived from the same
   * attention projection the row writes read, so a title that counts tasks never
   * depends on how far those writes got (nucleus#1443).
   */
  reconcileThreadTitles?(
    tasks: readonly Task[],
    rows?: readonly TaskRowProjection[],
  ): Promise<void>;
  /**
   * Settle the finished-parent archive obligation (nucleus#1459), from the host's
   * durable parent bindings and the pass's own task list. It is the terminal step's
   * work alone: no Inbox, decision-card, row or title read can gate it, and one
   * host's parent fault never covers another. A pass visits a bounded batch of the
   * oldest attempts, and every entry it cannot settle comes back as a typed wait for
   * the caller to record. A host that keeps no parent binding omits the method.
   */
  reconcileFinishedParents?(
    tasks: readonly Task[],
  ): Promise<readonly ParentArchiveWait[]>;
}
