import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { useNativeStubs, mount, type HostNode } from "./support/render";
import type { Colors } from "../client/design";

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
      design.selectedSurface(c as never),
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
        design.selectedSurface(c as never),
        "the open record keeps the selected surface",
      );
      open.pressable.props.onHoverIn();
      assert.equal(
        frameOf(open.ui, "Task: an inbox row").frame.props.style
          .backgroundColor,
        design.selectedSurface(c as never),
        "hover keeps the selected background",
      );
      open.pressable.props.onFocus();
      assert.equal(
        frameOf(open.ui, "Task: an inbox row").frame.props.style
          .backgroundColor,
        design.selectedSurface(c as never),
        "focus keeps the selected background",
      );
    } finally {
      open.ui.update(h("View", null));
    }
  });
}

test("menu text follows card-title color at rest, hover and selection without an indicator bar", async () => {
  await load();
  const counts = {
    needs: 2,
    planning: 1,
    leads: 0,
    papercuts: 0,
    queue: 1,
    working: 1,
    review: 0,
    closing: 0,
  };
  const renderMenu = (view: "needs" | "queue") =>
    mount(
      h(menu.InboxMenu, {
        c: dark,
        view,
        counts,
        loaded: true,
        onSelect: () => {},
      }),
    );
  const ui = renderMenu("queue");
  try {
    const entry = ui.get("Needs you, 2");
    const label = ui
      .ofType("Text")
      .find((node) => node.children.join("") === "Needs you");
    const count = ui
      .ofType("Text")
      .find((node) => node.children.join("") === "2");
    assert.ok(label);
    assert.ok(count);
    assert.equal(
      label.props.style.color,
      design.cardTitleColor(dark as never, false),
      "the resting menu label uses the card title tint",
    );
    assert.equal(
      count.props.style.color,
      design.cardTitleColor(dark as never, false),
      "the regular count uses the card title tint",
    );
    const icon = ui
      .ofType("Icon")
      .find((node) => node.props.name === "TriangleAlert");
    assert.equal(
      icon?.props.color,
      design.cardTitleColor(dark as never, false),
    );

    entry.props.onHoverIn();
    const hovered = ui.get("Needs you, 2");
    const hoveredLabel = ui
      .ofType("Text")
      .find((node) => node.children.join("") === "Needs you");
    assert.equal(
      hoveredLabel?.props.style.color,
      (dark as { foreground: string }).foreground,
    );
    assert.equal(
      hovered.props.style.backgroundColor,
      design.hoverSurface(dark as never),
    );
    hovered.props.onHoverOut();
    ui.get("Needs you, 2").props.onFocus();
    assert.equal(
      ui.ofType("Text").find((node) => node.children.join("") === "Needs you")
        ?.props.style.color,
      (dark as { foreground: string }).foreground,
      "keyboard focus uses full foreground",
    );
  } finally {
    ui.update(h("View", null));
  }

  const selected = renderMenu("needs");
  try {
    const entry = selected.get("Needs you, 2");
    assert.equal(entry.props.accessibilityState.selected, true);
    assert.equal(
      selected
        .ofType("Text")
        .find((node) => node.children.join("") === "Needs you")?.props.style
        .color,
      (dark as { foreground: string }).foreground,
      "the selected label is full foreground",
    );
    assert.equal(
      selected
        .ofType("View")
        .some((node) => node.props.style?.position === "absolute"),
      false,
      "selection has no indicator bar",
    );
  } finally {
    selected.update(h("View", null));
  }
});

for (const [name, c, titleColor] of [
  ["dark", dark, "rgba(240, 246, 252, 0.75)"],
  ["light", light, "rgba(31, 35, 40, 0.75)"],
] as const) {
  test(`a ${name} row uses the regular sidebar title above its muted labels`, async () => {
    await load();
    const ui = mount(
      h(cards.BoardCardVariantContext.Provider, {
        value: "row",
        children: h(cards.BoardCard as never, {
          ...rowProps(c, false),
          status: { tone: "muted", state: "Open", detail: "board" },
        }),
      }),
    );
    try {
      const texts = ui.ofType("Text");
      const meta = texts.find((node) => node.children.join("") === "T-1");
      assert.ok(meta, "line 1 names the reference");
      assert.equal(meta.props.style.fontWeight, "400");
      assert.equal(
        meta.props.style.color,
        (c as { foregroundMuted: string }).foregroundMuted,
        "the line 1 label reads muted, like the project",
      );
      const title = texts.find(
        (node) => node.children.join("") === "An inbox row",
      );
      assert.ok(title, "line 2 is the title");
      assert.equal(title.props.style.fontWeight, "400");
      assert.equal(
        title.props.style.color,
        titleColor,
        "the unselected title uses the sidebar title tint",
      );
      const state = texts.find((node) => node.children.join("") === "Open");
      assert.ok(state, "line 3 names the state");
      assert.equal(state.props.style.fontWeight, "400");
      assert.equal(
        state.props.style.color,
        (c as { foregroundMuted: string }).foregroundMuted,
        "a neutral state reads muted, not white",
      );
    } finally {
      ui.update(h("View", null));
    }
    // A toned state reads in its dot's tone, still at normal weight.
    const toned = mount(
      h(cards.BoardCardVariantContext.Provider, {
        value: "row",
        children: h(cards.BoardCard as never, rowProps(c, false)),
      }),
    );
    try {
      const state = toned
        .ofType("Text")
        .find((node) => node.children.join("") === "Working");
      assert.ok(state, "line 3 names the state");
      assert.equal(state.props.style.fontWeight, "400");
      assert.equal(
        state.props.style.color,
        design.roles(c as never).accent,
        "the state word carries its tone",
      );
    } finally {
      toned.update(h("View", null));
    }
  });
}

const counts = {
  needs: 1,
  planning: 2,
  leads: 0,
  papercuts: 2,
  queue: 0,
  working: 3,
  review: 0,
  closing: 0,
};

function mountMenu(c: Colors, view: "working" | "leads" = "working") {
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
      design.selectedSurface(dark as never),
    );
    working.props.onHoverIn();
    assert.equal(
      ui.query("Working, 3").props.style.backgroundColor,
      design.selectedSurface(dark as never),
      "hover keeps the selected entry",
    );
    working.props.onHoverOut();
    ui.query("Working, 3").props.onFocus();
    assert.equal(
      ui.query("Working, 3").props.style.backgroundColor,
      design.selectedSurface(dark as never),
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

test("the themed menu keeps a selected surface without a foreground bar", async () => {
  await load();
  const c = {
    accent: "#346bf1",
    accentForeground: "#ffffff",
    surface0: "#000000",
    surface1: "#111111",
    surface2: "#111111",
    surfaceNavigation: "#0f0f0f",
    border: "#191919",
    foreground: "#f5f5f5",
    foregroundMuted: "#818181",
    statusSuccess: "#2aa56d",
    statusWarning: "#fe9a00",
    statusDanger: "#fb414a",
  };
  const ui = mountMenu(c);
  try {
    const selectionMark = (label: string) =>
      ui
        .get(label)
        .children.some(
          (child) =>
            typeof child !== "string" &&
            child.props.pointerEvents === "none" &&
            child.props.style?.position === "absolute",
        );
    assert.equal(selectionMark("Working, 3"), false);
    const papercuts = ui.get("Papercuts, 2");
    papercuts.props.onHoverIn();
    assert.equal(selectionMark("Papercuts, 2"), false);
    assert.equal(selectionMark("Working, 3"), false);
  } finally {
    ui.update(h("View", null));
  }
});

test("themed zero-count entries quiet only their resting text", async () => {
  await load();
  const c = {
    accent: "#346bf1",
    accentForeground: "#ffffff",
    surface0: "#000000",
    surface1: "#111111",
    surface2: "#111111",
    surfaceNavigation: "#0f0f0f",
    border: "#191919",
    foreground: "#f5f5f5",
    foregroundMuted: "#818181",
    statusSuccess: "#2aa56d",
    statusWarning: "#fe9a00",
    statusDanger: "#fb414a",
  };
  const ui = mountMenu(c);
  try {
    const entry = ui.get("Leads, 0");
    const label = () =>
      ui.ofType("Text").find((node) => node.children.join("") === "Leads");
    const count = () =>
      ui.ofType("Text").find((node) => node.children.join("") === "0");
    const icon = () =>
      ui.ofType("Icon").find((node) => node.props.name === "Lightbulb");
    const restingTint = design.toneSurface(
      c.foreground,
      c.foreground,
      design.navigationTextOpacity.dimmed,
    );
    assert.equal(entry.props.style.opacity, 1);
    assert.equal(label()?.props.style.color, restingTint);
    assert.equal(count()?.props.style.color, restingTint);
    assert.equal(icon()?.props.color, restingTint);

    entry.props.onHoverIn();
    const hovered = ui.get("Leads, 0");
    assert.equal(hovered.props.style.opacity, 1);
    assert.equal(label()?.props.style.color, c.foreground);
    assert.equal(count()?.props.style.color, c.foreground);
    assert.equal(icon()?.props.color, c.foreground);
  } finally {
    ui.update(h("View", null));
  }
});

test("1546 the Planning entry counts the open lanes, dimmed at zero like the rest", async () => {
  await load();
  const ui = mountMenu(dark);
  try {
    // The accessible label names the unit, so the count reads as open lanes.
    const planning = ui.query("Planning, 2 open lanes");
    assert.equal(
      planning.props.style.opacity,
      1,
      "a non-zero Planning count never dims",
    );
    // Planning is not highlighted: its count reads in the same muted text as
    // the other unhighlighted entries.
    const countTextOf = (label: string) => {
      const entry = ui.query(label);
      const wanted = label.match(/, (\d+)/)?.[1];
      const count = (entry.children as unknown[]).find(
        (child) =>
          typeof child !== "string" &&
          (child as { type: string }).type === "Text" &&
          ((child as { children: unknown[] }).children ?? []).join("") ===
            wanted,
      ) as { props: { style: unknown } };
      assert.ok(count, `${label} draws its count as text`);
      return count.props.style;
    };
    assert.deepEqual(
      countTextOf("Planning, 2 open lanes"),
      countTextOf("Papercuts, 2"),
      "Planning counts in the same style as the other entries",
    );
    planning.props.onHoverIn();
    assert.equal(
      ui.query("Planning, 2 open lanes").props.style.backgroundColor,
      design.hoverSurface(dark as never),
      "hover dims the Planning entry like a list row",
    );
  } finally {
    ui.update(h("View", null));
  }
  // At zero the Planning entry dims but stays selectable, like every entry.
  const zero = mount(
    h(menu.InboxMenu as never, {
      c: dark,
      view: "working",
      counts: { ...counts, planning: 0 },
      loaded: true,
      onSelect: () => {},
    }),
  );
  try {
    assert.ok(
      zero.query("Planning, 0 open lanes"),
      "the zero count still names its unit",
    );
    assert.equal(
      zero.query("Planning, 0 open lanes").props.style.opacity,
      0.55,
      "a zero Planning count dims",
    );
  } finally {
    zero.update(h("View", null));
  }
});
