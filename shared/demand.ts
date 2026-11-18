/**
 * Spec 053: demand-based profile selection. Each run's demand is the task's
 * complexity, moved by a role offset and the usage level; selection takes every
 * available profile rated at or above the demand and rotates among them, cost
 * leaning the share toward cheaper ones (Spec 053, Tom 2026-11-04).
 * This module is the formula, shared by selection (server/routing.ts) and the
 * board's preview.
 */
import type { CapabilityLevel, DemandLevel, DemandRoleOffsets, PoolEntry, ProfileCapability, UsageLevel } from "./contracts";
import { CAPABILITY_LEVELS, DEMAND_LEVELS, USAGE_LABELS, capabilityRank, demandRank, honouredRequest, requestOnly } from "./pool";
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
/** Default role offsets (Tom, 2026-10-21: reviewer "Match the task"); Settings → Dispatch limits changes them. */
export const DEMAND_ROLE_OFFSETS: DemandRoleOffsets = { worker: 0, reviewer: 0, coordinator: -2 };

/**
 * The tier a task asks for: its complexity on the profile capability scale
 * (Spec 052, Tom 2026-11-17). Very-low complexity still asks for the cheapest
 * tier a profile carries; a task never asks for `frontier` by complexity alone,
 * which is an explicit request above the requested tier.
 */
export function requestedTier(complexity: CapabilityLevel | null | undefined): DemandLevel {
  const rank = demandRank(complexity ?? "medium");
  return DEMAND_LEVELS[Math.max(demandRank("low"), Math.min(demandRank("very_high"), rank))];
}

/**
 * Where a task's worker starts at each usage level (Tom, 2026-11-17):
 * Low starts every task one tier below its complexity; Normal starts high and
 * very-high complexity one tier below and everything lower at its requested
 * tier; High and Extra high start at the requested tier; Maximum puts workers
 * and reviewers on very-high or frontier profiles whatever the complexity.
 */
export function workerStartTier(usage: UsageLevel, complexity: CapabilityLevel | null | undefined): DemandLevel {
  const rank = demandRank(complexity ?? "medium");
  const start = usage === "low" ? rank - 1
    : usage === "normal" ? (rank >= demandRank("high") ? rank - 1 : rank)
    : usage === "maximum" ? demandRank("very_high")
    : rank;
  return DEMAND_LEVELS[Math.max(0, Math.min(demandRank("frontier"), start))];
}

/**
 * One run's demand: the level's start tier moved by the role offset. A reviewer
 * never sits below the worker's own tier ("at least the worker's capability"),
 * and a coordinator keeps its configured offset under every level, Maximum
 * included (Tom, 2026-11-17).
 */
export function runDemand(complexity: CapabilityLevel | null | undefined, role: DemandRole, usage: UsageLevel, offsets: DemandRoleOffsets = DEMAND_ROLE_OFFSETS): DemandLevel {
  const start = demandRank(workerStartTier(usage, complexity));
  const worker = start + offsets.worker;
  const rank = role === "reviewer" ? Math.max(start + offsets.reviewer, worker) : role === "worker" ? worker : start + offsets.coordinator;
  return DEMAND_LEVELS[Math.max(0, Math.min(demandRank("frontier"), rank))];
}

/**
 * The worker's actual tier from the profile it selected (an unrated entry
 * counts as medium). Reviewer selection floors against this actual rating, not
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
  const from = workerActualTier(task, pool) ?? workerStartTier(usage, task.complexity);
  const requested = requestedTier(task.complexity);
  const target = Math.min(demandRank(from) + 1, demandRank(requested));
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
 * The highest tier automatic selection may reach at this level: frontier at
 * Maximum (which runs workers and reviewers on the top two tiers regardless of
 * complexity), the task's own requested tier otherwise. Going above the
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
 * Spec 053 cost lean (Tom, 2026-11-04: "lean towards a lower cost model in the
 * capability tier, not exclude all other options"). Each cost step down doubles
 * a profile's effective weight, so at equal configured weight a very_low-cost
 * profile gets 16 times the share of a very_high-cost one, and a medium-cost
 * one gets twice a high-cost one. One constant; Spec 053 states it.
 */
export const COST_LEAN = 2;
/** An unrated cost counts as medium. */
const rated = (value: CapabilityLevel | null | undefined): number => capabilityRank(value ?? "medium");
/** A profile's rank on the demand scale; unrated counts as medium. */
const profileRank = (value: ProfileCapability | null | undefined): number => demandRank(value ?? "medium");
/** The cost lean for a profile: COST_LEAN per step below very_high. */
export const costLean = (cost: CapabilityLevel | null | undefined): number => COST_LEAN ** (CAPABILITY_LEVELS.length - 1 - rated(cost));
/** The divisor rotation uses: configured weight times the cost lean. */
export const effectiveWeight = (weight: number, cost: CapabilityLevel | null | undefined): number => weight * costLean(cost);

/**
 * The tier set one run selects from (Spec 052, Tom 2026-11-17; Spec 053
 * rotation). Automatic selection reaches the run's own tier: profiles rated at
 * that tier rotate by the cost lean. When none carries the tier, the nearest
 * tier above is the bail-out, and a shortfall takes the most capable profile at
 * or below the ceiling. Maximum is its own rule: workers and reviewers use the
 * top two tiers whatever the complexity, and no lower tier is a substitute.
 * The ceiling keeps automatic selection from reaching above the task's own
 * requested tier, which is an explicit route.
 */
export function selectionTier<T extends { capability?: ProfileCapability | null }>(
  demand: DemandLevel, entries: readonly T[], usage: UsageLevel, requested: DemandLevel,
): { tier: T[]; shortfall: boolean } {
  if (usage === "maximum") {
    const top = entries.filter(entry => entry.capability === "very_high" || entry.capability === "frontier");
    return { tier: top, shortfall: !top.length };
  }
  const ceiling = demandRank(usageCeiling(usage, requested));
  const within = entries.filter(entry => profileRank(entry.capability) <= ceiling);
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

export type DemandCandidate = Pick<PoolEntry, "profileId" | "enabled" | "group" | "cost" | "capability"> & { model: string; available: boolean };
export type DemandPick = {
  /** Every profile rated at or above the demand (rotation and the cost lean decide among them), or the most capable available on a shortfall. */
  profileIds: string[];
  shortfall: boolean;
  /** Profiles that would meet the demand but need a signed-off request at this level (a top-tier profile above the task's own requested tier, or frontier at High). */
  signoffOnly: string[];
};

/**
 * The profiles the formula picks for a demand. Candidates must be enabled,
 * catalog-available, in an available subscription group, and not share a
 * model in `excludedModels` (a reviewer never reviews its author's model).
 * Roles and scopes are not consulted: Spec 053 retires them.
 */
export function demandPick(demand: DemandLevel, usage: UsageLevel, candidates: readonly DemandCandidate[],
  unavailableGroups: ReadonlySet<string> = new Set(), excludedModels: ReadonlySet<string> = new Set(),
  requested?: DemandLevel | null, climbTier?: DemandLevel | null): DemandPick {
  const modelKey = (model: string) => model.split("/").at(-1)!.toLowerCase();
  const usable = candidates.filter(candidate => candidate.enabled && candidate.available && !unavailableGroups.has(candidate.group)
    && !excludedModels.has(modelKey(candidate.model)));
  // The same tier gate selection applies (Spec 052).
  const within = requested ?? demand;
  const gated = (candidate: DemandCandidate) => requestOnly(candidate, usage, within, climbTier);
  const automatic = usable.filter(candidate => !gated(candidate));
  // A signed-off request reaches a profile the level's permission rule holds,
  // including one above the task's requested tier (an explicit route); the
  // requested-tier bound only stops automatic selection.
  const signoffOnly = usable.filter(candidate => gated(candidate) && profileRank(candidate.capability) >= demandRank(demand))
    .map(candidate => candidate.profileId);
  const { tier: chosen, shortfall } = selectionTier(demand, automatic, usage, within);
  return {
    profileIds: chosen.map(candidate => candidate.profileId),
    shortfall: shortfall || !chosen.length,
    signoffOnly,
  };
}

export type DemandPreviewRow = {
  role: DemandRole; demand: DemandLevel; pick: DemandPick;
  /** A request on the task for this role: a signed-off (or within-level) one replaces the demand result. */
  request: { profileId: string; replaces: boolean } | null;
  /** Why the role has no automatic pick regardless of the pool, if so. */
  blocked: string | null;
};
type PreviewTask = Parameters<typeof taskAuthorModelKeys>[0] & {
  complexity?: CapabilityLevel | null;
  profileRequests?: Partial<Record<DemandRole, { profileId: string; reason: string; signoff?: { status: string } | null } | null>> | null;
  resolution?: Parameters<typeof taskAuthorModelKeys>[0]["resolution"];
};
/**
 * The board's read-only preview: each role's demand for this task, what the
 * formula would pick now, and any request that replaces that result. A
 * reviewer excludes every model that authored the task, as runtime does.
 */
export function taskDemandPreview(task: PreviewTask, pool: readonly PoolEntry[],
  profiles: ReadonlyArray<{ id: string; model: string; available: boolean }>, usage: UsageLevel, unavailableGroups: ReadonlySet<string>,
  offsets: DemandRoleOffsets = DEMAND_ROLE_OFFSETS, reviewed = false,
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
    const fullDemand = runDemand(task.complexity, role, usage, offsets);
    const workerActual = workerActualTier(task, pool);
    const roleDemand = role === "reviewer" && workerActual ? (demandRank(workerActual) > demandRank(fullDemand) ? workerActual : fullDemand) : fullDemand;
    const demand = role === "worker" ? (climb ? climb.to : reviewed ? workerStepUp(roleDemand, requested) : roleDemand) : roleDemand;
    const exception = role === "worker" ? climb?.to ?? climbed : climbed;
    const raw = task.profileRequests?.[role] ?? null;
    const request = raw ? { profileId: raw.profileId, replaces: Boolean(honouredRequest(raw, pool, usage, requested, exception)) } : null;
    // Runtime never picks a reviewer for an opaque author: independence cannot be proved.
    const blocked = role === "reviewer" && authors.has("default") ? "an opaque author model cannot prove review independence" : null;
    const pick = blocked ? { profileIds: [], shortfall: true, signoffOnly: [] }
      // A reviewer never runs on an opaque provider-default model either, as runtime refuses.
      : demandPick(demand, usage, role === "reviewer" ? candidates.filter(candidate => candidate.model.trim() && candidate.model.split("/").at(-1)!.toLowerCase() !== "default") : candidates,
        unavailableGroups, role === "reviewer" ? authors : new Set(), requested, exception);
    return { role, demand, pick, request, blocked };
  });
}
