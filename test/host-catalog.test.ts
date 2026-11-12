import { test } from "node:test";
import assert from "node:assert/strict";
import { PaseoAdapter } from "../service/paseo-composition";
import { hostCatalogSchema } from "../shared/host";
import { nucleusProfileSchema, profileAvailability, routingProfiles } from "../shared/profiles";

/**
 * Spec 052, step 1 of the Paseo split: the Paseo adapter's host catalog lists
 * every provider the daemon reports, not only the configured profiles' ones,
 * and the one-time import source is Paseo's own `config.agentProfiles`.
 */

type AdapterApi = {
  providers: {
    snapshot: (options?: unknown) => Promise<unknown>;
    listFeatures: (input: unknown) => Promise<unknown>;
  };
  config: { get: () => Promise<unknown> };
};

function adapterWith(api: Partial<AdapterApi>): PaseoAdapter {
  const adapter = new PaseoAdapter(
    "ws://127.0.0.1:1",
    "/unused/callback.sock",
    "/unused/worker-report.mjs",
  );
  (adapter as unknown as { api: unknown }).api = api;
  return adapter;
}

const entries = [
  {
    provider: "openai",
    label: "OpenAI",
    status: "ready",
    enabled: true,
    modes: [
      { id: "agent", label: "Agent", description: "Full agent" },
      { id: "plan", label: "Plan" },
    ],
    models: [
      {
        provider: "openai",
        id: "gpt-5",
        label: "GPT-5",
        aliases: ["gpt-5-latest"],
        isDefault: true,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        defaultThinkingOptionId: "high",
      },
      { provider: "openai", id: "gpt-5-mini", label: "GPT-5 mini" },
    ],
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    status: "error",
    enabled: true,
    error: "API key missing",
    models: [],
  },
  { provider: "t3", label: "T3", status: "ready", enabled: false, models: [] },
];

test("Spec 052 host catalog: every provider the host reports, with models, thinking options and modes", async () => {
  const adapter = adapterWith({
    providers: {
      snapshot: async () => ({ entries }),
      listFeatures: async () => ({ features: [] }),
    },
  });
  const catalog = hostCatalogSchema.parse(await adapter.catalog({ cwd: "/fixture/project" }));
  assert.deepEqual(
    catalog.providers.map((provider) => provider.key),
    ["openai", "anthropic", "t3"],
  );
  assert.deepEqual(catalog.providers[0], {
    key: "openai",
    label: "OpenAI",
    available: true,
    problem: "",
    models: [
      {
        id: "gpt-5",
        label: "GPT-5",
        aliases: ["gpt-5-latest"],
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
        defaultThinkingOptionId: "high",
        modes: [
          { id: "agent", label: "Agent", description: "Full agent" },
          { id: "plan", label: "Plan" },
        ],
        features: [],
      },
      {
        id: "gpt-5-mini",
        label: "GPT-5 mini",
        aliases: [],
        thinkingOptions: [],
        defaultThinkingOptionId: null,
        modes: [
          { id: "agent", label: "Agent", description: "Full agent" },
          { id: "plan", label: "Plan" },
        ],
        features: [],
      },
    ],
  });
  // A provider the host reports as unusable stays in the catalog with its reason.
  assert.deepEqual(catalog.providers[1], {
    key: "anthropic",
    label: "Anthropic",
    available: false,
    problem: "API key missing",
    models: [],
  });
  // A disabled provider is reported but is not a host this profile can run on.
  assert.deepEqual(catalog.providers[2], {
    key: "t3",
    label: "T3",
    available: false,
    problem: "Provider T3 is disabled on this host",
    models: [],
  });
});

test("Spec 052 host catalog: feature values need a project directory, so none are listed without one", async () => {
  const asked: unknown[] = [];
  const adapter = adapterWith({
    providers: {
      snapshot: async () => ({ entries }),
      listFeatures: async (input) => {
        asked.push(input);
        return { features: [] };
      },
    },
  });
  await adapter.catalog();
  assert.deepEqual(asked, [], "a host-level read invents no working directory");
});

test("Spec 052 host catalog: with a working directory, feature values are listed per model and a failure keeps the rest", async () => {
  const asked: { provider: string; cwd: string }[] = [];
  const adapter = adapterWith({
    providers: {
      snapshot: async () => ({ entries }),
      listFeatures: async (input) => {
        const request = input as { provider: string; cwd: string };
        asked.push({ provider: request.provider, cwd: request.cwd });
        if (request.provider === "openai/gpt-5")
          return {
            features: [
              { type: "toggle", id: "fast", label: "Fast", value: true },
              {
                type: "select",
                id: "permission",
                label: "Permission",
                value: "allow",
                options: [
                  { id: "allow", label: "Allow", isDefault: true },
                  { id: "ask", label: "Ask" },
                ],
              },
            ],
          };
        throw new Error("provider refused the feature list");
      },
    },
    config: { get: async () => ({ config: {} }) },
  });
  const catalog = hostCatalogSchema.parse(
    await adapter.catalog({ cwd: "/repo" }),
  );
  assert.deepEqual(asked.map((entry) => entry.provider).sort(), [
    "openai/gpt-5",
    "openai/gpt-5-mini",
  ]);
  assert.ok(asked.every((entry) => entry.cwd === "/repo"));
  const models = catalog.providers[0]!.models;
  assert.deepEqual(models[0]!.features, [
    { type: "toggle", id: "fast", label: "Fast", value: true },
    {
      type: "select",
      id: "permission",
      label: "Permission",
      value: "allow",
      options: [
        { id: "allow", label: "Allow", isDefault: true },
        { id: "ask", label: "Ask" },
      ],
    },
  ]);
  assert.deepEqual(
    models[1]!.features,
    [],
    "a model the host cannot describe keeps an empty set",
  );
  assert.deepEqual(
    catalog.providers[1]!.models,
    [],
    "an unavailable provider is not asked for features",
  );
});

test("Spec 052 hostProfiles: Paseo's own list with ids unchanged, and availability read from its catalog", async () => {
  const adapter = adapterWith({
    providers: {
      snapshot: async () => ({ entries }),
      // The host reports what its imported profiles carry: the fast toggle on gpt-5.
      listFeatures: async input => ({ features: (input as { provider?: string }).provider === "openai/gpt-5" ? [{ type: "toggle", id: "fast", label: "Fast", value: true }] : [] }),
    },
    config: {
      get: async () => ({
        config: {
          agentProfiles: [
            {
              id: "paseo-sol",
              name: "Sol",
              provider: "openai",
              model: "gpt-5",
              modeId: "agent",
              thinkingOptionId: "high",
              featureValues: { fast: true },
              notes: "frontier",
            },
            { id: "paseo-luna", name: "Luna", provider: "openai" },
          ],
        },
      }),
    },
  });
  const profiles = [
    { id: "paseo-sol", name: "Sol", provider: "openai", model: "gpt-5", modeId: "agent", thinkingOptionId: "high", featureValues: { fast: true }, notes: "frontier" },
    { id: "paseo-luna", name: "Luna", provider: "openai" },
  ].map((profile) => nucleusProfileSchema.parse(profile));
  assert.deepEqual(profiles, [
    {
      id: "paseo-sol",
      name: "Sol",
      provider: "openai",
      model: "gpt-5",
      modeId: "agent",
      thinkingOptionId: "high",
      featureValues: { fast: true },
      notes: "frontier",
    },
    {
      id: "paseo-luna",
      name: "Luna",
      provider: "openai",
      model: "",
      notes: "",
    },
  ]);
  const catalog = hostCatalogSchema.parse(await adapter.catalog({ cwd: "/fixture/project" }));
  assert.deepEqual(profileAvailability(profiles[0]!, catalog), {
    available: true,
    problem: "",
    supportedThinking: ["low", "high"],
  });
  assert.equal(
    profileAvailability(profiles[1]!, catalog).problem,
    "Profile needs an explicit model",
  );
});


test("imported profile projection matches the former Paseo routing list", async () => {
  const hostProfiles = [
    { id: "sol", name: "Sol", provider: "openai", model: "gpt-5", modeId: "agent", thinkingOptionId: "high", featureValues: { fast: true }, notes: "frontier" },
    { id: "mini", name: "Mini", provider: "openai", model: "gpt-5-mini" },
  ];
  const adapter = adapterWith({ providers: { snapshot: async () => ({ entries }), listFeatures: async input => ({ features: (input as { provider?: string }).provider === "openai/gpt-5" ? [{ type: "toggle", id: "fast", label: "Fast", value: true }] : [] }) } });
  const catalog = await adapter.catalog({ cwd: "/fixture/project" });
  const legacy = hostProfiles.map(p => {
    const model = entries[0]!.models.find(m => m.id === p.model)!;
    const supportedThinking = (model.thinkingOptions ?? []).map(o => o.id);
    return { id: p.id, name: p.name, provider: p.provider, model: p.model, modeId: p.modeId,
      thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues, notes: p.notes ?? "",
      available: true, problem: "", supportedThinking };
  });
  assert.deepEqual(routingProfiles(hostProfiles.map(p => nucleusProfileSchema.parse(p)), catalog), legacy);
});

test("nucleus#1139 review: availability answers the configured runtime mode and feature values", () => {
  const catalog = hostCatalogSchema.parse({
    providers: [{
      key: "openai", label: "OpenAI", available: true, problem: "",
      models: [{
        id: "gpt-5", label: "GPT-5", aliases: [],
        thinkingOptions: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }],
        defaultThinkingOptionId: "high",
        modes: [{ id: "agent", label: "Agent" }],
        features: [
          { type: "toggle", id: "fast", label: "Fast", value: true },
          { type: "select", id: "serviceTier", label: "Service tier", value: "standard",
            options: [{ id: "standard", label: "Standard" }, { id: "priority", label: "Priority" }] },
        ],
      }],
    }],
  });
  const base = { id: "sol", name: "Sol", provider: "openai", model: "gpt-5", notes: "" };
  // Reported mode and feature values stay available.
  assert.deepEqual(profileAvailability(nucleusProfileSchema.parse({ ...base, modeId: "agent", thinkingOptionId: "high", featureValues: { fast: true, serviceTier: "priority" } }), catalog),
    { available: true, problem: "", supportedThinking: ["low", "high"] });
  // A mode the host does not report is ineligible there.
  assert.equal(profileAvailability(nucleusProfileSchema.parse({ ...base, modeId: "plan" }), catalog).problem,
    "Configured runtime mode is not supported");
  // An option id the host does not report, and an unreported select value.
  assert.equal(profileAvailability(nucleusProfileSchema.parse({ ...base, featureValues: { contextWindow: 200000 } }), catalog).problem,
    "Configured option contextWindow is not supported");
  assert.equal(profileAvailability(nucleusProfileSchema.parse({ ...base, featureValues: { serviceTier: "ultra" } }), catalog).problem,
    "Configured option serviceTier does not offer that value");
  // A toggle that names a non-boolean value.
  assert.equal(profileAvailability(nucleusProfileSchema.parse({ ...base, featureValues: { fast: "yes" } }), catalog).problem,
    "Configured option fast needs a boolean value");
});
