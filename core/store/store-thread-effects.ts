import type { DatabaseSync } from "node:sqlite";
import type { Task } from "../../shared/contracts";
import { finishedThreadCleanupKeyPrefix, qualifiedThreadArchiveEffectKey, qualifiedThreadArchiveEffectKeyPrefix } from "./store-core";

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
   * Finished tasks on this host whose threads still owe an archive or removal.
   *
   * One direct query over the stored tasks: done or cancelled (the
   * active-capacity index deliberately excludes both, so the ordinary sweep
   * never presents them), this host's, not removed, and still owing a thread's
   * cleanup. A task is selected again on a later sweep only while an effect is
   * still owed, so a lost or partial cleanup keeps its durable retry
   * (nucleus#1155 brief v3). The effect keys and the completion marker are this
   * owner's formats, read here once.
   */
  finishedTasksOwingCleanup(hostId: string, removal: boolean): Task[] {
    const rows = this.db.prepare(`WITH finished AS (
      SELECT id, data, json_extract(data,'$.hostId') AS hostId FROM tasks
      WHERE json_extract(data,'$.hostId')=?
        AND json_extract(data,'$.removedAt') IS NULL
        AND ((json_extract(data,'$.phase')='done' AND (
          COALESCE(json_extract(data,'$.resolution.mergedCommit'),'')<>''
          OR (json_extract(data,'$.entrypoint')='proof'
            AND json_extract(data,'$.proofOnly.commit')=json_extract(data,'$.proofOnlyResult.commit'))))
          OR (? AND json_extract(data,'$.phase')='cancelled'
            AND json_extract(data,'$.disposition.status')='complete'))
        AND NOT EXISTS (SELECT 1 FROM meta WHERE key=? || tasks.id)
    ), threads AS (
      SELECT id AS taskId, hostId, json_extract(data,'$.agentId') AS agentId, 1 AS worker FROM finished
      UNION ALL
      SELECT finished.id, hostId, json_extract(retired.value,'$.agentId'), 1
        FROM finished, json_each(finished.data,'$.retiredWorkers') AS retired
      UNION ALL
      SELECT finished.id, finished.hostId, json_extract(runs.data,'$.agentId'),
        CASE WHEN json_extract(runs.data,'$.role')='revision' THEN 1 ELSE 0 END
        FROM finished JOIN runs ON runs.taskId=finished.id
        WHERE json_extract(runs.data,'$.hostId')=finished.hostId
    ), candidates AS (
      SELECT taskId, hostId, agentId, MAX(worker) AS worker FROM threads
        WHERE agentId IS NOT NULL AND agentId<>'' GROUP BY taskId, hostId, agentId
    )
    SELECT finished.data FROM finished WHERE EXISTS (
      SELECT 1 FROM candidates LEFT JOIN meta
        ON meta.key=? || json_array(candidates.hostId,candidates.agentId)
      WHERE candidates.taskId=finished.id AND (
        COALESCE(json_extract(meta.value,'$.status'),'')<>'archived'
        OR COALESCE(json_extract(meta.value,'$.op'),'archive')<>
          CASE WHEN ? AND candidates.worker=0 THEN 'delete' ELSE 'archive' END)
    ) ORDER BY finished.id`).all(hostId, removal ? 1 : 0, finishedThreadCleanupKeyPrefix, qualifiedThreadArchiveEffectKeyPrefix, removal ? 1 : 0) as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as Task);
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
