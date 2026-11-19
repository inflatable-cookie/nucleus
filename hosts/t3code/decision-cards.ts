/** Settle the native cards this adapter raised when their decision changes elsewhere. */
import type { AcpSessionSurface } from "../../shared/acp/surface";
import type { T3Reads } from "./reads";
import { activeStatuses } from "./reads";

interface CardContext {
  acp(): AcpSessionSurface | null;
  reads: T3Reads;
  respond(threadId: string, workspaceId: string, requestId: string, response: { answers?: Record<string, unknown>; decision?: "cancel" }): Promise<void>;
}

export class T3DecisionCards {
  constructor(private readonly core: CardContext) {}

  /**
   * `settled` is true only when the thread was read and every Nucleus card on it is
   * answered or cancelled on T3. An unread thread is never settled.
   */
  async reconcile(threadId: string, workspaceId: string): Promise<{ settled: boolean }> {
    const acp = this.core.acp();
    if (!acp?.decisionSettlement || !(await this.core.reads.isObserved(threadId))) return { settled: false };
    const projection = await this.core.reads.readProjection(threadId, "window");
    const liveRuns = new Set(projection.runs.filter(run => activeStatuses.has(run.status)).map(run => run.id));
    let open = 0;
    for (const request of projection.runtimeRequests) {
      if (request.kind !== "user_input" || request.status !== "pending") continue;
      const item = projection.turnItems.find(row => row.type === "user_input_request" && row.requestId === request.id);
      if (!item || item.questions?.length !== 1) continue;
      const question = item.questions[0];
      if (!question) continue;
      const match = /^nucleus_([0-9a-f-]{36})_(\d+)$/i.exec(question.id);
      if (!match) continue;
      const decision = acp.decisionSettlement(match[1]!, Number(match[2]!));
      const stale = request.responseCapability.type === "message" || Boolean(item.runId && !liveRuns.has(item.runId));
      if (decision.state === "open" && !stale) { open++; continue; }
      const response = decision.state === "answered" && decision.answer !== undefined
        ? { answers: { [question.id]: decision.answer } }
        : { decision: "cancel" as const };
      await this.core.respond(threadId, workspaceId, request.id, response);
    }
    return { settled: open === 0 };
  }
}
