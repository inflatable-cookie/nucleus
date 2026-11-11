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
  visibility: "active" | "parked",
  ...repos: Array<{ origin: string; path: string }>
): Project =>
  ({
    key,
    name: key,
    version: 1,
    visibility,
    repositories: repos,
    primary: repos[0],
    planner: { agentId: "thread" },
    drain: null,
  }) as unknown as Project;
const alpha = project("alpha", "active", repo("a"), repo("shared"));
const beta = project("beta", "active", repo("b"), repo("shared"));
const gamma = project("gamma", "parked", repo("g"));
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

type MountOver = {
  compact?: boolean;
  selection?: string[];
  lanesLoading?: boolean;
  lanesError?: string;
  plansError?: string;
  onRetryLanes?: () => void;
  sections?: PlanSection[];
  lanes?: LaneView[];
};

async function mountTab(over: MountOver = {}) {
  const { PlanningTab } = await import("../client/planning-panel");
  const log = { opened: [] as string[], selected: [] as string[][] };
  function Harness() {
    const [planEdits] = useState<Record<string, PlanEdit>>({});
    const [selection, setSelection] = useState<string[]>(over.selection ?? []);
    return h(PlanningTab, {
      sections: over.sections ?? sections,
      lanes: over.lanes ?? lanes,
      projects,
      plans: [latest, betaPlan],
      selection,
      compact: over.compact ?? false,
      step: "plan",
      busy: false,
      edits: planEdits,
      selectedLane: "",
      lanePanel: h("Text", null, "LANE PANEL SENTINEL"),
      lanesLoading: over.lanesLoading,
      lanesError: over.lanesError,
      plansError: over.plansError,
      onRetryLanes: over.onRetryLanes,
      onSelectProjects: (keys: string[]) => {
        log.selected.push(keys);
        setSelection(keys);
      },
      onStep: () => {},
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
  assert.equal(
    ui.get("Project: All projects").props.accessibilityLabel,
    "Project: All projects",
  );
  assert.ok(ui.get("Planning plan"));
  assert.ok(ui.get("Planning lane"), "the lane column is beside the plan");
  assert.match(ui.text(), /LANE PANEL SENTINEL/);
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
    ui.get("Planning lane"),
    "and the lane column keeps the project context",
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
  assert.ok(ui.get("Search lanes in alpha"));
  const all = ui.get("Search lanes in all projects");
  assert.equal(
    all.props.accessibilityState.selected,
    false,
    "no cross-project scope until asked",
  );
  ui.type("Find lanes", "beta lane");
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

test("866 rendered: a narrow layout opens the chooser as a modal and writes the shared project scope", async () => {
  const { ui, log } = await mountTab({ compact: true });
  assert.ok(ui.get("Browse all lanes"));
  ui.press("Project: All projects");
  assert.ok(ui.get("Planning project chooser"));
  assert.equal(ui.ofType("Modal").length, 1, "a modal at the narrow size");
  assert.equal(
    ui.get("Choose all projects").props.accessibilityState.selected,
    true,
  );
  ui.press("Choose project beta");
  assert.deepEqual(log.selected, [["beta"]]);
  assert.equal(
    ui.query("Planning project chooser"),
    undefined,
    "choosing closes the chooser",
  );
  assert.equal(
    ui.get("Project: beta").props.accessibilityLabel,
    "Project: beta",
  );
  assert.ok(ui.get("Search lanes in beta"));
  assert.ok(ui.get("Search lanes in all projects"));
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
    `${ui.all(/^Open lane /).length} lanes`,
    "the count is the whole lane record, not a page",
  );
  assert.ok(ui.all(/^Open lane /).length >= 3);
  assert.equal(
    ui.query(/^Open lane Gamma lane/),
    undefined,
    "All projects hides a parked-only lane",
  );
  ui.type("Find lanes", "nothing at all");
  assert.equal(ui.query(/^Open lane /), undefined);
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
  assert.match(scoped.text(), /No lanes in this scope\. Search all projects to look wider\./);
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
  assert.match(firstReadFailed.text(), /Couldn't load lanes: queue.snapshot failed/);
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

test("866 rendered LaneProjects: a shared lane shows each project's own position and offers its plan", async () => {
  const { LaneProjects } = await import("../client/planning-panel");
  const log: string[] = [];
  const shared = lanes.find((item) => item.key === "shared")!;
  const ui = mount(
    h(LaneProjects, {
      lane: shared,
      projects,
      plans: [latest, betaPlan],
      selected: ["alpha"],
      onSelectProject: (key: string) => log.push(key),
      c,
    }),
  );
  assert.equal(
    ui.get("Projects for Shared lane").props.accessibilityLabel,
    "Projects for Shared lane",
  );
  assert.equal(
    ui.get("alpha: Now · step 2 of 2").props.accessibilityLabel,
    "alpha: Now · step 2 of 2",
  );
  assert.equal(
    ui.get("beta: Later · step 1 of 1").props.accessibilityLabel,
    "beta: Later · step 1 of 1",
  );
  assert.match(
    ui.text(),
    /each project's plan orders this lane separately\. There is no single order across projects/,
  );
  assert.equal(
    ui.query("Show the alpha plan with this lane open"),
    undefined,
    "the chosen project is marked, not offered",
  );
  ui.press("Show the beta plan with this lane open");
  assert.deepEqual(log, ["beta"]);
  const single = lanes.find((item) => item.key === "s1")!;
  const one = mount(
    h(LaneProjects, { lane: single, projects, plans: [latest, betaPlan], c }),
  );
  assert.equal(
    one.get("alpha: Now · step 1 of 2").props.accessibilityLabel,
    "alpha: Now · step 1 of 2",
  );
  assert.doesNotMatch(one.text(), /There is no single order/);
  const loose = lanes.find((item) => item.key === "loose")!;
  const unplanned = mount(
    h(LaneProjects, { lane: loose, projects, plans: [latest, betaPlan], c }),
  );
  assert.equal(
    unplanned.get("alpha: Not in the plan").props.accessibilityLabel,
    "alpha: Not in the plan",
  );
});
