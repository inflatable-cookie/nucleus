import { test } from "node:test";
import { recentProjectActivity } from "./support/fakes";
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
import { taskSummarySchema, type UiBoard } from "../shared/contracts";
import { BOARD_STATE_KEY } from "../client/board-state";
import { applyLiveUpdate, decodeLiveFrame } from "../client/web/live-channel";

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

test("1030 a run event or telemetry write refetches no planning list; a lead write refetches leads only", async () => {
  await load();
  const { clearDecisionRead } = await import("../client/decision-read");
  clearDecisionRead();
  const client = new QueryClient();
  const fake = domainBoard();
  const ui = mountDomainBoard(client, fake.rpc);
  try {
    await settle(() => ui.text().includes("Steady lead"));
    await settle(
      () =>
        fake.reads().every((count) => count > 0) && client.isFetching() === 0,
    );
    const before = fake.reads();
    for (let write = 0; write < 5; write++) {
      fake.unrelatedWrite();
      await client.refetchQueries({ queryKey: ["nucleus", "state"] });
      // Let the surface render the new board, so a query keyed on it would have started.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await settle(() => client.isFetching() === 0);
    }
    assert.deepEqual(
      fake.reads(),
      before,
      "five unrelated board revisions moved no planning read",
    );
    fake.leadWrite();
    await client.refetchQueries({ queryKey: ["nucleus", "state"] });
    await settle(
      () => fake.reads()[0] > before[0] && client.isFetching() === 0,
    );
    assert.deepEqual(
      fake.reads().slice(1),
      before.slice(1),
      "a lead write leaves decisions and plans alone",
    );
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});

for (const compact of [false, true]) {
  test(`1030 a new leads revision keeps Triage on screen while the read is pending (${compact ? "narrow" : "wide"})`, async () => {
    await load();
    const client = new QueryClient();
    const fake = domainBoard();
    const ui = mountDomainBoard(client, fake.rpc, compact);
    try {
      await settle(() => ui.text().includes("Steady lead"));
      let release!: () => void;
      fake.holdLeads(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                cards: [...fake.rows, fake.lead("New lead")],
                links: [],
              });
          }),
      );
      fake.leadWrite();
      await client.refetchQueries({ queryKey: ["nucleus", "state"] });
      await settle(() => typeof release === "function");
      assert.ok(
        ui.text().includes("Steady lead"),
        "the previous leads stay on screen while the new revision loads",
      );
      assert.ok(
        !ui.text().includes("Loading pipeline"),
        "no loading state replaces loaded cards",
      );
      release();
      await settle(() => ui.text().includes("New lead"));
    } finally {
      ui.update(h("View", null));
      client.clear();
    }
  });
}

test("1030 a failed leads refresh keeps the last list and marks it stale", async () => {
  await load();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const fake = domainBoard();
  const ui = mountDomainBoard(client, fake.rpc);
  try {
    await settle(() => ui.text().includes("Steady lead"));
    fake.holdLeads(async () => {
      throw Error("Leads offline");
    });
    fake.leadWrite();
    await client.refetchQueries({ queryKey: ["nucleus", "state"] });
    await settle(() =>
      ui
        .text()
        .includes(
          "Leads not refreshed: Leads offline. Showing the last loaded list.",
        ),
    );
    assert.ok(
      ui.text().includes("Steady lead"),
      "the last loaded leads stay on screen",
    );
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});

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

test("late RPC ack and full responses do not overwrite newer live frames, and older live frames do not overwrite RPC projections", async () => {
  await load();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const requestedRevisions: Array<number | undefined> = [];
  let heldSnapshot: ((value: unknown) => void) | null = null;
  let nextRpcResponse: unknown = boardWithTask(1, "task-1", "Initial board", 0);

  const rpc = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") {
      requestedRevisions.push((input as { revision?: number }).revision);
      if (heldSnapshot) {
        return new Promise((resolve) => {
          const resolveHeld = heldSnapshot!;
          heldSnapshot = null;
          // Expose resolver so the test controls exact arrival ordering.
          resolveHeld(resolve);
        });
      }
      return nextRpcResponse;
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
    await settle(() => ui.text().includes("Initial board"));
    assert.equal(requestedRevisions[0], undefined);

    // Arrival order 1 (ack): RPC starts at rev 1, live board rev 2 commits while RPC is in flight,
    // then RPC resolves with ack(1). Revision 2 must remain in cache and on screen.
    let releaseAckRpc!: (value: unknown) => void;
    heldSnapshot = (resolve) => {
      releaseAckRpc = resolve as (value: unknown) => void;
    };
    const ackRefetch = client.refetchQueries({
      queryKey: BOARD_STATE_KEY,
      exact: true,
    });
    await settle(() => typeof releaseAckRpc === "function");
    assert.equal(
      requestedRevisions.at(-1),
      1,
      "bounded read sends the retained revision",
    );

    applyLiveUpdate(
      client,
      decodeLiveFrame({
        event: "board",
        data: JSON.stringify(boardWithTask(2, "task-2", "Live rev 2", 3)),
      }),
    );
    await settle(() => ui.text().includes("Live rev 2"));

    releaseAckRpc(boardAck(1, 0));
    await ackRefetch;
    const afterLateAck = client.getQueryData<UiBoard>(BOARD_STATE_KEY);
    assert.equal(afterLateAck?.revision, 2);
    assert.equal(afterLateAck?.activeWorkers, 3);
    assert.ok(ui.text().includes("Live rev 2"));

    // Arrival order 1 (same-revision live counters while RPC ack is in flight):
    // live counters at rev 2 must not be clobbered by an in-flight ack(2) captured earlier.
    let releaseSameRevAck!: (value: unknown) => void;
    heldSnapshot = (resolve) => {
      releaseSameRevAck = resolve as (value: unknown) => void;
    };
    const sameRevRefetch = client.refetchQueries({
      queryKey: BOARD_STATE_KEY,
      exact: true,
    });
    await settle(() => typeof releaseSameRevAck === "function");
    applyLiveUpdate(
      client,
      decodeLiveFrame({
        event: "counters",
        data: JSON.stringify(boardAck(2, 7)),
      }),
    );
    assert.equal(
      client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.activeWorkers,
      7,
    );
    releaseSameRevAck(boardAck(2, 1));
    await sameRevRefetch;
    assert.equal(
      client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.activeWorkers,
      7,
    );

    // Arrival order 1 (older full response): RPC starts at rev 2, live rev 4 commits while in flight,
    // then RPC resolves with an older full response (rev 3). Revision 4 must remain.
    let releaseOldFullRpc!: (value: unknown) => void;
    heldSnapshot = (resolve) => {
      releaseOldFullRpc = resolve as (value: unknown) => void;
    };
    const oldFullRefetch = client.refetchQueries({
      queryKey: BOARD_STATE_KEY,
      exact: true,
    });
    await settle(() => typeof releaseOldFullRpc === "function");
    applyLiveUpdate(
      client,
      decodeLiveFrame({
        event: "board",
        data: JSON.stringify(boardWithTask(4, "task-4", "Live rev 4", 4)),
      }),
    );
    await settle(() => ui.text().includes("Live rev 4"));
    releaseOldFullRpc(boardWithTask(3, "task-3", "Older full rev 3", 0));
    await oldFullRefetch;
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 4);
    assert.ok(ui.text().includes("Live rev 4"));
    assert.ok(!ui.text().includes("Older full rev 3"));

    // Arrival order 2 (RPC commits newer projection first, then older live full board and ack arrive):
    nextRpcResponse = boardWithTask(6, "task-6", "RPC rev 6", 5);
    await client.refetchQueries({ queryKey: BOARD_STATE_KEY, exact: true });
    await settle(() => ui.text().includes("RPC rev 6"));
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 6);

    applyLiveUpdate(
      client,
      decodeLiveFrame({
        event: "board",
        data: JSON.stringify(boardWithTask(5, "task-5", "Older live rev 5", 1)),
      }),
    );
    applyLiveUpdate(
      client,
      decodeLiveFrame({
        event: "counters",
        data: JSON.stringify(boardAck(5, 1)),
      }),
    );
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 6);
    assert.equal(
      client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.activeWorkers,
      5,
    );
    assert.ok(ui.text().includes("RPC rev 6"));

    // Same-revision counter refresh via RPC ack is preserved when no newer live commit intervened.
    nextRpcResponse = boardAck(6, 8);
    await client.refetchQueries({ queryKey: BOARD_STATE_KEY, exact: true });
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 6);
    assert.equal(
      client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.activeWorkers,
      8,
    );
    assert.ok(ui.text().includes("RPC rev 6"));

    // Server replacement via RPC poll: a lower-revision full board when nothing committed in flight replaces the cache.
    nextRpcResponse = boardWithTask(1, "task-r1", "Replaced server rev 1", 0);
    await client.refetchQueries({ queryKey: BOARD_STATE_KEY, exact: true });
    await settle(() => ui.text().includes("Replaced server rev 1"));
    assert.equal(client.getQueryData<UiBoard>(BOARD_STATE_KEY)?.revision, 1);
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});
