import type { WorkerPromptMeasurement } from '../../dispatch/prompt-text/measure';
import type { Task } from "../../../shared/contracts";

/**
 * One archived thread the retention pass may prune (orchestration contract,
 * "Archived thread retention"): a native identity with the archive stamp and the
 * launch labels the host itself reports. The pass resolves the task from the
 * labels and re-reads the archive fact before it removes anything, so this row is
 * evidence of what to look at, never permission to delete.
 */
export interface ArchivedThread {
  id: string;
  workspaceId: string | null;
  /** The host's own archive stamp; the pass compares it with the retention window. */
  archivedAt: string;
  labels: Record<string, string>;
}

/** The threads themselves: creating one for a task, finding the ones that exist, stopping a turn, and archiving or deleting a finished thread. */
export interface HostThreads {
  /** Restore this task's retained host parent only within an admitted owner restart. */
  restoreTaskParent?(task: Task, operationId: string, stillAllowed: () => boolean, beforeSend: () => void): Promise<void>;
  /** Observe the same interrupted restore occurrence without sending another command. */
  observeTaskParentRestore?(task: Task, operationId: string): Promise<"not_found" | "live" | "archived" | "deleted" | "mismatched" | "unobservable">;
  createAgent(
    task: Task,
    token: string,
    prompt: string,
    legacyPrompt?: string,
    measurement?: WorkerPromptMeasurement,
  ): Promise<{ id: string; workspaceId: string | null }>;
  findAgents(task: Task): Promise<{ id: string; workspaceId: string | null }[]>;
  /** Stop the assigned agent's current turn without delivering a follow-up message. */
  stopAgentTurn?(agentId: string, expectedTurnId?: string): Promise<void>;
  /** Stop this turn atomically. Implement only with a turn-scoped host command. */
  stopExactAgentTurn?(agentId: string, turnId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  /**
   * Permanently remove one thread at closeout (nucleus#1155). Present exactly
   * when the host can remove a thread: on such a host a task's support threads
   * stay settled while it is open and are removed when it ends, and a host
   * without this method keeps today's archive behaviour (Paseo).
   */
  deleteAgent?(agentId: string): Promise<void>;
  /**
   * The retention pass's enumeration: every archived thread on this host that
   * Nucleus created, walked to the host list's own positive end. `null` when the
   * walk could not be proved complete, so a partial list is never read as the
   * whole archived set and nothing is pruned from it.
   */
  archivedThreads?(): Promise<ArchivedThread[] | null>;
  /**
   * The fresh archive fact for one thread, read immediately before the retention
   * pass removes it: `null` when the host reports the thread absent (already
   * gone), otherwise the stamp it reports now — `null` when the operator
   * unarchived it, which always keeps the thread.
   */
  threadArchiveState?(
    agentId: string,
  ): Promise<{ archivedAt: string | null; deleted: boolean } | null>;
  /**
   * Drop this adapter's own per-thread state for threads the retention pass has
   * proved removed, so the state file shrinks with the threads it describes.
   * Absent when the adapter keeps nothing per thread.
   */
  forgetThreads?(agentIds: readonly string[]): void;
}
