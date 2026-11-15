import { historicalWireLabel } from "../../shared/wire-labels";

/**
 * The one owner of a workspace's thread inventory during an archive.
 *
 * The host SDK has no workspace filter, so the inventory is read page by page:
 * every page must make forward cursor progress and the provider must positively
 * end the list, or the archive refuses. The inventory is narrowed to the
 * workspace's project once that binding is known, and the facts the archive
 * needs — which threads belong to this task, which are foreign, and whether
 * every thread is idle — are derived here once.
 */
export interface ArchiveThreadRecord { id: string; workspaceId?: string | null; labels?: Record<string, string>; activeTurn?: unknown; pendingPermissions?: readonly unknown[] | null; status?: string | null; archivedAt?: string | null }
export interface ArchiveThreadPage { entries: { agent: ArchiveThreadRecord }[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }
export interface WorkspaceThreadInventoryHost {
  readonly workspaceHost: { archiveThreadPage(options: { filter: { includeArchived: boolean; projectKeys?: string[] }; page: { limit: number; cursor?: string } }): Promise<ArchiveThreadPage> };
}

/**
 * Every thread the daemon reports for this workspace, read to a positive end.
 *
 * A narrowed inventory passes the project keys its first catalogued page
 * observed. Archive history can exceed any fixed page count, so the read
 * requires forward cursor progress instead of guessing a bound.
 */
export async function workspaceThreadEntries(
  host: WorkspaceThreadInventoryHost,
  workspaceId: string,
  projectBinding: string | null,
  includeArchived: boolean,
): Promise<ArchiveThreadPage["entries"]> {
  const entries: ArchiveThreadPage["entries"] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const projectKeys = projectBinding ? [projectBinding] : undefined;
  for (;;) {
    const result = await host.workspaceHost.archiveThreadPage({ filter: { includeArchived, ...(projectKeys ? { projectKeys } : {}) }, page: { limit: 200, cursor } });
    entries.push(...result.entries.filter(entry => entry.agent.workspaceId === workspaceId));
    if (result.pageInfo.hasMore === false) break;
    const next = result.pageInfo.nextCursor;
    if (result.pageInfo.hasMore !== true || !next || cursors.has(next)) throw Error('Workspace thread inventory is incomplete');
    cursors.add(next);
    cursor = next;
  }
  return entries;
}

/** What the inventory says about this task's own threads and everyone else's. */
export interface WorkspaceThreadFacts {
  /** Threads that are neither this task's nor an attached participant's. */
  foreignAgentIds: string[];
}

/**
 * The ownership facts of one inventory. A foreign thread is only tolerated when
 * the caller declared `allowIdleForeignThreads`, and any thread that is not idle
 * (a live turn, a pending permission, a status that is not idle/error/closed)
 * refuses the archive: the checkout may still be written.
 */
export function workspaceThreadFacts(
  entries: ArchiveThreadPage["entries"],
  taskId: string,
  attachedAgentIds: ReadonlySet<string>,
  allowIdleForeignThreads: boolean,
): WorkspaceThreadFacts {
  const foreignAgentIds: string[] = [];
  for (const entry of entries) {
    const agent = entry.agent;
    if (historicalWireLabel(agent.labels, 'task') !== taskId && !attachedAgentIds.has(agent.id)) {
      if (!allowIdleForeignThreads) throw Error('Preserving workspace containing an unrelated thread');
      if (agent.id) foreignAgentIds.push(agent.id);
    }
    if (agent.activeTurn || agent.pendingPermissions?.length || !['idle', 'error', 'closed'].includes(agent.status ?? '')) throw Error('Waiting for workspace threads to become idle');
  }
  return { foreignAgentIds };
}
