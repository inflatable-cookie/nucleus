import { test } from "node:test";
import { recentProjectActivity } from "./support/fakes";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import { planningLaneLeads, type ProjectScope } from "../shared/project-scope";
import type { Lead, Project, TaskSummary } from "../shared/contracts";

useNativeStubs();
const load = () => import("../client/project-scope-controls");
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (key: string, ...repos: ReturnType<typeof repo>[]): Project =>
  ({
    key,
    name: key,
    repositories: repos,
    primary: repos[0],
    owner: {
      agentId: "thread",
      assignedBy: "operator",
      assignedAt: "2026-10-03T00:00:00.000Z",
      note: "",
    },
  }) as Project;
const projects = [
  project("consumer-b-v2", repo("consumer")),
  project("project-a-accelerator", repo("project-a")),
  project("other", repo("other")),
];
const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

test("1421 rendered: a plain click replaces the selection, Shift-click toggles one project", async () => {
  const { ProjectSelector, useProjectScope } = await load();
  const storage = memory();
  let seen: ProjectScope | null = null;
  function Harness() {
    const [scope, setScope] = useProjectScope(() => storage);
    seen = scope;
    return h(
      React.Fragment,
      null,
      h(ProjectSelector, {
        projects,
        tasks: [],
        leads: [],
        value: scope.projects,
        onChange: (keys) => setScope({ projects: keys }),
        onOpenChange: () => {},
        compact: false,
        c,
      }),
    );
  }
  const ui = mount(h(Harness));
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, All projects",
  );
  assert.equal(ui.query("Project selector"), undefined, "closed until pressed");
  ui.press(/^Projects, /);
  assert.ok(ui.get("Project selector"));
  assert.equal(ui.ofType("Modal").length, 0, "a popover at the wide size");
  assert.equal(
    ui.get(/^Project consumer-b-v2/).props.accessibilityLabel,
    "Project consumer-b-v2, 0 tasks",
    "the zero total is included in the accessible project name",
  );
  // A plain click from empty selects one project and closes the picker.
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(seen!.projects, ["consumer-b-v2"]);
  assert.equal(
    ui.query("Project selector"),
    undefined,
    "a plain click closes the picker",
  );
  // A plain click from a single selection replaces it.
  ui.press(/^Projects, /);
  ui.press(/^Project project-a-accelerator/);
  assert.deepEqual(seen!.projects, ["project-a-accelerator"]);
  assert.equal(ui.query("Project selector"), undefined);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, project-a-accelerator",
  );
  // Clicking the sole selected project keeps it selected.
  ui.press(/^Projects, /);
  ui.press(/^Project project-a-accelerator/);
  assert.deepEqual(seen!.projects, ["project-a-accelerator"]);
  assert.equal(ui.query("Project selector"), undefined);
  // Shift-click adds one project and keeps the picker open (the React Native
  // event shape, with the DOM event under nativeEvent).
  ui.press(/^Projects, /);
  ui.press(/^Project consumer-b-v2/, { nativeEvent: { shiftKey: true } });
  assert.deepEqual(seen!.projects, ["project-a-accelerator", "consumer-b-v2"]);
  assert.ok(
    ui.get("Project selector"),
    "the picker stays open for a sequence of Shift-clicks",
  );
  assert.equal(
    ui.get(/^Project consumer-b-v2/).props.accessibilityState.checked,
    true,
  );
  assert.equal(
    ui.get(/^Project other/).props.accessibilityState.checked,
    false,
  );
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, 2 projects",
  );
  // Shift-click with the React Native Web top-level shape removes one project.
  ui.press(/^Project project-a-accelerator/, { shiftKey: true });
  assert.deepEqual(seen!.projects, ["consumer-b-v2"]);
  assert.ok(ui.get("Project selector"));
  // Shift-click removes the last one: empty means all projects.
  ui.press(/^Project consumer-b-v2/, { nativeEvent: { shiftKey: true } });
  assert.deepEqual(seen!.projects, []);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, All projects",
    "none means all",
  );
  assert.ok(ui.get("Project selector"), "Shift-click never closes the picker");
});

test("1421 bundled: the Shift modifier survives the real client bundle (RN Web event path)", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const { boardShellPlugin } = await import("./support/render");
  const bytes = (
    await build({
      entryPoints: [
        new URL("../client/project-scope-controls.tsx", import.meta.url)
          .pathname,
      ],
      bundle: true,
      plugins: [boardShellPlugin],
      platform: "node",
      format: "cjs",
      packages: "external",
      write: false,
    })
  ).outputFiles[0].text;
  // The bundled handler reads the modifier from the press event itself, so it
  // survives whatever React Native Web wraps the event in.
  assert.match(
    bytes,
    /shiftKey/,
    "the bundled selector reads the Shift modifier",
  );
  const mod = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", bytes)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  const BundledSelector = (mod.exports as { ProjectSelector: unknown })
    .ProjectSelector as typeof import("../client/project-scope-controls").ProjectSelector;
  const seen: string[][] = [];
  function Harness() {
    const [value, setValue] = React.useState<string[]>([]);
    return h(BundledSelector, {
      projects,
      tasks: [],
      leads: [],
      value,
      onChange: (keys) => {
        seen.push(keys);
        setValue(keys);
      },
      onOpenChange: () => {},
      compact: false,
      c,
    });
  }
  const ui = mount(h(Harness));
  ui.press(/^Projects, /);
  ui.press(/^Project consumer-b-v2/, { shiftKey: true });
  assert.deepEqual(
    seen,
    [["consumer-b-v2"]],
    "a top-level Shift press toggles through the bundle",
  );
  assert.ok(
    ui.get("Project selector"),
    "the bundled picker stays open on Shift-click",
  );
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(
    seen[seen.length - 1],
    ["consumer-b-v2"],
    "a plain press through the bundle selects one",
  );
  assert.equal(
    ui.query("Project selector"),
    undefined,
    "a plain press through the bundle closes the picker",
  );
});

test("026-14b rendered: single-select, Clear back to all, and one top row of search and icons", async () => {
  const { ProjectSelector, useProjectScope } = await load();
  const storage = memory();
  let seen: ProjectScope | null = null;
  function Harness() {
    const [scope, setScope] = useProjectScope(() => storage);
    seen = scope;
    return h(
      React.Fragment,
      null,
      h(ProjectSelector, {
        projects,
        tasks: [],
        leads: [],
        value: scope.projects,
        onChange: (keys) => setScope({ projects: keys }),
        onOpenChange: () => {},
        compact: false,
        c,
      }),
    );
  }
  const ui = mount(h(Harness));
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, All projects",
  );
  assert.equal(ui.query("Project selector"), undefined, "closed until pressed");
  ui.press(/^Projects, /);
  assert.ok(ui.get("Project selector"));
  assert.equal(ui.ofType("Modal").length, 0, "a popover at the wide size");
  // The open picker's top row: the search and the two icon actions. The Enabled
  // switch, All and None and the selection-count row are gone (nucleus#1476).
  assert.equal(ui.query("Enabled"), undefined, "no Enabled switch");
  assert.equal(ui.query("Select all projects"), undefined, "no All button");
  assert.ok(ui.get("Filter projects"));
  assert.ok(ui.get("Clear project selection"), "Clear is an icon action");
  assert.doesNotMatch(ui.text(), /selected/, "no separate selection-count row");
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(seen!.projects, ["consumer-b-v2"]);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, consumer-b-v2",
  );
  ui.press(/^Projects, /);
  ui.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  assert.deepEqual(seen!.projects, ["consumer-b-v2", "project-a-accelerator"]);
  assert.equal(
    ui.get(/^Project consumer-b-v2/).props.accessibilityState.checked,
    true,
  );
  assert.equal(
    ui.get(/^Project other/).props.accessibilityState.checked,
    false,
  );
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, 2 projects",
  );

  ui.type("Filter projects", "project-a");
  assert.deepEqual(
    ui
      .all(/^Project /)
      .filter((node) => node.props.accessibilityRole === "checkbox")
      .map((node) => node.props.accessibilityLabel),
    ["Project project-a-accelerator, 0 tasks"],
  );
  ui.type("Filter projects", "");
  // Clear empties the selection, so every project shows at once, and the picker stays open.
  ui.press("Clear project selection");
  assert.deepEqual(seen!.projects, []);
  assert.ok(ui.get("Project selector"), "Clear keeps the picker open");
  assert.equal(
    ui
      .all(/^Project /)
      .filter((node) => node.props.accessibilityRole === "checkbox").length,
    3,
    "all projects show immediately",
  );
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, All projects",
    "none means all",
  );
  assert.equal(
    storage.getItem("nucleus:project-scope"),
    JSON.stringify({ projects: [] }),
    "only the selection is stored",
  );
});

test("026-14b rendered: the compact selector is a modal", async () => {
  const { ProjectSelector } = await load();
  const ui = mount(
    h(ProjectSelector, {
      projects,
      tasks: [],
      leads: [],
      value: [],
      onChange: () => {},
      onOpenChange: () => {},
      compact: true,
      c,
    }),
  );
  ui.press(/^Projects, /);
  assert.equal(ui.ofType("Modal").length, 1);
  assert.ok(ui.get("Project selector"));
  assert.ok(ui.get("Close project selector"));
  assert.ok(ui.get("Filter projects"), "the search sits in the modal");
  assert.ok(
    ui.get("Clear project selection"),
    "the compact modal carries the same icon action",
  );
  ui.press("Close project selector");
  assert.equal(ui.query("Project selector"), undefined);
  assert.equal(ui.ofType("Modal").length, 0);
});

test("Spec 027 #11 retired 2026-11-22: the rendered selector has no Parked header or Unpark, and every project scopes", async () => {
  const { ProjectSelector } = await load();
  const all = [projects[0], projects[1], projects[2]];
  const chosen: string[][] = [];
  const ui = mount(
    h(ProjectSelector, {
      projects: all,
      tasks: [],
      leads: [],
      value: [],
      onChange: (keys) => chosen.push(keys),
      onOpenChange: () => {},
      compact: false,
      c,
    }),
  );
  ui.press(/^Projects, /);
  assert.equal(ui.query("Parked"), undefined, "parking is retired: no Parked group");
  assert.equal(
    ui.query("Unpark project-a-accelerator"),
    undefined,
    "no Unpark action anywhere",
  );
  ui.press(/^Project project-a-accelerator/);
  assert.deepEqual(
    chosen,
    [["project-a-accelerator"]],
    "every project can be scoped",
  );
  assert.doesNotMatch(
    ui.text(),
    /owner\/project-a|live tasks|open leads/,
    "rows carry the name only: no origin or count lines",
  );
  const { PlanningTab } = await import("../client/planning-panel");
  const planning = mount(
    h(PlanningTab, {
      sections: all.map((project) => ({ project })),
      projectActivity: recentProjectActivity(all),
      lanes: [],
      edits: {},
      selectedLane: "",
      step: "plan",
      compact: false,
      busy: false,
      lanePanel: null,
      onStep: () => {},
      onOpenLane: () => {},
      onEdit: () => {},
      onSave: () => {},
      onCancel: () => {},
      c,
    }),
  );
  assert.ok(
    planning.get("Project row project-a-accelerator"),
    "several projects show one compact row each",
  );
  assert.equal(planning.query("Plan for project-a-accelerator"), undefined);
  assert.equal(
    planning.query("Plan project project-a-accelerator"),
    undefined,
    "no selector in the tab",
  );
  planning.press("Project row project-a-accelerator");
  assert.ok(planning.get("Plan for project-a-accelerator"));
});

test("026-14a rendered: a planning lane that leaves the selection closes and the compact view returns to the plan", async () => {
  const { usePlanningLane } = await load();
  let api: ReturnType<typeof usePlanningLane> | null = null,
    left = 0;
  function Harness({ inScope }: { inScope: string[] | null }) {
    api = usePlanningLane(inScope, () => {
      left++;
    });
    return null;
  }
  const ui = mount(h(Harness, { inScope: ["a-only", "shared"] }));
  api!.setLane("a-only");
  api!.setStep("lane");
  assert.equal(api!.lane, "a-only");
  ui.update(h(Harness, { inScope: null }));
  assert.equal(api!.lane, "a-only", "loading keeps the lane");
  ui.update(h(Harness, { inScope: ["b-only", "shared"] }));
  assert.equal(api!.lane, "");
  assert.equal(api!.step, "plan");
  assert.equal(left, 1);
  api!.setLane("shared");
  api!.setStep("lane");
  ui.update(h(Harness, { inScope: ["shared"] }));
  assert.equal(api!.lane, "shared", "a shared lane stays open");
  assert.equal(api!.step, "lane");
});

test("026-14a a lane shared by two projects shows only the selected projects' leads", () => {
  const both = [project("a", repo("a")), project("b", repo("b"))];
  const lead = (id: string, name: string, state = "open") =>
    ({
      id,
      state,
      lanes: ["shared"],
      repositories: [repo(name)],
    }) as unknown as Lead;
  const leads = [
    lead("from-a", "a"),
    lead("from-b", "b"),
    lead("closed-a", "a", "dropped"),
  ];
  assert.deepEqual(
    planningLaneLeads(leads, "shared", both, ["a"]).map((item) => item.id),
    ["from-a"],
  );
  assert.deepEqual(
    planningLaneLeads(leads, "shared", both, ["b"]).map((item) => item.id),
    ["from-b"],
  );
  assert.deepEqual(
    planningLaneLeads(leads, "shared", both, []).map((item) => item.id),
    ["from-a", "from-b"],
  );
});

test("026-14a/14b rendered Planning: two selected projects show both plans, none shows all, compact opens the lane in a modal over the plan", async () => {
  const { ProjectSelector, usePlanningLane, useProjectScope } = await load();
  const { PlanningTab } = await import("../client/planning-panel");
  const { planningScopeLanes, scopedProjects } = await import(
    "../shared/project-scope"
  );
  const entry = (lane: string, horizon: "now" | "next" | "later" = "now") => ({
    lane,
    note: "",
    horizon,
  });
  const plan = (key: string, entries: ReturnType<typeof entry>[]) => ({
    project: key,
    version: 1,
    entries,
    author: null,
    createdAt: null,
  });
  const plans = [
    plan("consumer-b-v2", [entry("consumer-a"), entry("consumer-b")]),
    plan("project-a-accelerator", [
      entry("project-a-a"),
      entry("shared", "later"),
    ]),
    plan("other", [entry("other-a")]),
  ];
  const lanes = [
    "consumer-a",
    "consumer-b",
    "project-a-a",
    "shared",
    "other-a",
  ].map((key) => ({
    key,
    title: `Lane ${key}`,
    liveByPhase: {},
    lastActivityAt: null,
    repositories: [],
  }));
  const saves: Array<[string, string[]]> = [];
  function Harness({
    compact,
    storage,
  }: {
    compact: boolean;
    storage: ReturnType<typeof memory>;
  }) {
    const [scope, setScope] = useProjectScope(() => storage);
    const [edits, setEdits] = React.useState<
      Record<string, { entries: ReturnType<typeof entry>[]; version: number }>
    >({});
    const planning = usePlanningLane(
      planningScopeLanes(projects, scope.projects, plans as never, lanes),
    );
    return h(
      React.Fragment,
      null,
      h(ProjectSelector, {
        projects,
        tasks: [],
        leads: [],
        value: scope.projects,
        onChange: (keys) => setScope({ ...scope, projects: keys }),
        onOpenChange: () => {},
        compact: false,
        c,
      }),
      h(PlanningTab, {
        c,
        compact,
        projectActivity: recentProjectActivity(projects),
        busy: false,
        step: planning.step,
        onStep: planning.setStep,
        selectedLane: planning.lane,
        onOpenLane: (lane) => {
          planning.setLane(lane);
          planning.setStep("lane");
        },
        lanes: lanes as never,
        edits,
        sections: scopedProjects(projects, scope.projects).map((project) => ({
          project,
          latest: plans.find((item) => item.project === project.key) as never,
          saved: plans.find((item) => item.project === project.key) as never,
        })),
        onEdit: (project, edit) =>
          setEdits((all) => ({ ...all, [project]: edit })),
        onSave: (project, edit) =>
          saves.push([project, edit.entries.map((item) => item.lane)]),
        onCancel: (project) =>
          setEdits((all) =>
            Object.fromEntries(
              Object.entries(all).filter(([key]) => key !== project),
            ),
          ),
        lanePanel: h(
          "Text",
          { accessibilityLabel: "Open lane" },
          planning.lane,
        ),
      }),
    );
  }
  const fresh = () => {
    const storage = memory();
    storage.setItem(
      "nucleus:project-scope",
      JSON.stringify({ projects: [], statusFilter: true }),
    );
    return storage;
  };
  const sections = (ui: ReturnType<typeof mount>) =>
    ui.all(/^Plan for /).map((node) => node.props.accessibilityLabel);

  const wide = mount(h(Harness, { compact: false, storage: fresh() }));
  wide.press(/^Projects, /);
  wide.press(/^Project consumer-b-v2/);
  wide.press(/^Projects, /);
  wide.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  assert.deepEqual(
    sections(wide),
    [],
    "two projects: compact rows, none expanded",
  );
  assert.equal(wide.all(/^Project row /).length, 2);
  wide.press("Project row project-a-accelerator");
  wide.press("Project row consumer-b-v2");
  assert.deepEqual(
    sections(wide),
    ["Plan for consumer-b-v2"],
    "one expanded at a time",
  );
  assert.ok(
    wide.get("Planning lane"),
    "plan and lane columns side by side at the wide size",
  );
  wide.press("Edit consumer-b-v2 plan");
  // #896 puts lane-order controls behind the per-step Move disclosure.
  wide.press("Move Lane consumer-a in consumer-b-v2");
  wide.press("Move Lane consumer-a down");
  wide.press("Save consumer-b-v2 plan");
  assert.deepEqual(
    saves,
    [["consumer-b-v2", ["consumer-b", "consumer-a"]]],
    "each section saves its own plan",
  );
  assert.equal(wide.query("Save project-a-accelerator plan"), undefined);
  wide.press("Clear project selection");
  assert.equal(wide.all(/^Project row /).length, 3, "none means all");
  wide.press(/^Project consumer-b-v2/);
  wide.press(/^Projects, /);
  wide.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  wide.press(/^Project other/, { nativeEvent: { shiftKey: true } });
  wide.press(/^Project consumer-b-v2/, { nativeEvent: { shiftKey: true } });
  wide.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  assert.deepEqual(
    sections(wide),
    ["Plan for other"],
    "one project in scope shows its roadmap with no rows",
  );
  assert.equal(wide.query(/^Project row /), undefined);

  const compact = mount(h(Harness, { compact: true, storage: fresh() }));
  compact.press(/^Projects, /);
  compact.press(/^Project consumer-b-v2/);
  compact.press(/^Projects, /);
  compact.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  compact.press("Project row project-a-accelerator");
  assert.deepEqual(sections(compact), ["Plan for project-a-accelerator"]);
  assert.equal(
    compact.query("Planning lane"),
    undefined,
    "compact has no lane pane",
  );
  // Without a detail pane the lane opens in a modal over the plan (Tom, 2026-11-21).
  compact.press("Open lane shared");
  assert.ok(compact.get("Lane detail"), "the lane opens in a modal");
  assert.ok(compact.get("Planning plan"), "the plan stays beneath it");
  assert.equal(compact.text().includes("shared"), true);
  compact.press("Close lane");
  assert.deepEqual(
    sections(compact),
    ["Plan for project-a-accelerator"],
    "same expansion after back",
  );
  compact.press("Open lane project-a-a");
  compact.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  assert.equal(
    compact.query("Planning lane"),
    undefined,
    "a lane leaving the selection returns to the plan",
  );
  assert.deepEqual(sections(compact), ["Plan for consumer-b-v2"]);
});

test("Planning header carries no Park, Unpark, Delete or planner-missing suffix: they live in Settings → Projects", async () => {
  const { PlanningTab } = await import("../client/planning-panel");
  for (const project of [
    projects[1],
    { ...projects[0], owner: null, planner: null },
  ]) {
    const ui = mount(
      h(PlanningTab, {
        sections: [{ project }],
        lanes: [],
        edits: {},
        selectedLane: "",
        step: "plan",
        compact: false,
        busy: false,
        lanePanel: null,
        onStep: () => {},
        onOpenLane: () => {},
        onEdit: () => {},
        onSave: () => {},
        onCancel: () => {},
        c,
      }),
    );
    for (const verb of ["Delete", "Park", "Unpark"])
      assert.equal(
        ui.query(`${verb} ${project.name}`),
        undefined,
        `${verb} left Planning`,
      );
    assert.doesNotMatch(ui.text(), /planner missing/);
  }
});

test("chooser settings icon: closes the chooser and opens Settings at Projects; absent on a host without Settings", async () => {
  const { ProjectSelector } = await load();
  for (const compact of [false, true]) {
    let opened = 0;
    const ui = mount(
      h(ProjectSelector, {
        projects: [{ ...projects[0], owner: null }],
        tasks: [],
        leads: [],
        value: [],
        onChange: () => {},
        onOpenChange: () => {},
        onSettings: () => opened++,
        compact,
        c,
      }),
    );
    ui.press(/^Projects, /);
    const { control } = await import("../client/design");
    assert.equal(
      ui.get("Filter projects").props.style.flex,
      1,
      `${compact}: the search takes the row's remaining width`,
    );
    for (const label of ["Clear project selection", "Project settings"])
      assert.equal(
        ui.get(label).props.style.minWidth,
        control.height,
        `${compact}: ${label} is an icon control on the search's row`,
      );
    assert.equal(
      ui.query("Manage projects"),
      undefined,
      "Manage projects is gone",
    );
    ui.press("Project settings");
    assert.equal(opened, 1);
    assert.equal(
      ui.query("Project selector"),
      undefined,
      `${compact}: the chooser closes`,
    );
    const bare = mount(
      h(ProjectSelector, {
        projects,
        tasks: [],
        leads: [],
        value: [],
        onChange: () => {},
        onOpenChange: () => {},
        compact,
        c,
      }),
    );
    bare.press(/^Projects, /);
    assert.equal(bare.query("Project settings"), undefined);
    assert.ok(
      bare.get("Clear project selection"),
      "Clear stays usable on a host without Settings",
    );
  }
});

test("1476 rendered: a legacy filter-off preference opens as all projects and Clear restores them", async () => {
  const { ProjectSelector, useProjectScope } = await load();
  const storage = memory();
  storage.setItem(
    "nucleus:project-scope",
    JSON.stringify({ projects: ["other"], statusFilter: false }),
  );
  let seen: ProjectScope | null = null;
  const actions = {
    park: () => Promise.resolve(),
    unpark: () => Promise.resolve(),
    rename: () => Promise.resolve(),
  };
  function Harness() {
    const [scope, setScope] = useProjectScope(() => storage);
    seen = scope;
    return h(ProjectSelector, {
      projects,
      tasks: [],
      leads: [],
      value: scope.projects,
      onChange: (keys: string[]) => setScope({ projects: keys }),
      projectActions: actions,
      onOpenChange: () => {},
      compact: false,
      c,
    });
  }
  const ui = mount(h(Harness));
  const stored = () => JSON.parse(storage.getItem("nucleus:project-scope")!);
  // The stored switch's off state is no selection now, so the board opens showing every project.
  assert.deepEqual(seen, { projects: [] }, "opens as all projects");
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, All projects",
  );
  assert.deepEqual(
    stored(),
    { projects: [] },
    "the retired flag is rewritten on load",
  );
  assert.equal(ui.query("Enabled"), undefined, "the switch is retired");

  // A plain pick scopes the board at once, with no second switch to turn back on.
  ui.press(/^Projects, /);
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(seen, { projects: ["consumer-b-v2"] });
  assert.deepEqual(stored(), { projects: ["consumer-b-v2"] });

  // Clear empties the selection, restores every project and keeps the picker open.
  ui.press(/^Projects, /);
  ui.press("Clear project selection");
  assert.deepEqual(seen, { projects: [] });
  assert.deepEqual(stored(), { projects: [] });
  assert.ok(ui.get("Project selector"), "the picker stays open");

  // Shift-clearing the last project restores all projects too.
  ui.press(/^Project other/);
  assert.deepEqual(seen, { projects: ["other"] });
  ui.press(/^Projects, /);
  ui.press(/^Project other/, { nativeEvent: { shiftKey: true } });
  assert.deepEqual(
    seen,
    { projects: [] },
    "clearing the last key shows all projects",
  );
});

test("1476: the board's selector commits the selection it reports; the other scope entry points write it too", () => {
  const source = boardSource();
  assert.match(
    source,
    /onChange=\{\(projects\) => setScope\(\{ projects \}\)\}/,
  );
  // A lane's "Show plan" writes the same selection (Planning has no chooser of its own since 2026-11-21).
  assert.match(
    source,
    /const showLanePlan = \(project: string\) => \{\s*setScope\(\{ projects: \[project\] \}\);/,
  );
});

test("1529 rendered: the picker lists each group by task count, then last activity, then name, in the popover and the modal", async () => {
  const { ProjectSelector } = await load();
  const now = Date.parse("2026-11-22T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const tasks = [
    { repository: "owner/other", repoPath: "/other", phase: "working" },
    { repository: "owner/other", repoPath: "/other", phase: "working" },
    { repository: "owner/consumer", repoPath: "/consumer", phase: "working" },
  ] as unknown as TaskSummary[];
  const activity = ["other", "consumer-b-v2"].map((key) => ({
    key,
    items: [
      { id: `${key}-a`, at: iso(now - 1000), executing: false },
      { id: `${key}-b`, at: iso(now - 1000), executing: false },
    ],
  }));
  const order = [
    "Project other, 2 tasks",
    "Project consumer-b-v2, 1 tasks",
    "Project project-a-accelerator, 0 tasks",
  ];
  // The wide and medium headers share the popover; the narrow header opens the modal.
  for (const compact of [false, true]) {
    const ui = mount(
      h(ProjectSelector, {
        projects,
        tasks,
        leads: [],
        projectActivity: activity,
        value: [],
        onChange: () => {},
        onOpenChange: () => {},
        compact,
        c,
      }),
    );
    ui.press(/^Projects, /);
    assert.ok(ui.get("Project selector"));
    assert.equal(
      ui.ofType("Modal").length,
      compact ? 1 : 0,
      compact ? "a modal at the narrow size" : "a popover at the wide size",
    );
    assert.deepEqual(
      ui
        .all(/^Project /)
        .filter((node) => node.props.accessibilityRole === "checkbox")
        .map((node) => node.props.accessibilityLabel),
      order,
      compact
        ? "the modal keeps the row order"
        : "the popover keeps the row order",
    );
  }
});
