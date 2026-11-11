import { paseoWorkspaceIdAccepted } from "./workspace-id";
import { existsSync } from "node:fs";
import type { Host, HostNativeArchive, HostThread, HostThreadInventory, HostTerminalInventory, HostWorkspaceRef, HostWorkspaceRecord, HostWorkspaceSpec } from "../../../shared/host";
import type { HostWorktreeWorkspaceSpec } from "../../../core/host";

/**
 * The Paseo host's workspace calls, behind the `Host` contract: the complete
 * native inventory, the project lookup, the native registration and the native
 * title write. Step 3 row 3 of the Paseo host split map (task 871) moved these
 * out of `server/paseo.ts`, which held them only because it was the one object
 * the core had.
 *
 * What decides stays core. `core/workspaces/workspace-lifecycle.ts` keeps workspace
 * inspection, the owned path and allocation proofs, the same-path registration
 * decision, the Git populate and every creation progress step; it calls these
 * calls at the points it already called Paseo. `workspaceInventory` is the native
 * read `findWorkspaces` matches against: the matching itself reads the Queue-owned
 * path facts, so it stays with them. Step 4 row 2 of that split (task 903) moved
 * the retained and closeout workspace policy to
 * `core/workspaces/workspace-continuation.ts`: the continuation preflight, the process
 * proof and the closeout workspace's identity and source proof keep their
 * refreshes, reads and refusals there, and this host supplies the registration
 * handle, the complete inventory and the worktree registration.
 *
 * Step 3 row 6 (task 871) moved the complete thread and terminal inventories
 * behind the same surface: `workspaceThreads` (every thread in the listed
 * registrations, archived included), `activeThreads` (every live thread, as
 * review entry reads it) and `workspaceTerminals`. Each walks the daemon to its
 * positive end and reports an incomplete or unreadable read as a refusal, never
 * as an empty list. The ownership, idleness and Git decisions over those facts
 * stay in `server/paseo.ts`.
 *
 * The owner is kept and `owner.api` is read at call time, so a test's replaced
 * daemon surface is the one called and nothing captures it. Each method keeps
 * the shape its call needs and adds no turn of its own: the reads await the
 * daemon inside the call the core had, and `createWorkspace` is a plain return
 * of the daemon's own promise, with core keeping the answer's mapping and
 * refusal as it did before the move.
 */
export class PaseoWorkspaceHost implements Pick<Host, "workspaceRef" | "workspaceAvailable" | "repositoryProject" | "setWorkspaceTitle" | "workspaceArchived"
  | "workspaceTerminals" | "workspaceThreads" | "activeThreads"> {
  constructor(private readonly owner: { readonly api: NativeWorkspaceDaemon }) {}

  archiveThreadPage(options: { filter: { includeArchived: boolean; projectKeys?: string[] }; page: { limit: number; cursor?: string } }) {
    return this.owner.api.agents.list(options);
  }

  /**
   * One registration's handle over the daemon's own. Each member is a plain
   * return: `refresh()` and `archive()` hand back the daemon's promise, so the
   * caller's await is the first thing after the call, and `current()` and
   * `directory` read the daemon's record when the caller reads them. The
   * continuation preflight, the process proof and the task workspace retirement
   * keep their refreshes, reads and refusals in core.
   */
  workspaceIdAccepted(id: unknown) { return paseoWorkspaceIdAccepted(id); }
  workspaceRef(id: string): HostWorkspaceRef {
    const native = this.owner.api.workspaces.ref(id);
    return {
      get directory() { return native.directory; },
      refresh: () => native.refresh(),
      current: () => native.current(),
      archive: (requestId) => native.archive(requestId),
    };
  }

  /**
   * Whether the daemon no longer lists the registration: the refresh is read
   * first, and only an absent record answers true. Core keeps the uncertain-archive
   * reconciliation that asks this question.
   */
  async workspaceArchived(id: string) {
    const workspace = this.owner.api.workspaces.ref(id); await workspace.refresh();
    return !workspace.current();
  }

  /**
   * The complete active inventory, paged to its end.
   *
   * Creation reconciliation needs it: Paseo's free-text workspace query does
   * not promise to search `worktreeSlug`, so using the Queue slug as a query
   * can hide the exact workspace whose creation response was lost. Page first,
   * then the caller applies the strict repository-plus-slug or recorded-ID
   * identity locally.
   */
  async workspaceInventory() {
    const entries: Awaited<ReturnType<typeof this.owner.api.workspaces.list>>["entries"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.owner.api.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      entries.push(...result.entries);
      if (!result.pageInfo.hasMore) return entries;
      if (!result.pageInfo.nextCursor) throw new Error("Workspace lookup is incomplete");
      cursor = result.pageInfo.nextCursor;
    }
    throw new Error("Workspace lookup exceeded the bounded page limit");
  }

  /**
   * The Paseo project rooted at a repository. Without it, a directory workspace
   * becomes its own project named after the worktree folder (Paseo's
   * findOrCreateProjectForDirectory). If no active project is rooted there, the
   * fallback keeps today's behaviour.
   */
  async repositoryProject(projectRoot: string) {
    try {
      const projects = (await this.owner.api.projects.list()).projects;
      const project = projects.find(entry => entry.projectRootPath === projectRoot);
      return project ? { projectId: project.projectId } : {};
    } catch { return {}; }
  }

  /**
   * Register one folder as a host workspace. Core supplies the title, the stable
   * request ID, the folder and the project it proved; this is Paseo's create,
   * returned as the daemon's own promise. Nothing is awaited or mapped here, so
   * core's existing refusal and `{id, directory}` mapping keep their turn: a
   * registration without a directory is not a workspace, and creation and
   * recovery name different refusals at their own boundaries.
   */
  createWorkspace(spec: HostWorkspaceSpec) {
    return this.owner.api.workspaces.create({ title: spec.title, requestId: spec.requestId,
      source: { kind: "directory", path: spec.directory, ...spec.project } });
  }

  /**
   * Register the closeout worktree core proved. Core supplies the title, the
   * request ID and the branch-off source — the repository, the integration
   * branch it starts from and the branch and slug it names — and this is Paseo's
   * own create returned as the daemon's promise. Core keeps the refusal a
   * registration without a directory names and its `{id, directory}` mapping.
   */
  createCloseoutWorkspace(spec: HostWorktreeWorkspaceSpec) {
    return this.owner.api.workspaces.create(spec);
  }

  /**
   * Write one workspace title, and confirm the host holds it. The refresh is the
   * read an uncertain previous write needs: a title the host already shows is
   * confirmed without a second send.
   */
  async setWorkspaceTitle(id: string, title: string, requestId: string, _uncertain: boolean) {
    const workspace = this.owner.api.workspaces.ref(id);
    const current = await workspace.refresh();
    if (!current) throw Error('Task workspace is no longer available');
    if (workspace.name === title) return;
    const result = await workspace.setTitle(title, requestId);
    if (result.title !== title) throw Error('Workspace title update was not confirmed');
  }

  async workspaceAvailable(id: string) {
    const workspace = this.owner.api.workspaces.ref(id); await workspace.refresh(); return Boolean(workspace.directory && existsSync(workspace.directory));
  }

  /**
   * The workspace's terminal sessions. A failed read keeps its cause in the
   * refusal text core reports; the count and the refusal it causes stay in core.
   */
  async workspaceTerminals(id: string): Promise<HostTerminalInventory> {
    try {
      const terminals = await this.owner.api.terminals.list({ workspaceId: id });
      return { ok: true, terminals: terminals.entries.map(entry => ({ id: entry.id, name: entry.name })) };
    } catch (error) { return { ok: false, reason: `Workspace ${id} terminal inventory could not be read: ${errorMessage(error)}` }; }
  }

  /**
   * Every thread, archived included, in the listed registrations. The walk is
   * paged to its positive end: a repeated or missing cursor is an incomplete
   * inventory, never a smaller one.
   */
  async workspaceThreads(workspaceIds: readonly string[]): Promise<HostThreadInventory> {
    try {
      const threads: HostThread[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const result = await this.owner.api.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
        threads.push(...result.entries.map(entry => entry.agent).filter(agent => agent.workspaceId != null && workspaceIds.includes(agent.workspaceId)).map(threadRecord));
        if (result.pageInfo.hasMore === false) break;
        const next = result.pageInfo.nextCursor;
        if (result.pageInfo.hasMore !== true || !next || cursors.has(next)) return { ok: false, reason: 'Workspace thread inventory is incomplete' };
        cursors.add(next); cursor = next;
      }
      return { ok: true, threads };
    } catch (error) { return { ok: false, reason: `Workspace thread inventory could not be read: ${errorMessage(error)}` }; }
  }

  /**
   * Every live thread the daemon lists, paged to its end. An unfinished walk
   * rejects: an unknown inventory is never an idle one.
   */
  async activeThreads(): Promise<HostThread[]> {
    const entries: NativeThreadEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.owner.api.agents.list({ filter: { includeArchived: false }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
      entries.push(...result.entries);
      if (!result.pageInfo.hasMore) return entries.map(entry => threadRecord(entry.agent));
      const next = result.pageInfo.nextCursor;
      if (!next) throw Error('Workspace thread inventory is incomplete');
      cursor = next;
    }
    throw Error('Workspace thread inventory exceeded its page limit');
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The Nucleus facts of one native thread record: what the ownership and idleness decisions read. */
const threadRecord = (agent: NativeThreadRecord): HostThread => ({
  id: agent.id,
  workspaceId: agent.workspaceId ?? null,
  labels: agent.labels ?? {},
  status: agent.status ?? '',
  archived: Boolean(agent.archivedAt),
  activeTurn: Boolean(agent.activeTurn),
  pendingPermissionKinds: (agent.pendingPermissions ?? []).map(request => request?.kind ?? null),
});

/**
 * The native workspace surface these calls read, as Nucleus states it: no SDK
 * type crosses the boundary, and only what is used is declared. The adapter's
 * own `api` is one of these.
 */
export interface NativeWorkspaceDaemon {
  readonly workspaces: {
    list(options: { page: { limit: number; cursor?: string } }): Promise<{ entries: NativeWorkspaceEntry[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }>;
    create(options: NativeWorkspaceCreateInput): Promise<NativeWorkspaceHandle>;
    ref(id: string): NativeWorkspaceRef;
  };
  readonly projects: { list(): Promise<{ projects: { projectRootPath: string; projectId: string }[] }> };
  readonly agents: {
    list(options: { filter: { includeArchived: boolean }; page: { limit: number; cursor?: string } }): Promise<{ entries: NativeThreadEntry[]; pageInfo: { hasMore: boolean; nextCursor?: string | null } }>;
  };
  readonly terminals: { list(options: { workspaceId: string }): Promise<{ entries: { id: string; name: string }[] }> };
}

/** One listed thread as the daemon reports it; only the fields the thread facts read. */
export interface NativeThreadRecord {
  readonly id: string;
  readonly workspaceId?: string | null;
  readonly labels?: Record<string, string>;
  readonly status?: string | null;
  readonly archivedAt?: string | null;
  readonly activeTurn?: unknown;
  readonly pendingPermissions?: readonly ({ readonly kind?: string | null } | null)[] | null;
}

export interface NativeThreadEntry {
  readonly agent: NativeThreadRecord;
}

/** One registration the inventory lists; `labels` is what the live-run presence projection reads. */
export interface NativeWorkspaceEntry {
  readonly id: string;
  readonly projectRootPath: string;
  readonly workspaceDirectory?: string | null;
  readonly worktreeSlug?: string | null;
  readonly labels?: readonly string[];
}

/** The registrations this host can be asked for: a folder, or the closeout worktree core proved. */
export type NativeWorkspaceCreateInput =
  | { title: string; requestId: string; source: { kind: "directory"; path: string; projectId?: string } }
  | HostWorktreeWorkspaceSpec;

/** A registration's own answer, as much of it as creation and recovery read. */
export interface NativeWorkspaceHandle {
  readonly id: string;
  readonly directory: string | null;
}

export interface NativeWorkspaceRef {
  readonly name?: string | null;
  readonly directory?: string | null;
  refresh(): Promise<unknown>;
  /** The record the last refresh read; null or undefined once the daemon no longer lists it. */
  current(): HostWorkspaceRecord | null | undefined;
  setTitle(title: string, requestId: string): Promise<{ title: string | null }>;
  archive(requestId: string): Promise<HostNativeArchive>;
}
