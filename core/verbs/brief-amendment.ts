import { z } from "zod";
import type { Task } from "../../shared/contracts";
import type { Engine } from "../engine";

const INTENT = 'brief_amendment_delivery_intent';
const ATTEMPT = 'brief_amendment_delivery_attempt';
const DELIVERED = 'brief_amendment_delivered';

/** One durable send intent: the amendment message, its recipient and the run that owns it. */
const intentSchema = z.object({
  messageId: z.string().min(1),
  hostId: z.string().min(1).nullable(),
  agentId: z.string().min(1),
  role: z.enum(['worker', 'reviewer']),
  version: z.number().int().positive(),
});
type DeliveryIntent = z.infer<typeof intentSchema>;

/**
 * Amendment intents recorded before this module typed the line. The durable
 * record is history, so its one legacy shape stays readable here rather than in
 * every reader.
 */
const LEGACY_INTENT = /^([^:]+): host (\S+); agent (\S+); role (\S+); version (\d+)$/;

/** The recorded intent, decoded once, or null when the line is not a send intent. */
function decodeIntent(detail: string): DeliveryIntent | null {
  const line = detail.trim();
  if (line.startsWith('{')) {
    try { return intentSchema.parse(JSON.parse(line)); } catch { return null; }
  }
  const legacy = LEGACY_INTENT.exec(line);
  if (!legacy) return null;
  const [, messageId, hostId, agentId, role, version] = legacy;
  if (role !== 'worker' && role !== 'reviewer') return null;
  return { messageId: messageId!, hostId: hostId === 'none' ? null : hostId!, agentId: agentId!, role, version: Number(version) };
}

/**
 * The delivery half of a brief amendment: a live worker or reviewer is told of
 * the amendment behind its current step. The intent is recorded durably before
 * any send, the attempt is recorded before the host call, and the delivered
 * marker after it — so an unknown delivery is never resent while an intent that
 * never reached the host is delivered by a later pass.
 */
export class BriefAmendmentDelivery {
  constructor(readonly engine: Engine) {}
  get store() { return this.engine.store; }

  /** The message one amendment version carries. */
  message(next: { version: number; digest: string; text: string; reason: string }): string {
    return `The operator amended this task's Nucleus-held brief to version ${next.version} (${next.digest}). Reason: ${next.reason}. This message is queued behind your current step; continue from the new brief. Earlier instructions that conflict with it no longer apply.\n\n${next.text}`;
  }

  /** Durable send intent for each live worker and reviewer thread; unknown delivery is never resent. */
  recordIntents(task: Task, version: number): void {
    const recorded = this.intents(task.id);
    for (const role of ['worker', 'reviewer'] as const) {
      const identity = this.engine.resolution.agentMessages.messageRecipientIdentity(task, role);
      if (!identity.live || !identity.agentId) continue;
      const messageId = `ns-brief-amendment-${task.id}-v${version}-${role}`;
      if (recorded.some(intent => intent.messageId === messageId)) continue;
      this.store.event(task.id, INTENT, JSON.stringify({ messageId, hostId: task.hostId ?? null, agentId: identity.agentId, role, version }));
    }
  }

  /** Every decoded intent this task recorded, in event order. */
  private intents(taskId: string): DeliveryIntent[] {
    return this.store.eventsAll(taskId).flatMap(event => {
      if (event.kind !== INTENT) return [];
      const intent = decodeIntent(event.detail);
      return intent ? [intent] : [];
    });
  }

  private recorded(taskId: string, kind: string, messageId: string): boolean {
    return this.store.eventsAll(taskId).some(event => event.kind === kind && event.detail.startsWith(`${messageId}:`));
  }

  /**
   * Deliver every recorded intent that has neither a delivered marker nor an
   * attempt. Called by the amending control and again by the ordinary pass, so an
   * intent recorded while the host was offline is delivered later; an attempted
   * send whose outcome is unknown is refused a second send and reported as it is.
   */
  async deliverPending(onlyTaskId?: string): Promise<void> {
    if (this.engine.stopped) return;
    const taskIds = onlyTaskId ? [onlyTaskId]
      : (this.store.db.prepare("SELECT id FROM tasks WHERE json_extract(data,'$.briefVersions') IS NOT NULL").all() as Array<{ id: string }>).map(row => row.id);
    for (const taskId of taskIds) {
      const task = this.store.task(taskId);
      if (!task.hostId) continue;
      for (const intent of this.intents(taskId)) {
        if (this.recorded(taskId, DELIVERED, intent.messageId) || this.recorded(taskId, ATTEMPT, intent.messageId)) continue;
        const version = task.briefVersions.find(item => item.version === intent.version);
        if (!version) continue;
        await this.deliver(task, intent, this.message(version));
      }
    }
  }

  /** One bounded send for one recorded intent. */
  async deliver(task: Task, intent: DeliveryIntent, text: string): Promise<void> {
    const hostId = task.hostId ?? intent.hostId;
    if (!hostId || !this.engine.resolution.originHostAvailable(hostId) || !this.engine.adapter.enqueueMessage) return;
    this.store.event(task.id, ATTEMPT, `${intent.messageId}: ${JSON.stringify({ hostId, agentId: intent.agentId })}`);
    try {
      await this.engine.resolution.withHost(hostId, () => this.engine.adapter.enqueueMessage!(intent.agentId, intent.messageId, text));
      if (!this.recorded(task.id, DELIVERED, intent.messageId))
        this.store.event(task.id, DELIVERED, `${intent.messageId}: ${JSON.stringify({ agentId: intent.agentId })}`);
    } catch (error) {
      // Delivery is unknown: the attempt keeps a later pass from sending twice.
      this.store.event(task.id, 'brief_amendment_delivery_unknown',
        `${intent.messageId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000));
    }
  }
}
