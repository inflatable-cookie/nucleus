import { git } from "../git/index";
import { normalizeRepositoryOrigin, laneListsRepository } from "../../shared/lanes";
import type { Lane, LaneDrain, LaneView, Outcome, Task } from "../../shared/contracts";
import { laneViewSchema , OPERATOR_IDENTITIES } from "../../shared/contracts";

export async function repositoryOrigin(repoPath: string): Promise<string | null> {
  try { return normalizeRepositoryOrigin(await git(repoPath, "remote", "get-url", "origin")); }
  catch { return null; }
}

export function attachableLane(lane: Lane | null, key: string, repoPath: string, origin?: string | null): Lane {
  if (!lane) throw new Error(`Unknown lane key ${key}; create it with lane.upsert before attaching a task`);
  if (lane.status === "done" || lane.status === "abandoned") throw new Error(`Lane ${key} is ${lane.status} and cannot accept tasks`);
  if (!laneListsRepository(lane.repositories, repoPath, origin)) throw new Error(`Lane ${key} does not list this repository`);
  return lane;
}

export function laneSnapshot(lanes: Lane[]): { lanes: string[]; laneContext: Array<{ key: string; title: string; aim: string }> } {
  return {
    lanes: lanes.map(lane => lane.key),
    laneContext: lanes.map(lane => ({ key: lane.key, title: lane.title, aim: lane.aim })),
  };
}

/** Papercut, lead and draft activity in one lane; `open` counts the records that keep it from closing. */
export type LaneRecordActivity = { at: string | null; open: number };
/** Spec 019 revision (2026-09-27): an open lane this long without activity closes itself. */
export const LANE_IDLE_CLOSE_MS = 14 * 86400000;
export const LANE_IDLE_CLOSE_NOTE = "Closed automatically after 14 days idle";

/** The keys of active lanes with no live task, no open record and no activity inside the idle window. */
export function idleLaneKeys(views: LaneView[], records: Map<string, LaneRecordActivity>, at: number): string[] {
  const cutoff = new Date(at - LANE_IDLE_CLOSE_MS).toISOString();
  return views.filter(lane => lane.status === "active"
    && !Object.values(lane.liveByPhase).some(Boolean)
    && !records.get(lane.key)?.open
    && (lane.lastActivityAt ?? "") < cutoff).map(lane => lane.key);
}

const LIVE = (task: Task) => !["done", "cancelled"].includes(task.phase) && !task.removedAt;

/** Spec 041, recipient renamed by Spec 058 cutover 5: the drain prompts name the project's planner. The operator's own identity escalates instead. */
export const OPERATOR_PLAN_OWNERS = OPERATOR_IDENTITIES;
/** A recipient Queue cannot name — empty or missing — escalates with no prompt, like the operator's own plan. */
export const escalatesWithoutPrompt = (owner: string) => !owner.trim() || OPERATOR_PLAN_OWNERS.has(owner);

export type LaneDrainInput = {
  key: string; title: string; aim: string;
  drain: LaneDrain | null; status: Lane["status"]; lastActivityAt: string;
  /** When the owner last kept the lane; a kept lane drains again only after later activity. */
  keptAt?: string | null;
  liveTasks: number; openLeads: number;
  /** Present only while the lane sits in its project's plan; leaving the plan ends an episode. */
  plan: { project: string; projectName: string; owner: string; doneWhen: string } | null;
  outcomes: Array<{ title: string; outcome: string; prNumber: number | null; finishedAt: string | null }>;
};
export type ProjectDrainInput = {
  key: string; name: string;
  drain: LaneDrain | null;
  liveTasks: number;
  /** Queued or running milestone QA in any repository belonging to this project. */
  activeQaRuns?: number;
  /** Latest finish of any of the project's tasks: a board drains when work finishes, not by being idle. */
  lastFinishedAt: string | null;
  /** Latest finish eligible to end an explicit idle mark. */
  idleSubmittedFinishedAt?: string | null;
  /** When the owner marked the board idle on purpose, or null. */
  idleSince?: string | null;
  topNow: { lane: string; title: string; aim: string; doneWhen: string; documentVersion: number } | null;
  firstNext: { lane: string; title: string; aim: string } | null;
  openLeads: Array<{ id: string; title: string }>;
  owner: string;
};
export type DrainNotice = { id: string; taskId: string; agentId: string; kind: "lane_drain" | "next_aim"; text: string };
export type DrainEvaluation = {
  lanes: Record<string, LaneDrain | null>;
  projects: Record<string, LaneDrain | null>;
  notices: DrainNotice[];
};

const laneDrainNoticeText = (input: LaneDrainInput, owner: string) => {
  const finished = input.outcomes.length
    ? input.outcomes.map(outcome => `- ${outcome.title} — ${outcome.outcome}${outcome.prNumber ? ` (PR #${outcome.prNumber})` : ""}${outcome.finishedAt ? `, ${outcome.finishedAt}` : ""}`).join("\n")
    : "- none recorded";
  return ["Nucleus: a lane in the plan has drained",
    `Lane: ${input.title} (${input.key})`,
    `Plan: ${input.plan!.projectName} (planner ${owner})`,
    `Aim: ${input.aim}`, `Done when: ${input.plan!.doneWhen || "not set"}`, `Last activity: ${input.lastActivityAt}`,
    `Finished in this lane:\n${finished}`,
    "Choose one: close the lane (lane.status done), brief more tasks toward its aim, or keep it with lane.keep and a reason.",
    "Nucleus asks the operator if the lane stays unanswered."].join("\n");
};
const nextAimNoticeText = (input: ProjectDrainInput, owner: string) => {
  const step = input.topNow
    ? [`Top now step: ${input.topNow.title} (${input.topNow.lane})`, `Aim: ${input.topNow.aim}`, `Done when: ${input.topNow.doneWhen || "not set"}`, `Lane document: version ${input.topNow.documentVersion}`,
       `Open leads: ${input.openLeads.length ? input.openLeads.map(lead => `${lead.title} (${lead.id})`).join(", ") : "none"}`]
    : ["Top now step: none"];
  return ["Nucleus: the project's board is drained",
    `Project: ${input.name} (${input.key})`, `Planner: ${owner}`, ...step,
    `First next step: ${input.firstNext ? `${input.firstNext.title} (${input.firstNext.lane}) — ${input.firstNext.aim}` : "none"}`,
    input.topNow
      ? "Choose one: brief tasks toward the step, move the first next step to now (plan.set), or close the step with lane.status if it is finished."
      : "The plan has no now or next step: save a plan (plan.set) that says what to aim at.",
    "Nucleus asks the operator if the board stays drained without an answer."].join("\n");
};

/**
 * Spec 041: one pass of lane close-out and next-aim detection. Pure: the store
 * gathers the inputs and applies the returned episodes and notices. A drained
 * lane prompts its project's planner once per episode and escalates to the operator
 * after the escalation timer; an operator-owned plan escalates straight away
 * with no prompt, and so does a recipient Queue cannot name. A drained board
 * prompts the planner with the plan's next aim on the same rules. New work, a
 * keep, a close, or leaving the plan ends an episode.
 */
export function evaluateDrains(
  lanes: LaneDrainInput[], projects: ProjectDrainInput[],
  settings: { drainMinutes: number; escalationMinutes: number }, at: number,
): DrainEvaluation {
  const at_ = new Date(at).toISOString();
  const result: DrainEvaluation = { lanes: {}, projects: {}, notices: [] };
  const escalate = (since: string) => at - Date.parse(since) >= settings.escalationMinutes * 60_000 ? at_ : null;
  for (const input of lanes) {
    // Drained: active, in a plan, no unfinished task, no open lead, and nothing attached has changed for the drain time.
    const drained = input.status === "active" && input.liveTasks === 0 && input.openLeads === 0 && input.plan !== null
      && at - Date.parse(input.lastActivityAt) >= settings.drainMinutes * 60_000
      // A keep answers the drain until something attached to the lane changes after it; without
      // this the keep itself was the last activity and the lane re-prompted every drain period.
      && !(input.keptAt && Date.parse(input.lastActivityAt) <= Date.parse(input.keptAt));
    if (!drained) { if (input.drain) result.lanes[input.key] = null; continue; }
    const owner = input.plan!.owner;
    const operatorOwned = escalatesWithoutPrompt(owner);
    let drain = input.drain;
    if (!drain) {
      drain = operatorOwned
        ? { since: at_, notices: 0, lastNoticeAt: null, escalatedAt: at_ }
        : { since: at_, notices: 1, lastNoticeAt: at_, escalatedAt: null };
    } else if (!drain.escalatedAt && escalate(drain.since)) drain = { ...drain, escalatedAt: at_ };
    // Build current text for each open prompted episode; the store refreshes
    // only its still-pending durable notice before delivery intent.
    if (!operatorOwned && drain.notices > 0) result.notices.push({ id: `lane-drain:${input.key}:${drain.since}`, taskId: `lane:${input.key}`, agentId: owner, kind: "lane_drain", text: laneDrainNoticeText(input, owner) });
    if (drain !== input.drain) result.lanes[input.key] = drain;
  }
  for (const input of projects) {
    // The episode's `lane` is the top `now` step when it began; a different top step means the plan moved on.
    const episode = input.drain;
    const answered = episode !== null && (episode.lane ?? null) !== (input.topNow?.lane ?? null);
    // A board drains when its last work finishes. A project idle since before the window
    // never starts an episode, and one started without a recent finish ends: at go-live
    // every dormant project fired a next-aim at its importer (23 to Northstar, 2026-10-03).
    const finished = input.lastFinishedAt ? Date.parse(input.lastFinishedAt) : Number.NaN;
    const reference = episode ? Date.parse(episode.since) : at;
    const drainedByFinish = Number.isFinite(finished) && reference - finished <= settings.escalationMinutes * 60_000;
    // The planner's idle acknowledgement answers the drained board until eligible
    // work finishes after it. Unrelated submissions may still count for normal drains.
    const eligibleFinishedAt = input.idleSubmittedFinishedAt === undefined ? input.lastFinishedAt : input.idleSubmittedFinishedAt;
    const eligibleFinished = eligibleFinishedAt ? Date.parse(eligibleFinishedAt) : Number.NaN;
    const idle = Boolean(input.idleSince) && !(Number.isFinite(eligibleFinished) && eligibleFinished > Date.parse(input.idleSince!));
    if (input.liveTasks > 0 || (input.activeQaRuns ?? 0) > 0 || answered || idle || !drainedByFinish) { if (episode) result.projects[input.key] = null; continue; }
    const operatorOwned = escalatesWithoutPrompt(input.owner);
    // A drained board is not an operator decision (Tom, 2026-10-15): the episode prompts
    // the planner and shows on the Planning tab, and never escalates.
    const drain = input.drain ?? (operatorOwned
      ? { since: at_, ...(input.topNow ? { lane: input.topNow.lane } : {}), notices: 0, lastNoticeAt: null, escalatedAt: null }
      : { since: at_, ...(input.topNow ? { lane: input.topNow.lane } : {}), notices: 1, lastNoticeAt: at_, escalatedAt: null });
    if (!operatorOwned && drain.notices > 0) result.notices.push({ id: `next-aim:${input.key}:${drain.since}`, taskId: `project:${input.key}`, agentId: input.owner, kind: "next_aim", text: nextAimNoticeText(input, input.owner) });
    if (drain !== input.drain) result.projects[input.key] = drain;
  }
  return result;
}

/**
 * Spec 019: one outcome-by-lane index built in a single pass, so a board with hundreds of
 * lanes never rescans every permanent outcome once per lane (audit A1: 240 lanes over 6,792
 * outcomes cost 31 ms of every rebuild). Each lane's list keeps the read order `buildLaneViews`
 * used before: newest `finishedAt` first, and equal times in outcome row order.
 */
export function indexOutcomesByLane(outcomes: Outcome[]): Map<string, Outcome[]> {
  const index = new Map<string, Outcome[]>();
  for (const outcome of outcomes) addOutcomeToLaneIndex(index, outcome);
  return index;
}
/** Appends one permanent outcome to the index, keeping a lane's list in newest-first order. */
export function addOutcomeToLaneIndex(index: Map<string, Outcome[]>, outcome: Outcome): void {
  for (const lane of new Set(outcome.lanes)) {
    const list = index.get(lane) ?? [];
    const finishedAt = outcome.finishedAt ?? "";
    let low = 0, high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      // Descending, and after any equal time, so the index keeps the stable read order.
      if ((list[middle].finishedAt ?? "").localeCompare(finishedAt) >= 0) low = middle + 1; else high = middle;
    }
    list.splice(low, 0, outcome);
    index.set(lane, list);
  }
}
/** Live tasks attached to each lane, indexed once per build instead of filtered per lane. */
function indexLiveTasksByLane(tasks: Task[]): Map<string, Task[]> {
  const index = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!LIVE(task)) continue;
    for (const lane of new Set(task.lanes)) {
      const list = index.get(lane);
      if (list) list.push(task); else index.set(lane, [task]);
    }
  }
  return index;
}
/** The lane a query selects: status and repository membership are the only lane-view filters. */
export function laneViewMatches(lane: Pick<Lane, "status" | "repositories">, query: { status?: Lane["status"]; repository?: string } = {}): boolean {
  if (query.status && lane.status !== query.status) return false;
  const repository = query.repository;
  if (!repository) return true;
  const repositoryOrigin = normalizeRepositoryOrigin(repository);
  return lane.repositories.some(repo => repo.path === repository || repo.origin === repository || (repositoryOrigin && repo.origin === repositoryOrigin));
}

export function buildLaneViews(
  lanes: Lane[],
  liveTasks: Task[],
  outcomesByLane: Map<string, Outcome[]>,
  lastEventAt: Map<string, string>,
  records: Map<string, LaneRecordActivity> = new Map(),
  query: { status?: Lane["status"]; repository?: string } = {},
): LaneView[] {
  const liveByLane = indexLiveTasksByLane(liveTasks);
  return lanes
    .filter(lane => laneViewMatches(lane, query))
    .map(lane => {
      const attached = liveByLane.get(lane.key) ?? [];
      const liveByPhase: Record<string, number> = {};
      const liveByRepository: Record<string, number> = {};
      for (const task of attached) {
        liveByPhase[task.phase] = (liveByPhase[task.phase] ?? 0) + 1;
        liveByRepository[task.repoPath] = (liveByRepository[task.repoPath] ?? 0) + 1;
      }
      const history = outcomesByLane.get(lane.key) ?? [];
      const activity = [
        lane.updatedAt,
        ...attached.map(task => lastEventAt.get(task.id) ?? task.updatedAt),
        ...history.map(outcome => outcome.finishedAt).filter((value): value is string => Boolean(value)),
        ...[records.get(lane.key)?.at].filter((value): value is string => Boolean(value)),
      ].sort().at(-1) ?? null;
      return laneViewSchema.parse({
        ...lane,
        liveByPhase,
        liveByRepository,
        terminalCount: history.length,
        lastActivityAt: activity,
        recentOutcomes: history.slice(0, 10).map(outcome => ({
          taskId: outcome.taskId, title: outcome.title, outcome: outcome.outcome,
          prUrl: outcome.pr?.url ?? null, prNumber: outcome.pr?.number ?? null, finishedAt: outcome.finishedAt,
        })),
      });
    })
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.title.localeCompare(b.title));
}
