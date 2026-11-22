import { test } from "node:test";
import assert from "node:assert/strict";
import React, { useState } from "react";
import { mount, useNativeStubs } from "./support/render";
import type { LaneView, Project, ProjectPlan } from "../shared/contracts";
import type { PlanEdit, PlanSection } from "../client/planning-panel";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (
  key: string,
  ...repos: Array<{ origin: string; path: string }>
): Project =>
  ({
    key,
    name: key,
    version: 1,
    repositories: repos,
    primary: repos[0],
    planner: { agentId: "thread" },
    drain: null,
  }) as unknown as Project;
const alpha = project("alpha", repo("a"), repo("shared"));
const beta = project("beta", repo("b"), repo("shared"));
const gamma = project("gamma", repo("g"));
const projects = [alpha, beta, gamma];
const entry = (
  lane: string,
  horizon: "now" | "next" | "later",
  doneWhen = "",
) => ({ lane, note: "", horizon, ...(doneWhen ? { doneWhen } : {}) });
const latest: ProjectPlan = {
  project: "alpha",
  version: 3,
  author: null,
  createdAt: null,
  entries: [entry("s1", "now", "Ship it"), entry("shared", "now")],
  done: [],
};
const betaPlan: ProjectPlan = {
  project: "beta",
  version: 1,
  author: null,
  createdAt: null,
  entries: [entry("b1", "now"), entry("shared", "later")],
  done: [],
};
const lane = (
  key: string,
  title: string,
  aim: string,
  ...repos: Array<{ origin: string; path: string }>
): LaneView =>
  ({
    key,
    title,
    aim,
    status: "active",
    repositories: repos,
    liveByPhase: { working: 1 },
    terminalCount: 0,
    recentOutcomes: [],
    lastActivityAt: "2026-11-06T09:00:00Z",
  }) as unknown as LaneView;
const lanes = [
  lane("s1", "Plan view", "Read direction", repo("a")),
  lane(
    "shared",
    "Shared lane",
    "One aim across projects",
    repo("shared"),
    repo("a"),
    repo("b"),
  ),
  lane("b1", "Beta lane", "Beta work", repo("b")),
  lane("loose", "Loose lane", "Not planned yet", repo("a")),
  lane("g1", "Gamma lane", "Parked project work", repo("g")),
];
const sections: PlanSection[] = [{ project: alpha, latest, saved: latest }];
/** A search result's label ends in the lane's status; the roadmap's lane cards beside it do not. */
const RESULT = /^Open lane .*, (Active|Paused|Done|Abandoned)$/;

type MountOver = {
  compact?: boolean;
  selection?: string[];
  lanesLoading?: boolean;
  lanesError?: string;
  plansError?: string;
  onRetryLanes?: () => void;
  sections?: PlanSection[];
  lanes?: LaneView[];
  step?: "plan" | "lane";
  selectedLane?: string;
};

async function mountTab(over: MountOver = {}) {
  const { PlanningTab } = await import("../client/planning-panel");
  const log = { opened: [] as string[], steps: [] as string[] };
  function Harness() {
    const [planEdits] = useState<Record<string, PlanEdit>>({});
    const selection = over.selection ?? [];
    return h(PlanningTab, {
      sections: over.sections ?? sections,
      lanes: over.lanes ?? lanes,
      projects,
      plans: [latest, betaPlan],
      selection,
      compact: over.compact ?? false,
      step: over.step ?? "plan",
      busy: false,
      edits: planEdits,
      selectedLane: over.selectedLane ?? "",
      lanePanel: h("Text", null, "LANE PANEL SENTINEL"),
      lanesLoading: over.lanesLoading,
      lanesError: over.lanesError,
      plansError: over.plansError,
      onRetryLanes: over.onRetryLanes,
      onStep: (step: string) => log.steps.push(step),
      onOpenLane: (key: string) => log.opened.push(key),
      onEdit: () => {},
      onSave: () => {},
      onCancel: () => {},
      c,
    });
  }
  return { ui: mount(h(Harness)), log };
}

test("866 rendered wide: the finder replaces the plan column, names project and status, and keeps the lane column", async () => {
  const { ui, log } = await mountTab();
  // The board header's project filter scopes Planning; it has no chooser of its own (Tom, 2026-11-21).
  assert.equal(ui.query(/^Project: /), undefined);
  assert.ok(ui.get("Planning plan"));
  assert.ok(ui.get("Planning project"), "the roadmap is beside the list");
  assert.ok(ui.get("Plan for alpha"));
  assert.doesNotMatch(
    ui.text(),
    /LANE PANEL SENTINEL/,
    "the lane page waits for a lane",
  );
  assert.equal(
    ui.query("Lane search results"),
    undefined,
    "search is closed until asked for",
  );
  ui.type("Find lanes", "shared");
  assert.equal(
    ui.query("Planning plan"),
    undefined,
    "the results replace the plan while searching",
  );
  assert.ok(ui.get("Lane search results"));
  assert.ok(
    ui.get("Planning project"),
    "and the detail pane keeps the project context",
  );
  const result = ui.get("Open lane Shared lane, alpha and beta, Active");
  assert.equal(result.props.accessibilityRole, "button");
  assert.match(ui.text(), /One aim across projects/);
  assert.match(ui.text(), /alpha · Now · step 2 of 2/);
  assert.match(ui.text(), /beta · Later · step 1 of 1/);
  assert.equal(
    ui.get("Lane search scope").children.join(""),
    "Searching all projects. Results match the title, aim or project.",
  );
  ui.press("Open lane Shared lane, alpha and beta, Active");
  assert.deepEqual(log.opened, ["shared"]);
  ui.press("Close lane search");
  assert.ok(ui.get("Planning plan"), "closing the search returns to the plan");
  assert.equal(ui.query("Lane search results"), undefined);
});

test("866 rendered: the all-projects scope is labelled and reaches lanes the chosen project does not list", async () => {
  const { ui } = await mountTab({ selection: ["alpha"] });
  // The scope buttons belong to the search, so they show once a search is open.
  assert.equal(ui.query("Search lanes in alpha"), undefined);
  ui.type("Find lanes", "beta lane");
  assert.ok(ui.get("Search lanes in alpha"));
  assert.equal(
    ui.get("Search lanes in all projects").props.accessibilityState.selected,
    false,
    "no cross-project scope until asked",
  );
  assert.equal(
    ui.query(/^Open lane Beta lane/),
    undefined,
    "the chosen project does not reach another project's lane",
  );
  ui.press("Search lanes in all projects");
  assert.equal(
    ui.get("Search lanes in all projects").props.accessibilityState.selected,
    true,
  );
  assert.ok(ui.get("Open lane Beta lane, beta, Active"));
});

test("a board without a detail pane keeps the plan and opens the open lane in a modal that returns to the plan", async () => {
  // Narrow, nothing open: the plan alone, and no modal.
  const closed = (await mountTab({ compact: true })).ui;
  assert.ok(closed.get("Planning plan"));
  assert.ok(closed.get("Browse all lanes"));
  assert.equal(
    closed.query("Planning lane"),
    undefined,
    "no lane pane beside the plan",
  );
  assert.equal(closed.ofType("Modal").length, 0);
  // Narrow with a lane open: the plan stays and the lane is a modal.
  const { ui, log } = await mountTab({
    compact: true,
    step: "lane",
    selectedLane: "s1",
  });
  assert.ok(ui.get("Planning plan"), "the plan stays under the modal");
  assert.equal(ui.ofType("Modal").length, 1, "the lane opens in a modal");
  assert.ok(ui.get("Lane detail"));
  assert.match(ui.text(), /LANE PANEL SENTINEL/);
  ui.press("Close lane");
  assert.deepEqual(
    log.steps,
    ["plan"],
    "closing the modal returns to the plan",
  );
  // Wide: the lane is the pane beside the plan, never a modal.
  const wide = (await mountTab({ step: "lane", selectedLane: "s1" })).ui;
  assert.ok(wide.get("Planning lane"));
  assert.equal(wide.ofType("Modal").length, 0);
});

test("866 rendered: searching all projects finds another project's lane and says so", async () => {
  const { ui } = await mountTab({ selection: ["alpha"] });
  ui.type("Find lanes", "beta lane");
  assert.equal(
    ui.query(/^Open lane Beta lane/),
    undefined,
    "the chosen project does not reach another project's lane",
  );
  assert.equal(
    ui.get("Lane search scope").children.join(""),
    "Searching alpha. Results match the title, aim or project.",
  );
  ui.press("Search lanes in all projects");
  assert.equal(
    ui.get("Lane search scope").children.join(""),
    "Searching all projects. Results match the title, aim or project.",
  );
  assert.ok(ui.get("Open lane Beta lane, beta, Active"));
  ui.press("Search lanes in alpha");
  assert.equal(
    ui.get("Lane search scope").children.join(""),
    "Searching alpha. Results match the title, aim or project.",
  );
  assert.equal(ui.query(/^Open lane Beta lane/), undefined);
});

test("866 rendered: browsing lists every lane in scope with an honest count; an empty search says so", async () => {
  const { ui } = await mountTab();
  ui.press("Browse all lanes");
  const count = ui.get("Lane search count");
  assert.equal(
    count.children.join(""),
    `${ui.all(RESULT).length} lanes`,
    "the count is the whole lane record, not a page",
  );
  assert.ok(ui.all(RESULT).length >= 3);
  assert.ok(
    ui.query(/^Open lane Gamma lane/),
    "All projects lists every project's lanes (parking is retired, 2026-11-22)",
  );
  ui.type("Find lanes", "nothing at all");
  assert.equal(ui.query(RESULT), undefined);
  assert.match(ui.text(), /No lanes match “nothing at all”/);
  assert.match(ui.text(), /0 of \d+ lanes/);
  assert.doesNotMatch(
    ui.text(),
    /search all projects/,
    "the all-projects scope is already in force, so it is not offered",
  );
  ui.press("Close lane search");
  assert.ok(ui.get("Planning plan"));
});

test("866 rendered: empty browse and empty search copy say what is actually absent", async () => {
  // Browsing with no query is not a failed match: there is nothing to match yet.
  const empty = (await mountTab({ lanes: [] })).ui;
  empty.press("Browse all lanes");
  assert.match(empty.text(), /No lanes in this scope/);
  assert.doesNotMatch(empty.text(), /No lanes match “”/);
  assert.doesNotMatch(empty.text(), /search all projects/i);
  assert.equal(empty.get("Lane search count").children.join(""), "0 lanes");
  // A chosen project's empty browse offers the wider scope; the all-projects scope does not.
  const scoped = (
    await mountTab({
      selection: ["alpha"],
      lanes: lanes.filter((item) => item.key === "b1"),
    })
  ).ui;
  scoped.press("Browse all lanes");
  assert.match(
    scoped.text(),
    /No lanes in this scope\. Search all projects to look wider\./,
  );
  scoped.press("Search lanes in all projects");
  assert.ok(
    scoped.get("Open lane Beta lane, beta, Active"),
    "the wider scope finds the other project's lane",
  );
  scoped.type("Find lanes", "nothing");
  assert.match(
    scoped.text(),
    /No lanes match “nothing”\. Clear the search\./,
    "an all-projects search does not offer the all-projects scope again",
  );
});

test("866 rendered: loading, failed and stale reads stay distinct from empty", async () => {
  let retried = 0;
  const loading = (await mountTab({ lanesLoading: true })).ui;
  loading.press("Browse all lanes");
  assert.match(loading.text(), /Loading lanes…/);
  assert.doesNotMatch(loading.text(), /No lanes match/);
  // A first read that fails passes no lanes yet, so both flags arrive together; the
  // failure must win, or the panel shows a spinner for a read that already failed.
  const firstReadFailed = (
    await mountTab({ lanesLoading: true, lanesError: "queue.snapshot failed" })
  ).ui;
  firstReadFailed.press("Browse all lanes");
  assert.match(
    firstReadFailed.text(),
    /Couldn't load lanes: queue.snapshot failed/,
  );
  assert.doesNotMatch(firstReadFailed.text(), /Loading lanes…/);
  const failed = (
    await mountTab({
      lanesError: "queue.snapshot failed",
      onRetryLanes: () => {
        retried += 1;
      },
    })
  ).ui;
  failed.press("Browse all lanes");
  assert.match(failed.text(), /Couldn't load lanes: queue.snapshot failed/);
  assert.match(failed.text(), /may be incomplete/);
  assert.doesNotMatch(failed.text(), /0 lanes/);
  failed.press("Retry loading lanes");
  assert.equal(retried, 1);
  const stale = (await mountTab({ plansError: "plan.get failed" })).ui;
  stale.press("Browse all lanes");
  assert.match(
    stale.text(),
    /Plan positions may be out of date: plan.get failed/,
    "a failed plan read is said, not hidden as “not in the plan”",
  );
  assert.ok(stale.get("Lane search count"));
});
