import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { useNativeStubs, mount, type HostNode } from "./support/render";

// nucleus#1528: inbox rows read like a sidebar list — no dividers, a dimmed
// hover/focus background, the selected surface when open — and the menu hovers
// the same way. Real rows and menu entries, driven through the components.
useNativeStubs();
type BoardCards = typeof import("../client/board/cards");
type BoardMenu = typeof import("../client/board/inbox-menu");
type Design = typeof import("../client/design");
let cards: BoardCards, menu: BoardMenu, design: Design;
const load = async () => {
  cards = await import("../client/board/cards");
  menu = await import("../client/board/inbox-menu");
  design = await import("../client/design");
  return { cards, menu, design };
};

const h = React.createElement;
/** Dark-theme palette: every themed style resolves to one of these tokens. */
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
} as never;
/** A light palette: the same roles, so hover and selection read in both themes. */
const light = {
  accent: "#0969da",
  accentForeground: "#ffffff",
  surface0: "#ffffff",
  surface1: "#f6f8fa",
  surface2: "#e8eaee",
  border: "#d0d7de",
  foreground: "#1f2328",
  foregroundMuted: "#59636e",
  statusWarning: "#9a6700",
  statusDanger: "#d1242f",
} as never;

const rowProps = (c: never, selected: boolean) => ({
  label: "Task: an inbox row",
  onPress: () => {},
  selected,
  c,
  kind: "task" as const,
  meta: "T-1",
  title: "An inbox row",
  status: { tone: "accent" as const, state: "Working", detail: "editing" },
});

/** Mounts a real row-variant card and returns its outer frame around the press target. */
function mountRow(c: never, selected: boolean) {
  const ui = mount(
    h(cards.BoardCardVariantContext.Provider, {
      value: "row",
      children: h(cards.BoardCard as never, rowProps(c, selected)),
    }),
  );
  const pressable = ui.query("Task: an inbox row");
  const frame = ui
    .ofType("View")
    .find((node) => node.children.includes(pressable));
  assert.ok(frame, "the row draws a frame around its press target");
  return { ui, pressable, frame: frame as HostNode };
}

const frameOf = (ui: ReturnType<typeof mount>, label: string | RegExp) => {
  const pressable = ui.query(label);
  const frame = ui
    .ofType("View")
    .find((node) => node.children.includes(pressable));
  assert.ok(frame, "the row draws a frame around its press target");
  return { pressable, frame: frame as HostNode };
};

for (const [name, c] of [
  ["dark", dark],
  ["light", light],
] as const) {
  test(`a ${name} row rests without dividers or borders, hovers dimmed and selects solid`, async () => {
    await load();
    const expectedHover = design.hoverSurface(c as never);
    assert.notEqual(
      expectedHover,
      (c as { surface2: string }).surface2,
      "hover reads dimmer than the selected surface",
    );
    const { ui, frame } = mountRow(c, false);
    try {
      const style = frame.props.style as Record<string, unknown>;
      assert.equal(style.borderBottomWidth, undefined, "no divider below");
      assert.equal(style.borderTopWidth, undefined, "no divider above");
      assert.equal(style.borderLeftWidth, undefined, "no accent edge");
      assert.equal(style.borderWidth, undefined, "no card border");
      assert.equal(style.backgroundColor, "transparent", "no fill at rest");
      assert.equal(
        style.borderRadius,
        design.radius.control,
        "rounded highlight corners",
      );
      assert.equal(
        style.marginHorizontal,
        design.space.xs,
        "the highlight insets from the list edges",
      );

      // Pointer hover dims the row; leaving clears it.
      ui.query("Task: an inbox row").props.onHoverIn();
      assert.equal(
        frameOf(ui, "Task: an inbox row").frame.props.style.backgroundColor,
        expectedHover,
        "hover shows the dimmed surface",
      );
      ui.query("Task: an inbox row").props.onHoverOut();
      assert.equal(
        frameOf(ui, "Task: an inbox row").frame.props.style.backgroundColor,
        "transparent",
        "leaving the row clears the hover",
      );

      // Keyboard focus dims the row the same way; blur clears it.
      ui.query("Task: an inbox row").props.onFocus();
      assert.equal(
        frameOf(ui, "Task: an inbox row").frame.props.style.backgroundColor,
        expectedHover,
        "keyboard focus shows the dimmed surface",
      );
      ui.query("Task: an inbox row").props.onBlur();
      assert.equal(
        frameOf(ui, "Task: an inbox row").frame.props.style.backgroundColor,
        "transparent",
        "blur clears the focus dim",
      );
    } finally {
      ui.update(h("View", null));
    }

    // Selected: the menu's selected surface, kept over hover.
    const open = mountRow(c, true);
    try {
      assert.equal(
        open.frame.props.style.backgroundColor,
        (c as { surface2: string }).surface2,
        "the open record keeps the selected surface",
      );
      open.pressable.props.onHoverIn();
      assert.equal(
        frameOf(open.ui, "Task: an inbox row").frame.props.style
          .backgroundColor,
        (c as { surface2: string }).surface2,
        "hover keeps the selected background",
      );
      open.pressable.props.onFocus();
      assert.equal(
        frameOf(open.ui, "Task: an inbox row").frame.props.style
          .backgroundColor,
        (c as { surface2: string }).surface2,
        "focus keeps the selected background",
      );
    } finally {
      open.ui.update(h("View", null));
    }
  });
}

test("the queue expander row rests without dividers too", async () => {
  await load();
  const ui = mount(
    h(cards.BoardCardVariantContext.Provider, {
      value: "row",
      children: h(cards.BoardCard as never, {
        label: "2 more queued in app",
        onPress: () => {},
        selected: false,
        c: dark,
        title: "…and 2 more in app",
      }),
    }),
  );
  try {
    const { frame } = frameOf(ui, "2 more queued in app");
    const style = frame.props.style as Record<string, unknown>;
    assert.equal(style.borderBottomWidth, undefined);
    assert.equal(style.borderLeftWidth, undefined);
    assert.equal(style.backgroundColor, "transparent");
  } finally {
    ui.update(h("View", null));
  }
});

const counts = {
  needs: 1,
  leads: 0,
  papercuts: 2,
  queue: 0,
  working: 3,
  review: 0,
  closing: 0,
};

function mountMenu(c: never, view: "working" | "leads" = "working") {
  return mount(
    h(menu.InboxMenu as never, {
      c,
      view,
      counts,
      loaded: true,
      onSelect: () => {},
    }),
  );
}

test("menu entries hover and focus dimmed; the selected entry keeps its surface", async () => {
  await load();
  const expectedHover = design.hoverSurface(dark as never);
  const ui = mountMenu(dark);
  try {
    // Working is selected: the selected surface, kept over hover and focus.
    const working = ui.query("Working, 3");
    const workingFrame = working;
    assert.equal(
      workingFrame.props.style.backgroundColor,
      (dark as { surface2: string }).surface2,
    );
    working.props.onHoverIn();
    assert.equal(
      ui.query("Working, 3").props.style.backgroundColor,
      (dark as { surface2: string }).surface2,
      "hover keeps the selected entry",
    );
    working.props.onHoverOut();
    ui.query("Working, 3").props.onFocus();
    assert.equal(
      ui.query("Working, 3").props.style.backgroundColor,
      (dark as { surface2: string }).surface2,
      "focus keeps the selected entry",
    );
    ui.query("Working, 3").props.onBlur();

    // Papercuts hovers and focuses dimmed, then clears.
    ui.query("Papercuts, 2").props.onHoverIn();
    assert.equal(
      ui.query("Papercuts, 2").props.style.backgroundColor,
      expectedHover,
      "hover dims the entry",
    );
    ui.query("Papercuts, 2").props.onHoverOut();
    assert.equal(
      ui.query("Papercuts, 2").props.style.backgroundColor,
      "transparent",
      "leaving clears the entry hover",
    );
    ui.query("Papercuts, 2").props.onFocus();
    assert.equal(
      ui.query("Papercuts, 2").props.style.backgroundColor,
      expectedHover,
      "keyboard focus dims the entry",
    );
    ui.query("Papercuts, 2").props.onBlur();
    assert.equal(
      ui.query("Papercuts, 2").props.style.backgroundColor,
      "transparent",
      "blur clears the entry focus",
    );

    // A dimmed zero-count entry still shows the hover.
    const leads = ui.query("Leads, 0");
    assert.equal(leads.props.style.opacity, 0.55, "zero counts stay dimmed");
    leads.props.onHoverIn();
    const hovered = ui.query("Leads, 0");
    assert.equal(
      hovered.props.style.backgroundColor,
      expectedHover,
      "a dimmed entry still hovers",
    );
    assert.equal(
      hovered.props.style.opacity,
      0.55,
      "hover keeps the dimmed quiet",
    );
  } finally {
    ui.update(h("View", null));
  }
});
