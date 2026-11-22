import type {
  CapabilityLevel,
  DemandLevel,
  PoolEntry,
  ProfileCapability,
  RoutePolicy,
  UsageLevel,
  UsageView,
} from "./contracts";
import { profileCapabilityLevels } from "./contracts";
export type ProfileSettings = PoolEntry;
/** Ordinal rank of the five task-complexity levels, lowest first (a profile's capability is a bracket). */
export const CAPABILITY_LEVELS: readonly CapabilityLevel[] = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
];
export function capabilityRank(value: CapabilityLevel): number {
  return CAPABILITY_LEVELS.indexOf(value);
}
/** A profile's four capability brackets, lowest first (Tom, 2026-11-19). */
export const PROFILE_CAPABILITY_LEVELS: readonly ProfileCapability[] =
  profileCapabilityLevels;
/** The bracket names Settings, the board and routing text show. */
export const BRACKET_LABELS: Record<ProfileCapability, string> = {
  mechanical: "Mechanical",
  worker: "Worker",
  heavyweight: "Heavyweight",
  frontier: "Frontier",
};
/** The demand scale a run's demand and a profile's capability both rank on: the four brackets. */
export const DEMAND_LEVELS: readonly DemandLevel[] = profileCapabilityLevels;
export function demandRank(value: DemandLevel): number {
  return DEMAND_LEVELS.indexOf(value);
}
/**
 * Spec 052: each level uses the profile's capability bracket. "The top two" are Heavyweight and Frontier (Tom, 2026-11-19).
 */
export const TOP_TIERS: readonly ProfileCapability[] = [
  "heavyweight",
  "frontier",
];

/** Whether a profile's bracket is one of the top two. */
export const topTier = (
  capability: ProfileCapability | null | undefined,
): boolean => capability === "heavyweight" || capability === "frontier";

/**
 * The operator's levels, spelled once for diagnostics and Settings: what a
 * level does, in one line, and the rule behind it.
 */
export const USAGE_LABELS: Record<
  UsageLevel,
  { label: string; detail: string; summary: string }
> = {
  low: {
    label: "Low",
    summary:
      "Starts one bracket below the task; high-complexity work needs permission at submission",
    detail:
      "Every task starts one bracket below the one it may climb to. High and very-high complexity work needs permission when it is submitted. Frontier requires a profile request, as does Heavyweight unless the task starts or climbs there. The reviewer runs one bracket below the worker.",
  },
  normal: {
    label: "Normal",
    summary:
      "Low complexity on Mechanical, medium and high on Worker, very high on Heavyweight",
    detail:
      "Very-low and low complexity start on Mechanical, medium and high on Worker, and very high on Heavyweight. A high task may climb once to Heavyweight after review changes; a very-high task uses Frontier only on request. The reviewer runs one bracket below the worker.",
  },
  high: {
    label: "High",
    summary:
      "High-complexity work starts on Heavyweight; Frontier is request-only",
    detail:
      "High and very-high complexity start on Heavyweight; lower complexities start as at Normal. Frontier profiles require an explicit request. The reviewer runs one bracket below the worker.",
  },
  extra_high: {
    label: "Extra high",
    summary: "Same starting brackets as High, with automatic Frontier selection",
    detail:
      "Every task starts as at High, and no run needs permission. The reviewer runs on the worker's bracket.",
  },
  maximum: {
    label: "Maximum",
    summary: "Workers and reviewers run on Heavyweight or Frontier profiles",
    detail:
      "Workers and reviewers run on Heavyweight or Frontier profiles regardless of complexity, and no run needs permission. The coordinator stays on Mechanical.",
  },
};

/**
 * Whether this pool entry requires an explicit profile request (Spec 052). `requested` is the bracket
 * the task may climb to and `climbTier` the bracket a recorded climb earned.
 * At Low and Normal, Frontier is request-only and Heavyweight is too unless
 * the task starts there (a very-high task) or a
 * recorded climb reached it. Rotation weight (Spec 053) is never a
 * permission rule.
 */
export function requestOnly(
  entry: Pick<PoolEntry, "capability">,
  usage: UsageLevel = "normal",
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
): boolean {
  const tier = entry.capability;
  if (!tier) return false;
  switch (usage) {
    case "maximum":
    case "extra_high":
      return false;
    case "high":
      return tier === "frontier";
    case "normal":
    case "low":
      return (
        tier === "frontier" ||
        (tier === "heavyweight" &&
          requested !== "frontier" &&
          climbTier !== "heavyweight")
      );
  }
}

/**
 * Whether a submission of this complexity needs the operator's permission at
 * this usage level (Tom, 2026-11-17): on Low, high and very-high complexity work
 * opens a decision and is held until the operator approves it. No other level
 * gates a submission.
 */
export function submissionNeedsPermission(
  level: UsageLevel,
  complexity: CapabilityLevel | null | undefined,
): boolean {
  return (
    level === "low" && (complexity === "high" || complexity === "very_high")
  );
}
/**
 * Whether automatic selection may ever reach this profile at this level: within
 * the task's own requested tier (Maximum is the exception, where workers and
 * reviewers use the top two tiers), and eligible under the usage level.
 */
export function automaticReachable(
  entry: Pick<PoolEntry, "capability">,
  level: UsageLevel,
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
  role: "worker" | "reviewer" | "coordinator" = "worker",
): boolean {
  const tier = entry.capability;
  if (level === "maximum" && role !== "coordinator") return topTier(tier);
  // Only a worker is capped at the climb bracket (Tom, 2026-11-18 reviewer; 2026-11-19 coordinator):
  // the usage level bounds the other roles.
  if (
    role === "worker" &&
    requested &&
    tier &&
    demandRank(tier) > demandRank(requested)
  )
    return false;
  return !requestOnly(entry, level, requested, climbTier);
}

/**
 * Spec 052 diagnostics: what the usage level in force means for automatic
 * selection of one pool entry. A read of the routing bounds and `requestOnly`,
 * never a gate; other gates (enabled, group, catalog) are reported beside it.
 */
export function automaticSelection(
  entry: Pick<PoolEntry, "capability">,
  level: UsageLevel,
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
  role: "worker" | "reviewer" | "coordinator" = "worker",
): NonNullable<RoutePolicy["automatic"]> {
  return automaticReachable(entry, level, requested, climbTier, role)
    ? "allowed"
    : "request_tier";
}
/** One plain sentence for `automaticSelection`; `time` formats the optional end time (the client passes local time). */
export function describeAutomaticSelection(
  entry: Pick<PoolEntry, "capability">,
  usage: UsageView,
  time: (iso: string) => string = (iso) => iso,
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
  role: "worker" | "reviewer" | "coordinator" = "worker",
): string {
  const label = USAGE_LABELS[usage.level].label;
  const ends =
    !usage.expired && usage.until && usage.level !== "normal"
      ? ` until ${time(usage.until)}`
      : "";
  const ended =
    usage.expired && usage.until
      ? ` (${USAGE_LABELS[usage.setLevel].label} ended ${time(usage.until)})`
      : "";
  switch (automaticSelection(entry, usage.level, requested, climbTier, role)) {
    case "allowed":
      return `${entry.capability === "frontier" ? "Frontier · " : ""}Automatic at ${label}${ends}${ended}`;
    case "request_tier": {
      const tier = entry.capability
        ? BRACKET_LABELS[entry.capability]
        : "Unrated";
      const aboveRequested =
        requested &&
        entry.capability &&
        demandRank(entry.capability) > demandRank(requested);
      const rule =
        usage.level === "maximum" && role !== "coordinator"
          ? "below Heavyweight and Frontier, which Maximum reserves for workers and reviewers"
          : aboveRequested
            ? `above the task's ${BRACKET_LABELS[requested]} bracket, so an explicit route is required`
            : `request-only at ${label}`;
      return `${tier}: ${rule}${ended}`;
    }
  }
}
/**
 * A short suffix for a profile button: the effective policy. Buttons do not
 * wrap, so the tag stays a few words (compact routing dialogs at 360 pt); the
 * chosen profile's wrapping sentence carries the level and end time.
 */
export function automaticSelectionTag(
  entry: Pick<PoolEntry, "capability">,
  level: UsageLevel,
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
  role: "worker" | "reviewer" | "coordinator" = "worker",
): string {
  return automaticSelection(entry, level, requested, climbTier, role) ===
    "request_tier"
    ? " · request only"
    : "";
}
/** The full sentence for one routing policy row; the server passes ISO time, the client local time. */
export function describeRoutePolicy(
  policy: Omit<RoutePolicy, "explanation">,
  usage: UsageView,
  time: (iso: string) => string = (iso) => iso,
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
): string {
  const source =
    policy.source === "request"
      ? `Explicit ${policy.role} request${policy.reason ? `: ${policy.reason}` : ""}`
      : policy.source === "preference"
        ? "Worker preference"
        : `Recorded ${policy.role} run used it (history, not today's policy)`;
  if (!policy.automatic)
    return `${source}; not in the pool, so automatic selection never uses it`;
  const preferenceOnly =
    policy.source === "preference" && policy.automatic.startsWith("request");
  return `${source}; automatic selection: ${describeAutomaticSelection(policy, usage, time, requested, climbTier, policy.role)}${preferenceOnly ? "; a preference alone does not select it" : ""}${policy.gates.length ? `; also ${policy.gates.join(", ")}` : ""}`;
}
export function saveProfileSettings(
  pool: PoolEntry[],
  settings: ProfileSettings,
): PoolEntry[] {
  const group = settings.group.trim();
  if (!group) throw Error("Subscription group is required");
  return [
    ...pool.filter((p) => p.profileId !== settings.profileId),
    { ...settings, group },
  ];
}

/**
 * Pool entries a save may store. Identity is the stored Nucleus profile record
 * (nucleus#1492): a new or changed entry must name one of `knownProfileIds`, the
 * stored profiles, and never depends on a host catalog being read. The catalog
 * only decides launch eligibility, so a valid stored profile saves whether or not
 * a host has been read. An entry left unchanged is kept even if its profile has
 * since been removed: one stale entry must not block every other save (live
 * 2026-09-27: a disabled entry for a deleted profile failed every Profile Pool
 * change). Dispatch only draws from the catalog, so a kept stale entry is inert.
 */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map(
            (k) =>
              `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");
export function checkPoolEntries(
  entries: PoolEntry[],
  knownProfileIds: ReadonlySet<string>,
  stored: PoolEntry[],
) {
  if (new Set(entries.map((e) => e.profileId)).size !== entries.length)
    throw Error("Duplicate pool profile");
  const unchanged = new Set(stored.map(canonical));
  for (const entry of entries) {
    if (
      !knownProfileIds.has(entry.profileId) &&
      !unchanged.has(canonical(entry))
    )
      throw Error(
        `Unknown profile ${entry.profileId}: no stored profile has this id`,
      );
    if (entry.group.startsWith("profile:"))
      throw Error("Subscription group prefix is reserved");
  }
}

/**
 * Entries whose profile is gone from Paseo's catalog. An empty catalog (none
 * named, or the daemon disconnected so none are loaded) marks nothing stale:
 * a daemon outage must never offer to drop the whole pool.
 */
export function stalePoolEntries(
  pool: readonly PoolEntry[],
  profiles: readonly { id: string }[],
): PoolEntry[] {
  if (!profiles.length) return [];
  const known = new Set(profiles.map((p) => p.id));
  return pool.filter((entry) => !known.has(entry.profileId));
}

/** Drop one entry. Every other entry is the same object, so a save stays byte-identical for them. */
export function removePoolEntry(
  pool: readonly PoolEntry[],
  profileId: string,
): PoolEntry[] {
  return pool.filter((entry) => entry.profileId !== profileId);
}

export function groupIsUnavailable(
  state: { unavailable: boolean; retryAt: string | null },
  at = Date.now(),
) {
  return (
    state.unavailable && (!state.retryAt || Date.parse(state.retryAt) > at)
  );
}
export function normalizeRetryAt(value: string | null) {
  const retryAt = value?.trim() || null;
  if (retryAt && !Number.isFinite(Date.parse(retryAt)))
    throw Error("Retry time must be a valid date");
  return retryAt;
}
/**
 * The subscription groups recorded unavailable at `at`, from the store's typed
 * availability rows. One read of the durable table serves every selection gate,
 * so no caller decodes the JSON row itself.
 */
export function unavailableGroupNames(
  availability: ReadonlyArray<{
    group: string;
    unavailable: boolean;
    retryAt: string | null;
  }>,
  at = Date.now(),
): Set<string> {
  return new Set(
    availability
      .filter((entry) => groupIsUnavailable(entry, at))
      .map((entry) => entry.group),
  );
}
export function activeGroupLimit(
  availability: readonly {
    group: string;
    unavailable: boolean;
    reason: string;
    retryAt: string | null;
  }[],
  group: string,
  at = Date.now(),
) {
  return availability.find(
    (a) => a.group === group && groupIsUnavailable(a, at),
  );
}

/**
 * The worker's effective thinking level: the worker request's own level when
 * it names one, else the task's. A brief or route may put it in either place,
 * and selection, validation and display all read it here (papercut 4befc74b:
 * a worker request's level was stored but never applied).
 */
export function workerThinking(task: {
  thinkingOptionId?: string;
  profileRequests?: { worker?: { thinkingOptionId?: string } | null } | null;
}): string {
  return (
    task.profileRequests?.worker?.thinkingOptionId ||
    task.thinkingOptionId ||
    ""
  );
}
/** A required request or a request-only profile supersedes an older binding. */
export function supersedingRouteProfile(
  request:
    | {
        profileId: string;
        reason: string;
        required?: boolean;
      }
    | null
    | undefined,
  recordedProfileId: string | null | undefined,
  pool: readonly Pick<PoolEntry, "capability" | "profileId">[],
  usage: UsageLevel,
  requested?: DemandLevel | null,
  climbTier?: DemandLevel | null,
): string | null {
  if (!request || request.profileId === recordedProfileId) return null;
  const entry = pool.find((item) => item.profileId === request.profileId);
  return request.required || (entry && requestOnly(entry, usage, requested, climbTier))
    ? request.profileId
    : null;
}

export function workerRouteProfile(task: {
  profile?: { id: string } | null;
  preferredProfileId?: string;
  profileRequests?: {
    worker?: {
      profileId: string;
      required?: boolean;
      ownerRoute?: boolean;
      routedAt?: string;
    } | null;
  } | null;
}): string | null {
  const request = task.profileRequests?.worker;
  return (
    (request?.required ? request.profileId : null) ??
    task.profile?.id ??
    request?.profileId ??
    task.preferredProfileId ??
    null
  );
}
