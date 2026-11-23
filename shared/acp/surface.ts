/**
 * Spec 065: the ACP session surface, and nothing else.
 *
 * The engine holds one of these so a catalogue call can mint a binding, and the
 * callback socket serves its calls. The interface lives here, with no imports, so
 * the engine depends on the promise and not on the implementation: the owner of
 * every rule below is `core/acp/sessions.ts`.
 */

/** Where an agent finds its session: the id, the task, and the owner-only file. */
export interface AcpSessionBinding {
  sessionId: string;
  taskId: string;
  bindingPath: string;
}

export type AcpCaller =
  | { kind?: "task"; taskId: string; sessionId: string }
  | { kind: "inbox"; hostId: string; sessionId: string };

export interface AcpInboxUiInput {
  kind: "inbox";
  hostId: string;
  sessionId: string;
}

export interface AcpInboxUiReply {
  /**
   * `opened` showed the board for this `ui`; `reused` means this same `ui` was already
   * served (the pass served it while T3 held the inbox's turn), so nothing was replayed;
   * `failed` names what stopped it.
   */
  status: "opened" | "reused" | "failed";
  hold: boolean;
  detail?: string;
}

export type AcpTurnInput = AcpCaller & {
  waitMs?: number;
  /**
   * `true` when the client is attaching (`session/new`/`session/load`) rather than
   * polling a turn it already holds. An attach always answers with the task's current
   * lifecycle line, because that line is what a reloaded thread shows; a held poll
   * answers only when something changed.
   */
  attach?: boolean;
};

export interface AcpElicitation {
  id: string;
  version: number;
  headline: string;
  question: string;
  choices: Array<{ label: string; consequence: string }>;
}
export type AcpAnswerInput = AcpCaller & { id: string; version: number } & (
    | { action: "accept"; answer: string }
    | { action: "cancel"; requestId: string }
  );

/**
 * Where one host's read of T3 looked for decision cards: its Inbox, or a task thread
 * whose leftover card is settled. Only the Inbox ever raises one (Spec 032).
 */
export type AcpCardScope =
  | { hostId: string }
  | { taskId: string; sessionId?: string };
/** One decision card, by the version it carries. */
export interface AcpPendingCard {
  id: string;
  version: number;
}

export type AcpTurnReply = {
  /** `hold` keeps the agent's turn open; `release` ends it, and the client settles the thread. */
  state: "hold" | "release";
  /** Why, in one line: the task's state, or the release directive the service recorded. */
  reason: string;
  /** Lifecycle lines the client shows as agent messages; empty when nothing changed. */
  messages: string[];
  elicitations?: AcpElicitation[];
} & (
  | {
      kind?: "task";
      task: {
        taskId: string;
        reference: string | null;
        phase: string;
        name: string;
      };
    }
  | { kind: "inbox"; hostId: string }
);

export interface AcpMessageInput {
  taskId: string;
  sessionId: string;
  eventId: string;
  text: string;
}

/** The host-shaped prompt rules a minting adapter may attach (see `shared/acp/binding`). */
export interface AcpBindingRules {
  ignorePattern?: string;
  holdPattern?: string;
}

export interface AcpSessionSurface {
  /**
   * Mint this task's session and the pointer in its checkout. One session per task.
   * A host adapter names its own prompt rules here, because the agent never parses
   * remote text: an ignore prompt ends the turn, a hold prompt holds it.
   */
  bind(
    input: { taskId: string; directory?: string } & AcpBindingRules,
  ): AcpSessionBinding;
  /** Mint a decision-only inbox identity for this host. */
  bindInbox?(input: { hostId: string } & AcpBindingRules): {
    sessionId: string;
    hostId: string;
    directory: string;
    bindingPath: string;
  };
  /**
   * Whether this task still has an open decision the operator must answer, wherever its
   * card lives. A host shows the task's row as needing a person and keeps it out of the
   * inbox's running count; no decision holds the task's own thread (Spec 032).
   */
  openDecisionKey?(taskId: string): string | null;
  /**
   * Record the decision cards a host's own read of T3 shows still pending on a thread,
   * so a turn offers no version that already has a live card. `null` means the thread was
   * not read, so offers wait for a successful observation. A task thread's cards are
   * settled and never offered again; only the host Inbox raises cards (Spec 032).
   */
  observedCards?(scope: AcpCardScope, cards: AcpPendingCard[] | null): void;
  /** The host inbox's offer, cap applied: a host re-enters the inbox only while this is non-null. */
  pendingInboxDecisionKey?(hostId: string): string | null;
  decisionSettlement?(
    id: string,
    version: number,
    scope?: AcpCardScope,
  ): { state: "open" | "answered" | "cancelled"; answer?: string };
  /** Ask whether to keep holding this turn, and which lifecycle lines to show. */
  turn(input: AcpTurnInput, token: string): Promise<AcpTurnReply>;
  /** Record a native operator answer to an offered decision. */
  answer?(input: AcpAnswerInput, token: string): Promise<unknown>;
  /** The operator's text in the task's thread: recorded and routed by Nucleus, never by the agent. */
  message(input: AcpMessageInput, token: string): Promise<unknown>;
  /** Open or reveal the board from the authenticated host inbox session. */
  openInboxUi?(input: AcpInboxUiInput, token: string): Promise<AcpInboxUiReply>;
  /** A host adapter's release directive: end this session's held turn now. */
  release(sessionId: string, reason: string): void;
}
