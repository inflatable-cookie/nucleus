import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import {
  HostSnapshotPendingError,
  ProvenPreSendRefusalError,
} from "../core/host";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { isReasoningDescriptor } from "../hosts/t3code/thinking";
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
import {
  liveConfigModels,
  reProbingConfigModels,
  settledNoCarrierConfigModels,
  unprobedConfigModels,
} from "./support/t3-nightly-config";

/**
 * The reason a T3-hosted profile launches, and the reason it waits (nucleus#1375).
 *
 * nucleus#1364's pilot failed on the live host with
 * `T3Code model gpt-6.1-terra has no "reasoning option" option`: the nested role
 * launch judged the codex profile's options against the *parent* provider's model
 * entry (the `nucleus` ACP model, which reports no options), and a snapshot read
 * while a provider re-probes was treated as a settled absence. The shapes below
 * are the live host's own `server.getConfig` entries (nucleus#1375 capture), so
 * the carrier, the nearest-level rule, the host wait and the drift fence are all
 * checked against what the server really reports.
 */

const stored = (index: number, values: Record<string, unknown>) =>
  nucleusProfileSchema.parse({
    id: `profile-${index}`,
    name: `profile-${index}`,
    ...values,
  });

const terra = stored(0, {
  provider: "codex",
  model: "gpt-6.1-terra",
  modeId: "full-access",
  thinkingOptionId: "high",
});
const luna = stored(1, {
  provider: "codex",
  model: "gpt-6-luna",
  modeId: "full-access",
  thinkingOptionId: "xhigh",
});
const lunaMax = stored(2, {
  provider: "codex",
  model: "gpt-6-luna",
  modeId: "full-access",
  thinkingOptionId: "max",
});
const lunaUltra = stored(3, {
  provider: "codex",
  model: "gpt-6-luna",
  modeId: "full-access",
  thinkingOptionId: "ultra",
});
const muse = stored(4, {
  provider: "pi",
  model: "opencode-go/muse-spark-1.3-contributor",
  thinkingOptionId: "medium",
});
const museMax = stored(5, {
  provider: "pi",
  model: "opencode-go/muse-spark-1.3-contributor",
  thinkingOptionId: "max",
});
const deepseek = stored(6, {
  provider: "pi",
  model: "opencode-go/deepseek-v4.1-flash",
  thinkingOptionId: "high",
});
const claude = stored(7, {
  provider: "claude",
  model: "claude-opus-5-5",
  thinkingOptionId: "high",
});
const claudeUltra = stored(8, {
  provider: "claude",
  model: "claude-opus-5-5",
  thinkingOptionId: "ultra",
});
const piDefault = stored(9, {
  provider: "pi",
  model: "default",
  thinkingOptionId: "medium",
});

const profiles = [
  terra,
  luna,
  lunaMax,
  lunaUltra,
  muse,
  museMax,
  deepseek,
  claude,
  claudeUltra,
  piDefault,
];
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

async function fixture(
  t: TestContext,
  providerShapes: unknown = liveConfigModels,
  capture = false,
) {
  const root = mkdtempSync(join(tmpdir(), "t3-thinking-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = structuredClone(
    providerShapes,
  ) as typeof liveConfigModels;
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
    ...(capture ? { modelCapturePath: join(root, "models.json") } : {}),
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

const workspaceOf = (host: T3CodeHost, directory: string) =>
  host.createWorkspace({
    title: "Synthetic worktree",
    requestId: "workspace-intent",
    directory,
    project: { projectId: "synthetic-project" },
  });

test("codex terra and luna send T3's real native reasoning value", async (t) => {
  const { directory, host, server, catalog } = await fixture(t);
  const workspace = await workspaceOf(host, directory);
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
  // The live codex models carry the level on `reasoningEffort` with no `role`;
  // the id is the carrier T3's own client reads.
  assert.deepEqual(
    await optionsSent(translated(terra, catalog), "launch-terra"),
    [{ id: "reasoningEffort", value: "high" }],
    "terra's high reaches the real carrier",
  );
  assert.deepEqual(
    await optionsSent(translated(lunaMax, catalog), "launch-luna-max"),
    [{ id: "reasoningEffort", value: "max" }],
    "luna's offered max reaches the real carrier",
  );
  // A level the model does not offer settles by the one thinking-scale rule.
  assert.deepEqual(
    await optionsSent(translated(lunaUltra, catalog), "launch-luna-ultra"),
    [{ id: "reasoningEffort", value: "max" }],
  );
});

test("pi and claude keep the table's own carrier", async (t) => {
  const { directory, host, server, catalog } = await fixture(t);
  const workspace = await workspaceOf(host, directory);
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
  const museProfile = translated(muse, catalog);
  assert.deepEqual(
    museProfile.featureValues,
    { thinking: "medium" },
    "the routing profile still carries Pi's translated feature",
  );
  assert.deepEqual(museProfile.translated, ["thinking"]);
  assert.deepEqual(await optionsSent(museProfile, "launch-muse"), [
    { id: "thinking", value: "medium" },
  ]);
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
  );
  // Claude's level is the `effort` option, and T3's top level is `ultrathink`.
  assert.deepEqual(
    await optionsSent(translated(claude, catalog), "launch-claude"),
    [{ id: "effort", value: "high" }],
  );
  assert.deepEqual(
    await optionsSent(translated(claudeUltra, catalog), "launch-claude-ultra"),
    [{ id: "effort", value: "ultrathink" }],
  );
  // A canonical level the real model does not report is settled to the nearest
  // one this model offers.
  assert.deepEqual(
    await optionsSent(
      {
        ...translated(deepseek, catalog),
        thinkingOptionId: "medium",
      } as Profile,
      "launch-tie",
    ),
    [{ id: "thinking", value: "low" }],
  );
  assert.deepEqual(
    await optionsSent(translated(museMax, catalog), "launch-muse-max"),
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

test("the reasoning carrier is T3's own: a select id from its client, or a select it marks reasoning", () => {
  const select = (id: string, role?: string) => ({
    id,
    label: id,
    type: "select" as const,
    options: [{ id: "high", label: "High" }],
    ...(role ? { role } : {}),
  });
  for (const id of [
    "reasoningEffort",
    "effort",
    "reasoning",
    "variant",
    "reasoning_effort",
    "thinking_level",
    "thinking",
  ])
    assert.equal(
      isReasoningDescriptor(select(id)),
      true,
      `${id} is one of T3's own thinking selects`,
    );
  assert.equal(isReasoningDescriptor(select("serviceTier")), false);
  assert.equal(isReasoningDescriptor(select("anything", "reasoning")), true);
  assert.equal(
    isReasoningDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "boolean",
    }),
    false,
    "only a select carries a level",
  );
});

test("selection judges a T3 task against T3's own catalog, so a profile T3 cannot launch is never chosen", async (t) => {
  const { catalog } = await fixture(t);
  const answers = routingProfiles(profiles, catalog, t3codeVocabulary);
  const by = (profile: typeof muse) =>
    answers.find((answer) => answer.id === profile.id)!;
  // The live Muse shape: available, with exactly Pi's levels.
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
  // The live codex shapes: `gpt-6.1-terra` and `gpt-6-luna` ride reasoningEffort.
  assert.deepEqual(by(terra).supportedThinking, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(by(terra).available, true);
  assert.deepEqual(by(luna).supportedThinking, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(by(luna).available, true);
  // The live claude shape carries its level on `effort`.
  assert.deepEqual(by(claude).supportedThinking, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(by(claude).available, true);
  // A level the model does not report keeps the profile ineligible here, with
  // the reason named, instead of failing at send.
  assert.equal(by(museMax).available, false);
  assert.equal(
    by(museMax).problem,
    "T3Code's opencode-go/muse-spark-1.3-contributor has no thinking level max",
  );
  assert.equal(by(lunaUltra).available, false);
  assert.equal(
    by(lunaUltra).problem,
    "T3Code's gpt-6-luna has no thinking level ultra",
  );
  // Pi's `default` model reports no option descriptors at all and its provider
  // reports options on other models: that is a settled absence, so a thinking
  // profile there is ineligible rather than waiting forever.
  assert.equal(by(piDefault).available, false);
  assert.equal(
    by(piDefault).problem,
    "T3Code's default has no thinking level medium",
  );
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
  const onlyMax = pool().map((entry, index) => ({
    ...entry,
    enabled: profiles[index] === museMax,
  }));
  assert.equal(chooseProfile(task, answers, onlyMax, {}, new Set()), null);
});

/** One raw provider entry from the captured shape, as the launch reads it. */
const rawProvider = (shapes: unknown, instanceId: string) =>
  (shapes as Array<Record<string, unknown> & { instanceId: string }>).find(
    (provider) => provider.instanceId === instanceId,
  );
const rawModel = (provider: Record<string, unknown>, slug: string) =>
  (provider.models as Array<{ slug: string }> | undefined)?.find(
    (model) => model.slug === slug,
  );

/** The launch's own fence, over the captured `server.getConfig` entry. */
const fence = (
  host: T3CodeHost,
  shapes: unknown,
  profile: Profile,
): { id: string; value: string | boolean }[] => {
  const provider = rawProvider(shapes, profile.provider)!;
  return host.modelSelectionOptions(
    profile,
    provider as never,
    rawModel(provider, profile.model) as never,
  );
};

test("selection and the pre-send fence agree on every profile selection keeps", async (t) => {
  const { catalog, host } = await fixture(t);
  const answers = routingProfiles(profiles, catalog, t3codeVocabulary);
  const kept = answers.filter((answer) => answer.available);
  assert.ok(kept.length >= 7, "the live shapes keep several profiles");
  for (const answer of kept) {
    // The same captured entry selection read, passed through the same fence the
    // launch uses: never a refusal for a profile selection kept.
    assert.doesNotThrow(
      () => fence(host, liveConfigModels, answer),
      `${answer.name} is kept by selection and must not be refused`,
    );
  }
  // And the fence never invents a level the model does not offer.
  assert.deepEqual(
    fence(host, liveConfigModels, {
      ...translated(terra, catalog),
      thinkingOptionId: "minimal",
    } as Profile),
    [{ id: "reasoningEffort", value: "low" }],
    "a level below the offered range settles upward by the one rule",
  );
});

test("a mid-probe snapshot is a host wait, not a refusal", async (t) => {
  // T3's initial snapshot: the provider is still probing and no options are
  // reported yet. Selection cannot judge the profile (the provider is not ready)
  // and the launch must wait, never refuse.
  const probing = await fixture(t, reProbingConfigModels);
  await assert.rejects(
    probing.host.createAgent(
      launchSpec(
        (await workspaceOf(probing.host, probing.directory)).id,
        translated(terra, probing.catalog),
        "launch-probing",
      ),
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof HostSnapshotPendingError,
        String((error as Error)?.stack ?? error),
      );
      assert.match((error as HostSnapshotPendingError).detail, /codex/);
      return true;
    },
  );
  // The provider reports `ready` while its models carry no options yet: a shape
  // T3's cached snapshot really takes during a re-probe. Selection keeps the
  // profile — nothing is known to be missing — and the launch waits.
  const unprobed = await fixture(t, unprobedConfigModels);
  const profile = translated(terra, unprobed.catalog);
  assert.equal(
    profile.available,
    true,
    "selection keeps a profile whose options the host has not settled",
  );
  assert.equal(profile.problem, "");
  await assert.rejects(
    unprobed.host.createAgent(
      launchSpec(
        (await workspaceOf(unprobed.host, unprobed.directory)).id,
        profile,
        "launch-unprobed",
      ),
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof HostSnapshotPendingError,
        String((error as Error)?.stack ?? error),
      );
      assert.match(
        (error as HostSnapshotPendingError).detail,
        /reports no model options yet/,
      );
      return true;
    },
  );
});

test("a settled snapshot with no carrier is refused before send, listing its real descriptors", async (t) => {
  const { directory, host, catalog, server } = await fixture(
    t,
    settledNoCarrierConfigModels,
  );
  const workspace = await workspaceOf(host, directory);
  // Codex still reports its other options and no thought-level control: the
  // snapshot has settled, so this is drift, not a probe in flight.
  const profile = translated(terra, catalog);
  assert.equal(profile.available, false, "selection also sees the absence");
  await assert.rejects(
    host.createAgent(launchSpec(workspace.id, profile, "launch-absent")),
    (error: unknown) => {
      assert.ok(
        error instanceof ProvenPreSendRefusalError,
        String((error as Error)?.stack ?? error),
      );
      assert.match(
        (error as ProvenPreSendRefusalError).reason,
        /has no "reasoning option" option/,
      );
      assert.match(
        (error as ProvenPreSendRefusalError).reason,
        /serviceTier:select, cyberAccessProgram:select/,
        "the refusal lists the model's real option descriptors",
      );
      return true;
    },
  );
  assert.equal(
    server.commands.some(
      (command) => command.method === "orchestration.launchThread",
    ),
    false,
    "nothing was sent",
  );
});

test("the catalog reports the desk's real model shapes as one diagnostic line", async (t) => {
  const { host } = await fixture(t);
  const shapes = host.modelShapes;
  assert.match(
    shapes,
    /codex\(ready\): gpt-6\.1-terra \[reasoningEffort:select/,
  );
  assert.match(shapes, /gpt-6-luna \[reasoningEffort:select/);
  assert.match(shapes, /claudeAgent\(ready\): claude-opus-5-5 \[effort:select/);
  assert.match(shapes, /pi\(ready\): default \[none\]/);
  assert.match(shapes, /thinking:select/);
});

test("a role profile's options come from its own provider entry, never the parent's", async (t) => {
  const { host, catalog } = await fixture(t);
  // The live `nucleus` ACP parent provider reports two models with no options at
  // all. A codex role profile's options are resolved against codex's own entry,
  // which is what the nested launch does; judging it against the parent's entry
  // would have refused every nested role launch (nucleus#1375).
  const parent = catalog.providers.find(
    (provider) => provider.key === "nucleus",
  )!;
  assert.deepEqual(parent.models[0]!.features, []);
  assert.deepEqual(parent.models[0]!.thinkingOptions, []);
  assert.deepEqual(fence(host, liveConfigModels, translated(terra, catalog)), [
    { id: "reasoningEffort", value: "high" },
  ]);
  assert.equal(
    profileCompatibility(terra, catalog, t3codeVocabulary).status,
    "works",
  );
});


test("the existing config read writes a bounded model capture when requested", async (t) => {
  const { root, server } = await fixture(t, liveConfigModels, true);
  const captured = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
  const codex = captured.providers.find((p: { instanceId: string }) => p.instanceId === "codex");
  assert.deepEqual(codex.models.map((m: { slug: string }) => m.slug), ["gpt-6.1-terra", "gpt-6-luna"]);
  assert.ok(captured.providers.some((p: { instanceId: string }) => p.instanceId === "pi"));
  assert.ok(captured.providers.some((p: { instanceId: string }) => p.instanceId === "claudeAgent"));
  assert.equal(JSON.stringify(captured).includes("synthetic-bearer"), false);
  assert.equal(server.requests.filter((call) => call.tag === "server.getConfig").length, 2);
});

test("a generic variant without levels remains a feature beside the real carrier", async (t) => {
  const shapes = structuredClone(liveConfigModels);
  const model = shapes[0]!.models[0]!;
  model.capabilities!.optionDescriptors.unshift({
    id: "variant", label: "Variant", type: "select",
    options: [{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }],
  } as never);
  const { catalog, host } = await fixture(t, shapes);
  const entry = catalog.providers.find((p) => p.key === "codex")!.models.find((m) => m.id === model.slug)!;
  assert.ok(entry.features.some((f) => f.id === "variant"));
  assert.ok(entry.thinkingOptions.some((o) => o.id === "high"));
  assert.deepEqual(host.modelSelectionOptions({ ...profiles[0]!, provider: "codex", model: model.slug, thinkingOptionId: "high" } as Profile, shapes[0] as never, model as never), [{ id: "reasoningEffort", value: "high" }]);
});
