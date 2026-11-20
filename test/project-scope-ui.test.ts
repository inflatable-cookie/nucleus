import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import React from "react";
import { mount, useNativeStubs } from "./support/render";
import {
  pickProjects,
  pipelineSelection,
  planningLaneLeads,
  type ProjectScope,
} from "../shared/project-scope";
import type { Lead, Project, ProjectQaRun } from "../shared/contracts";

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
        onChange: (keys) => setScope({ ...scope, projects: keys }),
        enabled: scope.statusFilter,
        onEnabledChange: (statusFilter) => setScope({ ...scope, statusFilter }),
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
  assert.equal(ui.get(/^Project other/).props.accessibilityState.checked, false);
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

test("026-14b rendered: single-select, clear to all, and the selector's Enabled switch keeps the selection", async () => {
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
        onChange: (keys) => setScope({ ...scope, projects: keys }),
        enabled: scope.statusFilter,
        onEnabledChange: (statusFilter) => setScope({ ...scope, statusFilter }),
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
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(seen!.projects, ["consumer-b-v2"]);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, consumer-b-v2",
  );
  // Shift-click builds the multi-project selection the switch test needs.
  ui.press(/^Projects, /);
  ui.press(/^Project project-a-accelerator/, {
    nativeEvent: { shiftKey: true },
  });
  assert.deepEqual(seen!.projects, ["consumer-b-v2", "project-a-accelerator"]);
  assert.equal(
    ui.get(/^Project consumer-b-v2/).props.accessibilityState.checked,
    true,
  );
  assert.equal(ui.get(/^Project other/).props.accessibilityState.checked, false);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, 2 projects",
  );

  assert.equal(
    ui.get("Enabled").props.accessibilityState.checked,
    true,
    "the switch sits in the open selector",
  );
  ui.press("Enabled");
  assert.equal(ui.get("Enabled").props.accessibilityState.checked, false);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, 2 projects · filter off",
    "the closed label says filtering is off",
  );
  assert.deepEqual(
    pipelineSelection(seen!),
    [],
    "every scoped view shows every project",
  );
  assert.deepEqual(
    seen!.projects,
    ["consumer-b-v2", "project-a-accelerator"],
    "the selection is kept",
  );
  ui.press("Enabled");
  assert.deepEqual(
    pipelineSelection(seen!),
    ["consumer-b-v2", "project-a-accelerator"],
    "on restores it",
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
  ui.press("Clear project selection");
  assert.deepEqual(seen!.projects, []);
  assert.equal(
    ui.get(/^Projects, /).props.accessibilityLabel,
    "Projects, All projects",
    "none means all",
  );
  ui.press("Select all projects");
  assert.deepEqual(seen!.projects, [
    "consumer-b-v2",
    "project-a-accelerator",
    "other",
  ]);
  assert.match(
    storage.getItem("nucleus:project-scope")!,
    /"statusFilter":true/,
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
  ui.press("Close project selector");
  assert.equal(ui.query("Project selector"), undefined);
  assert.equal(ui.ofType("Modal").length, 0);
});

test("Spec 027 #11 rendered selector lists parked projects under Parked for scoping, with no Unpark; Planning groups parked projects", async () => {
  const { ProjectSelector } = await load();
  const parked = { ...projects[1], visibility: "parked" as const, version: 3 };
  const all = [projects[0], parked, projects[2]];
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
  assert.ok(ui.get("Parked"));
  assert.equal(
    ui.query("Unpark project-a-accelerator"),
    undefined,
    "unpark lives in Settings → Projects",
  );
  ui.press(/^Project project-a-accelerator/);
  assert.deepEqual(
    chosen,
    [["project-a-accelerator"]],
    "a parked project can still be scoped",
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

test("Spec 035/022 rendered: Planning carries no QA launch or cancel, and links the plan to the shared QA detail", async () => {
  const { PlanningTab } = await import("../client/planning-panel");
  const run = {
    id: "qa-run-1",
    key: "owner/consumer",
    repository: { origin: "owner/consumer", path: "/consumer" },
    state: "running",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    exitCode: null,
    durationMs: 0,
    outputTail: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: 4242,
    admission: null,
    capacityWait: null,
    capacityUnavailable: false,
    steps: [],
    failedStep: null,
    interruptedStep: null,
    hostSettlement: null,
    escapedDescendants: [],
    cancelReason: null,
    logWriteErrors: [],
  } as ProjectQaRun;
  const opened: string[] = [];
  const ui = mount(
    h(PlanningTab, {
      sections: [{ project: projects[0] }],
      lanes: [],
      edits: {},
      selectedLane: "",
      step: "plan",
      compact: false,
      busy: false,
      lanePanel: null,
      qaRuns: [run],
      qaFenced: true,
      onOpenQaRun: (id: string) => opened.push(id),
      onCancelQa: () => {
        throw new Error("Planning must not cancel QA");
      },
      onRunQa: () => {
        throw new Error("Planning must not launch QA");
      },
      onStep: () => {},
      onOpenLane: () => {},
      onEdit: () => {},
      onSave: () => {},
      onCancel: () => {},
      c,
    } as never),
  );
  assert.equal(
    ui.query("Run full QA for consumer-b-v2 on current main"),
    undefined,
    "launching QA lives in the QA runs tab only",
  );
  assert.equal(
    ui.query("Cancel full QA for consumer-b-v2"),
    undefined,
    "cancelling QA lives in the QA runs tab only",
  );
  assert.match(ui.text(), /Latest QA/, "the plan keeps one compact result");
  ui.press("View the latest QA run for consumer-b-v2");
  assert.deepEqual(opened, ["qa-run-1"], "the link opens the shared QA detail");
});

test("Spec 022 rendered: Planning links a settled teardown failure to its QA run; the retry lives in the QA runs tab", async () => {
  const { ProjectQaLatest } = await import("../client/planning-panel");
  const run = {
    id: "qa-run-2",
    key: "owner/consumer",
    repository: { origin: "owner/consumer", path: "/consumer" },
    state: "hold",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    exitCode: 0,
    durationMs: 100,
    outputTail: "teardown failed",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: null,
    admission: null,
    capacityWait: null,
    capacityUnavailable: false,
    steps: [],
    failedStep: "teardown",
    interruptedStep: null,
    hostSettlement: null,
    escapedDescendants: [],
    cancelReason: null,
    logWriteErrors: [],
  } as ProjectQaRun;
  const opened: string[] = [];
  const ui = mount(
    h(ProjectQaLatest, {
      project: projects[0],
      runs: [run],
      onOpenRun: (id: string) => opened.push(id),
      c,
    } as never),
  );
  assert.equal(
    ui.query("Retry teardown for consumer-b-v2"),
    undefined,
    "Planning no longer carries the teardown retry",
  );
  ui.press("View the latest QA run for consumer-b-v2");
  assert.deepEqual(opened, ["qa-run-2"]);
  const passed = { ...run, state: "passed", failedStep: null } as ProjectQaRun;
  const other = mount(
    h(ProjectQaLatest, { project: projects[0], runs: [passed], c } as never),
  );
  assert.match(other.text(), /Passed/, "a passed run reads as passed");
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

test("026-14a/14b rendered Planning: two selected projects show both plans, none shows all, compact drills plan to lane and back", async () => {
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
    "compact shows one step",
  );
  compact.press("Open lane shared");
  assert.equal(compact.query("Planning plan"), undefined);
  assert.equal(compact.text().includes("shared"), true);
  compact.press("Back to plan");
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
    { ...projects[1], visibility: "parked" as const, version: 3 },
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

test("121 rendered: milestone QA stages render as named steps, and the task and QA runs surfaces receive them", async () => {
  const { ProjectQaSteps } = await import("../client/planning-panel");
  const step = (name: string, exitCode: number, timedOut = false) => ({
    name,
    command: `effigy ${name}`,
    exitCode,
    signal: null,
    timedOut,
    stdoutHead: "",
    stdoutTail: "",
    stderrHead: "",
    stderrTail: "",
    stdoutLogPath: null,
    stderrLogPath: null,
    stdoutBytes: 0,
    stderrBytes: 0,
  });
  const run = {
    id: "qa-1",
    key: "owner/consumer",
    repository: { origin: "owner/consumer", path: "/consumer" },
    state: "failed",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    exitCode: 7,
    durationMs: 10,
    outputTail: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: null,
    admission: null,
    capacityWait: null,
    capacityUnavailable: false,
    steps: [step("compile", 0), step("test", 7)],
    stages: [
      { name: "compile", argv: ["effigy", "compile"], timeoutMs: 1000 },
      { name: "test", argv: ["effigy", "test"], timeoutMs: 1000 },
    ],
    failedStep: "test",
    interruptedStep: null,
    hostSettlement: null,
    escapedDescendants: [],
    cancelReason: null,
    logWriteErrors: [],
  } as ProjectQaRun;
  const ui = mount(h(ProjectQaSteps, { run, c }));
  const rendered = ui.text();
  assert.match(
    rendered,
    /compile · passed/,
    "the passing compile stage renders as a named step",
  );
  assert.match(
    rendered,
    /test · exit 7/,
    "the failing test stage renders as a named step",
  );
  // The task detail receives its project QA row; the QA runs tab joins host and project QA reads.
  const source = boardSource();
  // PR #518's TypeScript formatting puts each JSX prop on its own line.
  assert.match(
    source,
    /<QaRunsTab\s+focusRunId=\{qaFocusId\}\s+runs=\{hostRunQuery\.data\}\s+qaRuns=\{qaQuery\.data\}/,
    "the QA runs tab joins host and milestone records",
  );
  assert.match(
    source,
    /title="Milestone QA"/,
    "the task detail renders the repository milestone QA",
  );
  assert.match(
    source,
    /<ProjectQaSteps\s+run=\{taskQaRun\}/,
    "the task detail renders each stage as a step",
  );
  assert.match(
    source,
    /enabled:tab==="planning"\|\|tab==="qa"\|\|Boolean\(selected\)/,
    "the QA list loads for Planning, the QA tab and an open task",
  );
});

test("136 rendered: log-write failures show apart from the output on the task and QA-run detail surfaces", async () => {
  const { ProjectQaLogWriteErrors } = await import("../client/planning-panel");
  const run = {
    id: "qa-1",
    key: "owner/consumer",
    repository: { origin: "owner/consumer", path: "/consumer" },
    state: "failed",
    baseBranch: "main",
    base: "a".repeat(40),
    argv: ["effigy", "qa"],
    digest: "b".repeat(64),
    exitCode: 7,
    durationMs: 10,
    outputTail: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: null,
    admission: null,
    capacityWait: null,
    capacityUnavailable: false,
    steps: [],
    failedStep: "test",
    interruptedStep: null,
    hostSettlement: null,
    escapedDescendants: [],
    cancelReason: null,
    logWriteErrors: [
      { step: "compile", stream: "stdout", error: "disk full" },
      { step: "test", stream: "stderr", error: "permission denied" },
    ],
  } as ProjectQaRun;
  const ui = mount(h(ProjectQaLogWriteErrors, { run, c }));
  const rendered = ui.text();
  assert.match(rendered, /compile stdout log could not be written: disk full/);
  assert.match(
    rendered,
    /test stderr log could not be written: permission denied/,
  );
  assert.equal(
    mount(
      h(ProjectQaLogWriteErrors, {
        run: { ...run, logWriteErrors: [] } as ProjectQaRun,
        c,
      }),
    ).text(),
    "",
    "a run without failures renders nothing",
  );
  // The task detail and QA run detail both render the same component.
  const source = boardSource();
  assert.match(
    source,
    /<ProjectQaLogWriteErrors\s+run=\{taskQaRun\}/,
    "the task detail renders log-write failures",
  );
  const qaSource = readFileSync(
    new URL("../client/qa-runs-tab.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    qaSource,
    /<ProjectQaLogWriteErrors run=\{qa\}/,
    "the QA run detail renders log-write failures",
  );
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
  }
});

test("1432: an explicit nonempty pick turns a disabled filter back on; an empty pick keeps the switch", () => {
  const off: ProjectScope = { projects: ["other"], statusFilter: false };
  assert.deepEqual(pickProjects(off, ["consumer-b-v2"]), { projects: ["consumer-b-v2"], statusFilter: true });
  assert.deepEqual(pickProjects(off, []), { projects: [], statusFilter: false }, "None keeps it off");
  assert.deepEqual(pickProjects({ projects: ["other"], statusFilter: true }, []), { projects: [], statusFilter: true });
});

test("1432 rendered: plain, Shift and All picks while the filter is off turn it on and persist both; None, clearing the last key, opening and disclosure leave it", async () => {
  const { ProjectSelector, useProjectScope } = await load();
  const storage = memory();
  storage.setItem("nucleus:project-scope", JSON.stringify({ projects: ["other"], statusFilter: false }));
  let seen: ProjectScope | null = null;
  let setScopeRef: ((scope: ProjectScope) => void) | null = null;
  const actions = {
    park: () => Promise.resolve(),
    unpark: () => Promise.resolve(),
    rename: () => Promise.resolve(),
  };
  function Harness() {
    const [scope, setScope] = useProjectScope(() => storage);
    seen = scope;
    setScopeRef = setScope;
    // The board's wiring (client/queue.tsx): one scope value carries the keys and the switch.
    return h(ProjectSelector, {
      projects,
      tasks: [],
      leads: [],
      value: scope.projects,
      onChange: (keys: string[]) => setScope(pickProjects(scope, keys)),
      enabled: scope.statusFilter,
      onEnabledChange: (statusFilter: boolean) => setScope({ ...scope, statusFilter }),
      projectActions: actions,
      onOpenChange: () => {},
      compact: false,
      c,
    });
  }
  const ui = mount(h(Harness));
  const stored = () => JSON.parse(storage.getItem("nucleus:project-scope")!);
  const current = (): ProjectScope => seen!;
  const turnOff = () => setScopeRef!({ ...current(), statusFilter: false });

  // Opening, disclosure and rename leave the switch off.
  ui.press(/^Projects, /);
  ui.press("Project actions for consumer-b-v2");
  ui.press("Rename consumer-b-v2");
  ui.press("Cancel rename of consumer-b-v2");
  assert.equal(current().statusFilter, false);
  assert.equal(ui.get("Enabled").props.accessibilityState.checked, false);

  // A plain pick turns it on with the new key, persisted together.
  ui.press(/^Project consumer-b-v2/);
  assert.deepEqual(current(), { projects: ["consumer-b-v2"], statusFilter: true });
  assert.deepEqual(stored(), { projects: ["consumer-b-v2"], statusFilter: true });
  assert.deepEqual(pipelineSelection(current()), ["consumer-b-v2"], "the board filters at once");

  // Shift-adding while off turns it on.
  turnOff();
  ui.press(/^Projects, /);
  ui.press(/^Project other/, { nativeEvent: { shiftKey: true } });
  assert.deepEqual(current(), { projects: ["consumer-b-v2", "other"], statusFilter: true });

  // Shift-clearing down to nothing keeps the switch as it was.
  turnOff();
  ui.press(/^Project other/, { nativeEvent: { shiftKey: true } });
  assert.deepEqual(current(), { projects: ["consumer-b-v2"], statusFilter: true }, "a nonempty Shift-removal is a pick");
  turnOff();
  ui.press(/^Project consumer-b-v2/, { nativeEvent: { shiftKey: true } });
  assert.deepEqual(current(), { projects: [], statusFilter: false }, "clearing the last key keeps it off");

  // None keeps it off; All turns it on.
  ui.press("Clear project selection");
  assert.equal(current().statusFilter, false);
  ui.press("Select all projects");
  assert.equal(current().statusFilter, true);
  assert.deepEqual(stored().statusFilter, true);
});

test("1432: the board's selector commits picks through pickProjects; other scope entry points keep the switch", () => {
  const source = boardSource();
  assert.match(source, /onChange=\{\(projects\) => setScope\(pickProjects\(scope, projects\)\)\}/);
  assert.match(source, /const setScopeProjects = \(projects: string\[\]\) => setScope\(\{ \.\.\.scope, projects \}\);/);
  assert.match(source, /onSelectProjects=\{setScopeProjects\}/);
});
