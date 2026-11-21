import { noticeSchema, type Notice } from "../../shared/contracts";
import { StoreCore } from "./store-core";

interface NoticeAccess {
  taskChanged(taskId: string): void;
}

/** Operator notices: one row per notice, read per task or across the board. */
export class StoreNotices {
  constructor(private readonly core: StoreCore, private readonly access: NoticeAccess) {}

  notices(taskId?: string): Notice[] {
    return (taskId ? this.core.db.prepare("SELECT data FROM notices WHERE taskId=? ORDER BY rowid").all(taskId) : this.core.db.prepare("SELECT data FROM notices ORDER BY rowid").all())
      .map(r => noticeSchema.parse(JSON.parse(String(r.data))));
  }

  /** Notices whose status still awaits settlement; the admission and attention counts read this. */
  unsettledNoticeCount(): number {
    return Number(this.core.db.prepare("SELECT COUNT(*) AS count FROM notices WHERE json_extract(data, '$.status') IN ('pending','intent','uncertain')").get()?.count ?? 0);
  }

  putNotice(n: Notice) {
    const saved = this.core.db.prepare(`INSERT INTO notices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data
      WHERE json_extract(notices.data,'$.explicitlyClearedAt') IS NULL`).run(n.id, n.taskId, JSON.stringify(n));
    if (!saved.changes) return;
    this.core.advanceRevision();
    this.access.taskChanged(n.taskId);
  }
}
