/** A fresh, durable occurrence re-enters an idle ACP thread when it needs a held turn. */
import { activeStatuses, type T3Reads } from "./reads";
import { canonical, type T3StateFile } from "./state";
import { identity, type T3IntentLedger } from "./intents";
import { HOLD_MARKER } from "./nesting";

interface HoldContext {
  hostId(): string;
  state: T3StateFile;
  reads: T3Reads;
  intents: T3IntentLedger;
  unsettle(threadId: string, messageId: string): Promise<void>;
}

export class T3DecisionHold {
  constructor(private readonly core: HoldContext) {}
  async reconcile(threadId: string): Promise<void> {
    if (!(await this.core.reads.isObserved(threadId))) return;
    let projection = await this.core.reads.readProjection(threadId, "observation");
    if (projection.thread.deletedAt || projection.thread.archivedAt || projection.runs.some(run => activeStatuses.has(run.status))) return;
    const previous = this.core.state.read().decisionHolds?.[threadId];
    let generation = 0;
    if (previous) {
      const intent = this.core.state.read().intents[previous.commandId];
      if (!intent) { await this.send(threadId, previous.commandId, previous.messageId); return; }
      // A transcript must prove whether this exact occurrence landed; a bounded
      // window cannot prove absence. A timed-out send still has a late reply in flight.
      projection = await this.core.reads.readProjection(threadId, "transcript");
      const items = projection.turnItems.filter(item => item.type === "user_message" && item.messageId === previous.messageId);
      if (items.length > 1) return;
      if (items.length === 1) {
        const runId = items[0].runId;
        const run = projection.runs.find(row => row.id === runId);
        if (!run || activeStatuses.has(run.status)) return;
        if (intent?.status === "unknown") this.core.state.update(state => {
          const current = state.intents[previous.commandId];
          if (current?.status === "unknown") current.status = "settled";
        });
      } else {
        if (!intent || intent.status === "settled" || intent.timedOut) return;
        if (intent.status === "unknown") this.core.state.update(state => {
          const current = state.intents[previous.commandId];
          if (current?.status === "unknown") current.status = "refused";
        });
      }
      generation = previous.generation + 1;
    } else if (!projection.runs.length) {
      // The launch may still be starting. A terminal run proves this is a re-entry.
      return;
    }
    const commandId = identity("decision-hold", canonical([this.core.hostId(), threadId, generation]));
    const messageId = identity("message", commandId);
    this.core.state.update(state => {
      state.decisionHolds ??= {};
      state.decisionHolds[threadId] = { generation, commandId, messageId };
    });
    await this.send(threadId, commandId, messageId);
  }

  private async send(threadId: string, commandId: string, messageId: string): Promise<void> {
    await this.core.unsettle(threadId, messageId);
    await this.core.intents.effect(commandId, "orchestration.dispatchCommand", {
      type: "message.dispatch", createdBy: "user", creationSource: "server", commandId, threadId, messageId,
      text: HOLD_MARKER, attachments: [], dispatchMode: { type: "queue_after_active" },
    });
  }
}
