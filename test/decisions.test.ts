import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { Decisions, decisionHeadline, decisionNoticeId } from "../core/planning/decisions";
import { Leads } from "../core/planning/leads";
import { Papercuts } from "../core/planning/papercut-operations";
import { decisionAnswer, decisionAdd, decisionLink, decisionSchema, decisionSupersede, submissionSchema } from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host";

/** Spec 032: record, methods, version guard, relayed answers, delivery and staleness. */
const project = { origin: "owner/decisions", path: "/fixture/decisions" };
const commit = "a".repeat(40);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ns-decisions-"));
  const store = new Store(join(dir, "queue.sqlite"));
  return {
    dir, store, decisions: new Decisions(store), leads: new Leads(store), cuts: new Papercuts(store),
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const add = (f: ReturnType<typeof setup>, input: Record<string, unknown> = {}) =>
  f.decisions.add({ question: "Which branch do we cut?", askedBy: "agent-asker", project, ...input });

test("032-1 add, get and list carry the record and filter by status, asker, project and links", () => {
  const f = setup(); try {
    const one = add(f);
    assert.equal(one.status, "open"); assert.equal(one.version, 1);
    assert.equal(one.askedBy.agentId, "agent-asker"); assert.deepEqual(one.askedBy.project, project);
    assert.deepEqual(one.versions.map(version => version.version), [1]);
    const reread = f.decisions.get({ id: one.id });
    assert.equal(reread.id, one.id);
    assert.equal(reread.headline, one.headline);
    assert.deepEqual(reread.links, one.links);
    assert.deepEqual(reread.choices, one.choices);

    const linked = add(f, { question: "Follow the lead?", askedBy: "agent-other", tasks: ["task-1"], leads: ["lead-1"], papercuts: ["cut-1"] });
    assert.deepEqual(f.decisions.list({ status: "open" }).map(d => d.id).sort(), [one.id, linked.id].sort());
    assert.deepEqual(f.decisions.list({ asker: "agent-other" }).map(d => d.id), [linked.id]);
    assert.deepEqual(f.decisions.list({ project: "/fixture/decisions" }).map(d => d.id).sort(), [one.id, linked.id].sort());
    assert.deepEqual(f.decisions.list({ task: "task-1" }).map(d => d.id), [linked.id]);
    assert.deepEqual(f.decisions.list({ lead: "lead-1" }).map(d => d.id), [linked.id]);
    assert.deepEqual(f.decisions.list({ papercut: "cut-1" }).map(d => d.id), [linked.id]);
    assert.deepEqual(f.decisions.list({ status: "answered" }), []);
  } finally { f.close(); }
});

test("032-1a the compact decision schema requires two or three choices and a recommended label", () => {
  const parsed = decisionAdd.input.parse({ question: "Which route?", headline: "Which route should we take?", askedBy: "agent",
    choices: [{ label: "Keep", consequence: "No migration." }, { label: "Change", consequence: "Migrate now." }], recommended: "Keep", details: "Full context with evidence." });
  assert.equal(parsed.headline, "Which route should we take?");
  assert.equal(parsed.choices?.length, 2);
  assert.equal(parsed.recommended, "Keep");
  assert.equal(parsed.details, "Full context with evidence.");
  assert.throws(() => decisionAdd.input.parse({ question: "q", askedBy: "agent", choices: [{ label: "Only", consequence: "One option." }] }), />=2/);
  assert.throws(() => decisionAdd.input.parse({ question: "q", askedBy: "agent", choices: [{ label: "A", consequence: "a" }, { label: "B", consequence: "b" }], recommended: "C" }), /match one choice/);
  const f = setup(); try {
    // Tom, 2026-11-13, with the planner ruling: the headline is the question
    // from its start up to the first `?`; a preceding statement stays in.
    const fallback = add(f, { question: "The setup is unclear. Should we keep the API?" });
    assert.equal(fallback.headline, "The setup is unclear. Should we keep the API?");
    assert.equal(fallback.choices?.length, 2);
    assert.equal(fallback.recommended, fallback.choices?.[0]?.label);
    assert.equal(decisionHeadline("First clause. Should Queue run the qualification?", "effigy#538"),
      "effigy#538 · First clause. Should Queue run the qualification?");
    assert.equal(decisionHeadline(`Should Queue run ${"a very long named qualification ".repeat(8)}?`, "effigy#538").endsWith("…"), true);
    assert.equal(decisionHeadline(`Should Queue run ${"a very long named qualification ".repeat(8)}?`, "effigy#538").length <= 140, true);
    const legacyQuestion = `The context is long. Should we keep ${"this branch ".repeat(20)}?`;
    const legacy = add(f, { question: legacyQuestion });
    f.store.updateDecision({ ...f.store.decision(legacy.id), headline: legacyQuestion.slice(0, 140),
      choices: [{ label: "Approve", consequence: "Accept the proposed direction." },
        { label: "Decline", consequence: "Keep the current direction." },
        { label: "Answer in my own words", consequence: "Give a different direction." }], recommended: "Approve" });
    const repaired = f.decisions.get({ id: legacy.id });
    assert.equal(repaired.headline, decisionHeadline(legacyQuestion));
    assert.match(repaired.headline ?? "", /^The context is long\. Should we keep this branch/);
    assert.match(repaired.headline ?? "", /…$/);
    assert.equal(repaired.choices?.length, 2, "legacy free-text decisions get concrete planning choices");
  } finally { f.close(); }
});

test("1183 a headline never starts mid-text: the question up to the first question mark wins", () => {
  const f = setup(); try {
    const question = "Sign off the video toolkit component inventory (tools/acowtancy-video-deck/docs/component-inventory.md, merged in PR 1236) so the refactor can be briefed?";
    const created = add(f, { question });
    assert.ok(created.headline!.startsWith("Sign off the video toolkit component inventory"),
      `the headline starts at the question start, not mid-path: ${created.headline}`);
    assert.doesNotMatch(created.headline ?? "", /^md,/);
    assert.equal(decisionHeadline("Upgrade the runtime to 7.0.0 for the worker fleet?", null),
      "Upgrade the runtime to 7.0.0 for the worker fleet?", "dots inside a version never matter");
    assert.equal(decisionHeadline("Rename docs/handbook.md to the new layout?", null),
      "Rename docs/handbook.md to the new layout?", "dots inside a file name never matter");
    assert.equal(decisionHeadline("Use e.g. three examples. Should we proceed?", null),
      "Use e.g. three examples. Should we proceed?", "abbreviations never split the headline");
    assert.equal(decisionHeadline("Pick one format, i.e. the stable one. Which is it?", null),
      "Pick one format, i.e. the stable one. Which is it?");
    assert.equal(decisionHeadline("Should we keep A? Or switch to B?", null), "Should we keep A?",
      "with two questions, the first one wins");
    assert.equal(decisionHeadline("The options are red, blue, etc. Which should we choose?", null),
      "The options are red, blue, etc. Which should we choose?", "a preceding statement sentence stays in the headline");
    // An existing mid-sentence headline refreshes on read from the stored question, which never changes.
    const broken = "md, merged in PR 1236) so the refactor can be briefed?";
    f.store.updateDecision({ ...f.store.decision(created.id), headline: broken });
    const reread = f.decisions.get({ id: created.id });
    assert.ok(reread.headline!.startsWith("Sign off the video toolkit component inventory"));
    assert.equal(f.store.decision(created.id).headline, broken, "the read never rewrites the stored row");
    assert.equal(f.store.decision(created.id).question, question, "the stored question never changes");
  } finally { f.close(); }
});

test("032-1b exact overtakes references mark an open decision probably overtaken and can be withdrawn", () => {
  const f = setup(); try {
    const settled = add(f, { question: "Should this API remain public?", headline: "Keep the API public?" });
    const ruling = add(f, { question: "Should the API become private?", headline: "Make the API private?" });
    const answered = f.decisions.answer({ id: ruling.id, version: 1, answer: "Make it private.", answeredBy: "operator (board)", relayed: false, note: "", overtakes: [settled.id] });
    assert.deepEqual(answered.answer?.overtakes, [settled.id]);
    const flagged = f.decisions.get({ id: settled.id });
    assert.equal(flagged.overtakenBy?.[0]?.kind, "decision_answer");
    assert.equal(flagged.overtakenBy?.[0]?.id, ruling.id);
    const withdrawn = f.decisions.withdraw({ id: settled.id, version: flagged.version, reason: `Withdrawn after ${flagged.overtakenBy![0]!.label}`, withdrawnBy: "operator (board)" });
    assert.equal(withdrawn.status, "withdrawn");
    assert.throws(() => f.decisions.answer({ id: settled.id, version: 2, answer: "x", answeredBy: "operator (board)", relayed: false, note: "", overtakes: [settled.id] }), /only an open decision/);

    const repeated = add(f, { question: "Does the older option still apply?" });
    f.decisions.markOvertaken(repeated.id, { kind: "planner_answer", id: "task-1", sourceId: "ask-1", label: "First ruling", at: "2026-11-02T10:00:00Z" });
    f.decisions.markOvertaken(repeated.id, { kind: "planner_answer", id: "task-1", sourceId: "ask-2", label: "Later ruling", at: "2026-11-02T11:00:00Z" });
    assert.deepEqual(f.decisions.get({ id: repeated.id }).overtakenBy?.map(reference => reference.sourceId), ["ask-1", "ask-2"],
      "two exact rulings from one task retain separate links");
  } finally { f.close(); }
});

test("032-2 a stale version is refused by answer, withdraw and supersede", () => {
  const f = setup(); try {
    const decision = add(f);
    f.decisions.answer({ id: decision.id, version: 1, answer: "Cut from main.", answeredBy: "operator (board)", relayed: false, note: "" });
    assert.equal(f.decisions.get({ id: decision.id }).version, 2);
    assert.throws(() => f.decisions.answer({ id: decision.id, version: 1, answer: "Again", answeredBy: "operator (board)", relayed: false, note: "" }), /version 2/);
    assert.throws(() => f.decisions.answer({ id: decision.id, version: 2, answer: "Again", answeredBy: "operator (board)", relayed: false, note: "" }), /only an open decision/);

    const open = add(f, { question: "Withdraw me" });
    f.decisions.answer({ id: open.id, version: 1, answer: "Answered", answeredBy: "operator (board)", relayed: false, note: "" });
    assert.throws(() => f.decisions.withdraw({ id: open.id, version: 1, reason: "stale", withdrawnBy: "agent-asker" }), /version 2/);

    const third = add(f, { question: "Supersede me" });
    f.decisions.withdraw({ id: third.id, version: 1, reason: "Overtaken", withdrawnBy: "agent-asker" });
    assert.throws(() => f.decisions.supersede({ id: third.id, version: 1, by: "agent-asker", question: "New" }), /version 2/);
  } finally { f.close(); }
});

test("032-3 relayed answers name the relaying agent, quote the operator and need an authorization note", () => {
  const f = setup(); try {
    const operatorOnly = add(f);
    assert.throws(() => f.decisions.answer({ id: operatorOnly.id, version: 1, answer: "Cut", answeredBy: "agent-relay", relayed: false, note: "" }), /Only the operator/);
    assert.throws(() => f.decisions.answer({ id: operatorOnly.id, version: 1, answer: "Cut", answeredBy: "operator (board)", relayed: true, note: "operator said so" }), /relaying agent/);
    assert.throws(() => f.decisions.answer({ id: operatorOnly.id, version: 1, answer: "Cut", answeredBy: "agent-relay", relayed: true, note: "  " }), /authorization/);
    const relayed = f.decisions.answer({ id: operatorOnly.id, version: 1, answer: "Cut from main.", answeredBy: "agent-relay", relayed: true, note: "Tom: cut from main" });
    assert.equal(relayed.answer?.text, "Cut from main."); assert.equal(relayed.answer?.relayed, "agent-relay");
    assert.equal(relayed.answer?.note, "Tom: cut from main"); assert.equal(relayed.answer?.answeredBy, "agent-relay");
    // The CLI route forces a relay; the board records operator authority directly.
    assert.equal(decisionAnswer.input.parse({ id: "x", version: 1, answer: "y", answeredBy: "agent" }).relayed, true);
    assert.equal(decisionAnswer.input.parse({ id: "x", version: 1, answer: "y", answeredBy: "operator (board)", relayed: false }).relayed, false);
  } finally { f.close(); }
});

test("032-4 withdraw records the reason and only an open decision changes", () => {
  const f = setup(); try {
    const decision = add(f);
    const withdrawn = f.decisions.withdraw({ id: decision.id, version: 1, reason: "Overtaken by the spec", withdrawnBy: "operator" });
    assert.equal(withdrawn.status, "withdrawn"); assert.equal(withdrawn.version, 2);
    assert.equal(withdrawn.withdrawal?.reason, "Overtaken by the spec");
    assert.deepEqual(withdrawn.versions.map(v => v.status), ["open", "withdrawn"]);
    assert.throws(() => f.decisions.withdraw({ id: decision.id, version: 2, reason: "Again", withdrawnBy: "operator" }), /only an open decision/);
  } finally { f.close(); }
});

test("032-5 supersede replaces an open decision with a new one in one step", () => {
  const f = setup(); try {
    const original = add(f, { question: "Old question", options: ["A", "B"], recommendation: "A" });
    const replacement = f.decisions.supersede({ id: original.id, version: 1, by: "agent-asker", question: "New question", recommendation: "B" });
    assert.equal(replacement.status, "open"); assert.equal(replacement.version, 1);
    assert.equal(replacement.question, "New question"); assert.deepEqual(replacement.options, ["A", "B"]);
    assert.equal(replacement.askedBy.agentId, "agent-asker");
    const old = f.decisions.get({ id: original.id });
    assert.equal(old.status, "superseded"); assert.equal(old.supersededBy, replacement.id); assert.equal(old.version, 2);
    assert.deepEqual(old.versions.map(v => v.status), ["open", "superseded"]);
    assert.throws(() => f.decisions.supersede({ id: original.id, version: 2, by: "agent-asker", question: "Third" }), /only an open decision/);
    const parsed = decisionSupersede.input.parse({ id: "x", version: 1, question: "q" });
    assert.equal(parsed.by, "operator");
    assert.deepEqual(decisionAdd.input.parse({ question: "q", askedBy: "a" }), { question: "q", context: null, options: [], recommendation: null, askedBy: "a", project: null, tasks: [], leads: [], papercuts: [] });
  } finally { f.close(); }
});

test("032-10 link adds links to an open decision in place, without superseding it or changing its id", () => {
  const f = setup(); try {
    const decision = add(f, { question: "Link me", tasks: ["task-a"], leads: ["lead-a"] });
    const linked = f.decisions.link({ id: decision.id, version: 1, tasks: ["task-b"], papercuts: ["cut-a"], by: "agent-linker" });
    assert.equal(linked.id, decision.id, "the id never changes");
    assert.equal(linked.status, "open"); assert.equal(linked.version, 2); assert.equal(linked.supersededBy, null);
    assert.deepEqual(linked.links, { tasks: ["task-a", "task-b"], leads: ["lead-a"], papercuts: ["cut-a"] });
    assert.deepEqual(linked.versions.map(version => version.version), [1, 2]);
    assert.deepEqual(linked.versions[1].links, { tasks: ["task-a", "task-b"], leads: ["lead-a"], papercuts: ["cut-a"] },
      "the history entry records the new links");
    assert.equal(linked.versions[1].by, "agent-linker");
    assert.deepEqual(f.decisions.list({ task: "task-b" }).map(item => item.id), [decision.id]);

    // Already-linked entries are not repeated, and a call that adds nothing writes no version.
    const repeat = f.decisions.link({ id: decision.id, version: 2, tasks: ["task-b"], leads: ["lead-a"] });
    assert.equal(repeat.version, 2); assert.deepEqual(repeat.versions.map(version => version.version), [1, 2]);

    assert.throws(() => f.decisions.link({ id: decision.id, version: 1, tasks: ["task-c"] }), /version 2/);
    const parsed = decisionLink.input.parse({ id: "x", version: 1, tasks: ["t"] });
    assert.equal(parsed.by, "operator"); assert.deepEqual(parsed.tasks, ["t"]);

    const closed = add(f, { question: "Answered" });
    f.decisions.answer({ id: closed.id, version: 1, answer: "Done", answeredBy: "operator (board)", relayed: false, note: "" });
    assert.throws(() => f.decisions.link({ id: closed.id, version: 2, tasks: ["task-z"] }), /only an open decision/);
  } finally { f.close(); }
});

test("032-11 a legacy version snapshot reads as unknown and is never filled from the current record", () => {
  const f = setup(); try {
    // A snapshot written before links were recorded: `links` is absent, so it must not read as empty.
    const legacy = decisionSchema.parse({
      id: "legacy-decision", version: 1, question: "Old question", context: null, options: [], recommendation: null,
      askedBy: { agentId: "agent-asker", project }, links: { tasks: ["task-a"], leads: ["lead-a"], papercuts: [] },
      status: "open", answer: null, withdrawal: null, supersededBy: null, delivery: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      versions: [{ version: 1, question: "Old question", context: null, options: [], recommendation: null, status: "open",
        answer: null, withdrawal: null, supersededBy: null, by: "agent-asker", at: "2026-01-01T00:00:00.000Z" }],
    });
    f.store.addDecision(legacy);
    assert.equal(f.decisions.get({ id: legacy.id }).versions[0].links, null, "an unrecorded snapshot is unknown, not empty links");
    const linked = f.decisions.link({ id: legacy.id, version: 1, tasks: ["task-b"] });
    assert.deepEqual(linked.versions.map(version => version.version), [1, 2]);
    assert.equal(linked.versions[0].links, null, "the pre-link snapshot stays unknown; it is never filled from the current record");
    assert.deepEqual(linked.versions[1].links, { tasks: ["task-a", "task-b"], leads: ["lead-a"], papercuts: [] });

    // Answering a legacy decision records its own snapshot and leaves the unknown one alone.
    const answered = decisionSchema.parse({ ...legacy, id: "legacy-answered", versions: [legacy.versions[0]] });
    f.store.addDecision(answered);
    const done = f.decisions.answer({ id: answered.id, version: 1, answer: "Yes", answeredBy: "operator (board)", relayed: false, note: "" });
    assert.equal(done.versions[0].links, null);
    assert.deepEqual(done.versions[1].links, { tasks: ["task-a"], leads: ["lead-a"], papercuts: [] });
  } finally { f.close(); }
});

test("032-6 staleness follows every link and never closes the decision", () => {
  const f = setup(); try {
    const live = f.store.insert(submissionSchema.parse({ submissionId: "live", title: "Live", repoPath: project.path, planningCommit: commit, handoffPath: "h.md", originAgentId: "origin" }), "host", "h", commit, {}, undefined, project.origin);
    const terminal = f.store.insert(submissionSchema.parse({ submissionId: "terminal", title: "Terminal", repoPath: project.path, planningCommit: commit, handoffPath: "h.md", originAgentId: "origin" }), "host", "h", commit, {}, undefined, project.origin);
    f.store.update(terminal.id, { phase: "done" });
    const lead = f.leads.add({ repositories: [project], title: "A lead", body: "", lanes: [], author: "agent" });
    const droppedLead = f.leads.add({ repositories: [project], title: "Dropped lead", body: "", lanes: [], author: "agent" });
    f.leads.drop({ id: droppedLead.id, reason: "Overtaken" });
    const cut = f.cuts.add({ repository: project, title: "A papercut", happened: "x", impact: "y", filedBy: "agent" });
    const closedCut = f.cuts.add({ repository: project, title: "Closed papercut", happened: "x", impact: "y", filedBy: "agent" });
    f.cuts.close({ id: closedCut.id, reason: "completed", note: "" });

    const open = add(f, { question: "Unlinked", });
    assert.equal(open.stale, false, "an unlinked decision is never stale");
    const terminalOnly = add(f, { question: "All terminal", tasks: [terminal.id], leads: [droppedLead.id], papercuts: [closedCut.id] });
    assert.equal(terminalOnly.stale, true);
    assert.equal(f.decisions.get({ id: terminalOnly.id }).status, "open", "staleness never closes the decision");
    assert.equal(add(f, { question: "Live task", tasks: [live.id] }).stale, false);
    assert.equal(add(f, { question: "Open lead", leads: [lead.id] }).stale, false);
    assert.equal(add(f, { question: "Open papercut", papercuts: [cut.id] }).stale, false);
    assert.equal(add(f, { question: "Purged task", tasks: ["purged-task-id"] }).stale, true);
  } finally { f.close(); }
});

function deliveryFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-decision-delivery-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const state: AgentObservation = { id: "agent-asker", workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" };
  const delivered: { agentId: string; messageId: string; text: string }[] = [];
  let fail = false;
  const adapter = {
    profiles: async () => [], observe: async () => state,
    notify: async (agentId: string, messageId: string, text: string) => { if (fail) throw new Error("transport down"); delivered.push({ agentId, messageId, text }); },
  } as unknown as Adapter & { notify(agentId: string, messageId: string, text: string): Promise<void> };
  const engine = new Engine(store, adapter);
  engine.identifyOriginHost = async () => 'host';
  store.setMeta("paused", false);
  store.setMeta("quiet", true);
  const decisions = new Decisions(store);
  return { dir, store, engine, decisions, delivered, state, setFail(value: boolean) { fail = value; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("032-7 answering sends one durable notice per version and a failure retries without losing the answer", async () => {
  const f = deliveryFixture(); try {
    const decision = f.decisions.add({ question: "Ship it?", askedBy: "agent-asker", project });
    f.setFail(true);
    const answered = f.decisions.answer({ id: decision.id, version: 1, answer: "Yes, ship it.", answeredBy: "operator (board)", relayed: false, note: "" });
    assert.equal(answered.delivery?.status, "pending");
    assert.equal(answered.delivery?.noticeId, decisionNoticeId(decision.id, 2));

    await f.engine.resolution.deliverDecisionNotices();
    assert.equal(f.delivered.length, 0, "a failed delivery sends nothing");
    assert.equal(f.decisions.get({ id: decision.id }).delivery?.status, "uncertain");
    assert.equal(f.decisions.get({ id: decision.id }).answer?.text, "Yes, ship it.", "the answer stays listable");
    assert.deepEqual(f.decisions.list({ status: "answered" }).map(d => d.id), [decision.id]);

    f.setFail(false);
    await f.engine.resolution.deliverDecisionNotices();
    assert.equal(f.delivered.length, 1);
    assert.equal(f.delivered[0].agentId, "agent-asker");
    assert.equal(f.delivered[0].messageId, decisionNoticeId(decision.id, 2));
    assert.match(f.delivered[0].text, /Yes, ship it\./);
    assert.equal(f.decisions.get({ id: decision.id }).delivery?.status, "delivered");

    await f.engine.resolution.deliverDecisionNotices();
    await f.engine.resolution.deliverDecisionNotices();
    assert.equal(f.delivered.length, 1, "delivery is deduplicated per decision version");
  } finally { f.close(); }
});

test("032-9 an answer relayed by the asker itself sends no notice back to its own thread", async () => {
  // Tom, 2026-09-29: the asking Chatterbox recording Tom's answer got a notice of that same answer.
  const f = deliveryFixture(); try {
    const own = f.decisions.add({ question: "Ship it?", askedBy: "agent-asker", project });
    const answered = f.decisions.answer({ id: own.id, version: 1, answer: "Yes, ship it.", answeredBy: "agent-asker", relayed: true, note: "Tom: ship it" });
    assert.equal(answered.status, "answered");
    assert.equal(answered.delivery, null);
    const other = f.decisions.add({ question: "Cut from main?", askedBy: "agent-asker", project });
    f.decisions.answer({ id: other.id, version: 1, answer: "Yes.", answeredBy: "agent-relay", relayed: true, note: "Tom: yes" });
    await f.engine.resolution.deliverDecisionNotices();
    assert.deepEqual(f.delivered.map(d => d.messageId), [decisionNoticeId(other.id, 2)], "only an answer relayed by someone else is delivered");
  } finally { f.close(); }
});

test("032-8 delivery waits while the asking agent is busy and pauses with the queue", async () => {
  const f = deliveryFixture(); try {
    const decision = f.decisions.add({ question: "Ready?", askedBy: "agent-asker", project });
    f.decisions.answer({ id: decision.id, version: 1, answer: "Go.", answeredBy: "operator (board)", relayed: false, note: "" });
    f.state.active = true; f.state.status = "running";
    await f.engine.resolution.deliverDecisionNotices();
    assert.equal(f.delivered.length, 0);
    assert.match(f.decisions.get({ id: decision.id }).delivery?.error ?? "", /finish/);
    f.state.active = false; f.state.status = "idle";
    f.store.setMeta("paused", true);
    await f.engine.resolution.deliverDecisionNotices();
    assert.equal(f.delivered.length, 0, "a paused queue delivers nothing");
    f.store.setMeta("paused", false);
    await f.engine.resolution.deliverDecisionNotices();
    assert.equal(f.delivered.length, 1);
  } finally { f.close(); }
});

test("032-9 a decision view names its Queue project, and agent-projects maps a thread by its task, else by its working directory", () => {
  const f = setup(); try {
    const task = f.store.insert(submissionSchema.parse({ submissionId: "pill-task", title: "Task", repoPath: project.path, planningCommit: commit,
      handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", commit);
    const owning = f.store.projectFor(project.path, project.origin)!;
    assert.ok(owning, "the task's repository has a Queue project");
    assert.equal(add(f).projectKey, owning.key);
    // Task 1183 refuses new project-less decisions; a legacy General row still reads with no project.
    const legacy = f.store.addDecision({ id: "legacy-general", version: 1, question: "Old general question?",
      askedBy: { agentId: "agent-asker", project: null }, links: { tasks: [], leads: [], papercuts: [] },
      status: "open", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", versions: [] });
    assert.equal(f.decisions.get({ id: legacy.id }).projectKey, null, "a General decision has no project");
    f.store.update(task.id, { agentId: "worker-1" });
    assert.deepEqual(f.decisions.agentProjects({ agents: [
      { agentId: "worker-1", cwd: "/somewhere/worktrees/ns-task" },
      { agentId: "supervisor", cwd: `${project.path}/docs` },
      { agentId: "stranger", cwd: "/tmp/elsewhere" },
      { agentId: "prefix", cwd: `${project.path}-other` },
    ] }), [
      { agentId: "worker-1", project: { key: owning.key, name: owning.name } },
      { agentId: "supervisor", project: { key: owning.key, name: owning.name } },
      { agentId: "stranger", project: null },
      { agentId: "prefix", project: null },
    ]);
  } finally { f.close(); }
});

test("032-9 agent-projects keeps a path-only task's project after its repository's origin is registered (Sol, #578)", () => {
  const f = setup(); try {
    const path = "/fixture/path-only";
    const task = f.store.insert(submissionSchema.parse({ submissionId: "path-only-task", title: "Task", repoPath: path, planningCommit: commit,
      handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", commit);
    f.store.ensureProject(path, "owner/path-only");
    f.store.update(task.id, { agentId: "worker-2" });
    const owning = f.store.projectFor(path, "owner/path-only")!;
    assert.deepEqual(f.decisions.agentProjects({ agents: [{ agentId: "worker-2", cwd: "/elsewhere/worktree" }] }),
      [{ agentId: "worker-2", project: { key: owning.key, name: owning.name } }]);
  } finally { f.close(); }
});

test('empty and single-option decisions and supersessions always have a recommendation', () => {
  const f = setup();
  try {
    for (const options of [[], ['Investigate with the planner']]) {
      const decision = add(f, { options });
      assert.ok(decision.choices && decision.choices.length >= 2);
      assert.ok(decision.choices.some(choice => choice.label === decision.recommended));
      const replacement = f.decisions.supersede({ id: decision.id, version: 1, by: 'agent-asker', question: 'Reconsider this stop?', options: [], choices: [] });
      assert.ok(replacement.choices && replacement.choices.length >= 2);
      assert.ok(replacement.choices.some(choice => choice.label === replacement.recommended));
    }
  } finally { f.close(); }
});
