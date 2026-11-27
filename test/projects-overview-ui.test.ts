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

async function mountOverview(inputs: Awaited<ReturnType<typeof boardInputs>>) {
  const { ProjectsOverview, projectOverviewColumns } = await import(
    "../client/board/projects-overview"
  );
  const { PopoverHost } = await import("../client/popover");
  const columns = projectOverviewColumns(inputs);
  const opened: Array<[string, string]> = [];
  const selected: string[] = [];
  const ui = mount(
    h(PopoverHost, {
      children: h(ProjectsOverview, {
        c: colors,
        columns,
        narrowWidth: null,
        badge: () => null,
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
        onOpenList: (project: string, view: string) =>
          opened.push([project, view]),
      }),
    }),
  );
  mounted.push(() => ui.update(h(React.Fragment)));
  return { ui, columns, opened, selected };
}

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

test("header counts link to the project's Leads, Papercuts and Queue lists", async () => {
  const inputs = await boardInputs();
  const { ui, opened } = await mountOverview(inputs);
  // Open leads and papercuts only: the dropped lead is not counted.
  assert.match(
    textOf(ui.get("Orchard overview")),
    /Orchard 2 Leads 1 Papercuts 3 Queue/,
  );
  assert.match(
    textOf(ui.get("Nucleus overview")),
    /Nucleus 0 Leads 1 Papercuts 1 Queue/,
  );
  for (const [label, view] of [
    ["2 Leads in Orchard", "leads"],
    ["1 Papercuts in Orchard", "papercuts"],
    ["3 Queue in Orchard", "queue"],
    ["1 Papercuts in Nucleus", "papercuts"],
  ] as const) {
    const link = ui.get(label);
    assert.equal(link.props.accessibilityRole, "link");
    ui.press(label);
    const project = inputs.projects.find(({ name }) =>
      label.endsWith(name),
    )!.key;
    assert.deepEqual(
      opened.at(-1),
      [project, view],
      `${label} opens ${view} for its project`,
    );
  }
  assert.ok(
    ui.query("Orchard counts help"),
    "the counts explain themselves in a (?) popover",
  );
});

test("only active tasks appear, in stage order, and a card opens its task", async () => {
  const inputs = await boardInputs();
  const { ui, selected } = await mountOverview(inputs);
  const cards = textOf(ui.get("Orchard active tasks"));
  const order = [
    "Needs task",
    "Working task",
    "Review task",
    "Merging task",
    "Closing task",
  ];
  let last = -1;
  for (const title of order) {
    const at = cards.indexOf(title);
    assert.ok(at > last, `${title} follows the previous stage`);
    last = at;
  }
  for (const title of ["Queued task", "Held queued task", "History task"])
    assert.doesNotMatch(cards, new RegExp(title), `${title} is not active`);
  ui.press(/Working task$/);
  assert.deepEqual(selected, ["orchard-api-working"]);
});

test("a project with nothing active keeps its header card", async () => {
  const inputs = await boardInputs();
  const { ui } = await mountOverview(inputs);
  for (const name of ["Nucleus", "Acowtancy"]) {
    assert.ok(ui.query(`${name} overview`), `${name} keeps its header card`);
    assert.equal(textOf(ui.get(`${name} active tasks`)), "Nothing active");
  }
  assert.match(
    textOf(ui.get("Acowtancy overview")),
    /0 Leads 0 Papercuts 0 Queue/,
  );
});

test("the Projects entry opens the overview and a count lands on its list with the filter set", async () => {
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
  const leads = await waitFor(/^\d+ Leads in roadmap$/);
  ui.press(leads.props.accessibilityLabel);
  const entry = await waitFor(/^Leads(, \d+)?$/);
  assert.equal(
    entry.props.accessibilityState?.selected,
    true,
    "the Leads list is open",
  );
  assert.ok(
    ui.query("Projects, roadmap"),
    "the project filter is set to roadmap",
  );
  // Leave the session filter as other tests found it.
  ui.press("Projects");
});
