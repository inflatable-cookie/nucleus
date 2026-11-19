import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, profile } from "./support/review-continuation-fixture";
import { plannerEscalations } from "../core/questions/ladder/records";
import {
  reviewContinuationState,
  reviewerCannotFinish,
} from "../core/review/review-continuation";

/**
 * nucleus#1372: a retained reviewer that reported it cannot finish the remaining
 * reading sat idle for five hours while `next` offered `restart role=reviewer
 * fresh` and nothing acted. Once the reader is observed settled, the sweep takes
 * that ordinary exit itself — or, where it cannot, opens the planner escalation
 * with the verb named. The reader is the escalation episode, so a replacement
 * that exhausts again is never silent under the answered escalation before it.
 */

/** Exhaust the current reader exactly as its authenticated progress report does. */
async function exhaust(f: ReturnType<typeof fixture>, eventId: string) {
  await f.report(
    { covered: ["Diff"], remaining: ["Tests"], exhausted: true },
    eventId,
  );
  assert.equal(
    reviewContinuationState(f.current(), f.store),
    "exhausted",
    "the reader reported it cannot finish at this head",
  );
  assert.ok(reviewerCannotFinish(f.run()));
  // The pass observes the reader idle: the report came from inside its turn.
  f.states.set("review-agent", {
    ...f.states.get("review-agent")!,
    status: "idle",
    active: false,
    permissions: false,
  });
}

/** A host whose archived reviewer proves the replacement's archive step. */
function archiveable(f: ReturnType<typeof fixture>) {
  const adapter = f.adapter as unknown as {
    originAgent?: (id: string) => Promise<unknown>;
  };
  adapter.originAgent = async (id: string) => ({
    id,
    workspaceId: "workspace",
    title: id,
    archived: true,
  });
}

const reviewerRuns = (f: ReturnType<typeof fixture>) =>
  f.store.runs(f.current().id).filter((run) => run.role === "reviewer");

test("a reader that reported it cannot finish is replaced fresh once it is observed idle", async () => {
  const f = fixture();
  try {
    archiveable(f);
    const reader = f.run();
    await exhaust(f, "queue-replaces");
    await f.engine.wake();
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_replaced").length,
      1,
      "the pass took the ordinary exit for this reader",
    );
    const fresh = f.createdRuns.filter(
      (run) => run.role === "reviewer" && run.id !== reader.id,
    );
    assert.equal(
      fresh.length,
      1,
      JSON.stringify(f.createdRuns.map((run) => `${run.role}:${run.id}`)),
    );
    assert.equal(f.current().resolution.currentRunId, fresh[0]!.id);
    assert.equal(f.store.run(reader.id)?.released, true);
    assert.notEqual(
      fresh[0]!.agentId,
      reader.agentId,
      "a fresh reader, not the retained one",
    );
    assert.equal(fresh[0]!.head, reader.head, "at the same exact head");
    assert.notEqual(
      reviewContinuationState(f.current(), f.store),
      "exhausted",
      "the exhausted reader no longer holds the task",
    );
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      0,
      "the ordinary exit needed no planner turn",
    );
    // A later pass finds a reader that can read: no second replacement, no
    // second record for the same reader.
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_replaced").length,
      1,
    );
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_escalated").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a replacement that cannot act escalates with the verb named, once per reader", async () => {
  const f = fixture();
  try {
    const reader = f.run();
    await exhaust(f, "queue-escalates");
    // The PR head moved under the reader, so the ordinary replacement refuses
    // rather than replacing it at a head it never read.
    f.store.update(f.current().id, { prHead: "c".repeat(40) });
    await f.engine.wake();
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_replaced").length,
      0,
    );
    const escalations = plannerEscalations(
      f.store.eventsAll(f.current().id) as never,
    );
    assert.equal(escalations.length, 1, JSON.stringify(escalations));
    assert.match(
      f.store
        .events(f.current().id)
        .find((event) => event.kind === "planner_escalation_question")!.detail,
      /restart role=reviewer fresh/,
      "the escalation question names the ordinary exit",
    );
    assert.match(
      f.store
        .events(f.current().id)
        .find((event) => event.kind === "review_exhausted_escalated")!.detail,
      new RegExp(reader.id),
      "the board names the reader the automatic exit could not replace",
    );
    // The same reader joins its own escalation; nothing is opened twice.
    await f.engine.wake();
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      1,
    );
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_escalated").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("each exhausted reader is its own escalation, so a later one is never silent", async () => {
  const f = fixture();
  try {
    const first = f.current().resolution.currentRunId!;
    const ladder = f.engine.resolution;
    const cause = ladder.openReviewContinuationEscalation(
      f.current(),
      "exhausted",
    );
    assert.match(
      f.store
        .events(f.current().id)
        .find((event) => event.kind === "planner_escalation")!.detail,
      new RegExp(cause),
    );
    // A replacement reader that later exhausts again is a new episode: it gets
    // its own escalation instead of joining the answered one before it.
    f.store.putRun({
      ...f.run(),
      id: "replacement-review-run",
      agentId: "replacement-review-agent",
      released: false,
    });
    f.store.update(f.current().id, {
      resolution: {
        ...f.current().resolution,
        currentRunId: "replacement-review-run",
      },
    });
    const second = ladder.openReviewContinuationEscalation(
      f.current(),
      "exhausted",
    );
    assert.notEqual(second, cause, first);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      2,
      "the second reader's stop escalates on its own",
    );
    // The same reader again joins its one escalation.
    assert.equal(
      ladder.openReviewContinuationEscalation(f.current(), "exhausted"),
      second,
    );
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      2,
    );
  } finally {
    await f.close();
  }
});

/** A coordinator is available, so the recovery route is live for this task. */
function withCoordinator(f: ReturnType<typeof fixture>) {
  const coordinator = profile("coordinator", "test/coordinator");
  f.store.setMeta("pool", [
    ...f.store.pool(),
    {
      profileId: coordinator.id,
      enabled: true,
      group: "coordinate",
      roles: ["coordinator"],
      weight: 1,
      scopes: ["general"],
    },
  ]);
  f.engine.profiles = [...f.engine.profiles, coordinator];
  (
    f.adapter as unknown as { supportsCoordinatorRecovery?: boolean }
  ).supportsCoordinatorRecovery = true;
}

test("a reader that reported it cannot finish is not escalated before its turn ends", async () => {
  const f = fixture();
  try {
    withCoordinator(f);
    await f.report(
      { covered: ["Diff"], remaining: ["Tests"], exhausted: true },
      "busy-exhausted",
    );
    // The report's own wake saw the reader inside its turn. The recovery route
    // must not pre-empt the replacement the lifecycle pass owes once it settles.
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      0,
      "a working exhausted reader keeps its owner stop, not a planner escalation",
    );
    await f.engine.wake();
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      0,
    );
    f.states.set("review-agent", {
      ...f.states.get("review-agent")!,
      status: "idle",
      active: false,
      permissions: false,
    });
    await f.engine.wake();
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_replaced").length,
      1,
      "the settled reader is replaced on the pass that observes it",
    );
  } finally {
    await f.close();
  }
});

test("a reader whose budget is spent without a refused reading still escalates through the route", async () => {
  const f = fixture();
  try {
    withCoordinator(f);
    await f.report({ covered: ["Diff"], remaining: ["Tests"] }, "spent-budget");
    // No refused reading: the reader never reported it cannot finish, so the
    // lifecycle owes it no automatic replacement and the ladder decides.
    f.store.putRun({
      ...f.run(),
      reviewBudgetExhaustedAt: new Date().toISOString(),
    });
    assert.equal(reviewContinuationState(f.current(), f.store), "exhausted");
    assert.equal(reviewerCannotFinish(f.run()), false);
    await f.engine.wake();
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.current().id) as never).length,
      1,
      "a spent budget still reaches the planner",
    );
    assert.equal(
      f.store
        .events(f.current().id)
        .filter((event) => event.kind === "review_exhausted_replaced").length,
      0,
    );
  } finally {
    await f.close();
  }
});
