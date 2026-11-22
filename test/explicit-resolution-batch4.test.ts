import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import {
  closeClearedEscalations,
  escalationVerbChoices,
  plannerEscalations,
  type EscalationVerbChoice,
} from "../core/questions/ladder";
import { Store } from "../core/store/store";
import {
  collectOwnerVerbFacts,
  ownerVerbViews,
  parkedRestart,
} from "../core/verbs/owner-verbs";
import {
  OPERATOR_BOARD_CALLER,
  questionAnswerInputSchema,
  questionAnswerRequestSchema,
  runSchema,
  submissionSchema,
  taskControlInputSchema,
} from "../shared/contracts";
import { observeIdle } from "./support/fakes";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "1".repeat(40);
const PLANNER = "planner-live";
const REPO = "/repo/explicit-batch4";

function makeFixture(options: { plannerRoutable?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ns-explicit-batch4-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("hostRegistry", [{ id: "host-1", kind: "paseo", label: "Host" }]);
  store.upsertProject({
    key: "explicit-batch4",
    name: "Explicit Batch 4",
    repositories: [
      {
        origin: "https://github.com/example/explicit-batch4.git",
        path: REPO,
      },
    ],
  });
  store.setProjectPlanner({
    key: "explicit-batch4",
    agentId: PLANNER,
    setBy: "operator",
  });
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Batch 4 escalation task",
      repoPath: REPO,
      planningCommit: BASE,
      handoffPath: "handoff.md",
      originAgentId: PLANNER,
      responsible: true,
    }),
    "host-1",
    "handoff",
    BASE,
  );
  const plannerRoutable = options.plannerRoutable ?? true;
  const adapter = {
    hostId: "host-1",
    profiles: async () => [],
    listLiveAgents: async () =>
      plannerRoutable
        ? [{ id: PLANNER, title: "Planner", directory: REPO, workspaceId: null }]
        : [],
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: !plannerRoutable && id === PLANNER,
    }),
    observe: async (agentId: string) => {
      if (agentId === PLANNER) {
        return plannerRoutable
          ? {
              id: PLANNER,
              status: "idle",
              active: false,
              workspaceId: "ws-planner",
              cwd: REPO,
            }
          : {
              id: PLANNER,
              status: "closed",
              active: false,
              workspaceId: "ws-planner",
              cwd: REPO,
            };
      }
      return (await observeIdle(null)(agentId))!;
    },
    stopAgentTurn: async () => {},
    archiveAgent: async () => {},
    createRun: async () => {
      throw new Error("Unexpected createRun");
    },
    sendRun: async () => {},
    notify: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const taskId = inserted.id;
  return {
    dir,
    store,
    engine,
    taskId,
    task: () => store.task(taskId),
    close: async () => {
      await engine.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function recordOpenEscalation(
  store: Store,
  engine: Engine,
  taskId: string,
  id: string,
  options: {
    runId?: string | null;
    payload?: Record<string, unknown>;
    offered?: EscalationVerbChoice[];
    recipient?: string;
    role?: "planner" | "decider";
  } = {},
) {
  const task = store.task(taskId);
  const cause = "e".repeat(64);
  store.event(
    taskId,
    "planner_escalation",
    `${id}: cause ${cause}; run ${options.runId ?? "worker"}; question pending`,
  );
  store.event(
    taskId,
    "planner_escalation_payload",
    `${id}: ${JSON.stringify({
      cause,
      runId: options.runId ?? null,
      question: "How should this stuck task proceed?",
      ...(options.payload ?? {}),
    })}`,
  );
  store.event(
    taskId,
    "planner_escalation_offered",
    `${id}: ${JSON.stringify(options.offered ?? [])}`,
  );
  engine.resolution.waiting(
    store.task(taskId),
    `Waiting with the planner: blocker escalation ${id} is open`,
    "escalated",
    { fact: { code: "escalation", subject: id } },
  );
  const questionId = `ns-escalation-${id}`;
  engine.resolution.openDelegatedQuestion(
    store.task(taskId),
    questionId,
    options.recipient ?? PLANNER,
    `Choose how to continue\n${(options.offered ?? []).map((o) => `- ${o.label}`).join("\n")}`,
    60_000,
    options.role ?? "planner",
    "host-1",
  );
  return questionId;
}

test("question.answer schema validates explicit command + version requirements", () => {
  const validTopVersion = questionAnswerInputSchema.parse({
    questionId: "ns-escalation-1",
    caller: PLANNER,
    version: 3,
    command: { action: "run.release", run: "run-1", accept: ["live_turn"] },
    reason: "Release stuck run",
  });
  assert.equal(validTopVersion.command?.action, "run.release");

  const validCommandVersion = questionAnswerRequestSchema.parse({
    taskId: "task-1",
    caller: PLANNER,
    command: { action: "phase.set", to: "working", version: 4 },
    reason: "Return to working",
  });
  assert.equal(validCommandVersion.command?.version, 4);

  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-1",
        caller: PLANNER,
        command: { action: "turn.release" },
        reason: "Missing version",
      }),
    /requires a task version/,
  );

  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-1",
        caller: PLANNER,
        version: 2,
        command: { action: "turn.release", version: 3 },
        reason: "Mismatched versions",
      }),
    /must match/,
  );

  assert.throws(
    () =>
      questionAnswerInputSchema.parse({
        questionId: "ns-escalation-1",
        caller: PLANNER,
        version: 2,
        answer: "Try again",
        command: { action: "turn.release" },
        reason: "Both answer and command",
      }),
    /Provide exactly one of answer, choice, decision or command/,
  );
});

test("underlay#046 shape: offered retry_effect choice is not refused with 'no longer available' loop", async () => {
  const f = makeFixture();
  try {
    const staleOffer: EscalationVerbChoice = {
      label: "Retry run-delivery.run-old: observe and retry the recorded effect",
      verb: "retry_effect",
      args: { effect: "run-delivery.run-old" },
    };
    const id = "underlay-046-retry";
    const questionId = recordOpenEscalation(f.store, f.engine, f.taskId, id, {
      offered: [staleOffer],
    });
    // `next` does not offer `retry_effect` for `run-delivery.run-old` at all.
    assert.equal(
      escalationVerbChoices(
        ownerVerbViews(collectOwnerVerbFacts(f.store, f.task())),
      ).some((choice) => choice.verb === "retry_effect"),
      false,
    );

    const seen: unknown[] = [];
    f.engine.resolution.applyOperatorControl = async (input) => {
      seen.push(input);
      return f.task();
    };

    const receipt = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: staleOffer.label,
        version: f.task().version,
        reason: "Invoke the real retry_effect handler without offer-match refusal",
      },
      PLANNER,
    );
    assert.equal(receipt.questionId, questionId);
    assert.equal(seen.length, 1);
    assert.equal((seen[0] as { action: string }).action, "retry_effect");
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      true,
    );
  } finally {
    await f.close();
  }
});

test("escalation answer carrying an explicit command enforces version, warnings, accept, owner_resolution and next", async () => {
  const f = makeFixture();
  try {
    const run = runSchema.parse({
      id: "run-stuck-1",
      taskId: f.taskId,
      role: "reviewer",
      generation: 1,
      head: HEAD_A,
      base: BASE,
      agentId: "reviewer-1",
      workspaceId: "ws-1",
      hostId: "host-1",
      profile: null,
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(run);
    f.store.update(f.taskId, {
      phase: "reviewing",
      prHead: HEAD_A,
      resolution: {
        ...f.task().resolution,
        currentRunId: run.id,
        reviewerAgentId: "reviewer-1",
      },
    });
    const id = "explicit-cmd-release";
    const questionId = recordOpenEscalation(f.store, f.engine, f.taskId, id, {
      runId: run.id,
    });
    const currentVersion = f.task().version;

    // 1. Stale version returns stale status without changing anything or settling the escalation.
    const stale = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion + 99,
        command: { action: "run.release", run: run.id, accept: [] },
        reason: "Release stuck reviewer",
      },
      PLANNER,
    );
    assert.equal((stale as { status?: string }).status, "stale");
    assert.match(
      (stale as { explicitResolution?: { next: string } }).explicitResolution
        ?.next ?? "",
      new RegExp(`version ${currentVersion}`),
    );
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      false,
    );

    // 2. Unaccepted warnings return warnings with ids and change nothing.
    const warned = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion,
        command: { action: "run.release", run: run.id, accept: [] },
        reason: "Release stuck reviewer",
      },
      PLANNER,
    );
    assert.equal((warned as { status?: string }).status, "warnings");
    const warningIds = (
      warned as {
        explicitResolution?: { warnings: Array<{ id: string }>; next: string };
      }
    ).explicitResolution?.warnings.map((w) => w.id);
    assert.deepEqual(warningIds?.sort(), ["live_turn", "unreported_result"]);
    assert.equal(f.store.run(run.id)?.released, false);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      false,
    );

    // 3. Repeating with accept applies the command, writes one owner_resolution event and settles the escalation.
    const applied = await f.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        version: currentVersion,
        command: {
          action: "run.release",
          run: run.id,
          accept: ["live_turn", "unreported_result"],
        },
        reason: "Release stuck reviewer",
      },
      PLANNER,
    );
    assert.equal((applied as { status?: string }).status, "applied");
    assert.ok(
      (applied as { explicitResolution?: { next: string } }).explicitResolution
        ?.next.length,
    );
    assert.equal(f.store.run(run.id)?.released, true);
    assert.equal(
      f.store.eventsAll(f.taskId).filter((e) => e.kind === "owner_resolution")
        .length,
      1,
    );
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      true,
    );
  } finally {
    await f.close();
  }
});

test("escalation explicit command enforces answerer authority and hard gates even with accept", async () => {
  const f = makeFixture({ plannerRoutable: true });
  try {
    f.store.update(f.taskId, {
      phase: "verifying",
      resumePrNumber: 42,
      prUrl: "https://github.com/example/explicit-batch4/pull/42",
      prHead: HEAD_A,
    });
    const id = "explicit-hard-gate";
    const questionId = recordOpenEscalation(f.store, f.engine, f.taskId, id);

    // Hard gate: merge.now refuses without an applied review verdict or operator source acceptance, even with accept.
    await assert.rejects(
      async () =>
        f.engine.resolution.answerDelegatedQuestion(
          {
            questionId,
            version: f.task().version,
            command: {
              action: "merge.now",
              head: HEAD_A,
              accept: ["checks", "holds", "turn_held"],
            },
            reason: "Attempt unreviewed merge",
          },
          PLANNER,
        ),
      /review verdict|operator source acceptance/i,
    );
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      false,
    );

    // Authority: an unauthorized caller (not live responsible planner / coordinator / operator) is refused.
    const deciderId = "explicit-unauth";
    const deciderQuestion = recordOpenEscalation(
      f.store,
      f.engine,
      f.taskId,
      deciderId,
      { recipient: "decider-1", role: "decider" },
    );
    await assert.rejects(
      async () =>
        f.engine.resolution.answerDelegatedQuestion(
          {
            questionId: deciderQuestion,
            version: f.task().version,
            command: { action: "phase.set", to: "working", accept: [] },
            reason: "Decider lacks explicit command authority",
          },
          "decider-1",
        ),
      /requires this task's coordinator, its live responsible planner or the operator board/i,
    );

    // Operator authority works via settleExplicitEscalationCommand.
    const opResult = await f.engine.resolution.settleExplicitEscalationCommand(
      f.task(),
      id,
      { action: "record.clear", kind: "escalation", id, accept: [] },
      "Operator clears escalation directly",
      OPERATOR_BOARD_CALLER,
      f.task().version,
    );
    assert.equal(opResult.status, "applied");
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find((e) => e.id === id)
        ?.answered,
      true,
    );
  } finally {
    await f.close();
  }
});

test("open escalations close automatically when their cause clears", async () => {
  const f = makeFixture();
  try {
    // 1. Review continuation escalation closes when the stopped reviewer is released.
    const reviewer = runSchema.parse({
      id: "rev-exhausted-1",
      taskId: f.taskId,
      role: "reviewer",
      generation: 1,
      head: HEAD_A,
      base: BASE,
      agentId: "reviewer-1",
      workspaceId: "ws-1",
      hostId: "host-1",
      profile: null,
      status: "finished",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      lastObservedAt: null,
      active: false,
      idleSince: null,
      completion: null,
      released: false,
    });
    f.store.putRun(reviewer);
    f.store.update(f.taskId, {
      phase: "reviewing",
      prHead: HEAD_A,
      resolution: { ...f.task().resolution, currentRunId: reviewer.id },
    });
    const revEscId = "rev-cont-cleared";
    recordOpenEscalation(f.store, f.engine, f.taskId, revEscId, {
      runId: null,
      payload: { reviewContinuation: "exhausted", reader: reviewer.id },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), []);

    f.store.putRun({ ...reviewer, released: true });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), [revEscId]);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find(
        (e) => e.id === revEscId,
      )?.answered,
      true,
    );
    assert.equal(f.task().resolution.stop, null);

    // 2. Recovery-pending escalation closes when its incident clears.
    const incEscId = "rec-pending-cleared";
    f.store.update(f.taskId, {
      phase: "needs_attention",
      resolution: {
        ...f.task().resolution,
        incident: {
          id: "inc-1",
          role: "reviewer",
          runId: reviewer.id,
          fingerprint: "fp-1",
          attempt: 1,
          cause: "stalled_turn",
          status: "escalated",
          detail: "Escalated",
          action: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    recordOpenEscalation(f.store, f.engine, f.taskId, incEscId, {
      payload: { cause: "recovery-pending" },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), []);

    f.store.update(f.taskId, {
      resolution: { ...f.task().resolution, incident: null },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), [incEscId]);
    assert.equal(
      plannerEscalations(f.store.eventsAll(f.taskId)).find(
        (e) => e.id === incEscId,
      )?.answered,
      true,
    );

    // 3. External-merge unreviewed escalation closes when operator source acceptance arrives.
    const extEscId = "ext-merge-cleared";
    recordOpenEscalation(f.store, f.engine, f.taskId, extEscId, {
      payload: { head: HEAD_B, commit: "c".repeat(40) },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), []);
    f.store.update(f.taskId, {
      resolution: {
        ...f.task().resolution,
        ownerAcceptances: [
          {
            head: HEAD_B,
            prNumber: 42,
            kind: "operator_source",
            at: new Date().toISOString(),
            review: null,
            qualification: "Operator accepted merged head",
            actor: { agentId: OPERATOR_BOARD_CALLER, role: "operator" },
            authority: { kind: "operator", note: null },
            reason: "Operator accepted merged head",
            missingEvidence: null,
          },
        ],
      },
    });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), [extEscId]);

    // 4. General escalation closes when the task ends (merged/done).
    const doneEscId = "done-cleared";
    recordOpenEscalation(f.store, f.engine, f.taskId, doneEscId);
    f.store.update(f.taskId, { phase: "done" });
    assert.deepEqual(closeClearedEscalations(f.store, f.task()), [doneEscId]);
  } finally {
    await f.close();
  }
});

test("deleted restart-as-escalation-answer path: parkedRestart never returns answer", async () => {
  const f = makeFixture();
  try {
    f.store.update(f.taskId, {
      phase: "done",
      resolution: {
        ...f.task().resolution,
        attention: false,
        recovery: {
          id: "rec-1",
          key: "recovery-key-1",
          generation: 1,
          status: "escalated",
          summary: "Escalated",
          incidentId: "inc-1",
          runId: null,
          agentId: null,
          idleSince: null,
          action: null,
        },
      },
    });
    const parked = parkedRestart(collectOwnerVerbFacts(f.store, f.task()));
    assert.ok("refusal" in parked);
    await assert.rejects(
      () =>
        f.engine.performTaskControl(
          taskControlInputSchema.parse({
            taskId: f.taskId,
            version: f.task().version,
            action: "restart",
            reason: "Old restart-as-escalation-answer lever",
          }),
        ),
      /done|Nothing is parked/i,
    );
  } finally {
    await f.close();
  }
});
