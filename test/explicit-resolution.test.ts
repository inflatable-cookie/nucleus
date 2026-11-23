import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { mergeGate } from "../core/forge/merge";
import {
  publishFormalReview,
  publishReviewOnce,
  reconcileFormalReviewPublication,
  verifyFormalReview,
  type FormalReviewRuntime,
} from "../core/forge/reviews";
import { publishedReviewDecision } from "../core/intake/result-application";
import { ordinaryReviewSource } from "../core/review/ordinary-review";
import { git } from "../core/git/index";
import { readGitCheckout, readGitRef } from "../core/git/git-identity";
import { hostCatalogSchema } from "../shared/host";
import { composeBbAdapter } from "../service/bb-adapter";
import { emptyBbThreadState } from "../hosts/bb";
import { formatAgentId } from "../shared/agent-identity";
import {
  OPERATOR_BOARD_CALLER,
  completionSchema,
  REVISION_BUDGET,
  runSchema,
  submissionSchema,
  taskControlTaskSchema,
  type Task,
} from "../shared/contracts";
import type { ResolutionWarningId } from "../shared/schema/task-control";
import type { RecordClearTarget } from "../core/verbs/explicit-resolution";
import { incidentSchema } from "../shared/incident";
import { hookRecordSchema } from "../shared/hooks";
import {
  ownerStopRecordSchema,
  resolutionSchema,
} from "../shared/schema/resolution";
import { taskStopRecord } from "../shared/task-stop";
import { prerequisiteWaitBlocksPhase } from "../core/store/store-prerequisites";
import { reviewPublicationKey } from "../core/review/review-publication";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";
import { runSettlementFence } from "../core/intake/run-settlement";
import { executionParticipants } from "../core/machine/execution-participants";
import { plannerEscalations } from "../core/questions/ladder/records";
import { blockingRecoveryEffects } from "../core/recovery/recovery-effects";
import { digest, operationInputHash } from "../core/store/store";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
  ownerTaskNext,
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
import { explicitOutcome } from "../bin/explicit-outcome.mjs";

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
    prUrl: "https://github.com/example/repo/pull/1",
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
    verifyPrIdentity: async (tObj: {
      prHead?: string | null;
      prUrl?: string | null;
    }) => ({
      head: tObj.prHead ?? head,
      url: tObj.prUrl ?? "https://github.com/example/repo/pull/1",
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
        ...("taskId" in args ? {} : { reference: task.reference }),
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

test("run.start reviewer in a formal-review repository records the formal publication form a scheduled reviewer gets", async (t) => {
  const launched: Record<string, unknown>[] = [];
  const { root, store, current, command, runtime } = await fixture(t, {
    createRun: async (
      _task: unknown,
      r: { id: string; role: string; workspaceId: string },
    ) => {
      launched.push({ ...r });
      return {
        id: `${r.role}-agent-${r.id.slice(0, 8)}`,
        workspaceId: r.workspaceId || "workspace",
      };
    },
  });
  const { repoDir, initialSha } = await attachGitCheckout(
    root,
    store,
    current().id,
  );
  store.patchRepository(
    { path: repoDir, origin: null },
    { reviewer: { login: "reviewer-bot" } },
  );
  store.update(current().id, {
    phase: "awaiting_review",
    prHead: initialSha,
    profile: profile("worker-author"),
    resolution: {
      ...current().resolution,
      pendingReviewReason: "Review the pushed fix",
    },
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

  const applied = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
  });
  assert.equal(applied.explicitResolution?.status, "applied");
  const reviewRun = store.run(applied.explicitResolution!.runId!)!;
  // Admission applies this repository's verdicts only with a formal review ID,
  // so the run must tell its reviewer to leave publication to Nucleus.
  assert.equal(reviewRun.formalReview, true);
  assert.equal(reviewRun.reviewResponsibilityRequired, true);
  assert.equal(reviewRun.reviewReason, "Review the pushed fix");
  assert.equal(launched.length, 1);
  assert.equal(launched[0]!.formalReview, true);
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

test("run.start enforces two_writers and budget warnings and coordinator authority", async (t) => {
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
  // The cap park's own record: six rounds alone are not the cap (papercut 677c378d).
  store.event(
    current().id,
    "revision_budget_exhausted",
    `Revision budget exhausted after ${REVISION_BUDGET} review rounds; the project planner decides the next approach`,
  );
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

  const coordCaller = formatAgentId(host, "coordinator");
  await assert.rejects(
    command({ ...args, caller: coordCaller, accept: ["two_writers"] }),
    /only the live responsible planner/i,
  );
  // The revision cap (and a second budget spend) is the planner's disposition,
  // as the author-round rule holds: a coordinator cannot start a run past it.
  await assert.rejects(
    command({ ...args, caller: coordCaller, agent: "retained", accept: ["budget"] }),
    /only the live responsible planner or operator board can accept .*budget/i,
  );
  const applied = await command({
    ...args,
    caller: planner,
    accept: ["duplicate_thread", "two_writers", "budget"],
  });
  assert.equal(applied.explicitResolution?.status, "applied");
});

test("an unaccepted explicit command leads with its warnings and exits non-zero, and next lists them up front (papercut ee6e634c)", async (t) => {
  const { store, current, run, command, runtime } = await fixture(t);
  const uncertain = run("uncertain-revision", "revision", null);
  store.putRun(uncertain);
  store.update(current().id, {
    phase: "changes_requested",
    prHead: head,
    workspaceId: "workspace",
    profile: profile("worker-prof"),
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

  // `next` names each command's warnings before it is sent.
  const next = ownerTaskNext(collectOwnerVerbFacts(store, current()));
  const start = next.explicitCommands?.find(
    (item) => item.action === "run.start" && item.args.replacing === uncertain.id,
  );
  assert.ok(start, JSON.stringify(next.explicitCommands));
  assert.deepEqual(start!.warnings, ["duplicate_thread", "two_writers"]);
  const release = next.explicitCommands?.find(
    (item) => item.action === "run.release" && item.args.run === uncertain.id,
  );
  assert.deepEqual(release?.warnings, ["live_turn", "unreported_result"]);

  // Sent without them, the command applies nothing and says so first.
  const { action: _action, taskId: _taskId, version: _version, ...args } = start!.args;
  const probe = await command({ action: "run.start", ...args });
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.deepEqual(
    probe.explicitResolution?.warnings.map((warning) => warning.id),
    start!.warnings,
    "the listed warnings are the ones the command names",
  );
  const refused = explicitOutcome(probe)!;
  assert.equal(
    refused.line,
    'warnings: duplicate_thread, two_writers (not applied; resend with "accept": ["duplicate_thread","two_writers"] to apply; only the live responsible planner or the operator board may accept two_writers)',
  );
  assert.ok(refused.line.startsWith("warnings: duplicate_thread, two_writers"));
  assert.equal(refused.exitCode, 2);
  assert.equal(store.run(uncertain.id)?.released, false, "nothing was applied");

  // A stale version is not applied either.
  const stale = await command({ action: "run.start", ...args, version: current().version + 1 });
  assert.equal(stale.explicitResolution?.status, "stale");
  assert.match(explicitOutcome(stale)!.line, /^stale: not applied/);
  assert.equal(explicitOutcome(stale)!.exitCode, 2);

  // Resent with next's list, it applies and exits zero.
  const applied = await command({ action: "run.start", ...args, accept: start!.warnings });
  assert.equal(applied.explicitResolution?.status, "applied");
  const outcome = explicitOutcome(applied)!;
  assert.match(outcome.line, /^applied/);
  assert.equal(outcome.exitCode, 0);
  assert.equal(explicitOutcome({ id: "not an explicit answer" }), null);
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
  await git(worktree, "reset", "--hard", "--quiet", firstSha);

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
  assert.equal(reviewRun.workspaceId, current().workspaceId);
  // run.start makes no Git writes: unconfirmed caller head does not overwrite task.prHead or move the checkout.
  assert.equal(current().prHead, firstSha);
  assert.equal(reviewRun.head, firstSha);
  assert.equal(readGitCheckout(worktree).head, firstSha);
  assert.equal(readGitCheckout(worktree).branch, current().branch);

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

test("run.start cannot select Frontier at Normal without a worker request", async (t) => {
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

  await assert.rejects(
    command({
      action: "run.start",
      role: "worker",
      agent: "fresh",
      caller: planner,
      accept: ["route_policy"],
    }),
    /No eligible profile is available for worker/,
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

  // Dirty task checkout refuses before starting review.
  writeFileSync(join(worktree, "a.txt"), "worker-dirty-edit\n");
  store.update(current().id, { runId: "live-w", agentActive: true });
  await assert.rejects(
    () =>
      command({
        action: "run.start",
        role: "reviewer",
        agent: "fresh",
        head: remoteSha,
      }),
    /uncommitted changes/i,
  );
  // Clean checkout at the worker-pushed remoteSha (#1508) with live worker surfaces two_writers warning (never a hard refusal).
  await git(worktree, "checkout", "--", "a.txt");
  await git(worktree, "fetch", "origin", `refs/heads/${branch}`);
  await git(worktree, "merge", "--ff-only", remoteSha);
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

  // Clean #1508 launch makes no Git writes, updates forge-confirmed prHead when checkout matches forge,
  // and accepts sourceApproved callback + settlement.
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
  assert.equal(revRun.workspaceId, current().workspaceId);
  const checkoutAfterLaunch = readGitCheckout(worktree);
  assert.equal(checkoutAfterLaunch.head, remoteSha);
  assert.equal(checkoutAfterLaunch.branch, branch);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "v2-remote\n");

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
  store.putRun({ ...store.run(revRunId)!, released: true, status: "finished" });
  await runtime.engine.resolution.resultApplication.advanceCompletedRun(
    current(),
    store.run(revRunId)!,
  );
  const workerAfterSettle = readGitCheckout(worktree);
  assert.equal(workerAfterSettle.head, remoteSha);
  assert.equal(workerAfterSettle.branch, branch);
  assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "v2-remote\n");
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
  // with an unpushed local commit ahead of forgeHead, run.start warns head_mismatch and never rewinds.
  const divergedProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: stuckRev.id,
    caller: formatAgentId(host, "coord-agent"),
    accept: ["duplicate_thread"],
  });
  assert.equal(divergedProbe.explicitResolution?.status, "warnings");
  assert.ok(
    divergedProbe.explicitResolution?.warnings.some(
      (w) => w.id === "head_mismatch",
    ),
  );
  // Accepting head_mismatch starts the run at the current unpushed head without rewinding or overwriting prHead.
  const replaced = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    replacing: stuckRev.id,
    caller: formatAgentId(host, "coord-agent"),
    accept: ["duplicate_thread", "head_mismatch"],
  });
  assert.equal(replaced.explicitResolution?.status, "applied");
  const replacedRun = store.run(replaced.explicitResolution!.runId!)!;
  assert.equal(replacedRun.head, unpushedSha);
  assert.equal(replacedRun.workspaceId, current().workspaceId);
  assert.equal(current().prHead, publishedSha);
  const workerAfter = readGitCheckout(worktree);
  assert.equal(workerAfter.head, unpushedSha);
  assert.equal(workerAfter.branch, branch);
  assert.equal(readGitRef(workerAfter, `refs/heads/${branch}`), unpushedSha);

  // 2. Caller-supplied head differing from forge also warns head_mismatch and never writes it to prHead.
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
  assert.equal(mismatchRun.head, unpushedSha);
  assert.equal(readGitCheckout(worktree).head, unpushedSha);

  // 3. Unreadable forge head returns head_mismatch; accepting starts on the checkout as it is and never records an unconfirmed prHead.
  forgeHead = "";
  const unreadableProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["duplicate_thread"],
  });
  assert.equal(unreadableProbe.explicitResolution?.status, "warnings");
  assert.ok(
    unreadableProbe.explicitResolution?.warnings.some(
      (w) => w.id === "head_mismatch",
    ),
  );
  const unreadableApplied = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["duplicate_thread", "head_mismatch"],
  });
  assert.equal(unreadableApplied.explicitResolution?.status, "applied");
  assert.equal(current().prHead, publishedSha);
  assert.equal(
    store.run(unreadableApplied.explicitResolution!.runId!)?.head,
    unpushedSha,
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
  assert.equal(deliveredSecondaryDir, secondaryWorktree);

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

test("review round 8: run.start makes no Git writes; #1508 passes ordinary result application and real mergeGate; ahead checkout and unreadable forge return head_mismatch", async (t) => {
  let forgeHead = "";
  let failForgeRead = false;
  let launchedWorkspaceId: string | null = null;
  let launchedContents: string | null = null;
  let createdToken = "";

  const { root, store, current, command, runtime } = await fixture(t, {
    verifyPrIdentity: async () => {
      if (failForgeRead) throw Error("GitHub unavailable");
      return {
        head: forgeHead,
        url: "https://github.com/example/repo/pull/77",
        number: 77,
        repository: "example/repo",
        headRepository: "example/repo",
        crossRepository: false,
      };
    },
    verifyReview: async () => 505,
    observe: async (id: string) => ({
      id,
      workspaceId: current().workspaceId,
      status: "idle",
      activeTurnId: null,
      archivedAt: null,
      active: false,
      permissions: 0,
    }),
    createRun: async (
      taskObj: { directory: string | null },
      r: { id: string; role: string; workspaceId: string },
      tok: string,
    ) => {
      createdToken = tok;
      launchedWorkspaceId = r.workspaceId;
      launchedContents = taskObj.directory
        ? readFileSync(join(taskObj.directory, "a.txt"), "utf8")
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
    "round8-git",
  );
  const branch = current().branch;
  const baseSha = await git(repoDir, "rev-parse", "main");

  // #1508 shape: worker commits and pushes v2-pushed from the task checkout while task.prHead is still stale at initialSha.
  writeFileSync(join(worktree, "a.txt"), "v2-pushed\n");
  await git(worktree, "add", "a.txt");
  await git(worktree, "commit", "-m", "v2 pushed");
  const pushedSha = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "origin", branch);
  forgeHead = pushedSha;

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
  store.patchRepository(
    { path: repoDir, origin: "example/repo" },
    { reviewer: { login: "reviewer-bot" } },
  );
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

  // 1. run.start with head=<pushed> makes no Git writes, confirms forgeHead === localHead, updates task.prHead, and launches reviewer in task.workspaceId.
  const started = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    head: pushedSha,
  });
  assert.equal(started.explicitResolution?.status, "applied");
  const revRunId = started.explicitResolution!.runId!;
  const revRun = store.run(revRunId)!;
  assert.equal(revRun.workspaceId, current().workspaceId);
  assert.equal(launchedWorkspaceId, current().workspaceId);
  assert.equal(launchedContents, "v2-pushed\n");
  assert.equal(current().prHead, pushedSha);
  assert.equal(readGitCheckout(worktree).head, pushedSha);
  assert.equal(readGitCheckout(worktree).branch, branch);

  // 2. Formal publication, callback intake, ordinary published-verdict application, and first real mergeGate all pass.
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  const fakeGhConfig = join(root, "fake-gh.json");
  const ghScript = join(bin, "gh");
  writeFileSync(
    ghScript,
    `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, 'utf8'));
const args = process.argv.slice(2);
const key = args[0] === 'api' ? args[1] : args.slice(0, 2).join(' ');
const entry = config[key] ?? config[String(key).replace(/\\?.*$/, '')];
if (!entry) { process.stderr.write('gh: no fake response for ' + key + '\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(entry.body));
`,
  );
  chmodSync(ghScript, 0o755);
  const sshScript = join(bin, "ssh");
  writeFileSync(
    sshScript,
    `#!/bin/sh\nexec git-upload-pack ${JSON.stringify(remote)}\n`,
  );
  chmodSync(sshScript, 0o755);
  const priorPath = process.env.PATH;
  const priorGhConfig = process.env.FAKE_GH_CONFIG;
  process.env.PATH = `${bin}:${priorPath ?? ""}`;
  process.env.FAKE_GH_CONFIG = fakeGhConfig;

  let reviewBody = "";
  try {
    await git(
      repoDir,
      "remote",
      "set-url",
      "origin",
      "git@github.com:example/repo.git",
    );
    await git(
      worktree,
      "remote",
      "set-url",
      "origin",
      "git@github.com:example/repo.git",
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
            reviewBody = bodyArg.slice("body=".length);
            return {
              id: 505,
              user: { login: "reviewer-bot" },
              body: reviewBody,
              commit_id: pushedSha,
              state: "APPROVED",
            };
          }
          return [];
        },
      },
    );
    assert.equal(reviewId, 505);

    writeFileSync(
      fakeGhConfig,
      JSON.stringify({
        "pr view": {
          body: {
            number: 77,
            url: "https://github.com/example/repo/pull/77",
            state: "OPEN",
            isDraft: false,
            headRefName: branch,
            baseRefName: "main",
            headRefOid: pushedSha,
            headRepository: { name: "repo" },
            headRepositoryOwner: { login: "example" },
            isCrossRepository: false,
          },
        },
        "repos/example/repo/pulls/77": {
          body: {
            html_url: "https://github.com/example/repo/pull/77",
            state: "open",
            draft: false,
            head: {
              ref: branch,
              sha: pushedSha,
              repo: { full_name: "example/repo" },
            },
            base: {
              ref: "main",
              repo: { full_name: "example/repo" },
            },
          },
        },
        graphql: {
          body: {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: pushedSha,
                  baseRefOid: baseSha,
                  baseRefName: "main",
                  isDraft: false,
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "APPROVED",
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { hasNextPage: false },
                  },
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          databaseId: 1,
                          name: "ci",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          startedAt: "2026-11-22T00:00:00Z",
                          completedAt: "2026-11-22T00:01:00Z",
                          detailsUrl: null,
                          checkSuite: { app: { databaseId: 1 } },
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            },
          },
        },
        "repos/example/repo/branches/main/protection": { body: {} },
        "repos/example/repo/branches/main/protection/required_status_checks": {
          body: { strict: false, contexts: [] },
        },
        "repos/example/repo/rules/branches/main": { body: [] },
      }),
    );

    const accepted = await runtime.engine.complete(
      {
        taskId: current().id,
        runId: revRunId,
        eventId: "evt-round8-terminal",
        status: "ready_to_merge",
        head: pushedSha,
        summary: "Approved",
        reviewText: "Approved at pushed head",
        reviewId,
      },
      createdToken,
    );
    assert.equal(accepted.accepted, true);
    store.putRun({
      ...store.run(revRunId)!,
      status: "finished",
      released: true,
    });
    const decision = publishedReviewDecision(store, current());
    assert.equal(decision.kind, "ready", JSON.stringify(decision));
    // Apply the published verdict through the ordinary result-application path.
    const applied = await runtime.engine.withHost(current().hostId!, () =>
      runtime.engine.resolution.resultApplication.applyPublishedReview(
        current(),
        decision,
      ),
    );
    assert.equal(applied.kind, "applied", JSON.stringify(applied));
    assert.equal(current().phase, "verifying");
    assert.equal(current().resolution.review?.head, pushedSha);
    assert.equal(current().resolution.review?.status, "ready_to_merge");
    assert.equal(current().resolution.review?.reviewId, reviewId);

    // First real mergeGate passes using the production verifyPr verifier (no injected verifyPr override).
    const gate = await mergeGate(
      current(),
      undefined,
      { login: "reviewer-bot" },
      "all",
      {
        readToken: async () => "fake-token",
        runGh: async (_t, endpoint) => {
          const reviewObj = {
            id: reviewId,
            user: { login: "reviewer-bot" },
            body: reviewBody,
            commit_id: pushedSha,
            state: "APPROVED",
          };
          if (endpoint.endsWith(`/reviews/${reviewId}`)) return reviewObj;
          if (endpoint.endsWith("/reviews")) return [reviewObj];
          return [];
        },
      },
    );
    assert.equal(gate.wait, "");
    assert.equal(gate.head, pushedSha);
  } finally {
    process.env.PATH = priorPath;
    if (priorGhConfig === undefined) delete process.env.FAKE_GH_CONFIG;
    else process.env.FAKE_GH_CONFIG = priorGhConfig;
    await git(repoDir, "remote", "set-url", "origin", remote);
    await git(worktree, "remote", "set-url", "origin", remote);
  }

  // 3. Checkout ahead of forge head (unpushed local commit): returns head_mismatch, never moves branch,
  // accepting starts on checkout as it is and never overwrites task.prHead.
  writeFileSync(join(worktree, "a.txt"), "v3-unpushed\n");
  await git(worktree, "add", "a.txt");
  await git(worktree, "commit", "-m", "v3 unpushed");
  const unpushedSha = await git(worktree, "rev-parse", "HEAD");
  store.update(current().id, { phase: "awaiting_review" });

  const aheadProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
  });
  assert.equal(aheadProbe.explicitResolution?.status, "warnings");
  assert.ok(
    aheadProbe.explicitResolution?.warnings.some(
      (w) => w.id === "head_mismatch",
    ),
  );
  assert.equal(readGitCheckout(worktree).head, unpushedSha);

  const aheadApplied = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["head_mismatch", "budget"],
  });
  assert.equal(aheadApplied.explicitResolution?.status, "applied");
  assert.equal(
    store.run(aheadApplied.explicitResolution!.runId!)?.head,
    unpushedSha,
  );
  assert.equal(readGitCheckout(worktree).head, unpushedSha);
  assert.equal(current().prHead, pushedSha);

  // 4. Unreadable forge head: returns head_mismatch, accepting starts on checkout as it is without updating task.prHead.
  failForgeRead = true;
  const unreadableProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["duplicate_thread", "budget"],
  });
  assert.equal(unreadableProbe.explicitResolution?.status, "warnings");
  assert.ok(
    unreadableProbe.explicitResolution?.warnings.some(
      (w) => w.id === "head_mismatch",
    ),
  );
  const unreadableApplied = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["duplicate_thread", "budget", "head_mismatch"],
  });
  assert.equal(unreadableApplied.explicitResolution?.status, "applied");
  assert.equal(
    store.run(unreadableApplied.explicitResolution!.runId!)?.head,
    unpushedSha,
  );
  assert.equal(current().prHead, pushedSha);

  // 5. Missing PR number/URL counts as unreadable forge head -> head_mismatch.
  failForgeRead = false;
  store.update(current().id, { prUrl: null, resumePrNumber: null });
  const missingPrProbe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
    accept: ["duplicate_thread", "budget"],
  });
  assert.equal(missingPrProbe.explicitResolution?.status, "warnings");
  assert.ok(
    missingPrProbe.explicitResolution?.warnings.some(
      (w) => w.id === "head_mismatch",
    ),
  );
});

test("review round 9: run.start never calls legacy verifyPr when verifyPrIdentity is absent and returns head_mismatch", async (t) => {
  let verifyPrCalled = 0;
  const { root, store, current, command, runtime } = await fixture(t, {
    verifyPrIdentity: undefined,
    verifyPr: async () => {
      verifyPrCalled += 1;
      return {
        head: "f".repeat(40),
        url: "https://github.com/example/repo/pull/99",
      };
    },
  });
  const { initialSha } = await attachGitCheckout(
    root,
    store,
    current().id,
    "round9-git",
  );
  store.update(current().id, {
    repository: "example/repo",
    prUrl: "https://github.com/example/repo/pull/99",
    prHead: initialSha,
    resumePrNumber: 99,
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

  const probe = await command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
  });
  assert.equal(verifyPrCalled, 0);
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.ok(
    probe.explicitResolution?.warnings.some((w) => w.id === "head_mismatch"),
  );
});

/** The reviewer pool and task facts a `run.start reviewer fresh` needs. */
async function reviewStartFixture(t: TestContext) {
  const f = await fixture(t);
  const { worktree, initialSha } = await attachGitCheckout(
    f.root,
    f.store,
    f.current().id,
  );
  f.store.update(f.current().id, {
    phase: "awaiting_review",
    prHead: initialSha,
    profile: profile("worker-author"),
  });
  f.runtime.engine.profiles = [profile("rev-1")];
  f.store.setMeta("pool", [
    {
      profileId: "rev-1",
      enabled: true,
      group: "reviews",
      weight: "default",
      scopes: ["general"],
      roles: ["reviewer"],
    },
  ]);
  return { ...f, worktree, initialSha };
}

test("068: run.start reviewer fresh returns a clean checkout detached at the branch tip to its branch", async (t) => {
  const f = await reviewStartFixture(t);
  const { store, worktree, initialSha } = f;
  await git(worktree, "checkout", "--quiet", "--detach", initialSha);
  assert.equal(await git(worktree, "branch", "--show-current"), "");
  const applied = await f.command({
    action: "run.start",
    role: "reviewer",
    agent: "fresh",
  });
  assert.equal(applied.explicitResolution?.status, "applied");
  // The reattach step moved no commit: the branch carries the same tree.
  assert.equal(
    await git(worktree, "branch", "--show-current"),
    f.current().branch,
  );
  assert.equal(await git(worktree, "rev-parse", "HEAD"), initialSha);
  assert.equal((await git(worktree, "status", "--porcelain")) ?? "", "");
  assert.ok(
    store.eventsAll(f.current().id).some(
      (event) =>
        event.kind === "task_checkout_reattached" &&
        event.detail.includes(initialSha),
    ),
  );
});

test("068: run.start worker returns a checkout detached at the branch tip to its branch", async (t) => {
  const f = await fixture(t);
  const { worktree, initialSha } = await attachGitCheckout(
    f.root,
    f.store,
    f.current().id,
  );
  f.store.update(f.current().id, {
    phase: "changes_requested",
    agentId: "worker-1",
    runId: "initial-worker",
    agentActive: false,
    profile: profile("worker-prof"),
  });
  await git(worktree, "checkout", "--quiet", "--detach", initialSha);
  assert.equal(await git(worktree, "branch", "--show-current"), "");
  // The reattach step runs for every run.start role, not only reviewers.
  const applied = await f.command({
    action: "run.start",
    role: "worker",
    agent: "retained",
    instruction: "Apply the review fix",
  });
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(
    await git(worktree, "branch", "--show-current"),
    f.current().branch,
  );
  assert.equal(await git(worktree, "rev-parse", "HEAD"), initialSha);
  assert.ok(
    f.store
      .eventsAll(f.current().id)
      .some(
        (event) =>
          event.kind === "task_checkout_reattached" &&
          event.detail.includes(initialSha),
      ),
  );
});

test("068: run.start reviewer fresh leaves a dirty detached checkout alone and names the refusal", async (t) => {
  const f = await reviewStartFixture(t);
  const { worktree, initialSha } = f;
  await git(worktree, "checkout", "--quiet", "--detach", initialSha);
  writeFileSync(join(worktree, "uncommitted.txt"), "worker scratch\n");
  await assert.rejects(
    f.command({ action: "run.start", role: "reviewer", agent: "fresh" }),
    /was not returned to .*uncommitted changes: \?\? uncommitted.txt/,
  );
  assert.equal(await git(worktree, "branch", "--show-current"), "");
  assert.equal(
    readFileSync(join(worktree, "uncommitted.txt"), "utf8"),
    "worker scratch\n",
  );
});

test("068: run.start reviewer fresh leaves a detached checkout that is not the branch tip alone", async (t) => {
  const f = await reviewStartFixture(t);
  const { worktree, initialSha } = f;
  // The branch advances while the checkout stays detached at the earlier tip.
  writeFileSync(join(worktree, "a.txt"), "v2\n");
  await git(worktree, "add", "a.txt");
  await git(worktree, "commit", "-m", "v2");
  const tip = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "checkout", "--quiet", "--detach", initialSha);
  await assert.rejects(
    f.command({ action: "run.start", role: "reviewer", agent: "fresh" }),
    /is not the tip of .*would move the working tree/,
  );
  assert.equal(await git(worktree, "branch", "--show-current"), "");
  assert.equal(await git(worktree, "rev-parse", "HEAD"), initialSha);
  assert.notEqual(tip, initialSha, "the branch tip moved");
});

test("068: run.start reviewer fresh does not disturb an unreleased follow-up round's detached checkout", async (t) => {
  const f = await reviewStartFixture(t);
  const { store, worktree, initialSha } = f;
  const reader = runSchema.parse({
    ...f.run("live-reader", "reviewer", "reader-agent"),
    head: initialSha,
    ordinaryDetached: true,
    priorRunId: "prior-round",
    priorHead: initialSha,
  });
  store.putRun(reader);
  store.update(f.current().id, {
    resolution: {
      ...f.current().resolution,
      currentRunId: reader.id,
      reviewerAgentId: reader.agentId,
    },
  });
  await git(worktree, "checkout", "--quiet", "--detach", initialSha);
  await assert.rejects(
    f.command({ action: "run.start", role: "reviewer", agent: "fresh" }),
    new RegExp(`owned by unreleased review round ${reader.id}`),
  );
  assert.equal(await git(worktree, "branch", "--show-current"), "");
  assert.equal(await git(worktree, "rev-parse", "HEAD"), initialSha);
});

test("068: run.release returns the checkout its settled round left detached to the branch", async (t) => {
  const f = await reviewStartFixture(t);
  const { store, worktree, initialSha } = f;
  const reader = runSchema.parse({
    ...f.run("settling-reader", "reviewer", "reader-agent"),
    head: initialSha,
    ordinaryDetached: true,
    priorRunId: "prior-round",
    priorHead: initialSha,
  });
  store.putRun(reader);
  store.setCredential(reader.id, "test-secret");
  store.update(f.current().id, {
    resolution: {
      ...f.current().resolution,
      currentRunId: reader.id,
      reviewerAgentId: reader.agentId,
    },
  });
  await git(worktree, "checkout", "--quiet", "--detach", initialSha);
  const released = await f.command({
    action: "run.release",
    run: reader.id,
    accept: ["live_turn", "unreported_result"],
  });
  assert.equal(released.explicitResolution?.status, "applied");
  assert.equal(store.run(reader.id)?.released, true);
  assert.equal(
    await git(worktree, "branch", "--show-current"),
    f.current().branch,
  );
  assert.equal(await git(worktree, "rev-parse", "HEAD"), initialSha);
  assert.ok(
    store.eventsAll(f.current().id).some(
      (event) => event.kind === "task_checkout_reattached",
    ),
  );
});

test("next previews exact planner record settlements and reports what's left", async (t) => {
  const stamp = "2026-11-23T10:00:00.000Z";
  type Case = RecordClearTarget & {
    warnings?: ResolutionWarningId[];
    observeOriginal?: boolean;
    settled: () => boolean;
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const hold = {
    owner: "another-planner",
    reason: "Pause dispatch",
    at: stamp,
    generation: 1,
    until: null,
  };
  const patch = (f: Fixture, change: Partial<Task["resolution"]>) =>
    f.store.update(f.current().id, {
      resolution: { ...f.current().resolution, ...change },
    });
  const notice = (taskId: string, id: string) => ({
    id,
    taskId,
    agentId: "owner",
    text: "Delivery unknown",
    status: "uncertain" as const,
    error: "",
    kind: "attention" as const,
    recipientAgentId: "",
    workspaceId: null,
    sources: [],
    originEntry: true,
  });
  const cases: Record<string, (f: Fixture) => Case> = {
    "stored stop": (f) => {
      patch(f, {
        stop: taskStopRecord("lifecycle", "A local wait", null, stamp),
      });
      return {
        kind: "stop",
        id: stamp,
        settled: () => f.current().resolution.stop === null,
      };
    },
    "foreign hold": (f) => {
      f.store.update(f.current().id, {
        holds: { dispatch: hold, merge: hold },
      });
      return {
        kind: "hold",
        id: "dispatch",
        warnings: ["hold_owner"],
        settled: () =>
          !f.current().holds?.dispatch && Boolean(f.current().holds?.merge),
      };
    },
    "owner stop under a hold": (f) => {
      f.store.update(f.current().id, { holds: { dispatch: hold } });
      patch(f, {
        ownerStop: ownerStopRecordSchema.parse({
          operationId: "stop-operation",
          taskVersion: f.current().version,
          role: "worker",
          reason: "Cancellation has not returned",
          caller: hold.owner,
          recordedAt: stamp,
          targetRunIds: ["old-run"],
          cancellations: [
            {
              runId: "old-run",
              role: "worker",
              agentId: "old-worker",
              workspaceId: null,
              turnId: "old-turn",
              effectId: "stop-effect",
              status: "uncertain",
            },
          ],
        }),
      });
      return {
        kind: "owner_stop",
        id: "stop-operation",
        warnings: ["hold_owner", "effect_may_land"],
        settled: () =>
          f.current().resolution.ownerStop === null &&
          Boolean(f.current().holds?.dispatch),
      };
    },
    "deferred verb": (f) => {
      patch(f, {
        deferredVerb: {
          at: stamp,
          input: { action: "move" },
          why: "held",
          target: null,
        },
      });
      return {
        kind: "deferred_verb",
        id: stamp,
        settled: () => f.current().resolution.deferredVerb === null,
      };
    },
    "legacy host wait": (f) => {
      patch(f, { hostWait: { hostId: host, since: stamp } });
      return {
        kind: "host_wait",
        id: host,
        settled: () => f.current().resolution.hostWait === null,
      };
    },
    "escalated incident beneath a stop": (f) => {
      patch(f, {
        stop: taskStopRecord(
          "operator_needed",
          "Independent stop",
          null,
          stamp,
        ),
        incident: incidentSchema.parse({
          id: "incident",
          role: "worker",
          createdAt: stamp,
          updatedAt: stamp,
          status: "escalated",
        }),
      });
      return {
        kind: "incident",
        id: "incident",
        settled: () =>
          f.current().resolution.incident === null &&
          f.current().resolution.stop?.since === stamp,
      };
    },
    "open escalation": (f) => {
      for (const id of ["old", "other"])
        f.store.event(
          f.current().id,
          "planner_escalation",
          `${id}: cause uncertain`,
        );
      return {
        kind: "escalation",
        id: "old",
        settled: () => {
          const occurrences = plannerEscalations(
            f.store.eventsAll(f.current().id),
          );
          return (
            occurrences.find((e) => e.id === "old")?.answered === true &&
            occurrences.find((e) => e.id === "other")?.answered === false
          );
        },
      };
    },
    "cancelled prerequisite": (f) => {
      const dependency = f.store.insert(
        submissionSchema.parse({
          submissionId: "cancelled",
          title: "Cancelled prerequisite",
          repoPath: repo,
          planningCommit: head,
          handoffPath: "handoff.md",
          originAgentId: "owner",
        }),
        host,
        "Handoff",
        head,
      );
      f.store.update(dependency.id, { phase: "cancelled" });
      f.store.update(f.current().id, {
        phase: "changes_requested",
        runId: "worker",
      });
      const { prerequisiteWait } = f.store.setPrerequisiteWait(
        f.current(),
        [dependency.id],
        "Needs prerequisite",
      );
      assert.ok(prerequisiteWait);
      const next = f.runtime.taskNext({ taskId: f.current().id });
      assert.equal(next.stop?.owner, "planner");
      assert.match(next.stop?.detail ?? "", /cancelled.*record\.clear/);
      return {
        kind: "wait",
        id: prerequisiteWait.id,
        settled: () =>
          f.current().prerequisiteWait === null &&
          f.store.task(dependency.id).phase === "cancelled",
      };
    },
    "released wait still blocks revision": (f) => {
      const waitId = randomUUID();
      f.store.update(f.current().id, {
        phase: "changes_requested",
        runId: "worker",
        prerequisiteWait: {
          id: waitId,
          waitsFor: [randomUUID()],
          releasedAt: stamp,
          reason: "No author instruction",
        },
      });
      assert.equal(prerequisiteWaitBlocksPhase(f.current()), true);
      return {
        kind: "wait",
        id: waitId,
        settled: () => !prerequisiteWaitBlocksPhase(f.current()),
      };
    },
    "attention notice on a terminal task": (f) => {
      f.store.update(f.current().id, { phase: "done" });
      f.store.putNotice(notice(f.current().id, "late-notice"));
      return {
        kind: "effect",
        id: "attention-notice.late-notice",
        warnings: ["effect_may_land"],
        settled: () =>
          f.store.notices(f.current().id).find((n) => n.id === "late-notice")
            ?.status === "superseded",
      };
    },
    "unfinished operation": (f) => {
      const task = f.current();
      const { payload, key } = taskControlOperation({
        action: "route",
        role: "reviewer",
        profileId: "next",
        now: true,
        reason: "Choose a reviewer route",
        taskId: task.id,
        version: task.version,
      });
      const accepted = f.store.acceptOperation({
        key,
        kind: "task_control",
        taskId: task.id,
        inputHash: operationInputHash(payload),
        payload,
      });
      assert.ok("operation" in accepted);
      const { id } = accepted.operation;
      return {
        kind: "effect",
        id: `operation.${id}`,
        warnings: ["effect_may_land"],
        settled: () => f.store.operation(id)?.state === "failed",
      };
    },
    "finished hook cleanup": (f) => {
      f.store.update(f.current().id, { phase: "done" });
      const hook = hookRecordSchema.parse({
        id: "finished-hook-record",
        taskId: f.current().id,
        hookId: "policy",
        event: "task.finished",
        eventId: "e".repeat(48),
        occurrence: 1,
        mode: "read_only",
        delivery: "advisory",
        state: "failed",
        manifest: {
          path: ".paseo/queue.json",
          commit: head,
          digest: `sha256:${"a".repeat(64)}`,
        },
        program: {
          kind: "repository",
          executable: {
            path: ".paseo/hooks/policy",
            commit: head,
            digest: `sha256:${"c".repeat(64)}`,
          },
          argv: [],
        },
        instruction: null,
        baseBranch: "main",
        baseCommit: head,
        attempt: 1,
        timeoutMs: 30000,
        maxOutputBytes: 65536,
        allowedPaths: [],
        commitSubject: null,
        eventDigest: "b".repeat(64),
        eventPayload: null,
        workspace: null,
        processId: null,
        result: null,
        commit: null,
        remote: null,
        summary: "",
        error: "",
        createdAt: stamp,
        updatedAt: stamp,
        reconciledAt: null,
      });
      f.store.putHookEvent(hook);
      return {
        kind: "effect",
        id: `hook.${hook.id}`,
        warnings: ["effect_may_land"],
        settled: () =>
          f.store.hookEvents(f.current().id)[0]?.state === "superseded",
      };
    },
    "owned tool": (f) => {
      f.store.event(
        f.current().id,
        "owned_tool_hold",
        JSON.stringify({
          runId: "tool-run",
          reason: "Tool still owns the checkout",
        }),
      );
      return {
        kind: "effect",
        id: "owned_tool.tool-run",
        warnings: ["owned_tool"],
        settled: () =>
          f.store
            .eventsAll(f.current().id)
            .some((event) => event.kind === "owned_tool_settled"),
      };
    },
    "uncertain run delivery": (f) => {
      f.store.putRun(f.run("uncertain-delivery", "reviewer", null));
      return {
        kind: "effect",
        id: "run-delivery.uncertain-delivery",
        warnings: ["effect_may_land"],
        settled: () =>
          f.store.run("uncertain-delivery")?.status === "stopped" &&
          f.store.run("uncertain-delivery")?.released === false,
      };
    },
    "uncertain review delivery": (f) => {
      const reviewer = f.run("retained-review", "reviewer", "reviewer");
      const delivery = (digit: string) => ({
        authorizationId: `authorization-${digit}`,
        operationId: `operation-${digit}`,
        deliveryId: `ns-review-${digit.repeat(64)}`,
        taskId: f.current().id,
        runId: reviewer.id,
        head,
        checkpointOrdinal: 1,
        taskVersion: f.current().version,
        briefVersion: null,
        briefDigest: null,
        reason: "Continue reviewing",
        instruction: "Resume at the checkpoint",
        createdAt: stamp,
        status: "uncertain",
      });
      const first = delivery("1");
      f.store.putRun(
        runSchema.parse({
          ...reviewer,
          reviewDeliveries: [first, delivery("2")],
        }),
      );
      return {
        kind: "effect",
        id: `review-delivery.${first.deliveryId}`,
        warnings: ["effect_may_land"],
        settled: () =>
          f.store
            .run(reviewer.id)
            ?.reviewDeliveries?.map((item) => item.status)
            .join() === "refused,uncertain",
      };
    },
    "uncertain merge response": (f) => {
      const request = {
        mergeIntent: true,
        mergeHead: head,
        mergeRequestedAt: stamp,
        mergeResponseOutcome: "uncertain" as const,
        mergeRetryAt: stamp,
        mergeRetryOutcome: "uncertain" as const,
      };
      f.store.update(f.current().id, {
        phase: "merging",
        resolution: { ...f.current().resolution, ...request },
      });
      return {
        kind: "effect",
        id: "merge-response.merge-response",
        warnings: ["effect_may_land"],
        observeOriginal: true,
        settled: () => {
          const state = f.current().resolution;
          for (const [field, value] of Object.entries(request))
            assert.equal(Reflect.get(state, field), value);
          assert.equal(state.mergeAutoRetryExhausted, true);
          return blockingRecoveryEffects(f.store, f.current()).some(
            (effect) => effect.kind === "merge-response",
          );
        },
      };
    },
    "held project validation": (f) => {
      patch(f, {
        projectValidation: resolutionSchema.shape.projectValidation.parse({
          argv: ["check"],
          digest: "validation-digest",
          exitCode: null,
          durationMs: 0,
          outputTail: "",
          base: head,
          head,
          state: "hold",
        }),
      });
      return {
        kind: "effect",
        id: "project-validation.project-validation",
        warnings: ["effect_may_land"],
        settled: () =>
          f.current().resolution.projectValidation?.state === "superseded",
      };
    },
  };
  for (const [name, seed] of Object.entries(cases)) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      f.store.setProjectPlanner({
        key: "example",
        agentId: planner,
        setBy: "operator",
      });
      const id = f.current().id;
      const wake = subtest.mock.method(
        f.runtime.engine,
        "wakeTask",
        async () => {},
      );
      const {
        settled,
        warnings = [],
        observeOriginal = false,
        ...target
      } = seed(f);
      f.store.putNotice(notice(id, "independent-notice"));
      const before = f.current();
      const read = () => f.runtime.taskNext({ taskId: id });
      const find = () =>
        read().explicitCommands?.find(
          (offer) =>
            offer.action === "record.clear" &&
            offer.args.kind === target.kind &&
            offer.args.id === target.id,
        );
      const offer = find();
      assert.ok(offer);
      assert.deepEqual(offer.args, {
        action: "record.clear",
        taskId: id,
        version: before.version,
        ...target,
      });
      assert.deepEqual(offer.warnings, warnings);
      assert.equal(f.audit().length, 0);
      assert.deepEqual(f.calls, []);
      if (warnings.length) {
        const probe = await f.command({ ...offer.args, caller: planner });
        assert.equal(probe.explicitResolution?.status, "warnings");
        assert.deepEqual(
          probe.explicitResolution?.warnings.map((warning) => warning.id),
          warnings,
        );
        assert.deepEqual(f.current(), before);
        assert.equal(wake.mock.callCount(), 0);
      }
      const result = await f.command({
        ...offer.args,
        accept: warnings,
        caller: planner,
      });
      assert.equal(result.explicitResolution?.status, "applied");
      assert.equal(result.phase, before.phase);
      assert.ok(settled());
      assert.equal(find(), undefined);
      assert.match(
        result.explicitResolution.next,
        /attention-notice\.independent-notice/,
      );
      assert.deepEqual(
        wake.mock.calls.map(({ arguments: args }) => args),
        [[id]],
      );
      if (observeOriginal)
        assert.match(
          result.explicitResolution.next,
          /original write remains recorded/,
        );
      assert.equal(
        (await f.command({ ...offer.args, accept: warnings, caller: planner }))
          .explicitResolution?.status,
        "stale",
      );
      await assert.rejects(
        f.command({
          ...offer.args,
          version: f.current().version,
          caller: planner,
          accept: warnings,
        }),
        /No current/,
      );
      const independent = f.store
        .notices(id)
        .find((n) => n.id === "independent-notice");
      assert.equal(independent?.status, "uncertain");
      assert.equal(f.audit().length, 1);
      assert.equal(JSON.parse(f.audit()[0]!.detail).source, "project_planner");
      if (target.id === "late-notice") {
        f.store.putNotice({
          ...notice(id, "late-notice"),
          error: "Late delivery observer",
        });
        assert.equal(
          f.store.notices(id).find((n) => n.id === "late-notice")?.status,
          "superseded",
        );
      }
    });
  }
});

test("next previews bound and terminal run releases without displacing a healthy run", async (t) => {
  for (const terminal of [false, true]) {
    await t.test(
      terminal ? "terminal cleanup" : "bound coordinator",
      async (subtest) => {
        const f = await fixture(subtest);
        const { store, current, run, runtime } = f;
        store.setProjectPlanner({
          key: "example",
          agentId: planner,
          setBy: "operator",
        });
        const stuck = run("bound-coordinator", "recovery", "coordinator");
        const healthy = run("healthy-review", "reviewer", "reviewer");
        store.putRun(stuck);
        store.putRun(healthy);
        const healthyBefore = store.run(healthy.id);
        store.update(current().id, {
          phase: terminal ? "cancelled" : "needs_attention",
          resolution: {
            ...current().resolution,
            currentRunId: healthy.id,
            recoveryActive: true,
            recovery: {
              id: "bound-episode",
              key: "key",
              generation: 1,
              runId: stuck.id,
              agentId: stuck.agentId,
              status: "running",
              summary: "A stale coordinator binding",
              idleSince: null,
              incidentId: null,
            },
          },
        });
        const read = () => runtime.taskNext({ taskId: current().id });
        const releases = () =>
          read().explicitCommands?.filter(
            (item) => item.action === "run.release",
          ) ?? [];
        const offer = releases().find((item) => item.args.run === stuck.id);
        assert.ok(offer);
        if (!terminal) assert.deepEqual(releases(), [offer]);
        else
          assert.ok(
            read().explicitCommands?.every(
              (item) => item.action !== "run.start",
            ),
          );
        assert.deepEqual(offer.warnings, ["live_turn", "unreported_result"]);
        assert.deepEqual(f.calls, []);
        const wake = subtest.mock.method(
          runtime.engine,
          "wakeTask",
          async () => {},
        );
        const probe = await f.command({ ...offer.args, caller: planner });
        assert.equal(probe.explicitResolution?.status, "warnings");
        assert.deepEqual(
          probe.explicitResolution?.warnings.map((w) => w.id),
          offer.warnings,
        );
        assert.equal(wake.mock.callCount(), 0);
        const apply = {
          ...offer.args,
          caller: planner,
          accept: offer.warnings,
        };
        const result = await f.command(apply);
        assert.equal(result.explicitResolution?.status, "applied");
        assert.equal(store.run(stuck.id)?.released, true);
        assert.notEqual(
          releases().some((item) => item.args.run === stuck.id),
          true,
        );
        assert.equal(
          (await f.command(apply)).explicitResolution?.status,
          "stale",
        );
        await f.command({ ...apply, version: current().version });
        assert.equal(current().resolution.currentRunId, healthy.id);
        assert.deepEqual(store.run(healthy.id), healthyBefore);
        assert.deepEqual(f.calls, ["stop coordinator"]);
      },
    );
  }
});

test("next names the operator's genuine decision and the planner's dependency correction", async (t) => {
  const f = await fixture(t);
  const task = f.current();
  const prerequisite = f.store.insert(
    submissionSchema.parse({
      submissionId: "before-dispatch",
      title: "Prerequisite",
      repoPath: repo,
      planningCommit: head,
      handoffPath: "handoff.md",
      originAgentId: "owner",
    }),
    host,
    "Handoff",
    head,
  );
  f.store.update(prerequisite.id, { phase: "cancelled" });
  f.store.update(task.id, { dependsOn: [prerequisite.id] });
  const read = () => f.runtime.taskNext({ taskId: task.id });
  assert.equal(read().stop?.owner, "planner");
  assert.ok(
    read().verbs.some(
      (item) => item.action === "set_dependencies" && item.available,
    ),
  );
  const decision = f.runtime.decisions.add({
    askedBy: planner,
    tasks: [task.id],
    question: "May the task change scope?",
  });
  const next = read();
  assert.equal(next.stop?.owner, "operator");
  assert.match(
    next.stop?.detail ?? "",
    new RegExp(`decision ${decision.id} with decision\\.answer`),
  );
  assert.ok(!next.explicitCommands?.some((item) => item.args.kind === "stop"));
  assert.equal(f.store.decision(decision.id).status, "open");
});

test("an unconfirmed initial worker cancellation keeps the real scheduler behind the old binding", async (t) => {
  let workerActive = true;
  let stopError = true;
  let cancelCalls = 0;
  let workerCreates = 0;
  const f = await fixture(t, {
    observe: async (id: string) => ({
      id,
      workspaceId: "workspace",
      status: workerActive && id === "initial-worker" ? "running" : "idle",
      active: workerActive && id === "initial-worker",
      activeTurnId:
        workerActive && id === "initial-worker" ? "worker-turn" : null,
      permissions: false,
      error: "",
    }),
    stopAgentTurn: async (id: string, turnId?: string) => {
      assert.equal(id, "initial-worker");
      assert.equal(turnId, "worker-turn");
      cancelCalls++;
      if (stopError) throw Error("The host lost the cancellation response");
    },
    verifyWorkspace: async (task: Task) => task.branch,
    createAgent: async () => {
      workerCreates++;
      return { id: "replacement-worker", workspaceId: "workspace" };
    },
  });
  const { store, runtime, current, command, root } = f;
  const { worktree } = await attachGitCheckout(
    root,
    store,
    current().id,
    "interrupted-dispatch",
  );
  const task = store.update(current().id, {
    phase: "dispatching",
    runId: "initial-dispatch",
    agentId: "initial-worker",
    agentActive: true,
    agentIntent: false,
    directory: worktree,
    profile: profile("worker"),
    prHead: null,
    prUrl: null,
  });
  store.setCredential(task.runId!, "worker-ticket");
  store.setMeta("paused", false);

  const read = () => runtime.taskNext({ taskId: task.id });
  const offer = read().explicitCommands?.find(
    (item) => item.action === "run.release" && item.args.run === task.runId,
  );
  assert.ok(offer);
  assert.deepEqual(offer.warnings, ["live_turn", "unreported_result"]);
  const probe = await command({ ...offer.args });
  assert.equal(probe.explicitResolution?.status, "warnings");
  assert.equal(cancelCalls, 0);

  const release = () =>
    command({
      ...offer.args,
      version: current().version,
      accept: offer.warnings,
    });
  for (const diagnostic of [
    /lost the cancellation response/,
    /unsettled turn/,
  ]) {
    await assert.rejects(release(), diagnostic);
    await runtime.engine.wakeTask(task.id);
    await runtime.engine.quiesce();
    assert.equal(workerCreates, 0);
    assert.equal(current().runId, task.runId);
    assert.equal(current().agentId, task.agentId);
    assert.equal(current().agentActive, true);
    assert.equal(f.audit().length, 0);
    assert.doesNotThrow(() => store.authenticate(task.runId!, "worker-ticket"));
    stopError = false;
  }

  workerActive = false;
  const applied = await release();
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.agentId, null);
  assert.throws(() => store.authenticate(task.runId!, "worker-ticket"));
  assert.equal(cancelCalls, 2);
  await runtime.engine.quiesce();
  assert.equal(workerCreates, 1);
});

test("clearing a publication wait preserves the receipt-backed verdict and reconciles the original GitHub review", async (t) => {
  const reviewer = { login: "reviewer-bot" };
  let posts = 0;
  let observed = 0;
  let allowObservation = () => {};
  const observation = new Promise<void>((resolve) => {
    allowObservation = resolve;
  });
  let remoteReview: {
    id: number;
    body: string;
    user: typeof reviewer;
    commit_id: string;
    state: string;
  } | null = null;
  const forge: FormalReviewRuntime = {
    readToken: async () => "fake-token",
    verifyPr: async (task) => ({ head: task.prHead!, url: task.prUrl! }),
    runGh: async (task, endpoint, args) => {
      if (args.includes("POST")) {
        posts++;
        const body = args
          .find((arg) => arg.startsWith("body="))
          ?.slice("body=".length);
        assert.ok(body);
        assert.ok(task.prHead);
        remoteReview = {
          id: 505,
          body,
          user: reviewer,
          commit_id: task.prHead,
          state: "CHANGES_REQUESTED",
        };
        throw Error(
          "HTTP 503: GitHub accepted the review, but the response was lost",
        );
      }
      if (args.includes("--paginate")) {
        await observation;
        observed++;
        return [[remoteReview]];
      }
      if (endpoint.endsWith("/505")) return remoteReview;
      throw Error("Lookup needs a published review ID");
    },
  };
  const publish: NonNullable<ResolutionAdapter["publishReview"]> = (
    store,
    task,
    run,
    status,
    text,
    allowed,
    setting,
  ) =>
    publishReviewOnce(store, task, run, status, text, allowed, setting, forge);
  const verify: ResolutionAdapter["verifyReview"] = (task, run, result) =>
    verifyFormalReview(task, run, result, reviewer, forge);
  const f = await fixture(t, { publishReview: publish, verifyReview: verify });
  const { store, root, current, runtime } = f;
  const { repoDir, initialSha } = await attachGitCheckout(
    root,
    store,
    current().id,
    "publication-replay",
  );
  await git(
    repoDir,
    "remote",
    "set-url",
    "origin",
    "git@github.com:example/repo.git",
  );
  store.patchRepository(
    { path: repoDir, origin: "example/repo" },
    { reviewer },
  );
  const runId = "finished-reviewer";
  const task = store.update(current().id, {
    phase: "reviewing",
    repository: "example/repo",
    resumePrNumber: 1,
    resolution: {
      ...current().resolution,
      reviewerAgentId: "retained-reviewer",
      currentRunId: null,
    },
  });
  const completion = completionSchema.parse({
    taskId: task.id,
    runId,
    eventId: "authenticated-review",
    status: "changes_required",
    head: initialSha,
    summary: "Fix the boundary",
    reviewText: "Keep ownership on the original operation.",
  });
  store.putRun({
    ...f.run(runId, "reviewer", "retained-reviewer"),
    head: initialSha,
    active: false,
    status: "finished",
    released: true,
    completion,
  });
  const run = store.run(runId);
  assert.ok(run);
  store.db
    .prepare(
      "INSERT INTO receipts(id,task,run,hash,response) VALUES(?,?,?,?,?)",
    )
    .run(
      completion.eventId,
      task.id,
      run.id,
      digest(JSON.stringify(completion)),
      JSON.stringify({ accepted: true }),
    );
  const journal = () =>
    store.getMeta<{ hash: string; transientFailure?: boolean }>(
      reviewPublicationKey(runId),
    );
  await assert.rejects(
    publishFormalReview(
      store,
      task,
      run,
      completion.status,
      completion.reviewText!,
      reviewer,
      () => true,
      forge,
    ),
    /response was lost/,
  );
  assert.equal(posts, 1);
  const original = journal();
  assert.equal(original?.transientFailure, true);
  const offer = runtime
    .taskNext({ taskId: task.id })
    .explicitCommands?.find((item) => item.args.id === `publication.${runId}`);
  assert.ok(offer);
  assert.deepEqual(offer.warnings, ["effect_may_land"]);
  try {
    const cleared = await f.command({ ...offer.args, accept: offer.warnings });
    assert.equal(cleared.explicitResolution?.status, "applied");
    assert.deepEqual(journal(), original);
    assert.deepEqual(store.run(run.id)?.completion, completion);
    const next = runtime.taskNext({ taskId: task.id });
    assert.ok(
      !next.explicitCommands?.some((item) => item.args.id === offer.args.id),
    );
    assert.ok(
      next.verbs.some(
        (item) =>
          item.available && item.args?.effect === `review_publication.${runId}`,
      ),
    );
    const hiddenReview: FormalReviewRuntime = {
      ...forge,
      runGh: async (task, endpoint, args, token) =>
        args.includes("--paginate")
          ? [[]]
          : forge.runGh!(task, endpoint, args, token),
    };
    // A complete inventory may lag the POST. Neither the scheduled publication
    // path nor an explicit retry may POST again after this clear.
    await assert.rejects(
      publishFormalReview(
        store,
        current(),
        run,
        completion.status,
        completion.reviewText!,
        reviewer,
        () => true,
        hiddenReview,
      ),
      /exact-marker match; found 0/,
    );
    await assert.rejects(
      reconcileFormalReviewPublication(
        store,
        current(),
        run,
        reviewer,
        "Check the original review",
        () => true,
        hiddenReview,
      ),
      /exact-marker match; found 0/,
    );
    assert.equal(posts, 1);
    assert.deepEqual(journal(), original);
    store.setMeta("paused", false);
  } finally {
    allowObservation();
  }
  await runtime.engine.quiesce();
  assert.equal(posts, 1);
  assert.ok(observed > 0);
  assert.equal(current().resolution.review?.reviewId, 505);
  assert.equal(current().resolution.review?.head, initialSha);
  assert.equal(
    store.getMeta<{ reviewId?: number }>(reviewPublicationKey(runId))?.reviewId,
    505,
  );
});

test("next and run.release respect the initial worker's pending native create", async (t) => {
  let entered = () => {};
  const creating = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let respond = () => {};
  const reply = new Promise<void>((resolve) => {
    respond = resolve;
  });
  let creates = 0;
  let token = "";
  const f = await fixture(t, {
    verifyWorkspace: async (task: Task) => task.branch,
    createAgent: async (_task: Task, credential: string) => {
      creates++;
      token = credential;
      entered();
      await reply;
      return { id: "original-worker", workspaceId: "workspace" };
    },
  });
  const { store, runtime, current, command, root } = f;
  await attachGitCheckout(root, store, current().id, "delayed-worker-create");
  const task = store.update(current().id, {
    phase: "dispatching",
    profile: profile("worker"),
    prHead: null,
    prUrl: null,
  });
  store.setMeta("paused", false);
  const wake = runtime.engine.wakeTask(task.id);
  let runId: string | null = null;
  try {
    await Promise.race([
      creating,
      wake.then(() => {
        throw Error(current().reason);
      }),
    ]);
    const pending = current();
    runId = pending.runId;
    assert.ok(runId);
    assert.equal(pending.agentId, null);
    assert.equal(pending.agentIntent, true);
    assert.notEqual(pending.resolution.stop?.fact?.code, "creation_in_flight");
    const next = () => runtime.taskNext({ taskId: task.id });
    assert.ok(
      !next().explicitCommands?.some(
        (offer) => offer.args.run === runId || offer.args.replacing === runId,
      ),
    );
    const release = {
      action: "run.release",
      run: runId,
      accept: ["live_turn", "unreported_result", "creation_in_flight"],
    };
    await assert.rejects(command(release), /may still bind a thread/);
    assert.equal(store.credentialRunForToken(token), runId);
    assert.equal(current().runId, runId);

    runtime.engine.resolution.waiting(
      current(),
      "The original create can still answer",
      "lifecycle",
      {
        fact: { code: "creation_in_flight", subject: runId },
      },
    );
    const stop = current().resolution.stop;
    assert.ok(stop);
    assert.ok(
      !next().explicitCommands?.some((offer) => offer.args.id === stop.since),
    );
    await assert.rejects(
      command({ action: "record.clear", kind: "stop", id: stop.since }),
      /may still bind a thread/,
    );
    await assert.rejects(command(release), /may still bind a thread/);
    assert.equal(f.audit().length, 0);
  } finally {
    respond();
    await wake;
    await runtime.engine.quiesce();
  }
  assert.equal(creates, 1);
  assert.equal(current().runId, runId);
  assert.equal(current().agentId, "original-worker");
});

test("an outage or retry keeps the same merge clear identity, and a new same-head send gets its own", async (t) => {
  const { store, current, runtime, command } = await fixture(t);
  const id = current().id;
  const clearId = "merge-response.merge-response";
  const requestedAt = "2026-11-23T10:00:00.000Z";
  const start = (at: string) =>
    store.update(
      id,
      {
        phase: "merging",
        resolution: {
          ...current().resolution,
          mergeIntent: true,
          mergeHead: head,
          mergeRequestedAt: at,
          mergeResponseOutcome: "uncertain",
          mergeRetryAt: null,
          mergeRetryOutcome: null,
          mergeAutoRetryExhausted: false,
        },
      },
      "merge_intent",
    );
  const offer = () =>
    runtime
      .taskNext({ taskId: id })
      .explicitCommands?.find(
        (item) => item.action === "record.clear" && item.args.id === clearId,
      );
  start(requestedAt);
  const first = offer();
  assert.ok(first);
  const input = {
    action: "record.clear",
    kind: "effect",
    id: clearId,
    accept: first.warnings,
  };
  const result = await command(input);
  assert.equal(result.explicitResolution?.status, "applied");
  await runtime.engine.quiesce();

  // A forge outage restarts the proof clock. A pending reissue updates its
  // own response but leaves the initial guarded send as the same occurrence.
  const outageAt = "2026-11-23T10:01:00.000Z";
  store.update(
    id,
    { resolution: { ...current().resolution, mergeRequestedAt: outageAt } },
    "uncertain_merge_outage_wait",
  );
  assert.equal(offer(), undefined);
  await assert.rejects(command(input), /No current effect/);
  store.update(
    id,
    {
      resolution: {
        ...current().resolution,
        mergeRetryAt: outageAt,
        mergeRetryOutcome: "uncertain",
      },
    },
    "merge_retry_uncertain",
  );
  assert.equal(offer(), undefined);
  assert.ok(
    blockingRecoveryEffects(store, current()).some(
      (effect) => effect.kind === "merge-response",
    ),
  );
  assert.equal(current().resolution.mergeAutoRetryExhausted, true);

  start("2026-11-23T10:02:00.000Z");
  assert.ok(offer());
  assert.equal((await command(input)).explicitResolution?.status, "applied");
  await runtime.engine.quiesce();
});
