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
 * The tier a demand selects from rated entries: every entry rated at or above
 * the demand (Spec 053 Tom 2026-11-04: filter by complexity, then weight by
 * cost); on a shortfall, the most capable entries. Cost never removes an entry.
 * Rotation and the cost lean then choose within the returned set. One rule for
 * selection and preview.
 */
export function demandTier<T extends { capability?: ProfileCapability | null }>(demand: DemandLevel, entries: readonly T[]): { tier: T[]; shortfall: boolean } {
  const meeting = entries.filter(entry => profileRank(entry.capability) >= demandRank(demand));
  if (meeting.length) return { tier: meeting, shortfall: false };
  const best = Math.max(...entries.map(entry => profileRank(entry.capability)));
  return { tier: entries.filter(entry => profileRank(entry.capability) === best), shortfall: true };
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
  requested?: DemandLevel | null): DemandPick {
  const modelKey = (model: string) => model.split("/").at(-1)!.toLowerCase();
  const usable = candidates.filter(candidate => candidate.enabled && candidate.available && !unavailableGroups.has(candidate.group)
    && !excludedModels.has(modelKey(candidate.model)));
  // The same tier gate selection applies (Spec 052).
  const gated = (candidate: DemandCandidate) => requestOnly(candidate, usage, requested);
  const automatic = usable.filter(candidate => !gated(candidate));
  const signoffOnly = usable.filter(candidate => gated(candidate) && profileRank(candidate.capability) >= demandRank(demand))
    .map(candidate => candidate.profileId);
  const { tier: chosen, shortfall } = demandTier(demand, automatic);
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
  return (["worker", "reviewer", "coordinator"] as const).map(role => {
    const fullDemand = runDemand(task.complexity, role, usage, offsets);
    const demand = role === "worker" && reviewed ? workerStepUp(fullDemand, requested) : fullDemand;
    const raw = task.profileRequests?.[role] ?? null;
    const request = raw ? { profileId: raw.profileId, replaces: Boolean(honouredRequest(raw, pool, usage, requested)) } : null;
    // Runtime never picks a reviewer for an opaque author: independence cannot be proved.
    const blocked = role === "reviewer" && authors.has("default") ? "an opaque author model cannot prove review independence" : null;
    const pick = blocked ? { profileIds: [], shortfall: true, signoffOnly: [] }
      // A reviewer never runs on an opaque provider-default model either, as runtime refuses.
      : demandPick(demand, usage, role === "reviewer" ? candidates.filter(candidate => candidate.model.trim() && candidate.model.split("/").at(-1)!.toLowerCase() !== "default") : candidates,
        unavailableGroups, role === "reviewer" ? authors : new Set(), requested);
    return { role, demand, pick, request, blocked };
  });
}
