import { z } from "zod";
import type { HostCatalog, HostProvider } from "./host";
import { isCanonicalProvider, isRuntimeMode, isThinkingLevel, canonicalThinkingLevels, translateProfile, type HostVocabulary, type LaunchValues } from "./profile-vocabulary";

/**
 * A Nucleus-owned profile record. Nucleus keeps its own list; the host only
 * reports what it can run (Tom, 2026-11-06/07, `docs/knowledge/vision.md`).
 *
 * Every value is canonical (`shared/profile-vocabulary.ts`, Tom 2026-11-12): the
 * provider key, the thinking level and the runtime mode come from Nucleus's one
 * vocabulary, and each host's adapter translates them in code. Options don't vary
 * by host (Tom, 2026-11-07), so a record carries one mode, one thinking level and
 * one feature value set. The stored schema accepts any string so a value outside
 * the vocabulary is kept and reported, never dropped; create and update refuse it.
 */
export const nucleusProfileSchema = z
  .object({
    id: z.string().min(1).max(240),
    name: z.string().min(1).max(240),
    /** The canonical provider key, not a host's own spelling. */
    provider: z.string().min(1).max(240),
    /** The provider's model id (or one of its aliases); empty when none is chosen yet. */
    model: z.string().max(240).default(""),
    modeId: z.string().min(1).max(240).optional(),
    thinkingOptionId: z.string().min(1).max(240).optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().max(4000).default(""),
  })
  .strict();
export type NucleusProfile = z.infer<typeof nucleusProfileSchema>;

const canonicalProvider = z.string().min(1).max(240).refine(isCanonicalProvider, { error: issue => `Provider ${String(issue.input)} is not in Nucleus's vocabulary` });
const canonicalMode = z.string().min(1).max(240).refine(isRuntimeMode, { error: issue => `Runtime mode ${String(issue.input)} is not in Nucleus's vocabulary` });
const canonicalThinking = z.string().min(1).max(240).refine(isThinkingLevel, { error: issue => `Thinking level ${String(issue.input)} is not in Nucleus's vocabulary` });

/** A profile as a caller creates one: the id is generated when absent; values are canonical. */
export const nucleusProfileInputSchema = z
  .object({
    id: z.string().min(1).max(240).optional(),
    name: z.string().min(1).max(240),
    provider: canonicalProvider,
    model: z.string().max(240).optional(),
    modeId: canonicalMode.optional(),
    thinkingOptionId: canonicalThinking.optional(),
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
    provider: canonicalProvider.optional(),
    model: z.string().max(240).optional(),
    modeId: canonicalMode.nullable().optional(),
    thinkingOptionId: canonicalThinking.nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).some((key) => key !== "id"),
    "Provide at least one field to update",
  );
export type NucleusProfileUpdate = z.infer<typeof nucleusProfileUpdateSchema>;

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

/** The provider of a host catalog with this host key, or null. */
export function hostProviderFor(key: string, catalog: HostCatalog): HostProvider | null {
  return catalog.providers.find(candidate => candidate.key === key) ?? null;
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
 * Whether launch values in one host's own spelling can run on the host whose
 * catalog this is, and why not. A profile is unavailable when the host lacks its provider or model, and
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
): ProfileAvailability {
  return availabilityOn(profile, hostProviderFor(profile.provider, catalog), catalog);
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

/**
 * Routing profiles for one host: each stored canonical profile translated with
 * that host's table, carrying the values a launch there sends, and judged against
 * the host's catalog. A value the table can't express makes the profile
 * unavailable there with the reason; nothing is configured per profile.
 */
export function routingProfiles(
  profiles: NucleusProfile[],
  catalog: HostCatalog,
  vocabulary: HostVocabulary,
): import('./contracts').Profile[] {
  return profiles.map((profile) => {
    const answer = profileCompatibility(profile, catalog, vocabulary);
    return {
      id: profile.id, name: profile.name, provider: answer.launch.provider, model: answer.launch.model,
      ...(answer.launch.modeId ? { modeId: answer.launch.modeId } : {}),
      ...(answer.launch.thinkingOptionId ? { thinkingOptionId: answer.launch.thinkingOptionId } : {}),
      ...(answer.launch.featureValues ? { featureValues: answer.launch.featureValues } : {}),
      notes: profile.notes,
      available: answer.available, problem: answer.problem, supportedThinking: answer.supportedThinking,
      ...(answer.translated.length ? { translated: answer.translated } : {}),
    };
  });
}

export type CompatibilityStatus = "works" | "unavailable";

/** One profile on one host: whether it can run there, why not, and what it launches with. */
export interface ProfileCompatibility extends ProfileAvailability {
  status: CompatibilityStatus;
  /** The problem in the operator's words, naming the host; empty when it works. */
  reason: string;
  /** The fields the host's table spells differently from the canonical value. */
  translated: string[];
  /** The values a launch on this host sends, in the host's own spelling. */
  launch: LaunchValues;
}

/**
 * Whether one canonical profile can run on one host: translated with that host's
 * table (Tom, 2026-11-12), then judged against the host's catalog. A value the
 * table can't express, or one the catalog doesn't report, answers a reason naming
 * the host.
 */
export function profileCompatibility(
  profile: AvailabilityFields,
  catalog: HostCatalog,
  vocabulary: HostVocabulary,
): ProfileCompatibility {
  // The levels this host runs for the profile's model, canonical: a host that
  // carries thinking as one of its own option values (T3's claude `effort`, its
  // pi `thinking`) reports them from that option, not as the model's native
  // levels, so a caller reading only the routing snapshot still sees them.
  const supportedThinking = canonicalThinkingLevelsOn(profile.provider, profile.model, catalog, vocabulary);
  const withLevels = (answer: Omit<ProfileCompatibility, 'status' | 'reason' | 'translated' | 'launch'>) =>
    supportedThinking ? { ...answer, supportedThinking } : answer;
  const translation = translateProfile(vocabulary, profile);
  if (!translation.ok)
    return { ...withLevels({ available: false, problem: translation.reason, supportedThinking: [] }), status: "unavailable",
      reason: translation.reason, translated: [], launch: translation.launch };
  const launch = translation.launch;
  const provider = hostProviderFor(launch.provider, catalog);
  const answer = withLevels(availabilityOn(launch, provider, catalog));
  return {
    ...answer,
    status: answer.available ? "works" : "unavailable",
    reason: answer.available ? "" : hostReason(answer.problem, vocabulary.label, launch.provider, launch),
    translated: translation.translated,
    launch,
  };
}

/** The canonical levels this host can run for one provider's model; null when the host does not report it. */
function canonicalThinkingLevelsOn(provider: string, modelId: string, catalog: HostCatalog, vocabulary: HostVocabulary) {
  if (!isCanonicalProvider(provider)) return null;
  const entry = vocabulary.providers[provider];
  const host = entry && catalog.providers.find(candidate => candidate.key === entry.key);
  const model = host && hostModelFor(modelId, host);
  return entry && model ? canonicalThinkingLevels(entry, model) : null;
}

/** The availability problem with the host named. */
function hostReason(problem: string, label: string, providerKey: string, values: AvailabilityFields): string {
  const missing = /^Provider (\S+) is not available on this host$/.exec(problem);
  if (missing) return `${label} has no ${missing[1]} provider`;
  const mode = /^Configured runtime mode (\S+) is not one of this host's modes(?: \((.*)\))?$/.exec(problem);
  if (mode) return `${label}'s ${providerKey} has no mode ${mode[1]}${mode[2] ? ` (it offers ${mode[2]})` : ""}`;
  if (problem === "Configured thinking level is not supported") return `${label}'s ${values.model} has no thinking level ${values.thinkingOptionId}`;
  if (/^Model \S+ is not available from provider/.test(problem)) return `${label}'s ${providerKey} has no model ${values.model}`;
  const option = /^Configured option (\S+) (is not supported|needs a boolean value|does not offer that value)$/.exec(problem);
  if (option) return option[2] === "is not supported" ? `${label}'s ${values.model} has no option ${option[1]}`
    : option[2] === "needs a boolean value" ? `${label}'s ${values.model} option ${option[1]} needs on or off`
    : `${label}'s ${values.model} option ${option[1]} has no value ${String(values.featureValues?.[option[1]!])}`;
  return problem.replace("this host", label);
}
