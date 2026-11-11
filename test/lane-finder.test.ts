import { test } from "node:test";
import assert from "node:assert/strict";
import type { LaneView, Project, ProjectPlan } from "../shared/contracts";
import {
  chooserProjects,
  laneFinderCount,
  laneFinderRows,
  laneFinderScopeLabel,
  lanePlaceLabel,
  lanePlaces,
  planPosition,
} from "../shared/lane-finder";

const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (
  key: string,
  ...repos: Array<{ origin: string; path: string }>
) =>
  ({
    key,
    name: key,
    version: 1,
    visibility: "active",
    repositories: repos,
    primary: repos[0],
    drain: null,
  }) as unknown as Project;
const parked = (
  key: string,
  ...repos: Array<{ origin: string; path: string }>
) => ({ ...project(key, ...repos), visibility: "parked" }) as Project;
const lane = (key: string, over: Partial<LaneView> = {}) =>
  ({
    key,
    title: `Title ${key}`,
    aim: `Aim ${key}`,
    status: "active",
    repositories: [repo(key)],
    lastActivityAt: "2026-11-06T09:00:00.000Z",
    ...over,
  }) as unknown as LaneView;
const entry = (name: string, horizon: "now" | "next" | "later") => ({
  lane: name,
  note: "",
  horizon,
});
const plan = (key: string, entries: ReturnType<typeof entry>[]): ProjectPlan =>
  ({
    project: key,
    version: 2,
    entries,
    author: null,
    createdAt: null,
  }) as ProjectPlan;

const alpha = project("alpha", repo("a"), repo("shared"));
const beta = project("beta", repo("b"), repo("shared"));
const projects = [alpha, beta];

test("866-1 a lane lists its projects and each project orders it separately", () => {
  const shared = lane("shared-lane", {
    repositories: [repo("shared"), repo("a"), repo("b")],
    title: "Shared lane",
    aim: "One aim",
  });
  const plans = [
    plan("alpha", [entry("shared-lane", "now"), entry("other-a", "now")]),
    plan("beta", [entry("beta-first", "now"), entry("shared-lane", "later")]),
  ];
  assert.deepEqual(lanePlaces(shared, projects, plans), [
    {
      key: "alpha",
      name: "alpha",
      parked: false,
      horizon: "now",
      position: 1,
      size: 2,
    },
    {
      key: "beta",
      name: "beta",
      parked: false,
      horizon: "later",
      position: 1,
      size: 1,
    },
  ]);
  // There is no global order: only each project's own position is reported.
  assert.equal(
    lanePlaceLabel({ ...lanePlaces(shared, projects, plans)[0] }),
    "Now · step 1 of 2",
  );
  assert.equal(
    lanePlaceLabel({ ...lanePlaces(shared, projects, plans)[1] }),
    "Later · step 1 of 1",
  );
});

test("866-2 a project that lists the lane but has not planned it says so; an unlisted lane has no places", () => {
  const unplanned = lane("unplanned", { repositories: [repo("a")] });
  assert.deepEqual(
    lanePlaces(unplanned, projects, [plan("alpha", [entry("other", "now")])]),
    [
      {
        key: "alpha",
        name: "alpha",
        parked: false,
        horizon: null,
        position: null,
        size: null,
      },
    ],
  );
  assert.equal(
    lanePlaceLabel(lanePlaces(unplanned, projects, [])[0]),
    "Not in the plan",
  );
  assert.deepEqual(
    lanePlaces(lane("orphan"), projects, []),
    [],
    "a lane that lists no project repository is not placed",
  );
  assert.deepEqual(planPosition(undefined, "x"), null);
});

test("866-3 Find lanes lists every lane in scope, open lanes first, and matches title, aim, key or project", () => {
  const lanes = [
    lane("paused-one", {
      status: "paused",
      title: "Paused one",
      repositories: [repo("a")],
    }),
    lane("done-one", {
      status: "done",
      title: "Done one",
      repositories: [repo("a")],
    }),
    lane("open-one", {
      title: "Open one",
      aim: "Search across projects",
      repositories: [repo("a")],
    }),
    lane("beta-one", { repositories: [repo("b")], title: "Beta one" }),
  ];
  const rows = laneFinderRows({ lanes, projects, plans: [] });
  assert.deepEqual(
    rows.map((row) => row.key),
    ["beta-one", "open-one", "paused-one", "done-one"],
    "open lanes by title, then paused, then closed",
  );
  assert.deepEqual(
    laneFinderRows({ lanes, projects, plans: [], query: "search across" }).map(
      (row) => row.key,
    ),
    ["open-one"],
    "an aim matches",
  );
  assert.deepEqual(
    laneFinderRows({ lanes, projects, plans: [], query: "beta" }).map(
      (row) => row.key,
    ),
    ["beta-one"],
    "a project name matches",
  );
  assert.deepEqual(
    laneFinderRows({ lanes, projects, plans: [], query: "OPEN ONE" }).map(
      (row) => row.key,
    ),
    ["open-one"],
    "matching ignores case",
  );
  assert.deepEqual(
    laneFinderRows({ lanes, projects, plans: [], query: "nothing here" }),
    [],
  );
});

test("866-4 the scope is the chosen project, or all non-parked projects; a parked project is reached by choosing it", () => {
  const lanes = [
    lane("alpha-lane", { repositories: [repo("a")] }),
    lane("parked-lane", { repositories: [repo("p")] }),
  ];
  const withParked = [...projects, parked("parked-project", repo("p"))];
  assert.deepEqual(
    laneFinderRows({
      lanes,
      projects: withParked,
      plans: [],
      selection: ["alpha"],
    }).map((row) => row.key),
    ["alpha-lane"],
  );
  assert.deepEqual(
    laneFinderRows({ lanes, projects: withParked, plans: [] }).map(
      (row) => row.key,
    ),
    ["alpha-lane"],
    "All projects hides a parked-only lane",
  );
  assert.deepEqual(
    laneFinderRows({
      lanes,
      projects: withParked,
      plans: [],
      selection: ["parked-project"],
    }).map((row) => row.key),
    ["parked-lane"],
  );
  const shared = lane("shared-lane", { repositories: [repo("shared")] });
  assert.equal(
    laneFinderRows({
      lanes: [shared],
      projects,
      plans: [],
      selection: ["alpha", "beta"],
    })[0].shared,
    true,
    "a lane two projects list is marked shared",
  );
  assert.equal(
    laneFinderRows({
      lanes: [shared],
      projects,
      plans: [],
      selection: ["alpha"],
    })[0].shared,
    true,
    "the shared flag describes the lane, not the scope",
  );
  assert.deepEqual(laneFinderScopeLabel(projects, []), "All projects");
  assert.deepEqual(laneFinderScopeLabel(projects, ["alpha"]), "alpha");
  assert.deepEqual(
    laneFinderScopeLabel(projects, ["alpha", "beta"]),
    "2 projects",
  );
});

test("866-5 the count line names results of the whole lane record, never a first page", () => {
  assert.equal(laneFinderCount(3, 3), "3 lanes");
  assert.equal(laneFinderCount(1, 1), "1 lane");
  assert.equal(laneFinderCount(2, 9), "2 of 9 lanes");
});

test("866-6 the chooser lists active projects first and parked ones last", () => {
  const ordered = chooserProjects([
    parked("zed", repo("z")),
    project("beta", repo("b")),
    project("alpha", repo("a")),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.name),
    ["alpha", "beta", "zed"],
  );
});
