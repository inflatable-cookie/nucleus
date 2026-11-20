import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  completionSchema,
  runSchema,
  taskControlInputSchema,
  type Task,
} from "../shared/contracts";
import { taskStopRecord } from "../shared/task-stop";
import { reviewPublicationBody } from "../core/forge/index";
import { holdPatch } from "../core/merge/merge-hold";
import { digest } from "../core/store/store";
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
