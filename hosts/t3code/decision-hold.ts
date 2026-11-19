/** A fresh, durable occurrence re-enters an idle ACP thread when it needs a held turn. */
import { activeStatuses, type T3Reads } from "./reads";
import { canonical, type T3StateFile } from "./state";
import { identity, type T3IntentLedger } from "./intents";
import { HOLD_MARKER } from "./nesting";
import { T3CompatibilityError } from "./contracts";

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
      // An acknowledged receipt proves the occurrence landed, and the observation above
      // proves no run is live or queued, so no history read is needed (nucleus#1407).
      if (
        intent.status !== "settled" &&
        !(await this.occurrenceFinished(
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
   * occurrence may go. Only the newest window's user message is read: finding it there is
   * exact, while its absence proves nothing unless the window is the whole history. A timed-out
   * send still has a late reply in flight. Ambiguity that the window cannot settle is raised,
   * never skipped silently, and nothing is resent (nucleus#1407).
   */
  private async occurrenceFinished(
    threadId: string,
    commandId: string,
    messageId: string,
    unknown: boolean,
    timedOut: boolean,
  ): Promise<boolean> {
    const read = await this.core.reads.readWindow(threadId);
    const items = read.projection.turnItems.filter(
      (item) => item.type === "user_message" && item.messageId === messageId,
    );
    if (items.length > 1) return false;
    if (items.length === 1) {
      const run = read.projection.runs.find((row) => row.id === items[0].runId);
      if (!run || activeStatuses.has(run.status)) return false;
      if (unknown) this.settleIntent(commandId, "settled");
      return true;
    }
    if (read.paged || read.omitsTurnItems)
      throw new T3CompatibilityError(
        `Nucleus inbox wake ${commandId} has an unsettled send older than T3's snapshot window, so T3 cannot show whether it landed; re-entry waits and nothing is resent`,
      );
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
