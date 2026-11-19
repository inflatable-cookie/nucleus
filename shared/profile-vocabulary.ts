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
 * host table uses to carry a thinking level, a runtime mode or a canonical
 * option (`speed`, nucleus#1386).
 */
export const CANONICAL_PROVIDERS = [
  "codex",
  "claude",
  "pi",
  "grok",
  "cursor",
  "opencode",
  "copilot",
  "omp",
  "antigravity",
  "muse",
  "fx",
  "kiro",
] as const;
export type CanonicalProvider = (typeof CANONICAL_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<CanonicalProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  pi: "Pi",
  grok: "Grok",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "Copilot",
  omp: "OMP",
  antigravity: "Antigravity",
  muse: "Muse",
  fx: "FX",
  kiro: "Kiro",
};

/** One ordered thinking scale, lowest first. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

/** Runtime modes, strictest first; `full-access` is the unattended run. */
export const RUNTIME_MODES = [
  "plan",
  "supervised",
  "accept-edits",
  "auto",
  "auto-review",
  "full-access",
] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_MODE_LABELS: Record<
  RuntimeMode,
  { label: string; description: string }
> = {
  plan: { label: "Plan", description: "Plans only; no edits or commands." },
  supervised: {
    label: "Supervised",
    description: "Asks before commands and file changes.",
  },
  "accept-edits": {
    label: "Accept edits",
    description: "Approves edits, asks before other actions.",
  },
  auto: {
    label: "Auto",
    description: "The provider approves routine actions; others still ask.",
  },
  "auto-review": {
    label: "Auto review",
    description: "A reviewer model approves actions instead of asking.",
  },
  "full-access": {
    label: "Full access",
    description: "Commands and edits run without prompts.",
  },
};

/**
 * Provider options under one canonical key and value set (nucleus#1386). A
 * profile stores the canonical key in `featureValues`; each host table spells it
 * its own way, or not at all. The default value is the provider's own default,
 * so a profile at the default sends nothing and runs on any host; a non-default
 * value runs only on a host whose table carries it.
 *
 * - `speed`: Paseo's codex `service_tier` and claude `fast_mode`, T3's codex
 *   `serviceTier` and claude `fastMode` — one setting under four names.
 * - `plan-mode`: Paseo's codex `plan_mode` toggle; T3 has no such option.
 * - `cyber-access`: T3's codex `cyberAccessProgram`; Paseo has no such option.
 * - `ultracode`: T3's claude `ultracode` toggle; Paseo has no such option.
 *
 * The host-only options are here for their defaults: a profile written on one
 * host stores every option that host offers, and its defaults must not make the
 * profile ineligible on a host that lacks the option.
 */
export const CANONICAL_OPTIONS = [
  "speed",
  "plan-mode",
  "cyber-access",
  "ultracode",
] as const;
export type CanonicalOption = (typeof CANONICAL_OPTIONS)[number];

export interface CanonicalOptionDefinition {
  label: string;
  description: string;
  /** The canonical values, in display order. */
  values: readonly string[];
  /** The provider's own default: never sent, and every host can run it. */
  defaultValue: string;
  valueLabels: Record<string, string>;
}

const onOff = (label: string, description: string): CanonicalOptionDefinition => ({
  label,
  description,
  values: ["off", "on"],
  defaultValue: "off",
  valueLabels: { off: "Off", on: "On" },
});

export const CANONICAL_OPTION_DEFINITIONS: Record<
  CanonicalOption,
  CanonicalOptionDefinition
> = {
  speed: {
    label: "Speed",
    description: "Processing speed. Faster tiers use more of the subscription.",
    values: ["default", "priority", "ultrafast"],
    defaultValue: "default",
    valueLabels: { default: "Normal", priority: "Fast", ultrafast: "Ultrafast" },
  },
  "plan-mode": onOff("Plan mode", "Planning-only collaboration mode."),
  "cyber-access": {
    label: "Cyber access",
    description: "The provider's cyber access program.",
    values: ["standard"],
    defaultValue: "standard",
    valueLabels: { standard: "Standard" },
  },
  ultracode: onOff("Ultracode", "The provider's extended coding mode."),
};

export const isCanonicalOption = (value: string): value is CanonicalOption =>
  (CANONICAL_OPTIONS as readonly string[]).includes(value);

/** A canonical option value in the operator's words. */
export const canonicalOptionValueLabel = (
  option: CanonicalOption,
  value: unknown,
): string =>
  CANONICAL_OPTION_DEFINITIONS[option].valueLabels[String(value)] ??
  String(value);

export const isCanonicalProvider = (
  value: string,
): value is CanonicalProvider =>
  (CANONICAL_PROVIDERS as readonly string[]).includes(value);
export const isThinkingLevel = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);
export const isRuntimeMode = (value: string): value is RuntimeMode =>
  (RUNTIME_MODES as readonly string[]).includes(value);

/** How a host carries one canonical runtime mode: its own mode id, or option values. */
export type NativeMode =
  | { modeId: string }
  | { featureValues: Record<string, unknown> };

/**
 * How one host carries one canonical option for one provider: its own option id,
 * and each canonical value's spelling there (a select's choice id, or a toggle's
 * boolean). A value with no entry can't be expressed on this host.
 */
export interface OptionTranslation {
  id: string;
  values: Partial<Record<string, string | boolean>>;
}

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
  /** Canonical option → how the host carries it. An option with no entry runs only at its default here. */
  options?: Partial<Record<CanonicalOption, OptionTranslation>>;
}

/** One host kind's translation table, owned by that host's adapter code. */
export interface HostVocabulary {
  kind: HostKind;
  label: string;
  providers: Partial<Record<CanonicalProvider, ProviderTranslation>>;
  /**
   * Option ids this host uses as a model's own thinking select when a provider
   * names no `thinkingOption` (T3's `reasoningEffort`). Like a `thinkingOption`,
   * they carry the thinking level: a profile never sets them and the editor never
   * shows them as a feature (nucleus#1365).
   */
  thinkingSelects?: readonly string[];
}

/**
 * The option ids that carry one provider's thinking level on one host: the
 * table's `thinkingOption`, else the host's own thinking selects. A profile
 * stores the level once, as `thinkingOptionId`; these never appear as features.
 */
export function thinkingCarriers(
  vocabulary: HostVocabulary,
  entry: ProviderTranslation,
): readonly string[] {
  return entry.thinkingOption
    ? [entry.thinkingOption]
    : (vocabulary.thinkingSelects ?? []);
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

/** Option ids the table itself uses for one provider's thinking, mode or canonical options; a profile can't set them directly. */
export function ownedOptions(
  vocabulary: HostVocabulary,
  entry: ProviderTranslation,
): Set<string> {
  const owned = new Set<string>(thinkingCarriers(vocabulary, entry));
  for (const mode of Object.values(entry.modes))
    if (mode && "featureValues" in mode)
      for (const key of Object.keys(mode.featureValues)) owned.add(key);
  for (const carrier of Object.values(entry.options ?? {}))
    if (carrier) owned.add(carrier.id);
  return owned;
}

/** The canonical option one host option id carries for this provider, or null. */
export function optionCarriedBy(
  entry: ProviderTranslation,
  id: string,
): CanonicalOption | null {
  return (
    CANONICAL_OPTIONS.find((option) => entry.options?.[option]?.id === id) ??
    null
  );
}

/**
 * The canonical value one host's own value spells for one option, read from the
 * table's inverse entry; `null` when the table carries no value for it.
 */
export function canonicalOptionValue(
  carrier: OptionTranslation,
  option: CanonicalOption,
  value: unknown,
): string | null {
  return (
    CANONICAL_OPTION_DEFINITIONS[option].values.find(
      (candidate) => carrier.values[candidate] === value,
    ) ?? null
  );
}

/**
 * Translate canonical profile values to one host's launch values with its table.
 * A value the table can't express answers a reason naming the host and the value;
 * the launch then carries the canonical values so a reader still sees the profile.
 */
export function translateProfile(
  vocabulary: HostVocabulary,
  profile: CanonicalValues,
): Translation {
  const label = vocabulary.label;
  const fallback: LaunchValues = {
    provider: profile.provider,
    model: profile.model,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.thinkingOptionId
      ? { thinkingOptionId: profile.thinkingOptionId }
      : {}),
    ...(profile.featureValues && Object.keys(profile.featureValues).length
      ? { featureValues: profile.featureValues }
      : {}),
  };
  const refuse = (reason: string): Translation => ({
    ok: false,
    reason,
    launch: fallback,
  });
  if (!isCanonicalProvider(profile.provider))
    return refuse(
      `Provider ${profile.provider} is not in Nucleus's vocabulary`,
    );
  const entry = vocabulary.providers[profile.provider];
  if (!entry) return refuse(`${label} has no ${profile.provider} provider`);
  const translated: string[] = [];
  const launch: LaunchValues = { provider: entry.key, model: profile.model };
  if (entry.key !== profile.provider) translated.push("provider");
  const features: Record<string, unknown> = {};
  const owned = ownedOptions(vocabulary, entry);
  for (const [option, value] of Object.entries(profile.featureValues ?? {})) {
    if (isCanonicalOption(option)) {
      const definition = CANONICAL_OPTION_DEFINITIONS[option];
      // Unset (the editor's Host default) is the provider's default too.
      if (value === null || value === undefined) continue;
      if (typeof value !== "string" || !definition.values.includes(value))
        return refuse(
          `${definition.label} ${String(value)} is not in Nucleus's vocabulary`,
        );
      // The provider's default needs no option: it is never sent, so a host
      // that lacks the option still runs the profile (nucleus#1386).
      if (value === definition.defaultValue) continue;
      const carrier = entry.options?.[option];
      const native = carrier?.values[value];
      if (!carrier || native === undefined)
        return refuse(
          `${label} can't express ${definition.label.toLowerCase()} ${canonicalOptionValueLabel(option, value)} for ${profile.provider}`,
        );
      features[carrier.id] = native;
      translated.push(option);
      continue;
    }
    if (owned.has(option)) {
      const carried = optionCarriedBy(entry, option);
      return refuse(
        carried
          ? `Option ${option} is how ${label} carries ${CANONICAL_OPTION_DEFINITIONS[carried].label}; set ${CANONICAL_OPTION_DEFINITIONS[carried].label} instead`
          : `Option ${option} is how ${label} carries a thinking level or mode; set those instead`,
      );
    }
    features[option] = value;
  }
  if (profile.thinkingOptionId) {
    const level = profile.thinkingOptionId;
    if (!isThinkingLevel(level))
      return refuse(`Thinking level ${level} is not in Nucleus's vocabulary`);
    const value = entry.thinking[level];
    if (value === undefined)
      return refuse(
        `${label} can't express thinking level ${level} for ${profile.provider}`,
      );
    if (entry.thinkingOption) {
      features[entry.thinkingOption] = value;
      translated.push("thinking");
    } else {
      launch.thinkingOptionId = value;
      if (value !== level) translated.push("thinking");
    }
  }
  if (profile.modeId) {
    const mode = profile.modeId;
    if (!isRuntimeMode(mode))
      return refuse(`Runtime mode ${mode} is not in Nucleus's vocabulary`);
    const native = entry.modes[mode];
    if (!native)
      return refuse(`${label} can't run ${profile.provider} in mode ${mode}`);
    if ("modeId" in native) {
      launch.modeId = native.modeId;
      if (native.modeId !== mode) translated.push("mode");
    } else {
      Object.assign(features, native.featureValues);
      translated.push("mode");
    }
  }
  if (Object.keys(features).length) launch.featureValues = features;
  return { ok: true, launch, translated };
}

const hasOption = (feature: HostFeature | undefined, value: string) =>
  feature?.type === "select" &&
  feature.options.some((option) => option.id === value);

/**
 * The canonical thinking levels one provider's model on this host can express:
 * the table's level for it and the host's own option for it. A provider whose
 * table carries its thinking as an option value (T3's claude `effort`) reports
 * them from that option when the host publishes it as a feature, and from the
 * model's own thinking options when the host publishes that same option as the
 * reasoning carrier (nucleus#1375); either way a caller that only reads the
 * routing snapshot sees the levels this host really runs (nucleus#1169).
 */
export function canonicalThinkingLevels(
  entry: ProviderTranslation,
  model: HostModel,
): ThinkingLevel[] {
  const carrier = entry.thinkingOption
    ? model.features.find((feature) => feature.id === entry.thinkingOption)
    : undefined;
  return THINKING_LEVELS.filter((level) => {
    const value = entry.thinking[level];
    return (
      value !== undefined &&
      (carrier
        ? hasOption(carrier, value)
        : model.thinkingOptions.some((option) => option.id === value))
    );
  });
}

/**
 * The canonical level a host's own value spells, for one provider, read from the
 * table's inverse entry. A value the table carries no level for is `null`, never
 * a guess: the table is the whole contract for what a host can express.
 */
export function canonicalThinkingValue(
  entry: ProviderTranslation,
  value: string,
): ThinkingLevel | null {
  return (
    THINKING_LEVELS.find((candidate) => entry.thinking[candidate] === value) ??
    null
  );
}

/**
 * The canonical level one host's launch values carry, read back through that
 * host's table: the level a routing snapshot or a host read spells its own way
 * (T3's claude `effort: ultrathink`, BB's `none`), for display. `null` when the
 * launch carries no level, or one the table has no level for.
 */
export function launchThinkingLevel(
  vocabulary: HostVocabulary,
  launch: Pick<LaunchValues, "provider" | "thinkingOptionId" | "featureValues">,
): ThinkingLevel | null {
  const entry = Object.values(vocabulary.providers).find(
    (candidate) => candidate?.key === launch.provider,
  );
  if (!entry)
    return launch.thinkingOptionId && isThinkingLevel(launch.thinkingOptionId)
      ? launch.thinkingOptionId
      : null;
  if (launch.thinkingOptionId)
    return canonicalThinkingValue(entry, launch.thinkingOptionId);
  for (const carrier of thinkingCarriers(vocabulary, entry)) {
    const value = launch.featureValues?.[carrier];
    if (typeof value === "string") return canonicalThinkingValue(entry, value);
  }
  return null;
}

/**
 * The nearest level of one ordered scale (Tom, 2026-11-04/12: a host translates
 * the canonical vocabulary in code, so a level a model does not report is
 * settled here instead of at the send). Distance decides; a tie takes the lower
 * level. This thinking-scale rule is distinct from the pool capability-tier
 * rule and may choose a higher supported level when it is closer.
 * `null` when the scale is empty: nothing on this model can carry the level.
 */
export function nearestThinkingLevel(
  supported: readonly ThinkingLevel[],
  level: ThinkingLevel,
): ThinkingLevel | null {
  if (supported.includes(level)) return level;
  const want = THINKING_LEVELS.indexOf(level);
  let best: ThinkingLevel | null = null;
  for (const candidate of supported) {
    const away = Math.abs(THINKING_LEVELS.indexOf(candidate) - want);
    if (
      best === null ||
      away < Math.abs(THINKING_LEVELS.indexOf(best) - want) ||
      (away === Math.abs(THINKING_LEVELS.indexOf(best) - want) &&
        THINKING_LEVELS.indexOf(candidate) < THINKING_LEVELS.indexOf(best))
    )
      best = candidate;
  }
  return best;
}

/**
 * One host's catalog in canonical values: only the providers its table names,
 * and per model only the thinking levels and modes the table can express and
 * the host reports. Options a table uses to carry thinking or a mode are left
 * out of the features. Settings builds its dropdowns from these.
 */
export function canonicalCatalog(
  vocabulary: HostVocabulary,
  catalog: HostCatalog,
): HostCatalog {
  const providers: HostProvider[] = [];
  for (const canonical of CANONICAL_PROVIDERS) {
    const entry = vocabulary.providers[canonical];
    const native =
      entry &&
      catalog.providers.find((candidate) => candidate.key === entry.key);
    if (!entry || !native) continue;
    const owned = ownedOptions(vocabulary, entry);
    providers.push({
      key: canonical,
      label: PROVIDER_LABELS[canonical],
      available: native.available,
      problem: native.problem,
      models: native.models.map((model): HostModel => {
        const carrier = entry.thinkingOption
          ? model.features.find(
              (feature) => feature.id === entry.thinkingOption,
            )
          : undefined;
        const levels = canonicalThinkingLevels(entry, model);
        const nativeDefault = entry.thinkingOption
          ? carrier?.type === "select"
            ? (carrier.options.find((option) => option.isDefault)?.id ??
              (typeof carrier.value === "string" ? carrier.value : null))
            : null
          : model.defaultThinkingOptionId;
        const defaultLevel =
          levels.find((level) => entry.thinking[level] === nativeDefault) ??
          null;
        const modes = RUNTIME_MODES.filter((mode) => {
          const value = entry.modes[mode];
          if (!value) return false;
          if ("modeId" in value)
            return model.modes.some(
              (candidate) => candidate.id === value.modeId,
            );
          return (
            catalog.featuresDeferred === true ||
            Object.keys(value.featureValues).every((key) =>
              model.features.some((feature) => feature.id === key),
            )
          );
        });
        return {
          id: model.id,
          label: model.label,
          aliases: model.aliases,
          thinkingOptions: levels.map((level) => ({
            id: level,
            label: THINKING_LABELS[level],
          })),
          defaultThinkingOptionId: defaultLevel,
          modes: modes.map((mode) => ({
            id: mode,
            ...RUNTIME_MODE_LABELS[mode],
          })),
          features: model.features.flatMap((feature) => {
            const carried = optionCarriedBy(entry, feature.id);
            if (carried) {
              const control = canonicalOptionFeature(
                carried,
                entry.options![carried]!,
                feature,
              );
              return control ? [control] : [];
            }
            return owned.has(feature.id) ? [] : [feature];
          }),
          // A model whose options the host has not settled keeps that fact: its
          // levels are the table's, not a report of absence (nucleus#1375).
          ...(model.unsettled === true ? { unsettled: true } : {}),
        };
      }),
    });
  }
  return {
    providers,
    ...(catalog.featuresDeferred ? { featuresDeferred: true } : {}),
  };
}

/**
 * One host feature that carries a canonical option, as the canonical control:
 * the canonical key and label, and only the values the table spells and the
 * host offers for this model (nucleus#1386). `null` when it offers none.
 */
function canonicalOptionFeature(
  option: CanonicalOption,
  carrier: OptionTranslation,
  feature: HostFeature,
): HostFeature | null {
  const definition = CANONICAL_OPTION_DEFINITIONS[option];
  const values = definition.values.filter((value) => {
    const native = carrier.values[value];
    if (native === undefined) return false;
    return feature.type === "toggle"
      ? typeof native === "boolean"
      : typeof native === "string" &&
          feature.options.some((choice) => choice.id === native);
  });
  if (!values.length) return null;
  const current = canonicalOptionValue(carrier, option, feature.value);
  return {
    type: "select",
    id: option,
    label: definition.label,
    description: definition.description,
    value:
      current && values.includes(current) ? current : definition.defaultValue,
    options: values.map((value) => ({
      id: value,
      label: definition.valueLabels[value] ?? value,
      ...(value === definition.defaultValue ? { isDefault: true } : {}),
    })),
  };
}

/** One canonical option control from several hosts: every value at least one host offers. */
function mergeOptionFeature(known: HostFeature, other: HostFeature): HostFeature {
  if (
    !isCanonicalOption(known.id) ||
    known.type !== "select" ||
    other.type !== "select"
  )
    return known;
  const definition = CANONICAL_OPTION_DEFINITIONS[known.id];
  const ids = new Set([
    ...known.options.map((choice) => choice.id),
    ...other.options.map((choice) => choice.id),
  ]);
  return {
    ...known,
    options: definition.values
      .filter((value) => ids.has(value))
      .map((value) => ({
        id: value,
        label: definition.valueLabels[value] ?? value,
        ...(value === definition.defaultValue ? { isDefault: true } : {}),
      })),
  };
}

/**
 * Several hosts' canonical catalogs as one: a provider, model, level or mode at
 * least one host can run. A provider is available when any host has it ready.
 */
export function mergeCanonicalCatalogs(
  catalogs: readonly HostCatalog[],
): HostCatalog {
  const providers: HostProvider[] = [];
  for (const catalog of catalogs)
    for (const provider of catalog.providers) {
      const current = providers.find(
        (candidate) => candidate.key === provider.key,
      );
      if (!current) {
        providers.push({
          ...provider,
          models: provider.models.map((model) => ({ ...model })),
        });
        continue;
      }
      if (!current.available && provider.available) {
        current.available = true;
        current.problem = "";
      }
      for (const model of provider.models) {
        const known = current.models.find(
          (candidate) => candidate.id === model.id,
        );
        if (!known) {
          current.models.push({ ...model });
          continue;
        }
        known.thinkingOptions = THINKING_LEVELS.filter(
          (level) =>
            known.thinkingOptions.some((option) => option.id === level) ||
            model.thinkingOptions.some((option) => option.id === level),
        ).map((level) => ({ id: level, label: THINKING_LABELS[level] }));
        known.defaultThinkingOptionId ??= model.defaultThinkingOptionId;
        // A model is unsettled only while every host that reports it is: one
        // host's settled report answers for this entry (nucleus#1375).
        if (known.unsettled === true && model.unsettled !== true)
          delete known.unsettled;
        known.modes = RUNTIME_MODES.filter(
          (mode) =>
            known.modes.some((item) => item.id === mode) ||
            model.modes.some((item) => item.id === mode),
        ).map((mode) => ({ id: mode, ...RUNTIME_MODE_LABELS[mode] }));
        known.features = [
          ...known.features.map((feature) => {
            const other = model.features.find((item) => item.id === feature.id);
            return other ? mergeOptionFeature(feature, other) : feature;
          }),
          ...model.features.filter(
            (feature) => !known.features.some((item) => item.id === feature.id),
          ),
        ];
        known.aliases = [...new Set([...known.aliases, ...model.aliases])];
      }
    }
  const deferred = catalogs.some((catalog) => catalog.featuresDeferred);
  return { providers, ...(deferred ? { featuresDeferred: true } : {}) };
}

/** Each canonical level spelled the same on the host. */
export const sameLevels = (
  ...levels: ThinkingLevel[]
): Partial<Record<ThinkingLevel, string>> =>
  Object.fromEntries(levels.map((level) => [level, level]));

/**
 * The table of a host that speaks the canonical vocabulary as it is. Only for an
 * adapter that carries no table of its own (test doubles); Paseo and T3Code each
 * own an explicit table.
 */
export function canonicalVocabulary(
  kind: HostKind,
  label: string,
): HostVocabulary {
  const entry = (key: string): ProviderTranslation => ({
    key,
    thinking: sameLevels(...THINKING_LEVELS),
    modes: Object.fromEntries(
      RUNTIME_MODES.map((mode) => [mode, { modeId: mode }]),
    ),
  });
  return {
    kind,
    label,
    providers: Object.fromEntries(
      CANONICAL_PROVIDERS.map((key) => [key, entry(key)]),
    ),
  };
}
