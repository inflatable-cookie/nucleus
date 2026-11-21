import { test } from "node:test";
import { recentProjectActivity } from './support/fakes';
import assert from "node:assert/strict";
import React from "react";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The host wraps contributed components with these providers from the SDK's host
// entry. A static import keeps them in the same module cache the client bundle's
// own SDK imports resolve to (one React context instance).
import {
  PluginClientStateProvider,
  PluginRpcProvider,
} from "@getpaseo/plugin/client/host";
import {
  boardShellPlugin,
  mount,
  useNativeStubs,
  type HostNode,
} from "./support/render";
import { Store } from "../core/store/store";
import { leadActions } from "../core/planning/lead-actions";
import type { LeadStatusFacts } from "../shared/lead-status";
import {
  hostRunRecordSchema,
  submissionSchema,
  summarizeTask,
  type ProjectQaRun,
} from "../shared/contracts";
import { CAPACITY_WAIT_PREFIX } from "../shared/wait-state";
import { createTaskDetailCache } from "../core/telemetry/task-detail";
import { leadFromPapercut } from "../shared/papercut-lead";
import type { Papercut } from "../shared/contracts";

useNativeStubs();

const h = React.createElement;
/** Dark-theme palette standing in for the operator's Paseo theme. Every themed
 * style in the board must resolve to one of these (or a fixed overlay literal). */
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
const fixedLiterals = new Set([
  "#000",
  "rgba(0, 0, 0, 0.68)",
  "rgba(0,0,0,0.68)",
  "transparent",
]);
const c = dark as never;

const repo = { origin: "owner/app", path: "/app" };
const project = {
  key: "app",
  name: "App",
  version: 1,
  visibility: "active",
  repositories: [repo],
  primary: repo,
};
const projectDRepo = { origin: "owner/project-d", path: "/project-d" };
const projectDProject = {
  key: "project-d",
  name: "Project-D",
  version: 1,
  visibility: "active",
  repositories: [projectDRepo],
  primary: projectDRepo,
};
const laneView = (key: string) => ({
  id: key,
  key,
  title: key === "first" ? "First" : "Second",
  aim: `Aim ${key}`,
  status: "active",
  note: "",
  repositories: [repo],
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  closedAt: null,
  liveByPhase: {},
  liveByRepository: {},
  terminalCount: 0,
  lastActivityAt: null,
  recentOutcomes: [],
});
const lanes = [laneView("first"), laneView("second")];
const plan = {
  project: "app",
  version: 1,
  entries: [
    { lane: "second", note: "", horizon: "now" },
    { lane: "first", note: "", horizon: "now" },
  ],
  author: null,
  createdAt: null,
  savedEntries: [
    { lane: "second", note: "", horizon: "now" },
    { lane: "first", note: "", horizon: "now" },
  ],
};
const phases = [
  "queued",
  "dispatching",
  "working",
  "changes_requested",
  "blocked",
  "error",
  "needs_attention",
  "awaiting_review",
  "reviewing",
  "verifying",
  "merging",
  "syncing",
  "closing",
] as const;
const summary = (
  id: string,
  title: string,
  lanes: string[],
  phase: string,
) => ({
  id,
  title,
  repoPath: "/app",
  repository: "owner/app",
  version: 1,
  number: null as number | null,
  reference: null as string | null,
  entrypoint: "worker",
  phase,
  reason: `Reason ${title}`,
  held: false,
  dependsOn: [],
  queuePriority: 0,
  parked: [
    "needs_attention",
    "awaiting_review",
    "changes_requested",
    "verifying",
  ].includes(phase),
  profile: null,
  prUrl: null,
  resumePrNumber: null,
  completionPrNumber: null,
  originError: "",
  originLookupError: "",
  lanes,
  disposition: null,
  resolution: { attention: false, mergedCommit: null },
});
type VisualTaskSummary = ReturnType<typeof summary> & {
  holdKind?: "dispatch" | "merge";
  holdEscalated?: boolean;
  hold?: { owner: string; reason: string; since: string | null };
  waitState?: {
    state:
      | "waiting_capacity"
      | "waiting_prerequisite"
      | "needs_operator_input"
      | "needs_source_rights"
      | "merge_hold";
    owner: string;
    nextAction: string;
    decisionId?: string;
  };
};
const tasks: VisualTaskSummary[] = [
  ...phases.map((phase) =>
    summary(`task-${phase}`, `Task ${phase}`, ["first"], phase),
  ),
  summary("shared", "Shared task", ["first", "second"], "working"),
  summary("unlaned", "Unlaned task", [], "queued"),
];
const papercut = {
  id: "cut-1",
  repository: { origin: "owner/app", path: "/app" },
  area: null as string | null,
  title: "Cut one",
  version: 1,
  happened: "It happened",
  impact: "Impact",
  fix: null as string | null,
  filedBy: "operator",
  filedAt: "2026-09-27T00:00:00.000Z",
  state: "open" as "open" | "promoted" | "closed",
  taskId: null as string | null,
  closedReason: null as "completed" | "deprecated" | null,
  draftId: null,
  note: null as string | null,
  closedAt: null,
  source: null,
  lanes: ["first"],
};
const taggedLead = () => leadFromPapercut(papercut as Papercut);
/** The narrow lead.board card a fixture projects to; lead.get keeps serving the full record. */
const boardRow = (row: {
  id: string;
  title: string;
  body: string;
  repositories: { origin: string; path: string }[];
  lanes: string[];
  tags: string[];
  papercut: { area: string | null } | null;
  state: string;
  version: number;
  check: { ok: boolean } | null;
  approval: unknown;
  targets: Array<{ kind: string; repository: string | null }>;
}) => ({
  id: row.id,
  title: row.title,
  preview: row.body.slice(0, 400),
  repositories: row.repositories,
  lanes: row.lanes,
  tags: row.tags,
  papercutArea: row.papercut?.area ?? null,
  state: row.state,
  version: row.version,
  check: row.check ? { ok: row.check.ok } : null,
  approved: Boolean(row.approval),
  targets: row.targets
    .filter((target) => target.kind === "draft" || target.kind === "task")
    .map((target) => ({ kind: target.kind, repository: target.repository })),
});
/** The server-side card filter of lead.board (store.listBoardLeads): open leads, plus promoted
 * leads holding a draft/task target and still a repository without one. Dropped and fully
 * promoted leads never come back as cards; a mock that skips this serves records the real read
 * cannot, and a dropped row's state fails the output schema on every later poll. */
const boardCards = <
  T extends {
    state: string;
    repositories: Array<{ origin: string }>;
    targets: Array<{ kind: string; repository: string | null }>;
  },
>(
  rows: readonly T[],
) =>
  rows.filter(
    (row) =>
      row.state === "open" ||
      (row.targets.some(
        (target) => target.kind === "draft" || target.kind === "task",
      ) &&
        row.repositories.some(
          (repo) =>
            !row.targets.some(
              (target) =>
                target.repository === repo.origin &&
                (target.kind === "draft" || target.kind === "task"),
            ),
        )),
  );
const lead = {
  id: "lead-1",
  title: "Lead one",
  body: "Lead body",
  repositories: [{ origin: "owner/app", path: "/app" }],
  lanes: ["first"],
  author: "operator",
  state: "open" as "open" | "promoted" | "dropped",
  version: 1,
  digest: undefined as string | undefined,
  check: null as {
    ok: boolean;
    message: string;
    checkedAt: string;
    planningCommit: string | null;
  } | null,
  approval: null as {
    version: number;
    digest: string;
    approver: string;
    approvedAt: string;
    note: string;
    relayed: boolean;
  } | null,
  baseBranch: "main",
  dropReason: null as string | null,
  targets: [] as Array<{
    kind: "task" | "draft" | "question" | "knowledge";
    repository: string | null;
    reference: string;
    at: string;
  }>,
  source: null,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  closedAt: null,
  tags: [] as string[],
  papercut: null,
  closure: null,
};
const board = {
  revision: 1,
  connected: true,
  hostId: "host",
  paused: false,
  dispatchHeld: false,
  error: "",
  quiet: false,
  activeWorkers: 0,
  unsettled: 0,
  globalLimit: 32,
  projectLimit: 5,
  projectLimitOverrides: {},
  tasks,
  profiles: [],
  pool: [],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes,
  projects: [project],
  projectActivity: [] as Array<{ key: string; items: Array<{ id: string; at: string; executing: boolean }> }>,
  prStates: {},
};
const service = {
  state: "running",
  detail: "",
  error: "",
  ready: true,
  paused: false,
  hostId: "host",
};
const hostRunsForUi: ReturnType<typeof hostRunRecordSchema.parse>[] = [];
const projectQaRunsForUi: ProjectQaRun[] = [];

/** Methods the surface asked for, so one read replacing two is provable. */
const rpcMethods: string[] = [];
const invoke = async (method: string, input: unknown): Promise<unknown> => {
  rpcMethods.push(method);
  if (method === "queue.ui-snapshot") return board;
  if (method === "queue.service-state") return service;
  if (method === "papercut.list") return [papercut];
  if (method === "papercut.get") return papercut;
  if (method === "decision.list") return [];
  if (method === "host.run.list") return hostRunsForUi;
  if (method === "host.run.accounting.list")
    return { readAt: "2026-09-27T00:00:00.000Z", entries: [], complete: true };
  // Audit A8: the board polls one combined read; both halves are this mock's.
  if (method === "host.run.board")
    return {
      runs: hostRunsForUi,
      accounting: {
        readAt: "2026-09-27T00:00:00.000Z",
        entries: [],
        complete: true,
      },
    };
  if (method === "project.qa.list") return projectQaRunsForUi;
  if (method === "lead.board")
    return { cards: boardCards([lead, taggedLead()]).map(boardRow), links: [] };
  if (method === "lead.get") {
    const detail = {
      ...lead,
      versions: [
        {
          version: 1,
          title: lead.title,
          body: lead.body,
          author: lead.author,
          createdAt: lead.createdAt,
          check: lead.check,
        },
      ],
    };
    return {
      ...detail,
      actions: leadActions(detail as unknown as LeadStatusFacts),
    };
  }
  if (method === "queue.plans")
    return [{ ...plan, savedEntries: plan.entries }];
  if (method === "plan.get") return plan;
  return {};
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * The host loads the plugin as a CJS bundle. Like plugin-load.test.ts guards the
 * server entry, this builds the client entry the way the host does and renders
 * MainSurface from the bundle — so the dark-theme check at both viewport sizes
 * verifies the artifact the installed bundle carries, not just the sources.
 * React, the JSX runtime, react-query and the plugin client stay single-instance
 * with the test's own imports; only react-native resolves to the host stubs.
 */
let bundledMainSurface: ((props: unknown) => React.ReactNode) | null = null;
async function bundleMainSurface() {
  if (bundledMainSurface) return bundledMainSurface;
  const root = resolve(import.meta.dirname, "..");
  // Resolve external singletons from this test, without writing a bundle into the checkout.
  const result = await build({
    entryPoints: [join(root, "client/queue.tsx")],
    bundle: true,
    plugins: [boardShellPlugin],
    platform: "node",
    format: "cjs",
    write: false,
    jsx: "automatic",
    logLevel: "silent",
    external: [
      "react",
      "react/jsx-runtime",
      "@tanstack/react-query",
      "@getpaseo/plugin/client",
      "@getpaseo/plugin/client/host",
    ],
    alias: {
      "react-native": join(root, "test/support/native-stub.mjs"),
      "@getpaseo/plugin/client/react-native": join(
        root,
        "test/support/native-stub.mjs",
      ),
    },
  });
  const compiled = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  assert.equal(
    typeof compiled.exports.MainSurface,
    "function",
    "the client bundle must export MainSurface",
  );
  bundledMainSurface = compiled.exports.MainSurface as (
    props: unknown,
  ) => React.ReactNode;
  return bundledMainSurface;
}

// Tom, 2026-11-21: the status line left the header; the slot table lives in the queue menu.
test("the bundled queue menu keeps the project default and override count readable", async () => {
  const mainSurface = await bundleMainSurface();
  const previous = board.projectLimitOverrides;
  board.projectLimitOverrides = { "project-a": 6 };
  const ui = mount(tree(mainSurface, false));
  try {
    await settleUntil(
      ui,
      () => ui.query("Queue controls menu")?.props.disabled === false,
      "the queue controls did not load",
    );
    assert.doesNotMatch(
      ui.text(),
      /project default|global slots/,
      "the header carries no status line",
    );
    ui.press("Queue controls menu");
    assert.match(ui.text(), /0\/32 global · project default 5 · 1 override/);
  } finally {
    unmount(ui);
    board.projectLimitOverrides = previous;
  }
});

function hostStyle(node: HostNode): Record<string, unknown> {
  const style = node.props.style;
  return style && typeof style === "object" && !Array.isArray(style)
    ? (style as Record<string, unknown>)
    : {};
}

function ancestorsOf(root: HostNode, target: HostNode): HostNode[] {
  const chain: HostNode[] = [];
  const walk = (node: HostNode): boolean => {
    if (node === target) return true;
    for (const child of node.children) {
      if (typeof child !== "string" && walk(child)) {
        chain.push(node);
        return true;
      }
    }
    return false;
  };
  walk(root);
  return chain;
}

function assertHeaderMenuInTopLayer(
  ui: ReturnType<typeof mount>,
  menuLabel: string,
  overlayLabel: string,
) {
  const menu = ui.get(menuLabel);
  const overlayZ = Number(hostStyle(ui.get(overlayLabel)).zIndex ?? 0);
  assert.ok(overlayZ > 0, "the outside-press layer covers the board");
  // Queue #1391: the open menu renders in the shell's popover layer, above
  // the list and detail panes, instead of climbing a z-index ladder inside the
  // header. The bundled surface carries its own copy of the layer id string.
  const layer = ui
    .ofType("View")
    .find((node) => node.props.testID === "nucleus-popover-layer");
  assert.ok(layer, "the board shell mounts one popover layer");
  assert.ok(
    ancestorsOf(layer, menu).length > 0,
    "the menu renders in the top layer, above the panes",
  );
}

for (const compact of [false, true])
  test(`706: bundled dark icon-and-chevron pause control acts on one press (${compact ? "compact" : "wide"})`, async () => {
    const MainSurface = await bundleMainSurface();
    const calls: Array<{ method: string; input: any }> = [];
    const rpc: typeof invoke = async (method, input) => {
      if (method === "queue.ui-snapshot") return structuredClone(board);
      if (method === "queue.control") {
        calls.push({ method, input });
        Object.assign(board, input);
        board.revision++;
        return { ok: true };
      }
      if (method === "queue.stop-threads") {
        calls.push({ method, input });
        assert.equal(board.paused, true, "stop runs after pause");
        return { ok: true, stopped: 0 };
      }
      return invoke(method, input);
    };
    const ui = mount(tree(MainSurface, compact, rpc));
    try {
      await settleUntil(
        ui,
        () => ui.query("Queue controls menu")?.props.disabled === false,
        "split button not ready",
      );
      assert.equal(
        ui.get("Queue controls menu").props.accessibilityState.expanded,
        false,
      );
      assert.equal(
        ui.query("Pause"),
        undefined,
        "the main control is icon-only; Pause is a menu row",
      );
      ui.press("Pause and drain");
      await settleUntil(
        ui,
        () => !!ui.query("Resume orchestration"),
        `pause did not become Resume: ${JSON.stringify(calls)} ${ui.text().slice(0, 450)}`,
      );
      ui.press("Resume orchestration");
      await settleUntil(
        ui,
        () => !board.paused && !!ui.query("Pause and drain"),
        "resume did not release pause",
      );
      ui.press("Queue controls menu");
      assert.equal(
        ui.get("Queue controls menu").props.accessibilityState.expanded,
        true,
      );
      assert.equal(ui.get("Pause").props.accessibilityRole, "menuitem");
      assert.equal(ui.get("Dispatch hold").props.accessibilityRole, "menuitem");
      assert.equal(ui.get("Stop").props.accessibilityRole, "menuitem");
      assertHeaderMenuInTopLayer(
        ui,
        "Queue controls",
        "Close queue controls",
      );
      ui.press("Dispatch hold");
      await settleUntil(
        ui,
        () =>
          ui.query("Queue controls") === undefined &&
          ui.text().includes("Dispatch held"),
        "hold has no one-click release",
      );
      assert.equal(ui.query("Confirm stop"), undefined);
      ui.press("Queue controls menu");
      const releaseItem = ui
        .all("Release dispatch hold")
        .find((node) => node.props.accessibilityRole === "menuitem");
      assert.ok(releaseItem, "the menu offers Release dispatch hold as a row");
      releaseItem!.props.onPress();
      await settleUntil(
        ui,
        () =>
          ui.query("Queue controls") === undefined &&
          !ui.text().includes("Dispatch held"),
        "release did not clear hold",
      );
      ui.press("Queue controls menu");
      ui.press("Stop");
      await settleUntil(
        ui,
        () => calls.some((call) => call.method === "queue.stop-threads"),
        "stop not submitted",
      );
      assert.equal(
        ui.query("Confirm stop"),
        undefined,
        "Stop has no arm or confirm step",
      );
      assert.equal(
        ui.query("Queue controls"),
        undefined,
        "selecting a row closes the menu",
      );
      assert.deepEqual(
        calls.slice(-2).map((call) => [call.method, call.input]),
        [
          ["queue.control", { paused: true }],
          ["queue.stop-threads", { caller: "operator (board)" }],
        ],
      );
    } finally {
      unmount(ui);
      board.paused = false;
      board.dispatchHeld = false;
      board.revision++;
    }
  });

function tree(
  MainSurface: (props: unknown) => React.ReactNode,
  compact: boolean,
  rpc: typeof invoke = invoke,
  failFast = false,
) {
  return h(QueryClientProvider, {
    client: new QueryClient({
      defaultOptions: { queries: { retry: failFast ? false : 3 } },
    }),
    children: h(PluginRpcProvider, {
      invoke: rpc,
      children: h(MainSurface as never, {
        theme: { colors: c },
        layout: { compact, platform: "ios" as const },
        navigation: {},
      }),
    }),
  });
}

/** Yield until the board read lands: the menu carries real counts and the open list has rendered. */
async function settle(ui: ReturnType<typeof mount>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (ui.query(/^Active, \d+$/) && ui.query(/ list$/)) return;
    await tick();
  }
  assert.fail("the inbox board did not render");
}

async function settleUntil(
  ui: ReturnType<typeof mount>,
  probe: () => boolean,
  message: string,
) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail(message);
}

function unmount(ui: ReturnType<typeof mount>) {
  ui.update(h("View", null));
}

const countText = (ui: ReturnType<typeof mount>, value: string) =>
  ui.ofType("Text").filter((node) => node.children.join("") === value).length;
const navigationButtons = (ui: ReturnType<typeof mount>) =>
  ui
    .get("Nucleus navigation")
    .children.filter(
      (node): node is HostNode =>
        typeof node !== "string" && node.type === "Pressable",
    );
const navigationLabels = (ui: ReturnType<typeof mount>) =>
  navigationButtons(ui).map((node) => String(node.props.accessibilityLabel));
/** A menu entry's name, without its count. */
const viewName = (label: string) => label.replace(/, \d+$/, "");
const navigationButton = (ui: ReturnType<typeof mount>, name: string) => {
  const button = navigationButtons(ui).find(
    (node) => viewName(String(node.props.accessibilityLabel)) === name,
  );
  assert.ok(button, `missing ${name} menu entry`);
  return button;
};
/** Open a menu view (or one of Active's sections) by name. */
const openView = (ui: ReturnType<typeof mount>, name: string) =>
  navigationButton(ui, name).props.onPress();
/** The views that list task and decision cards. */
const cardViews = ["Needs you", "Queue", "Active"] as const;
/** A text's count summed over the card views; each card lives in exactly one. */
const countAcross = (
  ui: ReturnType<typeof mount>,
  value: string,
  views: readonly string[] = cardViews,
) =>
  views.reduce((sum, view) => {
    openView(ui, view);
    return sum + countText(ui, value);
  }, 0);
/** The first card whose label matches, leaving its view open. */
const findCard = (
  ui: ReturnType<typeof mount>,
  match: (label: string) => boolean,
  views: readonly string[] = cardViews,
) => {
  for (const view of views) {
    openView(ui, view);
    const card = ui
      .ofType("Pressable")
      .find((node) => match(String(node.props.accessibilityLabel)));
    if (card) return card;
  }
  return undefined;
};
/** Close an open record: its modal backdrop below the wide layout, its pane's close control at it. */
const closeRecord = (ui: ReturnType<typeof mount>, backdrop: string) =>
  ui.press(ui.query(backdrop) ? backdrop : "Close detail");

/** Every themed color resolves to the dark palette (or a fixed overlay literal). */
function assertDarkTheme(ui: ReturnType<typeof mount>) {
  const palette: Set<string> = new Set(Object.values(dark));
  const visit = (node: HostNode) => {
    const styles = Array.isArray(node.props.style)
      ? node.props.style
      : [node.props.style];
    for (const style of styles) {
      if (!style || typeof style !== "object") continue;
      for (const key of [
        "color",
        "backgroundColor",
        "borderColor",
        "borderTopColor",
        "borderBottomColor",
        "placeholderTextColor",
        "shadowColor",
      ] as const) {
        const value = (style as Record<string, unknown>)[key];
        if (value === undefined || value === null) continue;
        assert.equal(typeof value, "string", `${key} must be a color string`);
        assert.ok(
          palette.has(value as string) || fixedLiterals.has(value as string),
          `${key} ${value} is outside the dark palette`,
        );
      }
    }
    for (const child of node.children)
      if (typeof child !== "string") visit(child);
  };
  for (const node of ui.ofType("View")) visit(node);
  for (const node of ui.ofType("Text")) visit(node);
}

async function verifyViewport(compact: boolean) {
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, compact));
  try {
    await settle(ui);
    // Tom, 2026-11-21: the menu replaces the Tasks, Planning and QA runs tabs.
    assert.deepEqual(navigationLabels(ui).map(viewName), [
      "Needs you",
      "Planning",
      "Leads",
      "Papercuts",
      "Queue",
      "Active",
      "Working",
      "In review",
      "Closing",
    ]);
    assert.ok(ui.get("Needs you list"), "the inbox opens on Needs you");
    assert.equal(ui.query(/^Tasks( \(|$|, )/), undefined, "no Tasks tab remains");
    assert.equal(ui.query(/^QA runs/), undefined, "QA runs is retired as a board surface");
    assert.equal(
      ui.query("Board mode"),
      undefined,
      "the inbox has no Pipeline/Lanes mode toggle",
    );
    assert.equal(ui.all("Lanes").length, 0, "nothing is labelled Lanes");
    openView(ui, "Planning");
    assert.ok(ui.get("Find lanes"), "Planning carries lane discovery");
    assert.equal(
      ui.query(/^Project: /),
      undefined,
      "Planning has no chooser of its own",
    );
    assert.ok(
      ui.query(/^Projects, /),
      "the header project selector scopes Planning",
    );
    openView(ui, "Queue");
    assert.equal(ui.query("Find lanes"), undefined);
    assert.equal(
      countAcross(ui, "Parked (no slot held)"),
      4,
      "parked lifecycle tasks carry the no-slot badge",
    );
    // Each task card renders once, in exactly one view, whatever its lane count.
    for (const phase of phases)
      assert.equal(
        countAcross(ui, `Task ${phase}`),
        1,
        `${phase} renders once`,
      );
    assert.equal(
      countAcross(ui, "Shared task"),
      1,
      "a card in two lanes renders once",
    );
    openView(ui, "Queue");
    assert.equal(countText(ui, "Task queued"), 1, "queued work is in Queue");
    openView(ui, "Active");
    for (const section of ["Working", "In review", "Closing"])
      assert.ok(
        ui.query(new RegExp(`^${section} section, \\d+$`)),
        `Active lists its ${section} section`,
      );
    assert.equal(countText(ui, "Task closing"), 1, "closing work is in Active");
    openView(ui, "Closing");
    assert.equal(countText(ui, "Task working"), 0, "a section shows only its own cards");
    assert.equal(countText(ui, "Task closing"), 1);
    // This fixture has no decisions: Needs you is one list with one empty state and a real zero.
    openView(ui, "Needs you");
    assert.ok(ui.query("Needs you list"), "Needs you is one list");
    assert.equal(ui.query(/ section, \d+$/), undefined, "Needs you has no section headers");
    const needs = Number(String(ui.get(/^Needs you, \d+$/).props.accessibilityLabel).split(", ")[1]);
    assert.equal(countText(ui, `${needs} items`), 1, "the list counts its real total");
    assert.equal(ui.text().includes("Nothing here."), needs === 0, "an empty list says so, and a populated one does not");
    assert.equal(
      ui.query("Filter by project"),
      undefined,
      "no separate filter switch on the board",
    );
    assert.equal(
      ui
        .ofType("Pressable")
        .filter((node) => node.props.accessibilityRole === "switch").length,
      0,
      "the board holds no switch",
    );
    // Leads and Papercuts are menu entries of their own; only Leads has the tag filter (Tom, 2026-11-21).
    openView(ui, "Leads");
    await settleUntil(
      ui,
      () => countText(ui, "Lead one") === 1,
      "the Leads list did not render",
    );
    assert.equal(countText(ui, "Cut one"), 0, "papercuts sit in their own menu view");
    assert.equal(ui.query(/^(Leads|Papercuts) tab, /), undefined, "no tab switch remains");
    for (const label of ["Promote", "Approve", "Drop", "Check again"])
      assert.equal(ui.query(label), undefined, `list rows render no ${label} button`);
    assert.equal(
      ui
        .ofType("Pressable")
        .filter((node) => node.props.accessibilityRole === "toolbar").length,
      0,
      "no row action toolbar",
    );
    // The reserved papercut tag is not offered on Leads; the papercut list has no filter.
    ui.press("Filter leads by tag, All tags (1)");
    assert.equal(ui.query("Filter leads by tag: Papercut (1)"), undefined);
    ui.press("Filter leads by tag: All tags (1)");
    openView(ui, "Papercuts");
    assert.equal(countText(ui, "Cut one"), 1);
    assert.equal(ui.query(/^Filter leads by tag/), undefined, "papercuts have no tag filter");
    openView(ui, "Leads");
    assert.equal(countText(ui, "Lead one"), 1);
    ui.press("Triage: Lead one");
    await settleUntil(
      ui,
      () =>
        ui.query("Lead detail") !== undefined &&
        ui.query("Check the brief") !== undefined,
      "the lead detail did not load",
    );
    assert.ok(ui.get("Leads list"), "opening a lead keeps the Leads list");
    assert.equal(
      ui.get("Approve the checked version").props.accessibilityState.disabled,
      true,
    );
    assert.match(ui.text(), /Lead has no brief to approve/);
    assertDarkTheme(ui);
    closeRecord(ui, "Close lead detail");
    assert.equal(ui.query("Lead detail"), undefined);
    openView(ui, "Papercuts");
    ui.press("Triage: Cut one");
    await settleUntil(
      ui,
      () =>
        ui.query("Papercut detail") !== undefined &&
        ui.query("Close as completed") !== undefined,
      "the papercut detail did not load",
    );
    assert.ok(ui.get("Promote"));
    assert.ok(ui.get("Close as completed"));
    assertDarkTheme(ui);
    closeRecord(ui, "Close papercut detail");
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
  }
}

test("026-14/A2 the bundled Planning tab renders its roadmap in the dark theme", async () => {
  const MainSurface = await bundleMainSurface();
  // A project with no recent activity is grouped as dormant, which the Planning tab folds away; this one has activity.
  const previousProjects = board.projects;
  const previousActivity = board.projectActivity;
  board.projects = [
    {
      ...project,
      owner: {
        agentId: "thread",
        assignedBy: "operator",
        assignedAt: "2026-09-27T00:00:00.000Z",
        note: "",
      },
    },
  ] as never;
  board.projectActivity = recentProjectActivity(board.projects);
  const ui = mount(tree(MainSurface, false));
  try {
    await settle(ui);
    navigationButton(ui, "Planning").props.onPress();
    await settleUntil(
      ui,
      () => ui.text().includes("Version 1"),
      `the bundled Planning tab did not render its roadmap: ${ui.text().slice(0, 600)}`,
    );
    assert.ok(ui.get("Now band"));
    assert.match(ui.text(), /Version 1/);
    assert.doesNotMatch(
      ui.text(),
      /Loading plan/,
      "a saved version at the current plan version renders at once",
    );
    assert.ok(ui.get("Open lane first"), "the roadmap lists its lanes");
    for (const view of ui.ofType("View"))
      assert.equal(
        view.children.some((child) => typeof child === "string"),
        false,
        `raw text child under View ${view.props.accessibilityLabel ?? ""}`,
      );
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
    board.projects = previousProjects;
    board.projectActivity = previousActivity;
  }
});

test("026-13/15 the bundled inbox renders in the dark theme at the wide viewport", async () => {
  await verifyViewport(false);
});

test("026-13/15 the bundled inbox renders in the dark theme at the medium viewport", async () => {
  await verifyViewport(true);
});

test("141 the bundled inbox distinguishes dispatch and merge holds in the dark theme", async () => {
  const originalTasks = board.tasks;
  board.tasks = [
    ...originalTasks,
    {
      ...summary("dispatch-held", "Ordinary hold", [], "queued"),
      held: true,
      holdKind: "dispatch",
    },
    {
      ...summary("merge-held", "Merge hold", [], "queued"),
      reason: "Waiting for prerequisites",
      held: true,
      holdKind: "merge",
    },
  ];
  let ui: ReturnType<typeof mount> | undefined;
  try {
    const MainSurface = await bundleMainSurface();
    ui = mount(tree(MainSurface, false));
    await settle(ui);
    // Held queued work stays in Queue.
    openView(ui, "Queue");
    assert.equal(countText(ui, "Dispatch held"), 1);
    assert.equal(countText(ui, "Merge held"), 1);
    assert.ok(
      ui.text().includes("Waiting for prerequisites"),
      "the queued merge hold keeps its prerequisite reason",
    );
    const mergeCard = ui
      .ofType("Pressable")
      .find((node) =>
        String(node.props.accessibilityLabel).startsWith(
          "app, Merge hold, Queued, Merge held",
        ),
      );
    assert.ok(
      mergeCard,
      "the merge-held queued task retains its queued state in the card label",
    );
    assert.equal(ui.query("On hold"), undefined);
    for (const [label, color] of [
      ["Dispatch held", dark.statusWarning],
      ["Merge held", dark.accent],
    ] as const) {
      const badge: HostNode | undefined = ui
        .all(label)
        .find((node) => node.props.accessibilityLabel === label);
      assert.ok(badge, `${label} badge renders`);
      assert.equal(
        (badge.props.style as { borderColor: string }).borderColor,
        color,
        `${label} uses its distinct dark-theme tone`,
      );
    }
    assertDarkTheme(ui);
  } finally {
    if (ui) unmount(ui);
    board.tasks = originalTasks;
  }
});

/** A Spec 032 decision fixture the mutating RPC stub below can answer or withdraw. */
type DecisionFixture = Record<string, unknown> & {
  id: string;
  status: string;
  answer: Record<string, unknown> | null;
  withdrawal: Record<string, unknown> | null;
};
const decision = (over: Record<string, unknown>): DecisionFixture => ({
  id: "dec-fresh",
  version: 1,
  question: "Which branch do we cut?",
  headline: over.headline ?? over.question ?? "Which branch do we cut?",
  context: "Release is Friday.",
  details: "Release is Friday.",
  choices: Object.hasOwn(over, "choices")
    ? over.choices
    : [
        { label: "main", consequence: "Cut from main." },
        { label: "release", consequence: "Cut from release." },
      ],
  recommended: over.recommended ?? "main",
  options: ["main", "release"],
  recommendation: "Cut from main.",
  askedBy: {
    agentId: "worker-1",
    project: { origin: "owner/app", path: "/app" },
  },
  links: { tasks: ["shared"], leads: ["lead-1"], papercuts: [] },
  status: "open" as string,
  answer: null,
  withdrawal: null,
  supersededBy: null,
  delivery: null,
  // Task 1183: the board names who asked — the task reference and role, never a bare thread ID.
  askerLabel: "project-a-accelerator#5747 worker",
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  versions: [],
  stale: false,
  ...over,
});

test("032 the bundled inbox shows agent decisions and Nucleus-raised merge holds under Needs you in the dark theme", async () => {
  const stamp = new Date().toISOString();
  const fresh = decision({});
  const stale = decision({
    id: "dec-stale",
    question: "Still worth splitting?",
    stale: true,
    context: null,
    choices: undefined,
    options: ["Keep", "Remove"],
    recommendation: null,
    links: { tasks: [], leads: [], papercuts: [] },
  });
  const withdrawable = decision({
    id: "dec-withdraw",
    question: "Rename the lane?",
    context: null,
    options: [],
    recommendation: null,
    askedBy: {
      agentId: "worker-2",
      project: { origin: "owner/app", path: "/app" },
    },
    askerLabel: "unlaned worker",
    overtakenBy: [
      {
        kind: "brief_amendment",
        id: "unlaned",
        sourceId: "brief-v2",
        label: "Brief amendment for task unlaned: updated scope",
        at: stamp,
      },
    ],
    links: { tasks: ["unlaned"], leads: [], papercuts: [] },
  });
  const general = decision({
    id: "dec-general",
    question: "Where should this decision live?",
    context: null,
    options: [],
    recommendation: null,
    askedBy: { agentId: "thread-general", project: null },
    askerLabel: "an earlier thread",
    links: { tasks: ["project-d-task"], leads: [], papercuts: [] },
  });
  const decisions = new Map<string, DecisionFixture>([
    [fresh.id, fresh],
    [stale.id, stale],
    [withdrawable.id, withdrawable],
    [general.id, general],
  ]);
  const answers: Array<Record<string, unknown>> = [],
    withdrawals: Array<Record<string, unknown>> = [];
  const originalProjects = board.projects,
    originalTasks = board.tasks;
  board.projects = [project, projectDProject];
  // This fixture serves its own open decisions. The board's decision read is keyed on the
  // store revision (#1011), so the store moves, as it does whenever decisions change.
  board.revision++;
  board.tasks = tasks
    .map((task) =>
      task.id === "shared"
        ? {
            ...task,
            number: 5747,
            reference: "project-a-accelerator#5747",
            title: "Close the F1 and F3 checks",
            waitState: {
              state: "needs_operator_input" as const,
              owner: "operator",
              nextAction: "Answer decision dec-fresh",
              decisionId: "dec-fresh",
            },
          }
        : task,
    )
    .concat([
      {
        ...summary("project-d-task", "Project-D task", [], "working"),
        repoPath: projectDRepo.path,
        repository: projectDRepo.origin,
      },
      {
        ...summary("held-task", "Held reviewed task", ["first"], "verifying"),
        held: true,
        holdKind: "merge",
        holdEscalated: true,
        hold: {
          owner: "agent-hold",
          reason: "External receipt pending",
          since: stamp,
        },
      },
    ]);
  const rpc = async (method: string, input: unknown) => {
    if (method === "decision.list")
      return [...decisions.values()].filter((item) => item.status === "open");
    if (method === "decision.get")
      return decisions.get((input as { id: string }).id) ?? {};
    if (method === "decision.answer") {
      answers.push(input as Record<string, unknown>);
      const item = decisions.get((input as { id: string }).id)!;
      item.status = "answered";
      item.version = 2;
      item.answer = {
        text: answers.at(-1)!.answer as string,
        answeredBy: answers.at(-1)!.answeredBy as string,
        answeredAt: stamp,
        relayed: null,
        note: "",
      };
      return item;
    }
    if (method === "decision.withdraw") {
      withdrawals.push(input as Record<string, unknown>);
      const item = decisions.get((input as { id: string }).id)!;
      item.status = "withdrawn";
      item.version = 2;
      item.withdrawal = {
        reason: withdrawals.at(-1)!.reason as string,
        withdrawnBy: withdrawals.at(-1)!.withdrawnBy as string,
        withdrawnAt: stamp,
      };
      return item;
    }
    return invoke(method, input);
  };
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false, rpc));
  try {
    await settle(ui);
    // Needs you is one list: four agent decisions and one Nucleus-raised merge hold, with the
    // attention tasks after them. Each card names its kind; there are no section headers (Tom, 2026-11-21).
    assert.equal(countText(ui, "Hold"), 1, "the escalated merge hold names its kind");
    assert.equal(ui.query(/ section, \d+$/), undefined, "Needs you has no section headers");
    const needsTotal = Number(
      String(ui.get(/^Needs you, \d+$/).props.accessibilityLabel).split(", ")[1],
    );
    assert.ok(needsTotal >= 5, `the menu counts every Needs you card: ${navigationLabels(ui).join(" | ")}`);
    assert.equal(countText(ui, `${needsTotal} items`), 1, "the list header counts the same total");
    // A Triage lead card carries no decision chip any more (Tom, 2026-11-07): its card is title, kind, project and state.
    assert.equal(
      countAcross(ui, "Decision"),
      11,
      `the four decision cards, each naming its kind, plus chips on the linked shared, unlaned and Project-D cards; project selector:${ui
        .all(/^Projects,/)
        .map((node) => node.props.accessibilityLabel)
        .join(", ")}; decisions: ${ui
        .ofType("Text")
        .map((node) => node.children.join(""))
        .filter((text) => text.includes("Decision"))
        .join(" | ")}`,
    );
    openView(ui, "Needs you");
    assert.equal(
      countText(ui, "Stale"),
      1,
      "the stale decision shows as stale, never hidden",
    );
    assert.equal(
      countText(ui, "Nucleus-raised"),
      1,
      "the escalated merge hold is visible under Needs you",
    );
    assert.ok(ui.query("Held merge: Held reviewed task"));
    assert.match(
      ui.text(),
      /Ready to merge, held for External receipt pending/,
    );
    assert.ok(ui.get("Release"));
    assert.ok(ui.get("Keep"));
    assert.ok(
      ui.query(/^Decision: Where should this decision live\?/),
      "a General decision is present under Needs you",
    );
    assert.equal(
      countText(ui, "General"),
      1,
      "the General decision has its own project label",
    );
    assert.equal(
      countText(ui, "linked: project-d"),
      1,
      "the General decision hints at its linked task project",
    );
    assert.match(
      ui.text(),
      /Asked project-a-accelerator#5747 worker · 3h ago · 2 links/,
      "the card names the task reference and role",
    );
    assert.ok(
      ui
        .text()
        .includes(
          "Task · project-a-accelerator#5747 · Close the F1 and F3 checks",
        ),
      "decision cards name linked tasks by reference and title",
    );
    // The linked shared task is working, so its card is in Active.
    openView(ui, "Active");
    assert.ok(
      ui.text().includes("Waiting on you · Which branch do we cut?"),
      "linked operator waits name the decision",
    );
    assert.ok(
      ui
        .ofType("Pressable")
        .some((node) =>
          String(node.props.accessibilityLabel).includes(
            "Waiting on you · Which branch do we cut?",
          ),
        ),
      "the task card accessibility label names the decision",
    );
    openView(ui, "Needs you");
    // Tom, 2026-09-29: cards named the asking agent's id, not the project it came from.
    assert.ok(
      countText(ui, "app") >= 3,
      "each decision card names its asking project",
    );
    assert.doesNotMatch(
      ui.text(),
      /agent-asker/,
      "the raw asker id is not the card label",
    );
    assert.doesNotMatch(
      ui.text(),
      /thread-general/,
      "an unplaced asker is never a bare thread ID",
    );
    assert.doesNotMatch(
      ui.text(),
      /Choose this direction|Accept the proposed direction/,
      "missing consequences never become placeholder filler",
    );
    assert.match(ui.text(), /Cut from main\./);
    assertDarkTheme(ui);
    // The decision modal starts with the compact question and choices; full details stay collapsed.
    ui.press(/^Decision: Which branch do we cut\?/);
    await settleUntil(
      ui,
      () => ui.query("Operator answer") !== undefined,
      "the decision modal did not load",
    );
    assert.doesNotMatch(
      ui.text(),
      /Release is Friday\./,
      "the long details start collapsed",
    );
    ui.press("Details, collapsed");
    await settleUntil(
      ui,
      () => ui.text().includes("Release is Friday."),
      "the decision details did not expand",
    );
    assert.match(ui.text(), /Release is Friday\./);
    assert.match(
      ui.text(),
      /Recommended · main — Cut from main\./,
      "the first choice is marked recommended and shows its consequence",
    );
    assert.match(
      ui.text(),
      /release — Cut from release\./,
      "the other choice shows its consequence",
    );
    assert.match(ui.text(), /Task · shared/);
    assert.match(ui.text(), /Lead · lead-1/);
    assert.equal(
      ui.get("Answer").props.accessibilityState.disabled,
      true,
      "an empty answer disables the button",
    );
    assert.equal(ui.get("Withdraw").props.accessibilityState.disabled, true);
    assertDarkTheme(ui);
    ui.type("Operator answer", "Cut from main at noon.");
    assert.equal(ui.get("Answer").props.accessibilityState.disabled, false);
    ui.press("Answer");
    await settleUntil(
      ui,
      () => ui.query("Record action result") !== undefined,
      "the answer result stayed out of the modal",
    );
    assert.equal(answers.length, 1);
    assert.equal(
      answers[0]!.answeredBy,
      "operator (board)",
      "the board answers with operator authority",
    );
    assert.equal(answers[0]!.relayed, false);
    assert.equal(answers[0]!.version, 1);
    // The Pipeline updates without reload: the answered decision leaves its column.
    await settleUntil(
      ui,
      () => ui.query(/^Decision: Which branch do we cut\?/) === undefined,
      "the answered decision stayed on the board",
    );
    assert.equal(countText(ui, `${needsTotal - 1} items`), 1, "the list count dropped");
    await settleUntil(
      ui,
      () => ui.text().includes("operator authority"),
      "the recorded answer did not render in the modal",
    );
    assertDarkTheme(ui);
    closeRecord(ui, "Close decision detail");
    // The withdraw path.
    ui.press(/^Decision: Rename the lane\?/);
    await settleUntil(
      ui,
      () => ui.query("Withdraw as overtaken") !== undefined,
      "the overtaken decision detail did not load",
    );
    assert.ok(
      ui.query(/View citing/),
      `the modal links to the exact citing amendment; labels: ${ui
        .all(/View citing/)
        .map((node) => node.props.accessibilityLabel)
        .join(" | ")}`,
    );
    ui.press("Withdraw as overtaken");
    await settleUntil(
      ui,
      () =>
        ui
          .text()
          .includes(
            "Withdrawn after Brief amendment for task unlaned: updated scope",
          ),
      "the one-click withdrawal did not record",
    );
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0]!.withdrawnBy, "operator (board)");
    assert.equal(
      withdrawals[0]!.reason,
      "Withdrawn after Brief amendment for task unlaned: updated scope",
    );
    await settleUntil(
      ui,
      () => ui.query(/^Decision: Rename the lane\?/) === undefined,
      "the withdrawn decision stayed on the board",
    );
    assert.equal(countText(ui, `${needsTotal - 2} items`), 1, "the list count dropped again");
    closeRecord(ui, "Close decision detail");
    // The stale decision stays open on the board until a human withdraws it.
    assert.ok(ui.query(/^Decision: Still worth splitting\?/));
    assert.equal(countText(ui, "Stale"), 1);
    assert.equal(
      countAcross(ui, "Decision"),
      5,
      "the stale and General decision cards keep their chips and kind labels, as does the linked Project-D task",
    );
    openView(ui, "Needs you");
    assertDarkTheme(ui);
    // A specific project filter keeps General and the held merge under Needs you.
    ui.press("Projects, All projects");
    assert.ok(ui.query("Project selector"));
    ui.press(/^Project App/);
    assert.equal(
      ui.get(/^Projects, /).props.accessibilityLabel,
      "Projects, App",
    );
    assert.equal(
      countText(ui, "Hold"),
      1,
      "the project filter keeps the held merge under Needs you",
    );
    assert.equal(
      countText(ui, "linked: project-d"),
      1,
      "the General task hint survives its linked project being filtered out",
    );
    assert.ok(
      ui.query("Needs you list"),
      "the Needs you list keeps General and the held merge under a specific project filter",
    );
    assert.equal(
      ui.query(/^Decisions \(/),
      undefined,
      "agent decisions remain under Needs you without a separate tab",
    );
    assert.ok(ui.query(/^Decision: Still worth splitting\?/));
    assert.ok(ui.query(/^Decision: Where should this decision live\?/));
    assert.equal(countText(ui, "linked: project-d"), 1);
    assertDarkTheme(ui);
  } finally {
    board.projects = originalProjects;
    board.tasks = originalTasks;
    board.revision++;
    unmount(ui);
  }
});

test("030-7 bundled dark-theme task detail offers routing before dispatch with eligible profiles and a required reason", async () => {
  const store = new Store(":memory:");
  try {
    const queued = store.insert(
      submissionSchema.parse({
        submissionId: "routing-ui",
        title: "Routing UI",
        repoPath: "/app",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      "a".repeat(40),
    );
    const started = store.insert(
      submissionSchema.parse({
        submissionId: "started-ui",
        title: "Started UI",
        repoPath: "/app",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      "a".repeat(40),
    );
    store.update(started.id, {
      phase: "working",
      agentIntent: true,
      agentId: "worker",
    });
    const parked = store.insert(
      submissionSchema.parse({
        submissionId: "parked-ui",
        title: "Parked UI",
        repoPath: "/app",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      "a".repeat(40),
    );
    store.update(parked.id, {
      phase: "verifying",
      workspaceIntent: true,
      agentActive: false,
    });
    const strong = {
      id: "strong",
      name: "Strong",
      provider: "test",
      model: "strong",
      available: true,
      problem: "",
      notes: "",
      supportedThinking: [],
    };
    const uiBoard = {
      ...board,
      tasks: [
        summary(queued.id, "Routing UI", [], "queued"),
        summary(started.id, "Started UI", [], "working"),
        { ...summary(parked.id, "Parked UI", [], "verifying"), parked: true },
      ],
      profiles: [strong],
      pool: [
        {
          profileId: "strong",
          enabled: true,
          group: "strong",
          roles: ["worker"],
          weight: "default",
          scopes: ["general"],
          capability: "frontier",
        },
      ],
    };
    const detail = createTaskDetailCache(store);
    let routingControl: unknown;
    let routingRequests = 0,
      routingCompletions = 0;
    const rpc = async (method: string, input: unknown) => {
      if (method !== "queue.task")
        return method === "queue.ui-snapshot"
          ? uiBoard
          : method === "queue.detail"
            ? detail((input as { taskId: string }).taskId)
            : invoke(method, input);
      routingRequests++;
      routingControl = input;
      // The control answers with a task, like the real RPC, and the fixture counts
      // the answer so completion is observed rather than assumed from the send.
      const answered = queued;
      routingCompletions++;
      return answered;
    };
    const MainSurface = await bundleMainSurface();
    // Below the wide layout the task detail is a modal with its own close control.
    const ui = mount(tree(MainSurface, true, rpc));
    try {
      await settle(ui);
      const routingCard = findCard(ui, (label) => label.includes("Routing UI"));
      assert.ok(routingCard, "the board never offered the queued task");
      routingCard.props.onPress();
      // PR #538 reads the detail in ten seconds: routing sits in the collapsed Technical group.
      await settleUntil(
        ui,
        () => ui.query("Technical") !== undefined,
        "the task detail never rendered its Technical tab",
      );
      ui.press("Technical");
      await settleUntil(
        ui,
        () => ui.query("Change routing") !== undefined,
        "the queued task detail never loaded its routing control",
      );
      assert.ok(ui.get("Change routing"));
      ui.press("Change routing");
      assert.ok(ui.get("Strong · request only"));
      assertDarkTheme(ui);
      // The required reason gates the save, including a whitespace-only entry.
      assert.equal(
        ui.get("Save routing").props.accessibilityState?.disabled,
        true,
      );
      ui.type("Reason (required)", "   ");
      assert.equal(
        ui.get("Save routing").props.accessibilityState?.disabled,
        true,
        "a blank reason never enables the save",
      );
      ui.type("Reason (required)", "Operator changed route");
      assert.equal(
        ui.get("Save routing").props.accessibilityState?.disabled,
        false,
      );
      ui.press("Save routing");
      // Semantic completion: the control answers, the surface applies the answer
      // (the routing panel closes) and the operation settles (the detail's
      // buttons are enabled again) before the detail is closed or reopened.
      await settleUntil(
        ui,
        () => routingCompletions === 1,
        "the routing control was never answered",
      );
      await settleUntil(
        ui,
        () => {
          const cancel = ui.query("Cancel task");
          return (
            Boolean(cancel) &&
            cancel!.props.accessibilityState?.disabled === false &&
            ui.query("Reason (required)") === undefined
          );
        },
        "the completed routing control never settled the task detail",
      );
      assert.equal(
        routingRequests,
        1,
        "one save sends exactly one routing control",
      );
      assert.equal(routingCompletions, 1, "the routing control answers once");
      assert.equal(
        (routingControl as { action: string }).action,
        "set_routing",
      );
      assert.equal(
        (routingControl as { reason?: string }).reason,
        "Operator changed route",
      );
      assert.equal(
        (routingControl as { relayed?: boolean }).relayed,
        undefined,
        "the board claims no relayed authorization",
      );
      assert.equal(
        (routingControl as { note?: string }).note,
        undefined,
        "the board appends no authorization note",
      );
      assert.ok(
        ui.query("Task detail"),
        "the detail stays open across the completed routing control",
      );
      assertDarkTheme(ui);
      ui.press("Close task detail");
      assert.equal(
        ui.query("Task detail"),
        undefined,
        "closing the detail removes the modal",
      );
      findCard(ui, (label) => label.includes("Started UI"))!.props.onPress();
      await settleUntil(
        ui,
        () => ui.query("Close task detail") !== undefined,
        "the started task detail never reopened",
      );
      assert.equal(
        ui.query("Change routing"),
        undefined,
        "a started task offers no routing change",
      );
      ui.press("Close task detail");
      findCard(ui, (label) => label.includes("Parked UI"))!.props.onPress();
      await settleUntil(
        ui,
        () => ui.text().includes("Parked (no slot held)"),
        "parked task detail omitted its slot status",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  } finally {
    store.close();
  }
});

test("026-15a bundled inbox records run each action and report in their detail", async () => {
  const stamp = "2026-09-27T00:00:00.000Z";
  const digest = `sha256:${"a".repeat(64)}`;
  const body = "---\ntitle: Lead one\n---\n\n## Outcome\n\nShip it.\n";
  const actionLead = {
    ...lead,
    body,
    digest,
    check: {
      ok: false,
      message: "Brief missing queue.lane",
      checkedAt: stamp,
      planningCommit: null as string | null,
    },
  };
  const dropLead = {
    ...lead,
    id: "lead-drop",
    title: "Lead drop",
    body: "Drop me",
  };
  const cut = {
    ...papercut,
    fix: "Patch it" as string | null,
    area: "queue" as string | null,
  };
  const versions = (item: typeof lead) => [
    {
      version: item.version,
      title: item.title,
      body: item.body,
      author: item.author,
      createdAt: item.createdAt,
      digest: item.digest,
      check: item.check,
    },
  ];
  const papercutPromotions: unknown[] = [];
  const rpc = async (method: string, input: unknown) => {
    if (method === "lead.board") {
      return {
        cards: boardCards([
          actionLead,
          dropLead,
          leadFromPapercut(cut as Papercut),
        ]).map(boardRow),
        links: [],
      };
    }
    if (method === "lead.get") {
      const id = (input as { id: string }).id;
      const item = id === dropLead.id ? dropLead : actionLead;
      const detail = { ...item, versions: versions(item) };
      return {
        ...detail,
        actions: leadActions(detail as unknown as LeadStatusFacts),
      };
    }
    if (method === "lead.check") {
      actionLead.check = {
        ok: true,
        message: "Ready",
        checkedAt: stamp,
        planningCommit: "c".repeat(40),
      };
      return { ...actionLead };
    }
    if (method === "lead.approve") {
      actionLead.approval = {
        version: actionLead.version,
        digest,
        approver: "operator (board)",
        approvedAt: stamp,
        note: "",
        relayed: false,
      };
      return { ...actionLead };
    }
    if (method === "lead.promote-task") {
      actionLead.state = "promoted";
      actionLead.targets = [
        {
          kind: "task" as const,
          repository: "owner/app",
          reference: "task-1",
          at: stamp,
        },
      ];
      return { taskId: "task-1", reference: "owner/app#1" };
    }
    if (method === "lead.drop") {
      dropLead.state = "dropped";
      dropLead.dropReason = (input as { reason: string }).reason;
      return { ...dropLead };
    }
    if (method === "papercut.list")
      return cut.state === ((input as { state?: string }).state ?? "open")
        ? [cut]
        : [];
    if (method === "papercut.get") return { ...cut };
    if (method === "papercut.edit") {
      const edit = input as {
        title?: string;
        area?: string;
        happened?: string;
        impact?: string;
        fix?: string;
      };
      cut.title = edit.title ?? cut.title;
      cut.area = edit.area || null;
      cut.happened = edit.happened ?? cut.happened;
      cut.impact = edit.impact ?? cut.impact;
      cut.fix = edit.fix || null;
      cut.version++;
      return { ...cut };
    }
    if (method === "papercut.promote-task") {
      papercutPromotions.push(input);
      cut.state = "promoted";
      cut.taskId = "task-2";
      return { taskId: "task-2", reference: "owner/app#2" };
    }
    if (method === "papercut.close") {
      cut.state = "closed";
      cut.closedReason = (
        input as { reason: "completed" | "deprecated" }
      ).reason;
      cut.note = (input as { note: string }).note;
      return { ...cut };
    }
    return invoke(method, input);
  };
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false, rpc));
  try {
    await settle(ui);
    openView(ui, "Leads");
    await settleUntil(
      ui,
      () => ui.text().includes("Lead one") && ui.text().includes("Lead drop"),
      "the 15a Leads list did not render",
    );
    assert.equal(ui.query("Promote"), undefined);
    ui.press("Triage: Lead one");
    await settleUntil(
      ui,
      () => ui.text().includes("Brief missing queue.lane"),
      "the failing-check reason did not render",
    );
    assert.equal(
      ui.get("Approve the checked version").props.accessibilityState.disabled,
      true,
    );
    ui.press("Check the brief");
    await settleUntil(
      ui,
      () =>
        ui.query("Check result") !== undefined &&
        ui.text().includes("Checks passed"),
      "check result stayed out of the modal",
    );
    ui.press("Approve the checked version");
    await settleUntil(
      ui,
      () =>
        ui.text().includes("Approved") &&
        ui.get("Approve the checked version").props.accessibilityState
          .disabled === true,
      "approve result stayed out of the modal",
    );
    ui.press("Promote to a task");
    await settleUntil(
      ui,
      () => ui.text().includes("Promoted as owner/app#1"),
      "promote result stayed out of the modal",
    );
    ui.press("More actions");
    assert.equal(
      ui.get("Drop the lead").props.accessibilityState.disabled,
      true,
    );
    assert.match(
      ui.text(),
      /Only open leads can be dropped; this lead is promoted/,
    );
    closeRecord(ui, "Close lead detail");
    ui.press("Triage: Lead drop");
    await settleUntil(
      ui,
      () => ui.query("More actions") !== undefined,
      "the drop lead modal did not load",
    );
    ui.press("More actions");
    await settleUntil(
      ui,
      () => ui.query("Drop reason") !== undefined,
      "the drop controls did not load",
    );
    ui.type("Drop reason", "Not needed");
    ui.press("Drop the lead");
    await settleUntil(
      ui,
      () => ui.text().includes("Dropped"),
      "drop result stayed out of the modal",
    );
    closeRecord(ui, "Close lead detail");
    openView(ui, "Papercuts");
    ui.press("Triage: Cut one");
    await settleUntil(
      ui,
      () =>
        ui.query("Papercut detail") !== undefined &&
        ui.query("Close as completed") !== undefined,
      "the papercut modal did not load",
    );
    // Spec 053: Promote waits for a complexity choice, then sends it.
    assert.equal(ui.get("Promote").props.accessibilityState.disabled, true);
    assert.match(ui.text(), /Choose a complexity first/);
    ui.press("Papercut complexity high");
    await settleUntil(
      ui,
      () => ui.get("Promote").props.accessibilityState.disabled === false,
      "Promote stayed disabled after choosing a complexity",
    );
    ui.press("Promote");
    await settleUntil(
      ui,
      () => ui.text().includes("Promoted as owner/app#2"),
      "papercut promote result stayed out of the modal",
    );
    assert.equal(papercutPromotions.length, 1);
    assert.equal((papercutPromotions[0] as { board: boolean }).board, true);
    assert.equal(
      (papercutPromotions[0] as { complexity: string }).complexity,
      "high",
      "the chosen complexity is sent",
    );
    ui.press("Edit");
    await settleUntil(
      ui,
      () =>
        ui.query("Save changes") !== undefined &&
        ui.query("What happened") !== undefined,
      "the papercut editor did not open",
    );
    assertDarkTheme(ui);
    ui.type("Title", "Cut corrected");
    ui.type("What happened", "The corrected detail");
    ui.type("Area", "queue UI");
    ui.press("Save changes");
    await settleUntil(
      ui,
      () =>
        ui.text().includes("Saved version 2") &&
        ui.text().includes("The corrected detail"),
      "papercut edit result stayed out of the modal",
    );
    assert.equal(cut.title, "Cut corrected");
    assert.equal(cut.version, 2);
    assert.equal(cut.state, "promoted");
    ui.type("Close note", "Done here");
    ui.press("Close as completed");
    await settleUntil(
      ui,
      () => ui.text().includes("Closed as completed"),
      "close result stayed out of the modal",
    );
    await settleUntil(
      ui,
      () => ui.text().includes("Already closed"),
      "the closed papercut state did not refresh",
    );
    const deprecated = ui.get("Close as deprecated");
    assert.equal(deprecated.props.accessibilityState.disabled, true);
    assert.match(ui.text(), /Already closed/);
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
  }
});

test("043 (a) the bundled inbox labels every declared wait state with owner and next action in the dark theme", async () => {
  const originalTasks = board.tasks;
  board.tasks = [
    ...originalTasks,
    {
      ...summary("wait-capacity", "Capacity wait", ["first"], "queued"),
      waitState: {
        state: "waiting_capacity",
        owner: "operator",
        nextAction: "Free a task slot",
      },
    },
    {
      ...summary("wait-prereq", "Prerequisite wait", ["first"], "queued"),
      waitState: {
        state: "waiting_prerequisite",
        owner: "Queue",
        nextAction: "Wait for the prerequisite to finish",
      },
    },
    {
      ...summary("wait-decision", "Decision wait", ["first"], "blocked"),
      waitState: {
        state: "needs_operator_input",
        owner: "operator",
        nextAction: "Answer decision dec-9",
        decisionId: "dec-9",
      },
    },
    {
      ...summary(
        "wait-rights",
        "Source rights wait",
        ["first"],
        "awaiting_review",
      ),
      waitState: {
        state: "needs_source_rights",
        owner: "operator",
        nextAction: "Grant source rights",
      },
    },
    {
      ...summary("wait-merge", "Merge wait", ["first"], "verifying"),
      held: true,
      holdKind: "merge",
      waitState: {
        state: "merge_hold",
        owner: "agent-hold",
        nextAction: "Release the hold, or keep it with a reason",
      },
    },
  ];
  const labels = [
    "Waiting for capacity",
    "Waiting for prerequisite",
    "Waiting on you · operator decision",
    "Needs source rights",
    "Merge hold",
  ] as const;
  try {
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, false));
    try {
      await settle(ui);
      // Each waiting card lives in one view; together they carry every label once.
      for (const label of labels)
        assert.equal(countAcross(ui, label), 1, `${label} renders once`);
      assert.equal(
        countAcross(ui, "Merge held"),
        0,
        "the wait-state merge hold replaces the duplicate Spec 040 badge",
      );
      const card = findCard(ui, (label) =>
        label.startsWith("app, Capacity wait, Queued, Waiting for capacity"),
      );
      assert.ok(card, "the card label names the wait state");
      const badge = ui
        .ofType("View")
        .find((node) =>
          String(node.props.accessibilityLabel ?? "").startsWith(
            "Wait state: Waiting for capacity",
          ),
        );
      assert.ok(badge, "the wait-state badge is accessible");
      assert.match(
        String(badge.props.accessibilityLabel),
        /owner operator; next Free a task slot/,
      );
      assert.ok(
        ui
          .ofType("View")
          .some((node) =>
            /Wait state: Waiting for prerequisite; owner Nucleus;/.test(
              String(node.props.accessibilityLabel ?? ""),
            ),
          ),
        "the persisted Queue owner is shown as Nucleus",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  } finally {
    board.tasks = originalTasks;
  }
});

test("decision waits use readable fallback labels in medium and wide lists", async () => {
  const originalTasks = board.tasks;
  const waitTask = {
    ...summary("operator-wait", "Operator wait", ["first"], "blocked"),
    waitState: {
      state: "needs_operator_input" as const,
      owner: "operator",
      nextAction: "Answer decision dec-operator",
      decisionId: "dec-operator",
    },
  };
  board.tasks = [...originalTasks, waitTask];
  const item = decision({
    id: "dec-operator",
    headline: "Choose the release window",
    question: "Choose the release window",
    options: [],
    choices: [],
    recommendation: null,
    links: { tasks: ["operator-wait"], leads: [], papercuts: [] },
  });
  const rpc = async (method: string, input: unknown) =>
    method === "decision.list" ? [item] : invoke(method, input);
  try {
    const MainSurface = await bundleMainSurface();
    for (const compact of [true, false]) {
      const ui = mount(tree(MainSurface, compact, rpc));
      try {
        await settle(ui);
        const card = findCard(ui, (label) => label.includes("Operator wait"));
        assert.ok(card);
        assert.ok(
          ui.text().includes("Waiting on you · operator decision"),
          "the operator wait fallback stays readable when its title is unavailable",
        );
        assert.match(
          String(card.props.accessibilityLabel),
          /Waiting on you · operator decision/,
        );
        const badge = ui
          .ofType("View")
          .find(
            (node) =>
              node.props.accessibilityLabel ===
              "Waiting on you · operator decision",
          );
        assert.ok(
          badge,
          "the badge accessibility label uses the same plain wording",
        );
        assert.doesNotMatch(
          String(card.props.accessibilityLabel),
          /dec-operator/,
        );
      } finally {
        unmount(ui);
      }
    }
  } finally {
    board.tasks = originalTasks;
  }
});

test("043 (a) bundled dark-theme task detail names the derived wait, its owner and next action", async () => {
  const store = new Store(":memory:");
  try {
    const task = store.insert(
      submissionSchema.parse({
        submissionId: "wait-detail",
        title: "Wait detail",
        repoPath: "/app",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      "a".repeat(40),
    );
    // Spec 043 (a2): the capacity wait is a current admission fact, not reason
    // text. The reason is deliberately unrelated so only the fact can derive it.
    store.update(task.id, { reason: "Dispatched into the queue" });
    const capacityReason = `${CAPACITY_WAIT_PREFIX} Global concurrent task-slot limit reached`;
    const detail = createTaskDetailCache(store, {
      slotAdmissionReason: () => capacityReason,
    });
    const uiBoard = {
      ...board,
      tasks: [
        ...board.tasks,
        summarizeTask(store.task(task.id), false, false, {
          slotAdmissionReason: capacityReason,
        }),
      ],
    };
    const rpc = async (method: string, input: unknown) =>
      method === "queue.ui-snapshot"
        ? uiBoard
        : method === "queue.detail"
          ? detail((input as { taskId: string }).taskId)
          : invoke(method, input);
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, false, rpc));
    try {
      await settle(ui);
      const waitCard = findCard(ui, (label) =>
        label.startsWith("app, Wait detail, Queued, Waiting for capacity"),
      );
      assert.ok(waitCard, "the capacity wait card remains available");
      waitCard!.props.onPress();
      // The Overview opens first and leads with the wait: its state, owner and next action.
      await settleUntil(
        ui,
        () => Boolean(ui.query(/^Wait: /)),
        "the task detail omitted its wait state",
      );
      assert.match(
        String(ui.query(/^Wait: /)?.props.accessibilityLabel),
        /^Wait: Waiting for capacity; owner operator; next .+$/,
        "the Overview names the capacity wait, its owner and next action",
      );
      assert.ok(
        ui.text().includes("Waiting for capacity"),
        "the wait state is visible on the Overview",
      );
      // Technical no longer repeats the wait state; its reference stays there.
      await settleUntil(
        ui,
        () => ui.query("Technical") !== undefined,
        "the task detail never rendered its Technical tab",
      );
      ui.press("Technical");
      await settleUntil(
        ui,
        () =>
          ui.query("Technical")?.props.accessibilityState?.selected === true,
        "the Technical tab did not open",
      );
      // The list row beside the detail keeps its own wait badge; the detail's visible wait line is what must not repeat.
      assert.equal(
        ui.text().includes("· next:"),
        false,
        "the wait state is not repeated on Technical",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  } finally {
    store.close();
  }
});

test("051 bundled dark-theme board marks an interactive task, and says when it is the operator's turn", async () => {
  const store = new Store(":memory:");
  try {
    const add = (id: string, title: string) =>
      store.insert(
        submissionSchema.parse({
          submissionId: id,
          title,
          repoPath: "/app",
          planningCommit: "a".repeat(40),
          handoffPath: "handoff.md",
          originAgentId: "origin",
          interactive: true,
        }),
        "host",
        "handoff",
        "a".repeat(40),
      );
    const running = store.update(
      add("interactive-running", "Interactive running").id,
      {
        phase: "working",
        agentId: "worker-a",
        reason: "Interactive session: the worker is running",
      },
    );
    const waiting = add("interactive-waiting", "Interactive waiting");
    const stop = {
      reason: "interactive" as const,
      detail:
        "Interactive session: waiting for the operator in the worker's thread",
      since: new Date().toISOString(),
      suggestedVerbs: [],
    };
    store.update(waiting.id, {
      phase: "working",
      agentId: "worker-b",
      reason: stop.detail,
      resolution: { ...waiting.resolution, stop },
    });
    const uiBoard = {
      ...board,
      tasks: [
        ...board.tasks,
        summarizeTask(store.task(running.id)),
        summarizeTask(store.task(waiting.id)),
      ],
    };
    const rpc = async (method: string, input: unknown) =>
      method === "queue.ui-snapshot" ? uiBoard : invoke(method, input);
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, false, rpc));
    try {
      await settle(ui);
      // Both sessions are working, so Active lists them.
      openView(ui, "Active");
      assert.equal(
        countText(ui, "Interactive"),
        1,
        "a running session shows the plain badge",
      );
      assert.equal(
        countText(ui, "Interactive · your turn"),
        1,
        "an idle session says it waits on the operator",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  } finally {
    store.close();
  }
});

// Finding 1 (nucleus-ui): a loading or failed board read is never reported as an empty inbox.
for (const compact of [false, true]) {
  const viewport = compact ? "medium" : "wide";
  test(`finding 1 a board still loading reads loading, never empty, at the ${viewport} viewport`, async () => {
    const pending = async (method: string, input: unknown) =>
      method === "queue.ui-snapshot"
        ? new Promise(() => {})
        : invoke(method, input);
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, compact, pending));
    try {
      await settleUntil(
        ui,
        () => ui.query("Needs you list") !== undefined,
        "the loading list did not render",
      );
      assert.ok(ui.text().includes("Loading…"), "the list says it is loading");
      assert.equal(
        ui.text().includes("Nothing here"),
        false,
        "loading is not reported as an empty list",
      );
      assert.equal(
        ui.text().includes("0 items"),
        false,
        "the list count is not a zero total",
      );
      assert.deepEqual(
        navigationLabels(ui),
        ["Needs you", "Planning", "Leads", "Papercuts", "Queue", "Active", "Working", "In review", "Closing"],
        "menu counts stay hidden until the board loads",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  });

  test(`finding 1 a failed board read says not loaded, never empty, at the ${viewport} viewport`, async () => {
    const failing = async (method: string, input: unknown) => {
      if (method === "queue.ui-snapshot")
        throw new Error("Snapshot read refused");
      return invoke(method, input);
    };
    const MainSurface = await bundleMainSurface();
    const ui = mount(tree(MainSurface, compact, failing, true));
    try {
      await settleUntil(
        ui,
        () => ui.text().includes("The board could not be read; see the error above."),
        "the failed list did not render",
      );
      assert.ok(ui.text().includes("Not loaded"), "the list count says not loaded");
      assert.equal(
        ui.text().includes("Nothing here"),
        false,
        "a failed read never reads empty",
      );
      assert.ok(
        ui.text().includes("Snapshot read refused"),
        "the failure is shown with the error banner",
      );
      assert.equal(
        navigationLabels(ui).some((label) => /, \d+$/.test(label)),
        false,
        "the menu shows no zero counts for a failed read",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  });

  // Tom, 2026-11-08: the swim-lane view is retired; the inbox (2026-11-21) lists each card once.
  // An empty board and a long list of cards in several lanes both read real totals.
  test(`the inbox lists an empty board and a long list of multi-lane cards with real totals at the ${viewport} viewport`, async () => {
    const respond =
      (uiBoard: unknown) => async (method: string, input: unknown) => {
        if (method === "queue.ui-snapshot") return uiBoard;
        if (method === "papercut.list") return [];
        if (method === "lead.board") return { cards: [], links: [] };
        return invoke(method, input);
      };
    const MainSurface = await bundleMainSurface();
    const empty = mount(
      tree(
        MainSurface,
        compact,
        respond({ ...board, tasks: [], pendingSubmissions: [], qaRuns: [] }),
      ),
    );
    try {
      await settle(empty);
      assert.deepEqual(
        navigationLabels(empty),
        ["Needs you, 0", "Planning", "Leads, 0", "Papercuts, 0", "Queue, 0", "Active, 0", "Working, 0", "In review, 0", "Closing, 0"],
        "every menu entry reads its real zero total",
      );
      assert.ok(empty.text().includes("Nothing here."), "an empty list says so");
      assert.ok(
        empty.query(/^Projects, /),
        "the project selector stays in the header",
      );
      assertDarkTheme(empty);
    } finally {
      unmount(empty);
    }
    const longTitle =
      "A task title written at length, so that it runs well past what a list row can hold and has to clamp to two lines "
        .repeat(3)
        .trim();
    const many = [
      ...Array.from({ length: 40 }, (_, index) =>
        summary(
          `multi-${index}`,
          `Multi-lane task ${index}`,
          index % 2 ? ["first", "second"] : ["second"],
          "queued",
        ),
      ),
      summary("long-queued", longTitle, ["first"], "queued"),
    ];
    const ui = mount(
      tree(MainSurface, compact, respond({ ...board, tasks: many })),
    );
    try {
      await settle(ui);
      openView(ui, "Queue");
      assert.equal(countText(ui, "41 items"), 1, "the list counts each card once");
      assert.ok(ui.query("Queue, 41"), "and so does the menu");
      for (let index = 0; index < 40; index++)
        assert.equal(
          countText(ui, `Multi-lane task ${index}`),
          1,
          `card ${index} renders once`,
        );
      const title = ui
        .ofType("Text")
        .find((node) => node.children.join("") === longTitle);
      assert.ok(title, "the long title renders in full in the row");
      assert.equal(
        title.props.numberOfLines,
        2,
        "the row clamps a long title to two lines",
      );
      assert.equal(
        ui.query(/lane, \d+ cards/),
        undefined,
        "no swim-lane row headers",
      );
      assert.equal(
        ui.query(/^Collapse /),
        undefined,
        "no per-cell collapse control",
      );
      assertDarkTheme(ui);
    } finally {
      unmount(ui);
    }
  });
}
