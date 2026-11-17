/**
 * Spec 065: the ACP session surface, and nothing else.
 *
 * The engine holds one of these so a catalogue call can mint a binding, and the
 * callback socket serves its calls. The interface lives here, with no imports, so
 * the engine depends on the promise and not on the implementation: the owner of
 * every rule below is `core/acp/sessions.ts`.
 */

/** Where an agent finds its session: the id, the task, and the owner-only file. */
export interface AcpSessionBinding { sessionId: string; taskId: string; bindingPath: string }

export interface AcpTurnInput {
  taskId: string;
  sessionId: string;
  waitMs?: number;
  /**
   * `true` when the client is attaching (`session/new`/`session/load`) rather than
   * polling a turn it already holds. An attach always answers with the task's current
   * lifecycle line, because that line is what a reloaded thread shows; a held poll
   * answers only when something changed.
   */
  attach?: boolean;
}

export interface AcpTurnReply {
  /** `hold` keeps the agent's turn open; `release` ends it, and the client settles the thread. */
  state: "hold" | "release";
  /** Why, in one line: the task's state, or the release directive the service recorded. */
  reason: string;
  /** Lifecycle lines the client shows as agent messages; empty when nothing changed. */
  messages: string[];
  task: { taskId: string; reference: string | null; phase: string; name: string };
}

export interface AcpMessageInput { taskId: string; sessionId: string; eventId: string; text: string }

export interface AcpSessionSurface {
  /** Mint this task's session and the pointer in its checkout. One session per task. */
  bind(input: { taskId: string }): AcpSessionBinding;
  /** Ask whether to keep holding this turn, and which lifecycle lines to show. */
  turn(input: AcpTurnInput, token: string): Promise<AcpTurnReply>;
  /** The operator's text in the task's thread: recorded and routed by Nucleus, never by the agent. */
  message(input: AcpMessageInput, token: string): Promise<unknown>;
  /** A host adapter's release directive: end this session's held turn now. */
  release(sessionId: string, reason: string): void;
}
