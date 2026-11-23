import { propagateQuantumDeferral } from "../../scheduling/pass-snapshot";
import type { Task, TaskControlInput } from "../../../shared/contracts";
import type { Engine } from "../../engine";
import { DurableFenceRefusal } from "../../intake/run-settlement";
import { now } from "../../store/store";
import { workspaceDiscardKey, type WorkspaceDiscard } from "../../workspaces/orphan-worktree";
import { RETAINED_PREREQUISITE_REFUSAL } from "../verb-refusal-text";
import { ownerStopPendingRefusal } from "../owner-stop";
import { moveToCloseout, type CloseoutMoveInput } from "./closeout";
import { reconcileRetainedExternalMerge, reconcileReviewEntryExternalMerge, type ExternalMergeInput } from "./external-merge";
import { moveToMerge, type MergeMoveInput } from "./merge";
import { moveToReview } from "./review";
import type { ReviewMoveInput } from "./types";
import { moveToWork, type WorkMoveInput } from "./work";

/**
 * Messages a move's guarded transaction raises when the task or its runs moved
 * under it. A move that cancelled a turn re-plans once against the fresh state
 * on these, because the cancelled run is idle by then and settles.
 */
const MOVE_REPLAN_MESSAGE = /^(Task changed|Task or run changed|A run started during the move|A run changed during the move)/;

/**
 * The owner's `move` verb: to work, review, merge and closeout, and the external
 * merge reconciliation closeout runs. Same-name `Engine` methods delegate here;
 * each verb's own work lives in its module, and the methods read the engine per
 * call, so instance overrides on the engine still win for the moves that re-enter.
 */
export class MoveControls {
  constructor(readonly engine: Engine) {}

  async applyTaskControlMove(input: TaskControlInput, operated: <T>(result: T) => T, operationId?: string): Promise<Task> {
    const store = this.engine.store;
    const before = store.task(input.taskId);
    if (before.resolution.ownerStop)
      throw new DurableFenceRefusal(ownerStopPendingRefusal(before.resolution.ownerStop));
    const eventCount = store.eventsAll(input.taskId).length;
    const attempt = (version: number) => {
      const moveInput = { taskId: input.taskId, version, reason: input.reason!, instruction: input.instruction, caller: input.caller,
        qualification: input.qualification, head: input.head, relayed: input.relayed, delegated: input.delegated, relayNote: input.note };
      return input.to === "work" ? this.engine.moveToWork(moveInput)
        : input.to === "merge" ? this.engine.moveToMerge(moveInput)
        : input.to === "closeout" ? this.engine.moveToCloseout({ ...moveInput, operationId })
        : this.engine.moveToReview({ taskId: input.taskId, version, reason: input.reason!, reviewer: input.reviewer,
          caller: input.caller, prNumber: input.prNumber,
          fresh: input.to === "review" ? input.fresh : undefined }, operationId);
    };
    // Round 4 (review #533): cancelling a turn is remote, so a callback can land
    // while it is in flight. Once this move has stopped live work, a concurrent
    // change does not refuse it: the move re-plans once against the fresh
    // state, where the cancelled run is idle and settles. Only a real invariant
    // can refuse the re-plan.
    const cancelsBefore = store.eventsAll(input.taskId).filter(event => event.kind === "owner_stop_sent").length;
    let result: Task;
    try { result = await attempt(input.version); }
    catch (error) {
      propagateQuantumDeferral(error);
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = store.eventsAll(input.taskId).filter(event => event.kind === "owner_stop_sent").length > cancelsBefore;
      if (!cancelled || !MOVE_REPLAN_MESSAGE.test(message)) throw error;
      store.event(input.taskId, "owner_move_replanned", message.slice(0, 2000));
      result = await attempt(store.task(input.taskId).version);
    }
    if (result.version === before.version && store.eventsAll(input.taskId).length === eventCount)
      throw new DurableFenceRefusal('The move could not change the task; read next and use force with a reason if a gate is blocking it');
    void this.engine.cleanContext(() => this.engine.wakeTask(result.id));
    void this.engine.cleanContext(() => this.engine.wakeRepository(result.repoPath));
    return operated(result);
  }

  moveToReview(input: ReviewMoveInput, operationId?: string): Promise<Task> {
    return moveToReview(this.engine, input, operationId);
  }

  moveToWork(input: WorkMoveInput): Promise<Task> {
    return moveToWork(this.engine, input);
  }

  moveToMerge(input: MergeMoveInput): Promise<Task> {
    return moveToMerge(this.engine, input);
  }

  moveToCloseout(input: CloseoutMoveInput): Promise<Task> {
    return moveToCloseout(this.engine, input);
  }

  reconcileRetainedExternalMerge(input: ExternalMergeInput & { qualification: string }): Promise<Task> {
    return reconcileRetainedExternalMerge(this.engine, input);
  }

  reconcileReviewEntryExternalMerge(input: ExternalMergeInput): Promise<Task> {
    return reconcileReviewEntryExternalMerge(this.engine, input);
  }

  /** An owner continuation refuses an open prerequisite wait and clears a released one in its own transaction. */
  resumeReleasedPrerequisiteWait(taskId: string): void {
    const store = this.engine.store;
    const task = store.task(taskId);
    if (!task.prerequisiteWait) return;
    if (!task.prerequisiteWait.releasedAt) throw Error(RETAINED_PREREQUISITE_REFUSAL);
    store.update(task.id, { prerequisiteWait: null }, 'prerequisite_wait_resumed', 'Owner explicitly resumed the task after the prerequisite notice');
  }

  /**
   * Papercut c7643943: one durable owner decision to lose the unproven contents
   * of exactly one workspace, bound to its task, workspace and directory and
   * written before any archive effect. A replay or lost reply keeps the first
   * record, and a record naming another directory is a contradiction rather
   * than something to overwrite or to archive through.
   */
  recordWorkspaceDiscard(task: Task, workspaceId: string, directory: string, input: TaskControlInput,
    authority: { kind: 'operator' | 'relayed_note'; note: string | null }): WorkspaceDiscard {
    const store = this.engine.store;
    const key = workspaceDiscardKey(task.id, workspaceId);
    const prior = store.getMeta<WorkspaceDiscard>(key);
    if (prior) {
      if (prior.workspaceId !== workspaceId || prior.directory !== directory)
        throw Error('A recorded content discard names another directory for this workspace; nothing was written or archived');
      return prior;
    }
    const record: WorkspaceDiscard = { workspaceId, directory, caller: input.caller!, authority: authority.kind, note: authority.note,
      reason: (input.reason ?? '').trim().slice(0, 4000), at: now() };
    store.transaction(() => {
      store.setMeta(key, record);
      store.event(task.id, 'workspace_discard_authorized', JSON.stringify(record));
    });
    return record;
  }
}
