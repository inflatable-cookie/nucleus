import {
  sameLevels,
  type HostVocabulary,
  type NativeMode,
  type ProviderTranslation,
  type RuntimeMode,
} from "../../shared/profile-vocabulary";
import type { CanonicalProvider } from "../../shared/profile-vocabulary";

/**
 * T3Code's spelling of Nucleus's profile vocabulary (Tom, 2026-11-12), read from
 * the nightly's `server.getConfig`. T3 names Claude's instance `claudeAgent`; it
 * carries Claude's thinking as the `effort` option (its top level `ultrathink`),
 * Pi's as `thinking` and FX's as `effort`; the rest ride the reasoning option.
 *
 * The reasoning option ids are T3's own: its client reads a level from
 * `reasoningEffort`, `effort`, `reasoning`, `variant`, `reasoning_effort`,
 * `thinking_level` or `thinking`, or from a select the provider marks
 * `role: "reasoning"` (nucleus#1375 read the live client and server). A stock
 * codex model reports `reasoningEffort` with no `role`, which is why the id list
 * — not the role alone — decides. Those ids carry the level and never show as a
 * feature.
 * Its four runtime modes are the same for every provider; a provider that reports
 * a subset narrows them through the catalog.
 *
 * Speed (nucleus#1386) is Codex's `serviceTier` select (`default`, `priority`;
 * the nightly offers no ultrafast tier) and Claude's `fastMode` boolean, as
 * `server.getConfig` reports them. Cyber access is Codex's `cyberAccessProgram`
 * and ultracode is Claude's `ultracode` boolean.
 */
const t3Modes: Partial<Record<RuntimeMode, NativeMode>> = {
  supervised: { modeId: "approval-required" },
  "accept-edits": { modeId: "auto-accept-edits" },
  auto: { modeId: "auto" },
  "full-access": { modeId: "full-access" },
};
const allLevels = sameLevels(
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
);
const reasoning = (key: string): ProviderTranslation => ({
  key,
  thinking: allLevels,
  modes: t3Modes,
});

/**
 * The table entry for one T3 provider instance, by its own key. A routing profile
 * carries the translated instance (`pi`, `claudeAgent`), so a launch translates
 * back to the canonical provider through this lookup rather than guessing.
 */
export const t3codeTranslation = (
  key: string,
): ProviderTranslation | undefined =>
  Object.values(t3codeVocabulary.providers).find(
    (entry) => entry && entry.key === key,
  );

/** The canonical provider one T3 instance id belongs to, or null. */
export const t3codeProviderOf = (key: string): CanonicalProvider | null =>
  (Object.entries(t3codeVocabulary.providers).find(
    ([, entry]) => entry?.key === key,
  )?.[0] as CanonicalProvider | undefined) ?? null;

export const t3codeVocabulary: HostVocabulary = {
  kind: "t3code",
  label: "T3Code",
  thinkingSelects: [
    "reasoningEffort",
    "effort",
    "reasoning",
    "variant",
    "reasoning_effort",
    "thinking_level",
    "thinking",
  ],
  providers: {
    codex: {
      ...reasoning("codex"),
      options: {
        speed: {
          id: "serviceTier",
          values: { default: "default", priority: "priority" },
        },
        "cyber-access": {
          id: "cyberAccessProgram",
          values: { standard: "standard" },
        },
      },
    },
    claude: {
      key: "claudeAgent",
      thinkingOption: "effort",
      thinking: {
        ...sameLevels("low", "medium", "high", "xhigh", "max"),
        ultra: "ultrathink",
      },
      modes: t3Modes,
      options: {
        speed: { id: "fastMode", values: { default: false, priority: true } },
        ultracode: { id: "ultracode", values: { off: false, on: true } },
      },
    },
    pi: {
      key: "pi",
      thinkingOption: "thinking",
      thinking: sameLevels(
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ),
      modes: t3Modes,
    },
    grok: reasoning("grok"),
    fx: {
      key: "fx",
      thinkingOption: "effort",
      thinking: sameLevels("low", "medium", "high", "xhigh", "max"),
      modes: t3Modes,
    },
    cursor: reasoning("cursor"),
    opencode: reasoning("opencode"),
    antigravity: reasoning("antigravity"),
    muse: reasoning("muse"),
    kiro: reasoning("kiro"),
  },
};
