import { z } from "zod";
import type { HostCatalog, HostProvider } from "./host";

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
  profile: Pick<NucleusProfile, "provider" | "model" | "thinkingOptionId" | "modeId" | "featureValues">,
  catalog: HostCatalog,
  providerMap: ProviderMap = {},
): ProfileAvailability {
  const provider = hostProviderFor(profile.provider, catalog, providerMap);
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
      problem: "Configured runtime mode is not supported",
      supportedThinking,
    };
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
): import('./contracts').Profile[] {
  return profiles.map((profile) => ({
    id: profile.id, name: profile.name, provider: profile.provider, model: profile.model,
    modeId: profile.modeId, thinkingOptionId: profile.thinkingOptionId,
    featureValues: profile.featureValues, notes: profile.notes,
    ...profileAvailability(profile, catalog, providerMap),
  }));
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
