import { taskOwner, type Task } from '../../../shared/contracts';
import { taskStopVerbsFor } from '../../../shared/task-stop';
import type { Ladder } from './ladder';
import type { PlannerEscalation } from './records';
import { unknownEscalationAttentionDetail } from './waits';

/**
 * An escalation whose delivery nobody observed is never resent. Once it outlives
 * the stall threshold the task surfaces as visible attention and the project
 * planner hears about it once on the agent channel; the stop is re-asserted each
 * pass, the message is not.
 */
export function attentionUnknownEscalation(
  ladder: Ladder,
  t: Task,
  escalation: Pick<PlannerEscalation, "id" | "question">,
): void {
  const current = ladder.store.task(t.id);
  const owner = taskOwner(current);
  ladder.resolution.recordStop(current, 'operator_needed', unknownEscalationAttentionDetail(escalation, owner), taskStopVerbsFor('operator_needed'));
  const events = ladder.store.eventsAll(t.id);
  if (events.some(event => event.kind === 'planner_escalation_attention' && event.detail.startsWith(`${escalation.id}:`))) return;
  ladder.store.event(t.id, 'planner_escalation_attention', `${escalation.id}: unknown delivery outlived the stall threshold; surfaced as visible attention with owner ${owner}`.slice(0, 4000));
  void notifyUnknownEscalation(ladder, ladder.store.task(t.id), escalation, owner);
}

/** One agent-channel message to the project's planner; the recorded intent prevents a resend. */
async function notifyUnknownEscalation(
  ladder: Ladder,
  t: Task,
  escalation: Pick<PlannerEscalation, "id" | "question">,
  owner: string,
): Promise<void> {
  if (ladder.attentioningEscalations.has(escalation.id)) return;
  if (ladder.store.eventsAll(t.id).some(event => event.kind === 'planner_escalation_attention_sent' && event.detail.startsWith(`${escalation.id}:`))) return;
  ladder.attentioningEscalations.add(escalation.id);
  try {
    if (!ladder.adapter.notify) {
      ladder.store.event(t.id, 'planner_escalation_attention_missed', `${escalation.id}: no agent-message channel is available`);
      return;
    }
    const recipient = await ladder.resolution.escalationRecipient(ladder.store.task(t.id)).catch(() => null);
    if (!recipient) {
      ladder.store.event(t.id, 'planner_escalation_attention_missed', `${escalation.id}: no project planner or task owner to message`);
      return;
    }
    const fresh = ladder.store.task(t.id);
    const host = recipient === fresh.originAgentId || recipient === fresh.notificationAgentId
      ? fresh.originHostId ?? fresh.hostId : await ladder.resolution.identifyOriginHost(recipient);
    if (!host || !ladder.resolution.withHost(host, () => ladder.resolution.originHostAvailable(host))) {
      ladder.store.event(t.id, 'planner_escalation_attention_missed', `${escalation.id}: ${recipient} is not reachable on a live host`);
      return;
    }
    // The durable intent is recorded before the send, so a delivery nobody
    // observed stays unknown and is never repeated.
    ladder.store.event(t.id, 'planner_escalation_attention_sent', `${escalation.id}: ${recipient} on host ${host}`);
    await ladder.resolution.withHost(host, () => ladder.resolution.host.sendMessage(recipient, {
      messageId: `ns-escalation-attention-${escalation.id}`, text: unknownEscalationAttentionDetail(escalation, owner) }));
    ladder.store.event(t.id, 'planner_escalation_attention_delivered', `${escalation.id}: ${recipient}`);
  } catch (error) {
    ladder.store.event(t.id, 'planner_escalation_attention_unknown', `${escalation.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
  } finally {
    ladder.attentioningEscalations.delete(escalation.id);
  }
}
