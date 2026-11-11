import type { LaneView, Project, ProjectPlan, TaskSummary, LeadListFacts } from './contracts';

export type PlanEntry = ProjectPlan['entries'][number];
/** Spec 026: the header selector chooses projects, so the tab has plan and lane columns. */
export type PlanningStep = 'plan' | 'lane';

export function planningColumns(compact: boolean, step: PlanningStep): PlanningStep[] {
  return compact ? [step] : ['plan', 'lane'];
}

export function planningPlan(latest: ProjectPlan | undefined, _saved?: ProjectPlan, laneKeys: readonly string[] = []) {
  const entries = latest?.entries ?? [];
  const planned = new Set([...entries.map(entry => entry.lane), ...(latest?.done ?? []).map(entry => entry.lane)]);
  return {
    now: entries.filter(entry => entry.horizon === 'now'),
    next: entries.filter(entry => entry.horizon === 'next'),
    later: entries.filter(entry => entry.horizon === 'later'),
    // Unplanned means a known lane with no current plan entry. A stale saved
    // membership projection can never move a planned lane into this group.
    unplanned: laneKeys.filter(key => !planned.has(key)).map(lane => ({ lane, note: '', horizon: 'later' as const })),
  };
}

export function reorderPlan(entries: PlanEntry[], lane: string, direction: -1 | 1): PlanEntry[] {
  const index = entries.findIndex(entry => entry.lane === lane);
  if (index < 0) return entries;
  const group = entries.filter(entry => entry.horizon === entries[index].horizon);
  const groupIndex = group.findIndex(entry => entry.lane === lane);
  const neighbor = group[groupIndex + direction];
  if (!neighbor) return entries;
  const result = [...entries];
  const other = result.findIndex(entry => entry.lane === neighbor.lane);
  [result[index], result[other]] = [result[other], result[index]];
  return result;
}

export function movePlan(entries: PlanEntry[], lane: string, horizon: PlanEntry['horizon']): PlanEntry[] {
  const entry = entries.find(item => item.lane === lane);
  if (!entry || entry.horizon === horizon) return entries;
  const rest = entries.filter(item => item.lane !== lane);
  const moved = { ...entry, horizon };
  if (horizon === 'later') return [...rest, moved];
  const firstLater = rest.findIndex(item => item.horizon === 'later');
  return firstLater < 0 ? [...rest, moved] : [...rest.slice(0, firstLater), moved, ...rest.slice(firstLater)];
}

/**
 * A draft of a project plan. `idle` is the change the draft makes to the idle mark: a reason sets it,
 * `null` ends the current mark, and absent leaves it as it is. A save without `idle` ends an idle plan.
 */
export type PlanDraft = { entries: PlanEntry[]; version: number; idle?: string | null };

/**
 * The `plan.set` input for a draft. `idle` is sent only when the draft sets a new mark: a changed
 * save without one ends the idle mark, so an existing mark is never renewed by saving the plan.
 */
export function planSaveInput(project: string, draft: PlanDraft, author: string) {
  return { project, version: draft.version, entries: draft.entries, ...(typeof draft.idle === 'string' ? { idle: draft.idle } : {}), author };
}

/** A draft is stale when the plan was saved past the version it was based on. The server refuses that save, so the draft waits. */
export function planDraftStale(draftVersion: number, latest: ProjectPlan | undefined): boolean {
  return Boolean(latest && latest.version > draftVersion);
}

/** The steps an idle plan may not have: anything in Now or Next. */
export function activeSteps(entries: readonly PlanEntry[]): PlanEntry[] {
  return entries.filter(entry => entry.horizon !== 'later');
}

/** Same lanes in the same order at the same horizons. Notes and completion conditions are not edited in the draft. */
export function sameOrder(a: readonly PlanEntry[], b: readonly PlanEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.lane === b[index].lane && entry.horizon === b[index].horizon);
}

/**
 * Re-bases a draft onto a newer plan without overwriting it. Steps the newer plan still has keep the
 * draft's order and horizon, with the newer note and completion condition; steps the draft does not
 * name follow in the newer plan's order. A lane the newer plan dropped leaves the draft.
 */
export function rebaseDraft(draft: readonly PlanEntry[], base: readonly PlanEntry[]): PlanEntry[] {
  const baseByLane = new Map(base.map(entry => [entry.lane, entry]));
  const named = new Set(draft.map(entry => entry.lane));
  const kept = draft.filter(entry => baseByLane.has(entry.lane)).map(entry => ({ ...baseByLane.get(entry.lane)!, horizon: entry.horizon }));
  return [...kept, ...base.filter(entry => !named.has(entry.lane))];
}

export function projectPlanningCounts(project: Project, tasks: TaskSummary[], leads: readonly LeadListFacts[]) {
  const owns = (origin: string | null | undefined, path: string) => project.repositories.some(repo =>
    origin && repo.origin ? repo.origin === origin : Boolean(path && repo.path === path));
  return {
    tasks: tasks.filter(task => !['done', 'cancelled'].includes(task.phase) && owns(task.repository, task.repoPath)).length,
    leads: leads.filter(lead => lead.state === 'open' && lead.repositories.some(repo => owns(repo.origin, repo.path))).length,
  };
}

export function projectLanes(project: Project, lanes: LaneView[]) {
  return lanes.filter(lane => (lane.repositories ?? []).some(member => (project.repositories ?? []).some(repo =>
    member.origin && repo.origin ? member.origin === repo.origin : Boolean(member.path && member.path === repo.path))));
}

export type RoadmapStep = {
  lane: string; title: string; aim: string; note: string; horizon: PlanEntry['horizon']; doneWhen: string;
  /** A `now` or `next` step without `doneWhen` saves, and the tab marks it. */
  doneWhenMissing: boolean;
  tasksDone: number; tasksLive: number; openLeads: number; lastActivityAt: string | null;
  /** Spec 041: the open drain episode; its `since` is the flag's age. */
  drained: { since: string } | null;
};
export type RoadmapDone = { lane: string; title: string; note: string; status: 'done' | 'abandoned'; closedAt: string | null };
export type Roadmap = { now: RoadmapStep[]; next: RoadmapStep[]; later: RoadmapStep[]; done: RoadmapDone[]; unplanned: RoadmapStep[] };

/** Spec 041: the plan read as a roadmap. `entries` are the pending (possibly edited) plan entries in order. */
export function roadmapView(input: { entries: PlanEntry[]; unplanned: PlanEntry[]; done?: ProjectPlan['done']; lanes: LaneView[]; leads: readonly LeadListFacts[] }): Roadmap {
  const step = (entry: PlanEntry): RoadmapStep => {
    const lane = input.lanes.find(item => item.key === entry.lane);
    return {
      lane: entry.lane, title: lane?.title ?? entry.lane, aim: lane?.aim ?? '', note: entry.note, horizon: entry.horizon, doneWhen: entry.doneWhen ?? '',
      doneWhenMissing: entry.horizon !== 'later' && !entry.doneWhen?.trim(),
      tasksDone: lane?.terminalCount ?? 0, tasksLive: lane ? Object.values(lane.liveByPhase).reduce((sum, count) => sum + count, 0) : 0,
      openLeads: input.leads.filter(lead => lead.state === 'open' && lead.lanes.includes(entry.lane)).length,
      lastActivityAt: lane?.lastActivityAt ?? null, drained: lane?.drain ? { since: lane.drain.since } : null,
    };
  };
  return {
    now: input.entries.filter(entry => entry.horizon === 'now').map(step),
    next: input.entries.filter(entry => entry.horizon === 'next').map(step),
    later: input.entries.filter(entry => entry.horizon === 'later').map(step),
    done: [...(input.done ?? [])].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .map(entry => ({ lane: entry.lane, title: input.lanes.find(lane => lane.key === entry.lane)?.title ?? entry.lane, note: entry.note, status: entry.status, closedAt: entry.closedAt })),
    unplanned: input.unplanned.map(step),
  };
}
