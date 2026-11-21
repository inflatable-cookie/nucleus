import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { Decisions, decisionNoticeId } from "../core/planning/decisions";
import { RuntimeQuestions } from "../core/runtime/questions";
import { RuntimeSettings } from "../core/runtime/settings";
import { RuntimeLifecycle, type RuntimeLifecycleOwner } from "../service/runtime-lifecycle";
import { AcpSessions } from "../core/acp/sessions";
import { bindOwner } from "../core/acp/decisions";
import { readAcpBinding } from "../shared/acp/binding";
import { CapacityChangeJournal } from "../core/dispatch/capacity-changes";
import {
  HostCallAbandonedError,
  HostUnknownDeliveryError,
  ProvenPreSendRefusalError,
  type Adapter,
  type AgentObservation,
  type HostPolicyConstructor,
} from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import { createAdapter, T3CodeHost } from "../hosts/t3code";
import { t3Fake, syntheticRun } from "./support/t3code-fake";
import { submissionSchema } from "../shared/contracts";
import { formatAgentId, parseAgentId } from "../shared/agent-identity";
import { fakeAdapter, profile } from "./support/fakes";

const project = { origin: "owner/decisions-independent", path: "/fixture/decisions-independent" };
const commit = "a".repeat(40);
const T3_HOST = "t3code:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function createFixture(t: TestContext, options: {
  observe?: (id: string) => Promise<AgentObservation>;
  notify?: (id: string, messageId: string, text: string) => Promise<void>;
  identifyOriginHost?: (agentId: string) => Promise<string | undefined>;
  hostAvailable?: (hostId: string) => boolean;
} = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ns-dec-delivery-")));
  const dbPath = join(dir, "queue.sqlite");
  let store = new Store(dbPath);
  const delivered: Array<{ agentId: string; messageId: string; text: string }> = [];
  const observations = new Map<string, AgentObservation>();
  const observationCalls = new Map<string, number>();

  const defaultObserve = async (id: string): Promise<AgentObservation> => {
    observationCalls.set(id, (observationCalls.get(id) ?? 0) + 1);
    return (
      observations.get(id) ?? {
        id,
        workspaceId: "ws",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      }
    );
  };
  const defaultNotify = async (id: string, messageId: string, text: string) => {
    delivered.push({ agentId: id, messageId, text });
  };

  const buildEngine = (s: Store) => {
    const adapter = fakeAdapter({
      profiles: async () => [profile("p-1")],
      observe: options.observe ?? defaultObserve,
      notify: options.notify ?? defaultNotify,
    });
    const engine = new Engine(s, adapter as unknown as Adapter, 60_000);
    engine.resolveHostAdapter = (id) =>
      ({ ...(adapter as object), hostId: id }) as unknown as Adapter;
    engine.identifyOriginHost =
      options.identifyOriginHost ??
      (async (agentId) => parseAgentId(agentId)?.hostId ?? "host-primary");
    engine.hostAvailable = options.hostAvailable ?? (() => true);
    engine.decisionNotices.observeTimeoutMs = 150;
    engine.decisionNotices.sendTimeoutMs = 150;
    engine.decisionNotices.retryDelaysMs = [30, 30, 30];
    return engine;
  };

  let engine = buildEngine(store);
  store.setMeta("paused", false);

  const makeQuestions = (s: Store, e: Engine) =>
    new RuntimeQuestions({
      store: s,
      engine: e,
      decisions: new Decisions(s),
      markStoreAccess: () => {},
    });

  let decisions = new Decisions(store);
  let questions = makeQuestions(store, engine);

  t.after(async () => {
    await engine.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    dbPath,
    get store() { return store; },
    get engine() { return engine; },
    get decisions() { return decisions; },
    get questions() { return questions; },
    delivered,
    observations,
    observationCalls,
    async reopen(recreateHooks?: (e: Engine) => void) {
      await engine.stop();
      store.close();
      store = new Store(dbPath);
      store.setMeta("paused", false);
      engine = buildEngine(store);
      recreateHooks?.(engine);
      decisions = new Decisions(store);
      questions = makeQuestions(store, engine);
    },
  };
}

test("board and T3 Inbox answers deliver via the shared path within 5s while fleet reconciliation is blocked, and fleet sweep does not send decision notices", async (t) => {
  const sweepEntered = deferred<void>();
  const sweepRelease = deferred<void>();
  // Register release before createFixture so t.after never waits 120s for a blocked quantum.
  t.after(() => sweepRelease.resolve());
  const f = createFixture(t);
  const plannerBoard = "planner-board";
  const plannerInbox = formatAgentId(T3_HOST, "planner-inbox");

  const slowTask = f.store.insert(
    submissionSchema.parse({
      submissionId: "slow-fleet-task",
      title: "Slow task blocking audit",
      repoPath: project.path,
      planningCommit: commit,
      handoffPath: "h.md",
      originAgentId: "origin",
    }),
    "host-primary",
    "h.md",
    commit,
  );
  f.store.update(slowTask.id, { phase: "working", agentId: "worker-slow" });

  f.engine.lastHookCleanupAt = Date.now();
  f.engine.migrateProjectOwnersToPlanners = async () => {};
  f.engine.resumePausedStops = async () => {};
  f.engine.recoverExhaustedWorkers = async () => {};
  f.engine.archiveRetiredErroredAgents = async () => {};
  f.engine.applyDeferredOwnerVerbs = async () => {};
  f.engine.deliverPendingBriefAmendments = async () => {};
  f.engine.continueAwaitingReviewers = async () => {};
  f.engine.lifecycle.enqueuePass = async () => {};
  f.engine.resolution.observe = async () => {};
  f.engine.scheduleTaskQuantum = async () => {
    sweepEntered.resolve();
    await sweepRelease.promise;
  };

  // Seed a decision BEFORE blocking the sweep and run a bounded auditPass directly
  // (without scheduleDecisionNotices) once to prove auditPass itself does not deliver decisions.
  const preExisting = f.decisions.add({
    question: "Pre-existing decision?",
    askedBy: "planner-sweep-check",
    project,
  });
  f.decisions.answer({
    id: preExisting.id,
    version: 1,
    answer: "Wait for owner",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });

  // Start the fleet sweep, which blocks inside scheduleTaskQuantum.
  let wakeCalls = 0;
  const origWake = f.engine.wake.bind(f.engine);
  f.engine.wake = () => {
    wakeCalls++;
    return origWake();
  };
  const runningWake = f.engine.wake();
  await sweepEntered.promise;

  // Now commit one decision answer via the Board RPC path and one via the T3 Inbox ACP path,
  // while the fleet sweep is intentionally stuck.
  const boardDecision = f.decisions.add({
    question: "Board question?",
    askedBy: plannerBoard,
    project,
  });
  const inboxDecision = f.decisions.add({
    question: "Inbox question?",
    askedBy: plannerInbox,
    project,
  });

  // Bind the inbox decision to an authenticated T3 inbox owner so AcpSessions.answer works normally.
  bindOwner(f.store, f.store.decision(inboxDecision.id), { kind: "inbox", hostId: T3_HOST });
  const acp = new AcpSessions(f.engine, {
    dataHome: f.dir,
    socketPath: join(f.dir, "cb.sock"),
    answerDecision: (input) => f.questions.answerT3Decision(input),
  });
  const inboxSession = acp.bindInbox({ hostId: T3_HOST });
  const inboxToken = readAcpBinding(inboxSession.bindingPath).token;

  const startedAt = Date.now();
  f.questions.answerDecision({
    id: boardDecision.id,
    version: 1,
    answer: "Approve board",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  await acp.answer(
    {
      kind: "inbox",
      hostId: T3_HOST,
      sessionId: inboxSession.sessionId,
      id: inboxDecision.id,
      version: 1,
      action: "accept",
      answer: "Approve inbox",
    },
    inboxToken,
  );

  // Also link a task ask to confirm the independent wake for task effects still fires.
  assert.ok(wakeCalls >= 3, "shared answer path still invokes engine.wake() for task effects");

  await waitFor(
    () =>
      f.decisions.get({ id: boardDecision.id }).delivery?.status === "delivered" &&
      f.decisions.get({ id: inboxDecision.id }).delivery?.status === "delivered",
    4_500,
    "board and inbox decision delivery while fleet sweep is blocked",
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5_000, `expected delivery within 5000ms, took ${elapsedMs}ms`);

  // Verify exact notice IDs and one delivery per version (plus preExisting caught by the same owner pass).
  const byId = new Map(f.delivered.map((item) => [item.messageId, item]));
  assert.equal(byId.get(decisionNoticeId(boardDecision.id, 2))?.agentId, plannerBoard);
  assert.match(byId.get(decisionNoticeId(boardDecision.id, 2))?.text ?? "", /Approve board/);
  assert.equal(byId.get(decisionNoticeId(inboxDecision.id, 2))?.agentId, "planner-inbox");
  assert.match(byId.get(decisionNoticeId(inboxDecision.id, 2))?.text ?? "", /Approve inbox/);

  // Let the coalesced follow-up quantum on "decision-notices" finish before seeding the sweep-only check.
  await f.engine.quiesce("audit");
  // Confirm auditPass without scheduleDecisionNotices does not send decision notices.
  const directDeliveredCount = f.delivered.length;
  const secondDecision = f.decisions.add({
    question: "After sweep unblocks?",
    askedBy: "planner-later",
    project,
  });
  f.decisions.answer({
    id: secondDecision.id,
    version: 1,
    answer: "Not via sweep",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  // Unblock the in-flight sweep and await it; auditPass itself no longer delivers decisions.
  sweepRelease.resolve();
  await runningWake;
  assert.equal(
    f.delivered.length,
    directDeliveredCount,
    "serial auditPass itself no longer sends decision notices",
  );
  assert.equal(f.decisions.get({ id: secondDecision.id }).delivery?.status, "pending");
});

test("task effects (operatorDecisionAnswered) and independent wake still run alongside immediate decision delivery", async (t) => {
  const f = createFixture(t);
  let taskEffectTriggered = 0;
  let wakeTriggered = 0;
  f.engine.resolution.operatorDecisionAnswered = () => {
    taskEffectTriggered++;
  };
  const stalled = deferred<void>();
  t.after(() => stalled.resolve());
  f.engine.wake = () => {
    wakeTriggered++;
    return stalled.promise;
  };

  const d = f.decisions.add({ question: "With task effect?", askedBy: "planner-effect", project });
  f.questions.answerDecision({
    id: d.id,
    version: 1,
    answer: "Proceed",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });

  await waitFor(() => f.decisions.get({ id: d.id }).delivery?.status === "delivered");
  assert.equal(taskEffectTriggered, 1);
  assert.equal(wakeTriggered, 1);
  assert.equal(f.delivered.length, 1);
});

test("coalesced wakeups deliver one notice per version with no duplicate planner turn", async (t) => {
  const f = createFixture(t);
  const d = f.decisions.add({ question: "Coalesce?", askedBy: "planner-coalesce", project });
  f.decisions.answer({
    id: d.id,
    version: 1,
    answer: "Once",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });

  const runs = await Promise.all([
    f.engine.scheduleDecisionNotices(),
    f.engine.scheduleDecisionNotices(),
    f.engine.scheduleDecisionNotices(),
    f.engine.resolution.deliverDecisionNotices(),
  ]);
  assert.equal(runs.length, 4);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0]!.messageId, decisionNoticeId(d.id, 2));
  assert.equal(f.decisions.get({ id: d.id }).delivery?.attempts, 1);

  // Additional wakeups after delivery remain no-ops.
  await f.engine.scheduleDecisionNotices();
  assert.equal(f.delivered.length, 1);
});

test("busy, unavailable, or hung recipients stay pending and cannot monopolize an unrelated reachable recipient", async (t) => {
  const hungWait = deferred<AgentObservation>();
  t.after(() => hungWait.resolve({ id: "hung-observe", workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" }));

  const f = createFixture(t, {
    identifyOriginHost: async (agentId) => {
      if (agentId === "hung-lookup") {
        await new Promise(() => {});
      }
      if (agentId === "offline-host-agent") return "host-offline";
      return "host-online";
    },
    hostAvailable: (hostId) => hostId === "host-online",
    observe: async (id) => {
      if (id === "hung-observe") return await hungWait.promise;
      if (id === "busy-agent") {
        return f.observations.get(id) ?? {
          id,
          workspaceId: "ws",
          status: "running",
          active: true,
          permissions: false,
          error: "",
        };
      }
      return { id, workspaceId: "ws", status: "idle", active: false, permissions: false, error: "" };
    },
  });

  // Seed 4 stalled/busy/unavailable decisions first (exceeding concurrency=4 if not prioritized,
  // and testing concurrency + fresh prioritization + retry).
  const dHungLookup = f.decisions.add({ question: "Hung lookup?", askedBy: "hung-lookup", project });
  const dHungObserve = f.decisions.add({ question: "Hung observe?", askedBy: "hung-observe", project });
  const dOffline = f.decisions.add({ question: "Offline host?", askedBy: "offline-host-agent", project });
  const dBusy = f.decisions.add({ question: "Busy agent?", askedBy: "busy-agent", project });
  for (const item of [dHungLookup, dHungObserve, dOffline, dBusy]) {
    f.decisions.answer({
      id: item.id,
      version: 1,
      answer: "Wait",
      answeredBy: "operator (board)",
      relayed: false,
      note: "",
    });
  }

  // Trigger a first pass so those 4 have recorded attempts/waits, or even concurrently with a fresh answer:
  const dReachable = f.decisions.add({ question: "Reachable?", askedBy: "reachable-idle", project });
  const startedAt = Date.now();
  f.questions.answerDecision({
    id: dReachable.id,
    version: 1,
    answer: "Deliver now",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });

  // Reachable idle recipient gets its notice immediately, well before hung timeouts accumulate.
  await waitFor(() => f.decisions.get({ id: dReachable.id }).delivery?.status === "delivered", 2_000);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(f.delivered.filter((m) => m.agentId === "reachable-idle").length, 1);

  // Hung, offline, and busy recipients remain pending with visible waits.
  await waitFor(() => f.decisions.get({ id: dBusy.id }).delivery?.error.includes("finish") === true, 2_000);
  assert.equal(f.decisions.get({ id: dBusy.id }).delivery?.status, "pending");
  assert.equal(f.decisions.get({ id: dOffline.id }).delivery?.status, "pending");
  assert.match(f.decisions.get({ id: dOffline.id }).delivery?.error ?? "", /Waiting for host host-offline/);

  // Once busy-agent becomes idle, the owner's own bounded retry delivers it once without a fleet sweep.
  f.observations.set("busy-agent", {
    id: "busy-agent",
    workspaceId: "ws",
    status: "idle",
    active: false,
    permissions: false,
    error: "",
  });
  await waitFor(() => f.decisions.get({ id: dBusy.id }).delivery?.status === "delivered", 2_000);
  assert.equal(f.delivered.filter((m) => m.agentId === "busy-agent").length, 1);
});

test("pause holds delivery and unpause via queueControl resumes through the same owner", async (t) => {
  const f = createFixture(t);
  f.store.setMeta("paused", true);
  // Intentionally block wake() so only the independent decision owner can deliver on unpause.
  const blockedWake = deferred<void>();
  t.after(() => blockedWake.resolve());
  f.engine.wake = () => blockedWake.promise;

  const d = f.decisions.add({ question: "Paused?", askedBy: "planner-paused", project });
  f.questions.answerDecision({
    id: d.id,
    version: 1,
    answer: "After unpause",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.delivered.length, 0);
  assert.equal(f.decisions.get({ id: d.id }).delivery?.status, "pending");

  const settings = new RuntimeSettings({
    store: f.store,
    engine: f.engine,
    decisions: f.decisions,
    capacityChanges: new CapacityChangeJournal(f.store),
    started: Promise.resolve(),
    hostId: "host-primary",
    startError: "",
    adapter: f.engine.adapter,
    connected: () => true,
    wakeAndSettlePostBootstrapTimeout: () => f.engine.wake(),
    markStoreAccess: () => {},
  });
  settings.queueControl({ paused: false });

  await waitFor(() => f.decisions.get({ id: d.id }).delivery?.status === "delivered", 2_000);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0]!.messageId, decisionNoticeId(d.id, 2));
});

test("restart and secondary host reconnect route through the same owner and never resend interrupted intents", async (t) => {
  let online = false;
  const f = createFixture(t, { hostAvailable: () => online });

  const pendingDecision = f.decisions.add({ question: "Pending across restart?", askedBy: "planner-restart", project });
  f.questions.answerDecision({
    id: pendingDecision.id,
    version: 1,
    answer: "Deliver after reconnect",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  await waitFor(() => (f.decisions.get({ id: pendingDecision.id }).delivery?.attempts ?? 0) >= 1);
  assert.equal(f.delivered.length, 0);

  // Also record an interrupted in-flight `intent` left by a crashed process.
  const intentDecision = f.decisions.add({ question: "Interrupted intent?", askedBy: "planner-intent", project });
  const answeredIntent = f.decisions.answer({
    id: intentDecision.id,
    version: 1,
    answer: "Do not resend",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  f.store.updateDecisionDelivery(intentDecision.id, {
    ...answeredIntent.delivery!,
    status: "intent",
    attempts: 1,
  });

  // Restart with fresh store and engine; keep host offline during resumeOperations,
  // then bring T3 secondary host online via RuntimeLifecycle.refreshOnSecondaryArrival.
  await f.reopen();
  f.engine.resumeOperations(true);
  await waitFor(() => f.decisions.get({ id: intentDecision.id }).delivery?.status === "uncertain", 2_000);
  assert.equal(f.delivered.length, 0, "interrupted intent settles uncertain without resending");

  // Simulate secondary T3 reconnect with primary wake blocked.
  online = true;
  let t3Connected = true;
  f.engine.refresh = async () => {};
  const lifecycle = new RuntimeLifecycle({
    store: f.store,
    engine: f.engine,
    adapter: f.engine.adapter,
    admission: {} as never,
    hostRegistry: { known: () => [] } as never,
    plannerTickets: { ensure: async () => {} } as never,
    t3Host: () => ({ status: () => ({ connected: t3Connected }) }) as never,
    refreshT3Settings: () => {},
    daemonUrl: "ws://127.0.0.1:1/ws",
    connectTimeoutMs: 50,
    paseoHostId: "host-primary",
    hostSession: null,
    idleShutdownLatched: false,
    connected: () => false,
    readPrStates: async () => ({}),
  } as unknown as RuntimeLifecycleOwner);

  await lifecycle.refreshOnSecondaryArrival();
  await waitFor(() => f.decisions.get({ id: pendingDecision.id }).delivery?.status === "delivered", 2_000);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0]!.messageId, decisionNoticeId(pendingDecision.id, 2));
  assert.equal(f.decisions.get({ id: intentDecision.id }).delivery?.status, "uncertain");
});

test("late and uncertain sends keep the answer committed, never resend blindly, and settle late acknowledgements without duplicate turns", async (t) => {
  const lateHostGate = deferred<void>();
  const lateTimeoutGate = deferred<void>();
  t.after(() => {
    lateHostGate.resolve();
    lateTimeoutGate.resolve();
  });

  let sendCount = 0;
  let mode: "unknown" | "abandoned_late" | "slow_timeout" = "unknown";
  const f = createFixture(t, {
    notify: async () => {
      sendCount++;
      if (mode === "unknown") {
        throw new HostUnknownDeliveryError({ command: "message.dispatch", reason: "socket_closed" });
      }
      if (mode === "abandoned_late") {
        const err = new HostCallAbandonedError({
          call: "control",
          holder: "notify:planner-late",
          ageMs: 60_000,
          deadlineMs: 60_000,
        });
        err.lateDelivery = true;
        err.late = lateHostGate.promise;
        throw err;
      }
      await lateTimeoutGate.promise;
    },
  });

  // 1. Unknown delivery error: answer stays committed, status is uncertain, retries never resend.
  const dUnknown = f.decisions.add({ question: "Unknown?", askedBy: "planner-unknown", project });
  f.questions.answerDecision({
    id: dUnknown.id,
    version: 1,
    answer: "Keep committed",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  await waitFor(() => f.decisions.get({ id: dUnknown.id }).delivery?.status === "uncertain", 2_000);
  assert.equal(f.decisions.get({ id: dUnknown.id }).answer?.text, "Keep committed");
  assert.equal(sendCount, 1);
  await f.engine.scheduleDecisionNotices();
  assert.equal(sendCount, 1, "uncertain delivery is never resent");

  // 2. HostCallAbandonedError with late promise: marks uncertain immediately, settles delivered when late resolves.
  mode = "abandoned_late";
  const dLateAck = f.decisions.add({ question: "Late ack?", askedBy: "planner-late", project });
  f.questions.answerDecision({
    id: dLateAck.id,
    version: 1,
    answer: "Late ok",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  await waitFor(() => f.decisions.get({ id: dLateAck.id }).delivery?.status === "uncertain", 2_000);
  assert.equal(sendCount, 2);
  await f.engine.scheduleDecisionNotices();
  assert.equal(sendCount, 2, "abandoned send is never resent while late ack is pending");

  lateHostGate.resolve();
  await waitFor(() => f.decisions.get({ id: dLateAck.id }).delivery?.status === "delivered", 2_000);
  assert.equal(sendCount, 2, "late ack settles without a second send");
  assert.ok(f.decisions.get({ id: dLateAck.id }).delivery?.deliveredAt);

  // 3. Send exceeding sendTimeoutMs: marks uncertain at timeout, settles delivered when in-flight send finishes late.
  mode = "slow_timeout";
  const dSlow = f.decisions.add({ question: "Slow send?", askedBy: "planner-slow-send", project });
  f.questions.answerDecision({
    id: dSlow.id,
    version: 1,
    answer: "Slow ok",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  await waitFor(() => f.decisions.get({ id: dSlow.id }).delivery?.status === "uncertain", 2_000);
  assert.equal(sendCount, 3);
  await f.engine.scheduleDecisionNotices();
  assert.equal(sendCount, 3, "timed-out send is never resent");

  lateTimeoutGate.resolve();
  await waitFor(() => f.decisions.get({ id: dSlow.id }).delivery?.status === "delivered", 2_000);
  assert.equal(sendCount, 3, "no duplicate planner turn when slow send resolves late");
});

test("decision answer notice to a busy T3 thread steers into the active turn via real T3 adapter and delivers exactly once (nucleus#1516)", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-dec-t3-steer-")));
  const fake = await t3Fake(t, root);
  const host = new T3CodeHost({
    endpoint: fake.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(root, "state.json"),
    probeThreadId: "synthetic-probe",
  });
  await host.connect();
  const t3Adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
    {
      socketPath: join(root, "callback.sock"),
      helperPath: join(root, "worker-report.mjs"),
    },
  );
  const store = new Store(join(root, "queue.sqlite"));
  store.setMeta("paused", false);
  const engine = new Engine(store, t3Adapter as unknown as Adapter, 60_000);
  engine.resolveHostAdapter = (id) =>
    id === host.hostId ? (t3Adapter as unknown as Adapter) : (t3Adapter as unknown as Adapter);
  engine.identifyOriginHost = async (agentId) =>
    parseAgentId(agentId)?.hostId ?? host.hostId;
  engine.hostAvailable = (hostId) => hostId === host.hostId;
  engine.decisionNotices.observeTimeoutMs = 2_000;
  engine.decisionNotices.sendTimeoutMs = 2_000;
  engine.decisionNotices.retryDelaysMs = [30, 30, 30];

  t.after(async () => {
    await engine.stop();
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Put the asking T3 thread mid-turn with an active run.
  const threadId = "synthetic-probe";
  const projection = fake.threads.get(threadId)!;
  const activeRun = syntheticRun(threadId, 1, { status: "running" });
  projection.runs = [activeRun];

  const decisions = new Decisions(store);
  const questions = new RuntimeQuestions({
    store,
    engine,
    decisions,
    markStoreAccess: () => {},
  });

  // Opening a decision via RuntimeQuestions wakes reconciliation immediately.
  let wakes = 0;
  const origWake = engine.wake.bind(engine);
  engine.wake = () => {
    wakes++;
    return origWake();
  };

  const asker = formatAgentId(host.hostId, threadId);
  const decision = questions.addDecision({
    question: "Use Opus frontier for queued task?",
    askedBy: asker,
    project,
  });
  assert.equal(wakes, 1, "addDecision wakes the engine without waiting for an unrelated wake");

  questions.answerDecision({
    id: decision.id,
    version: 1,
    answer: "Approve Opus",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });

  await waitFor(
    () => decisions.get({ id: decision.id }).delivery?.status === "delivered",
    3_000,
    "busy T3 thread decision answer notice steered",
  );

  const dispatches = fake.commands.filter(
    (command) =>
      command.type === "message.dispatch" &&
      command.threadId === threadId &&
      typeof command.text === "string" &&
      command.text.includes("Approve Opus"),
  );
  assert.equal(dispatches.length, 1, "answer notice delivered exactly once");
  assert.deepEqual(dispatches[0]!.dispatchMode, {
    type: "steer_active",
    targetRunId: activeRun.id,
  });
  assert.equal(decisions.get({ id: decision.id }).delivery?.attempts, 1);

  // Repeat schedules remain no-ops (no duplicate steer).
  await engine.scheduleDecisionNotices();
  const afterRepeat = fake.commands.filter(
    (command) =>
      command.type === "message.dispatch" &&
      command.threadId === threadId &&
      typeof command.text === "string" &&
      command.text.includes("Approve Opus"),
  );
  assert.equal(afterRepeat.length, 1);

  // Remote failure during steer marks uncertain and never resends blindly.
  const second = questions.addDecision({
    question: "Second question during remote fault?",
    askedBy: asker,
    project,
  });
  fake.controls.refuseMutation = true;
  questions.answerDecision({
    id: second.id,
    version: 1,
    answer: "Fault answer",
    answeredBy: "operator (board)",
    relayed: false,
    note: "",
  });
  await waitFor(
    () => decisions.get({ id: second.id }).delivery?.status === "uncertain",
    3_000,
    "remote steer failure marks uncertain",
  );
  const faultDispatches = fake.commands.filter(
    (command) =>
      command.type === "message.dispatch" &&
      command.threadId === threadId &&
      typeof command.text === "string" &&
      command.text.includes("Fault answer"),
  );
  assert.equal(faultDispatches.length, 1);
  await engine.scheduleDecisionNotices();
  const faultDispatchesAfter = fake.commands.filter(
    (command) =>
      command.type === "message.dispatch" &&
      command.threadId === threadId &&
      typeof command.text === "string" &&
      command.text.includes("Fault answer"),
  );
  assert.equal(faultDispatchesAfter.length, 1, "uncertain steer is never resent");
});
