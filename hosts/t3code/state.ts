import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sanitizeHostDeliveryDiagnostic } from '../../core/host';

const workspace = z.object({ id: z.string(), directory: z.string(), projectId: z.string(), title: z.string(), archivedAt: z.string().optional() });
/**
 * The command kinds this host records. One entry's kind is a typed fact, not a
 * fact re-derived from the stored wire: the six readers that used to JSON-parse
 * `payload` for `type` now ask the ledger.
 */
const intentKind = z.enum([
  'launchThread', 'project.create', 'project.update',
  'thread.settle', 'thread.unsettle', 'thread.metadata.update', 'thread.delete', 'thread.stop', 'thread.archive',
  'thread.tag.set', 'thread.created.record',
  'message.dispatch', 'runtime-request.respond', 'thread.user-input.dismiss',
  'delegated_task.request', 'delegated_task.completion-delivery.dispose',
]);
export type T3IntentKind = z.infer<typeof intentKind>;
const agent = z.object({ id: z.string(), workspaceId: z.string(), labels: z.record(z.string(), z.string()), title: z.string().optional(),
  /**
   * The parent thread this role thread was created as a delegated child of, recorded
   * at creation. A role thread of a parented task that is *not* a child (a fallback
   * launch, or a role whose run needs another checkout) never carries it, so
   * "nested child" stays a recorded fact and is never inferred from the task
   * (nucleus#1305 review).
   */
  parentThreadId: z.string().optional() });
const diagnostic = z.object({ command: z.string().optional(), field: z.string().optional(), reason: z.string().optional(), guidance: z.string().optional() }).strict().refine(value => {
  const clean = sanitizeHostDeliveryDiagnostic(value);
  return clean.command === value.command && clean.field === value.field && clean.reason === value.reason && clean.guidance === value.guidance;
});
const intent = z.object({ payload: z.string(), status: z.enum(['unknown', 'settled', 'refused', 'moot']), result: z.unknown().optional(),
  // The command kind this entry records, written once when the command is
  // reserved. A reader decides from this typed fact instead of re-parsing the
  // stored payload; entries written before it existed derive it once, in the
  // ledger's own `intentKindOf`.
  kind: intentKind.optional(),
  // The thread this command addressed, recorded at the same time, so a reader
  // never re-parses the payload to learn whose command it is.
  threadId: z.string().optional(),
  // Deletion postcondition observed after our delete; this does not prove command delivery.
  deletionObservedAt: z.string().optional(),
  // Unknown presentation delivery stays unknown historically, but needs no more work.
  retiredByDeletion: z.string().optional(),
  diagnostic: diagnostic.optional(),
  response: z.object({ agentId: z.string(), workspaceId: z.string(), requestId: z.string(), input: z.string() }).optional() });
/**
 * One accepted worker handover whose thread had not yet ended its turn: the
 * settle waits for the named run (or the next run to end) instead of settling a
 * live turn, and the ordinary host sweep retries it. Presentation only; the
 * durable settle itself is the `intents` ledger entry written before the send.
 */
const settleIntent = z.object({ agentId: z.string(), runId: z.string(), commandId: z.string(),
  expectedLatestRunId: z.string().optional(), recordedAt: z.string() });
/**
 * One support thread the one-row model still owes work on: its `nucleus-support`
 * tag and the `thread_created` card in the worker's conversation. Both are
 * durable presentation effects recorded here before they are sent, so a lost
 * reply is reconciled by a fresh read (the card's presence, or the recorded tag
 * intent) and never resent blindly.
 */
const supportRow = z.object({ taskId: z.string(), threadId: z.string(), role: z.string(), recordedAt: z.string(),
  /** The tag's outcome once known; `unknown` delivery is never resent. */
  tag: z.enum(['pending', 'settled', 'unknown']).optional(),
  /** The card's outcome once known; a readback proves it without a resend. */
  card: z.enum(['pending', 'settled', 'unknown']).optional() });
/**
 * One task's parent thread: the Nucleus ACP session that owns the task's row, the
 * checkout binding the launched agent resolves, and the facts the sweep needs to
 * hold or release its held turn. `releasedAt` is the last release this host sent, so
 * a sweep releases one turn once; `fallbackUntil` parks the native path after a child
 * this host could not create, so the rest of the task's roles do not pay the wait.
 */
const parentThread = z.object({ taskId: z.string(), threadId: z.string(), sessionId: z.string(), bindingPath: z.string(),
  workspaceId: z.string(), projectId: z.string(), directory: z.string(), createdAt: z.string(),
  /** The task's own state title, the base the row's step rides after. */
  title: z.string().optional(), archivedAt: z.string().optional(), releasedAt: z.string().optional(),
  /** Set when this host re-entered the thread; a create inside its grace window keeps the turn. */
  holdingSince: z.string().optional(), fallbackUntil: z.string().optional() });
const schema = z.object({ version: z.literal(1), hostId: z.string(), lastPassedVersion: z.string(),
  workspaces: z.record(z.string(), workspace), agents: z.record(z.string(), agent), intents: z.record(z.string(), intent),
  pendingSettles: z.record(z.string(), settleIntent).optional(),
  /**
   * One thread Nucleus last settled, by the command that settled it. An
   * unsettle clears the entry, so a later settle re-reads the thread and
   * settles it again under a fresh command instead of early-returning on the
   * old receipt (nucleus#1181: a retained reviewer continued for a second
   * round, or a worker surfaced for attention and returned to review).
   */
  settledThreads: z.record(z.string(), z.string()).optional(),
  /**
   * Worker handover settle command ids, recorded before the send. A worker settle
   * whose delivery is unknown is never resent (nucleus#1154), so the support-thread
   * reconciler must be able to tell it apart from a support report's settle.
   */
  workerSettles: z.record(z.string(), z.string()).optional(),
  /**
   * Support threads owing the one-row presentation effects, by native thread id.
   * Removed once both the tag and the card reached an outcome.
   */
  supportRows: z.record(z.string(), supportRow).optional(),
  /**
   * The worker row's composited title last written, by worker thread id. The
   * agent record's `title` stays the task's own state title; this is the state
   * title plus the step the row names, so an unchanged row sends nothing.
   */
  rowTitles: z.record(z.string(), z.string()).optional(),
  /**
   * The thread each (task, role) currently uses, by `${taskId}:${role}`. A role
   * that gets a replacement thread displaces the old one, whose last run is then
   * history: a superseded thread's fault must never read as the task's attention.
   */
  supportCurrent: z.record(z.string(), z.string()).optional(),
  /**
   * What this host read from T3's own settings at connect, never written back:
   * whether support threads are hidden by the client's tag setting.
   */
  supportThreads: z.enum(['hidden', 'setting_off', 'tag_missing']).optional(),
  /**
   * The task's parent thread on the Nucleus ACP provider, by task id. Role threads
   * are that thread's native subagent children, so the parent is the task's one
   * operator-visible row; it is keyed separately from `agents` because it is nobody's
   * run, and `findAgents` must never mistake it for the worker this task created.
   */
  parents: z.record(z.string(), parentThread).optional(),
  /**
   * Why the native-parent path is not in use, when it is not: a missing provider
   * instance, or a child that could not be created. Recorded for the host status and
   * for the next pass, never as a task decision (a task keeps working on top-level
   * role threads, which is the fallback).
   */
  nesting: z.object({ state: z.enum(['nested', 'fallback']), reason: z.string(), at: z.string() }).optional() });
export type T3State = z.infer<typeof schema>;
export type T3SettleIntent = z.infer<typeof settleIntent>;

/** A synchronous read/modify/write under an exclusive owner-only lock; no awaits cross it. */
export class T3StateFile {
  constructor(readonly path: string) {}
  read(): T3State {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || process.getuid && stat.uid !== process.getuid()) throw Error('Unsafe T3Code state file');
      return schema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hostId: '', lastPassedVersion: '', workspaces: {}, agents: {}, intents: {} };
      throw Error('T3Code durable state is unreadable');
    }
  }
  update<T>(fn: (state: T3State) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const fd = openSync(lock, 'wx', 0o600);
    const temporary = `${this.path}.${randomUUID()}`;
    try {
      const state = this.read(), result = fn(state);
      writeFileSync(temporary, JSON.stringify(schema.parse(state)), { flag: 'wx', mode: 0o600 });
      const file = openSync(temporary, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return result;
    } finally {
      closeSync(fd); unlinkSync(lock);
    }
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
