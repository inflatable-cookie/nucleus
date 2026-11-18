import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { submissionSchema, summarizeTask } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import { fakeAdapter, profile, submission } from "./support/fakes";
import { HostTransportFault } from "../core/host/adapter-routing";
import {
  record as reviewRecord,
  ownerRevisionFixture,
} from "./support/review-entry-fixture";

test("an offline or unknown task host waits without starting a workspace effect", async () => {
  const store = new Store(":memory:");
  let creates = 0;
  const engine = new Engine(
    store,
    {
      createWorkspace: async () => {
        creates++;
        throw Error("must not run");
      },
    } as unknown as Adapter,
    0,
  );
  engine.hostAvailable = (id) => id === "online";
  try {
    const make = (id: string, host: string) =>
      store.insert(
        submissionSchema.parse({
          submissionId: id,
          title: id,
          repoPath: "/repo",
          planningCommit: "a".repeat(40),
          handoffPath: "handoff",
          originAgentId: "origin",
        }),
        host,
        "handoff",
        "a".repeat(40),
      );
    const offline = make("offline", "offline");
    const unknown = make("unknown", "");
    await engine.dispatchTask(offline.id, false);
    await engine.dispatchTask(unknown.id, false);
    // The known offline host is one named host wait (Tom, 2026-11-14, T3 lane v18
    // host dropout option 1: wait); a task with no proven host keeps its own wait.
    assert.match(
      store.task(offline.id).reason,
      /Waiting on Paseo host offline since /,
    );
    assert.equal(
      store.task(offline.id).resolution.stop?.reason,
      "host_unavailable",
    );
    assert.match(store.task(unknown.id).reason, /proven host/);
    assert.equal(creates, 0);
    assert.equal(store.task(offline.id).workspaceIntent, false);
    assert.equal(store.task(unknown.id).workspaceIntent, false);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("new dispatch for a project on an offline host waits with host_unavailable", async () => {
  const store = new Store(":memory:");
  let creates = 0;
  const engine = new Engine(
    store,
    {
      createWorkspace: async () => {
        creates++;
        throw Error("must not run");
      },
    } as unknown as Adapter,
    0,
  );
  engine.hostAvailable = (id) => id === "online";
  try {
    const task = store.insert(
      submissionSchema.parse({
        submissionId: "host-wait",
        title: "Host wait",
        repoPath: "/repo",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff",
        originAgentId: "origin",
      }),
      "offline",
      "handoff",
      "a".repeat(40),
    );
    await engine.dispatchTask(task.id, false);
    const waiting = store.task(task.id);
    // Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): new dispatch for
    // a project whose host is away waits on that host, visibly and with its start.
    assert.equal(waiting.resolution.stop?.reason, "host_unavailable");
    assert.match(
      waiting.resolution.stop?.detail ?? "",
      /^Waiting on Paseo host offline since \d{4}-\d{2}-\d{2}T/,
    );
    assert.deepEqual(
      waiting.resolution.hostWait && {
        hostId: waiting.resolution.hostWait.hostId,
      },
      { hostId: "offline" },
      "the task records its own host wait while it is queued",
    );
    assert.equal(waiting.phase, "queued");
    assert.equal(creates, 0);
    assert.equal(waiting.workspaceIntent, false);
    const card = summarizeTask(
      waiting,
      false,
      false,
      {},
      [],
      undefined,
      "online",
      store.eventsAll(task.id),
    );
    assert.equal(card.stop, "wait");
    assert.match(
      card.stopRecord?.detail ?? "",
      /Waiting on Paseo host offline since /,
    );
  } finally {
    await engine.stop();
    store.close();
  }
});

test("real admission gives one free slot to healthy hosts while a BB host waits, then resumes BB", async () => {
  for (const refusal of [
    "Transport not connected: host bb:offline is unavailable",
    "plugin build mismatch",
    "registry offline",
  ]) {
    const store = new Store(":memory:");
    const worker = profile("worker");
    const launches: string[] = [];
    const adapter = fakeAdapter({
      validate: async () => "a".repeat(40),
      createWorkspace: async (task) => ({
        id: `ws-${task.id}`,
        directory: `/synthetic/workspaces/${task.id}`,
      }),
    });
    const engine = new Engine(store, adapter, 0);
    store.setMeta("paused", false);
    store.setMeta("globalLimit", 1);
    store.setMeta("pool", [
      {
        profileId: worker.id,
        enabled: true,
        group: "workers",
        weight: 1,
        scopes: ["general"],
      },
    ]);
    store.setProfiles([
      {
        id: worker.id,
        name: worker.name,
        provider: worker.provider,
        model: worker.model,
        notes: "",
      },
    ]);
    engine.profiles = [worker];
    engine.profileCatalogKnown = () => true;
    engine.profilesFor = () => [worker];
    let bbOnline = false;
    engine.hostAvailable = (host) =>
      !(refusal === "registry offline" && host === "bb:offline" && !bbOnline);
    const refusing = fakeAdapter({
      ...adapter,
      validate: async () => {
        if (refusal === "plugin build mismatch")
          throw new HostTransportFault("bb:offline", new Error(refusal));
        throw new Error(refusal);
      },
    });
    engine.resolveHostAdapter = (host) =>
      host === "bb:offline" && !bbOnline ? refusing : adapter;
    engine.hostIds = () => ["bb:offline", "paseo:primary", "t3code:primary"];
    engine.lastHookCleanupAt = Date.now();
    engine.migrateProjectOwnersToPlanners = async () => {};
    engine.resumePausedStops = async () => {};
    engine.recoverExhaustedWorkers = async () => {};
    engine.applyDeferredOwnerVerbs = async () => {};
    engine.deliverPendingBriefAmendments = async () => {};
    engine.continueAwaitingReviewers = async () => {};
    engine.lifecycle.enqueuePass = async () => {};
    engine.resolution.observe = async () => {};
    engine.scheduleTaskQuantum = async () => {};
    for (const method of [
      "deliverNotices",
      "deliverQueuedMessages",
      "resumeAskQuestions",
      "raiseOperatorQuestions",
      "delegateNativeQuestions",
      "resumeResponsibleAnsweredQuestions",
      "deliverHoldNotices",
      "deliverDecisionNotices",
      "deliverDrainNotices",
      "deliverHostOutageNotices",
    ] as const)
      engine.resolution[method] = async () => {};
    engine.enqueueTitle = () => {};
    engine.launchAgent = async (task) => {
      launches.push(task.id);
      store.update(task.id, {
        phase: "working",
        agentId: `agent-${task.id}`,
        agentActive: true,
      });
    };
    const add = (hostId: string, title: string) =>
      store.insert(
        submission({ title, repoPath: `/synthetic/${title}` }),
        hostId,
        "handoff",
        "a".repeat(40),
      );
    const bb = add("bb:offline", "bb");
    const bb2 = add("bb:offline", "bb2");
    const paseo = add("paseo:primary", "paseo");
    const t3 = add("t3code:primary", "t3");
    try {
      await engine.auditPass(true);
      assert.equal(
        store.task(bb.id).resolution.stop?.reason,
        "host_unavailable",
      );
      assert.equal(
        store.task(bb2.id).resolution.stop?.reason,
        "host_unavailable",
      );
      assert.deepEqual(
        launches,
        [paseo.id],
        "the real first-dispatch admission starts Paseo",
      );
      store.update(paseo.id, { phase: "done", agentActive: false });
      await engine.dispatchQueued();
      assert.deepEqual(
        launches,
        [paseo.id, t3.id],
        "T3 takes the released slot",
      );
      store.update(t3.id, { phase: "done", agentActive: false });
      bbOnline = true;
      await engine.auditPass(true);
      assert.deepEqual(
        launches,
        [paseo.id, t3.id, bb.id],
        "BB starts once on return",
      );
      store.update(bb.id, { phase: "done", agentActive: false });
      await engine.auditPass(true);
      assert.deepEqual(
        launches,
        [paseo.id, t3.id, bb.id, bb2.id],
        "the second BB task starts once",
      );
      await engine.auditPass(true);
      assert.deepEqual(
        launches,
        [paseo.id, t3.id, bb.id, bb2.id],
        "no duplicate launch",
      );
      store.update(bb2.id, { phase: "done", agentActive: false });
      bbOnline = false;
      const direct = add("bb:offline", "direct");
      await engine.dispatchTask(direct.id, false);
      assert.equal(
        store.task(direct.id).resolution.stop?.reason,
        "host_unavailable",
        "direct dispatch records the host wait",
      );
      store.update(direct.id, { phase: "done" });
      bbOnline = true;
      engine.resetAuditHostAvailability();
      const invalid = add("paseo:invalid", "invalid");
      const after = add("t3code:primary", "after");
      const invalidAdapter = fakeAdapter({
        ...adapter,
        validate: async () => {
          throw new Error("Planning base unavailable");
        },
      });
      engine.resolveHostAdapter = (host) =>
        host === "paseo:invalid" ? invalidAdapter : adapter;
      await engine.dispatchQueued();
      assert.equal(store.task(invalid.id).phase, "needs_attention");
      assert.match(store.task(invalid.id).reason, /Planning base unavailable/);
      assert.equal(
        launches.at(-1),
        after.id,
        "a task validation failure leaves the slot for another host",
      );
    } finally {
      await engine.stop();
      store.close();
    }
  }
});

test("a refused BB origin holds only its review while Paseo and T3 use real admission", async () => {
  const store = new Store(":memory:");
  const worker = profile("worker");
  const launches: string[] = [];
  let originReads = 0;
  const healthy = fakeAdapter({
    validate: async () => "a".repeat(40),
    createWorkspace: async (task) => ({
      id: `ws-${task.id}`,
      directory: `/synthetic/${task.id}`,
    }),
    originAgent: async () => null,
    inspectReviewEntry: async () => {
      throw Error("origin proof must run first");
    },
  });
  const bb = fakeAdapter({
    ...healthy,
    originAgent: async () => {
      originReads++;
      throw Error("Transport not connected: host bb:origin is unavailable");
    },
  });
  const engine = new Engine(store, healthy, 0);
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 2);
  store.setMeta("pool", [
    {
      profileId: worker.id,
      enabled: true,
      group: "workers",
      weight: 1,
      scopes: ["general"],
    },
  ]);
  store.setProfiles([
    {
      id: worker.id,
      name: worker.name,
      provider: worker.provider,
      model: worker.model,
      notes: "",
    },
  ]);
  engine.profiles = [worker];
  engine.profileCatalogKnown = () => true;
  engine.profilesFor = () => [worker];
  engine.resolution.select = (() => ({
    profile: worker,
  })) as unknown as typeof engine.resolution.select;
  engine.hostAvailable = () => true;
  engine.resolveHostAdapter = (host) => (host === "bb:origin" ? bb : healthy);
  engine.hostIds = () => ["bb:origin", "paseo:primary", "t3code:primary"];
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.deliverPendingBriefAmendments = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.observe = async () => {};
  engine.scheduleTaskQuantum = async () => {};
  for (const method of [
    "deliverNotices",
    "deliverQueuedMessages",
    "resumeAskQuestions",
    "raiseOperatorQuestions",
    "delegateNativeQuestions",
    "resumeResponsibleAnsweredQuestions",
    "deliverHoldNotices",
    "deliverDecisionNotices",
    "deliverDrainNotices",
    "deliverHostOutageNotices",
  ] as const)
    engine.resolution[method] = async () => {};
  engine.enqueueTitle = () => {};
  engine.launchAgent = async (task) => {
    launches.push(task.id);
    store.update(task.id, {
      phase: "working",
      agentId: `agent-${task.id}`,
      agentActive: true,
    });
  };
  const review = store.insert(
    submission({ title: "review", repoPath: "/synthetic/review" }),
    "paseo:primary",
    "handoff",
    "a".repeat(40),
    {
      entrypoint: "review",
      reviewEntry: reviewRecord(),
      originHostId: "bb:origin",
      workspaceId: "workspace",
      directory: "/synthetic/review-workspace",
    },
  );
  const extraReviews = Array.from({ length: 5 }, (_, index) =>
    store.insert(
      submission({ title: `review-${index}`, repoPath: "/synthetic/review" }),
      "paseo:primary",
      "handoff",
      "a".repeat(40),
      {
        entrypoint: "review",
        reviewEntry: reviewRecord(),
        originHostId: "bb:origin",
        workspaceId: `workspace-${index}`,
        directory: `/synthetic/review-${index}`,
      },
    ),
  );
  const paseo = store.insert(
    submission({ title: "paseo", repoPath: "/synthetic/review" }),
    "paseo:primary",
    "handoff",
    "a".repeat(40),
  );
  const t3 = store.insert(
    submission({ title: "t3", repoPath: "/synthetic/t3" }),
    "t3code:primary",
    "handoff",
    "a".repeat(40),
  );
  try {
    const pass = await engine.auditPass(true);
    assert.equal(pass.fault, null);
    assert.equal(store.getMeta("engineError"), "");
    assert.ok(originReads >= 1);
    assert.equal(store.task(review.id).resolution.stop?.reason, "origin_busy");
    assert.match(store.task(review.id).reason, /bb:origin/);
    assert.ok(
      extraReviews.every(
        (item) => store.task(item.id).resolution.stop?.reason === "origin_busy",
      ),
    );
    assert.equal(store.task(review.id).resolution.hostWait, null);
    assert.deepEqual(new Set(launches), new Set([paseo.id, t3.id]));
    assert.equal(engine.taskHostAvailable(store.task(paseo.id)), true);
    assert.equal(engine.taskHostAvailable(store.task(t3.id)), true);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("a recovered cross-host review rejoins fair slot order before admission", async () => {
  const f = ownerRevisionFixture();
  f.store.setMeta("paused", false);
  f.store.setMeta("hostId", "host");
  f.store.setMeta("pool", [
    {
      profileId: "reviewer",
      enabled: true,
      group: "reviewers",
      roles: ["reviewer"],
      weight: 1,
      scopes: ["general"],
    },
  ]);
  const { engine, adapter } = f.buildEngine();
  engine.hostAvailable = () => true;
  engine.resolveHostAdapter = () => adapter;
  try {
    f.store.setMeta("globalLimit", 1);
    const review = f.store.insert(
      f.reviewInput.submission,
      "host",
      "handoff",
      f.planningCommit,
      {
        entrypoint: "review",
        reviewEntry: {
          ...reviewRecord(),
          verifiedHead: f.oldHead,
          verifiedBase: f.planningCommit,
          planningCommit: f.planningCommit,
        },
        originHostId: "bb:origin",
        workspaceId: "workspace",
        directory: f.workspace,
        branch: "feature/external",
        prHead: f.oldHead,
        queuePriority: 0,
      },
    );
    engine.note(review.id, "Waiting for origin host bb:origin", "origin_busy");
    const earlier = f.store.insert(
      {
        ...f.reviewInput.submission,
        submissionId: "earlier-slot",
        title: "Earlier slot",
      },
      "host",
      "handoff",
      f.planningCommit,
      { queuePriority: 10 },
    );
    await engine.withHost("host", () =>
      engine.dispatchOwner.dispatchReviewEntry(f.store.task(review.id)),
    );
    const waiting = f.store.task(review.id);
    assert.equal(waiting.phase, "queued");
    assert.equal(
      waiting.reviewEntry?.dispatchBase,
      null,
      "proof does not bypass the earlier reservation",
    );
    assert.match(
      engine.resolution.slotAdmissionReason(waiting),
      /Waiting behind 1 earlier queued reservations/,
    );
    f.store.update(earlier.id, { phase: "done" });
    await engine.withHost("host", () =>
      engine.dispatchOwner.dispatchReviewEntry(f.store.task(review.id)),
    );
    assert.equal(f.store.task(review.id).phase, "awaiting_review");
    assert.equal(
      f.store.task(review.id).reviewEntry?.dispatchBase,
      f.planningCommit,
    );
  } finally {
    await engine.stop();
    f.close();
  }
});
