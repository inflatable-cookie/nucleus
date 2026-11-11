import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA, Store, digest } from "../core/store/store";
import { Papercuts } from "../core/planning/papercut-operations";
import { Leads } from "../core/planning/leads";
import { papercutEdit, projectSchema, submissionSchema } from "../shared/contracts";
import { scopeContains } from "../shared/project-scope";

const repo = { origin: "owner/papercuts-fixture", path: "/tmp/papercuts-fixture" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "queue-papercuts-"));
  let store = new Store(join(dir, "queue.sqlite"));
  let cuts = new Papercuts(store);
  return { dir, get store() { return store; }, get cuts() { return cuts; }, reopen() { store.close(); store = new Store(join(dir, "queue.sqlite")); cuts = new Papercuts(store); }, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("024-1 add get list state default and promotion leaves open list", () => {
  const f = setup(); try {
    const added = f.cuts.add({ repository: repo, title: "Friction", happened: "Tool failed", impact: "Wait", filedBy: "operator" });
    assert.deepEqual(f.cuts.get({ id: added.id }), added);
    assert.deepEqual(f.cuts.list({ repository: repo.origin }), [added]);
    assert.deepEqual(f.cuts.list({ state: "closed" }), []);
  } finally { f.close(); }
});
test("papercut.edit versions its fields and preserves tag, lanes, promotion and closure", () => {
  const f = setup(); try {
    f.store.upsertLane({ key: "lane-a", title: "Lane A", aim: "Keep the record", repositories: [repo] });
    const added = f.cuts.add({ repository: repo, area: "cli", title: "Original", happened: "Original happened", impact: "Original impact", fix: "Original fix", filedBy: "operator" });
    f.cuts.setLanes({ id: added.id, lanes: ["lane-a"] });
    const task = f.store.insert(submissionSchema.parse({ submissionId: "papercut-edit-task", title: "Fix papercut", repoPath: repo.path,
      planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40), {}, undefined, repo.origin);
    const promoted = f.cuts.promote({ id: added.id, taskId: task.id });
    assert.equal(promoted.version, 1);
    const edited = f.cuts.edit({ id: added.id, version: promoted.version, title: "Corrected", area: "", happened: "Corrected happened", impact: "More impact", fix: "", author: "operator (board)" });
    assert.deepEqual([edited.version, edited.title, edited.area, edited.happened, edited.impact, edited.fix], [2, "Corrected", null, "Corrected happened", "More impact", null]);
    assert.equal(edited.state, "promoted"); assert.equal(edited.taskId, task.id); assert.deepEqual(edited.lanes, ["lane-a"]);
    const lead = f.store.lead(added.id);
    assert.deepEqual(lead.tags, ["papercut"]); assert.equal(lead.state, "promoted"); assert.equal(lead.targets[0].reference, task.id);
    const versions = f.store.leadVersions(added.id);
    assert.deepEqual(versions.map(version => [version.version, version.title, version.author]), [[1, "Original", "operator"], [2, "Corrected", "operator (board)"]]);
    assert.match(versions[0].body, /Area\n\ncli/); assert.match(versions[0].body, /Original happened/);
    assert.match(versions[1].body, /Corrected happened/); assert.match(versions[1].body, /More impact/);
    assert.throws(() => f.cuts.edit({ id: added.id, version: 1, happened: "Stale" }), /changed to version 2; reload before saving/);
    assert.equal(f.cuts.get({ id: added.id }).happened, "Corrected happened", "the stale edit writes nothing");

    const closed = f.cuts.close({ id: added.id, reason: "completed", note: "Resolved" });
    const editedClosed = f.cuts.edit({ id: added.id, version: closed.version, impact: "Updated after closure" });
    assert.equal(editedClosed.version, 3); assert.equal(editedClosed.state, "closed"); assert.equal(editedClosed.closedReason, "completed");
    assert.equal(editedClosed.note, "Resolved"); assert.equal(editedClosed.taskId, task.id); assert.deepEqual(editedClosed.lanes, ["lane-a"]);
    assert.throws(() => new Leads(f.store).edit({ id: added.id, version: 3, title: "Lead path", author: "operator" }), /Use the papercut interface for papercut fields/);
    assert.equal(papercutEdit.input.parse({ id: added.id, version: 3 }).author, "operator");
    assert.throws(() => papercutEdit.input.parse({ id: added.id, version: 3, title: " " }), /Too small/);
  } finally { f.close(); }
});
test("024-2 promote by task id and repo reference", () => {
  const f = setup(); try {
    const task = f.store.insert(submissionSchema.parse({ submissionId: "papercut-task", title: "Fix", repoPath: repo.path, planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40), {}, undefined, repo.origin);
    for (const target of [{ taskId: task.id }, { reference: task.reference! }]) {
      const cut = f.cuts.add({ repository: repo, title: "Friction", happened: "Tool failed", impact: "Time", filedBy: "operator" });
      const promoted = f.cuts.promote({ id: cut.id, ...target });
      assert.equal(promoted.taskId, task.id); assert.equal(promoted.state, "promoted");
      assert.equal(f.store.task(task.id).papercutTask, true);
      f.reopen(); assert.equal(f.store.task(task.id).papercutTask, true, "the linked source class survives restart");
    }
    assert.equal(f.cuts.list({}).length, 0); assert.equal(f.cuts.list({ state: "promoted" }).length, 2);
  } finally { f.close(); }
});
test("024-3 close completed and deprecated with note and time", () => {
  const f = setup(); try {
    for (const reason of ["completed", "deprecated"] as const) {
      const added = f.cuts.add({ repository: repo, title: reason, happened: "Issue", impact: "Time", filedBy: "operator" });
      const closed = f.cuts.close({ id: added.id, reason, note: "Reviewed" });
      assert.equal(closed.closedReason, reason); assert.equal(closed.note, "Reviewed"); assert.ok(closed.closedAt);
    }
    assert.equal(f.cuts.list({}).length, 0); assert.equal(f.cuts.list({ state: "closed" }).length, 2);
  } finally { f.close(); }
});
test("024-11 migration and restart retain papercuts", () => {
  const f = setup(); try {
    const cut = f.cuts.add({ repository: repo, title: "Retained", happened: "Friction", impact: "Time", filedBy: "operator" });
    f.reopen(); assert.equal(f.store.getMeta("schema"), CURRENT_SCHEMA); assert.deepEqual(f.cuts.get({ id: cut.id }), cut);
  } finally { f.close(); }
});
test("papercut lead promotion pins its dispatch class without changing the planning source", () => {
  const f = setup(); try {
    const cut = f.cuts.add({ repository: repo, title: "Fix friction", happened: "Wait", impact: "Time", filedBy: "operator" });
    const lead = f.store.lead(cut.id);
    const approvedDigest = `sha256:${digest(lead.body)}` as const;
    const checked = f.store.updateLead({ ...lead,
      check: { ok: true, message: "Ready", checkedAt: lead.createdAt, planningCommit: "a".repeat(40), baseBranch: "main" },
      approval: { version: lead.version, digest: approvedDigest, approver: "operator", approvedAt: lead.createdAt, note: "Approved", relayed: false,
        baseBranch: "main", planningCommit: "a".repeat(40) } });
    const input = submissionSchema.parse({ submissionId: "promoted-cut", title: lead.title, repoPath: repo.path,
      planningCommit: "a".repeat(40), brief: {text: lead.body}, originAgentId: "origin", planningSource: { kind: "lead", id: lead.id },
      leadProvenance: {version: lead.version, approval: checked.approval!, earlierDigests: []} });
    const task = f.store.promoteSource({ kind: "lead", id: lead.id }, repo.origin, approvedDigest,
      digest(JSON.stringify(checked)), input, "host", "a".repeat(40), repo.origin);
    assert.ok("id" in task);
    assert.equal(task.papercutTask, true);
    assert.deepEqual(task.planningSource, input.planningSource);
    f.reopen();
    assert.equal(f.store.task(task.id).papercutTask, true);
  } finally { f.close(); }
});

test("a papercut lead keeps its source class through review entry", () => {
  const f = setup(); try {
    const cut = f.cuts.add({ repository: repo, title: "Fix review", happened: "Wait", impact: "Time", filedBy: "operator" });
    const lead = f.store.lead(cut.id), approvedDigest = `sha256:${digest(lead.body)}` as const;
    const checked = f.store.updateLead({ ...lead, digest: approvedDigest,
      check: { ok: true, message: "Ready", checkedAt: lead.createdAt, planningCommit: "a".repeat(40), baseBranch: "main" },
      approval: { version: lead.version, digest: approvedDigest, approver: "operator", approvedAt: lead.createdAt, note: "Approved", relayed: false,
        baseBranch: "main", planningCommit: "a".repeat(40) } });
    const input = submissionSchema.parse({ submissionId: "review-cut", title: lead.title, repoPath: repo.path, baseBranch: "main",
      planningCommit: "a".repeat(40), handoffPath: "", originAgentId: "origin", planningSource: { kind: "lead", id: lead.id },
      brief: { text: lead.body, mediaType: "text/markdown" }, leadProvenance: { version: lead.version, approval: checked.approval!, earlierDigests: [] } });
    const task = f.store.transaction(() => {
      const admitted = f.store.insert(input, "host", lead.body, "a".repeat(40), {}, undefined, repo.origin);
      f.store.claimReviewEntryBrief(input, "owner/papercuts-fixture", admitted.id);
      return f.store.task(admitted.id);
    });
    assert.equal(task.papercutTask, true);
    assert.equal(f.store.lead(cut.id).targets[0]?.reference, task.id);
    f.reopen(); assert.equal(f.store.task(task.id).papercutTask, true);
  } finally { f.close(); }
});

test("a draft approval record never authorizes review entry", () => {
  const f = setup(); try {
    const cut = f.cuts.add({ repository: repo, title: "Fix review", happened: "Wait", impact: "Time", filedBy: "operator" });
    const source = { kind: "lead" as const, id: cut.id }, text = "Approved bounded fixture scope", stamp = new Date().toISOString();
    const briefDigest = `sha256:${digest(text)}` as const;
    const approval = { version: 1, digest: briefDigest, approver: "operator", approvedAt: stamp, note: "Approved", relayed: false };
    const provenance = { version: 1, approval, earlierDigests: [] };
    const input = (extra: object) => submissionSchema.parse({ submissionId: "draft-review", title: "Fix", repoPath: repo.path, baseBranch: "main",
      planningCommit: "a".repeat(40), handoffPath: "", originAgentId: "origin", planningSource: source,
      brief: { text, mediaType: "text/markdown" }, draftProvenance: { id: "draft-review", ...provenance }, ...extra });
    assert.throws(() => f.store.validateReviewEntryBrief(input({}), "owner/papercuts-fixture"), /draft approval, check or planning identity changed/);
    assert.throws(() => f.store.validateReviewEntryBrief(input({ leadProvenance: provenance }), "owner/papercuts-fixture"), /conflicting approval records/);
  } finally { f.close(); }
});
