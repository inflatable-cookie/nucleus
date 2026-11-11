import type { HostRetainedAgentRef } from "../../../shared/host";
import type { PaseoAdapter } from "./paseo";

/** Native retained-message operations, with the adapter read at each call. */
export class PaseoMessageHost {
  constructor(private readonly owner: PaseoAdapter) {}
  retainedAgentRef(id: string): HostRetainedAgentRef {
    const agent = this.owner.api.agents.ref(id);
    return {
      get workspaceId() { return agent.workspaceId; },
      get archivedAt() { return agent.archivedAt; },
      get status() { return agent.status; },
      get activeTurn() { return agent.activeTurn; },
      get pendingPermissions() { return agent.pendingPermissions; },
      get runtimeInfo() { return agent.runtimeInfo; },
      refresh: () => agent.refresh(),
      current: () => agent.current(),
      send: (text, options) => agent.send(text, options),
    };
  }
  async interruptAndContinue(id: string, messageId: string, text: string): Promise<void> {
    await this.owner.client.sendAgentMessage(id, text, { messageId, activeTurnBehavior: "interrupt" });
  }
  /**
   * Queue behind the current step: the same retained-agent send checkpoint
   * continuation uses. No `activeTurnBehavior: "interrupt"`.
   */
  async enqueueMessage(id: string, messageId: string, text: string): Promise<void> {
    const agent = this.owner.api.agents.ref(id);
    await agent.send(text, { messageId });
  }
  private readonly idleDeliveries = new Map<string, Promise<void>>();
  /** Bound host reads, delivery and queue waits without cancelling an unknown send. */
  async beforeDeliveryDeadline<T>(operation: Promise<T>, deadline: number, signal: AbortSignal): Promise<{ value: T } | null> {
    let timer: ReturnType<typeof setTimeout>;
    let abort = () => {};
    const expired = new Promise<null>(resolve => {
      abort = () => resolve(null);
      timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || Date.now() >= deadline) abort();
    });
    try { return await Promise.race([operation.then(value => ({ value })), expired]); }
    finally { clearTimeout(timer!); signal.removeEventListener('abort', abort); }
  }
  /** Serialize each recipient's wait and send, including queue time in the window. */
  async sendWhenIdle(agentId: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }): Promise<boolean> {
    if (input.signal.aborted || input.timeoutMs <= 0) return false;
    const deadline = Date.now() + input.timeoutMs;
    const previous = this.idleDeliveries.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    this.idleDeliveries.set(agentId, slot);
    let sendFence: Promise<void> | undefined;
    try {
      if (!await this.beforeDeliveryDeadline(previous, deadline, input.signal)) return false;
      return await this.sendWhenIdleNow(agentId, input, deadline, sending => { sendFence = sending; });
    } finally {
      // A timed-out read is safe to leave behind. A send may still arrive, so
      // later deliveries stay behind that actual host operation until it settles.
      void (sendFence ?? previous).then(() => {
        release();
        if (this.idleDeliveries.get(agentId) === slot) this.idleDeliveries.delete(agentId);
      });
    }
  }
  /** A missing idle proof is known unsent; an unfinished send has unknown delivery. */
  async sendWhenIdleNow(agentId: string, input: { prompt: string; signal: AbortSignal; timeoutMs: number; messageId: string; sourceAgentId?: string }, deadline: number, fence: (sending: Promise<void>) => void): Promise<boolean> {
    const agent = this.owner.api.agents.ref(agentId);
    while (!input.signal.aborted && Date.now() < deadline) {
      const refreshed = await this.beforeDeliveryDeadline(agent.refresh(), deadline, input.signal);
      if (!refreshed?.value || agent.archivedAt) return false;
      if (input.signal.aborted || Date.now() >= deadline) return false;
      if (agent.status === 'idle' && !agent.activeTurn && !agent.pendingPermissions?.length) {
        // Refresh again immediately before enqueue; Paseo does not offer an atomic idle guard.
        const confirmed = await this.beforeDeliveryDeadline(agent.refresh(), deadline, input.signal);
        if (!confirmed?.value || agent.archivedAt || input.signal.aborted || Date.now() >= deadline) return false;
        if (agent.status !== 'idle' || agent.activeTurn || agent.pendingPermissions?.length) continue;
        const sending = this.sendPlannerMessage(agentId, input);
        fence(sending.then(() => {}, () => {}));
        if (!await this.beforeDeliveryDeadline(sending, deadline, input.signal))
          throw new Error(`Nucleus message ${input.messageId} delivery outcome unknown after timeout or abort; never resend`);
        return true;
      }
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); input.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, Math.min(250, Math.max(0, deadline - Date.now())));
        input.signal.addEventListener('abort', finish, { once: true });
      });
    }
    return false;
  }
  async sendPlannerMessage(agentId: string, input: { prompt: string; messageId: string; sourceAgentId?: string }): Promise<void> {
    // Only an explicit negative response is safe to retry. Transport failures are unknown.
    const client = this.owner.provenanceClient as unknown as { sendRequest(args: unknown): Promise<{ accepted: boolean; error?: string | null }> };
    const requestId = crypto.randomUUID();
    const response = await client.sendRequest({ requestId, message: { type: 'send_agent_message_request', requestId, agentId, text: input.prompt, messageId: input.messageId, sourceAgentId: input.sourceAgentId ?? 'nucleus' }, options: { skipQueue: true }, select: (msg: { type: string; payload: { requestId: string } }) => msg.type === 'send_agent_message_response' && msg.payload.requestId === requestId ? msg.payload : null });
    if (!response.accepted) await this.owner.client.sendAgentMessage(agentId, input.prompt, { messageId: input.messageId });
  }
}
