import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  Store,
  operationIdForKey,
  operationInputHash,
} from "../core/store/store";
import { Engine } from "../core/engine";
import { enginePorts } from "../core/port-context";
import { HostPass } from "../core/scheduling/host-pass";
import type { Adapter, AgentObservation } from "../core/host";
import { fakeAdapter, submission, observeIdle } from "./support/fakes";
import { catchUpFinishedTaskThreads } from "../core/workspaces/thread-archive";
import { hostDependents } from "../core/host/host-dependents";
import { queueOperationSchema } from "../shared/operations";

/**
 * nucleus#1257: one host's audit steps are their own owner. A step that throws is
 * recorded as `hostPassError` and never stops the host's later steps, so a silent
 * host pass cannot pass for a clean one.
 */
type Loose = Record<string, any>;
const HOST = "host-1";

function fixture(t: TestContext, adapter: Loose) {
  const store = new Store(":memory:");
  const engine = new Engine(store, adapter as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  const hostPass = new HostPass(
    enginePorts(
      engine,
      [
        "adapter",
        "host",
        "inventoryHostMatches",
        "observeRetiredWorkers",
        "retiredObservationKey",
        "retiredObservationPlan",
        "store",
      ],
      ["observationTargets"],
    ),
  );
  return { store, engine, hostPass };
}

test("a step that throws is recorded and the host's later steps still run", async (t) => {
  const ran: string[] = [];
  const adapter = {
    reconcileReportedSettlements: async () => {
      ran.push("settlements");
    },
    reconcileThreadTitles: () => {
      ran.push("titles");
      throw new Error("titles fault");
    },
    reconcileSettledThreads: async () => {
      ran.push("settled");
    },
  };
  const f = fixture(t, adapter);

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));

  assert.deepEqual(
    ran,
    ["settlements", "titles", "settled"],
    "the client steps run in order, past the failure",
  );
  assert.equal(
    String(f.store.getMeta("hostPassError")),
    `${HOST}/reconcileThreadTitles: titles fault`,
  );
  assert.equal(result.inventory, null);
  assert.equal(result.finishedCatchUp.size, 0);
});

test("a clean pass records no failure and answers the inventory it read", async (t) => {
  const observations = new Map<string, AgentObservation>([
    ["agent-1", { active: true } as AgentObservation],
  ]);
  const f = fixture(t, { observationInventory: async () => observations });
  f.engine.resolution.observationTargets = () => ["agent-1"];

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));

  assert.equal(
    f.store.getMeta("hostPassError"),
    undefined,
    "a clean pass writes no failure",
  );
  assert.equal(result.inventory, observations);
  assert.equal(result.transportAnswered, true, "the host answered its pass");
});

/**
 * Spec 066 C2 (R1/R6): the pass's own reading of a host. A step that fails at the
 * transport boundary means the host did not answer, even while the registry claims
 * a connection — the reading is the failure, not the claim — and a host's own
 * failure never answers for another host's wait.
 */
test("a step that fails at the transport boundary answers nothing for that host and nothing for another", async (t) => {
  const ran: string[] = [];
  const f = fixture(t, {
    reconcileReportedSettlements: async () => {
      const host = f.engine.activeHostId;
      if (host === HOST)
        throw new Error(`Transport not connected: host ${host} is unavailable`);
    },
    reconcileThreadTitles: () => {
      ran.push("titles");
    },
    reconcileSettledThreads: async () => {
      ran.push("settled");
    },
  });

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.equal(
    result.transportAnswered,
    false,
    "a connected claim is not an answer",
  );
  assert.deepEqual(
    ran,
    ["titles", "settled"],
    "the host's later steps still run",
  );
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /reconcileReportedSettlements: Transport not connected/,
  );

  // The next host's pass is its own reading, and the previous failure is not carried.
  const other = await f.engine.withHost("host-2", () =>
    f.hostPass.run("host-2"),
  );
  assert.equal(
    other.transportAnswered,
    true,
    "one host's transport failure never answers for another",
  );
});

test("terminal history is observed and superseded once on an archive-only host", async (t) => {
  let active = false;
  let activeTaskId = "";
  const adapter = fakeAdapter({
    originAgent: async (id: string) =>
      id === "gone"
        ? null
        : { id, workspaceId: "ws", title: "", archived: false },
    observe: async (id: string) => {
      if (id === "gone") throw Error("Thread absent");
      return {
        ...(await observeIdle("ws")(id)),
        active,
        labels: { "northstar.task": id === "active" ? activeTaskId : taskId },
      };
    },
    archiveAgent: async () =>
      assert.fail("an active thread must not be archived"),
  });
  const f = fixture(t, adapter);
  f.store.setMeta("paused", false);
  const initial = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  const taskId = initial.id;
  f.store.update(taskId, {
    phase: "done",
    agentId: "gone",
    resolution: { ...initial.resolution, mergedCommit: "b".repeat(40) },
  });
  const at = new Date().toISOString();
  const payload = {
    type: "task_control",
    control: { action: "restart", taskId, version: initial.version },
  };
  const key = "terminal-control";
  f.store.putOperation(
    queueOperationSchema.parse({
      id: operationIdForKey(key),
      key,
      kind: "task_control",
      inputHash: operationInputHash(payload),
      state: "needs_attention",
      taskId,
      hostId: HOST,
      createdAt: at,
      attempts: 1,
      effect: {
        kind: "task_control",
        target: "restart",
        intentAt: at,
        status: "uncertain",
      },
    }),
    payload,
  );
  const pass = () => f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  const first = await pass();
  assert.ok(first.finishedCatchUp.has(taskId));
  await catchUpFinishedTaskThreads(f.store, adapter, taskId);
  assert.equal(f.store.threadArchiveEffect("gone", HOST)?.status, "archived");
  assert.equal(
    f.store
      .eventsAll(taskId)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
  assert.equal(
    f.store
      .eventsAll(taskId)
      .filter((event) => event.kind === "thread_archive_observed").length,
    1,
  );
  assert.equal(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (item) => item.kind === "effect",
    ),
    false,
  );
  await pass();
  await catchUpFinishedTaskThreads(f.store, adapter, taskId);
  assert.equal(
    f.store
      .eventsAll(taskId)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
  assert.equal(
    f.store
      .eventsAll(taskId)
      .filter((event) => event.kind === "thread_archive_observed").length,
    1,
  );

  const other = f.store.insert(
    submission({ submissionId: "active-thread" }),
    HOST,
    "handoff",
    "a".repeat(40),
  );
  f.store.update(other.id, {
    phase: "done",
    agentId: "active",
    resolution: { ...other.resolution, mergedCommit: "b".repeat(40) },
  });
  activeTaskId = other.id;
  active = true;
  await catchUpFinishedTaskThreads(f.store, adapter, other.id);
  assert.equal(f.store.threadArchiveEffect("active", HOST), undefined);
  assert.ok(
    f.store
      .finishedTasksOwingThreadCleanup(HOST, false)
      .some((task) => task.id === other.id),
  );
});

test("terminal submit binds only its matching submission; cleanup controls stay visible", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const submitted = submission();
  const task = f.store.insert(submitted, HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, {
    phase: "done",
    resolution: { ...task.resolution, mergedCommit: "b".repeat(40) },
  });
  const at = new Date().toISOString();
  const payload = { type: "submit", submission: submitted };
  const key = `submit:${submitted.submissionId}`;
  const accepted = f.store.acceptOperation({
    key,
    kind: "submit",
    submissionId: submitted.submissionId,
    inputHash: operationInputHash(payload),
    payload,
  });
  assert.ok("accepted" in accepted);
  const op = accepted.operation;
  f.store.putOperation({ ...op, state: "needs_attention", attempts: 1 });
  const control = {
    type: "task_control",
    control: { action: "retry_effect", taskId: task.id, version: task.version },
  };
  const controlKey = "cleanup-control";
  f.store.putOperation(
    queueOperationSchema.parse({
      id: operationIdForKey(controlKey),
      key: controlKey,
      kind: "task_control",
      inputHash: operationInputHash(control),
      state: "needs_attention",
      taskId: task.id,
      hostId: HOST,
      createdAt: at,
      attempts: 1,
      effect: {
        kind: "task_control",
        target: "retry_effect",
        intentAt: at,
        status: "uncertain",
      },
    }),
    control,
  );
  const pass = () => f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  await pass();
  assert.equal(f.store.operation(op.id)?.taskId, task.id);
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
  assert.deepEqual(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).find(
      (item) => item.kind === "effect",
    )?.names,
    [`task control for ${f.store.numberFor(task.id)?.reference ?? task.id}`],
  );
  await pass();
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
});

test("a readable unlabelled archived thread settles, while an unreadable one waits", async (t) => {
  const f = fixture(
    t,
    fakeAdapter({
      observe: async (id) => ({
        ...(await observeIdle("ws")(id)),
        active: id === "live",
        labels: {},
      }),
      originAgent: async (id) => {
        if (id === "unknown") throw Error("offline");
        return { id, workspaceId: "ws", title: "", archived: true };
      },
    }),
  );
  f.store.setMeta("paused", false);
  for (const id of ["archived", "unknown", "live"]) {
    const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
    f.store.update(task.id, {
      phase: "done",
      agentId: id,
      resolution: { ...task.resolution, mergedCommit: "b".repeat(40) },
    });
    await catchUpFinishedTaskThreads(f.store, f.engine.adapter, task.id);
    await catchUpFinishedTaskThreads(f.store, f.engine.adapter, task.id);
    assert.equal(
      f.store.threadArchiveEffect(id, HOST)?.status,
      id === "archived" ? "archived" : undefined,
    );
    assert.equal(
      f.store
        .eventsAll(task.id)
        .filter((event) => event.kind === "thread_archive_observed").length,
      id === "archived" ? 1 : 0,
    );
  }
});

test("terminal operation pages advance past an unprovable submission", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const input = submission();
  const task = f.store.insert(input, HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, {
    phase: "done",
    resolution: { ...task.resolution, mergedCommit: "b".repeat(40) },
  });
  const wrong = {
    type: "submit",
    submission: { ...input, title: "different" },
  };
  const key = `submit:${input.submissionId}`;
  const accepted = f.store.acceptOperation({
    key,
    kind: "submit",
    submissionId: input.submissionId,
    hostId: HOST,
    inputHash: operationInputHash(wrong),
    payload: wrong,
  });
  assert.ok("accepted" in accepted);
  f.store.putOperation({
    ...accepted.operation,
    state: "needs_attention",
    attempts: 1,
  });
  const at = new Date().toISOString();
  for (let i = 0; i < 25; i++) {
    const control = {
      type: "task_control",
      control: { action: "restart", taskId: task.id, version: task.version },
    };
    const controlKey = `page-${i}`;
    f.store.putOperation(
      queueOperationSchema.parse({
        id: operationIdForKey(controlKey),
        key: controlKey,
        kind: "task_control",
        inputHash: operationInputHash(control),
        state: "needs_attention",
        taskId: task.id,
        hostId: HOST,
        createdAt: at,
        attempts: 1,
        effect: {
          kind: "task_control",
          target: "restart",
          intentAt: at,
          status: "uncertain",
        },
      }),
      control,
    );
  }
  const pass = () => f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  await pass();
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    24,
  );
  await pass();
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    25,
  );
  assert.equal(f.store.operation(accepted.operation.id)?.taskId, null);
  assert.ok(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true })
      .find((item) => item.kind === "effect")
      ?.names.includes("submit"),
  );
});
