/**
 * The forked sidebar's one read (Spec 062, decision 5b) and the board signal it
 * refetches on.
 *
 * The sidebar is a plugin surface, so the read is a plugin RPC method,
 * `sidebarGroups`, served by this plugin's backend and forwarded over the existing
 * owner socket to the Nucleus service's catalogue method `bb.sidebar-groups`. That
 * is one call for every Nucleus task group, never one per group, and it reads no
 * forge, no Git and no thread timeline: the service answers from the live task
 * records and the BB workspace handles it already owns.
 *
 * The projection is validated at both ends. It cannot import the service's own
 * schema (a BB plugin is built from its own directory), so the schema is declared
 * here and `test/bb-sidebar-groups.test.ts` parses one recorded answer through
 * both, which fails the affected run if the two ever drift.
 *
 * Live updates ride one realtime signal: the backend watches the service's board
 * revision on the retained connection and publishes `nucleus.board-signal` when it
 * moves, and the sidebar refetches this one read when it arrives. A signal that
 * never arrives costs a stale header, never a second polling loop in the UI.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The service catalogue method this plugin forwards to (Contract 007). */
export const SIDEBAR_GROUPS_METHOD = "bb.sidebar-groups";

/** The realtime channel a board revision change is published on. */
export const BOARD_SIGNAL_CHANNEL = "nucleus.board-signal";

export const sidebarGroupSchema = z.object({
  environmentId: z.string().min(1).max(240),
  taskId: z.string().min(1).max(240),
  number: z.number().int().positive().nullable(),
  reference: z.string().nullable(),
  repository: z.string().min(1).max(240),
  title: z.string().min(1),
  phase: z.string().min(1).max(60),
  phaseLabel: z.string().min(1).max(240),
  stateLabel: z.string().min(1).max(240),
  waitLabel: z.string().min(1).max(240).nullable(),
  prNumber: z.number().int().positive().nullable(),
  prState: z.enum(["OPEN", "CLOSED", "MERGED"]).nullable(),
  prUrl: z.string().max(2048).nullable(),
  attention: z.boolean(),
  held: z.boolean(),
  stop: z.string().min(1).max(60).nullable(),
}).strict();

/** One Nucleus project: the per-project tab's threads and the sidebar rows that link to its board. */
export const sidebarProjectSchema = z.object({
  key: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  repositoryPaths: z.array(z.string().min(1).max(4096)).max(100),
  threadIds: z.array(z.string().min(1).max(300)).max(101),
  bbProjectIds: z.array(z.string().min(1).max(240)).max(100),
}).strict();

export const sidebarGroupsOutputSchema = z.object({
  groups: z.array(sidebarGroupSchema),
  threads: z.array(z.object({
    threadId: z.string().min(1).max(240),
    taskId: z.string().min(1).max(240),
    role: z.string().min(1).max(80),
    environmentId: z.string().min(1).max(240),
  }).strict()),
  projects: z.array(sidebarProjectSchema),
}).strict();

export type SidebarGroup = z.infer<typeof sidebarGroupSchema>;
export type SidebarProject = z.infer<typeof sidebarProjectSchema>;

/** The route segment the board's panel takes for one project's board (decision 5d). */
export const PROJECT_BOARD_SUBPATH = "project";

/** The app route of one Nucleus project's board: `/plugins/nucleus/board/project/<key>`. */
export function projectBoardHref(projectKey: string, pluginId = "nucleus"): string {
  return `/plugins/${pluginId}/board/${PROJECT_BOARD_SUBPATH}/${encodeURIComponent(projectKey)}`;
}
export type SidebarGroups = z.infer<typeof sidebarGroupsOutputSchema>;

/** The plugin's own RPC method names, registered in `server.ts` and read by the fork. */
export const sidebarGroupsContract = defineRpcContract({
  sidebarGroups: { input: z.null(), output: sidebarGroupsOutputSchema },
});

/** One bounded service request, as the retained channel offers it. */
export interface SidebarGroupsSource {
  request(method: string, input: unknown): Promise<unknown>;
}

/**
 * The task-group action the sidebar's menu calls (nucleus#1313, Tom 2026-11-17).
 * `detachTask` records "no planner thread for presentation" for one task through the
 * service's own `detach` owner control: the plugin holds no task state, reads the
 * task's current version through `queue.next`, and names no planner. A caller from
 * the operator's BB is the operator at the board, which the control accepts.
 */
export const sidebarTaskActionContract = defineRpcContract({
  detachTask: {
    input: z.object({
      taskId: z.string().min(1).max(240),
      reason: z.string().trim().min(1).max(4000).optional(),
    }).strict(),
    output: z.object({
      taskId: z.string().min(1).max(240),
      detachedAt: z.string().min(1).max(64),
      detachedBy: z.string().min(1).max(300),
    }).strict(),
  },
});

export type SidebarTaskAction = ReturnType<typeof createSidebarTaskActionService>;

/**
 * The action's one route: read the task's current version, then apply the control.
 * A refusal is the service's own refusal text, so the menu shows why nothing changed.
 */
export function createSidebarTaskActionService(source: () => SidebarGroupsSource | null) {
  const client = (): SidebarGroupsSource => {
    const connected = source();
    if (!connected) throw new Error("The Nucleus service channel is not connected");
    return connected;
  };
  return {
    async detachTask(input: { taskId: string; reason?: string }) {
      const next = await client().request("queue.next", { taskId: input.taskId }) as { version?: unknown };
      if (typeof next?.version !== "number") throw new Error("The task's current version could not be read; nothing changed");
      const task = await client().request("queue.task", {
        action: "detach", taskId: input.taskId, version: next.version,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }) as { presentationDetached?: { at?: unknown; by?: unknown } | null };
      const record = task?.presentationDetached;
      if (!record || typeof record.at !== "string" || typeof record.by !== "string")
        throw new Error("The service answered without the detach record; re-read the task before acting again");
      return { taskId: input.taskId, detachedAt: record.at, detachedBy: record.by };
    },
  };
}

/** One BB project as `bb.sdk.projects.list()` returns it: its id and its sources. */
export interface BbProjectSource {
  id: string;
  sources?: Array<{ type?: string; path?: string }>;
}

/**
 * Add the BB projects whose local-path source is one of a Nucleus project's
 * repositories (decision 5d). The service names the BB projects its workspace
 * handles recorded; this resolves the rest — a BB project registered before any
 * task ran in it, or whose handles were all cleaned up — from BB's own project
 * list, so a project row links to its board whether or not Nucleus ever ran a
 * task there. The first Nucleus project that claims a path keeps it.
 */
export function withBbProjects(read: SidebarGroups, projects: readonly BbProjectSource[], samePath: (left: string, right: string) => boolean): SidebarGroups {
  const claimed = new Set(read.projects.flatMap(project => project.bbProjectIds));
  return {
    ...read,
    projects: read.projects.map(project => {
      const ids = [...project.bbProjectIds];
      for (const candidate of projects) {
        if (claimed.has(candidate.id)) continue;
        const local = (candidate.sources ?? []).filter(entry => entry.type === "local_path" && typeof entry.path === "string").map(entry => entry.path as string);
        if (!local.some(path => project.repositoryPaths.some(repository => samePath(path, repository)))) continue;
        claimed.add(candidate.id);
        if (ids.length < 100) ids.push(candidate.id);
      }
      return { ...project, bbProjectIds: ids };
    }),
  };
}

/**
 * The RPC handler. A read that cannot reach the service rejects: the sidebar then
 * keeps (or falls back to) upstream's group header, which is the stated
 * degradation, never a blocked sidebar or an invented state line. A failed BB
 * project list keeps the service's answer as it is: links it recorded still show.
 */
export function createSidebarGroupsService(
  source: () => SidebarGroupsSource | null,
  bbProjects?: { list(): Promise<unknown>; samePath(left: string, right: string): boolean },
) {
  return {
    async sidebarGroups(): Promise<SidebarGroups> {
      const client = source();
      if (!client) throw new Error("The Nucleus service channel is not connected");
      const read = sidebarGroupsOutputSchema.parse(await client.request(SIDEBAR_GROUPS_METHOD, null));
      if (!bbProjects) return read;
      let listed: unknown;
      try { listed = await bbProjects.list(); } catch { return read; }
      if (!Array.isArray(listed)) return read;
      const rows = listed.filter((row): row is BbProjectSource => typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string");
      return sidebarGroupsOutputSchema.parse(withBbProjects(read, rows, bbProjects.samePath));
    },
  };
}
