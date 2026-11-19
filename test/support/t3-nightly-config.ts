/**
 * The nightly's own `server.getConfig` shapes (nucleus#1364), read on a private
 * T3 server (`env -i`, scratch `--base-dir`, nightly
 * `0.1.11-nightly.20261118.4890`) driving the provider binaries the operator's
 * machine runs. They are the shapes a launch has to satisfy: Pi reports its
 * thinking as the `thinking` option (Muse 1.3 offers minimal..xhigh, DeepSeek
 * 4.1 Flash only low/high/max), Claude as `effort`, and Codex's reasoning select
 * (`reasoningEffort`) carries low..max for `gpt-6-luna` — no `ultra`.
 *
 * Only provider, model and option facts are kept: the capture carries no server
 * identity, workspace, project or credential.
 */
export const nightlyConfigModels = [
  {
    instanceId: "codex",
    displayName: "codex",
    enabled: true,
    status: "ready",
    models: [
      {
        slug: "gpt-6-luna",
        name: "GPT-6-Luna",
        aliases: [],
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                {
                  id: "low",
                  label: "Low",
                },
                {
                  id: "medium",
                  label: "Medium",
                  isDefault: true,
                },
                {
                  id: "high",
                  label: "High",
                },
                {
                  id: "xhigh",
                  label: "Extra High",
                },
                {
                  id: "max",
                  label: "Max",
                },
              ],
              currentValue: "medium",
            },
            {
              id: "serviceTier",
              label: "Service Tier",
              type: "select",
              options: [
                {
                  id: "default",
                  label: "Standard",
                  isDefault: true,
                },
                {
                  id: "priority",
                  label: "Fast",
                  description: "1.5x speed",
                },
              ],
              currentValue: "default",
            },
            {
              id: "cyberAccessProgram",
              label: "Cyber Access",
              type: "select",
              options: [
                {
                  id: "standard",
                  label: "Standard",
                  isDefault: true,
                },
              ],
              currentValue: "standard",
            },
          ],
        },
      },
    ],
  },
  {
    instanceId: "claudeAgent",
    displayName: "claudeAgent",
    enabled: true,
    status: "ready",
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                {
                  id: "low",
                  label: "Low",
                },
                {
                  id: "medium",
                  label: "Medium",
                  isDefault: true,
                },
                {
                  id: "high",
                  label: "High",
                },
                {
                  id: "xhigh",
                  label: "Extra High",
                },
                {
                  id: "max",
                  label: "Max",
                },
                {
                  id: "ultrathink",
                  label: "Ultrathink",
                },
              ],
              promptInjectedValues: ["ultrathink"],
            },
            {
              id: "ultracode",
              label: "Ultracode",
              type: "boolean",
            },
            {
              id: "fastMode",
              label: "Fast Mode",
              type: "boolean",
            },
          ],
        },
      },
    ],
  },
  {
    instanceId: "pi",
    displayName: "pi",
    enabled: true,
    status: "ready",
    supportedRuntimeModes: [
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ],
    models: [
      {
        slug: "opencode-go/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash 1017",
        aliases: [],
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [
                {
                  id: "low",
                  label: "Low",
                },
                {
                  id: "high",
                  label: "High",
                },
                {
                  id: "max",
                  label: "Max",
                },
              ],
            },
          ],
        },
      },
      {
        slug: "opencode-go/muse-spark-1.3-contributor",
        name: "Muse Spark 1.3 Contributor",
        aliases: [],
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [
                {
                  id: "minimal",
                  label: "Minimal",
                },
                {
                  id: "low",
                  label: "Low",
                },
                {
                  id: "medium",
                  label: "Medium",
                },
                {
                  id: "high",
                  label: "High",
                },
                {
                  id: "xhigh",
                  label: "Extra High",
                },
              ],
            },
          ],
        },
      },
    ],
  },
];
