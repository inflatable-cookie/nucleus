import { type HookRecord, hookRecordSchema } from "../../shared/hooks";
import { StoreCore } from "./store-core";

interface HookEventAccess {
  taskChanged(taskId: string): void;
}

/** Hook events: the telemetry journal of hook runs, read by page for the event loop and deleted in bounded batches. */
export class StoreHookEvents {
  constructor(private readonly core: StoreCore, private readonly access: HookEventAccess) {}

  /** One rowid-ordered page of hook events, for callers that hand the event loop back between pages. */
  hookEventsPage(afterRowid: number, limit: number, throughRowid = Number.MAX_SAFE_INTEGER): { records: HookRecord[]; lastRowid: number } {
    const rows = this.core.db.prepare("SELECT rowid AS rid, data FROM hook_events WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(afterRowid, throughRowid, limit);
    return { records: rows.map(row => hookRecordSchema.parse(JSON.parse(String(row.data)))), lastRowid: rows.length ? Number(rows[rows.length - 1].rid) : afterRowid };
  }

  hookEvents(taskId?: string): HookRecord[] {
    const rows = taskId ? this.core.db.prepare("SELECT data FROM hook_events WHERE taskId=? ORDER BY rowid").all(taskId) : this.core.db.prepare("SELECT data FROM hook_events ORDER BY rowid").all();
    return rows.map(row => hookRecordSchema.parse(JSON.parse(String(row.data))));
  }

  hookEvent(id: string): HookRecord | null {
    const row = this.core.db.prepare("SELECT data FROM hook_events WHERE id=?").get(id);
    return row ? hookRecordSchema.parse(JSON.parse(String(row.data))) : null;
  }

  /**
   * Remove reconciled orphan occurrences in bounded transactions. The reaper collects them
   * while it walks the table, so a store with thousands of legacy orphans pays a handful of
   * commits instead of one durable write per row.
   */
  deleteHookEvents(ids: readonly string[], batch = 500): number {
    let removed = 0;
    for (let start = 0; start < ids.length; start += batch) {
      const slice = ids.slice(start, start + batch);
      removed += this.core.transaction(() => {
        const remove = this.core.db.prepare("DELETE FROM hook_events WHERE id=?");
        let count = 0;
        for (const id of slice) count += Number(remove.run(id).changes);
        return count;
      });
    }
    return removed;
  }

  putHookEvent(record: HookRecord) {
    this.core.db.prepare("INSERT INTO hook_events VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(record.id, record.taskId, `${record.hookId}:${record.event}`, record.eventId, JSON.stringify(record));
    this.core.advanceTelemetryRevision(); this.access.taskChanged(record.taskId);
  }
}
