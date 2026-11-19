import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { ProvenPreSendRefusalError } from "../core/host";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { chooseProfile } from "../core/dispatch/routing";
import {
  nearestThinkingLevel,
  canonicalThinkingValue,
} from "../shared/profile-vocabulary";
import {
  nucleusProfileSchema,
  profileCompatibility,
  routingProfiles,
} from "../shared/profiles";
import { poolSchema, type PoolEntry, type Profile } from "../shared/contracts";
import { t3Fake } from "./support/t3code-fake";
import { nightlyConfigModels } from "./support/t3-nightly-config";

/**
 * nucleus#1364: the T3 host pilot (nucleus#1363) stored "Muse 1.3 grind" as Pi's
 * `thinking: medium`, and the launch died with
 * `T3Code model opencode-go/muse-spark-1.3-contributor has no "thinking" option`
 * while the codex coordinator died with
 * `T3Code model gpt-6-luna has no reasoning option "xhigh"`. The shapes below are
 * the nightly's own, so the translation, the nearest-level rule and the drift
 * fence are checked against what the server really reports.
 */

const stored = (index: number, values: Record<string, unknown>) =>
  nucleusProfileSchema.parse({
    id: `profile-${index}`,
    name: `profile-${index}`,
    ...values,
  });

/** The pool's own Muse/Luna shapes, canonical (task 1158). */
const muse = stored(0, {
  provider: "pi",
  model: "opencode-go/muse-spark-1.3-contributor",
  thinkingOptionId: "medium",
});
const deepseek = stored(1, {
  provider: "pi",
  model: "opencode-go/deepseek-v4.1-flash",
  thinkingOptionId: "high",
});
const luna = stored(2, {
  provider: "codex",
  model: "gpt-6-luna",
  modeId: "full-access",
  thinkingOptionId: "xhigh",
});
const lunaUltra = stored(3, {
  provider: "codex",
  model: "gpt-6-luna",
  modeId: "full-access",
  thinkingOptionId: "ultra",
});
const museMax = stored(4, {
  provider: "pi",
  model: "opencode-go/muse-spark-1.3-contributor",
  thinkingOptionId: "max",
});

const profiles = [muse, deepseek, luna, lunaUltra, museMax];
const pool = (): PoolEntry[] =>
  profiles.map((profile, index) =>
    poolSchema.parse({
      profileId: profile.id,
      enabled: true,
      group: `group-${index}`,
      roles: ["worker", "coordinator"],
      weight: 1,
      scopes: ["general"],
      capability: "medium",
      cost: "medium",
    }),
  );

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3-thinking-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = structuredClone(nightlyConfigModels);
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
  });
  t.after(() => {
    host.close();
    rmSync(root, { recursive: true, force: true });
  });
  await host.connect();
  const catalog = await host.catalog();
  return { root, directory, host, server, catalog };
}

const translated = (
  root: string,
  profile: typeof muse,
  catalog: Awaited<ReturnType<typeof fixture>>["catalog"],
): Profile => routingProfiles([profile], catalog, t3codeVocabulary)[0]!;

const launchSpec = (
  workspaceId: string,
  profile: Profile,
  requestId: string,
) => ({
  workspaceId,
  profile,
  title: "Synthetic role",
  mcpBindingPath: null,
  attempt: () => ({
    requestId,
    prompt: "Synthetic prompt",
    labels: { task: "synthetic-task", role: "worker" },
    environment: {},
  }),
});

test("canonical thinking reaches T3 whichever way the profile stores it and whichever descriptor carries it", async (t) => {
  const { directory, host, server, catalog } = await fixture(t);
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const optionsSent = async (profile: Profile, requestId: string) => {
    await host.createAgent(launchSpec(workspace.id, profile, requestId));
    const command = server.commands.find(
      (candidate) => candidate.commandId === requestId,
    )!;
    return (
      (command.modelSelection as { options?: { id: string; value: unknown }[] })
        .options ?? []
    );
  };
  // Pi: the canonical level is the table's `thinking` feature, carried by the
  // model's own `thinking` select (the nightly reports minimal..xhigh).
  const museProfile = translated("muse", muse, catalog);
  assert.deepEqual(
    museProfile.featureValues,
    { thinking: "medium" },
    "the routing profile carries the translated feature",
  );
  assert.deepEqual(museProfile.translated, ["thinking"]);
  assert.deepEqual(
    await optionsSent(museProfile, "launch-muse"),
    [{ id: "thinking", value: "medium" }],
    "thinking medium reaches Pi's reasoning descriptor",
  );
  // The same value in `thinkingOptionId` (a canonical profile launched directly)
  // is the same fact and reaches the same option.
  assert.deepEqual(
    await optionsSent(
      {
        ...museProfile,
        thinkingOptionId: "medium",
        featureValues: undefined,
      } as Profile,
      "launch-muse-canonical",
    ),
    [{ id: "thinking", value: "medium" }],
    "a canonical thinkingOptionId reaches the same carrier",
  );
  // Codex: no table carrier, so the level rides the reasoning select.
  assert.deepEqual(
    await optionsSent(translated("luna", luna, catalog), "launch-luna"),
    [{ id: "reasoningEffort", value: "xhigh" }],
    "xhigh reaches codex's reasoning descriptor",
  );
  // Other feature values still pass through unchanged.
  const withFeature = {
    ...translated("luna", luna, catalog),
    featureValues: { serviceTier: "priority" },
  } as Profile;
  assert.deepEqual(await optionsSent(withFeature, "launch-luna-feature"), [
    { id: "reasoningEffort", value: "xhigh" },
    { id: "serviceTier", value: "priority" },
  ]);
});

test("a canonical level the real model does not report is settled to the nearest one the vocabulary rule allows", async (t) => {
  const { directory, host, server, catalog } = await fixture(t);
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  const optionsSent = async (profile: Profile, requestId: string) => {
    await host.createAgent(launchSpec(workspace.id, profile, requestId));
    const command = server.commands.find(
      (candidate) => candidate.commandId === requestId,
    )!;
    return (
      (command.modelSelection as { options?: { id: string; value: unknown }[] })
        .options ?? []
    );
  };
  // The real gpt-6-luna offers low..max: `ultra` settles to `max`.
  assert.deepEqual(
    await optionsSent(
      translated("luna-ultra", lunaUltra, catalog),
      "launch-ultra",
    ),
    [{ id: "reasoningEffort", value: "max" }],
  );
  // The real DeepSeek 4.1 Flash offers low, high and max only: `medium` is the
  // same distance from low and high, so the thinking-scale tie settles to low.
  const deepseekProfile = {
    ...translated("deepseek", deepseek, catalog),
    thinkingOptionId: "medium",
  } as Profile;
  assert.deepEqual(await optionsSent(deepseekProfile, "launch-tie"), [
    { id: "thinking", value: "low" },
  ]);
  // Muse 1.3 offers minimal..xhigh: `max` settles to `xhigh`.
  assert.deepEqual(
    await optionsSent(translated("muse-max", museMax, catalog), "launch-max"),
    [{ id: "thinking", value: "xhigh" }],
  );
  // The rule is one ordered scale: distance first, lower on a tie.
  assert.equal(nearestThinkingLevel(["low", "high", "max"], "medium"), "low");
  assert.equal(nearestThinkingLevel(["low", "high", "max"], "xhigh"), "high");
  assert.equal(
    nearestThinkingLevel(["minimal", "low", "medium", "high", "xhigh"], "max"),
    "xhigh",
  );
  assert.equal(nearestThinkingLevel([], "medium"), null);
  assert.equal(
    canonicalThinkingValue(t3codeVocabulary.providers.claude!, "ultrathink"),
    "ultra",
  );
});

test("selection judges a T3 task against T3's own catalog, so a profile T3 cannot launch is never chosen", async (t) => {
  const { catalog } = await fixture(t);
  const answers = routingProfiles(profiles, catalog, t3codeVocabulary);
  const by = (profile: typeof muse) =>
    answers.find((answer) => answer.id === profile.id)!;
  // The stored Muse shape the pilot picked: available, with exactly Pi's levels.
  assert.deepEqual(
    {
      available: by(muse).available,
      problem: by(muse).problem,
      supportedThinking: by(muse).supportedThinking,
    },
    {
      available: true,
      problem: "",
      supportedThinking: ["minimal", "low", "medium", "high", "xhigh"],
    },
  );
  // A level the model does not report keeps the profile ineligible here, with
  // the reason named, instead of failing at send.
  assert.equal(by(museMax).available, false);
  assert.equal(
    by(museMax).problem,
    "T3Code's opencode-go/muse-spark-1.3-contributor has no thinking level max",
  );
  // gpt-6-luna offers low..max, so 'ultra' is ineligible on T3.
  assert.equal(by(lunaUltra).available, false);
  assert.equal(
    by(lunaUltra).problem,
    "T3Code's gpt-6-luna has no thinking level ultra",
  );
  assert.equal(by(luna).available, true);
  // Selection over that snapshot never returns an ineligible profile.
  const task = {
    id: "task",
    complexity: "high",
    scope: "general",
    profileRequests: {},
    pool: [],
  } as never;
  const chosen = chooseProfile(task, answers, pool(), {}, new Set());
  assert.ok(chosen, "an eligible profile is selected");
  assert.ok(
    chosen.profile.available !== false,
    "selection never returns a profile T3 cannot launch",
  );
  // With only the ineligible Muse-max shape enabled, selection answers none.
  const onlyMax = pool().map((entry, index) => ({
    ...entry,
    enabled: profiles[index] === museMax,
  }));
  assert.equal(chooseProfile(task, answers, onlyMax, {}, new Set()), null);
});

test("a model whose snapshot reports no thinking carrier is refused before send, naming the option and level", async (t) => {
  const { directory, host, catalog, server } = await fixture(t);
  const workspace = await host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });
  // The pilot's launch-time snapshot: the model is listed, its option
  // descriptors are not (the provider was re-probing). Selection had judged the
  // earlier, complete snapshot. This fence keeps that drift from being sent.
  server.controls.providers = structuredClone(nightlyConfigModels).map(
    (provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        capabilities: { optionDescriptors: [] },
      })),
    }),
  );
  const profile = translated("muse", muse, catalog);
  await assert.rejects(
    host.createAgent(launchSpec(workspace.id, profile, "launch-drift")),
    (error: unknown) => {
      assert.ok(
        error instanceof ProvenPreSendRefusalError,
        String((error as Error)?.stack ?? error),
      );
      assert.match(
        (error as ProvenPreSendRefusalError).reason,
        /has no "thinking" option/,
      );
      return true;
    },
  );
});
