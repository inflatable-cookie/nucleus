import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptControl,
  fixture,
  head,
} from "./support/review-continuation-fixture";
import { whileReaderInTurn } from "./support/reader-in-turn";
import {
  collectOwnerVerbFacts,
  ownerTaskNext,
} from "../core/verbs/owner-verbs";
import { completionSchema, taskControlInputSchema } from "../shared/contracts";
import { holdPatch, releasePatch } from "../core/merge/merge-hold";
import { ProvenPreSendRefusalError } from "../core/host/errors";
import { toolTimelinePage } from "./support/tool-timeline";

test("report recovery waits for a dispatch hold and sends after release", async () => {
  const f = fixture();
  try {
    await f.report(
      { covered: ["Diff"], remaining: ["Tests"] },
      "held-recovery",
    );
    f.store.putRun({
      ...f.run(),
      reviewBudgetExhaustedAt: new Date().toISOString(),
    });
    f.store.update(
      f.submitted.id,
      holdPatch(f.current(), "dispatch", "operator", "Wait for capacity"),
    );
    const sent: string[] = [];
    f.adapter.notify = async (_agent, _id, text) => {
      sent.push(text);
    };
    await f.engine.performTaskControl({
      action: "restart",
      role: "reviewer",
      taskId: f.submitted.id,
      version: f.current().version,
      reason: "Recover review",
    });
    assert.equal(sent.length, 0);
    assert.equal(f.current().resolution.deferredVerb?.target?.runId, f.runId);
    f.store.update(f.submitted.id, releasePatch(f.current(), "dispatch"));
    await f.engine.applyDeferredOwnerVerbs();
    assert.equal(sent.length, 1);
  } finally {
    await f.close();
  }
});

test("a proven unsent report request can be retried but unknown delivery remains fenced", async () => {
  for (const known of [true, false]) {
    const f = fixture();
    try {
      await f.report(
        { covered: ["Diff"], remaining: ["Tests"] },
        `send-${known}`,
      );
      f.store.putRun({
        ...f.run(),
        reviewBudgetExhaustedAt: new Date().toISOString(),
      });
      let calls = 0;
      f.adapter.notify = async () => {
        calls++;
        if (calls === 1)
          throw known
            ? new ProvenPreSendRefusalError("reviewer was not idle")
            : Error("connection lost");
      };
      const restart = () =>
        f.engine.performTaskControl({
          action: "restart",
          role: "reviewer",
          taskId: f.submitted.id,
          version: f.current().version,
          reason: "Recover review",
        });
      await assert.rejects(restart(), /before send|unknown/);
      if (known) await restart();
      else await assert.rejects(restart(), /unknown delivery/);
      assert.equal(calls, known ? 2 : 1);
    } finally {
      await f.close();
    }
  }
});

test("an idle reviewer with a delivered checkpoint can redeliver its report on the same run", async () => {
  const f = fixture();
  try {
    await f.report({ covered: ["Diff"], remaining: ["Tests"] }, "report-lost");
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1);
    f.store.putRun({
      ...f.run(),
      active: false,
      lastObservedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const sent: { id: string; text: string }[] = [];
    f.adapter.notify = async (_agent, id, text) => {
      sent.push({ id, text });
    };
    const task = f.current();
    await f.engine.performTaskControl({
      action: "move",
      to: "review",
      taskId: task.id,
      version: task.version,
      reason: "Recover the lost report",
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.id, /^ns-reviewer-report-/);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.createdRuns.length, 0);
  } finally {
    await f.close();
  }
});

test("an owner restarts an exhausted checkpoint through the retained reviewer", async () => {
  const f = fixture();
  try {
    await f.report({ covered: ["Diff"], remaining: ["Tests"] }, "exhausted");
    f.store.putRun({
      ...f.run(),
      reviewBudgetExhaustedAt: new Date().toISOString(),
    });
    const sent: string[] = [];
    f.adapter.notify = async (_agent, _id, text) => {
      sent.push(text);
    };
    const task = f.current();
    await f.engine.performTaskControl({
      action: "restart",
      role: "reviewer",
      taskId: task.id,
      version: task.version,
      reason: "Finish the review",
      instruction: "Check the outstanding tests",
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Check the outstanding tests/);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.createdRuns.length, 0);
  } finally {
    await f.close();
  }
});

test("a prior result fence does not force a fresh reviewer when the retained reader is idle", async () => {
  const f = fixture();
  try {
    await f.report({ covered: ["Diff"], remaining: ["Tests"] }, "result-fence");
    const task = f.current();
    f.store.update(task.id, {
      resolution: {
        ...task.resolution,
        review: {
          eventId: "saved",
          taskId: task.id,
          runId: f.runId,
          status: "blocked",
          summary: "Prior environment fault",
          head: f.run().head,
          reviewResponsibility: "environment",
        },
      },
    });
    const sent: string[] = [];
    f.adapter.notify = async (_agent, _id, text) => {
      sent.push(text);
    };
    await f.engine.performTaskControl({
      action: "move",
      to: "review",
      taskId: task.id,
      version: f.current().version,
      reason: "Recover review",
    });
    assert.equal(sent.length, 1);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.createdRuns.length, 0);
  } finally {
    await f.close();
  }
});

test("observation settles an orphan run fencing a checkpoint and Queue continues without a turn-end event", async () => {
  const f = fixture();
  try {
    await f.report(
      { covered: ["Diff"], remaining: ["Tests"] },
      "other-run-checkpoint",
    );
    const other = {
      ...f.run(),
      id: "other-review",
      agentId: "other-reviewer",
      reviewCheckpoints: [],
      createdAt: new Date(Date.parse(f.run().createdAt) - 60_000).toISOString(),
      completion: null,
      active: true,
    };
    f.store.putRun(other);
    f.store.putRun({
      ...other,
      id: "finished-sibling",
      status: "finished",
      released: true,
      createdAt: f.run().createdAt,
      completion: {
        eventId: "sibling-result",
        taskId: f.submitted.id,
        runId: "finished-sibling",
        status: "blocked",
        summary: "Earlier environment fault",
        head: f.run().head,
      },
    });
    f.states.set(other.agentId, {
      ...f.states.get("review-agent")!,
      id: other.agentId,
      status: "running",
      active: true,
    });
    await f.engine.wake();
    assert.equal(
      f.store.run(other.id)!.released,
      false,
      "a busy thread still holds its lease",
    );
    assert.equal(f.reviewerDeliveries.length, 0);
    f.states.set(other.agentId, {
      ...f.states.get(other.agentId)!,
      status: "idle",
      active: false,
    });
    assert.ok(f.engine.resolution.observationTargets().includes(other.agentId));
    await f.engine.wake();
    assert.equal(
      f.store.run(other.id)!.released,
      true,
      "ordinary idle observation settles the orphan run",
    );
    assert.ok(
      f.store
        .eventsAll(f.submitted.id)
        .some((event) => event.kind === "duplicate_run_superseded"),
    );
    await f.engine.wake();
    assert.equal(
      f.reviewerDeliveries.length,
      1,
      "the existing continuation gate now admits the checkpoint",
    );
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId);
    assert.equal(f.run().completion, null);
    assert.deepEqual(f.counts(), { merges: 0, syncs: 0 });
  } finally {
    await f.close();
  }
});

test("a deferred reviewer checkpoint retries on the next pass after its incident fence clears", async () => {
  const f = fixture();
  try {
    await f.report(
      { covered: ["Diff"], remaining: ["Tests"] },
      "fenced-checkpoint",
    );
    const incident = f.engine.resolution.ensureIncident(
      f.current(),
      f.run(),
      "Recovery is reconciling the review incident",
    );
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(
      f.reviewerDeliveries.length,
      0,
      "the checkpoint waits while its incident is open",
    );
    assert.ok(
      f.store
        .events(f.submitted.id)
        .some((event) => event.kind === "review_auto_continue_deferred"),
    );
    const current = f.current();
    f.store.update(current.id, {
      resolution: {
        ...current.resolution,
        incident: {
          ...incident,
          status: "resolved",
          detail: "Recovery reported the trigger settled",
          updatedAt: new Date().toISOString(),
        },
      },
    });
    await f.engine.wake();
    assert.equal(
      f.reviewerDeliveries.length,
      1,
      "the continuation retries after the fence clears",
    );
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId);
    assert.equal(
      f.store
        .events(f.submitted.id)
        .filter((event) => event.kind === "review_auto_continued").length,
      1,
    );
  } finally {
    await f.close();
  }
});

for (const action of [
  "sweep",
  "sweep-legacy-stopped",
  "move",
  "restart",
  "unbound-result",
] as const) {
  test(`a replacement reviewer at the same head can resume after an applied impediment (${action})`, async () => {
    const f = fixture();
    try {
      const taskId = f.submitted.id;
      const oldResult = completionSchema.parse({
        eventId: "exhausted-reader-blocked",
        taskId,
        runId: f.runId,
        head,
        status: "blocked",
        summary: "The continuation allowance is exhausted",
        reviewResponsibility: "environment",
        reviewText: "Review stopped before all inputs were read",
      });
      await whileReaderInTurn(f.engine, "review-agent", () =>
        f.engine.complete(
          {
            eventId: "exhausted-reader-progress",
            taskId,
            runId: f.runId,
            head,
            status: "review_in_progress",
            summary: "Continuation allowance exhausted",
            checkpoint: {
              covered: ["Diff"],
              remaining: ["Tests"],
              exhausted: true,
            },
          },
          "token",
        ),
      );
      assert.ok(f.run().reviewBudgetExhaustedAt);
      await f.engine.complete(oldResult, "token");
      await f.engine.wake();
      assert.equal(f.current().phase, "blocked");
      assert.equal(f.run().released, true);
      assert.equal(f.current().resolution.review?.eventId, oldResult.eventId);

      let token: string | undefined;
      const createRun = f.adapter.createRun!;
      f.adapter.createRun = async (task, run, credential) => {
        token = credential;
        return createRun(task, run, credential);
      };
      f.states.set("review-agent", {
        ...f.states.get("review-agent")!,
        status: "closed",
      });
      await f.engine.performTaskControl({
        taskId,
        version: f.current().version,
        action: "restart",
        role: "reviewer",
        fresh: true,
        caller: "owner",
        reason: "Finish the independent review",
      });
      await f.engine.wake();
      const runId = f.current().resolution.currentRunId!;
      const replacement = f.store.run(runId)!;
      const agentId = replacement.agentId!;
      assert.notEqual(runId, f.runId);
      assert.notEqual(agentId, "review-agent");
      assert.equal(replacement.head, head);
      assert.equal(f.current().resolution.review?.eventId, oldResult.eventId);

      const progress = {
        eventId: "replacement-reader-progress",
        taskId,
        runId,
        head,
        status: "review_in_progress" as const,
        summary: "First checkpoint",
        checkpoint: { covered: ["Diff"], remaining: ["Tests"] },
      };
      assert.ok(token);
      await f.engine.complete(progress, token);
      await f.engine.quiesce();
      assert.equal(f.store.run(runId)?.reviewCheckpoints?.length, 1);
      // The earlier auto-continue writer left this run stopped after a refusal.
      if (action !== "sweep")
        f.store.putRun({
          ...f.store.run(runId)!,
          status: "stopped",
          active: false,
        });
      f.states.set(agentId, {
        ...f.states.get(agentId)!,
        status: "idle",
        active: false,
        provider: replacement.profile!.provider,
        model: replacement.profile!.model,
      });

      if (action === "unbound-result") {
        const current = f.current();
        f.store.update(taskId, {
          resolution: {
            ...current.resolution,
            review: { ...oldResult, eventId: "mismatch" },
          },
        });
        await f.engine.auditPass(true);
        const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
        assert.ok(
          !next.verbs.some(
            (verb) =>
              verb.verb === "restart" &&
              verb.available &&
              verb.args?.role === "reviewer",
          ),
        );
        assert.match(
          next.verbs.find((verb) => verb.refusal?.startsWith("move review:"))
            ?.refusal ?? "",
          /report cannot be requested/,
        );
        await assert.rejects(
          f.engine.performTaskControl({
            action: "move",
            to: "review",
            taskId,
            version: f.current().version,
            reason: "Inspect the result",
          }),
          /report cannot be requested/,
        );
        assert.doesNotMatch(next.stop?.detail ?? "", /fresh/);
        assert.equal(f.reviewerDeliveries.length, 0);
        return;
      }

      const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
      assert.equal(next.outcome?.reader?.runId, runId);
      assert.equal(next.outcome?.impediments[0]?.eventId, oldResult.eventId);
      assert.doesNotMatch(next.stop?.detail ?? "", /fences checkpoint|fresh/);
      const offer = next.verbs.find(
        (verb) =>
          verb.verb === (action === "move" ? "move" : "restart") &&
          verb.available &&
          (action === "move"
            ? verb.args?.to === "review"
            : verb.args?.role === "reviewer"),
      );
      assert.ok(
        offer?.args && offer.args.fresh !== true,
        JSON.stringify(next.verbs),
      );
      if (action === "sweep" || action === "sweep-legacy-stopped") {
        assert.equal((await f.engine.auditPass(true)).fault, null);
        assert.equal(
          f.store
            .eventsAll(taskId)
            .filter((event) => event.kind === "review_auto_continued").length,
          1,
        );
      } else {
        const input = taskControlInputSchema.parse({
          ...offer.args,
          caller: "owner",
          reason: "Continue the checkpoint",
        });
        const key = `continue-${action}`;
        const outcome = await acceptControl(f, input, key);
        assert.equal(outcome.state, "succeeded", outcome.diagnostic);
        assert.equal((await acceptControl(f, input, key)).id, outcome.id);
      }
      assert.equal(f.store.run(runId)?.status, "running");
      assert.equal(
        f.store.run(runId)?.reviewDeliveries?.at(-1)?.status,
        "delivered",
      );
      assert.equal(f.current().resolution.review?.eventId, oldResult.eventId);
      assert.equal(
        f.store.run(f.runId)?.completion?.eventId,
        oldResult.eventId,
      );
      assert.equal((await f.engine.auditPass(true)).fault, null);
      assert.deepEqual(
        f.reviewerDeliveries.map((delivery) => delivery.runId),
        [runId],
      );
      assert.equal(
        f.store
          .eventsAll(taskId)
          .filter((event) => event.kind === "review_delivery_delivered").length,
        1,
      );
      assert.equal(f.createdRuns.length, 1);
      assert.deepEqual(f.counts(), { merges: 0, syncs: 0 });
    } finally {
      await f.close();
    }
  });
}

/**
 * One reviewer report request, bound to the delivered review occurrence it can
 * resend. The checkpoint's continuation is undelivered here, so the request
 * names the dispatch the reviewer was actually created for.
 */
function undeliveredReportCase(f: ReturnType<typeof fixture>) {
  f.store.putRun({
    ...f.run(),
    reviewBudgetExhaustedAt: new Date().toISOString(),
    reviewDeliveries: [],
    active: false,
    lastObservedAt: new Date(Date.now() + 1000).toISOString(),
  });
  f.store.event(
    f.submitted.id,
    "run_creation_bound",
    `${f.runId}: exact lookup bound agent review-agent in workspace; its dispatch delivery is not yet observed`,
  );
}

test("the already-asked refusal names the delivered continuation it waits on", async () => {
  const f = fixture();
  try {
    await f.report({ covered: ["Diff"], remaining: ["Tests"] }, "named-turn");
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1);
    f.store.putRun({
      ...f.run(),
      active: false,
      lastObservedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const sent: string[] = [];
    f.adapter.notify = async (_agent, _id, text) => {
      sent.push(text);
    };
    const task = f.current();
    await f.engine.performTaskControl({
      action: "move",
      to: "review",
      taskId: task.id,
      version: task.version,
      reason: "Recover the lost report",
    });
    assert.equal(sent.length, 1);
    await assert.rejects(
      f.engine.performTaskControl({
        action: "move",
        to: "review",
        taskId: f.submitted.id,
        version: f.current().version,
        reason: "Recover the lost report again",
      }),
      /already asked to resend its report for the delivered continuation[\s\S]*at head/,
    );
    assert.equal(sent.length, 1);
  } finally {
    await f.close();
  }
});
