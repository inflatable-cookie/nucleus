import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The host wraps contributed components with these providers from the SDK's host
// entry. A static import keeps them in the same module cache the client bundle's
// own SDK imports resolve to (one React context instance).
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { taskSummarySchema } from "../shared/contracts";

useNativeStubs();

type QueueModule = typeof import("../client/queue");
let queue: QueueModule;
const load = async () => {
  queue = await import("../client/queue");
  return queue;
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
/** Deliberately unsorted: the popover must order most-used first, then name. */
const capacities = [
  {
    projectKey: "project-e",
    projectName: "project-e",
    occupiedSlots: 1,
    slotLimit: 4,
    inFlightTasks: 1,
    inFlightLimit: 8,
  },
  {
    projectKey: "book",
    projectName: "book",
    occupiedSlots: 0,
    slotLimit: 4,
    inFlightTasks: 3,
    inFlightLimit: 8,
  },
  {
    projectKey: "zebra",
    projectName: "zebra",
    occupiedSlots: 2,
    slotLimit: 4,
    inFlightTasks: 0,
    inFlightLimit: 8,
  },
  {
    projectKey: "apple",
    projectName: "apple",
    occupiedSlots: 2,
    slotLimit: 4,
    inFlightTasks: 5,
    inFlightLimit: 8,
  },
];
const boardOf = (projectCapacities: typeof capacities) => ({
  revision: 1,
  connected: true,
  hostId: "host",
  paused: false,
  error: "",
  quiet: true,
  activeWorkers: 0,
  unsettled: 0,
  occupiedSlots: 5,
  globalLimit: 16,
  projectLimit: 4,
  projectCapacities,
  tasks: [parkedTask],
  profiles: [],
  pool: [],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes: [],
  projects: [project],
  prStates: {},
});

const invokeFor =
  (board: ReturnType<typeof boardOf>) =>
  async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") {
      const revision = (input as { revision?: number }).revision;
      if (revision !== undefined) {
        return {
          unchanged: true,
          revision,
          connected: true,
          paused: false,
          quiet: true,
          activeWorkers: 0,
          unsettled: 0,
          occupiedSlots: 5,
          error: "",
        };
      }
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
    if (method === "lead.board") return { cards: [], links: [] };
    if (
      method === "queue.plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "decision.list"
    )
      return [];
    return {};
  };

/** The slot table inside the queue menu (Tom, 2026-11-21: moved out of the header's status line). */
const SLOTS = /^Project slot usage \(/;

const surfaceProps = {
  theme: { colors: c },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "ios" as const },
};

/** One Queue surface; `client` is shared so a refresh observes one query. */
function surfaceTree(client: QueryClient) {
  return h(QueryClientProvider, {
    client,
    children: h(PluginRpcProvider, {
      invoke: invokeFor(boardOf(capacities)),
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

test("665 the queue menu holds the slot table, with only projects using a slot; the header has no status line (Tom, 2026-11-21)", async () => {
  await load();
  const client = new QueryClient();
  const ui = mount(surfaceTree(client));
  try {
    // The board is connected once the queue controls are enabled.
    await settle(
      () => ui.query("Queue controls menu")?.props.accessibilityState?.disabled === false,
    );
    // The status line left the header; a normal running queue shows no state pill.
    assert.ok(!ui.text().includes("Running ·"), "the header has no status line");
    assert.equal(ui.query("Queue state"), undefined, "a running queue shows no state pill");
    assert.equal(
      ui.query(SLOTS),
      undefined,
      "the slot table starts closed",
    );
    assert.ok(
      !ui.text().includes("project-e"),
      "no per-project row renders inline",
    );
    // The queue menu opens as an anchored dropdown, not a Modal, with the slot table inside.
    ui.press("Queue controls menu");
    assert.ok(ui.get(SLOTS), "the slot table opens with the queue menu");
    assert.ok(ui.text().includes("5/16 global · project default 4"), "the table keeps the global use and the project default");
    assert.equal(
      ui.ofType("Modal").length,
      0,
      "the popover never uses a full-screen Modal",
    );
    // Dismissal ordering, not just coverage: the outside-press layer sits
    // above the header controls and the board, while the open menu renders in
    // the shell's popover layer above the layer — so presses anywhere outside
    // the panel reach the layer first, and scroll and presses on the capped
    // menu still land on the menu.
    // (The stub renderer has no hit testing; the layering is the interaction.)
    const overlayZ =
      (ui.get("Close queue controls").props.style as { zIndex?: number })
        .zIndex ?? 0;
    assert.ok(
      overlayZ > 20,
      "the outside-press layer covers the header controls (nav row zIndex 20) and the board",
    );
    // Queue #1391: the popover renders in the shell's top layer, above the
    // board columns, instead of climbing a z-index ladder inside the header —
    // an anchored dropdown there is painted over by the column cards, and no
    // zIndex leaves the header's stacking context.
    const { POPOVER_LAYER_ID } = await import("../client/popover");
    const layer = ui
      .ofType("View")
      .find((node) => node.props.testID === POPOVER_LAYER_ID);
    assert.ok(layer, "the board shell mounts one popover layer");
    const inLayer = (root: HostNode, label: string): boolean =>
      root.children.some(
        (child) =>
          typeof child !== "string" &&
          (child.props.accessibilityLabel === label || inLayer(child, label)),
      );
    assert.ok(
      layer && inLayer(layer, "Queue controls"),
      "the queue menu renders in the top layer, above the board",
    );
    assert.ok(ui.get("apple, 2 of 4 slots, 5 of 8 in flight"));
    assert.ok(ui.get("zebra, 2 of 4 slots, 0 of 8 in flight"));
    assert.ok(ui.get("project-e, 1 of 4 slots, 1 of 8 in flight"));
    // Visibility is by slots in use only: tasks in flight with no live agent stay out.
    assert.equal(
      ui.query(/book, /),
      undefined,
      "a project with in-flight tasks but no slot does not appear",
    );
    // Stable order: most-used first, then name.
    const order = ui.text();
    assert.ok(
      order.indexOf("apple") < order.indexOf("zebra") &&
        order.indexOf("zebra") < order.indexOf("project-e"),
      "rows order by slots used, then name",
    );
    // A live board refresh does not close the menu.
    await client.refetchQueries({ queryKey: ["nucleus", "state"] });
    assert.ok(ui.get(SLOTS), "the menu survives a board refresh");
    // The trigger toggles it closed again.
    ui.press("Queue controls menu");
    assert.equal(ui.query(SLOTS), undefined, "the trigger closes the menu");
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});

test("665 the queue menu closes on outside click and on Escape", async () => {
  await load();
  // Escape arrives as a DOM keydown on web hosts; the stub renderer has no
  // document, so this test lends it a minimal listener registry.
  const keyListeners: Array<(event: { key: string }) => void> = [];
  const globals = globalThis as unknown as { document?: unknown };
  const previousDocument = globals.document;
  globals.document = {
    addEventListener: (
      type: string,
      listener: (event: { key: string }) => void,
    ) => {
      if (type === "keydown") keyListeners.push(listener);
    },
    removeEventListener: (
      type: string,
      listener: (event: { key: string }) => void,
    ) => {
      if (type !== "keydown") return;
      const at = keyListeners.indexOf(listener);
      if (at >= 0) keyListeners.splice(at, 1);
    },
  };
  const client = new QueryClient();
  const ui = mount(surfaceTree(client));
  try {
    // The board is connected once the queue controls are enabled.
    await settle(
      () => ui.query("Queue controls menu")?.props.accessibilityState?.disabled === false,
    );
    ui.press("Queue controls menu");
    assert.ok(ui.get(SLOTS), "the menu opens");
    // Outside click closes it through the overlay press.
    ui.press("Close queue controls");
    assert.equal(ui.query(SLOTS), undefined, "an outside click closes the menu");
    ui.press("Queue controls menu");
    assert.ok(ui.get(SLOTS), "the menu reopens");
    // Other keys leave it open; Escape closes it through the keydown listener.
    keyListeners.forEach((listener) => listener({ key: "Enter" }));
    assert.ok(ui.get(SLOTS), "other keys leave the menu open");
    keyListeners.forEach((listener) => listener({ key: "Escape" }));
    assert.equal(ui.query(SLOTS), undefined, "Escape closes the menu");
  } finally {
    if (previousDocument === undefined) delete globals.document;
    else globals.document = previousDocument;
    ui.update(h("View", null));
    client.clear();
  }
});

test("665 the slot table says so in one line when no project uses a slot", async () => {
  await load();
  const client = new QueryClient();
  const empty = boardOf(
    capacities.map((entry) => ({ ...entry, occupiedSlots: 0 })),
  );
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: invokeFor(empty),
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );
  try {
    // The board is connected once the queue controls are enabled.
    await settle(
      () => ui.query("Queue controls menu")?.props.accessibilityState?.disabled === false,
    );
    assert.ok(
      !ui.text().includes("project-e"),
      "no per-project row renders inline",
    );
    ui.press("Queue controls menu");
    assert.ok(ui.get(SLOTS), "the slot table opens with the menu");
    assert.ok(
      ui.text().includes("No project is using a slot."),
      "the empty state reads in one line",
    );
  } finally {
    ui.update(h("View", null));
    client.clear();
  }
});
