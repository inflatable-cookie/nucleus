import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import type {
  WorkStorageInput,
  WorkStorageState,
} from "../shared/schema/work-storage";

useNativeStubs();
const h = React.createElement;
// The dark theme roles the Settings screen paints with (Settings is dark-only for now).
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
  statusSuccess: "#3fb950",
} as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const ROOT = "/workspace/volume";
const DEFAULTS = {
  worktreesRoot: `${ROOT}/worktrees/nucleus`,
  backupRoot: `${ROOT}/archives/nucleus-backups`,
  projectQaRoot: `${ROOT}/archives/nucleus-project-qa`,
  scratchRoot: `${ROOT}/scratch/nucleus`,
  custodianRoot: `${ROOT}/scratch/nucleus/barge-custodians`,
};
const RETIRED = {
  worktreesRoot: `${ROOT}/queue/workspaces`,
  backupRoot: `${ROOT}/queue/backups`,
  projectQaRoot: `${ROOT}/queue/project-qa`,
};
const state = (
  overrides: Partial<WorkStorageState["overrides"]> = {},
): WorkStorageState => ({
  workRoot: ROOT,
  ...DEFAULTS,
  defaults: DEFAULTS,
  overrides: {
    workRoot: null,
    worktreesRoot: null,
    backupRoot: null,
    projectQaRoot: null,
    scratchRoot: null,
    custodianRoot: null,
    ...overrides,
  },
  retired: RETIRED,
  retainedRoots: [RETIRED.worktreesRoot],
  appliesOnRestart: true,
});

async function panel(props: Record<string, unknown>) {
  const { StoragePanel } = await import("../client/storage-settings");
  const base = {
    c: dark,
    state: state(),
    loading: false,
    loadError: null,
    inset: 16,
    save: async (input: WorkStorageInput) => state({ ...input }),
  };
  const ui = mount(h(StoragePanel as never, { ...base, ...props }));
  return ui;
}
const textOf = (node: { children: Array<unknown> } | string): string =>
  typeof node === "string"
    ? node
    : node.children.map((child) => textOf(child as never)).join("");

test("Storage is its own page with one noun per path, its portable default, and the restart note", async () => {
  const ui = await panel({});
  assert.match(ui.text(), /Storage/);
  assert.match(textOf(ui.get("Storage")), /Storage/);
  assert.match(
    ui.text(),
    /Changes apply when the Nucleus service next starts\./,
  );
  // The work root and each class are single controls, named by their noun, and
  // each shows the value `settings.json` holds (nothing yet), not the resolved path.
  assert.equal(ui.get("Work root").props.value, "");
  assert.equal(ui.get("Work root").props.placeholder, ROOT);
  assert.match(ui.text(), new RegExp(`in force now: ${ROOT}`));
  for (const [noun, path] of [
    ["Task worktrees", DEFAULTS.worktreesRoot],
    ["Database backups", DEFAULTS.backupRoot],
    ["Run scratch", DEFAULTS.scratchRoot],
    ["Custodian records", DEFAULTS.custodianRoot],
  ] as const) {
    const field = ui.get(noun);
    assert.equal(field.props.value, "", `${noun} has no override yet`);
    assert.equal(
      field.props.placeholder,
      path,
      `${noun} shows its portable default`,
    );
    assert.match(
      ui.text(),
      new RegExp(`Default: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  }
  // The retired locations the service still reads are named on the page.
  assert.match(textOf(ui.get("Retired locations")), /queue\/backups/);
  ui.update(h("View"));
});

test("saving sends the edited paths, leaves an untouched work root alone, and says when it applies", async () => {
  const calls: WorkStorageInput[] = [];
  const ui = await panel({
    save: async (input: WorkStorageInput) => {
      calls.push(input);
      return state({ backupRoot: input.backupRoot ?? null });
    },
  });
  ui.type("Database backups", `${ROOT}/custom/snapshots`);
  await tick();
  ui.press("Save paths");
  for (let i = 0; i < 10 && !calls.length; i++) await tick();
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.workRoot,
    undefined,
    "an untouched work root is not written, so a portable install stays portable",
  );
  assert.equal(calls[0]!.backupRoot, `${ROOT}/custom/snapshots`);
  assert.equal(
    calls[0]!.projectQaRoot,
    undefined,
    "an untouched class is not written at all",
  );
  for (let i = 0; i < 10 && !ui.query("Save paths")?.props.disabled; i++)
    await tick();
  assert.match(ui.text(), /Saved\. Applies on the next service start\./);
  ui.update(h("View"));
});

test("an environment-sourced path reads as in force and is never written by a save", async () => {
  const calls: WorkStorageInput[] = [];
  // The stored settings hold no scratch path; an environment override puts one in force.
  const envState = state();
  const ui = await panel({
    state: {
      ...envState,
      scratchRoot: `${ROOT}/env/runs`,
      overrides: { ...envState.overrides, scratchRoot: null },
    },
    save: async (input: WorkStorageInput) => {
      calls.push(input);
      return state({ backupRoot: input.backupRoot ?? null });
    },
  });
  assert.equal(
    ui.get("Run scratch").props.value,
    "",
    "the field holds the stored value, not the variable's",
  );
  assert.equal(ui.get("Run scratch").props.placeholder, `${ROOT}/env/runs`);
  assert.match(ui.text(), /environment override in force: .*env\/runs/);
  ui.type("Database backups", `${ROOT}/custom/snapshots`);
  await tick();
  ui.press("Save paths");
  for (let i = 0; i < 10 && !calls.length; i++) await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.backupRoot, `${ROOT}/custom/snapshots`);
  assert.equal(
    Object.hasOwn(calls[0]!, "scratchRoot"),
    false,
    "the environment value never becomes a saved path",
  );
  assert.equal(
    Object.hasOwn(calls[0]!, "worktreesRoot"),
    false,
    "untouched classes are not written",
  );
  ui.update(h("View"));
});

test("a refused path is explained on the page and marks the control that was refused", async () => {
  const ui = await panel({
    save: async () => {
      throw new Error("backupRoot must be inside workRoot (/workspace/volume)");
    },
  });
  ui.type("Database backups", "/elsewhere/snapshots");
  await tick();
  ui.press("Save paths");
  const alerts = () =>
    ui
      .ofType("Text")
      .filter((node) => node.props.accessibilityRole === "alert");
  for (let i = 0; i < 10 && !alerts().length; i++) await tick();
  assert.equal(alerts().length, 1);
  assert.match(textOf(alerts()[0]!), /backupRoot must be inside workRoot/);
  assert.notEqual(
    ui.get("Database backups").props.style.borderColor,
    ui.get("Run scratch").props.style.borderColor,
    "the refused control carries the danger border",
  );
  assert.doesNotMatch(
    ui.text(),
    /Saved\./,
    "a refused save never reads as saved",
  );
  ui.update(h("View"));
});

test("Reset paths restores every class default and keeps the work root", async () => {
  const calls: WorkStorageInput[] = [];
  const ui = await panel({
    state: state({
      backupRoot: `${ROOT}/custom/snapshots`,
      scratchRoot: `${ROOT}/custom/runs`,
    }),
    save: async (input: WorkStorageInput) => {
      calls.push(input);
      return state();
    },
  });
  assert.equal(
    ui.get("Database backups").props.value,
    `${ROOT}/custom/snapshots`,
  );
  ui.press("Reset paths");
  for (let i = 0; i < 10 && !calls.length; i++) await tick();
  assert.deepEqual(calls[0], {
    worktreesRoot: null,
    backupRoot: null,
    scratchRoot: null,
    custodianRoot: null,
  });
  ui.update(h("View"));
});
