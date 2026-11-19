import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { paseoVocabulary } from "../hosts/paseo/vocabulary";
import { HOST_VOCABULARIES } from "../hosts/vocabularies";
import { Store } from "../core/store/store";
import { migrateProfileOptions } from "../core/store/profile-vocabulary-migration";
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
import type { Profile } from "../shared/contracts";
import { t3Fake } from "./support/t3code-fake";
import { acpStub, nucleusProvider } from "./support/t3code-acp";
import {
  paseoOptionCatalog,
  t3ConfigWithAstra,
} from "./support/paseo-option-catalog";

/**
 * nucleus#1386 (Tom, 2026-11-19: "the Astra profile currently complains that T3
 * doesn't have 'service_tier', which is the same setting as 'speed' in paseo"):
 * every provider option more than one host carries has one canonical key, each
 * host's table spells it, and an option a host lacks is decided by selection.
 */

const vocabularies = Object.values(HOST_VOCABULARIES);

/**
 * The live "Astra frontier" profile with a synthesised id: written through both
 * hosts, it holds Paseo's `service_tier` and `plan_mode` beside T3's
 * `serviceTier` and `cyberAccessProgram`, every one at its default. T3 refused it
 * as "T3Code's gpt-6.2-astra has no option service_tier".
 */
const astra = {
  id: "synthetic-astra",
  name: "Astra frontier",
  provider: "codex",
  model: "gpt-6.2-astra",
  modeId: "full-access",
  thinkingOptionId: "high",
  featureValues: {
    service_tier: "default",
    plan_mode: false,
    serviceTier: "default",
    cyberAccessProgram: "standard",
  },
  notes: "",
};
const claudeFast = {
  id: "synthetic-opus-fast",
  name: "Opus fast",
  provider: "claude",
  model: "claude-opus-5-5",
  thinkingOptionId: "high",
  featureValues: { fastMode: true, ultracode: false },
  notes: "",
};

const migrated = (raw: unknown): NucleusProfile =>
  nucleusProfileSchema.parse(
    migrateProfileOptions([raw], vocabularies).profiles[0],
  );
const withSpeed = (profile: NucleusProfile, speed: string): NucleusProfile => ({
  ...profile,
  featureValues: { ...profile.featureValues, speed },
});

async function t3Fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "profile-options-t3-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = [...t3ConfigWithAstra(), nucleusProvider];
  const acp = acpStub(server.threads);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    acp: () => acp.surface,
    reentryTimeoutMs: 200,
  });
  t.after(() => {
    host.close();
    rmSync(root, { recursive: true, force: true });
  });
  await host.connect();
  return { host, server, directory, catalog: await host.catalog() };
}

test("the migration moves every host spelling to its canonical key once, keeping meaning, and lists what no table maps", () => {
  const unmatched = {
    id: "synthetic-turbo",
    name: "Turbo",
    provider: "codex",
    model: "gpt-6.2-astra",
    featureValues: { service_tier: "turbo" },
    notes: "",
  };
  const clash = {
    id: "synthetic-clash",
    name: "Clash",
    provider: "codex",
    model: "gpt-6.2-astra",
    featureValues: { service_tier: "priority", serviceTier: "default" },
    notes: "",
  };
  const { profiles, record } = migrateProfileOptions(
    [astra, claudeFast, unmatched, clash],
    vocabularies,
  );
  const byId = Object.fromEntries(
    (profiles as Array<{ id: string }>).map((profile) => [profile.id, profile]),
  ) as Record<string, typeof astra>;
  assert.deepEqual(byId["synthetic-astra"]!.featureValues, {
    speed: "default",
    "plan-mode": "off",
    "cyber-access": "standard",
  });
  assert.deepEqual(
    byId["synthetic-opus-fast"]!.featureValues,
    { speed: "priority", ultracode: "off" },
    "claude's fast mode is the same Speed setting; T3's ultracode id is its own canonical key",
  );
  assert.deepEqual(byId["synthetic-turbo"], unmatched, "an unmatched value stays as stored");
  assert.deepEqual(byId["synthetic-clash"], clash, "two spellings that disagree stay as stored");
  assert.deepEqual(
    record.unknown.map((item) => [item.profileId, item.field, item.value]),
    [
      ["synthetic-turbo", "featureValues.service_tier", "turbo"],
      ["synthetic-clash", "featureValues.serviceTier", "default"],
    ],
  );
  const again = migrateProfileOptions(profiles, vocabularies);
  assert.deepEqual(again.profiles, profiles, "a second run changes nothing");
  assert.deepEqual(again.record.changes, []);
});

test("the store runs the option migration once and records it; a second open changes nothing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "profile-options-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "db");
  const first = new Store(path);
  first.setMeta("profiles", [astra]);
  first.close();
  const second = new Store(path);
  try {
    second.migrateProfileOptions(vocabularies);
    assert.deepEqual(second.profiles()[0]!.featureValues, {
      speed: "default",
      "plan-mode": "off",
      "cyber-access": "standard",
    });
    const record = second.getMeta<{ at: string; changes: unknown[] }>(
      "profileOptionMigration",
    )!;
    assert.equal(record.changes.length, 1);
    const stored = JSON.stringify(second.getMeta("profiles"));
    second.migrateProfileOptions(vocabularies);
    assert.equal(JSON.stringify(second.getMeta("profiles")), stored);
    assert.equal(
      second.getMeta<{ at: string }>("profileOptionMigration")!.at,
      record.at,
    );
  } finally {
    second.close();
  }
});

test("the migrated Astra profile runs on both hosts and sends no default", async (t) => {
  const { catalog } = await t3Fixture(t);
  const profile = migrated(astra);
  for (const [vocabulary, read] of [
    [paseoVocabulary, paseoOptionCatalog()],
    [t3codeVocabulary, catalog],
  ] as const) {
    const answer = profileCompatibility(profile, read, vocabulary);
    assert.equal(answer.status, "works", `${vocabulary.label}: ${answer.reason}`);
    assert.equal(
      answer.launch.featureValues,
      undefined,
      `${vocabulary.label} sends no option at its default`,
    );
  }
});

test("speed priority launches on both hosts with each host's own spelling", async (t) => {
  const { host, server, directory, catalog } = await t3Fixture(t);
  const profile = withSpeed(migrated(astra), "priority");
  const [paseo] = routingProfiles([profile], paseoOptionCatalog(), paseoVocabulary);
  assert.equal(paseo!.available, true, paseo!.problem);
  assert.deepEqual(paseo!.featureValues, { service_tier: "priority" });
  assert.deepEqual(paseo!.translated, ["speed"]);

  const [t3] = routingProfiles([profile], catalog, t3codeVocabulary);
  assert.equal(t3!.available, true, t3!.problem);
  assert.deepEqual(t3!.featureValues, { serviceTier: "priority" });
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  await host.createAgent({
    workspaceId: workspace.id,
    profile: t3 as Profile,
    title: "Synthetic role",
    mcpBindingPath: null,
    attempt: () => ({
      requestId: "launch-astra-fast",
      prompt: "Synthetic prompt",
      labels: { "nucleus.task": "synthetic-task" },
      environment: {},
    }),
  });
  const command = server.commands.find(
    (candidate) => candidate.commandId === "launch-astra-fast",
  )!;
  assert.deepEqual(
    (command.modelSelection as { options?: { id: string; value: unknown }[] })
      .options,
    [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  );

  // Claude's fast mode is the same Speed control: a toggle on both hosts.
  const opus = migrated(claudeFast);
  assert.deepEqual(
    translateProfile(paseoVocabulary, opus).launch.featureValues,
    { fast_mode: true },
  );
  assert.deepEqual(
    translateProfile(t3codeVocabulary, opus).launch.featureValues,
    { effort: "high", fastMode: true },
  );
});

test("a speed T3 can't express excludes the profile from T3 selection with a per-host note, never a send refusal", async (t) => {
  const { catalog } = await t3Fixture(t);
  const profile = withSpeed(migrated(astra), "ultrafast");
  const [paseo] = routingProfiles([profile], paseoOptionCatalog(), paseoVocabulary);
  assert.equal(paseo!.available, true, "Paseo's Astra offers ultrafast");
  assert.deepEqual(paseo!.featureValues, { service_tier: "ultrafast" });

  const answer = profileCompatibility(profile, catalog, t3codeVocabulary);
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.reason, "T3Code can't express speed Ultrafast for codex");
  const [t3] = routingProfiles([profile], catalog, t3codeVocabulary);
  assert.equal(t3!.available, false, "selection excludes it on T3");
  assert.equal(t3!.problem, "T3Code can't express speed Ultrafast for codex");

  // A model the table can carry but that does not offer the value is the same
  // canonical fact on that host, named in the operator's words.
  const terra = { ...profile, model: "gpt-6.1-terra" };
  const onPaseo = profileCompatibility(terra, paseoOptionCatalog(), paseoVocabulary);
  assert.equal(onPaseo.status, "unavailable");
  assert.equal(onPaseo.reason, "Paseo's gpt-6.1-terra has no speed Ultrafast");
  assert.equal(onPaseo.problem, onPaseo.reason);
});

test("the editor shows one Speed control from both hosts and choosing it clears host spellings", async (t) => {
  const { catalog } = await t3Fixture(t);
  const merged = mergeCanonicalCatalogs([
    canonicalCatalog(paseoVocabulary, paseoOptionCatalog()),
    canonicalCatalog(t3codeVocabulary, catalog),
  ]);
  const astraModel = merged.providers
    .find((provider) => provider.key === "codex")!
    .models.find((model) => model.id === "gpt-6.2-astra")!;
  assert.deepEqual(
    astraModel.features.map((feature) => [feature.id, feature.label]),
    [
      ["speed", "Speed"],
      ["plan-mode", "Plan mode"],
      ["cyber-access", "Cyber access"],
    ],
    "no service_tier, serviceTier, plan_mode or cyberAccessProgram",
  );
  const speed = astraModel.features[0]!;
  assert.equal(speed.type, "select");
  assert.deepEqual(
    speed.type === "select" ? speed.options.map((option) => [option.id, option.label]) : [],
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
  assert.ok(!opus.features.some((feature) => ["fast_mode", "fastMode"].includes(feature.id)));

  // The editor judges the canonical profile against the canonical catalog.
  assert.equal(profileAvailability(withSpeed(migrated(astra), "priority"), merged).available, true);
  assert.deepEqual(
    withCanonicalOption("codex", { service_tier: "turbo", plan_mode: false }, "speed", "priority"),
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
