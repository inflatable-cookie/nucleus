/** A fresh, durable occurrence re-enters an idle ACP thread when it needs a held turn. */
import { T3CompatibilityError } from "./contracts";
import { activeStatuses, type T3Reads } from "./reads";
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
    let projection = await this.core.reads.readProjection(
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
      // Check the newest bounded window first so long threads keep advancing when the
      // previous hold message is still visible; only fall back to the full transcript
      // when absent so unknown-delivery absence is never guessed from a bounded slice.
      projection = await this.core.reads.readProjection(threadId, "window");
      let items = projection.turnItems.filter(
        (item) =>
          item.type === "user_message" && item.messageId === previous.messageId,
      );
      let settledBeforeWindow = false;
      if (items.length === 0) {
        try {
          projection = await this.core.reads.readProjection(
            threadId,
            "transcript",
          );
          items = projection.turnItems.filter(
            (item) =>
              item.type === "user_message" &&
              item.messageId === previous.messageId,
          );
        } catch (error) {
          if (
            !(error instanceof T3CompatibilityError) ||
            error.field !== "subscribeThread: incomplete projection" ||
            intent.status !== "settled" ||
            !projection.turnItems.some((item) => item.type === "user_message")
          ) {
            throw error;
          }
          // Settled in an earlier turn that has since scrolled past the bounded window
          // while all runs on the thread are now inactive.
          settledBeforeWindow = true;
        }
      }
      if (items.length > 1) return;
      if (items.length === 1) {
        const runId = items[0].runId;
        const run = projection.runs.find((row) => row.id === runId);
        if (!run || activeStatuses.has(run.status)) return;
        if (intent?.status === "unknown")
          this.core.state.update((state) => {
            const current = state.intents[previous.commandId];
            if (current?.status === "unknown") current.status = "settled";
          });
      } else if (!settledBeforeWindow) {
        if (!intent || intent.status === "settled" || intent.timedOut) return;
        if (intent.status === "unknown")
          this.core.state.update((state) => {
            const current = state.intents[previous.commandId];
            if (current?.status === "unknown") current.status = "refused";
          });
      }
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
