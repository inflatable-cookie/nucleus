/** A fresh, durable occurrence re-enters an idle ACP thread when it needs a held turn. */
import { activeStatuses, type Projection, type T3Reads } from "./reads";
import { canonical, type T3StateFile } from "./state";
import { identity, type T3IntentLedger } from "./intents";
import { HOLD_MARKER } from "./nesting";

interface HoldContext {
  hostId(): string;
  state: T3StateFile;
  reads: T3Reads;
  intents: T3IntentLedger;
  wake(threadId: string, messageId: string): Promise<void>;
}

export class T3DecisionHold {
  constructor(private readonly core: HoldContext) {}
  async reconcile(threadId: string): Promise<void> {
    if (!(await this.core.reads.isObserved(threadId))) return;
    const projection = await this.core.reads.readProjection(
      threadId,
      "observation",
    );
    if (
      projection.thread.deletedAt ||
      projection.thread.archivedAt ||
      projection.runs.some((run) => activeStatuses.has(run.status))
    )
      return;
    const previous = this.core.state.read().decisionHolds?.[threadId];
    let generation = 0;
    if (previous) {
      const intent = this.core.state.read().intents[previous.commandId];
      if (!intent) {
        await this.send(threadId, previous.commandId, previous.messageId);
        return;
      }
      // An acknowledged receipt is final. The observation above proves no run is live or
      // queued, so an acknowledged wake needs no history read, however far it has moved
      // out of T3's window (nucleus#1407).
      if (
        intent.status !== "settled" &&
        !(await this.unsettledOccurrenceFinished(
          threadId,
          previous.commandId,
          previous.messageId,
          intent.status === "unknown",
          intent.timedOut === true,
        ))
      )
        return;
      generation = previous.generation + 1;
    } else if (!projection.runs.length) {
      // The launch may still be starting. A terminal run proves this is a re-entry.
      return;
    }
    const commandId = identity(
      "decision-hold",
      canonical([this.core.hostId(), threadId, generation]),
    );
    const messageId = identity("message", commandId);
    this.core.state.update((state) => {
      state.decisionHolds ??= {};
      state.decisionHolds[threadId] = { generation, commandId, messageId };
    });
    await this.send(threadId, commandId, messageId);
  }

  /**
   * Whether an unsettled occurrence (unknown, refused or timed out) is decided, so the next
   * occurrence may go. The newest window is read first: finding the occurrence there is
   * exact. Absence is read from the full transcript, the only read that can prove it; a
   * paged transcript throws its incompatibility, so absence is never inferred from a bounded
   * suffix and nothing is resent (nucleus#1407). A timed-out send still has a late reply in flight.
   */
  private async unsettledOccurrenceFinished(
    threadId: string,
    commandId: string,
    messageId: string,
    unknown: boolean,
    timedOut: boolean,
  ): Promise<boolean> {
    let read: Projection = await this.core.reads.readProjection(
      threadId,
      "window",
    );
    let items = occurrenceOf(read, messageId);
    if (items.length === 0) {
      read = await this.core.reads.readProjection(threadId, "transcript");
      items = occurrenceOf(read, messageId);
    }
    if (items.length > 1) return false;
    if (items.length === 1) {
      const run = read.runs.find((row) => row.id === items[0].runId);
      if (!run || activeStatuses.has(run.status)) return false;
      if (unknown) this.settleIntent(commandId, "settled");
      return true;
    }
    if (timedOut) return false;
    if (unknown) this.settleIntent(commandId, "refused");
    return true;
  }

  private settleIntent(commandId: string, status: "settled" | "refused"): void {
    this.core.state.update((state) => {
      const current = state.intents[commandId];
      if (current?.status === "unknown") current.status = status;
    });
  }

  private async send(
    threadId: string,
    commandId: string,
    messageId: string,
  ): Promise<void> {
    await this.core.wake(threadId, messageId);
    await this.core.intents.effect(commandId, "orchestration.dispatchCommand", {
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "server",
      commandId,
      threadId,
      messageId,
      text: HOLD_MARKER,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
  }
}

/** The user messages carrying one occurrence's message id in a read. */
function occurrenceOf(read: Projection, messageId: string) {
  return read.turnItems.filter(
    (item) => item.type === "user_message" && item.messageId === messageId,
  );
}
