import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { t3HostCatalog } from "../hosts/t3code/catalog";
import { configProvider } from "../hosts/t3code/config";
import { t3codeVocabulary } from "../hosts/t3code/vocabulary";
import { paseoVocabulary } from "../hosts/paseo/vocabulary";
import {
  canonicalCatalog,
  mergeCanonicalCatalogs,
} from "../shared/profile-vocabulary";
import type { HostCatalog } from "../shared/host";
import { nightlyProviders, paseoCatalog } from "./support/pool-shapes";
import { HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, waitFor } from "./support/budgets";

/**
 * nucleus#1365: the profile editor shows one Thinking and one Mode control in
 * canonical values, and no host's thinking carrier (T3's Pi `thinking`, its
 * `reasoningEffort` select) appears again as a feature field.
 */
useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, { get: () => "#123" }) as never;

function t3Catalog(): HostCatalog {
  return t3HostCatalog(configProvider.array().parse(nightlyProviders()));
}

async function editor(
  catalog: HostCatalog,
  initial: Record<string, unknown>,
  calls: Array<{ method: string; input: any }> = [],
) {
  const { ProfileEditor } = await import("../client/settings-profile-editor");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invoke = async (method: string, input: any) => {
    calls.push({ method, input });
    return { profile: { notes: "", ...input } };
  };
  return mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: invoke as never,
        children: h(ProfileEditor as never, {
          c: colors,
          catalog,
          catalogs: [],
          directory: null,
          projects: [],
          repositories: [],
          initial: { notes: "", ...initial },
          entry: null,
          state: null,
          busy: false,
          poolSaveStatus: "",
          onChooseDirectory: () => {},
        }),
      }),
    }),
  );
}

/** Every control the editor labels with a field name, by that name. */
const controls = (ui: Awaited<ReturnType<typeof editor>>, name: string) =>
  ui.all(new RegExp(`^${name}, `));

test("a model whose host carries thinking as a feature shows exactly one Thinking and one Mode control and no thinking or reasoning field", async () => {
  const merged = mergeCanonicalCatalogs([
    canonicalCatalog(paseoVocabulary, paseoCatalog()),
    canonicalCatalog(t3codeVocabulary, t3Catalog()),
  ]);
  // Muse 1.3 grind after migration: T3 carries Pi's level as its `thinking` option.
  const ui = await editor(merged, {
    id: "synthetic-muse",
    name: "Muse 1.3 grind",
    provider: "pi",
    model: "opencode-go/muse-spark-1.3-contributor",
    thinkingOptionId: "medium",
  });
  assert.equal(controls(ui, "Thinking").length, 1, "one Thinking control");
  assert.equal(controls(ui, "Mode").length, 1, "one Mode control");
  assert.equal(
    ui.get(/^Thinking, /).props.accessibilityLabel,
    "Thinking, Medium",
  );
  assert.doesNotMatch(
    ui.text(),
    /Reasoning|Effort/,
    "no carrier shows as a feature",
  );
  // T3's codex reasoning select is the Thinking control, never a feature beside it.
  const codex = await editor(merged, {
    id: "synthetic-luna",
    name: "Codex grind",
    provider: "codex",
    model: "gpt-6-luna",
    modeId: "full-access",
    thinkingOptionId: "xhigh",
  });
  assert.equal(controls(codex, "Thinking").length, 1);
  assert.equal(controls(codex, "Mode").length, 1);
  assert.equal(codex.all(/^Reasoning, /).length, 0);
  // T3's `serviceTier` is the one canonical Speed control (nucleus#1386).
  assert.equal(
    codex.all(/^Speed, /).length,
    1,
    "other provider options still show, once, under their canonical name",
  );
  assert.equal(codex.all(/^Service Tier, /).length, 0);
});

test("a model with no modes still shows its one Mode control, as Host default", async () => {
  const ui = await editor(canonicalCatalog(paseoVocabulary, paseoCatalog()), {
    id: "synthetic-pi",
    name: "Pi",
    provider: "pi",
    model: "opencode-go/deepseek-v4.1-flash",
    thinkingOptionId: "high",
  });
  assert.equal(controls(ui, "Mode").length, 1);
  assert.equal(ui.get("Mode, Host default").type, "Text");
  assert.equal(controls(ui, "Thinking").length, 1);
});

test("a thinking carrier the migration kept shows under the one Thinking control, and choosing a level replaces it and keeps other options", async () => {
  const merged = mergeCanonicalCatalogs([
    canonicalCatalog(paseoVocabulary, paseoCatalog()),
    canonicalCatalog(t3codeVocabulary, t3Catalog()),
  ]);
  // The migration left this clash as stored: level low, T3's Pi carrier max.
  const calls: Array<{ method: string; input: any }> = [];
  const ui = await editor(
    merged,
    {
      id: "synthetic-clash",
      name: "Disagree",
      provider: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
      thinkingOptionId: "low",
      featureValues: { thinking: "max", extra: true },
    },
    calls,
  );
  assert.equal(
    controls(ui, "Thinking").length,
    1,
    "still one Thinking control",
  );
  assert.match(
    ui.get("Stored thinking option").children.join(""),
    /Also stored: thinking max/,
  );
  ui.press("Thinking, Low");
  ui.press("Thinking: High");
  await waitFor(
    () => calls.some((call) => call.method === "profile.update"),
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "the edit to save",
  );
  const update = calls.find((call) => call.method === "profile.update")!.input;
  assert.deepEqual(
    [update.thinkingOptionId, update.featureValues],
    ["high", { extra: true }],
    "the carrier goes, other options stay",
  );
  assert.equal(ui.query("Stored thinking option"), undefined);
});

test("a stored level outside this model's list shows as unavailable in the one Thinking control, so another level can replace it", async () => {
  const ui = await editor(canonicalCatalog(paseoVocabulary, paseoCatalog()), {
    id: "synthetic-odd",
    name: "Odd",
    provider: "claude",
    model: "claude-opus-5-5",
    thinkingOptionId: "ultracode",
  });
  assert.equal(controls(ui, "Thinking").length, 1);
  ui.press(/^Thinking, /);
  assert.ok(ui.query("Thinking: ultracode · unavailable"));
  assert.ok(ui.query("Thinking: Medium"));
});

test("a saved model no host reports keeps its retained thinking shown and repairable through the one Thinking control", async () => {
  // The migration kept this clash; its model is retired, so no catalog lists it.
  const calls: Array<{ method: string; input: any }> = [];
  const ui = await editor(
    canonicalCatalog(paseoVocabulary, paseoCatalog()),
    {
      id: "synthetic-retired",
      name: "Retired",
      provider: "pi",
      model: "opencode-go/retired-model",
      thinkingOptionId: "low",
      featureValues: { thinking: "max", extra: true },
    },
    calls,
  );
  assert.equal(controls(ui, "Thinking").length, 1, "one Thinking control");
  assert.equal(controls(ui, "Mode").length, 1, "one Mode control");
  assert.match(
    ui.get("Stored thinking option").children.join(""),
    /Also stored: thinking max/,
  );
  ui.press("Thinking, Low");
  ui.press("Thinking: High");
  await waitFor(
    () => calls.some((call) => call.method === "profile.update"),
    HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS,
    "the edit to save",
  );
  const update = calls.find((call) => call.method === "profile.update")!.input;
  assert.deepEqual(
    [update.model, update.thinkingOptionId, update.featureValues],
    ["opencode-go/retired-model", "high", { extra: true }],
    "the model and other options stay; the carrier goes",
  );
  // An unmapped stored level on a retired model shows too, and another level replaces it.
  const odd = await editor(canonicalCatalog(paseoVocabulary, paseoCatalog()), {
    id: "synthetic-odd-retired",
    name: "Odd retired",
    provider: "claude",
    model: "claude-retired",
    thinkingOptionId: "ultracode",
  });
  assert.equal(controls(odd, "Thinking").length, 1);
  odd.press(/^Thinking, /);
  assert.ok(odd.query("Thinking: ultracode · unavailable"));
  assert.ok(odd.query("Thinking: Medium"));
});
