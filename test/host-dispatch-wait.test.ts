import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import { submissionSchema, summarizeTask } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";
import { fakeAdapter, profile, submission } from "./support/fakes";
import { taskWithCurrentWait } from "../core/recovery/wait-context";
import { HostTransportFault } from "../core/host/adapter-routing";
import { HostExecutorLink } from "../service/host-executor";
import { createBbHostAdapter } from "../service/bb-host";
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
    const versions = [offline, unknown].map((task) => store.task(task.id).version);
    // The sweep's host loop records the outage; the queued tasks record nothing.
    engine.hostOutages.observe("offline", false);
    await engine.dispatchTask(offline.id, false);
    await engine.dispatchTask(unknown.id, false);
    assert.deepEqual(
      [offline, unknown].map((task) => store.task(task.id).version),
      versions,
      "a never-started task stores no wait (Spec 069 §1)",
    );
    // The known offline host is one named host wait (Tom, 2026-11-14, T3 lane v18
    // host dropout option 1: wait), read at the boundary; a task with no proven
    // host keeps its own wait.
    const read = (id: string) =>
      taskWithCurrentWait(store, store.task(id), {}, (task) =>
        engine.queuedExternalWait(task),
      );
    assert.match(read(offline.id).reason, /Waiting on Paseo host offline since /);
    assert.equal(read(offline.id).resolution.stop?.reason, "host_unavailable");
    assert.match(read(unknown.id).reason, /proven host/);
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
    // The sweep's host loop records the outage once for the host.
    const outage = engine.hostOutages.observe("offline", false)!;
    await engine.dispatchTask(task.id, false);
    const stored = store.task(task.id);
    assert.equal(stored.resolution.stop, null, "a never-started task stores no stop (Spec 069 §1)");
    assert.equal(stored.resolution.hostWait, null, "nor a host wait");
    // Tom, 2026-11-14 (T3 lane v18, host dropout option 1: wait): new dispatch for
    // a project whose host is away waits on that host, visibly and with its start,
    // now worked out when the task is read.
    const waiting = taskWithCurrentWait(store, stored, {}, (candidate) =>
      engine.queuedExternalWait(candidate),
    );
    assert.equal(waiting.resolution.stop?.reason, "host_unavailable");
    assert.match(
      waiting.resolution.stop?.detail ?? "",
      /^Waiting on Paseo host offline since \d{4}-\d{2}-\d{2}T/,
    );
    assert.deepEqual(
      waiting.resolution.hostWait,
      { hostId: "offline", since: outage.since },
      "the read names the host and the outage's own start",
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
    "hung operation",
    "hung BB pass",
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
    // The archived-thread retention pass reads each host hourly on its own detached
    // lane; this fixture measures the audit pass's own bound, so keep that lane idle.
    store.setMeta("lastThreadRetentionAt", Date.now());
    store.setMeta(
      "globalLimit",
      refusal === "hung operation" ? 2 : refusal === "hung BB pass" ? 3 : 1,
    );
    const hostRequests: string[] = [];
    const link = new HostExecutorLink({
      hostId: "bb:offline",
      declaration: {
        role: "host-executor",
        host: {
          dataDir: "/synthetic/bb",
          bbVersion: "test",
          sdkVersion: "test",
        },
      },
      deadlineMs: 10,
      write: (frame) => {
        hostRequests.push(
          String((frame as { input?: { op?: unknown } }).input?.op),
        );
      },
    });
    store.setMeta("pool", [
      {
        profileId: worker.id,
        enabled: true,
        group: "workers",
        weight: "default",
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
        if (refusal === "hung operation") {
          await link.request("call.counters", {});
          return "a".repeat(40);
        }
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
    // The branch-PR step reads on each task's own host now: held, so only the
    // host pass's own requests are counted below.
    engine.reconcile = async () => {};
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
      "deliverRowHiddenNotices",
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
        {
          hostSelection: {
            hostId,
            basis: "worker_profile",
            reason: "Previously selected worker host",
          },
        },
      );
    const bb = add("bb:offline", "bb");
    const bb2 = add("bb:offline", "bb2");
    const paseo = add("paseo:primary", "paseo");
    const t3 = add("t3code:primary", "t3");
    let retained: ReturnType<typeof add> | undefined;
    if (refusal === "hung BB pass") {
      retained = add("bb:offline", "retained-bb");
      store.update(retained.id, {
        phase: "working",
        agentId: "thr_retained",
        runId: "run_retained",
      });
      store.setMeta("bbThreads", {
        agents: {
          thr_retained: {
            id: "thr_retained",
            task: retained.id,
            run: "run_retained",
            role: "worker",
            workspaceId: "ws",
            parentThreadId: null,
            labels: {},
          },
        },
        spawns: {},
        writes: {},
      });
      const realBb = createBbHostAdapter(
        "bb:offline",
        () => true,
        "",
        store,
        (op, input) => link.request(op, input),
      );
      // The hung host hangs a dispatch's own call too (the fixture has no BB
      // checkout for the adapter's local planning-base read).
      realBb.validate = async () => {
        await link.request("call.counters", {});
        return "a".repeat(40);
      };
      engine.resolveHostAdapter = (host) =>
        host === "bb:offline" ? realBb : adapter;
    }
    try {
      const passStarted = Date.now();
      await engine.auditPass(true);
      if (refusal === "hung BB pass") {
        assert.ok(
          Date.now() - passStarted < 5_000,
          "one request deadline bounds the pass",
        );
        // The host pass stops at its first timed-out read (Spec 069 §2: only that
        // step fails); other owners' own calls stay theirs, each bounded alike.
        assert.equal(
          hostRequests.filter((op) => op === "thread.observe").length,
          1,
          "BB's host pass stops after its first timed-out request",
        );
      }
      // Spec 069 §2: only a lost connection takes BB down and parks its tasks. A
      // failed or hung call on a connected BB fails only its own step: BB stays up
      // (one call or one failed pass is not the host), its queued tasks keep no
      // stop, and the healthy hosts take the free slots.
      const connectionLost = refusal === "registry offline";
      const bbHealth = engine.hostHealth.read("bb:offline");
      assert.equal(bbHealth.state, connectionLost ? "down" : "up");
      for (const task of [bb, bb2])
        assert.equal(store.task(task.id).phase, "queued");
      // Queued rows store no host wait (Spec 069 §1), and no pass walks the
      // host's tasks (Spec 069 §2): a down host's wait is read, not written.
      const readStop = (id: string) =>
        taskWithCurrentWait(store, store.task(id), {}, (task) =>
          engine.queuedExternalWait(task),
        ).resolution.stop?.reason ?? null;
      for (const task of [bb, bb2]) {
        assert.equal(store.task(task.id).resolution.stop?.reason ?? null, null);
        assert.equal(
          readStop(task.id),
          connectionLost ? "host_unavailable" : null,
        );
      }
      if (connectionLost) {
        assert.ok(
          engine.hostLaunchWait("bb:offline"),
          "a down host admits no launch",
        );
      }
      if (refusal === "hung operation" || refusal === "hung BB pass") {
        // The hung call is read at read time from the health reading, never stored.
        assert.match(bbHealth.detail ?? "", /no answer within/);
        assert.doesNotMatch(store.task(bb.id).reason, /no answer within/);
        if (retained)
          assert.equal(
            store.task(retained.id).resolution.stop?.reason ?? null,
            null,
            "BB keeps its running task",
          );
        assert.deepEqual(new Set(launches), new Set([paseo.id, t3.id]));
        if (refusal === "hung BB pass") {
          // A truly hung host fails every pass: the third in a row makes it
          // degraded, which admits one first dispatch at a time and keeps its
          // running task. Nothing is parked.
          await engine.auditPass(true);
          assert.equal(engine.hostHealth.read("bb:offline").state, "up");
          await engine.auditPass(true);
          assert.equal(engine.hostHealth.read("bb:offline").state, "degraded");
          assert.equal(engine.hostOutages.current("bb:offline"), null);
          assert.equal(
            engine.hostLaunchWait("bb:offline", bb.id),
            null,
            "one launch is admitted",
          );
          engine.hostHealth.launchStarted("bb:offline", bb.id);
          assert.match(
            engine.hostLaunchWait("bb:offline", bb2.id) ?? "",
            /one launch at a time/,
            "a second waits while the first is in flight",
          );
          engine.hostHealth.launchSettled(bb.id);
          for (const task of [bb, bb2, retained!])
            assert.equal(
              store.task(task.id).resolution.stop?.reason ?? null,
              null,
            );
        }
        continue;
      }
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
      const directVersion = store.task(direct.id).version;
      await engine.dispatchTask(direct.id, false);
      // A host the registry reports away is read live, with nothing written
      // (Spec 069 §1); a refused call is the host-failure path (Spec 069 batch 2).
      if (refusal === "registry offline")
        assert.equal(
          store.task(direct.id).version,
          directVersion,
          "direct dispatch on an away host writes no wait",
        );
      assert.equal(
        taskWithCurrentWait(store, store.task(direct.id), {}, (task) =>
          engine.queuedExternalWait(task),
        ).resolution.stop?.reason ?? null,
        connectionLost ? "host_unavailable" : null,
        connectionLost
          ? "the read names the host wait"
          : "a failed call on a connected host fails only that dispatch",
      );
      assert.equal(store.task(direct.id).phase, "queued");
      store.update(direct.id, { phase: "done" });
      bbOnline = true;
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
      weight: "default",
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
    "deliverRowHiddenNotices",
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
    // Spec 069 §1/§2: the refused call fails only its own review's step. The
    // origin host stays connected (one call is not the host), and the other
    // reviews behind it are skipped for the rest of the pass without a visit or a
    // write.
    assert.equal(engine.hostHealth.read("bb:origin").state, "up");
    const read = (id: string) =>
      taskWithCurrentWait(store, store.task(id), {}, (task) =>
        engine.queuedExternalWait(task),
      ).reason;
    for (const item of extraReviews) {
      assert.equal(store.task(item.id).resolution.stop, null);
      assert.doesNotMatch(store.task(item.id).reason, /bb:origin/);
    }
    assert.equal(store.task(review.id).resolution.hostWait, null);
    assert.deepEqual(new Set(launches), new Set([paseo.id, t3.id]));
    assert.equal(engine.taskHostAvailable(store.task(paseo.id)), true);
    assert.equal(engine.taskHostAvailable(store.task(t3.id)), true);

    // The origin host is reported away outright. Reviews from it are not
    // startable heads, so they never stop the project's queue: freed slots go to
    // the worker behind them, pass after pass.
    engine.hostAvailable = (id) => id !== "bb:origin";
    for (const done of [paseo, t3])
      store.update(done.id, { phase: "done", agentActive: false });
    const worker = store.insert(
      submission({ title: "worker", repoPath: "/synthetic/review" }),
      "paseo:primary",
      "handoff",
      "a".repeat(40),
    );
    const reviewVersions = [review, ...extraReviews].map(
      (item) => store.task(item.id).version,
    );
    await engine.auditPass(true);
    await engine.auditPass(true);
    assert.ok(launches.includes(worker.id), "the worker behind the reviews starts");
    assert.deepEqual(
      [review, ...extraReviews].map((item) => store.task(item.id).version),
      reviewVersions,
      "a review whose origin is away is neither visited nor written",
    );
    assert.equal(read(extraReviews[0].id), "Waiting for origin host bb:origin");
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
      weight: "default",
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

test("a BB socket connection refusal clears on the next healthy sweep", async () => {
  const store = new Store(":memory:");
  const host = "bb:synthetic-host";
  let online = false;
  const engine = new Engine(store, fakeAdapter({}), 0);
  engine.hostAvailable = (id) => id === host && online;
  store.setMeta("paused", true);
  const failure =
    "BB host operation was not sent: Service socket connect failed: connect ENOENT fixture.sock";
  try {
    const stopped = store.insert(
      submissionSchema.parse(submission({ submissionId: "bb-stale-stop" })),
      host,
      "handoff",
      "a".repeat(40),
    );
    const independent = store.insert(
      submissionSchema.parse(
        submission({ submissionId: "bb-independent-stop" }),
      ),
      host,
      "handoff",
      "a".repeat(40),
    );
    engine.note(stopped.id, failure, "operator_needed", "needs_attention");
    engine.note(
      independent.id,
      "Planner must choose the next approach",
      "escalated",
      "needs_attention",
    );
    const next = (id: string) =>
      ownerTaskNext(collectOwnerVerbFacts(store, store.task(id)));
    assert.equal((await engine.auditPass(true)).fault, null);
    assert.equal(store.task(stopped.id).resolution.stop?.detail, failure);
    online = true;
    assert.equal((await engine.auditPass(true)).fault, null);
    assert.equal(store.task(stopped.id).resolution.stop, null);
    assert.doesNotMatch(next(stopped.id).reason, /connect ENOENT/);
    assert.equal(
      next(independent.id).stop?.detail,
      "Planner must choose the next approach",
    );
    assert.equal((await engine.auditPass(true)).fault, null);
    assert.equal(
      store
        .eventsAll(stopped.id)
        .filter((event) => event.kind === "host_wait_cleared").length,
      1,
    );
  } finally {
    await engine.stop();
    store.close();
  }
});
