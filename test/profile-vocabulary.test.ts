import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { t3HostCatalog } from "../hosts/t3code/catalog";
import { configProvider } from "../hosts/t3code/config";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { paseoVocabulary } from "../hosts/paseo/vocabulary";
import {
  nucleusProfileInputSchema,
  nucleusProfileSchema,
  profileCompatibility,
  type NucleusProfile,
} from "../shared/profiles";
import {
  canonicalCatalog,
  isCanonicalProvider,
  isRuntimeMode,
  isThinkingLevel,
  mergeCanonicalCatalogs,
  type HostVocabulary,
  type LaunchValues,
} from "../shared/profile-vocabulary";
import type { HostKind } from "../shared/host-kind";
import type { HostCatalog } from "../shared/host";
import {
  nightlyProviders,
  paseoCatalog,
  poolShapes,
} from "./support/pool-shapes";

/**
 * Task 1158 (Tom, 2026-11-12): profiles store one canonical vocabulary, and each
 * host adapter translates it in code with one table. No per-profile host setting.
 */

const stored = (index: number): NucleusProfile =>
  nucleusProfileSchema.parse({
    id: `shape-${index}`,
    name: poolShapes[index]!.profile.label,
    ...Object.fromEntries(
      Object.entries(poolShapes[index]!.profile).filter(
        ([key]) => key !== "label",
      ),
    ),
  });
/**
 * The launch values each pool shape translates to, by label (#1151's table):
 * Haiku and Opus run on T3 as `claudeAgent` with their thinking as `effort`,
 * DeepSeek and Muse as Pi with a `thinking` option, Grok with its mode and no
 * `auto_accept`, Codex unchanged. On Paseo Claude's full access is
 * `bypassPermissions` and Grok's is `auto_accept`. A string is the expected
 * reason the shape can't run there.
 */
const expected: Record<
  string,
  Partial<Record<HostKind, LaunchValues | string>>
> = {
  "Codex grind (full-access)": {
    paseo: {
      provider: "codex",
      model: "gpt-6-luna",
      modeId: "full-access",
      thinkingOptionId: "xhigh",
    },
    t3code: {
      provider: "codex",
      model: "gpt-6-luna",
      modeId: "full-access",
      thinkingOptionId: "xhigh",
    },
  },
  "Codex oracle (full-access)": {
    paseo: {
      provider: "codex",
      model: "gpt-6.1-sol",
      modeId: "full-access",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "codex",
      model: "gpt-6.1-sol",
      modeId: "full-access",
      thinkingOptionId: "high",
    },
  },
  "Codex worker (full-access)": {
    paseo: {
      provider: "codex",
      model: "gpt-6.1-terra",
      modeId: "full-access",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "codex",
      model: "gpt-6.1-terra",
      modeId: "full-access",
      thinkingOptionId: "high",
    },
  },
  "Claude haiku (auto)": {
    paseo: {
      provider: "claude",
      model: "claude-haiku-5-5",
      modeId: "auto",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "claudeAgent",
      model: "claude-haiku-5-5",
      modeId: "auto",
      featureValues: { effort: "high" },
    },
  },
  "Claude opus (full-access)": {
    paseo: {
      provider: "claude",
      model: "claude-opus-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "medium",
    },
    t3code: {
      provider: "claudeAgent",
      model: "claude-opus-5-5",
      modeId: "full-access",
      featureValues: { effort: "medium" },
    },
  },
  "Claude sonnet (full-access, disabled)": {
    paseo: {
      provider: "claude",
      model: "claude-haiku-5-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "claudeAgent",
      model: "claude-haiku-5-5",
      modeId: "full-access",
      featureValues: { effort: "high" },
    },
  },
  "Grok (full-access)": {
    paseo: {
      provider: "grok",
      model: "grok-4.6",
      thinkingOptionId: "high",
      featureValues: { auto_accept: true },
    },
    t3code: {
      provider: "grok",
      model: "grok-4.6",
      modeId: "full-access",
      thinkingOptionId: "high",
    },
  },
  "Pi muse (no mode)": {
    paseo: {
      provider: "pi",
      model: "opencode-go/muse-spark-1.3-contributor",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "pi",
      model: "opencode-go/muse-spark-1.3-contributor",
      featureValues: { thinking: "high" },
    },
  },
  "Pi deepseek (no mode)": {
    paseo: {
      provider: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
      featureValues: { thinking: "high" },
    },
  },
  "Pi glm (no mode, disabled)": {
    paseo: {
      provider: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
      thinkingOptionId: "high",
    },
    t3code: {
      provider: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
      featureValues: { thinking: "high" },
    },
  },
  "Mode-only (plan)": {
    paseo: "Paseo can't run codex in mode plan",
    t3code: "T3Code can't run codex in mode plan",
  },
  "Mode-only (auto)": {
    paseo: { provider: "codex", model: "gpt-6-luna", modeId: "auto" },
    t3code: { provider: "codex", model: "gpt-6-luna", modeId: "auto" },
  },
};

/** Every shape whose answer on this host differs from the expected table, named with its value. */
function coverageFailures(
  vocabulary: HostVocabulary,
  catalog: HostCatalog,
): string[] {
  const failures: string[] = [];
  for (const [index, shape] of poolShapes.entries()) {
    const want = expected[shape.profile.label]?.[vocabulary.kind];
    if (want === undefined) {
      failures.push(
        `${shape.profile.label}: no expected ${vocabulary.label} launch`,
      );
      continue;
    }
    const answer = profileCompatibility(stored(index), catalog, vocabulary);
    if (typeof want === "string") {
      if (answer.status !== "unavailable" || answer.reason !== want)
        failures.push(
          `${shape.profile.label}: expected "${want}", got ${answer.status} "${answer.reason}"`,
        );
    } else if (answer.status !== "works")
      failures.push(`${shape.profile.label}: ${answer.reason}`);
    else if (!isDeepStrictEqual(answer.launch, want))
      failures.push(
        `${shape.profile.label}: launches ${JSON.stringify(answer.launch)}, expected ${JSON.stringify(want)}`,
      );
  }
  return failures;
}

/** A deep copy of a table with one entry removed: a provider, or one thinking level or mode of one provider. */
function without(
  vocabulary: HostVocabulary,
  provider: string,
  field?: "thinking" | "modes",
  key?: string,
): HostVocabulary {
  const copy = structuredClone(vocabulary);
  const providers = copy.providers as Record<
    string,
    | { thinking: Record<string, string>; modes: Record<string, unknown> }
    | undefined
  >;
  if (!field) delete providers[provider];
  else delete providers[provider]![field][key!];
  return copy;
}

test("acceptance 1: every pool shape is canonical and translates on Paseo and on the recorded nightly T3 catalog to its launch values", () => {
  for (const shape of poolShapes) {
    const { label: _label, ...values } = shape.profile;
    assert.ok(
      isCanonicalProvider(values.provider),
      `${shape.profile.label}: provider ${values.provider} is canonical`,
    );
    if (values.modeId)
      assert.ok(
        isRuntimeMode(values.modeId),
        `${shape.profile.label}: mode ${values.modeId} is canonical`,
      );
    if (values.thinkingOptionId)
      assert.ok(
        isThinkingLevel(values.thinkingOptionId),
        `${shape.profile.label}: thinking ${values.thinkingOptionId} is canonical`,
      );
    assert.ok(
      !("auto_accept" in (values.featureValues ?? {})),
      `${shape.profile.label}: no host-owned option`,
    );
    nucleusProfileInputSchema.parse({ name: shape.profile.label, ...values });
  }
  const t3 = t3HostCatalog(nightlyProviders().map(p => configProvider.parse(p)));
  assert.deepEqual(coverageFailures(paseoVocabulary, paseoCatalog()), []);
  assert.deepEqual(coverageFailures(t3codeVocabulary, t3), []);
});

test("acceptance 1: removing any translation entry the pool uses fails the coverage with the value named", () => {
  const t3 = t3HostCatalog(nightlyProviders().map(p => configProvider.parse(p)));
  const removals: [
    HostVocabulary,
    HostCatalog,
    string,
    ("thinking" | "modes")?,
    string?,
  ][] = [
    [t3codeVocabulary, t3, "claude"],
    [t3codeVocabulary, t3, "pi"],
    [t3codeVocabulary, t3, "grok"],
    [t3codeVocabulary, t3, "codex"],
    [t3codeVocabulary, t3, "claude", "thinking", "medium"],
    [t3codeVocabulary, t3, "pi", "thinking", "high"],
    [t3codeVocabulary, t3, "claude", "modes", "full-access"],
    [t3codeVocabulary, t3, "codex", "modes", "auto"],
    [t3codeVocabulary, t3, "grok", "modes", "full-access"],
    [paseoVocabulary, paseoCatalog(), "claude"],
    [paseoVocabulary, paseoCatalog(), "grok"],
    [paseoVocabulary, paseoCatalog(), "claude", "modes", "full-access"],
    [paseoVocabulary, paseoCatalog(), "claude", "modes", "auto"],
    [paseoVocabulary, paseoCatalog(), "grok", "modes", "full-access"],
    [paseoVocabulary, paseoCatalog(), "codex", "thinking", "xhigh"],
  ];
  for (const [vocabulary, catalog, provider, field, key] of removals) {
    const failures = coverageFailures(
      without(vocabulary, provider, field, key),
      catalog,
    );
    const named = key ?? provider;
    assert.ok(
      failures.length > 0,
      `${vocabulary.label} without ${provider}${key ? ` ${field} ${key}` : ""} fails the coverage`,
    );
    assert.ok(
      failures.some((failure) => failure.includes(named)),
      `the failure names ${named}: ${failures.join("; ")}`,
    );
  }
});

test("a value no table can express makes the profile unavailable with a computed reason, and a value outside the vocabulary is refused at the form", () => {
  const answer = (
    values: Record<string, unknown>,
    vocabulary: HostVocabulary,
  ) =>
    profileCompatibility(
      nucleusProfileSchema.parse({ id: "p", name: "P", ...values }),
      vocabulary === paseoVocabulary ? paseoCatalog() : { providers: [] },
      vocabulary,
    );
  assert.equal(
    answer({ provider: "fx", model: "default" }, paseoVocabulary).reason,
    "Paseo has no fx provider",
  );
  assert.equal(
    answer(
      {
        provider: "claude",
        model: "claude-opus-5-5",
        thinkingOptionId: "ultra",
      },
      paseoVocabulary,
    ).reason,
    "Paseo can't express thinking level ultra for claude",
  );
  assert.equal(
    answer(
      {
        provider: "pi",
        model: "opencode-go/deepseek-v4.1-flash",
        modeId: "full-access",
      },
      paseoVocabulary,
    ).reason,
    "Paseo can't run pi in mode full-access",
  );
  assert.equal(
    answer(
      {
        provider: "grok",
        model: "grok-4.6",
        featureValues: { auto_accept: true },
      },
      paseoVocabulary,
    ).reason,
    "Option auto_accept is how Paseo carries a thinking level or mode; set those instead",
  );
  assert.equal(
    answer(
      {
        provider: "claude",
        model: "claude-opus-5-5",
        modeId: "bypassPermissions",
      },
      paseoVocabulary,
    ).reason,
    "Runtime mode bypassPermissions is not in Nucleus's vocabulary",
  );
  for (const input of [
    { provider: "claudeAgent" },
    { provider: "claude", modeId: "bypassPermissions" },
    { provider: "claude", thinkingOptionId: "ultrathink" },
  ])
    assert.equal(
      nucleusProfileInputSchema.safeParse({ name: "P", model: "m", ...input })
        .success,
      false,
      JSON.stringify(input),
    );
});

test("the form vocabulary is every host's catalog in canonical values, merged, without the options a table owns", () => {
  const t3 = t3HostCatalog(nightlyProviders().map(p => configProvider.parse(p)));
  const paseo = canonicalCatalog(paseoVocabulary, paseoCatalog());
  const onT3 = canonicalCatalog(t3codeVocabulary, t3);
  // T3's claudeAgent reads as canonical claude, its effort option as thinking levels.
  const t3Opus = onT3.providers
    .find((provider) => provider.key === "claude")!
    .models.find((model) => model.id === "claude-opus-5-5")!;
  assert.deepEqual(
    t3Opus.thinkingOptions.map((option) => option.id),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(
    t3Opus.modes.map((mode) => mode.id),
    ["supervised", "accept-edits", "auto", "full-access"],
  );
  assert.equal(
    t3Opus.features.some((feature) => feature.id === "effort"),
    false,
  );
  // Paseo's Claude has no canonical ultra (its ultracode is not offered), and its modes read canonically.
  const paseoOpus = paseo.providers
    .find((provider) => provider.key === "claude")!
    .models.find((model) => model.id === "claude-opus-5-5")!;
  assert.deepEqual(
    paseoOpus.thinkingOptions.map((option) => option.id),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    paseoOpus.modes.map((mode) => mode.id),
    ["plan", "supervised", "accept-edits", "auto", "full-access"],
  );
  // Paseo's Grok carries its modes as auto_accept, which is not a feature the form shows.
  const paseoGrok = paseo.providers.find((provider) => provider.key === "grok")!
    .models[0]!;
  assert.deepEqual(
    [paseoGrok.modes.map((mode) => mode.id), paseoGrok.features],
    [["supervised", "full-access"], []],
  );
  // Merged: a level or mode at least one host can run; providers by canonical key, once.
  const merged = mergeCanonicalCatalogs([paseo, onT3]);
  // T3's disabled Cursor still lists, unavailable with its reason.
  assert.deepEqual(
    merged.providers.map((provider) => [provider.key, provider.available]),
    [
      ["codex", true],
      ["claude", true],
      ["pi", true],
      ["grok", true],
      ["cursor", false],
    ],
  );
  const mergedOpus = merged.providers
    .find((provider) => provider.key === "claude")!
    .models.find((model) => model.id === "claude-opus-5-5")!;
  assert.deepEqual(
    mergedOpus.thinkingOptions.map((option) => option.id),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(
    mergedOpus.modes.map((mode) => mode.id),
    ["plan", "supervised", "accept-edits", "auto", "full-access"],
  );
});
