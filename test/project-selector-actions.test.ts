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
    repositories: repos,
    primary: repos[0],
    owner: null,
  }) as unknown as Project;
const consumer = project("consumer-b-v2", repo("consumer"));
const accelerator = project("project-a-accelerator", repo("project-a"));
const projects = [consumer, accelerator];
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The row actions, each recording its call. `overrides` replace one action. */
function rowActions(
  overrides: Record<string, (...args: unknown[]) => unknown> = {},
) {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve({});
    };
  const value: Record<string, (...args: unknown[]) => unknown> = {
    rename: record("rename"),
    remove: record("remove"),
    ...overrides,
  };
  return { calls, value };
}

/** Selector props: the picker's selection changes land in `changes`. */
function pickerProps(
  extra: Record<string, unknown> = {},
  list: Project[] = projects,
) {
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
  const upListeners = new Set<(event: { key?: string }) => void>();
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    addEventListener: (type: string, fn: (event: { key?: string }) => void) => {
      if (type === "keydown") listeners.push(fn);
      if (type === "keyup") upListeners.add(fn);
    },
    removeEventListener: (
      type: string,
      fn: (event: { key?: string }) => void,
    ) => {
      if (type === "keyup") upListeners.delete(fn);
    },
  };
  return {
    press: (key: string) => listeners.forEach((fn) => fn({ key })),
    release: (key: string) => [...upListeners].forEach((fn) => fn({ key })),
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
  assert.ok(
    ui.get("Project actions for consumer-b-v2"),
    "labelled with the name",
  );
  assert.equal(
    ui.get("Project actions for consumer-b-v2").props.accessibilityState
      .expanded,
    false,
  );

  // Opening the menu neither selects nor closes the picker.
  ui.press("Project actions for consumer-b-v2");
  assert.deepEqual(picker.changes, [], "no selection change");
  assert.ok(ui.get("Project selector"), "the picker stays open");
  assert.equal(
    ui.get("Project actions for consumer-b-v2").props.accessibilityState
      .expanded,
    true,
  );
  assert.equal(ui.query("Park consumer-b-v2"), undefined, "no Park: parking is retired");
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

test("1430 rendered: Rename validates the trimmed name, saves through the action and keeps the key", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  const save = () => ui.get("Save name for consumer-b-v2");
  assert.equal(
    ui.get("Name for consumer-b-v2").props.value,
    "consumer-b-v2",
    "starts at the stored name",
  );
  assert.equal(
    save().props.disabled,
    true,
    "an unchanged name cannot be saved",
  );

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
  assert.equal(
    ui.query("Name for consumer-b-v2"),
    undefined,
    "the editor closes on success",
  );
});

test("1430 rendered: Remove from Nucleus hands the project to the shared dialog and closes the picker without a save", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  assert.equal(ui.query("Archive consumer-b-v2"), undefined);
  ui.press("Remove consumer-b-v2 from Nucleus");
  assert.deepEqual(menu.calls, [["remove", consumer]]);
  assert.equal(
    ui.query("Project selector"),
    undefined,
    "the picker closes for the dialog",
  );
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
  assert.ok(ui.get("Rename consumer-b-v2"));
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
    assert.equal(
      ui.query("Name for consumer-b-v2"),
      undefined,
      "the rename is cancelled",
    );
    assert.ok(ui.get("Project selector"), "the picker stays open");
    doc.press("Escape");
    assert.equal(
      ui.query("Project selector"),
      undefined,
      "the next Escape closes the picker",
    );
  } finally {
    doc.restore();
  }
});

test("1430: projectNameProblem applies Settings' name rule", () => {
  assert.equal(projectNameProblem("  Board  "), undefined);
  assert.equal(projectNameProblem(" "), "Name is empty");
  assert.equal(projectNameProblem("x".repeat(200)), undefined);
  assert.equal(
    projectNameProblem("x".repeat(201)),
    "Name is over 200 characters",
  );
});

/** The disclosure chevron's icon: the Icon host node inside the chevron. */
const chevronIcon = (ui: ReturnType<typeof mount>, name: string) =>
  JSON.stringify(ui.get(`Project actions for ${name}`).children);

test("1432 rendered: the chevron shows collapsed and expanded, and one project's panel is open at a time", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  assert.match(chevronIcon(ui, "consumer-b-v2"), /ChevronDown/);
  ui.press("Project actions for consumer-b-v2");
  assert.match(chevronIcon(ui, "consumer-b-v2"), /ChevronUp/);
  assert.ok(
    ui.get("Actions for consumer-b-v2"),
    "the panel opens under its row",
  );

  ui.press("Project actions for project-a-accelerator");
  assert.equal(
    ui.query("Actions for consumer-b-v2"),
    undefined,
    "the first panel closes",
  );
  assert.ok(ui.get("Actions for project-a-accelerator"));
  assert.equal(
    ui.get("Project actions for consumer-b-v2").props.accessibilityState
      .expanded,
    false,
  );

  ui.press("Project actions for project-a-accelerator");
  assert.equal(
    ui.query("Actions for project-a-accelerator"),
    undefined,
    "the chevron collapses its own panel",
  );
  assert.deepEqual(
    picker.changes,
    [],
    "disclosure never changes the selection",
  );
});

test("1432 rendered: Rename replaces the row's name with a focused input, so one name shows while editing", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");

  const input = ui.get("Name for consumer-b-v2");
  assert.equal(input.props.value, "consumer-b-v2");
  assert.equal(input.props.autoFocus, true);
  assert.equal(
    ui.query(/^Project consumer-b-v2/),
    undefined,
    "the selectable label gives way to the input",
  );
  assert.doesNotMatch(ui.text(), /consumer-b-v2/, "no second copy of the name");
  assert.equal(
    ui.query("Actions for consumer-b-v2"),
    undefined,
    "the panel folds away while editing",
  );
  assert.equal(
    ui.get("Project actions for consumer-b-v2").props.disabled,
    true,
    "the chevron keeps its place",
  );

  // Cancel restores the label without a save.
  ui.type("Name for consumer-b-v2", "Draft");
  ui.press("Cancel rename of consumer-b-v2");
  assert.ok(ui.get(/^Project consumer-b-v2/));
  assert.equal(ui.query("Name for consumer-b-v2"), undefined);
  assert.deepEqual(menu.calls, []);
  assert.ok(ui.get("Project selector"), "the picker stays open");
});

test("1432 rendered: Enter saves without selecting the row or closing the picker; an unchanged Enter just closes the editor", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  ui.get("Name for consumer-b-v2").props.onSubmitEditing();
  assert.equal(
    ui.query("Name for consumer-b-v2"),
    undefined,
    "an unchanged name closes",
  );
  assert.deepEqual(menu.calls, []);

  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  ui.type("Name for consumer-b-v2", " ");
  ui.get("Name for consumer-b-v2").props.onSubmitEditing();
  assert.deepEqual(menu.calls, [], "an invalid name is not sent");
  assert.ok(ui.get("Name for consumer-b-v2"), "the editor stays for a fix");

  ui.type("Name for consumer-b-v2", "Consumer board ");
  ui.get("Name for consumer-b-v2").props.onSubmitEditing();
  assert.deepEqual(menu.calls, [["rename", consumer, "Consumer board"]]);
  await settle();
  assert.deepEqual(picker.changes, [], "the row was not activated");
  assert.ok(ui.get("Project selector"), "the picker stays open");
});

test("1432 rendered: a refused rename stays in the editor with the draft for a retry", async () => {
  let attempts = 0;
  const menu = rowActions({
    rename: () =>
      ++attempts === 1
        ? Promise.reject(new Error("Name already taken"))
        : Promise.resolve({}),
  });
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  ui.type("Name for consumer-b-v2", "Board");
  ui.press("Save name for consumer-b-v2");
  await settle();
  assert.match(ui.text(), /Name already taken/);
  assert.equal(
    ui.get("Name for consumer-b-v2").props.value,
    "Board",
    "the draft is kept",
  );
  ui.press("Save name for consumer-b-v2");
  await settle();
  assert.equal(attempts, 2);
  assert.equal(
    ui.query("Name for consumer-b-v2"),
    undefined,
    "the retry saves and closes",
  );
});

test("1432 rendered: a rename that re-sorts the row keeps its key, the selection and the open picker", async () => {
  const menu = rowActions();
  const picker = pickerProps({
    projectActions: menu.value,
    value: ["consumer-b-v2"],
  });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  ui.type("Name for consumer-b-v2", "zz board");
  ui.press("Save name for consumer-b-v2");
  await settle();
  // The refresh lands with the new name, which now sorts after the other project.
  const renamed = { ...consumer, name: "zz board" } as Project;
  ui.update(
    h(ProjectSelector, { ...picker.props, projects: [renamed, accelerator] }),
  );
  const order = ui
    .all(/^Project (zz board|project-a-accelerator),/)
    .map((node) => node.props.accessibilityLabel);
  assert.deepEqual(order, [
    "Project project-a-accelerator, 0 active, 0 in total",
    "Project zz board, 0 active, 0 in total",
  ]);
  assert.equal(
    ui.get(/^Project zz board/).props.accessibilityState.checked,
    true,
    "still selected by key",
  );
  assert.deepEqual(picker.changes, []);
  assert.ok(ui.get("Project selector"));
});

test("1432 rendered: in the compact picker, Escape or back cancels a rename before it closes the picker", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value, compact: true });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  const modal = () => ui.ofType("Modal")[0];
  modal().props.onRequestClose();
  assert.equal(
    ui.query("Name for consumer-b-v2"),
    undefined,
    "the rename is cancelled",
  );
  assert.ok(ui.get(/^Project consumer-b-v2/), "the label is back");
  assert.ok(modal(), "the picker stays open");
  modal().props.onRequestClose();
  assert.equal(
    ui.ofType("Modal").length,
    0,
    "the next press closes the picker",
  );
});

test("1432 rendered: Escape in the rename input cancels the edit and leaves the picker open", async () => {
  const menu = rowActions();
  const picker = pickerProps({ projectActions: menu.value });
  const { ProjectSelector } = await load();
  const ui = mount(h(ProjectSelector, picker.props));
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  ui.type("Name for consumer-b-v2", "Draft");
  ui.get("Name for consumer-b-v2").props.onKeyPress({
    nativeEvent: { key: "Escape" },
  });
  assert.equal(
    ui.query("Name for consumer-b-v2"),
    undefined,
    "the edit is cancelled",
  );
  assert.ok(ui.get(/^Project consumer-b-v2/), "the original label is back");
  assert.ok(ui.get("Project selector"), "the picker stays open");
  assert.deepEqual(menu.calls, []);
});

test("1432 rendered: the compact modal's Escape keyup after a cancelled rename does not close the picker", async () => {
  const doc = fakeDocument();
  try {
    const menu = rowActions();
    const picker = pickerProps({ projectActions: menu.value, compact: true });
    const { ProjectSelector } = await load();
    const ui = mount(h(ProjectSelector, picker.props));
    ui.press(/^Projects, /);
    ui.press("Project actions for consumer-b-v2");
    ui.press("Rename consumer-b-v2");
    ui.get("Name for consumer-b-v2").props.onKeyPress({
      nativeEvent: { key: "Escape" },
    });
    // The modal's own keyup handler runs before the release listener.
    ui.ofType("Modal")[0].props.onRequestClose();
    doc.release("Escape");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ui.ofType("Modal").length, 1, "the picker stays open");
    ui.ofType("Modal")[0].props.onRequestClose();
    assert.equal(ui.ofType("Modal").length, 0, "the next Escape closes it");
  } finally {
    doc.restore();
  }
});
