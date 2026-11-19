import {
  sameLevels,
  type HostVocabulary,
  type ProviderTranslation,
} from "../../shared/profile-vocabulary";

/**
 * Paseo's spelling of Nucleus's profile vocabulary (Tom, 2026-11-12), read from
 * the daemon's own catalog. Paseo spells providers, models and thinking levels
 * the canonical way. Modes differ by provider: Claude names full access
 * `bypassPermissions` and supervised `default`; Codex names its own three; Grok
 * carries full access as its `auto_accept` option; Pi reports no modes. Claude's
 * `ultracode` level has no canonical twin, so it is not offered.
 *
 * Speed (nucleus#1386) is Codex's `service_tier` select (`default`, `priority`,
 * `ultrafast`, labelled Speed) and Claude's `fast_mode` toggle, as the daemon's
 * own feature read reports them; plan mode is Codex's `plan_mode` toggle.
 */
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
const plain = (key: string): ProviderTranslation => ({
  key,
  thinking: allLevels,
  modes: {},
});

export const paseoVocabulary: HostVocabulary = {
  kind: "paseo",
  label: "Paseo",
  providers: {
    claude: {
      key: "claude",
      thinking: sameLevels(
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ),
      modes: {
        plan: { modeId: "plan" },
        supervised: { modeId: "default" },
        "accept-edits": { modeId: "acceptEdits" },
        auto: { modeId: "auto" },
        "full-access": { modeId: "bypassPermissions" },
      },
      options: {
        speed: { id: "fast_mode", values: { default: false, priority: true } },
      },
    },
    codex: {
      key: "codex",
      thinking: allLevels,
      modes: {
        auto: { modeId: "auto" },
        "auto-review": { modeId: "auto-review" },
        "full-access": { modeId: "full-access" },
      },
      options: {
        speed: {
          id: "service_tier",
          values: {
            default: "default",
            priority: "priority",
            ultrafast: "ultrafast",
          },
        },
        "plan-mode": { id: "plan_mode", values: { off: false, on: true } },
      },
    },
    pi: plain("pi"),
    grok: {
      key: "grok",
      thinking: allLevels,
      modes: {
        supervised: { featureValues: { auto_accept: false } },
        "full-access": { featureValues: { auto_accept: true } },
      },
    },
    cursor: plain("cursor"),
    opencode: plain("opencode"),
    copilot: plain("copilot"),
    omp: plain("omp"),
    antigravity: plain("antigravity"),
    muse: plain("muse"),
  },
};
