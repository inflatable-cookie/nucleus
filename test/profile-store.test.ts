import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostCatalogSchema,
  type HostCatalog,
  type HostProvider,
} from "../shared/host";
import {
  nucleusProfileSchema,
  profileAvailability,
  type NucleusProfile,
} from "../shared/profiles";

const profile = (overrides: Partial<NucleusProfile> = {}): NucleusProfile =>
  nucleusProfileSchema.parse({
    id: "sol",
    name: "Sol",
    provider: "openai",
    model: "gpt-5",
    notes: "",
    ...overrides,
  });

const provider = (overrides: Partial<HostProvider> = {}): HostProvider => ({
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
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "high",
      modes: [],
      features: [],
    },
  ],
  ...overrides,
});
const catalog = (...providers: HostProvider[]): HostCatalog =>
  hostCatalogSchema.parse({ providers });

test("Spec 052 availability: a table of launch values and catalogs", () => {
  const table: {
    label: string;
    profile: NucleusProfile;
    catalog: HostCatalog;
    available: boolean;
    problem: string;
    supportedThinking?: string[];
  }[] = [
    {
      label: "provider, model and thinking all present",
      profile: profile({ thinkingOptionId: "low" }),
      catalog: catalog(provider()),
      available: true,
      problem: "",
      supportedThinking: ["low", "high"],
    },
    {
      label: "a model alias counts as the model",
      profile: profile({ model: "gpt-5-latest" }),
      catalog: catalog(provider()),
      available: true,
      problem: "",
      supportedThinking: ["low", "high"],
    },
    {
      label: "a host without the provider",
      profile: profile({ provider: "anthropic" }),
      catalog: catalog(provider()),
      available: false,
      problem: "Provider anthropic is not available on this host",
      supportedThinking: [],
    },
    {
      label: "a host without the model, even when another provider has it",
      profile: profile({ model: "opus" }),
      catalog: catalog(
        provider(),
        provider({ key: "anthropic", label: "Anthropic" }),
      ),
      available: false,
      problem: "Model opus is not available from provider openai",
      supportedThinking: [],
    },
    {
      label: "no model chosen",
      profile: profile({ model: "" }),
      catalog: catalog(provider()),
      available: false,
      problem: "Profile needs an explicit model",
      supportedThinking: [],
    },
    {
      label: "a thinking level the model does not offer",
      profile: profile({ thinkingOptionId: "max" }),
      catalog: catalog(provider()),
      available: false,
      problem: "Configured thinking level is not supported",
      supportedThinking: ["low", "high"],
    },
    {
      label: "a provider the host reports unusable",
      profile: profile(),
      catalog: catalog(
        provider({ available: false, problem: "API key missing" }),
      ),
      available: false,
      problem: "API key missing",
      supportedThinking: [],
    },
  ];
  for (const row of table) {
    assert.deepEqual(
      profileAvailability(row.profile, row.catalog),
      {
        available: row.available,
        problem: row.problem,
        supportedThinking: row.supportedThinking ?? [],
      },
      row.label,
    );
  }
});
