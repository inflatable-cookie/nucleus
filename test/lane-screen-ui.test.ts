import { test } from "node:test";
import assert from "node:assert/strict";
import React, { useState } from "react";
import { mount, useNativeStubs } from "./support/render";
import type { BoardLead, LaneDocumentVersion, LaneView, Project, TaskSummary } from "../shared/contracts";
import type { LaneDocumentRead, LaneDraft, LaneListRead } from "../client/lane-screen";

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const settle = () => new Promise(resolve => setImmediate(resolve));

const lane = {
  key: "alpha-lane",
  title: "Alpha lane",
  aim: "Make planning readable",
  status: "active",
  note: "",
  repositories: [{ origin: "owner/alpha", path: "/alpha" }],
  liveByPhase: { working: 1 },
  terminalCount: 0,
  recentOutcomes: [],
  lastActivityAt: null,
} as unknown as LaneView;

const version = (number: number, text: string): LaneDocumentVersion =>
  ({ key: "alpha-lane", version: number, text, digest: `sha256:${"0".repeat(64)}`, author: "operator (board)", createdAt: "2026-11-06T09:00:00Z" }) as LaneDocumentVersion;
const latest = version(3, "# Alpha\n\nThe aim, in brief.\n\n## Scope\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven.\nLine eight.\nThe last line of the full text.");
const earlier = version(2, "# Alpha\n\nAn earlier wording.");

const work = (id: string, title: string, phase: string = "working"): TaskSummary =>
  ({ id, title, phase, held: false, lanes: ["alpha-lane"], reason: "", repoPath: "/alpha", version: 1 }) as unknown as TaskSummary;
const lead = (id: string, title: string, tags: string[] = [], papercutArea: string | null = null): BoardLead =>
  ({ id, title, preview: `${title} body`, lanes: ["alpha-lane"], tags, papercutArea, repositories: [], state: "open" }) as unknown as BoardLead;

type Over = {
  lane?: LaneView; compact?: boolean; canEdit?: boolean; busy?: boolean; doc?: LaneDocumentRead; draft?: LaneDraft | null;
  tasks?: LaneListRead<TaskSummary>; leads?: LaneListRead<BoardLead>;
  onLoadMoreTasks?: (offset: number) => void;
  onLoadPreviousTasks?: () => void; onRetryTasks?: () => void;
  onSaveDocument?: (input: { version: number; text: string }) => Promise<void>;
  readVersion?: (version: number) => Promise<LaneDocumentVersion | null>;
};

async function mountLane(over: Over = {}) {
  const { LaneScreen } = await import("../client/lane-screen");
  const log = { saves: [] as Array<{ version: number; text: string }>, opened: [] as string[], drafts: [] as unknown[], reads: [] as number[], status: [] as string[] };
  const props: Over = { ...over };
  const projects: Project[] = [];
  function Harness() {
    const [draft, setDraft] = useState<LaneDraft | null>(props.draft ?? null);
    return h(LaneScreen, {
      lane: props.lane ?? lane,
      compact: props.compact ?? false,
      projects,
      plans: [],
      selected: [],
      busy: props.busy ?? false,
      canEdit: props.canEdit ?? true,
      doc: props.doc ?? { data: latest },
      draft,
      onDraft: (next: LaneDraft | null) => { log.drafts.push(next); setDraft(next); },
      onSaveDocument: props.onSaveDocument ?? (async (input: { version: number; text: string }) => { log.saves.push(input); }),
      onRetryDocument: () => {},
      readVersion: props.readVersion ?? (async (number: number) => { log.reads.push(number); return number === 2 ? earlier : number === 3 ? latest : null; }),
      tasks: props.tasks ?? { items: [] },
      onLoadMoreTasks: props.onLoadMoreTasks,
      onLoadPreviousTasks: props.onLoadPreviousTasks,
      onRetryTasks: props.onRetryTasks,
      leads: props.leads ?? { items: [] },
      onOpenTask: (id: string) => log.opened.push(`task:${id}`),
      onOpenLead: (item: BoardLead) => log.opened.push(`lead:${item.id}`),
      onRetryLeads: () => {},
      onSelectProject: () => {},
      onSetStatus: (status: string) => log.status.push(status),
      c,
    });
  }
  const ui = mount(h(Harness));
  return {
    ui, log,
    /** Replaces the props the screen is given, as a fresh read would. */
    set(next: Over) { Object.assign(props, next); ui.update(h(Harness)); },
  };
}

test("the document states are distinct: loading, failed, none yet, and a preview", async () => {
  const loading = await mountLane({ doc: {} });
  assert.match(loading.ui.text(), /Loading document…/);
  assert.equal(loading.ui.query("Read full document for Alpha lane"), undefined);

  const failed = await mountLane({ doc: { error: "socket closed" } });
  assert.match(failed.ui.text(), /Couldn’t load the lane document: socket closed/);
  assert.equal(failed.ui.get("Retry the Alpha lane document").props.accessibilityLabel, "Retry the Alpha lane document");
  assert.doesNotMatch(failed.ui.text(), /No lane document yet/);

  const none = await mountLane({ doc: { data: null } });
  assert.match(none.ui.text(), /No lane document yet\./);
  assert.equal(none.ui.get("Write document for Alpha lane").props.accessibilityLabel, "Write document for Alpha lane");

  const preview = await mountLane();
  assert.ok(preview.ui.get("Lane document preview"));
  assert.ok(preview.ui.ofType("Text").some(node => node.props.accessibilityRole === "header" && node.children.join("") === "Alpha"), "the preview sets a Markdown heading as a heading");
  assert.doesNotMatch(preview.ui.text(), /# Alpha/, "the preview does not show raw Markdown markers");
  assert.match(preview.ui.text(), /Preview only\./);
  assert.doesNotMatch(preview.ui.text(), /The last line of the full text/, "the preview stops short of the full text");
  assert.ok(preview.ui.get("Read full document for Alpha lane"));
  assert.ok(preview.ui.get("Edit the Alpha lane document"));
});

test("a stale document says which version it shows and that it may be out of date", async () => {
  const stale = await mountLane({ doc: { data: latest, error: "timeout" } });
  assert.match(stale.ui.text(), /Showing version 3\. The latest could not be refreshed: timeout\. It may be out of date\./);
  assert.ok(stale.ui.get("Retry refreshing the Alpha lane document"));
  assert.ok(stale.ui.get("Lane document preview"), "the last read stays on screen");
});

test("reading the full document shows every line, and older versions are read on demand", async () => {
  const { ui, log } = await mountLane();
  ui.press("Read full document for Alpha lane");
  assert.ok(ui.get("Lane document, full text"));
  assert.match(ui.text(), /The last line of the full text\./);
  assert.ok(ui.ofType("Text").some(node => node.props.accessibilityRole === "header" && node.children.join("") === "Alpha"), "a Markdown heading is set as a heading");

  ui.press("Show the earlier version of Alpha lane");
  await settle();
  assert.deepEqual(log.reads, [2]);
  assert.match(ui.text(), /Version 2 · operator \(board\) · .* · not the latest/);
  assert.match(ui.text(), /An earlier wording\./);

  ui.press("Show the latest version of Alpha lane");
  assert.match(ui.text(), /The last line of the full text\./);

  ui.press("Back to lane Alpha lane");
  assert.ok(ui.get("Lane document preview"));
  assert.equal(ui.query("Lane document, full text"), undefined);
});

test("saving sends the version the text was written against and clears the draft on success", async () => {
  const { ui, log } = await mountLane();
  ui.press("Edit the Alpha lane document");
  assert.ok(ui.get("Lane document editor"));
  assert.match(ui.text(), /Editing Alpha lane from version 3/);
  ui.type("Lane document text", "# Alpha\n\nRevised.");
  assert.equal(ui.get("Save the Alpha lane document").props.disabled, false);
  ui.press("Save the Alpha lane document");
  await settle();
  assert.deepEqual(log.saves, [{ version: 3, text: "# Alpha\n\nRevised." }]);
  assert.equal(ui.query("Lane document editor"), undefined, "the editor closes once the save lands");
  assert.equal(log.drafts.at(-1), null);
});

test("a save with no change is refused, and a refused save keeps the operator's text", async () => {
  const refused = await mountLane({ onSaveDocument: async () => { throw new Error("Lane document alpha-lane changed to version 4; reload before saving"); } });
  refused.ui.press("Edit the Alpha lane document");
  assert.equal(refused.ui.get("Save the Alpha lane document").props.disabled, true, "no change, nothing to save");
  assert.match(refused.ui.text(), /No changes to save\./);

  refused.ui.type("Lane document text", "Mine.");
  refused.ui.press("Save the Alpha lane document");
  await settle();
  assert.match(refused.ui.text(), /Not saved: Lane document alpha-lane changed to version 4; reload before saving\. Your text is kept\./);
  assert.equal(refused.ui.get("Lane document text").props.value, "Mine.");
});

test("a document that changed under a draft blocks saving until the operator picks the new base", async () => {
  const { ui, log, set } = await mountLane({ draft: { base: 3, text: "Mine.", start: latest.text } });
  assert.ok(ui.get("Lane document editor"), "a kept draft opens the editor");
  assert.equal(ui.query("Lane document changed"), undefined);

  set({ doc: { data: version(4, "Newer text from another operator.") } });
  const alert = ui.get("Lane document changed");
  assert.equal(alert.props.accessibilityRole, "alert");
  assert.match(ui.text(), /The document changed to version 4 while you were editing/);
  assert.equal(ui.get("Save the Alpha lane document").props.disabled, true, "saving over newer text is refused");
  assert.equal(ui.get("Lane document text").props.value, "Mine.", "the text is kept");

  ui.press("Use version 4 of Alpha lane as the base for my text");
  assert.equal(ui.get("Save the Alpha lane document").props.disabled, false);
  ui.press("Save the Alpha lane document");
  await settle();
  assert.deepEqual(log.saves, [{ version: 4, text: "Mine." }]);
});

test("discarding a conflicting draft drops the text and keeps the latest version", async () => {
  const { ui, log, set } = await mountLane({ draft: { base: 3, text: "Mine.", start: latest.text } });
  set({ doc: { data: version(4, "Newer.") } });
  ui.press("Discard my text for Alpha lane and keep the latest");
  assert.equal(ui.query("Lane document editor"), undefined);
  assert.equal(log.drafts.at(-1), null);
  assert.doesNotMatch(ui.text(), /Mine\./);
  assert.ok(ui.get("Lane document preview"), "the latest version is what the lane shows");
});

test("the first version is written from version zero, with no latest text to compare", async () => {
  const { ui, log } = await mountLane({ doc: { data: null } });
  ui.press("Write document for Alpha lane");
  assert.match(ui.text(), /Write the first version of Alpha lane/);
  ui.type("Lane document text", "First.");
  ui.press("Save the Alpha lane document");
  await settle();
  assert.deepEqual(log.saves, [{ version: 0, text: "First." }]);
});

test("a draft from before the tab was left opens in the editor, and Edit never replaces it", async () => {
  const { ui, log } = await mountLane({ draft: { base: 3, text: "Kept.", start: latest.text } });
  assert.equal(ui.get("Lane document text").props.value, "Kept.");
  ui.press("Cancel changes to the Alpha lane document");
  assert.equal(log.drafts.at(-1), null);
  ui.press("Edit the Alpha lane document");
  assert.equal(ui.get("Lane document text").props.value, latest.text, "a fresh edit starts from the latest text");
});

test("work counts come from the lane, and a partial list says how many it shows", async () => {
  const held = { ...work("t1", "Build it"), held: true, hold: { owner: "Tom", reason: "Awaiting the source decision" } } as unknown as TaskSummary;
  const { ui, log } = await mountLane({ lane: { ...lane, liveByPhase: { working: 2 } } as LaneView, tasks: { items: [held] } });
  assert.match(ui.text(), /Work · 2/);
  assert.match(ui.text(), /Showing 1–1 of 2 live tasks/);
  assert.match(ui.query(/^Open task Build it/).props.accessibilityLabel, /Held · Awaiting the source decision/);
  assert.match(ui.text(), /Working · Held · Awaiting the source decision/);
  ui.press(/^Open task Build it/);
  assert.deepEqual(log.opened, ["task:t1"]);
});

test("lane work pages through queued tasks beyond the board overflow with the server total", async () => {
  let requested = -1;
  const { ui } = await mountLane({
    lane: { ...lane, liveByPhase: { queued: 30 } } as LaneView,
    tasks: { items: Array.from({ length: 25 }, (_, i) => work(`t${i}`, `Task ${i}`)), total: 30, offset: 0, nextOffset: 25 },
    onLoadMoreTasks: offset => { requested = offset; },
  });
  assert.match(ui.text(), /Showing 1–25 of 30 live tasks/);
  assert.equal(ui.all("Load next page of lane tasks").length, 2, "next is available above and below the list");
  ui.all("Load next page of lane tasks")[0].props.onPress();
  assert.equal(requested, 25);
  let returned = false;
  const pageTwo = await mountLane({
    lane: { ...lane, liveByPhase: { queued: 30 } } as LaneView,
    tasks: { items: Array.from({ length: 5 }, (_, i) => work(`t${i + 25}`, `Task ${i + 25}`)), total: 30, offset: 25, nextOffset: null },
    onLoadPreviousTasks: () => { returned = true; },
  });
  assert.match(pageTwo.ui.text(), /Showing 26–30 of 30 live tasks/);
  assert.equal(pageTwo.ui.all("Load previous page of lane tasks").length, 2, "previous is available above and below the list");
  pageTwo.ui.all("Load previous page of lane tasks")[0].props.onPress();
  assert.equal(returned, true);
});

test("work loading is not an empty list, and a failed work read says it may be out of date", async () => {
  const loading = await mountLane({ tasks: {} });
  assert.match(loading.ui.text(), /Loading work…/);
  assert.doesNotMatch(loading.ui.text(), /No work in this lane/);

  const empty = await mountLane({ lane: { ...lane, liveByPhase: {}, terminalCount: 0 } as LaneView, tasks: { items: [] } });
  assert.match(empty.ui.text(), /No work in this lane\./);
  assert.match(empty.ui.text(), /Finished · 0/);

  let retried = false;
  const failed = await mountLane({ tasks: { error: "timeout" }, onRetryTasks: () => { retried = true; } });
  assert.match(failed.ui.text(), /Couldn’t load work: timeout/);
  failed.ui.press("Retry loading lane tasks");
  assert.equal(retried, true);
});

test("leads and papercuts split the lane's open records, and each opens its record", async () => {
  const records = [lead("l1", "Triage the plan"), lead("p1", "Board overflow", ["papercut"], "board"), lead("l2", "Second lead")];
  const { ui, log } = await mountLane({ leads: { items: records } });
  assert.match(ui.text(), /Leads · 2/);
  assert.match(ui.text(), /Papercuts · 1/);

  ui.press("Show leads for Alpha lane");
  assert.ok(ui.get("Open lead Triage the plan"));
  assert.equal(ui.query("Open lead Board overflow"), undefined, "a papercut is not listed as a lead");
  ui.press("Open lead Triage the plan");
  assert.deepEqual(log.opened, ["lead:l1"]);

  ui.press("Show papercuts for Alpha lane");
  assert.ok(ui.get("Open papercut Board overflow"));
  ui.press("Open papercut Board overflow");
  assert.deepEqual(log.opened, ["lead:l1", "lead:p1"]);
});

test("lead lists page eight at a time from the complete read, so a first page is never a total", async () => {
  const records = Array.from({ length: 10 }, (_, index) => lead(`l${index}`, `Lead ${index}`));
  const { ui } = await mountLane({ leads: { items: records } });
  assert.match(ui.text(), /Leads · 10/, "the count is the lane's total, not the page");
  ui.press("Show leads for Alpha lane");
  assert.match(ui.text(), /Showing 8 of 10 leads\./);
  assert.ok(ui.get("Open lead Lead 7"));
  assert.equal(ui.query("Open lead Lead 8"), undefined, "the rest wait for the next page");
  ui.press("Show 2 more leads");
  assert.ok(ui.get("Open lead Lead 9"));
  assert.doesNotMatch(ui.text(), /Showing 8 of 10 leads/, "every lead shown ends the paging line");
  assert.equal(ui.query("Show 2 more leads"), undefined);

  const cuts = Array.from({ length: 9 }, (_, index) => lead(`p${index}`, `Papercut ${index}`, ["papercut"], "board"));
  const paged = await mountLane({ leads: { items: cuts } });
  assert.match(paged.ui.text(), /Papercuts · 9/);
  paged.ui.press("Show papercuts for Alpha lane");
  assert.match(paged.ui.text(), /Showing 8 of 9 papercuts\./);
  paged.ui.press("Show 1 more papercuts");
  assert.ok(paged.ui.get("Open papercut Papercut 8"));
});

test("a lead list still loading or failing shows no count, so a partial read is never a total", async () => {
  const loading = await mountLane({ leads: {} });
  loading.ui.press("Show leads for Alpha lane");
  assert.match(loading.ui.text(), /Loading leads…/);
  assert.doesNotMatch(loading.ui.text(), /Leads · /);

  const failed = await mountLane({ leads: { error: "lead.board refused" } });
  failed.ui.press("Show leads for Alpha lane");
  assert.match(failed.ui.text(), /Couldn’t load leads: lead\.board refused/);
  assert.match(failed.ui.text(), /Nothing here is a total until it loads\./);
  assert.doesNotMatch(failed.ui.text(), /Leads · /);
  assert.ok(failed.ui.get("Retry loading leads"));

  const stale = await mountLane({ leads: { items: [lead("l1", "Kept")], error: "timeout" } });
  stale.ui.press("Show leads for Alpha lane");
  assert.match(stale.ui.text(), /Showing the last leads read\. It may be out of date: timeout/);
  assert.match(stale.ui.text(), /Leads · 1/);
});

test("an empty related list says what is absent", async () => {
  const { ui } = await mountLane({ leads: { items: [] } });
  ui.press("Show papercuts for Alpha lane");
  assert.match(ui.text(), /No open papercuts in this lane\./);
  ui.press("Show leads for Alpha lane");
  assert.match(ui.text(), /No open leads in this lane\./);
});

test("the layout stacks at narrow sizes and sits the document beside the lists at wide sizes", async () => {
  const wide = await mountLane({ compact: false });
  assert.equal(wide.ui.get("Lane document and records").props.style.flexDirection, "row");
  assert.equal(wide.ui.get("Lane document and records").props.style.flexWrap, "wrap");
  const narrow = await mountLane({ compact: true });
  assert.equal(narrow.ui.get("Lane document and records").props.style.flexDirection, "column");
  assert.equal(narrow.ui.get("Lane document and records").props.style.flexWrap, "wrap");
});

test("raw keys, repositories and lane status stay behind Details", async () => {
  const { ui, log } = await mountLane();
  assert.equal(ui.query("Lane repositories"), undefined);
  assert.doesNotMatch(ui.text(), /alpha-lane/);
  ui.press("Show details for Alpha lane");
  assert.ok(ui.get("Lane repositories"));
  assert.match(ui.text(), /owner\/alpha \(\/alpha\)/);
  assert.match(ui.text(), /Key · alpha-lane/);
  ui.press("Set lane alpha-lane paused");
  assert.deepEqual(log.status, ["paused"]);
});

test("the editor and reader are reachable only with a document the operator can write", async () => {
  const { ui } = await mountLane({ canEdit: false });
  assert.equal(ui.query("Edit the Alpha lane document"), undefined);
  assert.ok(ui.get("Read full document for Alpha lane"));
  const none = await mountLane({ canEdit: false, doc: { data: null } });
  assert.equal(none.ui.query("Write document for Alpha lane"), undefined);
});

test("a lane with no document yet and a read still loading keep Edit unavailable", async () => {
  const { ui } = await mountLane({ doc: {} });
  assert.equal(ui.query("Edit the Alpha lane document"), undefined);
  assert.equal(ui.query("Write document for Alpha lane"), undefined);
});
