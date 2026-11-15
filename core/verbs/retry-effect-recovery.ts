import { incidentBindsCurrentWork, taskControlInputSchema, type Task, type TaskControlInput } from "../../shared/contracts";
import { blockingRecoveryEffects } from "../recovery/recovery-effects";
import { DurableFenceRefusal } from "../intake/run-settlement";
import { isRecoveredPreDispatchHookHold } from "../hooks/hooks";
import type { Engine } from "../engine";
import { digest, now } from "../store/store";
import { collectOwnerVerbFacts, ownerPendingEffects, splitOwnerEffectKey, type OwnerEffect } from "./owner-verbs";

/**
 * The recovery half of `retry_effect`: each recorded recovery effect is settled
 * by observing its own resource (the hook occurrence, the publication, the run
 * delivery, the merge response, the uncertain operation), and only an effect no
 * observer can settle keeps its fence with the reason the projection gives. The
 * effect key is decoded once, so no branch slices a prefix.
 */
export class RecoveryEffectRetries {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }
  get resolution() { return this.engine.resolution; }

  async retryRecoveryEffect(task: Task, input: TaskControlInput, found: OwnerEffect): Promise<Task> {
    const key = splitOwnerEffectKey(found.effect);
    if (!key) throw Error('The recovery effect identity is malformed; refresh task detail');
    const { kind, identity } = key;
    if (kind === 'incident') return this.settleReconcilingIncident(task, input, identity);
    if (kind === 'hook') return this.retryHookEffect(input, this.store.task(task.id), identity);
    if (kind === 'review_publication') return this.reconcilePublicationEffect(input, this.store.task(task.id), identity);
    if (kind === 'review-delivery') {
      const result = await this.resolution.reconcileReviewDeliveryEffect(task.id, identity);
      if (result.status === 'delivered') return this.store.task(task.id);
      throw Error(`review-delivery ${identity} is ${result.status}: ${result.evidence || 'the exact recipient message was not observed'}`);
    }
    if (kind === 'attention-notice') {
      await this.resolution.reconcileAttentionNoticeEffect(task.id, identity);
      const remains = blockingRecoveryEffects(this.store, this.store.task(task.id), { noticeKinds: 'all' }).some(effect => effect.kind === kind && effect.identity === identity);
      if (!remains) return this.store.task(task.id);
      throw Error(`attention-notice ${identity} remains blocking after its exact timeline observation`);
    }
    if (kind === 'run-delivery') {
      if (await this.resolution.reconcileUncertainRunDelivery(task.id, identity)) return this.store.task(task.id);
      throw Error(`run-delivery ${identity} is no longer an uncertain creation on this task`);
    }
    if (kind === 'merge-response') {
      const observed = await this.resolution.reconcileMergeResponseEffect(task.id);
      const remains = blockingRecoveryEffects(this.store, observed, { noticeKinds: 'all' }).some(effect => effect.kind === kind && effect.identity === identity);
      if (!remains) return observed;
      throw Error(`merge-response ${identity} remains blocking after the forge observation`);
    }
    if (kind === 'project-validation') {
      const resumed = this.resolution.retryProjectValidationEffect(this.store.task(task.id));
      void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
      return resumed;
    }
    if (kind === 'operation') {
      const operation = this.store.operation(identity);
      if (operation?.taskId === task.id && operation.state === 'needs_attention' && operation.result && operation.effect?.status === 'reconciled') {
        this.store.putOperation({ ...operation, state: 'succeeded', settledAt: now(), diagnostic: '' });
        this.store.event(task.id, 'operation_reconciled', `${identity}: durable result and reconciled effect observed`);
        return this.store.task(task.id);
      }
    }
    const current = blockingRecoveryEffects(this.store, this.store.task(task.id), { noticeKinds: 'all' }).find(effect => effect.kind === kind && effect.identity === identity);
    if (!current) return this.store.task(task.id);
    throw new DurableFenceRefusal(`${kind} ${identity} remains ${current.state}: ${current.reason}; no effect-specific observer can yet settle it`);
  }

  /**
   * An incident still marked reconciling that no active recovery run owns is
   * settled by re-proving that fact, never by re-running reconciliation: the
   * owner's reason becomes the settlement's detail and the incident keeps its
   * history.
   */
  private settleReconcilingIncident(task: Task, input: TaskControlInput, identity: string): Task {
    const settled = this.store.transaction(() => {
      const current = this.store.task(task.id), incident = current.resolution.incident;
      if (!incident || incident.id !== identity || incident.status !== 'reconciling'
        || !incidentBindsCurrentWork(current, this.store.runs(current.id))
        || current.resolution.recoveryActive || this.store.runs(current.id).some(run => run.role === 'recovery' && !run.released))
        throw Error(`Incident ${identity} still has an active reconciliation; refresh task detail`);
      const detail = `Owner re-proved no active recovery run owns this reconciling incident; settled by retry_effect: ${input.reason}`.slice(0, 2000);
      this.resolution.update(current, { incident: { ...incident, status: 'resolved', detail, updatedAt: new Date().toISOString() } }, {}, 'incident_reproved_settled', identity);
      return this.store.task(current.id);
    });
    void this.engine.cleanContext(() => this.engine.wakeTask(task.id));
    return settled;
  }

  /** One hook occurrence: retry it through the hook owner, then report what still holds. */
  async retryHookEffect(input: TaskControlInput, current: Task, eventId: string): Promise<Task> {
    const record = this.store.hookEvents(current.id).find(item => item.eventId === eventId);
    if (!record) throw Error(`Hook occurrence ${eventId} is no longer recorded on this task`);
    const before = blockingRecoveryEffects(this.store, current, { noticeKinds: 'all' }).find(effect => effect.kind === 'hook' && effect.identity === record.id);
    if (!before) return this.store.task(current.id);
    const result = await this.engine.hooks.retry(current, eventId, input.discard === true, false);
    const settled = this.store.task(current.id);
    const next = isRecoveredPreDispatchHookHold(settled, result)
      ? this.store.update(settled.id, { phase: 'queued', reason: 'Repository pre-dispatch hooks settled after retry' }, 'hook_retry_recovered')
      : settled;
    const remaining = blockingRecoveryEffects(this.store, this.store.task(current.id), { noticeKinds: 'all' }).find(effect => effect.kind === 'hook' && effect.identity === record.id);
    if (remaining) throw Error(`hook ${eventId} remains ${remaining.state}: ${remaining.reason}`);
    const latest = this.store.task(current.id);
    const stop = latest.resolution.stop, recovery = latest.resolution.recovery;
    const terminal = latest.phase === 'done' || latest.phase === 'cancelled';
    const blockers = blockingRecoveryEffects(this.store, latest, { noticeKinds: 'all' });
    // A successful terminal cleanup can settle the operator stop that was
    // opened for this recovery episode. Keep the stop if any effect remains,
    // and bind the clear to the exact stop key the resolved recovery owned.
    if (terminal && !blockers.length && stop?.reason === 'operator_needed' && recovery?.status === 'resolved'
      && recovery.key === digest(`stop:${stop.reason}:${stop.since}`))
      return this.resolution.update(latest, { stop: null }, {}, 'finished_hook_retry_cleared_recovery_stop', eventId);
    return next;
  }

  /** One formal review publication: observe and publish the original verdict, then report what still holds. */
  async reconcilePublicationEffect(input: TaskControlInput, current: Task, runId: string): Promise<Task> {
    const before = blockingRecoveryEffects(this.store, current, { noticeKinds: 'all' }).find(effect => effect.kind === 'publication' && effect.identity === runId);
    if (!before) return this.store.task(current.id);
    this.engine.rejectFenced(current, 'formal review publication reconciliation');
    const result = await this.resolution.reconcileReviewPublication(current, runId, input.reason ?? '', this.engine.coordinatorActionRunId.getStore());
    void this.engine.cleanContext(() => this.engine.wakeTask(current.id));
    const remaining = blockingRecoveryEffects(this.store, this.store.task(current.id), { noticeKinds: 'all' }).find(effect => effect.kind === 'publication' && effect.identity === runId);
    if (remaining) throw Error(`publication ${runId} remains ${remaining.state}: ${remaining.reason}`);
    return result;
  }

  /**
   * A task-control retry left uncertain after its effect was applied. When its
   * named effect is still pending, the owner's explicit retry is the new
   * authorization and only that effect re-runs through its ordinary observer. No
   * uncertain delivery is replayed without the effect's normal proofs.
   */
  async retryTaskControlOperation(task: Task, found: OwnerEffect): Promise<Task> {
    const identity = splitOwnerEffectKey(found.effect)?.identity;
    const id = identity ?? '';
    const operation = this.store.operation(id);
    const payload = this.store.operationPayload(id) as { control?: unknown } | null;
    const original = taskControlInputSchema.safeParse(payload?.control);
    if (!operation || operation.kind !== 'task_control' || operation.taskId !== task.id || operation.state !== 'needs_attention'
      || !original.success || original.data.action !== 'retry_effect' || !original.data.effect)
      throw Error(`Task-control operation ${id} is no longer an uncertain retry_effect; refresh task detail`);
    const pending = ownerPendingEffects(collectOwnerVerbFacts(this.store, task)).filter(item => item.kind !== 'task_control_operation');
    const target = pending.find(item => item.effect === original.data.effect);
    if (target) return this.engine.retryEffect({ ...original.data, taskId: task.id, version: task.version });
    const at = now(), settledTask = this.store.task(task.id);
    this.store.putOperation({ ...operation, state: 'succeeded', settledAt: at, diagnostic: '',
      result: { taskId: task.id, taskVersion: settledTask.version, phase: settledTask.phase, number: settledTask.number ?? null, reference: settledTask.reference ?? null },
      effect: operation.effect ? { ...operation.effect, status: 'reconciled', result: `Owner re-proved ${original.data.effect} is no longer pending`, resultAt: at } : null });
    this.store.event(task.id, 'task_control_operation_reconciled', `${id}: ${original.data.effect} is no longer pending`);
    return settledTask;
  }
}
