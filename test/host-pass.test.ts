import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  Store,
  operationIdForKey,
  operationInputHash,
  qualifiedThreadArchiveEffectKey,
} from "../core/store/store";
import { Engine } from "../core/engine";
import { enginePorts } from "../core/port-context";
import { HostPass } from "../core/scheduling/host-pass";
import type {
  Adapter,
  AgentObservation,
  ParentArchiveWait,
} from "../core/host";
import { fakeAdapter, submission, observeIdle } from "./support/fakes";
import { catchUpFinishedTaskThreads } from "../core/workspaces/thread-archive";
import { archiveProbeKey } from "../core/workspaces/thread-archive-effect";
import { hostDependents } from "../core/host/host-dependents";
import {
  operationStateLabel,
  queueOperationSchema,
} from "../shared/operations";
import { recoveryEffects } from "../core/recovery/recovery-effects";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { runSchema } from "../shared/contracts";
import { holdPatch } from "../core/merge/merge-hold";

/**
 * nucleus#1257: one host's audit steps are their own owner. A step that throws is
 * recorded as `hostPassError` and never stops the host's later steps, so a silent
 * host pass cannot pass for a clean one.
 */
type Loose = Record<string, any>;
const HOST = "host-1";

function fixture(
  t: TestContext,
  adapter: Loose,
  options: { task?: boolean } = {},
) {
  const store = new Store(":memory:");
  const engine = new Engine(store, adapter as Adapter, 60_000);
  t.after(async () => {
    await engine.stop();
    store.close();
  });
  // The row step visits one task on the host; the other steps here are
  // host-level calls.
  if (options.task)
    store.insert(
      submission({ submissionId: "row-host-pass", title: "Row step" }),
      HOST,
      "handoff",
      "a".repeat(40),
    );
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
        "scheduleLane",
        "stopped",
        "store",
      ],
      ["observationTargets"],
    ),
  );
  return { store, engine, hostPass };
}

/**
 * nucleus#1459: the finished-parent archive is its own terminal step, ahead of every
 * presentation read, so an Inbox, row or title fault never strands a done task's parent
 * and each typed wait is recorded once for the operator.
 */
test("the finished-parent archive step runs before presentation and records its typed waits once", async (t) => {
  const ran: string[] = [];
  const waits: ParentArchiveWait[] = [];
  const f = fixture(
    t,
    {
      reconcileFinishedParents: async () => {
        ran.push("parents");
        return waits;
      },
      reconcileTaskRow: async () => {
        ran.push("rows");
        throw new Error("rows fault");
      },
      reconcileThreadTitles: () => {
        ran.push("titles");
        throw new Error("titles fault");
      },
    },
    { task: true },
  );
  const task = f.store.tasks().find((candidate) => candidate.hostId === HOST)!;
  waits.push({
    taskId: task.id,
    threadId: "thread-parent-1",
    state: "unknown",
    reason: "the parent archive delivery is unknown",
  });

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.deepEqual(
    ran,
    ["parents", "rows", "titles"],
    "the terminal step runs first and the presentation faults never stop it",
  );
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /reconcileThreadTitles: titles fault/,
  );
  const events = f.store
    .events(task.id)
    .filter((event) => event.kind === "parent_archive_uncertain");
  assert.equal(events.length, 1, "the unknown delivery is named on the task");
  assert.match(
    events[0]!.detail,
    /thread-parent-1 \(unknown\): the parent archive delivery is unknown/,
  );
  assert.equal(
    f.store.getMeta("parentArchiveWait:host-1:" + task.id),
    "thread-parent-1 (unknown): the parent archive delivery is unknown",
  );

  // The same wait on the next pass is the same fact: no second event.
  await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.equal(
    f.store
      .events(task.id)
      .filter((event) => event.kind === "parent_archive_uncertain").length,
    1,
  );
  assert.equal(result.callFault, null);
});

test("a finished-parent archive fault stays that step's own and the host still passes", async (t) => {
  const ran: string[] = [];
  const f = fixture(
    t,
    {
      reconcileFinishedParents: async () => {
        ran.push("parents");
        throw new Error("parent archive fault");
      },
      reconcileThreadTitles: () => {
        ran.push("titles");
      },
    },
    { task: true },
  );

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.deepEqual(ran, ["parents", "titles"]);
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /reconcileFinishedParents: parent archive fault/,
  );
  assert.equal(result.callFault, null);
});

test("a step that throws is recorded and the host's later steps still run", async (t) => {
  const ran: string[] = [];
  const adapter = {
    reconcileTaskRow: async () => {
      ran.push("rows");
    },
    reconcileThreadTitles: () => {
      ran.push("titles");
      throw new Error("titles fault");
    },
  };
  const f = fixture(t, adapter, { task: true });

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));

  assert.deepEqual(
    ran,
    ["rows", "titles"],
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
  assert.equal(result.callFault, null, "the host answered its pass");
});

/**
 * Spec 069 §2 (superseding Spec 066 R6): a step that fails at the transport
 * boundary fails only itself. The pass hands it back as the host's call fault, a
 * `degraded` sample for HostHealth, and one host's fault never answers for another.
 */
test("a step that fails at the transport boundary is that host's call fault and nothing for another", async (t) => {
  const ran: string[] = [];
  const f = fixture(
    t,
    {
      reconcileTaskRow: async () => {
        const host = f.engine.activeHostId;
        if (host === HOST)
          throw new Error(
            `Transport not connected: host ${host} is unavailable`,
          );
      },
      reconcileThreadTitles: () => {
        ran.push("titles");
      },
    },
    { task: true },
  );

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.match(
    String(result.callFault),
    /Transport not connected/,
    "the failed step is the host's call fault",
  );
  assert.deepEqual(ran, ["titles"], "the host's later steps still run");
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /reconcileTaskRows: Transport not connected/,
  );

  // The next host's pass is its own reading, and the previous failure is not carried.
  const other = await f.engine.withHost("host-2", () =>
    f.hostPass.run("host-2"),
  );
  assert.equal(
    other.callFault,
    null,
    "one host's transport failure never answers for another",
  );
});

/**
 * nucleus#1469: the observation inventory is optional, so its read used to swallow
 * its own transport loss and leave the host reading as though it answered. It is a
 * host read like any other: a lost transport is this host's call fault for the pass
 * (a HostHealth sample, Spec 069 §2), while an inventory that merely cannot be read
 * is only unavailable. A host that recovers answers its next pass.
 */
test("an inventory that loses the transport is the host's call fault, and the next pass recovers", async (t) => {
  let connected = false;
  const observations = new Map<string, AgentObservation>([
    ["agent-1", { active: true } as AgentObservation],
  ]);
  const f = fixture(t, {
    observationInventory: async () => {
      if (!connected)
        throw new Error(`Transport not connected: host ${HOST} is unavailable`);
      return observations;
    },
  });
  f.engine.resolution.observationTargets = () => ["agent-1"];

  const lost = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.ok(
    lost.callFault,
    "an inventory transport loss is the host's call fault, not an empty answer",
  );
  assert.equal(
    lost.inventory,
    null,
    "and nothing is answered for the identities it holds",
  );
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /observationInventory: Transport not connected/,
  );

  connected = true;
  const recovered = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.equal(
    recovered.callFault,
    null,
    "the returning host answers its own pass",
  );
  assert.equal(
    recovered.inventory,
    observations,
    "with the inventory it could read this time",
  );
});

test("an inventory that cannot be read answers nothing while the host still answers its pass", async (t) => {
  const f = fixture(t, {
    observationInventory: async () => {
      throw new Error("thread list ended before its last page");
    },
  });
  f.engine.resolution.observationTargets = () => ["agent-1"];

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.equal(
    result.callFault,
    null,
    "an unreadable list is unavailability, not a host fault",
  );
  assert.equal(
    result.inventory,
    null,
    "and every identity takes the narrow read instead",
  );
  assert.match(
    String(f.store.getMeta("hostPassError")),
    /observationInventory: thread list ended before its last page/,
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
  const controlTask = f.store.insert(
    submission(),
    HOST,
    "handoff",
    "a".repeat(40),
  );
  f.store.update(controlTask.id, {
    phase: "done",
    resolution: { ...controlTask.resolution, mergedCommit: "b".repeat(40) },
  });
  const at = new Date().toISOString();
  const payload = {
    type: "task_control",
    control: {
      action: "restart",
      taskId: controlTask.id,
      version: controlTask.version,
    },
  };
  const key = "terminal-control";
  f.store.putOperation(
    queueOperationSchema.parse({
      id: operationIdForKey(key),
      key,
      kind: "task_control",
      inputHash: operationInputHash(payload),
      state: "needs_attention",
      taskId: controlTask.id,
      hostId: HOST,
      createdAt: at,
      startedAt: at,
      settledAt: at,
      expectedVersion: controlTask.version,
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
      .eventsAll(controlTask.id)
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
      .eventsAll(controlTask.id)
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
    recoveryEffects(f.store, f.store.task(task.id), {
      kinds: ["operation"],
    }).find((effect) => effect.identity === op.id)?.state,
    "superseded",
  );
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
  assert.match(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).find(
      (item) => item.kind === "effect",
    )!.names[0]!,
    /task control.*settlement lacks proof/,
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
  let labelTaskId = "";
  const f = fixture(
    t,
    fakeAdapter({
      observe: async (id) => ({
        ...(await observeIdle("ws")(id)),
        active: id === "live",
        status: ["archived", "labelled"].includes(id) ? "unknown" : "idle",
        labels:
          id === "labelled"
            ? { "northstar.task": labelTaskId }
            : ({} as Record<string, string>),
      }),
      originAgent: async (id) => {
        if (id === "unknown") throw Error("offline");
        return { id, workspaceId: "ws", title: "", archived: true };
      },
    }),
  );
  f.store.setMeta("paused", false);
  for (const id of ["archived", "labelled", "unknown", "live"]) {
    const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
    f.store.update(task.id, {
      phase: "done",
      agentId: id,
      resolution: { ...task.resolution, mergedCommit: "b".repeat(40) },
    });
    if (id === "labelled") labelTaskId = task.id;
    await catchUpFinishedTaskThreads(f.store, f.engine.adapter, task.id);
    await catchUpFinishedTaskThreads(f.store, f.engine.adapter, task.id);
    assert.equal(
      f.store.threadArchiveEffect(id, HOST)?.status,
      ["archived", "labelled"].includes(id) ? "archived" : undefined,
    );
    assert.equal(
      f.store
        .eventsAll(task.id)
        .filter((event) => event.kind === "thread_archive_observed").length,
      ["archived", "labelled"].includes(id) ? 1 : 0,
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
        startedAt: at,
        settledAt: at,
        expectedVersion: task.version,
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
      ?.names.some((name) => name.startsWith("submit:")),
  );
});

test("legacy submissions settle while a live restart target remains owed", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const submitted = submission();
  const task = f.store.insert(submitted, HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, {
    phase: "done",
    resolution: { ...task.resolution, mergedCommit: "b".repeat(40) },
  });
  const { scope, ...rest } = submitted;
  const payload = {
    type: "submit",
    submission: { ...rest, capability: scope },
  };
  const key = `submit:${submitted.submissionId}`;
  const accepted = f.store.acceptOperation({
    key,
    kind: "submit",
    submissionId: submitted.submissionId,
    hostId: HOST,
    inputHash: operationInputHash(payload),
    payload,
  });
  assert.ok("accepted" in accepted);
  f.store.putOperation({
    ...accepted.operation,
    state: "needs_attention",
    attempts: 1,
  });
  const at = new Date().toISOString();
  f.store.putRun(
    runSchema.parse({
      id: "live-run",
      taskId: task.id,
      hostId: HOST,
      role: "revision",
      generation: 1,
      agentId: "live-agent",
      workspaceId: "ws",
      status: "running",
      released: false,
      head: "a".repeat(40),
      base: "a".repeat(40),
      profile: null,
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      createdAt: at,
    }),
  );
  const control = {
    type: "task_control",
    control: { action: "restart", taskId: task.id, version: task.version },
  };
  const controlKey = "live-restart";
  const restart = f.store.putOperation(
    queueOperationSchema.parse({
      id: operationIdForKey(controlKey),
      key: controlKey,
      kind: "task_control",
      inputHash: operationInputHash(control),
      state: "needs_attention",
      taskId: task.id,
      hostId: HOST,
      expectedVersion: task.version,
      createdAt: at,
      startedAt: at,
      settledAt: at,
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
  const pass = () => f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  await pass();
  assert.equal(f.store.operation(accepted.operation.id)?.taskId, task.id);
  const effects = recoveryEffects(f.store, f.store.task(task.id), {
    kinds: ["operation"],
  });
  assert.equal(
    effects.find((effect) => effect.identity === accepted.operation.id)?.state,
    "superseded",
  );
  assert.equal(
    effects.find((effect) => effect.identity === restart.id)?.state,
    "uncertain",
  );
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
  await pass();
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    1,
  );
});

test("a stale worker completion does not settle an untracked current restart", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, {
    phase: "done",
    agentId: "current-agent",
    runId: "current-run",
    completion: {
      taskId: task.id,
      runId: "old-run",
      eventId: "old",
      status: "ready_for_review",
      summary: "old result",
    },
    resolution: { ...task.resolution, mergedCommit: "b".repeat(40) },
  });
  const at = new Date().toISOString();
  const control = {
    type: "task_control",
    control: { action: "restart", taskId: task.id, version: task.version },
  };
  const key = "restart-with-stale-completion";
  const op = f.store.putOperation(
    queueOperationSchema.parse({
      id: operationIdForKey(key),
      key,
      kind: "task_control",
      inputHash: operationInputHash(control),
      state: "needs_attention",
      taskId: task.id,
      hostId: HOST,
      expectedVersion: task.version,
      createdAt: at,
      startedAt: at,
      settledAt: at,
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
  await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.equal(
    recoveryEffects(f.store, f.store.task(task.id), {
      kinds: ["operation"],
    }).find((effect) => effect.identity === op.id)?.state,
    "uncertain",
  );
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "operation_superseded").length,
    0,
  );
});

test("an unreadable finished thread names its wait on Hosts and task next", async (t) => {
  let unavailable = true;
  const adapter = fakeAdapter({
    observe: async () => {
      throw Error("synthetic host offline");
    },
    originAgent: async () => {
      if (unavailable) throw Error("synthetic host offline");
      return null;
    },
  });
  const f = fixture(t, adapter);
  f.store.setMeta("paused", false);
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, {
    phase: "done",
    agentId: "worker",
    workspaceId: "ws",
    directory: "/synthetic/ws",
    prHead: "b".repeat(40),
    resolution: {
      ...task.resolution,
      mergedCommit: "b".repeat(40),
      syncedCommit: "b".repeat(40),
      archivedWorkspaceIds: ["ws"],
    },
  });
  const inspect = () =>
    ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(task.id)));
  await catchUpFinishedTaskThreads(f.store, adapter, task.id);
  await catchUpFinishedTaskThreads(f.store, adapter, task.id);
  const entry =
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true })
      .find((item) => item.kind === "effect")
      ?.names.join(" ") ?? "";
  assert.match(entry, /synthetic host offline/);
  assert.match(entry, /waiting for the host observation/);
  const retry = inspect().verbs.filter((view) => view.verb === "retry_effect");
  assert.ok(
    retry.some(
      (view) =>
        !view.available &&
        /synthetic host offline/.test(view.refusal ?? "") &&
        /host observation/.test(view.refusal ?? ""),
    ),
  );
  assert.ok(
    !retry.some(
      (view) => view.available && view.args?.effect === "workspace_archive.ws",
    ),
  );
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((event) => event.kind === "thread_archive_wait").length,
    1,
  );
  unavailable = false;
  await catchUpFinishedTaskThreads(f.store, adapter, task.id);
  assert.equal(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (item) => item.kind === "effect",
    ),
    false,
  );
  assert.ok(
    !inspect().verbs.some((view) =>
      (view.refusal ?? "").includes("synthetic host offline"),
    ),
  );
});

test("an exhausted thread archive names the existing workspace retry only when eligible", async (t) => {
  const adapter = fakeAdapter({
    observe: async () => {
      throw Error("synthetic host offline");
    },
    originAgent: async () => {
      throw Error("synthetic host offline");
    },
  });
  const f = fixture(t, adapter);
  f.store.setMeta("paused", false);
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, {
    phase: "done",
    agentId: "worker",
    workspaceId: "ws",
    directory: "/synthetic/ws",
    prHead: "b".repeat(40),
    resolution: {
      ...task.resolution,
      mergedCommit: "b".repeat(40),
      syncedCommit: "b".repeat(40),
    },
  });
  const key = f.store.threadArchiveKey("worker", HOST)!;
  f.store.putThreadArchiveEffect(key, "worker", {
    status: "ready",
    at: new Date().toISOString(),
    retries: 3,
  });
  await catchUpFinishedTaskThreads(f.store, adapter, task.id);
  const entry =
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true })
      .find((item) => item.kind === "effect")
      ?.names.join(" ") ?? "";
  assert.match(entry, /retry_effect workspace_archive\.ws/);
  assert.match(entry, /synthetic host offline/);
  const views = ownerTaskNext(
    collectOwnerVerbFacts(f.store, f.store.task(task.id)),
  ).verbs;
  const retry = views.find(
    (view) =>
      view.verb === "retry_effect" &&
      view.available &&
      view.args?.effect === "workspace_archive.ws",
  );
  assert.ok(retry);
  assert.match(String(retry.args?.summary), /synthetic host offline/);
});

test("a failed archive read after an idle observation shows its effect detail in both views", async (t) => {
  let unavailable = true;
  let taskId = "";
  const adapter = fakeAdapter({
    observe: async (id) => ({
      ...(await observeIdle("ws")(id)),
      labels: { "northstar.task": taskId },
    }),
    originAgent: async () => {
      if (unavailable) throw Error("synthetic archive read unavailable");
      return null;
    },
    archiveAgent: async () =>
      assert.fail("an unavailable archive read must not send"),
  });
  const f = fixture(t, adapter);
  f.store.setMeta("paused", false);
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  taskId = task.id;
  f.store.update(task.id, {
    phase: "done",
    agentId: "worker",
    workspaceId: "ws",
    directory: "/synthetic/ws",
    prHead: "b".repeat(40),
    resolution: {
      ...task.resolution,
      mergedCommit: "b".repeat(40),
      syncedCommit: "b".repeat(40),
      archivedWorkspaceIds: ["ws"],
    },
  });
  const next = () =>
    ownerTaskNext(collectOwnerVerbFacts(f.store, f.store.task(task.id)));
  for (let pass = 0; pass < 2; pass++) {
    await catchUpFinishedTaskThreads(f.store, adapter, task.id);
    assert.equal(
      f.store.getMeta(archiveProbeKey(f.store, task.id, "worker")),
      undefined,
    );
    const effect = f.store.getMeta<{ status: string; detail?: string }>(
      f.store.threadArchiveKey("worker", HOST)!,
    );
    assert.equal(effect?.status, "ready");
    assert.match(effect?.detail ?? "", /synthetic archive read unavailable/);
    const names =
      hostDependents(f.store, { id: HOST, kind: "paseo", primary: true })
        .find((item) => item.kind === "effect")
        ?.names.join(" ") ?? "";
    assert.match(names, /synthetic archive read unavailable/);
    assert.ok(
      next().verbs.some(
        (view) =>
          view.verb === "retry_effect" &&
          !view.available &&
          /synthetic archive read unavailable/.test(view.refusal ?? "") &&
          /host observation/.test(view.refusal ?? ""),
      ),
    );
  }
  unavailable = false;
  await catchUpFinishedTaskThreads(f.store, adapter, task.id);
  assert.equal(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (item) => item.kind === "effect",
    ),
    false,
  );
  assert.ok(
    !next().verbs.some((view) =>
      (view.refusal ?? "").includes("synthetic archive read unavailable"),
    ),
  );
});

test("engine sweep settles live-shaped terminal and retained operations past history", async (t) => {
  const f = fixture(t, fakeAdapter({ hostProcessListing: async () => [] }));
  const initial = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  for (let i = 0; i < 80; i++)
    f.store.update(initial.id, { reason: `version ${i}` });
  f.store.update(initial.id, {
    phase: "done",
    agentId: "legacy-worker",
    runId: "legacy-run",
  });
  const at = "2026-11-18T05:09:58.694Z";
  const end = "2026-11-18T05:10:04.311Z";
  f.store.putThreadArchiveEffect(
    qualifiedThreadArchiveEffectKey(HOST, "legacy-worker"),
    "legacy-worker",
    { status: "archived", at: end },
  );
  f.store.queueRunProcessCleanup({
    id: "legacy-run",
    taskId: initial.id,
    hostId: HOST,
  });
  for (let i = 0; i < 75; i++) {
    const key = `history-${i}`;
    f.store.putOperation(
      queueOperationSchema.parse({
        id: operationIdForKey(key),
        key,
        kind: "submit",
        inputHash: operationInputHash({}),
        state: "succeeded",
        hostId: HOST,
        createdAt: at,
      }),
      {},
    );
  }
  const payload = {
    type: "task_control",
    control: { action: "restart", taskId: initial.id, version: 77 },
  };
  const key = "old-restart";
  const operation = queueOperationSchema.parse({
    id: operationIdForKey(key),
    key,
    kind: "task_control",
    inputHash: operationInputHash(payload),
    state: "needs_attention",
    taskId: initial.id,
    expectedVersion: 77,
    createdAt: at,
    startedAt: at,
    settledAt: end,
    attempts: 1,
    diagnostic: "Transport",
    result: null,
    hostId: HOST,
    effect: {
      kind: "task_control",
      target: "restart",
      intentAt: at,
      status: "uncertain",
      result: "Transport",
    },
  });
  f.store.putOperation(operation, payload);
  const ids: string[] = [];
  for (const [i, kind, diagnostic] of [
    [
      0,
      "task_control",
      "Task execution participants or effects are not settled: publication is uncertain",
    ],
    [1, "submit", "Liveness check timed out (15000ms)"],
    [2, "submit", "Transport not connected"],
  ] as const) {
    const input = submission();
    const task = f.store.insert(input, HOST, "handoff", "a".repeat(40));
    const row = f.store.db
      .prepare("SELECT input_hash FROM tasks WHERE id=?")
      .get(task.id)!;
    f.store.db.prepare("INSERT INTO tombstones VALUES(?,?,?,?)").run(
      task.id,
      input.submissionId,
      row.input_hash,
      JSON.stringify({
        id: task.id,
        submissionId: input.submissionId,
        phase: "done",
      }),
    );
    f.store.db.prepare("DELETE FROM tasks WHERE id=?").run(task.id);
    const payload =
      kind === "submit"
        ? { type: "submit", submission: input }
        : {
            type: "task_control",
            control: {
              taskId: task.id,
              version: 88,
              action: "move",
              to: "closeout",
            },
          };
    const key =
      kind === "submit" ? `submit:${input.submissionId}` : `move-${i}`;
    const op = queueOperationSchema.parse({
      id: operationIdForKey(key),
      key,
      kind,
      inputHash: operationInputHash(payload),
      state: "needs_attention",
      taskId: kind === "submit" ? null : task.id,
      submissionId: kind === "submit" ? input.submissionId : null,
      expectedVersion: kind === "submit" ? null : 88,
      hostId: HOST,
      createdAt: at,
      startedAt: at,
      settledAt: end,
      attempts: 1,
      diagnostic,
      effect:
        kind === "submit"
          ? null
          : {
              kind: "task_control",
              target: "move",
              intentAt: at,
              status: "uncertain",
              result: diagnostic,
            },
    });
    ids.push(op.id);
    f.store.putOperation(op, payload);
  }
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(
    f.store
      .eventsAll(initial.id)
      .filter((e) => e.kind === "operation_superseded").length,
    1,
  );
  const refused = f.store.operation(ids[0]!)!;
  assert.equal(refused.settlement?.kind, "refused");
  const repeated = f.store.acceptOperation({
    key: refused.key,
    kind: refused.kind,
    inputHash: refused.inputHash,
    payload: f.store.operationPayload(refused.id),
  });
  assert.ok("accepted" in repeated);
  assert.deepEqual(repeated.operation, refused);
  for (const id of ids.slice(1)) {
    const op = f.store.operation(id)!;
    assert.ok(op.taskId);
    assert.equal(
      f.store
        .eventsAll(op.taskId!)
        .filter((e) => e.kind === "operation_superseded").length,
      1,
    );
  }
  assert.equal(
    f.store.getMeta<{ pending: boolean }>("runProcessCleanup:legacy-run")
      ?.pending,
    false,
  );
  assert.equal(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (x) => x.kind === "effect",
    ),
    false,
  );
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(
    f.store
      .eventsAll(initial.id)
      .filter((e) => e.kind === "operation_superseded").length,
    1,
  );
  for (const id of ids.slice(1))
    assert.equal(
      f.store
        .eventsAll(f.store.operation(id)!.taskId!)
        .filter((e) => e.kind === "operation_superseded").length,
      1,
    );
  // An older event-only settlement is migrated by ordinary retention too.
  f.store.putOperation({
    ...f.store.operation(operation.id)!,
    settlement: undefined,
  });
  // Normal retention removes the task events, but never the operation's evidence.
  assert.ok(
    f.store.purgeOldTasks(Date.now() + 15 * 86400000).includes(initial.id),
  );
  assert.equal(f.store.eventsAll(initial.id).length, 0);
  assert.equal(
    f.engine.operationStatus(operation.id).settlement?.kind,
    "superseded",
  );
  assert.equal(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (x) => x.kind === "effect",
    ),
    false,
  );
});

test("sweep leaves conflicting tombstone and unreadable process ownership visible", async (t) => {
  const f = fixture(t, fakeAdapter({ hostProcessListing: async () => null }));
  const input = submission();
  const task = f.store.insert(input, HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, { phase: "done", runId: "pending-run" });
  f.store.setMeta("runProcessCleanup:pending-run", {
    id: "pending-run",
    taskId: task.id,
    hostId: HOST,
    pending: true,
    uncertainty: JSON.stringify({
      reason: "process environment ownership is unreadable",
      processes: [],
    }),
  });
  const removed = submission();
  const removedTask = f.store.insert(removed, HOST, "handoff", "a".repeat(40));
  f.store.db.prepare("INSERT INTO tombstones VALUES(?,?,?,?)").run(
    removedTask.id,
    removed.submissionId,
    "conflicting-digest",
    JSON.stringify({
      id: removedTask.id,
      submissionId: removed.submissionId,
      phase: "done",
    }),
  );
  f.store.db.prepare("DELETE FROM tasks WHERE id=?").run(removedTask.id);
  const payload = { type: "submit", submission: removed };
  const key = `submit:${removed.submissionId}`;
  const op = queueOperationSchema.parse({
    id: operationIdForKey(key),
    key,
    kind: "submit",
    inputHash: operationInputHash(payload),
    state: "needs_attention",
    submissionId: removed.submissionId,
    hostId: HOST,
    createdAt: "2026-11-18T05:09:58.694Z",
    attempts: 1,
    diagnostic: "Transport not connected",
  });
  f.store.putOperation(op, payload);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  const names = hostDependents(f.store, {
    id: HOST,
    kind: "paseo",
    primary: true,
  }).find((x) => x.kind === "effect")!.names;
  assert.ok(
    names.some(
      (name) => name.includes("settlement lacks proof") && name.includes(op.id),
    ),
  );
  assert.ok(
    names.some(
      (name) =>
        name.includes("process table observation is unavailable") &&
        name.includes("pending-run"),
    ),
  );
  assert.equal(f.store.operation(op.id)?.taskId, null);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(
    f.store
      .eventsAll(removedTask.id)
      .filter((e) => e.kind === "operation_superseded").length,
    0,
  );
});

test("a restart without a recorded start time remains visible with its missing proof", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, { phase: "done" });
  const payload = {
    type: "task_control",
    control: { action: "restart", taskId: task.id, version: task.version },
  };
  const key = "missing-start-time";
  const op = queueOperationSchema.parse({
    id: operationIdForKey(key),
    key,
    kind: "task_control",
    inputHash: operationInputHash(payload),
    state: "needs_attention",
    taskId: task.id,
    expectedVersion: task.version,
    hostId: HOST,
    createdAt: "2026-11-18T05:09:58.694Z",
    settledAt: "2026-11-18T05:10:04.311Z",
    attempts: 1,
    diagnostic: "Transport",
    effect: {
      kind: "task_control",
      target: "restart",
      intentAt: "2026-11-18T05:09:58.694Z",
      status: "uncertain",
      result: "Transport",
    },
  });
  f.store.putOperation(op, payload);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(f.store.operation(op.id)?.settlement, undefined);
  assert.ok(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true })
      .find((x) => x.kind === "effect")
      ?.names.some((x) => x.includes("operation start time is missing")),
  );
});

test("a reasonless scratch cleanup records the retirement guard on the engine sweep", async (t) => {
  const f = fixture(t, fakeAdapter({ hostProcessListing: async () => [] }));
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  (
    f.store as unknown as { runScratchRemover: (path: string) => boolean }
  ).runScratchRemover = () => false;
  f.store.update(task.id, {
    phase: "done",
    runId: "guarded-run",
    temporaryDirectory: "/synthetic/guarded",
  });
  f.store.setMeta("runProcessCleanup:guarded-run", {
    id: "guarded-run",
    taskId: task.id,
    hostId: HOST,
    temporaryDirectory: "/synthetic/guarded",
    pending: true,
  });
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  const names = hostDependents(f.store, {
    id: HOST,
    kind: "paseo",
    primary: true,
  }).find((x) => x.kind === "effect")!.names;
  assert.ok(
    names.some(
      (x) =>
        x.includes("scratch retirement was refused") &&
        x.includes("inspect the scratch retirement guard"),
    ),
  );
  // The maintenance pass must preserve pending cleanup and its ownership facts.
  assert.ok(
    !f.store.purgeOldTasks(Date.now() + 15 * 86400000).includes(task.id),
  );
  assert.equal(
    f.store.getMeta<{ pending: boolean }>("runProcessCleanup:guarded-run")
      ?.pending,
    true,
  );
  assert.ok(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (x) => x.kind === "effect",
    ),
  );
  const before = f.store
    .eventsAll(task.id)
    .filter((x) => x.kind === "run_process_cleanup_deferred").length;
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((x) => x.kind === "run_process_cleanup_deferred").length,
    before,
  );
  (
    f.store as unknown as { runScratchRemover: (path: string) => boolean }
  ).runScratchRemover = () => true;
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(
    f.store.getMeta<{ pending: boolean }>("runProcessCleanup:guarded-run")
      ?.pending,
    false,
  );
  assert.ok(
    f.store.purgeOldTasks(Date.now() + 15 * 86400000).includes(task.id),
  );
});

test("a control without a task identity names the missing binding", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  const payload = {
    type: "task_control",
    control: { action: "move", taskId: "unknown", version: 88 },
  };
  const key = "unbound-control";
  const op = queueOperationSchema.parse({
    id: operationIdForKey(key),
    key,
    kind: "task_control",
    inputHash: operationInputHash(payload),
    state: "needs_attention",
    hostId: HOST,
    createdAt: "2026-11-18T05:09:58.694Z",
    attempts: 1,
    diagnostic: "Task execution participants or effects are not settled",
  });
  f.store.putOperation(op, payload);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(f.store.operation(op.id)?.settlement, undefined);
  assert.ok(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true })
      .find((x) => x.kind === "effect")
      ?.names.some((x) => x.includes("operation task identity is missing")),
  );
});

test("a bound submission stays settled after its task is retained", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const input = submission();
  const task = f.store.insert(input, HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, { phase: "done" });
  const payload = { type: "submit", submission: input };
  const key = `submit:${input.submissionId}`;
  const op = queueOperationSchema.parse({
    id: operationIdForKey(key),
    key,
    kind: "submit",
    inputHash: operationInputHash(payload),
    state: "needs_attention",
    taskId: task.id,
    submissionId: input.submissionId,
    hostId: HOST,
    createdAt: "2026-11-18T05:09:58.694Z",
    attempts: 1,
    diagnostic: "Transport",
  });
  f.store.putOperation(op, payload);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(f.engine.operationStatus(op.id).settlement?.kind, "superseded");
  assert.ok(
    f.store.purgeOldTasks(Date.now() + 15 * 86400000).includes(task.id),
  );
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(f.engine.operationStatus(op.id).settlement?.kind, "superseded");
  assert.equal(
    hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (x) => x.kind === "effect",
    ),
    false,
  );
});

test("settled submission stops blocking project removal but mismatched proof stays a blocker", async (t) => {
  const f = fixture(t, fakeAdapter({}));
  const project = f.store.upsertProject({
    key: "fixture-project",
    name: "Fixture",
    repositories: [{ path: "/repo", origin: null }],
  });
  const input = submission();
  const task = f.store.insert(input, HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, { phase: "done" });
  const payload = { type: "submit", submission: input };
  const key = `submit:${input.submissionId}`;
  const op = queueOperationSchema.parse({
    id: operationIdForKey(key),
    key,
    kind: "submit",
    inputHash: operationInputHash(payload),
    state: "needs_attention",
    taskId: task.id,
    submissionId: input.submissionId,
    repoPath: input.repoPath,
    hostId: HOST,
    createdAt: "2026-11-18T05:09:58.694Z",
    attempts: 1,
    diagnostic: "Transport",
  });
  f.store.putOperation(op, payload);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  const settled = f.store.operation(op.id)!;
  assert.equal(operationStateLabel(settled), "Submission superseded");
  assert.ok(
    !f.store
      .projectManagementPreview({ key: project.key })
      .items.some((x) => x.kind === "operation"),
  );
  f.store.putOperation({
    ...settled,
    settlement: { ...settled.settlement!, attempt: 2 },
  });
  const blocked = f.store.projectManagementPreview({ key: project.key });
  assert.ok(
    blocked.items.some((x) => x.kind === "operation" && x.id === op.id),
  );
  assert.equal(
    operationStateLabel(f.store.operation(op.id)!),
    "Submission needs attention",
  );
  assert.throws(
    () =>
      f.store.manageRemoveProject({
        key: project.key,
        version: project.version,
        digest: blocked.digest,
        reason: "fixture",
      }),
    /operations must settle/,
  );
  f.store.putOperation(settled);
  const preview = f.store.projectManagementPreview({ key: project.key });
  f.store.manageRemoveProject({
    key: project.key,
    version: project.version,
    digest: preview.digest,
    reason: "fixture",
  });
  assert.equal(f.store.projectByKey(project.key), null);
});

test("an unavailable process table does not create cleanup intents for unrecorded history", async (t) => {
  const f = fixture(t, fakeAdapter({ hostProcessListing: async () => null }));
  const task = f.store.insert(submission(), HOST, "handoff", "a".repeat(40));
  f.store.update(task.id, { phase: "done" });
  f.store.db
    .prepare("UPDATE tasks SET data=json_set(data,'$.runId',?) WHERE id=?")
    .run("historical-run", task.id);
  assert.equal(f.store.getMeta("runProcessCleanup:historical-run"), undefined);
  await f.engine.sweepOnce();
  await f.engine.quiesce();
  assert.equal(f.store.getMeta("runProcessCleanup:historical-run"), undefined);
  assert.equal(
    f.store
      .eventsAll(task.id)
      .filter((x) => x.kind === "run_process_cleanup_deferred").length,
    0,
  );
  assert.ok(
    !hostDependents(f.store, { id: HOST, kind: "paseo", primary: true }).some(
      (x) => x.kind === "effect",
    ),
  );
});

/**
 * nucleus#1419: one host pass sows the planner's own hold, its nudge and the
 * planner's answer in this order, so the row this same pass presents already reads
 * the escalation the pass just recorded. The hold itself is never touched.
 */
test("a planner's hold is snoozed until its nudge goes unanswered, in the same pass", async (t) => {
  const seen: string[] = [];
  const now = Date.now();
  const startedAt = new Date(now - 3 * 60 * 60_000).toISOString();
  const f = fixture(
    t,
    {
      reconcileTaskRow: async (
        _taskId: string,
        attention: { state: string },
      ) => {
        seen.push(attention.state);
      },
      rowSnoozeVisibility: async (taskId: string) => ({
        kind: "snoozed" as const,
        threadId: `thread-${taskId}`,
        episodeStartedAt: startedAt,
        cause: "Held by planner",
      }),
    },
    { task: true },
  );
  const task = f.store.tasks()[0]!;
  f.store.update(task.id, { phase: "needs_attention" });
  f.store.update(
    task.id,
    // The task's planner is its owner ("origin"), so this fence is its own park.
    holdPatch(
      f.store.task(task.id),
      "dispatch",
      "origin",
      "Approved, waiting for Effigy v0.15",
      null,
    ),
  );

  // A quiet task behind the planner's own hold: the row is snoozed, not shown.
  await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.deepEqual(seen, ["waiting"], "the planner's own hold parks the row");

  // The nudge reached the planner an hour ago and the answer window has closed.
  const fence = f.store.task(task.id).holds!.dispatch!;
  const noticeId = `row-hidden-hold:${task.id}:dispatch:1`;
  f.store.putNotice({
    id: noticeId,
    taskId: task.id,
    agentId: "origin",
    recipientAgentId: "",
    workspaceId: null,
    sources: [],
    originEntry: true,
    kind: "row_hidden",
    status: "delivered",
    error: "",
    text: "Nucleus: a hold still hides a task row on T3",
  });
  f.store.update(task.id, {
    holds: {
      dispatch: {
        ...fence,
        plannerAnswer: {
          since: startedAt,
          dueAt: new Date(now - 2 * 60 * 60_000).toISOString(),
          noticeId,
          deliveredAt: new Date(now - 60 * 60_000).toISOString(),
          unansweredAt: null,
          deliveryFault: "",
        },
      },
    },
  });
  seen.length = 0;
  await f.engine.withHost(HOST, () => f.hostPass.run(HOST));
  assert.deepEqual(
    seen,
    ["attention"],
    "the pass escalates the hold and presents the row again in one pass",
  );
  assert.ok(
    f.store
      .events(task.id)
      .some((event) => event.kind === "row_hidden_hold_unanswered"),
    "the escalation is recorded as the reason the row is visible",
  );
  assert.deepEqual(
    {
      generation: f.store.task(task.id).holdGeneration,
      reason: f.store.task(task.id).holdReason,
      held: f.store.task(task.id).held,
    },
    { generation: 1, reason: "Approved, waiting for Effigy v0.15", held: true },
    "the hold is never released because a timer fired",
  );
});
