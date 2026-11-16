import { z } from "zod";
import { availabilitySchema } from "../../shared/contracts";
import type { Completion } from "../../shared/contracts";
import { StoreCore, digest } from "./store-core";

/**
 * A callback that presented no credential, a revoked one, or another run's
 * token. It carries the refusal as a type so a caller (the callback socket's
 * status choice) decides from the class, never by matching this message.
 */
export class UnauthorizedCallbackError extends Error {
  constructor() { super("Unauthorized callback"); this.name = "UnauthorizedCallbackError"; }
}

export class StoreAuth {
  constructor(private readonly core: StoreCore) {}
  private get db() { return this.core.db; }
  /** A re-issued credential (restart, continuation, recovery) replaces the hash and lifts any revocation. */
  setCredential(run: string, token: string) { this.db.prepare("INSERT INTO credentials(run, hash, revoked) VALUES(?,?,0) ON CONFLICT(run) DO UPDATE SET hash=excluded.hash, revoked=0").run(run, digest(token)); }
  deleteCredential(run: string): void { this.db.prepare("DELETE FROM credentials WHERE run=?").run(run); }
  /** Store already-encoded availability without changing the caller's cooldown semantics. */
  setAvailability(group: string, data: string): void {
    this.db.prepare("INSERT INTO availability VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET data=excluded.data").run(group, data);
  }
  deleteAvailability(group: string): boolean {
    return this.db.prepare("DELETE FROM availability WHERE group_id=?").run(group).changes > 0;
  }
  /**
   * The stored hash of one receipt bound to this task and run, or null when the
   * receipt is absent or bound to another task or run. Callers compare it with
   * the record's own digest; this is the one read of that column.
   */
  receiptHash(id: string, task: string, run: string): string | null {
    const row = this.db.prepare("SELECT hash FROM receipts WHERE id=? AND task=? AND run=?").get(id, task, run) as { hash?: string } | undefined;
    return row?.hash ?? null;
  }
  /**
   * The arrival position and stored hash of one receipt bound to this task and
   * run, or null when it is absent or bound elsewhere. Position is the row order
   * the receipts keep, so a later receipt compares greater.
   */
  receiptPosition(id: string, task: string, run: string): { sequence: number; hash: string } | null {
    const row = this.db.prepare("SELECT rowid AS sequence, hash FROM receipts WHERE id=? AND task=? AND run=?").get(id, task, run) as { sequence: number; hash: string } | undefined;
    return row ?? null;
  }
  /** The arrival position of the first receipt a run recorded on its task, or null when it recorded none. */
  firstReceiptSequence(task: string, run: string): number | null {
    const row = this.db.prepare("SELECT rowid AS sequence FROM receipts WHERE task=? AND run=? ORDER BY rowid LIMIT 1").get(task, run) as { sequence: number } | undefined;
    return row?.sequence ?? null;
  }
  /** Completion writes preserve any report intent/response already attached to the same receipt. */
  setCompletionReceipt(id: string, task: string, run: string, hash: string, response: string): void {
    this.db.prepare("INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task=excluded.task,run=excluded.run,hash=excluded.hash,response=excluded.response").run(id,task,run,hash,response);
  }
  setReportIntent(id: string, task: string, run: string, hash: string): void {
    this.db.prepare("INSERT INTO receipts(id,task,run,hash,response,report_hash) VALUES(?,?,?,'','',?) ON CONFLICT(id) DO UPDATE SET report_hash=excluded.report_hash").run(id,task,run,hash);
  }
  setReportResponse(id: string, hash: string, response: unknown): void {
    this.db.prepare("UPDATE receipts SET report_response=? WHERE id=?").run(JSON.stringify({hash,response}),id);
  }
  authenticate(run: string, token: string) {
    const credential = this.db.prepare("SELECT hash, revoked FROM credentials WHERE run=?").get(run);
    if (!credential || credential.revoked || credential.hash !== digest(token)) throw new UnauthorizedCallbackError();
    const binding = this.db.prepare(`SELECT json_extract(r.data,'$.hostId') AS runHost,
        json_extract(t.data,'$.hostId') AS taskHost FROM runs r LEFT JOIN tasks t ON t.id=r.taskId WHERE r.id=?`).get(run);
    if (binding && (!binding.taskHost || binding.runHost !== binding.taskHost)) throw new Error('Waiting for a proven run host');
    if (!binding) {
      const tasks = this.db.prepare("SELECT json_extract(data,'$.hostId') AS host FROM tasks WHERE json_extract(data,'$.runId')=? LIMIT 2").all(run);
      if (tasks.length > 1 || tasks.some(task => !task.host)) throw new Error('Waiting for a proven run host');
    }
  }
  credentialRunForToken(token: string): string | null {
    const rows = this.db.prepare("SELECT run FROM credentials WHERE hash=? AND revoked=0 LIMIT 2").all(digest(token));
    return rows.length === 1 ? String(rows[0].run) : null;
  }
  /** Subscription group availability rows as stored. */
  availability(): Array<z.infer<typeof availabilitySchema>> {
    return this.db.prepare("SELECT data FROM availability").all().map(row => availabilitySchema.parse(JSON.parse(String(row.data))));
  }
  receipt(input: Completion, token: string): { accepted: true; eventId: string } | null {
    this.authenticate(input.runId, token);
    const row = this.db.prepare("SELECT * FROM receipts WHERE id=?").get(input.eventId);
    if (!row) return null;
    if (!row.hash) {
      if ((row.task && row.task !== input.taskId) || (row.run && row.run !== input.runId)) throw new Error("Completion event ID conflict");
      return null;
    }
    if (row.task !== input.taskId || row.run !== input.runId || row.hash !== digest(JSON.stringify(input))) throw new Error("Completion event ID conflict");
    return JSON.parse(String(row.response));
  }
}
