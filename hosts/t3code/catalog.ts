import type { z } from "zod";
import type { HostCatalog } from "../../shared/host";
import {
  runtimeModes,
  type configProvider,
  type optionDescriptor,
  type RuntimeMode,
} from "./config";
import {
  modelDescriptors,
  tableThinkingOptions,
  t3ModelThinking,
} from "./thinking";
import { t3codeTranslation } from "./vocabulary";

/**
 * The nightly's own wording for the four runtime modes (installed bundle, client
 * `runtimeModes` table): `Supervised`, `Auto-accept edits`, `Auto`, `Full access`.
 * The catalog reports them so Nucleus's profile editor names the choice the way
 * T3 does.
 */
const runtimeModeLabels: Record<
  RuntimeMode,
  { label: string; description: string }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  auto: {
    label: "Auto",
    description:
      "Supported providers approve routine actions; others still ask.",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
};
/**
 * The runtime modes one provider offers. The nightly omits `supportedRuntimeModes`
 * for a provider with no restriction, and then passes any of the four through;
 * a reported list restricts it, and a request outside it would silently run as
 * `approval-required`, so that list is what the catalog publishes.
 */
export const providerRuntimeModes = (
  supported: readonly RuntimeMode[] | undefined,
): readonly RuntimeMode[] =>
  supported && supported.length ? supported : runtimeModes;
/**
 * T3's `server.getConfig` providers as the host catalog, in T3's own keys. Pure:
 * the TypeScript adapter maps each live read with it, and the Rust engine's
 * board maps the scheduler's cached providers with it (Spec 070 ruling 11).
 */
export function t3HostCatalog(
  providers: readonly z.infer<typeof configProvider>[],
): HostCatalog {
  return {
    providers: providers.map((p) => ({
      key: p.instanceId,
      label: p.displayName ?? p.instanceId,
      available: p.enabled && p.status === "ready",
      problem:
        p.enabled && p.status === "ready"
          ? ""
          : "T3Code provider is unavailable",
      models: p.models.map((m) => {
        const translation = t3codeTranslation(p.instanceId);
        // One decision, shared with the launch fence: the same model entry says
        // which option carries the level (or that the snapshot cannot answer
        // yet). Selection publishes exactly what the fence will send.
        const thinking = t3ModelThinking(p, m, translation);
        // A carrier the table names for the provider (`thinking` for Pi, `effort`
        // for Claude and FX) stays a catalog feature the way it always was; only
        // a generic reasoning select is published as the model's thinking options.
        const reasoning =
          thinking.state === "carrier" &&
          thinking.carrier.id !== translation?.thinkingOption
            ? thinking.carrier
            : undefined;
        const descriptors = modelDescriptors(m);
        const feature = (descriptor: z.infer<typeof optionDescriptor>) =>
          descriptor.type === "boolean"
            ? {
                type: "toggle" as const,
                id: descriptor.id,
                label: descriptor.label,
                ...(descriptor.description
                  ? { description: descriptor.description }
                  : {}),
                value: descriptor.currentValue ?? false,
              }
            : {
                type: "select" as const,
                id: descriptor.id,
                label: descriptor.label,
                ...(descriptor.description
                  ? { description: descriptor.description }
                  : {}),
                value: descriptor.currentValue ?? null,
                options: descriptor.options.map((c) => ({
                  id: c.id,
                  label: c.label,
                  ...(c.description ? { description: c.description } : {}),
                  ...(c.isDefault === undefined
                    ? {}
                    : { isDefault: c.isDefault }),
                })),
              };
        return {
          id: m.slug,
          label: m.name,
          aliases: m.aliases ?? [],
          // A settled carrier publishes its own choices; a snapshot that cannot
          // answer yet publishes the table's levels (for a provider whose level
          // rides the generic reasoning select) and says it is unsettled, so
          // selection keeps the profile the fence will wait for.
          thinkingOptions: reasoning
            ? reasoning.options.map((c) => ({
                id: c.id,
                label: c.label,
                ...(c.isDefault === undefined
                  ? {}
                  : { isDefault: c.isDefault }),
              }))
            : thinking.state === "unsettled" && !translation?.thinkingOption
              ? tableThinkingOptions(translation)
              : [],
          ...(thinking.state === "unsettled" ? { unsettled: true } : {}),
          defaultThinkingOptionId:
            reasoning?.options.find((c) => c.isDefault)?.id ??
            (reasoning?.currentValue &&
            reasoning.options.some((c) => c.id === reasoning.currentValue)
              ? reasoning.currentValue
              : null),
          modes: providerRuntimeModes(p.supportedRuntimeModes).map((id) => ({
            id,
            ...runtimeModeLabels[id],
          })),
          features: descriptors.filter((d) => d !== reasoning).map(feature),
        };
      }),
    })),
  };
}
