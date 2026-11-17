/**
 * The BB board's pure decisions (Spec 062, decisions 5c and 5d): the rail badge,
 * the panel's sub-path routes, and which thread gets which tab. No React and no
 * SDK here, so each decision is tested on its own against real board shapes.
 */
import { phaseNeedsAttention } from "../../../shared/pipeline-board";
import { isOpenTask } from "../../../shared/queue-navigation";
import { attention } from "../../../client/board/text";
import type { BbSidebarGroups, BbSidebarProject } from "../../../shared/schema/bb-sidebar";
import type { TaskSummary } from "../../../shared/contracts";

/** The global board's `navPanel` (decision 5c): `/plugins/nucleus/board`. */
export const BOARD_PANEL_ID = "nucleus-board";
export const BOARD_PANEL_PATH = "board";

/** One project's board: `/plugins/nucleus/board/project/<nucleus-project-key>`. */
export const PROJECT_SEGMENT = "project";
/** The board's own Settings route, which the board header's Settings button opens. */
export const SETTINGS_SEGMENT = "settings";

export type BoardRoute =
  | { kind: "board" }
  | { kind: "project"; key: string }
  | { kind: "settings" }
  | { kind: "unknown"; subPath: string };

/**
 * The panel's route from its percent-encoded sub-path. The project key is the
 * Nucleus project key (decision 5d), never a BB project id, so a multi-repository
 * project has one route.
 */
export function parseBoardSubPath(subPath: string): BoardRoute {
  const segments = subPath.split("/").filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return null; }
  });
  if (segments.length === 0) return { kind: "board" };
  if (segments.some(segment => segment === null)) return { kind: "unknown", subPath };
  if (segments.length === 1 && segments[0] === SETTINGS_SEGMENT) return { kind: "settings" };
  if (segments.length === 2 && segments[0] === PROJECT_SEGMENT && segments[1]) return { kind: "project", key: segments[1] };
  return { kind: "unknown", subPath };
}

/** The unencoded sub-path `useBbNavigate().toPluginPanel` takes for one project's board. */
export const projectSubPath = (key: string) => `${PROJECT_SEGMENT}/${key}`;

/**
 * Whether a task needs the operator: the board's own attention test (an
 * attention phase — needs attention, blocked, error — a resolution marked for
 * attention, or an origin fault), an escalated hold or stop, or a native
 * question waiting on the operator.
 */
export function taskNeedsOperator(task: TaskSummary): boolean {
  return attention(task) || task.resolution?.escalated === true || (task.questionAgentIds?.length ?? 0) > 0;
}

/** The rail badge, as BB's `experimental_useBadge` takes it. */
export interface RailBadge {
  count: number;
  tone: "critical" | "warning";
  label: string;
}

/**
 * The rail badge from one board snapshot (decision 5c): the number of open tasks
 * that need the operator, `critical` while any of them is failing or waiting on
 * the operator (an attention phase or a question) and `warning` when only an
 * escalated hold or recovery stands, and `null` once they have all settled, so the
 * badge drains instead of sitting at zero.
 */
export function railBadge(tasks: readonly TaskSummary[]): RailBadge | null {
  const needing = tasks.filter(task => isOpenTask(task) && taskNeedsOperator(task));
  if (needing.length === 0) return null;
  const critical = needing.some(task => phaseNeedsAttention(task.phase) || (task.questionAgentIds?.length ?? 0) > 0);
  return {
    count: needing.length,
    tone: critical ? "critical" : "warning",
    label: needing.length === 1 ? "1 task needs you" : `${needing.length} tasks need you`,
  };
}

/** What the BB surfaces resolve from the sidebar's one read. */
export interface SidebarIndex {
  /** The Nucleus project whose planner or named agent this thread is, if any. */
  projectForThread(threadId: string): BbSidebarProject | null;
  /** The task whose recorded role thread this is, if any. */
  taskForThread(threadId: string): { taskId: string; role: string } | null;
  /** The Nucleus project a BB project row stands for, if Nucleus recorded one. */
  projectForBbProject(bbProjectId: string): BbSidebarProject | null;
}

/**
 * Index the read. A thread that is both a project agent and a recorded role thread
 * is a role thread here: the task detail is what is in front of the operator.
 */
export function sidebarIndex(read: BbSidebarGroups | null): SidebarIndex {
  const roles = new Map<string, { taskId: string; role: string }>();
  const projects = new Map<string, BbSidebarProject>();
  const bbProjects = new Map<string, BbSidebarProject>();
  for (const thread of read?.threads ?? []) roles.set(thread.threadId, { taskId: thread.taskId, role: thread.role });
  for (const project of read?.projects ?? []) {
    for (const threadId of project.threadIds) if (!roles.has(threadId) && !projects.has(threadId)) projects.set(threadId, project);
    for (const bbProjectId of project.bbProjectIds) if (!bbProjects.has(bbProjectId)) bbProjects.set(bbProjectId, project);
  }
  return {
    projectForThread: threadId => projects.get(threadId) ?? null,
    taskForThread: threadId => roles.get(threadId) ?? null,
    projectForBbProject: bbProjectId => bbProjects.get(bbProjectId) ?? null,
  };
}
