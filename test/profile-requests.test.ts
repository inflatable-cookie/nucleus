import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine";
import { Decisions } from "../core/planning/decisions";
import { Store } from "../core/store/store";
import { ROUTING_APPROVAL_MIGRATION_KEY } from "../core/store/store-migration";
import { chooseProfile } from "../core/dispatch/routing";
import { workerClimbTarget } from "../shared/demand";
import { poolSchema } from "../shared/contracts";
import { RPC_METHOD_NAMES } from "../shared/rpc-catalogue";
import { fakeAdapter, profile, submission } from "./support/fakes";

const head = "a".repeat(40);
const capabilities = ["worker", "heavyweight", "frontier"] as const;
const profiles = capabilities.map((tier) => profile(tier));
const pool = capabilities.map((tier) =>
  poolSchema.parse({
    profileId: tier,
    group: tier,
    enabled: true,
    capability: tier,
    weight: "default",
    scopes: ["general"],
  }),
);

test("stored very-high work uses Frontier automatically only at Extra high or Maximum", () => {
  const store = new Store(":memory:");
  try {
    store.setMeta("pool", pool);
    const task = store.insert(submission({ complexity: "very_high" }), "host", "handoff", head);
    const pick = (usage: ReturnType<Store["usageLevel"]>) =>
      chooseProfile(store.task(task.id), profiles, store.pool(), {}, new Set(), "worker", {}, usage)?.profile.id;

    for (const usage of ["low", "normal", "high"] as const)
      assert.equal(pick(usage), "heavyweight");

    store.update(task.id, {
      phase: "changes_requested",
      profile: profile("heavyweight"),
      resolution: {
        ...task.resolution,
        review: {
          taskId: task.id, runId: "review", eventId: "review-result",
          status: "changes_required", summary: "Revise", head,
        },
      },
    });
    for (const usage of ["low", "normal", "high"] as const) {
      assert.equal(workerClimbTarget(store.task(task.id), store.pool(), usage), null);
      assert.equal(pick(usage), "heavyweight");
    }
    for (const usage of ["extra_high", "maximum"] as const) {
      assert.equal(workerClimbTarget(store.task(task.id), store.pool(), usage)?.to, "frontier");
      assert.equal(pick(usage), "frontier");
    }
  } finally {
    store.close();
  }
});

test("a planner's stored brief request applies on first dispatch without a decision", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ns-profile-request-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const launches: string[] = [];
  const adapter = fakeAdapter({
    validate: async () => head,
    createWorkspace: async () => ({ id: "workspace", directory: dir }),
    verifyWorkspace: async (task) => task.branch,
    createAgent: async (task) => {
      launches.push(task.profile?.id ?? "");
      return { id: "worker", workspaceId: task.workspaceId };
    },
  });
  const engine = new Engine(store, adapter, 0);
  t.after(async () => {
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  engine.profiles = profiles;
  store.setMeta("paused", false);
  store.setMeta("pool", pool);
  const reason = "Prove the invariants across the systems";
  const task = store.insert(submission({
    repoPath: dir,
    complexity: "very_high",
    originAgentId: "planner",
    profileRequests: { worker: { profileId: "frontier", reason } },
  }), "host", "handoff", head, { branch: "ns-profile-request", baseBranch: "main" });

  await engine.dispatchTask(task.id, false);
  const current = store.task(task.id);
  assert.deepEqual(launches, ["frontier"], current.reason);
  assert.equal(current.profileRequests?.worker?.requestedBy, "planner");
  assert.equal(store.routingPolicy(current).profiles.find((row) => row.source === "request")?.reason, reason);
  assert.deepEqual(store.listDecisions({ task: task.id }), []);
});

test("store migration withdraws open routing approvals, drops grants and preserves task requests", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ns-retired-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  const seed = new Store(path);
  const task = seed.insert(submission({
    profileRequests: { worker: { profileId: "frontier", reason: "Study scheduling interactions" } },
  }), "host", "handoff", head);
  const decisions = new Decisions(seed);
  const signoff = decisions.add({
    askedBy: "origin", tasks: [task.id], question: "Allow the worker profile?",
  });
  const grantDecision = decisions.add({
    askedBy: "origin", tasks: [task.id], question: "Grant standing permission?",
  });
  const admission = decisions.add({
    askedBy: "origin", tasks: [task.id], question: "Admit this task at Low?",
  });
  seed.event(task.id, "routing_signoff_requested", JSON.stringify({
    role: "worker", profileId: "frontier", decisionId: signoff.id,
  }));
  seed.setMeta("routingGrants", [{ id: "grant", planner: "origin", status: "pending", decisionId: grantDecision.id }]);
  seed.db.prepare("UPDATE tasks SET data=json_set(data, '$.profileRequests.worker.signoff', json(?)) WHERE id=?").run(
    JSON.stringify({ status: "pending", decisionId: signoff.id, by: null, at: new Date().toISOString(), note: "" }),
    task.id,
  );
  seed.close();

  const reopened = new Store(path);
  try {
    assert.equal(reopened.decision(signoff.id).status, "withdrawn");
    assert.match(reopened.decision(signoff.id).withdrawal!.reason, /2026-11-22/);
    assert.equal(reopened.decision(grantDecision.id).status, "withdrawn");
    assert.equal(reopened.decision(admission.id).status, "open");
    assert.deepEqual(reopened.task(task.id).profileRequests, task.profileRequests);
    assert.equal(reopened.getMeta("routingGrants"), undefined);
    const record = reopened.getMeta<{ droppedGrants: number; withdrawn: string[] }>(ROUTING_APPROVAL_MIGRATION_KEY);
    assert.equal(record?.droppedGrants, 1);
    assert.deepEqual(new Set(record?.withdrawn), new Set([signoff.id, grantDecision.id]));
  } finally {
    reopened.close();
  }
  const again = new Store(path);
  try {
    assert.equal(again.decision(signoff.id).version, signoff.version + 1);
  } finally {
    again.close();
  }
});

test("queue.routing-grant has been removed from the RPC catalogue", () => {
  assert.ok(!RPC_METHOD_NAMES.includes("queue.routing-grant"));
});
