import type { DatabaseSync } from "node:sqlite";
import type { HostDependency } from "../../shared/rpc/hosts";
import type { HostKind } from "../../shared/host-kind";
import type { RepositorySettings, Task } from "../../shared/contracts";

/**
 * What still uses one registered host (Settings → Hosts, nucleus#1325): the live
 * tasks and unreleased runs bound to it, the unsettled side effects Nucleus still
 * owes on it, and the repositories whose `hostKind` routes to its kind.
 *
 * Everything but repositories refuses `host.remove`: forgetting a host while Nucleus
 * still owes it work would strand that work, and a disconnect proves nothing about
 * an outstanding effect. A repository routes to a host kind, not to this host, so
 * it is shown and never refuses.
 *
 * The primary Paseo host also answers for records written before host identities
 * were qualified (a task or run with no `hostId` belongs to it), so it counts them.
 */
export interface HostDependentsSource {
  readonly db: DatabaseSync;
  numberFor(taskId: string): { reference: string } | null;
  repositories(): RepositorySettings[];
  finishedTasksOwingThreadCleanup(hostId: string, removal: boolean): Task[];
}

const LIVE_OPERATION_STATES = ["pending", "running", "needs_attention"] as const;

export function hostDependents(source: HostDependentsSource, host: { id: string; kind: HostKind; primary: boolean }): HostDependency[] {
  const { db } = source;
  const ref = (taskId: string) => source.numberFor(taskId)?.reference ?? taskId;
  // `?2` admits unqualified legacy records for the primary host only.
  const hostMatch = (column: string) => `(${column}=?1 OR (?2=1 AND COALESCE(${column},'')=''))`;
  const params = [host.id, host.primary ? 1 : 0] as const;
  const out: HostDependency[] = [];

  const tasks = db.prepare(`SELECT id FROM tasks
    WHERE json_extract(data,'$.removedAt') IS NULL
      AND json_extract(data,'$.phase') NOT IN ('done','cancelled')
      AND ${hostMatch("json_extract(data,'$.hostId')")}
    ORDER BY rowid`).all(...params).map(row => ref(String(row.id)));
  if (tasks.length) out.push({ kind: "task", label: "live task", names: tasks });

  const runs = db.prepare(`SELECT runs.id AS id, runs.taskId AS taskId, json_extract(runs.data,'$.role') AS role FROM runs
    JOIN tasks ON tasks.id=runs.taskId
    WHERE json_extract(tasks.data,'$.removedAt') IS NULL
      AND COALESCE(json_extract(runs.data,'$.released'),0)=0
      AND ${hostMatch("json_extract(runs.data,'$.hostId')")}
    ORDER BY runs.rowid`).all(...params)
    .map(row => `${ref(String(row.taskId))} ${row.role ? String(row.role) : "run"}`);
  if (runs.length) out.push({ kind: "run", label: "bound run", names: runs });

  const effects: string[] = [];
  const states = LIVE_OPERATION_STATES.map(() => "?").join(",");
  for (const row of db.prepare(`SELECT kind, taskId FROM operations
    WHERE state IN (${states}) AND json_extract(data,'$.hostId')=? ORDER BY rowid`).all(...LIVE_OPERATION_STATES, host.id))
    effects.push(`${String(row.kind).replace(/_/g, " ")}${row.taskId ? ` for ${ref(String(row.taskId))}` : ""}`);
  for (const row of db.prepare(`SELECT json_extract(value,'$.taskId') AS taskId FROM meta
    WHERE key LIKE 'runProcessCleanup:%' AND json_extract(value,'$.pending')=1 AND json_extract(value,'$.hostId')=?
    ORDER BY key`).all(host.id))
    effects.push(`process cleanup for ${ref(String(row.taskId))}`);
  for (const task of source.finishedTasksOwingThreadCleanup(host.id, true))
    effects.push(`thread cleanup for ${ref(task.id)}`);
  if (effects.length) out.push({ kind: "effect", label: "unsettled effect", names: effects });

  const repositories = source.repositories()
    .filter(entry => entry.hostKind === host.kind)
    .map(entry => entry.repository.origin ?? entry.repository.path);
  if (repositories.length) out.push({ kind: "repository", label: "repository", names: repositories });
  return out;
}

/** Counted and named, a few of each, as the confirm and the refusal both word them. */
export function hostDependencyText(dependency: HostDependency): string {
  const shown = dependency.names.slice(0, 3).join(", ");
  const more = dependency.names.length > 3 ? `, +${dependency.names.length - 3} more` : "";
  return `${dependency.names.length} ${dependency.label}${dependency.names.length === 1 ? "" : "s"} (${shown}${more})`;
}

/** Why `host.remove` refuses: online, then every dependency but repositories. */
export function hostRemovalBlockers(online: boolean, dependents: readonly HostDependency[]): string[] {
  return [
    ...(online ? ["Host is online"] : []),
    ...dependents.filter(dependency => dependency.kind !== "repository").map(hostDependencyText),
  ];
}
