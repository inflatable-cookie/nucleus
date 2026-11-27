import { test } from "node:test";
import { recentProjectActivity } from "./support/project-activity";
import { boardDetailReply, boardTasks } from "./support/board-tasks";
import { leadActionHints } from "./support/lead-actions";
import assert from "node:assert/strict";
import React from "react";
import { readFileSync } from "node:fs";
import { createRustBoardTransport, type RustTask } from "../client/web/rust-board";
import { generatedProjectBadge, projectBadgeWebStyle } from "../shared/t3/project-badge";
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
import {
  hostRunRecordSchema,
  summarizeTask,
  type ProjectQaRun,
} from "../shared/contracts";
import { CAPACITY_WAIT_PREFIX } from "../shared/wait-state";
import { planningRead, space, toneSurface, wash } from "../client/design";
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

  repositories: [repo],
  primary: repo,
};
const projectDRepo = { origin: "owner/project-d", path: "/project-d" };
const projectDProject = {
  key: "project-d",
  name: "Project-D",
  version: 1,

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
  projectActivity: [] as Array<{
    key: string;
    items: Array<{ id: string; at: string; executing: boolean }>;
  }>,
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
      actions: leadActionHints(detail.repositories, {
        check: "Lead has no brief to check",
        approve: "Lead has no brief to approve",
      }),
    };
  }
  if (method === "queue.plans")
    return [{ ...plan, savedEntries: plan.entries }];
  if (method === "plan.get") return plan;
  return {};
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Bundle MainSurface with the fixture shell and render it in dark theme at
 * both viewport sizes.
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
    let refuseStop = true;
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
        if (refuseStop) throw new Error("Dispatch revision changed");
        board.paused = true;
        board.revision++;
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
      assertHeaderMenuInTopLayer(ui, "Queue controls", "Close queue controls");
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
      const beforeStop = calls.length;
      ui.press("Stop");
      await settleUntil(ui, () => ui.text().includes("Dispatch revision changed"), "Stop refusal was hidden");
      assert.equal(board.paused, false);
      assert.deepEqual(calls.slice(beforeStop).map((call) => call.method), ["queue.stop-threads"]);
      ui.press("Dismiss error");
      refuseStop = false;
      ui.press("Queue controls menu");
      const beforeRetry = calls.length;
      ui.press("Stop");
      await settleUntil(ui, () => board.paused, "Stop did not take effect");
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
        calls.slice(beforeRetry).map((call) => [call.method, call.input]),
        [["queue.stop-threads", { caller: "operator (board)" }]],
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
  rustRows?: RustTask[],
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
        ...(rustRows ? { rustBoard: () => {}, boardTransport: createRustBoardTransport(async () => Response.json(rustRows)) } : {}),
      }),
    }),
  });
}

/** Yield until the board read lands: the menu carries real counts and the open list has rendered. */
async function settle(ui: ReturnType<typeof mount>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (ui.query(/^Closing, \d+$/) && ui.query(/ list$/)) return;
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
/** A menu entry's name, without its count. Planning's count names its unit (nucleus#1546). */
const viewName = (label: string) => label.replace(/, \d+( open lanes)?$/, "");
const navigationButton = (ui: ReturnType<typeof mount>, name: string) => {
  const button = navigationButtons(ui).find(
    (node) => viewName(String(node.props.accessibilityLabel)) === name,
  );
  assert.ok(button, `missing ${name} menu entry`);
  return button;
};
/** Open a menu view by name. */
const openView = (ui: ReturnType<typeof mount>, name: string) =>
  navigationButton(ui, name).props.onPress();
/** The views that list task and decision cards. */
const cardViews = [
  "Needs you",
  "Queue",
  "Working",
  "In review",
  "Closing",
] as const;
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
  // A kind tile's tint is a palette role at low alpha (nucleus#1515), derived, not a literal.
  const palette: Set<string> = new Set([
    ...Object.values(dark),
    ...Object.values(projectBadgeWebStyle(generatedProjectBadge("App"), true)),
    ...Object.values(dark).map((value) => toneSurface(value, value)),
    toneSurface(dark.foreground, dark.foreground, 0.75),
    // Planning's review segment and idle banner tint a role at their own token alphas (nucleus#1531);
    // hover, selection, hairlines and status cards are washes at the `wash` alphas (nucleus#1540).
    ...[
      planningRead.reviewAlpha,
      planningRead.bannerAlpha,
      ...Object.values(wash),
    ].flatMap((alpha) =>
      Object.values(dark).map((value) => toneSurface(value, value, alpha)),
    ),
  ]);
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
      "Working",
      "In review",
      "Closing",
    ]);
    assert.ok(ui.get("Needs you list"), "the inbox opens on Needs you");
    assert.equal(
      ui.query(/^Tasks( \(|$|, )/),
      undefined,
      "no Tasks tab remains",
    );
    assert.equal(
      ui.query(/^QA runs/),
      undefined,
      "QA runs is retired as a board surface",
    );
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
    openView(ui, "Working");
    assert.equal(
      countText(ui, "Task working"),
      1,
      "working tasks open in Working",
    );
    openView(ui, "Closing");
    assert.equal(
      countText(ui, "Task closing"),
      1,
      "closing work is in Closing",
    );
    assert.equal(
      countText(ui, "Task working"),
      0,
      "an entry shows only its own cards",
    );
    assert.equal(countText(ui, "Task closing"), 1);
    // This fixture has no decisions: Needs you is one list with one empty state and a real zero.
    openView(ui, "Needs you");
    assert.ok(ui.query("Needs you list"), "Needs you is one list");
    assert.equal(
      ui.query(/ section, \d+$/),
      undefined,
      "Needs you has no section headers",
    );
    const needs = Number(
      String(ui.get(/^Needs you, \d+$/).props.accessibilityLabel).split(
        ", ",
      )[1],
    );
    assert.equal(
      countText(ui, `${needs} items`),
      1,
      "the list counts its real total",
    );
    assert.equal(
      ui.text().includes("Nothing here."),
      needs === 0,
      "an empty list says so, and a populated one does not",
    );
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
    assert.equal(
      countText(ui, "Cut one"),
      0,
      "papercuts sit in their own menu view",
    );
    assert.equal(
      ui.query(/^(Leads|Papercuts) tab, /),
      undefined,
      "no tab switch remains",
    );
    for (const label of ["Promote", "Approve", "Drop", "Check again"])
      assert.equal(
        ui.query(label),
        undefined,
        `list rows render no ${label} button`,
      );
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
    assert.equal(
      ui.query(/^Filter leads by tag/),
      undefined,
      "papercuts have no tag filter",
    );
    openView(ui, "Leads");
    assert.equal(countText(ui, "Lead one"), 1);
    ui.press(/^Lead: Lead one, Status: /);
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
    ui.press(/^Papercut: Cut one, Status: /);
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
      () => ui.query("Now column") !== undefined,
      `the bundled Planning tab did not render its roadmap: ${ui.text().slice(0, 600)}`,
    );
    assert.ok(ui.get("Focus"));
    assert.doesNotMatch(
      ui.text(),
      /Version 1/,
      "the read view never shows the version number",
    );
    assert.doesNotMatch(
      ui.text(),
      /Loading plan/,
      "a saved version at the current plan version renders at once",
    );
    assert.ok(ui.query(/^Open lane /), "the roadmap lists its lanes");
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
      ui.query(/Waiting for prerequisites/),
      "the queued merge hold keeps its prerequisite reason accessible",
    );
    const mergeCard = ui
      .ofType("Pressable")
      .find((node) =>
        String(node.props.accessibilityLabel).startsWith(
          "App, Merge hold, Queued, Merge held",
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
        (badge.props.style as { backgroundColor: string }).backgroundColor,
        toneSurface(color, dark.surface2),
        `${label} uses its distinct dark-theme tone as a tinted fill`,
      );
      assert.equal(
        (badge.props.style as { borderWidth?: number }).borderWidth,
        undefined,
        `${label} draws no outline`,
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


test("030-7 bundled dark-theme task detail offers routing before dispatch with eligible profiles and a required reason", async () => {
  const task = boardTasks();
  const queued = task("routing-ui", { title: "Routing UI" });
  const started = task("started-ui", {
    title: "Started UI",
    phase: "working",
    agentIntent: true,
    agentId: "worker",
  });
  const parked = task("parked-ui", {
    title: "Parked UI",
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
        weight: "default",
        capability: "frontier",
      },
    ],
  };
  const replies = new Map([queued, started, parked].map((row) => [
    row.id, boardDetailReply(row),
  ]));
  let routingControl: unknown;
  let routingRequests = 0,
    routingCompletions = 0;
  const rpc = async (method: string, input: unknown) => {
    if (method !== "queue.task")
      return method === "queue.ui-snapshot"
        ? uiBoard
        : method === "queue.detail"
          ? replies.get((input as { taskId: string }).taskId)
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
    // nucleus#1537: every editing action, routing included, lives in the ⋯ menu.
    await settleUntil(
      ui,
      () => ui.query("Task actions menu") !== undefined,
      "the task detail never rendered its actions menu",
    );
    ui.press("Task actions menu");
    await settleUntil(
      ui,
      () => ui.query("Change routing & profiles") !== undefined,
      "the queued task's menu never offered routing",
    );
    ui.press("Change routing & profiles");
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
        const menu = ui.query("Task actions menu");
        return (
          Boolean(menu) &&
          menu!.props.accessibilityState?.disabled !== true &&
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
    ui.press("Task actions menu");
    await settleUntil(
      ui,
      () =>
        ui.query("Cancel or supersede") !== undefined ||
        ui.query("Extend budget") !== undefined,
      "the started task's menu never opened",
    );
    assert.equal(
      ui.query("Change routing & profiles"),
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
    // The status line's state; its detail reads "· operator decision" beside it.
    "Waiting on you",
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
        label.startsWith("App, Capacity wait, Queued, Waiting for capacity"),
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
        assert.ok(ui.text().includes("Waiting on you"));
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
  // The current capacity fact provides the wait while the stored reason stays independent.
  const task = boardTasks()("wait-detail", {
    title: "Wait detail",
    reason: "Dispatched into the queue",
  });
  const context = {
    slotAdmissionReason: `${CAPACITY_WAIT_PREFIX} Global concurrent task-slot limit reached`,
  };
  const detail = boardDetailReply({
    ...task,
    reason: context.slotAdmissionReason,
    resolution: {
      ...task.resolution,
      stop: {
        reason: "capacity",
        detail: context.slotAdmissionReason,
        since: task.updatedAt,
        suggestedVerbs: [],
        fact: { code: "slot_capacity" },
      },
    },
  }, context);
  const uiBoard = {
    ...board,
    tasks: [
      ...board.tasks,
      summarizeTask(task, false, false, context),
    ],
  };
  const rpc = async (method: string, input: unknown) =>
    method === "queue.ui-snapshot"
      ? uiBoard
      : method === "queue.detail"
        ? detail
        : invoke(method, input);
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false, rpc));
  try {
    await settle(ui);
    const waitCard = findCard(ui, (label) =>
      label.startsWith("App, Wait detail, Queued, Waiting for capacity"),
    );
    assert.ok(waitCard, "the capacity wait card remains available");
    waitCard!.props.onPress();
    // The Overview opens first and leads with the wait in plain words: who acts and what Nucleus does.
    await settleUntil(
      ui,
      () => Boolean(ui.query(/^What is happening: /)),
      "the task detail omitted its wait state",
    );
    assert.match(
      String(ui.query(/^What is happening: /)?.props.accessibilityLabel),
      /^What is happening: Waiting · nothing to do\. Waiting for a machine-wide task slot$/,
      "the Overview names the global slot wait without blaming the project limit",
    );
    assert.ok(
      ui
        .text()
        .includes(
          "Nucleus starts it automatically when any task frees a slot",
        ),
      "the Overview says what Nucleus does next",
    );
    // Details opens beside it, and the header keeps the wait in view on every tab.
    ui.press("Details");
    await settleUntil(
      ui,
      () => ui.query("Details")?.props.accessibilityState?.selected === true,
      "the Details tab did not open",
    );
    assert.ok(
      ui.query("Task details"),
      "Details lists the task's reference facts",
    );
    assert.ok(ui.text().includes(task.id), "Details names the task ID");
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
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
        [
          "Needs you",
          "Planning",
          "Leads",
          "Papercuts",
          "Queue",
          "Working",
          "In review",
          "Closing",
        ],
        "menu counts stay hidden until the board loads",
      );
      for (const button of navigationButtons(ui))
        assert.equal(
          button.props.style.opacity,
          1,
          "no entry dims before its count loads",
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
        () =>
          ui
            .text()
            .includes("The board could not be read; see the error above."),
        "the failed list did not render",
      );
      assert.ok(
        ui.text().includes("Not loaded"),
        "the list count says not loaded",
      );
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
}

// nucleus#1525: at a narrow panel the same split menu lives in the drawer; each
// entry opens its own list and closes the drawer.
test("the narrow drawer lists Working, In review and Closing top-level with group gaps", async () => {
  const respond = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot")
      return {
        ...board,
        tasks: [
          summary("w1", "Working one", ["first"], "working"),
          summary("r1", "Review one", ["first"], "reviewing"),
        ],
        pendingSubmissions: [],
        qaRuns: [],
      };
    if (method === "papercut.list") return [];
    if (method === "lead.board") return { cards: [], links: [] };
    return invoke(method, input);
  };
  const MainSurface = await bundleMainSurface();
  const ui = mount(tree(MainSurface, false, respond));
  try {
    await settle(ui);
    // A 600-point panel folds the menu into a drawer behind a menu button.
    const panel = ui
      .ofType("View")
      .find((node) => typeof node.props.onLayout === "function");
    assert.ok(panel, "the board measures its panel");
    (panel as HostNode).props.onLayout({
      nativeEvent: { layout: { width: 600, height: 800 } },
    });
    assert.equal(
      ui.query("Nucleus navigation"),
      undefined,
      "the drawer starts closed",
    );
    assert.ok(ui.query("Open the board menu"), "the header offers the menu");
    ui.press("Open the board menu");
    assert.ok(ui.get("Board menu"), "the drawer opens");
    const menu = ui
      .get("Nucleus navigation")
      .children.filter((node): node is HostNode => typeof node !== "string");
    assert.deepEqual(
      menu.map((node) =>
        node.type === "Pressable"
          ? `entry:${viewName(String(node.props.accessibilityLabel))}`
          : node.type === "View" && node.props.style?.height === space.md
            ? "divider"
            : `other:${node.type}`,
      ),
      [
        "entry:Needs you",
        "divider",
        "entry:Planning",
        "entry:Leads",
        "entry:Papercuts",
        "entry:Queue",
        "divider",
        "entry:Working",
        "entry:In review",
        "entry:Closing",
      ],
      "the drawer carries the same split menu",
    );
    const dividers = menu.filter(
      (node) => node.type === "View" && node.props.style?.height === space.md,
    );
    assert.equal(dividers.length, 2);
    for (const divider of dividers)
      assert.equal(
        divider.props.style.backgroundColor,
        undefined,
        "the drawer's group gaps draw nothing",
      );
    assert.ok(ui.query("Working, 1"), "Working carries its own count");
    assert.ok(ui.query("Closing, 0"), "Closing reads its real zero");
    assert.equal(ui.query(/^Active/), undefined, "no Active entry remains");
    // Each entry opens its own list and closes the drawer.
    openView(ui, "Working");
    assert.ok(ui.query("Working list"), "Working opens its own list");
    assert.equal(
      ui.query("Board menu"),
      undefined,
      "picking an entry closes the drawer",
    );
    assert.equal(countText(ui, "1 item"), 1);
    assert.ok(ui.text().includes("Working one"));
    ui.press("Open the board menu");
    openView(ui, "Closing");
    assert.ok(ui.query("Closing list"), "Closing opens its own list");
    assert.equal(
      ui.query("Board menu"),
      undefined,
      "picking an entry closes the drawer",
    );
    assert.equal(countText(ui, "0 items"), 1);
    assertDarkTheme(ui);
  } finally {
    unmount(ui);
  }
});


/** Rows captured from the Rust /v1/tasks endpoint, with synthetic project names. */
async function rustRows(): Promise<RustTask[]> {
  const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/rust-task-order-rows.json", import.meta.url), "utf8"));
  const rows = await createRustBoardTransport(async () => Response.json(raw)).list(new AbortController().signal);
  return rows.map(row => ({ ...row, identity: { ...row.identity, repository: repo.origin } }));
}

for (const compact of [false, true]) {
  test(`026-13/15 dark Rust inbox shows the task columns and totals (${compact ? "medium" : "wide"})`, async () => {
    const rows = await rustRows();
    const previous = board.tasks;
    board.tasks = [];
    const ui = mount(tree(await bundleMainSurface(), compact, invoke, false, rows));
    try {
      await settleUntil(ui, () => Boolean(ui.query("History, 1")), "Rust task counts did not load");
      assert.deepEqual(navigationLabels(ui).map(viewName), ["Needs you", "Planning", "Leads", "Papercuts", "Queue", "Working", "In review", "Merging", "Closing", "History"]);
      const menu = ui.get("Nucleus navigation").children.filter((node): node is HostNode => typeof node !== "string");
      const gaps = menu.filter(node => node.type === "View" && node.props.style?.height === space.md);
      assert.equal(gaps.length, 2);
      for (const gap of gaps) assert.equal(gap.props.style.backgroundColor, undefined);
      assert.ok(ui.get("Needs you, 1"));
      assert.ok(ui.get("Queue, 3"));
      assert.ok(ui.get("Working, 1"));
      assert.ok(ui.get("In review, 1"));
      assert.ok(ui.get("Merging, 1"));
      assert.ok(ui.get("Closing, 1"));
      assert.match(ui.text(), /Needs task/);
      for (const [name, title] of [["Queue", "Queued task"], ["Working", "Working task"], ["In review", "Review task"], ["Merging", "Merging task"], ["Closing", "Closing task"], ["History", "History task"]]) {
        ui.press(new RegExp(`^${name},`));
        assert.match(ui.text(), new RegExp(title));
        assertDarkTheme(ui);
      }
    } finally { unmount(ui); board.tasks = previous; }
  });
}

test("032 Rust inbox places a work question and a held task in Needs you", async () => {
  const rows = await rustRows();
  const needs = rows[0]!;
  const question: RustTask = { ...needs, question: { work: { prompt: "Choose the next step", options: ["Continue", "Stop"] } } };
  const held: RustTask = { ...rows[1]!, identity: { ...rows[1]!.identity, id: "held", reference: "app#20" }, title: "Held merge", attention: "attention", hold: { reason: "Awaiting acceptance" } };
  const previous = board.tasks;
  board.tasks = [];
  const ui = mount(tree(await bundleMainSurface(), false, invoke, false, [question, held]));
  try {
    await settleUntil(ui, () => Boolean(ui.query("Needs you, 2")), "Needs you did not load");
    assert.match(ui.text(), /Choose the next step/);
    assert.match(ui.text(), /Held merge/);
  } finally { unmount(ui); board.tasks = previous; }
});

test("queue controls default to the current Rust menu", async () => {
  const previous = board.tasks;
  board.tasks = [];
  const ui = mount(tree(await bundleMainSurface(), false, invoke, false, await rustRows()));
  try {
    await settleUntil(ui, () => ui.query("Queue controls menu")?.props.disabled === false, "queue controls did not load");
    ui.press("Queue controls menu");
    assert.ok(ui.get("Pause"));
    assert.ok(ui.get("Dispatch hold"));
    assert.ok(ui.get("Stop"));
    assert.equal(ui.query(/^Project slot usage/), undefined);
  } finally { unmount(ui); board.tasks = previous; }
});

test("026-15a bundled records show the result of an action in their detail", async () => {
  const writes: unknown[] = [];
  const item = {
    id: "lead-1", kind: "lead" as const, projectKey: "app", projectName: "App", title: "Lead one", body: "Ship it.",
    lanes: [], repositories: [{ origin: repo.origin, bound: true }], author: "planner", state: "open" as const,
    reason: null, disposition: null, briefComplexity: null, revisitAt: null, taskId: null, version: 1,
    createdAtMs: null, updatedAtMs: null, history: [],
  };
  const rpc = async (method: string, input: unknown): Promise<unknown> => {
    if (method === "item.get") return item;
    if (method === "item.drop") {
      writes.push(input);
      return { ...item, state: "dropped", disposition: "deprecated", version: 2 };
    }
    return invoke(method, input);
  };
  const previous = board.tasks;
  board.tasks = [];
  const ui = mount(tree(await bundleMainSurface(), false, rpc, false, await rustRows()));
  try {
    await settleUntil(ui, () => Boolean(ui.query(/^Leads, /)), "Leads did not load");
    openView(ui, "Leads");
    await settleUntil(ui, () => Boolean(ui.query(/^Lead: Lead one, Status: /)), "lead did not load");
    ui.press(/^Lead: Lead one, Status: /);
    await settleUntil(ui, () => Boolean(ui.query("Open drop for lead")), "lead detail did not load");
    assertDarkTheme(ui);
    ui.press("Open drop for lead");
    ui.type("Note", "No longer needed");
    ui.press("Drop lead");
    await settleUntil(ui, () => Boolean(ui.query("State: Dropped · deprecated")), "drop result did not render");
    assert.deepEqual(writes, [{ id: "lead-1", project: "app", disposition: "deprecated", note: "No longer needed" }]);
    assertDarkTheme(ui);
  } finally { unmount(ui); board.tasks = previous; }
});

for (const compact of [false, true]) {
  test(`inbox totals count long multi-lane Rust task lists (${compact ? "medium" : "wide"})`, async () => {
    const rows = await rustRows();
    const working = rows.find(row => row.phase === "working")!;
    const many = Array.from({ length: 40 }, (_, i) => ({ ...working, identity: { ...working.identity, id: `long-${i}`, reference: `app#${i + 1}` }, title: `Long task ${i}`, number: i + 1, lanes: ["first", "second"] }));
    const previous = board.tasks;
    board.tasks = [];
    const ui = mount(tree(await bundleMainSurface(), compact, invoke, false, many));
    try {
      await settleUntil(ui, () => Boolean(ui.query("Working, 40")), "working total did not load");
      assert.ok(ui.get("Needs you, 0"));
      assert.match(ui.text(), /Nothing here\./);
      assert.ok(ui.get("Queue, 0"));
      ui.press("Working, 40");
      assert.match(ui.text(), /40 items/);
      assert.match(ui.text(), /Long task/);
      assertDarkTheme(ui);
    } finally { unmount(ui); board.tasks = previous; }
  });
}
