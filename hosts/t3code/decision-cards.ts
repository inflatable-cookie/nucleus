/**
 * Settle the native cards this adapter raised when their decision changes elsewhere, and
 * record the cards T3 still shows pending so the next held turn raises only the rest.
 */
import type {
  AcpCardScope,
  AcpPendingCard,
  AcpSessionSurface,
} from "../../shared/acp/surface";
import { rustInboxDecisionId } from "../../shared/rust-inbox";
import type { Projection, T3Reads } from "./reads";
import { activeStatuses } from "./reads";

interface CardContext {
  acp(): AcpSessionSurface | null;
  reads: T3Reads;
  respond(
    threadId: string,
    workspaceId: string,
    requestId: string,
    response: { answers?: Record<string, unknown>; decision?: "cancel" },
  ): Promise<void>;
}

export class T3DecisionCards {
  constructor(private readonly core: CardContext) {}

  /**
   * `settled` is true only when the thread was read and every Nucleus card on it is
   * answered or cancelled on T3. A null result means its cards are unobserved.
   *
   * The cards T3 still shows pending are recorded for `scope`, so the service offers a
   * version again exactly when the host's own read shows no live card for it: a card lost
   * with its turn is absent here and comes back on the next held turn (nucleus#1395).
   */
  async reconcile(
    threadId: string,
    workspaceId: string,
    scope: AcpCardScope,
  ): Promise<{ settled: boolean } | null> {
    const acp = this.core.acp();
    if (!acp) return null;
    let present: AcpPendingCard[] | null = null;
    try {
      if (
        acp.decisionSettlement &&
        (await this.core.reads.isObserved(threadId))
      ) {
        present = await this.readAndSettle(
          threadId,
          workspaceId,
          acp.decisionSettlement.bind(acp),
          scope,
        );
      }
    } finally {
      acp.observedCards?.(scope, present);
    }
    return present === null ? null : { settled: present.length === 0 };
  }

  private async readAndSettle(
    threadId: string,
    workspaceId: string,
    settlement: NonNullable<AcpSessionSurface["decisionSettlement"]>,
    scope: AcpCardScope,
  ): Promise<AcpPendingCard[] | null> {
    const projection = await this.core.reads.readProjection(threadId, "window");
    const liveRuns = new Set(
      projection.runs
        .filter((run) => activeStatuses.has(run.status))
        .map((run) => run.id),
    );
    const present: AcpPendingCard[] = [];
    // A window keeps only the newest timeline suffix. A pending card older than that
    // suffix has no item in the window, so its question is read from the full transcript.
    let transcript: Projection | null = null;
    for (const request of projection.runtimeRequests) {
      if (request.kind !== "user_input" || request.status !== "pending")
        continue;
      let item = projection.turnItems.find(
        (row) =>
          row.type === "user_input_request" && row.requestId === request.id,
      );
      if (!item) {
        transcript ??= await this.core.reads.readProjection(
          threadId,
          "transcript",
        );
        item = transcript.turnItems.find(
          (row) =>
            row.type === "user_input_request" && row.requestId === request.id,
        );
      }
      // An unidentified pending request could be a live Nucleus card.
      if (!item) return null;
      if (item.questions?.length !== 1) continue;
      const question = item.questions[0];
      if (!question) continue;
      const match = /^nucleus_(.+)_(\d+)$/.exec(question.id);
      if (!match) continue;
      const id = match[1]!;
      if (!/^[0-9a-f-]{36}$/i.test(id) && !rustInboxDecisionId.safeParse(id).success)
        continue;
      const version = Number(match[2]!);
      const decision = settlement(id, version, scope);
      const stale =
        request.responseCapability.type === "message" ||
        Boolean(item.runId && !liveRuns.has(item.runId));
      if (decision.state === "open" && !stale) {
        present.push({ id, version });
        continue;
      }
      const response =
        decision.state === "answered" && decision.answer !== undefined
          ? { answers: { [question.id]: decision.answer } }
          : { decision: "cancel" as const };
      await this.core.respond(threadId, workspaceId, request.id, response);
    }
    return present;
  }
}
