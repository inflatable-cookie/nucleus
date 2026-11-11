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

test("plans and plan.get stay exact across saves, lane closes and reopens, project edits and a repaired row", () => {
  const f = setup(); try {
    const gamma = { origin: "owner/gamma", path: "/fixture/gamma" };
    f.lane("a"); f.lane("b"); f.lane("gone"); f.lane("shared", [alpha, beta]); f.lane("gamma-lane", [gamma]);
    const projectA = f.store.projectFor(alpha.path, alpha.origin)!;
    const projectB = f.store.projectFor(beta.path, beta.origin)!;
    f.store.setPlan({ project: projectA.key, version: 0, entries: [{ lane: "b", note: "first" }, { lane: "a", horizon: "next", doneWhen: "A lands" }], author: "operator" });
    f.store.setPlan({ project: projectA.key, version: 1, entries: [{ lane: "a", horizon: "next", doneWhen: "A lands" }, { lane: "b" }, { lane: "gone" }], author: "operator" });
    f.store.setPlan({ project: projectB.key, version: 0, entries: [{ lane: "shared" }], author: "operator" });
    // Every read below goes through both public surfaces: the cached list must equal the
    // single-project read, which is what the board and the Planning tab compare.
    const read = () => {
      const all = f.store.plans();
      assert.deepEqual(all.map(plan => plan.project).sort(), f.store.projects().map(project => project.key).sort());
      for (const plan of all) {
        const { savedEntries, ...current } = plan;
        assert.deepEqual(current, f.store.plan({ project: plan.project }));
        assert.deepEqual(savedEntries, plan.version ? f.store.plan({ project: plan.project, version: plan.version }).entries : []);
      }
      return all;
    };
    const planA = () => read().find(plan => plan.project === projectA.key)!;
    assert.deepEqual(planA().entries.map(entry => entry.lane), ["a", "b", "gone", "shared"], "saved order first, unlisted lanes join at the end");
    assert.equal(planA().done, undefined, "no Done band while every saved lane is open");
    assert.deepEqual(read().find(plan => plan.project === projectB.key)!.entries.map(entry => entry.lane), ["shared"], "a lane listing several projects joins each");

    // A lane close, then a reopen: the Done band and the order follow the lane every time.
    f.store.setLaneStatus("a", "done");
    assert.deepEqual(planA().entries.map(entry => entry.lane), ["b", "gone", "shared"]);
    assert.deepEqual(planA().done?.map(entry => [entry.lane, entry.status, entry.doneWhen]), [["a", "done", "A lands"]], "the Done band keeps the entry the plan saved");
    f.store.setLaneStatus("a", "active");
    assert.deepEqual(planA().entries.map(entry => entry.lane), ["a", "b", "gone", "shared"], "a reopen returns the lane to its saved place");
    assert.equal(planA().done, undefined, "and takes it out of the Done band");
    f.store.setLaneStatus("a", "abandoned");
    assert.deepEqual(planA().done?.map(entry => [entry.lane, entry.status]), [["a", "abandoned"]]);
    f.store.setLaneStatus("a", "active");

    // A save invalidates the cached Done band: a lane dropped by the new version stays in
    // history, and the historical read keeps returning exactly what was saved.
    f.store.setLaneStatus("gone", "done");
    assert.deepEqual(planA().done?.map(entry => [entry.lane, entry.status]), [["gone", "done"]]);
    f.store.setPlan({ project: projectA.key, version: 2, entries: [{ lane: "a" }, { lane: "b" }], author: "operator" });
    assert.deepEqual(planA().entries.map(entry => entry.lane), ["a", "b", "shared"]);
    assert.deepEqual(planA().done?.map(entry => entry.lane), ["gone"], "a lane the newest save drops is still read from history");
    assert.deepEqual(f.store.plan({ project: projectA.key, version: 1 }).entries.map(entry => entry.lane), ["b", "a"], "a requested version still reads exactly as the earlier save");

    // A project edit: gamma joins project A, so the gamma lane now joins project A's plan too.
    const editedA = f.store.upsertProject({ key: projectA.key, name: projectA.name, repositories: [{ origin: alpha.origin, path: alpha.path }, gamma], primary: { origin: alpha.origin, path: alpha.path } });
    assert.deepEqual(planA().entries.map(entry => entry.lane), ["a", "b", "shared", "gamma-lane"], "the joined lane keeps its end position");
    assert.equal(f.store.plan({ project: projectA.key }).version, 3, "the project edit leaves the plan version alone");
    assert.equal(editedA.version, projectA.version + 1);

    // A repair that bypasses the store still invalidates the Done band's history read.
    const row = f.store.db.prepare("SELECT data FROM project_plans WHERE project=? AND version=2").get(projectA.key) as { data: string };
    const repaired = JSON.parse(row.data) as { entries: Array<{ lane: string; note?: string }> };
    repaired.entries.find(entry => entry.lane === "gone")!.note = "restored by a repair";
    f.store.db.prepare("UPDATE project_plans SET data=? WHERE project=? AND version=2").run(JSON.stringify(repaired), projectA.key);
    assert.deepEqual(planA().done?.map(entry => [entry.lane, entry.note]), [["gone", "restored by a repair"]], "a direct row write moves the plan clock");

    // An idle plan is part of the cached read, and restarting rebuilds the same answers.
    f.store.setPlan({ project: projectA.key, version: 3, entries: [{ lane: "a", horizon: "later" }, { lane: "b", horizon: "later" }], author: "operator", idle: "Waiting on the audit rulings" });
    assert.equal(planA().idle?.reason, "Waiting on the audit rulings");
    const before = read();
    f.reopen();
    assert.deepEqual(read(), before, "a reopened store reads the same plans");
  } finally { f.close(); }
});

test("041-3/4 plan.set accepts next and doneWhen, keeps old callers working, refuses stale saves and reads closed lanes as done", () => {
  const f = setup(); try {
    f.lane("a"); f.lane("b"); f.lane("c");
    const project = f.store.projectFor(alpha.path, alpha.origin)!;
    const legacy = f.store.setPlan(planSet.input.parse({ repository: alpha.origin, version: 0, entries: [{ lane: "a" }, { lane: "b", note: "n" }], author: "agent" }));
    assert.deepEqual(legacy.entries, [{ lane: "a", note: "", horizon: "now" }, { lane: "b", note: "n", horizon: "now" }], "callers without next or doneWhen see the old shape");
    const next = f.store.setPlan(planSet.input.parse({ project: project.key, version: 1, author: "operator (board)",
      entries: [{ lane: "b", horizon: "now" }, { lane: "a", horizon: "next", doneWhen: "Parser ships" }, { lane: "c", horizon: "later" }] }));
    assert.equal(next.version, 2);
    assert.deepEqual(next.entries.map(entry => [entry.lane, entry.horizon, entry.doneWhen]), [["b", "now", undefined], ["a", "next", "Parser ships"], ["c", "later", undefined]]);
    assert.throws(() => f.store.setPlan({ project: project.key, version: 1, entries: [{ lane: "a", horizon: "now" }], author: "agent" }), /changed to version 2; reload before saving/);
    assert.equal(f.store.plan({ project: project.key }).done, undefined, "no done lanes yet");
    f.store.setLaneStatus("a", "done"); f.store.setLaneStatus("c", "abandoned");
    const read = f.store.plan({ project: project.key });
    assert.deepEqual(read.entries.map(entry => entry.lane), ["b"], "closed lanes leave the order");
    assert.deepEqual(read.done?.map(entry => [entry.lane, entry.status, entry.doneWhen]).sort(), [["a", "done", "Parser ships"], ["c", "abandoned", undefined]]);
    f.store.setPlan({ project: project.key, version: 2, entries: [{ lane: "b", horizon: "now" }], author: "agent" });
    assert.deepEqual(f.store.plan({ project: project.key }).done?.map(entry => entry.lane).sort(), ["a", "c"], "Done survives later saves");
    f.reopen();
    assert.equal(f.store.plan({ project: project.key, version: 2 }).entries[1].doneWhen, "Parser ships");
  } finally { f.close(); }
});

/**
 * The lead.board order contract: createdAt DESC, then id DESC. Leads written in
 * one millisecond tie on createdAt and then order by their random ids, so an
 * expected order derived from insertion order is nondeterministic (review of #560).
 */
const boardOrder = (...leads: Array<{ id: string; createdAt: string }>) =>
  [...leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).map(lead => lead.id);

test("boardOrder breaks createdAt ties by id DESC, as the store query does", () => {
  const at = "2026-10-20T12:00:00.000Z";
  assert.deepEqual(boardOrder({ id: "a", createdAt: at }, { id: "c", createdAt: at }, { id: "b", createdAt: "2026-10-20T12:00:00.001Z" }), ["b", "c", "a"]);
});

test("lead.board projects narrow card facts; response bytes never grow with bodies or promoted history", () => {
  const f = setup(); try {
    const small = f.leads.add({ repositories: [alpha], title: "Small", body: "Short body", lanes: [], author: "agent-1" });
    const unicode = f.leads.add({ repositories: [alpha], title: "Unicode", body: "中".repeat(500_000), lanes: [], author: "agent-1", tags: ["idea"] });
    const escapes = f.leads.add({ repositories: [alpha], title: "Escapes", body: '"\\\'\n\t'.repeat(50_000), lanes: [], author: "agent-1" });
    // Two leads whose bodies differ by 499,600 characters but whose previews both saturate;
    // their card rows must serialize to the same byte length.
    const shortPreview = f.leads.add({ repositories: [alpha], title: "Twin", body: "y".repeat(400), lanes: [], author: "agent-1" });
    const longPreview = f.leads.add({ repositories: [alpha], title: "Twin", body: "y".repeat(500_000), lanes: [], author: "agent-1" });
    // Promoted history grows continuously; knowledge targets carry no repository, so none of
    // these rows may reach the board response.
    for (let n = 0; n < 30; n++) {
      const old = f.leads.add({ repositories: [alpha], title: `Old ${n}`, body: "x".repeat(500_000), lanes: [], author: "agent-1" });
      f.leads.promote({ id: old.id, kind: "knowledge", reference: `docs/knowledge/old-${n}.md` });
    }
    const dropped = f.leads.drop({ id: small.id, reason: "Superseded" });
    assert.equal(dropped.state, "dropped");
    const board = f.store.listBoardLeads();
    assert.deepEqual(board.cards.map(card => card.id), boardOrder(longPreview, shortPreview, escapes, unicode), "newest first, one complete card set — not a first page");
    const byId = new Map(board.cards.map(card => [card.id, card]));
    assert.deepEqual(byId.get(longPreview.id), {
      id: longPreview.id, title: "Twin", preview: "y".repeat(400), repositories: [alpha], lanes: [], tags: [],
      papercutArea: null, state: "open", version: 1, check: null, approved: false, targets: [],
    });
    assert.equal(byId.get(unicode.id)!.preview, "中".repeat(400), "the preview cuts on characters, not bytes");
    assert.equal(byId.get(escapes.id)!.preview.length, 400);
    assert.ok(board.cards.every(card => !("body" in card)), "no card carries a body field");
    assert.ok(!JSON.stringify(board).includes("x".repeat(1_000)), "promoted bodies never reach the response");
    assert.ok(!JSON.stringify(board).includes("Superseded"), "dropped leads and their disposition stay out");
    assert.equal(board.links.length, 0, "promoted history is absent without open decision links");
    assert.equal(Buffer.byteLength(JSON.stringify(byId.get(shortPreview.id)!)), Buffer.byteLength(JSON.stringify(byId.get(longPreview.id)!)), "card bytes are independent of body length");
    assert.ok(Buffer.byteLength(JSON.stringify(board)) < 6 * 1024, "a fleet with megabytes of briefs answers in kilobytes");
  } finally { f.close(); }
});
