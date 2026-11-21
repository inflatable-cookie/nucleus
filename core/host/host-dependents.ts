import type { Store } from "../store/store";
import { terminalThreadCleanupWaits } from "../workspaces/thread-archive";
import type { HostDependency } from "../../shared/rpc/hosts";
import type { HostKind } from "../../shared/host-kind";

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
const LIVE_OPERATION_STATES = [
  "pending",
  "running",
  "needs_attention",
] as const;

function cleanupReason(uncertainty: unknown, reason: unknown): string {
  if (uncertainty) {
    try {
      const value = JSON.parse(String(uncertainty)) as { reason?: unknown };
      if (typeof value.reason === "string" && value.reason) return value.reason;
    } catch {
      /* Report unreadable evidence without exposing its contents. */
    }
    return "ownership evidence is unreadable";
  }
  return reason ? String(reason) : "waiting for a process observation";
}

export function hostDependents(
  source: Store,
  host: { id: string; kind: HostKind; primary: boolean },
): HostDependency[] {
  const { db } = source;
  const ref = (taskId: string) => source.numberFor(taskId)?.reference ?? taskId;
  // Unqualified legacy records belong to the primary host only. The match is spelled as
  // plain index-able terms (nucleus#1495) so each host reads by seek, not by scanning history.
  const hostMatch = (column: string) =>
    host.primary
      ? `(${column}=?1 OR ${column} IS NULL OR ${column}='')`
      : `${column}=?1`;
  const params = [host.id] as const;
  const out: HostDependency[] = [];

  const tasks = db
    .prepare(
      `SELECT id FROM tasks
    WHERE json_extract(data,'$.removedAt') IS NULL
      AND json_extract(data,'$.phase') NOT IN ('done','cancelled')
      AND ${hostMatch("json_extract(data,'$.hostId')")}
    ORDER BY rowid`,
    )
    .all(...params)
    .map((row) => ref(String(row.id)));
  if (tasks.length)
    out.push({ kind: "task", label: "live task", names: tasks });

  const runs = db
    .prepare(
      `SELECT runs.id AS id, runs.taskId AS taskId, json_extract(runs.data,'$.role') AS role FROM runs
    JOIN tasks ON tasks.id=runs.taskId
    WHERE json_extract(tasks.data,'$.removedAt') IS NULL
      AND COALESCE(json_extract(runs.data,'$.released'),0)=0
      AND ${hostMatch("json_extract(runs.data,'$.hostId')")}
    ORDER BY runs.rowid`,
    )
    .all(...params)
    .map(
      (row) =>
        `${ref(String(row.taskId))} ${row.role ? String(row.role) : "run"}`,
    );
  if (runs.length) out.push({ kind: "run", label: "bound run", names: runs });

  const effects: string[] = [];
  const states = LIVE_OPERATION_STATES.map(() => "?").join(",");
  for (const row of db
    .prepare(
      `SELECT operations.id AS id, operations.kind AS kind, operations.state AS state, operations.taskId AS taskId, json_extract(operations.data,'$.startedAt') AS startedAt, json_extract(operations.data,'$.effect.target') AS target, json_extract(operations.data,'$.diagnostic') AS diagnostic FROM operations
    LEFT JOIN tasks ON tasks.id=operations.taskId OR (operations.kind='submit' AND operations.taskId IS NULL
      AND tasks.submission=json_extract(operations.data,'$.submissionId'))
    WHERE operations.state IN (${states}) AND COALESCE(json_extract(operations.data,'$.hostId'),json_extract(tasks.data,'$.hostId'))=?
      AND NOT (operations.state='needs_attention' AND COALESCE(
        json_extract(operations.data,'$.settlement.id')=operations.id
        AND json_extract(operations.data,'$.settlement.inputHash')=operations.inputHash
        AND json_extract(operations.data,'$.settlement.attempt')=json_extract(operations.data,'$.attempts')
        AND json_extract(operations.data,'$.settlement.intentAt') IS json_extract(operations.data,'$.effect.intentAt')
        AND json_type(operations.data,'$.settlement.evidence')='text',0))
      AND NOT (operations.state='needs_attention' AND (operations.kind='submit' OR (operations.kind='task_control'
        AND COALESCE(json_extract(operations.data,'$.effect.kind')='task_control' AND json_extract(operations.data,'$.effect.target')='restart',0))) AND EXISTS (SELECT 1 FROM events
        WHERE events.taskId=operations.taskId AND events.kind='operation_superseded' AND json_valid(events.detail)
          AND json_extract(events.detail,'$.id')=operations.id
          AND json_extract(events.detail,'$.inputHash')=operations.inputHash
          AND json_extract(events.detail,'$.attempt')=json_extract(operations.data,'$.attempts')
          AND json_extract(events.detail,'$.intentAt') IS json_extract(operations.data,'$.effect.intentAt')
          AND json_type(events.detail,'$.evidence')='text')) ORDER BY operations.rowid`,
    )
    .all(...LIVE_OPERATION_STATES, host.id))
    effects.push(
      `${String(row.kind).replace(/_/g, " ")}${row.taskId ? ` for ${ref(String(row.taskId))}` : ""}: ${row.state === "needs_attention" ? `settlement lacks proof${row.kind === "task_control" && !row.taskId ? " (operation task identity is missing)" : row.kind === "task_control" && row.target === "restart" && !row.startedAt ? " (operation start time is missing)" : ""}; owner should inspect operation ${String(row.id)} with operation-status and reconcile its outcome` : `operation ${String(row.id)} is ${String(row.state)}`}${row.diagnostic ? ` (${String(row.diagnostic)})` : ""}`,
    );
  for (const row of db
    .prepare(
      `SELECT json_extract(value,'$.id') AS runId, json_extract(value,'$.taskId') AS taskId, json_extract(value,'$.uncertainty') AS uncertainty, json_extract(value,'$.leftAlone.reason') AS reason FROM meta
    WHERE key LIKE 'runProcessCleanup:%' AND json_extract(value,'$.pending')=1 AND json_extract(value,'$.hostId')=?
    ORDER BY key`,
    )
    .all(host.id)) {
    const reason = cleanupReason(row.uncertainty, row.reason);
    const action =
      reason === "a live run shares this agent" ||
      reason === "run or its participant is active"
        ? "wait for the active run to finish"
        : reason === "a protected runtime still uses the scratch directory" ||
            reason === "live-ancestor" ||
            reason === "respawned-after-stop"
          ? "wait for the owning runtime to release the scratch"
          : reason === "scratch retirement was refused"
            ? "inspect the scratch retirement guard"
            : "restore process ownership observation";
    effects.push(
      `process cleanup for ${ref(String(row.taskId))}: ${reason}; owner should inspect run ${String(row.runId)} and ${action}; the sweep retries`,
    );
  }
  for (const task of source.finishedTasksOwingThreadCleanup(
    host.id,
    host.kind === "t3code",
  )) {
    const waits = terminalThreadCleanupWaits(
      source,
      task,
      host.kind === "t3code",
    );
    const detail = waits
      .map(
        (wait) =>
          `${wait.reason}; ${
            wait.retryWorkspaceId
              ? `owner can use retry_effect workspace_archive.${wait.retryWorkspaceId}`
              : "waiting for the host observation on a later sweep"
          }`,
      )
      .join("; ");
    effects.push(
      `thread cleanup for ${ref(task.id)}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (effects.length)
    out.push({ kind: "effect", label: "unsettled effect", names: effects });

  const repositories = source
    .repositories()
    .filter((entry) => entry.hostKind === host.kind)
    .map((entry) => entry.repository.origin ?? entry.repository.path);
  if (repositories.length)
    out.push({ kind: "repository", label: "repository", names: repositories });
  return out;
}

/** Counted and named, a few of each, as the confirm and the refusal both word them. */
export function hostDependencyText(dependency: HostDependency): string {
  const shown = dependency.names.slice(0, 3).join(", ");
  const more =
    dependency.names.length > 3 ? `, +${dependency.names.length - 3} more` : "";
  return `${dependency.names.length} ${dependency.label}${dependency.names.length === 1 ? "" : "s"} (${shown}${more})`;
}

/** Why `host.remove` refuses: online, then every dependency but repositories. */
export function hostRemovalBlockers(
  online: boolean,
  dependents: readonly HostDependency[],
): string[] {
  return [
    ...(online ? ["Host is online"] : []),
    ...dependents
      .filter((dependency) => dependency.kind !== "repository")
      .map(hostDependencyText),
  ];
}
