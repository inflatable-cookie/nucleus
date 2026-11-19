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
import type { Task } from "../../shared/contracts";
import type { AgentMessageReceipt } from "../questions/agent-messages";
import { verifyAcpSession, mintAcpSession } from "./binding";
import type { AcpAnswerInput, AcpCaller, AcpCardScope, AcpMessageInput, AcpPendingCard, AcpSessionBinding, AcpSessionSurface, AcpTurnInput, AcpTurnReply } from "../../shared/acp/surface";
import { acpFinishedLine, acpLifecycleLine, acpLifecycleSignature, acpTaskFinished, acpTaskName, type AcpLineMemory } from "./lifecycle";
import type { Engine } from "../engine";
import { createHash } from "node:crypto";
import { mintAcpInbox, verifyAcpInbox } from "./inbox-binding";
import { t3OperatorIdentity } from "../../shared/operator-identity";
import { acpDecisions, acpElicitation } from "./decisions";

/** How long one long-poll may wait; the agent asks again after this. */
export const ACP_TURN_WAIT_MAX_MS = 25_000;
/** How often a held turn re-reads its task while it waits. */
export const ACP_TURN_POLL_MS = 1_000;
/** Sessions whose last shown signature is remembered; the oldest is dropped first. */
export const ACP_SIGNATURE_MEMORY = 512;

/** The key one host scope's cards are recorded under. */
const scopeKey = (scope: AcpCardScope): string =>
  "hostId" in scope ? `inbox:${scope.hostId}` : `task:${scope.taskId}`;
/** The scope a caller offers decisions in, when it names one. */
const callerScope = (caller: AcpCaller): string | null =>
  caller.kind === "inbox" ? `inbox:${caller.hostId}` : caller.taskId ? `task:${caller.taskId}` : null;

export interface AcpMessageReply { receipt: AgentMessageReceipt }

export interface AcpSessionsOptions {
  /** The data home whose `acp/` directory holds session records and bindings. */
  dataHome: string;
  /** The callback socket the binding points the agent at. */
  socketPath: string;
  pollMs?: number;
  answerDecision?: (input: { id: string; version: number; answer: string; answeredBy: string; relayed: boolean; note: string }) => unknown;
}

/**
 * Mint a session, or refuse when this process serves none. The catalogue's owner
 * calls this with the surface the runtime attached, so the refusal is one rule
 * rather than a check each caller remembers.
 */
export function bindAcpSession(acp: AcpSessionSurface | null, input: { taskId: string; ignorePattern?: string; holdPattern?: string }): AcpSessionBinding {
  if (!acp) throw new Error("This process does not serve ACP sessions, so no binding was minted");
  return acp.bind(input);
}

export class AcpSessions implements AcpSessionSurface {
  /**
   * What each session was last shown: the signature, so a quiet task sends nothing,
   * and the reference and PR link already on screen, so a line does not repeat them.
   */
  private readonly shown = new Map<string, { signature: string; memory: AcpLineMemory }>();
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

  constructor(readonly engine: Engine, readonly options: AcpSessionsOptions) {}

  get dataHome(): string { return this.options.dataHome; }
  private get pollMs(): number { return this.options.pollMs ?? ACP_TURN_POLL_MS; }

  /** Mint this task's session and the pointer in its checkout. One session per task. */
  bind(input: { taskId: string; ignorePattern?: string; holdPattern?: string }): AcpSessionBinding {
    const task = this.engine.store.task(input.taskId);
    if (task.removedAt) throw new Error(`Task ${acpTaskName(task)} was removed; no ACP session can be bound to it`);
    if (!task.directory) throw new Error(`Task ${acpTaskName(task)} has no workspace checkout yet; bind the ACP session once its worktree exists`);
    return mintAcpSession({ dataHome: this.dataHome, socketPath: this.options.socketPath, taskId: task.id, directory: task.directory,
      ...(input.ignorePattern ? { ignorePattern: input.ignorePattern } : {}),
      ...(input.holdPattern ? { holdPattern: input.holdPattern } : {}) });
  }

  private cancelKey(id: string, version: number): string {
    return `acpCancel:${createHash("sha256").update(JSON.stringify([id, version])).digest("hex")}`;
  }
  /**
   * The decisions this session may still ask about: open here, and not dismissed as many
   * times as the operator's one re-offer allows. The operator's dismissal is the only
   * thing recorded as a cancellation receipt, so a settlement the host made from its own
   * read of T3 never spends that allowance (nucleus#1395).
   */
  private offerable(caller: AcpCaller) {
    return acpDecisions(this.engine.store, caller).filter(row => {
      const receipt = this.engine.store.getMeta<{ requests: string[] }>(this.cancelKey(row.id, row.version));
      return (receipt?.requests.length ?? 0) < 2;
    });
  }

  /** The host uses this only for the task parent it already owns. */
  pendingDecisionKey(taskId: string): string | null {
    const rows = this.offerable({ taskId, sessionId: "" });
    return rows.length ? JSON.stringify(rows.map(row => [row.id, row.version])) : null;
  }

  /**
   * The host's inbox uses this to gate its re-entry and release: a decision this inbox
   * must ask about, with the operator-cancel cap applied. Null when none is open. A
   * version whose card the host still shows pending counts: the turn exists to hold it.
   */
  pendingInboxDecisionKey(hostId: string): string | null {
    const rows = this.offerable({ kind: "inbox", hostId, sessionId: "" });
    return rows.length ? JSON.stringify(rows.map(row => [row.id, row.version])) : null;
  }

  /**
   * What the next offer raises: the offerable versions whose card the host's own read of
   * T3 does not already show pending. Recording an unread thread (`null`) proves nothing.
   */
  observedCards(scope: AcpCardScope, cards: AcpPendingCard[] | null): void {
    if (cards === null) return;
    this.presentCards.set(scopeKey(scope), new Set(cards.map(card => `${card.id}:${card.version}`)));
  }

  /** The versions a turn may raise a card for now. */
  private raises(caller: AcpCaller) {
    const present = this.presentCards.get(callerScope(caller) ?? "");
    return this.offerable(caller).filter(row => !present?.has(`${row.id}:${row.version}`)).map(acpElicitation);
  }

  /** Resolve the exact version shown on a card, including an answer since superseded. */
  decisionSettlement(id: string, version: number): { state: "open" | "answered" | "cancelled"; answer?: string } {
    try {
      const decision = this.engine.store.decision(id);
      if (decision.version === version && decision.status === "open") return { state: "open" };
      const next = decision.versions.find(row => row.version === version + 1);
      if (next?.status === "answered" && next.answer) return { state: "answered", answer: next.answer.text };
    } catch { /* A removed decision has no answer and its card is cleared. */ }
    return { state: "cancelled" };
  }

  /** Create an inbox credential with no task authority. */
  bindInbox(input: { hostId: string; ignorePattern?: string; holdPattern?: string }) {
    return mintAcpInbox({ ...input, dataHome: this.dataHome, socketPath: this.options.socketPath });
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
      const record = verifyAcpInbox({ dataHome: this.dataHome, hostId: input.hostId, sessionId: input.sessionId }, token);
      const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, ACP_TURN_WAIT_MAX_MS));
      const deadline = Date.now() + waitMs;
      for (;;) {
        const elicitations = input.attach === true ? [] : this.raises(input);
        const signature = JSON.stringify(elicitations);
        // A decision this inbox must ask about holds the turn, even while its card is
        // already live on T3: an offer that arrives first cancels that release directive.
        const required = this.pendingInboxDecisionKey(record.hostId);
        if (required) this.releases.delete(record.sessionId);
        const release = this.releases.get(record.sessionId);
        if (release !== undefined && !required) {
          this.releases.delete(record.sessionId);
          this.shownDecisions.set(record.sessionId, signature);
          return { kind: "inbox", hostId: record.hostId, state: "release", reason: release, messages: [], elicitations: [] };
        }
        if (input.attach || this.shownDecisions.get(record.sessionId) !== signature || Date.now() >= deadline) {
          this.shownDecisions.set(record.sessionId, signature);
          return { kind: "inbox", hostId: record.hostId, state: "hold", reason: "the inbox is open", messages: [], elicitations };
        }
        await this.wait(record.sessionId, Math.min(this.pollMs, deadline - Date.now()));
      }
    }
    const record = verifyAcpSession({ dataHome: this.dataHome, taskId: input.taskId, sessionId: input.sessionId }, token);
    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, ACP_TURN_WAIT_MAX_MS));
    const deadline = Date.now() + waitMs;
    const first = !this.shown.has(record.sessionId);
    for (;;) {
      const task = this.engine.store.task(record.taskId);
      const signature = acpLifecycleSignature(task);
      const messages: string[] = [];
      const elicitations = input.attach === true ? [] : this.raises(input);
      const decisionSignature = JSON.stringify(elicitations);
      const changedDecisions = this.shownDecisions.get(record.sessionId) !== decisionSignature;
      this.shownDecisions.set(record.sessionId, decisionSignature);
      const previous = this.shown.get(record.sessionId);
      if (first || input.attach === true || previous?.signature !== signature) {
        // A reattached session has nothing on screen to build on, so its line is whole.
        const memory: AcpLineMemory = previous && input.attach !== true ? previous.memory : { named: false, prUrl: null };
        messages.push(acpTaskFinished(task) ? acpFinishedLine(task) : acpLifecycleLine(task, memory));
        this.remember(record.sessionId, signature, { named: true, prUrl: task.prUrl ?? null });
      }
      const release = this.releases.get(record.sessionId);
      if ((release !== undefined || acpTaskFinished(task)) && !this.pendingDecisionKey(task.id)) {
        this.releases.delete(record.sessionId);
        return this.reply(task, "release", release ?? `the task is ${task.phase}`, messages);
      }
      if (messages.length || changedDecisions || input.attach || Date.now() >= deadline) return { ...this.reply(task, "hold", `the task is ${task.phase}`, messages), elicitations };
      await this.wait(record.sessionId, Math.min(this.pollMs, deadline - Date.now()));
    }
  }

  /** Only an authenticated session may answer a decision currently offered to it. */
  async answer(input: AcpAnswerInput, token: string): Promise<unknown> {
    if (input.kind === "inbox") verifyAcpInbox({ dataHome: this.dataHome, hostId: input.hostId, sessionId: input.sessionId }, token);
    else verifyAcpSession({ dataHome: this.dataHome, taskId: input.taskId, sessionId: input.sessionId }, token);
    const decision = acpDecisions(this.engine.store, input).find(row => row.id === input.id && row.version === input.version);
    if (!decision) {
      // A service-initiated settlement follows a closed or changed version. It is
      // already recorded, and must not be recorded a second time by this callback.
      try {
        const current = this.engine.store.decision(input.id);
        if (current.status !== "open" || current.version !== input.version) return { recorded: false };
      } catch { return { recorded: false }; }
      throw new Error("Decision changed or is not offered to this session");
    }
    if (input.action === "cancel") {
      // Only the operator's own dismissal reaches this route: the agent records the
      // cancellation receipt for a card its live turn raised, and a card a host settled
      // from its own read of T3 records nothing (nucleus#1395).
      const key = this.cancelKey(input.id, input.version);
      this.engine.store.transaction(() => {
        const receipt = this.engine.store.getMeta<{ requests: string[] }>(key) ?? { requests: [] };
        if (!receipt.requests.includes(input.requestId) && receipt.requests.length < 2) {
          this.engine.store.setMeta(key, { requests: [...receipt.requests, input.requestId] });
        }
      });
      return { recorded: false };
    }
    if (!this.options.answerDecision) throw new Error("This process cannot answer decisions");
    const hostId = input.kind === "inbox" ? input.hostId : this.engine.store.task(input.taskId).hostId!;
    return this.options.answerDecision({ id: input.id, version: input.version, answer: input.answer, answeredBy: t3OperatorIdentity(hostId), relayed: false,
      note: input.kind === "inbox" ? `Answered from T3 inbox ${input.hostId}` : `Answered from T3 task ${input.taskId}` });
  }

  /** The operator's text in the task's thread: recorded and routed by Nucleus, never by the agent. */
  async message(input: AcpMessageInput, token: string): Promise<AcpMessageReply> {
    const record = verifyAcpSession({ dataHome: this.dataHome, taskId: input.taskId, sessionId: input.sessionId }, token);
    return { receipt: await this.engine.resolution.operatorMessage(record.taskId, input.eventId, input.text) };
  }

  /**
   * A host adapter's release directive: end this session's held turn now, with its
   * reason shown to the client. A later prompt holds again.
   */
  release(sessionId: string, reason: string): void {
    this.releases.set(sessionId, reason);
    this.wake(sessionId);
  }

  private reply(task: Task, state: AcpTurnReply["state"], reason: string, messages: string[]): AcpTurnReply {
    return {
      state, reason, messages,
      task: { taskId: task.id, reference: task.reference ?? null, phase: task.phase, name: acpTaskName(task) },
    };
  }

  /** Remember one session's last line without letting the map grow with every task ever seen. */
  private remember(sessionId: string, signature: string, memory: AcpLineMemory): void {
    if (this.shown.size >= ACP_SIGNATURE_MEMORY && !this.shown.has(sessionId)) {
      const oldest = this.shown.keys().next();
      if (!oldest.done) this.shown.delete(oldest.value);
    }
    this.shown.set(sessionId, { signature, memory });
  }

  /** One bounded wait: a release directive wakes it, otherwise it checks again on the next tick. */
  private wait(sessionId: string, ms: number): Promise<void> {
    return new Promise(resolve => {
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
