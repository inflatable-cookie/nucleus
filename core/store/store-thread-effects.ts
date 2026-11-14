import type { DatabaseSync } from "node:sqlite";
import { qualifiedThreadArchiveEffectKey } from "./store-core";

/** The facts the thread-archive effects need: the connection, the recorded-leaf remover and meta. */
export interface ThreadEffectServices {
  readonly db: DatabaseSync;
  getMeta<T>(key: string): T | undefined;
  setMeta(key: string, value: unknown): void;
  /** Removes one recorded leaf the store proved; the caller's policy, not a new one. */
  removeRecordedRunScratch(directory: string): boolean;
}

/**
 * A thread's durable effects: the qualified archive record (proof a thread Queue launched can
 * never take another turn) and the recorded scratch leaves that go with it. One owner for the
 * key shape and for the one read and write of each, so a reader can never invent its own key.
 */
export class StoreThreadEffects {
  constructor(private readonly services: ThreadEffectServices) {}
  private get db() { return this.services.db; }

  /**
   * Look up the thread archive effect. `archived` is the durable proof that a
   * thread Queue launched can never take another turn.
   */
  archiveKey(agentId: string, hostId: string | null | undefined): string | null {
    if (!hostId) return null;
    return qualifiedThreadArchiveEffectKey(hostId, agentId);
  }

  putArchiveEffect<T extends { status: string; at: string }>(key: string, effect: T): void {
    this.services.setMeta(key, effect);
  }

  archiveEffect(agentId: string, hostId?: string | null): { status?: string } | undefined {
    const key = this.archiveKey(agentId, hostId);
    return key ? this.services.getMeta(key) : undefined;
  }

  /**
   * Remove every recorded run leaf a retired thread's tools were launched with,
   * through the same recorded-leaf path release uses. A retained thread's later
   * runs each start with their own leaf, so all of them go when the thread can
   * take no further turn (task 681).
   */
  retireScratch(taskId: string, agentId: string): number {
    let removed = 0;
    const host = this.db.prepare("SELECT json_extract(data,'$.hostId') AS host FROM tasks WHERE id=?").get(taskId)?.host;
    if (typeof host !== 'string' || !host) return 0;
    for (const row of this.db.prepare("SELECT json_extract(data,'$.temporaryDirectory') AS leaf FROM runs WHERE taskId=? AND json_extract(data,'$.agentId')=? AND json_extract(data,'$.hostId')=?").all(taskId, agentId, host))
      if (typeof row.leaf === "string" && row.leaf && this.services.removeRecordedRunScratch(row.leaf)) removed++;
    return removed;
  }
}
