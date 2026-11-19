import type { HostCatalog, HostFeature, HostModel } from "../../shared/host";
import { liveConfigModels } from "./t3-nightly-config";

/**
 * Paseo's own feature read for codex and claude models (nucleus#1386), copied
 * from the catalog the service stored from its last `providers.listFeatures`
 * read with a project directory (read 2026-11-18). Only the provider, model and
 * feature facts are kept; nothing identifies the host, a project or a person.
 *
 * What the real shape says:
 * - codex reports `service_tier` (labelled Speed: default, priority, ultrafast)
 *   and the `plan_mode` toggle; `gpt-6.1-terra` offers no ultrafast tier.
 * - claude `claude-opus-5-5` reports the `fast_mode` toggle (labelled Fast).
 */
const speed = (ultrafast: boolean): HostFeature => ({
  type: "select",
  id: "service_tier",
  label: "Speed",
  description: "Choose processing speed. Faster tiers increase usage.",
  value: "default",
  options: [
    { id: "default", label: "Normal", isDefault: true },
    { id: "priority", label: "Fast" },
    ...(ultrafast ? [{ id: "ultrafast", label: "Ultrafast" }] : []),
  ],
});
const planMode: HostFeature = {
  type: "toggle",
  id: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  value: false,
};
const fastMode: HostFeature = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  value: false,
};
const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const model = (
  id: string,
  label: string,
  features: HostFeature[],
  thinking: string[],
  modes: string[],
): HostModel => ({
  id,
  label,
  aliases: [],
  thinkingOptions: levels(...thinking),
  defaultThinkingOptionId: null,
  modes: modes.map((mode) => ({ id: mode, label: mode })),
  features,
});
const codexModes = ["auto", "auto-review", "full-access"];
const codexLevels = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const paseoOptionCatalog = (): HostCatalog => ({
  providers: [
    {
      key: "codex",
      label: "Codex",
      available: true,
      problem: "",
      models: [
        model("gpt-6.2-astra", "Astra", [speed(true), planMode], codexLevels, codexModes),
        model("gpt-6.1-terra", "Terra", [speed(false), planMode], codexLevels, codexModes),
      ],
    },
    {
      key: "claude",
      label: "Claude",
      available: true,
      problem: "",
      models: [
        model(
          "claude-opus-5-5",
          "Opus 5.5",
          [fastMode],
          ["low", "medium", "high", "xhigh", "max"],
          ["default", "acceptEdits", "auto", "bypassPermissions", "plan"],
        ),
      ],
    },
  ],
});

/**
 * T3's codex entries with `gpt-6.2-astra` beside them. The capture
 * (`t3-nightly-config.ts`) reports the same `serviceTier` and
 * `cyberAccessProgram` descriptors for every codex model it carries, and the
 * live host reports `gpt-6.2-astra` too (its compatibility row names the model);
 * Astra's entry here is terra's descriptors under Astra's slug, not a new probe.
 */
export const t3ConfigWithAstra = () => {
  const shapes = structuredClone(liveConfigModels);
  const codex = shapes.find((provider) => provider.instanceId === "codex")!;
  const models = codex.models as Array<(typeof codex.models)[number]>;
  const terra = models.find((entry) => entry.slug === "gpt-6.1-terra")!;
  (models as unknown[]).unshift({
    ...structuredClone(terra),
    slug: "gpt-6.2-astra",
    name: "GPT-6.2 Astra",
  });
  return shapes;
};
