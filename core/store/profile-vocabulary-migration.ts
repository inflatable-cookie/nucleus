import {
  CANONICAL_OPTION_DEFINITIONS,
  CANONICAL_OPTIONS,
  canonicalOptionValue,
  canonicalThinkingValue,
  isCanonicalProvider,
  isRuntimeMode,
  isThinkingLevel,
  thinkingCarriers,
  type CanonicalOption,
  type HostVocabulary,
  type ThinkingLevel,
} from "../../shared/profile-vocabulary";

/**
 * The one-time move of stored profiles to Nucleus's canonical vocabulary (Tom,
 * 2026-11-12). Stored profiles held Paseo's own spellings; each known spelling
 * maps to its canonical value here. A profile carrying any value this table does
 * not know is left exactly as stored and reported, never dropped or guessed.
 */
const LEGACY_PROVIDERS: Record<string, string> = { claudeAgent: "claude" };
const LEGACY_MODES: Record<string, string> = {
  bypassPermissions: "full-access",
  default: "supervised",
  acceptEdits: "accept-edits",
  "approval-required": "supervised",
  "auto-accept-edits": "accept-edits",
};
const LEGACY_THINKING: Record<string, string> = { ultrathink: "ultra" };

export interface ProfileVocabularyChange {
  profileId: string;
  field: string;
  from: unknown;
  to: unknown;
}
export interface ProfileVocabularyUnknown {
  profileId: string;
  field: string;
  value: unknown;
}
export interface ProfileVocabularyMigration {
  at: string;
  changes: ProfileVocabularyChange[];
  unknown: ProfileVocabularyUnknown[];
}

type Raw = Record<string, unknown>;

/** One stored profile in canonical values, with what changed and what this table doesn't know. */
export function canonicalProfile(raw: Raw): {
  profile: Raw;
  changes: ProfileVocabularyChange[];
  unknown: ProfileVocabularyUnknown[];
} {
  const profileId = typeof raw.id === "string" ? raw.id : "";
  const next: Raw = { ...raw };
  const changes: ProfileVocabularyChange[] = [],
    unknown: ProfileVocabularyUnknown[] = [];
  const set = (field: string, to: unknown) => {
    changes.push({ profileId, field, from: raw[field], to });
    if (to === undefined) delete next[field];
    else next[field] = to;
  };
  const provider = raw.provider;
  if (typeof provider === "string" && !isCanonicalProvider(provider)) {
    if (LEGACY_PROVIDERS[provider]) set("provider", LEGACY_PROVIDERS[provider]);
    else unknown.push({ profileId, field: "provider", value: provider });
  }
  const mode = raw.modeId;
  if (typeof mode === "string" && !isRuntimeMode(mode)) {
    if (LEGACY_MODES[mode]) set("modeId", LEGACY_MODES[mode]);
    else unknown.push({ profileId, field: "modeId", value: mode });
  }
  const thinking = raw.thinkingOptionId;
  if (typeof thinking === "string" && !isThinkingLevel(thinking)) {
    if (LEGACY_THINKING[thinking])
      set("thinkingOptionId", LEGACY_THINKING[thinking]);
    else
      unknown.push({ profileId, field: "thinkingOptionId", value: thinking });
  }
  // Paseo carried Grok's full access as its `auto_accept` option; the canonical
  // profile names the mode, and Paseo's table carries it back as the option.
  const features =
    raw.featureValues && typeof raw.featureValues === "object"
      ? (raw.featureValues as Raw)
      : null;
  if (next.provider === "grok" && features && "auto_accept" in features) {
    const value = features.auto_accept;
    if (typeof value !== "boolean" || typeof raw.modeId === "string")
      unknown.push({ profileId, field: "featureValues.auto_accept", value });
    else {
      const { auto_accept: _dropped, ...rest } = features;
      set("modeId", value ? "full-access" : "supervised");
      set("featureValues", Object.keys(rest).length ? rest : undefined);
    }
  }
  // Retired with the per-profile host mapping (nucleus#1151); no live profile has one.
  if ("hosts" in raw)
    unknown.push({ profileId, field: "hosts", value: raw.hosts });
  return unknown.length
    ? { profile: raw, changes: [], unknown }
    : { profile: next, changes, unknown };
}

/** Every stored profile in canonical values, and the record of the run. */
export function migrateProfileVocabulary(
  stored: readonly unknown[],
  at = new Date().toISOString(),
): { profiles: unknown[]; record: ProfileVocabularyMigration } {
  const record: ProfileVocabularyMigration = { at, changes: [], unknown: [] };
  const profiles = stored.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const answer = canonicalProfile(raw as Raw);
    record.changes.push(...answer.changes);
    record.unknown.push(...answer.unknown);
    return answer.profile;
  });
  return { profiles, record };
}

/**
 * One stored profile with its thinking level in one canonical field (nucleus#1365).
 * Profiles reached the store with the level in a host's own carrier option
 * (`featureValues.thinking` on T3's Pi, `effort` on its Claude, a `reasoning`
 * select) or as a host's own spelling in `thinkingOptionId` (`ultrathink`, BB's
 * `none`). Each value is mapped back through every host table that carries it
 * for this provider, so its meaning is kept: the level moves to
 * `thinkingOptionId` and the carrier option goes. A value no table maps, a value
 * two tables read as different levels, or a carrier that disagrees with the
 * stored level leaves the profile exactly as stored and is reported.
 */
export function canonicalThinkingProfile(
  raw: Raw,
  vocabularies: readonly HostVocabulary[],
): {
  profile: Raw;
  changes: ProfileVocabularyChange[];
  unknown: ProfileVocabularyUnknown[];
} {
  const profileId = typeof raw.id === "string" ? raw.id : "";
  const provider = raw.provider;
  if (typeof provider !== "string" || !isCanonicalProvider(provider))
    return { profile: raw, changes: [], unknown: [] };
  const hosts = vocabularies.flatMap((vocabulary) => {
    const entry = vocabulary.providers[provider];
    return entry ? [{ vocabulary, entry }] : [];
  });
  const unknown: ProfileVocabularyUnknown[] = [];
  /** The one level every host that reads this value agrees on, else null. */
  const levelOf = (
    value: unknown,
    readers: typeof hosts,
  ): ThinkingLevel | null => {
    if (typeof value !== "string") return null;
    const levels = new Set(
      readers
        .map(({ entry }) => canonicalThinkingValue(entry, value))
        .filter((level): level is ThinkingLevel => level !== null),
    );
    return levels.size === 1 ? [...levels][0]! : null;
  };
  const levels: ThinkingLevel[] = [];
  const stored = raw.thinkingOptionId;
  if (typeof stored === "string") {
    const level = isThinkingLevel(stored) ? stored : levelOf(stored, hosts);
    if (level) levels.push(level);
    else unknown.push({ profileId, field: "thinkingOptionId", value: stored });
  }
  const features =
    raw.featureValues &&
    typeof raw.featureValues === "object" &&
    !Array.isArray(raw.featureValues)
      ? (raw.featureValues as Raw)
      : {};
  const carried: string[] = [];
  for (const [option, value] of Object.entries(features)) {
    const readers = hosts.filter(({ vocabulary, entry }) =>
      thinkingCarriers(vocabulary, entry).includes(option),
    );
    if (!readers.length) continue;
    const level = levelOf(value, readers);
    if (level) {
      levels.push(level);
      carried.push(option);
    } else unknown.push({ profileId, field: `featureValues.${option}`, value });
  }
  if (new Set(levels).size > 1)
    unknown.push({
      profileId,
      field: "thinkingOptionId",
      value: {
        stored: stored ?? null,
        carried: Object.fromEntries(
          carried.map((option) => [option, features[option]]),
        ),
      },
    });
  if (unknown.length) return { profile: raw, changes: [], unknown };
  const level = levels[0];
  const changes: ProfileVocabularyChange[] = [];
  const next: Raw = { ...raw };
  if (level && stored !== level) {
    changes.push({
      profileId,
      field: "thinkingOptionId",
      from: stored,
      to: level,
    });
    next.thinkingOptionId = level;
  }
  if (carried.length) {
    const rest = Object.fromEntries(
      Object.entries(features).filter(([option]) => !carried.includes(option)),
    );
    const to = Object.keys(rest).length ? rest : undefined;
    changes.push({
      profileId,
      field: "featureValues",
      from: raw.featureValues,
      to,
    });
    if (to) next.featureValues = to;
    else delete next.featureValues;
  }
  return { profile: changes.length ? next : raw, changes, unknown };
}

/** Every stored profile's thinking in one canonical field, and the record of the run. */
export function migrateProfileThinking(
  stored: readonly unknown[],
  vocabularies: readonly HostVocabulary[],
  at = new Date().toISOString(),
): { profiles: unknown[]; record: ProfileVocabularyMigration } {
  const record: ProfileVocabularyMigration = { at, changes: [], unknown: [] };
  const profiles = stored.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const answer = canonicalThinkingProfile(raw as Raw, vocabularies);
    record.changes.push(...answer.changes);
    record.unknown.push(...answer.unknown);
    return answer.profile;
  });
  return { profiles, record };
}

/**
 * One stored profile with each shared provider option under its canonical key
 * (nucleus#1386). Profiles stored a host's own spelling (`service_tier` from
 * Paseo's codex, `serviceTier` from T3's, `fast_mode` or `fastMode` for Claude);
 * each value is read back through every host table that carries that option for
 * this provider, so its meaning is kept, and moves to the canonical key. A value
 * no table maps, two tables reading it differently, or a disagreement with a
 * canonical value already stored leaves the profile exactly as stored, reported.
 * A profile with no host spelling left is unchanged, so the move is idempotent.
 */
export function canonicalOptionProfile(
  raw: Raw,
  vocabularies: readonly HostVocabulary[],
): {
  profile: Raw;
  changes: ProfileVocabularyChange[];
  unknown: ProfileVocabularyUnknown[];
} {
  const profileId = typeof raw.id === "string" ? raw.id : "";
  const provider = raw.provider;
  const features =
    raw.featureValues &&
    typeof raw.featureValues === "object" &&
    !Array.isArray(raw.featureValues)
      ? (raw.featureValues as Raw)
      : null;
  if (typeof provider !== "string" || !isCanonicalProvider(provider) || !features)
    return { profile: raw, changes: [], unknown: [] };
  const unknown: ProfileVocabularyUnknown[] = [];
  const moved: Partial<Record<CanonicalOption, string>> = {};
  const carried: string[] = [];
  /** A canonical value already stored under the canonical key (a host may spell the option with that same id, as T3's `ultracode`). */
  const canonicalStored = (option: CanonicalOption): string | undefined => {
    const value = features[option];
    return typeof value === "string" &&
      CANONICAL_OPTION_DEFINITIONS[option].values.includes(value)
      ? value
      : undefined;
  };
  for (const [id, value] of Object.entries(features)) {
    for (const option of CANONICAL_OPTIONS) {
      // The canonical key holding a canonical value is already moved.
      if (id === option && canonicalStored(option) !== undefined) continue;
      const readers = vocabularies.flatMap((vocabulary) => {
        const carrier = vocabulary.providers[provider]?.options?.[option];
        return carrier && carrier.id === id ? [carrier] : [];
      });
      if (!readers.length) continue;
      const values = new Set(
        readers.map((carrier) => canonicalOptionValue(carrier, option, value)),
      );
      const canonical = values.size === 1 ? [...values][0] : null;
      const stored = canonicalStored(option) ?? moved[option];
      if (!canonical || (stored !== undefined && stored !== canonical))
        unknown.push({ profileId, field: `featureValues.${id}`, value });
      else {
        moved[option] = canonical;
        carried.push(id);
      }
    }
  }
  for (const option of CANONICAL_OPTIONS) {
    const stored = features[option];
    if (
      !carried.includes(option) &&
      stored != null &&
      (typeof stored !== "string" ||
        !CANONICAL_OPTION_DEFINITIONS[option].values.includes(stored))
    )
      unknown.push({ profileId, field: `featureValues.${option}`, value: stored });
  }
  if (unknown.length) return { profile: raw, changes: [], unknown };
  if (!carried.length) return { profile: raw, changes: [], unknown: [] };
  const to: Raw = { ...features };
  for (const id of carried) delete to[id];
  Object.assign(to, moved);
  return {
    profile: { ...raw, featureValues: to },
    changes: [{ profileId, field: "featureValues", from: raw.featureValues, to }],
    unknown: [],
  };
}

/** Every stored profile's shared options under their canonical keys, and the record of the run. */
export function migrateProfileOptions(
  stored: readonly unknown[],
  vocabularies: readonly HostVocabulary[],
  at = new Date().toISOString(),
): { profiles: unknown[]; record: ProfileVocabularyMigration } {
  const record: ProfileVocabularyMigration = { at, changes: [], unknown: [] };
  const profiles = stored.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const answer = canonicalOptionProfile(raw as Raw, vocabularies);
    record.changes.push(...answer.changes);
    record.unknown.push(...answer.unknown);
    return answer.profile;
  });
  return { profiles, record };
}
