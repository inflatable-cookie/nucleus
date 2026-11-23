import { test } from "node:test";
import assert from "node:assert/strict";
import { boardSource } from "./support/board-source";
import { recentProjectActivity } from "./support/fakes";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs, type HostNode } from "./support/render";
import { acrossViews, openView } from "./support/inbox";
import { Store } from "../core/store/store";
import {
  LEAD_PREVIEW_MAX,
  projectSchema,
  submissionSchema,
  summarizeTask,
  syncHoldProjection,
  visibleTaskSummaries,
  type LaneView,
  type Project,
  type ProjectPlan,
  type Task,
  type TaskSummary,
} from "../shared/contracts";
import { taskStopReasons } from "../shared/task-stop";
import { waitStates } from "../shared/wait-state";

// UI lane step 2 (Tom, 2026-11-07): a board task card says what is happening, what is
// waiting and who or what moves it next; IDs, lanes, profiles and timestamps move to the
// task view. Synthetic rows only; the rendered tree is read through the render helper.
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
const LONG_TITLE =
  "Board cards keep the title to two lines when the task title runs well past what a narrow column can show, so the reader still sees where the task starts";
const MERGE = "Merge held by operator: external receipt pending";
const DISPATCH =
  "Dispatch held by operator: planning owes a ruling on the cleared origin";
const fence = (reason: string) => ({
  owner: "operator",
  reason,
  at,
  generation: 1,
  until: null,
});

const repo = { origin: "owner/app", path: "/app" };
const project = {
  key: "app",
  name: "App",
  repositories: [repo],
  primary: repo,
};
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

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the surface did not settle");
}
const board = (
  tasks: TaskSummary[],
  queuedCounts: Array<{ repoPath: string; count: number }> = [],
) => ({
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
  queuedCounts,
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

/** Mounts the board at a narrow (compact) or wide layout. Queries do not retry, so an error settles at once. */
function mountBoard(
  invoke: (method: string, input: unknown) => Promise<unknown>,
  compact = false,
) {
  const surfaceProps = {
    theme: { colors: c },
    host: { id: "host", label: "Host" },
    layout: { compact, platform: "ios" as const },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The cards span the inbox's list views; reads reach every view (support/inbox.ts).
  return acrossViews(
    mount(
      h(QueryClientProvider, {
        client,
        children: h(PluginRpcProvider, {
          invoke,
          children: h(queue.MainSurface as never, surfaceProps),
        }),
      }),
    ),
  );
}

function seed(store: Store, id: string, patch: Partial<Task>) {
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: id,
      title: id,
      repoPath: "/app",
      planningCommit: head,
      handoffPath: `${id}.md`,
      originAgentId: "0b355fd4",
    }),
    "host",
    "handoff",
    head,
  );
  return store.update(inserted.id, {
    notificationAgentId: "56e9c969",
    originError: "",
    originLookupError: "",
    ...patch,
  });
}

/** The second project's repository and row, for a queue holding back tasks in two projects. */
const otherRepo = { origin: "owner/other", path: "/other" };
const otherProject = {
  key: "other",
  name: "Other",
  repositories: [otherRepo],
  primary: otherRepo,
};

/** One queued task's stored summary; whether the snapshot ships it or a page returns it is the test's choice. */
function queuedTask(
  store: Store,
  title: string,
  repoPath = "/app",
): TaskSummary {
  const task = seed(store, title.replace(/\s+/g, "-").toLowerCase(), {
    title,
    phase: "queued",
    reason: "Waiting for dispatch",
    repoPath,
  });
  return summarizeTask(store.task(task.id));
}

/**
 * A real `queue.queued-page` answer: the project's queue in order, one page at a time,
 * and each read logged so a test can prove there was no extra paging.
 */
function queuedPagesRead(
  queues: Record<string, TaskSummary[]>,
  log: Array<{ repoPath: string; offset: number }> = [],
) {
  return async (input: unknown) => {
    const { repoPath, offset, limit } = input as {
      repoPath: string;
      offset: number;
      limit: number;
    };
    log.push({ repoPath, offset });
    const queue = queues[repoPath] ?? [];
    const tasks = queue.slice(offset, offset + limit);
    const next = offset + tasks.length;
    return { tasks, nextOffset: next < queue.length ? next : null };
  };
}

/**
 * A `queue.queued-page` reader the test answers by hand and can fail, so a read on its
 * way is observable: one page at a time, from the project's queue in order.
 */
function controlledQueuedPages(queue: TaskSummary[]) {
  const log: Array<{ repoPath: string; offset: number }> = [];
  const waiting: Array<{ answer: () => void; fail: () => void }> = [];
  const read = async (input: unknown) => {
    const { repoPath, offset, limit } = input as {
      repoPath: string;
      offset: number;
      limit: number;
    };
    log.push({ repoPath, offset });
    await new Promise<void>((resolve, reject) =>
      waiting.push({
        answer: resolve,
        fail: () => reject(new Error("queue read failed")),
      }),
    );
    const tasks = queue.slice(offset, offset + limit);
    const next = offset + tasks.length;
    return { tasks, nextOffset: next < queue.length ? next : null };
  };
  return {
    log,
    read,
    answer: () => waiting.shift()?.answer(),
    fail: () => waiting.shift()?.fail(),
  };
}

/** The list's one ScrollView, whose layout, content-size and scroll events drive its paging. */
function listScroll(tree: ReturnType<typeof mountBoard>) {
  const list = tree.raw
    .ofType("ScrollView")
    .find((node) => node.props.onScroll);
  assert.ok(
    list,
    "the list exposes its layout, content-size and scroll events",
  );
  return list;
}

/** Board fixtures: one card per state the card renders, all from real stored tasks and summaries. */
function fixtures(store: Store) {
  const long = seed(store, "long-title", {
    title: LONG_TITLE,
    phase: "working",
    reason: "Worker is editing",
  });
  const held = seed(store, "both-holds", {
    phase: "queued",
    reason: "Waiting for dispatch",
    ...syncHoldProjection({ dispatch: fence(DISPATCH), merge: fence(MERGE) }),
  });
  const closing = seed(store, "archive-failed", {
    phase: "closing",
    reason: "Closing the workspace",
  });
  const stopped = seed(store, "stopped", {
    phase: "needs_attention",
    reason: "Needs a decision",
  });
  const queued = seed(store, "waiting-heavy", {
    phase: "queued",
    reason: "Waiting for dispatch",
  });
  const reporting = seed(store, "reporting", {
    phase: "working",
    reason: "Worker is editing",
  });
  const empty = seed(store, "empty-card", {
    phase: "needs_attention",
    reason: "",
  });
  const summary = (id: string) => summarizeTask(store.task(id));
  return {
    long: summary(long.id),
    held: summary(held.id),
    // The archive failure is attention: the card shows the error, not the attempt count or retry time.
    closing: {
      ...summary(closing.id),
      resolution: {
        ...summary(closing.id).resolution,
        archiveRetry: {
          workspaceId: "ws-1",
          attempts: 3,
          error: "EBUSY: resource busy",
          nextAttemptAt: at,
        },
      },
    },
    stopped: {
      ...summary(stopped.id),
      stop: "attention" as const,
      stopRecord: {
        reason: "operator_needed" as const,
        detail: "Operator decides whether to restart",
        since: at,
        suggestedVerbs: ["restart" as const, "route" as const],
      },
    },
    heavy: {
      ...summary(queued.id),
      heavyRun: {
        selector: "npm test",
        state: "queued" as const,
        position: 2,
        submittedAt: at,
        launchedAt: null,
        holder: "milestone QA",
      },
    },
    reporting: {
      ...summary(reporting.id),
      headline: "Parser written; tests are next",
    },
    // An attention stop with no reason, no report and no next action: the chips row must not render empty.
    empty: {
      ...summary(empty.id),
      stop: "attention" as const,
      waitState: undefined,
    },
    queued: summary(queued.id),
  };
}

/** The shared invoke: every method the board reads, with the queued page supplied by the test. */
function invokeWith(
  snapshot: unknown,
  queuedPage: (input: unknown) => Promise<unknown>,
  leads: unknown[] = [],
  decisions: unknown[] = [],
) {
  return async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return snapshot;
    if (method === "queue.service-state") return serviceState;
    if (method === "queue.detail") return undefined;
    if (method === "task.next") return null;
    if (method === "queue.queued-page") return queuedPage(input);
    if (method === "project.qa.list" || method === "host.run.list") return [];
    if (method === "host.run.board")
      return {
        runs: [],
        accounting: { readAt: at, entries: [], complete: true },
      };
    if (method === "lead.board") return { cards: leads, links: [] };
    if (method === "decision.list") return decisions;
    if (
      method === "queue.plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "project.owner-candidates"
    )
      return [];
    void input;
    return {};
  };
}

/** Counts View nodes with a wrapping chip style and no children: an empty chips row. */
function emptyChipRows(node: HostNode): number {
  const own =
    node.type === "View" &&
    node.props.style?.flexWrap === "wrap" &&
    node.props.style?.gap === 6 &&
    node.children.length === 0
      ? 1
      : 0;
  return (
    own +
    node.children.reduce(
      (sum, child) =>
        sum + (typeof child === "string" ? 0 : emptyChipRows(child)),
      0,
    )
  );
}

test("a board card says what is happening and what moves it next; IDs, timestamps and profile stay out", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const extra = {
      ...f.queued,
      id: "extra-1",
      title: "Second queued",
      number: 99,
      phase: "queued" as const,
    };
    // Three loaded queued cards (held, heavy, extra) out of 12 queued in the project: the column shows 9 more.
    const snapshot = board(
      [f.long, f.held, f.closing, f.stopped, f.heavy, f.reporting, extra],
      [{ repoPath: "/app", count: 12 }],
    );
    mounted = mountBoard(
      invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(
      () =>
        tree.text().includes("Parser written; tests are next") &&
        tree.text().includes("Dispatch held"),
    );

    // What is happening, and who moves it next (the body of each card).
    assert.match(
      tree.text(),
      /Workspace archive failed: EBUSY: resource busy/,
      "the failed archive is the next action",
    );
    assert.ok(
      tree
        .text()
        .includes("Needs attention · Operator decides whether to restart"),
      "the row's one status line says the state and the one detail that moves it next",
    );
    assert.ok(
      !tree.text().includes("operator_needed") &&
        !tree.text().includes("next: restart, route"),
      "technical stop mechanics stay off the card",
    );
    assert.match(
      tree.text(),
      /Waiting · for QA capacity · position 2/,
      "a queued heavy run names its place",
    );
    assert.ok(
      tree.text().includes("Parser written; tests are next"),
      "a card reads its latest report",
    );
    // Holds keep their own distinct chips, and the hold age comes from the summary's since field.
    assert.ok(
      tree.text().includes("Dispatch held"),
      "the dispatch hold keeps its chip",
    );
    assert.ok(
      tree.text().includes("Merge held"),
      "the merge hold keeps its chip",
    );
    assert.ok(
      !tree.text().includes("age not recorded"),
      "the summary carries the hold since time",
    );

    // Moved to the task view: no attempt count, retry time, profile placeholder or report caption on the card.
    assert.ok(
      !tree.text().includes("Attempt 3"),
      "the attempt count is in the task view",
    );
    assert.ok(
      !tree.text().includes("next retry"),
      "the retry time is in the task view",
    );
    assert.ok(
      !tree.text().includes("Automatic"),
      "the profile placeholder is in the task view",
    );
    assert.ok(
      !tree.text().includes("Latest report"),
      "the report caption is gone",
    );
    assert.ok(
      !tree.text().includes(head),
      "the planning commit is not on the card",
    );

    // Real totals: the project's 12 queued tasks, three shipped here, stay the Queue count.
    assert.ok(
      tree.query("Queue, 12"),
      "the Queue count carries the server total",
    );
    assert.equal(
      tree.raw.all("…and 9 more in app").length,
      0,
      "no expander row holds them back (nucleus#1532)",
    );

    // Long content: the full title stays in the accessible label, and the visible title is capped at two lines.
    assert.ok(
      tree.query(new RegExp(`^App, ${LONG_TITLE.slice(0, 40)}`)),
      "the accessible label names the whole task",
    );
    const stoppedLabel = tree.query(/^App, stopped,/)?.props
      .accessibilityLabel as string;
    assert.match(stoppedLabel, /Operator decides whether to restart/);
    assert.match(stoppedLabel, /Action: open task details/);
    assert.doesNotMatch(stoppedLabel, /operator_needed|restart, route/);
    const heldLabel = tree
      .all(/Full hold reason:/)
      .find((node) =>
        String(node.props.accessibilityLabel ?? "").includes(
          "Full hold reason:",
        ),
      )?.props.accessibilityLabel as string;
    assert.match(
      heldLabel,
      /Full hold reason: Dispatch held by operator: planning owes a ruling on the cleared origin/,
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("the card lays out the same content at a narrow and a wide board", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const snapshot = board([
      f.long,
      f.held,
      f.closing,
      f.stopped,
      f.heavy,
      f.reporting,
    ]);
    for (const compact of [true, false]) {
      mounted?.update(h("View", null));
      mounted = mountBoard(
        invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })),
        compact,
      );
      const tree = mounted;
      await settle(
        () =>
          tree.text().includes("Parser written; tests are next") &&
          tree.text().includes("Workspace archive failed"),
      );
      const label = compact ? "narrow" : "wide";
      const card = tree.query(/^App, Board cards keep the title/);
      assert.ok(card, `the ${label} card keeps its accessible label`);
      assert.equal(
        emptyChipRows(card as HostNode),
        0,
        `the ${label} card has no empty chips row`,
      );
      assert.match(
        tree.text(),
        /Dispatch held/,
        `the ${label} card keeps the hold chip`,
      );
      assert.match(
        tree.text(),
        /Workspace archive failed: EBUSY/,
        `the ${label} card keeps the error next action`,
      );
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a T3Code task row names the host in its accessible label, not on the row", async () => {
  await load();
  const store = new Store(":memory:");
  try {
    const { queued } = fixtures(store);
    const pendingUi = mount(
      h(queue.TaskCard as never, {
        task: { ...queued, hostId: "t3code:synthetic-environment" },
        selected: false,
        onPress: () => {},
        c,
        board: true,
      }),
    );
    try {
      assert.doesNotMatch(
        pendingUi.text(),
        /T3Code/,
        "an unbound queued task with hostPending keeps the host chip hidden",
      );
    } finally {
      pendingUi.update(h("View", null));
    }
    const task = {
      ...queued,
      hostId: "t3code:synthetic-environment",
      hostPending: undefined,
    };
    const ui = mount(
      h(queue.TaskCard as never, {
        task,
        selected: false,
        onPress: () => {},
        c,
        board: true,
      }),
    );
    try {
      // The row's project badge marks a T3 project; the host kind is detail (nucleus#1515).
      assert.doesNotMatch(ui.text(), /T3Code/, "the row draws no host chip");
      const label = ui
        .all(/.*/)
        .find((node) =>
          String(node.props.accessibilityLabel ?? "").includes(
            "Action: open task details",
          ),
        )?.props.accessibilityLabel as string;
      assert.match(label, /T3Code/);
      assert.doesNotMatch(
        label,
        /t3code:synthetic-environment/,
        "long host IDs stay in the task view",
      );
    } finally {
      ui.update(h("View", null));
    }
  } finally {
    store.close();
  }
});

test("a queued hold previews its first sentence and keeps the complete reason accessible", async () => {
  await load();
  const store = new Store(":memory:");
  try {
    const { held } = fixtures(store);
    const fullReason =
      "The planner needs to record the source ruling. The task can start after that decision.";
    const task = {
      ...held,
      holds: {
        ...(held.holds ?? {}),
        dispatch: {
          ...(held.holds?.dispatch ?? fence(fullReason)),
          reason: fullReason,
        },
      },
    };
    const ui = mount(
      h(queue.TaskCard as never, {
        task,
        selected: false,
        onPress: () => {},
        c,
        board: true,
      }),
    );
    try {
      assert.ok(
        ui
          .text()
          .includes(
            "Dispatch held · by a planner thread: The planner needs to record the source ruling.",
          ),
        `the status line names the hold and previews its first sentence: ${ui.text()}`,
      );
      assert.ok(
        !ui.text().includes("The task can start after that decision."),
        "the card keeps its preview to the first sentence",
      );
      const label = ui
        .all(/.*/)
        .find((node) =>
          String(node.props.accessibilityLabel ?? "").includes(
            "Full hold reason:",
          ),
        )?.props.accessibilityLabel as string;
      assert.ok(
        label.includes(fullReason),
        "the accessible name retains the unmodified full reason",
      );
    } finally {
      ui.update(h("View", null));
    }
  } finally {
    store.close();
  }
});

test("a card with nothing to show renders no empty chips row, and its state line stays", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    // Attention stop on a needs-attention task: the phase line says it, so the stop badge is suppressed.
    const snapshot = board([f.empty]);
    mounted = mountBoard(
      invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query(/^App, empty-card,/)));
    const card = tree.query(/^App, empty-card,/) as HostNode;
    assert.equal(
      emptyChipRows(card),
      0,
      "a suppressed stop leaves no empty chips row",
    );
    assert.ok(
      tree.query(/^App, empty-card, Attention/),
      "the accessible label still says what is happening",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("waits, holds and progress stops use operator words in visible and accessible card text", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const dependent = seed(store, "dependency", {
      phase: "queued",
      reason:
        "Waiting for prerequisites: Machine ports move out of the Paseo adapter (84aa4e89-0f2c-4ea4-ae22-b11111111111): changes_requested; Publish adapter (84aa4e89-0f2c-4ea4-ae22-b22222222222): reviewing",
      dependsOn: [
        "84aa4e89-0f2c-4ea4-ae22-b11111111111",
        "84aa4e89-0f2c-4ea4-ae22-b22222222222",
      ],
    });
    const progress = seed(store, "progress", {
      phase: "blocked",
      reason: "lifecycle: Reviewer continuing from checkpoint 2",
    });
    const task = store.task(dependent.id);
    const projectWithPlanner = projectSchema.parse({
      ...project,
      planner: { agentId: "planner-id", setBy: "operator", setAt: at },
    });
    const summaries = visibleTaskSummaries(
      [task, store.task(progress.id)],
      [projectWithPlanner],
    );
    const prereq = {
      ...summaries[0]!,
      waitingOn: "#874",
      waitState: {
        state: "waiting_prerequisite" as const,
        owner: "prerequisites",
        nextAction: "Wait for prerequisites to finish",
      },
    };
    const progressSummary = {
      ...summaries[1]!,
      stop: "run" as const,
      stopRecord: {
        reason: "lifecycle" as const,
        detail: "lifecycle: Reviewer continuing from checkpoint 2",
        since: at,
        suggestedVerbs: [],
      },
    };
    const holder = seed(store, "held-by-planner", {
      phase: "queued",
      reason: "Waiting for dispatch",
      ...syncHoldProjection({
        dispatch: { ...fence("Dispatch held by planner"), owner: "planner-id" },
      }),
    });
    const heldSummary = visibleTaskSummaries(
      [store.task(holder.id)],
      [projectWithPlanner],
    )[0]!;
    const mergeHolder = seed(store, "merge-held-by-planner", {
      phase: "merging",
      reason: "Merge held by planner-id: waiting for receipt",
      ...syncHoldProjection({
        merge: { ...fence("waiting for receipt"), owner: "planner-id" },
      }),
    });
    const mergeSummary = {
      ...visibleTaskSummaries(
        [store.task(mergeHolder.id)],
        [projectWithPlanner],
      )[0]!,
      waitState: {
        state: "merge_hold" as const,
        owner: "planner",
        nextAction: "Release the hold",
      },
      stop: "run" as const,
      stopRecord: {
        reason: "held" as const,
        detail: "Merge held by planner-id: waiting for receipt",
        since: at,
        suggestedVerbs: [],
      },
    };
    const operatorHolder = seed(store, "held-by-operator", {
      phase: "queued",
      reason: "Waiting for dispatch",
      ...syncHoldProjection({
        dispatch: { ...fence("Dispatch held by operator"), owner: "operator" },
      }),
    });
    const otherHolder = seed(store, "held-by-other-thread", {
      phase: "queued",
      reason: "Waiting for dispatch",
      ...syncHoldProjection({
        dispatch: {
          ...fence("Dispatch held by another thread"),
          owner: "other-thread",
        },
      }),
    });
    assert.equal(
      visibleTaskSummaries(
        [store.task(operatorHolder.id)],
        [projectWithPlanner],
      )[0]?.holdDisplayOwner,
      "you",
    );
    assert.equal(
      visibleTaskSummaries(
        [store.task(otherHolder.id)],
        [projectWithPlanner],
      )[0]?.holdDisplayOwner,
      "a planner thread",
    );
    for (const compact of [true, false]) {
      mounted?.update(h("View", null));
      mounted = mountBoard(
        invokeWith(
          board([prereq, progressSummary, heldSummary, mergeSummary]),
          async () => ({ tasks: [], hasMore: false }),
        ),
        compact,
      );
      const tree = mounted;
      await settle(() => tree.text().includes("After #874"));
      assert.ok(
        tree
          .text()
          .includes(
            "After #874 · Machine ports move out of the Paseo adapter · Changes · +1 more",
          ),
      );
      assert.ok(!tree.text().includes("84aa4e89"));
      assert.ok(tree.text().includes("Reviewer continuing from checkpoint 2"));
      assert.ok(!tree.text().includes("Stopped just now"));
      assert.ok(tree.text().includes("Dispatch held · by App planner"));
      assert.ok(tree.text().includes("Held · Merge held by App planner"));
      // The age sits at the end of the row's meta line (nucleus#1515).
      assert.match(tree.text(), /\d+d ago/);
      assert.ok(
        !tree
          .query(/^App, progress,/)
          ?.props.accessibilityLabel?.includes("no owner verb"),
      );
      const prerequisiteLabel = tree.query(/^App, dependency,/)?.props
        .accessibilityLabel as string;
      assert.ok(
        prerequisiteLabel.includes(
          "Waiting for prerequisite: After #874 · Machine ports move out of the Paseo adapter · Changes · +1 more",
        ),
      );
      assert.ok(!prerequisiteLabel.includes("84aa4e89"));
      assert.ok(
        !prerequisiteLabel.includes(
          "Waiting for prerequisite, Waiting for prerequisite",
        ),
      );
      assert.ok(
        tree
          .query(/^App, progress,/)
          ?.props.accessibilityLabel?.includes(
            "Waiting: lifecycle: Reviewer continuing from checkpoint 2",
          ),
      );
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("every task and decision card keeps stored IDs and hashes out of visible and accessible text", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const uuid = "7a3c4bc4-e0db-48bb-9071-4ae6f3a09222";
    const digest =
      "79768fb6010d5f4859798c1040303dff4a9cb3697ad3f773f755480d4a4164a8";
    const rows = [
      seed(store, "operator-wait", {
        phase: "blocked",
        reason: "Needs decision",
      }),
      seed(store, "escalation-wait", {
        phase: "blocked",
        reason:
          "Waiting with the planner or task owner " +
          uuid +
          ": blocker escalation " +
          digest,
      }),
      seed(store, "source-wait", {
        phase: "queued",
        reason: `Waiting for source ${uuid} ${digest}`,
      }),
      seed(store, "held-attention", {
        phase: "needs_attention",
        reason: `Merge held by ${uuid}: receipt ${digest}`,
      }),
      seed(store, "reason-card", {
        phase: "working",
        reason: `Working on ${uuid}; ref ${digest}`,
      }),
    ];
    const plannerProject = projectSchema.parse({
      ...project,
      planner: { agentId: uuid, setBy: "operator", setAt: at },
    });
    const escalation = store.task(rows[1]!.id);
    store.update(escalation.id, {
      resolution: {
        ...escalation.resolution,
        stop: {
          reason: "escalated",
          detail: `Waiting with the planner or task owner ${uuid}: blocker escalation ${digest}`,
          since: at,
          suggestedVerbs: [],
        },
      },
    });
    const base = visibleTaskSummaries(
      rows.map((row) => store.task(row.id)),
      [plannerProject],
    );
    const decision = {
      id: "decision-card",
      version: 1,
      question: `Should we keep ${uuid} at ${digest}?`,
      choices: [
        { label: `Keep ${uuid}`, consequence: `Build ${digest}` },
        { label: `Pause ${uuid}`, consequence: `Wait ${digest}` },
      ],
      recommended: `Keep ${uuid}`,
      details: null,
      context: null,
      options: [],
      recommendation: null,
      overtakenBy: [],
      askedBy: { agentId: "agent-asker", project: null },
      links: { tasks: [], leads: [], papercuts: [] },
      status: "open",
      answer: null,
      withdrawal: null,
      supersededBy: null,
      delivery: null,
      createdAt: at,
      updatedAt: at,
      versions: [],
      stale: false,
      projectKey: "app",
    };
    const cards = [
      {
        ...base[0]!,
        waitState: {
          state: "needs_operator_input" as const,
          owner: "operator",
          nextAction: `Answer ${uuid}`,
          decisionId: uuid,
        },
        reason: `Waiting on ${uuid} ${digest}`,
      },
      {
        ...base[1]!,
        stop: "run" as const,
        stopRecord: {
          reason: "escalated" as const,
          detail: `Waiting with the planner or task owner ${uuid}: blocker escalation ${digest}`,
          since: at,
          suggestedVerbs: [],
        },
      },
      {
        ...base[2]!,
        waitState: {
          state: "needs_source_rights" as const,
          owner: "operator",
          nextAction: `Accept ${digest}`,
        },
      },
      {
        ...base[3]!,
        holdEscalated: true,
        hold: { owner: uuid, reason: `receipt ${uuid} ${digest}`, since: at },
      },
      { ...base[4]!, reason: `Working on ${uuid}; ref ${digest}` },
    ];
    const snapshot = { ...board(cards), projects: [plannerProject] };
    for (const compact of [true, false]) {
      mounted?.update(h("View", null));
      mounted = mountBoard(
        invokeWith(
          snapshot,
          async () => ({ tasks: [], hasMore: false }),
          [],
          [decision],
        ),
        compact,
      );
      const tree = mounted;
      await settle(() => Boolean(tree.query(/^App, reason-card,/)));
      const raw = new RegExp(
        `(?:${uuid}|\\b[0-9a-f]{40}\\b|\\b[0-9a-f]{64}\\b)`,
        "i",
      );
      const texts = tree
        .ofType("Text")
        .flatMap((node) =>
          node.children.filter(
            (child): child is string => typeof child === "string",
          ),
        );
      assert.equal(
        texts.some((text) => raw.test(text)),
        false,
        "visible card text contains no UUID or digest",
      );
      const labels = tree
        .all(/.*/)
        .map((node) => node.props.accessibilityLabel)
        .filter((value): value is string => typeof value === "string");
      assert.equal(
        labels.some((label) => raw.test(label)),
        false,
        "card labels contain no UUID or digest",
      );
      assert.ok(
        tree.text().includes("Waiting on App planner · blocker escalation"),
      );
      assert.ok(tree.text().includes("Waiting on you"));

      const decisionTree = mount(
        h(queue.DecisionCard as never, {
          decision,
          selected: false,
          onPress: () => {},
          c,
          board: compact,
        }),
      );
      try {
        assert.ok(
          decisionTree.text().includes("Should we keep task at details?"),
          "the decision question is visible in plain form",
        );
        const decisionTexts = decisionTree
          .ofType("Text")
          .flatMap((node) =>
            node.children.filter(
              (child): child is string => typeof child === "string",
            ),
          );
        assert.equal(
          decisionTexts.some((text) => raw.test(text)),
          false,
          "decision text contains no UUID or digest",
        );
        const decisionLabels = decisionTree
          .all(/.*/)
          .map((node) => node.props.accessibilityLabel)
          .filter((value): value is string => typeof value === "string");
        assert.equal(
          decisionLabels.some((label) => raw.test(label)),
          false,
          "decision labels contain no UUID or digest",
        );
      } finally {
        decisionTree.update(h("View", null));
      }
    }

    const raw = new RegExp(
      `(?:${uuid}|\\b[0-9a-f]{40}\\b|\\b[0-9a-f]{64}\\b)`,
      "i",
    );
    const assertPlainCard = (task: TaskSummary) => {
      const card = mount(
        h(queue.TaskCard as never, {
          task,
          selected: false,
          onPress: () => {},
          c,
          board: true,
        }),
      );
      try {
        const text = card
          .ofType("Text")
          .flatMap((node) =>
            node.children.filter(
              (child): child is string => typeof child === "string",
            ),
          );
        assert.equal(
          text.some((value) => raw.test(value)),
          false,
          `visible text leaks from ${task.waitState?.state ?? task.stopRecord?.reason ?? "task"}`,
        );
        const labels = card
          .all(/.*/)
          .map((node) => node.props.accessibilityLabel)
          .filter((value): value is string => typeof value === "string");
        assert.equal(
          labels.some((value) => raw.test(value)),
          false,
          `accessible text leaks from ${task.waitState?.state ?? task.stopRecord?.reason ?? "task"}`,
        );
      } finally {
        card.update(h("View", null));
      }
    };
    for (const state of waitStates)
      assertPlainCard({
        ...base[4]!,
        waitState: {
          state,
          owner:
            state === "needs_operator_input" || state === "needs_source_rights"
              ? "operator"
              : "task",
          nextAction: `Resolve ${uuid} ${digest}`,
          ...(state === "needs_operator_input" ? { decisionId: uuid } : {}),
        },
      });
    for (const reason of taskStopReasons)
      assertPlainCard({
        ...base[4]!,
        stop: "run",
        stopRecord: {
          reason,
          detail:
            reason === "held"
              ? `Merge held by ${uuid}: receipt ${digest}`
              : `Waiting with the planner or task owner ${uuid}: blocker escalation ${digest}`,
          since: at,
          suggestedVerbs: [],
        },
      });
    for (const kind of ["dispatch", "merge"] as const)
      assertPlainCard({
        ...base[4]!,
        holds: {
          [kind]: {
            owner: uuid,
            reason: `${kind} hold ${uuid} ${digest}`,
            since: at,
          },
        },
        holdDisplayOwner: "App planner",
      });
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a long shell command card shows only its recorded elapsed time", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const startedAt = new Date(Date.now() - 26 * 60_000).toISOString();
    const command = `Worker is executing a shell command that has run for over 15 minutes (started at ${startedAt}): TMPDIR='/scratch/qa/project-a' effigy check`;
    const task = seed(store, "long-command", {
      phase: "working",
      reason: command,
    });
    const summary = summarizeTask(store.task(task.id));
    for (const compact of [true, false]) {
      mounted?.update(h("View", null));
      mounted = mountBoard(
        invokeWith(board([summary]), async () => ({
          tasks: [],
          hasMore: false,
        })),
        compact,
      );
      const tree = mounted;
      await settle(() => tree.text().includes("Long shell command"));
      assert.match(tree.text(), /Long shell command · 26m/);
      const label = tree.query(/^App, long-command,/)?.props
        .accessibilityLabel as string;
      assert.match(label, /Long shell command · 26m/);
      assert.ok(!label.includes("TMPDIR="));
      assert.ok(!tree.text().includes("TMPDIR="));
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1532: the Queue list's own page read shows its loading and failure states in the list.
test("the Queue list shows its held-back page loading, then a retry row when the read fails", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const shipped = [f.held, f.heavy, f.queued];
    const snapshot = board(shipped, [{ repoPath: "/app", count: 12 }]);
    // Loading: the page does not answer yet.
    mounted = mountBoard(
      invokeWith(snapshot, () => new Promise(() => undefined)),
    );
    let tree = mounted;
    await settle(() => Boolean(tree.query("Queue, 12")));
    openView(tree, "Queue");
    const list = listScroll(tree);
    list.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    list.props.onContentSizeChange(390, 200);
    await settle(() => tree.raw.text().includes("Loading queued tasks…"));
    mounted.update(h("View", null));

    // Error: the page refuses; the end of the list asks to try again.
    mounted = mountBoard(
      invokeWith(snapshot, async () => {
        throw new Error("queue unavailable");
      }),
    );
    tree = mounted;
    await settle(() => Boolean(tree.query("Queue, 12")));
    openView(tree, "Queue");
    const failed = listScroll(tree);
    failed.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    failed.props.onContentSizeChange(390, 200);
    await settle(() =>
      Boolean(tree.raw.query("Could not load queued tasks. Try again.")),
    );
    assert.equal(
      tree.raw.text().includes("Loading queued tasks…"),
      false,
      "a failed read stops asking and offers the retry row",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("the card keeps two-line titles, drops the repository and phase chips, and moves lanes to the task view", () => {
  const ui = boardSource();
  const start = ui.indexOf("function TaskCard(");
  const end = ui.indexOf("\n});\n", start);
  const card = ui.slice(start, end);
  // The row's title is capped at two lines (nucleus#1515), and the meta line carries the
  // short number, never the multi-repo reference.
  const shared = ui.slice(
    ui.indexOf("export const BoardCard"),
    ui.indexOf("\n});\n", ui.indexOf("export const BoardCard")),
  );
  assert.match(shared, /numberOfLines=\{2\}[\s\S]{0,200}\{title\}/);
  assert.match(card, /taskNumberLabel\(task, false\)/);
  assert.doesNotMatch(card, /repoChip|phaseChip|laneChips|profile\?\.name/);
  // The board call site passes only what the card still uses.
  const call = ui.slice(
    ui.indexOf("<TaskCard"),
    ui.indexOf("/>", ui.indexOf("<TaskCard")),
  );
  assert.doesNotMatch(call, /phaseChip|repoChip|laneChips/);
  assert.match(card, /return\s*\(?\s*<BoardCard/);
  assert.match(card, /holdReasonPreview\(dispatchWait\.reason\)/);
  assert.match(ui, /Stop category · \{taskSummaryStop\.reason\}/);
  assert.match(
    ui,
    /Suggested owner verbs ·\{" "\}\s*\{taskSummaryStop\.suggestedVerbs\.join\(", "\)\}/,
  );
});

// Triage (Tom, 2026-11-07): a lead card is a title, a kind, the project and one state line. The
// body preview the read carries stays out of the card; the record holds it.
// The read bounds a preview to LEAD_PREVIEW_MAX characters; the fixture is exactly that long.
const LONG_BODY =
  `What happened ${"the reader stops at the first line. ".repeat(12)}Impact`.slice(
    0,
    LEAD_PREVIEW_MAX,
  );
const LONG_CUT =
  "A papercut whose title runs well past the single line a Triage card can show, so the row stays short and the record carries the rest";
const triageLead = (
  id: string,
  title: string,
  patch: Record<string, unknown> = {},
) => ({
  id,
  title,
  preview: LONG_BODY,
  repositories: [repo],
  lanes: [],
  tags: [],
  papercutArea: null,
  state: "open",
  version: 1,
  check: null,
  approved: false,
  targets: [],
  ...patch,
});
const triagePapercuts = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    triageLead(`cut-${index}`, `Papercut ${index}`, {
      tags: ["papercut"],
    }),
  );

test("a long papercut and a long lead render as three-line rows: kind and project, a two-line title, one status line", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      triageLead("long-cut", LONG_CUT, {
        tags: ["papercut"],
        papercutArea: "board",
      }),
      triageLead("long-lead", LONG_TITLE, {
        tags: ["idea"],
        check: { ok: true },
      }),
    ];
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => tree.text().includes("Checked · awaiting approval"));
    const text = tree.text();
    assert.ok(
      tree.query(/^Papercut: A papercut whose title runs well past/),
      "the papercut row keeps its full title in its accessible label",
    );
    assert.match(text, /Open · board/, "a papercut states its area");
    assert.ok(
      !text.includes("What happened"),
      "the body passage stays in the record",
    );
    // Each row: the project on line 1 (a single-kind view drops the kind word),
    // the title in up to two lines, then the one status line (nucleus#1515).
    for (const [title, view, kind, icon, status] of [
      [LONG_CUT, "Papercuts", "Papercut", "Scissors", "Open · board"],
      [LONG_TITLE, "Leads", "Lead", "Lightbulb", "Checked · awaiting approval"],
    ] as const) {
      openView(tree, view);
      const rowNode = tree.raw.query(new RegExp(`^${kind}: `)) as HostNode;
      assert.ok(rowNode, `the ${kind} row is listed on its own view`);
      const rowText = nodeText(rowNode);
      assert.match(
        rowText,
        /^\s*App\s/,
        "line 1 starts with the project; the single-kind view drops the kind word",
      );
      const lineTexts = (rowNode as HostNode).children.flatMap(function texts(
        node: HostNode | string,
      ): string[] {
        if (typeof node === "string") return [node];
        if (
          node.type === "Text" &&
          node.children.every((child) => typeof child === "string")
        )
          return [node.children.join("")];
        return node.children.flatMap(texts);
      });
      assert.ok(
        !lineTexts.includes(kind),
        "the kind word stays in the accessible label, not the visible row",
      );
      assert.ok(lineTexts.includes("App"), "line 1 still names the project");
      assert.match(
        rowText,
        new RegExp(`${status.replace(" · ", "\\s+· ")}\\s*$`),
        "the status line closes the row",
      );
      assert.ok(
        nodeHas(
          rowNode,
          (child) => child.type === "Icon" && child.props.name === icon,
        ),
        `the ${kind} row draws its kind tile`,
      );
      const lines = tree
        .ofType("Text")
        .filter((node) => node.children.join("") === title)
        .map((node) => node.props.numberOfLines);
      assert.deepEqual(
        lines,
        [2],
        `the title "${title.slice(0, 24)}…" is up to two lines`,
      );
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("Papercuts load the next page near the end and keep the real total", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    mounted = mountBoard(
      invokeWith(
        board([]),
        async () => ({ tasks: [], hasMore: false }),
        triagePapercuts(30),
      ),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Papercuts, 30")));
    openView(tree, "Papercuts");
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Papercut /).length, 25);
    assert.equal(tree.raw.text().includes("…and 5 more"), false);
    const list = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(list, "the list exposes its real scroll event");
    list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    list.props.onContentSizeChange(390, 1500);
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    });
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Papercut /).length, 30);
    assert.ok(tree.query("Papercuts, 30"), "the header keeps the real total");
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("Leads load the next page near the end and keep the real total", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = Array.from({ length: 30 }, (_, index) =>
      triageLead(`idea-${index}`, `Idea ${index}`, { tags: ["idea"] }),
    );
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Leads, 30")));
    openView(tree, "Leads");
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Idea /).length, 25);
    assert.equal(tree.raw.text().includes("…and 5 more"), false);
    const list = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(list, "the list exposes its real scroll event");
    list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    list.props.onContentSizeChange(390, 1500);
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    });
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Idea /).length, 30);
    assert.ok(tree.query("Leads, 30"), "the header keeps the real total");
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("Leads fill a tall pane, and changing the tag or view resets the page", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      ...Array.from({ length: 30 }, (_, index) =>
        triageLead(`idea-${index}`, `Idea ${index}`, { tags: ["idea"] }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        triageLead(`research-${index}`, `Research ${index}`, {
          tags: ["research"],
        }),
      ),
    ];
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Leads, 60")));
    openView(tree, "Leads");
    assert.equal(
      tree.raw.all(/^(?:Lead|Papercut): /).length,
      25,
      "the Leads list starts at one page",
    );
    const list = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(list, "the list exposes its layout and content-size events");
    list.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    list.props.onContentSizeChange(390, 450);
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): /).length, 50);
    const filledList = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(filledList);
    filledList.props.onContentSizeChange(390, 900);
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): /).length, 60);

    const listAfterFill = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(listAfterFill);
    listAfterFill.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    tree.press("Filter leads by tag, All tags (60)");
    tree.press("Filter leads by tag: idea (30)");
    const filteredList = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(filteredList);
    filteredList.props.onContentSizeChange(390, 900);
    await settle(() => tree.raw.all(/^(?:Lead|Papercut): Idea /).length === 25);
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Idea /).length, 25);
    openView(tree, "Papercuts");
    openView(tree, "Leads");
    assert.equal(
      tree.raw.all(/^(?:Lead|Papercut): Idea /).length,
      25,
      "switching away and back starts the Leads list at one page",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("switching views at a tall viewport fills a short list without a new layout", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      ...triagePapercuts(10),
      ...Array.from({ length: 30 }, (_, index) =>
        triageLead(`idea-${index}`, `Idea ${index}`, { tags: ["idea"] }),
      ),
    ];
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Leads, 30")));
    // A tall pane measured on Papercuts: the whole short list fits at once.
    openView(tree, "Papercuts");
    const papercutList = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(papercutList);
    papercutList.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    papercutList.props.onContentSizeChange(390, 400);
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Papercut /).length, 10);
    // Switching views does not resize the ScrollView, so no layout event fires.
    // The Leads list starts at one page; its content size alone must fill it.
    openView(tree, "Leads");
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Idea /).length, 25);
    const leadsList = tree.raw
      .ofType("ScrollView")
      .find((node) => node.props.onScroll);
    assert.ok(leadsList);
    leadsList.props.onContentSizeChange(390, 900);
    assert.equal(
      tree.raw.all(/^(?:Lead|Papercut): Idea /).length,
      30,
      "the kept viewport height fills the short list on its content size",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("the Leads tag filter sits in the list header row, beside the title and the item count", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      triageLead("idea-one", "Idea one", { tags: ["idea"] }),
      triageLead("idea-two", "Idea two", { tags: ["idea"] }),
    ];
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Leads, 2")));
    openView(tree, "Leads");
    const contains = (
      node: HostNode | string,
      match: (candidate: HostNode) => boolean,
    ): boolean =>
      typeof node !== "string" &&
      (match(node) || node.children.some((child) => contains(child, match)));
    const labelled = (prefix: string) => (candidate: HostNode) =>
      String(candidate.props.accessibilityLabel ?? "").startsWith(prefix);
    const texted = (value: string) => (candidate: HostNode) =>
      candidate.type === "Text" && candidate.children.join("") === value;
    // The header row lists the title as its own child, and the item count and the filter
    // sit inside that same row (the count and filter share one child group). A filter on a
    // row of its own below the title fails: the title row would not hold it.
    const titleChild = (row: HostNode) =>
      row.children.some(
        (child) => typeof child !== "string" && texted("Leads")(child),
      );
    const headerRow = tree.raw
      .ofType("View")
      .map((view) => view as unknown as HostNode)
      .find(
        (row) =>
          titleChild(row) &&
          contains(row, texted("2 items")) &&
          contains(row, labelled("Filter leads by tag, All tags (2)")) &&
          !contains(row, labelled("Lead: ")),
      );
    assert.ok(
      headerRow,
      "one row holds the Leads title, the 2 items count and the tag filter, with no card in it",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("the Leads tag filter narrows the list; papercuts have no filter and the menu count stays the inbox total", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      ...triagePapercuts(10),
      triageLead("idea-lead", "Idea lead", { tags: ["idea"] }),
      triageLead("plain-lead", "Plain lead", { tags: ["research"] }),
    ];
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Leads, 2")));
    openView(tree, "Leads");
    // The reserved papercut tag is not offered: papercuts are their own list (Tom, 2026-11-21).
    tree.press("Filter leads by tag, All tags (2)");
    assert.equal(tree.query("Filter leads by tag: Papercut (10)"), undefined);
    tree.press("Filter leads by tag: idea (1)");
    await settle(() =>
      Boolean(tree.query(/^(?:Lead|Papercut): Idea lead, Status: /)),
    );
    assert.equal(
      tree.all(/^(?:Lead|Papercut): (Papercut|Plain)/).length,
      0,
      "the idea tag narrows the leads to the idea lead",
    );
    assert.ok(tree.query("Leads, 2"), "the menu count ignores the list filter");
    // Papercuts keep every card, with no filter header (Tom, 2026-11-21).
    openView(tree, "Papercuts");
    assert.equal(
      tree.raw.query(/^Filter leads by tag/),
      undefined,
      "the papercut list has no tag filter",
    );
    assert.ok(
      tree.query("Papercuts, 10"),
      "the papercut total is unaffected by the Leads filter",
    );
    assert.equal(
      tree.all(/^(?:Lead|Papercut): Papercut /).length,
      10,
      "ten papercuts fit on the one page of twenty-five",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// #1042 review, nucleus#1532: the Leads filter and the Queue's held-back pages persist; triage pages reset.
test("the Leads tag and the queue's held-back pages survive view changes while triage pages reset", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      ...triagePapercuts(10),
      triageLead("idea-lead", "Idea lead", { tags: ["idea"] }),
      triageLead("plain-lead", "Plain lead", { tags: ["research"] }),
    ];
    const shipped = [queuedTask(store, "Shipped one")];
    const held = [queuedTask(store, "Held one"), queuedTask(store, "Held two")];
    mounted = mountBoard(
      invokeWith(
        board(shipped, [{ repoPath: "/app", count: 3 }]),
        queuedPagesRead({ "/app": [...shipped, ...held] }),
        leads,
      ),
    );
    const tree = mounted;
    await settle(
      () =>
        Boolean(tree.query("Papercuts, 10")) && Boolean(tree.query("Queue, 3")),
    );
    openView(tree, "Papercuts");
    const papercutList = listScroll(tree);
    papercutList.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    papercutList.props.onContentSizeChange(390, 1500);
    papercutList.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    });
    assert.equal(tree.raw.all(/^(?:Lead|Papercut): Papercut /).length, 10);
    // A short queue in a tall pane fills itself, reading its one held-back page.
    openView(tree, "Queue");
    const queueList = listScroll(tree);
    queueList.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    queueList.props.onContentSizeChange(390, 200);
    await settle(() => tree.raw.text().includes("Held two"));
    openView(tree, "Planning");
    await settle(() => !tree.raw.query("Queue list"));
    openView(tree, "Queue");
    await settle(() => Boolean(tree.raw.query("Queue list")));
    assert.ok(
      tree.raw.text().includes("Held two"),
      "the held-back queue cards are kept",
    );
    // Switching back to Papercuts starts at its first page.
    openView(tree, "Papercuts");
    assert.equal(
      tree.raw.all(/^(?:Lead|Papercut): Papercut /).length,
      10,
      "the Papercuts page resets on a view change",
    );
    // The Leads filter is kept too.
    openView(tree, "Leads");
    tree.press("Filter leads by tag, All tags (2)");
    tree.press("Filter leads by tag: idea (1)");
    await settle(() => tree.raw.all(/^(?:Lead|Papercut): Plain /).length === 0);
    openView(tree, "Planning");
    await settle(() => !tree.raw.query("Leads list"));
    openView(tree, "Leads");
    await settle(() => Boolean(tree.raw.query("Leads list")));
    assert.ok(
      tree.raw.query("Filter leads by tag, idea (1)"),
      "the Leads tag filter is kept",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1532: held-back queued tasks are ordinary cards in the one list, at every layout.
test("held-back queued tasks render as ordinary cards in compact and wide board layouts", async () => {
  await load();
  for (const compact of [true, false]) {
    const store = new Store(":memory:");
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      const shipped = [queuedTask(store, "Shipped one")];
      const held = [
        queuedTask(store, "Held one"),
        queuedTask(store, "Held two"),
      ];
      mounted = mountBoard(
        invokeWith(
          board(shipped, [{ repoPath: "/app", count: 3 }]),
          queuedPagesRead({ "/app": [...shipped, ...held] }),
        ),
        compact,
      );
      const tree = mounted;
      await settle(() => Boolean(tree.query("Queue, 3")));
      openView(tree, "Queue");
      // A tall pane fills itself, so the held-back cards show without a scroll.
      const list = listScroll(tree);
      list.props.onLayout({ nativeEvent: { layout: { height: 900 } } });
      list.props.onContentSizeChange(390, 200);
      await settle(() => tree.raw.text().includes("Held two"));
      const label = compact ? "compact" : "wide";
      assert.ok(
        tree.raw.query(/^App, Held one, /),
        `the ${label} layout lists a held-back task as an ordinary card`,
      );
      assert.ok(
        tree.query("Queue, 3"),
        "the Queue menu count retains the actual server total",
      );
      assert.equal(
        tree.raw.all("Previous").length,
        0,
        "no pager buttons remain",
      );
    } finally {
      mounted?.update(h("View", null));
      store.close();
    }
  }
});

// nucleus#1532: a project's held-back tasks follow its shipped queued cards, in queue order.
test("the Queue appends each project's held-back tasks after its shipped cards, in queue order", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const shipped = [
      queuedTask(store, "A one"),
      queuedTask(store, "A two"),
      queuedTask(store, "O one", "/other"),
      queuedTask(store, "O two", "/other"),
    ];
    const queues = {
      "/app": [
        ...shipped.slice(0, 2),
        queuedTask(store, "A three"),
        queuedTask(store, "A four"),
        queuedTask(store, "A five"),
        queuedTask(store, "A six"),
      ],
      "/other": [
        ...shipped.slice(2),
        queuedTask(store, "O three", "/other"),
        queuedTask(store, "O four", "/other"),
      ],
    };
    const reads: Array<{ repoPath: string; offset: number }> = [];
    const snapshot = {
      ...board(shipped, [
        { repoPath: "/app", count: 6 },
        { repoPath: "/other", count: 4 },
      ]),
      projects: [project, otherProject],
    };
    mounted = mountBoard(invokeWith(snapshot, queuedPagesRead(queues, reads)));
    const tree = mounted;
    // Ten queued tasks in all: four shipped cards and six held back by the snapshot.
    await settle(() => Boolean(tree.query("Queue, 10")));
    openView(tree, "Queue");
    // A list that scrolls waits for the scroll: the pane is shorter than its content.
    const list = listScroll(tree);
    list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    list.props.onContentSizeChange(390, 1500);
    assert.equal(
      tree.raw.text().includes("A three"),
      false,
      "held-back tasks wait until the list nears its end",
    );
    assert.equal(tree.raw.text().includes("…and"), false, "no expander row");
    assert.equal(tree.raw.all("Previous").length, 0, "no pager buttons");
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    });
    await settle(
      () =>
        tree.raw.text().includes("A six") && tree.raw.text().includes("O four"),
    );
    const text = tree.raw.text();
    const order = [
      "A one",
      "A two",
      "A three",
      "A four",
      "A five",
      "A six",
      "O one",
      "O two",
      "O three",
      "O four",
    ];
    const at = order.map((title) => text.indexOf(title));
    assert.ok(
      at.every((index) => index >= 0),
      "every queued task shows as a card",
    );
    assert.deepEqual(
      at,
      [...at].sort((a, b) => a - b),
      "each project's held-back cards follow its shipped ones, in queue order",
    );
    assert.deepEqual(
      reads.map((read) => read.repoPath).sort(),
      ["/app", "/other"],
      "each project was read once, for its first page",
    );
    assert.deepEqual(
      reads.map((read) => read.offset),
      [0, 0],
      "the reads start at the project queue's first page",
    );
    // The end of every project's queue asks for nothing more.
    const before = reads.length;
    const settled = listScroll(tree);
    settled.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    });
    settled.props.onContentSizeChange(390, 1500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      reads.length,
      before,
      "the loaded end of the queue reads nothing",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1532 review finding: a scroll while a page is on its way must not read again.
test("a multi-page Queue waits while a page is on its way instead of reading it twice", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const queue = Array.from({ length: 30 }, (_, index) =>
      queuedTask(store, `Task ${String(index + 1).padStart(2, "0")}`),
    );
    const shipped = queue.slice(0, 2);
    const paging = controlledQueuedPages(queue);
    mounted = mountBoard(
      invokeWith(
        board(shipped, [{ repoPath: "/app", count: 30 }]),
        paging.read,
      ),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Queue, 30")));
    openView(tree, "Queue");
    const nearEnd = {
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    };
    // A tick, for the assertions that no further read started.
    const quiet = () => new Promise((resolve) => setTimeout(resolve, 20));
    const scroll = () => {
      const list = listScroll(tree);
      list.props.onScroll(nearEnd);
      list.props.onScroll(nearEnd);
      list.props.onContentSizeChange(390, 1500);
      return list;
    };
    let list = listScroll(tree);
    list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    list.props.onContentSizeChange(390, 1500);
    list.props.onScroll(nearEnd);
    await settle(() => paging.log.length === 1);
    // Repeated scrolls while the first page is on its way read nothing more.
    scroll();
    await quiet();
    assert.deepEqual(
      paging.log,
      [{ repoPath: "/app", offset: 0 }],
      "a page on its way is not read twice",
    );
    assert.ok(
      tree.raw.text().includes("Task 01"),
      "the shipped cards stay while the page reads",
    );
    paging.answer();
    await settle(() => tree.raw.text().includes("Task 25"));
    // The next page starts its read; further scrolls still wait for it.
    scroll();
    await settle(() => paging.log.length === 2);
    scroll();
    await quiet();
    assert.equal(paging.log.length, 2, "the page on its way is asked for once");
    paging.answer();
    await settle(() => paging.log.length === 3);
    assert.deepEqual(
      paging.log[2],
      { repoPath: "/app", offset: 25 },
      "the last page is read at its own offset",
    );
    scroll();
    await quiet();
    assert.equal(
      paging.log.length,
      3,
      "the last page on its way is asked for once",
    );
    paging.answer();
    await settle(() => tree.raw.text().includes("Task 30"));
    // The end of the queue reads nothing more.
    scroll();
    await quiet();
    assert.equal(paging.log.length, 3, "the end of the queue reads nothing");
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1532 review finding: a failed page keeps the cards read and waits at the retry row.
test("a failed Queue page keeps the cards already read and stops reads at the retry row", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const queue = Array.from({ length: 30 }, (_, index) =>
      queuedTask(store, `Task ${String(index + 1).padStart(2, "0")}`),
    );
    const shipped = queue.slice(0, 2);
    const log: Array<{ repoPath: string; offset: number }> = [];
    const waiting: Array<() => void> = [];
    // The first read of a further page fails; the retry's own read is held, so the
    // list's loading and retry rows can be read while that read is on its way.
    let failures = 1;
    mounted = mountBoard(
      invokeWith(
        board(shipped, [{ repoPath: "/app", count: 30 }]),
        async (input) => {
          const { repoPath, offset, limit } = input as {
            repoPath: string;
            offset: number;
            limit: number;
          };
          log.push({ repoPath, offset });
          if (offset > 0 && failures > 0) {
            failures -= 1;
            throw new Error("queue read failed");
          }
          if (offset > 0)
            await new Promise<void>((resolve) => waiting.push(resolve));
          const tasks = queue.slice(offset, offset + limit);
          const next = offset + tasks.length;
          return { tasks, nextOffset: next < queue.length ? next : null };
        },
      ),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Queue, 30")));
    openView(tree, "Queue");
    const nearEnd = {
      nativeEvent: {
        contentOffset: { y: 700 },
        contentSize: { height: 1500, width: 390 },
        layoutMeasurement: { height: 400, width: 390 },
      },
    };
    const quiet = () => new Promise((resolve) => setTimeout(resolve, 20));
    const list = listScroll(tree);
    list.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    list.props.onContentSizeChange(390, 1500);
    list.props.onScroll(nearEnd);
    await settle(() => tree.raw.text().includes("Task 25"));
    // The second page's read fails: the cards read so far stay, and the list ends there.
    listScroll(tree).props.onScroll(nearEnd);
    await settle(() =>
      Boolean(tree.raw.query("Could not load queued tasks. Try again.")),
    );
    assert.ok(
      tree.raw.text().includes("Task 25"),
      "a failed page keeps the cards already read",
    );
    assert.equal(
      tree.raw.text().includes("Loading queued tasks…"),
      false,
      "the retry row stands alone",
    );
    const reads = log.length;
    const failed = listScroll(tree);
    failed.props.onScroll(nearEnd);
    failed.props.onScroll(nearEnd);
    failed.props.onContentSizeChange(390, 1500);
    await quiet();
    assert.equal(log.length, reads, "a failed read waits for the retry row");
    // The retry reads the page again, and the queue reaches its end.
    tree.raw.press("Could not load queued tasks. Try again.");
    await settle(() => waiting.length === 1);
    assert.equal(
      tree.raw.query("Could not load queued tasks. Try again."),
      undefined,
      "the retry row hides while its own read is on its way",
    );
    assert.ok(
      tree.raw.text().includes("Loading queued tasks…"),
      "the loading row speaks for the retry's read",
    );
    waiting.shift()?.();
    await settle(() => tree.raw.text().includes("Task 30"));
    assert.equal(
      tree.raw.query("Could not load queued tasks. Try again."),
      undefined,
      "the retry row clears once the page reads",
    );
    const ended = log.length;
    const done = listScroll(tree);
    done.props.onScroll(nearEnd);
    done.props.onContentSizeChange(390, 1500);
    await quiet();
    assert.equal(log.length, ended, "the end of the queue reads nothing");
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1532: a short queue fills a tall pane without a scroll, and a failed page read offers a retry.
test("a short queue fills a tall pane and a failed page read ends it with a retry row", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const shipped = [queuedTask(store, "Shipped one")];
    const held = [
      queuedTask(store, "Held one"),
      queuedTask(store, "Held two"),
      queuedTask(store, "Held three"),
    ];
    const queue = [...shipped, ...held];
    const reads: Array<{ repoPath: string; offset: number }> = [];
    const read = queuedPagesRead({ "/app": queue }, reads);
    let failing = true;
    mounted = mountBoard(
      invokeWith(board(shipped, [{ repoPath: "/app", count: 4 }]), (input) =>
        failing ? Promise.reject(new Error("queue read failed")) : read(input),
      ),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Queue, 4")));
    openView(tree, "Queue");
    const list = listScroll(tree);
    list.props.onLayout({ nativeEvent: { layout: { height: 1200 } } });
    list.props.onContentSizeChange(390, 200);
    await settle(() =>
      Boolean(tree.raw.query("Could not load queued tasks. Try again.")),
    );
    assert.equal(
      tree.raw.text().includes("Held one"),
      false,
      "a failed page shows no held-back cards",
    );
    assert.equal(
      tree.raw.all("Previous").length,
      0,
      "the failure never falls back to a pager",
    );
    failing = false;
    tree.raw.press("Could not load queued tasks. Try again.");
    await settle(() => tree.raw.text().includes("Held three"));
    assert.equal(
      tree.raw.query("Could not load queued tasks. Try again."),
      undefined,
      "the retry row clears once the page reads",
    );
    // The whole queue fits the tall pane, and its end asks for nothing more.
    const before = reads.length;
    const filled = listScroll(tree);
    filled.props.onContentSizeChange(390, 900);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      reads.length,
      before,
      "the end of the queue reads nothing more",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a Triage card names its project, not its repository, when the two are named differently", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    // The project is "Board Surface"; its repository is owner/app, so the directory name "app" must not show.
    const named = { ...project, name: "Board Surface" };
    const snapshot = { ...board([]), projects: [named] };
    mounted = mountBoard(
      invokeWith(snapshot, async () => ({ tasks: [], hasMore: false }), [
        triageLead("named-lead", "Named lead", { tags: ["idea"] }),
      ]),
    );
    const tree = mounted;
    await settle(() =>
      Boolean(tree.query(/^(?:Lead|Papercut): Named lead, Status: /)),
    );
    const eyebrows = tree
      .ofType("Text")
      .map((node) => node.children.join(""))
      .filter((text) => text === "Board Surface" || text === "app");
    assert.deepEqual(
      eyebrows,
      ["Board Surface"],
      "the card shows the project name and no repository name",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("lead-only and papercut-only repositories render T3 project badges on the board and keep folders on non-T3 boards", async () => {
  await load();
  const store = new Store(":memory:");
  let t3Mounted: ReturnType<typeof mountBoard> | undefined;
  let plainMounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const named = { ...project, name: "Biock Aase" };
    const leads = [
      triageLead("lead-only", "Lead without tasks", { tags: ["idea"] }),
      triageLead("cut-only", "Papercut without tasks", {
        tags: ["papercut"],
        papercutArea: "board",
      }),
    ];
    const detailOpened: string[] = [];
    const rpcFor =
      (snapshot: ReturnType<typeof board>) =>
      async (method: string, input: unknown) => {
        if (method === "queue.ui-snapshot") return snapshot;
        if (method === "lead.board") return { cards: leads, links: [] };
        if (method === "lead.get" || method === "papercut.get") {
          detailOpened.push(`${method}:${(input as { id: string }).id}`);
          return null;
        }
        if (method === "decision.list") return [];
        if (method === "plans") return [];
        if (method === "queue.service-state") return serviceState;
        return { tasks: [], hasMore: false };
      };
    const t3Snapshot = {
      ...board([]),
      projects: [named],
      repositoryBadges: {
        [repo.path]: { monogram: "BA", color: "fuchsia" as const },
      },
    };
    t3Mounted = mountBoard(rpcFor(t3Snapshot));
    await settle(() =>
      Boolean(
        t3Mounted?.query(/^(?:Lead|Papercut): Lead without tasks, Status: /),
      ),
    );
    /** Badge text nodes on the Leads and Papercuts lists: the lead card and the papercut card. */
    const tabMonograms = (mounted: ReturnType<typeof mountBoard>) => {
      openView(mounted, "Leads");
      const found = mounted
        .ofType("Text")
        .filter((node) => node.children.join("") === "BA");
      openView(mounted, "Papercuts");
      found.push(
        ...mounted
          .ofType("Text")
          .filter((node) => node.children.join("") === "BA"),
      );
      openView(mounted, "Leads");
      return found;
    };
    const monograms = tabMonograms(t3Mounted);
    assert.equal(
      monograms.length,
      2,
      "both lead and papercut cards render the T3 badge with no tasks on the board",
    );
    for (const node of monograms) {
      assert.equal(node.props.style.color, "rgb(237, 106, 255)");
      assert.equal(
        node.props.style.backgroundColor,
        "rgba(237, 106, 255, 0.14)",
      );
    }
    assert.match(t3Mounted.text(), /Biock Aase/);
    assert.match(t3Mounted.text(), /Lead/);
    assert.match(t3Mounted.text(), /Papercut/);
    const cardFolderCount = (mounted: ReturnType<typeof mountBoard>) => {
      const count = (node: HostNode | string): number =>
        typeof node === "string"
          ? 0
          : (node.type === "Icon" && node.props.name === "Folder" ? 1 : 0) +
            node.children.reduce((sum, child) => sum + count(child), 0);
      const tabCards = () =>
        mounted.raw
          .all(/^(?:Lead|Papercut): /)
          .reduce((sum, card) => sum + count(card), 0);
      openView(mounted, "Leads");
      let total = tabCards();
      openView(mounted, "Papercuts");
      total += tabCards();
      openView(mounted, "Leads");
      return total;
    };
    assert.equal(cardFolderCount(t3Mounted), 0);
    t3Mounted.press(/^(?:Lead|Papercut): Lead without tasks, Status: /);
    t3Mounted.press("Close detail");
    t3Mounted.press(/^(?:Lead|Papercut): Papercut without tasks, Status: /);
    await settle(() => detailOpened.length === 2);
    assert.deepEqual(detailOpened, [
      "lead.get:lead-only",
      "papercut.get:cut-only",
    ]);

    const plainSnapshot = { ...board([]), projects: [named] };
    plainMounted = mountBoard(rpcFor(plainSnapshot));
    await settle(() =>
      Boolean(
        plainMounted?.query(/^(?:Lead|Papercut): Lead without tasks, Status: /),
      ),
    );
    assert.equal(
      tabMonograms(plainMounted).length,
      0,
      "non-T3 boards never render monograms",
    );
    assert.equal(cardFolderCount(plainMounted), 2);
  } finally {
    t3Mounted?.update(h("View", null));
    plainMounted?.update(h("View", null));
    store.close();
  }
});

// Tom, 2026-11-21: the inbox list keeps the coloured T3 project badges on task cards.
test("a task row in the inbox list shows its T3 project badge from its own host, and a folder without one", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const task = seed(store, "badged-task", { phase: "working" });
    const summary = {
      ...summarizeTask(store.task(task.id)),
      hostId: "t3code:main",
    };
    const snapshot = {
      ...board([summary]),
      projectBadges: {
        "t3code:main": {
          [summary.repoPath]: { monogram: "BA", color: "fuchsia" as const },
        },
      },
    };
    mounted = mountBoard(
      invokeWith(snapshot, async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(() => tree.text().includes("badged-task"));
    openView(tree, "Working");
    const badge = tree.raw
      .ofType("Text")
      .filter((node) => node.children.join("") === "BA");
    assert.equal(badge.length, 1, "the row draws the badge");
    assert.equal(badge[0].props.style.color, "rgb(237, 106, 255)");

    // The same task on a host the badge map does not name keeps its folder icon.
    mounted.update(h("View", null));
    mounted = mountBoard(
      invokeWith(
        { ...snapshot, tasks: [{ ...summary, hostId: "paseo:other" }] },
        async () => ({ tasks: [], hasMore: false }),
      ),
    );
    const plain = mounted;
    await settle(() => plain.text().includes("badged-task"));
    openView(plain, "Working");
    assert.equal(
      plain.raw.ofType("Text").filter((node) => node.children.join("") === "BA")
        .length,
      0,
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1511: the inbox board's post-roll fixes. Each one is measured on the real board
// render, at the layouts it affects.

/** A node's whole visible text, and whether it holds a node a predicate matches. */
const nodeText = (node: HostNode | string): string =>
  typeof node === "string" ? node : node.children.map(nodeText).join(" ");
/**
 * The row frame around a row's press target (nucleus#1528): the sidebar-style
 * highlight around the task button and, beside it, the row's flags and
 * controls, which sit outside the button.
 */
const rowFrame = (
  tree: { ofType(type: string): HostNode[] },
  label: RegExp,
): HostNode | undefined =>
  tree
    .ofType("View")
    .find(
      (node) =>
        node.props.style?.borderRadius === 8 &&
        node.props.style?.marginHorizontal === 8 &&
        node.children.some(
          (child) =>
            typeof child !== "string" &&
            child.type === "Pressable" &&
            label.test(String(child.props.accessibilityLabel ?? "")),
        ),
    );
const nodeHas = (
  node: HostNode | string,
  match: (node: HostNode) => boolean,
): boolean =>
  typeof node === "string"
    ? false
    : match(node) || node.children.some((child) => nodeHas(child, match));

test("the narrow header keeps the title, and its project selector becomes an icon that keeps the selection", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    mounted = mountBoard(
      invokeWith(board([f.long]), async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query(/^App, Board cards keep the title/)));
    // The board measures its own pane; 390 points is below the 720-point breakpoint.
    const measured = tree.raw
      .ofType("View")
      .find((node) => typeof node.props.onLayout === "function");
    assert.ok(measured, "the board measures its pane");
    measured!.props.onLayout({ nativeEvent: { layout: { width: 390 } } });

    assert.ok(
      tree.raw.query("Open the board menu"),
      "the menu button stays reachable",
    );
    assert.ok(
      tree.raw
        .ofType("Text")
        .some((node) => node.children.join("") === "Nucleus"),
      "the title stays visible",
    );
    const trigger = tree.raw.query(/^Projects, /);
    assert.ok(trigger, "the selector keeps its accessible label");
    assert.match(
      String(trigger!.props.accessibilityLabel),
      /^Projects, All projects$/,
      "and the label still names the selection",
    );
    assert.equal(
      nodeText(trigger as HostNode).trim(),
      "",
      "the selector shows its icon alone, so the row fits",
    );

    tree.raw.press(/^Projects, /);
    assert.ok(tree.raw.query("Project selector"), "the picker opens");
    tree.raw.press("Close project selector");
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a drained-lane row draws its controls inside the row, and the row opens its lane in Planning", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const lane = {
      id: "lane-1",
      key: "alpha",
      title: "Alpha lane",
      aim: "Done looks like alpha shipped.",
      status: "active",
      note: "",
      repositories: [repo],
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      drain: { since: at, notices: 1, lastNoticeAt: at, escalatedAt: at },
      keep: null,
      liveByPhase: {},
      liveByRepository: {},
      terminalCount: 0,
      lastActivityAt: at,
      recentOutcomes: [],
    };
    const snapshot = {
      ...board([]),
      lanes: [lane],
      projects: [
        {
          ...project,
          version: 1,
          primary: repo,
          drain: { since: at, notices: 1, lastNoticeAt: at, escalatedAt: at },
        },
      ],
    };
    const invoke = async (method: string, input: unknown) => {
      if (method === "queue.ui-snapshot") return snapshot;
      if (method === "queue.service-state") return serviceState;
      if (method === "queue.detail") return undefined;
      if (method === "task.next") return null;
      if (method === "queue.queued-page") return { tasks: [], hasMore: false };
      if (method === "queue.plans")
        return [
          {
            project: "app",
            version: 1,
            author: "planner-agent",
            createdAt: at,
            entries: [
              {
                lane: "alpha",
                note: "",
                horizon: "now",
                doneWhen: "Alpha shipped",
              },
            ],
          },
        ];
      if (method === "project.qa.list" || method === "host.run.list") return [];
      if (method === "host.run.board")
        return {
          runs: [],
          accounting: { readAt: at, entries: [], complete: true },
        };
      if (method === "lead.board") return { cards: [], links: [] };
      if (
        method === "papercut.list" ||
        method === "draft.list" ||
        method === "decision.list" ||
        method === "lane.task-page"
      )
        return method === "lane.task-page"
          ? { tasks: [], total: 0, nextOffset: null }
          : [];
      void input;
      return {};
    };
    mounted = mountBoard(invoke);
    const tree = mounted;
    await settle(() => tree.text().includes("Alpha lane has drained"));
    openView(tree, "Needs you");

    // Close and Keep draw inside the row's own sidebar frame (no dividers), not under it.
    const rowFrame = tree.raw
      .ofType("View")
      .find(
        (node) =>
          node.props.style?.borderRadius === 8 &&
          node.props.style?.marginHorizontal === 8 &&
          node.props.style?.borderBottomWidth === undefined &&
          node.props.style?.borderLeftWidth === undefined &&
          nodeHas(
            node,
            (child) =>
              child.props.accessibilityLabel ===
                "Mark drained lane alpha done",
          ) &&
          nodeHas(node, (child) =>
            /^Drained lane: Alpha lane, Status: Drained/.test(
              String(child.props.accessibilityLabel ?? ""),
            ),
          ),
      );
    assert.ok(rowFrame, "the drained-lane controls sit inside its row");
    assert.ok(
      nodeHas(
        rowFrame!,
        (child) => child.props.accessibilityLabel === "Keep drained lane alpha",
      ),
      "Keep sits in the row too",
    );
    // The row is the three-line anatomy (nucleus#1515): the kind and lane, the title,
    // the status; the lane's aim is in the plan view the row opens.
    assert.match(
      nodeText(rowFrame!),
      /^\s*Lane drained\s+App\s+\d+d ago\s+Alpha lane has drained\s+Drained\s+· plan owner has not answered\s+Mark done\s+Keep\s*$/,
    );
    assert.ok(
      nodeHas(
        rowFrame!,
        (child) => child.type === "Icon" && child.props.name === "Layers",
      ),
      "the drained lane draws its kind tile",
    );

    // Pressing the row opens its lane in Planning.
    tree.raw.press(/^Drained lane: Alpha lane,/);
    await settle(() => Boolean(tree.raw.query("Find lanes")));
    assert.ok(
      tree.raw
        .ofType("Text")
        .some((node) => node.children.join("") === "Planning"),
      "the board switches to Planning",
    );
    await settle(() => tree.raw.text().includes("Alpha lane"));
    // The lane it opens keeps the row's Nucleus-raised provenance (nucleus#1515).
    await settle(() =>
      Boolean(
        tree.raw.query(
          /^Nucleus-raised: Alpha lane drained and escalated to you/,
        ),
      ),
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a drained lane asks before it is marked done, and cancel writes nothing", async () => {
  const { LaneDrainCard } = await import("../client/board/cards");
  const calls: string[] = [];
  const lane = {
    key: "alpha",
    title: "Alpha lane",
    aim: "Done looks like alpha shipped.",
    status: "active",
    repositories: [repo],
    liveByPhase: { working: 2 },
    terminalCount: 0,
    lastActivityAt: at,
    recentOutcomes: [],
    drain: { since: at, notices: 1, lastNoticeAt: at, escalatedAt: at },
  } as unknown as LaneView;
  const projects = [{ ...project, name: "App" }] as Project[];
  const plans = [
    {
      project: "app",
      version: 1,
      author: null,
      createdAt: at,
      entries: [{ lane: "alpha", note: "", horizon: "now" }],
    },
  ] as unknown as ProjectPlan[];
  const ui = mount(
    h(LaneDrainCard, {
      lane,
      selected: false,
      onPress: () => {},
      c,
      busy: false,
      onClose: () => calls.push("done"),
      onKeep: () => {},
      projects,
      plans,
    }),
  );
  ui.press("Mark drained lane alpha done");
  assert.ok(ui.get("Mark Alpha lane done"), "marking done asks first");
  assert.match(
    ui.text(),
    /It moves to Finished lanes on every plan that lists it\. You can reopen it\./,
  );
  assert.match(ui.text(), /App \(Now\)/);
  assert.match(ui.text(), /2 live tasks/);
  assert.deepEqual(calls, [], "the confirmation writes nothing until it is confirmed");
  ui.press("Cancel marking Alpha lane done");
  assert.equal(ui.query("Mark Alpha lane done"), undefined);
  assert.deepEqual(calls, [], "cancel writes nothing");
  ui.press("Mark drained lane alpha done");
  ui.press("Mark Alpha lane done");
  assert.deepEqual(calls, ["done"]);
});

test("a task row keeps one status line and no host identity, while the detail keeps the routing", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  let detail: ReturnType<typeof mount> | undefined;
  try {
    const routing =
      "Profile Worker runs on online host t3code:task; not ruled out on srv_1, which is not ready";
    const task = seed(store, "host-waiting", { phase: "working" });
    const summary = {
      ...summarizeTask(store.task(task.id)),
      hostId: "t3code:32be2844",
      hostWait: { hostId: "t3code:32be2844", since: at },
      hostReason: routing,
    };
    mounted = mountBoard(
      invokeWith(board([summary]), async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(() => tree.text().includes("host-waiting"));
    // Visiting every view leaves the last one open; the wrapped lookup
    // navigates back to the card's own view first.
    const row = tree.all(/, host-waiting,/)[0];
    assert.ok(row, "the task row is on the board");
    const text = nodeText(row as HostNode);
    assert.equal(text.match(/on the host/g)?.length, 1, "the wait reads once");
    assert.match(
      text,
      /Waiting\s+· on the host/,
      `the status line names the wait: ${text}`,
    );
    assert.doesNotMatch(
      text,
      /T3Code host/,
      "the host identity stays off the row",
    );
    assert.ok(
      !text.includes("not ruled out"),
      "the routing sentence stays off the row",
    );
    assert.ok(
      !text.includes(routing),
      "the row carries no routing explanation",
    );
    // The accessible name follows the row: the wait and its age, never the outage
    // host's identity, its exact start time or the routing sentence.
    const label = String((row as HostNode).props.accessibilityLabel);
    assert.match(label, /Waiting on the host · \d+d ago/);
    assert.doesNotMatch(
      label,
      /32be2844|T3Code host/,
      "no host identifier in the label",
    );
    assert.ok(!label.includes(at), "no exact outage time in the label");
    assert.ok(
      !label.includes("not ruled out"),
      "no routing sentence in the label",
    );

    // The task detail keeps the host selection and the reason behind it.
    const { taskDetailView } = await import("../shared/task-view");
    const detailView = taskDetailView(store.task(task.id), {}, [], []);
    detail = mount(
      h(queue.TaskSummaryBlock as never, {
        // The detail's host selection is the summary's routing reason, shown in full.
        task: {
          ...detailView,
          hostSelection: {
            basis: "worker_profile" as const,
            hostId: "t3code:32be2844",
            reason: routing,
          },
        },
        next: null,
        runs: [],
        c,
      }),
    );
    assert.ok(
      detail.text().includes("not ruled out"),
      "the detail keeps the routing explanation",
    );
  } finally {
    detail?.update(h("View", null));
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a host-waiting task keeps an owner-facing stop's detail in its one row line", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const summary = {
      ...f.stopped,
      hostId: "t3code:32be2844",
      hostWait: { hostId: "t3code:32be2844", since: at },
    };
    mounted = mountBoard(
      invokeWith(board([summary]), async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(() =>
      tree.text().includes("Operator decides whether to restart"),
    );
    openView(tree, "Needs you");
    const row = tree.raw
      .all(/.*/)
      .find((node) =>
        String(node.props.accessibilityLabel ?? "").includes(", stopped,"),
      );
    assert.ok(row, "the stopped task's row is on the board");
    const text = nodeText(row as HostNode);
    assert.match(
      text,
      /Operator decides whether to restart/,
      "the owner-facing stop keeps its detail",
    );
    assert.match(
      text,
      /Needs attention\s+· Operator decides whether to restart · waiting on the host/,
      `and the host wait is still named: ${text}`,
    );
    assert.doesNotMatch(
      text,
      /T3Code host/,
      "the host identity stays off the row",
    );
    // Both facts ride the row's single status line, not two lines.
    const status = tree.raw
      .ofType("Text")
      .find((node) =>
        nodeText(node).includes("Operator decides whether to restart"),
      );
    assert.ok(status, "the detail is drawn");
    assert.match(
      nodeText(status as HostNode),
      /waiting on the host/,
      "the row's one line carries the stop and the wait",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("single-kind views drop the kind word from line 1; mixed lists keep it", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = [
      triageLead("idea-lead", "Idea lead", { tags: ["idea"] }),
      triageLead("tiny-cut", "Tiny papercut", { tags: ["papercut"] }),
    ];
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query(/^Lead: Idea lead, Status: /)));
    openView(tree, "Leads");
    const card = tree.raw.query(/^Lead: Idea lead, Status: /) as HostNode;
    assert.ok(card, "the lead row is listed");
    assert.equal(
      nodeText(card).match(/\bLead\b/g)?.length,
      undefined,
      "the Leads view drops the kind word; the label keeps it",
    );
    assert.match(nodeText(card), /^\s*App\s/, "line 1 starts with the project");
    openView(tree, "Papercuts");
    const cut = tree.raw.query(
      /^Papercut: Tiny papercut, Status: /,
    ) as HostNode;
    assert.ok(cut, "the papercut row is listed");
    assert.equal(nodeText(cut).match(/\bPapercut\b/g)?.length, undefined);
    // A list that mixes kinds keeps the kind word: the shared row defaults to showing it.
    const mixed = mount(
      h(queue.TriageLeadCard as never, {
        lead: leads[0],
        c,
        selected: false,
        onSelectLead: () => {},
        onSelectPapercut: () => {},
      }),
    );
    try {
      assert.ok(
        mixed.ofType("Text").some((node) => node.children.join("") === "Lead"),
        "a mixed list keeps the kind word on line 1",
      );
      const bare = mount(
        h(queue.TriageLeadCard as never, {
          lead: leads[0],
          c,
          selected: false,
          onSelectLead: () => {},
          onSelectPapercut: () => {},
          showKindWord: false,
        }),
      );
      try {
        assert.ok(
          !bare
            .ofType("Text")
            .some((node) => node.children.join("") === "Lead"),
          "a single-kind list drops it",
        );
      } finally {
        bare.update(h("View", null));
      }
    } finally {
      mixed.update(h("View", null));
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a task needing attention on Needs you draws the task tile and its reference in the one list", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const task = seed(store, "blocked-task", { phase: "blocked" });
    const summary = {
      ...summarizeTask(store.task(task.id)),
      phase: "blocked" as const,
    };
    mounted = mountBoard(
      invokeWith(board([summary]), async () => ({ tasks: [], hasMore: false })),
    );
    const tree = mounted;
    await settle(() => tree.text().includes("blocked-task"));
    // Reading every view leaves the last one open, so open Needs you before reading its list.
    openView(tree, "Needs you");
    assert.ok(tree.raw.query("Needs you list"), "Needs you is one list");
    const rowNode = tree.raw.query(/^App, blocked-task,/) as HostNode;
    assert.ok(rowNode, "the task row is listed");
    assert.ok(
      nodeHas(
        rowNode,
        (child) => child.type === "Icon" && child.props.name === "ListChecks",
      ),
      "the row draws the task kind tile",
    );
    assert.match(
      nodeText(rowNode),
      new RegExp(`^\\s*#${String(summary.number).padStart(3, "0")}\\s+App\\s`),
      "line 1 leads with the task reference, then the project",
    );
    assert.equal(
      tree.raw.query(/ section, \d+$/),
      undefined,
      "Needs you has no section headers",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("Planning lists its projects as inbox rows, grouped, with the selected surface on the open one", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const second = {
      key: "second",
      name: "Second",
      repositories: [{ origin: "owner/second", path: "/second" }],
      primary: { origin: "owner/second", path: "/second" },
    };
    const sleepy = {
      key: "sleepy",
      name: "Sleepy",
      repositories: [{ origin: "owner/sleepy", path: "/sleepy" }],
      primary: { origin: "owner/sleepy", path: "/sleepy" },
    };
    const plan = (name: string, projectKey: string) => ({
      project: projectKey,
      version: 1,
      author: "planner-agent",
      createdAt: at,
      entries: [{ lane: name, note: "", horizon: "now", doneWhen: "It ships" }],
    });
    // Store-wide activity keeps two projects out of Planning's Dormant group; the
    // third has none and lists under it (nucleus#1511's gutter check).
    const snapshot = {
      ...board([]),
      projects: [project, second, sleepy],
      projectActivity: recentProjectActivity([project, second]),
    };
    mounted = mountBoard(async (method: string) => {
      if (method === "queue.ui-snapshot") return snapshot;
      if (method === "queue.service-state") return serviceState;
      if (method === "queue.detail") return undefined;
      if (method === "task.next") return null;
      if (method === "queue.plans")
        return [plan("lane-a", "app"), plan("lane-b", "second")];
      if (method === "project.qa.list" || method === "host.run.list") return [];
      if (method === "host.run.board")
        return {
          runs: [],
          accounting: { readAt: at, entries: [], complete: true },
        };
      if (method === "lead.board") return { cards: [], links: [] };
      return [];
    });
    const tree = mounted;
    await settle(() => Boolean(tree.raw.query("Nucleus header controls")));
    openView(tree, "Planning");
    await settle(() => Boolean(tree.raw.query("Project row Second")));
    // nucleus#1531: inbox rows with no divider or card frame; the open row takes the selected surface.
    const row = (name: string) => tree.raw.get(`Project row ${name}`);
    const style = (name: string) =>
      row(name).props.style as {
        borderWidth?: number;
        borderBottomWidth?: number;
        backgroundColor?: string;
      };
    assert.equal(
      style("App").borderWidth,
      undefined,
      "no card border inside the list pane",
    );
    assert.equal(
      style("App").borderBottomWidth,
      undefined,
      "no divider between rows",
    );
    assert.equal(
      row("App").props.accessibilityState.selected,
      true,
      "the first active project opens beside the list",
    );
    assert.equal(style("App").backgroundColor, dark.surface2);
    assert.equal(
      style("Second").backgroundColor,
      "transparent",
      "a closed row has no background at rest",
    );
    tree.raw.press("Project row Second");
    await settle(
      () => row("Second").props.accessibilityState.selected === true,
    );
    assert.equal(style("Second").backgroundColor, dark.surface2);
    assert.ok(tree.raw.query("Plan for Second"));
    // The project with no recent activity lists under Dormant.
    assert.ok(
      tree.raw.query("Dormant projects"),
      "the dormant project is grouped",
    );
    assert.ok(
      nodeHas(
        tree.raw.get("Dormant projects"),
        (child) => child.props.accessibilityLabel === "Project row Sleepy",
      ),
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a resumed-thread count never adds a header pill", async () => {
  const { headerStatePills } = await import("../client/board/header");
  const state = {
    connected: true,
    paused: false,
    quiet: true,
    dispatchHeld: false,
    stoppedThreads: 0,
    resumedThreads: 3,
    operationBacklog: 0,
  };
  assert.deepEqual(
    headerStatePills(state as never),
    [],
    "the resumed count survives a restart with nothing to act on, so it earns no pill",
  );
  assert.deepEqual(
    headerStatePills({ ...state, stoppedThreads: 2 } as never).map(
      (pill) => pill.label,
    ),
    ["2 waiting to resume"],
    "stopped threads keep their pill",
  );
});

// nucleus#1515 (Tom, 2026-11-21): every card is the same three-line row — the kind tile,
// line 1 (reference or kind, project, age), the title, one status line — with flags only
// for exceptions and buttons only where the row is the action.
test("every card kind draws the three-line row, with flags only for exceptions and actions only on prompts", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const normal = seed(store, "plain-working", {
      phase: "working",
      reason: "Worker is editing",
    });
    const withPr = seed(store, "with-pr", {
      phase: "reviewing",
      reason: "Reviewer reading the diff",
    });
    const held = seed(store, "merge-ready", {
      phase: "merging",
      reason: "Waiting for merge",
      ...syncHoldProjection({ merge: fence("receipt pending") }),
    });
    const summary = (id: string) => summarizeTask(store.task(id));
    const number = (id: string) =>
      `#${String(store.task(id).number).padStart(3, "0")}`;
    const tasks = [
      summary(normal.id),
      { ...summary(withPr.id), prUrl: "https://github.com/owner/app/pull/39" },
      {
        ...summary(held.id),
        holdEscalated: true,
        hold: { owner: "operator", reason: "receipt pending", since: at },
      },
    ];
    const decision = {
      id: "decision-row",
      version: 1,
      question: "Ship the row redesign this week?",
      headline: "Ship the row redesign this week?",
      choices: [
        { label: "Ship", consequence: "" },
        { label: "Wait", consequence: "" },
      ],
      recommended: "Ship",
      details: null,
      context: null,
      options: [],
      recommendation: null,
      overtakenBy: [],
      askedBy: { agentId: "agent-asker", project: null },
      askerLabel: "the App planner",
      links: { tasks: [], leads: [], papercuts: [] },
      status: "open",
      answer: null,
      withdrawal: null,
      supersededBy: null,
      delivery: null,
      createdAt: at,
      updatedAt: at,
      versions: [],
      stale: false,
      projectKey: "app",
    };
    const calls: Array<{ method: string; input: unknown }> = [];
    // The decision read is cached per board revision, so this board has its own.
    const base = invokeWith(
      { ...board(tasks), revision: 1515 },
      async () => ({ tasks: [], hasMore: false }),
      [],
      [decision],
    );
    for (const compact of [true, false]) {
      mounted?.update(h("View", null));
      mounted = mountBoard(async (method, input) => {
        if (method === "queue.task") {
          calls.push({ method, input });
          return { ok: true };
        }
        return base(method, input);
      }, compact);
      const tree = mounted;
      await settle(
        () =>
          Boolean(tree.query(/^App, plain-working,/)) &&
          Boolean(tree.query(/^Decision: Ship the row/)),
      );
      const row = (label: RegExp) => {
        const node = tree.query(label) as HostNode | undefined;
        assert.ok(node, `${label} is listed`);
        return node!;
      };
      const tile = (node: HostNode, icon: string) =>
        nodeHas(
          node,
          (child) => child.type === "Icon" && child.props.name === icon,
        );

      // A normal task: reference and project, the title, its phase and report. No flags.
      const plain = row(/^App, plain-working,/);
      assert.ok(tile(plain, "ListChecks"), "a task row draws the task tile");
      assert.match(
        nodeText(plain),
        new RegExp(
          `^\\s*${number(normal.id)}\\s+App\\s+just now\\s+plain-working\\s+Working\\s+· Worker is editing\\s*$`,
        ),
        "a normal task is three lines and shows no flags",
      );
      assert.match(
        String(plain.props.accessibilityLabel),
        /plain-working.*Status: Working/,
        "the accessible label keeps the title and the status",
      );

      // The PR is a small flag after the status line, outside the task button, so the
      // link and the button are separate focusable controls.
      const prButton = row(/^App, with-pr,/);
      const pr = rowFrame(tree.raw, /^App, with-pr,/)!;
      assert.ok(pr, "the row frame holds the button and its flags");
      assert.match(
        nodeText(pr),
        /In review\s+· Reviewer reading the diff\s+#39\s*$/,
        "the PR rides as the one flag",
      );
      assert.ok(
        !nodeHas(prButton, (child) => child.props.accessibilityRole === "link"),
        "the PR link is not nested inside the task button",
      );
      assert.ok(
        nodeHas(pr, (child) =>
          /^Pull request #39, /.test(
            String(child.props.accessibilityLabel ?? ""),
          ),
        ),
        "the PR flag names its state accessibly",
      );

      // A decision: the kind in words, the project, the age; then the question and who asked.
      const asked = row(/^Decision: Ship the row redesign this week\?/);
      assert.ok(
        tile(asked, "CircleHelp"),
        "a decision draws the decision tile",
      );
      assert.match(
        nodeText(asked),
        /^\s*Decision\s+General\s+\d+d ago\s+Ship the row redesign this week\?\s+Your answer\s+· asked by the App planner\s*$/,
        `a decision is three lines; its choices stay in the detail: ${nodeText(asked)}`,
      );

      // A merge hold prompt: the kind and reference, the title, ready-to-merge and why it is held, then Release and Keep.
      openView(tree.raw, "Needs you");
      const holdRow = row(
        /^Merge hold: merge-ready, App, Status: Ready to merge · held for receipt pending, owner operator$/,
      );
      assert.ok(
        tile(holdRow, "CirclePause"),
        "a hold prompt draws the hold tile",
      );
      assert.match(
        nodeText(holdRow),
        new RegExp(
          `^\\s*Merge hold · ${number(held.id)}\\s+App\\s+\\d+d ago\\s+merge-ready\\s+Ready to merge\\s+· held for receipt pending\\s*$`,
        ),
      );
      assert.ok(
        !tree.raw.text().includes("Nucleus-raised"),
        "the Nucleus-raised chip moved to the detail",
      );
      tree.raw.press("Keep");
      assert.ok(
        tree.raw.query("Why keep the hold (required)"),
        "Keep asks for its reason",
      );
      tree.raw.press("Release");
      await settle(() => calls.length > 0);
      assert.deepEqual(
        (calls.at(-1)!.input as { action: string }).action,
        "release",
        "Release still releases the hold",
      );
      calls.length = 0;
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1515 review: what the row keeps when another fact wins the status line, the
// lead's current check, the named project and age on line 1, and full accessible names.
test("rows keep holds behind another status, a failed recheck, named projects with ages, and full labels", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const uuidTitle = "Rename 7a3c4bc4-e0db-48bb-9071-4ae6f3a09222 everywhere";
    const heldAway = seed(store, "held-and-away", {
      phase: "queued",
      reason: "Waiting for dispatch",
      ...syncHoldProjection({ dispatch: fence("Planner ruling owed.") }),
    });
    const titled = seed(store, "uuid-title", {
      title: uuidTitle,
      phase: "working",
      reason: "Worker is editing",
    });
    const mentioned = seed(store, "fenced-working", {
      phase: "working",
      reason: "Worker is editing",
      ...syncHoldProjection({ dispatch: fence("Planner ruling owed.") }),
    });
    const tasks = [
      {
        ...summarizeTask(store.task(heldAway.id)),
        hostId: "t3code:32be2844",
        hostWait: { hostId: "t3code:32be2844", since: at },
      },
      {
        ...summarizeTask(store.task(titled.id)),
        prUrl: "https://github.com/owner/app/pull/41",
      },
      // A report that merely mentions a hold never hides the live fence's flag.
      {
        ...summarizeTask(store.task(mentioned.id)),
        headline: "Dispatch held was discussed with the planner",
      },
    ];
    // Sixteen matched projects: line 1 draws two marks and a count, never sixteen.
    const many = Array.from({ length: 16 }, (_, index) => ({
      origin: `owner/proj-${index}`,
      path: `/proj-${index}`,
    }));
    const leads = [
      {
        ...triageLead("wide", "Spans many projects", {
          tags: ["idea"],
          repositories: many,
        }),
        createdAt: at,
      },
      {
        ...triageLead("rechecked", "Rechecked lead", {
          tags: ["idea"],
          check: { ok: false },
          approved: true,
        }),
        createdAt: at,
      },
    ];
    const decision = {
      id: "decision-badged",
      version: 1,
      question: "Which repo hosts the badge?",
      choices: [
        { label: "This one", consequence: "" },
        { label: "Another", consequence: "" },
      ],
      recommended: "This one",
      details: null,
      context: null,
      options: [],
      recommendation: null,
      overtakenBy: [],
      askedBy: { agentId: "agent-asker", project: repo },
      askerLabel: "the App planner",
      links: { tasks: [], leads: [], papercuts: [] },
      status: "open",
      answer: null,
      withdrawal: null,
      supersededBy: null,
      delivery: null,
      createdAt: at,
      updatedAt: at,
      versions: [],
      stale: false,
      projectKey: "app",
    };
    const snapshot = {
      ...board(tasks),
      revision: 1516,
      repositoryBadges: {
        [repo.path]: { monogram: "AP", color: "fuchsia" as const },
        ...Object.fromEntries(
          many.map((item, index) => [
            item.path,
            { monogram: `P${index}`, color: "amber" as const },
          ]),
        ),
      },
      pendingSubmissions: [
        {
          id: "op-1",
          submissionId: "sub-1",
          title: "Freshly submitted",
          repoPath: "/app",
          repository: "owner/app",
          lanes: [],
          state: "pending" as const,
          createdAt: at,
        },
      ],
    };
    mounted = mountBoard(
      invokeWith(snapshot, async () => ({ tasks: [], hasMore: false }), leads, [
        decision,
      ]),
    );
    const tree = mounted;
    await settle(
      () =>
        Boolean(tree.query(/^App, held-and-away,/)) &&
        Boolean(tree.query(/^Decision: Which repo hosts the badge\?/)),
    );

    // A host wait wins the status line, so the dispatch hold stays visible as a flag.
    tree.query(/^App, held-and-away,/);
    const away = rowFrame(tree.raw, /^App, held-and-away,/)!;
    assert.match(nodeText(away), /Waiting\s+· on the host/);
    assert.match(
      nodeText(away),
      /Dispatch held\s*$/,
      "the hold the status does not name stays a flag",
    );

    // The record's own title is announced as written, with the status and its detail.
    const titledRow = tree.query(/^App, Rename 7a3c4bc4/) as HostNode;
    assert.ok(titledRow, "the label keeps the actual title");
    assert.match(
      String(titledRow.props.accessibilityLabel),
      new RegExp(
        `^App, ${uuidTitle}, Working, .*Status: Working · Worker is editing, Action: open task details$`,
      ),
    );

    // A failed recheck wins over a retained approval; the lead row carries its age and full status.
    const lead = tree.query(/^Lead: Rechecked lead,/) as HostNode;
    assert.equal(
      lead.props.accessibilityLabel,
      "Lead: Rechecked lead, Status: Checks failed · brief needs revising",
    );
    assert.match(
      nodeText(lead),
      /^\s*AP\s+App\s+\d+d ago\s+Rechecked lead\s+Checks failed\s+· brief needs revising\s*$/,
    );

    // A decision from a T3-matched repository draws that project's badge.
    const asked = tree.query(
      /^Decision: Which repo hosts the badge\?/,
    ) as HostNode;
    assert.ok(
      nodeHas(
        asked,
        (child) => child.type === "Text" && child.children.join("") === "AP",
      ),
      "the decision's asking repository shows its T3 badge",
    );

    // A live fence keeps its flag even when the report headline mentions it.
    tree.query(/^App, fenced-working,/);
    const fenced = rowFrame(tree.raw, /^App, fenced-working,/)!;
    assert.match(
      nodeText(fenced),
      /Working\s+· Dispatch held was discussed with the planner\s+Dispatch held\s*$/,
      "the status is Working, so the dispatch fence stays a flag",
    );

    // The PR flag is a link: it opens the pull request and leaves the row's selection alone.
    const { Linking } = (await import("react-native")) as unknown as {
      Linking: { opened: string[] };
    };
    Linking.opened.length = 0;
    tree.raw.press(/^Pull request #41, .*, open on GitHub$/);
    assert.deepEqual(Linking.opened, ["https://github.com/owner/app/pull/41"]);
    assert.equal(
      tree.raw.query(/^(Task detail|Loading detail)$/),
      undefined,
      "opening the PR does not open the task",
    );

    // A decision names its asking project by its display name.
    assert.match(nodeText(asked), /^\s*Decision\s+AP\s+App\s+\d+d ago/);

    // A pending submission names its project and carries its age.
    const submitted = tree.query(/^Queued: Freshly submitted,/) as HostNode;
    assert.match(
      nodeText(submitted),
      /^\s*Submitting\s+AP\s+App\s+\d+d ago\s+Freshly submitted\s+Submitting/,
    );
    // Many projects stay inside line 1: two marks, a count, and the age keeps its place,
    // at the board's measured narrow layout (390 points, below the 720 breakpoint).
    openView(tree.raw, "Leads");
    const pane = tree.raw
      .ofType("View")
      .find((node) => typeof node.props.onLayout === "function");
    assert.ok(pane, "the board measures its pane");
    pane!.props.onLayout({ nativeEvent: { layout: { width: 390 } } });
    assert.ok(
      tree.raw.query("Open the board menu"),
      "the board is in its narrow layout",
    );
    const wide = tree.raw.query(/^Lead: Spans many projects,/) as HostNode;
    const marks = (node: HostNode): number =>
      (node.type === "Text" && /^P\d+$/.test(node.children.join("")) ? 1 : 0) +
      node.children.reduce(
        (sum, child) => sum + (typeof child === "string" ? 0 : marks(child)),
        0,
      );
    assert.equal(
      marks(wide),
      2,
      `two project marks are drawn: ${nodeText(wide)}`,
    );
    assert.match(
      nodeText(wide),
      /proj-1\s+\+14\s+\d+d ago\s+Spans many projects/,
    );
    const group = (node: HostNode): HostNode | undefined =>
      node.type === "View" && node.props.style?.overflow === "hidden"
        ? node
        : node.children
            .filter((child): child is HostNode => typeof child !== "string")
            .map(group)
            .find(Boolean);
    const projectGroup = group(wide);
    assert.ok(projectGroup, "the project group is one bounded unit");
    assert.equal(projectGroup!.props.style.flexShrink, 1);
    assert.equal(projectGroup!.props.style.minWidth, 0);
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// nucleus#1515 review: the engine keeps an owner-facing stop and records the task's
// own host outage beside it; the row reads "on the host", so the detail names both.
test("task detail shows an owner-facing stop and the independent host wait together", async () => {
  await load();
  const store = new Store(":memory:");
  let detail: ReturnType<typeof mount> | undefined;
  try {
    const { taskDetailView } = await import("../shared/task-view");
    const { taskNextSchema } = await import("../shared/contracts");
    const task = seed(store, "budget-and-away", { phase: "blocked" });
    const view = taskDetailView(store.task(task.id), {}, [], []);
    const next = taskNextSchema.parse({
      taskId: task.id,
      title: "budget-and-away",
      phase: "blocked",
      version: 1,
      repository: null,
      number: null,
      reference: null,
      attention: true,
      reason: "Budget reached",
      activeRun: null,
      prHead: null,
      prUrl: null,
      branch: "ns-task",
      stop: {
        kind: "attention",
        reason: "operator_needed",
        detail: "Budget reached; raise it or stop the task",
        since: at,
        suggestedVerbs: [],
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
      verbs: [],
    });
    detail = mount(
      h(queue.TaskSummaryBlock as never, {
        task: {
          ...view,
          resolution: {
            ...view.resolution,
            hostWait: { hostId: "t3code:32be2844", since: at },
          },
        },
        next,
        runs: [],
        c,
      }),
    );
    assert.match(
      detail.text(),
      /Budget reached; raise it or stop the task/,
      "the stop keeps its detail",
    );
    const hostWait = detail.query(/^Host wait: waiting on .+ since /);
    assert.ok(hostWait, "the independent host wait is in the detail too");
    assert.match(
      String(hostWait!.props.accessibilityLabel),
      new RegExp(`since ${at}$`),
    );
    assert.match(detail.text(), /Waiting on .+ · \d+d ago/);
  } finally {
    detail?.update(h("View", null));
    store.close();
  }
});
