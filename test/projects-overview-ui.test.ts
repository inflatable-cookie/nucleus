/**
 * nucleus#1666: the Projects overview, one column per project. The projects and
 * lead board come from the board's real Rust adapter over the planning engine
 * stand-in, and the tasks are captured `/v1/tasks` rows parsed by the board
 * transport, so every count and card is read from the shapes the engine serves.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import {
  planningEngine,
  type StoredItem,
} from "./support/rust-planning-engine";
import { planningFixture } from "./support/planning-fixture";
import * as api from "../shared/contracts";
import { projectSelectorRows } from "../shared/project-scope";
import {
  createRustBoardTransport,
  rustProjectActivity,
  rustSelectorCounts,
  type RustTask,
} from "../client/web/rust-board";

useNativeStubs();
const h = React.createElement;
const colors = {
  accent: "#346cf1",
  accentForeground: "#ffffff",
  surface0: "#000000",
  surface1: "#111111",
  surface2: "#1c1c1c",
  border: "#333333",
  foreground: "#f5f5f5",
  foregroundMuted: "#818181",
  foregroundLabel: "#8f8f8f",
  statusSuccess: "#19bc7d",
  statusWarning: "#e8a33d",
  statusDanger: "#ef5b5b",
} as never;
const textOf = (node: HostNode | string): string =>
  typeof node === "string"
    ? node
    : node.children.map(textOf).join(" ").replace(/\s+/g, " ").trim();

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const item = (
  over: Partial<StoredItem> & Pick<StoredItem, "id" | "title" | "kind">,
): StoredItem =>
  ({
    author: "planner",
    body: "Fixture body.",
    lanes: [],
    state: "open",
    ...over,
  }) as StoredItem;

async function capturedRows(): Promise<RustTask[]> {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL("./fixtures/rust-task-order-rows.json", import.meta.url),
      "utf8",
    ),
  );
  return createRustBoardTransport(async () => Response.json(raw)).list(
    new AbortController().signal,
  );
}

/** The board's inputs from the Rust adapter: an archived project, leads and papercuts, and tasks in two projects. */
async function boardInputs() {
  const engine = planningEngine();
  engine.setProjectSettings("retired", {
    name: "Retired",
    archived: true,
    repositories: [
      { origin: "example/retired", path: "/work/retired", base: "main" },
    ],
  });
  const at = { actor: "planner", atMs: Date.now() - 60_000 };
  engine.seed(
    "orchard",
    item({ id: "o-lead-1", kind: "lead", title: "Orchard lead one" }),
    at,
  );
  engine.seed(
    "orchard",
    item({ id: "o-lead-2", kind: "lead", title: "Orchard lead two" }),
    at,
  );
  engine.seed(
    "orchard",
    item({ id: "o-cut-1", kind: "papercut", title: "Orchard papercut" }),
    at,
  );
  engine.seed(
    "orchard",
    item({
      id: "o-dropped",
      kind: "lead",
      title: "Dropped lead",
      state: "dropped",
      disposition: "deprecated",
      reason: null,
    } as never),
    at,
  );
  engine.seed(
    "nucleus",
    item({ id: "n-cut-1", kind: "papercut", title: "Nucleus papercut" }),
    at,
  );
  engine.seed(
    "retired",
    item({ id: "r-lead", kind: "lead", title: "Retired lead" }),
    at,
  );
  const { createRustAdapter } = await import("../client/web/rust-adapter");
  const { createRustApi } = await import("../client/web/rust-api");
  const adapter = createRustAdapter(createRustApi(engine.fetcher));
  const board = await adapter.rpc(api.uiSnapshot, {});
  assert.ok(!("unchanged" in board));
  const leadBoard = await adapter.rpc(api.leadBoard, {});
  const rows = await capturedRows();
  const into = (repository: string, id: string) => {
    const row = rows.find(({ identity }) => identity.id === `captured-${id}`)!;
    return {
      ...row,
      identity: {
        ...row.identity,
        id: `${repository}-${id}`,
        repository: `example/${repository}`,
      },
    };
  };
  // Orchard runs one task in every stage, three of them queued (one needs the operator); Nucleus has only a queued task; Acowtancy has none.
  const tasks: RustTask[] = [
    ...[
      "history",
      "closing",
      "merging",
      "review",
      "working",
      "heldQueue",
      "queue",
      "needs",
    ].map((id) => into("orchard-api", id)),
    into("nucleus", "queue"),
  ];
  const queuedCounts = rustSelectorCounts(board.projects, tasks);
  const projectActivity = rustProjectActivity(
    board.projects,
    tasks,
    leadBoard.activity ?? [],
  );
  return {
    projects: board.projects,
    leads: leadBoard.cards,
    tasks,
    selector: {
      tasks: board.tasks,
      leads: leadBoard.cards,
      queuedCounts,
      projectActivity,
    },
  };
}

type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
/** A synthetic browser store: a map behind the Storage calls the overview makes. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    } satisfies Storage,
  };
};

async function mountOverview(
  inputs: Awaited<ReturnType<typeof boardInputs>>,
  storage: () => Storage | undefined = () => memoryStorage().storage,
) {
  const { ProjectsOverview, projectOverviewColumns } = await import(
    "../client/board/projects-overview"
  );
  const { PopoverHost } = await import("../client/popover");
  const columns = projectOverviewColumns(inputs);
  const selected: string[] = [];
  const openedItems: Array<[string, string, string]> = [];
  const props = {
    c: colors,
    columns,
    narrowWidth: null,
    badge: () => null,
    storage,
    rust: {
      error: null,
      retry: () => {},
      selected: null,
      onSelect: (id: string) => selected.push(id),
      project: (task: RustTask) => ({
        name: task.identity.repository,
        badge: null,
      }),
    },
    items: {
      selected: null,
      onSelectLead: (id: string, project: string) =>
        openedItems.push(["lead", id, project]),
      onSelectPapercut: (id: string, project: string) =>
        openedItems.push(["papercut", id, project]),
    },
  };
  const render = (extra: Record<string, unknown> = {}) =>
    h(PopoverHost, { children: h(ProjectsOverview, { ...props, ...extra }) });
  const ui = mount(render());
  mounted.push(() => ui.update(h(React.Fragment)));
  return { ui, columns, selected, openedItems, render };
}

/** The titles in one column's card list, in order. */
const cardTitles = (
  ui: Awaited<ReturnType<typeof mountOverview>>["ui"],
  label: string,
  titles: readonly string[],
) => {
  const text = textOf(ui.get(label));
  return titles
    .filter((title) => text.includes(title))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
};

test("columns follow the project select's order and leave archived projects out", async () => {
  const inputs = await boardInputs();
  const { ui, columns } = await mountOverview(inputs);
  const selectorOrder = projectSelectorRows(
    inputs.projects,
    [],
    "",
    inputs.selector.tasks,
    inputs.selector.leads,
    inputs.selector.queuedCounts,
    inputs.selector.projectActivity,
  ).map(({ name }) => name);
  assert.deepEqual(
    columns.map(({ project }) => project.name),
    selectorOrder,
  );
  assert.deepEqual(
    ui.all(/ column$/).map((node) => node.props.accessibilityLabel),
    selectorOrder.map((name) => `${name} column`),
  );
  // Orchard has the most open work, so the select lists it first, not in settings order.
  assert.equal(selectorOrder[0], "Orchard");
  assert.deepEqual([...selectorOrder].sort(), [
    "Acowtancy",
    "Nucleus",
    "Orchard",
  ]);
  assert.equal(
    ui.query("Retired column"),
    undefined,
    "an archived project has no column",
  );
});

test("the header has no help tip and shows Active, Leads, Papercuts and Queue as tabs", async () => {
  const inputs = await boardInputs();
  const { ui } = await mountOverview(inputs);
  // Active counts the five active stages; open leads and papercuts only (the dropped lead is not counted); all three queued tasks.
  assert.match(
    textOf(ui.get("Orchard overview")),
    /Orchard 5 Active 2 Leads 1 Papercuts 3 Queue/,
  );
  assert.match(
    textOf(ui.get("Nucleus overview")),
    /Nucleus 0 Active 0 Leads 1 Papercuts 1 Queue/,
  );
  assert.equal(ui.query(/counts help$/), undefined, "no (?) tip");
  assert.equal(ui.query(/counts$/), undefined, "no help popover");
  const tabs = ui.get("Orchard tabs");
  assert.equal(tabs.props.accessibilityRole, "tablist");
  for (const label of [
    "5 Active in Orchard",
    "2 Leads in Orchard",
    "1 Papercuts in Orchard",
    "3 Queue in Orchard",
  ]) {
    const tab = ui.get(label);
    assert.equal(tab.props.accessibilityRole, "tab");
    assert.equal(
      tab.props.accessibilityState.selected,
      label.includes("Active"),
      `${label}: Active is selected by default`,
    );
  }
});

test("each tab shows its type's cards in its list's order and marks the selection", async () => {
  const inputs = await boardInputs();
  const { ui, selected } = await mountOverview(inputs);
  const taskTitles = [
    "Needs task",
    "Queued task",
    "Held queued task",
    "Working task",
    "Review task",
    "Merging task",
    "Closing task",
    "History task",
  ];
  // Active: today's cards, in stage order.
  assert.deepEqual(cardTitles(ui, "Orchard active", taskTitles), [
    "Needs task",
    "Working task",
    "Review task",
    "Merging task",
    "Closing task",
  ]);
  // Leads: the Leads list's default order for this project.
  const { pipelineBoard } = await import("../shared/pipeline-board");
  const { leadsCards } = await import("../shared/inbox-board");
  const leadOrder = leadsCards(
    pipelineBoard({
      projects: inputs.projects,
      selection: ["orchard"],
      leads: inputs.leads,
      tasks: [],
    }),
  ).map((card) => (card.value as api.BoardLead).title);
  assert.equal(leadOrder.length, 2);
  ui.press("2 Leads in Orchard");
  assert.equal(
    ui.get("2 Leads in Orchard").props.accessibilityState.selected,
    true,
  );
  assert.equal(
    ui.get("5 Active in Orchard").props.accessibilityState.selected,
    false,
  );
  assert.deepEqual(
    cardTitles(ui, "Orchard leads", [
      "Orchard lead one",
      "Orchard lead two",
      "Orchard papercut",
      "Dropped lead",
    ]),
    leadOrder,
  );
  ui.press("1 Papercuts in Orchard");
  assert.equal(
    textOf(ui.get("Orchard papercuts")).includes("Orchard papercut"),
    true,
  );
  assert.doesNotMatch(textOf(ui.get("Orchard papercuts")), /Orchard lead/);
  // Queue: every queued task, in the Queue list's order.
  const { groupRustTasks } = await import("../client/web/rust-board");
  const queueOrder = groupRustTasks(
    inputs.tasks.filter(({ identity }) =>
      identity.repository.endsWith("orchard-api"),
    ),
  ).queue.map((task) => task.title);
  assert.equal(queueOrder.length, 3);
  ui.press("3 Queue in Orchard");
  assert.deepEqual(cardTitles(ui, "Orchard queue", taskTitles), queueOrder);
  ui.press(/Queued task$/);
  assert.deepEqual(selected, ["orchard-api-queue"]);
  // Another column keeps its own tab.
  assert.equal(
    ui.get("0 Active in Nucleus").props.accessibilityState.selected,
    true,
  );
});

test("a stored tab is restored, and missing or unreadable storage falls back to Active", async () => {
  const inputs = await boardInputs();
  const store = memoryStorage({
    "nucleus.projects-overview.tab.orchard": "papercuts",
    "nucleus.projects-overview.tab.nucleus": "nonsense",
  });
  const { ui } = await mountOverview(inputs, () => store.storage);
  assert.equal(
    ui.get("1 Papercuts in Orchard").props.accessibilityState.selected,
    true,
  );
  assert.ok(ui.query("Orchard papercuts"));
  assert.equal(
    ui.get("0 Active in Nucleus").props.accessibilityState.selected,
    true,
    "an unknown stored value falls back to Active",
  );
  ui.press("3 Queue in Orchard");
  assert.equal(
    store.values.get("nucleus.projects-overview.tab.orchard"),
    "queue",
  );

  for (const storage of [
    () => undefined,
    () => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    }),
    () => {
      throw new Error("no storage");
    },
  ]) {
    for (const unmount of mounted.splice(0)) unmount();
    const { ui: fallback } = await mountOverview(inputs, storage as never);
    assert.equal(
      fallback.get("5 Active in Orchard").props.accessibilityState.selected,
      true,
    );
    fallback.press("2 Leads in Orchard");
    assert.equal(
      fallback.get("2 Leads in Orchard").props.accessibilityState.selected,
      true,
      "the tab still switches without storage",
    );
  }
});

test("each card type opens its detail and the column keeps its tab", async () => {
  const inputs = await boardInputs();
  const { ui, selected, openedItems, render } = await mountOverview(inputs);
  ui.press(/Working task$/);
  assert.deepEqual(selected, ["orchard-api-working"]);
  ui.press("2 Leads in Orchard");
  ui.press(/^Lead: Orchard lead one/);
  assert.deepEqual(openedItems.at(-1), ["lead", "o-lead-1", "orchard"]);
  // The board marks the open lead, then the detail closes.
  ui.update(
    render({
      items: {
        selected: { id: "o-lead-1", project: "orchard" },
        onSelectLead() {},
        onSelectPapercut() {},
      },
    }),
  );
  ui.update(render());
  assert.equal(
    ui.get("2 Leads in Orchard").props.accessibilityState.selected,
    true,
    "closing the detail keeps the Leads tab",
  );
  ui.press("1 Papercuts in Nucleus");
  ui.press(/^Papercut: Nucleus papercut/);
  assert.deepEqual(openedItems.at(-1), ["papercut", "n-cut-1", "nucleus"]);
  ui.update(render());
  assert.equal(
    ui.get("1 Papercuts in Nucleus").props.accessibilityState.selected,
    true,
  );
  assert.equal(
    ui.get("2 Leads in Orchard").props.accessibilityState.selected,
    true,
  );
});

test("each empty tab says so quietly", async () => {
  const inputs = await boardInputs();
  const { ui } = await mountOverview(inputs);
  for (const name of ["Nucleus", "Acowtancy"])
    assert.ok(ui.query(`${name} overview`), `${name} keeps its header card`);
  assert.equal(textOf(ui.get("Acowtancy active")), "No active tasks");
  ui.press("0 Leads in Acowtancy");
  assert.equal(textOf(ui.get("Acowtancy leads")), "No open leads");
  ui.press("0 Papercuts in Acowtancy");
  assert.equal(textOf(ui.get("Acowtancy papercuts")), "No open papercuts");
  ui.press("0 Queue in Acowtancy");
  assert.equal(textOf(ui.get("Acowtancy queue")), "Nothing queued");
});

test("the Projects entry opens the overview, a tab stays on the board, and a lead opens and closes its detail", async () => {
  const fixture = planningFixture();
  const { MainSurface } = await import("../client/queue");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rows: unknown = JSON.parse(
    readFileSync(
      new URL("./fixtures/rust-task-order-rows.json", import.meta.url),
      "utf8",
    ),
  );
  const base = (
    await createRustBoardTransport(async () => Response.json(rows)).list(
      new AbortController().signal,
    )
  )[0]!;
  const boardTransport = createRustBoardTransport(async () =>
    Response.json(
      fixture.tasks.map((task) => ({
        ...base,
        identity: {
          ...base.identity,
          id: task.id,
          reference: task.reference,
          repository: "fixture/roadmap",
        },
        title: task.title,
        number: task.number,
        reference: task.reference,
        lanes: task.lanes,
        phase: task.phase,
        attention: task.phase === "blocked" ? "attention" : "active",
        stateLabel: task.phase[0]!.toUpperCase() + task.phase.slice(1),
      })),
    ),
  );
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke: fixture.invoke,
        children: h(MainSurface, {
          theme: { colors },
          layout: { compact: false },
          rustBoard: () => {},
          boardTransport,
        }),
      }),
    }),
  );
  mounted.push(() => {
    ui.update(h("View"));
    client.clear();
  });
  const waitFor = async (label: string | RegExp) => {
    for (let i = 0; i < 400 && !ui.query(label); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return ui.get(label);
  };
  await waitFor("Projects");
  ui.press("Projects");
  await waitFor("roadmap overview");
  assert.deepEqual(
    ui.all(/ column$/).map((node) => node.props.accessibilityLabel),
    ["roadmap column", "dormant column", "idle column"],
    "the active project first, then the rest by name, as the select lists them",
  );
  const leads = await waitFor(/^2 Leads in roadmap$/);
  ui.press(leads.props.accessibilityLabel);
  assert.equal(
    ui.get("2 Leads in roadmap").props.accessibilityState.selected,
    true,
  );
  assert.equal(
    ui.get("Projects").props.accessibilityState.selected,
    true,
    "the tab never leaves the Projects board",
  );
  assert.match(
    textOf(ui.get("roadmap leads")),
    /Name the host on the lane page.*Show the stuck cause on every card|Show the stuck cause on every card.*Name the host on the lane page/,
  );
  ui.press(/^Lead: Name the host on the lane page/);
  for (let i = 0; i < 400 && ui.all("Close lead").length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  // The close button and the backdrop share the label; either closes the detail.
  ui.all("Close lead")[0]!.props.onPress();
  for (let i = 0; i < 400 && ui.all("Close lead").length > 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(ui.all("Close lead").length, 0, "the detail closed");
  assert.equal(
    ui.get("2 Leads in roadmap").props.accessibilityState.selected,
    true,
    "closing the detail keeps the Leads tab",
  );
  assert.ok(ui.query("roadmap overview"), "the board is still open");
});
