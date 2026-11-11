import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SCHEMA, Store, submissionHash } from "../core/store/store";
import { Engine } from "../core/engine";
import { Leads } from "../core/planning/leads";
import { Papercuts } from "../core/planning/papercut-operations";
import { runPrompt } from "../core/dispatch/prompts";
import { briefDigest } from "../core/planning/brief";
import { submissionSchema, boardLeadSchema, leadAdd, leadEdit, leadReopen, leadList, leadImport, papercutAdd, planSet, laneDocumentEdit, type LeadDetail, type Profile, type Run, type Submission } from "../shared/contracts";
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

test("026-3 importing a docs/triage directory makes one lead per file titled by its first heading; a rerun reports duplicates", () => {
  const f = setup(); try {
    const triage = join(f.dir, "docs", "triage");
    mkdirSync(triage, { recursive: true });
    writeFileSync(join(triage, "README.md"), "# Triage\n\nHow this folder works.\n");
    writeFileSync(join(triage, "lanes-gate.md"), "---\nowner: tom\n---\n\n# Should lanes gate dispatch?\n\nLong-form thinking.\n\n## Options\n\n- a\n- b\n");
    writeFileSync(join(triage, "board.md"), "Intro line\n\n## Board swimlanes\n\nIdea body.\n");
    writeFileSync(join(triage, "empty.md"), "no heading here\n");
    writeFileSync(join(triage, "notes.txt"), "# Not markdown\n");
    const dry = f.leads.import({ repository: alpha, path: triage, dryRun: true });
    assert.equal(dry.imported.length, 2); assert.equal(f.leads.list(leadList.input.parse({})).length, 0, "a dry run writes nothing");
    const report = f.leads.import({ repository: alpha, path: triage, dryRun: false });
    assert.deepEqual(report.imported.map(entry => entry.file.split("/").at(-1)).sort(), ["board.md", "lanes-gate.md"]);
    assert.deepEqual(report.unparsed.map(entry => entry.file.split("/").at(-1)).sort(), ["README.md", "empty.md"]);
    const leads = f.leads.list(leadList.input.parse({}));
    const gate = leads.find(lead => lead.title === "Should lanes gate dispatch?")!;
    assert.match(gate.body, /^---\nowner: tom\n---\n\nLong-form thinking\.\n\n## Options/);
    assert.equal(gate.author, "import"); assert.deepEqual(gate.repositories, [alpha]);
    assert.ok(leads.some(lead => lead.title === "Board swimlanes" && lead.body === "Intro line\n\nIdea body."));
    const rerun = f.leads.import({ repository: alpha, path: triage, dryRun: false });
    assert.deepEqual(rerun.imported, []); assert.equal(rerun.duplicate.length, 2);
    assert.equal(f.leads.list(leadList.input.parse({})).length, 2);
    const single = f.leads.import({ repository: alpha, path: join(triage, "board.md"), dryRun: false });
    assert.equal(single.duplicate.length, 1, "a single file import shares the content key");
  } finally { f.close(); }
});

test("026-4 lane document edits by agent and operator keep versions; a stale save is refused and writes nothing", () => {
  const f = setup(); try {
    f.lane("lane-a");
    assert.equal(f.store.laneDocument("lane-a"), null);
    const first = f.store.editLaneDocument({ key: "lane-a", version: 0, text: "Intent v1", author: "agent-7" });
    const second = f.store.editLaneDocument({ key: "lane-a", version: 1, text: "Intent v2", author: "operator" });
    assert.deepEqual([first.version, first.author, second.version, second.author], [1, "agent-7", 2, "operator"]);
    assert.ok(first.createdAt && second.createdAt); assert.equal(second.digest, briefDigest("Intent v2"));
    assert.throws(() => f.store.editLaneDocument({ key: "lane-a", version: 1, text: "Stale", author: "agent-7" }), /changed to version 2; reload before saving/);
    assert.throws(() => f.store.editLaneDocument({ key: "lane-a", version: 0, text: "Stale", author: "agent-7" }), /reload/);
    assert.equal(f.store.laneDocument("lane-a")!.text, "Intent v2");
    assert.equal(f.store.laneDocument("lane-a", 1)!.text, "Intent v1");
    assert.equal(f.store.laneDocument("lane-a", 3), null);
    assert.throws(() => f.store.editLaneDocument({ key: "missing", version: 0, text: "x", author: "operator" }), /Unknown lane key/);
  } finally { f.close(); }
});

test("lane edit accepts the read digest and refuses a mismatched digest without writing", () => {
  const f = setup(); try {
    f.lane("lane-a");
    const first = f.store.editLaneDocument({ key: "lane-a", version: 0, text: "First", author: "planner" });
    const edit = laneDocumentEdit.input.parse({ key: first.key, version: first.version, digest: first.digest, text: "Second", author: "planner" });
    const second = f.store.editLaneDocument(edit);
    assert.equal(second.text, "Second");
    const revision = f.store.boardRevision();
    assert.throws(() => f.store.editLaneDocument({ ...edit, version: second.version, text: "Wrong digest" }), /digest changed; reload/);
    assert.equal(f.store.boardRevision(), revision);
    assert.deepEqual(f.store.laneDocument(first.key), second);
    assert.equal(f.store.laneDocument(first.key, 3), null);
    assert.throws(() => f.store.editLaneDocument({ ...edit, digest: second.digest }), /changed to version 2/);
    assert.equal(laneDocumentEdit.input.safeParse({ ...edit, digest: "invalid" }).success, false);
    assert.equal(f.store.editLaneDocument({ key: first.key, version: second.version, text: "Legacy save", author: "planner" }).version, 3);
  } finally { f.close(); }
});

const runOf = (taskId: string, id: string, role: Run["role"]): Run => ({
  id, taskId, role, generation: 1, head: "c".repeat(40), base: "a".repeat(40), agentId: null, workspaceId: "ws", instruction: null, profile,
  status: "running", createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false,
}) as Run;

test("026-5 a linked lane document is pinned at dispatch into worker and reviewer prompts, runs and the outcome; unlinked tasks are unchanged", async () => {
  const f = setup();
  const prompts = new Map<string, string>();
  const adapter = {
    profiles: async () => [profile], validate: async (t: { planningCommit: string }) => t.planningCommit,
    createWorkspace: async (t: { id: string }) => ({ id: `ws-${t.id}`, directory: "/fixture" }),
    findWorkspaces: async () => [], verifyWorkspace: async (t: { branch: string }) => t.branch,
    createAgent: async (t: { id: string; workspaceId: string }, _token: string, prompt: string) => { prompts.set(t.id, prompt); return { id: `agent-${t.id}`, workspaceId: t.workspaceId }; },
    findAgents: async () => [],
    observe: async (id: string) => ({ id, workspaceId: "ws", status: "running", active: true, permissions: false, error: "" }),
  } as unknown as Adapter;
  const engine = new Engine(f.store, adapter, 0); engine.profiles = [profile];
  try {
    f.store.setMeta("pool", [{ profileId: profile.id, enabled: true, group: "test", weight: 1, scopes: ["general"] }]);
    f.store.setMeta("paused", false);
    f.lane("lane-a");
    const submission = (extra: Partial<Submission>) => submissionSchema.parse({ submissionId: randomUUID(), title: "Task", repoPath: alpha.path,
      planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin", ...extra });
    assert.throws(() => f.store.insert(submission({ laneDocuments: ["lane-a"] }), "host", "handoff", "a".repeat(40), {}, undefined, alpha.origin), /has no document/);
    f.store.editLaneDocument({ key: "lane-a", version: 0, text: "Lane intent at dispatch", author: "operator" });
    const linked = f.store.insert(submission({ laneDocuments: ["lane-a"] }), "host", "handoff", "a".repeat(40), {}, undefined, alpha.origin);
    const plain = f.store.insert(submission({}), "host", "handoff", "a".repeat(40), {}, undefined, alpha.origin);
    await engine.wake();
    f.store.editLaneDocument({ key: "lane-a", version: 1, text: "Edited after dispatch", author: "operator" });
    const task = f.store.task(linked.id);
    const pinned = { key: "lane-a", version: 1, digest: briefDigest("Lane intent at dispatch") };
    assert.deepEqual(task.laneDocumentPins, [{ ...pinned, text: "Lane intent at dispatch" }]);
    assert.deepEqual(task.laneDocumentRuns, [{ runId: task.runId, documents: [pinned] }]);
    assert.match(prompts.get(linked.id)!, /Lane document — context, not scope authority: lane-a version 1/);
    assert.ok(prompts.get(linked.id)!.includes("Lane intent at dispatch"));
    f.store.putRun(runOf(task.id, "review-1", "reviewer"));
    assert.deepEqual(f.store.run("review-1")!.laneDocuments, [pinned]);
    const review = runPrompt(f.store.task(linked.id), f.store.run("review-1")!, "/helper", "/ticket", true);
    assert.ok(review.includes("Lane intent at dispatch")); assert.ok(!review.includes("Edited after dispatch"));
    f.store.update(task.id, { phase: "done", reason: "Closed" });
    assert.deepEqual(f.store.outcome(task.id)!.laneDocuments, [pinned], "the later edit never changes what the run recorded");

    const plainTask = f.store.task(plain.id);
    assert.ok(!prompts.get(plain.id)!.includes("Lane document"));
    assert.equal(plainTask.laneDocumentPins, undefined); assert.equal(plainTask.laneDocumentRuns, undefined);
    f.store.putRun(runOf(plain.id, "review-2", "reviewer"));
    assert.equal(f.store.run("review-2")!.laneDocuments, undefined);
    f.store.update(plain.id, { phase: "done", reason: "Closed" });
    assert.ok(!("laneDocuments" in f.store.outcome(plain.id)!));
    // Without a link the submission identity is the materialized responsible-default
    // digest (PR 779); the frozen pre-rollout hash only reconciles replayed rows.
    const legacy = submission({});
    const inserted = f.store.insert(legacy, "host", "handoff", "a".repeat(40), {}, undefined, alpha.origin);
    assert.equal((f.store.db.prepare("SELECT input_hash FROM tasks WHERE id=?").get(inserted.id) as { input_hash: string }).input_hash, submissionHash(legacy));
  } finally { await engine.stop(); f.close(); }
});

test("026-6 project plan set, stale set, a non-listing lane and a new lane joining the end", () => {
  const f = setup(); try {
    f.lane("first"); f.lane("second"); f.lane("elsewhere", [beta]);
    const project = f.store.projectFor(alpha.path, alpha.origin)!;
    const initial = f.store.plan({ project: project.key });
    assert.equal(initial.version, 0); assert.deepEqual(initial.entries.map(entry => entry.lane), ["first", "second"], "listing lanes appear before any save");
    const saved = f.store.setPlan(planSet.input.parse({ repository: alpha.origin, version: 0, entries: [{ lane: "second", note: "Now" }, { lane: "first" }], author: "operator" }));
    assert.equal(saved.version, 1); assert.deepEqual(saved.entries, [{ lane: "second", note: "Now", horizon: "now" }, { lane: "first", note: "", horizon: "now" }]);
    assert.throws(() => f.store.setPlan({ project: project.key, version: 0, entries: [{ lane: "first", note: "" }], author: "agent" }), /changed to version 1; reload before saving/);
    assert.throws(() => f.store.setPlan({ project: project.key, version: 1, entries: [{ lane: "elsewhere", note: "" }], author: "agent" }), /does not list this repository/);
    assert.equal(f.store.plan({ project: project.key }).version, 1, "refused saves write nothing");
    f.lane("third");
    assert.deepEqual(f.store.plan({ project: project.key }).entries.map(entry => entry.lane), ["second", "first", "third"], "a new lane joins the end");
    f.store.upsertLane({ key: "elsewhere", title: "elsewhere", aim: "Aim", repositories: [beta, alpha] });
    assert.deepEqual(f.store.plan({ project: project.key }).entries.slice(0, 2).map(entry => entry.lane), ["second", "first"], "a lane gaining a member repository joins after the saved order");
    assert.ok(f.store.plan({ project: project.key }).entries.some(entry => entry.lane === "elsewhere"));
    f.store.setLaneStatus("first", "done");
    assert.deepEqual(f.store.plan({ project: project.key }).entries.map(entry => entry.lane), ["second", "elsewhere", "third"], "closed lanes leave the plan as read");
    assert.deepEqual(f.store.plan({ project: project.key, version: 1 }).entries.map(entry => entry.lane), ["second", "first"], "a saved version reads as saved");
    const next = f.store.setPlan({ project: project.key, version: 1, entries: [{ lane: "third", note: "" }, { lane: "second", note: "" }], author: "agent" });
    assert.equal(next.version, 2);
  } finally { f.close(); }
});

test("026-16 restart keeps records, versions, plans and links", () => {
  const f = setup(); try {
    f.lane("lane-a");
    const lead = f.leads.add({ repositories: [alpha], title: "Kept", body: "v1", lanes: ["lane-a"], author: "operator" });
    f.leads.edit({ id: lead.id, version: 1, body: "v2", author: "operator" });
    f.leads.promote({ id: lead.id, kind: "knowledge", reference: "docs/knowledge/kept.md" });
    const cut = f.cuts.add({ repository: alpha, title: "Cut", happened: "Friction", impact: "Time", filedBy: "operator" });
    f.cuts.setLanes({ id: cut.id, lanes: ["lane-a"] });
    f.store.editLaneDocument({ key: "lane-a", version: 0, text: "Doc", author: "operator" });
    const project = f.store.projectFor(alpha.path, alpha.origin)!;
    f.store.setPlan({ project: project.key, version: 0, entries: [{ lane: "lane-a", note: "Top" }], author: "operator" });
    const before = { lead: f.leads.get({ id: lead.id }), cut: f.cuts.get({ id: cut.id }), doc: f.store.laneDocument("lane-a"), plan: f.store.plan({ project: project.key }) };
    f.reopen();
    assert.equal(f.store.getMeta("schema"), CURRENT_SCHEMA);
    assert.deepEqual({ lead: f.leads.get({ id: lead.id }), cut: f.cuts.get({ id: cut.id }), doc: f.store.laneDocument("lane-a"), plan: f.store.plan({ project: project.key }) }, before);

  } finally { f.close(); }
});

test("plans returns every project's current plan in one call, so clients never fan out per project", async () => {
  const { QueueRuntime } = await import("../service/runtime-owner");
  const { RPC_CATALOGUE } = await import("../shared/rpc-catalogue");
  const dir = mkdtempSync(join(tmpdir(), "nsq-plans-"));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    for (const name of ["alpha", "beta", "gamma"])
      await runtime.upsertProject({ key: name, name, repositories: [{ origin: `acme/${name}`, path: `/acme/${name}` }] });
    await runtime.upsertLane({ key: "alpha-now", title: "Alpha now", aim: "Ship alpha", repositories: [{ origin: "acme/alpha", path: "/acme/alpha" }] });
    await runtime.setPlan({ project: "alpha", version: 0, entries: [{ lane: "alpha-now", note: "Saved step" }], author: "operator" });
    const all = runtime.listPlans();
    assert.deepEqual(all.map(plan => plan.project).sort(), ["alpha", "beta", "gamma"]);
    for (const plan of all) {
      const { savedEntries, ...current } = plan;
      assert.deepEqual(current, runtime.getPlan({ project: plan.project }));
      assert.deepEqual(savedEntries, plan.version ? runtime.getPlan({ project: plan.project, version: plan.version }).entries : []);
    }
    assert.deepEqual(all.find(plan => plan.project === "alpha")?.savedEntries, [{ lane: "alpha-now", note: "Saved step", horizon: "now" }]);
    // One batched read carries current lane projections and immutable saved membership
    // used by Planning rows; clients do not need one plan.get request per project.
    assert.equal(RPC_CATALOGUE.find(entry => entry.name === "plans")?.method, "listPlans");
  } finally { await runtime.stop?.(); rmSync(dir, { recursive: true, force: true }); }
});

/**
 * The plans read is cached (audit A2): one project read and one lane read per call, and
 * the Done band reused until a plan write or a lane change. Each assertion below changes
 * exactly one of those inputs and then reads through `plan.get` and `plans`, so a cache
 * that missed an invalidation or served another version's facts fails here.
 */
