import type { HostCatalog, HostFeature, HostModel, HostProvider } from "./host";
import type { HostKind } from "./host-kind";

/**
 * Nucleus's one profile vocabulary (Tom, 2026-11-12: "hard code the mapping that
 * each host gives to each provider and have them converge on one canonical corpus
 * that we use in the settings form"). Profiles store only these values. Each host
 * adapter owns one translation table (`HostVocabulary`) from this corpus to its own
 * spellings; nothing is configured per profile and nothing is guessed.
 *
 * Models are the provider's own model ids, which hosts share. Feature values are
 * the provider's own option ids, passed through unchanged, except the options a
 * host table uses to carry a thinking level or a runtime mode.
 */
export const CANONICAL_PROVIDERS = [
  "codex", "claude", "pi", "grok", "cursor", "opencode", "copilot", "omp", "antigravity", "muse", "fx", "kiro",
] as const;
export type CanonicalProvider = (typeof CANONICAL_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<CanonicalProvider, string> = {
  codex: "Codex", claude: "Claude", pi: "Pi", grok: "Grok", cursor: "Cursor", opencode: "OpenCode",
  copilot: "Copilot", omp: "OMP", antigravity: "Antigravity", muse: "Muse", fx: "FX", kiro: "Kiro",
};

/** One ordered thinking scale, lowest first. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra",
};

/** Runtime modes, strictest first; `full-access` is the unattended run. */
export const RUNTIME_MODES = ["plan", "supervised", "accept-edits", "auto", "auto-review", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, { label: string; description: string }> = {
  plan: { label: "Plan", description: "Plans only; no edits or commands." },
  supervised: { label: "Supervised", description: "Asks before commands and file changes." },
  "accept-edits": { label: "Accept edits", description: "Approves edits, asks before other actions." },
  auto: { label: "Auto", description: "The provider approves routine actions; others still ask." },
  "auto-review": { label: "Auto review", description: "A reviewer model approves actions instead of asking." },
  "full-access": { label: "Full access", description: "Commands and edits run without prompts." },
};

export const isCanonicalProvider = (value: string): value is CanonicalProvider => (CANONICAL_PROVIDERS as readonly string[]).includes(value);
export const isThinkingLevel = (value: string): value is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(value);
export const isRuntimeMode = (value: string): value is RuntimeMode => (RUNTIME_MODES as readonly string[]).includes(value);

/** How a host carries one canonical runtime mode: its own mode id, or option values. */
export type NativeMode = { modeId: string } | { featureValues: Record<string, unknown> };

/** One canonical provider on one host. */
export interface ProviderTranslation {
  /** The host's own provider key. */
  key: string;
  /** The model option that carries the thinking level on this host; absent means the host's thinking option. */
  thinkingOption?: string;
  /** Canonical level → the host's value. A level with no entry can't be expressed here. */
  thinking: Partial<Record<ThinkingLevel, string>>;
  /** Canonical mode → how the host carries it. A mode with no entry can't be expressed here. */
  modes: Partial<Record<RuntimeMode, NativeMode>>;
}

/** One host kind's translation table, owned by that host's adapter code. */
export interface HostVocabulary {
  kind: HostKind;
  label: string;
  providers: Partial<Record<CanonicalProvider, ProviderTranslation>>;
}

/** The canonical fields a profile carries. */
export interface CanonicalValues {
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

/** What a launch on one host sends, in that host's own spelling. */
export interface LaunchValues {
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export type Translation =
  | { ok: true; launch: LaunchValues; translated: string[] }
  | { ok: false; reason: string; launch: LaunchValues };

/** Option ids the table itself uses for one provider; a profile can't set them directly. */
function ownedOptions(entry: ProviderTranslation): Set<string> {
  const owned = new Set<string>();
  if (entry.thinkingOption) owned.add(entry.thinkingOption);
  for (const mode of Object.values(entry.modes)) if (mode && "featureValues" in mode) for (const key of Object.keys(mode.featureValues)) owned.add(key);
  return owned;
}

/**
 * Translate canonical profile values to one host's launch values with its table.
 * A value the table can't express answers a reason naming the host and the value;
 * the launch then carries the canonical values so a reader still sees the profile.
 */
export function translateProfile(vocabulary: HostVocabulary, profile: CanonicalValues): Translation {
  const label = vocabulary.label;
  const fallback: LaunchValues = {
    provider: profile.provider, model: profile.model,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    ...(profile.featureValues && Object.keys(profile.featureValues).length ? { featureValues: profile.featureValues } : {}),
  };
  const refuse = (reason: string): Translation => ({ ok: false, reason, launch: fallback });
  if (!isCanonicalProvider(profile.provider)) return refuse(`Provider ${profile.provider} is not in Nucleus's vocabulary`);
  const entry = vocabulary.providers[profile.provider];
  if (!entry) return refuse(`${label} has no ${profile.provider} provider`);
  const translated: string[] = [];
  const launch: LaunchValues = { provider: entry.key, model: profile.model };
  if (entry.key !== profile.provider) translated.push("provider");
  const features: Record<string, unknown> = {};
  const owned = ownedOptions(entry);
  for (const [option, value] of Object.entries(profile.featureValues ?? {})) {
    if (owned.has(option)) return refuse(`Option ${option} is how ${label} carries a thinking level or mode; set those instead`);
    features[option] = value;
  }
  if (profile.thinkingOptionId) {
    const level = profile.thinkingOptionId;
    if (!isThinkingLevel(level)) return refuse(`Thinking level ${level} is not in Nucleus's vocabulary`);
    const value = entry.thinking[level];
    if (value === undefined) return refuse(`${label} can't express thinking level ${level} for ${profile.provider}`);
    if (entry.thinkingOption) { features[entry.thinkingOption] = value; translated.push("thinking"); }
    else { launch.thinkingOptionId = value; if (value !== level) translated.push("thinking"); }
  }
  if (profile.modeId) {
    const mode = profile.modeId;
    if (!isRuntimeMode(mode)) return refuse(`Runtime mode ${mode} is not in Nucleus's vocabulary`);
    const native = entry.modes[mode];
    if (!native) return refuse(`${label} can't run ${profile.provider} in mode ${mode}`);
    if ("modeId" in native) { launch.modeId = native.modeId; if (native.modeId !== mode) translated.push("mode"); }
    else { Object.assign(features, native.featureValues); translated.push("mode"); }
  }
  if (Object.keys(features).length) launch.featureValues = features;
  return { ok: true, launch, translated };
}

const hasOption = (feature: HostFeature | undefined, value: string) =>
  feature?.type === "select" && feature.options.some(option => option.id === value);

/**
 * The canonical thinking levels one provider's model on this host can express:
 * the table's level for it and the host's own option for it. A provider whose
 * table carries its thinking as an option value (T3's claude `effort`) reports
 * them from that option, so a caller that only reads the routing snapshot still
 * sees the levels this host really runs (nucleus#1169).
 */
export function canonicalThinkingLevels(entry: ProviderTranslation, model: HostModel): ThinkingLevel[] {
  const carrier = entry.thinkingOption ? model.features.find(feature => feature.id === entry.thinkingOption) : undefined;
  return THINKING_LEVELS.filter(level => {
    const value = entry.thinking[level];
    return value !== undefined && (entry.thinkingOption ? hasOption(carrier, value) : model.thinkingOptions.some(option => option.id === value));
  });
}

/**
 * One host's catalog in canonical values: only the providers its table names,
 * and per model only the thinking levels and modes the table can express and
 * the host reports. Options a table uses to carry thinking or a mode are left
 * out of the features. Settings builds its dropdowns from these.
 */
export function canonicalCatalog(vocabulary: HostVocabulary, catalog: HostCatalog): HostCatalog {
  const providers: HostProvider[] = [];
  for (const canonical of CANONICAL_PROVIDERS) {
    const entry = vocabulary.providers[canonical];
    const native = entry && catalog.providers.find(candidate => candidate.key === entry.key);
    if (!entry || !native) continue;
    const owned = ownedOptions(entry);
    providers.push({
      key: canonical, label: PROVIDER_LABELS[canonical], available: native.available, problem: native.problem,
      models: native.models.map((model): HostModel => {
        const carrier = entry.thinkingOption ? model.features.find(feature => feature.id === entry.thinkingOption) : undefined;
        const levels = canonicalThinkingLevels(entry, model);
        const nativeDefault = entry.thinkingOption
          ? (carrier?.type === "select" ? carrier.options.find(option => option.isDefault)?.id ?? (typeof carrier.value === "string" ? carrier.value : null) : null)
          : model.defaultThinkingOptionId;
        const defaultLevel = levels.find(level => entry.thinking[level] === nativeDefault) ?? null;
        const modes = RUNTIME_MODES.filter(mode => {
          const value = entry.modes[mode];
          if (!value) return false;
          if ("modeId" in value) return model.modes.some(candidate => candidate.id === value.modeId);
          return catalog.featuresDeferred === true || Object.keys(value.featureValues).every(key => model.features.some(feature => feature.id === key));
        });
        return {
          id: model.id, label: model.label, aliases: model.aliases,
          thinkingOptions: levels.map(level => ({ id: level, label: THINKING_LABELS[level] })),
          defaultThinkingOptionId: defaultLevel,
          modes: modes.map(mode => ({ id: mode, ...RUNTIME_MODE_LABELS[mode] })),
          features: model.features.filter(feature => !owned.has(feature.id)),
        };
      }),
    });
  }
  return { providers, ...(catalog.featuresDeferred ? { featuresDeferred: true } : {}) };
}

/**
 * Several hosts' canonical catalogs as one: a provider, model, level or mode at
 * least one host can run. A provider is available when any host has it ready.
 */
export function mergeCanonicalCatalogs(catalogs: readonly HostCatalog[]): HostCatalog {
  const providers: HostProvider[] = [];
  for (const catalog of catalogs)
    for (const provider of catalog.providers) {
      const current = providers.find(candidate => candidate.key === provider.key);
      if (!current) { providers.push({ ...provider, models: provider.models.map(model => ({ ...model })) }); continue; }
      if (!current.available && provider.available) { current.available = true; current.problem = ""; }
      for (const model of provider.models) {
        const known = current.models.find(candidate => candidate.id === model.id);
        if (!known) { current.models.push({ ...model }); continue; }
        known.thinkingOptions = THINKING_LEVELS.filter(level => known.thinkingOptions.some(option => option.id === level) || model.thinkingOptions.some(option => option.id === level))
          .map(level => ({ id: level, label: THINKING_LABELS[level] }));
        known.defaultThinkingOptionId ??= model.defaultThinkingOptionId;
        known.modes = RUNTIME_MODES.filter(mode => known.modes.some(item => item.id === mode) || model.modes.some(item => item.id === mode))
          .map(mode => ({ id: mode, ...RUNTIME_MODE_LABELS[mode] }));
        known.features = [...known.features, ...model.features.filter(feature => !known.features.some(item => item.id === feature.id))];
        known.aliases = [...new Set([...known.aliases, ...model.aliases])];
      }
    }
  const deferred = catalogs.some(catalog => catalog.featuresDeferred);
  return { providers, ...(deferred ? { featuresDeferred: true } : {}) };
}

/** Each canonical level spelled the same on the host. */
export const sameLevels = (...levels: ThinkingLevel[]): Partial<Record<ThinkingLevel, string>> =>
  Object.fromEntries(levels.map(level => [level, level]));

/**
 * The table of a host that speaks the canonical vocabulary as it is. Only for an
 * adapter that carries no table of its own (test doubles); Paseo and T3Code each
 * own an explicit table.
 */
export function canonicalVocabulary(kind: HostKind, label: string): HostVocabulary {
  const entry = (key: string): ProviderTranslation => ({
    key, thinking: sameLevels(...THINKING_LEVELS),
    modes: Object.fromEntries(RUNTIME_MODES.map(mode => [mode, { modeId: mode }])),
  });
  return { kind, label, providers: Object.fromEntries(CANONICAL_PROVIDERS.map(key => [key, entry(key)])) };
}
