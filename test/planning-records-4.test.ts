import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SCHEMA, Store, digest } from "../core/store/store";
import { Engine } from "../core/engine";
import { Leads } from "../core/planning/leads";
import { Papercuts } from "../core/planning/papercut-operations";
import { runPrompt } from "../core/dispatch/prompts";
import { briefDigest } from "../core/planning/brief";
import { submissionSchema, boardLeadSchema, leadAdd, leadEdit, leadReopen, leadList, leadImport, papercutAdd, planSet, type LeadDetail, type Profile, type Run, type Submission } from "../shared/contracts";
import { parseContractValue } from "../shared/schema-refusal";
import type { Adapter } from "../core/host";

/** Spec 026 acceptance oracle rows 1–6 and 16: one named test per row. */
const alpha = { origin: "owner/alpha", path: "/fixture/alpha" };
const beta = { origin: "owner/beta", path: "/fixture/beta" };
const profile: Profile = { id: "worker", name: "Worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "queue-planning-"));
  const path = join(dir, "queue.sqlite");
  let store = new Store(path);
  return {
    dir, path,
    get store() { return store; },
    get leads() { return new Leads(store); },
    get cuts() { return new Papercuts(store); },
    reopen() { store.close(); store = new Store(path); },
    lane(key: string, repositories = [alpha]) { return store.upsertLane({ key, title: key, aim: `Aim of ${key}`, repositories }); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const boardOrder = (...leads: Array<{ id: string; createdAt: string }>) =>
  [...leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map(lead => lead.id);

test("lead.board keeps partly promoted multi-repository cards and carries linked promoted leads as link facts", () => {
  const f = setup(); try {
    f.lane("lane-a");
    const stamp = "2026-10-20T00:00:00.000Z";
    const multi = f.leads.add({ repositories: [alpha, beta], title: "Multi", body: "Multi body", lanes: ["lane-a"], author: "agent-1" });
    f.store.updateLead({ ...multi, state: "promoted", version: 2,
      targets: [...multi.targets, { kind: "task" as const, repository: alpha.origin, reference: "task-1", at: stamp }] });
    const full = f.leads.add({ repositories: [alpha], title: "Full", body: "Full body", lanes: [], author: "agent-1" });
    f.store.updateLead({ ...full, state: "promoted",
      targets: [...full.targets, { kind: "task" as const, repository: alpha.origin, reference: "task-2", at: stamp }] });
    const decision = f.store.addDecision({ id: "dec-1", version: 1, question: "Promote the second repository too?",
      askedBy: { agentId: "agent-1", project: null }, links: { tasks: [], leads: [full.id, multi.id], papercuts: [] },
      status: "open", createdAt: stamp, updatedAt: stamp });
    const board = f.store.listBoardLeads();
    assert.deepEqual(board.cards.map(card => card.id), [multi.id], "the partly promoted lead keeps its card; the fully promoted one leaves");
    assert.deepEqual(board.cards[0]!.targets, [{ kind: "task", repository: alpha.origin }], "only the draft/task targets the board reads");
    assert.deepEqual(board.links, [{ id: full.id, lanes: [], repositories: [alpha] }], "the linked promoted lead appears once, as link facts alone");
    assert.ok(!JSON.stringify(board).includes("Full body"), "link facts carry no body");
    f.store.updateDecision({ ...decision, status: "answered", version: 2,
      answer: { text: "Yes", answeredBy: "operator", answeredAt: stamp, relayed: null, note: "" } });
    const after = f.store.listBoardLeads();
    assert.deepEqual(after.links, [], "an answered decision drops the link facts");
    assert.deepEqual(after.cards.map(card => card.id), [multi.id], "the card set never changes with decision state");
  } finally { f.close(); }
});

test("lead.board carries non-card papercut decision links", () => {
  const f = setup(); try {
    const cut = f.cuts.add({ repository: alpha, title: "Cut", happened: "Friction", impact: "Time", filedBy: "operator" });
    f.cuts.close({ id: cut.id, reason: "completed", note: "Done" });
    const stamp = "2026-10-20T00:00:00.000Z";
    f.store.addDecision({ id: "cut-decision", version: 1, question: "Review?", askedBy: { agentId: "agent", project: null }, links: { tasks: [], leads: [], papercuts: [cut.id] }, status: "open", createdAt: stamp, updatedAt: stamp });
    const board = f.store.listBoardLeads();
    assert.equal(board.cards.some(card => card.id === cut.id), false);
    assert.deepEqual(board.links, [{ id: cut.id, lanes: [], repositories: [alpha] }]);
  } finally { f.close(); }
});

test("lead.board answers through the catalogue and reuses its projection until a write advances the revision", async () => {
  const { QueueRuntime } = await import("../service/runtime-owner");
  const { callCatalogueMethod } = await import("../service/transport/dispatch");
  const dir = mkdtempSync(join(tmpdir(), "nsq-lead-board-"));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.upsertProject({ key: "app", name: "App", repositories: [{ origin: alpha.origin, path: "" }] });
    const added = await runtime.addLead({ repositories: [alpha], title: "Card", body: "Body", lanes: [], author: "operator" });
    const first = await callCatalogueMethod(runtime, "lead.board", {}) as { cards: Array<{ id: string }>; links: unknown[] };
    assert.deepEqual(first.cards.map(card => card.id), [added.id]);
    assert.equal(first.links.length, 0);
    // Between writes the runtime reuses its revisioned projection; dispatch output validation
    // parses each response, so identity is asserted on the owner method directly.
    assert.equal(runtime.leadBoard(), runtime.leadBoard(), "an unchanged revision reuses the projection instead of rescanning");
    const second = await runtime.addLead({ repositories: [alpha], title: "Second", body: "Body 2", lanes: [], author: "operator" });
    const next = await callCatalogueMethod(runtime, "lead.board", {}) as { cards: Array<{ id: string }> };
    assert.notEqual(next, first);
    assert.deepEqual(next.cards.map(card => card.id), boardOrder(second, added), "a lead write advances the revision and the projection");
  } finally { await runtime.stop?.(); rmSync(dir, { recursive: true, force: true }); }
});

test("lead.board gives legacy rows the canonical defaults lead.list gives them, and still refuses invalid ones (live #377)", () => {
  const f = setup(); try {
    f.lane("lane-a");
    const stamp = "2026-10-20T00:00:00.000Z";
    const noTags = f.leads.add({ repositories: [alpha], title: "No tags", body: "Body", lanes: ["lane-a"], author: "agent-1", tags: ["idea"] });
    const noLanes = f.leads.add({ repositories: [alpha], title: "No lanes", body: "Body", lanes: ["lane-a"], author: "agent-1" });
    const linked = f.leads.add({ repositories: [alpha], title: "Linked", body: "Body", lanes: ["lane-a"], author: "agent-1" });
    f.store.updateLead({ ...linked, state: "promoted",
      targets: [...linked.targets, { kind: "task" as const, repository: alpha.origin, reference: "task-9", at: stamp }] });
    f.store.addDecision({ id: "dec-legacy", version: 1, question: "Which lane?",
      askedBy: { agentId: "agent-1", project: null }, links: { tasks: [], leads: [linked.id], papercuts: [] },
      status: "open", createdAt: stamp, updatedAt: stamp });
    // Rows written before a defaulted field existed carry no key for it at all.
    const strip = (id: string, path: string) => f.store.db.prepare(`UPDATE leads SET data=json_remove(data,'${path}') WHERE id=?`).run(id);
    strip(noTags.id, "$.tags"); strip(noLanes.id, "$.lanes"); strip(linked.id, "$.lanes");
    const board = f.store.listBoardLeads();
    const card = (id: string) => board.cards.find(item => item.id === id)!;
    assert.deepEqual(card(noTags.id).tags, f.store.lead(noTags.id).tags, "a missing tags field takes the lead.list default");
    assert.deepEqual(card(noTags.id).tags, []);
    assert.deepEqual(card(noLanes.id).lanes, []);
    assert.deepEqual(board.links, [{ id: linked.id, lanes: [], repositories: [alpha] }], "link rows take the same defaults");
    assert.doesNotThrow(() => boardLeadSchema.parse(card(noTags.id)), "the card passes the lead.board output schema");
    // A field present but invalid is not a legacy default: it fails exactly as lead.list does.
    f.store.db.prepare("UPDATE leads SET data=json_set(data,'$.tags',json('null')) WHERE id=?").run(noTags.id);
    assert.throws(() => f.store.lead(noTags.id));
    assert.throws(() => f.store.listBoardLeads());
  } finally { f.close(); }
});

test("lead.board moves only narrow facts across the SQLite boundary, whatever metadata a lead retains (review #561)", () => {
  const f = setup(); try {
    const heavy = f.leads.add({ repositories: [alpha], title: "Heavy", body: "z".repeat(500_000), lanes: [], author: "agent-1" });
    const big = "m".repeat(1_000_000);
    // Large retained metadata the board never shows: a check message and a long reopen history.
    f.store.db.prepare("UPDATE leads SET data=json_set(data,'$.check',json(?),'$.reopens',json(?)) WHERE id=?").run(
      JSON.stringify({ ok: true, message: big, checkedAt: "2026-10-20T00:00:00.000Z", planningCommit: null }),
      JSON.stringify(Array.from({ length: 1_000 }, (_, n) => ({ at: "2026-10-20T00:00:00.000Z", by: "agent-1", reason: `reopen ${n} ${"r".repeat(1_000)}` }))),
      heavy.id);
    let crossed = 0;
    const prepare = f.store.db.prepare.bind(f.store.db);
    (f.store.db as { prepare: typeof prepare }).prepare = (sql: string) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      return Object.assign(statement, { all: (...args: Parameters<typeof all>) => {
        const rows = all(...args);
        crossed += rows.reduce((sum, row) => sum + Object.values(row as Record<string, unknown>).reduce((size: number, value) => size + String(value ?? "").length, 0), 0);
        return rows;
      } });
    };
    const board = f.store.listBoardLeads();
    (f.store.db as { prepare: typeof prepare }).prepare = prepare;
    assert.deepEqual(board.cards.find(card => card.id === heavy.id)?.check, { ok: true });
    assert.ok(crossed < 4 * 1024, `the board read moved ${crossed} characters out of SQLite; only narrow facts and a preview may cross`);
  } finally { f.close(); }
});

test("lead.board refuses a defaulted nested field that is present but not an object, as lead.list does", () => {
  const f = setup(); try {
    const lead = f.leads.add({ repositories: [alpha], title: "Bad check", body: "Body", lanes: [], author: "agent-1" });
    f.store.db.prepare("UPDATE leads SET data=json_set(data,'$.check','yes') WHERE id=?").run(lead.id);
    assert.throws(() => f.store.lead(lead.id));
    assert.throws(() => f.store.listBoardLeads(), /malformed check/);
  } finally { f.close(); }
});

test("lead.board accepts a papercut lead whose area is null, on cards and links, and refuses one with no area key (review #561)", () => {
  const f = setup(); try {
    f.lane("lane-a");
    const stamp = "2026-10-20T00:00:00.000Z";
    const card = f.leads.add({ repositories: [alpha], title: "Papercut card", body: "Body", lanes: ["lane-a"], author: "agent-1" });
    const linked = f.leads.add({ repositories: [alpha], title: "Papercut link", body: "Body", lanes: ["lane-a"], author: "agent-1" });
    f.store.updateLead({ ...linked, state: "promoted",
      targets: [...linked.targets, { kind: "task" as const, repository: alpha.origin, reference: "task-p", at: stamp }] });
    f.store.addDecision({ id: "dec-papercut", version: 1, question: "Which lane?",
      askedBy: { agentId: "agent-1", project: null }, links: { tasks: [], leads: [linked.id], papercuts: [] },
      status: "open", createdAt: stamp, updatedAt: stamp });
    const papercut = JSON.stringify({ area: null, happened: "It happened", impact: "", fix: null, source: null, draftId: null });
    for (const id of [card.id, linked.id])
      f.store.db.prepare("UPDATE leads SET data=json_set(data,'$.papercut',json(?)) WHERE id=?").run(papercut, id);
    assert.equal(f.store.lead(card.id).papercut?.area, null, "the canonical lead accepts a null area");
    const board = f.store.listBoardLeads();
    assert.equal(board.cards.find(item => item.id === card.id)?.papercutArea, null);
    assert.deepEqual(board.links.map(link => link.id), [linked.id]);
    f.store.db.prepare("UPDATE leads SET data=json_remove(data,'$.papercut.area') WHERE id=?").run(card.id);
    assert.throws(() => f.store.lead(card.id), "a papercut with no area key is invalid canonically");
    assert.throws(() => f.store.listBoardLeads(), /malformed papercut/);
  } finally { f.close(); }
});
