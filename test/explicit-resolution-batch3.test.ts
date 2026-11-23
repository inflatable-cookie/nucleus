import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { formatAgentId } from "../shared/agent-identity";
import {
  OPERATOR_BOARD_CALLER,
  runSchema,
  submissionSchema,
  taskControlInputSchema,
  taskControlTaskSchema,
  type Task,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import { runPrompt } from "../core/dispatch/prompts";
import { requiredCheckPollMetaKey } from "../core/forge/index";
import { merged as observeForgeMerge } from "../core/forge/merge";
import { git } from "../core/git/index";
import { stopUnreviewedExternalMerge } from "../core/merge/external-merge-check";
import { QueueRuntime } from "../service/runtime-owner";
import { callCatalogueMethod } from "../service/transport/dispatch";
import { profile } from "./support/fakes";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const MERGED_COMMIT = "c".repeat(40);
const HOST = "paseo-fixture";
const REPO = "/example-batch3";
const PLANNER = formatAgentId(HOST, "live-planner");

async function fixture(
  t: TestContext,
  resolutionOverrides: Record<string, unknown> = {},
  { hostOnly = false, repoPath = REPO }: { hostOnly?: boolean; repoPath?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "explicit-batch3-"));
  const adapter = {
    hostId: HOST,
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
        directory: repoPath,
        workspaceId: null,
      },
    ],
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: false,
    }),
    observe: async (id: string) => ({
      id,
      title: id,
      workspaceId: "ws-1",
      status: "idle",
      directory: repoPath,
    }),
    listAgents: async () => [],
    createRun: async () => ({ id: "created-agent", workspaceId: "ws-1" }),
    agentTimelinePage: async () => ({
      entries: [],
      hasOlder: false,
      hasNewer: false,
      gap: false,
      staleCursor: false,
      reset: false,
      epoch: "e1",
      projection: "canonical",
      startCursor: null,
      endCursor: null,
    }),
    stopAgentTurn: async () => {},
    archiveAgent: async () => {},
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
  store.setMeta("paused", false);
  store.upsertProject({
    key: "example-batch3",
    name: "Example",
    repositories: [{ origin: null, path: repoPath }],
  });
  store.setProjectPlanner({
    key: "example-batch3",
    agentId: PLANNER,
    setBy: "operator",
  });
  const resAdapter = runtime.engine.resolution.adapter as unknown as Record<
    string,
    unknown
  >;
  resAdapter.agentTimelinePage = async () => ({
    entries: [],
    hasOlder: false,
    hasNewer: false,
    gap: false,
    staleCursor: false,
    reset: false,
    epoch: "e1",
    projection: "canonical",
    startCursor: null,
    endCursor: null,
  });
  // `hostOnly` leaves the unbound fallback as the service composes it, so a
  // forge read made outside the task's host context finds no port.
  if (!hostOnly) Object.assign(resAdapter, resolutionOverrides);
  Object.assign(
    adapter as unknown as Record<string, unknown>,
    resolutionOverrides,
  );

  let seq = 0;
  const insertTask = (title: string, prNumber: number): Task => {
    seq += 1;
    const task = store.insert(
      submissionSchema.parse({
        submissionId: `sub-${seq}`,
        title,
        repoPath,
        planningCommit: HEAD,
        handoffPath: "handoff.md",
        originAgentId: PLANNER,
      }),
      HOST,
      "Handoff",
      HEAD,
    );
    return store.update(task.id, {
      repository: "example/repo",
      prUrl: `https://github.com/example/repo/pull/${prNumber}`,
      prHead: HEAD,
      resumePrNumber: prNumber,
    });
  };

  const attachCoordinator = (taskId: string, agentId = "coord-1") => {
    const at = new Date().toISOString();
    const run = runSchema.parse({
      id: `coord-run-${taskId}`,
      taskId,
      role: "recovery",
      status: "running",
      active: true,
      released: false,
      agentId,
      hostId: HOST,
      generation: store.task(taskId).coordinatorGeneration,
      head: HEAD,
      base: "main",
      workspaceId: "ws-1",
      profile: profile("coord", "test/coord"),
      createdAt: at,
      lastObservedAt: at,
      idleSince: at,
      completion: null,
    });
    store.putRun(run);
    store.update(taskId, {
      resolution: {
        ...store.task(taskId).resolution,
        recoveryActive: true,
        recovery: {
          id: `ep-${taskId}`,
          key: "k",
          generation: run.generation,
          runId: run.id,
          agentId,
          status: "running",
          summary: "",
          idleSince: null,
          incidentId: null,
        },
      },
    });
    return formatAgentId(HOST, agentId);
  };

  const attachReadyReview = (
    taskId: string,
    head = HEAD,
    status: "ready_to_merge" | "changes_required" = "ready_to_merge",
  ) => {
    const at = new Date().toISOString();
    const summary = status === "ready_to_merge" ? "Looks good" : "Handle the missing error case";
    const run = runSchema.parse({
      id: `rev-run-${taskId}`,
      taskId,
      role: "reviewer",
      status: "finished",
      active: false,
      released: true,
      generation: store.task(taskId).coordinatorGeneration,
      head,
      base: "main",
      workspaceId: "ws-1",
      profile: profile("reviewer", "test/reviewer"),
      agentId: "rev-1",
      hostId: HOST,
      createdAt: at,
      lastObservedAt: at,
      idleSince: at,
      completion: {
        taskId,
        runId: `rev-run-${taskId}`,
        eventId: `ev-${taskId}`,
        status,
        head,
        summary,
        ...(status === "changes_required" ? { reviewId: 101 } : {}),
      },
    });
    store.putRun(run);
    store.update(taskId, {
      resolution: {
        ...store.task(taskId).resolution,
        review: {
          taskId,
          runId: run.id,
          eventId: `ev-${taskId}`,
          status,
          head,
          summary,
          reviewId: 101,
        },
      },
    });
    return run;
  };

  const callExplicit = async (
    taskId: string,
    payload: Record<string, unknown>,
    caller = PLANNER,
  ) => {
    const current = store.task(taskId);
    const raw = await callCatalogueMethod(runtime, "queue.task", {
      taskId,
      version: current.version,
      reason: "Explicit resolution test",
      caller,
      ...payload,
    });
    return taskControlTaskSchema.parse(raw);
  };

  return {
    runtime,
    store,
    insertTask,
    attachCoordinator,
    attachReadyReview,
    callExplicit,
  };
}

test("oxide#361/#362: prerequisite wait releases the integration turn and deadlock cannot form", async (t) => {
  const { runtime, store, insertTask } = await fixture(t);
  const t361 = insertTask("oxide#361", 361);
  const t362 = insertTask("oxide#362", 362);

  // #362 holds sequence 1 in verifying; #361 holds sequence 2 waiting on #362.
  store.update(t362.id, {
    phase: "verifying",
    resolution: {
      ...store.task(t362.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  store.update(t361.id, {
    phase: "verifying",
    resolution: {
      ...store.task(t361.id).resolution,
      integrationTurn: { sequence: 2, acceptedAt: new Date().toISOString() },
      stop: {
        reason: "lifecycle",
        detail: `Waiting for repository integration turn: ${t362.title} (${t362.id}) holds it`,
        since: new Date().toISOString(),
        suggestedVerbs: [],
        fact: { code: "integration_turn", subject: t362.id },
      },
    },
    reasonFact: { code: "integration_turn", subject: t362.id },
  });

  assert.equal(
    runtime.engine.resolution.holdsIntegrationTurn(store.task(t362.id)),
    true,
  );
  assert.equal(
    runtime.engine.resolution.holdsIntegrationTurn(store.task(t361.id)),
    false,
  );

  // Setting a prerequisite wait on #362 immediately yields the turn to #361.
  await runtime.taskControl({
    action: "set_prerequisite_wait",
    taskId: t362.id,
    version: store.task(t362.id).version,
    waitsFor: [t361.id],
    reason: "Waiting for #361 to land first",
    caller: PLANNER,
  });

  assert.equal(
    runtime.engine.resolution.integrationActive(store.task(t362.id)),
    false,
  );
  assert.equal(
    runtime.engine.resolution.holdsIntegrationTurn(store.task(t361.id)),
    true,
  );
  // Waiting task #361 re-read the holder and cleared its stale integration_turn stop.
  assert.equal(store.task(t361.id).resolution.stop, null);
});

test("oxide#361/#362: turn.release frees the turn in one step and refreshes waiters; merge_in_flight warns", async (t) => {
  const { runtime, store, insertTask, callExplicit } = await fixture(t);
  const t361 = insertTask("oxide#361", 361);
  const t362 = insertTask("oxide#362", 362);

  store.update(t362.id, {
    phase: "verifying",
    resolution: {
      ...store.task(t362.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  store.update(t361.id, {
    phase: "verifying",
    resolution: {
      ...store.task(t361.id).resolution,
      integrationTurn: { sequence: 2, acceptedAt: new Date().toISOString() },
      stop: {
        reason: "lifecycle",
        detail: `Waiting for repository integration turn: ${t362.title} (${t362.id}) holds it`,
        since: new Date().toISOString(),
        suggestedVerbs: [],
        fact: { code: "integration_turn", subject: t362.id },
      },
    },
    reasonFact: { code: "integration_turn", subject: t362.id },
  });

  const released = await callExplicit(t362.id, { action: "turn.release" });
  assert.equal(released.explicitResolution?.status, "applied");
  assert.equal(released.resolution.integrationTurn, null);
  assert.equal(
    runtime.engine.resolution.holdsIntegrationTurn(store.task(t361.id)),
    true,
  );
  assert.equal(store.task(t361.id).resolution.stop, null);
  assert.equal(
    store.eventsAll(t362.id).filter((e) => e.kind === "owner_resolution")
      .length,
    1,
  );

  // merge_in_flight warning on turn.release: refused without accept, applied with accept.
  const t363 = insertTask("oxide#363", 363);
  store.update(t363.id, {
    phase: "merging",
    resolution: {
      ...store.task(t363.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      mergeIntent: true,
      mergeHead: HEAD,
    },
  });
  const warned = await callExplicit(t363.id, { action: "turn.release" });
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warned.explicitResolution?.warnings.map((w) => w.id),
    ["merge_in_flight"],
  );
  assert.notEqual(store.task(t363.id).resolution.integrationTurn, null);

  const accepted = await callExplicit(t363.id, {
    action: "turn.release",
    accept: ["merge_in_flight"],
  });
  assert.equal(accepted.explicitResolution?.status, "applied");
  assert.equal(accepted.resolution.integrationTurn, null);
});

test("oxide#361/#362: turn.take displaces holder with turn_held and merge_in_flight warnings", async (t) => {
  const { runtime, store, insertTask, callExplicit } = await fixture(t);
  const t361 = insertTask("oxide#361", 361);
  const t362 = insertTask("oxide#362", 362);

  store.update(t362.id, {
    phase: "merging",
    resolution: {
      ...store.task(t362.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      mergeIntent: true,
      mergeHead: HEAD,
    },
  });
  store.update(t361.id, {
    phase: "verifying",
    resolution: {
      ...store.task(t361.id).resolution,
      integrationTurn: { sequence: 2, acceptedAt: new Date().toISOString() },
      stop: {
        reason: "lifecycle",
        detail: `Waiting for repository integration turn: ${t362.title} (${t362.id}) holds it`,
        since: new Date().toISOString(),
        suggestedVerbs: [],
        fact: { code: "integration_turn", subject: t362.id },
      },
    },
    reasonFact: { code: "integration_turn", subject: t362.id },
  });

  const warned = await callExplicit(t361.id, { action: "turn.take" });
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warned.explicitResolution?.warnings.map((w) => w.id),
    ["turn_held", "merge_in_flight"],
  );
  // Nothing changed on warning.
  assert.notEqual(store.task(t362.id).resolution.integrationTurn, null);

  const taken = await callExplicit(t361.id, {
    action: "turn.take",
    accept: ["turn_held", "merge_in_flight"],
  });
  assert.equal(taken.explicitResolution?.status, "applied");
  assert.equal(store.task(t362.id).resolution.integrationTurn, null);
  assert.equal(store.task(t361.id).resolution.stop, null);
  assert.equal(
    runtime.engine.resolution.holdsIntegrationTurn(store.task(t361.id)),
    true,
  );
});

test("merge.now enforces both hard gates even with accept, warns on turn_held/checks/holds, and allows coordinators", async (t) => {
  let mergeCalls = 0;
  let mergedResponse:
    | { merged: boolean; commit: string | null; head: string; base: string }
    | Error = {
    merged: false,
    commit: null,
    head: HEAD,
    base: "main",
  };
  let checksWait = "Non-required check failed";

  const {
    store,
    insertTask,
    attachCoordinator,
    attachReadyReview,
    callExplicit,
  } = await fixture(t, {
    verifyPr: async (task: Task) => ({
      number: task.resumePrNumber ?? 80,
      url: task.prUrl ?? "https://github.com/example/repo/pull/80",
      head: HEAD,
      base: "main",
      state: "OPEN",
      merged: false,
    }),
    merge: async () => {
      mergeCalls += 1;
    },
    merged: async () => {
      if (mergedResponse instanceof Error) throw mergedResponse;
      return mergedResponse;
    },
    requiredChecks: async () => ({
      head: HEAD,
      wait: checksWait,
      checksFailed: Boolean(checksWait),
    }),
  });

  const task = insertTask("merge target", 10);
  const holder = insertTask("other holder", 11);
  store.update(task.id, { phase: "verifying" });

  // Hard gate 1: no applied verdict or operator source acceptance refuses even with accept.
  await assert.rejects(
    () =>
      callExplicit(task.id, {
        action: "merge.now",
        head: HEAD,
        accept: ["turn_held", "checks", "holds"],
      }),
    /no applied review verdict or explicit operator source acceptance/,
  );

  // Attach ready_to_merge review at HEAD; wrong head still refuses.
  attachReadyReview(task.id, HEAD);
  await assert.rejects(
    () =>
      callExplicit(task.id, {
        action: "merge.now",
        head: OTHER_HEAD,
        accept: ["turn_held", "checks", "holds"],
      }),
    /no applied review verdict or explicit operator source acceptance/,
  );

  // Hard gate 2: unknown earlier merge outcome refuses if GitHub cannot confirm unmerged.
  store.update(task.id, {
    resolution: {
      ...store.task(task.id).resolution,
      mergeIntent: true,
      mergeHead: HEAD,
      mergeResponseOutcome: "uncertain",
    },
  });
  mergedResponse = new Error("GitHub 502");
  await assert.rejects(
    () =>
      callExplicit(task.id, {
        action: "merge.now",
        head: HEAD,
        accept: ["turn_held", "checks", "holds"],
      }),
    /earlier merge request's outcome is unknown/,
  );

  // If GitHub says already merged, still refuses and points to closeout.now.
  mergedResponse = {
    merged: true,
    commit: MERGED_COMMIT,
    head: HEAD,
    base: "main",
  };
  await assert.rejects(
    () =>
      callExplicit(task.id, {
        action: "merge.now",
        head: HEAD,
        accept: ["turn_held", "checks", "holds"],
      }),
    /already merged.*closeout\.now/,
  );

  // When GitHub confirms unmerged in the same call, hard gate 2 passes; warnings still gate!
  mergedResponse = {
    merged: false,
    commit: null,
    head: HEAD,
    base: "main",
  };
  store.update(holder.id, {
    phase: "verifying",
    resolution: {
      ...store.task(holder.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  store.update(task.id, {
    holds: {
      merge: {
        reason: "Hold for window",
        owner: PLANNER,
        at: new Date().toISOString(),
        generation: 1,
        until: null,
      },
    },
  });

  const coordinator = attachCoordinator(task.id);
  const warned = await callExplicit(
    task.id,
    { action: "merge.now", head: HEAD },
    coordinator,
  );
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warned.explicitResolution?.warnings.map((w) => w.id),
    ["turn_held", "checks", "holds", "hold_owner"],
  );
  assert.equal(mergeCalls, 0);

  // Coordinator cannot override a planner-placed hold (hold_owner is planner/operator only).
  await assert.rejects(
    () =>
      callExplicit(
        task.id,
        {
          action: "merge.now",
          head: HEAD,
          accept: ["turn_held", "checks", "holds", "hold_owner"],
        },
        coordinator,
      ),
    /Only the live responsible planner or operator board can accept hold_owner/,
  );

  // Once the planner hold is absent, coordinator can apply merge.now with turn_held + checks.
  store.update(task.id, { holds: {} });
  const applied = await callExplicit(
    task.id,
    {
      action: "merge.now",
      head: HEAD,
      accept: ["turn_held", "checks"],
    },
    coordinator,
  );
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(mergeCalls, 1);
  assert.equal(applied.resolution.mergeResponseOutcome, "accepted");
  assert.equal(applied.resolution.mergeHead, HEAD);
});

test("a coordinator cannot accept creation_in_flight: no second thread beside a create the host may still answer (Spec 068)", async (t) => {
  const { store, insertTask, attachCoordinator, callExplicit } = await fixture(t);
  const task = insertTask("In-flight create", 44);
  store.update(task.id, {
    phase: "working",
    agentIntent: true,
    agentId: null,
    runId: "in-flight-worker-run",
    reason: "Uncertain worker creation in-flight-worker-run: its host may still answer the create command",
    resolution: {
      ...store.task(task.id).resolution,
      stop: {
        reason: "lifecycle",
        detail:
          "Uncertain worker creation in-flight-worker-run: its host may still answer the create command",
        since: new Date().toISOString(),
        suggestedVerbs: [],
        fact: { code: "creation_in_flight", subject: "in-flight-worker-run" },
      },
    },
  });
  const coordinator = attachCoordinator(task.id);
  await assert.rejects(
    () =>
      callExplicit(
        task.id,
        {
          action: "run.start",
          role: "worker",
          agent: "fresh",
          replacing: "in-flight-worker-run",
          accept: ["duplicate_thread", "creation_in_flight"],
        },
        coordinator,
      ),
    /Only the live responsible planner or operator board can accept creation_in_flight/,
  );
});

test("merge.now and closeout.now read forge ports on the task's host, not the unbound fallback", async (t) => {
  const calls: string[] = [];
  let mergedState = false;
  const { runtime, store, insertTask, attachReadyReview, callExplicit } =
    await fixture(
      t,
      {
        merged: async (task: Task) => {
          calls.push(`merged:${task.id}`);
          return {
            merged: mergedState,
            commit: mergedState ? MERGED_COMMIT : null,
            head: HEAD,
            base: "main",
          };
        },
        verifyPrIdentity: async () => {
          calls.push("verifyPrIdentity");
        },
        requiredChecks: async () => {
          calls.push("requiredChecks");
          return { head: HEAD };
        },
        merge: async () => {
          calls.push("merge");
        },
      },
      { hostOnly: true },
    );
  // The service's fallback carries no forge ports; only the bound host does.
  assert.equal(
    (runtime.engine.resolution.adapter as { merged?: unknown }).merged,
    undefined,
  );

  const task = insertTask("host-bound merge", 30);
  assert.equal(task.hostId, HOST);
  store.update(task.id, { phase: "verifying" });
  attachReadyReview(task.id, HEAD);
  const merged = await callExplicit(task.id, {
    action: "merge.now",
    head: HEAD,
  });
  assert.equal(merged.explicitResolution?.status, "applied");
  assert.equal(merged.phase, "merging");
  assert.deepEqual(calls, [
    `merged:${task.id}`,
    "verifyPrIdentity",
    "requiredChecks",
    "merge",
  ]);

  const parked = insertTask("host-bound closeout", 31);
  attachReadyReview(parked.id, HEAD);
  store.update(parked.id, { phase: "needs_attention" });
  mergedState = true;
  calls.length = 0;
  const closed = await callExplicit(parked.id, { action: "closeout.now" });
  assert.equal(closed.explicitResolution?.status, "applied");
  assert.equal(closed.resolution.mergedCommit, MERGED_COMMIT);
  assert.ok(calls.includes(`merged:${parked.id}`));
});

test("closeout.now closes merged-but-parked task, enforces hard gate, and gates unverified_merge to operator board", async (t) => {
  let syncCalls = 0;
  let mergedResult:
    | { merged: boolean; commit: string | null; head: string; base: string }
    | Error = new Error("GitHub offline");

  const {
    runtime,
    store,
    insertTask,
    attachCoordinator,
    attachReadyReview,
    callExplicit,
  } = await fixture(t, {
    merged: async () => {
      if (mergedResult instanceof Error) throw mergedResult;
      return mergedResult;
    },
    syncMain: async () => {
      syncCalls += 1;
      return MERGED_COMMIT;
    },
  });

  // Case 1: merged-but-parked task closes in one step via coordinator AND reaches sync + closeout.
  const parked = insertTask("parked merged", 20);
  attachReadyReview(parked.id, HEAD);
  store.update(parked.id, {
    phase: "needs_attention",
    resolution: {
      ...store.task(parked.id).resolution,
      mergedCommit: MERGED_COMMIT,
      mergeHead: HEAD,
      attention: true,
      stop: {
        reason: "escalated",
        detail: "Parked after merge",
        since: new Date().toISOString(),
        suggestedVerbs: [],
      },
    },
  });
  const coordinator = attachCoordinator(parked.id);
  const warnedClose = await callExplicit(
    parked.id,
    { action: "closeout.now" },
    coordinator,
  );
  assert.equal(warnedClose.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warnedClose.explicitResolution?.warnings.map((w) => w.id),
    ["live_runs"],
  );
  const closed = await callExplicit(
    parked.id,
    { action: "closeout.now", accept: ["live_runs"] },
    coordinator,
  );
  assert.equal(closed.explicitResolution?.status, "applied");
  assert.equal(closed.phase, "syncing");
  assert.equal(closed.resolution.stop, null);
  assert.equal(closed.resolution.attention, false);
  assert.equal(closed.resolution.recoveryActive, false);
  assert.equal(closed.resolution.recovery?.status, "resolved");
  assert.ok(closed.resolution.integrationTurn);
  assert.equal(
    store.runs(parked.id).some((r) => !r.released),
    false,
  );
  // Real task quantum advances syncing -> closing using the handoff.
  await runtime.engine.scheduleTaskQuantum(parked.id);
  assert.equal(syncCalls, 1);
  assert.equal(store.task(parked.id).phase, "closing");

  // Case 2: hard gate refuses when no applied verdict or operator source acceptance exists.
  const unreviewed = insertTask("unreviewed external merge", 21);
  mergedResult = {
    merged: true,
    commit: MERGED_COMMIT,
    head: HEAD,
    base: "main",
  };
  await assert.rejects(
    () =>
      callExplicit(
        unreviewed.id,
        { action: "closeout.now", accept: ["no_verdict"] },
        OPERATOR_BOARD_CALLER,
      ),
    /no applied review verdict or explicit operator source acceptance/,
  );

  // Case 3: operator source acceptance passes hard gate, warns no_verdict + unverified_merge when GitHub is unreadable.
  store.update(unreviewed.id, {
    resolution: {
      ...store.task(unreviewed.id).resolution,
      ownerAcceptances: [
        {
          kind: "operator_source",
          head: HEAD,
          prNumber: 21,
          review: null,
          reason: "Operator verified source",
          qualification: HEAD,
          actor: { agentId: OPERATOR_BOARD_CALLER, role: "operator" },
          authority: { kind: "operator", note: null },
          at: new Date().toISOString(),
          missingEvidence: "No reviewer verdict",
        },
      ],
    },
  });
  mergedResult = new Error("GitHub unreachable");

  // Planner cannot accept unverified_merge (operator only).
  await assert.rejects(
    () =>
      callExplicit(
        unreviewed.id,
        {
          action: "closeout.now",
          mergedCommit: MERGED_COMMIT,
          accept: ["unverified_merge", "no_verdict"],
        },
        PLANNER,
      ),
    /Only the operator board can accept unverified_merge/,
  );

  // Operator board sees both warnings without accept.
  const warned = await callExplicit(
    unreviewed.id,
    { action: "closeout.now", mergedCommit: MERGED_COMMIT },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warned.explicitResolution?.warnings.map((w) => w.id),
    ["unverified_merge", "no_verdict"],
  );

  // Operator board applies with both warnings accepted.
  const applied = await callExplicit(
    unreviewed.id,
    {
      action: "closeout.now",
      mergedCommit: MERGED_COMMIT,
      accept: ["unverified_merge", "no_verdict"],
    },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.resolution.mergedCommit, MERGED_COMMIT);
  assert.equal(applied.phase, "syncing");
});

test("a planner explicitly accepts a verified external merge without a review and closes it out", async (t) => {
  let observedHead = HEAD;
  let observedCommit = MERGED_COMMIT;
  let observedMerged = true;
  let mergeRequests = 0;
  let observedExternalOnly = false;
  const { runtime, store, insertTask, attachCoordinator, callExplicit } = await fixture(t, {
    merged: async (_task: Task, options?: { externalOnly: boolean }) => {
      if (options?.externalOnly) observedExternalOnly = true;
      return { merged: observedMerged, commit: observedMerged ? observedCommit : null, head: observedHead, base: "main" };
    },
    merge: async () => { mergeRequests++; },
    syncMain: async () => MERGED_COMMIT,
  });
  runtime.engine.resolution.closeoutAuthority = async () => "queue";

  const task = insertTask("Merged outside Nucleus without review", 39);
  store.update(task.id, { phase: "reviewing" });
  stopUnreviewedExternalMerge(
    { store, resolution: runtime.engine.resolution },
    store.task(task.id),
    HEAD,
    MERGED_COMMIT,
  );
  const command = runtime.taskNext({ taskId: task.id }).explicitCommands?.find(
    (entry) => entry.action === "closeout.now",
  );
  assert.deepEqual(command?.warnings, ["unreviewed_merge"]);
  assert.match(command?.note ?? "", /No reviewer verdict exists/);

  const before = store.task(task.id);
  const warned = await callExplicit(task.id, { action: "closeout.now" });
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(warned.explicitResolution?.warnings.map((entry) => entry.id), ["unreviewed_merge"]);
  assert.match(warned.explicitResolution?.warnings[0]?.text ?? "", /No reviewer verdict exists/);
  assert.deepEqual(store.task(task.id), before);
  assert.equal(observedExternalOnly, true);

  const acceptCloseout = { action: "closeout.now", accept: ["unreviewed_merge"] };
  await assert.rejects(
    runtime.engine.performTaskControl(taskControlInputSchema.parse({
      action: "move",
      to: "closeout",
      force: true,
      caller: PLANNER,
      taskId: task.id,
      version: before.version,
      reason: "A forced closeout still needs source acceptance",
    })),
    /closeout.now with accept \["unreviewed_merge"\]/,
  );
  observedHead = OTHER_HEAD;
  await assert.rejects(callExplicit(task.id, acceptCloseout), /no applied review verdict/);
  observedHead = HEAD;
  observedCommit = OTHER_HEAD;
  await assert.rejects(callExplicit(task.id, acceptCloseout), /no applied review verdict/);
  observedCommit = MERGED_COMMIT;
  await assert.rejects(
    callExplicit(task.id, acceptCloseout, formatAgentId(HOST, "worker")),
    /Explicit resolution requires/,
  );

  const coordinated = insertTask("Unreviewed merge with a coordinator", 41);
  store.update(coordinated.id, {
    phase: "blocked",
    resolution: {
      ...coordinated.resolution,
      unreviewedMerge: { head: HEAD, commit: MERGED_COMMIT, prNumber: 41 },
    },
  });
  const coordinator = attachCoordinator(coordinated.id);
  await assert.rejects(
    callExplicit(coordinated.id, acceptCloseout, coordinator),
    /Only the live responsible planner or operator board can accept unreviewed_merge/,
  );
  assert.equal(store.task(coordinated.id).resolution.ownerAcceptances.length, 0);
  const applied = await callExplicit(task.id, acceptCloseout);
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.phase, "syncing");
  assert.equal(applied.resolution.mergedCommit, MERGED_COMMIT);
  assert.equal(applied.resolution.review, null);
  assert.equal(applied.resolution.mergedWithNone, true);
  assert.equal(applied.resolution.ownerAcceptances.length, 1);
  const acceptance = applied.resolution.ownerAcceptances[0];
  assert.equal(acceptance?.kind, "external_merge_source");
  assert.equal(acceptance?.head, HEAD);
  assert.equal(acceptance?.mergedCommit, MERGED_COMMIT);
  assert.equal(acceptance?.prNumber, 39);
  assert.deepEqual(acceptance?.actor, { agentId: PLANNER, role: "planner" });
  assert.deepEqual(acceptance?.authority, { kind: "planner", note: null });
  assert.equal(acceptance?.reason, "Explicit resolution test");
  assert.match(acceptance?.missingEvidence ?? "", /No reviewer verdict exists/);
  assert.equal(acceptance?.review, null);
  assert.equal(store.eventsAll(task.id).filter((event) => event.kind === "owner_acceptance").length, 1);
  assert.ok(store.eventsAll(task.id).some((event) => event.kind === "planner_escalation_resolved"));
  await runtime.engine.scheduleTaskQuantum(task.id);
  await runtime.engine.scheduleTaskQuantum(task.id);
  assert.equal(store.task(task.id).phase, "done");

  const open = insertTask("Unreviewed PR still open", 40);
  store.update(open.id, { phase: "verifying" });
  observedMerged = false;
  await assert.rejects(
    callExplicit(open.id, acceptCloseout),
    /GitHub reports the PR is not merged/,
  );
  await assert.rejects(
    callExplicit(open.id, { action: "merge.now", head: HEAD, accept: ["unreviewed_merge"] }),
    /no applied review verdict or explicit operator source acceptance/,
  );
  assert.equal(store.task(open.id).resolution.mergeIntent, false);
  assert.equal(mergeRequests, 0);

  observedMerged = true;
  store.update(open.id, {
    phase: "merging",
    resolution: {
      ...store.task(open.id).resolution,
      mergeIntent: true,
      mergeHead: HEAD,
    },
  });
  await assert.rejects(
    callExplicit(open.id, acceptCloseout),
    /no applied review verdict or explicit operator source acceptance/,
  );
  assert.equal(store.task(open.id).resolution.ownerAcceptances.length, 0);
});

async function externalMergeFixture(t: TestContext, advance = false) {
  const root = mkdtempSync(join(tmpdir(), "explicit-external-merge-"));
  const repoPath = join(root, "repo");
  const directory = join(root, "work");
  const remote = join(root, "remote.git");
  const { runtime, store, insertTask, attachReadyReview, callExplicit } = await fixture(
    t,
    { merged: observeForgeMerge },
    { repoPath },
  );
  const priorPath = process.env.PATH;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  });
  const task = insertTask("Externally merged source", 49);

  await git(root, "init", "--bare", remote);
  await git(root, "init", "-b", task.baseBranch, repoPath);
  await git(repoPath, "config", "user.name", "Fixture");
  await git(repoPath, "config", "user.email", "fixture@example.invalid");
  await git(repoPath, "commit", "--allow-empty", "-m", "Base");
  await git(repoPath, "remote", "add", "origin", remote);
  await git(repoPath, "push", "origin", task.baseBranch);
  const base = await git(repoPath, "rev-parse", "HEAD");
  await git(repoPath, "worktree", "add", "-b", task.branch, directory);
  await git(directory, "commit", "--allow-empty", "-m", "Task source");
  const recordedHead = await git(directory, "rev-parse", "HEAD");
  if (advance) await git(directory, "commit", "--allow-empty", "-m", "Planner follow-up");
  const head = await git(directory, "rev-parse", "HEAD");
  await git(repoPath, "merge", "--no-ff", "-m", "Merge task PR", task.branch);
  const commit = await git(repoPath, "rev-parse", "HEAD");

  const bin = join(root, "bin");
  const response = join(root, "pr.json");
  const pr = {
    number: 49,
    html_url: task.prUrl,
    state: "closed",
    draft: false,
    merged: true,
    merge_commit_sha: commit,
    base: { ref: task.baseBranch, repo: { full_name: "example/repo" } },
    head: { ref: task.branch, sha: head, repo: { full_name: "example/repo" } },
  };
  const setPr = (patch: Partial<typeof pr> = {}) =>
    writeFileSync(response, JSON.stringify({ ...pr, ...patch }));
  setPr();
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
if (process.argv.slice(2).join(" ") !== "api repos/example/repo/pulls/49") process.exit(1);
process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(response)}));
`, { mode: 0o755 });
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env node
process.exit(require("node:child_process").spawnSync("git-upload-pack", [${JSON.stringify(remote)}], { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${priorPath ?? ""}`;
  await git(repoPath, "remote", "set-url", "origin", "git@github.com:example/repo.git");
  const publishMerge = () => git(repoPath, "push", remote, task.baseBranch);
  store.update(task.id, { phase: "blocked", prHead: recordedHead, directory, workspaceId: "ws-1" });
  return { runtime, store, task, attachReadyReview, callExplicit, pr, setPr, base, recordedHead, head, commit, publishMerge };
}

test("the planner can close out a parked external merge with outstanding published changes", async (t) => {
  const { runtime, store, task, attachReadyReview, callExplicit, head, commit, publishMerge } = await externalMergeFixture(t);
  await publishMerge();
  const review = attachReadyReview(task.id, head, "changes_required");
  store.event(task.id, "review_result_applied", review.id);
  const reviewBefore = store.task(task.id).resolution.review;
  stopUnreviewedExternalMerge(
    { store, resolution: runtime.engine.resolution },
    store.task(task.id),
    head,
    commit,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const command = runtime.taskNext({ taskId: task.id }).explicitCommands?.find(
    (entry) => entry.action === "closeout.now",
  );
  assert.deepEqual(command?.warnings, ["unreviewed_merge"]);
  assert.match(command?.note ?? "", /changes_required/);
  const warned = await callExplicit(task.id, { action: "closeout.now" });
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.match(warned.explicitResolution?.warnings[0]?.text ?? "", /changes_required/);

  const applied = await callExplicit(task.id, { action: "closeout.now", accept: ["unreviewed_merge"] });
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.deepEqual(applied.resolution.review, reviewBefore);
  assert.match(applied.resolution.ownerAcceptances[0]?.missingEvidence ?? "", /changes_required/);
});

test("closeout.now accepts the task PR's verified descendant with an already-advanced checkout", async (t) => {
  const { runtime, store, task, attachReadyReview, callExplicit, pr, setPr, base, recordedHead, head, commit, publishMerge } = await externalMergeFixture(t, true);
  const review = attachReadyReview(task.id, recordedHead);
  store.event(task.id, "review_result_applied", review.id);
  const before = store.task(task.id);
  const input = { action: "closeout.now", accept: ["unreviewed_merge"] };
  await publishMerge();
  const warned = await callExplicit(task.id, { action: "closeout.now" });
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.match(warned.explicitResolution?.warnings[0]?.text ?? "", new RegExp(head));

  const tree = await git(task.repoPath, "rev-parse", `${head}^{tree}`);
  const unpublished = await git(task.repoPath, "commit-tree", tree, "-m", "Unpublished");
  setPr({ merge_commit_sha: unpublished });
  await assert.rejects(callExplicit(task.id, input), /merge commit is not on the task base/);
  setPr({ head: { ...pr.head, sha: base } });
  await assert.rejects(callExplicit(task.id, input), /merged head does not descend from the recorded task source/);
  setPr({ head: { ...pr.head, repo: { full_name: "some-fork/repo" } } });
  await assert.rejects(callExplicit(task.id, input), /External merge identity does not match/);
  assert.deepEqual(store.task(task.id), before);
  setPr();
  await assert.rejects(
    runtime.engine.performTaskControl(taskControlInputSchema.parse({
      action: "move", to: "closeout", force: true, caller: PLANNER,
      taskId: task.id, version: before.version, reason: "Close out the merged PR",
    })),
    /closeout\.now/,
  );
  const applied = await callExplicit(task.id, input);
  assert.equal(applied.explicitResolution?.status, "applied");
  assert.equal(applied.prHead, before.prHead);
  assert.equal(applied.resolution.mergeHead, head);
  assert.equal(applied.resolution.mergedCommit, commit);
  assert.equal(applied.resolution.ownerAcceptances[0]?.head, head);
});

test("the closeout coordinator prompt attributes recorded closeout.now source acceptance", async (t) => {
  for (const [caller, role] of [[PLANNER, "planner"], [OPERATOR_BOARD_CALLER, "operator"]] as const) {
    await t.test(role, async (caseContext) => {
      const { store, task, callExplicit, head, publishMerge } = await externalMergeFixture(caseContext);
      await publishMerge();
      await callExplicit(task.id, { action: "closeout.now", accept: ["unreviewed_merge"] }, caller);
      const current = store.task(task.id);
      const run = runSchema.parse({
        id: "closeout-run",
        taskId: task.id,
        role: "closeout",
        status: "running",
        active: true,
        released: false,
        agentId: "closeout-coordinator",
        workspaceId: "ws-1",
        generation: current.coordinatorGeneration,
        head,
        base: task.baseBranch,
        profile: profile("coord", "test/coord"),
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        idleSince: null,
        completion: null,
      });
      const prompt = runPrompt(current, run, "/helper", "/ticket", true);
      assert.match(prompt, new RegExp(`the ${role} .*closeout\\.now`));
      assert.doesNotMatch(prompt, /move to=closeout/);
    });
  }
});

test("deleted levers: restart on merged-but-parked task refuses with closeout.now; stop on done task with turn refuses with turn.release", async (t) => {
  const { runtime, store, insertTask } = await fixture(t);

  const mergedParked = insertTask("merged parked", 30);
  store.update(mergedParked.id, {
    phase: "verifying",
    resolution: {
      ...store.task(mergedParked.id).resolution,
      mergedCommit: MERGED_COMMIT,
      mergeHead: HEAD,
    },
  });
  await assert.rejects(
    () =>
      runtime.taskControl({
        action: "restart",
        taskId: mergedParked.id,
        version: store.task(mergedParked.id).version,
        reason: "Try old restart-to-closeout lever",
        caller: PLANNER,
      }),
    /closeout\.now/,
  );

  const doneWithTurn = insertTask("done with turn", 31);
  store.update(doneWithTurn.id, {
    phase: "done",
    resolution: {
      ...store.task(doneWithTurn.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  await assert.rejects(
    () =>
      runtime.taskControl({
        action: "stop",
        taskId: doneWithTurn.id,
        version: store.task(doneWithTurn.id).version,
        reason: "Try old stop turn-lever",
        caller: PLANNER,
      }),
    /turn\.release/,
  );
});

test("review findings: exact-head gate ignores skipPRReview and pending proofs, validates target branch, preserves FIFO waiters and late merge responses", async (t) => {
  let mergeCallNum = 0;
  let resolveFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    resolveFirstEntered = resolve;
  });
  let rejectFirstMerge!: (error: Error) => void;
  let mergedBase = "release";
  let mergedState = false;

  const { runtime, store, insertTask, attachReadyReview, callExplicit } =
    await fixture(t, {
      merge: async () => {
        mergeCallNum += 1;
        if (mergeCallNum === 1) {
          resolveFirstEntered();
          await new Promise<void>((_, reject) => {
            rejectFirstMerge = reject;
          });
        }
      },
      merged: async () => ({
        merged: mergedState,
        commit: mergedState ? MERGED_COMMIT : null,
        head: HEAD,
        base: mergedBase,
      }),
    });

  // 1. skipPRReview: true and sourceApproved with awaitingProofs still fail the hard gate.
  const skipped = insertTask("skip review task", 40);
  store.update(skipped.id, { skipPRReview: true, phase: "verifying" });
  await assert.rejects(
    () => callExplicit(skipped.id, { action: "merge.now", head: HEAD }),
    /no applied review verdict or explicit operator source acceptance/,
  );
  mergedState = true;
  mergedBase = "main";
  const skippedWarning = await callExplicit(skipped.id, {
    action: "closeout.now",
    accept: ["no_verdict"],
  });
  assert.equal(skippedWarning.explicitResolution?.status, "warnings");
  assert.deepEqual(skippedWarning.explicitResolution.warnings.map((warning) => warning.id), ["unreviewed_merge"]);
  store.update(skipped.id, {
    resolution: {
      ...store.task(skipped.id).resolution,
      review: {
        taskId: skipped.id,
        runId: "rev-pending-proof",
        eventId: "ev-pending-proof",
        status: "changes_required",
        head: HEAD,
        summary: "Source approved pending proof",
        sourceApproved: true,
        awaitingProofs: [{ proof: "Screenshot", route: "author" }],
      },
    },
  });
  await assert.rejects(
    () => callExplicit(skipped.id, { action: "merge.now", head: HEAD }),
    /no applied review verdict or explicit operator source acceptance/,
  );
  await assert.rejects(
    () => callExplicit(skipped.id, { action: "closeout.now", accept: ["unreviewed_merge"] }),
    /no applied review verdict or explicit operator source acceptance/,
  );

  // 2. Target branch validation: wrong base refuses both merge.now and closeout.now.
  const wrongBase = insertTask("wrong base task", 41);
  attachReadyReview(wrongBase.id, HEAD);
  mergedState = true;
  mergedBase = "release";
  await assert.rejects(
    () => callExplicit(wrongBase.id, { action: "closeout.now" }),
    /merged into release, not task base main/,
  );
  mergedState = false;
  await assert.rejects(
    () => callExplicit(wrongBase.id, { action: "merge.now", head: HEAD }),
    /PR targets release, not task base main/,
  );

  // 3. Late merge response does not overwrite a newer accepted merge outcome.
  mergedBase = "main";
  mergedState = false;
  const race = insertTask("merge race task", 42);
  attachReadyReview(race.id, HEAD);
  const firstPending = callExplicit(race.id, {
    action: "merge.now",
    head: HEAD,
  });
  // Wait deterministically until the first merge request has committed pending and entered finish().
  await firstEntered;
  assert.equal(store.task(race.id).resolution.mergeResponseOutcome, "pending");

  const second = await callExplicit(race.id, {
    action: "merge.now",
    head: HEAD,
  });
  assert.equal(second.explicitResolution?.status, "applied");
  assert.equal(store.task(race.id).resolution.mergeResponseOutcome, "accepted");

  // First request now times out; it must NOT overwrite the newer "accepted" outcome.
  rejectFirstMerge(new Error("first request timed out"));
  await firstPending;
  assert.equal(store.task(race.id).resolution.mergeResponseOutcome, "accepted");
  assert.ok(
    store
      .eventsAll(race.id)
      .some((e) => e.kind === "merge_response_late_uncertain"),
  );

  // 4. turn.take on C displaces holder A while preserving unrelated waiter B's FIFO sequence.
  store.update(race.id, {
    phase: "done",
    resolution: {
      ...store.task(race.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });
  const a = insertTask("holder A", 50);
  const b = insertTask("waiter B", 51);
  const c = insertTask("taker C", 52);
  store.update(a.id, {
    phase: "verifying",
    resolution: {
      ...store.task(a.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  store.update(b.id, {
    phase: "verifying",
    resolution: {
      ...store.task(b.id).resolution,
      integrationTurn: { sequence: 2, acceptedAt: new Date().toISOString() },
    },
  });
  store.update(c.id, {
    phase: "verifying",
    resolution: {
      ...store.task(c.id).resolution,
      integrationTurn: { sequence: 3, acceptedAt: new Date().toISOString() },
    },
  });

  const taken = await callExplicit(c.id, {
    action: "turn.take",
    accept: ["turn_held"],
  });
  assert.equal(taken.explicitResolution?.status, "applied");
  assert.equal(store.task(a.id).resolution.integrationTurn, null);
  assert.equal(store.task(b.id).resolution.integrationTurn?.sequence, 2);
  assert.equal(store.task(c.id).resolution.integrationTurn?.sequence, 1);
  assert.equal(
    runtime.engine.resolution.holdsIntegrationTurn(store.task(c.id)),
    true,
  );
});

test("review round 2: serialize verifier vs explicit merge, honor operator_source with pending proof, preserve unrelated recovery runs, reconcile accepted merge from attention, classify check timeout as warning", async (t) => {
  let mergeCalls = 0;
  let mergeShouldFail = false;
  let mergedFlag = false;
  let checksError: Error | null = null;
  let resolveGateStarted!: () => void;
  const gateStarted = new Promise<void>((resolve) => {
    resolveGateStarted = resolve;
  });
  let releaseGate!: () => void;
  const gateGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const {
    runtime,
    store,
    insertTask,
    attachCoordinator,
    attachReadyReview,
    callExplicit,
  } = await fixture(t, {
    verifyPr: async (task: Task) => ({
      number: task.resumePrNumber ?? 80,
      url: task.prUrl ?? "https://github.com/example/repo/pull/80",
      head: HEAD,
      base: "main",
      state: "OPEN",
      merged: false,
    }),
    merge: async () => {
      mergeCalls += 1;
      if (mergeShouldFail) throw new Error("network timeout");
    },
    merged: async () => ({
      merged: mergedFlag,
      commit: mergedFlag ? MERGED_COMMIT : null,
      head: HEAD,
      base: "main",
    }),
    requiredChecks: async () => {
      if (checksError) throw checksError;
      return { head: HEAD, wait: "" };
    },
    mergeGate: async () => {
      resolveGateStarted();
      await gateGate;
      return { head: HEAD, base: "main", wait: "" };
    },
  });

  // 1. merge-request-serialization: ordinary verifier resumes after explicit merge.now recorded uncertain outcome and must NOT resend.
  const ser = insertTask("serialize merge", 60);
  attachReadyReview(ser.id, HEAD);
  store.update(ser.id, { phase: "verifying" });
  const verifyPromise = runtime.engine.withHost(HOST, () =>
    runtime.engine.resolution.verification(store.task(ser.id), false),
  );
  await gateStarted;
  mergeShouldFail = true;
  const explicitRes = await callExplicit(ser.id, {
    action: "merge.now",
    head: HEAD,
    accept: ["turn_held"],
  });
  assert.equal(explicitRes.explicitResolution?.status, "applied");
  assert.equal(store.task(ser.id).resolution.mergeResponseOutcome, "uncertain");
  assert.equal(mergeCalls, 1);
  mergeShouldFail = false;
  releaseGate();
  await verifyPromise;
  assert.equal(
    mergeCalls,
    1,
    "ordinary verifier must not resend over uncertain explicit merge",
  );
  store.update(ser.id, {
    phase: "done",
    resolution: {
      ...store.task(ser.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });

  // 2. exact-head-evidence + check-warning-classification: operator_source passes even when sourceApproved has awaitingProofs, and check timeout is a checks warning.
  const opTask = insertTask("operator acceptance with pending proof", 61);
  store.update(opTask.id, {
    phase: "verifying",
    resolution: {
      ...store.task(opTask.id).resolution,
      review: {
        taskId: opTask.id,
        runId: "rev-pending",
        eventId: "ev-pending",
        status: "changes_required",
        head: HEAD,
        summary: "Source approved pending proof",
        sourceApproved: true,
        awaitingProofs: [{ proof: "Screenshot", route: "author" }],
      },
      ownerAcceptances: [
        {
          kind: "operator_source",
          head: HEAD,
          prNumber: 61,
          review: null,
          reason: "Operator accepted exact head",
          qualification: HEAD,
          actor: { agentId: OPERATOR_BOARD_CALLER, role: "operator" },
          authority: { kind: "operator", note: null },
          at: new Date().toISOString(),
          missingEvidence: "Pending proof waived by operator",
        },
      ],
    },
  });
  checksError = new Error("PR checks lookup timed out");
  const checkWarned = await callExplicit(
    opTask.id,
    { action: "merge.now", head: HEAD },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(checkWarned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    checkWarned.explicitResolution?.warnings.map((w) => w.id),
    ["checks"],
  );
  const checkAccepted = await callExplicit(
    opTask.id,
    { action: "merge.now", head: HEAD, accept: ["checks"] },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(checkAccepted.explicitResolution?.status, "applied");
  checksError = null;
  store.update(opTask.id, {
    phase: "done",
    resolution: {
      ...store.task(opTask.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });

  // 3. coordinator-closeout-handoff: closeout.now releases only the episode's own recovery run and preserves an unrelated live recovery run.
  const handoff = insertTask("scoped handoff", 62);
  attachReadyReview(handoff.id, HEAD);
  store.update(handoff.id, {
    phase: "needs_attention",
    resolution: {
      ...store.task(handoff.id).resolution,
      mergedCommit: MERGED_COMMIT,
      mergeHead: HEAD,
    },
  });
  const coordCaller = attachCoordinator(handoff.id, "coord-main");
  const at = new Date().toISOString();
  store.putRun(
    runSchema.parse({
      id: "unrelated-recovery-run",
      taskId: handoff.id,
      role: "recovery",
      status: "running",
      active: true,
      released: false,
      agentId: "coord-other",
      hostId: HOST,
      generation: store.task(handoff.id).coordinatorGeneration,
      head: HEAD,
      base: "main",
      workspaceId: "ws-1",
      profile: profile("coord", "test/coord"),
      createdAt: at,
      lastObservedAt: at,
      idleSince: at,
      completion: null,
    }),
  );
  const handoffWarned = await callExplicit(
    handoff.id,
    { action: "closeout.now" },
    coordCaller,
  );
  assert.equal(handoffWarned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    handoffWarned.explicitResolution?.warnings.map((w) => w.id),
    ["live_runs"],
  );
  assert.equal(store.run(`coord-run-${handoff.id}`)?.released, false);
  assert.equal(store.run("unrelated-recovery-run")?.released, false);

  const handedOff = await callExplicit(
    handoff.id,
    { action: "closeout.now", accept: ["live_runs"] },
    coordCaller,
  );
  assert.equal(handedOff.explicitResolution?.status, "applied");
  assert.equal(store.run(`coord-run-${handoff.id}`)?.released, true);
  assert.equal(store.run("unrelated-recovery-run")?.released, false);
  store.update(handoff.id, {
    phase: "done",
    resolution: { ...store.task(handoff.id).resolution, integrationTurn: null },
  });

  // 4. merge-attention-scheduler (Ruling 3): merge.now puts the task in merging from needs_attention
  // and the real task quantum reconciles it without calling internal phases directly.
  const parkedMerge = insertTask("parked attention merge", 63);
  attachReadyReview(parkedMerge.id, HEAD);
  store.update(parkedMerge.id, {
    phase: "needs_attention",
    resolution: {
      ...store.task(parkedMerge.id).resolution,
      attention: true,
      stop: {
        reason: "escalated",
        detail: "Parked in attention",
        since: at,
        suggestedVerbs: [],
      },
    },
  });
  mergedFlag = false;
  const acceptedFromAttention = await callExplicit(parkedMerge.id, {
    action: "merge.now",
    head: HEAD,
  });
  assert.equal(acceptedFromAttention.explicitResolution?.status, "applied");
  assert.equal(acceptedFromAttention.phase, "merging");
  assert.equal(acceptedFromAttention.resolution.attention, false);
  assert.equal(acceptedFromAttention.resolution.stop, null);
  assert.equal(
    store.task(parkedMerge.id).resolution.mergeResponseOutcome,
    "accepted",
  );

  mergedFlag = true;
  await runtime.engine.scheduleTaskQuantum(parkedMerge.id);
  assert.equal(
    store.task(parkedMerge.id).resolution.mergedCommit,
    MERGED_COMMIT,
    store.task(parkedMerge.id).reason,
  );
});

test("planner rulings round 4: auto-retry stops when superseded by merge.now; closeout.now warns live_runs and cancels via run.release for another caller", async (t) => {
  let mergeCalls = 0;
  let mergeShouldFail = false;
  let resolveRetryGateStarted!: () => void;
  const retryGateStarted = new Promise<void>((resolve) => {
    resolveRetryGateStarted = resolve;
  });
  let releaseRetryGate!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetryGate = resolve;
  });
  const stoppedAgents: string[] = [];

  const {
    runtime,
    store,
    insertTask,
    attachCoordinator,
    attachReadyReview,
    callExplicit,
  } = await fixture(t, {
    verifyPr: async (task: Task) => ({
      number: task.resumePrNumber ?? 80,
      url: task.prUrl ?? "https://github.com/example/repo/pull/80",
      head: HEAD,
      base: "main",
      state: "OPEN",
      merged: false,
    }),
    merge: async () => {
      mergeCalls += 1;
      if (mergeShouldFail) throw new Error("explicit merge timeout");
    },
    merged: async () => ({
      merged: false,
      commit: null,
      head: HEAD,
      base: "main",
      proof: { proven: true, detail: "unmerged" },
    }),
    mergeGate: async () => {
      resolveRetryGateStarted();
      await retryGate;
      return { head: HEAD, base: "main", wait: "" };
    },
    stopAgentTurn: async (id: string) => {
      stoppedAgents.push(id);
    },
  });

  // Ruling 1: auto-retry observing an earlier uncertain request must stop without sending when merge.now supersedes it.
  const retryTask = insertTask("auto-retry superseded", 70);
  attachReadyReview(retryTask.id, HEAD);
  const earlierAt = new Date(Date.now() - 600_000).toISOString();
  const proofAt = new Date(Date.now() - 300_000).toISOString();
  store.update(retryTask.id, {
    phase: "merging",
    resolution: {
      ...store.task(retryTask.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: earlierAt },
      mergeIntent: true,
      mergeHead: HEAD,
      mergeBase: "main",
      mergeRequestedAt: earlierAt,
      mergeResponseOutcome: "uncertain",
      mergeProofSince: proofAt,
      mergeRetryAt: null,
      mergeRetryOutcome: null,
      mergeAutoRetryExhausted: false,
    },
  });
  const retryPromise = runtime.engine.scheduleTaskQuantum(retryTask.id);
  await retryGateStarted;

  // While auto-retry awaits its gate, merge.now issues a newer request and records uncertain.
  mergeShouldFail = true;
  const explicit = await callExplicit(retryTask.id, {
    action: "merge.now",
    head: HEAD,
  });
  assert.equal(explicit.explicitResolution?.status, "applied");
  assert.equal(mergeCalls, 1);
  assert.notEqual(
    store.task(retryTask.id).resolution.mergeRequestedAt,
    earlierAt,
  );
  assert.equal(
    store.task(retryTask.id).resolution.mergeResponseOutcome,
    "uncertain",
  );

  // Release auto-retry gate: it must see the newer request id and NOT send a second PUT.
  mergeShouldFail = false;
  releaseRetryGate();
  await retryPromise;
  assert.equal(
    mergeCalls,
    1,
    "superseded auto-retry must stop without sending a second PUT",
  );
  store.update(retryTask.id, {
    phase: "done",
    resolution: {
      ...store.task(retryTask.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });

  // Ruling 2: operator calling closeout.now while a live coordinator is bound gets live_runs warning;
  // accepting live_runs releases and cancels the coordinator via run.release.
  const liveCoordTask = insertTask("live coord closeout", 71);
  attachReadyReview(liveCoordTask.id, HEAD);
  store.update(liveCoordTask.id, {
    phase: "needs_attention",
    resolution: {
      ...store.task(liveCoordTask.id).resolution,
      mergedCommit: MERGED_COMMIT,
      mergeHead: HEAD,
    },
  });
  attachCoordinator(liveCoordTask.id, "coord-live");
  const warned = await callExplicit(
    liveCoordTask.id,
    { action: "closeout.now" },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warned.explicitResolution?.warnings.map((w) => w.id),
    ["live_runs"],
  );
  assert.equal(store.run(`coord-run-${liveCoordTask.id}`)?.released, false);
  assert.equal(stoppedAgents.length, 0);

  const accepted = await callExplicit(
    liveCoordTask.id,
    { action: "closeout.now", accept: ["live_runs"] },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(accepted.explicitResolution?.status, "applied");
  assert.equal(store.run(`coord-run-${liveCoordTask.id}`)?.released, true);
  assert.deepEqual(stoppedAgents, ["coord-live"]);
});

test("review round 5: forced move and stale merge lookup preserve newer explicit accepted outcome; retained check poll does not block sent merge", async (t) => {
  // 1. Forced move paused in flight + merge.now returns accepted -> late forced timeout preserves accepted.
  let forcedMergeStarted!: () => void;
  const forcedStarted = new Promise<void>((resolve) => {
    forcedMergeStarted = resolve;
  });
  let finishForcedMerge!: () => void;
  const forcedGate = new Promise<void>((resolve) => {
    finishForcedMerge = resolve;
  });
  let mergeAttempt = 0;

  let mergedLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    mergedLookupStarted = resolve;
  });
  let finishMergedLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    finishMergedLookup = resolve;
  });
  let pauseFirstLookup = false;
  let mergedFlag = false;
  let checkWaitCalls = 0;
  let checksPending = false;
  const stoppedAgents: string[] = [];

  const {
    runtime,
    store,
    insertTask,
    attachCoordinator,
    attachReadyReview,
    callExplicit,
  } = await fixture(t, {
    verifyPr: async (task: Task) => ({
      number: task.resumePrNumber ?? 80,
      url: task.prUrl ?? "https://github.com/example/repo/pull/80",
      head: HEAD,
      base: "main",
      state: "OPEN",
      merged: false,
    }),
    merge: async () => {
      mergeAttempt += 1;
      if (mergeAttempt === 1) {
        forcedMergeStarted();
        await forcedGate;
        throw new Error("forced merge timed out");
      }
    },
    merged: async () => {
      if (pauseFirstLookup) {
        pauseFirstLookup = false;
        mergedLookupStarted();
        await lookupGate;
        return {
          merged: false,
          commit: null,
          head: HEAD,
          base: "main",
          proof: { proven: false, detail: "stale unmerged lookup" },
        };
      }
      return {
        merged: mergedFlag,
        commit: mergedFlag ? MERGED_COMMIT : null,
        head: HEAD,
        base: "main",
        proof: { proven: !mergedFlag, detail: mergedFlag ? "merged" : "open" },
      };
    },
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: checksPending ? "Required check ci is pending" : "",
      pendingCheck: checksPending,
    }),
    requiredChecks: async () => {
      checkWaitCalls += 1;
      return {
        head: HEAD,
        wait: checksPending ? "Required check ci is pending" : "",
        pendingCheck: checksPending,
      };
    },
    stopAgentTurn: async (id: string) => {
      stoppedAgents.push(id);
    },
  });

  const forcedTask = insertTask("forced-vs-explicit", 80);
  attachReadyReview(forcedTask.id, HEAD);
  const forcedPromise = callCatalogueMethod(runtime, "queue.task", {
    taskId: forcedTask.id,
    action: "move",
    to: "merge",
    force: true,
    version: store.task(forcedTask.id).version,
    caller: OPERATOR_BOARD_CALLER,
    reason: "Operator forced merge",
  });
  await forcedStarted;

  const explicitAfterForced = await callExplicit(
    forcedTask.id,
    { action: "merge.now", head: HEAD },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(explicitAfterForced.explicitResolution?.status, "applied");
  assert.equal(
    store.task(forcedTask.id).resolution.mergeResponseOutcome,
    "accepted",
  );
  const explicitRequestedAt = store.task(forcedTask.id).resolution
    .mergeRequestedAt;

  finishForcedMerge();
  await forcedPromise;
  assert.equal(
    store.task(forcedTask.id).resolution.mergeRequestedAt,
    explicitRequestedAt,
  );
  assert.equal(
    store.task(forcedTask.id).resolution.mergeResponseOutcome,
    "accepted",
    "late forced timeout must not overwrite newer explicit accepted outcome",
  );
  store.update(forcedTask.id, {
    phase: "done",
    resolution: {
      ...store.task(forcedTask.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });

  // 2. Stale reconciliation lookup paused while newer explicit merge returns accepted.
  const staleLookupTask = insertTask("stale-lookup-vs-explicit", 81);
  attachReadyReview(staleLookupTask.id, HEAD);
  const oldRequestedAt = new Date(Date.now() - 60_000).toISOString();
  store.update(staleLookupTask.id, {
    phase: "merging",
    resolution: {
      ...store.task(staleLookupTask.id).resolution,
      integrationTurn: { sequence: 1, acceptedAt: oldRequestedAt },
      mergeIntent: true,
      mergeHead: HEAD,
      mergeBase: "main",
      mergeRequestedAt: oldRequestedAt,
      mergeResponseOutcome: "pending",
    },
  });
  pauseFirstLookup = true;
  const quantumPromise = runtime.engine.scheduleTaskQuantum(staleLookupTask.id);
  await lookupStarted;

  const explicitDuringLookup = await callExplicit(
    staleLookupTask.id,
    { action: "merge.now", head: HEAD },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(explicitDuringLookup.explicitResolution?.status, "applied");
  assert.equal(
    store.task(staleLookupTask.id).resolution.mergeResponseOutcome,
    "accepted",
  );
  const newerRequestedAt = store.task(staleLookupTask.id).resolution
    .mergeRequestedAt;

  finishMergedLookup();
  await quantumPromise;
  assert.equal(
    store.task(staleLookupTask.id).resolution.mergeRequestedAt,
    newerRequestedAt,
  );
  assert.equal(
    store.task(staleLookupTask.id).resolution.mergeResponseOutcome,
    "accepted",
    "stale unmerged lookup must not overwrite newer explicit accepted outcome",
  );
  store.update(staleLookupTask.id, {
    phase: "done",
    resolution: {
      ...store.task(staleLookupTask.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });

  // 3. Bound coordinator calling closeout.now on its own live run gets live_runs warning and cancels via run.release.
  const selfCoordTask = insertTask("self-coord-closeout", 82);
  attachReadyReview(selfCoordTask.id, HEAD);
  store.update(selfCoordTask.id, {
    phase: "needs_attention",
    resolution: {
      ...store.task(selfCoordTask.id).resolution,
      mergedCommit: MERGED_COMMIT,
      mergeHead: HEAD,
    },
  });
  const selfCoordCaller = attachCoordinator(selfCoordTask.id, "coord-self");
  const selfWarned = await callExplicit(
    selfCoordTask.id,
    { action: "closeout.now" },
    selfCoordCaller,
  );
  assert.equal(selfWarned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    selfWarned.explicitResolution?.warnings.map((w) => w.id),
    ["live_runs"],
  );
  assert.equal(store.run(`coord-run-${selfCoordTask.id}`)?.released, false);
  assert.equal(stoppedAgents.length, 0);

  const selfAccepted = await callExplicit(
    selfCoordTask.id,
    { action: "closeout.now", accept: ["live_runs"] },
    selfCoordCaller,
  );
  assert.equal(selfAccepted.explicitResolution?.status, "applied");
  assert.equal(store.run(`coord-run-${selfCoordTask.id}`)?.released, true);
  assert.deepEqual(stoppedAgents, ["coord-self"]);
  store.update(selfCoordTask.id, {
    phase: "done",
    resolution: {
      ...store.task(selfCoordTask.id).resolution,
      integrationTurn: null,
    },
  });

  // 4. Retained check poll must not block ordinary quantum from observing an already-sent merge.
  const checkPollTask = insertTask("retained-check-poll-merge", 83);
  attachReadyReview(checkPollTask.id, HEAD);
  store.update(checkPollTask.id, {
    phase: "verifying",
    resolution: {
      ...store.task(checkPollTask.id).resolution,
      stop: {
        reason: "lifecycle",
        detail: "Required check ci is pending",
        since: oldRequestedAt,
        suggestedVerbs: [],
      },
    },
  });
  store.setMeta(requiredCheckPollMetaKey(checkPollTask.id, HEAD), {
    head: HEAD,
    incidentId: null,
    nextAt: Date.now() + 60_000,
  });
  checksPending = true;
  mergedFlag = false;
  const acceptedChecksMerge = await callExplicit(
    checkPollTask.id,
    { action: "merge.now", head: HEAD, accept: ["checks"] },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(acceptedChecksMerge.explicitResolution?.status, "applied");
  assert.equal(acceptedChecksMerge.phase, "merging");
  assert.equal(
    store.task(checkPollTask.id).resolution.mergeResponseOutcome,
    "accepted",
  );

  mergedFlag = true;
  checkWaitCalls = 0;
  await runtime.engine.scheduleTaskQuantum(checkPollTask.id);
  assert.equal(
    checkWaitCalls,
    0,
    "pre-merge check poll must not run after merge was sent",
  );
  assert.equal(
    store.task(checkPollTask.id).resolution.mergedCommit,
    MERGED_COMMIT,
    store.task(checkPollTask.id).reason,
  );
  assert.equal(store.task(checkPollTask.id).phase, "syncing");
  store.update(checkPollTask.id, {
    phase: "done",
    resolution: {
      ...store.task(checkPollTask.id).resolution,
      integrationTurn: null,
      mergeIntent: false,
    },
  });

  // 5. An in-flight check poll that resolves with a failed check after merge.now succeeds
  // must NOT request a revision or clear the integration turn, and must continue merge reconciliation.
  let pollReadStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => {
    pollReadStarted = resolve;
  });
  let finishPollRead!: () => void;
  const pollGate = new Promise<void>((resolve) => {
    finishPollRead = resolve;
  });
  let inFlightMerged = false;
  const inFlightFx = await fixture(t, {
    merge: async () => {},
    merged: async () => ({
      merged: inFlightMerged,
      commit: inFlightMerged ? MERGED_COMMIT : null,
      head: HEAD,
      base: "main",
      proof: {
        proven: !inFlightMerged,
        detail: inFlightMerged ? "merged" : "open",
      },
    }),
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "Required check ci failed",
      checksFailed: true,
    }),
    requiredChecks: async () => {
      pollReadStarted();
      await pollGate;
      return {
        head: HEAD,
        wait: "Required check ci failed",
        checksFailed: true,
      };
    },
  });
  const inFlightTask = inFlightFx.insertTask("in-flight-check-poll-merge", 84);
  inFlightFx.attachReadyReview(inFlightTask.id, HEAD);
  inFlightFx.store.update(inFlightTask.id, {
    phase: "verifying",
    resolution: {
      ...inFlightFx.store.task(inFlightTask.id).resolution,
      stop: {
        reason: "lifecycle",
        detail: "Required check ci is pending",
        since: oldRequestedAt,
        suggestedVerbs: [],
      },
    },
  });
  inFlightFx.store.setMeta(requiredCheckPollMetaKey(inFlightTask.id, HEAD), {
    head: HEAD,
    incidentId: null,
    nextAt: Date.now() - 1_000,
  });

  const pollQuantum = inFlightFx.runtime.engine.scheduleTaskQuantum(
    inFlightTask.id,
  );
  await pollStarted;

  const mergedWhilePolling = await inFlightFx.callExplicit(
    inFlightTask.id,
    { action: "merge.now", head: HEAD, accept: ["checks"] },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(mergedWhilePolling.explicitResolution?.status, "applied");
  assert.equal(mergedWhilePolling.phase, "merging");
  assert.notEqual(mergedWhilePolling.resolution.integrationTurn, null);

  inFlightMerged = true;
  finishPollRead();
  await pollQuantum;

  const afterPoll = inFlightFx.store.task(inFlightTask.id);
  assert.equal(afterPoll.phase, "syncing", afterPoll.reason);
  assert.equal(afterPoll.resolution.mergedCommit, MERGED_COMMIT);
  assert.notEqual(afterPoll.resolution.integrationTurn, null);

  // 6. An in-flight check poll that REJECTS (e.g. forge PR identity error) after merge.now succeeds
  // must NOT rewrite the task to needs_attention; merge reconciliation still observes mergedCommit.
  let rejectPollStarted!: () => void;
  const rejectStarted = new Promise<void>((resolve) => {
    rejectPollStarted = resolve;
  });
  let triggerPollReject!: () => void;
  const rejectGate = new Promise<void>((resolve) => {
    triggerPollReject = resolve;
  });
  let rejectMerged = false;
  const rejectFx = await fixture(t, {
    merge: async () => {},
    merged: async () => ({
      merged: rejectMerged,
      commit: rejectMerged ? MERGED_COMMIT : null,
      head: HEAD,
      base: "main",
      proof: {
        proven: !rejectMerged,
        detail: rejectMerged ? "merged" : "open",
      },
    }),
    mergeGate: async () => ({
      head: HEAD,
      base: "main",
      wait: "Required check ci is pending",
      pendingCheck: true,
    }),
    requiredChecks: async () => {
      rejectPollStarted();
      await rejectGate;
      throw new Error(
        `PR #85 is not open (MERGED); expected open PR at ${HEAD}`,
      );
    },
  });
  const rejectTask = rejectFx.insertTask("in-flight-check-reject-merge", 85);
  rejectFx.attachReadyReview(rejectTask.id, HEAD);
  rejectFx.store.update(rejectTask.id, {
    phase: "verifying",
    resolution: {
      ...rejectFx.store.task(rejectTask.id).resolution,
      stop: {
        reason: "lifecycle",
        detail: "Required check ci is pending",
        since: oldRequestedAt,
        suggestedVerbs: [],
      },
    },
  });
  rejectFx.store.setMeta(requiredCheckPollMetaKey(rejectTask.id, HEAD), {
    head: HEAD,
    incidentId: null,
    nextAt: Date.now() - 1_000,
  });

  const rejectQuantum = rejectFx.runtime.engine.scheduleTaskQuantum(
    rejectTask.id,
  );
  await rejectStarted;

  const mergedBeforeReject = await rejectFx.callExplicit(
    rejectTask.id,
    { action: "merge.now", head: HEAD, accept: ["checks"] },
    OPERATOR_BOARD_CALLER,
  );
  assert.equal(mergedBeforeReject.explicitResolution?.status, "applied");
  assert.equal(mergedBeforeReject.phase, "merging");

  rejectMerged = true;
  triggerPollReject();
  await rejectQuantum;

  const afterReject = rejectFx.store.task(rejectTask.id);
  assert.equal(afterReject.phase, "syncing", afterReject.reason);
  assert.equal(afterReject.resolution.mergedCommit, MERGED_COMMIT);
  assert.notEqual(afterReject.resolution.integrationTurn, null);
});
