import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { boardDetailReply, boardNext, boardTasks } from "./support/board-tasks";
import { formatAgentId } from "../shared/agent-identity";
import { summarizeTask } from "../shared/task-view";
import {
  detail,
  taskNextSchema,
  taskNextVerbSchema,
  taskSummarySchema,
  type TaskNext,
} from "../shared/contracts";

// Task Overview (UI lane step 3, redesigned in nucleus#1537): what is happening, who acts
// next and the owner verbs that apply; refusals sit with the full verb list in Details. The
// rendered tree is read through the render helper at a narrow and a wide layout.
useNativeStubs();
type QueueModule = typeof import("../client/queue");
let queue: QueueModule;
const load = async () => {
  queue = await import("../client/queue");
  return queue;
};

const h = React.createElement;
/** Dark-theme palette: every themed style resolves to one of these tokens. */
const dark = {
  accent: "#1f6feb",
  accentForeground: "#ffffff",
  surface0: "#0d1117",
  surface1: "#161b22",
  surface2: "#30363d",
  border: "#30363d",
  foreground: "#f0f6fc",
  foregroundMuted: "#8b949e",
  statusWarning: "#f0883e",
  statusDanger: "#f85149",
} as const;
const c = dark as never;
const head = "a".repeat(40),
  at = "2026-10-27T00:00:00.000Z";
const workerProfile = {
  id: "worker",
  name: "Worker",
  provider: "test",
  model: "test/worker",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: [],
};
const repo = { origin: "owner/app", path: "/app" };
const project = {
  key: "app",
  name: "App",
  repositories: [repo],
  primary: repo,
};
const TITLE = "Decide whether the retained reviewer restarts";
const LONG_DETAIL =
  "The operator decides whether the retained reviewer restarts after the stalled turn, and the record keeps the observed evidence for that restart and for every refusal so the decision can be audited later without reading the whole thread again.";

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the surface did not settle");
}

const summaryOf = (overrides: Record<string, unknown>) =>
  taskSummarySchema.parse({
    id: "task",
    title: TITLE,
    repoPath: "/app",
    version: 1,
    number: null,
    reference: null,
    entrypoint: "worker",
    phase: "needs_attention",
    reason: "Waiting for the operator",
    held: false,
    parked: false,
    dependsOn: [],
    queuePriority: 0,
    profile: null,
    prUrl: null,
    resumePrNumber: null,
    completionPrNumber: null,
    originError: "",
    originLookupError: "",
    lanes: [],
    disposition: null,
    resolution: { attention: true, mergedCommit: null },
    ...overrides,
  });
const board = (tasks: ReturnType<typeof summaryOf>[]) => ({
  revision: 1,
  connected: true,
  hostId: "host",
  paused: false,
  error: "",
  quiet: true,
  activeWorkers: 0,
  unsettled: 0,
  occupiedSlots: 0,
  globalLimit: 32,
  projectLimit: 5,
  tasks,
  profiles: [workerProfile],
  pool: [
    {
      profileId: workerProfile.id,
      enabled: true,
      group: "author",
      roles: ["worker"],
      weight: "default",
      scopes: ["general"],
    },
  ],
  availability: [],
  assignments: {},
  recentAssignments: {},
  lanes: [],
  projects: [project],
  prStates: {},
});
const serviceState = {
  state: "running",
  detail: "",
  error: "",
  ready: true,
  paused: false,
  hostId: "host",
};

/** A `task.next` reading for a task waiting on the operator: restart applies, move and route are refused. */
function waitingNext(
  taskId: string,
  overrides: Record<string, unknown> = {},
): TaskNext {
  return taskNextSchema.parse({
    taskId,
    title: TITLE,
    phase: "needs_attention",
    version: 1,
    repository: "owner/app",
    number: null,
    reference: null,
    attention: true,
    reason: "Waiting for the operator",
    activeRun: null,
    prHead: null,
    prUrl: null,
    branch: "ns-task",
    stop: {
      kind: "attention",
      reason: "operator_needed",
      detail: LONG_DETAIL,
      since: at,
      suggestedVerbs: ["restart", "route", "move"],
      owner: "operator",
      evidence: null,
    },
    outcome: {
      accepted: null,
      reported: null,
      impediment: null,
      impediments: [],
      reader: null,
      authorResult: null,
      decision: "Nothing outstanding",
      revision: { runs: 0, budget: 3, exhausted: false },
    },
    holds: {},
    verbs: [
      taskNextVerbSchema.parse({
        verb: "restart",
        action: "restart",
        available: true,
        args: { action: "restart", taskId, version: 1 },
      }),
      taskNextVerbSchema.parse({
        verb: "move",
        action: "move",
        available: false,
        refusal: "Moving to work requires the task author",
      }),
      taskNextVerbSchema.parse({
        verb: "route",
        action: "route",
        available: false,
        refusal: "No eligible worker profile is enabled",
      }),
    ],
    ...overrides,
  }) as TaskNext;
}

function mountBoard(
  invoke: (method: string, input: unknown) => Promise<unknown>,
  compact: boolean,
) {
  const surfaceProps = {
    theme: { colors: c },
    host: { id: "host", label: "Host" },
    layout: { compact, platform: "ios" as const },
  };
  // Queries do not retry, so a failed read settles into its error state at once.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return mount(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );
}

/** A parked task and the queue.detail reply served by the test RPC. */
function setup(readNext: (taskId: string) => Promise<unknown>) {
  const taskId = "task";
  const detailReply = detail.output.parse({
    task: {
      id: taskId,
      hostId: "host",
      createdAt: at,
      updatedAt: at,
      version: 2,
      submissionId: "overview",
      title: TITLE,
      repoPath: "/app",
      planningCommit: head,
      handoffPath: "overview.md",
      originAgentId: "origin",
      phase: "needs_attention",
      reason: "Waiting for the operator",
      held: false,
      handoffText: "handoff",
      planningBase: head,
      workspaceId: null,
      directory: null,
      branch: "ns-task",
      agentId: null,
      runId: null,
      profile: null,
      workspaceIntent: false,
      agentIntent: false,
      lastAgentStatus: null,
      idleSince: null,
      completion: null,
      agentActive: null,
      lastObservedAt: null,
      prUrl: null,
      prHead: null,
      coordinatorGeneration: 1,
    },
    events: [],
    runs: [],
    notices: [],
    dependencies: [],
    hooks: [],
    telemetry: {
      taskId,
      generatedAt: at,
      evidence: "exact",
      totalElapsedMs: 0,
      waitingMs: 0,
      activeMs: 0,
      interventionMs: 0,
      currentStage: "attention",
      currentStageAgeMs: 0,
      closeoutAuthority: "pending",
      stages: [],
      interventions: {
        recoveryRuns: 0,
        recoveries: [],
        uncertainCreations: 0,
        absentCreations: 0,
        attentionNotices: 0,
        escalations: 0,
        hookHolds: 0,
        hookRetries: 0,
        revisions: 0,
        replacements: 0,
        operatorActions: [],
      },
    },
  });
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot")
      return board([
        summaryOf({
          id: taskId,
          phase: "needs_attention",
          parked: true,
          resolution: { attention: true, mergedCommit: null },
        }),
      ]);
    if (method === "queue.service-state") return serviceState;
    if (method === "queue.detail") return detailReply;
    if (method === "task.next") return readNext(taskId);
    if (method === "project.qa.list" || method === "host.run.list") return [];
    if (method === "host.run.board")
      return {
        runs: [],
        accounting: { readAt: at, entries: [], complete: true },
      };
    if (method === "lead.board") return { cards: [], links: [] };
    if (
      method === "queue.plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "decision.list" ||
      method === "project.owner-candidates"
    )
      return [];
    void input;
    return {};
  };
  return invoke;
}

async function openOverview(tree: ReturnType<typeof mountBoard>) {
  await settle(() => tree.text().includes(TITLE));
  tree.press(new RegExp(TITLE));
  await settle(() => Boolean(tree.query(/^What is happening: /)));
}

for (const compact of [false, true]) {
  const layout = compact ? "narrow" : "wide";
  test(`the Overview leads with what is happening, who acts next and the owner verbs that apply at a ${layout} layout`, async () => {
    await load();
    let mounted: ReturnType<typeof mountBoard> | undefined;
    const invoke = setup(async (taskId) => waitingNext(taskId));
    try {
      mounted = mountBoard(invoke, compact);
      await openOverview(mounted);
      // nucleus#1537: the card names the state in words and its headline; the copy comes from the stop reason.
      await settle(() =>
        /^What is happening: Needs you\. /.test(
          String(
            mounted!.query(/^What is happening: /)?.props.accessibilityLabel,
          ),
        ),
      );
      assert.match(mounted.text(), /Next: /);
      // The raw stop detail moves to Details; the Overview carries the plain copy only.
      assert.equal(
        mounted.text().includes(LONG_DETAIL),
        false,
        "the raw stop detail is not on the Overview",
      );
      // Owner verbs that apply are actions; refused ones are never offered as actions.
      assert.ok(mounted.query("restart"), "the available restart is an action");
      assert.equal(
        mounted.all("move").length,
        0,
        "the refused move is not an action",
      );
      assert.equal(
        mounted.all("route").length,
        0,
        "the refused route is not an action",
      );
      // Details keeps every owner verb with its refusal, and the raw stop detail.
      mounted.press("Details");
      await settle(
        () =>
          mounted!.query("Details")?.props.accessibilityState.selected === true,
      );
      assert.ok(
        mounted.query(
          /^move: unavailable, Moving to work requires the task author/,
        ),
        "the full verb reference with refusals is on Details",
      );
      assert.ok(
        mounted.query(
          /^route: unavailable, No eligible worker profile is enabled/,
        ),
        "the refused route names its refusal on Details",
      );
      assert.ok(
        mounted.text().includes(LONG_DETAIL),
        "the raw stop detail is on Details",
      );
    } finally {
      mounted?.update(h("View", null));
    }
  });
}

test("while the owner verbs are being read, the Overview keeps the wait it already knows and says the verbs are loading", async () => {
  await load();
  let mounted: ReturnType<typeof mountBoard> | undefined;
  const invoke = setup(() => new Promise(() => undefined));
  try {
    mounted = mountBoard(invoke, false);
    await openOverview(mounted);
    // The task's stored state stands in for the stop until the read arrives.
    assert.match(
      String(mounted.query(/^What is happening: /)?.props.accessibilityLabel),
      /^What is happening: .+\. .+$/,
      "what is happening is still named while the verbs load",
    );
    assert.ok(
      mounted.query("Reading owner verbs"),
      "the loading state is named",
    );
    assert.ok(mounted.text().includes("Reading owner verbs…"));
    assert.equal(
      mounted.all("Retry reading owner verbs").length,
      0,
      "no retry is offered while the read is in flight",
    );
  } finally {
    mounted?.update(h("View", null));
  }
});

test("a failed read names the failure and retries from the same control", async () => {
  await load();
  let mounted: ReturnType<typeof mountBoard> | undefined;
  let reads = 0;
  let fail = true;
  const invoke = setup(async (taskId) => {
    reads++;
    if (fail) throw new Error("Queue did not answer the owner-verb read");
    return waitingNext(taskId);
  });
  try {
    mounted = mountBoard(invoke, false);
    await openOverview(mounted);
    await settle(() => Boolean(mounted!.query("Retry reading owner verbs")));
    assert.ok(
      mounted.query(
        "Owner verbs could not be read: Queue did not answer the owner-verb read",
      ),
      "the failed operation is named",
    );
    assert.ok(
      mounted.text().includes("Queue did not answer the owner-verb read"),
      "the failure is visible",
    );
    assert.equal(
      mounted.all("restart").length,
      0,
      "no action is offered from a failed read",
    );
    const readsBeforeRetry = reads;
    fail = false;
    mounted.press("Retry reading owner verbs");
    await settle(() => Boolean(mounted!.query("restart")));
    assert.ok(reads > readsBeforeRetry, "the retry reads again");
    assert.equal(mounted.all("Retry reading owner verbs").length, 0);
  } finally {
    mounted?.update(h("View", null));
  }
});


test("task detail submits the host-qualified native question to its web answer connection", async () => {
  await load();
  const { bindWebQuestions, updateWebQuestions } = await import("../client/native-questions");
  const task = boardTasks()("question-task", {
    title: "Question task",
    phase: "needs_attention",
    reason: "Waiting for the operator",
    agentId: "worker",
    workspaceId: "workspace",
  });
  const reply = boardDetailReply(task);
  const surroundingReads = setup(async (taskId) => waitingNext(taskId));
  const agentRef = formatAgentId(task.hostId, "worker");
  const otherAgentRef = formatAgentId("other-host", "worker");
  const sent: Array<[string, string, Record<string, string>]> = [];
  const unbind = bindWebQuestions(async (agent, request, answers) => {
    sent.push([agent, request, answers]);
    updateWebQuestions(agent, []);
  });
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    updateWebQuestions(otherAgentRef, [{
      id: "permission-1",
      questions: [{ header: "Other host", question: "Another worker asked", options: ["Ignore"] }],
    }]);
    updateWebQuestions(agentRef, [{
      id: "permission-1",
      questions: [{
        header: "Approach",
        question: "Which approach should the worker take?",
        options: ["Rewrite the parser", "Patch the parser"],
      }],
    }]);
    const ui = mountBoard(async (method, input) => {
      if (method === "queue.ui-snapshot") return board([summarizeTask(task)]);
      if (method === "queue.detail") return reply;
      if (method === "task.next") return boardNext(reply.task);
      return surroundingReads(method, input);
    }, false);
    mounted = ui;
    await settle(() => ui.text().includes(task.title));
    ui.press(/Question task/);
    await settle(() => ui.text().includes("Waiting for your answer"));
    assert.match(ui.text(), /worker asked/);
    assert.match(ui.text(), /Which approach should the worker take\?/);
    assert.doesNotMatch(ui.text(), /Another worker asked/);
    assert.equal(ui.get("Submit answer").props.accessibilityState.disabled, true);
    ui.press("Details");
    ui.press("Answer Approach: Patch the parser");
    assert.equal(ui.get("Submit answer").props.accessibilityState.disabled, false);
    ui.press("Submit answer");
    await settle(() => !ui.query("Submit answer"));
    assert.deepEqual(sent, [[agentRef, "permission-1", { Approach: "Patch the parser" }]]);
    assert.equal(ui.get("Details").props.accessibilityState.selected, true);
  } finally {
    mounted?.update(h("View", null));
    updateWebQuestions(agentRef, []);
    updateWebQuestions(otherAgentRef, []);
    unbind();
  }
});
