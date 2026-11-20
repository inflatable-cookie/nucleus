import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import { projectNameProblem } from "../shared/project-scope";
import type { Project } from "../shared/contracts";

useNativeStubs();
const load = () => import("../client/project-scope-controls");
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (key: string, ...repos: ReturnType<typeof repo>[]) =>
  ({
    key,
    name: key,
    version: 4,
    visibility: "active",
    repositories: repos,
    primary: repos[0],
    owner: null,
  }) as unknown as Project;
const consumer = project("consumer-b-v2", repo("consumer"));
const accelerator = project("project-a-accelerator", repo("project-a"));
const parked = { ...project("other", repo("other")), visibility: "parked" } as Project;
const projects = [consumer, accelerator];
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The row actions, each recording its call. `overrides` replace one action. */
function rowActions(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve({});
    };
  const value: Record<string, (...args: unknown[]) => unknown> = {
    park: record("park"),
    unpark: record("unpark"),
    rename: record("rename"),
    remove: record("remove"),
    ...overrides,
  };
  return { calls, value };
}

/** Selector props: the picker's selection changes land in `changes`. */
function pickerProps(extra: Record<string, unknown> = {}, list: Project[] = projects) {
  const changes: string[][] = [];
  return {
    changes,
    props: {
      projects: list,
      tasks: [],
      leads: [],
      value: [],
      onChange: (keys: string[]) => changes.push(keys),
      onOpenChange: () => {},
      compact: false,
      c,
      ...extra,
    },
  };
}

/** A stand-in for the document the picker listens on for Escape; `restore` puts the real one back. */
function fakeDocument() {
  const listeners: Array<(event: { key?: string }) => void> = [];
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    addEventListener: (type: string, fn: (event: { key?: string }) => void) => {
      if (type === "keydown") listeners.push(fn);
    },
    removeEventListener: () => {},
  };
  return {
    press: (key: string) => listeners.forEach((fn) => fn({ key })),
    restore: () => {
      globals.document = previous;
    },
  };
}

test("1430 rendered: the row ellipsis is labelled with the project and leaves the row's selection alone", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  assert.ok(ui.get("Project actions for consumer-b-v2"), "labelled with the name");
  assert.equal(
    ui.get("Project actions for consumer-b-v2").props.accessibilityState.expanded,
    false,
  );

  // Opening the menu neither selects nor closes the picker.
  ui.press("Project actions for consumer-b-v2");
  assert.deepEqual(picker.changes, [], "no selection change");
  assert.ok(ui.get("Project selector"), "the picker stays open");
  assert.equal(
    ui.get("Project actions for consumer-b-v2").props.accessibilityState.expanded,
    true,
  );
  assert.ok(ui.get("Park consumer-b-v2"));
  assert.ok(ui.get("Rename consumer-b-v2"));
  assert.ok(ui.get("Remove consumer-b-v2 from Nucleus"));

  // The row's own press still selects and closes, as before.
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(picker.changes, [["consumer-b-v2"]]);
  assert.equal(ui.query("Project selector"), undefined);
});

test("1430 rendered: no ellipsis without project actions, so hosts without them keep their rows", async () => {
  const picker = pickerProps();
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  assert.equal(ui.query("Project actions for consumer-b-v2"), undefined);
  assert.ok(ui.get(/^Project consumer-b-v2/));
});

test("1430 rendered: the ellipsis reveals on hover or focus with a hover pointer, and stays visible on touch and compact", async () => {
  const globals = globalThis as { matchMedia?: unknown };
  const before = globals.matchMedia;
  const menu = rowActions();
  const { ProjectSelector } = await load();
  const base = pickerProps({ projectActions: menu.value }).props;
  const opacity = (ui: ReturnType<typeof mount>) =>
    ui.get("Project actions for consumer-b-v2").props.style.opacity;
  try {
    globals.matchMedia = () => ({ matches: true });
    const ui = mount(h(ProjectSelector, base));
    ui.press(/^Projects, /);
    assert.equal(opacity(ui), 0, "hidden on a hover pointer until hover");
    ui.get(/^Project consumer-b-v2/).props.onHoverIn();
    assert.equal(opacity(ui), 1, "hover reveals");
    ui.get(/^Project consumer-b-v2/).props.onHoverOut();
    assert.equal(opacity(ui), 0);
    ui.get("Project actions for consumer-b-v2").props.onFocus();
    assert.equal(opacity(ui), 1, "keyboard focus reveals");
    ui.get("Project actions for consumer-b-v2").props.onBlur();
    assert.equal(opacity(ui), 0);
    ui.press("Project actions for consumer-b-v2");
    assert.equal(opacity(ui), 1, "an open menu keeps it visible");
  } finally {
    globals.matchMedia = before;
  }

  // No hover pointer (touch or a native host): visible without hover.
  const touch = mount(h(ProjectSelector, base));
  touch.press(/^Projects, /);
  assert.equal(opacity(touch), 1);
  // The compact picker is a touch surface too.
  const compact = mount(h(ProjectSelector, { ...base, compact: true }));
  compact.press(/^Projects, /);
  assert.equal(opacity(compact), 1);
});

test("1430 rendered: Park asks first, saves through the action on confirm, and the menu closes", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Park consumer-b-v2");
  assert.match(ui.text(), /Park consumer-b-v2\? No new work starts\./);
  assert.equal(menu.calls.length, 0, "nothing saved before confirming");
  ui.press("Keep project consumer-b-v2");
  assert.equal(ui.query("Park project consumer-b-v2"), undefined, "Keep backs out");
  ui.press("Park consumer-b-v2");
  ui.press("Park project consumer-b-v2");
  assert.deepEqual(menu.calls, [["park", consumer]]);
  await settle();
  assert.equal(
    ui.query("Project actions for consumer-b-v2")?.props.accessibilityState.expanded,
    false,
    "the menu closes on success",
  );
  assert.ok(ui.get("Project selector"), "the picker stays open");
});

test("1430 rendered: Unpark is a direct action for a parked project, and a refusal stays on the row", async () => {
  const menu = rowActions({
    unpark: () => Promise.reject(new Error("Project changed since it was read")),
  });
  const picker = pickerProps({ projectActions: menu.value }, [parked, ...projects]);
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for other");
  assert.equal(ui.query("Park other"), undefined, "no Park for a parked project");
  ui.press("Unpark other");
  await settle();
  assert.match(ui.text(), /Project changed since it was read/);
  assert.ok(ui.get("Project actions for other"), "the menu stays open for a retry");
});

test("1430 rendered: Rename validates the trimmed name, saves through the action and keeps the key", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  const save = () => ui.get("Save name for consumer-b-v2");
  assert.equal(ui.get("Name for consumer-b-v2").props.value, "consumer-b-v2", "starts at the stored name");
  assert.equal(save().props.disabled, true, "an unchanged name cannot be saved");

  ui.type("Name for consumer-b-v2", "   ");
  assert.match(ui.text(), /Name is empty/);
  assert.equal(save().props.disabled, true);

  ui.type("Name for consumer-b-v2", "x".repeat(201));
  assert.match(ui.text(), /Name is over 200 characters/);
  assert.equal(save().props.disabled, true);

  ui.type("Name for consumer-b-v2", "  Consumer board  ");
  assert.equal(save().props.disabled, false);
  ui.press("Save name for consumer-b-v2");
  assert.deepEqual(menu.calls, [["rename", consumer, "Consumer board"]]);
  await settle();
  assert.equal(ui.query("Name for consumer-b-v2"), undefined, "the editor closes on success");
});

test("1430 rendered: Remove from Nucleus hands the project to the shared dialog and closes the picker without a save", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Remove consumer-b-v2 from Nucleus");
  assert.deepEqual(menu.calls, [["remove", consumer]]);
  assert.equal(ui.query("Project selector"), undefined, "the picker closes for the dialog");
  assert.deepEqual(picker.changes, [], "no selection change");
});

test("1430 rendered: Remove is absent when the host has no removal dialog", async () => {
  const menu = rowActions();
  const { remove: _remove, ...withoutRemove } = menu.value;
  const picker = pickerProps({ projectActions: withoutRemove });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  assert.equal(ui.query("Remove consumer-b-v2 from Nucleus"), undefined);
  assert.ok(ui.get("Park consumer-b-v2"));
});

test("1430 rendered: Escape closes an open row action first, and the picker on the next press", async () => {
  const doc = fakeDocument();
  try {
    const menu = rowActions();
    const picker = pickerProps({ projectActions: menu.value });
    const { ProjectSelector } = await load();
    const ui = mount(h(ProjectSelector, picker.props));
    ui.press(/^Projects, /);
    ui.press("Project actions for consumer-b-v2");
    ui.press("Rename consumer-b-v2");
    doc.press("Escape");
    assert.equal(ui.query("Name for consumer-b-v2"), undefined, "the rename is cancelled");
    assert.ok(ui.get("Project selector"), "the picker stays open");
    doc.press("Escape");
    assert.equal(ui.query("Project selector"), undefined, "the next Escape closes the picker");
  } finally {
    doc.restore();
  }
});

test("1430: projectNameProblem applies Settings' name rule", () => {
  assert.equal(projectNameProblem("  Board  "), undefined);
  assert.equal(projectNameProblem(" "), "Name is empty");
  assert.equal(projectNameProblem("x".repeat(200)), undefined);
  assert.equal(projectNameProblem("x".repeat(201)), "Name is over 200 characters");
});
