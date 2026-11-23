import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import type { NucleusProfile } from "../shared/profiles";
import type { StoredHostCatalog } from "../shared/host";

/**
 * Spec 052, step 2 of the Paseo split: Settings' Profiles section creates and
 * edits Nucleus's own profiles from the canonical vocabulary every registered
 * host's catalog converges on (`profile.vocabulary`, task 1158), and shows each
 * one's availability with its plain reason. Routing uses the stored profiles.
 */

useNativeStubs();

type SettingsModule = typeof import("../client/settings-screen");
let settings: SettingsModule;
const load = async () => {
  settings = await import("../client/settings-screen");
  return settings;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail("the profiles panel did not settle");
}

/** The form's vocabulary as `profile.vocabulary` answers it: two available providers with models, modes, thinking and features. */
const catalog: StoredHostCatalog = {
  readAt: "2026-11-09T09:00:00.000Z",
  providers: [
    {
      key: "codex",
      label: "Codex",
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
            { id: "auto", label: "Auto", description: "Full agent work" },
            { id: "plan", label: "Plan" },
          ],
          features: [
            { type: "toggle", id: "web", label: "Web search", value: false },
            {
              type: "select",
              id: "permissions",
              label: "Permissions",
              value: "ask",
              options: [
                { id: "ask", label: "Ask" },
                { id: "allow", label: "Allow", isDefault: true },
              ],
            },
          ],
        },
        {
          id: "gpt-5-mini",
          label: "GPT-5 mini",
          aliases: [],
          thinkingOptions: [],
          defaultThinkingOptionId: null,
          modes: [{ id: "auto", label: "Auto" }],
          features: [],
        },
      ],
    },
    {
      key: "claude",
      label: "Claude",
      available: true,
      problem: "",
      models: [
        {
          id: "claude-1",
          label: "Claude 1",
          aliases: [],
          thinkingOptions: [],
          defaultThinkingOptionId: null,
          modes: [],
          features: [
            { type: "toggle", id: "fast", label: "Fast", value: false },
          ],
        },
      ],
    },
    {
      key: "cursor",
      label: "Cursor",
      available: false,
      problem: "Sign in required to use Cursor.",
      models: [
        {
          id: "cursor-1",
          label: "Cursor 1",
          aliases: [],
          thinkingOptions: [],
          defaultThinkingOptionId: null,
          modes: [],
          features: [],
        },
      ],
    },
  ],
};

function choose(
  ui: ReturnType<typeof mount>,
  label: string,
  option: string,
  current: string,
) {
  ui.press(`${label}, ${current}`);
  ui.press(`${label}: ${option}`);
}

/** A profile imported from a host that had Anthropic: unavailable here, with the reason. */
const imported = (): NucleusProfile =>
  ({
    id: "imported",
    name: "Imported Sol",
    provider: "anthropic",
    model: "opus",
    notes: "Kept from Paseo",
    featureValues: undefined,
  }) as NucleusProfile;

const board = () => ({
  revision: 1,
  connected: true,
  hostId: "host",
  paused: false,
  error: "",
  quiet: true,
  activeWorkers: 0,
  unsettled: 0,
  globalLimit: 32,
  projectLimit: 5,
  papercutProjectLimit: 2,
  tasks: [],
  profiles: [],
  pool: [],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes: [],
  projects: [],
  projectLimitOverrides: {},
  projectInFlightLimitOverrides: {},
  projectCapacities: [],
  prStates: {},
});

interface Fixture {
  profiles: NucleusProfile[];
  creates: unknown[];
  updates: unknown[];
  removes: unknown[];
  catalogReads: { cwd?: string; refresh?: boolean }[];
  /** `profile.compatibility`'s answer; no hosts when unset. */
  compatibility?: { hosts: unknown[]; rows: unknown[] };
  /** Answers `profile.vocabulary` instead of the fixed catalog when set. */
  catalogAnswer?: (input: {
    cwd?: string;
    refresh?: boolean;
  }) => Promise<unknown>;
  profileSave?: (entry: import("../shared/contracts").PoolEntry) => Promise<unknown>;
}

function screenTree(fixture: Fixture, compact = false) {
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return board();
    if (method === "queue.profile" && fixture.profileSave)
      return fixture.profileSave(input as import("../shared/contracts").PoolEntry);
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "repositories")
      return [
        {
          repository: { origin: "acme/app", path: "/app" },
          closeout: null,
          validation: null,
          reviewer: null,
          qa: null,
          note: "",
          updatedAt: "2026-11-07T00:00:00.000Z",
          revision: 1,
        },
      ];
    if (method === "profile.list") return { profiles: fixture.profiles };
    if (method === "profile.compatibility")
      return fixture.compatibility ?? { hosts: [], rows: [] };
    if (method === "profile.vocabulary") {
      fixture.catalogReads.push(input as { cwd?: string });
      return fixture.catalogAnswer
        ? fixture.catalogAnswer(input as { cwd?: string; refresh?: boolean })
        : catalog;
    }
    if (method === "profile.create") {
      fixture.creates.push(input);
      const profile = {
        ...(input as NucleusProfile),
        id: "created-1",
        model: (input as NucleusProfile).model ?? "",
        notes: (input as NucleusProfile).notes ?? "",
      };
      fixture.profiles = [...fixture.profiles, profile];
      return { profile };
    }
    if (method === "profile.update") {
      fixture.updates.push(input);
      const patch = input as Partial<NucleusProfile> & { id: string };
      const current = fixture.profiles.find(
        (profile) => profile.id === patch.id,
      )!;
      const merged = { ...current } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (key === "id") continue;
        if (value === null) delete merged[key];
        else if (value !== undefined) merged[key] = value;
      }
      fixture.profiles = fixture.profiles.map((profile) =>
        profile.id === patch.id
          ? (merged as unknown as NucleusProfile)
          : profile,
      );
      return { profile: merged };
    }
    if (method === "profile.remove") {
      fixture.removes.push(input);
      fixture.profiles = fixture.profiles.filter(
        (profile) => profile.id !== (input as { id: string }).id,
      );
      return { removed: true };
    }
    return {};
  };
  return h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke,
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c },
        host: { id: "host", label: "Host" },
        layout: { compact, platform: "ios" as const },
      }),
    }),
  });
}

const fixture = (): Fixture => ({
  profiles: [imported()],
  creates: [],
  updates: [],
  removes: [],
  catalogReads: [],
});

test("the weight editor shows a refusal or an unconfirmed weight, and only shows Saved for the stored entry", async () => {
  await load();
  const state = fixture();
  state.profileSave = async (entry) => {
    if (entry.weight === "fewest") throw new Error("Store unavailable");
    return {
      ok: true,
      entry: entry.weight === "fewer" ? { ...entry, weight: "default" } : entry,
    };
  };
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => Boolean(ui.query("Edit Imported Sol")));
    ui.press("Edit Imported Sol");
    ui.press("Weight: fewest assignments");
    await settle(() => ui.text().includes("Not saved: Store unavailable"));
    ui.press("Weight: fewer assignments");
    await settle(() => ui.text().includes("Not saved: The service could not confirm"));
    ui.press("Weight: more assignments");
    await settle(() => ui.query("Profile save status")?.props.children === "Saved");
    assert.doesNotMatch(ui.text(), /Profile settings could not be saved/);
  } finally {
    ui.update(h("View", null));
  }
});

test("Settings Profiles creates a profile from the host catalog and shows the unavailable one with its reason", async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => ui.text().includes("Imported Sol"));
    assert.doesNotMatch(
      ui.text(),
      /Routing still reads Paseo|Available on this host|Profile notes|Changes save automatically|Feature values come from one project directory/,
    );
    await settle(() => state.catalogReads.some((read) => read.cwd === "/app"));
    assert.equal(
      ui.get("Imported Sol: Unavailable").props.accessibilityHint,
      "Unavailable",
    );
    assert.equal(ui.query("Availability for Imported Sol"), undefined);
    assert.equal(
      ui.query("Remove Imported Sol"),
      undefined,
      "Remove stays off the list row",
    );

    ui.press("Edit Imported Sol");
    await settle(() => Boolean(ui.query("Profile availability preview")));
    assert.equal(
      ui.get("Profile availability preview").children.join(""),
      "Provider anthropic is not available on this host",
    );
    ui.press("Close Imported Sol");

    ui.press("Add profile");
    await settle(() => Boolean(ui.query("Close new profile")));
    assert.equal(ui.query("Create profile"), undefined);
    assert.equal(ui.query("Save"), undefined);
    ui.type("Name", "Fast worker");
    choose(ui, "Provider", "Codex", "Choose a provider");
    choose(ui, "Model", "GPT-5, gpt-5", "Choose a model");
    await settle(() => state.creates.length === 1);
    assert.deepEqual(state.creates[0], {
      name: "Fast worker",
      provider: "codex",
      model: "gpt-5",
      thinkingOptionId: "high",
      featureValues: { web: false, permissions: "ask" },
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(state.creates[0] as object, "notes"),
      false,
      "notes stay stored and unsent",
    );
    await settle(
      () =>
        ui.text().includes("Fast worker") &&
        Boolean(ui.query("Edit Fast worker") || ui.query("Close Fast worker")),
    );
    assert.doesNotMatch(
      ui.text(),
      /Available on this host|Mode: Plan|Web search: on/,
    );

    choose(ui, "Mode", "Plan", "Host default");
    choose(ui, "Thinking", "Low", "High");
    ui.press("Feature Web search on");
    choose(ui, "Permissions", "Allow", "Ask");
    await settle(() =>
      state.updates.some(
        (entry) =>
          (entry as { modeId?: string }).modeId === "plan" &&
          (entry as { thinkingOptionId?: string }).thinkingOptionId === "low",
      ),
    );
    const latest = state.updates.at(-1) as Record<string, unknown>;
    assert.equal(latest.id, "created-1");
    assert.equal(latest.modeId, "plan");
    assert.equal(latest.thinkingOptionId, "low");
    assert.deepEqual(latest.featureValues, { web: true, permissions: "allow" });
    assert.equal(Object.prototype.hasOwnProperty.call(latest, "notes"), false);

    assert.equal(
      ui.query("Provider map"),
      undefined,
      "one host and an empty map show no provider map",
    );
    assert.doesNotMatch(
      ui.text(),
      /Provider map|Every host key maps to itself|Host provider key/,
    );

    ui.press("Edit Imported Sol");
    await settle(() => Boolean(ui.query("Remove Imported Sol")));
    ui.press("Remove Imported Sol");
    await settle(() => Boolean(ui.query("Confirm removing Imported Sol")));
    ui.press("Confirm removing Imported Sol");
    await settle(() => state.removes.length === 1);
    assert.deepEqual(state.removes[0], { id: "imported" });
    await settle(() => !ui.text().includes("Imported Sol"));
    assert.match(ui.text(), /Fast worker/, "the other profile is untouched");
  } finally {
    ui.update(h("View", null));
  }
});

test("Settings Profiles keeps a draft on a refused save and names the reason", async () => {
  await load();
  const state = fixture();
  let fail = true;
  const ui = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string, input: unknown) => {
          if (method === "profile.create" && fail)
            throw new Error("the profile store is unavailable");
          if (method === "profile.create") {
            state.creates.push(input);
            return {
              profile: {
                ...(input as NucleusProfile),
                id: "created-1",
                notes: "",
              },
            };
          }
          if (method === "profile.update")
            return {
              profile: Object.fromEntries(
                [...Object.entries(input as object), ["notes", ""]].filter(
                  ([, value]) => value !== null,
                ),
              ),
            };
          if (method === "queue.ui-snapshot") return board();
          if (method === "backup.list")
            return { snapshots: [], localError: null };
          if (method === "repositories")
            return [
              {
                repository: { origin: "acme/app", path: "/app" },
                closeout: null,
                validation: null,
                reviewer: null,
                qa: null,
                note: "",
                updatedAt: "2026-11-07T00:00:00.000Z",
                revision: 1,
              },
            ];
          if (method === "profile.list") return { profiles: state.profiles };
          if (method === "profile.vocabulary") return catalog;
          return {};
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(
      () =>
        ui.text().includes("Imported Sol") && Boolean(ui.query("Add profile")),
    );
    ui.press("Add profile");
    await settle(
      () =>
        Boolean(ui.query("Close new profile")) &&
        Boolean(ui.query("Provider, Choose a provider")),
    );
    ui.type("Name", "Doomed");
    ui.press("Provider, Choose a provider");
    await settle(() => Boolean(ui.query("Provider: Codex")));
    ui.press("Provider: Codex");
    await settle(() => Boolean(ui.query("Model, Choose a model")));
    choose(ui, "Model", "GPT-5, gpt-5", "Choose a model");
    await settle(() =>
      /Not saved: the profile store is unavailable/.test(ui.text()),
    );
    assert.equal(
      ui.get("Name").props.value,
      "Doomed",
      "the draft survives the refusal",
    );
    assert.equal(state.creates.length, 0);
    // A failure needs room: it takes its own line under the Name row, not a squeeze beside the field.
    const failure = ui.get("Profile save status") as Node;
    assert.match(
      failure.children.join(""),
      /^Not saved: the profile store is unavailable/,
    );
    assert.equal(
      labelsIn(ui.get("Profile name row") as Node).includes(
        "Profile save status",
      ),
      false,
      "the failure is off the Name row",
    );
    assert.equal(
      labelsIn(ui.get("New profile editor") as Node).includes(
        "Profile save status",
      ),
      true,
      "the failure stays inside the editor",
    );
    assert.equal(failure.props.accessibilityLiveRegion, "polite");
    fail = false;
    choose(ui, "Model", "GPT-5 mini, gpt-5-mini", "GPT-5, gpt-5");
    await settle(() => state.creates.length === 1);
    // The created profile opens in its own editor; a rename there saves after its pause and reads Saved.
    await settle(() => Boolean(ui.query("Doomed editor")));
    ui.type("Name", "Doomed again");
    for (
      const deadline = Date.now() + 3_000;
      Date.now() < deadline &&
      ui.query("Profile save status")?.children.join("") !== "Saved";

    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ui.get("Profile save status").children.join(""), "Saved");
    assert.equal(
      labelsIn(ui.get("Profile name row") as Node).includes(
        "Profile save status",
      ),
      true,
      "a brief Saved sits inline on the Name row",
    );
    assert.equal((state.creates[0] as { name: string }).name, "Doomed");
    assert.equal((state.creates[0] as { model: string }).model, "gpt-5-mini");
  } finally {
    ui.update(h("View", null));
  }
});

test("the add flow uses dropdowns, Host default plain text, and a short unavailable-provider reason", async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(
      () =>
        ui.text().includes("Imported Sol") && Boolean(ui.query("Add profile")),
    );
    ui.press("Add profile");
    await settle(() => Boolean(ui.query("Provider, Choose a provider")));
    ui.press("Provider, Choose a provider");
    await settle(() => Boolean(ui.query("Provider: Cursor · needs sign-in")));
    assert.ok(
      ui.get("Provider: Cursor · needs sign-in"),
      "an unauthenticated provider is labelled with a short reason",
    );
    assert.doesNotMatch(ui.text(), /Sign in required to use Cursor/);
    ui.press("Provider: Cursor · needs sign-in");
    await settle(() => Boolean(ui.query("Model, Choose a model")));
    choose(ui, "Model", "Cursor 1, cursor-1", "Choose a model");
    assert.equal(
      ui.get("Mode, Host default").type,
      "Text",
      "an empty mode list is plain text, not a dropdown",
    );
    assert.equal(
      ui.get("Thinking, Host default").type,
      "Text",
      "an empty thinking list is plain text, not a dropdown",
    );
    const hostDefault = ui
      .ofType("Text")
      .filter((node) => node.children.join("") === "Host default");
    assert.equal(
      hostDefault.length,
      2,
      "Mode and Thinking stay one plain control each when the host offers no choice",
    );
    assert.equal(ui.query("Notes"), undefined);
    assert.doesNotMatch(
      ui.text(),
      /\/app|Feature values come from one project directory|Available on this host|Changes save automatically/,
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("Profiles shows loading, an empty list, a catalog error, and long names without truncation", async () => {
  await load();
  let resolveList:
    | ((value: { profiles: NucleusProfile[] }) => void)
    | undefined;
  const pending = new Promise<{ profiles: NucleusProfile[] }>((resolve) => {
    resolveList = resolve;
  });
  const loading = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string) => {
          if (method === "queue.ui-snapshot") return board();
          if (method === "backup.list")
            return { snapshots: [], localError: null };
          if (method === "profile.list") return pending;
          if (method === "profile.vocabulary") return catalog;
          if (method === "repositories") return [];
          return {};
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => loading.text().includes("Profiles"));
    loading.press("Profiles");
    await settle(() => loading.text().includes("Reading profiles…"));
    assert.equal(
      loading.get("Stored profiles").props.style.borderBottomWidth ?? 0,
      0,
      "a loading line draws no section divider: sections part with spacing (nucleus#1540)",
    );
    resolveList!({ profiles: [] });
    await settle(() =>
      loading
        .text()
        .includes("No profiles yet. Add one from what your hosts can run."),
    );
    assert.equal(
      loading.get("Stored profiles").props.style.borderBottomWidth ?? 0,
      0,
      "an empty line draws no section divider (nucleus#1540)",
    );
  } finally {
    loading.update(h("View", null));
  }

  const failed = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string) => {
          if (method === "queue.ui-snapshot") return board();
          if (method === "backup.list")
            return { snapshots: [], localError: null };
          if (method === "profile.list")
            throw new Error("profile store offline");
          if (method === "profile.vocabulary")
            throw new Error("catalog offline");
          return {};
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => failed.text().includes("Profiles"));
    failed.press("Profiles");
    await settle(() =>
      failed.text().includes("Could not read profiles: profile store offline"),
    );
    assert.match(
      failed.text(),
      /The providers and models could not be read: catalog offline/,
    );
    assert.equal(
      failed.get("Stored profiles").props.style.borderBottomWidth ?? 0,
      0,
      "an unreadable list draws no section divider (nucleus#1540)",
    );
  } finally {
    failed.update(h("View", null));
  }

  const longName =
    "A very long profile name that would otherwise truncate across a narrow settings column";
  const long = fixture();
  long.profiles = [
    {
      id: "long",
      name: longName,
      provider: "codex",
      model: "gpt-5",
      notes: "secret",
      featureValues: undefined,
    } as NucleusProfile,
  ];
  const ui = mount(screenTree(long));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => ui.text().includes(longName));
    const name = ui
      .ofType("Text")
      .find((node) => node.children.join("") === longName)!;
    assert.equal(
      name.props.numberOfLines,
      undefined,
      "a long name is not ellipsised",
    );
    assert.ok(ui.get(`Edit ${longName}`));
    assert.ok(ui.get("Add profile"));
    assert.doesNotMatch(ui.text(), /secret|Profile notes/);
    ui.press(`Edit ${longName}`);
    await settle(() => Boolean(ui.query("Name")));
    assert.equal(ui.query("Notes"), undefined);
    assert.ok(ui.get("Provider, Codex"));
    assert.ok(ui.get("Model, GPT-5, gpt-5"));
  } finally {
    ui.update(h("View", null));
  }
});

test("nucleus#998: Profiles and Subscriptions are separated by a gap, not a second divider, wide and narrow", async () => {
  await load();
  const longName =
    "A very long profile name that keeps going so the last row wraps on a narrow settings column";
  for (const compact of [false, true]) {
    const state = fixture();
    state.profiles = [
      imported(),
      {
        id: "long",
        name: longName,
        provider: "codex",
        model: "gpt-5",
        featureValues: undefined,
      } as NucleusProfile,
    ];
    const ui = mount(screenTree(state, compact));
    try {
      await settle(() => ui.text().includes("Profiles"));
      ui.press("Profiles");
      await settle(() => ui.text().includes(longName));
      const section = ui.get("Stored profiles").props.style;
      assert.equal(
        section.borderBottomWidth ?? 0,
        0,
        `${compact ? "narrow" : "wide"}: the last row's divider is the only line`,
      );
      assert.equal(
        section.paddingBottom,
        24,
        "a wider gap before Subscriptions",
      );
      assert.ok(ui.get("Subscriptions"));
    } finally {
      ui.update(h("View", null));
    }
  }
});

test("nucleus#998: Subscriptions ending in group rows is the last section, with no divider", async () => {
  await load();
  const state = fixture();
  const ui = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string, input: unknown) => {
          if (method === "queue.ui-snapshot")
            return {
              ...board(),
              pool: [
                {
                  profileId: "imported",
                  group: "anthropic",
                  weight: "most",
                  enabled: true,
                  scopes: ["general"],
                  roles: ["worker"],
                },
              ],
            };
          return (
            screenTree(state).props as {
              children: {
                props: { invoke: (m: string, i: unknown) => Promise<unknown> };
              };
            }
          ).children.props.invoke(method, input);
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => ui.text().includes("anthropic"));
    assert.equal(
      ui.get("Subscriptions").props.style.borderBottomWidth ?? 0,
      0,
      "the last section has no divider",
    );
    assert.equal(
      ui.query("Provider map"),
      undefined,
      "the provider map is retired (task 1158)",
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("when registered projects disagree on feature values, Profiles names the projects and hides the path picker", async () => {
  await load();
  const state = fixture();
  const other: StoredHostCatalog = {
    readAt: "2026-11-09T09:00:00.000Z",
    providers: [
      {
        key: "codex",
        label: "Codex",
        available: true,
        problem: "",
        models: [
          {
            id: "gpt-5",
            label: "GPT-5",
            aliases: [],
            thinkingOptions: [{ id: "low", label: "Low" }],
            defaultThinkingOptionId: "low",
            modes: [],
            features: [
              { type: "toggle", id: "web", label: "Web search", value: true },
            ],
          },
        ],
      },
    ],
  };
  const ui = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string, input: unknown) => {
          if (method === "queue.ui-snapshot")
            return {
              ...board(),
              projects: [
                {
                  key: "app",
                  name: "App",
                  version: 1,
                  
                  repositories: [{ origin: "acme/app", path: "/app" }],
                  primary: { origin: "acme/app", path: "/app" },
                },
                {
                  key: "other",
                  name: "Other",
                  version: 1,
                  
                  repositories: [{ origin: "acme/other", path: "/other" }],
                  primary: { origin: "acme/other", path: "/other" },
                },
              ],
            };
          if (method === "backup.list")
            return { snapshots: [], localError: null };
          if (method === "repositories")
            return [
              {
                repository: { origin: "acme/app", path: "/app" },
                closeout: null,
                validation: null,
                reviewer: null,
                qa: null,
                note: "",
                updatedAt: "2026-11-07T00:00:00.000Z",
                revision: 1,
              },
              {
                repository: { origin: "acme/other", path: "/other" },
                closeout: null,
                validation: null,
                reviewer: null,
                qa: null,
                note: "",
                updatedAt: "2026-11-07T00:00:00.000Z",
                revision: 1,
              },
            ];
          if (method === "profile.list") return { profiles: state.profiles };
          if (method === "profile.vocabulary") {
            const cwd = (input as { cwd?: string }).cwd;
            return cwd === "/other" ? other : catalog;
          }
          return {};
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => ui.text().includes("Imported Sol"));
    ui.press("Add profile");
    await settle(() => Boolean(ui.query("Provider, Choose a provider")));
    choose(ui, "Provider", "Codex", "Choose a provider");
    choose(ui, "Model", "GPT-5, gpt-5", "Choose a model");
    await settle(
      () =>
        /Feature values differ for App and Other/.test(ui.text()) ||
        /Feature values differ for Other and App/.test(ui.text()),
    );
    assert.doesNotMatch(ui.text(), /\/app|\/other/);
    assert.ok(ui.get("Choose which project to use"));
    assert.equal(
      ui.query("Project, App"),
      undefined,
      "the project choice stays behind the disclosure",
    );
    ui.press("Choose which project to use");
    await settle(
      () =>
        Boolean(ui.query("Project, App")) ||
        Boolean(ui.query("Project, Other")),
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("removing a profile added this session leaves no ghost row", async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(
      () =>
        ui.text().includes("Imported Sol") && Boolean(ui.query("Add profile")),
    );
    ui.press("Add profile");
    await settle(
      () =>
        Boolean(ui.query("Close new profile")) &&
        Boolean(ui.query("Provider, Choose a provider")),
    );
    ui.type("Name", "Fast worker");
    choose(ui, "Provider", "Codex", "Choose a provider");
    choose(ui, "Model", "GPT-5, gpt-5", "Choose a model");
    await settle(
      () =>
        state.creates.length === 1 &&
        Boolean(ui.query("Close Fast worker") || ui.query("Edit Fast worker")),
    );
    if (ui.query("Edit Fast worker")) ui.press("Edit Fast worker");
    await settle(() => Boolean(ui.query("Remove Fast worker")));
    ui.press("Remove Fast worker");
    await settle(() => Boolean(ui.query("Confirm removing Fast worker")));
    ui.press("Confirm removing Fast worker");
    await settle(() => state.removes.length === 1);
    assert.deepEqual(state.removes[0], { id: "created-1" });
    await settle(() => !ui.text().includes("Fast worker"));
    assert.equal(ui.query("Edit Fast worker"), undefined);
    assert.equal(ui.query("Close Fast worker"), undefined);
    assert.match(ui.text(), /Imported Sol/, "the other profile is untouched");
  } finally {
    ui.update(h("View", null));
  }
});

const iconOf = (node: {
  type: string;
  props: Record<string, any>;
  children: unknown[];
}): string | undefined => {
  if (node.type === "Icon") return node.props.name;
  for (const child of node.children)
    if (typeof child !== "string") {
      const found = iconOf(child as never);
      if (found) return found;
    }
  return undefined;
};

for (const compact of [false, true])
  test(`nucleus#999: Profiles uses the shared icon buttons, each naming its object; On/Off stays a word (${compact ? "narrow" : "wide"})`, async () => {
    await load();
    const state = fixture();
    const ui = mount(screenTree(state, compact));
    try {
      await settle(() => ui.text().includes("Profiles"));
      ui.press("Profiles");
      await settle(
        () =>
          ui.text().includes("Imported Sol") &&
          Boolean(ui.query("Add profile")),
      );
      // The list-level actions sit in the section heading, refresh then add.
      assert.equal(iconOf(ui.get("Add profile")), "Plus");
      assert.equal(iconOf(ui.get("Refresh providers and models")), "RefreshCw");
      assert.equal(
        ui.ofType("Text").find((node) => node.children.join("") === "Add"),
        undefined,
        "no Add word in the header",
      );
      assert.equal(iconOf(ui.get("Edit Imported Sol")), "Pencil");
      const toggle = ui.get(/^(Disable|Enable) Imported Sol$/);
      assert.equal(
        iconOf(toggle),
        undefined,
        "the on/off toggle is a word, its state",
      );
      assert.ok(
        ["On", "Off"].includes(
          JSON.stringify(toggle).match(/"(On|Off)"/)?.[1] ?? "",
        ),
        "it reads On or Off",
      );
      ui.press("Edit Imported Sol");
      await settle(() => Boolean(ui.query("Remove Imported Sol")));
      assert.equal(iconOf(ui.get("Close Imported Sol")), "X");
      assert.equal(iconOf(ui.get("Duplicate Imported Sol")), "Copy");
      const remove = ui.get("Remove Imported Sol");
      assert.equal(iconOf(remove), "Trash2");
      ui.press("Remove Imported Sol");
      await settle(() => Boolean(ui.query("Confirm removing Imported Sol")));
      assert.match(
        ui.text(),
        /Remove profile/,
        "the danger confirm keeps its words",
      );
      ui.press("Keep Imported Sol");
      ui.press("Close Imported Sol");
      ui.press("Add profile");
      await settle(() => Boolean(ui.query("Close new profile")));
      assert.equal(iconOf(ui.get("Close new profile")), "X");
      assert.equal(
        ui.get("Add profile").props.accessibilityState.disabled,
        true,
        "one new profile at a time",
      );
    } finally {
      ui.update(h("View", null));
    }
  });

test("a refused Remove or Duplicate names the reason and keeps the profile", async () => {
  await load();
  const state = fixture();
  // A canonical profile, so the duplicate passes the form's own check and reaches the store.
  state.profiles = [{ ...imported(), provider: "codex", model: "gpt-5" }];
  let failRemove = true;
  let failDuplicate = true;
  const ui = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string, input: unknown) => {
          if (method === "profile.create" && failDuplicate)
            throw new Error("the profile store is unavailable");
          if (method === "profile.remove" && failRemove)
            throw new Error("the profile store is unavailable");
          if (method === "queue.ui-snapshot") return board();
          if (method === "backup.list")
            return { snapshots: [], localError: null };
          if (method === "repositories")
            return [
              {
                repository: { origin: "acme/app", path: "/app" },
                closeout: null,
                validation: null,
                reviewer: null,
                qa: null,
                note: "",
                updatedAt: "2026-11-07T00:00:00.000Z",
                revision: 1,
              },
            ];
          if (method === "profile.list") return { profiles: state.profiles };
          if (method === "profile.vocabulary") return catalog;
          if (method === "profile.create") {
            state.creates.push(input);
            const profile = {
              ...(input as NucleusProfile),
              id: "created-1",
              model: (input as NucleusProfile).model ?? "",
              notes: (input as NucleusProfile).notes ?? "",
            };
            state.profiles = [...state.profiles, profile];
            return { profile };
          }
          if (method === "profile.remove") {
            state.removes.push(input);
            state.profiles = state.profiles.filter(
              (profile) => profile.id !== (input as { id: string }).id,
            );
            return { removed: true };
          }
          return {};
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => ui.text().includes("Imported Sol"));
    ui.press("Edit Imported Sol");
    await settle(() => Boolean(ui.query("Duplicate Imported Sol")));
    ui.press("Duplicate Imported Sol");
    await settle(() =>
      /Not saved: the profile store is unavailable/.test(ui.text()),
    );
    assert.equal(state.creates.length, 0, "a refused Duplicate writes nothing");
    assert.match(ui.text(), /Imported Sol/);
    ui.press("Remove Imported Sol");
    await settle(() => Boolean(ui.query("Confirm removing Imported Sol")));
    ui.press("Confirm removing Imported Sol");
    await settle(
      () =>
        /Not saved: the profile store is unavailable/.test(ui.text()) &&
        state.removes.length === 0,
    );
    assert.equal(state.removes.length, 0, "a refused Remove writes nothing");
    assert.match(ui.text(), /Imported Sol/);
    assert.ok(
      ui.query("Remove Imported Sol") ||
        ui.query("Confirm removing Imported Sol"),
      "the editor stays open after a refused Remove",
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("task 1158: a profile shows one quiet icon naming the hosts it cannot run on, and the reason alone with one host", async () => {
  const { hostCompatibilityNote } = await load();
  const hosts = [
    {
      hostId: "paseo:1",
      kind: "paseo",
      label: "Paseo",
      online: true,
      readAt: null,
    },
    {
      hostId: "t3code:1",
      kind: "t3code",
      label: "T3Code",
      online: true,
      readAt: null,
    },
  ];
  const rows = [
    {
      profileId: "imported",
      hostId: "paseo:1",
      status: "works",
      reason: "",
      translated: [],
      launch: null,
    },
    {
      profileId: "imported",
      hostId: "t3code:1",
      status: "unavailable",
      reason: "T3Code can't run claude in mode plan",
      translated: [],
      launch: null,
    },
  ];
  assert.equal(
    hostCompatibilityNote(
      { hosts: hosts.slice(0, 1), rows } as never,
      "imported",
    ),
    "",
    "one host it runs on shows nothing",
  );
  // nucleus#1365: with one host, the reason it can't run there still shows, naming the host.
  assert.equal(
    hostCompatibilityNote({ hosts: hosts.slice(1), rows } as never, "imported"),
    "T3Code can't run claude in mode plan",
  );
  assert.equal(
    hostCompatibilityNote({ hosts, rows } as never, "imported"),
    "Not on T3Code: T3Code can't run claude in mode plan",
  );
  assert.equal(
    hostCompatibilityNote(
      { hosts, rows: rows.slice(0, 1) } as never,
      "imported",
    ),
    "",
    "works everywhere shows nothing",
  );
  const state = fixture();
  state.profiles = [
    {
      id: "imported",
      name: "Imported Sol",
      provider: "codex",
      model: "gpt-5",
      notes: "",
    } as NucleusProfile,
  ];
  state.compatibility = { hosts, rows };
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() =>
      Boolean(
        ui.query(
          "Imported Sol: Not on T3Code: T3Code can't run claude in mode plan",
        ),
      ),
    );
    assert.equal(
      ui.query("Imported Sol hosts"),
      undefined,
      "no per-host chips",
    );
    ui.press("Edit Imported Sol");
    await settle(() => Boolean(ui.query("Imported Sol editor")));
    assert.equal(
      ui.query("Profile hosts"),
      undefined,
      "no host mapping in the editor",
    );
    assert.equal(ui.query("T3Code mapping"), undefined);
  } finally {
    ui.update(h("View", null));
  }
});

test("the dispatch row and sliders wait for the board: absent while it loads or fails, present once it arrives", async () => {
  await load();
  const state = fixture();
  let resolveBoard: ((value: ReturnType<typeof board>) => void) | undefined;
  let failBoard = false;
  const pending = new Promise<ReturnType<typeof board>>((resolve) => {
    resolveBoard = resolve;
  });
  const tree = () =>
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: async (method: string) => {
          if (method === "queue.ui-snapshot") {
            if (failBoard) throw new Error("the service is restarting");
            return pending;
          }
          if (method === "backup.list")
            return { snapshots: [], localError: null };
          if (method === "repositories") return [];
          if (method === "profile.list") return { profiles: state.profiles };
          if (method === "profile.vocabulary") return catalog;
          return {};
        },
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: c },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    });
  const open = async (ui: ReturnType<typeof mount>) => {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => Boolean(ui.query("Edit Imported Sol")));
    ui.press("Edit Imported Sol");
    await settle(() => Boolean(ui.query("Profile name row")));
  };
  const ui = mount(tree());
  try {
    await open(ui);
    assert.equal(
      ui.query("Profile dispatch row"),
      undefined,
      "no Subscription or Weight while the board loads",
    );
    assert.equal(
      ui.query("Cost value"),
      undefined,
      "no sliders while the board loads",
    );
    assert.ok(
      labelsIn(ui.get("Profile name row") as Node).includes(
        "Duplicate Imported Sol",
      ),
      "the Name row and its actions are already there",
    );
    resolveBoard!({
      ...board(),
      pool: [
        {
          profileId: "imported",
          group: "anthropic",
          weight: "most",
          enabled: true,
          scopes: ["general"],
          roles: ["worker"],
        },
      ],
    } as never);
    await settle(() => Boolean(ui.query("Profile dispatch row")));
    assert.equal(
      ui.get("Weight for Imported Sol").props.value,
      "3",
      "the stored weight shows once the board arrives",
    );
    assert.equal(ui.get("Cost value").children.join(""), "Unset");
  } finally {
    ui.update(h("View", null));
  }
  failBoard = true;
  const failed = mount(tree());
  try {
    await open(failed);
    await settle(() => /the service is restarting/.test(failed.text()));
    assert.equal(
      failed.query("Profile dispatch row"),
      undefined,
      "a failed board read shows no dispatch fields to edit",
    );
    assert.equal(failed.query("Cost value"), undefined);
  } finally {
    failed.update(h("View", null));
  }
});

type Node = {
  type: string;
  props: Record<string, any>;
  children: Array<Node | string>;
};
const labelsIn = (node: Node): string[] =>
  node.children.flatMap((child) =>
    typeof child === "string"
      ? []
      : [String(child.props.accessibilityLabel ?? ""), ...labelsIn(child)],
  );

test("model option fields flow two to a row, an odd last one spans the row, and they stack on a phone", async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(
      () =>
        ui.text().includes("Imported Sol") && Boolean(ui.query("Add profile")),
    );
    ui.press("Add profile");
    await settle(() => Boolean(ui.query("Provider, Choose a provider")));
    const editor = () => ui.get("New profile editor");
    const layout = (width: number) =>
      editor().props.onLayout({ nativeEvent: { layout: { width } } });
    const rows = () =>
      (ui.all("Model options row") as Node[]).map((row) =>
        row.children.filter((cell): cell is Node => typeof cell !== "string"),
      );
    assert.equal(rows().length, 0, "no option rows before a model is chosen");
    layout(688);
    choose(ui, "Provider", "Codex", "Choose a provider");
    choose(ui, "Model", "GPT-5, gpt-5", "Choose a model");
    await settle(() => rows().length === 2);
    const order = rows().map((cells) =>
      cells.map((cell) =>
        labelsIn(cell).find((label) =>
          /^(Mode|Thinking|Permissions), |^Feature Web search on$/.test(label),
        ),
      ),
    );
    assert.deepEqual(
      order,
      [
        ["Mode, Host default", "Thinking, High"],
        ["Feature Web search on", "Permissions, Ask"],
      ],
      "Mode and Thinking, then the features, two to a row",
    );
    for (const cells of rows())
      for (const cell of cells)
        assert.deepEqual(
          [cell.props.style.flex, cell.props.style.minWidth],
          [1, 0],
          "each option takes half the row",
        );
    layout(358);
    for (const cells of rows())
      for (const cell of cells)
        assert.equal(cell.props.style.minWidth, "100%", "stacked on a phone");
    layout(688);
    choose(ui, "Model", "GPT-5 mini, gpt-5-mini", "GPT-5, gpt-5");
    await settle(() => rows().length === 1 && rows()[0].length === 2);
    assert.ok(labelsIn(rows()[0][0]).includes("Mode, Host default"));
    assert.match(
      ui.text(),
      /Host default/,
      "an empty thinking list stays plain text beside Mode",
    );
    choose(ui, "Provider", "Claude", "Codex");
    choose(ui, "Model", "Claude 1, claude-1", "Choose a model");
    // Mode and Thinking are always one control each (nucleus#1365); the one feature is the odd last.
    await settle(() => rows().length === 2 && rows()[1].length === 1);
    assert.equal(
      rows()[1][0].props.style.flex,
      1,
      "a lone option spans the row",
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("host option values read as plain words", async () => {
  await load();
  assert.equal(settings.plainWords("xhigh", "xhigh"), "Extra high");
  assert.equal(settings.plainWords(undefined, "xhigh"), "Extra high");
  assert.equal(settings.plainWords("", "full_access"), "Full access");
  assert.equal(settings.plainWords("read-only", "read-only"), "Read only");
  assert.equal(
    settings.plainWords("Full Access", "bypassPermissions"),
    "Full Access",
    "a host display label in words stays",
  );
  assert.equal(settings.plainWords("max", "max"), "Maximum");
  assert.equal(settings.plainWords("low", "low"), "Low");
  assert.equal(
    settings.plainWords(undefined, "bypassPermissions"),
    "Bypass permissions",
    "a camelCase key is spelled out",
  );
  assert.equal(
    settings.plainWords("acceptEdits", "acceptEdits"),
    "Accept edits",
  );
  assert.equal(settings.plainWords("GPT-5 high", "gpt-5-high"), "GPT-5 high");
});

test("a Profiles card shows Name, Subscription, Weight, Provider and Model at one control height with one caption size, wide and narrow", async () => {
  await load();
  const { control, caption } = await import("../client/design");
  const state = fixture();
  const tree = h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string) => {
        if (method === "queue.ui-snapshot")
          return {
            ...board(),
            pool: [
              {
                profileId: "imported",
                group: "anthropic",
                weight: "most",
                enabled: true,
                scopes: ["general"],
                roles: ["worker"],
              },
            ],
          };
        if (method === "backup.list")
          return { snapshots: [], localError: null };
        if (method === "repositories") return [];
        if (method === "profile.list") return { profiles: state.profiles };
        if (method === "profile.vocabulary") return catalog;
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c },
        host: { id: "host", label: "Host" },
        layout: { compact: false, platform: "ios" as const },
      }),
    }),
  });
  const ui = mount(tree);
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => Boolean(ui.query("Edit Imported Sol")));
    ui.press("Edit Imported Sol");
    await settle(() => Boolean(ui.query("Profile dispatch row")));
    const editor = () => ui.get("Imported Sol editor");
    const trigger = (label: string) =>
      (ui.ofType("Pressable") as Node[]).find((node) =>
        String(node.props.accessibilityLabel ?? "").startsWith(`${label}, `),
      )!;
    for (const width of [688, 358]) {
      editor().props.onLayout({ nativeEvent: { layout: { width } } });
      const heights = {
        name: ui.get("Name").props.style.minHeight,
        subscription: ui.get("Subscription").props.style.minHeight,
        decrease: ui.get("Decrease weight for Imported Sol").props.style
          .minHeight,
        weight: ui.get("Weight for Imported Sol").props.style.height,
        increase: ui.get("Increase weight for Imported Sol").props.style
          .minHeight,
        provider: trigger("Provider").props.style.minHeight,
        model: trigger("Model").props.style.minHeight,
      };
      for (const [field, height] of Object.entries(heights))
        assert.equal(height, control.height, `${field} at ${width} points`);
      for (const text of ["Subscription", "Weight", "Provider", "Model"]) {
        const style = (ui.ofType("Text") as Node[]).find(
          (node) => node.children.join("") === text,
        )?.props.style;
        assert.equal(
          style?.fontSize,
          caption.fontSize,
          `${text} caption at ${width} points`,
        );
      }
      assert.equal(ui.get("Name").props.style.fontSize, control.text.fontSize);
      assert.equal(
        ui.get("Subscription").props.style.fontSize,
        control.text.fontSize,
      );
    }
    // At the phone width Subscription and Weight each take a full row; By request is retired.
    const row = ui.get("Profile dispatch row") as Node;
    const cells = row.children.filter(
      (cell): cell is Node => typeof cell !== "string",
    );
    assert.equal(cells[0].props.style.minWidth, "100%");
    assert.equal(cells[1].props.style.minWidth, "100%");
    assert.equal(ui.query("Selection by request"), undefined);
  } finally {
    ui.update(h("View", null));
  }
});

test("nucleus#970: the Refresh tooltip names the stored catalog's age", async () => {
  const { catalogAge } = await load();
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  assert.equal(catalogAge(undefined, now), "");
  assert.equal(catalogAge("not a time", now), "");
  assert.equal(catalogAge("2026-11-09T11:59:30.000Z", now), "read just now");
  assert.equal(catalogAge("2026-11-09T11:55:00.000Z", now), "read 5 min ago");
  assert.equal(catalogAge("2026-11-09T09:00:00.000Z", now), "read 3 h ago");
  assert.equal(catalogAge("2026-11-07T12:00:00.000Z", now), "read 2 d ago");
  assert.equal(
    catalogAge("2026-11-09T12:05:00.000Z", now),
    "read just now",
    "a clock ahead of the host never reads negative",
  );
});

for (const compact of [false, true])
  test(`nucleus#970: Profiles opens on the stored catalog; Refresh replaces it, or keeps it and names the reason once (${compact ? "narrow" : "wide"})`, async () => {
    await load();
    const state = fixture();
    state.profiles = [
      {
        id: "sol",
        name: "Sol",
        provider: "codex",
        model: "gpt-5",
        notes: "",
      } as NucleusProfile,
    ];
    const readAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const renamed = {
      providers: catalog.providers.map((provider) =>
        provider.key === "codex"
          ? { ...provider, label: "Codex Next" }
          : provider,
      ),
    };
    let release: (() => void) | null = null;
    let refreshFailure = "";
    state.catalogAnswer = async (input) => {
      if (!input.refresh) return { ...catalog, readAt };
      if (refreshFailure) throw new Error(refreshFailure);
      return new Promise((resolve) => {
        release = () =>
          resolve({ ...renamed, readAt: new Date().toISOString() });
      });
    };
    const ui = mount(screenTree(state, compact));
    try {
      await settle(() => ui.text().includes("Profiles"));
      ui.press("Profiles");
      await settle(() => ui.text().includes("Sol"));
      const refresh = () => ui.get("Refresh providers and models");
      await settle(
        () =>
          refresh().props.accessibilityHint ===
          "Refresh providers and models · read 5 min ago",
      );
      assert.equal(ui.query("Sol: Unavailable"), undefined);
      assert.ok(
        state.catalogReads.every((read) => !read.refresh),
        "opening the page never refreshes",
      );
      ui.press("Edit Sol");
      await settle(() => Boolean(ui.query("Provider, Codex")));

      ui.press("Refresh providers and models");
      await settle(
        () =>
          refresh().props.accessibilityHint ===
          "Refreshing providers and models…",
      );
      assert.equal(refresh().props.accessibilityState.disabled, true);
      await settle(() => state.catalogReads.some((read) => read.refresh));
      assert.deepEqual(
        state.catalogReads.filter((read) => read.refresh),
        [{ cwd: "/app", refresh: true }],
      );
      assert.ok(
        ui.query("Provider, Codex"),
        "the stored lists stay usable while Refresh runs",
      );
      assert.equal(
        ui.query("Sol: Unavailable"),
        undefined,
        "a read in flight never reads as unavailable",
      );

      release!();
      await settle(() => Boolean(ui.query("Provider, Codex Next")));
      await settle(
        () =>
          refresh().props.accessibilityHint ===
          "Refresh providers and models · read just now",
      );
      assert.equal(refresh().props.accessibilityState.disabled, false);

      refreshFailure = "Daemon is disconnected";
      ui.press("Refresh providers and models");
      await settle(() =>
        ui
          .text()
          .includes(
            "Refresh failed: Daemon is disconnected. The stored providers and models stay.",
          ),
      );
      assert.equal(
        ui.text().split("Refresh failed").length - 1,
        1,
        "the reason shows once",
      );
      assert.ok(
        ui.query("Provider, Codex Next"),
        "a failed refresh keeps the stored catalog",
      );
      await settle(() => refresh().props.accessibilityState.disabled === false);

      refreshFailure = "";
      ui.press("Refresh providers and models");
      await settle(() => !ui.text().includes("Refresh failed"));
      release!();
    } finally {
      ui.update(h("View", null));
    }
  });

test("nucleus#970: while the first catalog read is in flight, no row reads unavailable", async () => {
  await load();
  const state = fixture();
  state.profiles = [
    {
      id: "sol",
      name: "Sol",
      provider: "codex",
      model: "gpt-5",
      notes: "",
    } as NucleusProfile,
  ];
  state.catalogAnswer = () => new Promise(() => {});
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(
      () => ui.text().includes("Sol") && state.catalogReads.length > 0,
    );
    assert.equal(ui.query("Sol: Unavailable"), undefined);
    assert.equal(
      ui.get("Refresh providers and models").props.accessibilityHint,
      "Refresh providers and models",
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("nucleus#1322: the model picker shows each model's name and its model ID, once when they match", async () => {
  await load();
  const { paseoCatalog } = await import("./support/pool-shapes");
  // Paseo's pi catalog shape; a synthetic second upstream shares the Deepseek label, so only the ID tells them apart.
  const host = paseoCatalog();
  const pi = host.providers.find((provider) => provider.key === "pi")!;
  pi.models.push({ ...pi.models[1]!, id: "opencode/deepseek-v4.1-flash" });
  const state = fixture();
  state.catalogAnswer = async () => ({
    ...host,
    readAt: "2026-11-18T09:00:00.000Z",
  });
  state.profiles = [
    {
      id: "pi",
      name: "Pi deepseek",
      provider: "pi",
      model: "opencode-go/deepseek-v4.1-flash",
      notes: "",
    } as NucleusProfile,
    {
      id: "opus",
      name: "Opus",
      provider: "claude",
      model: "claude-opus-5-5",
      notes: "",
    } as NucleusProfile,
    {
      id: "gone",
      name: "Retired",
      provider: "pi",
      model: "opencode-go/retired-1",
      notes: "",
    } as NucleusProfile,
  ];
  const ui = mount(screenTree(state));
  const lines = (node: Node) =>
    (
      node.children.filter((child) => typeof child !== "string") as Node[]
    ).flatMap(function texts(child: Node): string[] {
      return child.type === "Text"
        ? [child.children.join("")]
        : (
            child.children.filter(
              (inner) => typeof inner !== "string",
            ) as Node[]
          ).flatMap(texts);
    });
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(
      () => ui.text().includes("Pi deepseek") && state.catalogReads.length > 0,
    );

    ui.press("Edit Pi deepseek");
    await settle(() =>
      Boolean(ui.query("Model, Deepseek, opencode-go/deepseek-v4.1-flash")),
    );
    const trigger = ui.get(
      "Model, Deepseek, opencode-go/deepseek-v4.1-flash",
    ) as Node;
    assert.deepEqual(
      lines(trigger),
      ["Deepseek", "opencode-go/deepseek-v4.1-flash"],
      "the closed control shows the name over the model ID",
    );
    ui.press("Model, Deepseek, opencode-go/deepseek-v4.1-flash");
    for (const [name, id] of [
      ["Muse", "opencode-go/muse-spark-1.3-contributor"],
      ["Deepseek", "opencode-go/deepseek-v4.1-flash"],
      ["Deepseek", "opencode/deepseek-v4.1-flash"],
    ]) {
      assert.deepEqual(
        lines(ui.get(`Model: ${name}, ${id}`) as Node),
        [name, id],
        `${id} shows its name and ID`,
      );
    }
    ui.press("Model, Deepseek, opencode-go/deepseek-v4.1-flash");
    ui.press("Close Pi deepseek");

    ui.press("Edit Opus");
    await settle(() => Boolean(ui.query("Model, claude-opus-5-5")));
    assert.deepEqual(
      lines(ui.get("Model, claude-opus-5-5") as Node),
      ["claude-opus-5-5"],
      "a label equal to the ID shows once",
    );
    ui.press("Model, claude-opus-5-5");
    assert.deepEqual(lines(ui.get("Model: claude-haiku-5-5") as Node), [
      "claude-haiku-5-5",
    ]);
    ui.press("Model, claude-opus-5-5");
    ui.press("Close Opus");

    ui.press("Edit Retired");
    await settle(() => Boolean(ui.query("Model, opencode-go/retired-1")));
    assert.deepEqual(
      lines(ui.get("Model, opencode-go/retired-1") as Node),
      ["opencode-go/retired-1"],
      "a model the host no longer reports shows its ID",
    );
  } finally {
    ui.update(h("View", null));
  }
});

/** The track inside the usage strip labelled `label`. */
const usageTrack = (ui: ReturnType<typeof mount>, label: string): Node => {
  const container = ui.get(label) as Node;
  const track = container.children.find(
    (child): child is Node => typeof child !== "string",
  );
  assert.ok(track);
  return track;
};

/** The fill width inside the usage strip labelled `label`. */
const usageFillWidth = (
  ui: ReturnType<typeof mount>,
  label: string,
): unknown => {
  const track = usageTrack(ui, label);
  const fill = track.children.find(
    (child): child is Node => typeof child !== "string",
  );
  assert.ok(fill);
  return fill.props.style.width;
};

/** Profiles rows for the usage-bar tests: board order B, A, C with no stored profiles. */
type RoleWindow = { counts: Record<string, number>; sample: number };

function usageTree(
  recent: Record<string, number>,
  compact = false,
  extra: {
    sample?: number;
    roles?: Partial<Record<"worker" | "reviewer" | "coordinator", RoleWindow>>;
  } = {},
) {
  const snapshot = {
    ...board(),
    profiles: (["b", "a", "c", "d"] as const).map((id) => ({
      id,
      name: `Sol ${id.toUpperCase()}`,
      provider: "codex",
      model: "gpt-5",
      notes: "",
      available: true,
      problem: "",
      supportedThinking: [],
    })),
    pool: (["b", "a", "c", "d"] as const).map((profileId) => ({
      profileId,
      group: "codex",
      enabled: true,
      roles: ["worker"],
      weight: "default",
      scopes: ["general"],
    })),
    recentAssignments: recent,
    recentAssignmentSample: extra.sample ?? 50,
    recentAssignmentRoles: {
      worker: { counts: {}, sample: 0 },
      reviewer: { counts: {}, sample: 0 },
      coordinator: { counts: {}, sample: 0 },
      ...extra.roles,
    },
  };
  const invoke = async (method: string) => {
    if (method === "queue.ui-snapshot") return snapshot;
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "repositories") return [];
    if (method === "profile.list") return { profiles: [] };
    if (method === "profile.compatibility") return { hosts: [], rows: [] };
    if (method === "profile.vocabulary") return catalog;
    return {};
  };
  return h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke,
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c },
        host: { id: "host", label: "Host" },
        layout: { compact, platform: "ios" as const },
      }),
    }),
  });
}

for (const compact of [false, true])
  test(`nucleus#1501: rows scale recent-assignment strips to visible leaders (${compact ? "narrow" : "wide"})`, async () => {
    await load();
    const { profileUsage, RECENT_ASSIGNMENT_WINDOW } = await import(
      "../client/settings-profile-helpers"
    );
    const { usageStripColor } = await import("../client/design");
    assert.equal(
      RECENT_ASSIGNMENT_WINDOW,
      50,
      "the bar reads the rotation window",
    );
    assert.equal(
      usageStripColor(0),
      "rgb(82, 182, 209)",
      "positive usage starts cool",
    );
    assert.equal(usageStripColor(1), "rgb(224, 126, 151)", "leaders end warm");
    assert.deepEqual(
      profileUsage(
        {
          recentAssignments: {
            "profile:a": 16,
            "profile:b": 16,
            "profile:c": 13,
            "profile:d": 0,
            "profile:retired": 50,
            anthropic: 8,
          },
          recentAssignmentSample: 50,
        } as never,
        "a",
        ["a", "b", "c", "d"],
      ),
      { count: 16, max: 16, sample: 50 },
      "the maximum includes visible profile IDs and ignores retired history",
    );
    assert.equal(profileUsage(null, "a", ["a"]), null, "no board, no bar");
    const ui = mount(
      usageTree(
        {
          "profile:a": 16,
          "profile:b": 16,
          "profile:c": 13,
          "profile:d": 0,
          "profile:retired": 50,
          anthropic: 8,
        },
        compact,
      ),
    );
    try {
      await settle(() => ui.text().includes("Profiles"));
      ui.press("Profiles");
      await settle(
        () =>
          Boolean(ui.query(/Sol A, all roles: 16 of 50 recent assignments/)) &&
          Boolean(ui.query(/Sol D, all roles: 0 of 50 recent assignments/)),
      );
      assert.ok(ui.query(/Sol B, all roles: 16 of 50 recent assignments/));
      assert.ok(ui.query(/Sol C, all roles: 13 of 50 recent assignments/));
      assert.equal(
        usageFillWidth(ui, "Sol A, all roles: 16 of 50 recent assignments"),
        "100%",
      );
      assert.equal(
        usageFillWidth(ui, "Sol B, all roles: 16 of 50 recent assignments"),
        "100%",
        "tied leaders both fill the strip",
      );
      assert.equal(
        usageFillWidth(ui, "Sol C, all roles: 13 of 50 recent assignments"),
        "81.25%",
        "13 scales against the visible maximum of 16",
      );
      assert.equal(
        usageFillWidth(ui, "Sol D, all roles: 0 of 50 recent assignments"),
        "0%",
        "zero is a neutral empty track",
      );
      assert.equal(
        usageTrack(ui, "Sol A, all roles: 16 of 50 recent assignments").props
          .style.height,
        36,
        "the track matches adjacent controls",
      );
      assert.doesNotMatch(
        ui.text(),
        /(?:16|13|0)\/50/,
        "counts are not printed as inline fractions",
      );
      const flat = ui.text();
      assert.ok(
        flat.indexOf("Sol B") < flat.indexOf("Sol A") &&
          flat.indexOf("Sol A") < flat.indexOf("Sol C"),
        "usage never reorders the rows",
      );
      for (const name of ["Sol A", "Sol B", "Sol C"])
        assert.ok(ui.query(`Edit ${name}`), `${name} stays editable`);
      assert.match(
        String((ui.get("Profiles help") as Node).props.accessibilityHint ?? ""),
        /full strip means that profile is busiest in the list.*up to its last 50 recorded/s,
        "the section help names the scale and sample window once",
      );
    } finally {
      ui.update(h("View", null));
    }
  });

test("nucleus#1501: an all-zero sample keeps neutral empty strips", async () => {
  await load();
  const ui = mount(usageTree({}, false, { sample: 0 }));
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() =>
      Boolean(ui.query(/Sol A, all roles: 0 of 0 recent assignments/)),
    );
    for (const name of ["Sol A", "Sol B", "Sol C", "Sol D"])
      assert.equal(
        usageFillWidth(ui, `${name}, all roles: 0 of 0 recent assignments`),
        "0%",
        `${name} has no fill`,
      );
    assert.doesNotMatch(
      ui.text(),
      /(?:0|1)\/50/,
      "an empty sample has no inline fraction",
    );
    const flat = ui.text();
    assert.ok(
      flat.indexOf("Sol B") < flat.indexOf("Sol A"),
      "row order holds with no data either",
    );
  } finally {
    ui.update(h("View", null));
  }
});

// nucleus#1502: the usage view picks which charged window the strips read.
const ALL_WINDOW = {
  "profile:a": 16,
  "profile:b": 16,
  "profile:c": 13,
  "profile:d": 0,
};
const ROLE_WINDOWS: Partial<
  Record<"worker" | "reviewer" | "coordinator", RoleWindow>
> = {
  // Partial sample: 15 worker charges, a tied leader pair and an empty profile.
  worker: {
    counts: { "profile:a": 5, "profile:b": 5, "profile:c": 5, "profile:d": 0 },
    sample: 15,
  },
  // Three reviewer charges: one profile leads at 2, another at 1.
  reviewer: { counts: { "profile:b": 1, "profile:c": 2 }, sample: 3 },
  // No coordinator history yet.
  coordinator: { counts: {}, sample: 0 },
};

for (const compact of [false, true])
  test(`nucleus#1502: switching the usage view changes the counts, maximum and accessible summary (${compact ? "narrow" : "wide"})`, async () => {
    await load();
    const ui = mount(
      usageTree(ALL_WINDOW, compact, { sample: 50, roles: ROLE_WINDOWS }),
    );
    try {
      await settle(() => ui.text().includes("Profiles"));
      ui.press("Profiles");
      await settle(() =>
        Boolean(ui.query(/Sol B, all roles: 16 of 50 recent assignments/)),
      );
      assert.equal(
        usageFillWidth(ui, "Sol B, all roles: 16 of 50 recent assignments"),
        "100%",
        "All keeps the shared window and its tied leaders",
      );
      assert.equal(
        usageFillWidth(ui, "Sol C, all roles: 13 of 50 recent assignments"),
        "81.25%",
      );

      ui.press("Workers");
      await settle(() =>
        Boolean(ui.query(/Sol A, workers: 5 of 15 recent assignments/)),
      );
      assert.equal(
        usageFillWidth(ui, "Sol A, workers: 5 of 15 recent assignments"),
        "100%",
        "tied worker leaders fill",
      );
      assert.equal(
        usageFillWidth(ui, "Sol B, workers: 5 of 15 recent assignments"),
        "100%",
      );
      assert.equal(
        usageFillWidth(ui, "Sol D, workers: 0 of 15 recent assignments"),
        "0%",
        "zero stays an empty track",
      );
      assert.doesNotMatch(
        ui.text(),
        /No recorded/,
        "a populated view has no empty state",
      );

      ui.press("Reviewers");
      await settle(() =>
        Boolean(ui.query(/Sol C, reviewers: 2 of 3 recent assignments/)),
      );
      assert.equal(
        usageFillWidth(ui, "Sol C, reviewers: 2 of 3 recent assignments"),
        "100%",
      );
      assert.equal(
        usageFillWidth(ui, "Sol B, reviewers: 1 of 3 recent assignments"),
        "50%",
        "a partial sample scales to this view's maximum, not the All maximum",
      );
      assert.equal(
        usageFillWidth(ui, "Sol A, reviewers: 0 of 3 recent assignments"),
        "0%",
      );

      ui.press("Coordinators");
      await settle(() =>
        ui.text().includes("No recorded coordinator assignments yet."),
      );
      for (const name of ["Sol A", "Sol B", "Sol C", "Sol D"])
        assert.equal(
          usageFillWidth(
            ui,
            `${name}, coordinators: 0 of 0 recent assignments`,
          ),
          "0%",
          `${name} has no coordinator fill`,
        );

      ui.press("All roles");
      await settle(() =>
        Boolean(ui.query(/Sol B, all roles: 16 of 50 recent assignments/)),
      );
      assert.equal(
        usageFillWidth(ui, "Sol B, all roles: 16 of 50 recent assignments"),
        "100%",
        "returning to All restores its counts",
      );
    } finally {
      ui.update(h("View", null));
    }
  });

test("nucleus#1502: the usage view strip shows its count and view in a tooltip on hover", async () => {
  await load();
  const ui = mount(
    usageTree(ALL_WINDOW, false, { sample: 50, roles: ROLE_WINDOWS }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => Boolean(ui.query("Workers")));
    ui.press("Workers");
    await settle(() =>
      Boolean(ui.query(/Sol A, workers: 5 of 15 recent assignments/)),
    );
    ui.get("Sol A, workers: 5 of 15 recent assignments").props.onHoverIn();
    await settle(() =>
      ui.text().includes("Sol A, workers: 5 of 15 recent assignments"),
    );
    assert.ok(
      ui.text().includes("Sol A, workers: 5 of 15 recent assignments"),
      "the tooltip names the view, count and sample",
    );
  } finally {
    ui.update(h("View", null));
  }
});

test("nucleus#1502: an empty role view says so and keeps every row editable", async () => {
  await load();
  const ui = mount(
    usageTree(ALL_WINDOW, false, { sample: 50, roles: ROLE_WINDOWS }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Profiles");
    await settle(() => Boolean(ui.query("Coordinators")));
    ui.press("Coordinators");
    await settle(() =>
      ui.text().includes("No recorded coordinator assignments yet."),
    );
    for (const name of ["Sol A", "Sol B", "Sol C", "Sol D"])
      assert.ok(
        ui.query(`Edit ${name}`),
        `${name} stays editable with no history`,
      );
  } finally {
    ui.update(h("View", null));
  }
});
