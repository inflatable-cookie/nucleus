import { z } from "zod";
import type { Project } from "./contracts";

/**
 * Spec 026 (nucleus#1446): one activity rule for the board project selector and the
 * Planning tab. A project is active while task work is executing, or while its latest
 * substantive activity is less than five days old. Parked projects are never dormant:
 * they keep their own Parked group. Planner registration plays no part; it routes
 * questions and never keeps a project active.
 */
export const PROJECT_ACTIVITY_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/** Task phases that are doing work now: a worker, reviewer, verifier, merger or closeout holds the task. */
export const EXECUTING_TASK_PHASES: readonly string[] = ["dispatching", "working", "reviewing", "verifying", "syncing", "merging", "closing"];

/** Event kinds that record observation, bookkeeping or background sweeps. They never refresh project activity. */
export const ROUTINE_EVENT_KINDS: readonly string[] = [
  "agent_state", "telemetry_stage", "phase_latency", "prompt_size",
  "pre_merge_candidate_build_duration", "pre_merge_hook_duration", "check_policy_observation",
  "initial_pr_lookup", "initial_pr_lookup_empty", "initial_pr_lookup_unavailable",
  "runtime_scope_captured", "load_guard_skipped",
  "callback_reminder", "callback_reminder_extended", "callback_reminder_skipped",
  "project_planner_set", "project_planner_cleared", "project_agent_registered", "project_agent_unregistered", "project_owner_retired",
];

/** Suffixes of routine kinds: routine observations, reconciliations, supersessions, expiries, deferrals and skips. */
export const ROUTINE_EVENT_SUFFIXES: readonly string[] = ["_observed", "_observe_failed", "_reconciled", "_superseded", "_expired", "_deferred", "_skipped"];

/** Whether an event kind is real submission, work, lifecycle progress or completion. The store's SQL applies the same rule. */
export function isSubstantiveEventKind(kind: string): boolean {
  return !ROUTINE_EVENT_KINDS.includes(kind) && !ROUTINE_EVENT_SUFFIXES.some(suffix => kind.endsWith(suffix));
}

/** One repository's newest substantive time, as the store reads it. `origin` is null for a path-only repository. */
export type RepositoryActivityFact = { origin: string | null; path: string; at: string };

/** The persisted facts a project's activity reads, store-wide: never filtered by selection, paging or visible rows. */
export type ProjectActivityFacts = {
  /** Submissions, work, completions and planning records (leads, papercuts), by repository. */
  repositories: RepositoryActivityFact[];
  /** Deliberate plan versions, by project key. */
  plans: Array<{ project: string; at: string }>;
  /** Live tasks in an executing phase, by repository. */
  executing: Array<{ origin: string | null; path: string }>;
};

export const projectActivitySchema = z.object({
  key: z.string(),
  executing: z.boolean(),
  /** The newest substantive activity, or null for a project that has never had any. */
  activityAt: z.string().nullable(),
}).strict();

export type ProjectActivity = z.infer<typeof projectActivitySchema>;

const owns = (project: Project, origin: string | null | undefined, path: string): boolean =>
  project.repositories.some(repo => origin && repo.origin ? repo.origin === origin : Boolean(path && repo.path === path));

/** Each project's activity read from the store-wide facts. A repository belongs to a project by origin when both sides know one, else by path. */
export function projectActivityRows(projects: readonly Project[], facts: ProjectActivityFacts): ProjectActivity[] {
  return projects.map(project => {
    let activityAt: string | null = null;
    const note = (at: string) => { if (!activityAt || at > activityAt) activityAt = at; };
    for (const fact of facts.repositories) if (owns(project, fact.origin, fact.path)) note(fact.at);
    for (const plan of facts.plans) if (plan.project === project.key) note(plan.at);
    const executing = facts.executing.some(task => owns(project, task.origin, task.path));
    return { key: project.key, executing, activityAt };
  });
}

/** Whether a project is active at `nowMs`: executing work, or substantive activity under the five-day window. */
export function projectActive(activity: ProjectActivity | undefined, nowMs: number): boolean {
  if (!activity) return false;
  if (activity.executing) return true;
  return activity.activityAt !== null && nowMs - Date.parse(activity.activityAt) < PROJECT_ACTIVITY_WINDOW_MS;
}

/** The Dormant group: a project that is neither parked nor active. Parked projects are never dormant. */
export function projectDormantByActivity(project: Pick<Project, "key" | "visibility">, activity: ProjectActivity | undefined, nowMs: number): boolean {
  return project.visibility !== "parked" && !projectActive(activity, nowMs);
}
