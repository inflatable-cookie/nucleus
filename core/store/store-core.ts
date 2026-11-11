import { formatAgentId } from "../../shared/agent-identity";
import { createHash } from "node:crypto";
import { DatabaseSync,type StatementSync } from "node:sqlite";

export const now = () => new Date().toISOString();
export class StoreMaintenanceError extends Error {
  constructor(message = "Store maintenance is running; no write may start") { super(message); this.name = "StoreMaintenanceError"; }
}

/** A host-run row's data only when it is well-formed JSON, so an undecodable row reads as NULL. */
export const HOST_RUN_VALID_DATA = "CASE WHEN json_valid(data) THEN data END";
/** The indexed selector expression; queries must repeat it exactly to use the index. */
export const HOST_RUN_SELECTOR = `json_extract(${HOST_RUN_VALID_DATA},'$.selector')`;

interface TransactionHooks { committed(): void; beforeRollback(): void; rolledBack(): void }
interface StoreCoreHooks {
  transaction(): TransactionHooks;
  revisionAdvanced(): void;
  eventWritten(taskId: string, at: string): void;
  taskChanged(taskId: string): void;
}

/** Shared persistence primitives. Seam modules depend on this class, never on Store. */
export class StoreCore {
  db!: DatabaseSync;
  maintenanceOpen = false;
  private readonly statements = new Map<string, StatementSync>();
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  private hostRunAuthorityObserver: ((previous: unknown, value: unknown) => void) | null = null;
  constructor(private readonly hooks: StoreCoreHooks) {}
  transaction<T>(fn: () => T): T {
    if (this.maintenanceOpen) throw new StoreMaintenanceError();
    this.db.exec("BEGIN IMMEDIATE");
    const hooks = this.hooks.transaction();
    try {
      const result = fn(); this.db.exec("COMMIT");
      hooks.committed();
      return result;
    } catch (error) {
      hooks.beforeRollback();
      this.db.exec("ROLLBACK");
      hooks.rolledBack();
      throw error;
    }
  }
  event(taskId: string, kind: string, detail: string) {
    const at = now();
    this.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)").run(taskId, at, kind, detail);
    this.hooks.eventWritten(taskId, at);
    this.advanceTelemetryRevision(); this.hooks.taskChanged(taskId);
  }

  getMeta<T>(key: string): T | undefined {
    const statement = this.statement("SELECT value FROM meta WHERE key=?");
    const row = statement.get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }

  deleteMeta(key: string) {
    if (this.maintenanceOpen) throw new StoreMaintenanceError();
    this.db.prepare("DELETE FROM meta WHERE key=?").run(key);
  }

  setMeta(key: string, value: unknown) {
    if (this.maintenanceOpen) throw new StoreMaintenanceError();
    const previous = key === "hostRunAuthority" ? this.getMeta(key) : undefined;
    this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
    if (key === "hostRunAuthority") {
      try { this.hostRunAuthorityObserver?.(previous, value); } catch { /* Scheduler observation never changes the authority write. */ }
    }
  }

  observeHostRunAuthority(observer: ((previous: unknown, value: unknown) => void) | null) { this.hostRunAuthorityObserver = observer; }

  readClock(name: string): number {
    const statement = this.statement("SELECT version FROM projection_clock WHERE name=?");
    return Number(statement.get(name)?.version ?? 0);
  }

  telemetryRevision(): number { return this.readPublicationClock().version; }

  boardRevision(): number { return this.readPublicationClock().board_version; }

  private readPublicationClock(): { version: number; board_version: number } {
    const statement = this.statement("SELECT version,board_version FROM projection_clock WHERE name='publication'");
    const row = statement.get();
    return { version: Number(row?.version ?? 0), board_version: Number(row?.board_version ?? 0) };
  }

  advanceTelemetryRevision() { this.advancePublicationClock(false); }

  private advancePublicationClock(board: boolean): void {
    const statement = this.statement(`INSERT INTO projection_clock(name,version,board_version) VALUES('publication',1,?)
      ON CONFLICT(name) DO UPDATE SET version=version+1,board_version=board_version+excluded.board_version`);
    statement.run(board ? 1 : 0);
  }

  /** Configuration writes must advance the board as well as telemetry. */
  advanceRevision() { this.advancePublicationClock(true); this.hooks.revisionAdvanced(); }

  /**
   * Planning-list revision: lead, papercut and decision writes advance it, and nothing else
   * does. `lead.board` derives only from those records, so a task, run, notice, project or
   * configuration write no longer rebuilds it per poll.
   */
  leadRevision(): number { return this.getMeta<number>("leadRevision") ?? 0; }

  advanceLeadRevision() { this.setMeta("leadRevision", this.leadRevision() + 1); }
}



export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Normalized input digest used to fence idempotent acceptance. */
export const operationInputHash = (value: unknown) => digest(JSON.stringify(value ?? null));



/**
 * The durable per-thread archive effect. `archived` is proof that a thread Queue
 * launched can never take another turn, which is also when its run scratch
 * leaves are done (task 681).
 */
export const qualifiedThreadArchiveEffectKey = (hostId: string, agentId: string) => `threadArchiveQualified:${formatAgentId(hostId, agentId)}`;
