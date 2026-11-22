/**
 * Spec 053: demand-based profile selection. Each run's demand is a capability
 * bracket: the task's complexity moved by the usage level and, for a worker,
 * the one step-up; selection takes the available profiles at that bracket and
 * rotates among them by each profile's weight share (Spec 053, Tom 2026-11-21). There are no role offsets (Tom, 2026-11-19): the reviewer's
 * bracket follows the usage level and the coordinator runs on Mechanical.
 * This module is the formula, shared by selection (core/dispatch/routing.ts)
 * and the board's preview.
 */
import { weightShare, type CapabilityLevel, type DemandLevel, type PoolEntry, type ProfileCapability, type ProfileWeight, type UsageLevel } from "./contracts";
import { CAPABILITY_LEVELS, DEMAND_LEVELS, USAGE_LABELS, capabilityRank, demandRank, requestOnly } from "./pool";
import { taskAuthorModelKeys } from "./authors";

export type DemandRole = "worker" | "reviewer" | "coordinator";
/**
 * Spec 053 Decision 4 (Tom, 2026-10-21: "Require it"): a new submission names its
 * complexity, which sets how capable a model each of its runs needs.
 */
export const COMPLEXITY_REQUIRED = "queue.complexity is required: very_low, low, medium, high or very_high. It sets how capable a model each run of the task needs (Spec 053)";
export function complexityRefusal(submission: { complexity?: CapabilityLevel | null }): string | null {
  return submission.complexity ? null : COMPLEXITY_REQUIRED;
}

const bracket = (rank: number): DemandLevel => DEMAND_LEVELS[Math.max(0, Math.min(DEMAND_LEVELS.length - 1, rank))];

/**
 * The task's own bracket (Tom, 2026-11-19): very-low and low complexity are
 * Mechanical, medium and high are Worker, very high is Heavyweight. Unset reads
 * as medium. Deciders run here (nucleus#1362).
 */
export function complexityBracket(complexity: CapabilityLevel | null | undefined): DemandLevel {
  switch (complexity ?? "medium") {
    case "very_low": case "low": return "mechanical";
    case "medium": case "high": return "worker";
    case "very_high": return "heavyweight";
  }
}

/**
 * The bracket a task may climb to (Tom, 2026-11-19): its own bracket, one
 * above for high and very-high complexity. The step-up decides the difference:
 * a medium task stays on Worker, a high task may climb once to Heavyweight and
 * a very-high one to Frontier when the usage level allows automatic selection there.
 */
export function requestedTier(complexity: CapabilityLevel | null | undefined): DemandLevel {
  const own = demandRank(complexityBracket(complexity));
  return bracket(complexity === "high" || complexity === "very_high" ? own + 1 : own);
}

/**
 * Where a task's worker starts at each usage level, in whole brackets (Tom,
 * 2026-11-19). Low starts every task one bracket below the one it may climb to;
 * Normal starts it on its own bracket; High and Extra high start it at the
 * bracket it may climb to, up to Heavyweight; Maximum puts workers and
 * reviewers on Heavyweight or Frontier whatever the complexity.
 */
export function workerStartTier(usage: UsageLevel, complexity: CapabilityLevel | null | undefined): DemandLevel {
  const requested = demandRank(requestedTier(complexity));
  switch (usage) {
    case "low": return bracket(requested - 1);
    case "normal": return complexityBracket(complexity);
    case "high": case "extra_high": return bracket(Math.min(requested, demandRank("heavyweight")));
    case "maximum": return "heavyweight";
  }
}

/** Whether the reviewer runs one bracket below the worker at this level (Tom, 2026-11-19: Low and Normal). */
export const reviewerBelowWorker = (usage: UsageLevel): boolean => usage === "low" || usage === "normal";

/**
 * One run's demand before any worker ran: the worker starts at the level's
 * bracket, the reviewer one bracket below it at Low and Normal and on it
 * above, and the coordinator always on Mechanical (Tom, 2026-11-19:
 * "Coordinator should always be mechanical if available").
 */
export function runDemand(complexity: CapabilityLevel | null | undefined, role: DemandRole, usage: UsageLevel): DemandLevel {
  if (role === "coordinator") return "mechanical";
  const start = demandRank(workerStartTier(usage, complexity));
  return bracket(role === "reviewer" && reviewerBelowWorker(usage) ? start - 1 : start);
}

/**
 * The reviewer's demand (Tom, 2026-11-19): one bracket below the worker's
 * actual profile (or its start bracket before a worker ran) at Low and Normal,
 * the worker's bracket at High, Extra high and Maximum. A Mechanical worker
 * gets a Mechanical reviewer. Only a critical task floors it at the worker's
 * bracket, as its brief asks for a reviewer at least as capable as the worker.
 */
export function reviewerDemand(task: { complexity?: CapabilityLevel | null; critical?: boolean | null; profile?: { id?: string; [key: string]: unknown } | null },
  pool: readonly Pick<PoolEntry, "profileId" | "capability">[], usage: UsageLevel): DemandLevel {
  const worker = demandRank(workerActualTier(task, pool) ?? workerStartTier(usage, task.complexity));
  const moved = reviewerBelowWorker(usage) ? worker - 1 : worker;
  return bracket(task.critical ? Math.max(moved, worker) : moved);
}

/**
 * The worker's actual bracket from the profile it selected (an unrated entry
 * counts as Worker). Reviewer selection floors against this actual rating, not
 * the calculated demand: a run that rotated onto a stronger profile is reviewed
 * by at least that capability (Tom, 2026-11-17).
 */
export function workerActualTier(task: { profile?: { id?: string; [key: string]: unknown } | null },
  pool: readonly Pick<PoolEntry, "profileId" | "capability">[]): DemandLevel | null {
  const profileId = task.profile?.id;
  if (!profileId) return null;
  const entry = pool.find(item => item.profileId === profileId);
  return entry ? DEMAND_LEVELS[profileRank(entry.capability)] : null;
}

function automaticClimbCeiling(requested: DemandLevel, usage: UsageLevel): DemandLevel {
  return requested === "frontier" && requestOnly({ capability: "frontier" }, usage)
    ? "heavyweight"
    : requested;
}

/**
 * The one climb an applied changes-required review authorizes (Tom,
 * 2026-11-17): the next worker run moves one tier above the worker's actual
 * tier, capped at the task's requested tier. The applied review outcome —
 * never the phase alone — authorizes it, and a recorded climb for the same
 * review run authorizes no second one.
 */
export function workerClimbTarget(task: {
  complexity?: CapabilityLevel | null;
  profile?: { id?: string; [key: string]: unknown } | null;
  resolution?: { review?: { status: string; runId: string } | null; workerClimb?: { reviewRunId: string } | null; [key: string]: unknown } | null;
}, pool: readonly Pick<PoolEntry, "profileId" | "capability">[], usage: UsageLevel): { from: DemandLevel; to: DemandLevel; reviewRunId: string } | null {
  const review = task.resolution?.review;
  if (!review || review.status !== "changes_required") return null;
  if (task.resolution?.workerClimb?.reviewRunId === review.runId) return null;
  const requested = requestedTier(task.complexity);
  const ceiling = automaticClimbCeiling(requested, usage);
  const start = workerStartTier(usage, task.complexity);
  // The step-up exists because the level started the task below the bracket it
  // may climb to. A task the level starts there (a medium task, or a high task
  // at High) does not climb.
  if (demandRank(start) >= demandRank(requested)) return null;
  // One step from the tier the worker actually ran on: a first run that used
  // the shortfall path must climb to the missing intermediate tier, never skip
  // it (Tom, 2026-11-17).
  const from = workerActualTier(task, pool) ?? start;
  const target = Math.min(demandRank(from) + 1, demandRank(ceiling));
  if (target <= demandRank(from)) return null;
  return { from, to: DEMAND_LEVELS[target], reviewRunId: review.runId };
}

/**
 * The tier a recorded climb earned: the permission exception belongs to the run
 * that climbs back to the task's requested tier, and never to a first attempt
 * before any climb (Tom, 2026-11-17). Null once the requested tier moved below
 * the recorded climb.
 */
export function climbedTier(task: { complexity?: CapabilityLevel | null;
  resolution?: { workerClimb?: { to: ProfileCapability } | null; [key: string]: unknown } | null }): DemandLevel | null {
  const to = task.resolution?.workerClimb?.to;
  if (!to) return null;
  return demandRank(to) <= demandRank(requestedTier(task.complexity)) ? to : null;
}

/**
 * The highest bracket automatic selection may reach at this level: Frontier at
 * Maximum (which runs workers and reviewers on Heavyweight or Frontier
 * regardless of complexity), the bracket the task may climb to otherwise. Going above the
 * requested tier is an explicit planner or operator route (Tom, 2026-11-17).
 */
export function usageCeiling(usage: UsageLevel, requested: DemandLevel): DemandLevel {
  return usage === "maximum" ? "frontier" : requested;
}

/**
 * One step back up toward the task's requested tier, capped there (Tom,
 * 2026-11-17). A review asking for changes on a task that started below its
 * requested tier gives the next worker run one tier more; it never climbs past
 * the requested tier, which is an explicit planner or operator route.
 */
export function workerStepUp(demand: DemandLevel, requested: DemandLevel): DemandLevel {
  const rank = demandRank(demand);
  return rank >= demandRank(requested) ? demand : DEMAND_LEVELS[rank + 1];
}

/** A worker's first run takes the level's start tier; a run after review changes climbs one. */
export function workerStepApplies(reviewed: boolean): boolean {
  return reviewed;
}
export function workerStepLabel(usage: UsageLevel, reviewed: boolean): string {
  return reviewed ? "one step up toward the requested tier after review changes" : `first attempt: at the ${USAGE_LABELS[usage].label} start tier`;
}

/**
 * Spec 053 rotation share (Tom, 2026-11-21; steeper stops Tom, 2026-11-22): a
 * profile's weight stop sets its relative share within the eligible set, 50% to
 * 200% of Default (`weightShare`). It orders rotation only and never admits or
 * excludes a profile; no cost rating enters it.
 */
/** A profile's rank on the bracket scale; unrated counts as Worker. */
export const profileRank = (value: ProfileCapability | null | undefined): number => demandRank(value ?? "worker");
/** The divisor rotation uses: the profile's relative share for its weight stop. */
export const rotationShare = (weight: ProfileWeight): number => weightShare(weight);

/**
 * The tier set one run selects from (Spec 052, Tom 2026-11-17; Spec 053
 * rotation). Automatic selection reaches the run's own tier: profiles rated at
 * that tier rotate by weight share. When none carries the tier, the nearest
 * tier above is the bail-out, and a shortfall takes the most capable profile at
 * or below the ceiling. Maximum is its own rule: workers and reviewers use
 * Heavyweight and Frontier whatever the complexity, and no lower tier is a substitute.
 * The ceiling keeps automatic selection from reaching above the task's own
 * requested tier, which is an explicit route. `topOnly` is Maximum's separate
 * rule and applies to workers and reviewers only, never a coordinator.
 */
export function selectionTier<T extends { capability?: ProfileCapability | null }>(
  demand: DemandLevel, entries: readonly T[], topOnly: boolean, ceiling: DemandLevel,
): { tier: T[]; shortfall: boolean } {
  if (topOnly) {
    const top = entries.filter(entry => entry.capability === "heavyweight" || entry.capability === "frontier");
    return { tier: top, shortfall: !top.length };
  }
  const max = demandRank(ceiling);
  const within = entries.filter(entry => profileRank(entry.capability) <= max);
  if (!within.length) return { tier: [], shortfall: true };
  const exact = within.filter(entry => profileRank(entry.capability) === demandRank(demand));
  if (exact.length) return { tier: exact, shortfall: false };
  const above = within.filter(entry => profileRank(entry.capability) > demandRank(demand));
  if (above.length) {
    const nearest = Math.min(...above.map(entry => profileRank(entry.capability)));
    return { tier: above.filter(entry => profileRank(entry.capability) === nearest), shortfall: false };
  }
  const best = Math.max(...within.map(entry => profileRank(entry.capability)));
  return { tier: within.filter(entry => profileRank(entry.capability) === best), shortfall: true };
}

export type DemandCandidate = Pick<PoolEntry, "profileId" | "enabled" | "group" | "capability"> & { model: string; available: boolean };
export type DemandPick = {
  /** Every profile rated at or above the demand (rotation by weight share decides among them), or the most capable available on a shortfall. */
  profileIds: string[];
  shortfall: boolean;
};

/**
 * The profiles the formula picks for a demand. Candidates must be enabled,
 * catalog-available, in an available subscription group, and not share a
 * model in `excludedModels` (a reviewer never reviews its author's model).
 * Roles and scopes are not consulted: Spec 053 retires them.
 */
export function demandPick(demand: DemandLevel, usage: UsageLevel, candidates: readonly DemandCandidate[],
  unavailableGroups: ReadonlySet<string> = new Set(), excludedModels: ReadonlySet<string> = new Set(),
  requested?: DemandLevel | null, climbTier?: DemandLevel | null, ceiling?: DemandLevel | null, topOnly = usage === "maximum"): DemandPick {
  const modelKey = (model: string) => model.split("/").at(-1)!.toLowerCase();
  const usable = candidates.filter(candidate => candidate.enabled && candidate.available && !unavailableGroups.has(candidate.group)
    && !excludedModels.has(modelKey(candidate.model)));
  // The same tier gate selection applies (Spec 052).
  const within = requested ?? demand;
  const gated = (candidate: DemandCandidate) => requestOnly(candidate, usage, within, climbTier);
  const automatic = usable.filter(candidate => !gated(candidate));
  const { tier: chosen, shortfall } = selectionTier(demand, automatic, topOnly, ceiling ?? usageCeiling(usage, within));
  return {
    profileIds: chosen.map(candidate => candidate.profileId),
    shortfall: shortfall || !chosen.length,
  };
}

export type DemandPreviewRow = {
  role: DemandRole; demand: DemandLevel; pick: DemandPick;
  /** The explicit profile request stored for this role. */
  request: { profileId: string; replaces: boolean } | null;
  /** Why the role has no automatic pick regardless of the pool, if so. */
  blocked: string | null;
};
type PreviewTask = Parameters<typeof taskAuthorModelKeys>[0] & {
  complexity?: CapabilityLevel | null;
  profileRequests?: Partial<Record<DemandRole, { profileId: string; reason: string } | null>> | null;
  resolution?: Parameters<typeof taskAuthorModelKeys>[0]["resolution"];
};
/**
 * The board's read-only preview: each role's demand for this task, what the
 * formula would pick now, and any request that replaces that result. A
 * reviewer excludes every model that authored the task, as runtime does.
 */
export function taskDemandPreview(task: PreviewTask, pool: readonly PoolEntry[],
  profiles: ReadonlyArray<{ id: string; model: string; available: boolean }>, usage: UsageLevel, unavailableGroups: ReadonlySet<string>,
  reviewed = false,
): DemandPreviewRow[] {
  const candidates: DemandCandidate[] = pool.flatMap(entry => {
    const profile = profiles.find(item => item.id === entry.profileId);
    return profile ? [{ ...entry, model: profile.model, available: profile.available }] : [];
  });
  const authors = taskAuthorModelKeys(task);
  const requested = requestedTier(task.complexity);
  const climb = workerClimbTarget(task, pool, usage);
  const climbed = climbedTier(task);
  return (["worker", "reviewer", "coordinator"] as const).map(role => {
    const fullDemand = runDemand(task.complexity, role, usage);
    const roleDemand = role === "reviewer" ? reviewerDemand(task, pool, usage) : fullDemand;
    const demand = role === "worker" ? (climb ? climb.to : reviewed ? workerStepUp(roleDemand, automaticClimbCeiling(requested, usage)) : roleDemand) : roleDemand;
    // A coordinator takes the lowest permitted bracket with a profile, so only
    // a worker is bounded by the bracket the task may climb to.
    const ceiling = role === "worker" && usage !== "maximum" ? requested : "frontier";
    const exception = role === "worker" ? climb?.to ?? climbed : climbed;
    const raw = task.profileRequests?.[role] ?? null;
    const request = raw ? { profileId: raw.profileId, replaces: true } : null;
    // Runtime never picks a reviewer for an opaque author: independence cannot be proved.
    const blocked = role === "reviewer" && authors.has("default") ? "an opaque author model cannot prove review independence" : null;
    const pick = blocked ? { profileIds: [], shortfall: true }
      // A reviewer never runs on an opaque provider-default model either, as runtime refuses.
      : demandPick(demand, usage, role === "reviewer" ? candidates.filter(candidate => candidate.model.trim() && candidate.model.split("/").at(-1)!.toLowerCase() !== "default") : candidates,
        unavailableGroups, role === "reviewer" ? authors : new Set(), requested, exception, ceiling, usage === "maximum" && role !== "coordinator");
    return { role, demand, pick, request, blocked };
  });
}
