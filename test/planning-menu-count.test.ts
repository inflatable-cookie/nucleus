import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { planningFixture } from "./support/planning-fixture";

useNativeStubs();
const h = React.createElement;
/** Dark-theme palette standing in for the operator's Paseo theme. */
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
} as const;
const c = dark as never;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * nucleus#1546: the Planning menu entry counts the open lanes in scope through
 * the real board read — real stored lanes and projects, read back through
 * `queue.ui-snapshot` like the operator's board. Wide, medium and the narrow
 * drawer, in the dark theme.
 */
test("1546 the Planning menu entry counts the open lanes in scope", async () => {
  const fixture = await planningFixture();
  // One lane two projects list: it counts once, whatever selects both.
  fixture.store.upsertLane({
    key: "shared",
    title: "Shared lane",
    aim: "A lane two selected projects list.",
    repositories: [
      { origin: "fixture/roadmap", path: "/fixture/roadmap" },
      { origin: "fixture/idle", path: "/fixture/idle" },
    ],
  });
  const { MainSurface } = await import("../client/queue");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: fixture.invoke,
        children: h(MainSurface as never, {
          theme: { colors: c },
          layout: { compact: false, platform: "ios" as const },
          navigation: {},
        }),
      }),
    }),
  );
  const nameOf = (key: string) =>
    (fixture.store.projectByKey(key)?.name ?? key) as string;
  const roadmap = nameOf(fixture.keys.roadmap);
  const idle = nameOf(fixture.keys.idle);
  const dormant = nameOf(fixture.keys.dormant);
  const waitFor = async (label: string | RegExp) => {
    for (let i = 0; i < 400 && !ui.query(label); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return ui.get(label);
  };
  // The board measures its panel on its root view; firing a width switches layouts.
  const setWidth = (width: number) => {
    const panel = ui
      .ofType("View")
      .find(
        (node) =>
          typeof node.props.onLayout === "function" &&
          node.props.style?.backgroundColor === dark.surface0,
      );
    assert.ok(panel, "the board measures its panel");
    panel.props.onLayout({ nativeEvent: { layout: { width, height: 800 } } });
  };
  // A menu entry's dimming lives on its pressable frame.
  const opacityOf = (label: string | RegExp) =>
    ui.get(label).props.style.opacity;
  // The project selector's trigger and one project row. A Shift-press leaves
  // the popover open for the next pick, so the trigger is only pressed when
  // the rows are not already showing.
  const selectProject = async (name: string, additive?: boolean) => {
    const row = new RegExp(`^Project ${escapeRegExp(name)},`);
    if (!ui.query(row)) {
      ui.press(/^Projects, /);
      await waitFor(row);
    }
    ui.press(
      row,
      additive ? { nativeEvent: { shiftKey: true } } : undefined,
    );
  };
  try {
    // All projects: the six active lanes — reliability, host, activities,
    // containers, benchmark and the shared lane counted once. The done lanes
    // (board-ui, spike) never count.
    await waitFor("Planning, 6 open lanes");
    assert.equal(
      opacityOf("Planning, 6 open lanes"),
      1,
      "a non-zero Planning count never dims",
    );
    // The count reads in the dark theme, in the same muted text as the rest.
    const entry = ui.get("Planning, 6 open lanes");
    const count = (
      entry.children as Array<{ type?: string; children?: unknown[] } | string>
    ).find(
      (child) =>
        typeof child !== "string" &&
        child.type === "Text" &&
        (child.children ?? []).join("") === "6",
    ) as { props: { style: { color: string } } };
    assert.ok(count, "Planning draws its count as text");
    assert.equal(
      count.props.style.color,
      dark.foregroundMuted,
      "the count reads muted in the dark theme",
    );
    // The entry opens Planning like every other entry opens its view.
    ui.press(/^Planning, \d+ open lanes$/);
    await waitFor(/^Plan for /);

    // The count follows the project selection.
    await selectProject(roadmap);
    await waitFor("Planning, 5 open lanes");
    // Two selected projects still count their shared lane once.
    await selectProject(idle, true);
    await waitFor("Planning, 6 open lanes");
    // Idle alone lists only its own lanes.
    await selectProject(idle);
    await waitFor("Planning, 2 open lanes");
    // Dormant lists none: the zero entry dims but stays selectable. The view
    // is still on Planning from above, and the selected entry never dims, so
    // step onto Needs you first.
    await selectProject(dormant);
    await waitFor("Planning, 0 open lanes");
    ui.press(/^Needs you, \d+$/);
    await waitFor("Needs you list");
    assert.equal(
      opacityOf("Planning, 0 open lanes"),
      0.55,
      "a zero Planning count dims like every other entry",
    );
    ui.press(/^Planning, \d+ open lanes$/);
    assert.equal(
      opacityOf("Planning, 0 open lanes"),
      1,
      "the selected entry keeps its selected styling",
    );
    // Clearing the selection restores all projects and their open lanes.
    ui.press(/^Projects, /);
    await waitFor("Clear project selection");
    ui.press("Clear project selection");
    await waitFor("Planning, 6 open lanes");

    // Medium width keeps the same menu inline.
    setWidth(900);
    assert.ok(
      ui.query("Planning, 6 open lanes"),
      "the medium layout keeps the Planning count",
    );
    // The narrow drawer carries the same entry behind the menu button.
    setWidth(400);
    assert.equal(
      ui.query("Nucleus navigation"),
      undefined,
      "the drawer starts closed",
    );
    ui.press("Open the board menu");
    ui.get("Board menu");
    assert.ok(
      ui.query("Planning, 6 open lanes"),
      "the narrow drawer carries the Planning count",
    );
    ui.press(/^Planning, \d+ open lanes$/);
    assert.equal(
      ui.query("Board menu"),
      undefined,
      "picking the entry closes the drawer",
    );
    // Narrow drills into the roadmap in place: project rows first, then the plan.
    for (let i = 0; i < 400 && ui.all(/^Plan for |^Project row /).length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(
      ui.all(/^Plan for |^Project row /).length > 0,
      "the Planning view opens from the drawer",
    );
  } finally {
    ui.update(h("View", null));
    client.clear();
    await fixture.close();
  }
});
