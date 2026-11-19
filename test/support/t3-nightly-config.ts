/**
 * The nightly's own `server.getConfig` shapes for Tom's live T3 host
 * (nucleus#1375). The codex, pi and claudeAgent entries were compared with
 * the bounded capture from an isolated service runtime's own T3 host read on
 * 2026-11-19; every committed model entry was identical. The nucleus ACP parent
 * entry remains from the earlier ad hoc read-only client and decoder capture.
 * Neither capture mutated T3.
 *
 * Only provider, model and option facts are kept: instance ids, model slugs,
 * aliases and `optionDescriptors` (id, label, type, role, choices). The capture
 * carries no environment identity, workspace, project, credential or version.
 *
 * What the real shape says (nightly 0.1.11-nightly.20261118):
 * - codex `gpt-6.1-terra` and `gpt-6-luna` carry the level on a
 *   `reasoningEffort` select with **no `role`**: the id is the carrier, exactly
 *   as T3's own client reads it.
 * - claudeAgent `claude-opus-5-5` carries it on `effort` (through `ultrathink`).
 * - pi reports `thinking` per model, and its `default` model reports **no**
 *   option descriptors at all — a settled absence, not a probe in flight.
 * - the `nucleus` ACP provider that parents a task's role threads reports two
 *   models with no options; a role profile's options must never be judged against
 *   it (that was the pilot's real refusal, nucleus#1375).
 */
export const liveConfigModels = [
  {
    instanceId: "codex",
    displayName: "Codex",
    enabled: true,
    driver: "codex",
    status: "ready",
    models: [
      {
        slug: "gpt-6.1-terra",
        name: "GPT-6.1 Terra",
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
                  isDefault: true,
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
                {
                  id: "max",
                  label: "Max",
                },
                {
                  id: "ultra",
                  label: "Ultra",
                },
              ],
              currentValue: "low",
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
      {
        slug: "gpt-6-luna",
        name: "GPT-6-Luna",
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
    displayName: "Claude",
    enabled: true,
    driver: "claudeAgent",
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
    instanceId: "nucleus",
    displayName: "Nucleus",
    enabled: true,
    driver: "acpRegistry",
    status: "ready",
    models: [
      {
        slug: "nucleus",
        name: "Nucleus",
        capabilities: {
          optionDescriptors: [],
        },
      },
      {
        slug: "nucleus-quiet",
        name: "Nucleus (quiet)",
        capabilities: {
          optionDescriptors: [],
        },
      },
    ],
  },
  {
    instanceId: "pi",
    displayName: "Pi",
    enabled: true,
    driver: "pi",
    supportedRuntimeModes: [
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ],
    status: "ready",
    models: [
      {
        slug: "default",
        name: "Pi default",
        capabilities: {
          optionDescriptors: [],
        },
      },
      {
        slug: "opencode-go/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash 1017",
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

/**
 * The pilot's launch-time shape (nucleus#1375): every provider is listed with
 * its models, and no model reports an option descriptor because the server is
 * still probing them. T3's own initial snapshots look like this (`status:
 * "warning"`, a "Checking … availability." message). Nothing may be refused from
 * it: selection keeps the profile and the launch waits for the next read.
 */
export const reProbingConfigModels = liveConfigModels.map((provider) => ({
  ...provider,
  status: provider.instanceId === "codex" ? "warning" : provider.status,
  models: provider.models.map((model) => ({
    slug: model.slug,
    name: model.name,
    capabilities: { optionDescriptors: [] },
  })),
}));

/**
 * The same absence with the provider still reporting `ready`: T3's cached
 * snapshot can say ready while its models carry no descriptors yet. A provider
 * that reports no option on any model is mid-probe, so this is a host wait too.
 */
export const unprobedConfigModels = liveConfigModels.map((provider) =>
  provider.instanceId !== "codex"
    ? provider
    : {
        ...provider,
        models: provider.models.map((model) => ({
          slug: model.slug,
          name: model.name,
          capabilities: { optionDescriptors: [] },
        })),
      },
);

/**
 * A settled codex snapshot that truly carries no reasoning option: the model
 * reports its other options (`serviceTier`, `cyberAccessProgram`) and none of
 * them is a thought-level control. A launch is refused before send, and the
 * refusal lists these real descriptors.
 */
export const settledNoCarrierConfigModels = liveConfigModels.map((provider) =>
  provider.instanceId !== "codex"
    ? provider
    : {
        ...provider,
        models: provider.models.map((model) => ({
          ...model,
          capabilities: {
            optionDescriptors: (
              model.capabilities?.optionDescriptors ?? []
            ).filter((descriptor) => descriptor.id !== "reasoningEffort"),
          },
        })),
      },
);
