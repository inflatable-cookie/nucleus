import type { LaneView, Project, ProjectPlan } from './contracts';
import { projectLanes } from './planning-tab';
import { projectDormantByActivity, type ProjectActivity } from './project-activity';

/**
 * Spec 026 Planning read view (nucleus#1531): the words and groupings the project list,
 * the project roadmap and the lane page show. Pure, so the components and their tests
 * read one definition.
 */

export type PlanHorizon = 'now' | 'next' | 'later';
export const PLAN_HORIZONS: readonly PlanHorizon[] = ['now', 'next', 'later'];
export const horizonTitle = (horizon: PlanHorizon) => horizon[0].toUpperCase() + horizon.slice(1);
/** The one-line hint under each roadmap column. */
export const HORIZON_HINTS: Record<PlanHorizon, string> = {
  now: 'Being worked on',
  next: 'Starts when a Now lane finishes',
  later: 'Planned, not scheduled',
};

/** The list's three groups: Active, Idle on purpose (the plan's idle mark) and Dormant (the activity rule). */
export type ProjectGroup = 'active' | 'idle' | 'dormant';
export const PROJECT_GROUP_TITLES: Record<ProjectGroup, string> = { active: 'Active', idle: 'Idle on purpose', dormant: 'Dormant' };

/**
 * An idle mark is the owner's deliberate answer, so it wins over the activity rule:
 * an idle project is listed as idle however long ago its last work was.
 */
export function projectGroup(plan: Pick<ProjectPlan, 'idle'> | undefined, activity: ProjectActivity | undefined, nowMs: number): ProjectGroup {
  if (plan?.idle) return 'idle';
  return projectDormantByActivity(activity, nowMs) ? 'dormant' : 'active';
}

/** The latest recent item's time, or null when the store holds none. */
export function projectLastActivity(activity: ProjectActivity | undefined): string | null {
  return (activity?.items ?? []).reduce<string | null>((latest, item) => (!latest || item.at > latest ? item.at : latest), null);
}

/** Phases a person has to act on. */
const ATTENTION_PHASES = ['blocked', 'error', 'needs_attention'];
/** Live tasks in a lane that need someone, from the server's complete per-phase count. */
export const laneAttention = (lane: Pick<LaneView, 'liveByPhase'>) =>
  ATTENTION_PHASES.reduce((sum, phase) => sum + (lane.liveByPhase[phase] ?? 0), 0);
export const laneLive = (lane: Pick<LaneView, 'liveByPhase'>) =>
  Object.values(lane.liveByPhase).reduce((sum, count) => sum + count, 0);

/** A lane card's live work grouped into the bar's segments, in reading order. */
export type PhaseGroup = 'attention' | 'changes' | 'working' | 'review' | 'merging' | 'queued';
export const PHASE_GROUP_WORDS: Record<PhaseGroup, string> = {
  attention: 'need you',
  changes: 'changes requested',
  working: 'working',
  review: 'in review',
  merging: 'merging',
  queued: 'queued',
};
const PHASE_GROUP_OF: Record<string, PhaseGroup> = {
  blocked: 'attention', error: 'attention', needs_attention: 'attention',
  changes_requested: 'changes',
  dispatching: 'working', working: 'working',
  awaiting_review: 'review', report_ready: 'review', reviewing: 'review', verifying: 'review',
  merging: 'merging', syncing: 'merging', closing: 'merging',
  queued: 'queued',
};
const PHASE_GROUP_ORDER: readonly PhaseGroup[] = ['attention', 'changes', 'working', 'review', 'merging', 'queued'];

/** The lane's live tasks by group, largest meaning first; empty groups are left out. */
export function lanePhaseGroups(lane: Pick<LaneView, 'liveByPhase'>): Array<{ group: PhaseGroup; count: number }> {
  const counts = new Map<PhaseGroup, number>();
  for (const [phase, count] of Object.entries(lane.liveByPhase)) {
    if (!count) continue;
    const group = PHASE_GROUP_OF[phase] ?? 'working';
    counts.set(group, (counts.get(group) ?? 0) + count);
  }
  return PHASE_GROUP_ORDER.filter(group => counts.has(group)).map(group => ({ group, count: counts.get(group)! }));
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export type ProjectStatus = { attention: number; inProgress: number; live: number };

/** The counts behind a project row: tasks needing someone and live tasks across its lanes, and its Now lanes. */
export function projectStatus(project: Project, plan: Pick<ProjectPlan, 'entries'> | undefined, lanes: LaneView[]): ProjectStatus {
  const own = projectLanes(project, lanes);
  return {
    attention: own.reduce((sum, lane) => sum + laneAttention(lane), 0),
    inProgress: (plan?.entries ?? []).filter(entry => entry.horizon === 'now').length,
    live: own.reduce((sum, lane) => sum + laneLive(lane), 0),
  };
}

/**
 * A project row's one line in words: "2 need you · 3 lanes in progress · 19 tasks live",
 * "Idle · <reason>" or "No recent activity". Each part is returned apart so the row can
 * colour the attention count.
 */
export function projectStatusParts(group: ProjectGroup, plan: Pick<ProjectPlan, 'entries' | 'idle'> | undefined, status: ProjectStatus): { attention: string | null; rest: string } {
  if (group === 'idle') return { attention: null, rest: `Idle · ${plan?.idle?.reason ?? ''}` };
  if (group === 'dormant') return { attention: null, rest: 'No recent activity' };
  return {
    attention: status.attention ? `${status.attention} need you` : null,
    rest: [
      plural(status.inProgress, 'lane in progress', 'lanes in progress'),
      status.live ? plural(status.live, 'task live', 'tasks live') : 'no tasks live',
    ].join(' · '),
  };
}

export function projectStatusLine(group: ProjectGroup, plan: Pick<ProjectPlan, 'entries' | 'idle'> | undefined, status: ProjectStatus): string {
  const parts = projectStatusParts(group, plan, status);
  return [parts.attention, parts.rest].filter(Boolean).join(' · ');
}

/**
 * The roadmap's banner. The focus is the first Now lane's aim (Tom, 2026-11-22: "Just go
 * with first lane"); an idle plan shows its reason instead, and a project with no plan
 * and no activity says it is dormant.
 */
export type RoadmapBanner =
  | { kind: 'focus'; lane: string; text: string }
  | { kind: 'idle'; reason: string; at: string }
  | { kind: 'dormant' }
  | { kind: 'none' };

export function roadmapBanner(plan: Pick<ProjectPlan, 'entries' | 'idle' | 'version'> | undefined, lanes: LaneView[], group: ProjectGroup): RoadmapBanner {
  if (plan?.idle) return { kind: 'idle', reason: plan.idle.reason, at: plan.idle.at };
  const first = plan?.entries.find(entry => entry.horizon === 'now');
  if (first) {
    const lane = lanes.find(item => item.key === first.lane);
    return { kind: 'focus', lane: first.lane, text: lane?.aim || lane?.title || first.lane };
  }
  if (group === 'dormant') return { kind: 'dormant' };
  return { kind: 'none' };
}

/** "Plan updated 3h ago by the Nucleus planner": never the version number. */
export function planUpdatedLine(plan: Pick<ProjectPlan, 'author' | 'createdAt' | 'version'> | undefined, age: (at: string) => string): string {
  if (!plan?.version) return 'No plan saved yet';
  const by = plan.author ? ` by ${plan.author}` : '';
  return plan.createdAt ? `Plan updated ${age(plan.createdAt)}${by}` : `Plan saved${by}`;
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

export function lanePlanContext(laneKey: string, plans: readonly ProjectPlan[], project?: string | null): LanePlanContext | null {
  const find = (plan: ProjectPlan) => plan.entries.find(entry => entry.lane === laneKey);
  const chosen = project ? plans.find(plan => plan.project === project && find(plan)) : undefined;
  const plan = chosen ?? plans.find(find);
  const entry = plan && find(plan);
  if (!plan || !entry) return null;
  return { project: plan.project, horizon: entry.horizon, note: entry.note, doneWhen: entry.doneWhen ?? '', author: plan.author, savedAt: plan.createdAt };
}

/** A lane is open while active or paused; done and abandoned are closed. */
export const laneOpen = (lane: Pick<LaneView, 'status'>) => lane.status === 'active' || lane.status === 'paused';

/** The lane document's name: its first Markdown heading, else a plain fallback. */
export function laneDocumentName(text: string | undefined): string {
  const heading = text?.split('\n').map(line => line.trim()).find(line => /^#\s+\S/.test(line));
  return heading ? heading.replace(/^#\s+/, '') : 'Lane document';
}
