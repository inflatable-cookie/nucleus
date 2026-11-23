import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  completionSchema,
  explicitResolutionSchema,
  runSchema,
  taskControlInputSchema,
  type Task,
} from "../shared/contracts";
import { taskStopRecord } from "../shared/task-stop";
import { TASK_PROGRESSING_REASON } from "../shared/task-detail-summary";
import { reviewPublicationBody } from "../core/forge/index";
import { holdPatch } from "../core/merge/merge-hold";
import { digest } from "../core/store/store";
import { formatAgentId } from "../shared/agent-identity";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import { plannerEscalations } from "../core/questions/ladder/records";
import { taskProgressDigest } from "../core/recovery/coordinator-report";
import { escalationWaitState } from "../core/questions/ladder/hold";
import { taskControlOperation } from "../core/verbs/task-control-key";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import type { ResolutionAdapter } from "../core/resolution";
import { fixture, base, head } from "./support/responsible-lifecycle-fixture";

const publicationId = 142701;
const future = "2099-01-01T00:00:00.000Z";

type Fixture = Pick<ReturnType<typeof fixture>, "current" | "engine" | "store" | "coordinator">;
type RecoveryEpisode = NonNullable<Task["resolution"]["recovery"]>;

function registerPlanner(f: Fixture) {
  const task = f.current();
  const caller = formatAgentId(task.hostId!, "registered-planner");
  f.store.upsertProject({
    key: "settlement",
    name: "Settlement",
    repositories: [{ origin: null, path: task.repoPath }],
  });
  f.store.setProjectPlanner({
    key: "settlement",
    agentId: caller,
    setBy: "operator",
  });
  return caller;
}

function episodeFor(
  task: Task,
  changes: Partial<RecoveryEpisode> = {},
): RecoveryEpisode {
  return {
    id: "recovery-occurrence",
    key: "recovery-key",
    generation: task.coordinatorGeneration,
    runId: null,
    agentId: null,
    incidentId: null,
    status: "escalated",
    summary: "Recovery previously escalated this occurrence",
    idleSince: null,
    progress: taskProgressDigest(task),
    ...changes,
  };
}

function recoveryCommand(
  f: Fixture,
  caller: string,
  args: Record<string, unknown>,
) {
  const task = f.current();
  return resolveExplicitly(
    f.engine,
    explicitResolutionSchema.parse({
      taskId: task.id,
      version: task.version,
      caller,
      reason: "Settle the obsolete recovery binding",
      ...args,
    }),
    () => "The scheduler resumes ordinary reconciliation.",
  );
}

function settlementOffers(f: Fixture) {
  return (
    ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()))
      .explicitCommands ?? []
  );
}

function coordinatorFor(f: Fixture) {
  const task = f.current();
  const at = new Date().toISOString();
  const completion = completionSchema.parse({
    eventId: "coordinator-report",
    taskId: task.id,
    runId: "coordinator-run",
    status: "recovered",
    summary: "Retry the old stop",
    coordinatorAction: { verb: "retry_effect", reason: "Retry" },
  });
  const run = runSchema.parse({
    id: completion.runId,
    taskId: task.id,
    hostId: task.hostId,
    workspaceId: task.workspaceId,
    generation: task.coordinatorGeneration,
    role: "recovery",
    agentId: "retained-coordinator",
    status: "finished",
    createdAt: at,
    lastObservedAt: null,
    idleSince: null,
    released: false,
    active: false,
    head,
    base,
    profile: f.coordinator,
    completion,
  });
  f.store.putRun(run);
  f.store.setCredential(run.id, "coordinator-token");
  return { run, completion };
}

function reportCoordinatorBeforeHeadChange(f: Fixture) {
  const task = f.current();
  const { run, completion } = coordinatorFor(f);
  f.store.putRun({ ...run, status: "running", active: true, completion: null });
  f.store.update(task.id, {
    resolution: {
      ...task.resolution,
      recoveryActive: true,
      recovery: episodeFor(task, {
        runId: run.id,
        agentId: run.agentId,
        status: "running",
      }),
    },
  });
  const receipt = f.engine.resolution.complete(
    { ...completion, head, coordinatorGeneration: run.generation },
    "coordinator-token",
  );
  assert.equal(receipt.accepted, true);
  f.store.update(task.id, { prHead: "c".repeat(40) });
  return { run, completion: f.store.run(run.id)!.completion! };
}

function parkedVerdict(
  test: TestContext,
  status: "ready_to_merge" | "changes_required" = "ready_to_merge",
  ledgerOnly = false,
) {
  const f = fixture();
  test.after(() => f.close());
  const adapter = f.adapter as typeof f.adapter & ResolutionAdapter;
  const task = f.current();
  const expired = new Date(Date.now() - 60_000).toISOString();
  f.store.putRepository(
    { origin: null, path: task.repoPath },
    null,
    "Formal review",
    null,
    { login: "review-bot" },
  );
  const runId = "retained-review";
  const verdict = completionSchema.parse({
    taskId: task.id,
    runId,
    eventId: "accepted-verdict",
    status,
    head,
    prNumber: 1,
    summary:
      status === "changes_required"
        ? "Correct the revision instruction"
        : "Exact source approved",
    reviewText: "Read the exact source and returned the findings",
    ...(status === "changes_required"
      ? { reviewResponsibility: "author" }
      : {}),
  });
  const run = runSchema.parse({
    id: runId,
    taskId: task.id,
    agentId: "retained-reader",
    role: "reviewer",
    generation: 1,
    head,
    base,
    workspaceId: task.workspaceId,
    hostId: task.hostId,
    profile: f.reviewer,
    formalReview: true,
    status: "finished",
    released: true,
    createdAt: expired,
    lastObservedAt: expired,
    active: false,
    idleSince: expired,
    completion: ledgerOnly ? verdict : { ...verdict, reviewId: publicationId },
  });
  f.store.putRun(run);
  f.idle(run.agentId!);
  f.store.setCompletionReceipt(
    verdict.eventId,
    task.id,
    run.id,
    digest(JSON.stringify(verdict)),
    JSON.stringify({ accepted: true, eventId: verdict.eventId }),
  );
  f.store.setMeta(`reviewPublication:${run.id}`, {
    reviewId: publicationId,
    hash: digest(reviewPublicationBody(task, run, status, verdict.reviewText!)),
  });
  // Recreate the stored regression: a released formal review, a resolved timed
  // escalation, a blocked phase, and no application or review record.
  const wait = { kind: "time" as const, target: expired };
  const stop = escalationWaitState("timed-park", wait);
  f.store.event(
    task.id,
    "planner_escalation_wait",
    `timed-park: ${JSON.stringify(wait)}`,
  );
  if (!ledgerOnly)
    f.store.event(
      task.id,
      "planner_escalation_resolved",
      "timed-park: wait ended",
    );
  f.store.update(task.id, {
    phase: "blocked",
    reason: "A prior escalation parked this task",
    resolution: {
      ...task.resolution,
      currentRunId: null,
      reviewerAgentId: run.agentId,
      reviewerProfile: f.reviewer,
      stop: taskStopRecord(stop.stopReason, stop.stopDetail, null, expired),
    },
  });
  let publicationReads = 0;
  let publicationWrites = 0;
  let reportRequests = 0;
  adapter.verifyReview = async (_task, observed, completion, reviewer) => {
    publicationReads++;
    assert.equal(observed.id, run.id);
    assert.equal(completion.reviewId, publicationId);
    assert.equal(reviewer?.login, "review-bot");
    return publicationId;
  };
  adapter.publishReview = async () => {
    publicationWrites++;
    throw Error("Unexpected publication");
  };
  adapter.notify = async () => {
    reportRequests++;
  };
  const next = () =>
    ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(
      (verb) =>
        verb.verb === "move" &&
        (verb.args?.to === "review" ||
          verb.refusal?.startsWith("move review:")),
    )!;
  const moveInput = () =>
    taskControlInputSchema.parse({
      taskId: task.id,
      version: f.current().version,
      action: "move",
      to: "review",
      reason: "Apply the published verdict",
    });
  const assertNoSend = () => {
    assert.equal(publicationWrites, 0);
    assert.equal(reportRequests, 0);
    assert.equal(f.reviewerRuns().length, 1);
    assert.deepEqual(f.sends, []);
  };
  return {
    ...f,
    adapter,
    run,
    verdict,
    next,
    moveInput,
    publicationReads: () => publicationReads,
    assertNoSend,
    assertAppliedOnce: () =>
      assert.deepEqual(
        f.events("run_result_applied").map((event) => event.detail),
        [run.id],
      ),
    assertPending: (reviewerCount = 1) => {
      assert.equal(f.current().resolution.review, null);
      assert.equal(f.events("run_result_applied").length, 0);
      assert.equal(publicationReads, 0);
      assert.equal(publicationWrites, 0);
      assert.equal(f.reviewerRuns().length, reviewerCount);
      assert.deepEqual(f.sends, []);
    },
  };
}

test("clearing a detached recovery applies the existing exact-head verdict", async (t) => {
  const f = parkedVerdict(t);
  const caller = registerPlanner(f);
  const before = f.current();
  f.store.event(
    before.id,
    "planner_escalation_wait_superseded",
    "timed-park: wait ended",
  );
  const recovery = episodeFor(before, { incidentId: "already-cleared" });
  f.store.update(before.id, {
    phase: "reviewing",
    reason: "Waiting for result application",
    resolution: {
      ...before.resolution,
      stop: null,
      recovery,
      recoveryActive: true,
    },
  });
  f.adapter.mergeGate = async () => ({
    head,
    base,
    wait: "Waiting for required checks",
  });
  assert.equal(
    await f.engine.resolution.reapplyPendingReview(f.current()),
    "blocked",
  );
  const offer = settlementOffers(f).find(
    (item) => item.args.id === recovery.id,
  );
  assert.equal(offer?.args.kind, "recovery");
  assert.deepEqual(offer.warnings, []);
  const result = await recoveryCommand(f, caller, offer.args);
  assert.equal(result.explicitResolution?.status, "applied");
  await f.engine.wake();
  await f.engine.quiesce();
  assert.equal(f.current().phase, "verifying");
  assert.equal(f.current().resolution.review?.runId, f.run.id);
  assert.equal(f.current().resolution.review?.head, head);
  f.assertAppliedOnce();
  f.assertNoSend();
  assert.equal(f.events("owner_resolution").length, 1);
});

for (const kind of [
  "recovery",
  "recovery flag",
  "attention",
  "run_pointer",
  "run.release",
] as const) {
  test(`the registered planner can settle ${kind} once and leave other occurrences alone`, async (t) => {
    const f = fixture();
    t.after(() => f.close());
    f.store.setMeta("paused", true);
    const caller = registerPlanner(f);
    const task = f.current();
    const { run, completion } = coordinatorFor(f);
    const action = {
      runId: run.id,
      eventId: completion.eventId,
      status: "pending" as const,
      reportStatus: "recovered" as const,
      summary: completion.summary,
      coordinatorAction: completion.coordinatorAction ?? null,
    };
    const isRelease = kind === "run.release";
    const pendingAction = kind === "recovery" || isRelease;
    if (!isRelease) f.store.putRun({ ...run, released: true });
    const recovery = pendingAction
      ? episodeFor(task, {
          runId: run.id,
          action,
        })
      : null;
    if (pendingAction)
      f.store.event(
        task.id,
        "run_result_applying",
        JSON.stringify([task.id, run.id, completion.eventId]),
      );
    // The independent incident and escalation have different durable identities.
    const incident =
      kind === "attention"
        ? null
        : {
            id: "other-incident",
            status: "escalated" as const,
            role: "worker" as const,
            createdAt: future,
            updatedAt: future,
            cause: "workspace_state",
            detail: "Independent fault",
            runId: null,
            fingerprint: "",
            attempt: 0,
            action: "" as const,
          };
    if (kind !== "attention")
      f.store.event(
        task.id,
        "planner_escalation",
        `other-escalation: cause ${digest("unrelated")}; run worker; question pending`,
      );
    if (recovery) {
      const cause = digest(`coordinator-refused:${task.id}:${recovery.id}`);
      f.store.event(
        task.id,
        "planner_escalation",
        `owned-escalation: cause ${cause}; run ${run.id}; question pending`,
      );
    }
    f.store.update(task.id, {
      resolution: {
        ...task.resolution,
        stop: null,
        recovery,
        incident,
        recoveryActive: pendingAction || kind === "recovery flag",
        attention: kind === "attention",
        currentRunId: kind === "run_pointer" ? "missing-run" : null,
      },
    });
    await f.engine.quiesce();
    const offer = settlementOffers(f).find((item) =>
      isRelease
        ? item.args.run === run.id
        : item.args.kind === (kind === "recovery flag" ? "recovery" : kind),
    );
    assert.ok(offer);
    const warnings = pendingAction ? ["effect_may_land"] : [];
    assert.deepEqual(offer.warnings, warnings);
    const { taskId: _taskId, version: _version, ...args } = offer.args;
    if (warnings.length) {
      const refused = await recoveryCommand(f, caller, args);
      assert.equal(refused.explicitResolution?.status, "warnings");
      assert.deepEqual(
        refused.explicitResolution.warnings.map((warning) => warning.id),
        warnings,
      );
      assert.equal(f.events("owner_resolution").length, 0);
    }
    const applied = await recoveryCommand(f, caller, {
      ...args,
      accept: warnings,
    });
    assert.equal(applied.explicitResolution?.status, "applied");
    const after = f.current();
    assert.deepEqual(after.resolution.incident, incident);
    const escalations = plannerEscalations(f.store.eventsAll(task.id));
    assert.equal(
      escalations.find((item) => item.id === "other-escalation")?.answered,
      kind === "attention" ? undefined : false,
    );
    assert.equal(
      escalations.find((item) => item.id === "owned-escalation")?.answered,
      recovery ? true : undefined,
    );
    assert.equal(after.resolution.attention, false);
    assert.equal(after.resolution.currentRunId, null);
    assert.equal(after.resolution.recoveryActive, false);
    assert.equal(
      after.resolution.recovery?.action?.status,
      pendingAction ? "refused" : undefined,
    );
    assert.deepEqual(f.store.run(run.id)?.completion, completion);
    await assert.rejects(
      recoveryCommand(f, caller, { ...args, accept: warnings }),
      /No current/,
    );
    assert.throws(
      () =>
        f.engine.resolution.complete(
          {
            ...completion,
            eventId: "late-coordinator-report",
          },
          "coordinator-token",
        ),
      /unauthorized callback/i,
    );
    await f.engine.resolution.recovery.pass(task.id);
    assert.equal(f.events("owner_resolution").length, 1);
    assert.equal(
      f.current().resolution.recovery?.action?.status,
      pendingAction ? "refused" : undefined,
    );
  });
}

test("permanently stale coordinator bindings release without another escalation", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const before = f.current();
  const { run, completion } = coordinatorFor(f);
  let observations = 0;
  const observe = f.adapter.observe.bind(f.adapter);
  f.adapter.observe = async (agentId) => {
    if (agentId === run.agentId) observations++;
    return observe(agentId);
  };
  f.store.update(before.id, {
    resolution: {
      ...before.resolution,
      recoveryActive: true,
      recovery: episodeFor(before, {
        runId: run.id,
        action: {
          runId: run.id,
          eventId: completion.eventId,
          status: "refused",
          reportStatus: "recovered",
          summary: completion.summary,
          reason: "Stale run",
        },
      }),
    },
  });
  const recovery = f.current().resolution.recovery;
  for (let pass = 0; pass < 3; pass++)
    await f.engine.resolution.recovery.pass(before.id);
  assert.equal(f.store.run(run.id)?.released, true);
  assert.deepEqual(f.store.run(run.id)?.completion, completion);
  assert.equal(f.current().resolution.recovery?.id, recovery?.id);
  assert.equal(f.current().resolution.recovery?.action?.reason, "Stale run");
  assert.equal(f.current().resolution.recovery?.status, "resolved");
  assert.equal(f.current().resolution.recoveryActive, false);
  assert.equal(f.events("coordinator_binding_released").length, 1);
  assert.equal(f.events("recovery_escalated").length, 0);
  assert.equal(observations, 1);
});

test("a stale coordinator report cannot release its active turn", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const task = f.current();
  const { run, completion } = reportCoordinatorBeforeHeadChange(f);
  const observe = f.adapter.observe.bind(f.adapter);
  let sawActiveTurn = false;
  f.adapter.observe = async (id) => {
    const state = await observe(id);
    if (id !== run.agentId) return state;
    sawActiveTurn = true;
    return {
      ...state,
      status: "running",
      active: true,
      activeTurnId: "reporting-turn",
    };
  };

  await f.engine.resolution.recovery.pass(task.id);
  assert.equal(f.store.run(run.id)?.released, false);
  assert.doesNotThrow(() => f.store.authenticate(run.id, "coordinator-token"));
  assert.equal(sawActiveTurn, true);
  assert.equal(f.current().resolution.recovery?.action?.status, "pending");

  f.adapter.observe = observe;
  f.idle(run.agentId!);
  await f.engine.resolution.recovery.pass(task.id);
  assert.equal(f.store.run(run.id)?.released, true);
  assert.deepEqual(f.store.run(run.id)?.completion, completion);
  assert.equal(f.current().resolution.recovery?.action?.status, "refused");
});

test("a stale coordinator claim with unknown outcome still requires planner acceptance after restart", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const caller = registerPlanner(f);
  const task = f.current();
  const { run, completion } = reportCoordinatorBeforeHeadChange(f);
  // The previous process had ended the turn and claimed the action, then
  // stopped before writing its outcome. Only the durable journal remains.
  f.store.putRun({
    ...f.store.run(run.id)!,
    status: "finished",
    released: true,
    active: false,
  });
  const claim = JSON.stringify([task.id, run.id, completion.eventId]);
  f.store.event(task.id, "run_result_applying", claim);
  await f.engine.resolution.recovery.pass(task.id);
  const episode = f.current().resolution.recovery;
  assert.equal(episode?.action?.status, "pending");
  assert.equal(f.events("coordinator_action_refused").length, 0);
  const offer = settlementOffers(f).find((item) => item.args.id === episode?.id);
  assert.ok(offer);
  assert.deepEqual(offer.warnings, ["effect_may_land"]);
  const probe = await recoveryCommand(f, caller, offer.args);
  assert.equal(probe.explicitResolution?.status, "warnings");
  const result = await recoveryCommand(f, caller, {
    ...offer.args,
    accept: offer.warnings,
  });
  assert.equal(result.explicitResolution?.status, "applied");
  assert.equal(f.current().resolution.recovery?.action?.status, "refused");
  assert.equal(f.events("run_result_applying")[0]?.detail, claim);
});

test("clearing a pending episode while admission waits prevents its coordinator launch", async (t) => {
  const f = fixture({ responsible: false });
  t.after(() => f.close());
  const caller = registerPlanner(f);
  const task = f.current();
  f.store.update(task.id, {
    phase: "error",
    reason: "Resolve a coordinator fault",
  });
  let entered!: () => void;
  const atLease = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finishLease!: (available: boolean) => void;
  const lease = new Promise<boolean>((resolve) => {
    finishLease = resolve;
  });
  f.engine.resolution.lease = async () => {
    entered();
    return lease;
  };
  const routing = f.engine.resolution.recovery.route(f.current());
  await Promise.race([
    atLease,
    routing.then(() => {
      throw Error("Coordinator route never reached its lease");
    }),
  ]);
  try {
    const episode = f.current().resolution.recovery;
    assert.equal(episode?.status, "pending");
    const result = await recoveryCommand(f, caller, {
      action: "record.clear",
      kind: "recovery",
      id: episode.id,
    });
    assert.equal(result.explicitResolution?.status, "applied");
    assert.equal(f.current().resolution.recovery?.id, episode.id);
  } finally {
    finishLease(true);
    await routing;
  }
  assert.equal(f.current().resolution.recovery?.status, "resolved");
  assert.deepEqual(f.coordinatorRuns(), []);
  assert.equal(f.events("telemetry_recovery").length, 0);
});

test("a late coordinator observation cannot reopen a released recovery", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const caller = registerPlanner(f);
  const task = f.current();
  const { run } = coordinatorFor(f);
  f.store.putRun({ ...run, active: true, status: "running", completion: null });
  f.store.update(task.id, {
    resolution: {
      ...task.resolution,
      recoveryActive: true,
      recovery: episodeFor(task, { runId: run.id, status: "running" }),
    },
  });
  let entered!: () => void;
  const observing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let failRead!: (error: Error) => void;
  const lateRead = new Promise<never>((_, reject) => {
    failRead = reject;
  });
  const observe = f.adapter.observe.bind(f.adapter);
  f.adapter.observe = async (agentId) => {
    if (agentId !== run.agentId) return observe(agentId);
    entered();
    return lateRead;
  };
  const pass = f.engine.resolution.recovery.pass(task.id);
  await observing;
  try {
    const offer = settlementOffers(f).find((item) => item.args.run === run.id);
    assert.ok(offer);
    assert.deepEqual(offer.warnings, ["live_turn", "unreported_result"]);
    const result = await recoveryCommand(f, caller, {
      ...offer.args,
      accept: offer.warnings,
    });
    assert.equal(result.explicitResolution?.status, "applied");
  } finally {
    failRead(new Error("The old turn became unreadable"));
    await pass;
  }
  assert.equal(f.store.run(run.id)?.released, true);
  assert.equal(f.current().resolution.recovery?.status, "resolved");
  assert.equal(f.events("recovery_escalated").length, 0);
});

for (const status of ["ready_to_merge", "changes_required"] as const) {
  test(`next previews and the sweep applies a released published ${status} from a blocked row`, async (t) => {
    const f = parkedVerdict(t, status);
    let verified = 0;
    if (status === "ready_to_merge") {
      f.adapter.mergeGate = async () => {
        verified++;
        return { head, base, wait: "Waiting for required checks" };
      };
    } else {
      f.store.setMeta("paused", true);
    }
    const before = f.current();
    const events = f.store.eventsAll(before.id);
    assert.match(
      f.next().note ?? "",
      new RegExp(`Apply the published ${status}`),
    );
    assert.deepEqual(f.current(), before);
    assert.deepEqual(f.store.eventsAll(before.id), events);
    assert.equal(f.publicationReads(), 0);
    await f.engine.wake();
    const after = f.current();
    assert.equal(
      after.phase,
      status === "ready_to_merge" ? "verifying" : "changes_requested",
    );
    assert.equal(after.resolution.review?.runId, f.run.id);
    assert.notEqual(
      after.resolution.stop?.detail,
      before.resolution.stop?.detail,
    );
    if (status === "changes_required") {
      assert.equal(
        after.resolution.pendingWorkerInstruction,
        f.verdict.summary,
      );
      assert.equal(
        after.resolution.revisionRuns,
        before.resolution.revisionRuns,
      );
    }
    f.assertAppliedOnce();
    f.assertNoSend();
    if (status === "ready_to_merge") {
      await f.engine.wake();
      assert.ok(verified > 0, "application enters ordinary verification");
    } else {
      f.store.setMeta("paused", false);
      await f.engine.wake();
      const revision = f.store
        .runs(before.id)
        .findLast((run) => run.role === "revision");
      assert.equal(revision?.instruction, f.verdict.summary);
      assert.equal(f.reviewerRuns().length, 1);
    }
  });

  test(`ordinary move applies published ${status} through its durable control operation`, async (t) => {
    const f = parkedVerdict(t, status, true);
    // Also cover completion enrichment on replay when only publication has committed.
    // Pause keeps the follow-on launch parked while settlement still runs.
    f.store.setMeta("paused", true);
    const control = f.moveInput();
    const acceptance = await f.engine.startOperation({
      ...taskControlOperation(control),
      kind: "task_control",
      taskId: control.taskId,
      expectedVersion: control.version,
    });
    assert.ok("operation" in acceptance);
    const operation = await f.engine.awaitOperation(acceptance.operation.id);
    assert.equal(operation.state, "succeeded", operation.diagnostic);
    assert.equal(f.current().resolution.review?.reviewId, publicationId);
    assert.equal(f.store.run(f.run.id)?.completion?.reviewId, publicationId);
    f.assertAppliedOnce();
    assert.equal(f.events("planner_escalation_wait_superseded").length, 1);
    f.assertNoSend();
  });
}

type Parked = ReturnType<typeof parkedVerdict>;
const negativeTwins: {
  name: string;
  seed(f: Parked): void;
  refusal: RegExp;
}[] = [
  {
    name: "an independent wait",
    seed(f) {
      f.store.event(
        f.current().id,
        "planner_escalation_wait",
        `independent: ${JSON.stringify({ kind: "time", target: future })}`,
      );
    },
    refusal: /planner ladder still owns escalation independent/,
  },
  {
    name: "an owner stop",
    seed(f) {
      const task = f.current();
      f.store.update(
        task.id,
        holdPatch(task, "dispatch", "owner", "Owner stopped work", null),
      );
    },
    refusal: /Dispatch is held by owner/,
  },
  {
    name: "a changed head",
    seed(f) {
      const task = f.current();
      f.store.update(task.id, {
        prHead: base,
        resolution: { ...task.resolution, currentRunId: f.run.id },
      });
    },
    refusal: /canonical PR and exact verdict head/,
  },
  {
    name: "a newer reviewer",
    seed(f) {
      const task = f.current();
      f.store.update(task.id, {
        resolution: { ...task.resolution, currentRunId: f.run.id },
      });
      f.store.putRun({
        ...f.run,
        id: "newer-reader",
        completion: null,
        status: "running",
        released: false,
      });
    },
    refusal: /newer-reader is newer/,
  },
  {
    name: "an invalid callback receipt",
    seed(f) {
      f.store.db
        .prepare("UPDATE receipts SET hash=? WHERE id=?")
        .run("0".repeat(64), f.verdict.eventId);
    },
    refusal: /Callback intake has no authenticated accepted receipt/,
  },
  {
    name: "an invalid publication",
    seed(f) {
      f.store.setMeta(`reviewPublication:${f.run.id}`, {
        reviewId: publicationId,
        hash: "0".repeat(64),
      });
    },
    refusal: /Review publication must reconcile its evidence/,
  },
  {
    name: "a conflicting live effect",
    seed(f) {
      f.store.putNotice({
        id: "unsettled-attention",
        taskId: f.current().id,
        agentId: "origin",
        recipientAgentId: "origin",
        workspaceId: null,
        sources: [],
        originEntry: true,
        kind: "attention",
        status: "uncertain",
        error: "delivery unknown",
        text: "Attention",
      });
    },
    refusal: /attention notice unsettled-attention delivery is uncertain/,
  },
  {
    name: "a live participant",
    seed(f) {
      f.store.putRun({
        ...f.run,
        id: "unreleased-recovery",
        role: "recovery",
        completion: null,
        status: "running",
        released: false,
      });
    },
    refusal: /recovery run unreleased-recovery still owns work/,
  },
];

for (const { name, seed, refusal } of negativeTwins) {
  test(`${name} keeps the published verdict pending in both preview and execution`, async (t) => {
    const f = parkedVerdict(t);
    seed(f);
    const reviewerCount = f.reviewerRuns().length;
    assert.equal(f.next().available, false);
    assert.match(f.next().refusal ?? "", refusal);
    await assert.rejects(f.engine.performTaskControl(f.moveInput()), refusal);
    // Exercise the scheduler admission without asking other owners to resolve
    // the deliberately unsettled wait, run or effect in this fixture.
    await f.engine.resolution.advance(f.current());
    f.assertPending(reviewerCount);
  });
}

for (const stopState of ["missing", "stale"] as const) {
  test(`an open reviewer consult fences a published verdict with a ${stopState} stop`, async (t) => {
    const f = parkedVerdict(t);
    const task = f.current();
    if (stopState === "missing")
      f.store.update(task.id, {
        resolution: { ...task.resolution, stop: null },
      });
    const consultId = "independent-consult";
    f.store.event(
      task.id,
      "reviewer_consult",
      `${consultId}: cause ${"c".repeat(64)}; run worker`,
    );

    const refusal =
      /Waiting with the retained reviewer: consult independent-consult/;
    assert.equal(f.next().available, false);
    assert.match(f.next().refusal ?? "", refusal);
    await assert.rejects(f.engine.performTaskControl(f.moveInput()), refusal);

    await f.engine.wake();
    assert.equal(f.current().resolution.stop?.reason, "escalated");
    assert.match(f.current().resolution.stop?.detail ?? "", refusal);
    f.assertPending();
    f.assertNoSend();
  });
}

test("the sweep surfaces an overdue unknown escalation while the released reviewer is still bound", async (t) => {
  const f = parkedVerdict(t);
  const task = f.current();
  f.store.update(task.id, {
    resolution: { ...task.resolution, currentRunId: f.run.id },
  });
  const escalationId = "unknown-delivery";
  const cause = "d".repeat(64);
  const question =
    "How should the author proceed with the independent blocker?";
  f.store.setMeta("stallThresholdMinutes", 0);
  f.store.event(
    task.id,
    "planner_escalation",
    `${escalationId}: cause ${cause}; run worker; question ${question.length} chars; options none`,
  );
  f.store.event(
    task.id,
    "planner_escalation_payload",
    `${escalationId}: ${JSON.stringify({ cause, runId: null, question })}`,
  );
  f.store.event(
    task.id,
    "planner_escalation_unknown",
    `${escalationId}: delegated delivery outcome unknown`,
  );
  const refusal = /planner ladder still owns escalation unknown-delivery/;
  assert.equal(f.next().available, false);
  assert.match(f.next().refusal ?? "", refusal);
  await assert.rejects(f.engine.performTaskControl(f.moveInput()), refusal);

  await f.engine.wake();
  await f.engine.wake();
  const after = f.current();
  assert.equal(after.resolution.stop?.reason, "operator_needed");
  assert.match(
    after.resolution.stop?.detail ?? "",
    /unknown-delivery never reported a delivery/,
  );
  assert.equal(f.events("planner_escalation_attention").length, 1);
  assert.equal(f.events("planner_escalation_sent").length, 0);
  assert.equal(after.resolution.currentRunId, f.run.id);
  f.assertPending();
});

test("the sweep classifies a fresh author blocker while a released reviewer is still bound", async (t) => {
  const f = parkedVerdict(t);
  const task = f.current();
  const blocked = {
    ...task.completion!,
    eventId: "independent-author-blocker",
    status: "blocked" as const,
    summary: "The author needs a decision on the independent blocker",
  };
  f.store.update(task.id, {
    completion: blocked,
    resolution: { ...task.resolution, currentRunId: f.run.id },
  });
  f.store.db.prepare("DELETE FROM receipts WHERE id=?").run(f.verdict.eventId);

  await f.engine.wake();
  assert.equal(f.events("blocker_ladder_classified").length, 1);
  assert.match(
    f.events("blocker_ladder_classified")[0]?.detail ?? "",
    /^independent-author-blocker:/,
  );
  f.assertPending();
});

test("a sweep and ordinary move racing after publication have a single committed application", async (t) => {
  const f = parkedVerdict(t);
  let entered!: () => void;
  let release!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let readers = 0;
  f.adapter.verifyReview = async () => {
    if (++readers === 1) {
      entered();
      await resume;
    }
    return publicationId;
  };
  const task: Task = f.current();
  const sweep = f.engine.resolution.reapplyPendingReview(task);
  await Promise.race([
    checking,
    sweep.then((outcome) =>
      assert.fail(`Sweep exited before the publication read: ${outcome}`),
    ),
  ]);
  try {
    const moved = await f.engine.performTaskControl(f.moveInput());
    assert.equal(moved.resolution.review?.runId, f.run.id);
  } finally {
    release();
  }
  assert.equal(
    await sweep,
    "blocked",
    "the losing invocation must not report its own application",
  );
  await f.engine.quiesce();
  f.assertAppliedOnce();
  assert.equal(
    await f.engine.resolution.reapplyPendingReview(f.current()),
    "none",
  );
  f.assertNoSend();
});

test("a hold recorded during forge observation is rechecked before application", async (t) => {
  const f = parkedVerdict(t);
  const verifyReview = f.adapter.verifyReview!;
  f.adapter.verifyReview = async (...args) => {
    const verdict = await verifyReview(...args);
    const task = f.current();
    f.store.update(
      task.id,
      holdPatch(task, "dispatch", "owner", "Stop during verification", null),
    );
    return verdict;
  };
  assert.equal(f.next().available, true);
  await assert.rejects(
    f.engine.performTaskControl(f.moveInput()),
    /Dispatch is held by owner: Stop during verification/,
  );
  assert.equal(f.current().resolution.review, null);
  assert.equal(f.events("run_result_applied").length, 0);
  f.assertNoSend();
});

/**
 * nucleus#1437 (installed #1427): a settled-wait prose stop is a machine-generated
 * `operator_needed` occurrence. Stored, with its reviewer incident and recovery
 * resolved and nothing live, it must settle, and the preserved published verdict must
 * then apply exactly once through the ordinary reconciliation.
 */
const syntheticStop = (task: Task, at = new Date().toISOString()) =>
  taskStopRecord(
    "operator_needed",
    TASK_PROGRESSING_REASON,
    null,
    at,
    ["restart", "route", "move"],
  );
const stopEvents = (f: Parked) =>
  f.store.eventsAll(f.current().id).filter((event) =>
    ["task_stopped", "incident", "recovery_started", "needs_attention"].includes(
      event.kind,
    ),
  ).length;

test("a stored settled-wait stop with no live owner settles and the published verdict applies once (nucleus#1437)", async (t) => {
  const f = parkedVerdict(t, "ready_to_merge");
  f.adapter.mergeGate = async () => ({
    head,
    base,
    wait: "Waiting for required checks",
  });
  const task = f.current();
  f.store.update(task.id, {
    phase: "blocked",
    reason: TASK_PROGRESSING_REASON,
    resolution: {
      ...task.resolution,
      stop: syntheticStop(task),
      incident: null,
      recovery: null,
      recoveryActive: false,
    },
  });
  assert.equal(f.current().resolution.stop?.reason, "operator_needed");

  await f.engine.wake();
  const after = f.current();
  assert.notEqual(
    after.resolution.stop?.detail,
    TASK_PROGRESSING_REASON,
    "the synthetic stop is not the task's stop once it has no owner",
  );
  assert.equal(after.phase, "verifying");
  f.assertAppliedOnce();
  f.assertNoSend();

  // Replay: a repeated sweep writes no new stop, incident or recovery.
  const before = stopEvents(f);
  await f.engine.wake();
  await f.engine.wake();
  assert.equal(stopEvents(f), before);
  f.assertAppliedOnce();
  f.assertNoSend();
});

test("a settled-wait stop keeps its stop while an incident it may belong to is still escalated (nucleus#1437 negative twin)", async (t) => {
  const f = parkedVerdict(t, "ready_to_merge");
  const task = f.current();
  f.store.update(task.id, {
    phase: "blocked",
    reason: TASK_PROGRESSING_REASON,
    resolution: {
      ...task.resolution,
      stop: syntheticStop(task),
      incident: {
        id: "escalated-incident",
        fingerprint: "escalated-incident",
        role: "reviewer",
        runId: f.run.id,
        turnId: null,
        attempt: 1,
        cause: "missing_callback",
        detail: "Reviewer callback is missing",
        action: "",
        status: "escalated",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  });
  await f.engine.wake();
  const after = f.current();
  assert.equal(after.resolution.stop?.reason, "operator_needed");
  assert.equal(after.resolution.stop?.detail, TASK_PROGRESSING_REASON);
  assert.equal(after.resolution.incident?.status, "escalated");
});
