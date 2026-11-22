import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { formatAgentId } from "../shared/agent-identity";
import {
  OPERATOR_BOARD_CALLER,
  runSchema,
  submissionSchema,
  taskControlTaskSchema,
  type Task,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
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
        directory: REPO,
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
      directory: REPO,
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
    repositories: [{ origin: null, path: REPO }],
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
  Object.assign(resAdapter, resolutionOverrides);
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
        repoPath: REPO,
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

  const attachReadyReview = (taskId: string, head = HEAD) => {
    const at = new Date().toISOString();
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
        status: "ready_to_merge",
        head,
        summary: "Looks good",
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
          status: "ready_to_merge",
          head,
          summary: "Looks good",
          reviewId: 101,
        },
      },
    });
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
  const closed = await callExplicit(
    parked.id,
    { action: "closeout.now" },
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
  await assert.rejects(
    () =>
      callExplicit(skipped.id, {
        action: "closeout.now",
        accept: ["no_verdict"],
      }),
    /no applied review verdict or explicit operator source acceptance/,
  );
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
  const handedOff = await callExplicit(
    handoff.id,
    { action: "closeout.now" },
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
