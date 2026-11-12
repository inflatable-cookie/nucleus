import { z } from "zod";
import type { HostCatalog, HostProvider } from "./host";
import type { HostKind } from "./host-kind";

/**
 * One profile's setting on one host kind (nucleus#1151). The pool's profiles were
 * set up for Paseo; another host may spell the provider, model or mode
 * differently, or not offer it at all. The operator maps the differing values
 * once per host kind, or excludes the profile there. A value given here replaces
 * the profile's own on that host only; `null` clears it there (for example, a
 * thinking level the host carries as a feature value instead). `provider` is the
 * host's own provider key, read directly, never through the provider map.
 */
export const profileHostSettingSchema = z
  .object({
    excluded: z.boolean().optional(),
    provider: z.string().min(1).max(240).optional(),
    model: z.string().min(1).max(240).optional(),
    modeId: z.string().min(1).max(240).nullable().optional(),
    thinkingOptionId: z.string().min(1).max(240).nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type ProfileHostSetting = z.infer<typeof profileHostSettingSchema>;

/** Settings keyed by host kind: stable across a host's restarts and new instance ids. */
export const profileHostsSchema = z
  .object({ paseo: profileHostSettingSchema.optional(), t3code: profileHostSettingSchema.optional() })
  .strict();
export type ProfileHosts = z.infer<typeof profileHostsSchema>;

/**
 * A Nucleus-owned profile record. Nucleus keeps its own list; the host only
 * reports what it can run (Tom, 2026-11-06/07, `docs/knowledge/vision.md`).
 *
 * The provider is the normalised key, so the same profile works on a host that
 * spells the provider differently. Options don't vary by host (Tom, 2026-11-07:
 * "Let's go with no for now and look at it again if the need arises"), so a
 * record carries one mode, one thinking option and one feature value set.
 */
export const nucleusProfileSchema = z
  .object({
    id: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    /** The normalised provider key, not the host's own spelling. */
    provider: z.string().min(1).max(240),
    /** The host's model id (or one of its aliases); empty when none is chosen yet. */
    model: z.string().max(240).default(""),
    modeId: z.string().min(1).max(240).optional(),
    thinkingOptionId: z.string().min(1).max(240).optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(4000).default(""),
    /** Per-host mapping or exclusion (nucleus#1151); absent means the profile's own values everywhere. */
    hosts: profileHostsSchema.optional(),
  })
  .strict();
export type NucleusProfile = z.infer<typeof nucleusProfileSchema>;

/** A profile as a caller creates one: the id is generated when absent. */
export const nucleusProfileInputSchema = z
  .object({
    id: z.string().min(1).max(240).optional(),
    name: z.string().min(1).max(240),
    provider: z.string().min(1).max(240),
    model: z.string().max(240).optional(),
    modeId: z.string().min(1).max(240).optional(),
    thinkingOptionId: z.string().min(1).max(240).optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(4000).optional(),
    hosts: profileHostsSchema.optional(),
  })
  .strict();
export type NucleusProfileInput = z.infer<typeof nucleusProfileInputSchema>;

/** An edit to one stored profile; `null` clears an optional field. */
export const nucleusProfileUpdateSchema = z
  .object({
    id: z.string().min(1).max(240),
    name: z.string().min(1).max(240).optional(),
    provider: z.string().min(1).max(240).optional(),
    model: z.string().max(240).optional(),
    modeId: z.string().min(1).max(240).nullable().optional(),
    thinkingOptionId: z.string().min(1).max(240).nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    notes: z.string().max(4000).optional(),
    hosts: profileHostsSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "id"),
    "Provide at least one field to update",
  );
export type NucleusProfileUpdate = z.infer<typeof nucleusProfileUpdateSchema>;

/**
 * One host's provider keys mapped to the normalised keys a profile names.
 * Identity by default, which is what Paseo's keys are: a key with no entry maps
 * to itself, so a map only records the hosts that spell a provider differently
 * (Tom, 2026-11-07).
 */
export const providerMapSchema = z.record(
  z.string().min(1).max(240),
  z
    .string()
    .min(1)
    .max(240)
    .refine(
      (value) => value === value.trim(),
      "A normalised provider key is trimmed",
    ),
);
export type ProviderMap = z.infer<typeof providerMapSchema>;

/** The normalised key for one host provider key; identity when the map has no entry. */
export function normaliseProvider(
  providerMap: ProviderMap,
  hostProviderKey: string,
): string {
  return providerMap[hostProviderKey] ?? hostProviderKey;
}

/** What the one-time import copied, and that it ran. */
export const profileImportRecordSchema = z
  .object({
    at: z.string(),
    /** Where the copied list came from: the host's own profile list. */
    source: z.string().min(1),
    imported: z.number().int().nonnegative(),
    /** Records already present under the same id, which the import never overwrote. */
    kept: z.number().int().nonnegative(),
    /** Host entries the schema refused to store; they stay out rather than half-copied. */
    skipped: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ProfileImportRecord = z.infer<typeof profileImportRecordSchema>;

/** The provider of a host catalog that a stored profile names, or null. */
export function hostProviderFor(
  provider: string,
  catalog: HostCatalog,
  providerMap: ProviderMap = {},
): HostProvider | null {
  return (
    catalog.providers.find(
      (candidate) => normaliseProvider(providerMap, candidate.key) === provider,
    ) ?? null
  );
}

/** The host model a stored profile names, by id or one of its aliases. */
export function hostModelFor(model: string, provider: HostProvider) {
  return (
    provider.models.find(
      (candidate) =>
        candidate.id === model || candidate.aliases.includes(model),
    ) ?? null
  );
}

/** Today's `Profile` availability fields, computed from a stored profile and one host's catalog. */
export interface ProfileAvailability {
  available: boolean;
  problem: string;
  supportedThinking: string[];
}

/**
 * Whether one stored profile can run on the host whose catalog this is, and why
 * not. A profile is unavailable when the host lacks its provider or model, and
 * there is no silent fallback: a missing provider or model is a refusal, not a
 * different model (Tom, 2026-11-07: a profile from another host "is unavailable
 * under normal semantics"). `supportedThinking` is the matched model's options,
 * so a picker can offer exactly what this host allows. The answer also covers
 * the configured runtime mode and feature values, so a profile carrying a mode
 * or feature the host does not report is ineligible there instead of refusing
 * at launch (nucleus#1139 review).
 */
export function profileAvailability(
  profile: AvailabilityFields,
  catalog: HostCatalog,
  providerMap: ProviderMap = {},
): ProfileAvailability {
  return availabilityOn(profile, hostProviderFor(profile.provider, catalog, providerMap), catalog);
}

type AvailabilityFields = Pick<NucleusProfile, "provider" | "model" | "thinkingOptionId" | "modeId" | "featureValues">;

/** The availability answer for a profile whose host provider is already resolved (or absent). */
function availabilityOn(
  profile: AvailabilityFields,
  provider: HostProvider | null,
  catalog: HostCatalog,
): ProfileAvailability {
  if (!provider)
    return {
      available: false,
      problem: `Provider ${profile.provider} is not available on this host`,
      supportedThinking: [],
    };
  if (!provider.available)
    return {
      available: false,
      problem:
        provider.problem ||
        `Provider ${profile.provider} is not available on this host`,
      supportedThinking: [],
    };
  if (!profile.model)
    return {
      available: false,
      problem: "Profile needs an explicit model",
      supportedThinking: [],
    };
  const model = hostModelFor(profile.model, provider);
  if (!model)
    return {
      available: false,
      problem: `Model ${profile.model} is not available from provider ${profile.provider}`,
      supportedThinking: [],
    };
  const supportedThinking = model.thinkingOptions.map((option) => option.id);
  if (
    profile.thinkingOptionId &&
    !supportedThinking.includes(profile.thinkingOptionId)
  )
    return {
      available: false,
      problem: "Configured thinking level is not supported",
      supportedThinking,
    };
  if (profile.modeId && profile.modeId !== "default" && !model.modes.some((mode) => mode.id === profile.modeId))
    return {
      available: false,
      // Name the mode and the host's own list: a profile T3Code cannot run is
      // ineligible with its reason visible, never silently changed at launch
      // (nucleus#1143).
      problem: `Configured runtime mode ${profile.modeId} is not one of this host's modes${
        model.modes.length ? ` (${model.modes.map((mode) => mode.id).join(", ")})` : ""
      }`,
      supportedThinking,
    };
  // A deferred read answers nothing about feature values: unknown, never
  // negative. The launch context resolves them with the real project
  // directory, and a host that always answers (T3Code) never defers.
  if (catalog.featuresDeferred !== true)
    for (const [option, value] of Object.entries(profile.featureValues ?? {})) {
      const feature = model.features.find((candidate) => candidate.id === option);
      if (!feature)
        return {
          available: false,
          problem: `Configured option ${option} is not supported`,
          supportedThinking,
        };
      if (feature.type === "toggle") {
        if (typeof value !== "boolean")
          return {
            available: false,
            problem: `Configured option ${option} needs a boolean value`,
            supportedThinking,
          };
      } else if (typeof value !== "string" || !feature.options.some((choice) => choice.id === value))
        return {
          available: false,
          problem: `Configured option ${option} does not offer that value`,
          supportedThinking,
        };
    }
  return { available: true, problem: "", supportedThinking };
}

/** Build routing profiles from Nucleus records and a host catalog snapshot. */
export function routingProfiles(
  profiles: NucleusProfile[],
  catalog: HostCatalog,
  providerMap: ProviderMap = {},
  hostKind?: HostKind,
): import('./contracts').Profile[] {
  return profiles.map((profile) => {
    if (!hostKind)
      return {
        id: profile.id, name: profile.name, provider: profile.provider, model: profile.model,
        modeId: profile.modeId, thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues, notes: profile.notes,
        ...profileAvailability(profile, catalog, providerMap),
      };
    // On a named host kind the routing profile carries the values that host
    // launches with: the operator's mapping applied, and the host's own provider
    // key, so a mapped profile launches with the mapped values (nucleus#1151).
    const answer = profileCompatibility(profile, catalog, providerMap, hostKind);
    return {
      id: profile.id, name: profile.name, provider: answer.launch.provider, model: answer.launch.model,
      modeId: answer.launch.modeId, thinkingOptionId: answer.launch.thinkingOptionId,
      featureValues: answer.launch.featureValues, notes: profile.notes,
      available: answer.available, problem: answer.problem, supportedThinking: answer.supportedThinking,
      ...(answer.status === "excluded" ? { excluded: true } : {}),
      ...(answer.mapped.length ? { mapped: answer.mapped } : {}),
    };
  });
}

/** The host names an operator reads, by host kind. */
export const HOST_KIND_LABELS: Record<HostKind, string> = { paseo: "Paseo", t3code: "T3Code" };

/** The fields a host setting can replace, in the order the UI and reasons name them. */
export const PROFILE_HOST_FIELDS = ["provider", "model", "modeId", "thinkingOptionId", "featureValues"] as const;

/** A profile as one host kind runs it: its own values with that host's setting applied. */
export interface ProfileOnHost {
  values: AvailabilityFields;
  /** The host provider key the setting names, read without the provider map; null when unmapped. */
  hostProviderKey: string | null;
  excluded: boolean;
  /** The fields the setting replaces. */
  mapped: (typeof PROFILE_HOST_FIELDS)[number][];
}

export function profileOnHost(profile: AvailabilityFields & Pick<NucleusProfile, "hosts">, hostKind: HostKind): ProfileOnHost {
  const setting = profile.hosts?.[hostKind];
  const values: AvailabilityFields = {
    provider: profile.provider, model: profile.model,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.featureValues ? { featureValues: profile.featureValues } : {}),
  };
  const mapped: ProfileOnHost["mapped"] = [];
  if (!setting) return { values, hostProviderKey: null, excluded: false, mapped };
  for (const field of PROFILE_HOST_FIELDS) {
    const value = setting[field];
    if (value === undefined) continue;
    mapped.push(field);
    if (value === null) delete (values as Record<string, unknown>)[field];
    else (values as Record<string, unknown>)[field] = value;
  }
  return { values, hostProviderKey: setting.provider ?? null, excluded: setting.excluded === true, mapped };
}

export type CompatibilityStatus = "works" | "unavailable" | "excluded";

/** One profile on one host: whether it can run there, why not, and what it launches with. */
export interface ProfileCompatibility extends ProfileAvailability {
  status: CompatibilityStatus;
  /** The problem in the operator's words, naming the host; empty when it works. */
  reason: string;
  mapped: ProfileOnHost["mapped"];
  /** The values a launch on this host sends; `provider` is the host's own key. */
  launch: { provider: string; model: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> };
}

/**
 * Whether one profile can run on one host, computed from that host's catalog and
 * the profile's setting for its kind (nucleus#1151). An excluded profile is never
 * selected there. A mapped provider is the host's own key; otherwise the profile's
 * normalised key is read through the provider map, and the launch carries the
 * matched host key, which is what the host's create call names.
 */
export function profileCompatibility(
  profile: AvailabilityFields & Pick<NucleusProfile, "hosts">,
  catalog: HostCatalog,
  providerMap: ProviderMap,
  hostKind: HostKind,
): ProfileCompatibility {
  const label = HOST_KIND_LABELS[hostKind];
  const onHost = profileOnHost(profile, hostKind);
  const provider = onHost.hostProviderKey
    ? catalog.providers.find((candidate) => candidate.key === onHost.hostProviderKey) ?? null
    : hostProviderFor(onHost.values.provider, catalog, providerMap);
  const launch = {
    ...onHost.values,
    provider: provider?.key ?? onHost.values.provider,
  } as ProfileCompatibility["launch"];
  if (onHost.excluded)
    return { available: false, problem: `Excluded on ${label} in Settings`, supportedThinking: [], status: "excluded",
      reason: `Excluded on ${label} in Settings`, mapped: onHost.mapped, launch };
  const answer = availabilityOn(onHost.values, provider, catalog);
  return {
    ...answer,
    status: answer.available ? "works" : "unavailable",
    reason: answer.available ? "" : hostReason(answer.problem, label, provider?.key ?? onHost.values.provider, onHost.values),
    mapped: onHost.mapped,
    launch,
  };
}

/** The availability problem with the host named, as the per-host chip shows it. */
function hostReason(problem: string, label: string, providerKey: string, values: AvailabilityFields): string {
  const missing = /^Provider (\S+) is not available on this host$/.exec(problem);
  if (missing) return `${label} has no ${missing[1]} provider`;
  const mode = /^Configured runtime mode (\S+) is not one of this host's modes(?: \((.*)\))?$/.exec(problem);
  if (mode) return `${label}'s ${providerKey} has no mode ${mode[1]}${mode[2] ? ` (it offers ${mode[2]})` : ""}`;
  if (problem === "Configured thinking level is not supported") return `${label}'s ${values.model} has no thinking level ${values.thinkingOptionId}`;
  if (/^Model \S+ is not available from provider/.test(problem)) return `${label}'s ${providerKey} has no model ${values.model}`;
  return problem.replace("this host", label);
}

/** One provider-map entry that would make a profile available on a host. */
export interface ProviderMapSuggestion {
  hostId: string;
  /** The host's own provider key, which the entry maps from. */
  hostKey: string;
  /** The normalised key the profile names, which the entry maps to. */
  normalised: string;
  profileName: string;
}

/**
 * Where the provider map can help (Tom, 2026-11-08): Nucleus serves more than
 * one host, a profile's provider key isn't offered on one of them, and that
 * host offers the profile's model under a different, unmapped key. One host,
 * or no such match, suggests nothing. A host key suggests one entry, the first
 * profile's.
 */
export function providerMapSuggestions(
  hosts: readonly { id: string; catalog: HostCatalog }[],
  profiles: readonly Pick<NucleusProfile, "name" | "provider" | "model">[],
  providerMap: ProviderMap = {},
): ProviderMapSuggestion[] {
  if (hosts.length < 2) return [];
  const suggestions: ProviderMapSuggestion[] = [];
  for (const host of hosts)
    for (const profile of profiles) {
      if (!profile.provider || !profile.model || hostProviderFor(profile.provider, host.catalog, providerMap)) continue;
      const match = host.catalog.providers.find(candidate =>
        providerMap[candidate.key] === undefined && hostModelFor(profile.model, candidate));
      if (!match || suggestions.some(entry => entry.hostId === host.id && entry.hostKey === match.key)) continue;
      suggestions.push({ hostId: host.id, hostKey: match.key, normalised: profile.provider, profileName: profile.name });
    }
  return suggestions;
}
