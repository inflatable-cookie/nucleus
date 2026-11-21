import assert from "node:assert/strict";
import { test } from "node:test";
import {
  taskControlInputSchema,
} from "../shared/contracts";
import { resendExecutorReport } from "../core/verbs/executor-report";
import { requestReviewerReport } from "../core/verbs/reviewer-report";
import { WorkerRestarts } from "../core/verbs/restart-worker";
import {
  deferredRestart,
  head,
  intentFixture,
  lostReply,
  restartAfterIntent,
} from "./support/intent-restart";
import { observeIdle } from "./support/fakes";

for (const role of ["executor", "reviewer"] as const) {
  const kind = `${role}_report_request_intent`;
  test(`${kind} records a report request before its reply`, async (t) => {
    const f = intentFixture(
      t,
      {
        verifyPr: async () => ({
          url: "https://github.com/example/repo/pull/1",
          head,
        }),
        notify: async () => {
          throw lostReply;
        },
      },
      { phase: "reviewing", resumePrNumber: 1 },
    );
    const run = f.run({ role });
    f.engine.resolution.update(f.task(), { reviewerAgentId: "reader" });
    const reason = "Request the retained report";
    const write = () =>
      role === "reviewer"
        ? requestReviewerReport(
            f.engine,
            f.task(),
            run,
            f.task().version,
            reason,
          )
        : resendExecutorReport(
            f.engine,
            taskControlInputSchema.parse({
              action: "restart",
              taskId: f.id,
              version: f.task().version,
              role,
              reason,
            }),
            f.task(),
            reason,
          );
    await deferredRestart(
      t,
      f,
      kind,
      () => assert.rejects(write(), /unknown/i),
      "The report-request fence lacks a receipt observer",
      (store) => {
        assert.equal(
          store
            .eventsAll(f.id)
            .filter((e) => e.kind === `${role}_report_request_sent`).length,
          1,
        );
      },
    );
  });
}

test("report_ready_planner_notice_intent is recorded before notification", async (t) => {
  const f = intentFixture(t, {
    notify: async () => {
      throw lostReply;
    },
  });
  f.engine.resolution.plannerRungsFor = async () => ({ rungs: [{ agentId: "planner", rung: "task" }], projectFailed: false });
  f.engine.resolution.identifyOriginHost = async () => "host";
  const task = f.store.update(f.id, {
    completion: {
      taskId: f.id,
      runId: "worker-run",
      eventId: "report",
      status: "report_ready",
      summary: "Report ready",
      artifact: {
        key: "report",
        version: 1,
        digest: "sha256:" + head.padEnd(64, "a"),
      },
    },
  });
  await deferredRestart(
    t,
    f,
    "report_ready_planner_notice_intent",
    () => f.engine.acceptWorkerResult(task, task),
    "Report acceptance persists but the notification has no receipt observer",
    (store) => {
      assert.equal(
        store
          .eventsAll(f.id)
          .filter((e) => e.kind === "report_ready_planner_notice_delivered")
          .length,
        1,
      );
    },
  );
});

test("owner_restart_instruction_intent fences an uncertain retained-thread restart", async (t) => {
  const f = intentFixture(t, {
    notify: async () => {
      throw lostReply;
    },
  });
  f.store.event(
    f.id,
    "owner_stopped",
    JSON.stringify({ runIds: ["worker-run"] }),
  );
  const reason = "Continue the stopped task";
  const write = () =>
    new WorkerRestarts(f.engine).restartWorker({
      task: f.task(),
      input: taskControlInputSchema.parse({
        action: "restart",
        taskId: f.id,
        version: f.task().version,
        reason,
      }),
      reason,
      instruction: reason,
      role: "worker",
      shape: "owner_stopped_worker",
    });
  await deferredRestart(
    t,
    f,
    "owner_restart_instruction_intent",
    () => assert.rejects(write(), lostReply),
    "The bare instruction has no operation identity for the recovery effect reader",
    (store) => {
      assert.equal(
        store
          .eventsAll(f.id)
          .filter((e) => e.kind === "owner_restart_instruction_sent").length,
        1,
      );
    },
  );
});

function activeWorker() {
  return {
    id: "worker",
    workspaceId: "ws",
    status: "running",
    active: true,
    activeTurnId: "turn",
    permissions: false,
    error: "",
  };
}
for (const route of [false, true]) {
  const kind = route ? "route_stop_intent" : "owner_stop_intent";
  test(`${kind} records the target before stopping it`, async (t) => {
    let active = true;
    const f = intentFixture(t, {
      observe: async (id) =>
        active ? { ...activeWorker(), id } : observeIdle("ws")(id),
      stopAgentTurn: async () => {
        active = false;
        throw lostReply;
      },
    });
    const write = () =>
      route
        ? f.engine["stopRouteRun"](
            f.task(),
            "worker",
            null,
            "fixture-operation",
          )
        : f.engine.cancelDisplacedTurns(
            f.id,
            [
              {
                id: "worker-run",
                taskId: f.id,
                agentId: "worker",
                workspaceId: "ws",
                role: "worker",
              },
            ],
            "stop",
          );
    await deferredRestart(
      t,
      f,
      kind,
      () => assert.rejects(write(), /Fixture target changed/),
      "A bare stop intent has no independent sweep observer",
      (store) => {
        assert.ok(
          store
            .eventsAll(f.id)
            .some((e) => e.kind === kind.replace("_intent", "_settled")),
        );
      },
    );
  });
}

test("stalled_turn_stop_intent survives a lost reply on the exact turn", async (t) => {
  let active = true;
  let sends = 0;
  const f = intentFixture(
    t,
    {
      observe: async (id) =>
        active ? { ...activeWorker(), id } : observeIdle("ws")(id),
      stopAgentTurn: async () => {
        active = false;
        sends++;
        throw lostReply;
      },
    },
    { prHead: null, prUrl: null },
  );
  f.engine.resolution.update(f.task(), {
    attention: true,
    incident: {
      id: "incident",
      role: "worker",
      runId: "worker-run",
      fingerprint: "fixture",
      attempt: 1,
      cause: "stalled_turn",
      turnId: "turn",
      detail: "The fixture turn stalled",
      action: "",
      status: "reconciling",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  await restartAfterIntent(
    f.engine,
    f.id,
    "stalled_turn_stop_intent",
    async () => {
      await f.engine
        .stopStalledTurn({
          taskId: f.id,
          version: f.task().version,
          runId: "worker-run",
        })
        .catch((error) => {
          assert.match(String(error), /Fixture target changed/);
        });
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      assert.equal(
        store.task(f.id).resolution.stalledTurnStop?.status,
        "stopped",
      );
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
      assert.equal(sends, 1);
    },
  );
});

test("transient_provider_resume_intent records the continuation before the adapter call", async (t) => {
  const state = {
    ...activeWorker(),
    status: "error",
    active: false,
    activeTurnId: undefined,
    error: "Provider overloaded, retry later",
  };
  let sends = 0;
  const f = intentFixture(
    t,
    {
      observe: async (id) => ({ ...state, id }),
      continueWorker: async () => {
        sends++;
        throw lostReply;
      },
    },
    { prHead: null, prUrl: null },
  );
  await deferredRestart(
    t,
    f,
    "transient_provider_resume_intent",
    async () => {
      const resume = () =>
        f.engine.resolution.resumeTransientWorker(f.task(), state);
      await resume();
      const retry = f.task().transientProviderRetry;
      assert.ok(retry);
      f.store.update(f.id, {
        transientProviderRetry: {
          ...retry,
          retryAt: new Date(0).toISOString(),
        },
      });
      await resume();
      assert.equal(sends, 1);
      f.store.update(f.id, { phase: "done", workspaceId: null });
    },
    "Terminal tasks lack a continuation-receipt visit",
    (store) => {
      assert.equal(store.task(f.id).transientProviderRetry?.status, "sent");
      assert.equal(sends, 1);
    },
  );
});
