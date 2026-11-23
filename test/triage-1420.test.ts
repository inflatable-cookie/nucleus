import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Leads } from "../core/planning/leads";
import { Papercuts } from "../core/planning/papercut-operations";
import {
  TriageService,
  selectTriageBatch,
  triageDigest,
  triageNoticeBatch,
  triageNoticeProject,
  TRIAGE_BATCH_LIMIT,
  type TriageDecision,
  type TriagePromotionRequest,
} from "../core/planning/triage";
import {
  applyTriage,
  type TriageApplyInput,
} from "../core/runtime/planning-triage";
import { unparkDueLeads } from "../core/planning/parking";
import type { Lead } from "../shared/contracts";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";

/** Nucleus#1420 proofs on an isolated store: one bounded batch, dispositions, replay, restart, source edits, absent planner and capacity. */
const alpha = { origin: "owner/alpha", path: "/fixture/alpha" };
const beta = { origin: "owner/beta", path: "/fixture/beta" };
const PLANNER = "planner-agent";
const DAY = 86_400_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "queue-triage-"));
  const path = join(dir, "queue.sqlite");
  let store = new Store(path);
  const ensure = (s: Store) => {
    const project = s.ensureProject(alpha.path, alpha.origin);
    return s.projectByKey(project.key)!;
  };
  let project = ensure(store);
  return {
    dir,
    get store() {
      return store;
    },
    get project() {
      return store.projectByKey(project.key)!;
    },
    get leads() {
      return new Leads(store);
    },
    get cuts() {
      return new Papercuts(store);
    },
    get service() {
      return new TriageService(store);
    },
    reopen() {
      store.close();
      store = new Store(path);
      project = store.projectByKey(project.key)!;
    },
    planner(agentId: string | null) {
      store.setProjectPlanner({ key: project.key, agentId, setBy: "test" });
    },
    enable() {
      return new TriageService(store).setEnabled({
        project: project.key,
        enabled: true,
        by: "operator",
      });
    },
    add(title: string, tags: string[] = [], body = "Filing text") {
      return this.leads.add({
        repositories: [alpha],
        title,
        body,
        lanes: [],
        tags,
        author: "agent-1",
      });
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const decisionFor = (
  lead: Lead,
  decision: Partial<TriageDecision> &
    Pick<TriageDecision, "disposition" | "reason">,
): TriageDecision => ({
  recordId: lead.id,
  leadVersion: lead.version,
  digest: triageDigest(lead),
  ...decision,
});

const batchItems = (f: ReturnType<typeof setup>) =>
  f.service.view(f.project.key).batch!.items;

test("1420-1 triage is off by default and opt-in creates one batch with a planner notice", () => {
  const f = setup();
  try {
    f.add("Idea one");
    f.service.evaluate({ at: Date.now() });
    assert.equal(
      f.service.view(f.project.key).batch,
      null,
      "an unopted project makes no batch",
    );
    f.planner(PLANNER);
    f.enable();
    f.service.evaluate({ at: Date.now() });
    const view = f.service.view(f.project.key);
    assert.equal(view.batch?.items.length, 1);
    assert.equal(view.batch?.planner, PLANNER);
    const notices = f.store.notices(`triage:${f.project.key}`);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "triage");
    assert.equal(notices[0].agentId, PLANNER);
    assert.equal(triageNoticeBatch(notices[0]), view.batch!.id);
    assert.equal(
      triageNoticeProject(f.store, notices[0])?.key,
      f.project.key,
      "the prompt stays live while its batch is outstanding",
    );
  } finally {
    f.close();
  }
});

test("1420-2 a batch is bounded, oldest first, and a project never holds two outstanding batches", () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const ids: string[] = [];
    for (let i = 0; i < TRIAGE_BATCH_LIMIT + 2; i++)
      ids.push(f.add(`Idea ${i}`).id);
    const at = Date.now();
    f.service.evaluate({ at });
    const first = f.service.view(f.project.key).batch!;
    assert.equal(first.items.length, TRIAGE_BATCH_LIMIT);
    const createdAt = first.items.map((item) => item.createdAt);
    assert.deepEqual(createdAt, [...createdAt].sort(), "oldest first");
    const expected = selectTriageBatch(f.store.openLeads(), {}, at)
      .map((lead) => lead.id)
      .slice(0, TRIAGE_BATCH_LIMIT);
    assert.deepEqual(
      first.items.map((item) => item.recordId),
      expected,
    );
    f.add("Late idea");
    f.service.evaluate({ at: at + 60_000 });
    assert.equal(
      f.service.view(f.project.key).batch!.id,
      first.id,
      "a new record waits for the outstanding batch",
    );
    assert.equal(
      f.store.notices(`triage:${f.project.key}`).length,
      1,
      "one prompt per batch",
    );
  } finally {
    f.close();
  }
});

test("1420-3 dispositions: duplicate and fixed closures with canonical targets, defer, operator, promote and a planner-held record", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const canonical = f.add("Canonical idea", [], "The canonical body");
    const duplicate = f.add("Duplicate idea");
    const cut = f.cuts.add({
      repository: alpha,
      title: "Fixed papercut",
      happened: "Broke",
      impact: "Bad",
      filedBy: "agent-2",
    });
    const later = f.add("Defer me");
    const question = f.add("Operator question");
    const promote = f.add("Routine promote");
    // Nucleus#1543: a parked lead replaces the hold tag and is never triaged automatically.
    const held = f.add("Held idea");
    f.leads.park({
      id: held.id,
      version: held.version,
      reason: "Waits on a host",
      revisitAt: null,
      author: PLANNER,
    });
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    assert.equal(
      batch.items.some((item) => item.recordId === held.id),
      false,
      "a parked lead is never triaged automatically",
    );
    const cutLead = f.store.lead(cut.id);
    const promoted: TriagePromotionRequest[] = [];
    const promoter = {
      promote: async (request: TriagePromotionRequest) => {
        promoted.push(request);
        return { status: "applied" as const, task: "1234", diagnostic: "" };
      },
    };
    const input: TriageApplyInput = {
      project: f.project.key,
      batch: batch.id,
      by: PLANNER,
      decisions: [
        decisionFor(canonical, {
          disposition: "defer",
          revisitAt: new Date(Date.now() + DAY).toISOString(),
          reason: "Canonical lead stays open",
        }),
        decisionFor(duplicate, {
          disposition: "close",
          closure: "duplicate",
          canonical: canonical.id,
          reason: "Same request as the canonical lead",
        }),
        decisionFor(cutLead, {
          disposition: "close",
          closure: "fixed",
          canonical: "task 1200",
          reason: "Verified fixed by task 1200",
        }),
        decisionFor(later, {
          disposition: "defer",
          revisitAt: new Date(Date.now() + DAY).toISOString(),
          reason: "Wait for lane activity",
        }),
        decisionFor(question, {
          disposition: "operator",
          question: "Should this become a lane?",
          reason: "Needs a product call",
        }),
        decisionFor(promote, { disposition: "promote", reason: "In scope" }),
      ],
    };
    const result = await applyTriage(f.store, promoter, input);
    assert.equal(result.complete, true);
    assert.equal(promoted.length, 1);
    assert.equal(
      promoted[0].by,
      PLANNER,
      "the planner is the attributed approver and promoting agent",
    );
    assert.equal(f.store.lead(duplicate.id).state, "dropped");
    assert.match(
      f.store.lead(duplicate.id).dropReason ?? "",
      /duplicate: Same request .*canonical: /,
    );
    assert.equal(f.store.papercut(cut.id).state, "closed");
    assert.equal(f.store.papercut(cut.id).closedReason, "completed");
    assert.match(f.store.papercut(cut.id).note ?? "", /canonical: task 1200/);
    assert.equal(
      f.store.lead(later.id).state,
      "open",
      "a deferred record stays open",
    );
    assert.deepEqual(
      f.service
        .view(f.project.key)
        .operatorQuestions.map((item) => item.recordId),
      [question.id],
    );
    const view = f.service.view(f.project.key);
    assert.equal(
      view.batch,
      null,
      "a completed batch clears the outstanding slot",
    );
    assert.equal(view.lastCompleted, batch.id);
    f.reopen();
    const completed = f.service.planningView(f.project.key)!.latest!;
    assert.equal(
      completed.id,
      batch.id,
      "Planning retains the completed digest after restart",
    );
    const fixed = completed.items.find((item) => item.recordId === cut.id)!;
    assert.equal(fixed.title, "Fixed papercut");
    assert.equal(fixed.kind, "papercut");
    assert.equal(fixed.outcome?.reason, "Verified fixed by task 1200");
    assert.equal(fixed.outcome?.canonical, "task 1200");
    assert.equal(
      fixed.canonicalTaskId,
      null,
      "plain-text evidence does not become a broken task link",
    );
    const settled = f.store.lead(promote.id);
    assert.equal(
      settled.state,
      "open",
      "promotion is recorded by the task link, not a drop",
    );
  } finally {
    f.close();
  }
});

test("1420-4 validation refuses an incomplete decision and leaves the record open for a corrected one", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Needs evidence");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    const refused = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("not called");
        },
      },
      {
        project: f.project.key,
        batch: batch.id,
        by: PLANNER,
        decisions: [
          decisionFor(lead, {
            disposition: "close",
            closure: "duplicate",
            reason: "No canonical given",
          }),
        ],
      },
    );
    assert.equal(refused.complete, false);
    assert.equal(refused.outcomes[0].status, "refused");
    assert.match(batchItems(f)[0].outcome!.diagnostic, /canonical/);
    assert.equal(f.store.lead(lead.id).state, "open");
    const fixed = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("not called");
        },
      },
      {
        project: f.project.key,
        batch: batch.id,
        by: PLANNER,
        decisions: [
          decisionFor(lead, {
            disposition: "defer",
            revisitAt: new Date(Date.now() + DAY).toISOString(),
            reason: "Need more evidence",
          }),
        ],
      },
    );
    assert.equal(
      fixed.complete,
      true,
      "the same item accepts a corrected decision",
    );
  } finally {
    f.close();
  }
});

test("1420-5 a source edit after assessment supersedes the decision, and the record is reassessed", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Changing idea");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    const assessed = f.store.lead(lead.id);
    f.leads.edit({
      id: lead.id,
      version: assessed.version,
      body: "Edited after the batch was made",
      author: "operator",
    });
    const result = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("not called");
        },
      },
      {
        project: f.project.key,
        batch: batch.id,
        by: PLANNER,
        decisions: [
          decisionFor(assessed, {
            disposition: "close",
            closure: "fixed",
            canonical: "task 9",
            reason: "Looked fixed",
          }),
        ],
      },
    );
    assert.equal(result.complete, true);
    assert.equal(result.outcomes[0].status, "superseded");
    assert.equal(
      f.store.lead(lead.id).state,
      "open",
      "a changed record is never closed on the old assessment",
    );
    f.service.evaluate({ at: Date.now() + 60_000 });
    const next = f.service.view(f.project.key).batch!;
    assert.deepEqual(
      next.items.map((item) => item.recordId),
      [lead.id],
      "the edited record is reassessed",
    );
    assert.notEqual(next.items[0].leadVersion, assessed.version);
  } finally {
    f.close();
  }
});

test("1420-6 replays and stale batches never reapply a decision", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Duplicate once");
    const other = f.add("Canonical");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    const input: TriageApplyInput = {
      project: f.project.key,
      batch: batch.id,
      by: PLANNER,
      decisions: [
        decisionFor(lead, {
          disposition: "close",
          closure: "duplicate",
          canonical: other.id,
          reason: "Same",
        }),
        decisionFor(other, {
          disposition: "defer",
          revisitAt: new Date(Date.now() + DAY).toISOString(),
          reason: "Keep",
        }),
      ],
    };
    const first = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("unused");
        },
      },
      input,
    );
    assert.equal(first.complete, true);
    const dropReason = f.store.lead(lead.id).dropReason;
    const replay = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("replay must not promote");
        },
      },
      input,
    );
    assert.equal(replay.replayed, true);
    assert.equal(
      f.store.lead(lead.id).dropReason,
      dropReason,
      "a replay changes nothing",
    );
    const stale = { ...input, batch: "00000000-0000-4000-8000-000000000000" };
    await assert.rejects(
      applyTriage(
        f.store,
        {
          promote: async () => {
            throw new Error("unused");
          },
        },
        stale,
      ),
      /not outstanding/,
    );
  } finally {
    f.close();
  }
});

test("1420-7 a restart keeps the outstanding batch, its assessments and the planner prompt", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Survives restart");
    f.service.evaluate({ at: Date.now() });
    const before = f.service.view(f.project.key).batch!;
    f.reopen();
    const after = f.service.view(f.project.key);
    assert.equal(after.enabled, true);
    assert.equal(after.batch?.id, before.id);
    assert.equal(f.store.notices(`triage:${f.project.key}`).length, 1);
    const result = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("unused");
        },
      },
      {
        project: f.project.key,
        batch: before.id,
        by: PLANNER,
        decisions: [
          decisionFor(f.store.lead(lead.id), {
            disposition: "defer",
            revisitAt: new Date(Date.now() + DAY).toISOString(),
            reason: "After restart",
          }),
        ],
      },
    );
    assert.equal(result.complete, true);
  } finally {
    f.close();
  }
});

test("1420-8 an absent planner keeps the batch visible and unnoticed until a planner exists, and a handover re-addresses it", () => {
  const f = setup();
  try {
    f.enable();
    f.add("Waiting idea");
    f.service.evaluate({ at: Date.now() });
    const view = f.service.view(f.project.key);
    assert.equal(
      view.batch?.noticed,
      false,
      "no planner: the batch is visible and not noticed",
    );
    assert.equal(f.store.notices(`triage:${f.project.key}`).length, 0);
    f.planner("planner-one");
    f.service.evaluate({ at: Date.now() + 60_000 });
    assert.equal(f.service.view(f.project.key).batch?.noticed, true);
    assert.equal(
      f.store.notices(`triage:${f.project.key}`)[0].agentId,
      "planner-one",
    );
    f.planner("planner-two");
    f.service.evaluate({ at: Date.now() + 120_000 });
    const notices = f.store.notices(`triage:${f.project.key}`);
    assert.equal(
      notices.find((n) => n.agentId === "planner-one")?.status,
      "superseded",
      "the old planner's prompt ends",
    );
    assert.equal(
      notices.find((n) => n.agentId === "planner-two")?.status,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("1420-9 a full dispatch queue holds batch creation until room opens", () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    f.add("Capacity idea");
    f.service.evaluate({ at: Date.now(), hasRoom: () => false });
    assert.equal(f.service.view(f.project.key).batch, null);
    assert.equal(f.service.view(f.project.key).waiting, "capacity");
    f.service.evaluate({ at: Date.now() + 60_000, hasRoom: () => true });
    assert.equal(f.service.view(f.project.key).batch?.items.length, 1);
    assert.equal(f.service.view(f.project.key).waiting, null);
  } finally {
    f.close();
  }
});

test("1420-10 a deferred record returns when its revisit time is due, and an opt-out keeps the ledger", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Revisit me");
    const at = Date.now();
    f.service.evaluate({ at });
    const batch = f.service.view(f.project.key).batch!;
    await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("unused");
        },
      },
      {
        project: f.project.key,
        batch: batch.id,
        by: PLANNER,
        decisions: [
          decisionFor(lead, {
            disposition: "defer",
            revisitAt: new Date(at + DAY).toISOString(),
            reason: "Later",
          }),
        ],
      },
    );
    f.service.evaluate({ at: at + DAY - 1 });
    assert.equal(f.service.view(f.project.key).batch, null, "not yet due");
    // The sweep unparks a due park before triage reads the records (Nucleus#1543).
    assert.deepEqual(unparkDueLeads(f.store, at + DAY + 1), [lead.id]);
    f.service.evaluate({ at: at + DAY + 1 });
    assert.deepEqual(
      f.service.view(f.project.key).batch?.items.map((item) => item.recordId),
      [lead.id],
    );
    const batchNow = f.service.view(f.project.key).batch!;
    f.service.setEnabled({
      project: f.project.key,
      enabled: false,
      by: "operator",
    });
    f.service.evaluate({ at: at + 2 * DAY });
    assert.equal(
      f.service.state(f.project.key).batch?.id,
      batchNow.id,
      "an opted-out project makes no new work",
    );
    assert.equal(
      f.service.state(f.project.key).records[lead.id].current.disposition,
      "defer",
      "opting out keeps the ledger",
    );
  } finally {
    f.close();
  }
});

test("1420-11 a promotion proposed for a pending check stays open, then settles on the next apply", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Needs a check");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    const input: TriageApplyInput = {
      project: f.project.key,
      batch: batch.id,
      by: PLANNER,
      decisions: [
        decisionFor(lead, { disposition: "promote", reason: "Routine" }),
      ],
    };
    const first = await applyTriage(
      f.store,
      {
        promote: async () => ({
          status: "proposed" as const,
          task: null,
          diagnostic: "The brief check is running",
        }),
      },
      input,
    );
    assert.equal(first.complete, false);
    assert.equal(first.outcomes[0].status, "proposed");
    assert.equal(
      f.service.view(f.project.key).batch?.id,
      batch.id,
      "a proposed promotion keeps the batch outstanding",
    );
    const second = await applyTriage(
      f.store,
      {
        promote: async () => ({
          status: "applied" as const,
          task: "77",
          diagnostic: "",
        }),
      },
      input,
    );
    assert.equal(second.complete, true);
    assert.equal(second.outcomes[0].task, "77");
  } finally {
    f.close();
  }
});

test("1420-12 a promotion that throws is refused without closing the record", async () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const lead = f.add("Throws");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    const result = await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("Lead has no brief to promote");
        },
      },
      {
        project: f.project.key,
        batch: batch.id,
        by: PLANNER,
        decisions: [
          decisionFor(lead, { disposition: "promote", reason: "Routine" }),
        ],
      },
    );
    assert.equal(result.outcomes[0].status, "refused");
    assert.match(result.outcomes[0].diagnostic, /no brief/);
    assert.equal(f.store.lead(lead.id).state, "open");
  } finally {
    f.close();
  }
});

test("1420-13 the ledger is per project: a record of another project is never batched here", () => {
  const f = setup();
  try {
    f.planner(PLANNER);
    f.enable();
    const other = f.store.ensureProject(beta.path, beta.origin);
    f.leads.add({
      repositories: [beta],
      title: "Beta idea",
      body: "",
      lanes: [],
      tags: [],
      author: "agent-2",
    });
    f.add("Alpha idea");
    f.service.evaluate({ at: Date.now() });
    const items = f.service.view(f.project.key).batch!.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Alpha idea");
    assert.ok(other.key !== f.project.key);
  } finally {
    f.close();
  }
});

test("1420-14 the planner prompt is delivered once through the notice path, and a settled batch is never sent again", async (t) => {
  const f = setup();
  try {
    f.planner("planner");
    f.enable();
    f.store.setMeta("hostId", "host");
    f.store.setMeta("paused", false);
    f.add("Delivered idea");
    f.service.evaluate({ at: Date.now() });
    const batch = f.service.view(f.project.key).batch!;
    const targets: string[] = [];
    const adapter = {
      hostId: "host",
      listLiveAgents: async () => [
        { id: "planner", title: "Planner", workspaceId: null },
      ],
      observe: async (id: string) => ({
        id,
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      }),
      notify: async (id: string) => {
        targets.push(id);
      },
      profiles: async () => [],
    } as unknown as Adapter;
    const engine = new Engine(f.store, adapter, 0);
    t.after(() => engine.stop());
    await engine.resolution.deliverDrainNotices();
    assert.deepEqual(
      targets,
      ["planner"],
      "the outstanding batch reaches the planner once",
    );
    const notice = f.store.notices(`triage:${f.project.key}`)[0];
    assert.equal(notice.status, "delivered");
    await engine.resolution.deliverDrainNotices();
    assert.equal(targets.length, 1, "a delivered prompt is not resent");
    const lead = f.store.openLeads()[0];
    await applyTriage(
      f.store,
      {
        promote: async () => {
          throw new Error("unused");
        },
      },
      {
        project: f.project.key,
        batch: batch.id,
        by: "planner",
        decisions: [
          decisionFor(lead, {
            disposition: "defer",
            revisitAt: new Date(Date.now() + DAY).toISOString(),
            reason: "Later",
          }),
        ],
      },
    );
    f.service.evaluate({ at: Date.now() + 60_000 });
    await engine.resolution.deliverDrainNotices();
    assert.equal(
      targets.length,
      1,
      "no batch is outstanding, so nothing is sent",
    );
  } finally {
    f.close();
  }
});
