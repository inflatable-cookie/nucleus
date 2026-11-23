/**
 * Spec 065: the service API an ACP session talks to.
 *
 * The agent is a thin client: it holds no state and repeats no decision. Everything
 * it shows or does comes from one of the three calls here —
 *
 * - `bind`: Nucleus mints the task's one session and the owner-only pointer in the
 *   task's checkout (a host adapter calls this before it opens the task's thread);
 * - `turn`: the held turn. The answer says keep holding or release, with the
 *   lifecycle lines that changed since the last answer;
 * - `message`: the operator's text in the task's thread, handed to Nucleus's own
 *   message route (never answered by the agent).
 *
 * A turn is held while the task is unfinished. A host adapter that knows more than
 * the task row — the T3 adapter, whose role threads are children of this one — can
 * call `release` to let the task settle between children; the next prompt holds
 * again. The directive is memory-only, so a service restart re-derives the answer
 * from the task and never invents a release.
 */
import { taskDetailView, type Task } from "../../shared/contracts";
import type { AgentMessageReceipt } from "../questions/agent-messages";
import { verifyAcpSession, mintAcpSession } from "./binding";
import type {
  AcpAnswerInput,
  AcpCaller,
  AcpCardScope,
  AcpInboxUiInput,
  AcpInboxUiReply,
  AcpMessageInput,
  AcpPendingCard,
  AcpSessionBinding,
  AcpSessionSurface,
  AcpTaskPresentation,
  AcpTurnInput,
  AcpTurnReply,
} from "../../shared/acp/surface";
import {
  acpPresentationSignature,
  acpTaskFinished,
  acpTaskMessages,
  acpTaskName,
  acpTaskPresentation,
  type AcpLineMemory,
} from "./lifecycle";
import type { Engine } from "../engine";
import { createHash } from "node:crypto";
import { mintAcpInbox, verifyAcpInbox } from "./inbox-binding";
import { t3OperatorIdentity } from "../../shared/operator-identity";
import {
  acpElicitation,
  bindOwner,
  boundOwner,
  matchesOwner,
  proposedOwner,
  type DecisionScope,
} from "./decisions";
import { activityReadContext } from "../telemetry/task-activity-observation";
import {
  taskWaitStateContext,
  taskWithCurrentWait,
} from "../recovery/wait-context";

/** How long one long-poll may wait; the agent asks again after this. */
export const ACP_TURN_WAIT_MAX_MS = 25_000;
/** How often a held turn re-reads its task while it waits. */
export const ACP_TURN_POLL_MS = 1_000;
/** Sessions whose last shown signature is remembered; the oldest is dropped first. */
export const ACP_SIGNATURE_MEMORY = 512;

/** The key one host Inbox's cards are recorded under. */
const inboxScopeKey = (hostId: string): string => `inbox:${hostId}`;

export interface AcpMessageReply {
  receipt: AgentMessageReceipt;
}

export interface AcpSessionsOptions {
  /** The data home whose `acp/` directory holds session records and bindings. */
  dataHome: string;
  /** The callback socket the binding points the agent at. */
  socketPath: string;
  pollMs?: number;
  answerDecision?: (input: {
    id: string;
    version: number;
    answer: string;
    answeredBy: string;
    relayed: boolean;
    note: string;
  }) => unknown;
  openInboxUi?: (
    hostId: string,
  ) => Promise<{ status: "opened" | "reused" | "failed"; detail?: string }>;
}

/**
 * Mint a session, or refuse when this process serves none. The catalogue's owner
 * calls this with the surface the runtime attached, so the refusal is one rule
 * rather than a check each caller remembers.
 */
export function bindAcpSession(
  acp: AcpSessionSurface | null,
  input: {
    taskId: string;
    directory?: string;
    ignorePattern?: string;
    holdPattern?: string;
  },
): AcpSessionBinding {
  if (!acp)
    throw new Error(
      "This process does not serve ACP sessions, so no binding was minted",
    );
  return acp.bind(input);
}

export class AcpSessions implements AcpSessionSurface {
  /**
   * What each session was last shown: the signature, so a quiet task sends nothing,
   * and the reference and PR link already on screen, so a line does not repeat them.
   */
  private readonly shown = new Map<
    string,
    { signature: string; memory: AcpLineMemory }
  >();
  /** Release directives from a host adapter, consumed by the turn that acts on them. */
  private readonly shownDecisions = new Map<string, string>();
  /**
   * The decision cards each host scope's own read of T3 shows still pending. A version
   * with a live card is not offered again, and one whose card is gone is offered again;
   * absence is the host's read, never this process's assumption (nucleus#1395).
   */
  private readonly presentCards = new Map<string, Set<string>>();
  private readonly releases = new Map<string, string>();
  /** Turns waiting on this session: a release, or a new signature, wakes them. */
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(
    readonly engine: Engine,
    readonly options: AcpSessionsOptions,
  ) {}

  get dataHome(): string {
    return this.options.dataHome;
  }
  private get pollMs(): number {
    return this.options.pollMs ?? ACP_TURN_POLL_MS;
  }

  /** Mint this task's session and the pointer in its checkout. One session per task. */
  bind(input: {
    taskId: string;
    directory?: string;
    ignorePattern?: string;
    holdPattern?: string;
  }): AcpSessionBinding {
    const task = this.engine.store.task(input.taskId);
    if (task.removedAt)
      throw new Error(
        `Task ${acpTaskName(task)} was removed; no ACP session can be bound to it`,
      );
    const allowedDirectories = [
      task.directory,
      task.resolution.closeoutDirectory,
    ].filter((value): value is string => Boolean(value));
    if (!allowedDirectories.length)
      throw new Error(
        `Task ${acpTaskName(task)} has no workspace checkout yet; bind the ACP session once its worktree exists`,
      );
    const targetDirectory = input.directory ?? task.directory;
    if (!targetDirectory || !allowedDirectories.includes(targetDirectory))
      throw new Error(
        `Task ${acpTaskName(task)} cannot bind ACP session to unrecorded checkout ${input.directory ?? "(none)"}`,
      );
    return mintAcpSession({
      dataHome: this.dataHome,
      socketPath: this.options.socketPath,
      taskId: task.id,
      directory: targetDirectory,
      ...(input.ignorePattern ? { ignorePattern: input.ignorePattern } : {}),
      ...(input.holdPattern ? { holdPattern: input.holdPattern } : {}),
    });
  }

  private cancelKey(id: string, version: number): string {
    return `acpCancel:${createHash("sha256")
      .update(JSON.stringify([id, version]))
      .digest("hex")}`;
  }
  /**
   * The decisions this Inbox may still ask about: open, owned by this host's Inbox, and
   * not dismissed as many times as the operator's one re-offer allows. The operator's
   * dismissal is the only thing recorded as a cancellation receipt, so a settlement the
   * host made from its own read of T3 never spends that allowance (nucleus#1395).
   */
  private offerable(hostId: string) {
    const caller: AcpCaller = { kind: "inbox", hostId, sessionId: "" };
    return this.engine.store.listDecisions({ status: "open" }).filter((row) => {
      if (!matchesOwner(this.owner(row, hostId), caller)) return false;
      return (this.cancelReceipt(row)?.requests.length ?? 0) < 2;
    });
  }

  /** The Inbox that owns one open version (Spec 032): its binding, else its links. */
  private owner(
    row: import("../../shared/contracts").Decision,
    connectedHost: string,
  ): DecisionScope {
    return (
      boundOwner(this.engine.store, row) ??
      proposedOwner(this.engine.store, row, connectedHost)
    );
  }

  private cancelReceipt(row: {
    id: string;
    version: number;
  }): { requests: string[] } | undefined {
    return this.engine.store.getMeta<{ requests: string[] }>(
      this.cancelKey(row.id, row.version),
    );
  }

  /**
   * Whether this task still has an open decision the operator must answer, wherever its
   * card lives, by the same one re-offer rule the offer uses. The host shows the task's
   * row as attention and leaves it out of the Inbox's running count; a decision never
   * holds the task's own thread (nucleus#1538).
   */
  openDecisionKey(taskId: string): string | null {
    const rows = this.engine.store
      .listDecisions({ status: "open", task: taskId })
      .filter((row) => (this.cancelReceipt(row)?.requests.length ?? 0) < 2);
    return rows.length
      ? JSON.stringify(rows.map((row) => [row.id, row.version]))
      : null;
  }

  /**
   * The host's inbox uses this to gate its re-entry and release: a decision this inbox
   * must ask about, with the operator-cancel cap applied. Null when none is open. A
   * version whose card the host still shows pending counts: the turn exists to hold it.
   */
  pendingInboxDecisionKey(hostId: string): string | null {
    const rows = this.offerable(hostId);
    return rows.length
      ? JSON.stringify(rows.map((row) => [row.id, row.version]))
      : null;
  }

  /**
   * Record the cards the host's own read of T3 shows still pending. An unread thread
   * (`null`) clears the observation, so a previous absence cannot authorize an offer
   * after a failed read. A task thread's read only settles a card an earlier owner left
   * there; a decision's card is offered in the Inbox alone (nucleus#1538).
   */
  observedCards(scope: AcpCardScope, cards: AcpPendingCard[] | null): void {
    if (!("hostId" in scope)) return;
    const key = inboxScopeKey(scope.hostId);
    if (cards === null) {
      this.presentCards.delete(key);
      return;
    }
    this.presentCards.set(
      key,
      new Set(cards.map((card) => `${card.id}:${card.version}`)),
    );
    // Positive host evidence adopts a legacy card this Inbox shows before anything else
    // can offer the version. A card about another host's task stays that host's.
    for (const card of cards) {
      const row = this.engine.store
        .listDecisions({ status: "open" })
        .find((d) => d.id === card.id && d.version === card.version);
      if (!row || boundOwner(this.engine.store, row)) continue;
      const linkedHost = row.links.tasks
        .map((id) => this.engine.store.taskOrNull(id))
        .find(
          (task) =>
            task && !task.removedAt && task.hostId?.startsWith("t3code:"),
        )?.hostId;
      if (!linkedHost || linkedHost === scope.hostId)
        bindOwner(this.engine.store, row, {
          kind: "inbox",
          hostId: scope.hostId,
        });
    }
  }

  /** The task a decision is about, for the name its Inbox card carries. */
  private linkedTask(row: import("../../shared/contracts").Decision): {
    reference: string | null;
    title: string;
  } | null {
    for (const id of row.links.tasks) {
      const task = this.engine.store.taskOrNull(id);
      if (task && !task.removedAt)
        return { reference: task.reference ?? null, title: task.title };
    }
    return null;
  }

  /**
   * What this Inbox's next offer raises: the offerable versions whose card the host's own
   * read of T3 does not already show pending. A first offer waits for that read.
   */
  private raises(hostId: string) {
    const present = this.presentCards.get(inboxScopeKey(hostId));
    if (!present) return [];
    const offered = [];
    for (const row of this.offerable(hostId)) {
      if (present.has(`${row.id}:${row.version}`)) continue;
      bindOwner(this.engine.store, row, this.owner(row, hostId));
      offered.push(acpElicitation(row, this.linkedTask(row)));
    }
    return offered;
  }

  /** Resolve the exact version shown on a card, including an answer since superseded. */
  decisionSettlement(
    id: string,
    version: number,
    scope?: AcpCardScope,
  ): { state: "open" | "answered" | "cancelled"; answer?: string } {
    try {
      const decision = this.engine.store.decision(id);
      if (decision.version === version && decision.status === "open") {
        // No decision is owned by a task thread (Spec 032), so any card left there is
        // settled; only the owning Inbox keeps its card open.
        if (scope && !("hostId" in scope)) return { state: "cancelled" };
        const owner = boundOwner(this.engine.store, decision);
        if (scope && (!owner || owner.hostId !== scope.hostId))
          return { state: "cancelled" };
        return { state: "open" };
      }
      const next = decision.versions.find((row) => row.version === version + 1);
      if (next?.status === "answered" && next.answer)
        return { state: "answered", answer: next.answer.text };
    } catch {
      /* A removed decision has no answer and its card is cleared. */
    }
    return { state: "cancelled" };
  }

  /** Create an inbox credential with no task authority. */
  bindInbox(input: {
    hostId: string;
    ignorePattern?: string;
    holdPattern?: string;
  }) {
    return mintAcpInbox({
      ...input,
      dataHome: this.dataHome,
      socketPath: this.options.socketPath,
    });
  }

  /**
   * Ask whether to keep holding this turn, and which lifecycle lines to show. An
   * attach (`attach: true`) always gets the current line: the agent may have been
   * killed and relaunched while this service kept the session's shown signature, and
   * a reloaded thread has nothing else to display. An attach raises no card: a card
   * belongs to a held turn, and the first held poll offers it at once because the attach
   * recorded no offer (nucleus#1395).
   */
  async turn(input: AcpTurnInput, token: string): Promise<AcpTurnReply> {
    if (input.kind === "inbox") {
      // The inbox holds its turn only while an operator decision is offered (nucleus#1384).
      // The adapter releases it once nothing is offered and its own cards are settled; an
      // offer that arrives first cancels that directive, so a card is never left behind.
      const record = verifyAcpInbox(
        {
          dataHome: this.dataHome,
          hostId: input.hostId,
          sessionId: input.sessionId,
        },
        token,
      );
      const waitMs = Math.max(
        0,
        Math.min(input.waitMs ?? 0, ACP_TURN_WAIT_MAX_MS),
      );
      const deadline = Date.now() + waitMs;
      for (;;) {
        const elicitations =
          input.attach === true ? [] : this.raises(record.hostId);
        const signature = JSON.stringify(elicitations);
        // A decision this inbox must ask about holds the turn, even while its card is
        // already live on T3: an offer that arrives first cancels that release directive.
        const required = this.pendingInboxDecisionKey(record.hostId);
        if (required) this.releases.delete(record.sessionId);
        const release = this.releases.get(record.sessionId);
        if (release !== undefined && !required) {
          this.releases.delete(record.sessionId);
          this.shownDecisions.set(record.sessionId, signature);
          return {
            kind: "inbox",
            hostId: record.hostId,
            state: "release",
            reason: release,
            messages: [],
            elicitations: [],
          };
        }
        if (
          input.attach ||
          this.shownDecisions.get(record.sessionId) !== signature ||
          Date.now() >= deadline
        ) {
          this.shownDecisions.set(record.sessionId, signature);
          return {
            kind: "inbox",
            hostId: record.hostId,
            state: "hold",
            reason: "the inbox is open",
            messages: [],
            elicitations,
          };
        }
        await this.wait(
          record.sessionId,
          Math.min(this.pollMs, deadline - Date.now()),
        );
      }
    }
    const record = verifyAcpSession(
      {
        dataHome: this.dataHome,
        taskId: input.taskId,
        sessionId: input.sessionId,
      },
      token,
    );
    const waitMs = Math.max(
      0,
      Math.min(input.waitMs ?? 0, ACP_TURN_WAIT_MAX_MS),
    );
    const deadline = Date.now() + waitMs;
    const first = !this.shown.has(record.sessionId);
    for (;;) {
      const task = this.engine.store.task(record.taskId);
      const runs = this.engine.store.runs(task.id);
      const events = this.engine.store.eventsAll(task.id);
      const decisions = this.engine.store.listDecisions({
        status: "open",
        task: task.id,
      });
      const decisionId = decisions[0]?.id ?? null;
      const waitContext = taskWaitStateContext(
        this.engine.store,
        task,
        decisionId,
      );
      const view = taskDetailView(
        taskWithCurrentWait(this.engine.store, task, waitContext),
        waitContext,
        runs,
        events,
        this.engine.store.canonicalRepository(task.repoPath, task.repository),
        Date.now(),
        activityReadContext(this.engine.store),
      );
      const facts = {
        task,
        runs,
        activity: view.activity!,
        decisions,
        events,
      };
      const presentation = acpTaskPresentation(facts);
      const signature = acpPresentationSignature(presentation, facts);
      const previous = this.shown.get(record.sessionId);
      const changed =
        first || input.attach === true || previous?.signature !== signature;
      let messages: string[] = [];
      if (changed) {
        // A reattached session has nothing on screen to build on, so its view is rebuilt whole.
        const memory: AcpLineMemory =
          previous && input.attach !== true
            ? previous.memory
            : { named: false, prUrl: null };
        const derived = acpTaskMessages(facts, memory);
        messages = derived.messages;
        this.remember(record.sessionId, signature, derived.nextMemory);
      }
      const release = this.releases.get(record.sessionId);
      if (release !== undefined || acpTaskFinished(task)) {
        this.releases.delete(record.sessionId);
        return this.reply(
          task,
          "release",
          release ?? `the task is ${task.phase}`,
          messages,
          presentation,
        );
      }
      if (changed || input.attach || Date.now() >= deadline)
        return this.reply(
          task,
          "hold",
          `the task is ${task.phase}`,
          messages,
          presentation,
        );
      await this.wait(
        record.sessionId,
        Math.min(this.pollMs, deadline - Date.now()),
      );
    }
  }

  /** Only an authenticated session may answer a decision currently offered to it. */
  async answer(input: AcpAnswerInput, token: string): Promise<unknown> {
    if (input.kind === "inbox")
      verifyAcpInbox(
        {
          dataHome: this.dataHome,
          hostId: input.hostId,
          sessionId: input.sessionId,
        },
        token,
      );
    else
      verifyAcpSession(
        {
          dataHome: this.dataHome,
          taskId: input.taskId,
          sessionId: input.sessionId,
        },
        token,
      );
    const decision = this.engine.store
      .listDecisions({ status: "open" })
      .find(
        (row) =>
          row.id === input.id &&
          row.version === input.version &&
          !!boundOwner(this.engine.store, row) &&
          matchesOwner(boundOwner(this.engine.store, row)!, input),
      );
    if (!decision) {
      // A service-initiated settlement follows a closed or changed version. It is
      // already recorded, and must not be recorded a second time by this callback.
      try {
        const current = this.engine.store.decision(input.id);
        if (current.status !== "open" || current.version !== input.version)
          return { recorded: false };
      } catch {
        return { recorded: false };
      }
      throw new Error("Decision changed or is not offered to this session");
    }
    if (input.action === "cancel") {
      // Only the operator's own dismissal reaches this route: the agent records the
      // cancellation receipt for a card its live turn raised, and a card a host settled
      // from its own read of T3 records nothing (nucleus#1395).
      const key = this.cancelKey(input.id, input.version);
      this.engine.store.transaction(() => {
        const receipt = this.engine.store.getMeta<{ requests: string[] }>(
          key,
        ) ?? { requests: [] };
        if (
          !receipt.requests.includes(input.requestId) &&
          receipt.requests.length < 2
        ) {
          this.engine.store.setMeta(key, {
            requests: [...receipt.requests, input.requestId],
          });
        }
      });
      return { recorded: false };
    }
    if (!this.options.answerDecision)
      throw new Error("This process cannot answer decisions");
    const hostId =
      input.kind === "inbox"
        ? input.hostId
        : this.engine.store.task(input.taskId).hostId!;
    return this.options.answerDecision({
      id: input.id,
      version: input.version,
      answer: input.answer,
      answeredBy: t3OperatorIdentity(hostId),
      relayed: false,
      note:
        input.kind === "inbox"
          ? `Answered from T3 inbox ${input.hostId}`
          : `Answered from T3 task ${input.taskId}`,
    });
  }

  /**
   * Serve the operator's `ui` from an authenticated inbox session (nucleus#1415). The host
   * answers with the board it showed or the failure it met, inside the command's own bound;
   * whether the inbox is held is decided by the offer alone, so the command's result never
   * changes decision delivery.
   */
  async openInboxUi(
    input: AcpInboxUiInput,
    token: string,
  ): Promise<AcpInboxUiReply> {
    const record = verifyAcpInbox(
      {
        dataHome: this.dataHome,
        hostId: input.hostId,
        sessionId: input.sessionId,
      },
      token,
    );
    const hasOffer = () => this.pendingInboxDecisionKey(record.hostId) !== null;
    if (!this.options.openInboxUi) {
      return {
        status: "failed",
        hold: hasOffer(),
        detail: "This process cannot open the board from the inbox",
      };
    }
    try {
      const opened = await this.options.openInboxUi(record.hostId);
      const detail =
        opened.status === "failed" ? sanitizeBoardDetail(opened.detail) : "";
      return {
        status: opened.status,
        hold: hasOffer(),
        ...(detail ? { detail } : {}),
      };
    } catch (error) {
      const detail = sanitizeBoardDetail(
        error instanceof Error ? error.message : String(error),
      );
      return {
        status: "failed",
        hold: hasOffer(),
        ...(detail ? { detail } : {}),
      };
    }
  }

  /** The operator's text in the task's thread: recorded and routed by Nucleus, never by the agent. */
  async message(
    input: AcpMessageInput,
    token: string,
  ): Promise<AcpMessageReply> {
    const record = verifyAcpSession(
      {
        dataHome: this.dataHome,
        taskId: input.taskId,
        sessionId: input.sessionId,
      },
      token,
    );
    return {
      receipt: await this.engine.resolution.operatorMessage(
        record.taskId,
        input.eventId,
        input.text,
      ),
    };
  }

  /**
   * A host adapter's release directive: end this session's held turn now, with its
   * reason shown to the client. A later prompt holds again.
   */
  release(sessionId: string, reason: string): void {
    this.releases.set(sessionId, reason);
    this.wake(sessionId);
  }

  private reply(
    task: Task,
    state: AcpTurnReply["state"],
    reason: string,
    messages: string[],
    presentation?: AcpTaskPresentation,
  ): AcpTurnReply {
    return {
      state,
      reason,
      messages,
      task: {
        taskId: task.id,
        reference: task.reference ?? null,
        phase: task.phase,
        name: acpTaskName(task),
      },
      ...(presentation ? { presentation } : {}),
    };
  }

  /** Remember one session's last line without letting the map grow with every task ever seen. */
  private remember(
    sessionId: string,
    signature: string,
    memory: AcpLineMemory,
  ): void {
    if (this.shown.size >= ACP_SIGNATURE_MEMORY && !this.shown.has(sessionId)) {
      const oldest = this.shown.keys().next();
      if (!oldest.done) this.shown.delete(oldest.value);
    }
    this.shown.set(sessionId, { signature, memory });
  }

  /** One bounded wait: a release directive wakes it, otherwise it checks again on the next tick. */
  private wait(sessionId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timers = this.waiting.get(sessionId) ?? new Set<() => void>();
      const done = () => {
        timers.delete(done);
        if (timers.size === 0) this.waiting.delete(sessionId);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      timer.unref?.();
      timers.add(done);
      this.waiting.set(sessionId, timers);
    });
  }

  private wake(sessionId: string): void {
    for (const done of [...(this.waiting.get(sessionId) ?? [])]) done();
  }
}

/** One board failure's detail with any pairing URL or token fragment removed. */
function sanitizeBoardDetail(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(
      /pairingUrl:\S+|https?:\/\/\S*#token=\S+|#token=\S+/gi,
      "[redacted]",
    )
    .trim();
}
