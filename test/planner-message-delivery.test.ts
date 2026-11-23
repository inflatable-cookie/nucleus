import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTimelineEntryPayloadSchema } from "@getpaseo/protocol/messages";
import { ParticipantTickets } from "../core/dispatch/participant-tickets";
import { Engine } from "../core/engine";
import type { Adapter, HostPolicyConstructor } from "../core/host";
import { HostPolicies } from "../core/host/host-policies";
import { runInTaskQuantumScope } from "../core/scheduling/pass-snapshot";
import { Store, digest } from "../core/store/store";
import { createAdapter, T3CodeHost } from "../hosts/t3code";
import { createBbHostAdapter } from "../service/bb-host";
import { PaseoAdapter } from "../service/paseo-composition";
import { formatAgentId } from "../shared/agent-identity";
import {
  PLANNER_DELIVERY_EVENT,
  readPlannerDelivery,
  taskActivity,
} from "../shared/task-activity";
import { waitFor } from "./support/budgets";
import { bbFake, bbWire } from "./support/bb-fake";
import { submission, tempStore } from "./support/fakes";
import { syntheticRun, t3Fake, threadProjection } from "./support/t3code-fake";

const plannerId = "synthetic-task-planner";
const projectPlannerId = "synthetic-project-planner";
const checkMs = 5_000;

async function fixture(t: TestContext) {
  const { store, dir } = tempStore(t);
  const server = await t3Fake(t, dir);
  server.controls.queueMessageRuns = true;
  server.threads.set(plannerId, threadProjection(plannerId, dir));
  const planner = server.threads.get(plannerId)!;
  server.threads.set(projectPlannerId, threadProjection(projectPlannerId, dir));
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath: join(dir, "host-state.json"),
    timeoutMs: 1_000,
    probeThreadId: "synthetic-probe",
  });
  t.after(() => host.close());
  await host.connect();
  store.setMeta("hostId", host.hostId);
  const taskPlanner = formatAgentId(host.hostId, plannerId);
  const head = "a".repeat(40);
  const id = store.insert(
    submission({ repoPath: dir, originAgentId: taskPlanner }),
    host.hostId,
    "Handoff",
    head,
  ).id;
  store.update(id, {
    phase: "blocked",
    plannerAgentId: taskPlanner,
    originHostId: host.hostId,
  });
  const reporting = {
    socketPath: join(dir, "callback.sock"),
    helperPath: join(dir, "worker-report.mjs"),
  };
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
    reporting,
  );
  const start = (db: Store) => {
    const engine = new Engine(db, adapter, 0);
    const tickets = new ParticipantTickets(engine, reporting);
    engine.resolution.ensurePlannerTicket = (recipient, hostId) =>
      tickets.ensureFor(recipient, hostId);
    engine.resolution.delegatedAnswerWaitMs = 400;
    t.after(() => engine.stop());
    return engine;
  };
  const engine = start(store);
  const question = "How should the task proceed?";
  const openEscalation = () =>
    engine.resolution.openPlannerEscalation(store.task(id), {
      cause: digest("Synthetic dependency stopped"),
      runId: null,
      question,
      payload: { question },
    });
  const updates = (db = store) =>
    db.eventsAll(id).flatMap((event) => {
      if (event.kind !== PLANNER_DELIVERY_EVENT) return [];
      const record = readPlannerDelivery(event.detail);
      assert.ok(record, "the persisted delivery update decodes");
      return [record];
    });
  const delivery = (db = store) => updates(db).at(-1);
  const commands = () =>
    server.commands.filter((command) => command.type === "message.dispatch");
  const activity = () => {
    const task = store.task(id);
    return taskActivity({
      task,
      stop: task.resolution.stop,
      events: store.eventsAll(id),
      runs: [],
      now: Date.now(),
    });
  };
  return {
    server,
    store,
    planner,
    id,
    engine,
    start,
    openEscalation,
    updates,
    delivery,
    commands,
    activity,
    host,
    dir,
  };
}

test("an idle planner gets one queue-only send from an expired task quantum, and that exact message starts a turn", async (t) => {
  const f = await fixture(t);
  const neededAt = Date.now();
  await runInTaskQuantumScope(0, async () => f.openEscalation());
  await waitFor(
    () => f.commands().length > 0,
    checkMs,
    "the first planner message",
  );
  const [command] = f.commands();
  assert.ok(command);
  assert.match(command.text, /NUCLEUS_TICKET= nucleus question.answer -/);
  await waitFor(
    () => f.delivery()?.state === "started",
    checkMs,
    "the planner's turn",
  );
  assert.equal(f.commands().length, 1);
  assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
  assert.equal(command.threadId, plannerId);
  const updates = f.updates();
  assert.deepEqual(
    updates.map((record) => record.state),
    ["routed", "intent", "accepted", "started"],
  );
  assert.equal(new Set(updates.map((record) => record.occurrence)).size, 1);
  assert.ok(updates.every((record) => record.messageId === command.commandId));
  assert.equal(f.delivery()?.nativeMessageId, command.messageId);
  assert.equal(f.delivery()?.runId, f.planner.runs[0].id);
  assert.equal(f.delivery()?.startedAt, f.planner.runs[0].startedAt);
  assert.ok(Date.parse(f.delivery()!.startedAt!) - neededAt < 60_000);
  assert.equal(
    f.store
      .eventsAll(`delegation:${command.commandId}`)
      .filter((event) => event.kind === "delegated_delivery").length,
    1,
  );
});

test("a busy planner keeps its running turn and the queued message keeps its full answer window", async (t) => {
  const f = await fixture(t);
  const busy = syntheticRun(plannerId, 1, {
    status: "running",
    completedAt: null,
  });
  f.planner.runs.push(busy);
  f.openEscalation();
  await waitFor(
    () => f.delivery()?.state === "queued",
    checkMs,
    "a queued planner message",
  );
  assert.equal(f.activity().state, "nucleus");
  assert.match(f.activity().detail, /Queued behind the planner/);
  const [command] = f.commands();
  assert.ok(command);
  const [previous, queued] = f.planner.runs;
  assert.equal(previous.id, busy.id);
  assert.equal(previous.status, "running");
  assert.equal(queued.userMessageId, command.messageId);

  await delay(500);
  assert.ok(
    !f.store
      .eventsAll(`delegation:${command.commandId}`)
      .some((event) => event.kind === "delegated_closed"),
  );
  previous.status = "completed";
  queued.status = "running";
  queued.startedAt = new Date().toISOString();
  await waitFor(
    () => f.delivery()?.state === "started",
    checkMs,
    "the queued message's turn",
  );
  assert.equal(f.delivery()?.runId, queued.id);
  assert.equal(f.activity().detail, "Waiting for a planner decision");
  assert.deepEqual(
    f.server.commands.map((row) => row.type),
    ["message.dispatch"],
  );
});

test("a proved pre-send refusal retries the recorded planner message without changing its identity", async (t) => {
  const f = await fixture(t);
  f.planner.thread.snoozedUntil = new Date(Date.now() + 60_000).toISOString();
  f.openEscalation();
  await waitFor(
    () => f.delivery()?.state === "refused",
    checkMs,
    "the planner's snooze fence",
  );
  assert.match(f.delivery()?.detail ?? "", /snoozed until/);
  assert.deepEqual(f.commands(), []);
  f.planner.thread.snoozedUntil = null;
  await waitFor(
    () => f.delivery()?.state === "started",
    checkMs,
    "the retried planner message",
  );
  assert.equal(f.delivery()?.attempt, 2);
  const [command] = f.commands();
  assert.ok(command);
  assert.equal(f.commands().length, 1);
  assert.ok(
    f.updates().every((record) => record.messageId === command.commandId),
  );
});

test("an exhausted pre-send retry advances to the verified project planner under the same occurrence", async (t) => {
  const f = await fixture(t);
  f.store.upsertProject({
    key: "synthetic",
    name: "Synthetic",
    repositories: [{ origin: null, path: f.dir }],
  });
  f.store.setProjectPlanner({
    key: "synthetic",
    agentId: formatAgentId(f.host.hostId, projectPlannerId),
    setBy: "operator",
  });
  f.planner.thread.snoozedUntil = new Date(Date.now() + 60_000).toISOString();
  f.openEscalation();
  await waitFor(
    () => f.delivery()?.state === "started",
    checkMs,
    "the second planner rung",
  );
  const [command] = f.commands();
  assert.ok(command);
  assert.equal(f.commands().length, 1);
  assert.equal(command.threadId, projectPlannerId);
  const updates = f.updates();
  assert.deepEqual(
    updates
      .filter((record) => record.state === "refused")
      .map((record) => record.attempt),
    [1, 2, 3],
  );
  assert.equal(new Set(updates.map((record) => record.occurrence)).size, 1);
  assert.equal(new Set(updates.map((record) => record.messageId)).size, 2);
});

test("after restart an unknown delivery is looked up by its original command and message, even when a newer run is visible", async (t) => {
  const f = await fixture(t);
  f.server.controls.postEffectDefect = true;
  f.server.controls.mutationObserver = () => {
    f.server.controls.projectionMissing.push(plannerId);
  };
  f.openEscalation();
  await waitFor(
    () => f.delivery()?.state === "unknown",
    checkMs,
    "the lost planner acceptance",
  );
  assert.match(f.activity().detail, /Waiting on the host/);
  const [command] = f.commands();
  assert.ok(command);
  await f.engine.stop();

  const reopened = new Store(f.store.path);
  const restarted = f.start(reopened);
  try {
    restarted.resolution.ladder.resumeDelegations(reopened.task(f.id));
    await delay(500);
    assert.equal(f.delivery(reopened)?.state, "unknown");
    assert.equal(f.commands().length, 1);
    const original = f.planner.runs[0];
    original.status = "completed";
    original.completedAt = new Date().toISOString();
    f.planner.turnItems.push({
      type: "user_message",
      messageId: command.messageId,
      runId: original.id,
    });
    f.planner.runs.push(
      syntheticRun(plannerId, 2, { status: "running", completedAt: null }),
    );
    f.server.controls.projectionMissing = [];
    await waitFor(
      () => f.delivery(reopened)?.state === "started",
      checkMs,
      "the original run read back",
    );
    assert.equal(f.delivery(reopened)?.runId, original.id);
    assert.equal(f.delivery(reopened)?.messageId, command.commandId);
    assert.equal(f.delivery(reopened)?.nativeMessageId, command.messageId);
    assert.deepEqual(f.commands(), [command]);
    assert.equal(
      reopened
        .eventsAll(`delegation:${command.commandId}`)
        .filter((event) => event.kind === "delegated_delivery").length,
      1,
    );
  } finally {
    await restarted.stop();
    reopened.close();
  }
});

function plannerLadder(
  t: TestContext,
  store: Store,
  dir: string,
  hostId: string,
  recipient: string,
) {
  store.setMeta("hostId", hostId);
  const planner = formatAgentId(hostId, recipient);
  const task = store.insert(
    submission({ repoPath: dir, originAgentId: planner }),
    hostId,
    "Handoff",
    "a".repeat(40),
  );
  store.update(task.id, {
    phase: "blocked",
    plannerAgentId: planner,
    originHostId: hostId,
  });
  const question = "How should the task proceed?";
  return {
    start(db: Store, adapter: Adapter, resume = false) {
      const engine = new Engine(db, adapter, 0);
      engine.resolution.delegatedAnswerWaitMs = 50;
      t.after(() => engine.stop());
      if (resume) engine.resolution.ladder.resumeDelegations(db.task(task.id));
      else
        engine.resolution.openPlannerEscalation(db.task(task.id), {
          cause: digest("Synthetic dependency stopped"),
          runId: null,
          question,
          payload: { question },
        });
      return engine;
    },
    delivery(db = store) {
      const event = db
        .eventsAll(task.id)
        .findLast((row) => row.kind === PLANNER_DELIVERY_EVENT);
      return event ? readPlannerDelivery(event.detail) : null;
    },
    activity() {
      const row = store.task(task.id);
      return taskActivity({
        task: row,
        stop: row.resolution.stop,
        events: store.eventsAll(task.id),
        runs: [],
        now: Date.now(),
      });
    },
  };
}

test("Paseo restores an unsent busy-planner question and looks up its exact turn after a lost send response", async (t) => {
  const { store, dir } = tempStore(t);
  const hostId = "synthetic-paseo";
  let busy = true;
  let readExact = false;
  const sends: string[] = [];
  const entries: Array<
    ReturnType<typeof AgentTimelineEntryPayloadSchema.parse>
  > = [];
  const adapter = new PaseoAdapter(
    "ws://127.0.0.1:1",
    join(dir, "callback.sock"),
    join(dir, "worker-report.mjs"),
  );
  t.after(() => adapter.close());
  Object.assign(adapter, {
    api: {
      agents: {
        ref: () => ({
          refresh: async () => true,
          current: () => ({ title: "Planner" }),
          get status() {
            return busy ? "running" : "idle";
          },
          get activeTurn() {
            return busy ? { turnId: "earlier-turn" } : null;
          },
          timeline: {
            refetch: async () => ({
              entries: readExact ? entries : [],
              error: null,
              hasOlder: true,
              gap: false,
              reset: false,
              staleCursor: false,
            }),
          },
          async send(text: string, options: { messageId: string }) {
            assert.deepEqual(
              Object.keys(options),
              ["messageId"],
              "the native queue has no steer or interrupt flag",
            );
            sends.push(options.messageId);
            entries.push(
              AgentTimelineEntryPayloadSchema.parse({
                provider: "codex",
                item: {
                  type: "user_message",
                  clientMessageId: options.messageId,
                  text,
                },
                turnId: "question-turn",
                timestamp: new Date().toISOString(),
                seqStart: 4,
                seqEnd: 4,
                sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }],
                collapsed: [],
              }),
            );
            throw Error("Synthetic response lost after send");
          },
        }),
      },
    },
  });
  const ladder = plannerLadder(t, store, dir, hostId, plannerId);
  const first = ladder.start(store, adapter);
  await waitFor(
    () => ladder.delivery()?.state === "queued",
    checkMs,
    "Paseo planner queue",
  );
  assert.match(ladder.activity().detail, /Queued behind the planner/);
  await delay(150);
  assert.deepEqual(sends, []);
  await first.stop();
  const reopened = new Store(store.path);
  const resumed = ladder.start(reopened, adapter, true);
  try {
    busy = false;
    await waitFor(
      () => ladder.delivery(reopened)?.state === "unknown",
      checkMs,
      "lost Paseo receipt",
    );
    assert.deepEqual(sends, [ladder.delivery()?.messageId]);
    readExact = true;
    await waitFor(
      () => ladder.delivery(reopened)?.state === "started",
      checkMs,
      "the original Paseo timeline entry",
    );
    assert.equal(ladder.delivery(reopened)?.runId, "question-turn");
    assert.equal(sends.length, 1);
  } finally {
    await resumed.stop();
    reopened.close();
  }
});

test("BB delivers a busy external planner's question on idle and recovers the original late receipt", async (t) => {
  const { store, dir } = tempStore(t);
  const fake = bbFake();
  const id = "thr_planner";
  const row = bbWire("list", {
    id,
    status: "active",
    runtime: { displayStatus: "active" },
    hasPendingInteraction: false,
  });
  fake.rows.set(id, row);
  const hostId = "bb:synthetic";
  let acknowledge = () => {};
  const late = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const adapter = createBbHostAdapter(
    hostId,
    () => true,
    dir,
    store,
    async (operation, args) => {
      const response = await fake.operations.execute(operation, args);
      if (operation === "thread.send")
        throw Object.assign(Error("Synthetic acknowledgement delayed"), {
          late: late.then(() => response),
        });
      return response;
    },
  );
  const ladder = plannerLadder(t, store, dir, hostId, id);
  ladder.start(store, adapter);
  const sends = () =>
    fake.calls.filter(({ method }) => method === "threads.send");
  await waitFor(
    () => ladder.delivery()?.state === "queued",
    checkMs,
    "BB planner queue",
  );
  assert.match(ladder.activity().detail, /Queued behind the planner/);
  await delay(150);
  assert.deepEqual(sends(), []);
  row.status = "idle";
  row.runtime.displayStatus = "idle";
  await waitFor(
    () => ladder.delivery()?.state === "unknown",
    checkMs,
    "the original BB send",
  );
  acknowledge();
  await waitFor(
    () => ladder.delivery()?.state === "accepted",
    checkMs,
    "BB send receipt",
  );
  assert.equal(sends().length, 1);
  assert.equal(sends()[0]?.args.mode, "queue-if-active");
  assert.equal(
    sends()[0]?.args.pluginSubmission.data.messageId,
    ladder.delivery()?.messageId,
  );
});
