import type { DispositionRef, Task, WorkDisposition } from "../../../shared/contracts";
import type { HookContext } from "../../hooks/hooks";
import type { HookRecord } from "../../../shared/hooks";

export interface DispositionRequest {
  taskId: string;
  version: number;
  action: "cancel" | "supersede";
  reason?: string;
  replacementTaskId?: string;
  workDisposition?: WorkDisposition;
  requestedBy?: string;
}

/** Remote effects the disposition driver reconciles. Tests inject fakes; production wires the adapter and git. */
export interface DispositionDeps {
  hostAvailable?(task: Task): boolean;
  withHost?<T>(id: string, fn: () => T): T;
  hooks: {
    emit(event: "task.cancelled", task: Task, context: HookContext): Promise<{ hold: boolean; attention: boolean; records: unknown[] }>;
    /** Stop a launched Queue-owned project validation after the durable disposition fence. */
    cancelProjectValidation?(task: Task, reason: string): Promise<void>;
    /**
     * The consumer-owned pre-archive retention gate. Before this disposition
     * archives the retained workspace, every bound `task.pre_archive` hook may
     * refuse; a hold preserves the worktree and reports the hook's evidence.
     */
    preArchive?(task: Task): Promise<{ hold: boolean; detail: string }>;
    /**
     * The advisory finished-task runtime stop. After a cancellation completes,
     * a bound `task.finished` hook runs once in the retained worktree; its
     * failure is a warning and never reopens the task.
     */
    finished?(task: Task): Promise<{ hold: boolean; attention: boolean; records: unknown[] }>;
    /** Production Queue hooks expose the durable automatic-replay eligibility of a held occurrence. */
    heldAutomaticReplay?(task: Task): { record: HookRecord; ordinal: number | null } | null;
    automaticReplayAvailable?(task: Task): boolean;
    cancellationEmissionSettled?(taskId: string): boolean;
  };
  observeAgent(id: string): Promise<{ stopped: boolean }>;
  /**
   * Cancel an active owned turn immediately. Same Paseo interrupt channel as
   * stall continuation; the text tells the agent to stop and not push.
   */
  interruptTurn?(agentId: string, messageId: string, text: string): Promise<void>;
  /** Origin heads and tags at the task's git cwd. Thrown listing failures retry next pass. */
  listRemoteRefs?(task: Task): Promise<DispositionRef[]>;
  archiveAgent(id: string): Promise<void>;
  /** Spec 027: remove the task's Queue-owned sibling worktrees. Best effort; never fails disposition. */
  archiveSiblings?(task: Task): Promise<void>;
  proveWorkspaceEmpty(task: Task): Promise<{ empty: boolean; detail: string; uncertain?: string }>;
  proveRetainedByReplacement(task: Task, replacement: Task): Promise<{ retained: boolean; detail: string; uncertain?: string }>;
  archiveWorkspace(task: Task): Promise<boolean>;
  observeWorkspaceArchived(task: Task): Promise<boolean>;
  settleCancelledPr(task: Task): Promise<string>;
}
