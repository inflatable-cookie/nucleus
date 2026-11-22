import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { publishFormalReview } from "../core/forge/reviews";
import { git } from "../core/git/index";
import { readGitCheckout, readGitRef } from "../core/git/git-identity";
import { hostCatalogSchema } from "../shared/host";
import { composeBbAdapter } from "../service/bb-adapter";
import { emptyBbThreadState } from "../hosts/bb";
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
import {
  sendRunVia,
  type RunSendOwner,
} from "../core/dispatch/run-launch/send";
import { recoveryDispatchSnapshot } from "../core/recovery/recovery-context";
import { ProvenPreSendRefusalError } from "../core/recovery/task-reasons";
import { checkoutRunScratchPlacement } from "../core/workspaces/run-scratch";
import { QueueRuntime } from "../service/runtime-owner";
import { callCatalogueMethod } from "../service/transport/dispatch";
import { profile } from "./support/fakes";

const head = "a".repeat(40);
const host = "paseo-fixture";
const repo = "/example";
const planner = formatAgentId(host, "live-planner");

async function attachGitCheckout(
  root: string,
  store: QueueRuntime["store"],
  taskId: string,
  suffix = "git",
) {
  const baseDir = join(root, suffix);
  const remote = join(baseDir, "remote.git");
  const repoDir = join(baseDir, "repo");
  const worktree = join(baseDir, "worktree");
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
  const task = store.task(taskId);
  await git(repoDir, "worktree", "add", "-b", task.branch, worktree, "main");
  const initialSha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-u", "origin", task.branch);
  store.update(taskId, {
    repoPath: repoDir,
    directory: worktree,
    workspaceId: "workspace",
    workspaceIntent: true,
    prHead: initialSha,
  });
  return { remote, repoDir, worktree, initialSha };
}

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
    createWorkspace: async (tObj: {
      id: string;
      directory: string | null;
    }) => ({
      id: `ws-${tObj.id}-${calls.length}`,
      directory: tObj.directory ?? "",
    }),
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
    sendRun: async (
      _task: unknown,
      r: { id: string; role: string; agentId: string | null },
      _token: string,
      _ctx?: unknown,
      _ownerCtx?: unknown,
      guard?: { allowed: () => Promise<boolean>; stillAllowed: () => boolean },
    ) => {
      if (guard && (!(await guard.allowed()) || !guard.stillAllowed())) {
        throw new ProvenPreSendRefusalError(
          "Run ownership changed before send",
        );
      }
      calls.push(`sendRun ${r.role} ${r.agentId}`);
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
      return "delivered" as const;
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
  const { root, store, current, run, command, audit, calls, runtime } =
    await fixture(t);
  const { initialSha } = await attachGitCheckout(root, store, current().id);
  const stuck = run("stuck-reviewer", "reviewer", null);
  store.putRun({ ...stuck, head: initialSha });
  store.setCredential(stuck.id, "old-secret");
  store.update(current().id, {
    phase: "reviewing",
    prHead: initialSha,
    profile: profile("worker-author"),
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
  assert.equal(calls[0], `create reviewer ${initialSha.slice(0, 8)}`);
  assert.equal(audit().length, 1);
});

test("#1508: run.start reviewer head=<pushed> warns on head_mismatch and starts at the pushed head", async (t) => {
  const { root, store, current, command, runtime } = await fixture(t);
  const { worktree, initialSha } = await attachGitCheckout(
    root,
    store,
    current().id,
  );
  writeFileSync(join(worktree, "a.txt"), "v2\n");
  await git(worktree, "add", "a.txt");
  await git(worktree, "commit", "-m", "v2");
  const pushed = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "origin", current().branch);
  store.update(current().id, {
    phase: "working",
    prHead: initialSha,
    profile: profile("worker-author"),
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
  assert.match(calls[0]!, /^sendRun revision worker-1$/);
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
  assert.equal(delivered.explicitResolution?.delivery, "delivered");
  assert.equal(delivered.phase, "reviewing");
  assert.ok(
    calls.some((c) => c.startsWith("steer reviewer-1: Resend your report now")),
  );
});

test("an uncertain-creation stall launches a coordinator that can resolve it with run.start", async (t) => {
  const { root, store, current, run, command, runtime } = await fixture(t);
  const { initialSha } = await attachGitCheckout(root, store, current().id);
  const stuck = run("uncertain-rev", "reviewer", null);
  store.putRun({ ...stuck, head: initialSha });
  store.update(current().id, {
    phase: "reviewing",
    prHead: initialSha,
    profile: profile("worker-author"),
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
  let deliveredToken = "";
  const { root, store, current, command, runtime } = await fixture(t, {
    sendRun: async (_task: unknown, _r: { id: string }, tok: string) => {
      deliveredToken = tok;
    },
  });
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
    profile: profile("worker-author"),
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
  const reviewRun = store.run(started.explicitResolution!.runId!)!;
  assert.ok(reviewRun.reviewCheckoutDirectory);
  assert.notEqual(reviewRun.reviewCheckoutDirectory, worktree);
  // Unconfirmed caller head does not overwrite task.prHead; reviewer gets its own detached view at pushedSha while worker worktree stays at firstSha.
  assert.equal(current().prHead, firstSha);
  assert.equal(
    readGitCheckout(reviewRun.reviewCheckoutDirectory!).head,
    pushedSha,
  );
  assert.equal(readGitCheckout(reviewRun.reviewCheckoutDirectory!).branch, "");
  assert.equal(readGitCheckout(worktree).head, firstSha);

  // Retained worker uses sendRun with a newly minted credential after prior credential was revoked.
  store.setCredential("old-rev", "revoked-secret");
  store.deleteCredential("old-rev");
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
  const { root, adapter, store, current, command, runtime } = await fixture(t);
  const { initialSha } = await attachGitCheckout(root, store, current().id);
  store.update(current().id, {
    phase: "reviewing",
    prHead: initialSha,
    profile: profile("worker-author"),
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
  let notifyFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    notifyFirstEntered = resolve;
  });
  let createCalls = 0;
  adapter.createRun = async (_task, r) => {
    createCalls++;
    if (createCalls === 1) {
      notifyFirstEntered();
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
  await firstEntered;
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
    profile: profile("worker-author"),
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

test("review round 2: reviewer source custody refuses dirty checkout, warns two_writers for live worker, handles #1508 forge-confirmed remote push through callback intake", async (t) => {
  let createdToken = "";
  let forgeHead = "";
  const { root, store, current, command, runtime } = await fixture(t, {
    verifyPrIdentity: async () => ({
      head: forgeHead,
      url: "https://github.com/example/repo/pull/42",
    }),
    createRun: async (
      _task: unknown,
      r: { id: string; role: string; workspaceId: string },
      tok: string,
    ) => {
      createdToken = tok;
      return {
        id: `${r.role}-agent-${r.id.slice(0, 8)}`,
        workspaceId: r.workspaceId || "workspace",
      };
    },
  });
  const remote = join(root, "remote.git");
  const repoDir = join(root, "repo");
  const worktree = join(root, "worktree");
  const pusher = join(root, "pusher");
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
  await git(worktree, "push", "-u", "origin", branch);

  // Remote push ahead of local branch (#1508).
  await git(root, "clone", remote, pusher);
  await git(pusher, "config", "user.email", "test@example.com");
  await git(pusher, "config", "user.name", "Test");
  await git(pusher, "checkout", branch);
  writeFileSync(join(pusher, "a.txt"), "v2-remote\n");
  await git(pusher, "add", "a.txt");
  await git(pusher, "commit", "-m", "v2 remote");
  const remoteSha = await git(pusher, "rev-parse", "HEAD");
  await git(pusher, "push", "origin", branch);
  forgeHead = remoteSha;

  store.update(current().id, {
    repoPath: repoDir,
    directory: worktree,
    workspaceId: "workspace",
    workspaceIntent: true,
    prUrl: "https://github.com/example/repo/pull/42",
    prHead: firstSha,
    phase: "awaiting_review",
    profile: profile("worker-a", "model-alpha"),
    agentId: "worker-1",
    agentActive: false,
  });
  runtime.engine.profiles = [
    profile("worker-a", "model-alpha"),
    profile("rev-b", "model-beta"),
  ];
  store.setMeta("pool", [
    {
      profileId: "worker-a",
      enabled: true,
      group: "workers",
      weight: "default",
      scopes: ["general"],
      roles: ["worker"],
    },
    {
      profileId: "rev-b",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  // Live worker with dirty uncommitted edit surfaces two_writers warning (never a hard refusal),
  // and accepting two_writers launches the reviewer in its own detached view without touching the worker's files, HEAD or branch.
  writeFileSync(join(worktree, "a.txt"), "worker-dirty-edit\n");
  store.update(current().id, { runId: "live-w", agentActive: true });
  const liveProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    head: remoteSha,
  });
  assert.equal(liveProbe.explicitResolution?.status, "warnings");
  assert.ok(
    liveProbe.explicitResolution?.warnings.some((w) => w.id === "two_writers"),
  );

  // Clean #1508 launch fetches remoteSha, creates a separate detached review worktree at remoteSha,
  // updates forge-confirmed prHead, leaves worker worktree/branch/dirty file intact, and accepts sourceApproved callback + settlement.
  const started = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    head: remoteSha,
    accept: ["two_writers"],
  });
  assert.equal(started.explicitResolution?.status, "applied");
  const revRunId = started.explicitResolution!.runId!;
  const revRun = store.run(revRunId)!;
  assert.equal(current().prHead, remoteSha);
  assert.ok(revRun.reviewCheckoutDirectory);
  assert.notEqual(revRun.reviewCheckoutDirectory, worktree);
  assert.equal(
    readGitCheckout(revRun.reviewCheckoutDirectory!).head,
    remoteSha,
  );
  assert.equal(readGitCheckout(revRun.reviewCheckoutDirectory!).branch, "");
  assert.equal(
    readFileSync(join(revRun.reviewCheckoutDirectory!, "a.txt"), "utf8"),
    "v2-remote\n",
  );
  // Worker's HEAD, branch and dirty working file survive launch untouched.
  const workerAfterLaunch = readGitCheckout(worktree);
  assert.equal(workerAfterLaunch.head, firstSha);
  assert.equal(workerAfterLaunch.branch, branch);
  assert.equal(
    readFileSync(join(worktree, "a.txt"), "utf8"),
    "worker-dirty-edit\n",
  );

  assert.ok(createdToken.length > 0);
  const accepted = await runtime.engine.complete(
    {
      taskId: current().id,
      runId: revRunId,
      eventId: "evt-rev-1508",
      status: "blocked",
      head: remoteSha,
      sourceApproved: true,
      reviewResponsibility: "environment",
      awaitingProofs: [{ proof: "e2e", route: "external" }],
      summary: "Source approved at remote head; awaiting external proof",
      reviewText: "Looks good",
    },
    createdToken,
  );
  assert.equal(accepted.accepted, true);
  assert.equal(store.run(revRunId)?.completion?.head, remoteSha);
  // Settle completed run: detached review worktree cleans up while worker checkout stays untouched.
  store.putRun({ ...store.run(revRunId)!, released: true, status: "finished" });
  await runtime.engine.resolution.resultApplication.advanceCompletedRun(
    current(),
    store.run(revRunId)!,
  );
  const workerAfterSettle = readGitCheckout(worktree);
  assert.equal(workerAfterSettle.head, firstSha);
  assert.equal(workerAfterSettle.branch, branch);
  assert.equal(
    readFileSync(join(worktree, "a.txt"), "utf8"),
    "worker-dirty-edit\n",
  );
});

test("review round 2: replacing checks role and preserves live_turn/unreported_result; reviewer enforces model independence", async (t) => {
  const { root, store, current, run, command, runtime } = await fixture(t);
  const { initialSha } = await attachGitCheckout(root, store, current().id);
  const liveWorker = run("live-worker-run", "revision", "worker-1");
  store.putRun({
    ...liveWorker,
    head: initialSha,
    active: true,
    status: "running",
    profile: profile("author-p", "model-alpha"),
  });
  store.update(current().id, {
    phase: "reviewing",
    prHead: initialSha,
    profile: profile("author-p", "model-alpha"),
  });
  runtime.engine.profiles = [
    profile("author-p", "model-alpha"),
    profile("same-model-rev", "model-alpha"),
  ];
  store.setMeta("pool", [
    {
      profileId: "same-model-rev",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  // Cross-role replacement is refused.
  await assert.rejects(
    command({
      action: "run.start",
      role: "reviewer",
      agent: "fresh",
      replacing: liveWorker.id,
    }),
    /cannot be replaced by run\.start reviewer/i,
  );

  // Same-model reviewer is refused by independence policy.
  await assert.rejects(
    command({
      action: "run.start",
      role: "reviewer",
      agent: "fresh",
    }),
    /No independent reviewer profile/i,
  );

  // Adding an independent profile selects it; replacing a live reviewer surfaces live_turn and unreported_result.
  runtime.engine.profiles.push(profile("indep-rev", "model-beta"));
  store.setMeta("pool", [
    {
      profileId: "same-model-rev",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
    {
      profileId: "indep-rev",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);
  const liveRev = run("live-rev-run", "reviewer", "rev-agent-1");
  store.putRun({ ...liveRev, active: true, status: "running" });
  const probe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: liveRev.id,
  });
  assert.equal(probe.explicitResolution?.status, "warnings");
  const ids = probe.explicitResolution!.warnings.map((w) => w.id);
  assert.ok(ids.includes("live_turn"));
  assert.ok(ids.includes("unreported_result"));
  assert.ok(ids.includes("duplicate_thread"));
});

test("review round 2: delayed retained sendRunVia does not rotate binding back to replaced run", async (t) => {
  const bindings: Array<{ key: string; runId: string; token: string }> = [];
  const sentMessages: string[] = [];
  let releaseFirstRefresh!: () => void;
  let refreshCount = 0;
  let rootDir = "";

  const { root, store, current, command, runtime } = await fixture(t, {
    sendRun: async (
      task: Parameters<typeof sendRunVia>[1],
      r: Parameters<typeof sendRunVia>[2],
      token: string,
      _ctx?: unknown,
      _ownerCtx?: unknown,
      guard?: Parameters<typeof sendRunVia>[6],
    ) => {
      const myRefresh = ++refreshCount;
      const owner: RunSendOwner = {
        helperPath: join(rootDir, "helper.mjs"),
        scratchPlacement: () => checkoutRunScratchPlacement(),
        retainedAgentRef: () =>
          ({
            refresh: async () => {
              if (myRefresh === 1) {
                await new Promise<void>((resolve) => {
                  releaseFirstRefresh = resolve;
                });
              }
            },
            current: () => ({
              id: r.agentId!,
              labels: { "nucleus.mcpBinding": "bind-key-1" },
            }),
            send: async (_text: string, opts: { messageId: string }) => {
              sentMessages.push(opts.messageId);
            },
          }) as unknown as ReturnType<RunSendOwner["retainedAgentRef"]>,
        binding: (key, _t, runId, tok) => {
          bindings.push({ key, runId, token: tok });
        },
        ticket: (_t, runObj) => join(rootDir, `ticket-${runObj.id}.json`),
        continueReviewer: async () => ({ sent: true }),
      };
      await sendRunVia(owner, task, r, token, null, null, guard);
    },
  });
  rootDir = root;
  store.update(current().id, {
    phase: "changes_requested",
    prHead: head,
    workspaceId: "workspace",
    agentId: "worker-1",
    agentActive: false,
    profile: profile("w-1"),
  });

  const firstPromise = command({
    action: "run.start",
    role: "worker",
    agent: "retained",
    instruction: "First turn",
  });
  await new Promise((r) => setTimeout(r, 20));
  const firstRunId = current().resolution.currentRunId!;
  assert.ok(firstRunId);

  // Replace run 1 while its refresh is still paused.
  const second = await command({
    action: "run.start",
    role: "worker",
    agent: "retained",
    replacing: firstRunId,
    accept: [
      "duplicate_thread",
      "two_writers",
      "live_turn",
      "unreported_result",
    ],
    instruction: "Second turn",
  });
  const secondRunId = second.explicitResolution!.runId!;
  assert.equal(bindings.at(-1)?.runId, secondRunId);
  assert.deepEqual(sentMessages, [`ns-run-${secondRunId}`]);

  // Resume run 1's refresh: guard must refuse before rotating binding or sending.
  releaseFirstRefresh();
  await firstPromise;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.runId, secondRunId);
  assert.deepEqual(sentMessages, [`ns-run-${secondRunId}`]);

  // Run 2's credential authenticates a real callback.
  const accepted = await runtime.engine.complete(
    {
      taskId: current().id,
      runId: secondRunId,
      eventId: "evt-1498-retained",
      status: "blocked",
      summary: "Needs clarification",
    },
    bindings[0]!.token,
  );
  assert.equal(accepted.accepted, true);
});

test("review round 2: message.send reports host steer disposition and blocks queued fallback without accept; proof-only recovers with bound workspace; next/snapshot handle executor role", async (t) => {
  let lastAllowFallback: boolean | undefined;
  let steerHandler: (
    id: string,
    msgId: string,
    text: string,
    src?: string,
    opts?: { allowQueuedFallback?: boolean },
  ) => Promise<"delivered" | "queued"> = async (
    _id,
    _msgId,
    _text,
    _src,
    opts,
  ) => {
    lastAllowFallback = opts?.allowQueuedFallback;
    return "delivered";
  };
  const { store, current, command, runtime } = await fixture(t, {
    steerOrNotify: (
      id: string,
      msgId: string,
      text: string,
      src?: string,
      opts?: { allowQueuedFallback?: boolean },
    ) => steerHandler(id, msgId, text, src, opts),
  });
  store.update(current().id, {
    phase: "working",
    prHead: head,
    workspaceId: "workspace",
    agentId: "worker-1",
    agentActive: true,
  });

  // 1. Successful steer on active thread returns delivered (not queued).
  const steered = await command({
    action: "message.send",
    role: "worker",
    text: "Focus on tests",
    accept: ["queued"],
  });
  assert.equal(steered.explicitResolution?.delivery, "delivered");
  assert.equal(lastAllowFallback, true);

  // 2. Idle snapshot without queued acceptance passes allowQueuedFallback=false and does not silently queue.
  store.update(current().id, { agentActive: false });
  steerHandler = async (_id, _msgId, _text, _src, opts) => {
    lastAllowFallback = opts?.allowQueuedFallback;
    if (opts?.allowQueuedFallback === false) {
      throw new ProvenPreSendRefusalError(
        "Steer refused; queued fallback not accepted",
      );
    }
    return "queued";
  };
  const refusedFallback = await command({
    action: "message.send",
    role: "worker",
    text: "Ping",
  });
  assert.equal(lastAllowFallback, false);
  assert.equal(refusedFallback.explicitResolution?.delivery, "unknown");

  // 3. Uncertain executor run in task.next offers run.release, never run.start worker, and flows into coordinator snapshot.
  const execRun = runSchema.parse({
    id: "exec-uncertain",
    taskId: current().id,
    role: "executor",
    hostId: host,
    workspaceId: "workspace",
    agentId: null,
    generation: 1,
    head,
    base: head,
    instruction: null,
    profile: null,
    profileGroup: null,
    status: "uncertain",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    idleSince: null,
    active: null,
    completion: null,
    released: false,
  });
  store.putRun(execRun);
  const next = runtime.taskNext({ taskId: current().id });
  assert.ok(
    next.explicitCommands?.some(
      (c) => c.action === "run.release" && c.args.run === execRun.id,
    ),
  );
  assert.equal(
    next.explicitCommands?.some(
      (c) => c.action === "run.start" && c.args.replacing === execRun.id,
    ),
    false,
  );
  const snapshot = recoveryDispatchSnapshot(
    collectOwnerVerbFacts(store, current()),
    { cause: "lifecycle", target: "worker", recoveryRunId: "rec-1" },
  );
  assert.ok(
    snapshot.explicitCommands?.some(
      (c) => c.action === "run.release" && c.args.run === execRun.id,
    ),
  );

  // 4. Proof-only task with bound workspaceId and agentIntent recovers via recoverExistingWorkspace in quantumSteps.
  store.setMeta("paused", false);
  let launchedProofOnly = false;
  runtime.engine.launchProofOnly = async () => {
    launchedProofOnly = true;
  };
  store.update(current().id, {
    entrypoint: "proof",
    proofOnly: { commit: head },
    workspaceId: "bound-proof-ws",
    directory: "/bound/proof/dir",
    workspaceIntent: true,
    agentIntent: true,
    agentId: null,
    phase: "dispatching",
    resolution: { ...current().resolution, stop: null },
  });
  await runtime.engine.withHost(host, () =>
    runtime.engine.quantumSteps(current().id, current(), {
      pausedForPrerequisiteWait: false,
    }),
  );
  assert.equal(launchedProofOnly, true);
  assert.equal(current().resolution.stop, null);
});

test("review round 4: coordinator one-step replacement on real Git worktree, unpushed branch preserved, unconfirmed head not saved, missing checkout refused", async (t) => {
  let forgeHead = "";
  const { root, store, current, run, command, runtime } = await fixture(t, {
    verifyPrIdentity: async () => ({
      head: forgeHead,
      url: "https://github.com/example/repo/pull/99",
    }),
  });
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
  const publishedSha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "-u", "origin", branch);
  forgeHead = publishedSha;

  // Worker has one unpushed local commit ahead of publishedSha.
  writeFileSync(join(worktree, "a.txt"), "v2-unpushed\n");
  await git(worktree, "add", "a.txt");
  await git(worktree, "commit", "-m", "v2 unpushed");
  const unpushedSha = await git(worktree, "rev-parse", "HEAD");

  const coordRun = run("live-coord", "recovery", "coord-agent");
  const stuckRev = run("stuck-rev", "reviewer", null);
  store.putRun(coordRun);
  store.putRun(stuckRev);
  store.update(current().id, {
    repoPath: repoDir,
    directory: worktree,
    workspaceId: "workspace",
    workspaceIntent: true,
    prUrl: "https://github.com/example/repo/pull/99",
    prHead: publishedSha,
    phase: "reviewing",
    profile: profile("worker-a", "model-alpha"),
    agentId: "worker-1",
    agentActive: false,
    coordinatorAgentId: "coord-agent",
    resolution: {
      ...current().resolution,
      currentRunId: stuckRev.id,
      recoveryActive: true,
      recovery: {
        id: "ep-1",
        key: "k-1",
        generation: 1,
        runId: coordRun.id,
        agentId: "coord-agent",
        status: "running",
        summary: "Stall",
        idleSince: null,
        incidentId: null,
      },
    },
  });
  runtime.engine.profiles = [
    profile("worker-a", "model-alpha"),
    profile("rev-b", "model-beta"),
  ];
  store.setMeta("pool", [
    {
      profileId: "rev-b",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  // 1. Live coordinator replaces uncertain reviewer in one step on real Git checkout:
  // reviewer gets its own detached view at publishedSha while worker's worktree stays attached at unpushedSha.
  const replaced = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: stuckRev.id,
    caller: formatAgentId(host, "coord-agent"),
    accept: ["duplicate_thread"],
  });
  assert.equal(replaced.explicitResolution?.status, "applied");
  const replacedRun = store.run(replaced.explicitResolution!.runId!)!;
  assert.ok(replacedRun.reviewCheckoutDirectory);
  assert.notEqual(replacedRun.reviewCheckoutDirectory, worktree);
  assert.equal(
    readGitCheckout(replacedRun.reviewCheckoutDirectory!).head,
    publishedSha,
  );
  assert.equal(
    readGitCheckout(replacedRun.reviewCheckoutDirectory!).branch,
    "",
  );
  const workerAfter = readGitCheckout(worktree);
  assert.equal(workerAfter.head, unpushedSha);
  assert.equal(workerAfter.branch, branch);
  assert.equal(readGitRef(workerAfter, `refs/heads/${branch}`), unpushedSha);

  // 2. Caller-supplied head differing from forge warns head_mismatch, never writes it to prHead,
  // and even after accepting head_mismatch still launches the reviewer on the forge-confirmed publishedSha.
  const mismatchProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    head: unpushedSha,
  });
  assert.equal(mismatchProbe.explicitResolution?.status, "warnings");
  assert.ok(
    mismatchProbe.explicitResolution?.warnings.some(
      (w) => w.id === "head_mismatch",
    ),
  );
  const mismatchApplied = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    head: unpushedSha,
    accept: ["head_mismatch", "duplicate_thread"],
  });
  assert.equal(mismatchApplied.explicitResolution?.status, "applied");
  assert.equal(current().prHead, publishedSha);
  const mismatchRun = store.run(mismatchApplied.explicitResolution!.runId!)!;
  assert.equal(mismatchRun.head, publishedSha);
  assert.equal(
    readGitCheckout(mismatchRun.reviewCheckoutDirectory!).head,
    publishedSha,
  );

  // 3. Unavailable forge head refuses instead of falling through to an unconfirmed commit.
  forgeHead = "";
  await assert.rejects(
    command({
      action: "run.start",
      role: "reviewer",
      agent: "fresh",
      accept: ["duplicate_thread"],
    }),
    /forge pr head is unavailable/i,
  );
  forgeHead = publishedSha;

  // 4. Missing, unbound (null) and repo-aliasing checkouts all refuse as unavailable.
  store.update(current().id, { directory: join(root, "missing-worktree") });
  await assert.rejects(
    command({
      action: "run.start",
      role: "reviewer",
      agent: "fresh",
      accept: ["duplicate_thread"],
    }),
    /checkout is unavailable/i,
  );
  store.update(current().id, { directory: null });
  await assert.rejects(
    command({
      action: "run.start",
      role: "reviewer",
      agent: "fresh",
      accept: ["duplicate_thread"],
    }),
    /checkout is unavailable/i,
  );
  store.update(current().id, { directory: repoDir });
  await assert.rejects(
    command({
      action: "run.start",
      role: "reviewer",
      agent: "fresh",
      accept: ["duplicate_thread"],
    }),
    /checkout is unavailable/i,
  );
});

test("review round 4: reviewer profile selection scopes to task host catalog; BB service adapter forwards allowQueuedFallback", async (t) => {
  const secondaryHost = "t3code-secondary";
  const workerA = profile("worker-a", "model-alpha", { provider: "codex" });
  const primaryOnly = profile("primary-only-rev", "model-beta", {
    provider: "claude",
  });
  const secondaryOnly = profile("secondary-only-rev", "model-gamma", {
    provider: "codex",
  });
  const makeCatalog = (entries: Array<{ key: string; models: string[] }>) =>
    hostCatalogSchema.parse({
      providers: entries.map(({ key, models }) => ({
        key,
        label: key,
        available: true,
        problem: "",
        models: models.map((id) => ({
          id,
          label: id,
          aliases: [],
          thinkingOptions: [{ id: "high", label: "high" }],
          defaultThinkingOptionId: null,
          modes: [{ id: "default", label: "default" }],
          features: [],
        })),
      })),
    });
  const { root, adapter, store, current, runtime } = await fixture(t, {
    catalog: async () =>
      makeCatalog([
        { key: "codex", models: ["model-alpha"] },
        { key: "claude", models: ["model-beta"] },
      ]),
  });

  // Register secondary host with its own catalog distinct from primary.
  let deliveredSecondaryProfileId: string | null = null;
  let deliveredSecondaryDir: string | null = null;
  const secondaryAdapter = {
    ...adapter,
    hostId: secondaryHost,
    catalog: async () =>
      makeCatalog([{ key: "codex", models: ["model-gamma"] }]),
    createRun: async (
      tObj: { directory: string | null },
      r: { id: string; profile: { id: string } | null; workspaceId: string },
    ) => {
      deliveredSecondaryProfileId = r.profile?.id ?? null;
      deliveredSecondaryDir = tObj.directory;
      return {
        id: `secondary-rev-${r.id.slice(0, 8)}`,
        workspaceId: r.workspaceId || "workspace",
      };
    },
  } as unknown as Adapter;
  store.setProfiles(
    [workerA, primaryOnly, secondaryOnly].map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      notes: "",
      modeId: p.modeId,
      thinkingOptionId: p.thinkingOptionId,
    })),
  );
  runtime.engine.hostIds = () => [host, secondaryHost];
  runtime.engine.resolveHostAdapter = (id) =>
    id === secondaryHost ? secondaryAdapter : id === host ? adapter : undefined;
  runtime.engine.hostAvailable = () => true;
  await runtime.engine.refresh();

  store.setMeta("pool", [
    {
      profileId: primaryOnly.id,
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
    {
      profileId: secondaryOnly.id,
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);
  const secondaryTask = store.insert(
    submissionSchema.parse({
      submissionId: "secondary-host-task",
      title: "Secondary host task",
      repoPath: repo,
      planningCommit: head,
      handoffPath: "handoff.md",
      originAgentId: "owner",
    }),
    secondaryHost,
    "Handoff",
    head,
  );
  const { worktree: secondaryWorktree, initialSha: secondarySha } =
    await attachGitCheckout(root, store, secondaryTask.id, "secondary-git");
  store.update(secondaryTask.id, {
    phase: "awaiting_review",
    prHead: secondarySha,
    profile: profile("worker-a", "model-alpha"),
  });

  const started = taskControlTaskSchema.parse(
    await callCatalogueMethod(runtime, "queue.task", {
      action: "run.start",
      taskId: secondaryTask.id,
      version: store.task(secondaryTask.id).version,
      reason: "Start reviewer on secondary host",
      caller: OPERATOR_BOARD_CALLER,
      role: "reviewer",
      agent: "fresh",
    }),
  );
  assert.equal(started.explicitResolution?.status, "applied");
  const created = store.run(started.explicitResolution!.runId!);
  assert.equal(created?.profile?.id, secondaryOnly.id);
  assert.equal(deliveredSecondaryProfileId, secondaryOnly.id);
  assert.ok(
    deliveredSecondaryDir && deliveredSecondaryDir !== secondaryWorktree,
  );

  // BB service adapter forwards allowQueuedFallback=false and refuses instead of queueing.
  const bbState = emptyBbThreadState();
  bbState.agents["bb-thread-1"] = {
    id: "bb-thread-1",
    task: current().id,
    run: "run-1",
    role: "worker",
    workspaceId: "ws-1",
    parentThreadId: null,
    labels: {},
  };
  store.setMeta("bbThreads", bbState);
  const ops: Array<{ op: string; mode?: unknown }> = [];
  const bbAdapter = composeBbAdapter({
    hostId: "bb-test",
    connected: () => true,
    dataDir: join(root, "bb-data"),
    store,
    workspaces: {
      createWorkspace: async () => ({ id: "ws-1", directory: root }),
      findWorkspaces: async () => [],
      workspaceAvailable: async () => true,
      workspaceIdAccepted: () => true,
      taskWorkspaceArchived: async () => false,
      workspaceRef: () => ({
        directory: root,
        refresh: async () => true,
        current: () => null,
        archive: async () => ({
          archivedAt: new Date().toISOString(),
          error: null,
        }),
      }),
      repositoryProject: async () => ({ workspaceRoot: root }),
    },
    records: () => ({}),
    put: () => {},
    notSent: (error) => error instanceof ProvenPreSendRefusalError,
    operation: async (op, input) => {
      const mode = (input as { mode?: unknown })?.mode;
      ops.push({ op, mode });
      if (op === "thread.send" && mode === "steer") {
        throw new ProvenPreSendRefusalError("No active turn to steer");
      }
      return {
        operation: op,
        at: new Date().toISOString(),
        calls: {},
        value: {},
      };
    },
  });

  await assert.rejects(
    bbAdapter.steerOrNotify!("bb-thread-1", "msg-1", "Hello", undefined, {
      allowQueuedFallback: false,
    }),
    /queued fallback was not accepted/i,
  );
  // Only the steer attempt ran; no queued fallback send was dispatched.
  assert.deepEqual(ops, [{ op: "thread.send", mode: "steer" }]);
});

test("review round 5: native reviewer gets its own host workspace, terminal verdict publishes when worker is behind, dirty detached view is preserved on release", async (t) => {
  let forgeHead = "";
  const registeredWorkspaces = new Map<string, string>();
  let launchedWorkspaceId: string | null = null;
  let launchedWorkspaceContents: string | null = null;
  let createdToken = "";

  const { root, store, current, command, runtime } = await fixture(t, {
    verifyPrIdentity: async () => ({
      head: forgeHead,
      url: "https://github.com/example/repo/pull/77",
    }),
    createWorkspace: async (taskObj: { directory: string | null }) => {
      const id = `review-ws-${registeredWorkspaces.size + 1}`;
      registeredWorkspaces.set(id, taskObj.directory!);
      return { id, directory: taskObj.directory! };
    },
    createRun: async (
      _taskObj: unknown,
      r: { id: string; role: string; workspaceId: string },
      tok: string,
    ) => {
      createdToken = tok;
      launchedWorkspaceId = r.workspaceId;
      const dir = registeredWorkspaces.get(r.workspaceId) ?? null;
      launchedWorkspaceContents = dir
        ? readFileSync(join(dir, "a.txt"), "utf8")
        : null;
      return {
        id: `${r.role}-agent-${r.id.slice(0, 8)}`,
        workspaceId: r.workspaceId,
      };
    },
  });

  const { remote, repoDir, worktree, initialSha } = await attachGitCheckout(
    root,
    store,
    current().id,
    "round5-git",
  );
  const branch = current().branch;
  // Remote push ahead of local worker checkout (#1508).
  const pusher = join(root, "round5-pusher");
  await git(root, "clone", remote, pusher);
  await git(pusher, "config", "user.email", "test@example.com");
  await git(pusher, "config", "user.name", "Test");
  await git(pusher, "checkout", branch);
  writeFileSync(join(pusher, "a.txt"), "v2-pushed\n");
  await git(pusher, "add", "a.txt");
  await git(pusher, "commit", "-m", "v2 pushed");
  const pushedSha = await git(pusher, "rev-parse", "HEAD");
  await git(pusher, "push", "origin", branch);
  forgeHead = pushedSha;

  // Worker checkout is behind at initialSha AND has an uncommitted edit.
  writeFileSync(join(worktree, "a.txt"), "worker-local-dirty\n");
  store.update(current().id, {
    repository: "example/repo",
    prUrl: "https://github.com/example/repo/pull/77",
    prHead: initialSha,
    resumePrNumber: 77,
    phase: "awaiting_review",
    profile: profile("worker-a", "model-alpha"),
    agentId: "worker-1",
    agentActive: false,
  });
  runtime.engine.profiles = [
    profile("worker-a", "model-alpha"),
    profile("rev-b", "model-beta"),
  ];
  store.setMeta("pool", [
    {
      profileId: "rev-b",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);

  // 1. Fresh reviewer registers its own host workspace pointing at the detached view and sees v2-pushed, not worker-local-dirty.
  const started = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
  });
  assert.equal(started.explicitResolution?.status, "applied");
  const revRunId = started.explicitResolution!.runId!;
  const revRun = store.run(revRunId)!;
  assert.notEqual(revRun.workspaceId, current().workspaceId);
  assert.equal(launchedWorkspaceId, revRun.workspaceId);
  assert.equal(launchedWorkspaceContents, "v2-pushed\n");
  assert.equal(
    readFileSync(join(worktree, "a.txt"), "utf8"),
    "worker-local-dirty\n",
  );

  // 2. Formal publication of a terminal verdict succeeds even though the worker checkout is behind & dirty.
  await git(
    repoDir,
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/repo.git",
  );
  const reviewId = await publishFormalReview(
    store,
    current(),
    revRun,
    "ready_to_merge",
    "Approved at pushed head",
    { login: "reviewer-bot" },
    () => true,
    {
      readToken: async () => "fake-token",
      verifyPr: async () => ({
        head: pushedSha,
        url: "https://github.com/example/repo/pull/77",
      }),
      runGh: async (_t, endpoint, args) => {
        if (endpoint.endsWith("/reviews") && args.includes("POST")) {
          const bodyArg = args.find((a) => a.startsWith("body="))!;
          return {
            id: 505,
            user: { login: "reviewer-bot" },
            body: bodyArg.slice("body=".length),
            commit_id: pushedSha,
            state: "APPROVED",
          };
        }
        return [];
      },
    },
  );
  await git(repoDir, "remote", "set-url", "origin", remote);
  assert.equal(reviewId, 505);

  // 3. Complete terminal verdict through intake, then test dirty detached worktree preservation on run.release.
  const accepted = await runtime.engine.complete(
    {
      taskId: current().id,
      runId: revRunId,
      eventId: "evt-round5-terminal",
      status: "ready_to_merge",
      head: pushedSha,
      summary: "Approved",
      reviewText: "Approved at pushed head",
      reviewId,
    },
    createdToken,
  );
  assert.equal(accepted.accepted, true);
  // Let any in-flight step triggered by complete() settle before issuing the next command.
  await new Promise((r) => setTimeout(r, 200));

  // Start a second reviewer run, dirty its detached checkout, and verify run.release preserves it instead of force-deleting.
  store.update(current().id, { phase: "awaiting_review" });
  const started2 = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["duplicate_thread", "budget"],
  });
  assert.equal(
    started2.explicitResolution?.status,
    "applied",
    JSON.stringify(started2.explicitResolution),
  );
  const revRun2Id = started2.explicitResolution!.runId!;
  const revRun2 = store.run(revRun2Id)!;
  writeFileSync(
    join(revRun2.reviewCheckoutDirectory!, "a.txt"),
    "reviewer-uncommitted-note\n",
  );
  const released = await command({
    action: "run.release",
    run: revRun2Id,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(released.explicitResolution?.status, "applied");
  assert.equal(existsSync(revRun2.reviewCheckoutDirectory!), true);
  assert.equal(
    readFileSync(join(revRun2.reviewCheckoutDirectory!, "a.txt"), "utf8"),
    "reviewer-uncommitted-note\n",
  );
  assert.match(
    released.explicitResolution?.next ?? "",
    /uncommitted changes and was preserved/i,
  );

  // 4. Retained reviewer start refuses when the retained thread's detached view is missing or does not match the target head.
  store.update(current().id, {
    resolution: {
      ...current().resolution,
      reviewerAgentId: "legacy-worker-workspace-reviewer",
    },
  });
  await assert.rejects(
    () =>
      command({
        action: "run.start",
        role: "reviewer",
        agent: "retained",
        accept: ["duplicate_thread", "budget"],
      }),
    /detached review checkout/i,
  );
});
