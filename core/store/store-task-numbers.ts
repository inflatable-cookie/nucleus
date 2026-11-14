import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { taskNumberReference } from "./store-tasks";
import { repositoryIdentity } from "./store-tasks";

/** The number cache the projection keeps warm; a miss reads the table. */
export interface TaskNumberCache {
  set(taskId: string, value: { number: number; reference: string }): void;
}

/** The facts task numbering needs: the store's connection and the projection's number cache. */
export interface TaskNumberServices {
  readonly db: DatabaseSync;
  readonly numberCache: TaskNumberCache;
}

/**
 * Task numbering: which human reference names which task, and the durable per-repository
 * counter that gives each one its number. One owner, so assignment, lookup and the
 * ambiguous-reference refusal cannot drift.
 */
export class StoreTaskNumbers {
  constructor(private readonly services: TaskNumberServices) {}
  private get db() { return this.services.db; }

  /** Assign this task's number from its repository's counter, or return the number it has. */
  assign(taskId: string, repository: string): { number: number; reference: string } {
    const existing = this.numberFor(taskId);
    if (existing) return existing;
    const row = this.db.prepare("SELECT next_number FROM task_number_counters WHERE repository=?").get(repository);
    const number = Number(row?.next_number ?? 1);
    this.db.prepare("INSERT INTO task_numbers(task_id,repository,number) VALUES(?,?,?)").run(taskId, repository, number);
    this.db.prepare("INSERT INTO task_number_counters(repository,next_number) VALUES(?,?) ON CONFLICT(repository) DO UPDATE SET next_number=excluded.next_number").run(repository, number + 1);
    const assigned = { number, reference: taskNumberReference(repository, number) };
    this.services.numberCache.set(taskId, assigned);
    return assigned;
  }

  numberFor(taskId: string): { number: number; reference: string } | null {
    const row = this.db.prepare("SELECT repository,number FROM task_numbers WHERE task_id=?").get(taskId);
    return row ? { number: Number(row.number), reference: taskNumberReference(String(row.repository), Number(row.number)) } : null;
  }

  /** Every numbered task's numbering repository; the row survives a task's purge, so it resolves a decision's link. */
  repositories(): Array<{ taskId: string; repository: string }> {
    return this.db.prepare("SELECT task_id,repository FROM task_numbers").all()
      .map(row => ({ taskId: String(row.task_id), repository: String(row.repository) }));
  }

  /**
   * The one task a human reference names. A bare `repo#N` may name the repository slug or
   * its path, so more than one match is ambiguous and refuses rather than picking one.
   */
  taskIdByNumber(input: { reference?: string; repository?: string; number?: number }): string {
    const match = input.reference?.match(/^([^#]+)#0*([1-9][0-9]*)$/);
    const rows = input.repository && input.number
      ? this.db.prepare("SELECT task_id FROM task_numbers WHERE repository=? AND number=?").all(repositoryIdentity(input.repository, input.repository), input.number)
      : match ? this.db.prepare("SELECT task_id,repository FROM task_numbers WHERE number=?").all(Number(match[2])).filter(row =>
        match[1]!.includes('/') ? String(row.repository) === repositoryIdentity(match[1]!, match[1]!) : basename(String(row.repository)) === match[1]) : [];
    if (rows.length !== 1) throw new Error(rows.length ? "Ambiguous task reference; use repository and number" : "Task reference not found");
    return String(rows[0].task_id);
  }

  /** Resolve human task references at the API boundary; stored identities stay UUIDs. */
  resolve(identity: string): string {
    return identity.includes('#') ? this.taskIdByNumber({ reference: identity }) : identity;
  }
}
