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
  Object.assign(resAdapter, resolutionOverrides);
  if (resolutionOverrides.syncMain) {
    (adapter as unknown as Record<string, unknown>).syncMain =
      resolutionOverrides.syncMain;
  }

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
  store.update(t361.id, {
    phase: "merging",
    resolution: {
      ...store.task(t361.id).resolution,
      mergeIntent: true,
      mergeHead: HEAD,
    },
  });
  const warned = await callExplicit(t361.id, { action: "turn.release" });
  assert.equal(warned.explicitResolution?.status, "warnings");
  assert.deepEqual(
    warned.explicitResolution?.warnings.map((w) => w.id),
    ["merge_in_flight"],
  );
  assert.notEqual(store.task(t361.id).resolution.integrationTurn, null);

  const accepted = await callExplicit(t361.id, {
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
  // Real sync step advances syncing -> closing using the handoff.
  await runtime.engine.withHost(HOST, () =>
    runtime.engine.resolution.closeout.advanceSyncing(store.task(parked.id)),
  );
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
