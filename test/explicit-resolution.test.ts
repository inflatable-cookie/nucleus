import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { git } from "../core/git/index";
import { readGitCheckout } from "../core/git/git-identity";
import { formatAgentId } from "../shared/agent-identity";
import {
  OPERATOR_BOARD_CALLER,
  REVISION_BUDGET,
  runSchema,
  submissionSchema,
  taskControlTaskSchema,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import { runSettlementFence } from "../core/intake/run-settlement";
import { executionParticipants } from "../core/machine/execution-participants";
import { plannerEscalations } from "../core/questions/ladder/records";
import { blockingRecoveryEffects } from "../core/recovery/recovery-effects";
import { operationInputHash } from "../core/store/store";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
} from "../core/verbs/owner-verbs";
import { taskControlOperation } from "../core/verbs/task-control-key";
import { QueueRuntime } from "../service/runtime-owner";
import { callCatalogueMethod } from "../service/transport/dispatch";
import { profile } from "./support/fakes";

const head = "a".repeat(40);
const host = "paseo-fixture";
const repo = "/example";
const planner = formatAgentId(host, "live-planner");

async function fixture(
  t: TestContext,
  adapterOverrides: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "explicit-resolution-"));
  const calls: string[] = [];
  const adapter = {
    hostId: host,
    socketPath: join(root, "callback.sock"),
    helperPath: join(root, "helper.mjs"),
    client: { isConnected: true },
    isConnected: () => true,
    supportsCoordinatorRecovery: true,
    connect: async () => {},
    close: async () => {},
    catalog: async () => ({ providers: [] }),
    listLiveAgents: async () => [
      {
        id: "live-planner",
        title: "Planner",
        directory: repo,
        workspaceId: null,
      },
    ],
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: id === "retired-planner",
    }),
    stopAgentTurn: async (id: string) => {
      calls.push(`stop ${id}`);
    },
    archiveAgent: async (id: string) => {
      calls.push(`archive ${id}`);
    },
    createRun: async (
      _task: unknown,
      r: { id: string; role: string; head: string; workspaceId: string },
    ) => {
      calls.push(`create ${r.role} ${r.head.slice(0, 8)}`);
      return {
        id: `${r.role}-agent-${r.id.slice(0, 8)}`,
        workspaceId: r.workspaceId || "workspace",
      };
    },
    continueRun: async (
      r: { id: string; role: string; agentId: string | null },
      _msgId: string,
      text: string,
    ) => {
      calls.push(`continue ${r.role} ${r.agentId}: ${text.slice(0, 40)}`);
    },
    steerOrNotify: async (agentId: string, _msgId: string, text: string) => {
      calls.push(`steer ${agentId}: ${text.slice(0, 40)}`);
    },
    ...adapterOverrides,
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: join(root, "nucleus"),
    adapterFactory: () => adapter,
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  });
  const store = runtime.store;
  store.setMeta("paused", true);
  await runtime.ensureBootstrap();
  store.upsertProject({
    key: "example",
    name: "Example",
    repositories: [{ origin: null, path: repo }],
  });
  store.setProjectPlanner({
    key: "example",
    agentId: formatAgentId(host, "retired-planner"),
    setBy: "operator",
  });
  const task = store.insert(
    submissionSchema.parse({
      submissionId: "fixture",
      title: "Fixture",
      repoPath: repo,
      planningCommit: head,
      handoffPath: "handoff.md",
      originAgentId: "owner",
    }),
    host,
    "Handoff",
    head,
  );
  const current = () => store.task(task.id);
  const run = (
    id: string,
    role: "reviewer" | "recovery" | "revision",
    agentId: string | null,
  ) =>
    runSchema.parse({
      id,
      role,
      agentId,
      taskId: task.id,
      hostId: host,
      workspaceId: "workspace",
      status: agentId ? "running" : "uncertain",
      generation: 1,
      head,
      base: head,
      profile: null,
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      idleSince: null,
      active: agentId ? true : null,
      completion: null,
      released: false,
    });
  const command = async (args: Record<string, unknown>) =>
    taskControlTaskSchema.parse(
      await callCatalogueMethod(runtime, "queue.task", {
        reference: task.reference,
        version: current().version,
        caller: OPERATOR_BOARD_CALLER,
        reason: "Settle the recorded occurrence",
        ...args,
      }),
    );
  const audit = () =>
    store
      .eventsAll(task.id)
      .filter((event) => event.kind === "owner_resolution");
  return { root, adapter, store, current, run, command, audit, calls, runtime };
}

test("run.release changes an agentless reviewer's durable fence and revokes its credential", async (t) => {
  const { store, current, run, command, audit, calls } = await fixture(t);
  const reviewer = run("review-run", "reviewer", null);
  store.putRun(reviewer);
  store.setCredential(reviewer.id, "test-secret");
  store.update(current().id, {
    phase: "reviewing",
    prHead: head,
    resolution: { ...current().resolution, currentRunId: reviewer.id },
  });
  assert.match(
    runSettlementFence({ store, task: current() }, reviewer) ?? "",
    /uncertain/,
  );

  const version = current().version;
  const args = { action: "run.release", run: reviewer.id };
  const probe = await command(args);
  assert.deepEqual(
    probe.explicitResolution?.warnings.map((x) => x.id),
    ["live_turn", "unreported_result"],
  );
  assert.equal(probe.version, version);
  assert.equal(
    (await command({ ...args, accept: ["live_turn"] })).explicitResolution
      ?.status,
    "warnings",
  );
  assert.equal(audit().length, 0);

  const result = await command({
    ...args,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(result.explicitResolution?.status, "applied");
  assert.match(result.explicitResolution?.next ?? "", /scheduler/);
  assert.equal(result.phase, "reviewing");
  assert.equal(current().resolution.currentRunId, null);
  assert.equal(store.run(reviewer.id)?.released, true);
  assert.equal(
    runSettlementFence({ store, task: current() }, store.run(reviewer.id)!),
    null,
  );
  assert.throws(
    () => store.authenticate(reviewer.id, "test-secret"),
    /unauthorized/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(audit().length, 1);
  assert.deepEqual(JSON.parse(audit()[0].detail).accepted, [
    "live_turn",
    "unreported_result",
  ]);
  const stale = await command({
    ...args,
    version,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(stale.explicitResolution?.status, "stale");
  assert.equal(stale.version, result.version);
  assert.equal(audit().length, 1);
});

test("ordinary reviewer routing resumes after one release and one effect clear", async (t) => {
  const { store, current, run, command, calls, runtime } = await fixture(t);
  const reviewer = run("review-run", "reviewer", null);
  store.putRun(reviewer);
  store.update(current().id, {
    phase: "reviewing",
    prHead: head,
    workspaceId: reviewer.workspaceId,
    resolution: { ...current().resolution, currentRunId: reviewer.id },
  });
  runtime.engine.profiles = [profile("next-reviewer")];
  store.setMeta("pool", [
    {
      profileId: "next-reviewer",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);
  const task = current();
  const route = {
    action: "route" as const,
    role: "reviewer" as const,
    profileId: "next-reviewer",
    now: true,
    reason: "Choose a reviewer route",
  };
  const { payload, key } = taskControlOperation({
    ...route,
    taskId: task.id,
    version: task.version,
  });
  const accepted = store.acceptOperation({
    key,
    kind: "task_control",
    taskId: task.id,
    inputHash: operationInputHash(payload),
    payload,
  });
  assert.ok("operation" in accepted);
  const operation = store.putOperation({
    ...accepted.operation,
    state: "needs_attention",
    diagnostic: "Delivery unknown",
    effect: {
      kind: "task_control",
      target: "route",
      status: "uncertain",
      intentAt: new Date().toISOString(),
      result: null,
      resultAt: null,
    },
  });

  assert.match(
    runSettlementFence({ store, task }, reviewer) ?? "",
    /uncertain/,
  );
  await assert.rejects(
    command(route),
    new RegExp(`operation ${operation.id} is uncertain`),
  );
  const released = await command({
    action: "run.release",
    run: reviewer.id,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(released.explicitResolution?.status, "applied");
  const clear = {
    action: "record.clear",
    kind: "effect",
    id: `task_control_operation.${operation.id}`,
    caller: planner,
  };
  assert.equal(
    (await command(clear)).explicitResolution?.warnings[0].id,
    "effect_may_land",
  );
  assert.equal(
    (await command({ ...clear, accept: ["effect_may_land"] }))
      .explicitResolution?.status,
    "applied",
  );
  assert.equal(store.operation(operation.id)?.state, "failed");

  const routed = await command(route);
  assert.equal(routed.phase, "awaiting_review");
  assert.equal(routed.profileRequests?.reviewer?.profileId, "next-reviewer");
  assert.deepEqual(
    store.runs(task.id).map((run) => [run.id, run.released]),
    [[reviewer.id, true]],
  );
  assert.deepEqual(calls, []);
});

test("record.clear supersedes a notice and keeps late delivery evidence from restoring the fence", async (t) => {
  const { store, current, command, audit } = await fixture(t);
  const task = current();
  store.putNotice({
    id: "notice",
    taskId: task.id,
    agentId: "owner",
    text: "Delivery unknown",
    status: "uncertain",
    error: "",
    kind: "attention",
    recipientAgentId: "",
    workspaceId: null,
    sources: [],
    originEntry: true,
  });
  const blockers = () =>
    blockingRecoveryEffects(store, current()).map((effect) => effect.identity);
  assert.deepEqual(blockers(), ["notice"]);
  const args = {
    action: "record.clear",
    kind: "effect",
    id: "attention-notice.notice",
    caller: planner,
  };
  assert.equal(
    (await command(args)).explicitResolution?.warnings[0].id,
    "effect_may_land",
  );
  assert.equal(
    (await command({ ...args, accept: ["effect_may_land"] })).explicitResolution
      ?.status,
    "applied",
  );
  assert.deepEqual(blockers(), []);
  store.putNotice({
    ...store.notices(task.id)[0]!,
    status: "uncertain",
    error: "Late response",
  });
  assert.equal(store.notices(task.id)[0]?.status, "superseded");
  assert.ok(
    audit().every(
      (event) => JSON.parse(event.detail).source === "project_planner",
    ),
  );
});

test("run.release cancels a current revision on the retained worker thread", async (t) => {
  const { store, current, run, command, calls } = await fixture(t);
  const revision = run("revision-run", "revision", "worker");
  store.putRun(revision);
  store.update(current().id, {
    phase: "working",
    agentId: revision.agentId,
    runId: "original-worker",
    workspaceId: revision.workspaceId,
    resolution: { ...current().resolution, currentRunId: revision.id },
  });
  const result = await command({
    action: "run.release",
    run: revision.id,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(result.explicitResolution?.status, "applied");
  assert.deepEqual(calls, ["stop worker"]);
  assert.equal(result.agentId, revision.agentId);
  assert.equal(result.runId, "original-worker");
  assert.equal(result.resolution.currentRunId, null);
});

test("run.release leaves another live revision using the same thread alone", async (t) => {
  const { store, current, run, command, calls } = await fixture(t);
  const older = run("old-revision", "revision", "worker");
  const newer = run("new-revision", "revision", "worker");
  store.putRun(older);
  store.putRun(newer);
  store.update(current().id, {
    phase: "working",
    agentId: newer.agentId,
    runId: "original-worker",
    workspaceId: newer.workspaceId,
    resolution: { ...current().resolution, currentRunId: newer.id },
  });
  const result = await command({
    action: "run.release",
    run: older.id,
    archive: true,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(result.explicitResolution?.status, "applied");
  assert.deepEqual(calls, []);
  assert.equal(result.resolution.currentRunId, newer.id);
  assert.equal(store.run(newer.id)?.released, false);
});

test("the coordinator can release or clear its task records within its authority", async (t) => {
  const { store, current, run, command, audit, calls } = await fixture(t);
  const coordinator = run("recovery-run", "recovery", "coordinator");
  const reviewer = run("review-run", "reviewer", "reviewer");
  store.putRun(coordinator);
  store.putRun(reviewer);
  store.update(current().id, {
    resolution: {
      ...current().resolution,
      currentRunId: reviewer.id,
      recoveryActive: true,
      recovery: {
        id: "episode",
        key: "key",
        generation: 1,
        runId: coordinator.id,
        agentId: coordinator.agentId,
        status: "running",
        summary: "Mechanical stop",
        idleSince: null,
        incidentId: null,
      },
    },
  });
  const caller = formatAgentId(host, "coordinator");
  const release = {
    action: "run.release",
    run: reviewer.id,
    archive: true,
    caller,
    accept: ["live_turn", "unreported_result"],
  };
  const hold = { action: "record.clear", kind: "hold", id: "dispatch", caller };
  store.update(current().id, {
    holds: {
      dispatch: {
        owner: planner,
        reason: "Planner hold",
        at: new Date().toISOString(),
        generation: 1,
        until: null,
      },
    },
  });
  assert.equal(
    (await command(hold)).explicitResolution?.warnings[0].id,
    "hold_owner",
  );
  await assert.rejects(
    command({ ...hold, accept: ["hold_owner"] }),
    /only the live responsible planner/i,
  );
  await assert.rejects(
    command({ ...release, caller: formatAgentId(host, "reviewer") }),
    /requires this task's coordinator/,
  );
  await assert.rejects(
    command({ ...release, run: "other-task-run" }),
    /belongs to this task/,
  );
  store.update(current().id, { critical: true });
  await assert.rejects(command(release), /critical task/);
  assert.equal(audit().length, 0);
  assert.deepEqual(calls, []);
  assert.equal(
    (await command({ ...hold, caller: OPERATOR_BOARD_CALLER }))
      .explicitResolution?.status,
    "warnings",
  );
  assert.equal(
    (
      await command({
        ...hold,
        caller: OPERATOR_BOARD_CALLER,
        accept: ["hold_owner"],
      })
    ).explicitResolution?.status,
    "applied",
  );
  store.update(current().id, { critical: false });
  assert.equal((await command(release)).explicitResolution?.status, "applied");
  assert.equal(
    executionParticipants(current(), store.runs(current().id)).has("reviewer"),
    false,
  );
  assert.deepEqual(calls, ["stop reviewer", "archive reviewer"]);
});

test("record.clear retires an owned-tool hold and a stale escalation without using its snapshot", async (t) => {
  const { store, current, command, runtime } = await fixture(t);
  const id = "prior-escalation";
  const taskId = current().id;
  store.event(
    taskId,
    "owned_tool_hold",
    JSON.stringify({ runId: "old", reason: "unreadable timeline" }),
  );
  store.event(
    taskId,
    "planner_escalation",
    `${id}: cause blocked-tool; run old`,
  );
  store.event(
    taskId,
    "planner_escalation_payload",
    `${id}: ${JSON.stringify({ id, runId: "old", binding: "old snapshot" })}`,
  );
  runtime.engine.resolution.waiting(
    current(),
    "The text was edited",
    "escalated",
    { fact: { code: "escalation", subject: id } },
  );
  const tool = { action: "record.clear", kind: "effect", id: "owned_tool.old" };
  assert.equal(
    (await command(tool)).explicitResolution?.warnings[0].id,
    "owned_tool",
  );
  await command({ ...tool, accept: ["owned_tool"] });
  assert.ok(
    !ownerPendingEffects(collectOwnerVerbFacts(store, current())).some(
      (effect) => effect.effect === tool.id,
    ),
  );
  assert.equal(
    (await command({ action: "record.clear", kind: "escalation", id }))
      .explicitResolution?.status,
    "applied",
  );
  assert.equal(plannerEscalations(store.eventsAll(taskId))[0]?.answered, true);
  assert.equal(current().resolution.stop, null);
});

test("a new task reason keeps its own fact when a resolution update carries an older stop", async (t) => {
  const { store, current, runtime } = await fixture(t);
  runtime.engine.resolution.waiting(
    current(),
    "Waiting for the slot",
    "lifecycle",
    { fact: { code: "integration_turn" } },
  );
  const task = current();
  assert.deepEqual(task.reasonFact, { code: "integration_turn" });
  const stop = task.resolution.stop!;
  store.update(task.id, {
    reason: "Waiting for prerequisites: another task",
    resolution: {
      ...task.resolution,
      stop: { ...stop, detail: "The integration turn is still held" },
    },
  });
  assert.deepEqual(current().reasonFact, { code: "prerequisite" });
  assert.deepEqual(current().resolution.stop?.fact, {
    code: "integration_turn",
  });
});

test("praxis#369 / underlay#046: run.start reviewer fresh replacing=<run> resolves uncertain reviewer in one step", async (t) => {
  const { store, current, run, command, audit, calls, runtime } =
    await fixture(t);
  const stuck = run("stuck-reviewer", "reviewer", null);
  store.putRun(stuck);
  store.setCredential(stuck.id, "old-secret");
  store.update(current().id, {
    phase: "reviewing",
    prHead: head,
    workspaceId: "workspace",
    resolution: { ...current().resolution, currentRunId: stuck.id },
  });
  runtime.engine.profiles = [profile("fresh-reviewer")];
  store.setMeta("pool", [
    {
      profileId: "fresh-reviewer",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  const args = {
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: stuck.id,
  };
  const probe = await command(args);
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.deepEqual(
    probe.explicitResolution?.warnings.map((w) => w.id),
    ["duplicate_thread"],
  );
  assert.equal(store.run(stuck.id)?.released, false);
  assert.equal(audit().length, 0);

  const applied = await command({ ...args, accept: ["duplicate_thread"] });
  assert.equal(applied.explicitResolution?.status, "applied");
  const newRunId = applied.explicitResolution?.runId;
  assert.ok(newRunId && newRunId !== stuck.id);
  assert.equal(applied.phase, "reviewing");
  assert.equal(store.run(stuck.id)?.released, true);
  assert.throws(
    () => store.authenticate(stuck.id, "old-secret"),
    /unauthorized/i,
  );
  assert.equal(store.run(newRunId)?.status, "running");
  assert.equal(current().resolution.currentRunId, newRunId);
  assert.ok(
    current().resolution.reviewerAgentId?.startsWith("reviewer-agent-"),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^create reviewer aaaaaaaa$/);
  assert.equal(audit().length, 1);
});

test("#1508: run.start reviewer head=<pushed> warns on head_mismatch and starts at the pushed head", async (t) => {
  const { store, current, command, runtime } = await fixture(t);
  const pushed = "b".repeat(40);
  store.update(current().id, {
    phase: "working",
    prHead: head,
    workspaceId: "workspace",
  });
  runtime.engine.profiles = [profile("rev-1")];
  store.setMeta("pool", [
    {
      profileId: "rev-1",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  const args = { action: "run.start", role: "reviewer", head: pushed };
  const probe = await command(args);
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.deepEqual(
    probe.explicitResolution?.warnings.map((w) => w.id),
    ["head_mismatch"],
  );

  const applied = await command({ ...args, accept: ["head_mismatch"] });
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.phase, "working");
  const created = store.run(applied.explicitResolution!.runId!);
  assert.equal(created?.head, pushed);
  assert.equal(created?.status, "running");
});

test("#1498: run.start worker retained starts a revision run on the bound worker thread", async (t) => {
  const { store, current, command, calls } = await fixture(t);
  store.update(current().id, {
    phase: "changes_requested",
    prHead: head,
    workspaceId: "workspace",
    agentId: "worker-1",
    runId: "initial-worker",
    agentActive: false,
    profile: profile("worker-prof"),
  });
  const applied = await command({
    action: "run.start",
    role: "worker",
    agent: "retained",
    instruction: "Apply the review fix",
  });
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.phase, "changes_requested");
  const created = store.run(applied.explicitResolution!.runId!);
  assert.equal(created?.role, "revision");
  assert.equal(created?.agentId, "worker-1");
  assert.equal(created?.status, "running");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^continue revision worker-1: Apply the review fix/);
});

test("run.start enforces two_writers, budget, and route_policy warnings and coordinator authority", async (t) => {
  const { store, current, run, command, runtime } = await fixture(t);
  const coord = run("coord-run", "recovery", "coordinator");
  store.putRun(coord);
  store.update(current().id, {
    phase: "working",
    prHead: head,
    workspaceId: "workspace",
    agentId: "worker-1",
    runId: "initial-worker",
    agentActive: true,
    profile: profile("worker-prof"),
    profileRequests: {
      worker: {
        profileId: "worker-prof",
        reason: "Need frontier",
        required: false,
        signoff: {
          status: "pending",
          decisionId: "dec-1",
          by: planner,
          at: new Date().toISOString(),
          note: "",
        },
      },
    },
    resolution: {
      ...current().resolution,
      revisionRuns: REVISION_BUDGET,
      recoveryActive: true,
      recovery: {
        id: "ep",
        key: "k",
        generation: 1,
        runId: coord.id,
        agentId: coord.agentId,
        status: "running",
        summary: "Stall",
        idleSince: null,
        incidentId: null,
      },
    },
  });
  runtime.engine.profiles = [profile("worker-prof")];
  store.setMeta("pool", [
    {
      profileId: "worker-prof",
      enabled: true,
      group: "work",
      weight: "default",
      scopes: ["general"],
      roles: ["worker"],
    },
  ]);

  const args = { action: "run.start", role: "worker", agent: "fresh" };
  const probe = await command(args);
  assert.equal(probe.explicitResolution?.status, "warnings");
  const ids = probe.explicitResolution?.warnings.map((w) => w.id) ?? [];
  assert.ok(ids.includes("duplicate_thread"));
  assert.ok(ids.includes("two_writers"));
  assert.ok(ids.includes("budget"));
  assert.ok(ids.includes("route_policy"));

  const coordCaller = formatAgentId(host, "coordinator");
  await assert.rejects(
    command({ ...args, caller: coordCaller, accept: ["two_writers"] }),
    /only the live responsible planner/i,
  );
  await assert.rejects(
    command({ ...args, caller: coordCaller, accept: ["route_policy"] }),
    /only the live responsible planner/i,
  );

  const applied = await command({
    ...args,
    caller: planner,
    accept: ["duplicate_thread", "two_writers", "budget", "route_policy"],
  });
  assert.equal(applied.explicitResolution?.status, "applied");
});

test("phase.set warns on live_runs and writes only phase and reason", async (t) => {
  const { store, current, run, command, audit } = await fixture(t);
  const activeRun = run("rev-1", "reviewer", "reviewer-1");
  store.putRun(activeRun);
  store.update(current().id, {
    phase: "reviewing",
    resolution: { ...current().resolution, currentRunId: activeRun.id },
  });

  const args = {
    action: "phase.set",
    to: "awaiting_review",
    reason: "Reset phase for explicit re-review",
  };
  const probe = await command(args);
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.deepEqual(
    probe.explicitResolution?.warnings.map((w) => w.id),
    ["live_runs"],
  );
  assert.equal(current().phase, "reviewing");

  const applied = await command({ ...args, accept: ["live_runs"] });
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.phase, "awaiting_review");
  assert.equal(applied.reason, "Reset phase for explicit re-review");
  assert.equal(applied.resolution.currentRunId, activeRun.id);
  assert.equal(audit().length, 1);
});

test("message.send warns on queued and no_thread, delivers without changing task state", async (t) => {
  const { store, current, run, command, calls } = await fixture(t);
  const noThread = await command({
    action: "message.send",
    role: "reviewer",
    text: "Please report your verdict",
  });
  assert.equal(noThread.explicitResolution?.status, "warnings");
  assert.deepEqual(
    noThread.explicitResolution?.warnings.map((w) => w.id),
    ["no_thread"],
  );
  const acceptedNoThread = await command({
    action: "message.send",
    role: "reviewer",
    text: "Please report your verdict",
    accept: ["no_thread"],
  });
  assert.equal(acceptedNoThread.explicitResolution?.status, "applied");
  assert.equal(acceptedNoThread.explicitResolution?.delivery, "unknown");

  const rev = run("rev-1", "reviewer", "reviewer-1");
  store.putRun(rev);
  store.update(current().id, {
    phase: "reviewing",
    resolution: {
      ...current().resolution,
      currentRunId: rev.id,
      reviewerAgentId: "reviewer-1",
    },
  });
  const queued = await command({
    action: "message.send",
    role: "reviewer",
    text: "Resend your report now",
  });
  assert.equal(queued.explicitResolution?.status, "warnings");
  assert.deepEqual(
    queued.explicitResolution?.warnings.map((w) => w.id),
    ["queued"],
  );

  const delivered = await command({
    action: "message.send",
    role: "reviewer",
    text: "Resend your report now",
    accept: ["queued"],
  });
  assert.equal(delivered.explicitResolution?.status, "applied");
  assert.equal(delivered.explicitResolution?.delivery, "queued");
  assert.equal(delivered.phase, "reviewing");
  assert.ok(
    calls.some((c) => c.startsWith("steer reviewer-1: Resend your report now")),
  );
});

test("an uncertain-creation stall launches a coordinator that can resolve it with run.start", async (t) => {
  const { store, current, run, command, runtime } = await fixture(t);
  const stuck = run("uncertain-rev", "reviewer", null);
  store.putRun(stuck);
  store.update(current().id, {
    phase: "reviewing",
    prHead: head,
    workspaceId: "workspace",
    resolution: { ...current().resolution, currentRunId: stuck.id },
  });
  runtime.engine.profiles = [profile("coord-prof"), profile("rev-prof")];
  store.setMeta("pool", [
    {
      profileId: "coord-prof",
      enabled: true,
      group: "coord",
      weight: "default",
      scopes: ["general"],
      roles: ["coordinator"],
    },
    {
      profileId: "rev-prof",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);
  store.setMeta("paused", false);

  // Observation records the uncertain creation as a lifecycle stop with creation_lookup fact.
  await runtime.engine.resolution.observe();
  const stopped = current();
  assert.equal(stopped.resolution.stop?.reason, "lifecycle");
  assert.equal(stopped.resolution.stop?.fact?.code, "creation_lookup");
  assert.match(
    stopped.resolution.stop?.detail ?? "",
    /run\.start reviewer fresh replacing=uncertain-rev/,
  );

  // Backdate stop.since past grace so the mechanical stall launches a coordinator.
  store.update(stopped.id, {
    resolution: {
      ...stopped.resolution,
      stop: {
        ...stopped.resolution.stop!,
        since: new Date(Date.now() - 120_000).toISOString(),
      },
    },
  });
  await runtime.engine.withHost(host, () =>
    runtime.engine.resolution.recovery.route(current()),
  );
  const withCoord = current();
  assert.equal(withCoord.resolution.recoveryActive, true);
  assert.ok(
    withCoord.resolution.recovery?.agentId,
    "coordinator launched for uncertain-creation stall",
  );

  // The launched coordinator resolves the stall in one step with run.start.
  const coordCaller = formatAgentId(
    host,
    withCoord.resolution.recovery!.agentId!,
  );
  const resolved = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: stuck.id,
    caller: coordCaller,
    accept: ["duplicate_thread"],
  });
  assert.equal(resolved.explicitResolution?.status, "applied");
  assert.equal(store.run(stuck.id)?.released, true);
  assert.equal(
    store.run(resolved.explicitResolution!.runId!)?.status,
    "running",
  );
});

test("review fixes: reviewer head binds real checkout and updates prHead; retained sendRun installs fresh credential", async (t) => {
  const { root, adapter, store, current, command, runtime } = await fixture(t);
  const remote = join(root, "remote.git");
  const repoDir = join(root, "repo");
  const worktree = join(root, "worktree");
  await git(root, "init", "--bare", remote);
  await git(root, "init", repoDir);
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "Test");
  await git(repoDir, "checkout", "-b", "main");
  writeFileSync(join(repoDir, "a.txt"), "v1\n");
  await git(repoDir, "add", "a.txt");
  await git(repoDir, "commit", "-m", "v1");
  await git(repoDir, "remote", "add", "origin", remote);
  await git(repoDir, "push", "-u", "origin", "main");
  const branch = current().branch;
  await git(repoDir, "worktree", "add", "-b", branch, worktree, "main");
  const firstSha = await git(worktree, "rev-parse", "HEAD");
  writeFileSync(join(worktree, "a.txt"), "v2\n");
  await git(worktree, "add", "a.txt");
  await git(worktree, "commit", "-m", "v2");
  const pushedSha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-u", "origin", branch);
  await git(worktree, "checkout", "--quiet", "--detach", firstSha);

  store.update(current().id, {
    repoPath: repoDir,
    directory: worktree,
    workspaceId: "workspace",
    workspaceIntent: true,
    prHead: firstSha,
    phase: "working",
  });
  runtime.engine.profiles = [profile("rev-1")];
  store.setMeta("pool", [
    {
      profileId: "rev-1",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  const started = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    head: pushedSha,
    accept: ["head_mismatch"],
  });
  assert.equal(started.explicitResolution?.status, "applied");
  assert.equal(current().prHead, pushedSha);
  assert.equal(readGitCheckout(worktree).head, pushedSha);

  // Retained worker uses sendRun with a newly minted credential after prior credential was revoked.
  store.setCredential("old-rev", "revoked-secret");
  store.deleteCredential("old-rev");
  let deliveredToken = "";
  (
    adapter as unknown as {
      sendRun?: (
        task: unknown,
        r: { id: string },
        tok: string,
      ) => Promise<void>;
    }
  ).sendRun = async (_task, _r, tok) => {
    deliveredToken = tok;
  };
  store.update(current().id, {
    phase: "changes_requested",
    agentId: "worker-1",
    runId: "initial-worker",
    agentActive: false,
    profile: profile("w-1"),
  });
  const retained = await command({
    action: "run.start",
    role: "worker",
    agent: "retained",
    instruction: "Fix",
  });
  const revId = retained.explicitResolution!.runId!;
  assert.ok(deliveredToken.length > 0);
  assert.doesNotThrow(() => store.authenticate(revId, deliveredToken));
});

test("review fixes: late createRun acknowledgement does not overwrite replaced reviewer binding", async (t) => {
  const { adapter, store, current, command, runtime } = await fixture(t);
  store.update(current().id, {
    phase: "reviewing",
    prHead: head,
    workspaceId: "workspace",
  });
  runtime.engine.profiles = [profile("rev-1")];
  store.setMeta("pool", [
    {
      profileId: "rev-1",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  let resolveFirst!: (value: { id: string; workspaceId: string }) => void;
  let createCalls = 0;
  adapter.createRun = async (_task, r) => {
    createCalls++;
    if (createCalls === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return { id: `replacement-${r.id.slice(0, 6)}`, workspaceId: "workspace" };
  };

  const firstPromise = command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
  });
  // Wait a tick for the first run to be recorded in intent state.
  await new Promise((r) => setTimeout(r, 20));
  const firstRun = store.runs(current().id)[0]!;
  assert.equal(firstRun.status, "intent");

  const second = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: firstRun.id,
    accept: ["duplicate_thread"],
  });
  const secondRunId = second.explicitResolution!.runId!;
  const replacementAgent = current().resolution.reviewerAgentId;
  assert.ok(replacementAgent?.startsWith("replacement-"));

  resolveFirst({ id: "late-first-agent", workspaceId: "workspace" });
  await firstPromise;

  assert.equal(current().resolution.currentRunId, secondRunId);
  assert.equal(current().resolution.reviewerAgentId, replacementAgent);
  assert.equal(store.run(firstRun.id)?.released, true);
  assert.equal(store.run(firstRun.id)?.status, "superseded");
  assert.equal(store.run(firstRun.id)?.agentId, "late-first-agent");
});

test("review fixes: Spec 052 route_policy applies to selected frontier worker at normal usage level", async (t) => {
  const { store, current, run, command, runtime } = await fixture(t);
  const coord = run("coord-run", "recovery", "coordinator");
  store.putRun(coord);
  store.update(current().id, {
    phase: "working",
    prHead: head,
    workspaceId: "workspace",
    resolution: {
      ...current().resolution,
      recoveryActive: true,
      recovery: {
        id: "ep",
        key: "k",
        generation: 1,
        runId: coord.id,
        agentId: coord.agentId,
        status: "running",
        summary: "Stall",
        idleSince: null,
        incidentId: null,
      },
    },
  });
  runtime.engine.profiles = [profile("frontier-worker")];
  store.setMeta("pool", [
    {
      profileId: "frontier-worker",
      enabled: true,
      group: "frontier",
      weight: "default",
      capability: "frontier",
      scopes: ["general"],
      roles: ["worker"],
    },
  ]);

  const probe = await command({
    action: "run.start",
    role: "worker",
    agent: "fresh",
  });
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.ok(
    probe.explicitResolution?.warnings.some((w) => w.id === "route_policy"),
  );
  await assert.rejects(
    command({
      action: "run.start",
      role: "worker",
      agent: "fresh",
      caller: formatAgentId(host, "coordinator"),
      accept: ["route_policy"],
    }),
    /only the live responsible planner/i,
  );
});

test("review fixes: phase.set preserves stop, message.send warns on queue-only route & active revision, next exposes explicitCommands", async (t) => {
  const queuedCalls: string[] = [];
  const { adapter, store, current, run, command, runtime } = await fixture(t, {
    steerOrNotify: undefined,
    enqueueMessage: async (agentId: string) => {
      queuedCalls.push(agentId);
    },
  });
  const stuck = run("uncertain-rev", "reviewer", null);
  store.putRun(stuck);
  store.update(current().id, {
    phase: "reviewing",
    prHead: head,
    workspaceId: "workspace",
    resolution: { ...current().resolution, currentRunId: stuck.id },
  });
  runtime.engine.resolution.waiting(
    current(),
    "Uncertain reviewer creation",
    "lifecycle",
    {
      fact: { code: "creation_lookup", subject: stuck.id },
    },
  );
  const stopSince = current().resolution.stop!.since;

  // phase.set preserves stop and its since timestamp.
  const moved = await command({
    action: "phase.set",
    to: "awaiting_review",
    accept: ["live_runs"],
  });
  assert.equal(moved.explicitResolution?.status, "applied");
  assert.equal(current().resolution.stop?.since, stopSince);

  // task.next exposes machine-readable explicitCommands.
  const next = runtime.taskNext({ taskId: current().id });
  assert.ok(
    next.explicitCommands?.some(
      (c) => c.action === "run.start" && c.args.replacing === stuck.id,
    ),
  );
  assert.ok(
    next.explicitCommands?.some(
      (c) => c.action === "record.clear" && c.args.kind === "stop",
    ),
  );

  // Queue-only adapter warns queued even when idle, and active revision agent takes precedence over task.agentId.
  const rev = run("active-rev", "revision", "revision-agent");
  store.putRun({ ...rev, active: false });
  store.update(current().id, { agentId: "old-worker", agentActive: false });
  const queueProbe = await command({
    action: "message.send",
    role: "worker",
    text: "Check status",
  });
  assert.equal(queueProbe.explicitResolution?.status, "warnings");
  assert.deepEqual(
    queueProbe.explicitResolution?.warnings.map((w) => w.id),
    ["queued"],
  );
  const queueSent = await command({
    action: "message.send",
    role: "worker",
    text: "Check status",
    accept: ["queued"],
  });
  assert.equal(queueSent.explicitResolution?.delivery, "queued");
  assert.deepEqual(queuedCalls, ["revision-agent"]);

  // Positive binding of an already-existing workspace when workspaceIntent && !workspaceId.
  store.update(current().id, {
    workspaceId: null,
    directory: null,
    workspaceIntent: true,
    phase: "dispatching",
  });
  adapter.findWorkspaces = async () => [
    { id: "existing-ws", directory: "/existing/dir" },
  ];
  const bound = await runtime.engine.withHost(host, () =>
    runtime.engine.recoverExistingWorkspace(current()),
  );
  assert.equal(bound, true);
  assert.equal(current().workspaceId, "existing-ws");
});
