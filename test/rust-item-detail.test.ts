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
  ["Send to planner", "Parked", "Completed", "Deprecated"].filter((name) => ui.query(name));
const footer = (ui: ReturnType<typeof mount>) =>
  ui.all(/^(Park|Open drop for) (lead|papercut)$/).map((node) => node.props.accessibilityLabel as string);

test("lead · open: Send to planner has one button with no repository or complexity selects, then shows With planner since and Send again", async () => {
  const engine = planningEngine();
  const recipient = "01adc496-18f0-4b9e-a22c-d1acb7facdab";
  engine.setRecipient("acowtancy", recipient);
  engine.setThreadTitle(recipient, "Acowtancy planner");
  engine.seed("acowtancy", lead({ id: "i-offline", title: "Offline marking queue", repositories: ["example/acowtancy-v2", "example/dairy"] }), {
    actor: "planner",
    atMs: now - 2 * DAY,
  });
  const { ui } = await open(engine, "i-offline", "acowtancy", "lead");
  assert.equal(state(ui), "State: Open");
  assert.deepEqual(panels(ui), ["Send to planner"]);
  assert.deepEqual(footer(ui), ["Park lead", "Open drop for lead"]);
  assert.equal(ui.query(/^Repository, /), undefined, "no repository select");
  assert.equal(ui.query(/^Complexity, /), undefined, "no complexity select");
  assert.ok(ui.query("About sending to planner help"), "help tip explains what the planner does");
  assert.match(ui.text(), /Acowtancy/);
  assert.match(ui.text(), /Marking Hub for December/);
  assert.match(ui.text(), /example\/acowtancy-v2, example\/dairy/);
  const version = engine.item("acowtancy", "i-offline").version;
  ui.press("Send lead to planner");
  await waitFor(() => /With planner since /.test(ui.text()), 4000, "with planner shown");
  assert.deepEqual(engine.writes, [
    {
      method: "POST",
      path: "/planning/acowtancy/items/i-offline/assess",
      body: { version },
    },
  ]);
  assert.equal(state(ui), "State: Open", "item stays open until the planner drops or promotes it");
  assert.match(ui.text(), /Acowtancy planner/);
  assert.doesNotMatch(ui.text(), new RegExp(recipient));
  ui.press("Activity, collapsed");
  assert.ok(ui.query("Activity, expanded"), "Activity is open");
  assert.ok(ui.text().split("Acowtancy planner").length >= 3, "activity repeats the readable recipient label");
  assert.doesNotMatch(ui.text(), new RegExp(recipient));
  ui.all(recipient).forEach((node) => node.props.onHoverIn());
  assert.match(ui.text(), new RegExp(recipient));
  assert.ok(ui.query("Send lead to planner again"), "Send again offered after first send");
  // Sending again sends at the new version and records a second entry.
  const nextVersion = engine.item("acowtancy", "i-offline").version;
  ui.press("Send lead to planner again");
  await waitFor(() => engine.writes.length === 2, 4000, "second send");
  assert.deepEqual(engine.writes.at(-1), {
    method: "POST",
    path: "/planning/acowtancy/items/i-offline/assess",
    body: { version: nextVersion },
  });
});

test("papercut · open: the panel shows why no planner can start, until the message reaches one", async () => {
  const cause = "Can't start a planner: no T3 project matches example/orchard-web";
  const item = papercut({ id: "i-cold", title: "No planner yet" });
  // An outcome names the history entry of its send: the second one here, after filing.
  const blocked = [
    { actor: "Operator", atMs: now - 3 * HOUR, action: "assess", item, recipient: "new planner thread" },
    { actor: "Nucleus", atMs: now - 2 * HOUR, action: "assess_blocked", item, cause, send: 2 },
  ];
  const engine = planningEngine();
  engine.seed("orchard", item, { actor: "planner", atMs: now - DAY }, blocked);
  const { ui } = await open(engine, "i-cold", "orchard", "papercut");
  assert.match(ui.text(), /With planner since /);
  assert.ok(ui.text().includes(cause), "the cause is under With planner since");
  assert.ok(ui.query("Send papercut to planner again"));
  ui.press("Activity, collapsed");
  assert.match(ui.text(), /Planner not started/);

  const reached = planningEngine();
  reached.seed("orchard", item, { actor: "planner", atMs: now - DAY }, [
    ...blocked,
    { actor: "Nucleus", atMs: now - HOUR, action: "assess_reached", item, send: 2 },
  ]);
  const later = await open(reached, "i-cold", "orchard", "papercut");
  assert.match(later.ui.text(), /With planner since /);
  assert.ok(!later.ui.text().includes(cause), "a resolved cause leaves the panel");
});

test("papercut · open: an earlier send's progress never replaces the latest send's result", async () => {
  const item = papercut({ id: "i-again", title: "Sent twice" });
  const earlier = "Can't start a planner: T3's model list hasn't arrived yet";
  const latest = "Can't start a planner: no T3 project matches example/orchard-web";
  const sent = (atMs: number) => ({ actor: "Operator", atMs, action: "assess", item, recipient: "new planner thread" });
  const progress = (atMs: number, send: number, cause?: string) => ({
    actor: "Nucleus",
    atMs,
    action: cause ? "assess_blocked" : "assess_reached",
    item,
    send,
    cause,
  });
  // History sequences: filed 1, first send 2, its wait 3, Send again 4, its refusal 5.
  const interleaved = [
    sent(now - 5 * HOUR),
    progress(now - 4 * HOUR, 2, earlier),
    sent(now - 3 * HOUR),
    progress(now - 2 * HOUR, 4, latest),
  ];
  for (const after of [progress(now - HOUR, 2), progress(now - HOUR, 2, "Can't start a planner: T3 rejected the new thread")]) {
    const engine = planningEngine();
    engine.seed("orchard", item, { actor: "planner", atMs: now - DAY }, [...interleaved, after]);
    const { ui } = await open(engine, "i-again", "orchard", "papercut");
    assert.ok(ui.text().includes(latest), "the latest send's cause stays");
    assert.ok(!ui.text().includes(earlier) && !ui.text().includes("rejected the new thread"));
    mounted.pop()!();
  }
});

test("lead · open: a stale view refuses Send to planner and reloads", async () => {
  const engine = planningEngine();
  engine.seed("acowtancy", lead({ id: "i-stale", title: "Stale lead" }), { actor: "planner", atMs: now - DAY });
  const { ui } = await open(engine, "i-stale", "acowtancy", "lead");
  engine.editElsewhere("acowtancy", "i-stale", { title: "Updated lead" });
  ui.press("Send lead to planner");
  await waitFor(() => /changed since you opened it/.test(ui.text()), 4000, "refusal said");
  assert.match(ui.text(), /Updated lead/);
  assert.equal(ui.query("Send lead to planner again"), undefined);
});

test("papercut · open: Send to planner records new planner thread when no planner is live", async () => {
  const engine = planningEngine();
  engine.seed("orchard", papercut({ id: "i-web", title: "Web only", repositories: ["example/orchard-web"] }), { actor: "planner", atMs: now - HOUR });
  const { ui } = await open(engine, "i-web", "orchard", "papercut");
  assert.deepEqual(panels(ui), ["Send to planner"]);
  ui.press("Send papercut to planner");
  await waitFor(() => /With planner since /.test(ui.text()), 4000, "with planner");
  assert.match(ui.text(), /new planner thread/);
});

test("lead · parked: reason, who parked it, revisit date, Send to planner and Reopen", async () => {
  const engine = planningEngine();
  engine.setThreadTitle("Tom", "Tom");
  engine.setRecipient("acowtancy", "planner-acowtancy");
  const revisitAt = new Date(now + 7 * DAY).toISOString();
  const item = lead({ id: "i-fonts", title: "Self-hosted fonts", lanes: [] });
  engine.seed("acowtancy", { ...item, state: "parked", reason: "Waiting on Ben's type choices.", revisitAt }, { actor: "planner", atMs: now - 6 * DAY }, [
    { actor: "Tom", atMs: now - 4 * DAY, action: "park", item: { ...item, state: "parked", reason: "Waiting on Ben's type choices.", revisitAt } },
  ]);
  const { ui } = await open(engine, "i-fonts", "acowtancy", "lead");
  assert.equal(state(ui), "State: Parked");
  assert.deepEqual(panels(ui), ["Send to planner", "Parked"]);
  assert.match(ui.text(), /Waiting on Ben's type choices\./);
  assert.match(ui.text(), /Tom/);
  assert.match(ui.text(), /In 7 days/);
  assert.deepEqual(footer(ui), ["Open drop for lead"], "a parked item drops but does not park");
  ui.press("Send lead to planner");
  await waitFor(() => /With planner since /.test(ui.text()), 4000, "parked item sent to planner");
  assert.equal(state(ui), "State: Parked");
  const version = engine.item("acowtancy", "i-fonts").version;
  ui.press("Reopen lead");
  await waitFor(() => state(ui) === "State: Open", 4000, "reopened");
  assert.deepEqual(engine.writes.at(-1), { method: "POST", path: "/planning/acowtancy/items/i-fonts/reopen", body: { version } });
  assert.deepEqual(panels(ui), ["Send to planner"]);
});

test("lead · promoted: the linked task card opens the task; the body collapses", async () => {
  const engine = planningEngine();
  engine.setThreadTitle("Tom", "Tom");
  engine.setProjectSettings("acowtancy", { claimedPlannerThreads: ["planner"] });
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
  assert.match(ui.text(), /Filed\s*Acowtancy planner/);
});

test("papercut · open: park from the footer with a reason and revisit day", async () => {
  const engine = planningEngine();
  engine.seed("nucleus", papercut({ id: "i-routing", title: "Activity tab fails with a routing record" }), { actor: "planner", atMs: now - 5 * HOUR });
  const { ui } = await open(engine, "i-routing", "nucleus", "papercut");
  assert.equal(state(ui), "State: Open");
  assert.deepEqual(panels(ui), ["Send to planner"]);
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
  engine.setThreadTitle("Tom", "Tom");
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

test("item authors and activity actors use engine labels with raw IDs in tooltips", async () => {
  const engine = planningEngine();
  const planner = "mcp:launch:planner-example";
  const unknown = "mcp:launch:unknown-example";
  const titled = "01adc496-18f0-4b9e-a22c-d1acb7facdab";
  engine.setThreadTitle(titled, "Longhorn papercut details view");
  engine.setThreadTitle("parked-thread", "Parked by Longhorn");
  engine.setThreadTitle("dropped-thread", "Dropped by Longhorn");
  engine.setThreadTitle("archived-thread", "Archived collaborator");
  engine.setProjectSettings("acowtancy", { claimedPlannerThreads: [planner] });
  engine.setProjectSettings("legacy", { name: "Longhorn", archived: true, claimedPlannerThreads: ["mcp:launch:old-planner"] });
  engine.seed("acowtancy", papercut({ id: "known-author", title: "Known author", author: planner }), { actor: planner, atMs: now });
  engine.seed("acowtancy", papercut({ id: "unknown-author", title: "Unknown author", author: unknown }), { actor: unknown, atMs: now });
  engine.seed("acowtancy", papercut({ id: "titled-author", title: "Titled author", author: titled }), { actor: titled, atMs: now });
  engine.seed("acowtancy", papercut({ id: "archived-planner", title: "Archived planner", author: "mcp:launch:old-planner", authorProjectId: "legacy" }), { actor: "mcp:launch:old-planner", atMs: now });
  engine.seed("acowtancy", papercut({ id: "operator-author", title: "Operator author", author: "operator" }), { actor: "operator", atMs: now });
  const parkedItem = papercut({ id: "parked-item", title: "Parked item", state: "parked", reason: "Later", revisitAt: null });
  engine.seed("acowtancy", parkedItem, { actor: planner, atMs: now - 1 }, [
    { actor: "parked-thread", atMs: now, action: "park", item: parkedItem },
  ]);
  const droppedItem = papercut({ id: "dropped-item", title: "Dropped item", state: "dropped", disposition: "completed", reason: "Done" });
  engine.seed("acowtancy", droppedItem, { actor: planner, atMs: now - 1 }, [
    { actor: "dropped-thread", atMs: now, action: "drop", item: droppedItem },
  ]);
  engine.seed("acowtancy", papercut({ id: "archived-title", title: "Archived title", author: "archived-thread" }), { actor: "archived-thread", atMs: now });
  const configured = engine;
  const known = await open(configured, "known-author", "acowtancy", "papercut");
  assert.match(known.ui.text(), /Acowtancy planner/);
  assert.doesNotMatch(known.ui.text(), /mcp:launch:planner-example/);
  known.ui.get(planner).props.onHoverIn();
  assert.match(known.ui.text(), /mcp:launch:planner-example/);
  const fallback = await open(configured, "unknown-author", "acowtancy", "papercut");
  assert.match(fallback.ui.text(), /Agent thread/);
  assert.doesNotMatch(fallback.ui.text(), /mcp:launch:unknown-example/);
  fallback.ui.get(unknown).props.onHoverIn();
  assert.match(fallback.ui.text(), /mcp:launch:unknown-example/);
  const oldPlanner = await open(configured, "archived-planner", "acowtancy", "papercut");
  assert.match(oldPlanner.ui.text(), /Longhorn planner/);
  const titledItem = await open(configured, "titled-author", "acowtancy", "papercut");
  assert.match(titledItem.ui.text(), /Longhorn papercut details view/);
  titledItem.ui.press(/Activity/);
  assert.match(titledItem.ui.text(), /Longhorn papercut details view/);
  titledItem.ui.all(titled).forEach((node) => node.props.onHoverIn());
  assert.match(titledItem.ui.text(), new RegExp(titled));
  const parked = await open(configured, "parked-item", "acowtancy", "papercut");
  assert.match(parked.ui.text(), /Parked by Longhorn/);
  parked.ui.get("parked-thread").props.onHoverIn();
  assert.match(parked.ui.text(), /parked-thread/);
  const dropped = await open(configured, "dropped-item", "acowtancy", "papercut");
  assert.match(dropped.ui.text(), /Dropped by Longhorn/);
  dropped.ui.get("dropped-thread").props.onHoverIn();
  assert.match(dropped.ui.text(), /dropped-thread/);
  const archivedTitle = await open(configured, "archived-title", "acowtancy", "papercut");
  assert.match(archivedTitle.ui.text(), /Archived collaborator/);
  const operator = await open(configured, "operator-author", "acowtancy", "papercut");
  assert.match(operator.ui.text(), /Operator/);
});
