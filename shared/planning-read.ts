import type { LaneView, Project, ProjectPlan, TaskSummary } from "./contracts";
import { projectLanes, projectPlanningCounts } from "./planning-tab";
import { hiddenQueuedByProject } from "./queued-more";
import {
  projectDormantByActivity,
  type ProjectActivity,
} from "./project-activity";

/**
 * Spec 026 Planning read view (nucleus#1531): the words and groupings the project list,
 * the project roadmap and the lane page show. Pure, so the components and their tests
 * read one definition.
 */

export type PlanHorizon = "now" | "next" | "later";
export const PLAN_HORIZONS: readonly PlanHorizon[] = ["now", "next", "later"];
export const horizonTitle = (horizon: PlanHorizon) =>
  horizon[0].toUpperCase() + horizon.slice(1);
/** The one-line hint under each roadmap column. */
export const HORIZON_HINTS: Record<PlanHorizon, string> = {
  now: "Being worked on",
  next: "Starts when a Now lane finishes",
  later: "Planned, not scheduled",
};

/** The list's two groups: Active, and Dormant (the activity rule). */
export type ProjectGroup = "active" | "dormant";
export const PROJECT_GROUP_TITLES: Record<ProjectGroup, string> = {
  active: "Active",
  dormant: "Dormant",
};

export function projectGroup(
  activity: ProjectActivity | undefined,
  nowMs: number,
): ProjectGroup {
  return projectDormantByActivity(activity, nowMs) ? "dormant" : "active";
}

/**
 * A project row's last activity: the store-wide activity read's `lastAt` (the newest
 * task, outcome or lead in the project's own repositories, in a lane or not, with no
 * window), its recent items, its live tasks' own times, the plan's last save, and the
 * record times of the lanes listing its repositories (created, edited, closed or kept). The
 * newest wins; null when the project has none. A lane's aggregate `lastActivityAt` is never
 * read: a lane two projects share counts the other project's tasks and outcomes in it
 * (reviews 6010316003 and 6010408992). Its own record belongs to every project it lists.
 */
export function projectLastActivity(input: {
  project: Project;
  activity?: ProjectActivity;
  lanes?: readonly Pick<
    LaneView,
    "repositories" | "createdAt" | "updatedAt" | "closedAt" | "keep"
  >[];
  tasks: readonly Pick<
    TaskSummary,
    "repoPath" | "repository" | "updatedAt" | "phase"
  >[];
  plan?: Pick<ProjectPlan, "createdAt">;
}): string | null {
  const owns = (origin: string | null | undefined, path: string) =>
    input.project.repositories.some((repo) =>
      origin && repo.origin
        ? repo.origin === origin
        : Boolean(path && repo.path === path),
    );
  const times = [
    input.activity?.lastAt,
    ...(input.activity?.items ?? []).map((item) => item.at),
    ...input.tasks
      .filter((task) => owns(task.repository, task.repoPath))
      .map((task) => task.updatedAt),
    input.plan?.createdAt,
    ...projectLanes(input.project, [
      ...(input.lanes ?? []),
    ] as LaneView[]).flatMap((lane) => [
      lane.createdAt,
      lane.updatedAt,
      lane.closedAt,
      lane.keep?.at,
    ]),
  ].filter(
    (value): value is string =>
      Boolean(value) && Number.isFinite(Date.parse(value!)),
  );
  return times.reduce<string | null>(
    (latest, at) =>
      !latest || Date.parse(at) > Date.parse(latest) ? at : latest,
    null,
  );
}

/** Phases a person has to act on. */
const ATTENTION_PHASES: readonly string[] = [
  "blocked",
  "error",
  "needs_attention",
];
/** Live tasks in a lane that need someone, from the server's complete per-phase count. */
export const laneAttention = (lane: Pick<LaneView, "liveByPhase" | "attentionCount">) =>
  lane.attentionCount ?? ATTENTION_PHASES.reduce(
    (sum, phase) => sum + (lane.liveByPhase[phase] ?? 0),
    0,
  );
export const laneLive = (lane: Pick<LaneView, "liveByPhase">) =>
  Object.values(lane.liveByPhase).reduce((sum, count) => sum + count, 0);

/** A lane card's live work grouped into the bar's segments, in reading order. */
export type PhaseGroup =
  | "attention"
  | "changes"
  | "working"
  | "review"
  | "merging"
  | "queued";
export const PHASE_GROUP_WORDS: Record<PhaseGroup, string> = {
  attention: "need you",
  changes: "changes requested",
  working: "working",
  review: "in review",
  merging: "merging",
  queued: "queued",
};
const PHASE_GROUP_OF: Record<string, PhaseGroup> = {
  blocked: "attention",
  error: "attention",
  needs_attention: "attention",
  changes_requested: "changes",
  dispatching: "working",
  working: "working",
  awaiting_review: "review",
  report_ready: "review",
  reviewing: "review",
  verifying: "review",
  merging: "merging",
  syncing: "merging",
  closing: "merging",
  queued: "queued",
};
const PHASE_GROUP_ORDER: readonly PhaseGroup[] = [
  "attention",
  "changes",
  "working",
  "review",
  "merging",
  "queued",
];

/** The lane's live tasks by group, largest meaning first; empty groups are left out. */
export function lanePhaseGroups(
  lane: Pick<LaneView, "liveByPhase">,
): Array<{ group: PhaseGroup; count: number }> {
  const counts = new Map<PhaseGroup, number>();
  for (const [phase, count] of Object.entries(lane.liveByPhase)) {
    if (!count) continue;
    const group = PHASE_GROUP_OF[phase] ?? "working";
    counts.set(group, (counts.get(group) ?? 0) + count);
  }
  return PHASE_GROUP_ORDER.filter((group) => counts.has(group)).map(
    (group) => ({ group, count: counts.get(group)! }),
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export type ProjectStatus = {
  attention: number;
  inProgress: number;
  live: number;
};

/**
 * The counts behind a project row. Live tasks follow the project selector's rule: each live
 * task in one of the project's repositories counts once however many lanes it is in (Spec
 * 019), plus the queued tasks the board holds back. "Need you" is the distinct live tasks
 * that are blocked, in error or need attention; the board never holds those back. Lanes in
 * progress are the plan's Now lanes.
 */
export function projectStatus(input: {
  project: Project;
  plan?: Pick<ProjectPlan, "entries">;
  tasks: TaskSummary[];
  queuedCounts?: readonly { repoPath: string; count: number }[];
}): ProjectStatus {
  const { project, tasks } = input;
  const owns = (origin: string | null | undefined, path: string) =>
    project.repositories.some((repo) =>
      origin && repo.origin
        ? repo.origin === origin
        : Boolean(path && repo.path === path),
    );
  const hidden = hiddenQueuedByProject(input.queuedCounts ?? [], tasks)
    .filter((item) =>
      project.repositories.some((repo) => repo.path === item.repoPath),
    )
    .reduce((sum, item) => sum + item.hidden, 0);
  return {
    attention: new Set(
      tasks
        .filter(
          (task) =>
            ATTENTION_PHASES.includes(task.phase) &&
            owns(task.repository, task.repoPath),
        )
        .map((task) => task.id),
    ).size,
    inProgress: (input.plan?.entries ?? []).filter(
      (entry) => entry.horizon === "now",
    ).length,
    live: projectPlanningCounts(project, tasks, []).tasks + hidden,
  };
}

/**
 * A project row's one line in words: "2 need you · 3 lanes in progress · 19 tasks live"
 * or "No recent activity". Each part is returned apart so the row can colour the
 * attention count.
 */
export function projectStatusParts(
  group: ProjectGroup,
  status: ProjectStatus,
): { attention: string | null; rest: string } {
  if (group === "dormant")
    return { attention: null, rest: "No recent activity" };
  return {
    attention: status.attention ? `${status.attention} need you` : null,
    rest: [
      plural(status.inProgress, "lane in progress", "lanes in progress"),
      status.live
        ? plural(status.live, "task live", "tasks live")
        : "no tasks live",
    ].join(" · "),
  };
}

export function projectStatusLine(
  group: ProjectGroup,
  status: ProjectStatus,
): string {
  const parts = projectStatusParts(group, status);
  return [parts.attention, parts.rest].filter(Boolean).join(" · ");
}

/**
 * The roadmap's banner. The focus is the first Now lane's aim (Tom, 2026-11-22: "Just go
 * with first lane"); a project with no Now lane and no activity says it is dormant.
 */
export type RoadmapBanner =
  | { kind: "focus"; lane: string; text: string }
  | { kind: "dormant" }
  | { kind: "none" };

export function roadmapBanner(
  plan: Pick<ProjectPlan, "entries"> | undefined,
  lanes: LaneView[],
  group: ProjectGroup,
): RoadmapBanner {
  const first = plan?.entries.find((entry) => entry.horizon === "now");
  if (first) {
    const lane = lanes.find((item) => item.key === first.lane);
    return {
      kind: "focus",
      lane: first.lane,
      text: lane?.aim || lane?.title || first.lane,
    };
  }
  if (group === "dormant") return { kind: "dormant" };
  return { kind: "none" };
}

/** "Plan updated 3h ago by the Nucleus planner": never the version number. */
export function planUpdatedLine(
  plan: Pick<ProjectPlan, "author" | "createdAt" | "version"> | undefined,
  age: (at: string) => string,
): string {
  if (!plan?.version) return "No plan saved yet";
  const by = plan.author ? ` by ${plan.author}` : "";
  return plan.createdAt
    ? `Plan updated ${age(plan.createdAt)}${by}`
    : `Plan saved${by}`;
}

/**
 * The open lane's place in one project's plan: its horizon, the entry's note and
 * completion condition, and who saved the plan and when. `project` is the plan the lane
 * was opened from; when that plan does not list it, the first plan that does stands in.
 */
export type LanePlanContext = {
  project: string;
  horizon: PlanHorizon;
  note: string;
  doneWhen: string;
  author: string | null;
  savedAt: string | null;
};

export function lanePlanContext(
  laneKey: string,
  plans: readonly ProjectPlan[],
  project?: string | null,
): LanePlanContext | null {
  const find = (plan: ProjectPlan) =>
    plan.entries.find((entry) => entry.lane === laneKey);
  const chosen = project
    ? plans.find((plan) => plan.project === project && find(plan))
    : undefined;
  const plan = chosen ?? plans.find(find);
  const entry = plan && find(plan);
  if (!plan || !entry) return null;
  return {
    project: plan.project,
    horizon: entry.horizon,
    note: entry.note,
    doneWhen: entry.doneWhen ?? "",
    author: plan.author,
    savedAt: plan.createdAt,
  };
}

/** A lane is open while active or paused; done and abandoned are closed. */
export const laneOpen = (lane: Pick<LaneView, "status">) =>
  lane.status === "active" || lane.status === "paused";

/** The lane document's name: its first Markdown heading, else a plain fallback. */
export function laneDocumentName(text: string | undefined): string {
  const heading = text
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => /^#\s+\S/.test(line));
  return heading ? heading.replace(/^#\s+/, "") : "Lane document";
}
