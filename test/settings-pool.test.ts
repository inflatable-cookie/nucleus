import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRequire } from "node:module";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { build } from "esbuild";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { boardShellPlugin, mount, useNativeStubs } from "./support/render";
import {
  capacitySchema,
  poolSchema,
  type PoolEntry,
  type Profile,
} from "../shared/contracts";

useNativeStubs();

type SettingsModule = typeof import("../client/settings-screen");
let settings: SettingsModule;
const load = async () => {
  settings = await import("../client/settings-screen");
  return settings;
};
const loadBundle = async () => {
  const bytes = (
    await build({
      stdin: {
        contents: `export * from "../client/settings-screen.tsx";`,
        resolveDir: import.meta.dirname,
      },
      bundle: true,
      plugins: [boardShellPlugin],
      platform: "node",
      format: "cjs",
      packages: "external",
      write: false,
    })
  ).outputFiles[0]!.text;
  const compiled = { exports: {} as SettingsModule };
  new Function("require", "module", "exports", bytes)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  settings = compiled.exports;
  return compiled.exports;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Real time for debounced autosaves: poll every 20 ms for up to 3 s. */
async function waitFor(probe: () => boolean, label = "condition") {
  for (const deadline = Date.now() + 3_000; Date.now() < deadline; ) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}
const profile = (id: string, name = id): Profile => ({
  id,
  name,
  provider: "openai",
  model: "gpt-5",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: [],
});
const entry = (profileId: string, group = "subscription"): PoolEntry =>
  poolSchema.parse({
    profileId,
    group,
    weight: "default",
    enabled: true,
  });

/** Settings-only capacity writes: the read Settings renders, with no change recorded yet. */
const CAPACITY_LIMITS = {
  globalLimit: 32,
  projectLimit: 5,
  hostCallLimit: 6,
  threadRetentionDays: 3,
  threadRetentionIntervalHours: 12,
};
const CAPACITY_VALUES = {
  ...CAPACITY_LIMITS,
  operatorDefaultHostKind: "paseo" as const,
};
interface CapacityView {
  effective: typeof CAPACITY_VALUES;
  changes: {
    version: number;
    at: string;
    surface: string;
    before: typeof CAPACITY_VALUES;
    after: typeof CAPACITY_VALUES;
  }[];
}
const capacityAuthorityState = (
  overrides: Record<string, unknown> = {},
): CapacityView =>
  ({
    effective: { ...CAPACITY_VALUES, heavySlots: 5, normalSlots: 22, lightSlots: 5 },
    revision: "limits-0",
    changes: [],
    ...overrides,
  }) as CapacityView;
const usageOf = (state: Record<string, unknown>) => ({
  availability: state.availability,
  assignments: state.assignments,
  recentAssignments: state.recentAssignments,
  recentAssignmentSample: state.recentAssignmentSample,
  recentAssignmentRoles: state.recentAssignmentRoles,
});
const board = (overrides: Record<string, unknown> = {}) => ({
  revision: 1,
  canEditSettings: true,
  connected: true,
  hostId: "host",
  paused: false,
  error: "",
  quiet: true,
  activeWorkers: 0,
  unsettled: 0,
  globalLimit: 32,
  projectLimit: 5,
  tasks: [],
  profiles: [],
  pool: [],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes: [],
  projects: [],
  projectLimitOverrides: {},
  projectCapacities: [],
  prStates: {},
  ...overrides,
});

/** Remove a project row's override the way an operator does: its trash icon, then the confirmation (Tom, 2026-11-08). */
function pressRemove(
  ui: { press(label: string | RegExp): void },
  name: string,
) {
  ui.press(`Remove the ${name} override`);
  ui.press(`Remove ${name} dispatch limit override`);
}

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail("the settings screen did not settle");
}

function unmount(ui: ReturnType<typeof mount>) {
  ui.update(h("View", null));
}

function setSettingsWidth(ui: ReturnType<typeof mount>, width: number) {
  ui.get("Nucleus settings").props.onLayout({
    nativeEvent: { layout: { width } },
  });
}

function selectSettingsTab(ui: ReturnType<typeof mount>, label: string) {
  const tab = (ui.get("Settings sections") as Node).children.find(
    (node): node is Node =>
      typeof node !== "string" && node.props.accessibilityLabel === label,
  );
  assert.ok(tab, `the ${label} tab`);
  tab.props.onPress();
}

function screenTree(
  state: ReturnType<typeof board>,
  onPool?: (input: unknown) => void,
  compact = false,
  onUsage?: (input: unknown) => void,
) {
  const invoke = async (method: string, input: unknown) => {
    if (method === "rust.profile-usage") return usageOf(state as Record<string, unknown>);
    if (method === "queue.ui-snapshot") return state;
    if (method === "queue.capacity-state") return capacityAuthorityState();
    if (method === "queue.usage") {
      onUsage?.(input);
      return {
        level: "maximum",
        setLevel: "maximum",
        until: null,
        expired: false,
      };
    }
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "queue.pool" || method === "queue.profile") {
      onPool?.(input);
      return method === "queue.profile" ? { ok: true, entry: input } : { ok: true };
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

test("a live profile row is one line at narrow and wide sizes, with no By request status", async () => {
  await load();
  const model = "claude-sonnet-4-5-20250929";
  const longName = "A very long profile name that would otherwise truncate";
  const state = board({
    profiles: [
      {
        ...profile("worker-1", longName),
        provider: "anthropic",
        model,
        thinkingOptionId: "high",
      },
    ],
    pool: [
      poolSchema.parse({
        profileId: "worker-1",
        group: "anthropic-max",
        enabled: true,
        capability: "frontier",
        weight: "most",
      }),
    ],
    recentAssignments: { "profile:worker-1": 2 },
    recentAssignmentSample: 2,
    assignments: { "profile:worker-1": 7 },
  });
  for (const compact of [false, true]) {
    const mode = compact ? "compact" : "wide";
    const ui = mount(screenTree(state, undefined, compact));
    if (compact) setSettingsWidth(ui, 390);
    selectSettingsTab(ui, "Profiles");
    await settle(() => ui.text().includes(longName));
    const texts = ui.ofType("Text");
    const name = texts.find((node) => node.children.join("") === longName)!;
    const modelLine = texts.find((node) => node.children.join("") === model);
    assert.ok(name && !modelLine, `${mode} row renders only the profile name`);
    assert.equal(
      ui.query(`${longName}: Needs a request`),
      undefined,
      "By request and its status icon are retired (Tom, 2026-11-09)",
    );
    assert.equal(
      name.props.numberOfLines,
      undefined,
      `the name is not ellipsised in the ${mode} view`,
    );
    const rowChildren = (child: typeof name) =>
      ui
        .ofType("View")
        .find((view) => view.children.includes(child))
        ?.children.filter((item) => typeof item !== "string") ?? [];
    assert.deepEqual(
      rowChildren(name)
        .filter((child) => child !== name)
        .map((child) => child.props.accessibilityLabel),
      [
        `${longName}, all roles: 2 of 2 recent assignments`,
        `Disable ${longName}`,
        `Edit ${longName}`,
      ],
      "usage, On/Off and Edit share one line with the name",
    );
    assert.equal(
      ui.query(`Remove ${longName}`),
      undefined,
      "Remove stays off the list row",
    );
    assert.doesNotMatch(
      ui.text(),
      /Cost:|Usage policy:|· relative share|checked against the usage level|2 recent · 7 total|Profile notes|Changes save automatically/,
    );
    unmount(ui);
  }
});

test("an empty or disconnected catalog marks nothing stale", async () => {
  await load();
  const pool = [
    entry("live"),
    { ...entry("opencode-go", "opencode-go"), enabled: false },
  ];
  const empty = mount(
    screenTree(board({ connected: true, profiles: [], pool })),
  );
  selectSettingsTab(empty, "Profiles");
  await settle(() =>
    empty
      .text()
      .includes("No profiles yet. Add one from what your hosts can run."),
  );
  assert.equal(empty.text().includes("This profile is gone"), false);
  assert.equal(empty.query("Remove opencode-go"), undefined);
  unmount(empty);

  const disconnected = mount(
    screenTree(
      board({
        connected: false,
        profiles: [profile("live", "Live model")],
        pool,
      }),
    ),
  );
  selectSettingsTab(disconnected, "Profiles");
  await settle(() => disconnected.text().includes("Live model"));
  assert.equal(
    disconnected.text().includes("This profile is gone"),
    false,
    "a daemon outage does not offer to remove stale rows",
  );
  assert.equal(disconnected.query("Remove opencode-go"), undefined);
  unmount(disconnected);
});

test("the bundled dark Settings screen adds a project override from the picker and removes it", async () => {
  await loadBundle();
  const projectA = {
    key: "project-a",
    name: "Project-A",
    version: 1,
    
    repositories: [{ origin: "owner/project-a", path: "/project-a" }],
    primary: { origin: "owner/project-a", path: "/project-a" },
  };
  const projectD = {
    key: "project-d",
    name: "Project-D",
    version: 1,
    
    repositories: [{ origin: "owner/project-d", path: "/project-d" }],
    primary: { origin: "owner/project-d", path: "/project-d" },
  };
  let state = board({
    projects: [projectA, projectD],
    projectLimitOverrides: { "project-d": 3 },
  });
  const writes: unknown[] = [];
  // Controls for the review #596 regressions: hold a write in flight, or fail one.
  let hold: Promise<void> | null = null,
    failRemove = false;
  const invoke = async (method: string, input: unknown) => {
    if (method === "rust.profile-usage") return usageOf(state as Record<string, unknown>);
    if (method === "queue.ui-snapshot") return state;
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "queue.capacity-state") return capacityAuthorityState();
    if (method === "queue.project-dispatch-limit") {
      const change = input as { projectKey: string; limit: number | null };
      if (hold) await hold;
      if (change.limit === null && failRemove)
        throw new Error("override store unavailable");
      writes.push(change);
      const overrides = {
        ...(state.projectLimitOverrides as Record<string, number>),
      };
      if (change.limit === null) delete overrides[change.projectKey];
      else overrides[change.projectKey] = change.limit;
      state = board({
        ...state,
        revision: state.revision + 1,
        projects: [projectA, projectD],
        projectLimitOverrides: overrides,
      });
      return { ok: true };
    }
    return {};
  };
  const dark = {
    accent: "#1f6feb",
    accentForeground: "#ffffff",
    surface0: "#0d1117",
    surface1: "#161b22",
    surface2: "#30363d",
    border: "#30363d",
    foreground: "#f0f6fc",
    foregroundMuted: "#8b949e",
    statusWarning: "#f0883e",
    statusDanger: "#f85149",
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: dark },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    await settle(() => ui.text().includes("Profiles"));
    ui.press("Dispatch limits");
    await settle(() => Boolean(ui.query("Remove the Project-D override")));
    assert.equal(
      ui.get("Heavy dispatch limit (slots, 0–4294967295)").props.value,
      "5",
      "the task slots are writable again, seeded from the state in force",
    );
    assert.equal(
      ui.query("Save dispatch limits"),
      undefined,
      "Dispatch limits has no save buttons",
    );
    assert.equal(
      ui.get("Nucleus settings").props.style.backgroundColor,
      dark.surface0,
      "the rendered bundle uses the dark host theme",
    );
    assert.equal(
      ui.ofType("Modal").length,
      0,
      "the override picker opens no dialog",
    );
    assert.equal(
      ui.query("Add project limit override: Project-A"),
      undefined,
      "the project picker starts closed",
    );
    ui.press("Add project limit override, +");
    assert.ok(
      ui.get("Add project limit override: Project-A"),
      "+ opens the anchored project picker",
    );
    assert.equal(
      ui.query("Add project limit override: Project-D"),
      undefined,
      "projects with an override are left out of the picker",
    );
    // Choosing a project creates its override at once at the per-project limit.
    // While that create is in flight, + waits: a second pick cannot race it (review #596).
    let releaseCreate!: () => void;
    hold = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    ui.press("Add project limit override: Project-A");
    await waitFor(
      () => ui.get("Add project limit override, +").props.disabled === true,
      "+ to wait for the pending create",
    );
    assert.equal(
      ui.query("Add project limit override: Project-A"),
      undefined,
      "picking closes the picker",
    );
    hold = null;
    releaseCreate();
    await waitFor(
      () =>
        (state.projectLimitOverrides as Record<string, number>)["project-a"] ===
          5 && Boolean(ui.query("Remove the Project-A override")),
      "the override to be created on pick",
    );
    // One line per override: no fixed-width field, no in-flight control (review #599; Tom, 2026-11-08).
    assert.ok(
      !ui.ofType("View").some((node) => node.props.style?.width === 200),
      "no fixed-width override field",
    );
    assert.equal(
      ui.query(/In-flight task cap/),
      undefined,
      "the in-flight cap is always twice the slots",
    );
    assert.deepEqual(writes, [{ projectKey: "project-a", limit: 5 }]);
    const slots = "Task slots for Project-A (0–64; 0 admits nothing)";
    ui.type(slots, "0");
    await waitFor(
      () =>
        (state.projectLimitOverrides as Record<string, number>)["project-a"] ===
        0,
      "the edit to autosave",
    );
    assert.deepEqual(writes[1], { projectKey: "project-a", limit: 0 });

    // A refresh from an in-flight save never replaces a newer draft (review #596).
    let release!: () => void;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    ui.type(slots, "4");
    ui.get(slots).props.onBlur();
    // Saving… is quiet now (Tom, 2026-11-08): the held save shows only as the draft that waits for it.
    await waitFor(
      () => ui.get(slots).props.value === "4",
      "the draft to be entered",
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    ui.type(slots, "");
    hold = null;
    release();
    await waitFor(
      () =>
        (state.projectLimitOverrides as Record<string, number>)["project-a"] ===
        4,
      "the in-flight save to land",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      ui.get(slots).props.value,
      "",
      "the cleared draft stays while typing",
    );
    const settled = writes.length;
    ui.get(slots).props.onBlur();
    assert.equal(
      ui.get(slots).props.value,
      "4",
      "an empty field returns to the value when typing ends",
    );
    assert.equal(writes.length, settled, "an empty field is never sent");

    // Once Remove starts the row takes no edits, so nothing recreates the override (review #596).
    let releaseRemove!: () => void;
    hold = new Promise((resolve) => {
      releaseRemove = resolve;
    });
    ui.type(slots, "6");
    const beforeRemove = writes.length;
    pressRemove(ui, "Project-A");
    await waitFor(
      () => ui.get(slots).props.editable === false,
      "the row to lock while Remove runs",
    );
    ui.type(slots, "4");
    assert.equal(
      ui.get(slots).props.value,
      "6",
      "typing during Remove is ignored",
    );
    hold = null;
    releaseRemove();
    await waitFor(
      () =>
        !Object.keys(
          state.projectLimitOverrides as Record<string, number>,
        ).includes("project-a") && !ui.query("Remove the Project-A override"),
      "the locked removal",
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(
      !Object.keys(
        state.projectLimitOverrides as Record<string, number>,
      ).includes("project-a"),
      "no edit typed during Remove recreates the override",
    );
    assert.deepEqual(
      writes.slice(beforeRemove),
      [{ projectKey: "project-a", limit: null }],
      "only the removal is written: the pending 6 is replaced and the typed 4 ignored",
    );
    // Re-add it for the edit-then-Remove case.
    ui.press("Add project limit override, +");
    ui.press("Add project limit override: Project-A");
    await waitFor(
      () => Boolean(ui.query("Remove the Project-A override")),
      "Project-A to be re-added",
    );
    // An edit immediately followed by Remove ends removed: Remove replaces the pending edit.
    ui.type(slots, "7");
    pressRemove(ui, "Project-A");
    await waitFor(
      () =>
        !Object.keys(
          state.projectLimitOverrides as Record<string, number>,
        ).includes("project-a") && !ui.query("Remove the Project-A override"),
      "the removal",
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(
      !Object.keys(
        state.projectLimitOverrides as Record<string, number>,
      ).includes("project-a"),
      "no pending edit recreates the override after Remove",
    );
    assert.deepEqual(writes.at(-1), { projectKey: "project-a", limit: null });
    assert.equal(
      writes.filter((write) => (write as { limit: number | null }).limit === 7)
        .length,
      0,
    );

    // A failed Remove explains itself and keeps the override.
    failRemove = true;
    pressRemove(ui, "Project-D");
    await waitFor(
      () =>
        /Not saved: .*override store unavailable/.test(
          String(ui.query("Project-D override save status")?.children.join("")),
        ),
      "the removal failure to show",
    );
    assert.equal(
      (state.projectLimitOverrides as Record<string, number>)["project-d"],
      3,
    );
    assert.equal(
      ui.get("Task slots for Project-D (0–64; 0 admits nothing)").props
        .editable,
      true,
      "a failed Remove gives editing back",
    );
    failRemove = false;
    assert.deepEqual(
      state.projectLimitOverrides,
      { "project-d": 3 },
      "removing Project-A keeps the other project override",
    );
    assert.equal(
      ui.query("Cancel Project-A dispatch limit override"),
      undefined,
      "no draft rows or Cancel: picking creates",
    );
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});

test("Settings has no Repositories section: per-repository overrides live in the opened project, the default in Projects → Defaults", async () => {
  await load();
  const ui = mount(screenTree(board()));
  try {
    await settle(() => ui.text().includes("Profiles"));
    assert.equal(
      ui.query("Repositories"),
      undefined,
      "the section is gone (lane nucleus-ui, task 946 build task 4)",
    );
    assert.ok(ui.get("Projects"));
  } finally {
    unmount(ui);
  }
});

/** The task slots' save has settled: its status reads Saved. */
const saved = (ui: {
  query: (label: string) => { children: unknown[] } | undefined;
}) => ui.query("Task slots save status")?.children.join("") === "Saved";

async function mountRevisionedLimits() {
  const bundle = await loadBundle();
  const slots = { heavySlots: 5, normalSlots: 86, lightSlots: 5 };
  let effective = { ...CAPACITY_VALUES, ...slots, globalLimit: 96 };
  const writes: unknown[] = [];
  const revision = () => `limits-${writes.length}`;
  const invoke = async (method: string, input: unknown) => {
    if (method === "rust.profile-usage") return usageOf(board() as Record<string, unknown>);
    if (method === "queue.ui-snapshot") return board();
    if (method === "queue.capacity-state")
      return { revision: revision(), effective, changes: [] };
    if (method === "queue.capacity") {
      const patch = capacitySchema.parse(input);
      assert.ok("revision" in patch);
      const { revision: displayed, ...fields } = patch;
      assert.equal(displayed, revision());
      writes.push(patch);
      effective = { ...effective, ...fields };
      return { ok: true };
    }
    return {};
  };
  const dark = {
    accent: "#1f6feb",
    accentForeground: "#fff",
    surface0: "#0d1117",
    surface1: "#161b22",
    surface2: "#30363d",
    border: "#30363d",
    foreground: "#f0f6fc",
    foregroundMuted: "#8b949e",
    statusWarning: "#f0883e",
    statusDanger: "#f85149",
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h((props) => props.children, {
          children: h(bundle.QueueSettingsScreen as never, {
            theme: { colors: dark },
            host: { id: "host", label: "Host" },
            layout: { compact: false, platform: "ios" as const },
          }),
        }),
      }),
    }),
  );
  await settle(() => ui.text().includes("Profiles"));
  ui.press("Dispatch limits");
  await settle(
    () => ui.query("Heavy dispatch limit (slots, 0–4294967295)") !== undefined,
  );
  return {
    ui,
    writes,
    close() {
      unmount(ui);
      client.clear();
    },
  };
}

test("dark bundled Limits saves the edited slot at its displayed revision", async () => {
  const { ui, writes, close } = await mountRevisionedLimits();
  const heavy = "Heavy dispatch limit (slots, 0–4294967295)";
  const project = "Per project dispatch limit (slots, 1–32)";
  try {
    assert.equal(ui.get(heavy).props.value, "5");
    assert.equal(ui.get(project).props.value, "5");
    assert.equal(ui.query("Advanced limits"), undefined);
    assert.equal(ui.query("Task slots save status"), undefined);
    assert.equal(writes.length, 0);
    ui.type(project, "6");
    await waitFor(() => saved(ui));
    assert.deepEqual(writes, [{ revision: "limits-0", projectLimit: 6 }]);
    assert.equal(ui.get(heavy).props.value, "5");
    ui.type(heavy, "21");
    await waitFor(() => writes.length === 2 && saved(ui));
    assert.deepEqual(writes[1], { revision: "limits-1", heavySlots: 21 });
    assert.equal(ui.get(project).props.value, "6");
    assert.equal(ui.query("View change history"), undefined);
    assert.ok(ui.text().includes("Project overrides"));
    assert.ok(ui.text().includes("Usage level"));
  } finally {
    close();
  }
});

test("bundled Limits steppers enforce the Rust slot bounds for typing and buttons", async () => {
  const { ui, writes, close } = await mountRevisionedLimits();
  const project = "Per project dispatch limit (slots, 1–32)";
  try {
    assert.equal(ui.ofType("input").length, 0);
    assert.equal(ui.get(project).type, "TextInput");
    assert.equal(ui.get(project).props.keyboardType, "number-pad");
    ui.press(`Increase ${project}`);
    await waitFor(() => writes.length === 1 && saved(ui));
    assert.deepEqual(writes[0], { revision: "limits-0", projectLimit: 6 });
    ui.type(project, "abc");
    assert.equal(ui.get(project).props.value, "");
    ui.type(project, "33");
    assert.equal(writes.length, 1);
    ui.get(project).props.onBlur();
    await waitFor(() => writes.length === 2 && saved(ui));
    assert.deepEqual(writes[1], { revision: "limits-1", projectLimit: 32 });
    assert.equal(
      ui.get(`Increase ${project}`).props.accessibilityState.disabled,
      true,
    );
    ui.type(project, "1");
    await waitFor(() => writes.length === 3 && saved(ui));
    assert.deepEqual(writes[2], { revision: "limits-2", projectLimit: 1 });
    assert.equal(
      ui.get(`Decrease ${project}`).props.accessibilityState.disabled,
      true,
    );
  } finally {
    close();
  }
});

test("Spec 052: the usage slider lives under Dispatch limits, and saves a level with an end time picked from the calendar", async () => {
  await load();
  const sent: unknown[] = [];
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
      undefined,
      false,
      (input) => sent.push(input),
    ),
  );
  selectSettingsTab(ui, "Profiles");
  await settle(() => ui.text().includes("Live model"));
  assert.equal(
    ui.query("Usage level"),
    undefined,
    "Profiles no longer carries the slider",
  );
  ui.press("Dispatch limits");
  await settle(() => ui.text().includes("Usage level"));
  // Normal in force shows only when it differs from the level set, and the end time shows only above Normal.
  assert.doesNotMatch(ui.text(), /Normal in force/);
  assert.doesNotMatch(ui.text(), /until/);
  // The end-time field sits in a column: no flex basis to stretch it into a tall gap (Tom, 2026-10-22).
  assert.ok(
    !ui.ofType("View").some((node) => node.props.style?.flexBasis === 280),
    "no 280 px basis on the Limits page",
  );
  for (const title of ["Usage level", "Task slots", "Project overrides"]) {
    const header = ui
      .ofType("Text")
      .find(
        (node) =>
          node.props.accessibilityRole === "header" &&
          node.children.join("") === title,
      );
    assert.ok(header, `${title} section header`);
    // A long note or "Not saved" reason wraps below; it never squeezes the title (review #599).
    // A long title wraps inside its group rather than overflowing the section on a narrow layout (857 review evidence).
    assert.equal(
      header.props.style.flexShrink,
      1,
      `${title} wraps instead of overflowing`,
    );
    assert.equal(
      header.props.numberOfLines,
      undefined,
      `${title} is never truncated`,
    );
    assert.ok(header.props.style.minWidth >= 120);
    const views = ui.ofType("View");
    const titleGroup = views.find((node) => node.children.includes(header));
    assert.ok(titleGroup, `${title} title group`);
    const headerRow = views.find((node) => node.children.includes(titleGroup));
    assert.equal(headerRow?.props.style.flexWrap, "wrap", `${title} row wraps`);
  }
  ui.press("Usage Maximum");
  await settle(() =>
    /medium and high on Heavyweight, very high on Frontier/.test(
      ui.get("Usage level help").props.accessibilityHint,
    ),
  );
  await waitFor(() => sent.length === 1, "the level to save on press");
  assert.deepEqual(sent[0], { level: "maximum", until: null });
  ui.press("Return to Normal: No end");
  await settle(() => ui.text().includes("In 1 week"));
  assert.ok(
    !ui.ofType("View").some((node) => node.props.style?.width === 200),
    "the end time is small text, not a field beside the slider (task 1014)",
  );
  ui.press("In 3 days");
  ui.press("Minute 30");
  ui.press("Done");
  await settle(() => !ui.text().includes("In 1 week"));
  assert.equal(
    ui.query("Return to Normal: No end"),
    undefined,
    "the link shows the picked local time",
  );
  assert.equal(
    ui.query("Save usage level"),
    undefined,
    "no save button: the end time saves when picked",
  );
  await waitFor(() => sent.length === 2, "the end time to save when picked");
  const saved = sent[1] as { level: string; until: string };
  assert.equal(saved.level, "maximum");
  const until = new Date(saved.until);
  assert.equal(until.getMinutes(), 30);
  const days = (until.getTime() - Date.now()) / 86_400_000;
  assert.ok(
    days > 2.9 && days < 3.1,
    `about three days ahead, got ${days.toFixed(2)}`,
  );
  unmount(ui);
});

test("Dispatch limits has no Role demand section: roles carry no demand offsets (Tom, 2026-11-19)", async () => {
  await load();
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
    ),
  );
  selectSettingsTab(ui, "Profiles");
  await settle(() => ui.text().includes("Live model"));
  ui.press("Dispatch limits");
  await settle(() => ui.text().includes("Usage level"));
  assert.equal(ui.query("Role demand offsets"), undefined);
  assert.equal(ui.query("coordinator demand offset"), undefined);
  assert.doesNotMatch(ui.text(), /Role demand/);
  unmount(ui);
});

test("Dispatch limits keeps explanations behind (?): hidden until hovered or pressed (Tom, 2026-10-22)", async () => {
  await load();
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
    ),
  );
  await settle(() => ui.query("Task slots help") !== undefined);
  // The descriptions are no longer on the page.
  for (const text of [
    "Each run starts at the usage level's tier",
    "Parked tasks hold no slot",
    "A project's own slot limit",
    "Runs need what the task needs",
  ])
    assert.ok(!ui.text().includes(text), `"${text}" sits behind its (?)`);
  for (const title of ["Usage level", "Task slots", "Project overrides"]) {
    const help = ui.get(`${title} help`);
    assert.ok(
      help.props.accessibilityHint.length > 20,
      `${title} has its explanation as the (?) hint`,
    );
    assert.equal(
      ui.query(`${title} help text`),
      undefined,
      `${title} help is closed by default`,
    );
  }
  // Pressing pins it open; pressing again closes it. Hover opens it too.
  ui.press("Task slots help");
  await settle(() => Boolean(ui.query("Task slots help text")));
  assert.match(ui.text(), /Parked tasks hold no slot/);
  ui.press("Task slots help");
  await settle(() => !ui.query("Task slots help text"));
  ui.get("Project overrides help").props.onHoverIn();
  await settle(() => Boolean(ui.query("Project overrides help text")));
  ui.get("Project overrides help").props.onHoverOut();
  await settle(() => !ui.query("Project overrides help text"));
  // Review #600: a press closes a tip that hover or focus opened, and it stays closed until the pointer leaves.
  ui.get("Usage level help").props.onHoverIn();
  await settle(() => Boolean(ui.query("Usage level help text")));
  ui.press("Usage level help");
  await settle(() => !ui.query("Usage level help text"));
  ui.get("Usage level help").props.onHoverIn();
  await tick();
  await tick();
  assert.equal(
    ui.query("Usage level help text"),
    undefined,
    "still hovered after closing: stays closed",
  );
  ui.get("Usage level help").props.onHoverOut();
  ui.get("Usage level help").props.onHoverIn();
  await settle(() => Boolean(ui.query("Usage level help text")));
  ui.get("Usage level help").props.onFocus?.();
  ui.press("Usage level help");
  await settle(() => !ui.query("Usage level help text"));
  // Review #600: the panel spans its section's header row (capped at 420 px), never a fixed width that overflows a compact layout.
  ui.press("Task slots help");
  await settle(() => Boolean(ui.query("Task slots help text")));
  assert.equal(ui.get("Task slots help text").props.style.maxWidth, 420);
  assert.ok(
    !ui.ofType("View").some((node) => node.props.style?.width === 300),
    "no fixed-width help panel",
  );
  assert.ok(
    ui
      .ofType("View")
      .some(
        (node) =>
          node.props.style?.position === "absolute" &&
          node.props.style?.left === 0 &&
          node.props.style?.right === 0,
      ),
    "the panel is laid against both edges of its section",
  );
  unmount(ui);
});

test("Spec 052: a usage expiry projected while the end-time picker is open keeps the picker and the draft", async () => {
  await load();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const state = board({
    profiles: [profile("live", "Live model")],
    pool: [entry("live")],
  }) as ReturnType<typeof board> & { usage: unknown };
  state.usage = {
    level: "maximum",
    setLevel: "maximum",
    until,
    expired: false,
  };
  const ui = mount(screenTree(state));
  await settle(
    () => Boolean(ui.query("Usage High")) && ui.text().includes("until"),
  );
  ui.press("Usage High");
  ui.press(/^Return to Normal: until /);
  await settle(() => ui.text().includes("In 1 week"));
  // The level expires on the host; the next poll re-projects the board.
  state.usage = { level: "normal", setLevel: "maximum", until, expired: true };
  const deadline = Date.now() + 9000;
  while (!ui.text().includes("Normal in force") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(ui.text(), /Normal in force/, "the header shows the expiry");
  assert.match(ui.text(), /In 1 week/, "the picker stays open");
  assert.match(
    ui.get("Usage level help").props.accessibilityHint,
    /High and very-high complexity start on Heavyweight\. Frontier profiles require an explicit request/,
    "the edited level draft survives",
  );
  unmount(ui);
});

test("settings tabs show the short labels and keep full accessible names", async () => {
  await load();
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
    ),
  );
  await settle(() => ui.query("Settings sections") !== undefined);
  const sections = ui.get("Settings sections") as Node;
  assert.equal(sections.type, "View", "one row of tabs, no scroller");
  assert.equal(sections.props.style.flexWrap, "nowrap", "the tabs never wrap");
  for (const [full, short] of [
    ["Profiles", "Profiles"],
    ["Dispatch limits", "Limits"],
  ]) {
    const tab = ui.get(full) as Node;
    assert.ok(
      sections.children.some(
        (node) =>
          typeof node !== "string" && node.props.accessibilityLabel === full,
      ),
      `${full} is a tab`,
    );
    assert.equal(
      ui.ofType("Text").some((node) => node.children.join("") === short),
      true,
      `${full} shows as ${short}`,
    );
    assert.equal(tab.props.accessibilityRole, "button");
  }
  unmount(ui);
});

test("Spec 052: a profile row shows a status only for a problem; a frontier profile shows none at any level, and the editor has no By request", async () => {
  await loadBundle();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const pool = [
    poolSchema.parse({
      profileId: "frontier",
      group: "frontier",
      enabled: true,
      capability: "frontier",
      weight: "default",
    }),
    poolSchema.parse({
      profileId: "cheap",
      group: "cheap",
      enabled: true,
      capability: "frontier",
      weight: "default",
    }),
    poolSchema.parse({
      profileId: "off",
      group: "off",
      enabled: false,
      capability: "frontier",
      weight: "default",
    }),
    poolSchema.parse({
      profileId: "gone",
      group: "gone",
      enabled: true,
      weight: "default",
    }),
  ];
  let state = board({
    profiles: [
      profile("frontier", "Frontier Opus with a long profile name"),
      profile("cheap", "Cheap"),
      profile("off", "Off"),
      {
        ...profile("gone", "Gone"),
        available: false,
        problem: "Provider missing",
      },
    ],
    pool,
  }) as ReturnType<typeof board> & { usage: unknown };
  state.usage = {
    level: "maximum",
    setLevel: "maximum",
    until,
    expired: false,
  };
  const writes: string[] = [];
  const dark = {
    accent: "#1f6feb",
    accentForeground: "#ffffff",
    surface0: "#0d1117",
    surface1: "#161b22",
    surface2: "#30363d",
    border: "#30363d",
    foreground: "#f0f6fc",
    foregroundMuted: "#8b949e",
    statusWarning: "#f0883e",
    statusDanger: "#f85149",
  };
  const invoke = async (method: string) => {
    if (method === "rust.profile-usage") return usageOf(state as Record<string, unknown>);
    if (method === "queue.ui-snapshot") return state;
    if (method === "backup.list") return { snapshots: [], localError: null };
    if (method === "queue.capacity-state") return capacityAuthorityState();
    writes.push(method);
    return {};
  };
  const status = (ui: ReturnType<typeof mount>, name: string) =>
    ui
      .ofType("Pressable")
      .find((node) =>
        String(node.props.accessibilityLabel ?? "").startsWith(`${name}: `),
      )
      ?.props.accessibilityLabel?.toString()
      .slice(name.length + 2) ?? "";
  for (const compact of [false, true]) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    state = {
      ...state,
      usage: { level: "maximum", setLevel: "maximum", until, expired: false },
    };
    const ui = mount(
      h(QueryClientProvider, {
        client,
        children: h(PluginRpcProvider, {
          invoke: invoke as never,
          children: h(settings.QueueSettingsScreen as never, {
            theme: { colors: dark },
            host: { id: "host", label: "Host" },
            layout: { compact, platform: "ios" as const },
          }),
        }),
      }),
    );
    try {
      selectSettingsTab(ui, "Profiles");
      await settle(() => ui.text().includes("Frontier Opus"));
      assert.equal(
        ui.get("Nucleus settings").props.style.backgroundColor,
        dark.surface0,
      );
      assert.equal(
        status(ui, "Frontier Opus with a long profile name"),
        "",
        "a frontier profile has no status",
      );
      assert.equal(
        status(ui, "Cheap"),
        "",
        "needing a request is not a row status",
      );
      assert.equal(status(ui, "Off"), "", "an off profile has no status");
      assert.equal(status(ui, "Gone"), "Unavailable");
      assert.doesNotMatch(
        ui.text(),
        /Usage policy:|Cost: very high|· relative share|Changes save automatically|Profile notes/,
      );
      state = {
        ...state,
        revision: state.revision + 1,
        usage: { level: "normal", setLevel: "maximum", until, expired: true },
      };
      await client.refetchQueries({
        queryKey: ["nucleus", "state"],
        exact: true,
      });
      // A refetch is async: wait on the clock, not on a fixed count of immediate ticks, so the probe cannot race it.
      await waitFor(
        () => status(ui, "Gone") === "Unavailable",
        "the refetch to settle",
      );
      assert.equal(
        status(ui, "Frontier Opus with a long profile name"),
        "",
        "still no status at Normal",
      );
      assert.equal(
        status(ui, "Gone"),
        "Unavailable",
        "unavailable still shows at Normal",
      );
      ui.press("Edit Frontier Opus with a long profile name");
      await settle(() => Boolean(ui.query("Capability help")));
      assert.equal(
        ui.query("Selection by request"),
        undefined,
        "By request is retired (Tom, 2026-11-09)",
      );
      assert.match(
        ui.get("Capability help").props.accessibilityHint,
        /Frontier requires a request at Low, Normal and High\. Heavyweight does too at Low and Normal unless the task starts or climbs there/,
      );
      assert.match(
        ui.get("Weight help").props.accessibilityHint,
        /never makes a profile eligible or ineligible/,
      );
      assert.doesNotMatch(
        ui.text(),
        /Each cost step down|Cost help|Each run needs the task's complexity|Weight 2 receives|By request/,
      );
      assert.equal(
        ui.query("Save Frontier Opus with a long profile name"),
        undefined,
      );
      assert.equal(ui.query("Cancel"), undefined);
      assert.ok(
        ui.get("Remove Frontier Opus with a long profile name"),
        "Remove is an icon action in the editor header",
      );
      assert.deepEqual(
        writes.filter(
          (method) => method === "queue.profile" || method === "queue.pool",
        ),
        [],
        "reading the policy writes nothing",
      );
    } finally {
      ui.update(h("View", null));
      client.clear();
    }
  }
});

test("Subscriptions: a group row names only its state; its counts and pause sit in the opened editor", async () => {
  await load();
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
    ),
  );
  try {
    selectSettingsTab(ui, "Profiles");
    await settle(() => Boolean(ui.all(/^Pause /)[0]));
    assert.ok(
      contains(ui.get("Subscriptions") as Node, "Pause subscription"),
      "the groups sit in the Subscriptions section on Profiles",
    );
    assert.doesNotMatch(ui.text(), /recent ·/, "no counts on the row");
    assert.equal(
      ui.query("Mark unavailable"),
      undefined,
      "the pause is folded until the group is opened",
    );
    ui.press(/^Pause /);
    await settle(() => ui.text().includes("recent ·"));
    assert.match(ui.text(), /Reason/);
    assert.ok(ui.get("Retry at"), "the retry field is named plainly");
  } finally {
    unmount(ui);
  }
});

test("a problem shows an unboxed warning glyph; needing a request shows no glyph now By request is retired", async () => {
  await load();
  const dark = {
    accent: "#1f6feb",
    accentForeground: "#ffffff",
    surface0: "#0d1117",
    surface1: "#161b22",
    surface2: "#30363d",
    border: "#30363d",
    foreground: "#f0f6fc",
    foregroundMuted: "#8b949e",
    statusWarning: "#f0883e",
    statusDanger: "#f85149",
  };
  const state = board({
    recentAssignmentSample: 0,
    recentAssignmentRoles: {
      worker: { counts: {}, sample: 0 },
      reviewer: { counts: {}, sample: 0 },
      coordinator: { counts: {}, sample: 0 },
    },
    profiles: [
      profile("paused", "GLM 5.3 Flash"),
      profile("oracle", "Opus Oracle"),
      profile("both", "Paused oracle"),
    ],
    pool: [
      poolSchema.parse({
        profileId: "paused",
        group: "zai",
        enabled: true,
        weight: "default",
      }),
      poolSchema.parse({
        profileId: "oracle",
        group: "anthropic",
        enabled: true,
        capability: "frontier",
        weight: "default",
      }),
      poolSchema.parse({
        profileId: "both",
        group: "zai",
        enabled: true,
        capability: "frontier",
        weight: "default",
      }),
    ],
    availability: [
      {
        group: "zai",
        unavailable: true,
        reason: "weekly limit",
        retryAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  });
  const ui = mount(
    h(QueryClientProvider, {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      children: h(PluginRpcProvider, {
        invoke: (async (method: string) =>
          method === "rust.profile-usage"
            ? usageOf(state)
            : method === "queue.ui-snapshot"
            ? state
            : method === "backup.list"
              ? { snapshots: [], localError: null }
              : method === "queue.capacity-state"
                ? capacityAuthorityState()
                : {}) as never,
        children: h(settings.QueueSettingsScreen as never, {
          theme: { colors: dark },
          host: { id: "host", label: "Host" },
          layout: { compact: false, platform: "ios" as const },
        }),
      }),
    }),
  );
  try {
    selectSettingsTab(ui, "Profiles");
    await settle(() => ui.text().includes("Paused oracle"));
    const node = ui.get("GLM 5.3 Flash: Subscription paused") as Node;
    const icon = node.children.find(
      (child): child is Node =>
        typeof child !== "string" && child.props.name !== undefined,
    )!;
    assert.deepEqual(
      [icon.props.name, icon.props.color],
      ["TriangleAlert", dark.statusWarning],
      "a paused subscription reads as a warning",
    );
    assert.equal(node.props.style.backgroundColor, undefined, "no button box");
    assert.notEqual(node.props.accessibilityRole, "button");
    assert.equal(
      ui.query("Opus Oracle: Needs a request"),
      undefined,
      "a frontier profile shows no status",
    );
    assert.equal(ui.query("Opus Oracle: Subscription paused"), undefined);
    const name = ui
      .ofType("Text")
      .find((item) => item.children.join("") === "Paused oracle")!;
    const rowLabels = ui
      .ofType("View")
      .find((view) => view.children.includes(name))!
      .children.filter(
        (child): child is Node => typeof child !== "string" && child !== name,
      )
      .map((child) => child.props.accessibilityLabel);
    assert.deepEqual(
      rowLabels,
      [
        "Paused oracle, all roles: 0 of 0 recent assignments",
        "Paused oracle: Subscription paused",
        "Disable Paused oracle",
        "Edit Paused oracle",
      ],
      "usage, then the warning, On/Off and Edit",
    );
    node.props.onHoverIn();
    await settle(() => ui.text().includes("Subscription paused"));
    assert.match(
      ui.text(),
      /Subscription paused/,
      "the tooltip names the status",
    );
  } finally {
    unmount(ui);
  }
});

test("the opened editor autosaves pool fields and keeps Remove at the bottom with a confirmation", async () => {
  await load();
  const saved: unknown[] = [];
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
      (input) => saved.push(input),
    ),
  );
  try {
    selectSettingsTab(ui, "Profiles");
    await settle(() => ui.text().includes("Live model"));
    assert.equal(ui.query("Remove Live model"), undefined);
    ui.press("Edit Live model");
    await settle(
      () =>
        Boolean(ui.query("Weight help")) &&
        Boolean(ui.query("Remove Live model")),
    );
    assert.equal(ui.query("Save Live model"), undefined);
    assert.equal(ui.query("Cancel"), undefined);
    assert.doesNotMatch(
      ui.text(),
      /Changes save automatically|Profile notes|Usage policy:/,
    );
    ui.press("Weight: more assignments");
    await waitFor(
      () =>
        saved.some(
          (value) =>
            value && typeof value === "object" && (value as { weight?: string }).weight === "more",
        ),
      "weight to autosave",
    );
    const weightWrite = saved.find(
      (value) =>
        value &&
        typeof value === "object" &&
        (value as { weight?: string }).weight === "more",
    ) as { profileId: string; weight: string };
    assert.equal(weightWrite.profileId, "live");
    assert.equal("cost" in weightWrite, false, "a profile write carries no Cost");
    assert.equal(
      ui.query("Advanced"),
      undefined,
      "subscription and weight are directly visible",
    );
    assert.equal(ui.query("Increase weight for Live model"), undefined, "the numeric stepper is gone");
    assert.doesNotMatch(ui.text(), /Weight 2|Weight 1/);
    assert.match(
      ui.get("Weight help").props.accessibilityHint,
      /Recent assignments: 0; total assignments: 0/,
    );
    ui.press("Remove Live model");
    await settle(() => Boolean(ui.query("Confirm removing Live model")));
    assert.match(ui.text(), /Remove Live model\?/);
    ui.press("Keep Live model");
    await settle(() => !ui.query("Confirm removing Live model"));
    assert.ok(ui.get("Remove Live model"));
  } finally {
    unmount(ui);
  }
});

type Node = {
  type: string;
  props: Record<string, any>;
  children: Array<Node | string>;
};
const contains = (node: Node, label: string | RegExp): boolean =>
  node.children.some(
    (child) =>
      typeof child !== "string" &&
      ((typeof label === "string"
        ? child.props.accessibilityLabel === label
        : label.test(String(child.props.accessibilityLabel ?? ""))) ||
        contains(child, label)),
  );
/** The half-width column holding a control: a flex-1 View with a minWidth (0 beside its pair, 100% stacked). */
function columnOf(ui: ReturnType<typeof mount>, label: string | RegExp) {
  const column = (ui.ofType("View") as Node[])
    .filter(
      (node) =>
        node.props.style?.flex === 1 &&
        "minWidth" in (node.props.style ?? {}) &&
        contains(node, label),
    )
    .at(-1);
  assert.ok(column, `a column for ${label}`);
  return column;
}
async function openEditor(name = "Live model") {
  await load();
  const saved: unknown[] = [];
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", name)],
        pool: [{ ...entry("live"), weight: "more" as const }],
      }),
      (input) => saved.push(input),
    ),
  );
  selectSettingsTab(ui, "Profiles");
  await settle(() => ui.text().includes(name));
  ui.press(`Edit ${name}`);
  await settle(() => Boolean(ui.query("Weight help")));
  return { ui, saved };
}
const layoutEditor = (
  ui: ReturnType<typeof mount>,
  width: number,
  name = "Live model",
) =>
  ui
    .get(`${name} editor`)
    .props.onLayout({ nativeEvent: { layout: { width } } });

test("the editor pairs Provider | Model and Weight | Capability from its own width, stacking only on a phone", async () => {
  const { ui } = await openEditor();
  try {
    const pairs = [
      [/^Provider, /, /^Model, /],
      ["Weight value", "Capability value"],
    ] as const;
    const minWidths = () =>
      pairs.flat().map((label) => columnOf(ui, label).props.style.minWidth);
    // Paseo's settings column measures about 640: the screen is compact, the editor still pairs.
    setSettingsWidth(ui, 640);
    assert.ok(
      ui.query("Settings sections"),
      "the tab row shows at the Paseo settings width",
    );
    for (const width of [0, 610, 1280]) {
      layoutEditor(ui, width);
      assert.deepEqual(
        minWidths(),
        [0, 0, 0, 0],
        `paired at an editor width of ${width}`,
      );
    }
    layoutEditor(ui, 358);
    assert.deepEqual(
      minWidths(),
      Array(4).fill("100%"),
      "stacked at a phone width",
    );
  } finally {
    unmount(ui);
  }
});

/** The direct View children of a row, each a column. */
const columns = (node: Node) =>
  node.children.filter(
    (child): child is Node =>
      typeof child !== "string" && child.type === "View",
  );

test("Name shares the first row with Duplicate and Remove, with no caption above it", async () => {
  const { ui } = await openEditor();
  try {
    for (const width of [688, 390]) {
      layoutEditor(ui, width);
      const nameRow = ui.get("Profile name row") as Node;
      assert.equal(
        nameRow.props.style.flexWrap,
        "nowrap",
        `one row at ${width}`,
      );
      assert.ok(
        contains(nameRow, "Name") &&
          contains(nameRow, "Duplicate Live model") &&
          contains(nameRow, "Remove Live model"),
        `Name, Duplicate and Remove share the row at ${width}`,
      );
      const name = ui.get("Name");
      assert.equal(
        name.props.placeholder,
        "Name",
        "the placeholder carries the name",
      );
      assert.equal(
        ui.ofType("Text").some((node) => node.children.join("") === "Name"),
        false,
        "no separate Name caption",
      );
      const editor = ui.get("Live model editor") as Node;
      assert.equal(
        columns(editor)[0],
        nameRow,
        "the Name row is the editor's first row",
      );
    }
  } finally {
    unmount(ui);
  }
});

test("Subscription takes its own row, Weight shares the Capability row, and the old stepper and its space are gone; By request is gone", async () => {
  const { ui, saved } = await openEditor();
  try {
    layoutEditor(ui, 688);
    const dispatchRow = ui.get("Profile dispatch row") as Node;
    assert.ok(contains(dispatchRow, "Subscription"));
    assert.equal(contains(dispatchRow, "Weight help"), false, "Weight left the Subscription row");
    assert.equal(ui.query("Decrease weight for Live model"), undefined);
    assert.equal(ui.query("Weight for Live model"), undefined);
    assert.equal(
      ui.query("Selection by request"),
      undefined,
      "By request is retired (Tom, 2026-11-09)",
    );
    assert.doesNotMatch(ui.text(), /By request/);
    const weightColumn = columnOf(ui, "Weight value");
    assert.ok(
      contains(weightColumn, "Weight help") && contains(weightColumn, /^Weight slider, /),
      "Weight is the shared slider with its ?",
    );
    assert.deepEqual(
      [columnOf(ui, "Weight value").props.style.minWidth, columnOf(ui, "Capability value").props.style.minWidth],
      [0, 0],
      "Weight and Capability pair on one row in the former Cost position",
    );
    layoutEditor(ui, 358);
    assert.equal(
      columnOf(ui, "Weight value").props.style.minWidth,
      "100%",
      "on a phone each takes the whole row",
    );
    ui.press("Weight: most assignments");
    await waitFor(
      () => saved.some((value) => (value as { weight?: string })?.weight === "most"),
      "weight to autosave",
    );
    assert.equal(
      saved.some(
        (value) =>
          value &&
          typeof value === "object" &&
          ("byRequest" in (value as object) || "cost" in (value as object)),
      ),
      false,
      "no write carries a retired field",
    );
  } finally {
    unmount(ui);
  }
});
test("Weight and Capability are sliders with the chosen value beside the label, Default marked at the centre, and an unset capability marks no stop", async () => {
  const { ui, saved } = await openEditor();
  try {
    const weight = ui.get(/^Weight slider, /),
      capability = ui.get(/^Capability slider, /);
    assert.equal(weight.props.accessibilityRole, "adjustable");
    assert.equal(weight.props.accessibilityLabel, "Weight slider, More");
    assert.equal(weight.props.accessibilityValue.now, 3);
    assert.equal(weight.props.accessibilityValue.max, 4, "five stops");
    assert.equal(ui.query(/^Cost/), undefined, "Cost is retired");
    assert.deepEqual(
      ["fewest", "fewer", "default", "more", "most"].map((stop) =>
        ui.get(new RegExp(`^Weight: ${stop === "default" ? "default" : `${stop} assignments`}$`)).props.accessibilityState.selected,
      ),
      [false, false, false, true, false],
      "each stop has a plain-words accessible name",
    );
    assert.equal(
      capability.props.accessibilityLabel,
      "Capability slider, not set",
    );
    assert.equal(
      capability.props.accessibilityValue.now,
      undefined,
      "unset marks no stop",
    );
    assert.equal(
      ui.query("Weight help") !== undefined &&
        ui.query("Capability help") !== undefined,
      true,
      "a ? beside each name",
    );
    assert.equal(
      ui.get("Weight value").children.join(""),
      "More",
      "the chosen weight sits at the right of its label row",
    );
    assert.equal(ui.get("Capability value").children.join(""), "Unset");
    assert.doesNotMatch(ui.text(), /\b(80|90|100|110|120)%|\bx\d/, "no numbers in the primary control");
    assert.ok(
      ui.ofType("Text").some((node) => node.children.join("") === "Default"),
      "the centre stop's Default label is visible",
    );
    assert.doesNotMatch(
      ui.text(),
      /Very low|Very high|\bMedium\b|\bFewest\b|\bMost\b/,
      "no other stop labels under either slider",
    );
    weight.props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } });
    await waitFor(
      () => saved.some((value) => (value as { weight?: string })?.weight === "default"),
      "a keyboard-style decrement to autosave the centre stop",
    );
    capability.props.onAccessibilityAction({
      nativeEvent: { actionName: "increment" },
    });
    await waitFor(
      () =>
        saved.some(
          (value) =>
            (value as { capability?: string })?.capability === "worker",
        ),
      "an adjust from unset to start at Worker, as unset counts",
    );
    // Tom, 2026-11-19: four capability brackets, Mechanical to Frontier.
    assert.deepEqual(
      ["Mechanical", "Worker", "Heavyweight", "Frontier"].map((stop) =>
        Boolean(ui.query(`Capability ${stop}`)),
      ),
      [true, true, true, true],
    );
    for (const retired of ["low", "medium", "high", "very high", "very low"])
      assert.equal(
        ui.query(`Capability ${retired}`),
        undefined,
        `no ${retired} stop`,
      );
    assert.equal(capability.props.accessibilityValue.max, 3, "four stops");
    ui.press("Capability Frontier");
    await waitFor(
      () =>
        saved.some(
          (value) =>
            (value as { capability?: string })?.capability === "frontier",
        ),
      "the frontier stop to autosave",
    );
    await settle(
      () => ui.get("Capability value").children.join("") === "Frontier",
    );
    assert.equal(
      ui.get("Capability value").children.join(""),
      "Frontier",
      "the chosen value shows at the right of the label",
    );
    assert.match(
      ui.get("Capability help").props.accessibilityHint,
      /Frontier requires a request at Low, Normal and High\. Heavyweight does too at Low and Normal unless the task starts or climbs there/,
    );
    ui.press("Weight: fewest assignments");
    await waitFor(
      () =>
        saved.some(
          (value) => (value as { weight?: string })?.weight === "fewest",
        ),
      "a stop press to autosave",
    );
  } finally {
    unmount(ui);
  }
});

test("a long profile name keeps Duplicate and Remove on the Name row", async () => {
  const name =
    "A very long profile name that goes on well past the width of the settings column on any phone";
  const { ui } = await openEditor(name);
  try {
    layoutEditor(ui, 358, name);
    const nameRow = ui.get("Profile name row") as Node;
    assert.equal(
      nameRow.props.style.flexWrap,
      "nowrap",
      "Name and the actions share one non-wrapping row",
    );
    assert.ok(contains(nameRow, "Name") && contains(nameRow, `Remove ${name}`));
    assert.equal(ui.get("Name").props.value, name);
  } finally {
    unmount(ui);
  }
});

test("a stop slider is one continuous track with stops and labels placed at their own positions", async () => {
  const { ui } = await openEditor();
  try {
    const slider = ui.get(/^Weight slider, /) as Node;
    const nodes = slider.children.filter(
      (child): child is Node => typeof child !== "string",
    );
    const tracks = nodes.filter((node) => node.type === "View");
    assert.equal(
      tracks.length,
      2,
      "one base track and one fill, nothing between the stops",
    );
    assert.deepEqual(
      [tracks[0].props.style.left, tracks[0].props.style.right],
      [0, 0],
      "the base track spans first to last stop",
    );
    assert.equal(
      tracks[1].props.style.width,
      "75%",
      "the fill reaches the chosen stop (High, 3 of 4)",
    );
    const stops = nodes.filter(
      (node) => node.props.accessibilityRole === "button",
    );
    assert.deepEqual(
      stops.map((stop) => stop.props.style.left),
      ["0%", "25%", "50%", "75%", "100%"],
    );
    for (const stop of stops) {
      assert.equal(
        stop.props.style.position,
        "absolute",
        "targets overlay the track instead of splitting it",
      );
      assert.equal(stop.props.style.width, 44);
      assert.equal(
        stop.props.style.marginLeft,
        -22,
        "each target is centred on its stop",
      );
    }
    const ring = (label: string) =>
      (ui.get(label).children[0] as Node).props.style;
    assert.equal(
      ring("Weight: most assignments").borderWidth,
      1,
      "an unfilled stop keeps a thin ring",
    );
    assert.equal(ring("Weight: more assignments").width, 18, "the chosen stop is larger");
    assert.equal(ring("Weight: more assignments").borderWidth, 2);
  } finally {
    unmount(ui);
  }
});

test("every Settings section aligns with the tab row: no inner side padding at any width", async () => {
  await load();
  const ui = mount(
    screenTree(
      board({
        profiles: [profile("live", "Live model")],
        pool: [entry("live")],
      }),
    ),
  );
  try {
    for (const width of [390, 640, 1280]) {
      setSettingsWidth(ui, width);
      for (const section of [
        "Dispatch limits",
        "Profiles",
        "Projects",
        "Hosts",
        "Storage",
      ]) {
        selectSettingsTab(ui, section);
        await tick();
        let checked = 0;
        for (const node of [
          ...ui.ofType("ScrollView"),
          ...ui.ofType("View"),
        ] as Node[]) {
          const style = node.props.style ?? {};
          if (node.props.accessibilityLabel === "Settings sections") continue;
          if (style.flex === 1 && style.minHeight === 0) {
            checked++;
            assert.equal(
              style.marginHorizontal ?? 0,
              0,
              `${section} at ${width}: no side margin`,
            );
            assert.equal(
              style.paddingHorizontal ?? 0,
              0,
              `${section} at ${width}: no side padding`,
            );
          }
        }
        assert.ok(
          checked > 0,
          `${section} at ${width}: its content column was checked`,
        );
        assert.equal(
          ui.get("Nucleus settings").props.style.paddingHorizontal ?? 0,
          0,
        );
        assert.equal(
          ui.query("Store backups")?.props.style.paddingHorizontal ?? 0,
          0,
        );
      }
    }
  } finally {
    unmount(ui);
  }
});
