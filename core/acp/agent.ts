/**
 * Spec 065: the ACP agent itself, and nothing else.
 *
 * Agent Client Protocol over stdio: JSON-RPC 2.0, one object per line. Any
 * ACP-capable app can register this as a provider. A session is one Nucleus task's
 * thread, with no model and no improvisation:
 *
 * - `session/new` and `session/load` resolve the Nucleus-minted binding for the
 *   thread's working directory and attach to the service;
 * - `session/prompt` holds the turn open until the service releases it, showing the
 *   lifecycle lines the service sends, and forwards anything a person typed;
 * - `session/cancel` ends the turn at once (the client sends it before it steers).
 *
 * The agent knows nothing about any host. Everything host- or task-specific — the
 * binding, the transport, the "this prompt is not for you" rule — is injected by
 * whoever launches it (the ACP client's provider configuration and Nucleus itself).
 */
import { createHash } from "node:crypto";
import type { AcpBinding } from "./binding";
import type { AcpMessageInput, AcpTurnInput, AcpTurnReply } from "./surface";

export type { AcpMessageInput, AcpTurnInput, AcpTurnReply };

type Json = Record<string, unknown>;
type Id = number | string;
type Send = (message: Json) => void;

/** The ACP protocol revision this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;
/** One long-poll's wait. The service's own bound is 25 s; the transport adds a socket margin. */
export const ACP_TURN_WAIT_MS = 20_000;
const TRANSPORT_RETRY_DELAY_MS = 1_000;
const TRANSPORT_FAILURE_LIMIT = 3;

/**
 * ACP clients may require a model list, and T3 wants at least two entries. There is
 * no model behind either: they differ only in the name the client displays.
 */
export const ACP_MODELS = [
  { modelId: "nucleus", name: "Nucleus", description: "Nucleus task lifecycle: a real task, no model." },
  { modelId: "nucleus-quiet", name: "Nucleus (quiet)", description: "The same task thread; the lifecycle lines are identical." },
] as const;

/** The turn request the transport sends: the surface's input with the wait always named. */
export interface AcpTurnRequest extends AcpTurnInput { waitMs: number }
export type AcpMessageRequest = AcpMessageInput;
export interface AcpMessageReply { receipt: { status: string; detail?: string } }

/** The service calls one session makes. Injected, so the protocol is testable without a service. */
export interface AcpSessionTransport {
  turn(input: AcpTurnRequest, signal: AbortSignal): Promise<AcpTurnReply>;
  message(input: AcpMessageRequest): Promise<AcpMessageReply>;
}

/** What a thread's working directory resolves to: Nucleus's binding and how to reach the service. */
export interface AcpSessionSource { binding: AcpBinding; transport: AcpSessionTransport }

export interface AcpAgentOptions {
  /** Resolve the binding for a thread's working directory. A refusal is shown to the client. */
  resolve(cwd: string): Promise<AcpSessionSource>;
  /**
   * A prompt this agent must end without showing or forwarding, supplied by whoever
   * launches it: a host that wakes the thread with its own notification text (T3's
   * delegated-task wake, for one) is not a person speaking to the task.
   */
  ignore?(text: string, binding: AcpBinding): boolean;
  /** One long-poll's wait; the tests use a short one. */
  turnWaitMs?: number;
  /** Delay before retrying a service call that failed for transport reasons. */
  retryDelayMs?: number;
  /** Consecutive transport failures before the turn ends with an explanation. */
  maxTransportFailures?: number;
  version?: string;
  log?(line: string): void;
}

/** An ACP-level refusal: the client shows its message and nothing is invented. */
class AcpRefusal extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = "AcpRefusal"; }
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface SessionState {
  sessionId: string;
  taskId: string;
  binding: AcpBinding;
  transport: AcpSessionTransport;
  /** Lifecycle lines the service already sent, waiting for the next prompt to show them. */
  pending: string[];
  /** Whether the thread's opening prompt has been consumed. */
  prompted: boolean;
  cancelled: boolean;
  controller: AbortController;
  inFlight: boolean;
}

/**
 * One agent process. It serves any number of sessions (a client may open several),
 * keeps no durable state, and can be killed and relaunched at any time: the binding
 * and the service hold everything worth keeping.
 */
export class AcpAgent {
  private readonly sessions = new Map<string, SessionState>();
  private readonly work = new Set<Promise<unknown>>();
  private model: string = ACP_MODELS[0].modelId;

  constructor(private readonly options: AcpAgentOptions) {}

  private get turnWaitMs(): number { return this.options.turnWaitMs ?? ACP_TURN_WAIT_MS; }
  private get retryDelayMs(): number { return this.options.retryDelayMs ?? TRANSPORT_RETRY_DELAY_MS; }
  private get failureLimit(): number { return this.options.maxTransportFailures ?? TRANSPORT_FAILURE_LIMIT; }

  /** Read ACP traffic from `input`, answer on `output`, until the input closes. */
  async run(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
    const send: Send = message => { output.write(`${JSON.stringify(message)}\n`); };
    let buffer = "";
    for await (const chunk of input) {
      buffer += String(chunk);
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.dispatch(line, send);
      }
    }
    await Promise.allSettled([...this.work]);
  }

  /** End the session's turn now, as the client asked. The next prompt starts a new one. */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    session.controller.abort();
    this.options.log?.(`cancelled ${sessionId}`);
  }

  /**
   * Dispatch one message without blocking the reader: a held prompt must not stop
   * `session/cancel` from being read, and a client may send the cancel before the
   * prompt's own answer.
   */
  private dispatch(line: string, send: Send): void {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The Nucleus ACP agent reads one JSON-RPC message per line" } }); return; }
    if (!isObject(message) || message.jsonrpc !== "2.0") return;
    const id = message.id;
    const method = message.method;
    if (typeof id !== "number" && typeof id !== "string") {
      // A notification carries no answer. `session/cancel` is the only one the agent acts on.
      if (method === "session/cancel" && isObject(message.params) && typeof message.params.sessionId === "string")
        this.cancel(message.params.sessionId);
      return;
    }
    if (typeof method !== "string") { this.refuse(send, id, "Request has no method", -32600); return; }
    const running = this.handle(method, message.params, id, send)
      .catch(error => this.refuse(send, id, reasonOf(error), error instanceof AcpRefusal ? error.code : -32603));
    this.work.add(running);
    void running.finally(() => this.work.delete(running));
  }

  private refuse(send: Send, id: Id, message: string, code: number): void {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private result(send: Send, id: Id, result: Json): void {
    send({ jsonrpc: "2.0", id, result });
  }

  private async handle(method: string, params: unknown, id: Id, send: Send): Promise<void> {
    const input = isObject(params) ? params : {};
    switch (method) {
      case "initialize":
        this.result(send, id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          agentInfo: { name: "nucleus", title: "Nucleus", version: this.options.version ?? "0.0.0" },
          authMethods: [],
        });
        return;
      case "authenticate":
        // A Nucleus session is authorized by its minted binding, not by an ACP auth flow.
        this.result(send, id, {});
        return;
      case "session/new":
        await this.open(input, id, send, false);
        return;
      case "session/load":
        await this.open(input, id, send, true);
        return;
      case "session/set_model": {
        const modelId = typeof input.modelId === "string" ? input.modelId : "";
        if (!ACP_MODELS.some(model => model.modelId === modelId))
          throw new AcpRefusal(-32602, `Unknown model ${modelId || "(none)"}; this session offers ${ACP_MODELS.map(model => model.modelId).join(", ")}`);
        this.model = modelId;
        this.result(send, id, {});
        return;
      }
      case "session/prompt":
        await this.prompt(input, id, send);
        return;
      default:
        throw new AcpRefusal(-32601, `The Nucleus ACP agent does not implement ${method}`);
    }
  }

  /** `session/new` and `session/load` share one step: bind this working directory to its task and attach. */
  private async open(params: Json, id: Id, send: Send, loading: boolean): Promise<void> {
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
    const requested = typeof params.sessionId === "string" ? params.sessionId : null;
    const source = await this.resolve(cwd);
    const { binding } = source;
    if (loading) {
      if (requested !== binding.sessionId)
        throw new AcpRefusal(-32000, `This thread's Nucleus binding is session ${binding.sessionId}, not ${requested ?? "(none)"}. Nucleus holds the task's history: reopen the task's thread, or ask Nucleus to bind this checkout again.`);
    }
    const attached = await this.attach(source);
    const session: SessionState = {
      sessionId: binding.sessionId, taskId: binding.taskId, binding, transport: source.transport,
      pending: attached.messages,
      prompted: false, cancelled: false, controller: new AbortController(), inFlight: false,
    };
    this.sessions.set(session.sessionId, session);
    this.result(send, id, this.sessionResult(session.sessionId));
    // A reloaded thread shows where the task stands now; nothing else is replayed, because
    // Nucleus holds the task's history.
    if (loading) for (const line of session.pending.splice(0)) this.emit(send, session.sessionId, line);
  }

  /** The models block every session answer carries. */
  private sessionResult(sessionId: string): Json {
    return { sessionId, models: { availableModels: ACP_MODELS.map(model => ({ ...model })), currentModelId: this.model } };
  }

  /** Resolve a working directory's binding, and attach to the service it names. */
  private async resolve(cwd: string): Promise<AcpSessionSource> {
    try { return await this.options.resolve(cwd); }
    catch (error) { throw new AcpRefusal(-32000, reasonOf(error)); }
  }

  /** The first call of a session: proves the credential and reads the task's first lifecycle line. */
  private async attach(source: AcpSessionSource): Promise<AcpTurnReply> {
    const { binding, transport } = source;
    try {
      return await transport.turn({ taskId: binding.taskId, sessionId: binding.sessionId, waitMs: 0 }, new AbortController().signal);
    } catch (error) {
      throw new AcpRefusal(-32000, `Nucleus is unreachable for task ${binding.taskId}: ${reasonOf(error)}`);
    }
  }

  private async prompt(params: Json, id: Id, send: Send): Promise<void> {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = this.sessions.get(sessionId);
    if (!session) throw new AcpRefusal(-32602, `Unknown session ${sessionId || "(none)"}; open it with session/new first`);
    if (session.inFlight) throw new AcpRefusal(-32602, `A turn is already in flight for ${sessionId}; cancel it before sending another`);
    session.inFlight = true;
    try {
      const text = promptText(params.prompt);
      if (text === "" || this.options.ignore?.(text, session.binding)) {
        // Not the operator speaking: nothing is shown and nothing is forwarded.
        this.result(send, id, { stopReason: "end_turn" });
        return;
      }
      session.cancelled = false;
      session.controller = new AbortController();
      for (const line of session.pending.splice(0)) this.emit(send, sessionId, line);
      if (!session.prompted) {
        // The thread's opening prompt establishes it. It is not a message to the task.
        session.prompted = true;
      } else {
        const forwarded = await this.forward(session, text, send);
        if (!forwarded) { this.result(send, id, { stopReason: "end_turn" }); return; }
      }
      const outcome = await this.hold(session, send);
      this.result(send, id, { stopReason: outcome });
    } finally {
      session.inFlight = false;
    }
  }

  /**
   * Hand the person's text to Nucleus's own message route. The agent never answers it,
   * and it never retries: a transport failure is shown and the turn ends, because an
   * unsent message is unknown delivery, not permission to send it twice.
   */
  private async forward(session: SessionState, text: string, send: Send): Promise<boolean> {
    const eventId = createHash("sha256").update(`${session.sessionId}\0${text}`).digest("hex");
    try {
      await session.transport.message({ taskId: session.taskId, sessionId: session.sessionId, eventId, text });
      return true;
    } catch (error) {
      this.emit(send, session.sessionId, `Nucleus could not record that message: ${reasonOf(error)}`);
      return false;
    }
  }

  /**
   * Hold the turn while the service says to. The service answers with `release` when
   * the task finished or a host adapter released it, and with lifecycle lines when
   * something worth showing changed. A service that stays unreachable ends the turn
   * after a bounded number of failures instead of holding a thread nobody can settle.
   */
  private async hold(session: SessionState, send: Send): Promise<string> {
    let failures = 0;
    for (;;) {
      if (session.cancelled) return "cancelled";
      try {
        const reply = await session.transport.turn({ taskId: session.taskId, sessionId: session.sessionId, waitMs: this.turnWaitMs }, session.controller.signal);
        failures = 0;
        for (const line of reply.messages) this.emit(send, session.sessionId, line);
        if (reply.state === "release") return "end_turn";
        // A service that answers `hold` at once returns before the long-poll's own wait.
        // Yield to the event loop between polls so a held turn never starves the process.
        await yieldToEventLoop();
      } catch (error) {
        if (session.cancelled || session.controller.signal.aborted) continue;
        failures += 1;
        this.options.log?.(`turn for ${session.sessionId} failed (${failures}): ${reasonOf(error)}`);
        if (failures >= this.failureLimit) {
          this.emit(send, session.sessionId, `Nucleus is unreachable (${reasonOf(error)}); ending this turn.`);
          return "end_turn";
        }
        await delay(this.retryDelayMs);
      }
    }
  }

  private emit(send: Send, sessionId: string, text: string): void {
    send({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    });
  }
}

/** The text of one ACP prompt: its text blocks, in order. Anything else is not text to forward. */
function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt.trim();
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map(block => isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(text => text !== "")
    .join("\n")
    .trim();
}

const delay = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, Math.max(0, ms)); timer.unref?.(); });
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => { setImmediate(resolve).unref?.(); });
