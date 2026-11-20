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
 *   lifecycle lines the service sends, and forwards anything a person typed. A host
 *   that released a turn re-enters the thread with a prompt of its own: the binding's
 *   `holdPattern` names it, so nothing is shown, nothing is forwarded, and the turn
 *   holds — which is what gives the host's next child a live parent run;
 * - `session/cancel` ends the turn at once (the client sends it before it steers).
 *
 * The agent knows nothing about any host. Everything host- or task-specific — the
 * binding, the transport, the "this prompt is not for you" rule — is injected by
 * whoever launches it (the ACP client's provider configuration and Nucleus itself).
 */
import { createHash, randomUUID } from "node:crypto";
import { AcpBindingMissingError } from "./binding";
import type { AcpBinding } from "./binding";
import type {
  AcpAnswerInput,
  AcpCaller,
  AcpElicitation,
  AcpInboxUiInput,
  AcpInboxUiReply,
  AcpMessageInput,
  AcpTurnInput,
  AcpTurnReply,
} from "./surface";

export type {
  AcpInboxUiInput,
  AcpInboxUiReply,
  AcpMessageInput,
  AcpTurnInput,
  AcpTurnReply,
};

type Json = Record<string, unknown>;
type Id = number | string;
type Send = (message: Json) => void;

/** The ACP protocol revision this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;
/** One long-poll's wait. The service's own bound is 25 s; the transport adds a socket margin. */
export const ACP_TURN_WAIT_MS = 20_000;
/** The first retry's delay after a failed service call; each further failure doubles it. */
const TRANSPORT_RETRY_DELAY_MS = 1_000;
/** The longest a held turn waits between retries while the service is unreachable. */
const TRANSPORT_RETRY_MAX_MS = 30_000;
/** Consecutive transport failures before the one fault line is shown. The turn stays held. */
const TRANSPORT_FAULT_AFTER = 3;
/** Attach calls a session open makes while the service is unreachable before it refuses (about 30 s of backoff). */
const TRANSPORT_ATTACH_ATTEMPTS = 6;
/** The callback socket's answer to a credential it does not hold: no retry can ever succeed. */
const CREDENTIAL_REFUSED_STATUS = 401;

/**
 * ACP clients may require a model list, and T3 wants at least two entries. There is
 * no model behind either: they differ only in the name the client displays.
 */
export const ACP_MODELS = [
  {
    modelId: "nucleus",
    name: "Nucleus",
    description: "Nucleus task lifecycle: a real task, no model.",
  },
  {
    modelId: "nucleus-quiet",
    name: "Nucleus (quiet)",
    description: "The same task thread; the lifecycle lines are identical.",
  },
] as const;

/** The turn request the transport sends: the surface's input with the wait always named. */
export type AcpTurnRequest = AcpTurnInput & { waitMs: number };
export type AcpMessageRequest = AcpMessageInput;
export interface AcpMessageReply {
  receipt: { status: string; detail?: string };
}

/** The service calls one session makes. Injected, so the protocol is testable without a service. */
export interface AcpSessionTransport {
  turn(input: AcpTurnRequest, signal: AbortSignal): Promise<AcpTurnReply>;
  message(input: AcpMessageRequest): Promise<AcpMessageReply>;
  answer?(input: AcpAnswerInput): Promise<unknown>;
  /** `signal` aborts on Stop; the service's own bound ends a hung open with a result. */
  openUi?(
    input: AcpInboxUiInput,
    signal: AbortSignal,
  ): Promise<AcpInboxUiReply>;
}

/** What a thread's working directory resolves to: Nucleus's binding and how to reach the service. */
export interface AcpSessionSource {
  binding: AcpBinding;
  transport: AcpSessionTransport;
}

export interface AcpAgentOptions {
  /** Resolve the binding for a thread's working directory. A refusal is shown to the client. */
  resolve(cwd: string): Promise<AcpSessionSource>;
  /**
   * A prompt this agent must end without showing or forwarding, supplied by whoever
   * launches it: a host that wakes the thread with its own notification text (T3's
   * delegated-task wake, for one) is not a person speaking to the task.
   */
  ignore?(text: string, binding: AcpBinding): boolean;
  /**
   * A prompt this agent must hold without showing or forwarding: the host re-arming a
   * thread whose turn it released, so the host can create the thread's next child
   * under a live run. Same provenance as `ignore` — configuration, never parsed text.
   */
  hold?(text: string, binding: AcpBinding): boolean;
  /** One long-poll's wait; the tests use a short one. */
  turnWaitMs?: number;
  /** Delay before retrying a service call that failed for transport reasons; doubles per failure. */
  retryDelayMs?: number;
  /** The longest wait between retries while the service is unreachable. */
  retryMaxDelayMs?: number;
  /** Attach calls a session open makes before it refuses; a refused credential refuses at once. */
  attachAttempts?: number;
  /** Consecutive transport failures before the one fault line is shown. The held turn is never ended by them. */
  faultLineAfter?: number;
  version?: string;
  log?(line: string): void;
}

/** An ACP-level refusal: the client shows its message and nothing is invented. */
class AcpRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "AcpRefusal";
  }
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface SessionState {
  sessionId: string;
  caller: AcpCaller;
  binding: AcpBinding;
  transport: AcpSessionTransport;
  /** Lifecycle lines the service already sent, waiting for the next prompt to show them. */
  pending: string[];
  /** Whether the thread's opening prompt has been consumed. */
  prompted: boolean;
  cancelled: boolean;
  controller: AbortController;
  inFlight: boolean;
  /** How many turns this session has had; a card belongs to the one that raised it. */
  turn: number;
  /**
   * The cards this session's live turn raised, by `id:version`, each with the turn that
   * raised it. One version is never raised twice at once, and a card that outlived its
   * turn is forgotten at the next one: a client that settles a card without telling this
   * process must not leave a version unraised forever.
   */
  cards: Map<string, { requestId: string; turn: number }>;
}

/**
 * One agent process. It serves any number of sessions (a client may open several),
 * keeps no durable state, and can be killed and relaunched at any time: the binding
 * and the service hold everything worth keeping.
 */
export class AcpAgent {
  private readonly sessions = new Map<string, SessionState>();
  private readonly inertSessions = new Set<string>();
  private readonly work = new Set<Promise<unknown>>();
  private model: string = ACP_MODELS[0].modelId;
  private readonly elicitationReplies = new Map<Id, (response: Json) => void>();
  /** The last line each session showed, so an identical line is never sent twice in a row. */
  private readonly lastLine = new Map<string, string>();

  constructor(private readonly options: AcpAgentOptions) {}

  private get turnWaitMs(): number {
    return this.options.turnWaitMs ?? ACP_TURN_WAIT_MS;
  }
  private get retryDelayMs(): number {
    return this.options.retryDelayMs ?? TRANSPORT_RETRY_DELAY_MS;
  }
  private get retryMaxDelayMs(): number {
    return this.options.retryMaxDelayMs ?? TRANSPORT_RETRY_MAX_MS;
  }
  private get attachAttempts(): number {
    return this.options.attachAttempts ?? TRANSPORT_ATTACH_ATTEMPTS;
  }
  private get faultLineAfter(): number {
    return this.options.faultLineAfter ?? TRANSPORT_FAULT_AFTER;
  }
  /** The wait before the next retry: doubling from the first delay, bounded, so an outage never spins. */
  private retryWait(failures: number): number {
    return Math.min(
      this.retryMaxDelayMs,
      this.retryDelayMs * 2 ** Math.max(0, failures - 1),
    );
  }

  /** Read ACP traffic from `input`, answer on `output`, until the input closes. */
  async run(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
  ): Promise<void> {
    const send: Send = (message) => {
      output.write(`${JSON.stringify(message)}\n`);
    };
    let buffer = "";
    for await (const chunk of input) {
      buffer += String(chunk);
      for (
        let index = buffer.indexOf("\n");
        index >= 0;
        index = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.dispatch(line, send);
      }
    }
    // The client closed the pipe: no one can answer a held turn any more, and the host
    // may be shutting down. End every turn instead of leaving a process holding one.
    for (const session of this.sessions.values())
      this.cancel(session.sessionId);
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
    try {
      message = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "The Nucleus ACP agent reads one JSON-RPC message per line",
        },
      });
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") return;
    const id = message.id;
    const method = message.method;
    if (
      (typeof id === "number" || typeof id === "string") &&
      method === undefined
    ) {
      const receive = this.elicitationReplies.get(id);
      if (receive) {
        this.elicitationReplies.delete(id);
        receive(message);
      }
      return;
    }
    if (typeof id !== "number" && typeof id !== "string") {
      // A notification carries no answer. `session/cancel` is the only one the agent acts on.
      if (
        method === "session/cancel" &&
        isObject(message.params) &&
        typeof message.params.sessionId === "string"
      )
        this.cancel(message.params.sessionId);
      return;
    }
    if (typeof method !== "string") {
      this.refuse(send, id, "Request has no method", -32600);
      return;
    }
    const running = this.handle(method, message.params, id, send).catch(
      (error) =>
        this.refuse(
          send,
          id,
          reasonOf(error),
          error instanceof AcpRefusal ? error.code : -32603,
        ),
    );
    this.work.add(running);
    void running.finally(() => this.work.delete(running));
  }

  private refuse(send: Send, id: Id, message: string, code: number): void {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private result(send: Send, id: Id, result: Json): void {
    send({ jsonrpc: "2.0", id, result });
  }

  private async handle(
    method: string,
    params: unknown,
    id: Id,
    send: Send,
  ): Promise<void> {
    const input = isObject(params) ? params : {};
    switch (method) {
      case "initialize":
        this.result(send, id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
          },
          agentInfo: {
            name: "nucleus",
            title: "Nucleus",
            version: this.options.version ?? "0.0.0",
          },
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
        if (!ACP_MODELS.some((model) => model.modelId === modelId))
          throw new AcpRefusal(
            -32602,
            `Unknown model ${modelId || "(none)"}; this session offers ${ACP_MODELS.map((model) => model.modelId).join(", ")}`,
          );
        this.model = modelId;
        this.result(send, id, {});
        return;
      }
      case "session/prompt":
        await this.prompt(input, id, send);
        return;
      default:
        throw new AcpRefusal(
          -32601,
          `The Nucleus ACP agent does not implement ${method}`,
        );
    }
  }

  /** `session/new` and `session/load` share one step: bind this working directory to its task and attach. */
  private async open(
    params: Json,
    id: Id,
    send: Send,
    loading: boolean,
  ): Promise<void> {
    const cwd =
      typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
    const requested =
      typeof params.sessionId === "string" ? params.sessionId : null;
    let source: AcpSessionSource;
    try {
      source = await this.options.resolve(cwd);
    } catch (error) {
      if (!loading && error instanceof AcpBindingMissingError) {
        const sessionId = randomUUID();
        this.inertSessions.add(sessionId);
        this.result(send, id, this.sessionResult(sessionId));
        return;
      }
      throw new AcpRefusal(-32000, reasonOf(error));
    }
    const { binding } = source;
    if (loading) {
      if (requested !== binding.sessionId)
        throw new AcpRefusal(
          -32000,
          `This thread's Nucleus binding is session ${binding.sessionId}, not ${requested ?? "(none)"}. Nucleus holds the task's history: reopen the task's thread, or ask Nucleus to bind this checkout again.`,
        );
    }
    const attached = await this.attach(source);
    const session: SessionState = {
      sessionId: binding.sessionId,
      caller: callerFor(binding),
      binding,
      transport: source.transport,
      pending: attached.messages,
      prompted: false,
      cancelled: false,
      controller: new AbortController(),
      inFlight: false,
      turn: 0,
      cards: new Map(),
    };
    this.sessions.set(session.sessionId, session);
    this.result(send, id, this.sessionResult(session.sessionId));
    // A reloaded thread shows where the task stands now; nothing else is replayed, because
    // Nucleus holds the task's history.
    if (loading)
      for (const line of session.pending.splice(0))
        this.emit(send, session.sessionId, line);
  }

  /** The models block every session answer carries. */
  private sessionResult(sessionId: string): Json {
    return {
      sessionId,
      models: {
        availableModels: ACP_MODELS.map((model) => ({ ...model })),
        currentModelId: this.model,
      },
    };
  }

  /**
   * The first call of a session: proves the credential and reads the task's current
   * lifecycle line. It asks for an attach, so a relaunched agent shows the line even
   * when this service already showed it to the previous one.
   */
  private async attach(source: AcpSessionSource): Promise<AcpTurnReply> {
    const { binding, transport } = source;
    // A session open that meets a socket gap (a roll, or a socket being replaced) waits on the
    // same bounded backoff a held turn does, so the provider's first turn does not fail on the
    // gap. A refused credential is permanent and refuses at once.
    const signal = new AbortController().signal;
    for (let failures = 1; ; failures++) {
      try {
        return await transport.turn(
          {
            ...callerFor(binding),
            waitMs: 0,
            attach: true,
          },
          signal,
        );
      } catch (error) {
        if (refusedCredential(error) || failures >= this.attachAttempts)
          throw new AcpRefusal(
            -32000,
            `Nucleus is unreachable for this session: ${reasonOf(error)}`,
          );
        this.options.log?.(
          `attach for ${binding.sessionId} failed (${failures}): ${reasonOf(error)}`,
        );
        await delay(this.retryWait(failures), signal);
      }
    }
  }

  private async prompt(params: Json, id: Id, send: Send): Promise<void> {
    const sessionId =
      typeof params.sessionId === "string" ? params.sessionId : "";
    if (this.inertSessions.has(sessionId))
      throw new AcpRefusal(
        -32602,
        "No Nucleus task is bound to this directory; Nucleus opens task threads itself.",
      );
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new AcpRefusal(
        -32602,
        `Unknown session ${sessionId || "(none)"}; open it with session/new first`,
      );
    if (session.inFlight)
      throw new AcpRefusal(
        -32602,
        `A turn is already in flight for ${sessionId}; cancel it before sending another`,
      );
    session.inFlight = true;
    try {
      const text = promptText(params.prompt);
      // The thread's opening prompt establishes it and is never forwarded, so a session
      // has exactly one. Any first prompt takes that slot, including one this agent does
      // not answer: a host's wake arriving before the operator's first message must not
      // turn that message into an opening prompt.
      const opening = !session.prompted;
      session.prompted = true;
      // A host's own text is configuration, never parsed: `ignore` ends the turn and
      // `hold` keeps it, and neither is shown or forwarded.
      const ignored =
        text !== "" && (this.options.ignore?.(text, session.binding) ?? false);
      const holding =
        !ignored &&
        text !== "" &&
        (this.options.hold?.(text, session.binding) ?? false);
      if (text === "" || ignored) {
        // Not the operator speaking: nothing is shown and nothing is forwarded.
        this.result(send, id, { stopReason: "end_turn" });
        return;
      }
      session.cancelled = false;
      session.controller = new AbortController();
      // A new turn raises its own cards. A card the client no longer shows is not this
      // turn's, whatever this process last heard: the client settles a turn's cards when
      // the turn ends, and the service's offer (with the host's read of what is still
      // pending) says whether the version is raised again (nucleus#1395).
      session.turn += 1;
      for (const [key, card] of session.cards)
        if (card.turn < session.turn) session.cards.delete(key);
      for (const line of session.pending.splice(0))
        this.emit(send, sessionId, line);
      if (session.caller.kind === "inbox" && !holding && text === "ui") {
        const outcome = await this.openInboxUi(session, send);
        if (outcome) {
          this.result(send, id, { stopReason: outcome });
          return;
        }
      } else if (!opening && !holding && session.caller.kind !== "inbox") {
        const forwarded = await this.forward(session, text, send);
        if (!forwarded) {
          this.result(send, id, { stopReason: "end_turn" });
          return;
        }
      }
      const outcome = await this.hold(session, send);
      this.result(send, id, { stopReason: outcome });
    } finally {
      session.inFlight = false;
    }
  }

  /**
   * Handle the inbox's exact `ui` command through its authenticated host binding
   * (nucleus#1415). One short success or actionable failure is shown, and the command
   * finishes: `end_turn` when no decision is offerable, `cancelled` when the operator
   * stopped it, and nothing when an offerable decision keeps the inbox's turn held, as
   * every other inbox turn does. The board's own bound lives in the service, so a hung
   * board call names its failure here instead of holding the turn. Pairing links never
   * cross this boundary.
   */
  private async openInboxUi(
    session: SessionState,
    send: Send,
  ): Promise<"end_turn" | "cancelled" | null> {
    if (session.caller.kind !== "inbox") return "end_turn";
    if (!session.transport.openUi) {
      this.emit(
        send,
        session.sessionId,
        "Nucleus cannot open the board from this session.",
        true,
      );
      return "end_turn";
    }
    try {
      const reply = await session.transport.openUi(
        {
          kind: "inbox",
          hostId: session.caller.hostId,
          sessionId: session.sessionId,
        },
        session.controller.signal,
      );
      if (session.cancelled) return "cancelled";
      if (reply.status === "opened") {
        this.emit(send, session.sessionId, "Opened the Nucleus board.", true);
      } else if (reply.status === "reused") {
        // This same `ui` was already served — usually by the pass that answered the
        // message T3 queued while the inbox's turn was held — so nothing was replayed.
        this.emit(send, session.sessionId, "The Nucleus board is open.", true);
      } else {
        const detail = sanitizeUiDetail(reply.detail);
        this.emit(
          send,
          session.sessionId,
          detail
            ? `Nucleus could not open the board: ${detail}`
            : "Nucleus could not open the board.",
          true,
        );
      }
      return reply.hold ? null : "end_turn";
    } catch (error) {
      // Stop ends the command with no invented line; anything else is shown and ends it.
      if (session.cancelled || abortOf(error)) return "cancelled";
      const detail = sanitizeUiDetail(reasonOf(error));
      this.emit(
        send,
        session.sessionId,
        detail
          ? `Nucleus could not open the board: ${detail}`
          : "Nucleus could not open the board.",
        true,
      );
      return "end_turn";
    }
  }

  /**
   * Hand the person's text to Nucleus's own message route. The agent never answers it,
   * and it never retries: a transport failure is shown and the turn ends, because an
   * unsent message is unknown delivery, not permission to send it twice.
   */
  private async forward(
    session: SessionState,
    text: string,
    send: Send,
  ): Promise<boolean> {
    if (session.caller.kind === "inbox") return false;
    const eventId = createHash("sha256")
      .update(`${session.sessionId}\0${text}`)
      .digest("hex");
    try {
      await session.transport.message({
        taskId: session.caller.taskId,
        sessionId: session.sessionId,
        eventId,
        text,
      });
      return true;
    } catch (error) {
      this.emit(
        send,
        session.sessionId,
        `Nucleus could not record that message: ${reasonOf(error)}`,
      );
      return false;
    }
  }

  /**
   * Hold the turn while the service says to. The service answers with `release` when
   * the task finished or a host adapter released it, and with lifecycle lines when
   * something worth showing changed.
   *
   * An unreachable service (a roll, or a callback socket being replaced) never ends a
   * held turn: the same session keeps polling after a bounded, doubling wait, so the
   * turn resumes on the same binding once the socket answers, with no re-minting and no
   * manual restart. After `faultLineAfter` consecutive failures the turn shows one fault
   * line for the outage. The turn ends only on `release`, on `session/cancel`, or when
   * the client's stdin closes.
   */
  private async hold(session: SessionState, send: Send): Promise<string> {
    let failures = 0;
    let faultShown = false;
    for (;;) {
      if (session.cancelled) return "cancelled";
      try {
        const reply = await session.transport.turn(
          {
            ...session.caller,
            waitMs: this.turnWaitMs,
          },
          session.controller.signal,
        );
        failures = 0;
        faultShown = false;
        for (const question of reply.elicitations ?? [])
          this.elicit(session, question, send);
        for (const line of reply.messages)
          this.emit(send, session.sessionId, line);
        if (reply.state === "release") return "end_turn";
        // A service that answers `hold` at once returns before the long-poll's own wait.
        // Yield to the event loop between polls so a held turn never starves the process.
        await yieldToEventLoop();
      } catch (error) {
        if (session.cancelled || session.controller.signal.aborted) continue;
        if (refusedCredential(error)) {
          this.emit(
            send,
            session.sessionId,
            `Nucleus refused this session's credential (${reasonOf(error)}); ending this turn.`,
          );
          return "end_turn";
        }
        failures += 1;
        this.options.log?.(
          `turn for ${session.sessionId} failed (${failures}): ${reasonOf(error)}`,
        );
        if (!faultShown && failures >= this.faultLineAfter) {
          faultShown = true;
          this.emitFault(
            send,
            session.sessionId,
            `Nucleus is unreachable (${reasonOf(error)}); this turn stays open and resumes when Nucleus answers.`,
          );
        }
        await delay(this.retryWait(failures), session.controller.signal);
      }
    }
  }

  /**
   * A held turn can carry several native cards; the service owns each answer. A version
   * gets one card at a time, and only while its turn is held: whether a version may be
   * offered at all is the service's decision, so this agent spends no attempt of its own.
   */
  private elicit(
    session: SessionState,
    question: AcpElicitation,
    send: Send,
  ): void {
    if (!session.transport.answer) return;
    const key = `${question.id}:${question.version}`;
    if (session.cards.has(key)) return;
    const requestId = `nucleus-elicitation-${randomUUID()}`;
    const fieldId = `nucleus_${question.id}_${question.version}`;
    // A client that never settles a request must not grow this map without bound; the
    // oldest card is forgotten, and the service's offer decides about that version again.
    if (session.cards.size >= 512 && !session.cards.has(key)) {
      const oldest = session.cards.keys().next();
      if (!oldest.done) session.cards.delete(oldest.value);
    }
    session.cards.set(key, { requestId, turn: session.turn });
    if (this.elicitationReplies.size >= 512) {
      const oldest = this.elicitationReplies.keys().next();
      if (!oldest.done) this.elicitationReplies.delete(oldest.value);
    }
    this.elicitationReplies.set(requestId, (response) => {
      const result = isObject(response.result) ? response.result : {};
      const content = isObject(result.content) ? result.content : {};
      const card = session.cards.get(key);
      const live =
        card?.requestId === requestId &&
        card.turn === session.turn &&
        session.inFlight;
      // The client resolved this request, so no card of it exists any more. Presence is
      // the answer here, never an assumption: it is why the next offer may raise a new one.
      if (card?.requestId === requestId) session.cards.delete(key);
      if (result.action === "accept" && typeof content[fieldId] === "string")
        this.record(session, question, {
          action: "accept",
          answer: content[fieldId] as string,
        });
      else if (result.action === "cancel" && live)
        // Only a card this turn raised can carry the operator's own dismissal. A card the
        // client settles after its turn ended is a settlement the host made from its own
        // read of T3, and recording it would spend the version's one re-offer.
        this.record(session, question, { action: "cancel", requestId });
    });
    const field = question.choices.length
      ? {
          oneOf: question.choices.map((choice) => ({
            const: choice.label,
            title: choice.label,
            description: choice.consequence,
          })),
        }
      : {};
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "elicitation/create",
      params: {
        sessionId: session.sessionId,
        mode: "form",
        message: question.question,
        _meta: { "cognition.ai/allowOther": true },
        requestedSchema: {
          type: "object",
          required: [fieldId],
          properties: {
            [fieldId]: {
              type: "string",
              title: question.headline,
              description: question.question,
              ...field,
            },
          },
        },
      },
    });
  }

  /** Send one answer to the service, exactly once: an unknown delivery is never resent. */
  private record(
    session: SessionState,
    question: AcpElicitation,
    event:
      | { action: "accept"; answer: string }
      | { action: "cancel"; requestId: string },
  ): void {
    const work = session.transport.answer!({
      ...session.caller,
      id: question.id,
      version: question.version,
      ...event,
    }).catch(() => {
      // A failed answer has unknown delivery; the service's own decision state decides
      // whether this version is offered again.
      this.options.log?.("could not record an elicitation response");
    });
    this.work.add(work);
    void work.finally(() => this.work.delete(work));
  }

  /**
   * One lifecycle line on the wire. Clients join message chunks without a separator,
   * so each line ends its own paragraph; a line identical to the one just shown is not
   * sent again, whichever poll or attach asked for it.
   */
  private emit(
    send: Send,
    sessionId: string,
    text: string,
    force = false,
  ): void {
    if (!force && this.lastLine.get(sessionId) === text) return;
    this.lastLine.set(sessionId, text);
    this.chunk(send, sessionId, text);
  }

  /**
   * One outage's fault line. It is never suppressed as a repeat: each outage shows its
   * own line even when the failure reads the same as the last one, and it does not
   * become the line a lifecycle update is compared against.
   */
  private emitFault(send: Send, sessionId: string, text: string): void {
    this.chunk(send, sessionId, text);
  }

  private chunk(send: Send, sessionId: string, text: string): void {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${text}\n\n` },
        },
      },
    });
  }
}

/** Whether a transport error is this process's own abort (the operator's Stop). */
function abortOf(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** Strip any pairing URL or token fragment before showing an error in chat. */
function sanitizeUiDetail(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(
      /pairingUrl:\S+|https?:\/\/\S*#token=\S+|#token=\S+/gi,
      "[redacted]",
    )
    .trim();
}

/** The text of one ACP prompt: its text blocks, in order. Anything else is not text to forward. */
function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt.trim();
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) =>
      isObject(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter((text) => text !== "")
    .join("\n")
    .trim();
}

/** Only a refused credential is permanent: every other failure is a service that may answer again. */
function refusedCredential(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === CREDENTIAL_REFUSED_STATUS
  );
}

/** A bounded wait that `session/cancel` ends at once: a backoff never holds up a cancel. */
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve).unref?.();
  });

/** The binding, never prompt text, selects the scoped service surface. */
function callerFor(binding: AcpBinding): AcpCaller {
  return "kind" in binding && binding.kind === "inbox"
    ? { kind: "inbox", hostId: binding.hostId, sessionId: binding.sessionId }
    : { taskId: binding.taskId, sessionId: binding.sessionId };
}
