import { test } from "node:test";
import { recentProjectActivity } from "./support/project-activity";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The host wraps contributed components with these providers from the SDK's host
// entry. A static import keeps them in the same module cache the client bundle's
// own SDK imports resolve to (one React context instance).
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { boardShellPlugin, mount, useNativeStubs } from "./support/render";
import { acrossViews, openView, planningEntry } from "./support/inbox";
/** The inbox lists one view at a time; card reads reach every view (support/inbox.ts). */
const mountInbox = (element: React.ReactElement) => acrossViews(mount(element));
import { build } from "esbuild";
import { createRequire } from "node:module";
import { taskSummarySchema, uiSnapshot, type UiBoard } from "../shared/contracts";
import { BOARD_STATE_KEY, nextBoardState } from "../client/board-state";

useNativeStubs();

type QueueModule = typeof import("../client/queue");
let queue: QueueModule;
const load = async () => {
  queue = await import("../client/queue");
  return queue;
};
const loadBundle = async () => {
  const bytes = (
    await build({
      entryPoints: [new URL("../client/queue.tsx", import.meta.url).pathname],
      bundle: true,
      plugins: [boardShellPlugin],
      platform: "node",
      format: "cjs",
      packages: "external",
      write: false,
    })
  ).outputFiles[0].text;
  const compiled = { exports: {} as QueueModule };
  new Function("require", "module", "exports", bytes)(
    createRequire(import.meta.url),
    compiled,
    compiled.exports,
  );
  queue = compiled.exports;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;

const repo = { origin: "owner/app", path: "/app" };
const project = {
  key: "app",
  name: "App",
  repositories: [repo],
  primary: repo,
  owner: {
    agentId: "thread",
    assignedBy: "operator",
    assignedAt: "2026-10-03T00:00:00.000Z",
    note: "",
  },
};
const parkedTask = taskSummarySchema.parse({
  id: "parked-task",
  title: "Held verification",
  repoPath: "/app",
  version: 1,
  number: null,
  reference: null,
  entrypoint: "worker",
  phase: "verifying",
  reason: "Waiting for a project slot…",
  held: false,
  parked: true,
  dependsOn: [],
  queuePriority: 0,
  profile: null,
  prUrl: null,
  resumePrNumber: null,
  completionPrNumber: null,
  originError: "",
  originLookupError: "",
  lanes: [],
  disposition: null,
  resolution: { attention: false, mergedCommit: null },
});
const board = {
  revision: 1,
  connected: true,
  hostId: "host",
  paused: false,
  error: "",
  quiet: true,
  activeWorkers: 0,
  unsettled: 0,
  occupiedSlots: 0,
  globalLimit: 32,
  projectLimit: 5,
  tasks: [parkedTask],
  profiles: [],
  pool: [],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes: [],
  projects: [project],
  projectActivity: recentProjectActivity([project]),
  prStates: {},
};

let fullFetches = 0,
  ackFetches = 0;
let leadRows: unknown[] = [];
const invoke = async (method: string, input: unknown) => {
  if (method === "queue.ui-snapshot") {
    const revision = (input as { revision?: number }).revision;
    if (revision !== undefined) {
      ackFetches++;
      return {
        unchanged: true,
        revision,
        connected: true,
        paused: false,
        quiet: true,
        activeWorkers: 0,
        unsettled: 0,
        occupiedSlots: 0,
        error: "",
      };
    }
    fullFetches++;
    // Keep the first board fetch in flight across the second surface's mount.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return board;
  }
  if (method === "queue.service-state")
    return {
      state: "running",
      detail: "",
      error: "",
      ready: true,
      paused: false,
      hostId: "host",
    };
  if (method === "lead.board") return { cards: leadRows, links: [] };
  if (
    method === "queue.plans" ||
    method === "papercut.list" ||
    method === "draft.list" ||
    method === "decision.list"
  )
    return [];
  return {};
};

const surfaceProps = {
  theme: { colors: c },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "ios" as const },
};

/** One Queue surface; `client` is shared across surfaces so they observe one query. */
function surfaceTree(client: QueryClient) {
  return h(QueryClientProvider, {
    client,
    children: h(PluginRpcProvider, {
      invoke,
      children: h(queue.MainSurface as never, surfaceProps),
    }),
  });
}

/** Yield until the probe holds or the attempt budget runs out. Each attempt waits
 * real time so react-query's batching and in-flight stub timers can land. */
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the surface did not settle");
}

test("026-14c both surfaces hydrate one board projection: a surface mounting after the board is cached renders at once and both keep planning", async () => {
  await load();
  const client = new QueryClient();
  const first = mountInbox(surfaceTree(client));
  await settle(() => first.text().includes("Parked (no slot held)"));
  // The second surface mounts with the board already cached (the workspace panel
  // opening while the operator's main surface is running).
  const second = mountInbox(surfaceTree(client));
  // It hydrates from the shared cached projection at once — no wait for its own poll.
  assert.ok(
    second.text().includes("Parked (no slot held)"),
    "the second surface renders the board without waiting for its own poll",
  );
  // Both surfaces reach the planning projection: sections and plan reads work on each.
  second.press(planningEntry);
  await settle(() => Boolean(second.raw.query("Plan for App")));
  first.press(planningEntry);
  await settle(() => Boolean(first.raw.query("Plan for App")));
  // An unchanged refresh merges the bounded counters into the shared projection.
  await client.refetchQueries({ queryKey: ["nucleus", "state"] });
  assert.ok(ackFetches >= 1, "the refresh sent the observed revision");
  assert.ok(
    Boolean(second.raw.query("Plan for App")),
    "planning survives the unchanged refresh",
  );
  assert.ok(
    first.text().includes("Parked (no slot held)") &&
      second.text().includes("Parked (no slot held)"),
    "both surfaces keep the projection through an unchanged refresh",
  );
  first.update(h("View", null));
  second.update(h("View", null));
});

test("026 rendered bundle in dark theme lists leads and papercuts as separate menu views and filters only leads by tag", async () => {
  await loadBundle();
  // The board read's narrow card rows; lead.get still serves the full record on selection.
  const makeLead = (id: string, tags: string[]) => ({
    id,
    title: id,
    preview: `Body of ${id}`,
    repositories: [repo],
    lanes: [],
    tags,
    papercutArea: null,
    state: "open" as const,
    version: 1,
    check: null,
    approved: false,
    targets: [],
  });
  // A briefed lead has left Triage through its own projection filter, so its tag must not
  // appear in the filter even though the read still carries it as a card candidate.
  const briefed = {
    ...makeLead("Briefed", ["briefed"]),
    state: "promoted" as const,
    targets: [{ kind: "task" as const, repository: repo.origin }],
  };
  leadRows = [
    makeLead("Tagged", ["papercut"]),
    makeLead("Plain", ["idea"]),
    briefed,
  ];
  const client = new QueryClient();
  const dark = new Proxy(
    { surface0: "#111111", surface1: "#1b1b1b", foreground: "#eeeeee" },
    { get: (value, key) => value[key as keyof typeof value] ?? "#888888" },
  ) as never;
  const ui = mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(queue.MainSurface as never, {
          ...surfaceProps,
          theme: { colors: dark },
        }),
      }),
    }),
  );
  try {
    // The board read lands after the lead read, so wait for both before counting anything.
    await settle(
      () =>
        ui.text().includes("Tagged") &&
        ui.text().includes("Plain") &&
        !ui.text().includes("Loading…"),
    );
    // Leads and Papercuts are menu entries of their own, each with its real total (Tom, 2026-11-21).
    openView(ui, "Leads");
    const leads = ui.raw;
    assert.ok(leads.query("Leads, 1") && leads.query("Papercuts, 1"));
    assert.equal(
      leads.query(/^(Leads|Papercuts) tab, /),
      undefined,
      "no tab switch inside Leads",
    );
    assert.ok(
      leads.text().includes("Plain") && !leads.text().includes("Tagged"),
    );
    // The tag filter sits in the list header, after the item count (Tom, 2026-11-21).
    assert.ok(leads.text().includes("1 item"));
    // A dropdown of the tags the Leads view shows, with counts (Tom, 2026-10-15). Papercuts are
    // their own list, so the reserved papercut tag is never offered here.
    leads.press("Filter leads by tag, All tags (1)");
    assert.deepEqual(
      leads
        .all(/^Filter leads by tag: /)
        .map((node) => node.props.accessibilityLabel),
      ["Filter leads by tag: All tags (1)", "Filter leads by tag: idea (1)"],
    );
    assert.ok(
      !leads.text().includes("Reserved"),
      "no reserved group: the papercut tag is not offered",
    );
    assert.equal(
      leads.query(/^Filter leads by tag: briefed/),
      undefined,
      "a tag only on briefed leads is not offered",
    );
    leads.press("Filter leads by tag: idea (1)");
    assert.ok(leads.text().includes("Plain"));
    // Papercuts are their own list, unfiltered by the Leads tag (Tom, 2026-11-21).
    openView(ui, "Papercuts");
    assert.ok(
      ui.raw.text().includes("Tagged") && !ui.raw.text().includes("Plain"),
    );
    assert.equal(
      ui.raw.query(/^Filter leads by tag/),
      undefined,
      "the papercut list has no tag filter",
    );
    // Back on Leads, the tag filter still narrows the list.
    openView(ui, "Leads");
    assert.ok(
      ui.raw.text().includes("Plain") && !ui.raw.text().includes("Tagged"),
    );
  } finally {
    ui.update(h("View", null));
    leadRows = [];
    client.clear();
  }
});

/** A board whose planning lists follow per-domain revisions (task 1030). */
function domainBoard() {
  const counts = new Map<string, number>();
  const planning = { leads: 1, decisions: 1, plans: 1 };
  let revision = 10;
  let leadRead: (() => Promise<unknown>) | null = null;
  const lead = (id: string) => ({
    id,
    title: id,
    preview: `Body of ${id}`,
    repositories: [repo],
    lanes: [],
    tags: [],
    papercutArea: null,
    state: "open" as const,
    version: 1,
    check: null,
    approved: false,
    targets: [],
  });
  const rows = [lead("Steady lead")];
  const rpc = async (method: string, input: unknown) => {
    counts.set(method, (counts.get(method) ?? 0) + 1);
    if (method === "queue.ui-snapshot") {
      if ((input as { revision?: number }).revision === revision)
        return {
          unchanged: true,
          revision,
          connected: true,
          paused: false,
          quiet: true,
          activeWorkers: 0,
          unsettled: 0,
          error: "",
          stoppedThreads: 0,
          resumedThreads: 0,
        };
      return { ...board, revision, planning: { ...planning } };
    }
    if (method === "lead.board" && leadRead) return leadRead();
    if (method === "lead.board") return { cards: rows, links: [] };
    return invoke(method, input);
  };
  const reads = () =>
    ["lead.board", "decision.list", "queue.plans"].map(
      (method) => counts.get(method) ?? 0,
    );
  /** A run event or telemetry write: the board revision moves, no planning domain does. */
  const unrelatedWrite = () => {
    revision++;
  };
  const leadWrite = () => {
    revision++;
    planning.leads++;
  };
  return {
    rpc,
    reads,
    rows,
    lead,
    unrelatedWrite,
    leadWrite,
    holdLeads: (read: (() => Promise<unknown>) | null) => {
      leadRead = read;
    },
  };
}

function mountDomainBoard(
  client: QueryClient,
  rpc: (method: string, input: unknown) => Promise<unknown>,
  compact = false,
) {
  return mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: rpc,
        children: h(queue.MainSurface as never, {
          ...surfaceProps,
          layout: { ...surfaceProps.layout, compact },
        }),
      }),
    }),
  );
}


test("an unavailable decision read stays visible on the board", async () => {
  await load();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rpc = async (method: string, input: unknown) => {
    if (method === "decision.list") throw Error("Decisions unavailable");
    return invoke(method, input);
  };
  const ui = mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: rpc,
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );
  try {
    await settle(() => ui.text().includes("Decisions unavailable"));
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});

function boardWithTask(
  revision: number,
  taskId: string,
  title: string,
  activeWorkers = 0,
) {
  return {
    ...board,
    revision,
    activeWorkers,
    occupiedSlots: activeWorkers,
    tasks: [{ ...parkedTask, id: taskId, title }],
  };
}

function boardAck(revision: number, activeWorkers: number) {
  return {
    unchanged: true as const,
    revision,
    connected: true,
    paused: false,
    dispatchHeld: false,
    drained: false,
    boundRuns: [],
    quiet: true,
    activeWorkers,
    unsettled: 0,
    occupiedSlots: activeWorkers,
    stoppedThreads: 0,
    resumedThreads: 0,
    error: "",
  };
}

test("board projection changes preserve matching counters and reject revisions out of order", () => {
  const projection = (revision: number, activeWorkers: number) =>
    uiSnapshot.output.parse(boardWithTask(revision, "task", "Retained task", activeWorkers));
  const retained = projection(7, 1);
  const matching = boardAck(7, 2);
  assert.deepEqual(nextBoardState(undefined, matching), matching);
  const merged = nextBoardState(retained, matching);
  assert.equal(merged.revision, 7);
  assert.equal(merged.activeWorkers, 2);
  assert.ok(!("unchanged" in retained) && !("unchanged" in merged));
  assert.deepEqual(merged.tasks, retained.tasks);

  assert.equal(nextBoardState(retained, boardAck(6, 9)), retained);
  assert.equal(nextBoardState(retained, boardAck(8, 9)), retained);
  assert.equal(nextBoardState(retained, projection(6, 9)), retained);
  assert.equal(nextBoardState(retained, projection(8, 4)).revision, 8);
  assert.equal(nextBoardState(retained, projection(7, 4)).activeWorkers, 4);
  assert.equal(nextBoardState(retained, projection(1, 0), { allowReplacement: true }).revision, 1);
  assert.equal(nextBoardState(retained, boardAck(1, 9), { allowReplacement: true }), retained);
});

test("a bounded board read keeps the projection and a replacement can restart its revision", async () => {
  await load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requestedRevisions: Array<number | undefined> = [];
  let response = uiSnapshot.output.parse(boardWithTask(6, "task-6", "Current board", 5));

  const rpc = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") {
      requestedRevisions.push((input as { revision?: number }).revision);
      return response;
    }
    return invoke(method, input);
  };
  const ui = mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: rpc,
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );

  try {
    await settle(() => ui.text().includes("Current board"));
    assert.deepEqual(requestedRevisions, [undefined]);

    response = boardAck(6, 8);
    await client.refetchQueries({ queryKey: BOARD_STATE_KEY, exact: true });
    assert.equal(requestedRevisions.at(-1), 6, "bounded read sends the retained revision");
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 6);
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.activeWorkers, 8);
    assert.ok(ui.text().includes("Current board"));

    response = uiSnapshot.output.parse(boardWithTask(1, "task-r1", "Replaced board", 0));
    await client.refetchQueries({ queryKey: BOARD_STATE_KEY, exact: true });
    await settle(() => ui.text().includes("Replaced board"));
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 1);
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});
