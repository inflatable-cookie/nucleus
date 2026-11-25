import { test } from "node:test";
import assert from "node:assert/strict";
import { t3HostCatalog } from "../hosts/t3code/catalog";
import { configProvider } from "../hosts/t3code/config";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { paseoVocabulary } from "../hosts/paseo/vocabulary";
import {
  nucleusProfileSchema,
  profileAvailability,
  profileCompatibility,
  routingProfiles,
  type NucleusProfile,
} from "../shared/profiles";
import {
  canonicalCatalog,
  mergeCanonicalCatalogs,
  translateProfile,
} from "../shared/profile-vocabulary";
import { withCanonicalOption } from "../client/settings-profile-helpers";
import { paseoOptionCatalog } from "./support/paseo-option-catalog";
import { liveConfigModels } from "./support/t3-nightly-config";

// Board profiles use canonical option keys. Catalog fixtures contain the original host spellings.
const astra = nucleusProfileSchema.parse({
  id: "astra", name: "Astra", provider: "codex", model: "gpt-6.2-astra",
  modeId: "full-access", thinkingOptionId: "high", featureValues: {}, notes: "",
});
const onT3Terra = (profile: NucleusProfile): NucleusProfile => ({
  ...profile,
  model: "gpt-6.1-terra",
});
const withSpeed = (profile: NucleusProfile, speed: string): NucleusProfile => ({
  ...profile,
  featureValues: { ...profile.featureValues, speed },
});

test("a speed T3 can't express excludes the profile from T3 selection with a per-host note, never a send refusal", () => {
  const catalog = t3HostCatalog(liveConfigModels.map(p => configProvider.parse(p)));
  const profile = withSpeed(astra, "ultrafast");
  const [paseo] = routingProfiles(
    [profile],
    paseoOptionCatalog(),
    paseoVocabulary,
  );
  assert.equal(paseo!.available, true, "Paseo's Astra offers ultrafast");
  assert.deepEqual(paseo!.featureValues, { service_tier: "ultrafast" });

  const answer = profileCompatibility(
    onT3Terra(profile),
    catalog,
    t3codeVocabulary,
  );
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.reason, "T3Code can't express speed Ultrafast for codex");
  const [t3] = routingProfiles([onT3Terra(profile)], catalog, t3codeVocabulary);
  assert.equal(t3!.available, false, "selection excludes it on T3");
  assert.equal(t3!.problem, "T3Code can't express speed Ultrafast for codex");

  // A model the table can carry but that does not offer the value is the same
  // canonical fact on that host, named in the operator's words.
  const terra = { ...profile, model: "gpt-6.1-terra" };
  const onPaseo = profileCompatibility(
    terra,
    paseoOptionCatalog(),
    paseoVocabulary,
  );
  assert.equal(onPaseo.status, "unavailable");
  assert.equal(onPaseo.reason, "Paseo's gpt-6.1-terra has no speed Ultrafast");
  assert.equal(onPaseo.problem, onPaseo.reason);
});

test("the editor shows one Speed control from both hosts and choosing it clears host spellings", () => {
  const catalog = t3HostCatalog(liveConfigModels.map(p => configProvider.parse(p)));
  const merged = mergeCanonicalCatalogs([
    canonicalCatalog(paseoVocabulary, paseoOptionCatalog()),
    canonicalCatalog(t3codeVocabulary, catalog),
  ]);
  const codex = merged.providers.find((provider) => provider.key === "codex")!;
  // Terra is reported by both hosts: Paseo's `service_tier` and T3's
  // `serviceTier` merge into the one Speed control.
  const terraModel = codex.models.find(
    (model) => model.id === "gpt-6.1-terra",
  )!;
  assert.deepEqual(
    terraModel.features.map((feature) => [feature.id, feature.label]),
    [
      ["speed", "Speed"],
      ["plan-mode", "Plan mode"],
      ["cyber-access", "Cyber access"],
    ],
    "no service_tier, serviceTier, plan_mode or cyberAccessProgram",
  );
  const astraModel = codex.models.find(
    (model) => model.id === "gpt-6.2-astra",
  )!;
  assert.deepEqual(
    astraModel.features.map((feature) => feature.id),
    ["speed", "plan-mode"],
  );
  const speed = astraModel.features[0]!;
  assert.equal(speed.type, "select");
  assert.deepEqual(
    speed.type === "select"
      ? speed.options.map((option) => [option.id, option.label])
      : [],
    [
      ["default", "Normal"],
      ["priority", "Fast"],
      ["ultrafast", "Ultrafast"],
    ],
  );
  const opus = merged.providers
    .find((provider) => provider.key === "claude")!
    .models.find((model) => model.id === "claude-opus-5-5")!;
  assert.ok(opus.features.some((feature) => feature.id === "speed"));
  assert.ok(
    !opus.features.some((feature) =>
      ["fast_mode", "fastMode"].includes(feature.id),
    ),
  );

  // The editor judges the canonical profile against the canonical catalog.
  assert.equal(
    profileAvailability(withSpeed(astra, "priority"), merged)
      .available,
    true,
  );
  assert.deepEqual(
    withCanonicalOption(
      "codex",
      { service_tier: "turbo", plan_mode: false },
      "speed",
      "priority",
    ),
    { plan_mode: false, speed: "priority" },
  );
});

test("a host spelling left in a profile is refused with the canonical control named", () => {
  const answer = translateProfile(t3codeVocabulary, {
    provider: "codex",
    model: "gpt-6.2-astra",
    featureValues: { serviceTier: "priority" },
  });
  assert.equal(answer.ok, false);
  assert.equal(
    answer.ok ? "" : answer.reason,
    "Option serviceTier is how T3Code carries Speed; set Speed instead",
  );
});
