import { phaseNeedsAttention } from "../../shared/pipeline-board";
import { isTerminalPhase, phaseStateLabel, taskStateLabel } from "../../shared/task-state";
import { QA_CAPACITY_WAIT_PREFIX, waitStateLabels } from "../../shared/wait-state";
import type { Project, Task, TaskSummary } from "../../shared/contracts";
import { projectHasRepository } from "../../shared/project-scope";
import type { PrState } from "../forge/pr-status";
import type { BbSidebarGroups, BbSidebarProject, BbSidebarThread } from "../../shared/schema/bb-sidebar";

/**
 * Spec 062 decision 5b: the batched read behind a Nucleus task group's header.
 *
 * One read answers every group the sidebar draws, keyed by environment id, so a
 * group costs no request of its own. It joins two records the service already
 * owns — the live task rows and the BB workspace handles — through the workspace
 * id the task records, and it reads nothing else: no forge, no Git, no thread
 * timeline. A task with no BB environment (a Paseo or T3 task, or a BB task whose
 * first thread has not attached yet) is simply absent, and the sidebar renders
 * upstream's group for it.
 */
/**
 * The recorded BB workspace handle, as this read needs it. Structural on purpose:
 * the projection joins durable records and owns no host adapter.
 */
export interface BbSidebarWorkspace {
  environmentId?: string;
  archivedAt?: string;
  /** The BB project the handle was attached under, once BB named it. */
  projectId?: string;
  /** The repository root the handle's BB project stands for. */
  repositoryRoot?: string;
}

/** The recorded BB role-thread fact, as this read needs it. */
export interface BbSidebarThreadRecord {
  id: string;
  task: string;
  role: string;
}

export interface BbSidebarSource {
  /** Live tasks only: a finished task's group is history, not the working sidebar. */
  liveTasks(): Task[];
  /** The board's own summaries: the label, wait and PR facts the sidebar draws. */
  summaries(): TaskSummary[];
  /** The recorded `bbWorktree` handles, keyed by handle id. */
  workspaces(): Record<string, BbSidebarWorkspace>;
  /** The recorded BB role threads, for the environment-keyed thread list. */
  threads(): { agents?: Record<string, BbSidebarThreadRecord> };
  /** The board's own PR states, keyed by task id (`core/forge/pr-status.ts`). */
  prStates: Record<string, PrState>;
  /** The registered Nucleus projects (Spec 027), for the per-project surfaces (decision 5d). */
  projects(): Project[];
}

/** One bounded answer: more live tasks than this is a board problem, not a sidebar one. */
export const BB_SIDEBAR_GROUP_LIMIT = 400;

/** The PR number a card names: its own fields first, its URL as the last resort. */
export function prNumberOf(task: Pick<TaskSummary, "completionPrNumber" | "resumePrNumber" | "prUrl">): number | null {
  const candidates = [task.completionPrNumber, task.resumePrNumber];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  const match = typeof task.prUrl === "string" ? /\/pull\/(\d+)(?:$|[/?#])/.exec(task.prUrl) : null;
  return match ? Number(match[1]) : null;
}

/**
 * The recorded wait, spelled the way the board spells it. A task that names what
 * it waits on keeps that name; otherwise its declared wait state names it; and a
 * task whose own reason carries the QA queue position shows that archived reason
 * verbatim rather than a second, invented label.
 */
function waitLabelOf(task: Pick<TaskSummary, "waitingOn" | "waitState" | "reason">): string | null {
  if (task.waitingOn) return `Waiting on ${task.waitingOn}`.slice(0, 240);
  // A QA queue position is the recorded reason itself, so it is shown exactly as
  // Queue wrote it: the declared wait state's own label would drop the position.
  if (typeof task.reason === "string" && task.reason.startsWith(QA_CAPACITY_WAIT_PREFIX)) {
    const end = task.reason.indexOf(")", QA_CAPACITY_WAIT_PREFIX.length);
    return (end === -1 ? task.reason : task.reason.slice(0, end + 1)).slice(0, 240);
  }
  const state = task.waitState?.state;
  if (state && state in waitStateLabels) return waitStateLabels[state as keyof typeof waitStateLabels];
  return null;
}

/** The state helper's own answer, capped to the schema's bound rather than re-worded. */
const label = (value: string) => value.slice(0, 240);

export function readBbSidebarGroups(source: BbSidebarSource): BbSidebarGroups {
  const workspaces = source.workspaces();
  const prStates = source.prStates;
  const groups: BbSidebarGroups["groups"] = [];
  const threads: BbSidebarThread[] = [];
  const summaries = new Map(source.summaries().map(summary => [summary.id, summary]));
  const live = source
    .liveTasks()
    .filter(task => !isTerminalPhase(task.phase))
    .slice(0, BB_SIDEBAR_GROUP_LIMIT);
  const byTask = new Map<string, string>();
  for (const task of live) {
    const summary = summaries.get(task.id);
    // A live task with no board summary has no card the sidebar could agree with.
    if (!summary) continue;
    const workspaceId = task.workspaceId;
    if (!workspaceId) continue;
    const workspace = workspaces[workspaceId];
    // No attached environment means no group yet: the sidebar draws upstream's
    // header until the task's first thread lands, and never an empty state line.
    if (!workspace?.environmentId || workspace.archivedAt) continue;
    byTask.set(task.id, workspace.environmentId);
    const prNumber = prNumberOf(summary);
    groups.push({
      environmentId: workspace.environmentId,
      taskId: task.id,
      number: typeof summary.number === "number" && summary.number > 0 ? summary.number : null,
      reference: summary.reference ?? null,
      title: summary.title,
      phase: summary.phase,
      phaseLabel: label(phaseStateLabel(summary)),
      stateLabel: label(taskStateLabel(summary)),
      waitLabel: waitLabelOf(summary),
      prNumber,
      prState: prStates[task.id] ?? null,
      prUrl: typeof summary.prUrl === "string" ? summary.prUrl.slice(0, 2048) : null,
      attention: Boolean(summary.originError || summary.originLookupError) || summary.resolution?.attention === true || phaseNeedsAttention(summary.phase),
      held: Boolean(summary.held),
      stop: typeof summary.stop === "string" ? summary.stop : null,
    });
  }
  // The role threads of the very groups this answer names, so a caller can find a
  // task's threads by the environment the group already carries. A thread whose
  // workspace names no attached environment belongs to no group here.
  const state = source.threads();
  for (const agent of Object.values(state.agents ?? {})) {
    const environmentId = byTask.get(agent.task);
    if (!environmentId) continue;
    threads.push({ threadId: agent.id, taskId: agent.task, role: agent.role, environmentId });
  }
  return { groups, threads, projects: sidebarProjects(source.projects(), workspaces, source.liveTasks()) };
}

/**
 * Spec 062 decision 5d: each project's planner and named-agent threads, and the BB
 * projects recorded for its repositories. A BB project resolves through the
 * workspace handles Nucleus wrote: the handle's repository root, or the repository
 * of a task that records the handle. An archived handle still names its BB project:
 * archiving a task's workspace leaves the BB project in place, so its row keeps its
 * link. The project's repository paths ride along, so the plugin resolves a BB
 * project no handle names by its own local-path source.
 */
function sidebarProjects(projects: Project[], workspaces: Record<string, BbSidebarWorkspace>, tasks: Task[]): BbSidebarProject[] {
  const taskByWorkspace = new Map<string, Task>();
  for (const task of tasks) if (task.workspaceId) taskByWorkspace.set(task.workspaceId, task);
  return projects.map(project => {
    const threadIds = new Set<string>();
    if (project.planner?.agentId) threadIds.add(project.planner.agentId);
    for (const agent of project.agents ?? []) threadIds.add(agent.agentId);
    const bbProjectIds = new Set<string>();
    for (const [handle, workspace] of Object.entries(workspaces)) {
      if (!workspace.projectId) continue;
      const task = taskByWorkspace.get(handle);
      const owned = (workspace.repositoryRoot && projectHasRepository(project, workspace.repositoryRoot))
        || (task && projectHasRepository(project, task.repoPath, task.repository));
      if (owned) bbProjectIds.add(workspace.projectId);
    }
    const repositoryPaths = [...new Set(project.repositories.flatMap(repo => repo.path ? [repo.path] : []))].slice(0, 100);
    return { key: project.key, name: project.name, repositoryPaths, threadIds: [...threadIds].slice(0, 101), bbProjectIds: [...bbProjectIds].slice(0, 100) };
  });
}
