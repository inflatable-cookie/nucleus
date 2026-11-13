import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sanitizeHostDeliveryDiagnostic } from '../../core/host';

const workspace = z.object({ id: z.string(), directory: z.string(), projectId: z.string(), title: z.string(), archivedAt: z.string().optional() });
const agent = z.object({ id: z.string(), workspaceId: z.string(), labels: z.record(z.string(), z.string()), title: z.string().optional() });
const diagnostic = z.object({ command: z.string().optional(), field: z.string().optional(), reason: z.string().optional(), guidance: z.string().optional() }).strict().refine(value => {
  const clean = sanitizeHostDeliveryDiagnostic(value);
  return clean.command === value.command && clean.field === value.field && clean.reason === value.reason && clean.guidance === value.guidance;
});
const intent = z.object({ payload: z.string(), status: z.enum(['unknown', 'settled', 'refused', 'moot']), result: z.unknown().optional(),
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
  workerSettles: z.record(z.string(), z.string()).optional() });
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
