import { NO_PENDING_EFFECT_REFUSAL } from './verb-refusal-text';
import { REMOVED_TASK_REFUSAL } from './control-refusals';
import { settleSupersededFences } from '../recovery/fence-settlement';
import type { Task, TaskControlInput } from "../../shared/contracts";
import { blockingRecoveryEffects } from '../recovery/recovery-effects';
import { settleObservedHostEffectOperations } from '../recovery/effect-gates';
import { DurableFenceRefusal } from '../intake/run-settlement';
import { now } from '../store/store';
import type { Engine } from '../engine';
import { collectOwnerVerbFacts, ownerEffectIdentity, ownerPendingEffects } from './owner-verbs';

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
  get store() { return this.engine.store; }

  async retryEffect(input: TaskControlInput, operationId?: string): Promise<Task> {
    const task = this.store.task(input.taskId);
    if (task.removedAt) throw Error(REMOVED_TASK_REFUSAL);
    // A replayed retry whose own effect already landed is answered by that
    // recorded outcome, never re-sent or refused as stale.
    const archived = this.engine.replayedArchiveOutcome(task, input, operationId);
    if (archived) return archived;
    const catalogArchived = this.engine.replayedCatalogArchiveOutcome(task, input, operationId);
    if (catalogArchived) return catalogArchived;
    // A disposition workspace step that already settled is answered by its
    // settled disposition, never re-run from a stale operation.
    const dispositionSettled = this.engine.replayedDispositionWorkspaceOutcome(task, input, operationId);
    if (dispositionSettled) return dispositionSettled;
    this.engine.requireOwnerControlCurrent(task, input.version, 'Task changed; refresh before retrying');
    const beforeSettlement = this.engine.retryEffectBeforeSettlement(task, input);
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
    await this.engine.settleObservedIdleRuns(task.id, `retry_effect ${input.effect ?? ''}`.trim());
    const pending = ownerPendingEffects(collectOwnerVerbFacts(this.store, this.store.task(task.id)));
    const matches = input.effect ? pending.filter(item => item.effect === input.effect) : pending;
    if (matches.length !== 1) throw Error(input.effect
      ? `No recorded side effect ${input.effect} is pending on this task${pending.length ? `; pending: ${pending.map(item => item.effect).join(', ')}` : ''}`
      : pending.length > 1 ? `Name one pending effect: ${pending.map(item => item.effect).join(', ')}`
      : NO_PENDING_EFFECT_REFUSAL);
    const found = matches[0]!;
    if (found.kind === 'recovery_effect') return this.engine.retryRecoveryEffect(task, input, found);
    if (found.kind === 'task_control_operation') return this.engine.retryTaskControlOperation(task, found);
    // A proof policy belongs only to the disposition workspace step; it is never
    // silently ignored on another effect.
    if (input.workDisposition && found.kind !== 'disposition_workspace')
      throw Error('A work disposition policy is only valid for a disposition workspace retry');
    // Spec 050: both new verbs settle the fences they obsolete. A refused retry
    // changes nothing; an applied one first supersedes the stale incident,
    // recovery, reminders, carry and checkpoint intent with history kept, so a
    // stale episode never survives the retry it was blocking. The settlement is
    // part of this control, so the version-guarded handlers expect the version
    // it produced.
    settleSupersededFences(this.store, task.id, `retry_effect ${found.effect}: ${input.reason ?? ''}`, now(), this.engine.coordinatorActionRunId.getStore());
    const expected = this.store.task(task.id).version;
    const current = this.store.task(task.id);
    return this.engine.retryOrdinaryEffect(task, input, found, current, expected);
  }

  /**
   * The observation half of `retry_effect` for a named task operation: the owner
   * names `operation.<id>`, and a later-evidence settlement is recorded and
   * returned. An unanswered operation keeps its fence with the reason the
   * projection gives, never a resend. Anything not named as an operation is left
   * to the ordinary pending-effect list.
   */
  retryEffectByObservation(task: Task, input: TaskControlInput): Task | null {
    const named = input.effect ? ownerEffectIdentity(input.effect, 'operation') : null;
    const candidate = named ? this.store.operation(named) : null;
    if (!candidate || candidate.kind !== 'task_control' || candidate.taskId !== task.id || candidate.state !== 'needs_attention') return null;
    const settled = settleObservedHostEffectOperations(this.store, task.id);
    if (settled.some(operation => operation.id === candidate.id)) return this.store.task(task.id);
    const blocked = blockingRecoveryEffects(this.store, this.store.task(task.id), { noticeKinds: 'all' })
      .find(effect => effect.kind === 'operation' && effect.identity === candidate.id);
    if (!blocked) return this.store.task(task.id);
    throw new DurableFenceRefusal(`operation ${candidate.id} remains ${blocked.state}: ${blocked.reason}; no later task evidence answers its host effect yet`);
  }
}
