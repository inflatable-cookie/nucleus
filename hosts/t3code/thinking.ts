import { z } from "zod";
import {
  THINKING_LEVELS,
  THINKING_LABELS,
  canonicalThinkingValue,
  isThinkingLevel,
  type ProviderTranslation,
  type ThinkingLevel,
} from "../../shared/profile-vocabulary";
import { optionDescriptor, type config } from "./config";
import { t3codeVocabulary } from "./vocabulary";

/**
 * One model's thinking carrier, decided once (nucleus#1375).
 *
 * Selection and the pre-send fence both ask this module the same question about
 * the same `server.getConfig` model entry, so a profile selection kept is never
 * refused by the fence. Nucleus#1364's pilot failed because the nested launch
 * judged a codex profile's options against the *parent* provider's model entry
 * (the `nucleus` ACP model, which reports no options at all), and because a
 * snapshot read while a provider re-probes was treated as a settled absence.
 *
 * The rules come from T3's own client (`reasoningEffort`, `effort`, `reasoning`,
 * `variant`, `reasoning_effort`, `thinking_level`, `thinking`, or a select the
 * provider marks `role: "reasoning"`), and from the nightly's own provider
 * contract: `status` is one of `ready | warning | error | disabled`, and a model
 * may report `capabilities: null` until its options are known.
 */
export type Descriptor = z.infer<typeof optionDescriptor>;
export type SelectDescriptor = Extract<Descriptor, { type: "select" }>;
export type ConfigProvider = z.infer<typeof config>["providers"][number];
export type ConfigModel = ConfigProvider["models"][number];
/** One canonical level and the native value this model's carrier offers for it. */
export type OfferedLevel = { level: ThinkingLevel; value: string };

/**
 * Whether a descriptor is a provider's own thought-level control: a select with
 * `role: "reasoning"`, or one of the option ids T3's own client reads a level
 * from. The id list is the host table's (`vocabulary.thinkingSelects`), so the
 * catalog, the editor and the fence agree on which option carries the level.
 */
export const isReasoningDescriptor = (
  descriptor: Descriptor,
): descriptor is SelectDescriptor =>
  descriptor.type === "select" &&
  (descriptor.role === "reasoning" ||
    (t3codeVocabulary.thinkingSelects ?? []).includes(descriptor.id));

/**
 * A model's real option descriptors as one line (id, type, role), for a refusal
 * or a diagnostic. A model that reports none says so plainly; the placeholder
 * "reasoning option" is never the whole answer (nucleus#1375).
 */
export const descriptorSummary = (
  descriptors: readonly Descriptor[],
): string =>
  descriptors.length
    ? descriptors
        .map(
          (descriptor) =>
            `${descriptor.id}:${descriptor.type}${
              descriptor.type === "select" && descriptor.role
                ? `:${descriptor.role}`
                : ""
            }`,
        )
        .join(", ")
    : "none";

/** The model's own descriptors, as the nightly reports them (absent or null is none). */
export const modelDescriptors = (model: ConfigModel): readonly Descriptor[] =>
  model.capabilities?.optionDescriptors ?? [];

/** Whether this provider instance reports any model option at all. */
export const providerReportsOptions = (provider: ConfigProvider): boolean =>
  provider.models.some((model) => modelDescriptors(model).length > 0);

/**
 * One model's thinking carrier on this provider, or why there is none yet:
 * - `carrier`: the select that carries the level, with the canonical levels it
 *   offers (a level the table can't spell is not offered);
 * - `unsettled`: the snapshot cannot answer yet — the provider is still probing,
 *   or it reports no model options at all — so a launch waits for a settled
 *   snapshot instead of refusing;
 * - `absent`: the settled snapshot reports other options and no carrier, so a
 *   launch is refused naming the real descriptors.
 */
export type ModelThinking =
  | {
      state: "carrier";
      carrier: SelectDescriptor;
      offered: readonly OfferedLevel[];
    }
  | { state: "unsettled"; detail: string }
  | {
      state: "absent";
      detail: string;
      /** What the settled snapshot really reported, for the refusal. */
      descriptors: readonly Descriptor[];
    };

/** The canonical level and native value the table reads from one carrier choice. */
const levelOf = (
  translation: ProviderTranslation | undefined,
  value: string,
): ThinkingLevel | null =>
  translation
    ? canonicalThinkingValue(translation, value)
    : isThinkingLevel(value)
      ? value
      : null;

export const offeredLevels = (
  translation: ProviderTranslation | undefined,
  carrier: SelectDescriptor,
): readonly OfferedLevel[] =>
  carrier.options.flatMap((choice) => {
    const level = levelOf(translation, choice.id);
    return level ? [{ level, value: choice.id }] : [];
  });

/** The canonical levels this model's carrier offers, lowest first. */
export const offeredThinkingLevels = (
  translation: ProviderTranslation | undefined,
  carrier: SelectDescriptor,
): readonly ThinkingLevel[] =>
  THINKING_LEVELS.filter((level) =>
    offeredLevels(translation, carrier).some(
      (option) => option.level === level,
    ),
  );

/**
 * This provider's thinking carrier for one model. The table's own `thinkingOption`
 * wins when the model reports it (Pi's `thinking`, Claude's and FX's `effort`);
 * every other provider rides T3's own reasoning select.
 */
export function t3ModelThinking(
  provider: ConfigProvider,
  model: ConfigModel,
  translation: ProviderTranslation | undefined,
): ModelThinking {
  const descriptors = modelDescriptors(model);
  const carrier =
    (translation?.thinkingOption
      ? descriptors.find(
          (descriptor) =>
            descriptor.id === translation.thinkingOption &&
            descriptor.type === "select",
        )
      : undefined) ?? descriptors.find(
      (descriptor) =>
        isReasoningDescriptor(descriptor) &&
        (descriptor.role === "reasoning" || offeredLevels(translation, descriptor).length > 0),
    );
  if (carrier && carrier.type === "select")
    return {
      state: "carrier",
      carrier,
      offered: offeredLevels(translation, carrier),
    };
  // No carrier in this model's own list. A provider that is not ready, or that
  // reports no options on any model, is mid-probe: T3's initial snapshots report
  // `status: "warning"` with no descriptors until the provider answers.
  if (provider.status !== "ready")
    return {
      state: "unsettled",
      detail: `T3Code provider ${provider.instanceId} has not settled its probe (status ${provider.status})`,
    };
  if (!providerReportsOptions(provider))
    return {
      state: "unsettled",
      detail: `T3Code provider ${provider.instanceId} reports no model options yet`,
    };
  return {
    state: "absent",
    detail: `T3Code model ${model.slug} reports no thinking carrier; its option descriptors are ${descriptorSummary(descriptors)}`,
    descriptors,
  };
}

/**
 * The levels a model can express before its own carrier is known: the table's
 * levels for its provider. Used only while the snapshot is unsettled, so
 * selection keeps a profile the fence will wait for instead of parking it as
 * unsupported; once the provider settles, the carrier's real levels replace them.
 */
export const tableThinkingLevels = (
  translation: ProviderTranslation | undefined,
): readonly { level: ThinkingLevel; value: string }[] =>
  THINKING_LEVELS.flatMap((level) => {
    const value = translation?.thinking[level];
    return value ? [{ level, value }] : [];
  });

/** The canonical level labels one unsettled model publishes (native values). */
export const tableThinkingOptions = (
  translation: ProviderTranslation | undefined,
): { id: string; label: string }[] =>
  tableThinkingLevels(translation).map(({ level, value }) => ({
    id: value,
    label: THINKING_LABELS[level],
  }));

/** Every descriptor this provider instance reports, for the `service.health` line. */
export const providerModelShapes = (provider: ConfigProvider): string => {
  const models = provider.models.slice(0, 8);
  const more =
    provider.models.length > models.length
      ? `; +${provider.models.length - models.length} more models`
      : "";
  return `${provider.instanceId}(${provider.status}): ${models
    .map(
      (model) =>
        `${model.slug} [${descriptorSummary(modelDescriptors(model))}]`,
    )
    .join("; ")}${more}`;
};
