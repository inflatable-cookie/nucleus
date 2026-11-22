import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import {
  defaultProjectScope,
  effectiveSelection,
  isAdditivePress,
  planningScopeLanes,
  projectHasRepository,
  projectSelectorRows,
  readProjectScope,
  scopeContains,
  scopedProjects,
  selectionLabel,
  selectProject,
  toggleProject,
  writeProjectScope,
} from "../shared/project-scope";
import type { Project } from "../shared/contracts";

const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (
  key: string,
  name: string,
  ...repos: ReturnType<typeof repo>[]
): Project => ({
  key,
  name,
  version: 1,
  visibility: "active",
  repositories: repos,
  primary: repos[0],
  drain: null,
});
const consumer = project(
  "consumer-b-v2",
  "consumer-b-v2",
  repo("consumer"),
  repo("consumer-web"),
);
const projectA = project(
  "project-a-accelerator",
  "project-a-accelerator",
  repo("project-a"),
);
const other = project("other", "Other", repo("other"));
const projects = [other, projectA, consumer];

test("026-14b two selected projects scope every view to both; none means all", () => {
  const both = ["consumer-b-v2", "project-a-accelerator"];
  const contains = scopeContains(projects, both);
  assert.equal(
    contains("/consumer-web", "owner/consumer-web"),
    true,
    "a second repository of a selected project is in scope",
  );
  assert.equal(contains("/project-a", null), true);
  assert.equal(contains("/other", "owner/other"), false);
  assert.deepEqual(
    scopedProjects(projects, both).map((item) => item.key),
    ["consumer-b-v2", "project-a-accelerator"],
    "Planning shows both plans",
  );
  const all = scopeContains(projects, []);
  assert.equal(all("/other", "owner/other"), true);
  assert.deepEqual(
    scopedProjects(projects, []).map((item) => item.key),
    ["consumer-b-v2", "other", "project-a-accelerator"],
  );
  assert.equal(selectionLabel(projects, []), "All projects");
  assert.equal(selectionLabel(projects, ["other"]), "Other");
  assert.equal(selectionLabel(projects, both), "2 projects");
});

test("Spec 027 #11 selector Parked section and All projects view hide parked while a selected parked project remains reachable", () => {
  const parked = { ...projectA, visibility: "parked" as const, version: 2 };
  const all = [other, parked, consumer];
  assert.deepEqual(
    projectSelectorRows(all, [], "", [], []).map((row) => [
      row.key,
      row.visibility,
    ]),
    [
      ["consumer-b-v2", "active"],
      ["other", "active"],
      ["project-a-accelerator", "parked"],
    ],
  );
  assert.deepEqual(
    scopedProjects(all, []).map((project) => project.key),
    ["consumer-b-v2", "other"],
  );
  assert.equal(scopeContains(all, [])("/project-a", "owner/project-a"), false);
  assert.equal(
    scopeContains(all, ["project-a-accelerator"])(
      "/project-a",
      "owner/project-a",
    ),
    true,
  );
  assert.deepEqual(
    scopedProjects(all, ["project-a-accelerator"]).map(
      (project) => project.key,
    ),
    ["project-a-accelerator"],
  );
});

test("026-14b a stale selected key is ignored rather than hiding everything", () => {
  assert.deepEqual(effectiveSelection(projects, ["gone"]), []);
  assert.equal(
    scopeContains(projects, ["gone"])("/other", "owner/other"),
    true,
  );
  assert.deepEqual(
    effectiveSelection([], ["gone"]),
    ["gone"],
    "kept until projects load",
  );
});

test("026-14b an empty selection shows every project; clearing the last project restores them", () => {
  assert.deepEqual(
    scopedProjects(projects, []).map((p) => p.key),
    ["consumer-b-v2", "other", "project-a-accelerator"],
  );
  assert.deepEqual(
    scopedProjects(
      projects,
      toggleProject(
        projects.map((p) => p.key),
        "other",
      ),
    ).map((p) => p.key),
    ["consumer-b-v2", "project-a-accelerator"],
    "a Shift-press toggles one project",
  );
  assert.deepEqual(
    scopedProjects(projects, toggleProject(["consumer-b-v2"], "consumer-b-v2")),
    scopedProjects(projects, []),
    "clearing the last project shows all projects",
  );
  assert.deepEqual(
    selectProject([], "other"),
    ["other"],
    "a plain press replaces the selection",
  );
  assert.deepEqual(selectProject(["consumer-b-v2"], "other"), ["other"]);
  assert.deepEqual(
    selectProject(["consumer-b-v2"], "consumer-b-v2"),
    ["consumer-b-v2"],
    "pressing the sole selected project keeps it selected",
  );
});

test("026-14b the selector lists every project with filter, primary repository, counts and checkboxes", () => {
  const tasks = [
    {
      repository: "owner/consumer-web",
      repoPath: "/consumer-web",
      phase: "working",
    },
    { repository: "owner/consumer", repoPath: "/consumer", phase: "done" },
  ] as Parameters<typeof projectSelectorRows>[3];
  const leads = [
    {
      id: "l1",
      title: "L1",
      state: "open",
      lanes: [],
      repositories: [repo("project-a")],
    },
  ] as Parameters<typeof projectSelectorRows>[4];
  const rows = projectSelectorRows(
    projects,
    ["project-a-accelerator"],
    "",
    tasks,
    leads,
  );
  assert.deepEqual(
    rows.map((row) => [
      row.key,
      row.primary,
      row.tasks,
      row.leads,
      row.checked,
    ]),
    [
      ["consumer-b-v2", "owner/consumer", 1, 0, false],
      ["other", "owner/other", 0, 0, false],
      ["project-a-accelerator", "owner/project-a", 0, 1, true],
    ],
  );
  assert.deepEqual(
    projectSelectorRows(projects, [], "PROJECT-A", tasks, leads).map(
      (row) => row.key,
    ),
    ["project-a-accelerator"],
  );
  assert.deepEqual(toggleProject(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleProject(["a", "b"], "a"), ["b"]);
});

test("1426 selector totals include every live phase and hidden queued tasks across member repositories", () => {
  const multiRepo = project("multi", "Multi", repo("multi-a"), repo("multi-b"));
  const empty = project("empty", "Empty", repo("empty"));
  const tasks = [
    {
      id: "q1",
      repository: "owner/multi-a",
      repoPath: "/multi-a",
      phase: "queued",
    },
    {
      id: "working",
      repository: "owner/multi-a",
      repoPath: "/multi-a",
      phase: "working",
    },
    {
      id: "review",
      repository: "owner/multi-b",
      repoPath: "/multi-b",
      phase: "awaiting_review",
    },
    {
      id: "closing",
      repository: "owner/multi-b",
      repoPath: "/multi-b",
      phase: "merging",
    },
    {
      id: "done",
      repository: "owner/multi-a",
      repoPath: "/multi-a",
      phase: "done",
    },
    {
      id: "cancelled",
      repository: "owner/multi-b",
      repoPath: "/multi-b",
      phase: "cancelled",
    },
  ] as Parameters<typeof projectSelectorRows>[3];
  const rows = projectSelectorRows(
    [multiRepo, empty],
    ["empty"],
    "",
    tasks,
    [
      {
        id: "lead",
        title: "Lead",
        state: "open",
        lanes: [],
        repositories: [repo("multi-a")],
      },
      {
        id: "papercut",
        title: "Papercut",
        state: "open",
        lanes: [],
        repositories: [repo("multi-b")],
        tags: ["papercut"],
      },
    ] as Parameters<typeof projectSelectorRows>[4],
    [
      { repoPath: "/multi-a", count: 3 },
      { repoPath: "/multi-b", count: 2 },
    ],
  );
  assert.deepEqual(
    rows.map(({ key, tasks: count, leads: leadCount }) => [
      key,
      count,
      leadCount,
    ]),
    [
      ["multi", 8, 2],
      ["empty", 0, 0],
    ],
    "four rendered live tasks plus four hidden queued tasks; terminal tasks and non-task cards do not affect the task total",
  );
  assert.equal(rows[0].checked, false, "totals are independent of selection");
});

test("1421 single-select by default: a plain press replaces, Shift toggles one project", () => {
  assert.deepEqual(selectProject([], "a"), ["a"], "empty selects one");
  assert.deepEqual(
    selectProject(["a"], "b"),
    ["b"],
    "a single selection is replaced",
  );
  assert.deepEqual(
    selectProject(["a", "b"], "c"),
    ["c"],
    "a multi-project selection is replaced",
  );
  assert.deepEqual(
    selectProject(["a"], "a"),
    ["a"],
    "the sole selected project stays selected",
  );
  assert.deepEqual(
    toggleProject(["a"], "b"),
    ["a", "b"],
    "Shift adds through the toggle path",
  );
  assert.deepEqual(
    toggleProject(["a", "b"], "a"),
    ["b"],
    "Shift removes through the toggle path",
  );
  assert.equal(isAdditivePress(undefined), false, "touch carries no event");
  assert.equal(isAdditivePress({}), false, "a plain press carries no modifier");
  assert.equal(isAdditivePress({ shiftKey: false }), false);
  assert.equal(isAdditivePress({ nativeEvent: { shiftKey: false } }), false);
  assert.equal(isAdditivePress({ nativeEvent: null }), false);
  assert.equal(
    isAdditivePress({ shiftKey: true }),
    true,
    "React Native Web exposes Shift at the top level",
  );
  assert.equal(
    isAdditivePress({ nativeEvent: { shiftKey: true } }),
    true,
    "React Native nests the DOM event under nativeEvent",
  );
});

test("026-14b the selection persists in local storage, else for the session", () => {
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  const scope = {
    projects: ["consumer-b-v2", "project-a-accelerator"],
  };
  writeProjectScope(storage, scope);
  assert.deepEqual(readProjectScope(storage), scope);
  assert.equal(
    JSON.parse(items.get("nucleus:project-scope")!).statusFilter,
    undefined,
    "only the selection is stored (nucleus#1476)",
  );
  assert.deepEqual(
    readProjectScope(undefined),
    scope,
    "no storage keeps the session copy",
  );
  items.set("northstar-queue:project-scope", "{broken");
  assert.deepEqual(readProjectScope(storage), scope);
  writeProjectScope(undefined, defaultProjectScope);
  assert.deepEqual(readProjectScope(undefined), defaultProjectScope);
});

test("1476: a legacy statusFilter=false selection opens as all projects; an active one is kept", () => {
  const stored = (value: unknown) => {
    const items = new Map<string, string>([
      ["nucleus:project-scope", JSON.stringify(value)],
    ]);
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
  };
  assert.deepEqual(
    readProjectScope(
      stored({ projects: ["consumer-b-v2"], statusFilter: false }),
    ),
    { projects: [] },
    "the retired switch's off state is no selection, so every project shows",
  );
  assert.deepEqual(
    readProjectScope(
      stored({ projects: ["consumer-b-v2"], statusFilter: true }),
    ),
    { projects: ["consumer-b-v2"] },
    "an active stored selection is kept",
  );
  assert.deepEqual(
    readProjectScope(stored({ projects: ["consumer-b-v2"] })),
    { projects: ["consumer-b-v2"] },
    "the shape without the retired field reads as a selection",
  );
  assert.deepEqual(
    readProjectScope(stored({ projects: [], statusFilter: false })),
    { projects: [] },
  );
});

test("026-14b project scope migrates the old local key once and uses the Nucleus key after", () => {
  const items = new Map<string, string>([
    [
      "northstar-queue:project-scope",
      JSON.stringify({
        projects: ["project-a-accelerator"],
        statusFilter: true,
      }),
    ],
  ]);
  const reads = new Map<string, number>();
  const storage = {
    getItem: (key: string) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return items.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  assert.deepEqual(readProjectScope(storage), {
    projects: ["project-a-accelerator"],
  });
  assert.equal(items.has("northstar-queue:project-scope"), false);
  assert.deepEqual(JSON.parse(items.get("nucleus:project-scope")!), {
    projects: ["project-a-accelerator"],
  });
  assert.deepEqual(readProjectScope(storage), {
    projects: ["project-a-accelerator"],
  });
  assert.equal(reads.get("northstar-queue:project-scope"), 1);
});

test("1476: the old key's statusFilter=false migrates to all projects", () => {
  const items = new Map<string, string>([
    [
      "northstar-queue:project-scope",
      JSON.stringify({
        projects: ["project-a-accelerator"],
        statusFilter: false,
      }),
    ],
  ]);
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  assert.deepEqual(readProjectScope(storage), { projects: [] });
  assert.deepEqual(JSON.parse(items.get("nucleus:project-scope")!), {
    projects: [],
  });
});

test("026-14a Planning lanes in scope: selected plans plus lanes listing a selected repository", () => {
  const plans = [
    {
      project: "consumer-b-v2",
      version: 1,
      entries: [{ lane: "consumer-plan", note: "", horizon: "now" }],
    },
    {
      project: "other",
      version: 1,
      entries: [{ lane: "other-plan", note: "", horizon: "now" }],
    },
  ] as Parameters<typeof planningScopeLanes>[2];
  const lanes = [
    { key: "project-a-lane", repositories: [repo("project-a")] },
    { key: "other-lane", repositories: [repo("other")] },
  ];
  assert.deepEqual(
    planningScopeLanes(
      projects,
      ["consumer-b-v2", "project-a-accelerator"],
      plans,
      lanes,
    ),
    ["consumer-plan", "project-a-lane"],
  );
  assert.deepEqual(planningScopeLanes(projects, [], plans, lanes), [
    "consumer-plan",
    "other-plan",
    "project-a-lane",
    "other-lane",
  ]);
});

test("026-14b one header selector scopes every view through the selection alone", () => {
  const ui = boardSource();
  const controls = readFileSync(
    new URL("../client/project-scope-controls.tsx", import.meta.url),
    "utf8",
  );
  // Cutover 7 (PR 850) reformatted the board and routed papercut/lead cards
  // through the shared BoardCard; the selector stays one instance in the header
  // guard across the four views.
  assert.equal(
    ui.match(/<ProjectSelector\b/g)?.length,
    1,
    "one selector in the header",
  );
  // The inbox header shows the selector for every view (Tom, 2026-11-21).
  assert.match(ui, /const filter = \(\s*<ProjectSelector/);
  assert.match(ui, /filter=\{filter\}/);
  assert.match(
    ui,
    /const selection = effectiveSelection\(state\?\.projects \?\? \[\], scope\.projects\)/,
    "stale keys drop out for every view",
  );
  assert.match(
    ui,
    /const selection = effectiveSelection\(state\?\.projects \?\? \[\], scope\.projects\);/,
    "the selection scopes every view",
  );
  assert.match(
    ui,
    /useInboxBoard\(\{\s*state,\s*selection,/,
    "the inbox projection receives the selection",
  );
  assert.match(ui, /pipelineBoard\(\{[\s\S]{0,200}selection,/, "the one projection reads it");
  assert.match(
    ui,
    /lanes=\{state\?\.lanes \?\? \[\]\}/,
    "Planning receives the lanes the finder searches",
  );
  assert.match(
    ui,
    /selection=\{scope\.projects\}/,
    "Planning reads the one project scope",
  );
  assert.match(
    ui,
    /const kind = triageKind\(lead\)/,
    "Pipeline Triage classifies each lead through the shared helper",
  );
  assert.match(
    ui,
    /kind === "papercut" \? onSelectPapercut\(lead\.id\)/,
    "the classified kind routes papercuts to their detail modal",
  );
  assert.match(ui, /const planningProjects = effectiveSelection/, "Planning");
  assert.match(
    ui,
    /planningLaneLeads\(\s*boardLeads,\s*planningLane,\s*state\?\.projects \?\? \[\],/,
    "Planning lane leads",
  );
  assert.match(ui, /usePlanningLane\(planningInScope,/);
  assert.match(
    ui,
    /<ProjectSelector\s+projects=\{state\?\.projects \?\? \[\]\}/,
    "the selector holds the selection, with no second filter switch",
  );
  assert.doesNotMatch(
    ui,
    /<ProjectFilterSwitch|statusFilter/,
    "no switch on the board and no retired flag",
  );
  assert.doesNotMatch(
    controls,
    /ProjectFilterSwitch|accessibilityLabel="Enabled"|statusFilter/,
    "the switch and its stored flag are retired (nucleus#1476)",
  );
  assert.match(controls, /writeProjectScope\(storage\(\), scope\)/);
  assert.doesNotMatch(ui, /projectFilter/);
});

test("repository matching prefers origin and falls back to path only when needed", () => {
  assert.equal(
    projectHasRepository(consumer, "/consumer", "owner/other"),
    false,
  );
  assert.equal(
    projectHasRepository(consumer, "/elsewhere", "owner/consumer"),
    true,
  );
  assert.equal(projectHasRepository(consumer, "/consumer", null), true);
  assert.equal(projectHasRepository(consumer, "", null), false);
});

test("1529 the selector keeps active projects first, then Dormant, then Parked, ordering each group by task count, last activity and name", () => {
  const NOW = Date.parse("2026-11-22T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const live = (id: string, path: string) => ({
    id,
    repository: `owner${path}`,
    repoPath: path,
    phase: "working",
  });
  const seen = (key: string, at: number) => ({
    key,
    items: [
      { id: `${key}-a`, at: iso(at), executing: false },
      { id: `${key}-b`, at: iso(at), executing: false },
    ],
  });
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const alpha = project("alpha", "Alpha", repo("alpha"));
  const zeta = project("zeta", "Zeta", repo("zeta"));
  const mid = project("mid", "Mid", repo("mid"));
  const beta = project("beta", "Beta", repo("beta"));
  const gamma = project("gamma", "Gamma", repo("gamma"));
  const parkedHigh = {
    ...project("parked-high", "Parked high", repo("parked-high")),
    visibility: "parked" as const,
  };
  const parkedLow = {
    ...project("parked-low", "Parked low", repo("parked-low")),
    visibility: "parked" as const,
  };
  const tasks = [
    live("a1", "/alpha"),
    live("z1", "/zeta"),
    live("m1", "/mid"),
    live("m2", "/mid"),
    live("m3", "/mid"),
    ...["p1", "p2", "p3", "p4", "p5"].map((id) => live(id, "/parked-high")),
  ] as Parameters<typeof projectSelectorRows>[3];
  const activity = [
    seen("alpha", NOW - HOUR),
    seen("zeta", NOW - DAY),
    seen("parked-high", NOW - HOUR),
    seen("parked-low", NOW - HOUR),
  ] as Parameters<typeof projectSelectorRows>[6];
  const rows = projectSelectorRows(
    [gamma, parkedLow, mid, zeta, beta, parkedHigh, alpha],
    [],
    "",
    tasks,
    [],
    [],
    activity,
    NOW,
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.tasks, row.dormant]),
    [
      ["alpha", 1, false],
      ["zeta", 1, false],
      ["mid", 3, true],
      ["beta", 0, true],
      ["gamma", 0, true],
      ["parked-high", 5, false],
      ["parked-low", 0, false],
    ],
    "count decides inside a group, then newest activity, then name; " +
      "a dormant project with more tasks still sorts below every active one, " +
      "and parked projects stay last",
  );
});

test("1529 held-back queued tasks count toward the selector order", () => {
  const NOW = Date.parse("2026-11-22T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const qa = project("qa", "Qa", repo("qa"));
  const qb = project("qb", "Qb", repo("qb"));
  const tasks = [
    { id: "b1", repository: "owner/qb", repoPath: "/qb", phase: "working" },
    { id: "b2", repository: "owner/qb", repoPath: "/qb", phase: "working" },
  ] as Parameters<typeof projectSelectorRows>[3];
  const activity = [qa, qb].map((item) => ({
    key: item.key,
    items: [
      { id: `${item.key}-a`, at: iso(NOW - 1000), executing: false },
      { id: `${item.key}-b`, at: iso(NOW - 1000), executing: false },
    ],
  })) as Parameters<typeof projectSelectorRows>[6];
  const rows = projectSelectorRows([qb, qa], [], "", tasks, [], [{ repoPath: "/qa", count: 3 }], activity, NOW);
  assert.deepEqual(
    rows.map((row) => [row.key, row.tasks]),
    [
      ["qa", 3],
      ["qb", 2],
    ],
    "hidden queued work outranks rendered tasks in the order",
  );
});
