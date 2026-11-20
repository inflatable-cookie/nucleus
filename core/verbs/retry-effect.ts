import { NO_PENDING_EFFECT_REFUSAL } from "./verb-refusal-text";
import { REMOVED_TASK_REFUSAL } from "./control-refusals";
import { settleSupersededFences } from "../recovery/fence-settlement";
import type { Task, TaskControlInput } from "../../shared/contracts";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { ownerEffectRetryRefusal } from "./owner-effects";
import { uncertainOperationRetryRefusal } from "./verb-fences";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { now } from "../store/store";
import type { Engine } from "../engine";
import {
  collectOwnerVerbFacts,
  ownerEffectIdentity,
  ownerPendingEffects,
} from "./owner-verbs";
import {
  buildOutputCleanupHooks,
  buildOutputDirectoryAbsent,
} from "../workspaces/worktree-cleanup";
import { terminalArchiveWorkspaces } from "../closeout/terminal-archive";

/**
 * The owner's `retry_effect` verb: one named failed or uncertain side effect is
 * observed, then bound or retried once. The verb re-derives the pending list from
 * the store, so an owner names an effect that is still pending; the handlers
 * observe the remote or local resource first, bind a found-done effect and refuse
 * with what was observed when the outcome stays unknown. The replayed outcomes,
 * the pre-settlement chain, the recovery observers and the ordinary effects each
 * live in their own module; this one owns the order between them.
 */
export class RetryEffectControls {
  constructor(readonly engine: Engine) {}
  get store() {
    return this.engine.store;
  }

  async retryEffect(
    input: TaskControlInput,
    operationId?: string,
  ): Promise<Task> {
    const task = this.store.task(input.taskId);
    if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
    // A replayed retry whose own effect already landed is answered by that
    // recorded outcome, never re-sent or refused as stale.
    const archived = this.engine.replayedArchiveOutcome(
      task,
      input,
      operationId,
    );
    if (archived) return archived;
    const catalogArchived = this.engine.replayedCatalogArchiveOutcome(
      task,
      input,
      operationId,
    );
    if (catalogArchived) return catalogArchived;
    // A disposition workspace step that already settled is answered by its
    // settled disposition, never re-run from a stale operation.
    const dispositionSettled = this.engine.replayedDispositionWorkspaceOutcome(
      task,
      input,
      operationId,
    );
    if (dispositionSettled) return dispositionSettled;
    this.engine.requireOwnerControlCurrent(
      task,
      input.version,
      "Task changed; refresh before retrying",
    );
    const facts = collectOwnerVerbFacts(
      this.store,
      task,
      operationId,
      this.engine.coordinatorActionRunId.getStore(),
    );
    const requested = ownerPendingEffects(facts).filter(
      (item) => !input.effect || item.effect === input.effect,
    );
    const applicable = requested.filter(
      (item) => !ownerEffectRetryRefusal(facts, item),
    );
    if (requested.length && !applicable.length)
      throw new DurableFenceRefusal(
        ownerEffectRetryRefusal(facts, requested[0]!)!,
      );
    if (!input.effect && applicable.length === 1) {
      input = { ...input, effect: applicable[0]!.effect };
    }
    const archiveId = input.effect
      ? ownerEffectIdentity(input.effect, "workspace_archive")
      : null;
    if (
      archiveId &&
      task.resolution.archivedWorkspaceIds.includes(archiveId) &&
      terminalArchiveWorkspaces(task, this.store.runs(task.id)).some(
        (workspace) =>
          workspace.id === archiveId && workspace.directory && workspace.head,
      )
    )
      return task;
    // Observe a gone build-output target before any cleanup send. Workspace
    // archives instead join the serialized cleanup lane and its proof gates.
    const absentCleanup = await this.settleAbsentCleanup(task, input);
    if (absentCleanup) return absentCleanup;
    const beforeSettlement = this.engine.retryEffectBeforeSettlement(
      task,
      input,
    );
    if (beforeSettlement) return beforeSettlement;
    // An uncertain host-effect control the task has since answered settles by
    // observation, without force: the owner asked for the effect to be observed,
    // and the task's own later record is that observation (nucleus#1159).
    const observed = this.retryEffectByObservation(task, input);
    if (observed) return observed;
    // Spec 050 terminal-cleanup liveness (papercut b87375b0): apply the same
    // observed-liveness settlement the verbs use before deriving the effect, so
    // an idle never-reporting run cannot fence the retry it holds. A live agent
    // or an unobservable one still fences.
    await this.engine.settleObservedIdleRuns(
      task.id,
      `retry_effect ${input.effect ?? ""}`.trim(),
    );
    const currentFacts = collectOwnerVerbFacts(
      this.store,
      this.store.task(task.id),
      operationId,
      this.engine.coordinatorActionRunId.getStore(),
    );
    const pending = ownerPendingEffects(currentFacts);
    const currentEffect = pending.find((item) => item.effect === input.effect);
    const refusal = currentEffect
      ? ownerEffectRetryRefusal(currentFacts, currentEffect)
      : null;
    if (refusal) throw new DurableFenceRefusal(refusal);
    const matches = input.effect
      ? pending.filter((item) => item.effect === input.effect)
      : pending.filter((item) => !ownerEffectRetryRefusal(currentFacts, item));
    if (matches.length !== 1)
      throw Error(
        input.effect
          ? `No recorded side effect ${input.effect} is pending on this task${pending.length ? `; pending: ${pending.map((item) => item.effect).join(", ")}` : ""}`
          : matches.length > 1
            ? `Name one pending effect: ${matches.map((item) => item.effect).join(", ")}`
            : NO_PENDING_EFFECT_REFUSAL,
      );
    const found = matches[0]!;
    if (found.kind === "recovery_effect")
      return this.engine.retryRecoveryEffect(task, input, found);
    if (found.kind === "task_control_operation")
      return this.engine.retryTaskControlOperation(task, found);
    // A proof policy belongs only to the disposition workspace step; it is never
    // silently ignored on another effect.
    if (input.workDisposition && found.kind !== "disposition_workspace")
      throw Error(
        "A work disposition policy is only valid for a disposition workspace retry",
      );
    // Spec 050: both new verbs settle the fences they obsolete. A refused retry
    // changes nothing; an applied one first supersedes the stale incident,
    // recovery, reminders, carry and checkpoint intent with history kept, so a
    // stale episode never survives the retry it was blocking. The settlement is
    // part of this control, so the version-guarded handlers expect the version
    // it produced.
    settleSupersededFences(
      this.store,
      task.id,
      `retry_effect ${found.effect}: ${input.reason ?? ""}`,
      now(),
      this.engine.coordinatorActionRunId.getStore(),
    );
    const expected = this.store.task(task.id).version;
    const current = this.store.task(task.id);
    return this.engine.retryOrdinaryEffect(
      task,
      input,
      found,
      current,
      expected,
    );
  }

  /** Settle an already-gone terminal target without replaying a cleanup effect. */
  private async settleAbsentCleanup(
    task: Task,
    input: TaskControlInput,
  ): Promise<Task | null> {
    // Leave paused retries to the ordinary handler, which reports the hold
    // without observing the host or changing cleanup state.
    if (this.store.getMeta("paused") === true) return null;
    const id = input.effect
      ? ownerEffectIdentity(input.effect, "build_output_cleanup")
      : null;
    if (
      !id ||
      !["done", "cancelled"].includes(task.phase) ||
      task.workspaceId !== id ||
      !task.directory
    )
      return null;
    const record = task.resolution.buildOutputCleanups.find(
      (item) => item.workspaceId === id && !item.runId,
    );
    if (
      !record ||
      !["uncertain", "skipped", "intent"].includes(record.state) ||
      record.directory !== task.directory
    )
      return null;
    if (!(await buildOutputDirectoryAbsent(record.directory))) return null;
    const adapter = this.engine.adapter;
    if (!adapter.preflightWorkspaceStorage || !adapter.taskWorkspaceArchived)
      throw Error(
        "Workspace storage or archive observation is unavailable; cleanup remains uncertain",
      );
    await adapter.preflightWorkspaceStorage(task);
    if (!(await adapter.taskWorkspaceArchived(id)))
      throw Error(
        "Workspace is still present in the host catalog; cleanup remains uncertain",
      );
    if (!(await buildOutputDirectoryAbsent(record.directory)))
      throw Error("Workspace directory reappeared during cleanup observation");
    return this.store.transaction(() => {
      const current = this.store.task(task.id);
      this.engine.requireOwnerControlCurrent(
        current,
        task.version,
        "Task changed during cleanup observation; refresh before retrying",
      );
      buildOutputCleanupHooks(
        this.store,
        task.id,
        id,
        record.directory,
        () => true,
      ).observed({
        detail: "directory absent; nothing to clean up",
        removed: false,
        safe: true,
        observations: [],
      });
      return this.store.task(task.id);
    });
  }

  /**
   * The observation half of `retry_effect` for a named task operation: the owner
   * names `operation.<id>`. Sweep records later evidence. This path returns the
   * current task when the occurrence no longer blocks, or the same refusal as
   * the read view while the delivery remains uncertain.
   */
  retryEffectByObservation(task: Task, input: TaskControlInput): Task | null {
    const named = input.effect
      ? ownerEffectIdentity(input.effect, "operation")
      : null;
    const candidate = named ? this.store.operation(named) : null;
    if (
      !candidate ||
      candidate.kind !== "task_control" ||
      candidate.taskId !== task.id ||
      candidate.state !== "needs_attention"
    )
      return null;
    if (candidate.result && candidate.effect?.status === "reconciled")
      return null;
    // nucleus#1428: a move whose journal proves it wrote and sent nothing settles
    // failed here, with that evidence. Only then may the scheduler continue.
    if (this.store.unwrittenMergeMoveProof(candidate.id)) {
      this.store.reconcileUnwrittenMergeMove(candidate.id, candidate.inputHash);
      void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
      return this.store.task(task.id);
    }
    const blocked = blockingRecoveryEffects(
      this.store,
      this.store.task(task.id),
      { noticeKinds: "all" },
    ).find(
      (effect) =>
        effect.kind === "operation" && effect.identity === candidate.id,
    );
    if (!blocked) return this.store.task(task.id);
    throw new DurableFenceRefusal(
      uncertainOperationRetryRefusal(
        candidate.id,
        blocked.state,
        blocked.reason,
      ),
    );
  }
}
