import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Engine } from "../core/engine";
import type { Adapter } from "../core/host";
import { Decisions } from "../core/planning/decisions";
import { closeTerminalEscalations } from "../core/questions/escalation-settlement";
import {
  escalationVerbChoices,
  plannerEscalations,
  type EscalationVerbChoice,
} from "../core/questions/ladder";
import { Store } from "../core/store/store";
import { resolveExplicitly } from "../core/verbs/explicit-resolution";
import {
  collectOwnerVerbFacts,
  ownerVerbViews,
  parkedRestart,
} from "../core/verbs/owner-verbs";
import {
  OPERATOR_BOARD_CALLER,
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

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-explicit-batch4-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("hostRegistry", [
    { id: "host-1", kind: "paseo", label: "Host" },
  ]);
  store.upsertProject({
    key: "explicit-batch4",
    name: "Explicit Batch 4",
    repositories: [
      { origin: "https://github.com/example/explicit-batch4.git", path: REPO },
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
  const adapter = {
    hostId: "host-1",
    profiles: async () => [],
    listLiveAgents: async () => [
      { id: PLANNER, title: "Planner", directory: REPO, workspaceId: null },
    ],
    originAgent: async (id: string) => ({
      id,
      title: id,
      workspaceId: null,
      archived: false,
    }),
    observe: async (agentId: string) =>
      agentId === PLANNER
        ? {
            id: PLANNER,
            status: "idle",
            active: false,
            workspaceId: "ws-planner",
            cwd: REPO,
          }
        : (await observeIdle(null)(agentId))!,
    stopAgentTurn: async () => {},
    archiveAgent: async () => {},
    createRun: async () => {
      throw new Error("Unexpected createRun");
    },
    sendRun: async () => {},
    notify: async () => {},
    findAnyOpenBranchPr: async () => [],
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  const taskId = inserted.id;
  return {
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

function makeRun(
  taskId: string,
  overrides: Record<string, unknown> & { id: string },
) {
  const at = new Date(Date.now() - 5_000).toISOString();
  return runSchema.parse({
    taskId,
    role: "revision",
    attempt: 1,
    generation: 1,
    agentId: `agent-${overrides.id}`,
    hostId: "host-1",
    workspaceId: "ws-worker",
    head: HEAD_A,
    base: BASE,
    profile: {
      id: "p-1",
      name: "P",
      provider: "codex",
      model: "gpt-5",
      notes: "",
      available: true,
      problem: "",
      supportedThinking: [],
    },
    status: "running",
    active: true,
    released: false,
    createdAt: at,
    lastObservedAt: at,
    idleSince: null,
    completion: null,
    ...overrides,
  });
}

function recordOpenEscalation(
  store: Store,
  engine: Engine,
  taskId: string,
  id: string,
  options: { runId?: string | null; offered?: EscalationVerbChoice[] } = {},
) {
  const cause = "e".repeat(64);
  store.event(
    taskId,
    "planner_escalation",
    `${id}: cause ${cause}; run ${options.runId ?? "worker"}; question pending`,
  );
  store.event(
    taskId,
    "planner_escalation_payload",
    `${id}: ${JSON.stringify({ cause, runId: options.runId ?? null, question: "How should this stuck task proceed?" })}`,
  );
  engine.resolution.waiting(
    store.task(taskId),
    `Waiting with the planner: blocker escalation ${id} is open`,
    "escalated",
    {
      fact: { code: "escalation", subject: id },
    },
  );
  const offered = options.offered ?? [];
  store.event(
    taskId,
    "planner_escalation_offered",
    `${id}: ${JSON.stringify(offered)}`,
  );
  const questionId = `ns-escalation-${id}`;
  const choices = [
    "Stop and keep the work",
    "Wait until a time (put an ISO timestamp in Reason)",
    ...offered.map((o) => o.label),
  ];
  engine.resolution.openDelegatedQuestion(
    store.task(taskId),
    questionId,
    PLANNER,
    `Choose how to continue\n${choices.map((c) => `- ${c}`).join("\n")}`,
    60_000,
    "planner",
    "host-1",
  );
  return { questionId };
}

test("#1491 shape: first plain-choice answer after PR/run changed installs the wait and target at the current task version", async () => {
  const fx = makeFixture();
  try {
    const runId = "run-worker-1491";
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: runId,
        agentId: "agent-worker-1491",
        active: false,
      }),
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "working",
        runId,
        agentId: "agent-worker-1491",
        prHead: HEAD_A,
        resolution: { ...fx.task().resolution, currentRunId: runId },
      },
      "worker_started",
      "worker run",
    );
    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-1491",
      { runId },
    );
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head changed after offer",
    );

    const targetIso = new Date(Date.now() + 3_600_000).toISOString();
    await fx.engine.resolution.answerDelegatedQuestion(
      {
        questionId,
        choice: "Wait until a time (put an ISO timestamp in Reason)",
        reason: targetIso,
      },
      PLANNER,
    );
    const events = fx.store.eventsAll(fx.taskId);
    assert.equal(
      plannerEscalations(events).find((e) => e.id === "esc-1491")?.answered,
      true,
    );
    const waitEvent = events.findLast(
      (e) =>
        e.kind === "planner_escalation_wait" &&
        e.detail.startsWith("esc-1491:"),
    );
    assert.ok(waitEvent, "planner_escalation_wait must be recorded");
    const wait = JSON.parse(waitEvent.detail.slice("esc-1491: ".length)) as {
      kind: string;
      target: string;
    };
    assert.equal(wait.kind, "time");
    assert.equal(wait.target, targetIso);
    assert.equal(fx.task().resolution.stop?.reason, "lifecycle");
  } finally {
    await fx.close();
  }
});

test("underlay#046 shape: real owner retry guard runs without 'no longer available' or binding-hash loop, and record.clear kind=escalation stays the manual close", async () => {
  const fx = makeFixture();
  try {
    const reviewerRunId = "run-rev-046";
    const deliveryId = `ns-review-${"c".repeat(64)}`;
    const at = new Date().toISOString();
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: reviewerRunId,
        role: "reviewer",
        agentId: "agent-rev-046",
        workspaceId: "ws-rev",
        active: false,
        reviewDeliveries: [
          {
            authorizationId: randomUUID(),
            operationId: randomUUID(),
            deliveryId,
            taskId: fx.taskId,
            runId: reviewerRunId,
            head: HEAD_A,
            checkpointOrdinal: 1,
            taskVersion: fx.task().version,
            briefVersion: 1,
            briefDigest: null,
            reason: "Review head A",
            instruction: "Review head A",
            createdAt: at,
            status: "uncertain",
            evidence: "delivery timed out",
            observedAt: at,
          },
        ],
      }),
    );
    fx.store.update(
      fx.taskId,
      {
        phase: "reviewing",
        prHead: HEAD_A,
        resolution: { ...fx.task().resolution, currentRunId: reviewerRunId },
      },
      "review_started",
      "uncertain reviewer delivery",
    );
    const offered = escalationVerbChoices(
      ownerVerbViews(collectOwnerVerbFacts(fx.store, fx.task())),
    );
    const retryOffer = offered.find((item) => item.verb === "retry_effect");
    assert.ok(retryOffer);
    const { questionId } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-046",
      { runId: reviewerRunId, offered },
    );
    fx.store.update(
      fx.taskId,
      { prHead: HEAD_B },
      "pr_head_updated",
      "head moved",
    );
    try {
      await fx.engine.resolution.answerDelegatedQuestion(
        {
          questionId,
          choice: retryOffer.label,
          reason: "Retry uncertain delivery",
        },
        PLANNER,
      );
    } catch (error) {
      assert.doesNotMatch(
        error instanceof Error ? error.message : String(error),
        /is no longer available|binding/i,
      );
    }

    // Manual close via record.clear kind=escalation remains the explicit close on non-terminal tasks.
    const cleared = await resolveExplicitly(
      fx.engine,
      {
        taskId: fx.taskId,
        version: fx.task().version,
        action: "record.clear",
        kind: "escalation",
        id: "esc-046",
        accept: [],
        reason: "Manual escalation close",
        caller: OPERATOR_BOARD_CALLER,
      },
      () => "next",
    );
    assert.equal(cleared.explicitResolution?.status, "applied");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-046",
      )?.answered,
      true,
    );
    assert.equal(fx.task().resolution.stop, null);
  } finally {
    await fx.close();
  }
});

test("terminal phase (owner complete and late answer on ended task) closes open escalations and linked decisions in one transaction and refuses late answers", async () => {
  const fx = makeFixture();
  try {
    const decisions = new Decisions(fx.store);
    fx.store.putRun(
      makeRun(fx.taskId, {
        id: "run-complete-1",
        status: "finished",
        active: false,
        released: true,
        endedAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    const { questionId: qComplete } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-complete",
    );
    const dComplete = decisions.add({
      headline: "Escalation before owner complete",
      question: "How should esc-complete proceed?",
      choices: [
        { label: "Stop and keep the work", consequence: "Parks task" },
        {
          label: "Return to the worker with a new approach",
          consequence: "Continues worker",
        },
      ],
      askedBy: PLANNER,
      tasks: [fx.taskId],
    });
    fx.store.event(
      fx.taskId,
      "planner_escalation_decision_linked",
      `esc-complete: decision ${dComplete.id}`,
    );

    // Real owner complete closes the open escalation and withdraws its linked decision in one transaction.
    await fx.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: fx.taskId,
        version: fx.task().version,
        action: "complete",
        reason: "Operator completed task",
        caller: OPERATOR_BOARD_CALLER,
      }),
    );
    assert.equal(fx.task().phase, "done");
    assert.equal(fx.store.decision(dComplete.id).status, "withdrawn");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-complete",
      )?.answered,
      true,
    );
    assert.equal(
      fx.store
        .eventsAll(`delegation:${qComplete}`)
        .some((e) => e.kind === "delegated_closed"),
      true,
    );

    // Late plain answer on a newly cancelled task closes escalation + linked decision in one transaction and refuses as closed.
    fx.store.update(
      fx.taskId,
      { phase: "working" },
      "reopen",
      "setup terminal late-answer check",
    );
    const { questionId: qLate } = recordOpenEscalation(
      fx.store,
      fx.engine,
      fx.taskId,
      "esc-terminal",
    );
    const dTerminal = decisions.add({
      headline: "Terminal task decision",
      question: "How should esc-terminal proceed?",
      choices: [
        { label: "Stop and keep the work", consequence: "Parks task" },
        {
          label: "Return to the worker with a new approach",
          consequence: "Continues worker",
        },
      ],
      askedBy: PLANNER,
      tasks: [fx.taskId],
    });
    fx.store.event(
      fx.taskId,
      "planner_escalation_decision_linked",
      `esc-terminal: decision ${dTerminal.id}`,
    );
    fx.store.update(
      fx.taskId,
      { phase: "cancelled" },
      "task_cancelled",
      "task ended before late answer",
    );
    // The terminal transition itself closed the escalation and withdrew its linked decision in the same transaction.
    assert.equal(fx.store.decision(dTerminal.id).status, "withdrawn");
    assert.equal(
      plannerEscalations(fx.store.eventsAll(fx.taskId)).find(
        (e) => e.id === "esc-terminal",
      )?.answered,
      true,
    );
    await assert.rejects(
      async () =>
        await fx.engine.resolution.answerDelegatedQuestion(
          {
            questionId: qLate,
            choice: "Stop and keep the work",
            reason: "Late plain answer on ended task",
          },
          PLANNER,
        ),
      /closed|already settled/i,
    );
    assert.deepEqual(closeTerminalEscalations(fx.store, fx.task()), []);
  } finally {
    await fx.close();
  }
});

test("deleted restart-as-escalation-answer path: parkedRestart never returns answer", () => {
  const fx = makeFixture();
  try {
    recordOpenEscalation(fx.store, fx.engine, fx.taskId, "esc-no-restart");
    const parked = parkedRestart(collectOwnerVerbFacts(fx.store, fx.task()));
    assert.ok(!parked || !("answer" in parked));
  } finally {
    fx.close();
  }
});
