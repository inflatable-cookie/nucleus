import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { Store } from "../core/store/store";
import {
  agentMessageRecordSchema,
  runSchema,
  submissionSchema,
  taskNextSchema,
  taskNextVerbSchema,
  taskStopReasons,
  type AgentMessageRecord,
  type Run,
  type TaskDetail,
  type TaskNext,
  type TaskStopReason,
  type UiQueueState,
} from "../shared/contracts";
import { taskDetailView } from "../shared/task-view";
import type { TaskDrafts } from "../client/task/drafts";
import { hostDisplayLabel } from "../shared/host-outage";
import {
  buildActivityTimeline,
  explicitCommandLabel,
  stopReasonCopy,
  taskHappeningView,
  taskProgressSteps,
  taskReviewFindings,
  taskStatTiles,
} from "../shared/task-detail-view";
import { OPERATOR_BOARD_CALLER } from "../shared/holds";
import {
  CAPACITY_WAIT_PREFIX,
  qaCapacityWaitReason,
} from "../shared/wait-state";
import { capacityReason } from "../core/dispatch/capacity";
import { taskControlInputSchema } from "../shared/schema/task-control";

useNativeStubs();

const h = React.createElement;

const dark = {
  accent: "#7aa2ff",
  accentForeground: "#0d1220",
  surface0: "#111214",
  surface1: "#18191c",
  surface2: "#222327",
  border: "#2c2d32",
  foreground: "#e6e6e8",
  foregroundMuted: "#8e8f96",
  statusSuccess: "#4fbf7f",
  statusWarning: "#e2a93b",
  statusDanger: "#ef6a6a",
} as const;
const c = dark as never;

const HEAD = "a".repeat(40);
const HEAD_2 = "b".repeat(40);
const AT = "2026-11-22T10:50:00.000Z";

let seeded = 0;

function createTaskDetail(
  store: Store,
  overrides: Partial<TaskDetail> = {},
): TaskDetail {
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: `sub-${++seeded}`,
      repoPath: "/repo/app",
      title: "Redesign task detail pane",
      originAgentId: "planner-1",
      planningCommit: HEAD,
      handoffPath: "redesign.md",
    }),
    "host",
    "handoff",
    HEAD,
  );
  const view = taskDetailView(store.task(inserted.id), {}, [], []);
  return { ...view, ...overrides };
}

function makeNext(
  task: TaskDetail,
  overrides: Record<string, unknown> = {},
): TaskNext {
  return taskNextSchema.parse({
    taskId: task.id,
    title: task.title,
    phase: task.phase,
    version: task.version,
    repository: task.repository ?? "owner/app",
    number: task.number,
    reference: task.number ? `app#${task.number}` : null,
    attention: false,
    reason: task.reason,
    activeRun: null,
    prHead: task.prHead,
    prUrl: task.prUrl,
    branch: task.branch,
    stop: null,
    outcome: {
      accepted: null,
      reported: null,
      impediment: null,
      impediments: [],
      reader: null,
      authorResult: null,
      decision: "Nothing outstanding",
      revision: { runs: 0, budget: 6, exhausted: false },
    },
    holds: {},
    verbs: [],
    ...overrides,
  });
}

function makeQueryResult<T>(data: T) {
  return {
    data,
    error: null,
    isFetching: false,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: async () => ({ data }),
  } as never;
}

async function renderDialog(opts: {
  task: TaskDetail;
  next: TaskNext;
  runs?: Run[];
  events?: Array<{
    id: number;
    taskId: string;
    at: string;
    kind: string;
    detail: string;
  }>;
  messages?: AgentMessageRecord[];
  state?: UiQueueState;
  compact?: boolean;
  inline?: boolean;
  /** The board's draft store (a plain record, shared across tasks as on the board). */
  drafts?: TaskDrafts;
  invoke?: (method: string, input: unknown) => Promise<unknown>;
}) {
  const { TaskDialog } = await import("../client/task/task-dialog");
  const { PopoverHost } = await import("../client/popover");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const calls: Array<{ method: string; input: unknown }> = [];
  const invoke = async (method: string, input: unknown) => {
    calls.push({ method, input });
    if (opts.invoke) return opts.invoke(method, input);
    return opts.task;
  };
  const element = (task: TaskDetail, next: TaskNext) => {
    const detailData = {
      task,
      events: opts.events ?? [],
      runs: opts.runs ?? [],
      notices: [],
      dependencies: [],
      hooks: [],
      operations: [],
      messages: opts.messages ?? [],
      telemetry: null,
      missingResult: null,
    };
    return h(
      QueryClientProvider,
      { client: queryClient },
      h(PluginRpcProvider, {
        invoke,
        children: h(
          PopoverHost,
          null,
          h(TaskDialog, {
            task,
            detailQuery: makeQueryResult(detailData),
            nextQuery: makeQueryResult(next),
            state: opts.state,
            decisions: [],
            spansRepositories: false,
            compact: opts.compact ?? false,
            inline: opts.inline ?? true,
            busy: false,
            act: async (fn: () => Promise<unknown>) => {
              await fn();
            },
            drafts,
            navigation: {
              openAgent: () => {},
              openWorkspace: () => {},
            } as never,
            onClose: () => {},
            onSelectTask: () => {},
            c,
          }),
        ),
      }),
    );
  };
  const drafts = opts.drafts ?? ({} as TaskDrafts);
  const tree = mount(element(opts.task, opts.next));
  /** A board poll: the same open dialog re-rendered with newer reads. */
  const rerender = (task: TaskDetail, next: TaskNext) =>
    tree.update(element(task, next));
  return { tree, calls, rerender };
}

test("every stop reason in the vocabulary renders a plain headline and next line with no raw IDs", async () => {
  const store = new Store(":memory:");
  try {
    for (const reason of taskStopReasons) {
      const copy = stopReasonCopy(reason, {
        projectName: "app",
        hostLabel: hostDisplayLabel("host"),
        owner: "operator",
      });
      assert.ok(copy.headline.length > 5, `${reason}: headline present`);
      assert.ok(copy.explanation.length > 10, `${reason}: explanation present`);
      assert.ok(copy.nextLine.length > 5, `${reason}: nextLine present`);

      const task = createTaskDetail(store, { phase: "needs_attention" });
      const rawId = "8b63c554-459d-4c4d-a92f-704ffc548014";
      const next = makeNext(task, {
        attention:
          reason === "operator_needed" ||
          reason === "run_stalled" ||
          reason === "budget",
        stop: {
          kind: "attention",
          reason: reason as TaskStopReason,
          detail: `Raw internal stop ${rawId} sha ${HEAD}`,
          since: AT,
          suggestedVerbs: [],
          owner: "operator",
          evidence: null,
        },
      });

      const happening = taskHappeningView({ task, next, runs: [] });
      assert.equal(
        happening.headline,
        copy.headline,
        `${reason}: derived headline matches`,
      );
      assert.equal(
        happening.nextLine,
        copy.nextLine,
        `${reason}: derived nextLine matches`,
      );
      assert.ok(
        !happening.headline.includes(rawId),
        `${reason}: no UUID in headline`,
      );
      assert.ok(
        !happening.explanation.includes(rawId),
        `${reason}: no UUID in explanation`,
      );
      assert.ok(
        !happening.nextLine.includes(HEAD),
        `${reason}: no SHA in nextLine`,
      );

      // Render the real TaskDialog for a representative set and verify Overview text
      const { tree } = await renderDialog({ task, next });
      const text = tree.text();
      assert.ok(
        text.includes(copy.headline),
        `${reason}: rendered headline in Overview`,
      );
      assert.ok(
        text.includes(copy.nextLine),
        `${reason}: rendered nextLine in Overview`,
      );
      assert.ok(
        !text.includes(rawId),
        `${reason}: raw stop UUID not on Overview`,
      );
      tree.update(h("View", null));
    }
  } finally {
    store.close();
  }
});

test("explicit-command buttons call their commands and handle inline warning acceptance", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, {
      phase: "needs_attention",
      agentId: "thr_worker_1",
    });
    const next = makeNext(task, {
      attention: true,
      stop: {
        kind: "attention",
        reason: "operator_needed",
        detail: "Worker delivery unconfirmed",
        since: AT,
        suggestedVerbs: ["restart"],
        owner: "operator",
        evidence: null,
      },
      explicitCommands: [
        {
          action: "run.start",
          args: {
            action: "run.start",
            taskId: task.id,
            version: task.version,
            role: "worker",
            agent: "retained",
          },
          fill: ["reason"],
          note: "Start a revision run on the retained worker thread.",
        },
        {
          action: "run.release",
          args: {
            action: "run.release",
            taskId: task.id,
            version: task.version,
            run: "run-stuck-1",
          },
          fill: ["reason"],
          note: "Release stalled worker run.",
        },
      ],
      verbs: [
        taskNextVerbSchema.parse({
          verb: "restart",
          action: "restart",
          available: true,
          args: { action: "restart", taskId: task.id, version: task.version },
          fill: ["reason"],
        }),
        taskNextVerbSchema.parse({
          verb: "move",
          action: "move",
          available: false,
          refusal: "No PR yet",
        }),
      ],
    });

    assert.equal(
      explicitCommandLabel(next.explicitCommands![0]!),
      "Start the worker again",
    );
    assert.equal(
      explicitCommandLabel(next.explicitCommands![1]!),
      "Release the stuck run",
    );

    let attempt = 0;
    const { tree, calls } = await renderDialog({
      task,
      next,
      invoke: async (method, input) => {
        if (method === "queue.task") {
          attempt += 1;
          const payload = input as { accept?: string[] };
          if (attempt === 1) {
            return {
              ...task,
              explicitResolution: {
                status: "warnings",
                warnings: [
                  {
                    id: "live_turn",
                    text: "The worker thread may still have an active turn.",
                  },
                ],
                next: "Pass accept: ['live_turn'] to proceed.",
              },
            };
          }
          assert.deepEqual(payload.accept, ["live_turn"]);
          return {
            ...task,
            explicitResolution: {
              status: "applied",
              warnings: [],
              next: "Started retained worker run.",
            },
          };
        }
        return task;
      },
    });

    // Overview does not show refused owner verbs
    assert.ok(!tree.text().includes("No PR yet"));
    // Click primary explicit command button
    tree.press("Start the worker again");
    tree.type("Reason (required)", "Confirming worker restart");
    tree.press("Confirm Start the worker again");

    // Wait a tick for async RPC resolution
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      tree.text().includes("The worker thread may still have an active turn."),
      "warning text renders inline",
    );
    assert.ok(
      tree.query("Accept warnings and retry"),
      "Accept and retry button renders inline",
    );

    // Click Accept and retry
    tree.press("Accept warnings and retry");
    await new Promise((r) => setTimeout(r, 20));

    const taskControlCalls = calls.filter(
      (call) => call.method === "queue.task",
    );
    assert.equal(taskControlCalls.length, 2);
    assert.deepEqual(
      (taskControlCalls[0]!.input as { accept: string[] }).accept,
      [],
    );
    assert.deepEqual(
      (taskControlCalls[1]!.input as { accept: string[] }).accept,
      ["live_turn"],
    );
    assert.ok(tree.text().includes("Started retained worker run."));

    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("progress strip reflects every phase and renders across wide, modal and narrow layouts", async () => {
  const store = new Store(":memory:");
  try {
    const cases: Array<{
      phase: TaskDetail["phase"];
      expectedStates: Array<"done" | "current" | "todo">;
      prUrl?: string | null;
      prHead?: string | null;
      runs?: Run[];
    }> = [
      {
        phase: "queued",
        expectedStates: ["current", "todo", "todo", "todo", "todo"],
      },
      {
        phase: "working",
        expectedStates: ["done", "current", "todo", "todo", "todo"],
      },
      {
        phase: "reviewing",
        expectedStates: ["done", "done", "current", "todo", "todo"],
        prUrl: "https://github.com/owner/app/pull/42",
        prHead: HEAD_2,
        runs: [
          runSchema.parse({
            id: "rev-1",
            taskId: "t",
            role: "reviewer",
            generation: 1,
            head: HEAD,
            base: HEAD,
            agentId: "rev-agent",
            workspaceId: "wks-1",
            profile: {
              id: "p-rev",
              name: "Sol heavyweight",
              provider: "test",
              model: "gpt-6.2-sol",
              notes: "",
              available: true,
              problem: "",
              supportedThinking: [],
            },
            status: "finished",
            createdAt: AT,
            lastObservedAt: AT,
            active: false,
            idleSince: null,
            released: true,
            completion: {
              eventId: "ev-rev",
              taskId: "t",
              runId: "rev-1",
              status: "changes_required",
              summary: "One P1 finding in docs.",
              reviewText:
                "- [P1] Docs contradicted each other on steer behaviour.",
            },
          }),
        ],
      },
      {
        phase: "merging",
        expectedStates: ["done", "done", "done", "current", "todo"],
      },
      {
        phase: "closing",
        expectedStates: ["done", "done", "done", "done", "current"],
      },
      {
        phase: "done",
        expectedStates: ["done", "done", "done", "done", "done"],
      },
    ];

    const layouts = [
      { inline: true, compact: false },
      { inline: false, compact: false },
      { inline: false, compact: true },
    ];

    for (const item of cases) {
      const task = createTaskDetail(store, {
        phase: item.phase,
        prUrl: item.prUrl ?? null,
        prHead: item.prHead ?? null,
      });
      const next = makeNext(task);
      // Stored runs belong to the task they are read with.
      const runs = (item.runs ?? []).map((run) => ({
        ...run,
        taskId: task.id,
        completion: run.completion
          ? { ...run.completion, taskId: task.id }
          : null,
      }));
      const steps = taskProgressSteps({ task, next, runs });
      assert.deepEqual(
        steps.map((s) => s.state),
        item.expectedStates,
        `phase ${item.phase} progress strip states`,
      );

      for (const layout of layouts) {
        const { tree } = await renderDialog({
          task,
          next,
          runs,
          inline: layout.inline,
          compact: layout.compact,
        });
        const text = tree.text();
        assert.ok(
          text.includes("Queued"),
          `${item.phase}: Queued step rendered`,
        );
        assert.ok(
          text.includes("Working"),
          `${item.phase}: Working step rendered`,
        );
        assert.ok(
          text.includes("Review"),
          `${item.phase}: Review step rendered`,
        );
        assert.ok(text.includes("Merge"), `${item.phase}: Merge step rendered`);
        assert.ok(text.includes("Close"), `${item.phase}: Close step rendered`);
        if (item.phase === "reviewing") {
          assert.ok(
            text.includes("Docs contradicted each other on steer behaviour."),
            "review finding rendered",
          );
          // The report is shown as written, with the fact that its head is not the PR head.
          assert.ok(
            text.includes(
              `Not the current head (reviewed ${HEAD.slice(0, 7)})`,
            ),
            "a report from an earlier head says so",
          );
          assert.ok(
            !text.includes("Fixed in"),
            "no fix is claimed from a push",
          );
        }
        tree.update(h("View", null));
      }
    }
  } finally {
    store.close();
  }
});

test("Activity groups consecutive repeats, folds messages, hides bookkeeping behind Show raw events", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working" });
    const next = makeNext(task);
    const events = [
      {
        id: 1,
        taskId: task.id,
        at: "2026-11-22T10:00:00.000Z",
        kind: "admitted",
        detail: "Got a project slot.",
      },
      {
        id: 2,
        taskId: task.id,
        at: "2026-11-22T10:01:00.000Z",
        kind: "run_usage_unavailable",
        detail: "usage missing",
      },
      {
        id: 3,
        taskId: task.id,
        at: "2026-11-22T10:02:00.000Z",
        kind: "prompt_size",
        detail: "12400 bytes",
      },
      {
        id: 4,
        taskId: task.id,
        at: "2026-11-22T10:03:00.000Z",
        kind: "creation_attempt_reserved",
        detail: "reserved",
      },
      {
        id: 5,
        taskId: task.id,
        at: "2026-11-22T10:04:00.000Z",
        kind: "callback_reminder",
        detail: "Reminder 1",
      },
      {
        id: 6,
        taskId: task.id,
        at: "2026-11-22T10:05:00.000Z",
        kind: "callback_reminder",
        detail: "Reminder 2",
      },
      {
        id: 7,
        taskId: task.id,
        at: "2026-11-22T10:06:00.000Z",
        kind: "callback_reminder",
        detail: "Reminder 3",
      },
      {
        id: 8,
        taskId: task.id,
        at: "2026-11-22T10:07:00.000Z",
        kind: "callback_reminder",
        detail: "Reminder 4",
      },
    ];
    const messages = [
      agentMessageRecordSchema.parse({
        id: "msg-1",
        contentKey: "content-msg-1",
        textDigest: "digest-msg-1",
        fromTaskId: task.id,
        fromRole: "worker",
        fromReference: "app#1",
        toTaskId: "other-task",
        toRole: "reviewer",
        toReference: "app#2",
        text: "Pushed the fix for round 2.",
        status: "delivered",
        createdAt: "2026-11-22T10:04:30.000Z",
        deliveredAt: "2026-11-22T10:04:31.000Z",
        error: "",
      }),
    ];

    const timeline = buildActivityTimeline({
      events,
      messages,
      taskId: task.id,
    });
    assert.equal(timeline.rawCount, 8);
    // Reminder 1 sits alone before the message; reminders 2-4 are adjacent and group.
    assert.deepEqual(
      timeline.items.map((item) => [item.source, item.count]),
      [
        ["event", 3],
        ["message", 1],
        ["event", 1],
        ["event", 1],
      ],
      "bookkeeping hidden; adjacent repeats grouped; the message keeps the earlier reminder separate",
    );

    const { tree } = await renderDialog({ task, next, events, messages });
    tree.press("Activity");
    const collapsedText = tree.text();
    assert.ok(
      collapsedText.includes("Pushed the fix for round 2."),
      "message folded into Activity",
    );
    assert.ok(
      !collapsedText.includes("12400 bytes"),
      "bookkeeping hidden by default",
    );
    assert.ok(
      collapsedText.includes("Show raw events (8)"),
      "raw toggle shows total recorded count",
    );
    assert.ok(
      collapsedText.includes("×3"),
      "the grouped repeat shows its count",
    );
    assert.ok(
      tree.query(/\(3 times\)/),
      "the grouped repeat names its count for a screen reader",
    );

    // Expand raw events
    tree.press(/Show raw events \(8\)/);
    const expandedText = tree.text();
    assert.ok(
      expandedText.includes("12400 bytes"),
      "raw bookkeeping visible after toggle",
    );

    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("the ⋯ menu holds every editing action and submits them", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "queued" });
    const next = makeNext(task, {
      verbs: [
        taskNextVerbSchema.parse({
          verb: "set_dependencies",
          action: "set_dependencies",
          available: true,
          args: { taskId: task.id, version: task.version },
          fill: ["dependsOn"],
        }),
      ],
    });
    const { tree, calls } = await renderDialog({ task, next });

    // Open ⋯ menu
    tree.press("Task actions menu");
    const menuText = tree.text();
    assert.ok(menuText.includes("Amend brief"));
    assert.ok(menuText.includes("Hold task"));
    assert.ok(menuText.includes("Promote in project"));
    assert.ok(menuText.includes("Change routing & profiles"));
    assert.ok(menuText.includes("Set dependencies"));
    assert.ok(menuText.includes("Cancel task"));

    // Trigger Promote directly from ⋯ menu
    tree.press("Promote in project");
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      calls.some(
        (call) =>
          call.method === "queue.task" &&
          (call.input as { action: string }).action === "promote",
      ),
      "Promote action called queue.task",
    );

    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("fact and owner variants read independently written copy", () => {
  const store = new Store(":memory:");
  try {
    const slotWait = {
      state: "waiting_capacity",
      owner: "operator",
      nextAction:
        "Free a task slot or raise the limit; Nucleus dispatches when capacity allows",
    } as const;
    // The admission check's own reasons, built from the sentences core writes.
    const waiting = (reason: string, owner = "operator") =>
      createTaskDetail(store, {
        phase: "queued",
        reason,
        waitState: { ...slotWait, owner },
      });
    const view = (task: TaskDetail) =>
      taskHappeningView({ task, next: null, runs: [] });

    // The machine-wide QA scheduler owns a QA wait, with its queue position.
    const qaTask = waiting(qaCapacityWaitReason(3), "Queue QA scheduler");
    const qa = view(qaTask);
    assert.equal(qa.headline, "Waiting for a QA validation slot");
    assert.equal(
      qa.explanation,
      "The machine-wide validation scheduler is full; this task is number 3 in its queue.",
    );
    assert.deepEqual(
      taskStatTiles({ task: qaTask, next: null, runs: [] }).slice(1, 3),
      [
        { label: "Waiting on", value: "QA slot" },
        { label: "QA position", value: "3" },
      ],
    );

    // The project's own pool (an override of 2), both slots taken.
    const project = view(
      waiting(
        `${CAPACITY_WAIT_PREFIX} ${capacityReason("project")} (2/2 occupied: #001, #002)`,
      ),
    );
    assert.equal(project.headline, "Waiting for a slot in app");
    assert.equal(
      project.explanation,
      "This repository’s task slots are all taken (2 of 2 in use).",
    );
    assert.equal(
      project.nextLine,
      "Nucleus starts it automatically when a slot frees. You can raise this project’s limit in Settings → Limits.",
    );

    // A papercut waits on the papercut pool even when the project has room.
    const papercut = view(
      waiting(
        `${CAPACITY_WAIT_PREFIX} ${capacityReason("papercut")} (1/1 occupied: #004)`,
      ),
    );
    assert.equal(papercut.headline, "Waiting for a papercut slot");
    assert.equal(
      papercut.explanation,
      "Papercuts in app share their own small pool, and it is full (1 of 1 in use).",
    );

    // The global cap is the machine-wide limit, never the project's.
    const global = view(
      waiting(
        `${CAPACITY_WAIT_PREFIX} ${capacityReason("global")} (4/4 occupied: #001, #002, #003, #004)`,
      ),
    );
    assert.equal(global.headline, "Waiting for a machine-wide task slot");
    assert.equal(
      global.explanation,
      "Every task slot across Nucleus is in use (4 of 4 in use).",
    );

    // The project's in-flight workspace cap is its own limit.
    const inFlight = view(
      waiting("Waiting: 3 of 3 tasks in flight for this project"),
    );
    assert.equal(
      inFlight.headline,
      "Waiting for in-flight work in app to finish",
    );
    assert.equal(
      inFlight.explanation,
      "3 of 3 tasks are in flight for this project, its in-flight cap.",
    );

    // Earlier reservations supply a dispatch position; a plain slot wait supplies none.
    const reservedTask = waiting(
      `${CAPACITY_WAIT_PREFIX} Waiting behind 2 earlier queued reservations (3/4 global slots occupied)`,
    );
    assert.equal(
      view(reservedTask).headline,
      "Waiting behind earlier queued tasks",
    );
    assert.deepEqual(
      taskStatTiles({ task: reservedTask, next: null, runs: [] })[2],
      { label: "Ahead in queue", value: "2" },
    );
    assert.equal(
      taskStatTiles({
        task: waiting(
          `${CAPACITY_WAIT_PREFIX} ${capacityReason("project")} (2/2 occupied)`,
        ),
        next: null,
        runs: [],
      }).some((tile) => tile.label === "Ahead in queue"),
      false,
      "no queue position is invented from the display list",
    );

    // A typed fact picks its own copy: the integration turn is not a generic lifecycle stop.
    const integration = taskHappeningView({
      task: createTaskDetail(store, {
        phase: "verifying",
        reasonFact: { code: "integration_turn" },
      }),
      next: makeNext(createTaskDetail(store), {
        stop: {
          kind: "wait",
          reason: "lifecycle",
          detail: "Integration turn held by app#4",
          since: AT,
          suggestedVerbs: [],
          owner: "Queue",
          evidence: null,
        },
      }),
      runs: [],
    });
    assert.equal(
      integration.headline,
      "Waiting for the repository integration turn",
    );
    assert.equal(
      integration.nextLine,
      "Nucleus gives this task the integration turn automatically when the current merge finishes.",
    );
  } finally {
    store.close();
  }
});

test("the ⋯ menu opens inside the modal and its actions submit there", async () => {
  const store = new Store(":memory:");
  try {
    for (const compact of [false, true]) {
      const task = createTaskDetail(store, { phase: "queued" });
      const next = makeNext(task);
      const { tree, calls } = await renderDialog({
        task,
        next,
        inline: false,
        compact,
      });
      tree.press("Task actions menu");
      // The board's own popover layer sits outside the modal's presentation layer:
      // the menu must render in a layer the modal itself mounts.
      const [modal] = tree.ofType("Modal");
      assert.ok(modal, "the detail is a modal at this layout");
      const within = (node: HostNode | string, label: string): boolean =>
        typeof node !== "string" &&
        (node.props.accessibilityLabel === label ||
          node.children.some((child) => within(child, label)));
      assert.ok(
        within(modal!, "Hold task"),
        "the menu renders inside the modal",
      );
      tree.press("Hold task");
      tree.type("Hold reason (required)", "Waiting for the design review");
      tree.press("Confirm hold task");
      await new Promise((r) => setTimeout(r, 10));
      const hold = calls.find(
        (call) =>
          call.method === "queue.task" &&
          (call.input as { action: string }).action === "hold",
      );
      assert.ok(
        hold,
        `the hold submits from the modal (${compact ? "narrow" : "medium"})`,
      );
      assert.equal(
        (hold!.input as { reason?: string }).reason,
        "Waiting for the design review",
      );
      tree.update(h("View", null));
    }
  } finally {
    store.close();
  }
});

test("Extend budget appears only for an exhausted budget and submits as the operator at the board", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working" });
    // Not exhausted: `next` refuses the verb, so the menu does not offer it.
    const unspent = makeNext(task, {
      verbs: [
        taskNextVerbSchema.parse({
          verb: "extend_budget",
          action: "extend_budget",
          available: false,
          refusal: "The task budget is not exhausted",
        }),
      ],
    });
    {
      const { tree } = await renderDialog({ task, next: unspent });
      tree.press("Task actions menu");
      assert.equal(
        tree.query("Extend budget"),
        undefined,
        "no extension for an unspent budget",
      );
      tree.update(h("View", null));
    }
    // Exhausted: the available verb is offered and its payload carries the board caller.
    const exhausted = makeNext(task, {
      verbs: [
        taskNextVerbSchema.parse({
          verb: "extend_budget",
          action: "extend_budget",
          available: true,
          args: { taskId: task.id, version: task.version },
          fill: ["reason"],
        }),
      ],
    });
    const { tree, calls } = await renderDialog({ task, next: exhausted });
    tree.press("Task actions menu");
    tree.press("Extend budget");
    tree.type("Reason (required)", "Large UI redesign needs extra time");
    tree.press("Confirm extend budget");
    await new Promise((r) => setTimeout(r, 10));
    const call = calls.find(
      (item) =>
        item.method === "queue.task" &&
        (item.input as { action: string }).action === "extend_budget",
    );
    assert.ok(call, "the extension submits");
    // The boundary the budget handler checks: a valid control input from the board caller.
    const input = taskControlInputSchema.parse(call!.input);
    assert.equal(input.caller, OPERATOR_BOARD_CALLER);
    assert.equal(
      (input as { reason?: string }).reason,
      "Large UI redesign needs extra time",
    );
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("a started, held task finds its route and hold verbs in the ⋯ menu, not the Overview", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, {
      phase: "working",
      agentId: "thr_worker_1",
    });
    const next = makeNext(task, {
      verbs: [
        taskNextVerbSchema.parse({
          verb: "route",
          action: "route",
          available: true,
          args: {
            action: "route",
            taskId: task.id,
            version: task.version,
            role: "reviewer",
          },
          fill: ["profileId", "reason"],
        }),
        taskNextVerbSchema.parse({
          verb: "keep_hold",
          action: "keep_hold",
          available: true,
          args: {
            action: "keep_hold",
            taskId: task.id,
            version: task.version,
            kind: "merge",
          },
          fill: ["reason"],
        }),
        taskNextVerbSchema.parse({
          verb: "restart",
          action: "restart",
          available: true,
          args: { action: "restart", taskId: task.id, version: task.version },
          fill: ["reason"],
        }),
      ],
    });
    const { tree, calls } = await renderDialog({ task, next });
    // The Overview card keeps only non-editing actions.
    assert.ok(tree.query("restart"), "restart stays on the Overview");
    assert.equal(
      tree.query("route reviewer"),
      undefined,
      "route is not an Overview action",
    );
    assert.equal(
      tree.query("keep merge hold"),
      undefined,
      "keep hold is not an Overview action",
    );

    tree.press("Task actions menu");
    assert.ok(tree.query("Route reviewer"), "route reviewer is in the menu");
    assert.ok(tree.query("Keep merge hold"), "keep merge hold is in the menu");
    tree.press("Keep merge hold");
    assert.equal(
      tree.query("Confirm keep hold")?.props.accessibilityState?.disabled,
      true,
      "the confirmation waits for its required reason",
    );
    tree.type("Reason (required)", "External receipt still pending");
    tree.press("Confirm keep hold");
    await new Promise((r) => setTimeout(r, 10));
    const call = calls.find(
      (item) =>
        item.method === "queue.task" &&
        (item.input as { action: string }).action === "keep_hold",
    );
    assert.ok(call, "keep hold submits from the menu");
    const input = taskControlInputSchema.parse(call!.input);
    assert.equal(input.caller, OPERATOR_BOARD_CALLER);
    assert.equal((input as { kind?: string }).kind, "merge");
    assert.equal(
      (input as { reason?: string }).reason,
      "External receipt still pending",
    );
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("Activity summarizes structured payloads and leaves raw identifiers to the raw list", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working" });
    const runId = "8b63c554-459d-4c4d-a92f-704ffc548014";
    // The payload `owner_control` writes (core/verbs/owner-verbs.ts).
    const ownerControl = JSON.stringify({
      verb: "restart",
      caller: "operator (board)",
      phaseBefore: "needs_attention",
      phaseAfter: "working",
      identities: { taskId: task.id, runId, version: task.version },
      reason: "Worker stalled after the push",
    });
    const events = [
      {
        id: 1,
        taskId: task.id,
        at: "2026-11-22T10:00:00.000Z",
        kind: "owner_control",
        detail: ownerControl,
      },
      {
        id: 2,
        taskId: task.id,
        at: "2026-11-22T10:05:00.000Z",
        kind: "review_result_applied",
        detail: runId,
      },
    ];
    assert.equal(
      buildActivityTimeline({
        events,
        messages: [],
        taskId: task.id,
      }).items.find((item) => item.kind === "owner_control")?.detail,
      "restart by the operator at the board · needs attention → working · Worker stalled after the push",
    );
    const { tree } = await renderDialog({ task, next: makeNext(task), events });
    tree.press("Activity");
    const text = tree.text();
    assert.ok(
      text.includes("Worker stalled after the push"),
      "the reason is readable",
    );
    assert.ok(!text.includes("{"), "no JSON in the default timeline");
    assert.ok(!text.includes(runId), "no raw run ID in the default timeline");
    tree.press(/Show raw events \(2\)/);
    assert.ok(
      tree.text().includes(runId),
      "the raw list keeps the full record",
    );
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

/** A stored reviewer run with one completion report, as `queue.detail` returns it. */
function reviewerRun(
  taskId: string,
  opts: {
    id?: string;
    eventId: string;
    head: string;
    status: "changes_required" | "ready_to_merge" | "blocked";
    summary: string;
    reviewText?: string;
    verdicts?: unknown[];
    at?: string;
  },
) {
  const id = opts.id ?? "rev-1";
  return runSchema.parse({
    id,
    taskId,
    role: "reviewer",
    generation: 1,
    head: opts.head,
    base: HEAD,
    agentId: `${id}-agent`,
    workspaceId: "wks-1",
    profile: null,
    status: "finished",
    createdAt: opts.at ?? AT,
    lastObservedAt: opts.at ?? AT,
    active: false,
    idleSince: null,
    released: true,
    completion: {
      eventId: opts.eventId,
      taskId,
      runId: id,
      status: opts.status,
      summary: opts.summary,
      ...(opts.reviewText ? { reviewText: opts.reviewText } : {}),
      ...(opts.verdicts ? { verdicts: opts.verdicts } : {}),
    },
  });
}

function acceptedOutcome(accepted: Record<string, unknown>) {
  return {
    accepted: {
      status: "ready_to_merge",
      head: HEAD,
      currentHead: true,
      superseded: false,
      runId: "rev-1",
      eventId: "ev-1",
      reviewerAgentId: "rev-1-agent",
      reviewId: null,
      published: true,
      summary: "Approved.",
      ...accepted,
    },
    reported: null,
    impediment: null,
    impediments: [],
    reader: null,
    authorResult: null,
    decision: "Nothing outstanding",
    revision: { runs: 1, budget: 6, exhausted: false },
  };
}

test("the Review card reads its report by task, run and completion event", () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "verifying", prHead: HEAD });
    // The retained reviewer filed a blocked report, then a new approval on the same run.
    const blocked = reviewerRun(task.id, {
      eventId: "ev-blocked",
      head: HEAD,
      status: "blocked",
      summary: "Could not read the diff.",
      reviewText: "- [P1] Diff unreadable.",
    });
    // `task.next` already has the approval while `queue.detail` still holds the blocked report.
    const next = makeNext(task, {
      outcome: acceptedOutcome({
        eventId: "ev-approved",
        summary: "Approved at the current head.",
      }),
    });
    const catchingUp = taskReviewFindings(task, next, [blocked]);
    assert.equal(
      catchingUp?.summary,
      "Approved at the current head.",
      "the outcome's own summary stands in while the reads catch up",
    );
    assert.deepEqual(
      catchingUp?.items,
      [
        {
          id: "summary-finding",
          severity: "OK",
          text: "Approved",
          status: `Approved · At ${HEAD.slice(0, 7)}`,
        },
      ],
      "the blocked findings never show under the approval",
    );

    // Once the detail read carries the same event, the report's own text shows.
    const approved = reviewerRun(task.id, {
      eventId: "ev-approved",
      head: HEAD,
      status: "ready_to_merge",
      summary: "Approved.",
      reviewText: "Approved.\n- [P3] Rename the helper later.",
    });
    assert.deepEqual(
      taskReviewFindings(task, next, [approved])?.items.map((item) => [
        item.severity,
        item.text,
      ]),
      [["P3", "Rename the helper later."]],
    );
  } finally {
    store.close();
  }
});

test("superseded and not-the-current-head are separate facts", () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working", prHead: HEAD });
    const run = reviewerRun(task.id, {
      eventId: "ev-1",
      head: HEAD,
      status: "changes_required",
      summary: "One finding.",
      reviewText: "- [P2] Copy names the wrong limit.",
    });
    // Same head, superseded: superseded, never "not the current head".
    const sameHead = taskReviewFindings(
      task,
      makeNext(task, {
        outcome: acceptedOutcome({
          status: "changes_required",
          superseded: true,
        }),
      }),
      [run],
    );
    assert.equal(
      sameHead?.items[0]?.status,
      `At ${HEAD.slice(0, 7)} · Superseded`,
    );
    assert.equal(
      sameHead?.roundLabel,
      "Round 1 · changes requested · superseded",
    );
    // A different head, not superseded: only "not the current head".
    const moved = { ...task, prHead: HEAD_2 };
    const differentHead = taskReviewFindings(
      moved,
      makeNext(moved, {
        outcome: acceptedOutcome({
          status: "changes_required",
          currentHead: false,
        }),
      }),
      [run],
    );
    assert.equal(
      differentHead?.items[0]?.status,
      `Not the current head (reviewed ${HEAD.slice(0, 7)})`,
    );
  } finally {
    store.close();
  }
});

test("the Review card shows the selected report's findings and verdicts as written", () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working", prHead: HEAD });
    const run = reviewerRun(task.id, {
      eventId: "ev-1",
      head: HEAD,
      status: "changes_required",
      summary: "Two findings.",
      reviewText:
        "- [P2] Capacity copy names the wrong limit.\n- [P3] Spacing in the header.",
      verdicts: [
        {
          id: "capacity",
          subject: "capacity copy",
          verdict: "fail",
          evidence: "Project limit named for a global wait.",
        },
        {
          id: "menu",
          subject: "Modal menu",
          verdict: "pass",
          evidence: "Menu renders in the modal.",
        },
      ],
    });
    const findings = taskReviewFindings(
      task,
      makeNext(task, {
        outcome: acceptedOutcome({ status: "changes_required" }),
      }),
      [run],
    );
    const at = `At ${HEAD.slice(0, 7)}`;
    assert.deepEqual(
      findings?.items.map((item) => [item.severity, item.text, item.status]),
      [
        ["P2", "Capacity copy names the wrong limit.", at],
        ["P3", "Spacing in the header.", at],
        ["Fail", "capacity copy: Project limit named for a global wait.", at],
        ["Pass", "Modal menu: Menu renders in the modal.", at],
      ],
      "no cross-matching, no fixed marks, every verdict keeps its evidence",
    );
    assert.ok(
      !findings?.items.some((item) => /fixed|resolved/i.test(item.status)),
    );
  } finally {
    store.close();
  }
});

test("an empty papercut pool held for an earlier request names the reservation", () => {
  const store = new Store(":memory:");
  try {
    // The reason `core/dispatch/capacity.ts` writes when an earlier request reserved the only papercut slot.
    const reason = `${CAPACITY_WAIT_PREFIX} ${capacityReason("papercut")} (0/1 occupied, 1 reserved by earlier requests)`;
    const task = createTaskDetail(store, {
      phase: "queued",
      reason,
      waitState: {
        state: "waiting_capacity",
        owner: "operator",
        nextAction:
          "Free a task slot or raise the limit; Nucleus dispatches when capacity allows",
      },
    });
    const view = taskHappeningView({ task, next: null, runs: [] });
    assert.equal(view.headline, "Waiting for a papercut slot");
    assert.equal(
      view.explanation,
      "Papercuts in app share their own small pool: 0 of 1 in use, 1 slot held for earlier requests.",
    );
    assert.equal(
      view.nextLine,
      "The earlier request has the first claim on the slot. Nucleus starts this papercut when a slot is free for it.",
    );
  } finally {
    store.close();
  }
});

test("Activity summarizes identity-only events by kind and keeps a bracketed note as written", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working" });
    // What the worker launcher and the note action store (synthetic identities).
    const agentId =
      "thread:delegated-task:ns-agent-0b2a69ba-1111-4222-8333-444455556666";
    const events = [
      {
        id: 1,
        taskId: task.id,
        at: "2026-11-22T10:00:00.000Z",
        kind: "agent_created",
        detail: agentId,
      },
      {
        id: 2,
        taskId: task.id,
        at: "2026-11-22T10:05:00.000Z",
        kind: "coordination_note",
        detail: "[QA] waiting for the receipt",
      },
    ];
    const items = buildActivityTimeline({
      events,
      messages: [],
      taskId: task.id,
    }).items;
    assert.equal(
      items.find((item) => item.kind === "agent_created")?.detail,
      "A new agent thread started for this task.",
    );
    assert.equal(
      items.find((item) => item.kind === "coordination_note")?.detail,
      "[QA] waiting for the receipt",
    );
    const { tree } = await renderDialog({ task, next: makeNext(task), events });
    tree.press("Activity");
    const text = tree.text();
    assert.ok(
      !text.includes("ns-agent"),
      "no host identity in the default timeline",
    );
    assert.ok(
      text.includes("[QA] waiting for the receipt"),
      "the note shows as written",
    );
    tree.press(/Show raw events \(2\)/);
    assert.ok(
      tree.text().includes(agentId),
      "the raw list keeps the original record",
    );
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("the dependency editor shows the selected task's own list and never another task's draft", async () => {
  const store = new Store(":memory:");
  try {
    // One draft store for the board, shared across the tasks the operator opens.
    const drafts = {} as TaskDrafts;
    const dependencyVerb = (task: TaskDetail) =>
      taskNextVerbSchema.parse({
        verb: "set_dependencies",
        action: "set_dependencies",
        available: true,
        args: { taskId: task.id, version: task.version },
        fill: ["dependsOn"],
      });
    const field =
      "Prerequisites (comma-separated task IDs or references; leave empty to clear)";
    const taskA = createTaskDetail(store, {
      phase: "queued",
      dependsOn: ["app#11"],
    });
    const taskB = createTaskDetail(store, {
      phase: "queued",
      dependsOn: ["app#22", "app#23"],
    });

    // Task A: start an edit and leave it unsaved.
    const a = await renderDialog({
      task: taskA,
      next: makeNext(taskA, { verbs: [dependencyVerb(taskA)] }),
      drafts,
    });
    a.tree.press("Task actions menu");
    a.tree.press("Set dependencies");
    a.tree.type(field, "app#99");
    a.tree.update(h("View", null));

    // Task B opens with its own stored list, and the untouched form cannot submit.
    const b = await renderDialog({
      task: taskB,
      next: makeNext(taskB, { verbs: [dependencyVerb(taskB)] }),
      drafts,
    });
    b.tree.press("Task actions menu");
    b.tree.press("Set dependencies");
    assert.equal(
      b.tree.get(field).props.value,
      "app#22, app#23",
      "B's own prerequisites",
    );
    assert.equal(
      b.tree.get("Save dependencies").props.accessibilityState?.disabled,
      true,
      "an untouched form never submits",
    );
    // A change enables Save, and the submission is B's.
    b.tree.type(field, "app#22");
    b.tree.press("Save dependencies");
    await new Promise((r) => setTimeout(r, 10));
    const call = b.calls.find(
      (item) =>
        item.method === "queue.task" &&
        (item.input as { action: string }).action === "set_dependencies",
    );
    assert.deepEqual(
      [
        (call?.input as { taskId: string }).taskId,
        (call?.input as { dependsOn: string[] }).dependsOn,
      ],
      [taskB.id, ["app#22"]],
    );
    b.tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("the Review card shows the report's own summary and judges the head only by comparing heads", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working", prHead: HEAD_2 });
    const run = reviewerRun(task.id, {
      eventId: "ev-1",
      head: HEAD,
      status: "changes_required",
      summary: "Two issues block the merge.",
      reviewText:
        "Two issues block the merge.\n- [P1] The menu is hidden in the modal.",
    });
    // A stale `next` read still says the verdict is at the current head and not superseded;
    // the report's own head differs from the PR head, so it is not the current head.
    const next = makeNext(task, {
      outcome: acceptedOutcome({
        status: "changes_required",
        head: HEAD,
        currentHead: true,
        superseded: false,
      }),
    });
    const { tree } = await renderDialog({ task, next, runs: [run] });
    const text = tree.text();
    assert.ok(
      text.includes("Two issues block the merge."),
      "the report's own summary shows beside its findings",
    );
    assert.ok(tree.query("Review summary: Two issues block the merge."));
    assert.ok(text.includes("The menu is hidden in the modal."));
    assert.ok(
      text.includes(`Not the current head (reviewed ${HEAD.slice(0, 7)})`),
    );
    assert.ok(!text.includes(`At ${HEAD.slice(0, 7)}`));
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("Activity shows no host thread identity in any default line", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working" });
    // Synthetic identities in the shapes hosts write.
    const events = [
      {
        id: 1,
        taskId: task.id,
        at: "2026-11-22T10:00:00.000Z",
        kind: "agent_created",
        detail:
          "thread:delegated-task:ns-agent-0b2a69ba-1111-4222-8333-444455556666",
      },
      {
        id: 2,
        taskId: task.id,
        at: "2026-11-22T10:01:00.000Z",
        kind: "worker_resumed",
        detail: "Resumed ns-run-7f3e2a after the restart",
      },
      {
        id: 3,
        taskId: task.id,
        at: "2026-11-22T10:02:00.000Z",
        kind: "agent_observed",
        detail: "mcp:paseo:worker-alpha",
      },
      {
        id: 4,
        taskId: task.id,
        at: "2026-11-22T10:03:00.000Z",
        kind: "coordination_note",
        detail: "[QA] asked t3code:thread-abc for the receipt",
      },
    ];
    const { tree } = await renderDialog({ task, next: makeNext(task), events });
    tree.press("Activity");
    const text = tree.text();
    for (const prefix of [
      "thread:delegated-task",
      "ns-agent-",
      "ns-run-",
      "mcp:",
      "t3code:",
    ])
      assert.ok(!text.includes(prefix), `no ${prefix} in the default timeline`);
    assert.ok(
      text.includes("A new agent thread started for this task."),
      "identity-only events read by kind",
    );
    assert.ok(
      text.includes("Resumed after the restart"),
      "the human words remain",
    );
    assert.ok(
      text.includes("[QA] asked for the receipt"),
      "the note keeps its words",
    );
    tree.press(/Show raw events \(4\)/);
    assert.ok(
      tree.text().includes("ns-run-7f3e2a"),
      "the raw list keeps the originals",
    );
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("an open dependency form follows a refresh until edited, then is fenced to its starting list", async () => {
  const store = new Store(":memory:");
  try {
    const field =
      "Prerequisites (comma-separated task IDs or references; leave empty to clear)";
    const verb = (task: TaskDetail) =>
      taskNextVerbSchema.parse({
        verb: "set_dependencies",
        action: "set_dependencies",
        available: true,
        args: { taskId: task.id, version: task.version },
        fill: ["dependsOn"],
      });
    const v1 = createTaskDetail(store, { phase: "queued", dependsOn: [] });
    // A poll picks up a prerequisite added elsewhere, at a newer version.
    const v2 = { ...v1, version: v1.version + 1, dependsOn: ["app#7"] };

    // Untouched: the form follows the refresh and stays unsavable.
    const untouched = await renderDialog({
      task: v1,
      next: makeNext(v1, { verbs: [verb(v1)] }),
    });
    untouched.tree.press("Task actions menu");
    untouched.tree.press("Set dependencies");
    untouched.rerender(v2, makeNext(v2, { verbs: [verb(v2)] }));
    assert.equal(
      untouched.tree.get(field).props.value,
      "app#7",
      "the form shows the refreshed list",
    );
    assert.equal(
      untouched.tree.get("Save dependencies").props.accessibilityState
        ?.disabled,
      true,
      "a refresh never turns an untouched form into a clearing save",
    );
    untouched.tree.update(h("View", null));

    // Edited before the refresh: fenced to its starting list until the operator restarts.
    const edited = await renderDialog({
      task: v1,
      next: makeNext(v1, { verbs: [verb(v1)] }),
    });
    edited.tree.press("Task actions menu");
    edited.tree.press("Set dependencies");
    edited.tree.type(field, "app#5");
    edited.rerender(v2, makeNext(v2, { verbs: [verb(v2)] }));
    assert.ok(
      edited.tree
        .text()
        .includes(
          "These prerequisites changed while you were editing: now app#7.",
        ),
    );
    assert.equal(
      edited.tree.get("Save dependencies").props.accessibilityState?.disabled,
      true,
    );
    edited.tree.press("Start from the current list");
    assert.equal(edited.tree.get(field).props.value, "app#7");
    edited.tree.type(field, "app#7, app#5");
    edited.tree.press("Save dependencies");
    await new Promise((r) => setTimeout(r, 10));
    const call = edited.calls.find(
      (item) =>
        (item.input as { action?: string }).action === "set_dependencies",
    );
    assert.deepEqual(
      [
        (call?.input as { version: number }).version,
        [...(call?.input as { dependsOn: string[] }).dependsOn].sort(),
      ],
      [v2.version, ["app#5", "app#7"]],
    );
    edited.tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("a newer next read sets the PR head the Review card compares against", async () => {
  const store = new Store(":memory:");
  try {
    // `queue.detail` still holds version 1 at head A; `task.next` is at version 2 with
    // PR head B and an approval at B.
    const detail = createTaskDetail(store, {
      phase: "verifying",
      prHead: HEAD,
    });
    const newer = { ...detail, version: detail.version + 1, prHead: HEAD_2 };
    const next = makeNext(newer, {
      outcome: acceptedOutcome({
        head: HEAD_2,
        eventId: "ev-b",
        runId: "rev-b",
        summary: "Approved at B.",
      }),
    });
    const { tree } = await renderDialog({ task: detail, next });
    const text = tree.text();
    assert.ok(text.includes("Approved at B."));
    assert.ok(
      text.includes(`At ${HEAD_2.slice(0, 7)}`),
      "the approval is at the current head",
    );
    assert.ok(
      !text.includes("Not the current head"),
      "a lagging detail read never makes it stale",
    );
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});

test("Activity names owner-control callers in words and explains a late delivery", async () => {
  const store = new Store(":memory:");
  try {
    const task = createTaskDetail(store, { phase: "working" });
    const thread =
      "thread:delegated-task:ns-agent-0b2a69ba-1111-4222-8333-444455556666";
    const runId = "8b63c554-459d-4c4d-a92f-704ffc548014";
    // The payloads `owner_control` and run delivery write (synthetic identities).
    const ownerControl = JSON.stringify({
      verb: "restart",
      caller: thread,
      phaseBefore: "needs_attention",
      phaseAfter: "working",
      identities: { taskId: task.id, runId },
      reason: "Worker stalled",
    });
    const events = [
      {
        id: 1,
        taskId: task.id,
        at: "2026-11-22T10:00:00.000Z",
        kind: "owner_control",
        detail: ownerControl,
      },
      {
        id: 2,
        taskId: task.id,
        at: "2026-11-22T10:05:00.000Z",
        kind: "released_run_delivery_observed",
        detail: `${runId}: ${thread}`,
      },
    ];
    const { tree } = await renderDialog({ task, next: makeNext(task), events });
    tree.press("Activity");
    const text = tree.text();
    assert.ok(
      text.includes(
        "restart by an agent · needs attention → working · Worker stalled",
      ),
    );
    assert.ok(
      text.includes(
        "A run Nucleus had already released was delivered late; Nucleus left it out of the task.",
      ),
    );
    assert.ok(
      !text.includes("thread:") &&
        !text.includes("ns-agent-") &&
        !text.includes(runId),
    );
    tree.press(/Show raw events \(2\)/);
    assert.ok(tree.text().includes(thread), "the raw list keeps the originals");
    tree.update(h("View", null));
  } finally {
    store.close();
  }
});
