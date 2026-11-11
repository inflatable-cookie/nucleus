import { isDeepStrictEqual } from 'node:util';
import type { ReviewDeliveryAuthorization, Run } from '../../shared/contracts';
import type { Resolution } from '../resolution';
import { reviewContinuationWait, reviewDeliveryReason } from '../review/review-continuation';
import type { TimelinePage } from './stall';
import { now } from '../store/store';

/** Whether one timeline page holds this exact user message. Map bug 14: hasOlder is unknown without looking. */
export function timelineMessage(page: TimelinePage | null | undefined, messageId: string): 'present' | 'absent' | 'unknown' {
  if (!page || page.hasOlder || page.gap || page.staleCursor || page.reset) return 'unknown';
  return page.entries.some(entry => entry.item.type === 'user_message' &&
    ((entry.item as Record<string, unknown>).messageId === messageId || (entry.item as Record<string, unknown>).clientMessageId === messageId))
    ? 'present' : 'absent';
}

/** Settle an unknown send from its exact message. */
export type EffectReconcileContext = Pick<Resolution, 'adapter' | 'deliveryInTimeline' | 'host' | 'reconcileReviewDelivery' | 'reconcileReviewDeliveryOperations' | 'settleReviewDelivery' | 'store'>;

export class EffectReconcile {
  constructor(readonly resolution: EffectReconcileContext) {}
  get store() { return this.resolution.store; }
  get adapter() { return this.resolution.adapter; }

  /**
   * `receiptProven` is set only when the evidence shows the reviewer received
   * this exact message (Paseo accepted it, or the timeline holds it). Only then
   * is the run re-pinned to the brief the message carried: a same-run callback
   * proves the reviewer acted, not that it read amended text.
   */
  settleReviewDelivery(runId: string, deliveryId: string, status: ReviewDeliveryAuthorization['status'], evidence: string, receiptProven = false) {
    this.store.transaction(() => {
      const run = this.store.run(runId);
      if (!run) throw new Error('Reviewer run disappeared while settling its delivery intent');
      const deliveries = [...(run.reviewDeliveries ?? [])], index = deliveries.findIndex(item => item.deliveryId === deliveryId);
      if (index < 0) throw new Error('Reviewer delivery intent disappeared before settlement');
      const previous = deliveries[index];
      if (previous.status === 'delivered' || previous.status === status) {
        // Receipt proof can arrive after callback evidence settled the send; the pin only moves up.
        if (status === 'delivered' && previous.status === 'delivered' && receiptProven && previous.briefVersion !== null && (run.briefVersion ?? 0) < previous.briefVersion)
          this.store.putRun({ ...run, briefVersion: previous.briefVersion });
        return;
      }
      if (previous.status === 'refused' && status !== 'refused') return;
      deliveries[index] = { ...previous, status, evidence: evidence.slice(0, 2000), observedAt: now() };
      const repin = status === 'delivered' && receiptProven && previous.briefVersion !== null ? { briefVersion: previous.briefVersion } : {};
      this.store.putRun({ ...run, reviewDeliveries: deliveries, ...repin });
      const current = this.store.task(run.taskId);
      const reason = status === 'uncertain' ? reviewDeliveryReason(deliveryId, 'uncertain') :
        status === 'delivered' ? reviewContinuationWait(current, this.store).reason : `Reviewer delivery ${deliveryId} was refused before send: ${evidence.slice(0, 600)}`;
      const ownedReasons = [reviewDeliveryReason(deliveryId, 'reserved'), reviewDeliveryReason(deliveryId, 'uncertain')];
      if (ownedReasons.includes(current.reason)) this.store.update(current.id, { reason }, `review_delivery_${status}`, `${deliveryId}: ${evidence.slice(0, 1200)}`);
      else this.store.event(current.id, `review_delivery_${status}`, `${deliveryId}: ${evidence.slice(0, 1200)}`);
      if (status === 'delivered') this.resolution.reconcileReviewDeliveryOperations(current.id, run.id, deliveryId, evidence);
    });
  }

  /** Reconcile an unknown reviewer creation only from a terminal agent and its exact dispatch timeline. */
  async reconcileArchivedReviewerDispatch(taskId: string, runId: string): Promise<boolean> {
    const task = this.store.task(taskId), run = this.store.run(runId);
    if (!run || run.taskId !== taskId || run.role !== 'reviewer' || run.status !== 'uncertain' || !run.agentId) return false;
    if (!this.adapter.agentTimelinePage || !this.adapter.originAgent)
      throw new Error(`Reviewer dispatch ${run.id} remains uncertain; archived timeline evidence is unavailable`);
    const identity = await this.resolution.host.originAgent(run.agentId);
    if (identity?.workspaceId !== run.workspaceId) throw new Error(`Reviewer dispatch ${run.id} remains uncertain; agent workspace identity changed`);
    const archived = identity.archived;
    if (!archived) {
      const observed = await this.resolution.host.observe(run.agentId);
      if (observed.id !== run.agentId || observed.workspaceId !== run.workspaceId || observed.status !== 'closed'
        || observed.active || observed.activeTurnId || observed.permissions)
        throw new Error(`Reviewer dispatch ${run.id} remains uncertain; its agent is not proven closed or archived`);
    }
    const page = await this.resolution.host.agentTimelinePage(run.agentId, 100);
    if (!page || page.hasOlder !== false || page.gap || page.staleCursor || page.reset)
      throw new Error(`Reviewer dispatch ${run.id} remains uncertain; its timeline is unreadable or incomplete`);
    const messageId = `ns-run-${run.id}`;
    if (page.entries.some(entry => entry.item.type === 'user_message'
      && ((entry.item as Record<string, unknown>).messageId === messageId
        || (entry.item as Record<string, unknown>).clientMessageId === messageId)))
      throw new Error(`Reviewer dispatch ${run.id} remains uncertain; timeline contains ${messageId}`);
    const latestTask = this.store.task(taskId), latest = this.store.run(runId);
    if (latestTask.version !== task.version || !latest || !isDeepStrictEqual(latest, run))
      throw new Error('Reviewer dispatch changed during timeline reconciliation; refresh task detail');
    this.store.transaction(() => {
      this.store.putRun({ ...run, status: 'superseded', released: true, active: false });
      this.store.event(taskId, 'run_delivery_not_delivered', `${runId}: agent ${run.agentId} ${archived ? 'archived' : 'closed'}; complete readable timeline has no ${messageId}`);
    });
    return true;
  }

  /** Re-prove one uncertain run creation from its exact stable message identity. */
  async reconcileUncertainRunDelivery(taskId: string, runId: string): Promise<boolean> {
    const task = this.store.task(taskId), run = this.store.run(runId);
    if (!run || run.taskId !== taskId || run.status !== 'uncertain' || !run.agentId || !run.workspaceId) return false;
    if (!this.adapter.agentTimelinePage || !this.adapter.originAgent)
      throw new Error(`Run ${runId} remains uncertain; its exact creation timeline is unavailable`);
    const origin = await this.resolution.host.originAgent(run.agentId);
    if (!origin || origin.workspaceId !== run.workspaceId)
      throw new Error(`Run ${runId} remains uncertain; its agent workspace identity changed`);
    const archived = origin.archived;
    if (!archived) {
      const observed = await this.resolution.host.observe(run.agentId);
      if (observed.id !== run.agentId || observed.workspaceId !== run.workspaceId || observed.status !== 'closed'
        || observed.active || observed.activeTurnId || observed.permissions)
        throw new Error(`Run ${runId} remains uncertain; its agent is not proven closed or archived`);
    }
    const page = await this.resolution.host.agentTimelinePage(run.agentId, 100);
    if (!page || page.hasOlder !== false || page.gap || page.staleCursor || page.reset)
      throw new Error(`Run ${runId} remains uncertain; its timeline is unreadable or incomplete`);
    const messageId = `ns-run-${run.id}`;
    const found = page.entries.some(entry => entry.item.type === 'user_message'
      && ((entry.item as Record<string, unknown>).messageId === messageId
        || (entry.item as Record<string, unknown>).clientMessageId === messageId));
    const latestTask = this.store.task(taskId), latestRun = this.store.run(runId);
    if (latestTask.version !== task.version || !latestRun || !isDeepStrictEqual(latestRun, run))
      throw new Error(`Run ${runId} changed during timeline reconciliation; refresh task detail`);
    if (found) {
      this.store.putRun({ ...run, status: 'running' });
      this.store.event(taskId, 'run_delivery_reconciled', `${runId}: exact creation message observed`);
      return true;
    }
    this.store.transaction(() => {
      this.store.putRun({ ...run, status: 'superseded', released: true, active: false });
      this.store.event(taskId, 'run_delivery_not_delivered', `${runId}: agent ${run.agentId} ${archived ? 'archived' : 'closed'}; complete readable timeline has no ${messageId}`);
    });
    return true;
  }

  /**
   * Clear stale operation attention only when exact same-intent delivery
   * evidence exists: the delivery names the operation that reserved it, and an
   * inspection names the delivery, so both settle by identity.
   */
  reconcileReviewDeliveryOperations(taskId: string, runId: string, deliveryId: string, evidence: string) {
    const task = this.store.task(taskId), run = this.store.run(runId);
    const delivery = run?.reviewDeliveries?.find(item => item.deliveryId === deliveryId);
    if (!run || run.taskId !== taskId || !delivery || delivery.status !== 'delivered' || delivery.evidence !== evidence) return;
    // The reserving operation, and any same-intent inspection that recorded
    // this exact delivery as still uncertain.
    const operations = this.store.operations({ taskId, states: ['needs_attention'], limit: 1000 })
      .filter(item => item.kind === 'task_control' && (item.id === delivery.operationId || item.diagnostic.includes(deliveryId)));
    for (const operation of operations) {
      const at = now();
      this.store.putOperation({ ...operation, state: 'succeeded', settledAt: at, diagnostic: '',
        result: { taskId: task.id, taskVersion: task.version, phase: task.phase, number: task.number ?? null, reference: task.reference ?? null },
        effect: operation.effect ? { ...operation.effect, status: 'reconciled', result: evidence.slice(0, 2000), resultAt: at } : null });
    }
  }

  /** Whether the reviewer's timeline holds this exact delivery message; a failed read is unknown, never absence. */
  async deliveryInTimeline(run: Run, deliveryId: string): Promise<boolean> {
    if (!run.agentId) return false;
    try {
      const page = await this.resolution.host.agentTimelinePage(run.agentId, 100);
      return timelineMessage(page, deliveryId) === 'present';
    } catch { return false; }
  }
  async reconcileReviewDelivery(run: Run, authorization: ReviewDeliveryAuthorization): Promise<ReviewDeliveryAuthorization> {
    const latest = this.store.run(run.id)!;
    const delivery = latest.reviewDeliveries?.find(item => item.deliveryId === authorization.deliveryId) ?? authorization;
    if (delivery.status === 'refused') return delivery;
    if (delivery.status === 'delivered') {
      // Callback evidence settled it without proving receipt of the brief it carried: upgrade the pin from the timeline.
      if (delivery.briefVersion !== null && (latest.briefVersion ?? 0) < delivery.briefVersion && await this.resolution.deliveryInTimeline(latest, delivery.deliveryId))
        this.resolution.settleReviewDelivery(latest.id, delivery.deliveryId, 'delivered', `Timeline contains exact user message ${delivery.deliveryId}`, true);
      return this.store.run(latest.id)!.reviewDeliveries!.find(item => item.deliveryId === delivery.deliveryId)!;
    }
    // The exact timeline message is the strongest evidence: it proves receipt, so it is read first.
    if (await this.resolution.deliveryInTimeline(latest, delivery.deliveryId)) {
      this.resolution.settleReviewDelivery(latest.id, delivery.deliveryId, 'delivered', `Timeline contains exact user message ${delivery.deliveryId}`, true);
      return this.store.run(latest.id)!.reviewDeliveries!.find(item => item.deliveryId === delivery.deliveryId)!;
    }
    // A checkpoint is saved progress, not delivery identity: its ordinal is
    // assigned on receipt, so an earlier checkpoint delayed behind a later send
    // says nothing about that send. Without the exact timeline message the
    // occurrence stays unknown and keeps its durable hold.
    this.resolution.settleReviewDelivery(latest.id, delivery.deliveryId, 'uncertain', 'No matching delivery evidence was available; absence is not proof that send did not occur');
    return this.store.run(latest.id)!.reviewDeliveries!.find(item => item.deliveryId === delivery.deliveryId)!;
  }

  /** Owner `retry_effect` observes one exact reviewer delivery identity. */
  async reconcileReviewDeliveryEffect(taskId: string, deliveryId: string): Promise<ReviewDeliveryAuthorization> {
    const run = this.store.runs(taskId).find(candidate => candidate.reviewDeliveries?.some(item => item.deliveryId === deliveryId));
    const delivery = run?.reviewDeliveries?.find(item => item.deliveryId === deliveryId);
    if (!run || !delivery) throw new Error(`No reviewer delivery ${deliveryId} is recorded on this task`);
    return this.resolution.reconcileReviewDelivery(run, delivery);
  }

  /** Observe an exact attention notice before settling its uncertain delivery. */
  async reconcileAttentionNoticeEffect(taskId: string, noticeId: string): Promise<boolean> {
    const notice = this.store.notices(taskId).find(item => item.id === noticeId && item.kind === 'attention');
    if (!notice || !['intent', 'uncertain'].includes(notice.status)) return false;
    if (!notice.agentId || !this.adapter.agentTimelinePage)
      throw new Error(`Attention notice ${noticeId} remains uncertain; its recipient timeline is unavailable`);
    const page = await this.resolution.host.agentTimelinePage(notice.agentId, 100);
    if (!page || page.hasOlder !== false || page.gap || page.staleCursor || page.reset)
      throw new Error(`Attention notice ${noticeId} remains uncertain; its recipient timeline is incomplete`);
    const delivered = page.entries.some(entry => entry.item.type === 'user_message'
      && ((entry.item as Record<string, unknown>).messageId === noticeId
        || (entry.item as Record<string, unknown>).clientMessageId === noticeId));
    if (!delivered) throw new Error(`Attention notice ${noticeId} remains uncertain; complete timeline has no exact message, so it was not resent`);
    const current = this.store.notices(taskId).find(item => item.id === noticeId);
    if (!current || !['intent', 'uncertain'].includes(current.status)) return false;
    this.store.putNotice({ ...current, status: 'delivered', error: '' });
    this.store.event(taskId, 'attention_notice_reconciled', `${noticeId}: exact recipient timeline message observed`);
    return true;
  }
}
