import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { planningFixture } from "./support/planning-fixture";
import { planningEntry } from "./support/inbox";
import type { BoardTheme } from "../client/shell/types";

/**
 * nucleus#1531: Planning reads projects, lanes, plans, tasks and leads from
 * fixture RPC responses. Wide has separate panes. Medium drills into the
 * roadmap and opens the lane page in the modal.
 */
useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const textOf = (node: HostNode | string): string =>
  typeof node === "string"
    ? node
    : node.children.map(textOf).join(" ").replace(/\s+/g, " ").trim();

async function mountBoard(
  compact: boolean,
  setup?: (fixture: Awaited<ReturnType<typeof planningFixture>>) => void,
  colors: BoardTheme["colors"] = c,
) {
  const fixture = planningFixture();
  setup?.(fixture);
  const { MainSurface } = await import("../client/queue");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: fixture.invoke,
        children: h(MainSurface, { theme: { colors }, layout: { compact } }),
      }),
    }),
  );
  const waitFor = async (label: string | RegExp) => {
    for (let i = 0; i < 400 && !ui.query(label); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return ui.get(label);
  };
  return {
    ui,
    waitFor,
    fixture,
    close() {
      ui.update(h("View"));
      client.clear();
    },
  };
}

test("1531 wide: the list groups projects with a status line in words, and the first project shows its roadmap", async () => {
  const board = await mountBoard(false);
  const { ui, waitFor } = board;
  try {
    await waitFor(planningEntry);
    ui.press(planningEntry);
    await waitFor(
      "Status for roadmap: 1 need you · 2 lanes in progress · 4 tasks live",
    );
    // The probe task sits in two lanes; summing the lanes' counts would say 5 (Spec 019: count it once).
    assert.match(textOf(ui.get("Active projects")), /roadmap/);
    assert.match(
      textOf(ui.get("Idle on purpose projects")),
      /idle[\s\S]*Idle · Benchmark roadmap complete\. Waiting for your next direction\./,
    );
    assert.match(
      textOf(ui.get("Dormant projects")),
      /dormant[\s\S]*No recent activity/,
    );
    assert.equal(
      ui.query(/^Plan for /)?.props.accessibilityLabel,
      "Plan for roadmap",
      "the first active project opens with no accordion in the list",
    );

    const plan = textOf(ui.get("Plan for roadmap"));
    assert.match(plan, /Plan updated just now by the roadmap planner/);
    assert.doesNotMatch(
      plan,
      /Version \d|version \d|step \d+ of/,
      "no version number or step counter in the read view",
    );
    assert.match(
      textOf(ui.get("Focus")),
      /Queue stops stalling or misreporting work silently/,
      "the focus is the first Now lane's aim",
    );
    const now = textOf(ui.get("Now column")),
      next = textOf(ui.get("Next column")),
      later = textOf(ui.get("Later column"));
    assert.match(
      now,
      /Being worked on[\s\S]*Queue reliability[\s\S]*BB as a host/,
    );
    assert.match(
      now,
      /Done when[\s\S]*Milestone QA passes and one observed week needs no manual unsticking\./,
    );
    assert.match(next, /Starts when a Now lane finishes[\s\S]*Activity types/);
    assert.match(later, /Planned, not scheduled[\s\S]*Native containers/);
    assert.doesNotMatch(
      later,
      /Board UI/,
      "a finished lane leaves the columns",
    );
    assert.ok(
      ui.get("1 need you in Queue reliability"),
      "the card carries the attention pill",
    );
    assert.equal(ui.query("1 need you in BB as a host"), undefined);
    assert.ok(
      ui.get(
        "Progress for Queue reliability: 1 need you, 1 working, 1 in review, 1 queued, 2 finished",
      ),
    );
    ui.press("Finished lanes, 2");
    assert.ok(ui.get("Open lane Board UI, finished"));
    assert.ok(ui.get("Open lane Containers spike, finished"));
    assert.doesNotMatch(
      textOf(ui.get("Later column")),
      /Containers spike/,
      "the live plan has dropped the closed spike",
    );
    ui.press("Show roadmap plan history");
    await waitFor("Now in version 2");
    assert.match(
      textOf(ui.get("Plan history for roadmap")),
      /Version 2 · saved .* by the roadmap planner · the latest/,
      "History holds the version",
    );
    // The latest save as stored, not the live projection: the spike closed after it was saved.
    assert.match(
      textOf(ui.get("Later in version 2")),
      /Containers spike · Done when The spike says go or no-go\. · Two days, then decide\./,
      "each saved entry shows its finish line and note",
    );
    assert.match(
      textOf(ui.get("Now in version 2")),
      /BB as a host · Done when .* · The pilot finished\. Waiting for the next real opt-in task\./,
    );
    ui.press("Show the earlier version of the roadmap plan");
    await waitFor("Now in version 1");
    assert.match(
      textOf(ui.get("Plan history for roadmap")),
      /Version 1 · saved .* · not the latest/,
      "History pages back through plan.get",
    );
    assert.match(textOf(ui.get("Later in version 1")), /Native containers/);
    assert.match(
      textOf(ui.get("Now in version 1")),
      /BB as a host · Done when .* · Waiting for the next real opt-in task\./,
      "version 1 keeps the note it was saved with",
    );
    assert.equal(
      ui.get("Show the earlier version of the roadmap plan").props.disabled,
      true,
      "version 1 is the first save",
    );
    ui.press("Show the later version of the roadmap plan");
    await waitFor("Now in version 2");
    assert.match(
      textOf(ui.get("Plan history for roadmap")),
      /Version 2 · .* · the latest/,
    );
    ui.press("Edit roadmap plan");
    assert.ok(
      ui.get("Draft plan for roadmap"),
      "Edit plan opens today's editor",
    );
  } finally {
    board.close();
  }
});

test("1531 wide: the columns sit side by side, and See all pages through the lane's whole finished history", async () => {
  const board = await mountBoard(false);
  const { ui, waitFor } = board;
  try {
    await waitFor(planningEntry);
    ui.press(planningEntry);
    await waitFor("Open lane BB as a host");
    assert.equal(ui.get("Roadmap").props.style.flexDirection, "row");
    ui.press("Open lane BB as a host");
    await waitFor("See all finished work in BB as a host");
    const before = textOf(ui.get("Recently finished"));
    assert.match(before, /13 in total/);
    assert.doesNotMatch(
      before,
      /Host follow-up 1 /,
      "only the newest show before See all",
    );
    ui.press("See all finished work in BB as a host");
    for (
      let i = 0;
      i < 400 &&
      !/The last 10 of 13 finished\./.test(textOf(ui.get("Recently finished")));
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const all = textOf(ui.get("Recently finished"));
    assert.equal(
      (all.match(/[✓✕]/g) ?? []).length,
      10,
      "See all shows the lane view's own ten rows; the engine keeps no paged finished history",
    );
    assert.match(all, /The last 10 of 13 finished\./);
    assert.equal(
      ui.query("Show more finished work in BB as a host"),
      undefined,
      "the search said there is no more",
    );
  } finally {
    board.close();
  }
});

test("1616 mounted: board pane dividers appear at wide widths and disappear when narrow", async () => {
  const board = await mountBoard(false);
  const { ui, waitFor } = board;
  try {
    await waitFor("Nucleus navigation");
    const panel = ui.ofType("View").find(
      (node) =>
        typeof node.props.onLayout === "function" &&
        node.props.style?.flex === 1 &&
        node.props.style?.backgroundColor === "#000",
    );
    assert.ok(panel, "the board panel reports its measured width");
    panel.props.onLayout({ nativeEvent: { layout: { width: 1280, height: 900 } } });
    assert.equal(
      ui.ofType("View").filter((node) => node.props.style?.borderRightWidth === 1).length,
      2,
      "wide menu/list/detail panes have both dividers",
    );

    panel.props.onLayout({ nativeEvent: { layout: { width: 600, height: 900 } } });
    assert.equal(
      ui.ofType("View").some((node) => node.props.style?.borderRightWidth === 1),
      false,
      "narrow stacked navigation and list have no vertical dividers",
    );
  } finally {
    board.close();
  }
});

test("1531 wide: a project whose only record is a new lane shows that lane's time as its last activity", async () => {
  // The no-work project gains a lane and nothing else (review 6010408992).
  const board = await mountBoard(false, (fixture) =>
    fixture.addLane({
      key: "dormant-lane",
      title: "Dormant lane",
      aim: "A lane for the project with no work.",
      repositories: [{ origin: "fixture/dormant", path: "/fixture/dormant" }],
    }),
  );
  const { ui, waitFor } = board;
  try {
    await waitFor(planningEntry);
    ui.press(planningEntry);
    await waitFor("Project row dormant");
    assert.match(
      textOf(ui.get("Project row dormant")),
      /^dormant (just now|\d+m) /,
      "the lane record gives the row an age",
    );
  } finally {
    board.close();
  }
});

test("1531 wide: an idle project shows its reason instead of a focus, and a dormant one says it is dormant", async () => {
  const board = await mountBoard(false);
  const { ui, waitFor } = board;
  try {
    await waitFor(planningEntry);
    ui.press(planningEntry);
    await waitFor("Project row idle");
    ui.press("Project row idle");
    assert.match(
      textOf(ui.get("Idle on purpose")),
      /Benchmark roadmap complete\. Waiting for your next direction\./,
    );
    assert.equal(ui.query("Focus"), undefined);
    ui.press("Project row dormant");
    assert.match(textOf(ui.get("Dormant")), /No recent activity/);
    assert.equal(ui.query("Focus"), undefined);
    assert.equal(
      ui.query("Roadmap"),
      undefined,
      "no columns for a project with no plan",
    );
  } finally {
    board.close();
  }
});

test("1531 wide: a lane page shows its finish line, why it is open, status, work, leads and finished work, with a breadcrumb back", async () => {
  const board = await mountBoard(false);
  const { ui, waitFor } = board;
  try {
    await waitFor(planningEntry);
    ui.press(planningEntry);
    await waitFor("Open lane Queue reliability");
    ui.press("Open lane Queue reliability");
    await waitFor(/^Open task Spec 067 batch 2/);
    await waitFor("Open lead Show the stuck cause on every card");
    const page = textOf(ui.get("Lane Queue reliability"));
    assert.match(
      textOf(ui.get("Breadcrumb")),
      /Planning › roadmap › Queue reliability/,
    );
    assert.match(page, /Now[\s\S]*Open/);
    assert.match(
      textOf(ui.get("Aim")),
      /every stuck state has a visible cause and an exit/,
    );
    const finish = textOf(ui.get("Finish line"));
    assert.match(
      finish,
      /Milestone QA passes and one observed week needs no manual unsticking\./,
    );
    assert.match(
      finish,
      /Why it’s still open:[\s\S]*the launch batch still needed a manual restart/,
      "keep.reason says why it is still open",
    );
    assert.match(
      textOf(ui.get("Latest status")),
      /Spec 067 is landing in six batches[\s\S]*the roadmap planner · just now/,
    );
    const flight = textOf(ui.get("In flight"));
    assert.match(flight, /4 tasks/);
    assert.match(flight, /roadmap#001[\s\S]*Spec 067 batch 2[\s\S]*In review/);
    assert.match(flight, /Blocked/);
    assert.match(
      textOf(ui.get("Waiting to start")),
      /Show the stuck cause on every card/,
    );
    const finished = textOf(ui.get("Recently finished"));
    assert.match(finished, /2 in total/);
    assert.match(
      finished,
      /Spec 067 batch 1: typed decision fields[\s\S]*PR #416/,
    );
    assert.ok(ui.get("Live tasks: 4"));
    assert.ok(ui.get("Need you: 1"));
    assert.ok(ui.get("Leads waiting: 1"));
    assert.ok(
      ui.get("roadmap: Now"),
      "the plans it is in, with their horizons",
    );
    assert.doesNotMatch(
      page,
      /step \d+ of|Shared by|plan orders this lane separately/,
      "no step counter or shared-lane caveat",
    );
    ui.press("Show details for Queue reliability");
    assert.ok(
      ui.get("Lane repositories"),
      "the key and repositories stay under Details",
    );
    ui.press("Back to roadmap");
    assert.ok(ui.get("Plan for roadmap"));
    assert.equal(ui.query("Lane Queue reliability"), undefined);
  } finally {
    board.close();
  }
});

test("1531 medium: the roadmap opens in place of the list, and the lane page opens in the modal with the same breadcrumb", async () => {
  const colors = {
    surface0: "#fcfcfc",
    surface1: "#fcfcfc",
    surface2: "#ffffff",
    surfaceNavigation: "#fafafa",
    foreground: "#27272a",
    foregroundMuted: "#71717b",
    accent: "#1b4ed8",
    accentForeground: "#ffffff",
    border: "#e4e4e7",
    statusSuccess: "#2aa56d",
    statusWarning: "#fe9a00",
    statusDanger: "#fb2c36",
  };
  const board = await mountBoard(true, undefined, colors);
  const { ui, waitFor } = board;
  try {
    await waitFor(planningEntry);
    ui.press(planningEntry);
    await waitFor("Project row roadmap");
    assert.equal(
      ui.query(/^Plan for /),
      undefined,
      "the list shows first without a detail pane",
    );
    ui.press("Project row roadmap");
    assert.ok(ui.get("Plan for roadmap"));
    assert.equal(
      ui.query("Project row idle"),
      undefined,
      "the roadmap takes the list pane",
    );
    assert.equal(
      ui.get("Roadmap").props.style.flexDirection,
      "column",
      "without a detail pane the columns stack",
    );
    ui.press("Open lane Queue reliability");
    const dialog = await waitFor("Lane detail");
    assert.match(textOf(dialog), /Planning › roadmap › Queue reliability/);
    assert.match(textOf(dialog), /Finish line/);
    ui.press("Back to roadmap");
    assert.equal(ui.query("Lane detail"), undefined);
    assert.ok(ui.get("Plan for roadmap"));
    ui.press("Back to Planning");
    assert.ok(
      ui.get("Project row idle"),
      "Planning returns to the project list",
    );
    const panel = ui.ofType("View").find(
      (node) =>
        typeof node.props.onLayout === "function" &&
        node.props.style?.backgroundColor === colors.surface0,
    );
    assert.ok(panel, "the board measures its panel");
    panel.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } });
    ui.press("Project row roadmap");
    assert.equal(
      ui.get("Open lane Queue reliability").props.style.backgroundColor,
      colors.surface2,
      "the narrow light board keeps the raised lane card when the former list fill equaled the section shade",
    );
  } finally {
    board.close();
  }
});
