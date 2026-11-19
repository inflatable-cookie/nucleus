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
import type { AcpMessageInput, AcpSessionBinding, AcpSessionSurface, AcpTurnInput, AcpTurnReply } from "../../shared/acp/surface";
import { acpFinishedLine, acpLifecycleLine, acpLifecycleSignature, acpTaskFinished, acpTaskName } from "./lifecycle";
import type { Engine } from "../engine";
import { mintAcpInbox, verifyAcpInbox } from "./inbox-binding";

/** How long one long-poll may wait; the agent asks again after this. */
export const ACP_TURN_WAIT_MAX_MS = 25_000;
/** How often a held turn re-reads its task while it waits. */
export const ACP_TURN_POLL_MS = 1_000;
/** Sessions whose last shown signature is remembered; the oldest is dropped first. */
export const ACP_SIGNATURE_MEMORY = 512;

export interface AcpMessageReply { receipt: AgentMessageReceipt }

export interface AcpSessionsOptions {
  /** The data home whose `acp/` directory holds session records and bindings. */
  dataHome: string;
  /** The callback socket the binding points the agent at. */
  socketPath: string;
  pollMs?: number;
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
  /** The last lifecycle signature each session was shown, so a quiet task sends nothing. */
  private readonly shown = new Map<string, string>();
  /** Release directives from a host adapter, consumed by the turn that acts on them. */
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

  /** Create an inbox credential with no task authority. */
  bindInbox(input: { hostId: string; ignorePattern?: string; holdPattern?: string }) {
    return mintAcpInbox({ ...input, dataHome: this.dataHome, socketPath: this.options.socketPath });
  }

  /**
   * Ask whether to keep holding this turn, and which lifecycle lines to show. An
   * attach (`attach: true`) always gets the current line: the agent may have been
   * killed and relaunched while this service kept the session's shown signature, and
   * a reloaded thread has nothing else to display.
   */
  async turn(input: AcpTurnInput, token: string): Promise<AcpTurnReply> {
    if (input.kind === "inbox") {
      const record = verifyAcpInbox({ dataHome: this.dataHome, hostId: input.hostId, sessionId: input.sessionId }, token);
      const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, ACP_TURN_WAIT_MAX_MS));
      if (!input.attach && waitMs) await this.wait(record.sessionId, waitMs);
      return { kind: "inbox", hostId: record.hostId, state: "hold", reason: "the inbox is open", messages: [] };
    }
    const record = verifyAcpSession({ dataHome: this.dataHome, taskId: input.taskId, sessionId: input.sessionId }, token);
    const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, ACP_TURN_WAIT_MAX_MS));
    const deadline = Date.now() + waitMs;
    const first = !this.shown.has(record.sessionId);
    for (;;) {
      const task = this.engine.store.task(record.taskId);
      const signature = acpLifecycleSignature(task);
      const messages: string[] = [];
      if (first || input.attach === true || this.shown.get(record.sessionId) !== signature) {
        messages.push(acpTaskFinished(task) ? acpFinishedLine(task) : acpLifecycleLine(task));
        this.remember(record.sessionId, signature);
      }
      const release = this.releases.get(record.sessionId);
      if (release !== undefined || acpTaskFinished(task)) {
        this.releases.delete(record.sessionId);
        return this.reply(task, "release", release ?? `the task is ${task.phase}`, messages);
      }
      if (messages.length || Date.now() >= deadline) return this.reply(task, "hold", `the task is ${task.phase}`, messages);
      await this.wait(record.sessionId, Math.min(this.pollMs, deadline - Date.now()));
    }
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
  private remember(sessionId: string, signature: string): void {
    if (this.shown.size >= ACP_SIGNATURE_MEMORY && !this.shown.has(sessionId)) {
      const oldest = this.shown.keys().next();
      if (!oldest.done) this.shown.delete(oldest.value);
    }
    this.shown.set(sessionId, signature);
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
