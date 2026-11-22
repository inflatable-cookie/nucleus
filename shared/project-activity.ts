import { z } from "zod";
import type { Project } from "./contracts";

/**
 * Spec 026 (nucleus#1446, brief v3): one activity rule for the board project selector and
 * Planning. A project is active when at least two distinct substantive work items have activity
 * less than three days old. An item is a task, or a task together with every lead linked to it,
 * so edits, checkpoints, review, completion, promotion and linked source records count once.
 * One recent item, such as a single sweep task while it runs, leaves the project Dormant. A
 * project nobody works on is Dormant until work returns, with no action to reactivate it (Tom,
 * 2026-11-22: parking is retired). Planner registration plays no part, and background bookkeeping
 * never adds an item.
 */
export const PROJECT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Distinct recent work items a project needs before it is active. */
export const PROJECT_ACTIVE_ITEM_COUNT = 2;

/** Task phases that are doing work now. A task in one of these is recent whatever its event times. */
export const EXECUTING_TASK_PHASES: readonly string[] = ["dispatching", "working", "reviewing", "verifying", "syncing", "merging", "closing"];

/** Event kinds that record observation, bookkeeping or background sweeps. They never add an item. */
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

/**
 * Task events whose detail names the lead they link to: a papercut promoted to a task, or a review
 * entry that claimed its source lead. They join the task and the lead into one item.
 */
export const LEAD_LINK_EVENT_KINDS: readonly string[] = ["papercut_linked", "papercut_source_claimed"];

/** Whether an event kind is real submission, work, lifecycle progress or completion. The store's SQL applies the same rule. */
export function isSubstantiveEventKind(kind: string): boolean {
  return !ROUTINE_EVENT_KINDS.includes(kind) && !ROUTINE_EVENT_SUFFIXES.some(suffix => kind.endsWith(suffix));
}

/** A repository as an item names it. `origin` is null for a path-only repository. */
export type ActivityRepository = { origin: string | null; path: string };

/** One work item the store found recent, or executing. Its repositories are the members' repositories. */
export type ActivityItemFact = { id: string; repositories: ActivityRepository[]; at: string; executing: boolean };

/** The persisted facts a project's activity reads, store-wide: never filtered by selection, paging or visible rows. */
export type ProjectActivityFacts = { items: ActivityItemFact[] };

export const projectActivitySchema = z.object({
  key: z.string(),
  /** The recent work items in the project, by identity. Distinct ids are counted once. */
  items: z.array(z.object({ id: z.string(), at: z.string(), executing: z.boolean() }).strict()),
}).strict();

export type ProjectActivity = z.infer<typeof projectActivitySchema>;

const owns = (project: Project, origin: string | null | undefined, path: string): boolean =>
  project.repositories.some(repo => origin && repo.origin ? repo.origin === origin : Boolean(path && repo.path === path));

/** Each project's recent items, read from the store-wide facts. A repository belongs to a project by origin when both sides know one, else by path. */
export function projectActivityRows(projects: readonly Project[], facts: ProjectActivityFacts): ProjectActivity[] {
  return projects.map(project => ({
    key: project.key,
    items: facts.items
      .filter(item => item.repositories.some(repo => owns(project, repo.origin, repo.path)))
      .map(({ id, at, executing }) => ({ id, at, executing })),
  }));
}

/** Distinct work items that count as recent at `nowMs`: executing, or activity under the three-day window. */
export function projectActiveItemCount(activity: ProjectActivity | undefined, nowMs: number): number {
  if (!activity) return 0;
  const recent = new Set<string>();
  for (const item of activity.items)
    if (item.executing || nowMs - Date.parse(item.at) < PROJECT_ACTIVITY_WINDOW_MS) recent.add(item.id);
  return recent.size;
}

/** Whether a project is active at `nowMs`: at least two distinct recent work items. */
export function projectActive(activity: ProjectActivity | undefined, nowMs: number): boolean {
  return projectActiveItemCount(activity, nowMs) >= PROJECT_ACTIVE_ITEM_COUNT;
}

/** The Dormant group: a project that is not active by the activity rule. */
export function projectDormantByActivity(activity: ProjectActivity | undefined, nowMs: number): boolean {
  return !projectActive(activity, nowMs);
}
