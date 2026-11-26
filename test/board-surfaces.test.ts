import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { mount, useNativeStubs, type HostNode } from "./support/render";

// nucleus#1540: the board reads like T3. Regions differ by surface step, cards and
// controls draw no border at rest, and hover and selection come from the design
// roles, never a literal. Real components, driven through their own handlers.
useNativeStubs();
const h = React.createElement;

const dark = {
  accent: "#1f6feb",
  accentForeground: "#ffffff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusSuccess: "#3fb950",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
} as const;
const light = {
  ...dark,
  surface0: "#ffffff",
  surface1: "#f6f8fa",
  surface2: "#e8eaee",
  border: "#d0d7de",
  foreground: "#1f2328",
  foregroundMuted: "#59636e",
} as const;
const c = dark as never;
const design = () => import("../client/design");
const controls = () => import("../client/controls");

type Ui = ReturnType<typeof mount>;
/** The state wash: the non-interactive overlay that fills a control's own bounds. */
const washes = (ui: Ui) =>
  ui
    .ofType("View")
    .filter(
      (node) =>
        node.props.pointerEvents === "none" &&
        node.props.style?.position === "absolute" &&
        node.props.style?.borderWidth === undefined,
    );
const washColor = (ui: Ui) => washes(ui)[0]?.props.style.backgroundColor;
/** The view that directly holds the node labelled `label`. */
const parentOf = (ui: Ui, label: string) => {
  const target = ui.get(label);
  return ui
    .ofType("View")
    .find((node) => node.children.includes(target)) as HostNode | undefined;
};

for (const [name, palette] of [
  ["dark", dark],
  ["light", light],
] as const) {
  test(`the ${name} roles derive hover, selected and hairline from the theme foreground`, async () => {
    const { roles, toneSurface, wash, hoverSurface, selectedSurface } =
      await design();
    const r = roles(palette as never);
    assert.equal(r.canvas, palette.surface0);
    assert.equal(r.section, palette.surface1);
    assert.equal(r.raised, palette.surface2);
    assert.equal(
      r.hover,
      toneSurface(palette.foreground, palette.surface2, wash.hover),
    );
    assert.equal(
      r.selected,
      toneSurface(palette.foreground, palette.surface2, wash.selected),
    );
    assert.equal(
      r.hairline,
      toneSurface(palette.foreground, palette.border, wash.hairline),
    );
    assert.ok(wash.hover < wash.selected, "hover reads dimmer than selected");
    assert.notEqual(r.hairline, r.border, "a hairline is quieter than a field edge");
    assert.equal(hoverSurface(palette as never), r.hover);
    assert.equal(selectedSurface(palette as never), r.selected);
  });
}

test("a secondary button rests borderless and lightens with the hover role", async () => {
  const { Button } = await controls();
  const { roles } = await design();
  const ui = mount(h(Button, { c, text: "Retry", onPress: () => {} }));
  const style = ui.get("Retry").props.style;
  assert.equal(style.borderWidth, undefined, "no border at rest");
  assert.equal(style.backgroundColor, roles(c).raised);
  assert.equal(washes(ui).length, 0, "no wash at rest");
  ui.get("Retry").props.onHoverIn();
  assert.equal(washColor(ui), roles(c).hover, "hover washes the fill");
  ui.get("Retry").props.onHoverOut();
  assert.equal(washes(ui).length, 0);
});

test("a pressable card rests borderless on the next surface step, hovers and selects with the roles", async () => {
  const { SurfacePress, PaneSurfaceContext, useCardFill } = await controls();
  const { roles } = await design();
  function Card({ selected }: { selected: boolean }) {
    const fill = useCardFill(c);
    return h(SurfacePress, {
      c,
      label: "Open lane",
      selected,
      onPress: () => {},
      style: { backgroundColor: fill },
      children: h("Text", null, "Lane"),
    });
  }
  const ui = mount(h(Card, { selected: false }));
  const card = () => ui.get("Open lane");
  assert.equal(card().props.style.borderWidth, undefined, "no card border");
  assert.equal(
    card().props.style.backgroundColor,
    roles(c).section,
    "a card on the canvas takes the section step",
  );
  card().props.onHoverIn();
  assert.equal(washColor(ui), roles(c).hover);
  card().props.onHoverOut();
  assert.equal(washes(ui).length, 0);
  ui.update(h(Card, { selected: true }));
  assert.equal(washColor(ui), roles(c).selected, "selection is the stronger wash");
  assert.equal(card().props.accessibilityState.selected, true);

  const onSection = mount(
    h(PaneSurfaceContext.Provider, {
      value: "section",
      children: h(Card, { selected: false }),
    }),
  );
  assert.equal(
    onSection.get("Open lane").props.style.backgroundColor,
    roles(c).raised,
    "a card on a section pane steps up to raised",
  );
});

test("a board card draws no border; hover and selection are role washes over its fill", async () => {
  const cards = await import("../client/board/cards");
  const { roles } = await design();
  const props = (selected: boolean) => ({
    label: "Task: a board card",
    onPress: () => {},
    selected,
    c,
    kind: "task" as const,
    meta: "T-1",
    title: "A board card",
    status: { tone: "accent" as const, state: "Working", detail: "editing" },
  });
  const ui = mount(h(cards.BoardCard as never, props(false)));
  const frame = () => parentOf(ui, "Task: a board card")!;
  assert.equal(frame().props.style.borderWidth, undefined, "no card border");
  assert.equal(frame().props.style.backgroundColor, roles(c).section);
  ui.get("Task: a board card").props.onHoverIn();
  assert.equal(washColor(ui), roles(c).hover);
  ui.get("Task: a board card").props.onHoverOut();
  ui.update(h(cards.BoardCard as never, props(true)));
  assert.equal(washColor(ui), roles(c).selected);
});

test("a toned badge reads by its tinted fill, with no outline", async () => {
  const { Badge } = await import("../client/board/badges");
  const { roles, toneSurface } = await design();
  const ui = mount(
    h(Badge, { label: "Dispatch held", tone: "warning", c, a11y: "Dispatch held" }),
  );
  const style = ui.get("Dispatch held").props.style;
  assert.equal(style.borderWidth, undefined);
  assert.equal(
    style.backgroundColor,
    toneSurface(dark.statusWarning, roles(c).raised),
  );
});

