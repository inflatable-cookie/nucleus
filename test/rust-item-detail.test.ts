/**
 * The lead and papercut view (Spec 071, "Leads and papercuts") mounted on the board's
 * real Rust planning adapter, once per state in the approved mockup. The engine
 * stand-in serves the stored item, list and history shapes and keeps the store's
 * transition rules, so each action is checked by what the engine received and
 * what the view shows after reading the item back.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mount, useNativeStubs } from "./support/render";
import { waitFor } from "./support/budgets";
import { planningEngine, type StoredItem } from "./support/rust-planning-engine";
import type { RustTask } from "../client/web/rust-board";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();

const colors = {
  accent: "#346cf1", accentForeground: "#ffffff", surface0: "#000000", surface1: "#111111", surface2: "#1c1c1c",
  border: "#333333", foreground: "#f5f5f5", foregroundMuted: "#818181", foregroundLabel: "#8f8f8f",
  statusSuccess: "#19bc7d", statusWarning: "#e8a33d", statusDanger: "#ef5b5b",
} as never;

let modules:
  | Promise<[typeof import("../client/records/rust-item"), typeof import("../client/web/rust-adapter"), typeof import("../client/web/rust-api"), typeof import("../client/web/shell")]>
  | undefined;
const load = () => {
  if (!modules) {
    useNativeStubs();
    modules = (async () => {
      const loaded = await Promise.all([
        import("../client/records/rust-item"),
        import("../client/web/rust-adapter"),
        import("../client/web/rust-api"),
        import("../client/web/shell"),
      ]);
      const { bindBoardShell } = await import("../client/shell");
      bindBoardShell({ ...loaded[3], Icon: () => null });
      return loaded;
    })();
  }
  return modules;
};

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const lead = (over: Partial<StoredItem> & Pick<StoredItem, "id" | "title">): StoredItem =>
  ({
    kind: "lead",
    author: "planner",
    // A lead's body is its task brief: the service admits it with the complexity it declares.
    body: "---\nqueue:\n  complexity: high\n---\n\nMarkers lose work when the network drops.\n\n- Queue in the browser\n- Replay in order",
    lanes: ["marking-hub"],
    state: "open",
    ...over,
  }) as StoredItem;
const papercut = (over: Partial<StoredItem> & Pick<StoredItem, "id" | "title">): StoredItem =>
  ({ kind: "papercut", author: "planner", body: "The Activity tab fails to parse.", lanes: [], state: "open", ...over }) as StoredItem;

const reviewingTask = {
  identity: { id: "t-promoted", reference: "acowtancy-v2#1203", repository: "example/acowtancy-v2", base: "main" },
  reference: "acowtancy-v2#1203",
  title: "Learner-effort mapping for practice sets",
  phase: "reviewing",
  stateLabel: "Reviewing",
  attention: "active",
  wait: null,
  question: null,
  hold: null,
  stateSinceMs: now - HOUR,
  createdAtMs: now - 3 * HOUR,
  lifecycle: {
    steps: [
      { key: "queued", label: "Queued", state: "done", tone: "success", visits: [{ enteredAtMs: now - 3 * HOUR, leftAtMs: now - 3 * HOUR + 180_000 }] },
      { key: "working", label: "Working", state: "done", tone: "success", visits: [{ enteredAtMs: now - 3 * HOUR + 180_000, leftAtMs: now - HOUR }] },
      { key: "review", label: "Review", state: "current", tone: "accent", visits: [{ enteredAtMs: now - HOUR, leftAtMs: null }] },
      { key: "merge", label: "Merge", state: "todo", tone: "muted", visits: [] },
      { key: "close", label: "Close", state: "todo", tone: "muted", visits: [] },
    ],
  },
} as unknown as RustTask;

async function open(
  engine: ReturnType<typeof planningEngine>,
  id: string,
  project: string,
  kind: "lead" | "papercut",
  options: { task?: RustTask } = {},
) {
  const [{ RustItemDialog }, { createRustAdapter }, { createRustApi }, web] = await load();
  const adapter = createRustAdapter(createRustApi(engine.fetcher));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const openedTasks: string[] = [];
  const h = React.createElement;
  const ui = mount(
    h(QueryClientProvider, {
      client,
      children: h(web.WebContext.Provider, {
        value: { transport: adapter, settings: false },
        children: h(RustItemDialog, {
          id,
          project,
          kind,
          inline: true,
          c: colors,
          onClose: () => {},
          laneName: (key: string) => ({ "marking-hub": "Marking Hub for December" })[key] ?? key,
          badge: () => null,
          task: (taskId: string) => (options.task && taskId === options.task.identity.id ? options.task : undefined),
          onOpenTask: (taskId: string) => openedTasks.push(taskId),
        }),
      }),
    }),
  );
  mounted.push(() => {
    ui.update(h(React.Fragment));
    client.clear();
  });
  await waitFor(() => Boolean(ui.query(/^State: /)), 5000, `${id} loads`);
  return { ui, openedTasks };
}

const state = (ui: ReturnType<typeof mount>) => String(ui.query(/^State: /)?.props.accessibilityLabel);
const panels = (ui: ReturnType<typeof mount>) =>
  ["Promote", "Parked", "Completed", "Deprecated"].filter((name) => ui.query(name));
const footer = (ui: ReturnType<typeof mount>) =>
  ui.all(/^(Park|Open drop for) (lead|papercut)$/).map((node) => node.props.accessibilityLabel as string);

test("lead · open: the Complexity picker starts at the brief's level; a new level is written into the brief, then promoted to the chosen repository", async () => {
  const engine = planningEngine();
  engine.seed("acowtancy", lead({ id: "i-offline", title: "Offline marking queue", repositories: ["example/acowtancy-v2", "example/dairy"] }), {
    actor: "planner",
    atMs: now - 2 * DAY,
  });
  const { ui } = await open(engine, "i-offline", "acowtancy", "lead");
  assert.equal(state(ui), "State: Open");
  assert.deepEqual(panels(ui), ["Promote"]);
  assert.deepEqual(footer(ui), ["Park lead", "Open drop for lead"]);
  assert.match(ui.text(), /Acowtancy/);
  assert.match(ui.text(), /Marking Hub for December/);
  assert.match(ui.text(), /example\/acowtancy-v2, example\/dairy/);
  assert.match(ui.get(/^Complexity, /).props.accessibilityLabel, /^Complexity, High$/, "the brief declares high");
  // An unbound repository can be chosen but not promoted to.
  ui.press(/^Repository, /);
  ui.press("Repository: example/dairy, Not bound to T3");
  await waitFor(() => ui.get("Promote lead").props.disabled === true, 2000, "unbound refuses");
  assert.match(ui.text(), /Bind example\/dairy to a T3 project before promoting/);
  ui.press(/^Repository, /);
  ui.press("Repository: example/acowtancy-v2");
  ui.press(/^Complexity, /);
  ui.press("Complexity: Low");
  await waitFor(() => ui.get("Promote lead").props.disabled === false, 2000, "bound enables");
  const version = engine.item("acowtancy", "i-offline").version;
  ui.press("Promote lead");
  await waitFor(() => state(ui) === "State: Promoted", 4000, "promoted");
  const [edit, promote] = engine.writes.slice(-2);
  assert.equal(edit?.method, "PUT");
  assert.equal(edit?.path, "/planning/acowtancy/items/i-offline");
  assert.equal((edit?.body as { version: number; complexity: string }).version, version);
  assert.equal((edit?.body as { complexity: string }).complexity, "low");
  assert.deepEqual(promote, {
    method: "POST",
    path: "/planning/acowtancy/items/i-offline/promote",
    body: { repository: "example/acowtancy-v2" },
  });
  // The brief keeps everything but its level.
  const body = engine.item("acowtancy", "i-offline").body;
  assert.match(body, /complexity: low/);
  assert.match(body, /Replay in order$/);
  assert.match(ui.text(), /Promoted as acowtancy-v2#1201/);
  assert.deepEqual(footer(ui), [], "a promoted item has no footer");
});

test("lead · open with flow-style front matter: the declared level is read and promoted unchanged", async () => {
  const engine = planningEngine();
  engine.seed("acowtancy", lead({ id: "i-flow", title: "Flow lead", body: "---\nqueue: {complexity: medium}\n---\nShip it." }), { actor: "planner", atMs: now - DAY });
  const { ui } = await open(engine, "i-flow", "acowtancy", "lead");
  assert.match(ui.get(/^Complexity, /).props.accessibilityLabel, /^Complexity, Medium$/);
  assert.equal(ui.get("Promote lead").props.disabled, false);
  ui.press("Promote lead");
  await waitFor(() => state(ui) === "State: Promoted", 4000, "promoted");
  assert.deepEqual(
    engine.writes.map(({ method, path }) => `${method} ${path}`),
    ["POST /planning/acowtancy/items/i-flow/promote"],
    "an unchanged level needs no edit",
  );
});

test("lead · open with no complexity in its brief: the chosen level is added to the brief before promotion", async () => {
  const engine = planningEngine();
  engine.seed("acowtancy", lead({ id: "i-bare", title: "Bare lead", body: "No front matter yet." }), { actor: "planner", atMs: now - DAY });
  const { ui } = await open(engine, "i-bare", "acowtancy", "lead");
  assert.match(ui.get(/^Complexity, /).props.accessibilityLabel, /^Complexity, Medium$/);
  ui.press("Promote lead");
  await waitFor(() => state(ui) === "State: Promoted", 4000, "promoted");
  assert.equal(engine.item("acowtancy", "i-bare").body, "---\nqueue:\n  complexity: medium\n---\nNo front matter yet.");
});

test("papercut naming one repository of a project with several bound ones promotes to it", async () => {
  const engine = planningEngine();
  engine.seed("orchard", papercut({ id: "i-web", title: "Web only", repositories: ["example/orchard-web"] }), { actor: "planner", atMs: now - HOUR });
  const { ui } = await open(engine, "i-web", "orchard", "papercut");
  assert.equal(ui.query(/^Repository, /), undefined, "one listed repository needs no choice");
  ui.press("Promote papercut");
  await waitFor(() => state(ui) === "State: Promoted", 4000, "promoted");
  assert.deepEqual(engine.writes.at(-1)?.body, { repository: "example/orchard-web", complexity: "medium" });
});

test("lead · parked: reason, who parked it and the revisit date ahead; Reopen returns it to Open", async () => {
  const engine = planningEngine();
  const revisitAt = new Date(now + 7 * DAY).toISOString();
  const item = lead({ id: "i-fonts", title: "Self-hosted fonts", lanes: [] });
  engine.seed("acowtancy", { ...item, state: "parked", reason: "Waiting on Ben's type choices.", revisitAt }, { actor: "planner", atMs: now - 6 * DAY }, [
    { actor: "Tom", atMs: now - 4 * DAY, action: "park", item: { ...item, state: "parked", reason: "Waiting on Ben's type choices.", revisitAt } },
  ]);
  const { ui } = await open(engine, "i-fonts", "acowtancy", "lead");
  assert.equal(state(ui), "State: Parked");
  assert.deepEqual(panels(ui), ["Parked"]);
  assert.match(ui.text(), /Waiting on Ben's type choices\./);
  assert.match(ui.text(), /Tom/);
  assert.match(ui.text(), /In 7 days/);
  assert.deepEqual(footer(ui), ["Open drop for lead"], "a parked item drops but does not park");
  const version = engine.item("acowtancy", "i-fonts").version;
  ui.press("Reopen lead");
  await waitFor(() => state(ui) === "State: Open", 4000, "reopened");
  assert.deepEqual(engine.writes.at(-1), { method: "POST", path: "/planning/acowtancy/items/i-fonts/reopen", body: { version } });
  assert.deepEqual(panels(ui), ["Promote"]);
});

test("lead · promoted: the linked task card opens the task; the body collapses", async () => {
  const engine = planningEngine();
  const item = lead({ id: "i-effort", title: "Learner-effort mapping", repositories: ["example/acowtancy-v2"] });
  engine.seed("acowtancy", { ...item, state: "promoted", taskId: "t-promoted", taskLinks: ["t-promoted"] }, { actor: "planner", atMs: now - 3 * DAY }, [
    { actor: "Tom", atMs: now - 3 * HOUR, action: "promote", item: { ...item, state: "promoted", taskId: "t-promoted", taskLinks: ["t-promoted"] } },
  ]);
  const { ui, openedTasks } = await open(engine, "i-effort", "acowtancy", "lead", { task: reviewingTask });
  assert.equal(state(ui), "State: Promoted");
  assert.deepEqual(panels(ui), []);
  assert.match(ui.text(), /acowtancy-v2#1203/);
  assert.match(ui.text(), /Reviewing/);
  assert.ok(ui.query("Lead, collapsed"), "the body is collapsed");
  assert.deepEqual(footer(ui), []);
  ui.press("Open task acowtancy-v2#1203");
  assert.deepEqual(openedTasks, ["t-promoted"]);
  ui.press("Activity, collapsed");
  await waitFor(() => /Promoted\s*Tom/.test(ui.text()), 2000, "activity opens");
  assert.match(ui.text(), /Filed\s*planner/);
});

test("papercut · open: one repository, park from the footer with a reason and revisit day", async () => {
  const engine = planningEngine();
  engine.seed("nucleus", papercut({ id: "i-routing", title: "Activity tab fails with a routing record" }), { actor: "planner", atMs: now - 5 * HOUR });
  const { ui } = await open(engine, "i-routing", "nucleus", "papercut");
  assert.equal(state(ui), "State: Open");
  assert.deepEqual(panels(ui), ["Promote"]);
  assert.equal(ui.query(/^Repository, /), undefined, "one repository needs no choice");
  assert.match(ui.text(), /What happened/);
  ui.press("Park papercut");
  await waitFor(() => Boolean(ui.query("Park reason")), 2000, "park form");
  ui.type("Park reason", "After the resolution commands land.");
  ui.type("Revisit on", "2099-01-15");
  ui.press("Park");
  await waitFor(() => state(ui) === "State: Parked", 4000, "parked");
  const park = engine.writes.at(-1)!;
  assert.equal(park.path, "/planning/nucleus/items/i-routing/park");
  assert.equal((park.body as { reason: string }).reason, "After the resolution commands land.");
  assert.equal(new Date((park.body as { revisitAt: string }).revisitAt).getFullYear(), 2099);
  assert.match(ui.text(), /After the resolution commands land\./);
});

test("papercut · open: promotes to the project's only repository with the default complexity", async () => {
  const engine = planningEngine();
  engine.seed("nucleus", papercut({ id: "i-one", title: "One repository" }), { actor: "planner", atMs: now - HOUR });
  const { ui } = await open(engine, "i-one", "nucleus", "papercut");
  ui.press("Promote papercut");
  await waitFor(() => state(ui) === "State: Promoted", 4000, "promoted");
  assert.deepEqual(engine.writes.at(-1)?.body, { repository: "example/nucleus", complexity: "medium" });
});

test("papercut · parked and due: warning state; changing the revisit day parks again; drop takes a disposition", async () => {
  const engine = planningEngine();
  const revisitAt = new Date(now - DAY).toISOString();
  const item = papercut({ id: "i-twice", title: "next prints the wait twice" });
  const parked = { ...item, state: "parked" as const, reason: "Revisit after the commands land.", revisitAt };
  engine.seed("nucleus", parked, { actor: "planner", atMs: now - 8 * DAY }, [{ actor: "planner", atMs: now - 6 * DAY, action: "park", item: parked }]);
  const { ui } = await open(engine, "i-twice", "nucleus", "papercut");
  assert.equal(state(ui), "State: Parked · revisit due");
  assert.match(ui.text(), /Due yesterday/);
  ui.type("Revisit", "2099-03-01");
  await waitFor(() => Boolean(ui.query("Save revisit date")), 2000, "save offered");
  ui.press("Save revisit date");
  await waitFor(() => state(ui) === "State: Parked", 4000, "parked again");
  const repark = engine.writes.at(-1)!;
  assert.equal(repark.path, "/planning/nucleus/items/i-twice/park");
  assert.equal((repark.body as { reason: string }).reason, "Revisit after the commands land.");

  ui.press("Open drop for papercut");
  await waitFor(() => Boolean(ui.query(/^Disposition, /)), 2000, "drop form");
  assert.match(ui.get(/^Disposition, /).props.accessibilityLabel, /Completed/);
  ui.press(/^Disposition, /);
  ui.press("Disposition: Deprecated");
  ui.type("Note", "Superseded by the next view.");
  ui.press("Drop papercut");
  await waitFor(() => state(ui) === "State: Dropped · deprecated", 4000, "dropped");
  assert.deepEqual(engine.writes.at(-1), {
    method: "POST",
    path: "/planning/nucleus/items/i-twice/drop",
    body: { reason: "Superseded by the next view.", disposition: "deprecated" },
  });
  assert.deepEqual(panels(ui), ["Deprecated"]);
  assert.match(ui.text(), /Superseded by the next view\./);
});

test("papercut · dropped as completed: outcome panel with the note and who dropped it; Reopen", async () => {
  const engine = planningEngine();
  const item = papercut({ id: "i-count", title: "Header count includes archived tasks" });
  const dropped = { ...item, state: "dropped" as const, disposition: "completed" as const, reason: "Fixed by nucleus#1571." };
  engine.seed("nucleus", dropped, { actor: "planner", atMs: now - 5 * DAY }, [{ actor: "Tom", atMs: now - DAY, action: "drop", item: dropped }]);
  const { ui } = await open(engine, "i-count", "nucleus", "papercut");
  assert.equal(state(ui), "State: Dropped · completed");
  assert.deepEqual(panels(ui), ["Completed"]);
  assert.match(ui.text(), /Fixed by nucleus#1571\./);
  assert.match(ui.text(), /Tom/);
  assert.ok(ui.query("What happened, collapsed"));
  assert.deepEqual(footer(ui), []);
  ui.press("Activity, collapsed");
  await waitFor(() => /Dropped as completed\s*Tom/.test(ui.text()), 2000, "activity names the disposition");
  ui.press("Reopen papercut");
  await waitFor(() => state(ui) === "State: Open", 4000, "reopened");
  assert.equal(engine.writes.at(-1)?.path, "/planning/nucleus/items/i-count/reopen");
});

test("lead drop records deprecated with the note; leads offer no disposition", async () => {
  const engine = planningEngine();
  engine.seed("acowtancy", lead({ id: "i-drop", title: "Drop me" }), { actor: "planner", atMs: now - DAY });
  const { ui } = await open(engine, "i-drop", "acowtancy", "lead");
  ui.press("Open drop for lead");
  await waitFor(() => Boolean(ui.query("Note")), 2000, "drop form");
  assert.equal(ui.query(/^Disposition, /), undefined);
  ui.type("Note", "Not worth it.");
  ui.press("Drop lead");
  await waitFor(() => state(ui) === "State: Dropped · deprecated", 4000, "dropped");
  assert.deepEqual(engine.writes.at(-1)?.body, { reason: "Not worth it.", disposition: "deprecated" });
});

test("edit saves at the opened version; after a refusal the saved version is shown before anything is replaced", async () => {
  const engine = planningEngine();
  engine.seed("acowtancy", lead({ id: "i-edit", title: "Before" }), { actor: "planner", atMs: now - DAY });
  const { ui } = await open(engine, "i-edit", "acowtancy", "lead");
  const opened = engine.item("acowtancy", "i-edit").version;
  ui.press("Edit lead");
  await waitFor(() => Boolean(ui.query("Title")), 2000, "editor");
  ui.type("Title", "After");
  // Another writer changes the body while this editor changes only the title.
  engine.editElsewhere("acowtancy", "i-edit", { body: "The planner's newer body." });
  ui.press("Save changes");
  await waitFor(() => Boolean(ui.query("Saved version")), 4000, "saved version shown");
  assert.match(ui.text(), /changed since you opened the editor/);
  assert.equal((engine.writes.at(-1)!.body as { version: number }).version, opened);
  assert.match(ui.text(), /The planner's newer body\./, "the other writer's body is visible");
  assert.equal(ui.query("Save changes"), undefined, "no ordinary save over unseen content");
  assert.equal(engine.item("acowtancy", "i-edit").body, "The planner's newer body.", "the refused save changed nothing");
  // Use saved: the editor takes the stored text; saving then keeps the other writer's body.
  ui.press("Use the saved version");
  await waitFor(() => Boolean(ui.query("Save changes")), 2000, "editor rebased");
  assert.equal(ui.get("Body").props.value, "The planner's newer body.");
  ui.type("Title", "After");
  ui.press("Save changes");
  await waitFor(() => !ui.query("Title"), 4000, "saved");
  assert.deepEqual(
    { title: engine.item("acowtancy", "i-edit").title, body: engine.item("acowtancy", "i-edit").body },
    { title: "After", body: "The planner's newer body." },
  );
});

test("after a refusal, Replace writes the operator's draft over the version shown", async () => {
  const engine = planningEngine();
  engine.seed("nucleus", papercut({ id: "i-replace", title: "Original" }), { actor: "planner", atMs: now - DAY });
  const { ui } = await open(engine, "i-replace", "nucleus", "papercut");
  ui.press("Edit papercut");
  await waitFor(() => Boolean(ui.query("Body")), 2000, "editor");
  ui.type("Body", "My rewrite.");
  engine.editElsewhere("nucleus", "i-replace", { title: "Renamed elsewhere" });
  ui.press("Save changes");
  await waitFor(() => Boolean(ui.query("Saved version")), 4000, "saved version shown");
  const shown = engine.item("nucleus", "i-replace").version;
  ui.press("Replace the saved version");
  await waitFor(() => !ui.query("Body"), 4000, "replaced");
  assert.equal((engine.writes.at(-1)!.body as { version: number }).version, shown);
  assert.equal(engine.item("nucleus", "i-replace").body, "My rewrite.");
});
