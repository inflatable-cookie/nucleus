import { activeGroupLimit, PROFILE_CAPABILITY_LEVELS } from "../shared/pool";
import {
  profileAvailability,
  hostModelFor,
  type NucleusProfile,
} from "../shared/profiles";
import type {
  AssignmentRole,
  PoolEntry,
  Profile,
  Project,
  RepositorySettings,
  UiQueueState,
} from "../shared/contracts";
import type {
  HostCatalog,
  HostFeature,
  HostModel,
  HostProvider,
} from "../shared/host";
import * as api from "../shared/contracts";
import {
  isCanonicalOption,
  isCanonicalProvider,
  thinkingCarriers,
  type CanonicalOption,
} from "../shared/profile-vocabulary";
import { HOST_VOCABULARIES } from "../hosts/vocabularies";

/** Legacy provider option keys removed when the canonical option is edited. */
const LEGACY_OPTION_KEYS: Readonly<
  Partial<Record<CanonicalOption, readonly string[]>>
> = {
  speed: ["service_tier", "fast_mode"],
  "plan-mode": ["plan_mode"],
};

/** The five rotation-weight stops and the plain words each reads as; Default is the centre (Spec 053). */
export const WEIGHT_STOP_LABELS: Record<api.ProfileWeight, string> = {
  fewest: "Fewest",
  fewer: "Fewer",
  default: "Default",
  more: "More",
  most: "Most",
};
/** Each stop's accessible name: what it does to this profile's turn in rotation, never a number. */
export const WEIGHT_STOP_SPEECH: Record<api.ProfileWeight, string> = {
  fewest: "Weight: fewest assignments",
  fewer: "Weight: fewer assignments",
  default: "Weight: default",
  more: "Weight: more assignments",
  most: "Weight: most assignments",
};
export const levelLabel = (level: string) =>
  level.charAt(0).toUpperCase() + level.slice(1).replaceAll("_", " ");
/** Below this editor width (a phone) paired fields stack. */
export const PAIRED_MIN_WIDTH = 460;
export const HOST_DEFAULT = { value: "", label: "Host default" };
export const PLAIN_KEYS: Record<string, string> = {
  xhigh: "Extra high",
  xlow: "Extra low",
  max: "Maximum",
  min: "Minimum",
};
/**
 * A host option in plain words: the host's display label when it reads as words,
 * else its raw key spelled out ("xhigh" reads "Extra high", "full_access" "Full access").
 */
export function plainWords(label: string | undefined, id: string): string {
  const text = (label ?? "").trim() || id;
  // Words already: a space, or a leading capital ("Full Access"). A camelCase key is still a key.
  if (/\s/.test(text) || /^[A-Z]/.test(text)) return text;
  const known = PLAIN_KEYS[text.toLowerCase()];
  if (known) return known;
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type ProfileDraft = {
  name: string;
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
};

export const emptyProfileDraft = (): ProfileDraft => ({
  name: "",
  provider: "",
  model: "",
  modeId: null,
  thinkingOptionId: null,
  featureValues: {},
});
export const profileDraft = (
  profile: Pick<
    NucleusProfile,
    | "name"
    | "provider"
    | "model"
    | "modeId"
    | "thinkingOptionId"
    | "featureValues"
  >,
): ProfileDraft => ({
  name: profile.name,
  provider: profile.provider,
  model: profile.model,
  modeId: profile.modeId ?? null,
  thinkingOptionId: profile.thinkingOptionId ?? null,
  featureValues: profile.featureValues ?? {},
});

/**
 * The canonical provider a stored profile names in the form's vocabulary, or null
 * when no registered host can run it. The vocabulary is every host's catalog in
 * canonical values (`profile.vocabulary`, task 1158).
 */
export function namedProvider(
  provider: string,
  catalog: HostCatalog | undefined,
) {
  return catalog && provider
    ? (catalog.providers.find((candidate) => candidate.key === provider) ??
        null)
    : null;
}

/** Each profile on each registered host (`profile.compatibility`), the read the CLI shares. */
export type CompatibilityRead = {
  hosts: api.ProfileCompatibilityHost[];
  rows: api.ProfileCompatibilityRow[];
};

/**
 * The one quiet status a profile row may show for the hosts (task 1158): nothing
 * while it runs on every registered host, else the hosts it can't run on with
 * each reason, for the icon's popover. With one host the reason stands alone (it
 * names the host): a level that host can't express is still a per-host note on
 * the row, never only "Unavailable" (nucleus#1365).
 */
export function hostCompatibilityNote(
  read: CompatibilityRead | undefined,
  profileId: string,
): string {
  if (!read?.hosts?.length) return "";
  const single = read.hosts.length === 1;
  return read.hosts
    .flatMap((host) => {
      const row = read.rows.find(
        (item) => item.profileId === profileId && item.hostId === host.hostId,
      );
      return row?.status === "unavailable"
        ? [single ? row.reason : `Not on ${host.label}: ${row.reason}`]
        : [];
    })
    .join("\n");
}

/**
 * Stored option values that carry this provider's thinking on some host but are
 * not a feature the editor shows (nucleus#1365): a carrier the migration kept
 * because it had no canonical match or disagreed with the level. The editor shows
 * them under its one Thinking control, and choosing a level there clears them.
 */
export function hiddenThinkingValues(
  provider: string,
  featureValues: Record<string, unknown>,
  shown: readonly HostFeature[],
): [string, unknown][] {
  if (!isCanonicalProvider(provider)) return [];
  const carriers = new Set(
    Object.values(HOST_VOCABULARIES).flatMap((vocabulary) => {
      const entry = vocabulary.providers[provider];
      return entry ? [...thinkingCarriers(vocabulary, entry)] : [];
    }),
  );
  return Object.entries(featureValues).filter(
    ([option]) =>
      carriers.has(option) && !shown.some((feature) => feature.id === option),
  );
}

/**
 * Feature values with one canonical option set (nucleus#1386): any host's own
 * spelling or known legacy spelling of that option goes, so the editor's one
 * control is the only value.
 */
export function withCanonicalOption(
  provider: string,
  featureValues: Record<string, unknown>,
  option: string,
  value: unknown,
): Record<string, unknown> {
  if (!isCanonicalOption(option) || !isCanonicalProvider(provider))
    return { ...featureValues, [option]: value };
  const carriers = new Set(
    [
      ...(LEGACY_OPTION_KEYS[option] ?? []),
      ...Object.values(HOST_VOCABULARIES).flatMap((vocabulary) => {
        const carrier = vocabulary.providers[provider]?.options?.[option];
        return carrier ? [carrier.id] : [];
      }),
    ],
  );
  return {
    ...Object.fromEntries(
      Object.entries(featureValues).filter(([id]) => !carriers.has(id)),
    ),
    [option]: value,
  };
}

/**
 * A short plain reason for an unavailable provider, for the dropdown label.
 * Sign-in and disabled map to fixed phrases; a raw host error is never stacked
 * under the field (Tom, 2026-11-08).
 */
export function providerShortReason(provider: HostProvider): string {
  const text = provider.problem.trim();
  const lower = text.toLowerCase();
  if (
    /\b(sign[- ]?in|sign[- ]?on|unauthenticated|auth(?:entication)?|log[- ]?in)\b/.test(
      lower,
    )
  )
    return "needs sign-in";
  if (/\bdisabled\b/.test(lower)) return "unavailable";
  const first = text.split(/[.!\n]/)[0]?.trim() ?? "";
  if (!first) return "unavailable";
  return first.length > 48 ? "unavailable" : first;
}

export function providerOptionLabel(provider: HostProvider): string {
  const label = provider.label || provider.key;
  return provider.available
    ? label
    : `${label} · ${providerShortReason(provider)}`;
}

/** Project display name for a repository path: the project name, else its origin, never the path. */
export function projectNameForPath(
  path: string,
  projects: readonly Project[],
  repositories: readonly RepositorySettings[],
): string {
  const project = projects.find((candidate) =>
    candidate.repositories.some((repo) => repo.path === path),
  );
  if (project) return project.name;
  const row = repositories.find(
    (candidate) => candidate.repository.path === path,
  );
  if (row?.repository.origin) return row.repository.origin;
  return "this project";
}

export function featureFingerprint(model: HostModel | null): string {
  if (!model) return "";
  return JSON.stringify(
    model.features.map((feature) => ({
      id: feature.id,
      type: feature.type,
      value: feature.value,
      options:
        feature.type === "select"
          ? feature.options.map((option) => option.id)
          : [],
    })),
  );
}

export function defaultPoolEntry(
  profile: Pick<Profile, "id" | "provider" | "model">,
): PoolEntry {
  return {
    profileId: profile.id,
    enabled: false,
    group:
      profile.provider === "omp"
        ? `omp-${profile.model.split("/")[0]}`
        : profile.provider,
    weight: api.DEFAULT_PROFILE_WEIGHT,
  };
}

/**
 * A row's status, only when something needs a look: unavailable, else a paused
 * subscription group. By request and its status are retired (Tom, 2026-11-09).
 */
export function profileRowStatus(
  profile: Pick<Profile, "available">,
  entry: PoolEntry,
  state: UiQueueState,
): { problem: string } {
  const groups = state.effectiveProfileGroups;
  const group = groups && Object.hasOwn(groups, entry.profileId)
    ? groups[entry.profileId]
    : groups === undefined ? entry.group : undefined;
  return {
    problem: !profile.available
      ? "Unavailable"
      : group && activeGroupLimit(state.availability, group)
        ? "Subscription paused"
        : "",
  };
}

export function modelWords(
  profile: Pick<Profile, "provider" | "model">,
  catalog: HostCatalog | undefined,
): string {
  const provider = namedProvider(profile.provider, catalog);
  const model = provider ? hostModelFor(profile.model, provider) : null;
  return model?.label || profile.model || "no model";
}

/** The rolling window recent-assignment counts cover (nucleus#1497): up to the last 50 recorded assignments, the sample the All view reads (`recentCounts`, `ASSIGNMENT_HISTORY_KEEP`). Rotation reads each role's own window instead (`recentRoleUsage`, nucleus#1558). */
export const RECENT_ASSIGNMENT_WINDOW = 50;

/**
 * The Profiles usage view (nucleus#1502): All keeps the rotation's shared window
 * across roles; each role reads its own charged window.
 */
export type UsageRole = "all" | AssignmentRole;

export const USAGE_ROLE_TABS: readonly {
  id: UsageRole;
  text: string;
  label: string;
  noun: string;
}[] = [
  { id: "all", text: "All", label: "All roles", noun: "" },
  { id: "worker", text: "Workers", label: "Workers", noun: "worker" },
  { id: "reviewer", text: "Reviewers", label: "Reviewers", noun: "reviewer" },
  {
    id: "coordinator",
    text: "Coordinators",
    label: "Coordinators",
    noun: "coordinator",
  },
];

/** The window one view reads: its profile counts and its real sample size. */
export function usageWindow(
  state: Pick<
    UiQueueState,
    "recentAssignments" | "recentAssignmentSample" | "recentAssignmentRoles"
  >,
  role: UsageRole,
): { counts: Record<string, number>; sample: number } {
  if (role === "all")
    return {
      counts: state.recentAssignments ?? {},
      sample: state.recentAssignmentSample ?? 0,
    };
  return state.recentAssignmentRoles?.[role] ?? { counts: {}, sample: 0 };
}

/**
 * One profile's count, the busiest visible row's count and the view's sample size
 * for its Profiles strip. Only IDs in the rendered list set the maximum; retained
 * history for removed profiles and group keys never affect the comparison.
 */
export function profileUsage(
  state: Pick<
    UiQueueState,
    "recentAssignments" | "recentAssignmentSample" | "recentAssignmentRoles"
  > | null,
  profileId: string,
  visibleProfileIds: readonly string[],
  role: UsageRole = "all",
): { count: number; max: number; sample: number } | null {
  if (!state) return null;
  const { counts: recent, sample } = usageWindow(state, role);
  const count = recent[`profile:${profileId}`] ?? 0;
  const max = visibleProfileIds.reduce(
    (highest, id) => Math.max(highest, recent[`profile:${id}`] ?? 0),
    0,
  );
  return { count, max, sample };
}

export type CatalogRead = { cwd: string; catalog: HostCatalog };

/** How long ago the stored catalog was read from the host, for the Refresh tooltip. */
export function catalogAge(
  readAt: string | undefined,
  nowMs = Date.now(),
): string {
  const at = readAt ? Date.parse(readAt) : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return "read just now";
  if (minutes < 60) return `read ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `read ${hours} h ago`;
  return `read ${Math.floor(hours / 24)} d ago`;
}

export function identityCreateInput(draft: ProfileDraft) {
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    model: draft.model,
    ...(draft.modeId ? { modeId: draft.modeId } : {}),
    ...(draft.thinkingOptionId
      ? { thinkingOptionId: draft.thinkingOptionId }
      : {}),
    ...(Object.keys(draft.featureValues).length
      ? { featureValues: draft.featureValues }
      : {}),
  };
}

export function identityValid(draft: ProfileDraft) {
  return (
    draft.name.trim().length > 0 &&
    draft.provider.length > 0 &&
    draft.model.length > 0
  );
}

/** One live profile row: name, labelled attention icons when needed, on/off and Edit. */
