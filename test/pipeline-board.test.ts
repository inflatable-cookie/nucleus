import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardSource } from "./support/board-source";
import {
  pipelineBoard,
  pipelineColumn,
  pipelineColumns,
  pipelinePhaseColumn,
  triageKind,
  triagePage,
  triagePageSize,
  triageState,
} from "../shared/pipeline-board";
import { taskSchema } from "../shared/contracts";

type Input = Parameters<typeof pipelineBoard>[0];
const repo = { origin: "owner/app", path: "/app" };
const project = {
  key: "app",
  name: "App",
  version: 1,
  visibility: "active" as const,
  repositories: [repo],
  primary: repo,
  drain: null,
};
const lane = (key: string) => ({
  key,
  title: key,
  aim: "Aim",
  status: "active",
  repositories: [repo],
  recentOutcomes: [],
});
const task = (id: string, lanes: string[], phase = "queued") => ({
  id,
  title: id,
  lanes,
  phase,
  repository: repo.origin,
  repoPath: repo.path,
});
const lead = (id: string, lanes: string[]) => ({
  id,
  title: id,
  state: "open",
  lanes,
  repositories: [repo],
  tags: [],
  targets: [],
  body: "Body",
  version: 1,
});
function boardInput(extra: Partial<Input> = {}): Input {
  return {
    projects: [project],
    lanes: [
      lane("first"),
      lane("second"),
      lane("empty"),
    ] as unknown as Input["lanes"],
    selection: ["app"],
    leads: [],
    tasks: [],
    pendingSubmissions: [],
    ...extra,
  };
}
function board(extra: Partial<Input> = {}) {
  return pipelineBoard(boardInput(extra));
}
const all = (view: ReturnType<typeof board>) =>
  pipelineColumns.flatMap((name) => view.cards[name]).map((card) => card.id);

test("026 columns fold papercuts into Triage; Spec 032 puts Decisions ahead of Attention", () => {
  assert.deepEqual(
    [...pipelineColumns],
    [
      "Triage",
      "Decisions",
      "Attention",
      "Queued",
      "Working",
      "Review",
      "Closing",
    ],
  );
});

test("026-13 every task phase lands in its mapped column; done and cancelled leave the board", () => {
  // Enumerate the phase enum so a new phase cannot fall through silently.
  const phases = [...taskSchema.shape.phase.options].sort();
  assert.deepEqual(phases, [
    "awaiting_review",
    "blocked",
    "cancelled",
    "changes_requested",
    "closing",
    "dispatching",
    "done",
    "error",
    "merging",
    "needs_attention",
    "queued",
    "report_ready",
    "reviewing",
    "syncing",
    "verifying",
    "working",
  ]);
  assert.deepEqual(
    Object.fromEntries(
      phases.map((phase) => [
        phase,
        pipelinePhaseColumn(phase as Parameters<typeof pipelinePhaseColumn>[0]),
      ]),
    ),
    {
      awaiting_review: "Review",
      blocked: "Attention",
      cancelled: "Closing",
      changes_requested: "Working",
      closing: "Closing",
      report_ready: "Review",
      dispatching: "Working",
      done: "Closing",
      error: "Attention",
      merging: "Closing",
      needs_attention: "Attention",
      queued: "Queued",
      reviewing: "Review",
      syncing: "Closing",
      verifying: "Closing",
      working: "Working",
    },
  );
  assert.equal(
    pipelineColumn({ kind: "lead", id: "lead", lanes: [], value: {} as never }),
    "Triage",
  );
  const live = phases.filter(
    (phase) => phase !== "done" && phase !== "cancelled",
  );
  const single = board({
    tasks: live.map((phase) => task(phase, [], phase)) as Input["tasks"],
  }).cards;
  assert.deepEqual(single.Attention.map((card) => card.id).sort(), [
    "blocked",
    "error",
    "needs_attention",
  ]);
  assert.deepEqual(
    single.Queued.map((card) => card.id),
    ["queued"],
  );
  assert.deepEqual(single.Working.map((card) => card.id).sort(), [
    "changes_requested",
    "dispatching",
    "working",
  ]);
  assert.deepEqual(single.Review.map((card) => card.id).sort(), [
    "awaiting_review",
    "report_ready",
    "reviewing",
  ]);
  assert.deepEqual(single.Closing.map((card) => card.id).sort(), [
    "closing",
    "merging",
    "syncing",
    "verifying",
  ]);
  const finished = board({
    tasks: [
      task("finished", [], "done"),
      task("dropped", [], "cancelled"),
    ] as Input["tasks"],
  });
  assert.deepEqual(
    all(finished),
    [],
    "finished and cancelled tasks leave the board",
  );
  assert.deepEqual(Object.values(finished.counts), [0, 0, 0, 0, 0, 0, 0]);
});

test("the board is one set of columns: each card once whatever its lane count, lanes kept on the card", () => {
  // Tom, 2026-11-08: the swim-lane view is retired; the board never splits by lane.
  const view = board({
    leads: [
      lead("lead", ["first", "second"]),
      { ...lead("cut", ["first", "second"]), tags: ["papercut"] },
    ] as unknown as Input["leads"],
    tasks: [
      task("shared", ["first", "second"]),
      task("unlaned", []),
    ] as Input["tasks"],
  });
  assert.deepEqual(all(view).sort(), ["cut", "lead", "shared", "unlaned"]);
  assert.equal(view.cards.Triage.length, 2);
  assert.equal(view.counts.Queued, 2, "a task in two lanes counts once");
  assert.deepEqual(
    view.cards.Queued.find((card) => card.id === "shared")!.lanes,
    ["first", "second"],
  );
  assert.deepEqual(Object.keys(view.counts), [...pipelineColumns]);
});

test("Spec 027 #11 All projects hides parked work but keeps attention visible", () => {
  const parked = { ...project, visibility: "parked" as const };
  const tasks = [
    task("running", ["first"], "working"),
    {
      ...task("blocked", ["first"], "blocked"),
      held: false,
      resolution: { attention: false },
    },
    {
      ...task("held", ["first"], "queued"),
      held: true,
      resolution: { attention: false },
    },
  ] as Input["tasks"];
  const everyone = board({ projects: [parked], selection: [], tasks });
  assert.deepEqual(
    everyone.cards.Working.map((card) => card.id),
    [],
  );
  assert.deepEqual(
    everyone.cards.Attention.map((card) => card.id),
    ["blocked"],
  );
  assert.deepEqual(
    everyone.cards.Queued.map((card) => card.id),
    ["held"],
  );
  const selected = board({ projects: [parked], selection: ["app"], tasks });
  assert.deepEqual(
    selected.cards.Working.map((card) => card.id),
    ["running"],
  );
  assert.deepEqual(
    selected.cards.Attention.map((card) => card.id),
    ["blocked"],
  );
});
test("026-12 the pipeline has no Done column, and finished or cancelled tasks leave it", () => {
  // Tom, 2026-09-27: "We don't need the Done column in Pipeline view".
  const view = board({
    tasks: [
      task("live", ["first"], "queued"),
      task("finished", ["first"], "done"),
      task("dropped", ["first"], "cancelled"),
    ] as Input["tasks"],
  });
  assert.ok(!(view.counts as Record<string, number>).Done);
  assert.deepEqual(all(view), ["live"]);
});

test("026-14b two selected projects share one pipeline; none means all", () => {
  const otherRepo = { origin: "owner/other", path: "/other" },
    thirdRepo = { origin: "owner/third", path: "/third" };
  const otherProject = {
    key: "other",
    name: "Other",
    version: 1,
    visibility: "active" as const,
    repositories: [otherRepo],
    primary: otherRepo,
    drain: null,
  };
  const thirdProject = {
    key: "third-project",
    name: "Third",
    version: 1,
    visibility: "active" as const,
    repositories: [thirdRepo],
    primary: thirdRepo,
    drain: null,
  };
  const lanes = [
    lane("first"),
    lane("second"),
    { ...lane("third"), repositories: [otherRepo] },
    { ...lane("fourth"), repositories: [thirdRepo] },
  ] as unknown as Input["lanes"];
  const tasks = [
    task("app-task", ["first"]),
    {
      ...task("other-task", ["third"]),
      repository: otherRepo.origin,
      repoPath: otherRepo.path,
    },
    {
      ...task("third-task", ["fourth"]),
      repository: thirdRepo.origin,
      repoPath: thirdRepo.path,
    },
  ] as Input["tasks"];
  const input = {
    projects: [project, otherProject, thirdProject],
    lanes,
    tasks,
  };
  assert.deepEqual(
    board({ ...input, selection: ["app", "other"] }).cards.Queued.map(
      (card) => card.id,
    ),
    ["app-task", "other-task"],
  );
  assert.deepEqual(
    board({ ...input, selection: ["app"] }).cards.Queued.map((card) => card.id),
    ["app-task"],
  );
  assert.deepEqual(
    board({ ...input, selection: [] }).cards.Queued.map((card) => card.id),
    ["app-task", "other-task", "third-task"],
  );
});

test("026-14b a saved selection naming a removed project shows all, as the other views do", () => {
  assert.deepEqual(
    board({
      selection: ["removed"],
      tasks: [task("live", ["first"])] as Input["tasks"],
    }).cards.Queued.map((card) => card.id),
    ["live"],
  );
  assert.deepEqual(
    board({
      selection: ["removed", "app"],
      tasks: [task("live", ["first"])] as Input["tasks"],
    }).cards.Queued.map((card) => card.id),
    ["live"],
  );
});

test("026-12 a lead promoted for one repository remains actionable for another", () => {
  const second = { origin: "owner/second", path: "/second" };
  const lead = {
    id: "multi",
    title: "Multi",
    state: "promoted",
    lanes: ["first"],
    repositories: [repo, second],
    targets: [{ kind: "task", repository: repo.origin, reference: "app#1" }],
  };
  assert.equal(
    board({ selection: [], leads: [lead] as unknown as Input["leads"] }).cards
      .Triage[0].id,
    "multi",
  );
});

const decision = (
  id: string,
  links: { tasks?: string[]; leads?: string[]; papercuts?: string[] },
  extra: Record<string, unknown> = {},
  project: { origin: string; path: string } = {
    origin: repo.origin,
    path: repo.path,
  },
) => ({
  id,
  version: 1,
  question: `Question ${id}`,
  context: null,
  options: [],
  recommendation: null,
  askedBy: { agentId: "agent-asker", project },
  links: {
    tasks: links.tasks ?? [],
    leads: links.leads ?? [],
    papercuts: links.papercuts ?? [],
  },
  status: "open",
  answer: null,
  withdrawal: null,
  supersededBy: null,
  delivery: null,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  versions: [],
  stale: false,
  projectKey: null,
  askerLabel: "agent-asker",
  ...extra,
});

test("032 the decisions view sits ahead of Attention and holds agent decisions only", () => {
  const view = board({
    tasks: [
      task("live", ["first"]),
      { ...task("stuck", ["second"]), phase: "needs_attention" },
      {
        ...task("escalated", ["first"], "blocked"),
        resolution: { attention: true, mergedCommit: null, escalated: true },
      },
    ] as Input["tasks"],
    decisions: [
      decision("d1", { tasks: ["live"] }),
      decision("d2", {}),
    ] as Input["decisions"],
  });
  // Tom, 2026-09-29: Queue-raised work belongs in Attention, not the decisions column.
  assert.deepEqual(
    view.cards.Decisions.map((card) => card.id),
    ["d1", "d2"],
    "only agent decisions",
  );
  assert.deepEqual(
    view.cards.Decisions.map((card) => card.kind),
    ["decision", "decision"],
  );
  assert.equal(
    view.cards.Attention.map((card) => card.id).filter((id) => id === "stuck")
      .length,
    1,
    "the raised task keeps its Attention card",
  );
  assert.equal(view.counts.Decisions, 2);
});

test("032 a decision carries the lanes of its linked tasks, leads and papercuts; an unlinked decision has none", () => {
  const view = board({
    leads: [
      lead("lead-1", ["first"]),
      { ...lead("cut-1", ["second"]), tags: ["papercut"] },
    ] as unknown as Input["leads"],
    tasks: [task("live", ["second"])] as Input["tasks"],
    decisions: [
      decision("d1", { tasks: ["live"], leads: ["lead-1"] }),
      decision("d2", {}),
      decision("d3", { papercuts: ["cut-1"] }),
    ] as Input["decisions"],
  });
  const lanesOf = (id: string) =>
    view.cards.Decisions.find((card) => card.id === id)!.lanes.sort();
  assert.deepEqual(
    lanesOf("d1"),
    ["first", "second"],
    "a linked task's and lead's lanes carry the decision",
  );
  assert.deepEqual(
    lanesOf("d3"),
    ["second"],
    "a linked papercut's lanes carry the decision too",
  );
  assert.deepEqual(lanesOf("d2"), [], "an unlinked decision has no lanes");
});

test("papercut decision links scope through tagged lead facts", () => {
  const other = { origin: "owner/other", path: "/other" };
  const otherProject = {
    key: "other",
    name: "Other",
    version: 1,
    visibility: "active" as const,
    repositories: [other],
    primary: other,
    drain: null,
  };
  const linked = {
    ...lead("cut-1", ["second"]),
    repositories: [other],
    tags: ["papercut"],
  };
  const view = board({
    projects: [project, otherProject],
    selection: ["other"],
    leads: [],
    linkedLeads: [linked] as Input["linkedLeads"],
    decisions: [decision("d", { papercuts: ["cut-1"] })] as Input["decisions"],
  });
  assert.deepEqual(
    view.cards.Decisions.map((card) => card.id),
    ["d"],
  );
  assert.deepEqual(view.cards.Decisions[0].lanes, ["second"]);
  const outside = board({
    projects: [project, otherProject],
    selection: ["app"],
    leads: [],
    linkedLeads: [linked] as Input["linkedLeads"],
    decisions: [decision("d", { papercuts: ["cut-1"] })] as Input["decisions"],
  });
  assert.equal(outside.cards.Decisions.length, 0);
});

test("032 decisions scope by their links, then by the asker's project, and answered ones leave the board", () => {
  const other = { origin: "owner/other", path: "/other" };
  const otherProject = {
    key: "other",
    name: "Other",
    version: 1,
    visibility: "active" as const,
    repositories: [other],
    primary: other,
    drain: null,
  };
  const inApp = decision("in-app", { tasks: ["live"] });
  const byAsker = decision("by-asker", {}, {});
  const answered = decision(
    "answered",
    { tasks: ["live"] },
    { status: "answered" },
  );
  const rows = board({
    selection: ["app"],
    tasks: [task("live", ["first"])] as Input["tasks"],
    decisions: [inApp, byAsker, answered] as Input["decisions"],
  });
  assert.deepEqual(
    rows.cards.Decisions.map((card) => card.id),
    ["in-app", "by-asker"],
    "the asker's project is app, so the unlinked decision stays",
  );
  const stranger = decision("stranger", {}, {}, other);
  const filtered = board({
    selection: ["app"],
    tasks: [task("live", ["first"])] as Input["tasks"],
    decisions: [stranger] as Input["decisions"],
    projects: [project, otherProject],
  });
  assert.equal(
    filtered.cards.Decisions.length,
    0,
    "another project's decision stays out",
  );
  const unknown = decision("unknown", { tasks: ["missing"] });
  (unknown.askedBy as { project: unknown }).project = null;
  const unclaimed = board({
    selection: ["app"],
    tasks: [task("live", ["first"])] as Input["tasks"],
    decisions: [unknown] as Input["decisions"],
  });
  assert.deepEqual(
    unclaimed.cards.Decisions.map((card) => card.id),
    ["unknown"],
    "a decision no project can claim stays visible everywhere",
  );
});

test("032 General decisions stay visible under a project filter when linked tasks belong elsewhere", () => {
  const other = { origin: "owner/project-d", path: "/project-d" };
  const otherProject = {
    key: "project-d",
    name: "Project-D",
    version: 1,
    visibility: "active" as const,
    repositories: [other],
    primary: other,
    drain: null,
  };
  const general = decision("general", { tasks: ["project-d-task"] });
  (general.askedBy as { project: unknown }).project = null;
  const rows = board({
    selection: ["app"],
    projects: [project, otherProject],
    tasks: [
      {
        ...task("project-d-task", []),
        repository: other.origin,
        repoPath: other.path,
      },
    ] as Input["tasks"],
    decisions: [general] as Input["decisions"],
  });
  assert.deepEqual(
    rows.cards.Decisions.map((card) => card.id),
    ["general"],
  );
  assert.equal(
    rows.counts.Decisions,
    1,
    "the General decision stays countable with its linked project filtered out",
  );
});

test("032 a stale decision stays on the board, and the age label stays coarse", async () => {
  const rows = board({
    tasks: [task("live", ["first"])] as Input["tasks"],
    decisions: [
      decision("d1", { tasks: ["live"] }, { stale: true }),
    ] as Input["decisions"],
  });
  assert.equal(
    (rows.cards.Decisions[0].value as { stale: boolean }).stale,
    true,
    "stale decisions are shown, never hidden",
  );
  const { decisionAge } = await import("../shared/pipeline-board");
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  assert.equal(decisionAge("2026-09-29T12:00:30.000Z", now), "just now");
  assert.equal(decisionAge("2026-09-29T11:30:00.000Z", now), "30m ago");
  assert.equal(decisionAge("2026-09-29T06:00:00.000Z", now), "6h ago");
  assert.equal(decisionAge("2026-09-27T06:00:00.000Z", now), "2d ago");
  assert.equal(
    decisionAge("2026-09-29T12:30:00.000Z", now + 60_000),
    "just now",
    "a future stamp never goes negative",
  );
});

test("long columns hold every card and the header counts them all", () => {
  const view = board({
    tasks: Array.from({ length: 300 }, (_, index) =>
      task(`bulk-${index}`, ["first"]),
    ) as Input["tasks"],
  });
  assert.equal(view.counts.Queued, 300);
  assert.equal(
    view.cards.Queued.length,
    300,
    "no five-card cell: the column scrolls instead",
  );
});

test("026-12a every inbox card renders through the shared board card, and the list is one scroll", () => {
  const ui = boardSource();
  // The inbox list (Tom, 2026-11-21) lives in its own module, which the shell mounts for every list view.
  const list = readFileSync(
    new URL("../client/board/inbox-list.tsx", import.meta.url),
    "utf8",
  );
  assert.match(ui, /<InboxList\b/);
  // One card component: TaskCard renders through BoardCard, and leads render BoardCard too.
  assert.match(ui, /function BoardCard\(/);
  // Commit 308157c4 (2026-09-27, one board card component) pinned TaskCard to
  // BoardCard. Its body since grew hooks and helpers, so the window is bounded by
  // the component itself: the match may not cross the next function declaration.
  assert.match(
    ui,
    /function TaskCard\((?:(?!function )[\s\S])*?return\s*\(?\s*<BoardCard/,
  );
  assert.ok(
    !ui.includes("PipelineRecordCard"),
    "the list must not keep a separate record card component",
  );
  assert.match(list, /case "task":\s*return <TaskCard/);
  assert.doesNotMatch(list, /card\.kind==='papercut'|card\.kind === "papercut"/);
  assert.match(list, /<BoardCard key=\{key\}/);
  assert.doesNotMatch(list, /actions=/);
  assert.doesNotMatch(list, /actionsLabel/);
  // Every card draws as a row of the one list, which is its view's single scroll.
  assert.match(list, /<BoardCardVariantContext\.Provider value="row">/);
  assert.equal((list.match(/<ScrollView\b/g) ?? []).length, 1, "the list is one scroll");
  // Leads page their own window (Tom, 2026-11-07).
  assert.match(list, /const visible = page \? page\.visible : section\.cards;/);
  // Swim-lane rows, kanban columns and their stubs are gone (Tom, 2026-11-08; 2026-11-21).
  assert.doesNotMatch(
    ui,
    /text="Show less"|expandedCells|collapsedRows|lane, \$\{total\} cards|Nothing in this lane|pipelineColumnWidths|pipelineStubColumns/,
  );
});

test("026-13 the inbox menu has no Lanes or QA destination; Planning holds the lane search", () => {
  const ui = boardSource();
  const controls = readFileSync(
    new URL("../client/project-scope-controls.tsx", import.meta.url),
    "utf8",
  );
  const inbox = readFileSync(
    new URL("../shared/inbox-board.ts", import.meta.url),
    "utf8",
  );
  // #866: the separate Lanes destination is folded into Planning's lane search; QA is a task (Tom, 2026-11-21).
  assert.doesNotMatch(inbox, /id: 'lanes'|id: 'qa'/);
  assert.match(inbox, /\{ id: 'planning', label: 'Planning'/);
  assert.doesNotMatch(ui, /accessibilityLabel="Board mode"/);
  assert.doesNotMatch(ui, /text="Pipeline"/);
  assert.doesNotMatch(ui, /text="Status"/);
  assert.doesNotMatch(ui, /statusColumn/);
  assert.doesNotMatch(ui, /<QaRunsTab\b/);
  // Tom, 2026-11-08: the board's swim-lane view and its switch are retired; the header keeps the project selector.
  assert.doesNotMatch(ui, /LanesSwitch|useLanesSwitch|lanesOn|swimlanes/);
  assert.doesNotMatch(
    controls,
    /LanesSwitch|accessibilityLabel="Lanes"|pipeline-lanes|BoardMode|board-mode/,
  );
  assert.match(
    ui,
    /<ProjectSelector\s+projects=\{state\?\.projects \?\? \[\]\}/,
    "the selector holds the project selection",
  );
  assert.doesNotMatch(controls, /ProjectFilterSwitch/);
  assert.doesNotMatch(controls, /accessibilityLabel="Enabled"/);
  // A lane opened from Planning's lane search keeps the plan and lane panes.
  assert.match(
    ui,
    /const selectPlanningLane = \(key: string\) => \{\s*setPlanningPin\(key\);/,
  );
  assert.doesNotMatch(ui, /setPipelineTarget/);
  // The menu counts and every list read one derivation, then the Leads tag filter narrows a copy.
  assert.match(ui, /const columns = useMemo\(\s*\(\) => pipelineBoard\(\{/);
  assert.equal(
    (ui.match(/pipelineBoard\(/g) ?? []).length,
    1,
    "derive the board once, then filter Leads cards",
  );
  // The project selection is the only filter state (nucleus#1476).
  assert.match(ui, /const inbox = useInboxBoard\(\{\s*state,\s*selection,/);
  // #866 retired the Lanes table and its second projection.
  assert.doesNotMatch(ui, /tablePipeline|laneTableRows/);
});

test("026-15 an accepted submission shows queued as submitting until its task appears", () => {
  const pending = {
    id: "op-1",
    submissionId: "sub-under-validation",
    title: "Awaiting validation",
    repoPath: repo.path,
    repository: repo.origin,
    lanes: ["first"],
    state: "running" as const,
    createdAt: "2026-09-27T10:10:00.000Z",
  };
  const view = board({ pendingSubmissions: [pending] });
  // It is a Queued card, never a Working or Review card.
  assert.equal(view.counts.Queued, 1);
  assert.equal(view.cards.Queued[0].kind, "submission");
  assert.equal(view.cards.Queued[0].id, "op-1");
  assert.equal(view.cards.Working.length, 0);
  assert.equal(view.cards.Review.length, 0);
  // The task that supersedes it is the only card; the pending card leaves.
  const replaced = board({
    tasks: [task("task-1", ["first"])] as Input["tasks"],
  });
  assert.deepEqual(
    replaced.cards.Queued.map((card) => card.kind),
    ["task"],
  );
  assert.equal(replaced.counts.Queued, 1);
});

test("026-15a inbox cards open a record modal or the detail pane and carry no action buttons", () => {
  const ui = boardSource();
  // The inbox list lives in its own module, which the shell mounts (Tom, 2026-11-21).
  const pipeline = readFileSync(
    new URL("../client/board/inbox-list.tsx", import.meta.url),
    "utf8",
  );
  const triageLeadCard = readFileSync(
    new URL("../client/board/triage-lead-card.tsx", import.meta.url),
    "utf8",
  );
  assert.match(ui, /<InboxList\b/);
  // A wide board opens a record in the detail pane; Planning and narrower boards open the same record as a modal.
  assert.match(ui, /const inlineDetail = wide && view !== "planning";/);
  assert.match(ui, /\{wide && detailPane\}/);
  assert.match(ui, /\{!inlineDetail && detail\}/);
  assert.doesNotMatch(pipeline, /setTab\('papercuts'\)/);
  assert.doesNotMatch(pipeline, /text="Approve"/);
  assert.doesNotMatch(pipeline, /text="Promote"/);
  assert.doesNotMatch(pipeline, /text="Drop"/);
  assert.doesNotMatch(pipeline, /text="Check again"/);
  assert.doesNotMatch(pipeline, /actionsLabel/);
  assert.match(triageLeadCard, /onSelectPapercut\(lead\.id\)/);
  assert.match(triageLeadCard, /onSelectLead\(lead\.id\)/);
  assert.match(
    ui,
    /const selectPapercut = \(id: string\) => \{[^}]*setOpenPapercutId\(id\); \}/,
  );
  assert.match(
    ui,
    /const selectLead = \(id: string, lane: [^)]*\) => \{[^}]*setSelectedLeadId\(id\); \}/,
  );
  assert.match(ui, /label="Lead detail"/);
  assert.match(ui, /label="Papercut detail"/);
  // #868: the lead record's Check, Approve and Promote controls live in the shared lead screen.
  const leadScreen = readFileSync(
    new URL("../client/lead-screen.tsx", import.meta.url),
    "utf8",
  );
  assert.match(ui, /<LeadScreen/);
  assert.match(
    leadScreen,
    /text=\{running === "check" \? "Checking…" : "Check brief"\}/,
  );
  assert.match(
    leadScreen,
    /text=\{running === "approve" \? "Approving…" : "Approve"\}/,
  );
  assert.match(leadScreen, /"Promote to task"/);
  assert.match(leadScreen, /approve: approveReason/);
  assert.match(ui, /text="Close as completed"/);
  assert.match(ui, /text="Close as deprecated"/);
  assert.match(ui, /papercutPromoteReason/);
  assert.match(ui, /Record action result/);
  assert.match(ui, /Record action error/);
  assert.match(ui, /board: true/);
  assert.equal(
    ui.match(/<MainSurface \{\.\.\.props\} workspaceBoard=\{resolution\} \/>/g)
      ?.length,
    1,
    "the workspace board reuses the same record modals",
  );
});

test("026-14 Planning tab writes operator versions and refuses stale saves", async () => {
  const { Store } = await import("../core/store/store");
  const store = new Store(":memory:");
  try {
    store.upsertProject({
      key: project.key,
      name: project.name,
      repositories: project.repositories,
      primary: project.primary,
    });
    store.upsertLane({
      key: "first",
      title: "First",
      aim: "Aim",
      repositories: [repo],
    });
    const saved = store.setPlan({
      project: "app",
      version: 0,
      entries: [{ lane: "first", note: "", horizon: "later" }],
      author: "operator (board)",
    });
    assert.equal(saved.author, "operator (board)");
    assert.equal(store.plan({ project: "app" }).entries[0].horizon, "later");
    assert.throws(
      () =>
        store.setPlan({
          project: "app",
          version: 0,
          entries: [],
          author: "operator (board)",
        }),
      /reload before saving/,
    );
    const doc = store.editLaneDocument({
      key: "first",
      version: 0,
      text: "Lane intent",
      author: "operator (board)",
    });
    assert.equal(doc.author, "operator (board)");
    assert.throws(
      () =>
        store.editLaneDocument({
          key: "first",
          version: 0,
          text: "Stale",
          author: "operator (board)",
        }),
      /reload before saving/,
    );
  } finally {
    store.close();
  }
});

test("032 a linked promoted lead outside the card set places its decision through link facts alone", () => {
  const promoted = { id: "promoted-1", lanes: ["first"], repositories: [repo] };
  const view = board({
    leads: [lead("lead-1", ["second"])] as unknown as Input["leads"],
    linkedLeads: [promoted] as Input["linkedLeads"],
    decisions: [
      decision("d1", { leads: ["promoted-1"] }),
      decision("d2", { leads: ["lead-1"] }),
    ] as Input["decisions"],
  });
  assert.deepEqual(
    view.cards.Decisions.map((card) => [card.id, card.lanes]),
    [
      ["d1", ["first"]],
      ["d2", ["second"]],
    ],
    "a fully promoted lead's lanes still carry its decision",
  );
  assert.deepEqual(
    view.cards.Triage.map((card) => card.id),
    ["lead-1"],
    "link facts never become Triage cards",
  );
});

test("377 planning lists read the narrow lead.board projection, never every full page", () => {
  const ui = boardSource();
  assert.match(
    ui,
    /queryFn: \(\) => fetchLeadBoard\(\{\}\)/,
    "one narrow read replaces the open-then-promoted page walk",
  );
  assert.doesNotMatch(
    ui,
    /fetchLeadPages/,
    "the client no longer downloads full bodies for lists",
  );
  assert.doesNotMatch(
    ui,
    /snippet\(card\.value\.preview\)/,
    "a Triage card shows one state line; the body preview stays in the record",
  );
  assert.match(
    ui,
    /triageState\(lead\)/,
    "the state line reads the presence facts through the shared helper",
  );
  assert.match(
    ui,
    /linkedLeads:\s*leadLinks/,
    "open decisions resolve linked promoted leads from link facts",
  );
});

test("Triage cards: one state line per lead or papercut, operator order, and pages of eight", () => {
  const card = (id: string, patch: Record<string, unknown>) => ({
    id,
    title: id,
    state: "open",
    lanes: [],
    repositories: [repo],
    preview: "What happened … Impact …",
    papercutArea: null,
    tags: [],
    version: 1,
    check: null,
    approved: false,
    targets: [],
    ...patch,
  });
  const cut = card("old-cut", { tags: ["papercut"], papercutArea: "board" });
  const idle = card("idle-lead", { tags: ["idea"] });
  const approvable = card("checked-lead", {
    tags: ["idea"],
    check: { ok: true },
  });
  const approved = card("approved-lead", {
    tags: ["idea"],
    check: { ok: true },
    approved: true,
  });
  const promoted = card("promoted-lead", {
    tags: ["idea"],
    state: "promoted",
    check: { ok: false },
    approved: true,
    targets: [{ kind: "task", repository: repo.origin }],
  });
  const shuffled = [cut, idle, approved, approvable];
  const triage = board({ leads: shuffled as unknown as Input["leads"] }).cards
    .Triage;
  assert.deepEqual(
    triage.map((item) => item.id),
    ["checked-lead", "idle-lead", "approved-lead", "old-cut"],
    "checked leads first, approved leads next, papercuts last; ties keep the board order",
  );
  assert.equal(triageState(approvable as never), "Checks passed · unapproved");
  assert.equal(triageState(idle as never), "Unchecked · unapproved");
  assert.equal(triageState(approved as never), "Checks passed · approved");
  assert.equal(
    triageState(promoted as never),
    "Promoted · Checks failed · approved",
  );
  assert.equal(triageState(cut as never), "Open · board");
  assert.equal(
    triageState(card("no-area", { tags: ["papercut"] }) as never),
    "Open",
  );
  assert.equal(triageKind(cut as never), "papercut");
  assert.equal(triageKind(idle as never), "lead");
  const many = Array.from({ length: 10 }, (_, index) =>
    card(`cut-${index}`, { tags: ["papercut"] }),
  );
  const page = triagePage(many, triagePageSize);
  assert.equal(page.visible.length, 8, "the first page holds eight cards");
  assert.equal(page.hidden, 2, 'the rest wait behind the "…and N more" card');
  assert.equal(
    triagePage(many, triagePageSize * 2).hidden,
    0,
    "the next page shows the rest",
  );
  assert.equal(
    triagePage(many.slice(0, 3), triagePageSize).hidden,
    0,
    "a short column has no overflow card",
  );
});

