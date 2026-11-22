import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Leads } from "../core/planning/leads";
import { Papercuts } from "../core/planning/papercut-operations";
import { TriageService, triageDigest, type TriageDecision } from "../core/planning/triage";
import { unparkDueLeads } from "../core/planning/parking";
import { LEAD_PARKING_MIGRATION_KEY } from "../core/store/store-migration";
import { pipelineBoard } from "../shared/pipeline-board";
import { inboxCounts, inboxSections, leadsCards, papercutCards, parkedCards } from "../shared/inbox-board";
import { triageStatus } from "../shared/pipeline-board";
import { defaultRecheckDate, parkedCheckLabel, recheckIsoFromDate, PARK_DEFAULT_DAYS } from "../shared/parking";
import type { BoardLead, Lead } from "../shared/contracts";

/** Nucleus#1543 proofs on an isolated store: park and unpark, the board's counts, the due recheck, edits, the hold-tag migration and triage defer. */
const alpha = { origin: "owner/alpha", path: "/fixture/alpha" };
const PLANNER = "planner-agent";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "queue-parking-"));
  const path = join(dir, "queue.sqlite");
  let store = new Store(path);
  const key = () => store.projectByKey(store.ensureProject(alpha.path, alpha.origin).key)!.key;
  let projectKey = key();
  return {
    dir,
    get store() { return store; },
    get projectKey() { return projectKey; },
    get leads() { return new Leads(store); },
    get cuts() { return new Papercuts(store); },
    get service() { return new TriageService(store); },
    reopen() { store.close(); store = new Store(path); projectKey = store.projectByKey(projectKey)!.key; },
    planner() { store.setProjectPlanner({ key: projectKey, agentId: PLANNER, setBy: "test" }); },
    enable() { return new TriageService(store).setEnabled({ project: projectKey, enabled: true, by: "operator" }); },
    add(title: string, tags: string[] = [], body = "Filing text") {
      return this.leads.add({ repositories: [alpha], title, body, lanes: [], tags, author: "agent-1" });
    },
    /** The board's narrow read, as the inbox sees it: every open lead card plus its projection. */
    board() {
      return pipelineBoard({ projects: store.projects(), selection: [], leads: store.listBoardLeads().cards, linkedLeads: [], tasks: [], decisions: [], pendingSubmissions: [] });
    },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const cardIds = (cards: { id: string }[]) => cards.map(card => card.id).sort();

test("1543-1 a parked lead leaves the list and every count, and unparking returns it", () => {
  const f = setup(); try {
    const a = f.add("Open the T3 Inbox board in the maximized right panel");
    const b = f.add("Ordinary lead");
    assert.equal(inboxCounts(f.board()).leads, 2);
    const revisitAt = new Date(Date.now() + DAY).toISOString();
    f.leads.park({ id: a.id, version: a.version, reason: "Waits on a T3 capability", revisitAt, author: "planner" });

    let board = f.board();
    assert.deepEqual(cardIds(leadsCards(board)), [b.id].sort(), "the parked lead is not on the to-do list");
    assert.equal(inboxCounts(board).leads, 1, "the menu count leaves it out");
    assert.equal(inboxSections(board, "leads")[0].cards.length, 1, "the list header count leaves it out");
    assert.deepEqual(cardIds(parkedCards(board, "leads")), [a.id], "it shows under Parked");
    const parkedCard = parkedCards(board, "leads")[0].value as BoardLead;
    assert.equal(parkedCard.parked?.reason, "Waits on a T3 capability");
    assert.equal(triageStatus(parkedCard).state, "Waits on a T3 capability", "an expanded parked card shows its reason");
    assert.match(triageStatus(parkedCard).detail ?? "", /^check again /);

    const unparked = f.leads.unpark({ id: a.id, version: a.version });
    assert.equal(unparked.parked, null);
    board = f.board();
    assert.equal(inboxCounts(board).leads, 2, "unparking returns it to the count");
    assert.deepEqual(parkedCards(board, "leads"), []);
    assert.throws(() => f.leads.unpark({ id: a.id, version: a.version }), /not parked/);
  } finally { f.close(); }
});

test("1543-2 park is version-guarded, refuses wrong states and past dates, and a re-park replaces the record", () => {
  const f = setup(); try {
    const lead = f.add("Guarded");
    const future = new Date(Date.now() + DAY).toISOString();
    assert.throws(() => f.leads.park({ id: lead.id, version: 9, reason: "stale", author: "planner" }), /reload before parking/);
    assert.throws(() => f.leads.park({ id: lead.id, version: lead.version, reason: "   ", author: "planner" }), /reason/);
    assert.throws(() => f.leads.park({ id: lead.id, version: lead.version, reason: "past", revisitAt: new Date(Date.now() - HOUR).toISOString(), author: "planner" }), /future/);
    const first = f.leads.park({ id: lead.id, version: lead.version, reason: "First reason", revisitAt: future, author: "planner" });
    assert.equal(first.version, lead.version, "parking changes no content version");
    const again = f.leads.park({ id: lead.id, version: first.version, reason: "Second reason", revisitAt: null, author: "operator" });
    assert.equal(again.parked?.reason, "Second reason");
    assert.equal(again.parked?.revisitAt, null, "a re-park with no date replaces the record");
    const dropped = f.add("Dropped one");
    f.leads.drop({ id: dropped.id, reason: "not needed" });
    assert.throws(() => f.leads.park({ id: dropped.id, version: dropped.version, reason: "nope", author: "planner" }), /Only open leads can be parked/);
  } finally { f.close(); }
});

test("1543-3 a passed recheck unparks the lead once, tells the planner once and is never repeated", () => {
  const f = setup(); try {
    f.planner();
    const lead = f.add("Waiting on upstream");
    const soon = new Date(Date.now() + HOUR).toISOString();
    f.leads.park({ id: lead.id, version: lead.version, reason: "Waits on upstream", revisitAt: soon, author: "planner" });
    assert.deepEqual(unparkDueLeads(f.store, Date.now()), [], "before the time, nothing moves");
    assert.ok(f.store.lead(lead.id).parked, "still parked");

    const later = Date.now() + 2 * HOUR;
    assert.deepEqual(unparkDueLeads(f.store, later), [lead.id]);
    const after = f.store.lead(lead.id);
    assert.equal(after.parked, null);
    assert.equal(after.recheck?.reason, "Waits on upstream");
    const notices = f.store.notices(`project:${f.projectKey}`).filter(notice => notice.kind === "lead_recheck");
    assert.equal(notices.length, 1, "one planner notice");
    assert.equal(notices[0].text.split("\n")[0], `Parked lead ${lead.title} is due for a recheck: Waits on upstream`);
    assert.equal(triageStatus(f.board().cards.Triage.find(card => card.kind === "lead")!.value as BoardLead).state, "Due for a recheck");

    assert.deepEqual(unparkDueLeads(f.store, later + DAY), [], "a second pass finds nothing to unpark");
    assert.equal(f.store.notices(`project:${f.projectKey}`).filter(notice => notice.kind === "lead_recheck").length, 1, "never repeated");
  } finally { f.close(); }
});

test("1543-4 edit, promote and drop each unpark a parked lead", () => {
  const f = setup(); try {
    const edited = f.add("Edited");
    const promoted = f.add("Promoted");
    const dropped = f.add("Dropped");
    const at = new Date(Date.now() + DAY).toISOString();
    for (const lead of [edited, promoted, dropped]) f.leads.park({ id: lead.id, version: lead.version, reason: "wait", revisitAt: at, author: "planner" });

    const afterEdit = f.leads.edit({ id: edited.id, version: edited.version, body: "A new brief body", author: "operator" });
    assert.equal(afterEdit.parked, null, "an edit unparks");
    assert.equal(afterEdit.version, edited.version + 1);

    const afterPromote = f.leads.promote({ id: promoted.id, kind: "question", reference: "question-7" });
    assert.equal(afterPromote.parked, null, "a promotion unparks");

    const afterDrop = f.leads.drop({ id: dropped.id, reason: "superseded" });
    assert.equal(afterDrop.parked, null, "a drop unparks");
    assert.equal(afterDrop.state, "dropped");
  } finally { f.close(); }
});

test("1543-5 the hold tag becomes a park on the next open, once, and the tag goes", () => {
  const f = setup(); try {
    const held = f.add("Held before parking", ["hold", "t3"]);
    f.reopen();
    const migrated = f.store.lead(held.id);
    assert.deepEqual(migrated.tags, ["t3"], "the hold tag is removed");
    assert.equal(migrated.parked?.reason, "Held before parking existed");
    assert.equal(migrated.parked?.revisitAt, null);
    assert.equal(migrated.state, "open");
    const record = f.store.getMeta<{ changes: Array<{ id: string }> }>(LEAD_PARKING_MIGRATION_KEY);
    assert.deepEqual(record?.changes.map(change => change.id), [held.id], "the migration record names the change");

    f.reopen();
    assert.equal(f.store.getMeta<{ changes: unknown[] }>(LEAD_PARKING_MIGRATION_KEY)?.changes.length, 1, "a later open changes nothing");
    assert.equal(f.store.lead(held.id).parked?.reason, "Held before parking existed");
  } finally { f.close(); }
});

test("1543-6 triage never batches a parked lead, and defer writes a park with its revisit time", () => {
  const f = setup(); try {
    f.planner(); f.enable();
    const parkedAlready = f.add("Parked before triage");
    f.leads.park({ id: parkedAlready.id, version: parkedAlready.version, reason: "later", revisitAt: new Date(Date.now() + DAY).toISOString(), author: "planner" });
    const candidate = f.add("Deferred by triage");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.projectKey).batch!;
    assert.deepEqual(batch.items.map(item => item.recordId), [candidate.id], "only the open lead is batched");

    const revisitAt = new Date(Date.now() + 7 * DAY).toISOString();
    const decision: TriageDecision = { recordId: candidate.id, leadVersion: candidate.version, digest: triageDigest(candidate), disposition: "defer", reason: "Revisit after the release", revisitAt };
    const { result, promotions } = f.service.begin({ project: f.projectKey, batch: batch.id, by: PLANNER, decisions: [decision] });
    assert.equal(promotions.length, 0);
    assert.equal(result?.complete, true);
    assert.equal(result?.outcomes[0].status, "applied");
    const deferred = f.store.lead(candidate.id);
    assert.equal(deferred.parked?.reason, "Revisit after the release");
    assert.equal(deferred.parked?.revisitAt, revisitAt, "the park carries the revisit time");
    assert.equal(deferred.state, "open");

    f.service.evaluate({ at: Date.now() });
    assert.equal(f.service.view(f.projectKey).batch, null, "a deferred lead is not batched while parked");
  } finally { f.close(); }
});

test("1543-7 a papercut parks like a lead, and closing it unparks it", () => {
  const f = setup(); try {
    const cut = f.cuts.add({ repository: alpha, title: "Slow board refresh", happened: "It lagged", impact: "Time lost", filedBy: "agent-1" });
    f.cuts.edit({ id: cut.id, version: cut.version, title: "Slow board refresh (renamed)" });
    const current = f.store.papercut(cut.id);
    f.leads.park({ id: cut.id, version: f.store.lead(cut.id).version, reason: "Waits on a host fix", revisitAt: null, author: "planner" });
    assert.equal(f.store.papercut(cut.id).parked?.reason, "Waits on a host fix");
    const board = f.board();
    assert.deepEqual(cardIds(papercutCards(board)), [], "the parked papercut is not on the list");
    assert.deepEqual(cardIds(parkedCards(board, "papercuts")), [cut.id]);
    assert.equal(current.state, "open");

    f.cuts.close({ id: cut.id, reason: "completed", note: "fixed" });
    const closed = f.store.lead(cut.id);
    assert.equal(closed.state, "closed");
    assert.equal(closed.parked, null, "closing unparks");
  } finally { f.close(); }
});

test("1543-8 the park rules: default date, date parsing and the parked label", () => {
  const now = new Date("2026-11-22T10:00:00");
  assert.equal(defaultRecheckDate(now), `2026-12-06`, `${PARK_DEFAULT_DAYS} days out, local day`);
  assert.ok(recheckIsoFromDate("2026-12-06", now), "a future day is accepted");
  assert.equal(recheckIsoFromDate("2026-11-22", now), null, "today is not after today");
  assert.equal(recheckIsoFromDate("2026-02-31", now), null, "a rolled-over day is refused, not moved");
  assert.equal(recheckIsoFromDate("next week", now), null);
  assert.equal(parkedCheckLabel(null), "no recheck date set");
  // The day is written in the reader's locale, so the proof checks the wording and the year, not the format.
  assert.match(parkedCheckLabel(new Date("2026-12-06T09:00:00").toISOString()), /^check again .*2026$/);
});
