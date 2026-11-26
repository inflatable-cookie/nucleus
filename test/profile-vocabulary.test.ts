import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { t3HostCatalog } from "../hosts/t3code/catalog";
import { configProvider } from "../hosts/t3code/config";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
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
  type HostVocabulary,
  type LaunchValues,
} from "../shared/profile-vocabulary";
import type { HostCatalog } from "../shared/host";
import { nightlyProviders, poolShapes } from "./support/pool-shapes";

/**
 * Profiles store one canonical vocabulary and the current host translates it
 * through its own table (nucleus#1158).
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

const expected: Record<string, LaunchValues | string> = {
  "Codex grind (full-access)": {
    provider: "codex",
    model: "gpt-6-luna",
    modeId: "full-access",
    thinkingOptionId: "xhigh",
  },
  "Codex oracle (full-access)": {
    provider: "codex",
    model: "gpt-6.1-sol",
    modeId: "full-access",
    thinkingOptionId: "high",
  },
  "Codex worker (full-access)": {
    provider: "codex",
    model: "gpt-6.1-terra",
    modeId: "full-access",
    thinkingOptionId: "high",
  },
  "Claude haiku (auto)": {
    provider: "claudeAgent",
    model: "claude-haiku-5-5",
    modeId: "auto",
    featureValues: { effort: "high" },
  },
  "Claude opus (full-access)": {
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    modeId: "full-access",
    featureValues: { effort: "medium" },
  },
  "Claude sonnet (full-access, disabled)": {
    provider: "claudeAgent",
    model: "claude-haiku-5-5",
    modeId: "full-access",
    featureValues: { effort: "high" },
  },
  "Grok (full-access)": {
    provider: "grok",
    model: "grok-4.6",
    modeId: "full-access",
    thinkingOptionId: "high",
  },
  "Pi muse (no mode)": {
    provider: "pi",
    model: "opencode-go/muse-spark-1.3-contributor",
    featureValues: { thinking: "high" },
  },
  "Pi deepseek (no mode)": {
    provider: "pi",
    model: "opencode-go/deepseek-v4.1-flash",
    featureValues: { thinking: "high" },
  },
  "Pi glm (no mode, disabled)": {
    provider: "pi",
    model: "opencode-go/deepseek-v4.1-flash",
    featureValues: { thinking: "high" },
  },
  "Mode-only (plan)": "T3Code can't run codex in mode plan",
  "Mode-only (auto)": {
    provider: "codex",
    model: "gpt-6-luna",
    modeId: "auto",
  },
};

function coverageFailures(
  vocabulary: HostVocabulary,
  catalog: HostCatalog,
): string[] {
  const failures: string[] = [];
  for (const [index, shape] of poolShapes.entries()) {
    const want = expected[shape.profile.label];
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
    } else if (answer.status !== "works") {
      failures.push(`${shape.profile.label}: ${answer.reason}`);
    } else if (!isDeepStrictEqual(answer.launch, want)) {
      failures.push(
        `${shape.profile.label}: launches ${JSON.stringify(answer.launch)}, expected ${JSON.stringify(want)}`,
      );
    }
  }
  return failures;
}

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

test("every pool shape is canonical and translates on the T3 catalog to its launch values", () => {
  for (const shape of poolShapes) {
    const { label: _label, ...values } = shape.profile;
    assert.ok(isCanonicalProvider(values.provider));
    if (values.modeId) assert.ok(isRuntimeMode(values.modeId));
    if (values.thinkingOptionId)
      assert.ok(isThinkingLevel(values.thinkingOptionId));
    assert.ok(!("auto_accept" in (values.featureValues ?? {})));
    nucleusProfileInputSchema.parse({ name: shape.profile.label, ...values });
  }
  const catalog = t3HostCatalog(
    nightlyProviders().map((p) => configProvider.parse(p)),
  );
  assert.deepEqual(coverageFailures(t3codeVocabulary, catalog), []);
});

test("removing a T3 translation entry used by the pool fails coverage with the value named", () => {
  const catalog = t3HostCatalog(
    nightlyProviders().map((p) => configProvider.parse(p)),
  );
  const removals: [string, ("thinking" | "modes")?, string?][] = [
    ["claude"],
    ["pi"],
    ["grok"],
    ["codex"],
    ["claude", "thinking", "medium"],
    ["pi", "thinking", "high"],
    ["claude", "modes", "full-access"],
    ["codex", "modes", "auto"],
    ["grok", "modes", "full-access"],
  ];
  for (const [provider, field, key] of removals) {
    const failures = coverageFailures(
      without(t3codeVocabulary, provider, field, key),
      catalog,
    );
    const named = key ?? provider;
    assert.ok(failures.length > 0);
    assert.ok(
      failures.some((failure) => failure.includes(named)),
      failures.join("; "),
    );
  }
});

test("unavailable T3 values have a computed reason and the form exposes canonical values", () => {
  const catalog = t3HostCatalog(
    nightlyProviders().map((p) => configProvider.parse(p)),
  );
  const answer = (values: Record<string, unknown>) =>
    profileCompatibility(
      nucleusProfileSchema.parse({ id: "p", name: "P", ...values }),
      catalog,
      t3codeVocabulary,
    );
  assert.equal(
    answer({ provider: "codex", model: "gpt-6-luna", modeId: "plan" }).reason,
    "T3Code can't run codex in mode plan",
  );
  assert.equal(
    answer({
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "ultra",
    }).status,
    "works",
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
    );

  const canonical = canonicalCatalog(t3codeVocabulary, catalog);
  const opus = canonical.providers
    .find((provider) => provider.key === "claude")!
    .models.find((model) => model.id === "claude-opus-5-5")!;
  assert.deepEqual(
    opus.thinkingOptions.map((option) => option.id),
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.deepEqual(
    opus.modes.map((mode) => mode.id),
    ["supervised", "accept-edits", "auto", "full-access"],
  );
  assert.equal(
    opus.features.some((feature) => feature.id === "effort"),
    false,
  );
});
