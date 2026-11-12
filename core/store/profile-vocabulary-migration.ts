import { isCanonicalProvider, isRuntimeMode, isThinkingLevel } from "../../shared/profile-vocabulary";

/**
 * The one-time move of stored profiles to Nucleus's canonical vocabulary (Tom,
 * 2026-11-12). Stored profiles held Paseo's own spellings; each known spelling
 * maps to its canonical value here. A profile carrying any value this table does
 * not know is left exactly as stored and reported, never dropped or guessed.
 */
const LEGACY_PROVIDERS: Record<string, string> = { claudeAgent: "claude" };
const LEGACY_MODES: Record<string, string> = {
  bypassPermissions: "full-access", default: "supervised", acceptEdits: "accept-edits",
  "approval-required": "supervised", "auto-accept-edits": "accept-edits",
};
const LEGACY_THINKING: Record<string, string> = { ultrathink: "ultra" };

export interface ProfileVocabularyChange { profileId: string; field: string; from: unknown; to: unknown }
export interface ProfileVocabularyUnknown { profileId: string; field: string; value: unknown }
export interface ProfileVocabularyMigration { at: string; changes: ProfileVocabularyChange[]; unknown: ProfileVocabularyUnknown[] }

type Raw = Record<string, unknown>;

/** One stored profile in canonical values, with what changed and what this table doesn't know. */
export function canonicalProfile(raw: Raw): { profile: Raw; changes: ProfileVocabularyChange[]; unknown: ProfileVocabularyUnknown[] } {
  const profileId = typeof raw.id === "string" ? raw.id : "";
  const next: Raw = { ...raw };
  const changes: ProfileVocabularyChange[] = [], unknown: ProfileVocabularyUnknown[] = [];
  const set = (field: string, to: unknown) => { changes.push({ profileId, field, from: raw[field], to }); if (to === undefined) delete next[field]; else next[field] = to; };
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
    if (LEGACY_THINKING[thinking]) set("thinkingOptionId", LEGACY_THINKING[thinking]);
    else unknown.push({ profileId, field: "thinkingOptionId", value: thinking });
  }
  // Paseo carried Grok's full access as its `auto_accept` option; the canonical
  // profile names the mode, and Paseo's table carries it back as the option.
  const features = raw.featureValues && typeof raw.featureValues === "object" ? raw.featureValues as Raw : null;
  if (next.provider === "grok" && features && "auto_accept" in features) {
    const value = features.auto_accept;
    if (typeof value !== "boolean" || typeof raw.modeId === "string") unknown.push({ profileId, field: "featureValues.auto_accept", value });
    else {
      const { auto_accept: _dropped, ...rest } = features;
      set("modeId", value ? "full-access" : "supervised");
      set("featureValues", Object.keys(rest).length ? rest : undefined);
    }
  }
  // Retired with the per-profile host mapping (nucleus#1151); no live profile has one.
  if ("hosts" in raw) unknown.push({ profileId, field: "hosts", value: raw.hosts });
  return unknown.length ? { profile: raw, changes: [], unknown } : { profile: next, changes, unknown };
}

/** Every stored profile in canonical values, and the record of the run. */
export function migrateProfileVocabulary(stored: readonly unknown[], at = new Date().toISOString()): { profiles: unknown[]; record: ProfileVocabularyMigration } {
  const record: ProfileVocabularyMigration = { at, changes: [], unknown: [] };
  const profiles = stored.map(raw => {
    if (!raw || typeof raw !== "object") return raw;
    const answer = canonicalProfile(raw as Raw);
    record.changes.push(...answer.changes);
    record.unknown.push(...answer.unknown);
    return answer.profile;
  });
  return { profiles, record };
}
