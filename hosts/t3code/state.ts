import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
  // The digest of `payload`, recorded when a terminal entry's body is compacted
  // to its receipt: a replay must still tell the same command from a changed one,
  // and the body itself is no longer kept (see `compactHistory`).
  payloadDigest: z.string().optional(),
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

/** One command payload as recorded in the ledger, and the kind it is. */
type RecordedWire = { method?: string; payload?: { type?: unknown; threadId?: unknown; commandId?: unknown; requestId?: unknown; title?: unknown } };

/** The kind of one ledger entry, derived once from the wire when a legacy entry has none. */
export function intentKindOf(intent: T3State['intents'][string]): T3IntentKind | undefined {
  if (intent.kind) return intent.kind;
  return kindOfWire(intent.payload);
}

function kindOfWire(encoded: string): T3IntentKind | undefined {
  try {
    const wire = JSON.parse(encoded) as RecordedWire;
    if (wire.method === 'orchestration.launchThread') return 'launchThread';
    if (wire.method === 'projects.mutate') return wire.payload?.type === 'project.update' ? 'project.update' : 'project.create';
    if (wire.method !== 'orchestration.dispatchCommand' || typeof wire.payload?.type !== 'string') return undefined;
    return wire.payload.type as T3IntentKind;
  } catch {
    return undefined;
  }
}

/** The thread one entry addresses, from the record or, for a legacy entry, from its wire. */
export function intentThreadId(intent: T3State['intents'][string]): string | undefined {
  if (intent.threadId) return intent.threadId;
  try {
    const payload = (JSON.parse(intent.payload) as RecordedWire).payload;
    return typeof payload?.threadId === 'string' ? payload.threadId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many terminal commands keep their whole recorded body. The newest ones keep
 * everything, so a command retried within a task's own cycle replays its recorded
 * answer; older ones keep only their receipt (see `compactHistory`).
 */
export const RETAINED_INTENT_BODIES = 64;
/**
 * Kinds whose recorded body a later exact lookup reads, so it is never dropped:
 * a confirmed deletion reads its own command id, a runtime response binds by its
 * request, and a project mutation's caller decodes the recorded answer. All are a
 * handful of small entries, and none of them is the file's weight.
 */
const BODY_LOOKUP_KINDS: ReadonlySet<T3IntentKind> = new Set([
  'thread.delete', 'runtime-request.respond', 'thread.user-input.dismiss', 'project.create', 'project.update',
]);

/** The digest a compacted entry keeps of the exact wire it recorded. */
export const payloadDigest = (encoded: string): string => createHash('sha256').update(encoded).digest('hex');

/**
 * What a replay of this command still reads from its recorded answer once the body
 * is compacted. A launch's caller decodes the thread it created (`createAgent`);
 * every other caller ignores the answer, so `undefined` is what a caller sees.
 */
function replayReceipt(kind: T3IntentKind, result: unknown): unknown {
  if (kind !== 'launchThread') return undefined;
  const threadId = (result as { threadId?: unknown } | null)?.threadId;
  return typeof threadId === 'string' ? { threadId } : undefined;
}

/**
 * Bound the command history the file carries (2026-11-18: 686 settled commands made
 * the file 12 MB, 5.3 MB of message dispatches and 6.5 MB of launch records, and
 * every read re-parsed all of it).
 *
 * What is kept is the delivery contract itself: an entry is never dropped, so a
 * command identity stays taken and a later exact lookup or settle still finds it.
 * Beyond the newest `RETAINED_INTENT_BODIES` terminal commands a settled entry
 * keeps its receipt — status, kind, thread, delivered-body digest, deletion marks
 * and the identity a launch replay decodes — and loses the message or launch body
 * that made the file heavy. An unresolved delivery (`unknown`) is never compacted:
 * it stays exactly as recorded and is never resent blindly. A pre-send refusal
 * keeps its wire, which is what a recorded retry replays.
 */
function compactHistory(state: T3State): void {
  const keys = Object.keys(state.intents);
  // Record the kind and thread once for every entry, legacy or not, so neither a
  // later pass nor a reader parses the stored wire again.
  for (const key of keys) {
    const intent = state.intents[key];
    if (!intent.kind) { const kind = intentKindOf(intent); if (kind) intent.kind = kind; }
    if (!intent.threadId) { const threadId = intentThreadId(intent); if (threadId) intent.threadId = threadId; }
  }
  const terminal = keys.filter(key => state.intents[key].status !== 'unknown');
  // Only the commands beyond the newest window are compacted. A record with fewer
  // than the window (`length - RETAINED_INTENT_BODIES` negative) keeps every body:
  // a host's first commands must not lose what a retry within the window replays.
  const compacted = Math.max(0, terminal.length - RETAINED_INTENT_BODIES);
  for (const key of terminal.slice(0, compacted)) {
    const intent = state.intents[key];
    if (intent.payloadDigest || intent.status === 'refused' || !intent.kind || BODY_LOOKUP_KINDS.has(intent.kind)) continue;
    state.intents[key] = { ...intent, payload: '', payloadDigest: payloadDigest(intent.payload), result: replayReceipt(intent.kind, intent.result) };
  }
}

/**
 * The service is the state file's single owner, so the parsed record is held in
 * memory for the life of this object: `read()` never touches the filesystem after
 * the first call, and every change goes through `update`, which writes the whole
 * record atomically (a synced temporary file renamed over the original, under an
 * exclusive owner-only lock). The owner-only safety check runs on the one load.
 *
 * The memory record is the service's live record: callers treat what `read()`
 * returns as read-only and never mutate it outside `update`.
 *
 * On 2026-11-18 the live file was 12 MB and every status getter re-read and
 * re-parsed it (35% of the executor's samples); the in-memory record and the
 * bounded history in `update` are what stopped that.
 */
export class T3StateFile {
  private loaded: T3State | null = null;
  constructor(readonly path: string) {}
  /** The loaded record; the file is read and validated once, on the first call. */
  read(): T3State { return this.loaded ?? (this.loaded = this.load()); }
  private load(): T3State {
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
      compactHistory(state);
      writeFileSync(temporary, JSON.stringify(schema.parse(state)), { flag: 'wx', mode: 0o600 });
      const file = openSync(temporary, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return result;
    } catch (error) {
      // A refused or failed write leaves the file as it was; drop the in-memory
      // record so the next read loads exactly what the file holds instead of a
      // partly applied change.
      this.loaded = null;
      throw error;
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
