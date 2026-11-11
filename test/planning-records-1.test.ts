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

test("026-1 lead add, edit, get, list, set-lanes and drop round-trip with body versions", () => {
  const f = setup(); try {
    const added = f.leads.add({ repositories: [alpha], title: "Idea", body: "First body", lanes: [], author: "agent-1" });
    assert.equal(added.state, "open"); assert.equal(added.version, 1);
    const edited = f.leads.edit({ id: added.id, version: 1, body: "Second body", author: "operator" });
    assert.equal(edited.version, 2); assert.equal(edited.body, "Second body");
    assert.throws(() => f.leads.edit({ id: added.id, version: 1, body: "Stale", author: "agent-1" }), /reload before saving/);
    const detail = f.leads.get({ id: added.id });
    assert.deepEqual(detail.versions.map(version => [version.version, version.body, version.author]), [[1, "First body", "agent-1"], [2, "Second body", "operator"]]);
    const other = f.leads.add({ repositories: [beta], title: "Other", body: "", lanes: [], author: "operator" });
    assert.deepEqual(f.leads.list(leadList.input.parse({})).map(lead => lead.id).sort(), [added.id, other.id].sort(), "open by default");
    assert.deepEqual(f.leads.list(leadList.input.parse({ repository: "owner/alpha" })).map(lead => lead.id), [added.id]);
    f.lane("lane-a");
    assert.deepEqual(f.leads.setLanes({ id: added.id, lanes: ["lane-a"] }).lanes, ["lane-a"]);
    assert.deepEqual(f.leads.list(leadList.input.parse({ lane: "lane-a" })).map(lead => lead.id), [added.id]);
    assert.equal(leadList.input.parse({ state: "closed" }).state, "closed");
    const dropped = f.leads.drop({ id: other.id, reason: "Superseded by a spec" });
    assert.equal(dropped.state, "dropped"); assert.equal(dropped.dropReason, "Superseded by a spec"); assert.ok(dropped.closedAt);
    assert.deepEqual(f.leads.list(leadList.input.parse({ state: "dropped" })).map(lead => lead.id), [other.id]);
    assert.throws(() => f.leads.drop({ id: other.id, reason: "Again" }), /Only open leads/);
    const promoted = f.leads.promote({ id: added.id, kind: "question", reference: "Should lanes gate?" });
    assert.equal(promoted.state, "promoted");
    assert.deepEqual(promoted.targets.map(target => [target.kind, target.repository, target.reference]), [["question", null, "Should lanes gate?"]]);
    assert.equal(f.leads.promote({ id: added.id, kind: "question", reference: "Should lanes gate?" }).targets.length, 1, "a repeated promotion adds nothing");
    assert.equal(f.leads.promote({ id: added.id, kind: "knowledge", reference: "docs/knowledge/x.md" }).targets.length, 2);
  } finally { f.close(); }
});

test("026-1 lead drop needs a reason at the contract", async () => {
  const { leadDrop } = await import("../shared/contracts");
  assert.throws(() => leadDrop.input.parse({ id: "x" }));
  assert.throws(() => leadDrop.input.parse({ id: "x", reason: "  " }));
});

test("026-1 lead reopen needs an id, a nonempty reason and an author at the contract", () => {
  assert.throws(() => leadReopen.input.parse({ id: "x" }));
  assert.throws(() => leadReopen.input.parse({ id: "x", reason: "  ", author: "operator" }), /reason/);
  assert.throws(() => leadReopen.input.parse({ id: "x", reason: "why" }), /author/);
  assert.throws(() => leadReopen.input.parse({ id: "x", reason: "why", author: "" }));
  assert.equal(leadReopen.input.parse({ id: "x", reason: "  mistaken drop  ", author: "agent-1" }).reason, "mistaken drop");
  assert.equal(leadReopen.input.parse({ id: "x", reason: "why", author: "agent-1" }).author, "agent-1");
});

test("026-1 lead reopen restores a dropped, checked, approved multi-version lead in place and keeps the drop in history", () => {
  const f = setup(); try {
    f.lane("lane-a");
    const lead = f.leads.add({ repositories: [alpha], title: "Mistakenly dropped", body: "v1", lanes: ["lane-a"], tags: ["idea"], author: "agent-1" });
    f.leads.edit({ id: lead.id, version: 1, body: "v2", author: "operator" });
    const at = "2026-10-14T09:00:00.000Z";
    f.store.recordLeadCheck(lead.id, 2, { ok: true, message: "Renders", checkedAt: at, planningCommit: "c".repeat(40), baseBranch: "main" });
    const approval = { version: 2, digest: briefDigest("v2"), approver: "Tom", approvedAt: at, note: "", relayed: false };
    f.store.updateLead({ ...f.store.lead(lead.id), approval });
    f.store.recordLeadApproval(lead.id, 2, approval);
    const before = { lead: f.store.lead(lead.id), versions: f.store.leadVersions(lead.id) };
    const dropped = f.leads.drop({ id: lead.id, reason: "Dropped in triage by mistake" });
    const reopened = f.leads.reopen({ id: lead.id, reason: "Mistaken drop; the planner wants it back", author: "agent-9" });
    assert.equal(reopened.state, "open");
    assert.equal(reopened.dropReason, null, "the current dropped-state reason clears");
    assert.equal(reopened.closedAt, null);
    assert.equal(reopened.version, 2, "the content version is unchanged");
    assert.deepEqual(f.store.leadVersions(lead.id), before.versions, "every saved version, check and approval byte is unchanged");
    for (const field of ["id", "title", "body", "digest", "check", "checkOperationId", "approval", "author", "repositories", "lanes", "tags", "baseBranch", "targets", "source", "createdAt"] as const)
      assert.deepEqual(reopened[field], before.lead[field], `${field} is unchanged`);
    assert.equal(f.store.leadVersions(lead.id).length, 2, "no version row is written");
    const [episode] = reopened.reopens;
    assert.deepEqual(episode.drop, { reason: "Dropped in triage by mistake", at: dropped.closedAt }, "the prior drop's reason and time outlive the cleared state fields");
    assert.equal(episode.reason, "Mistaken drop; the planner wants it back");
    assert.equal(episode.by, "agent-9");
    assert.ok(episode.at);
    assert.deepEqual(f.leads.get({ id: lead.id }).reopens, reopened.reopens, "lead.get carries the durable history");
    // Editable again through the ordinary path, which writes no reopen episode.
    const edited = f.leads.edit({ id: lead.id, version: 2, body: "v3", author: "operator" });
    assert.equal(edited.version, 3);
    assert.equal(edited.reopens.length, 1);
    // Wrong-state and repeated requests refuse whole and write nothing.
    const frozen = JSON.stringify(f.store.lead(lead.id));
    assert.throws(() => f.leads.reopen({ id: lead.id, reason: "Again", author: "agent-9" }), /Only dropped leads can be reopened; this lead is open/);
    assert.equal(JSON.stringify(f.store.lead(lead.id)), frozen, "a refused reopen writes nothing");
    assert.throws(() => f.leads.reopen({ id: lead.id, reason: "Again", author: "agent-9" }), /this lead is open/);
    assert.equal(f.leads.get({ id: lead.id }).reopens.length, 1, "no duplicate audit row");
    f.leads.promote({ id: lead.id, kind: "question", reference: "Should this lead survive?" });
    assert.throws(() => f.leads.reopen({ id: lead.id, reason: "Unpromote", author: "agent-9" }), /this lead is promoted/, "targets are never silently unpromoted");
    const cut = f.cuts.add({ repository: alpha, title: "Cut", happened: "Friction", impact: "Time", filedBy: "operator" });
    assert.throws(() => f.leads.reopen({ id: cut.id, reason: "Not a lead", author: "agent-9" }), /Papercut records are not reopened by lead\.reopen/);
    // A second drop and reopen appends one episode per cycle, each with its own prior drop.
    const recurring = f.leads.add({ repositories: [alpha], title: "Dropped twice", body: "", lanes: [], author: "operator" });
    const firstDrop = f.leads.drop({ id: recurring.id, reason: "First drop" });
    f.leads.reopen({ id: recurring.id, reason: "First reopen", author: "agent-1" });
    const secondDrop = f.leads.drop({ id: recurring.id, reason: "Second drop" });
    const again = f.leads.reopen({ id: recurring.id, reason: "Second reopen", author: "operator" });
    assert.deepEqual(again.reopens.map(entry => [entry.by, entry.reason, entry.drop.reason, entry.drop.at]),
      [["agent-1", "First reopen", "First drop", firstDrop.closedAt], ["operator", "Second reopen", "Second drop", secondDrop.closedAt]]);
  } finally { f.close(); }
});

test("026-1 lead.reopen through the catalogue refuses malformed, concurrent and repeated requests with one audit entry", async () => {
  const { QueueRuntime } = await import("../service/runtime-owner");
  const { callCatalogueMethod } = await import("../service/transport/dispatch");
  const dir = mkdtempSync(join(tmpdir(), "nsq-reopen-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const leads = new Leads(store);
  const lead = leads.add({ repositories: [alpha], title: "Reopen me", body: "Body", lanes: [], author: "operator" });
  store.close();
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await callCatalogueMethod(runtime, "lead.drop", { id: lead.id, reason: "Wrong call" });
    await assert.rejects(() => callCatalogueMethod(runtime, "lead.reopen", { id: lead.id, reason: "   ", author: "agent-9" }), /reason/);
    await assert.rejects(() => callCatalogueMethod(runtime, "lead.reopen", { id: lead.id, reason: "why" }), /author/);
    const rounds = await Promise.allSettled([
      callCatalogueMethod(runtime, "lead.reopen", { id: lead.id, reason: "Mistaken drop", author: "agent-9" }),
      callCatalogueMethod(runtime, "lead.reopen", { id: lead.id, reason: "Mistaken drop", author: "agent-9" }),
    ]);
    const kept = rounds.filter(entry => entry.status === "fulfilled");
    assert.equal(kept.length, 1, "exactly one of two simultaneous reopens is accepted");
    const refused = rounds.find(entry => entry.status === "rejected") as PromiseRejectedResult;
    assert.match(String(refused.reason), /Only dropped leads can be reopened/);
    const read = await callCatalogueMethod(runtime, "lead.get", { id: lead.id }) as LeadDetail;
    assert.equal(read.state, "open");
    assert.equal(read.dropReason, null);
    assert.deepEqual(read.reopens.map(entry => [entry.by, entry.drop.reason]), [["agent-9", "Wrong call"]]);
    assert.equal(read.versions.length, 1, "no content mutation");
    await assert.rejects(() => callCatalogueMethod(runtime, "lead.reopen", { id: lead.id, reason: "Again", author: "agent-9" }), /this lead is open/);
    const after = await callCatalogueMethod(runtime, "lead.get", { id: lead.id }) as LeadDetail;
    assert.equal(after.reopens.length, 1, "the refused repeat adds no audit row");
  } finally { await runtime.stop?.(); rmSync(dir, { recursive: true, force: true }); }
});

test("lead add and edit refuse titles over 200 characters", () => {
  const f = setup(); try {
    const overlong = "x".repeat(201);
    const repository = [alpha];
    assert.equal(leadAdd.input.parse({ repositories: repository, title: "Default base" }).baseBranch, "main");
    assert.equal(leadAdd.input.parse({ repositories: repository, title: "Release base", baseBranch: "release/v0.5" }).baseBranch, "release/v0.5");
    assert.equal(leadEdit.input.parse({ id: "lead", version: 1, baseBranch: "release/v0.5", author: "operator" }).baseBranch, "release/v0.5");
    assert.equal(leadAdd.input.safeParse({ repositories: repository, title: "Bad base", baseBranch: "release/with space" }).success, false);
    assert.equal(leadAdd.input.safeParse({ repositories: repository, title: "Bad ref", baseBranch: "release/foo..bar" }).success, false);
    assert.throws(() => leadAdd.input.parse({ repositories: repository, title: overlong }), /Lead title must be 200 characters or fewer/);
    assert.throws(() => leadEdit.input.parse({ id: "lead", version: 1, title: overlong, body: "", author: "operator" }), /Lead title must be 200 characters or fewer/);
    assert.throws(() => f.leads.add({ repositories: repository, title: overlong, body: "", lanes: [], author: "operator" }), /Lead title must be 200 characters or fewer/);
    const lead = f.leads.add({ repositories: repository, title: "Lead", body: "", lanes: [], author: "operator" });
    assert.throws(() => f.leads.edit({ id: lead.id, version: 1, title: overlong, body: "", author: "operator" }), /Lead title must be 200 characters or fewer/);
  } finally { f.close(); }
});

test("lead add and import accept an origin string and ignore import author", () => {
  const f = setup(); try {
    const originOnly = [{ origin: alpha.origin, path: "" }];
    assert.deepEqual(leadAdd.input.parse({ repositories: alpha.origin, title: "Idea" }).repositories, originOnly);
    assert.deepEqual(leadAdd.input.parse({ repository: alpha.origin, title: "Idea" }).repositories, originOnly);
    assert.deepEqual(leadAdd.input.parse({ repositories: [alpha.origin], title: "Idea" }).repositories, originOnly);
    const imported = leadImport.input.parse({ repository: alpha.origin, path: "/triage", author: "agent-1" });
    assert.deepEqual(imported.repository, originOnly[0]);
    assert.equal("author" in imported, false);
    assert.deepEqual(leadImport.input.parse({ repositories: alpha, path: "/triage" }).repository, alpha);
    assert.deepEqual(papercutAdd.input.parse({ repository: alpha.origin, title: "Cut", happened: "x", impact: "y" }).repository, originOnly[0]);
    assert.throws(() => f.leads.add(leadAdd.input.parse({ repositories: "owner/missing", title: "X" })), /No local checkout for owner\/missing/);
    f.store.putRepository({ origin: alpha.origin, path: alpha.path }, null, "");
    const added = f.leads.add(leadAdd.input.parse({ repository: "https://github.com/owner/alpha", title: "From origin" }));
    assert.deepEqual(added.repositories, [alpha]);
    const cut = f.cuts.add(papercutAdd.input.parse({ repository: alpha.origin, title: "Cut", happened: "Friction", impact: "Time" }));
    assert.deepEqual(cut.repository, alpha);
    const triage = join(f.dir, "docs", "triage");
    mkdirSync(triage, { recursive: true });
    writeFileSync(join(triage, "idea.md"), "# Origin import\n\nBody.\n");
    const report = f.leads.import(leadImport.input.parse({ repository: alpha.origin, path: triage, author: "agent-1" }));
    assert.equal(report.imported.length, 1);
    const lead = f.leads.list(leadList.input.parse({}))[0];
    assert.equal(lead.title, "Origin import");
    assert.equal(lead.author, "import");
    assert.deepEqual(lead.repositories, [alpha]);
  } finally { f.close(); }
});

test("schema refusals name the field and expected shape on one line", () => {
  assert.throws(() => parseContractValue(leadAdd.input, { repositories: [alpha] }), { message: "title: expected string" });
  assert.throws(() => parseContractValue(leadAdd.input, { repositories: 1, title: "t" }), { message: "repositories: expected owner/name origin or {origin, path} or an array of those" });
  assert.throws(() => parseContractValue(leadImport.input, { repository: 1, path: "/x" }), { message: "repository: expected owner/name origin or {origin, path}" });
  assert.throws(() => parseContractValue(leadAdd.input, { repositories: [alpha], title: "t", extra: 1 }), { message: "extra: unrecognized key" });
});

test("an unrecognized origin with a checkout path stores the resolved path as identity", () => {
  const f = setup(); try {
    const path = join(f.dir, "self-hosted");
    mkdirSync(path);
    const repo = { origin: "git@git.internal.example:team/app.git", path };
    const added = f.leads.add({ repositories: [repo], title: "Local", body: "", lanes: [], author: "operator" });
    assert.deepEqual(added.repositories, [{ origin: resolve(path), path }]);
    assert.deepEqual(f.leads.list(leadList.input.parse({ repository: resolve(path) })).map(lead => lead.id), [added.id]);
    const cut = f.cuts.add({ repository: repo, title: "Cut", happened: "Friction", impact: "Time", filedBy: "operator" });
    assert.deepEqual(cut.repository, { origin: resolve(path), path });
    assert.deepEqual(f.cuts.list({ repository: resolve(path) }).map(item => item.id), [cut.id]);
  } finally { f.close(); }
});

test("026-2 a lead or papercut joins two lanes in order; one unknown, closed or non-listing lane refuses the whole change", () => {
  const f = setup(); try {
    f.lane("first"); f.lane("second"); f.lane("closed"); f.lane("elsewhere", [beta]); f.lane("paused");
    f.store.setLaneStatus("closed", "done"); f.store.setLaneStatus("paused", "paused");
    const lead = f.leads.add({ repositories: [alpha], title: "Lead", body: "Body", lanes: [], author: "operator" });
    const cut = f.cuts.add({ repository: alpha, title: "Cut", happened: "Friction", impact: "Time", filedBy: "operator" });
    assert.deepEqual(f.leads.setLanes({ id: lead.id, lanes: ["second", "first", "paused"] }).lanes, ["second", "first", "paused"]);
    assert.deepEqual(f.cuts.setLanes({ id: cut.id, lanes: ["second", "first"] }).lanes, ["second", "first"]);
    for (const [bad, message] of [["missing", /Unknown lane key missing/], ["closed", /is done/], ["elsewhere", /does not list this repository/]] as const) {
      assert.throws(() => f.leads.setLanes({ id: lead.id, lanes: ["first", bad] }), message);
      assert.throws(() => f.cuts.setLanes({ id: cut.id, lanes: ["first", bad] }), message);
      assert.throws(() => f.leads.add({ repositories: [alpha], title: "New", body: "", lanes: [bad], author: "operator" }), message);
    }
    assert.deepEqual(f.leads.get({ id: lead.id }).lanes, ["second", "first", "paused"], "nothing changed");
    assert.deepEqual(f.cuts.get({ id: cut.id }).lanes, ["second", "first"]);
    assert.equal(f.leads.list(leadList.input.parse({})).length, 2, "a refused add writes nothing");
    const both = f.leads.add({ repositories: [alpha, beta], title: "Cross", body: "", lanes: ["first", "elsewhere"], author: "operator" });
    assert.deepEqual(both.lanes, ["first", "elsewhere"], "a lead listing two repositories may join a lane of either");
  } finally { f.close(); }
});
