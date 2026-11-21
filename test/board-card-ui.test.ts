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
  queuedPage: () => Promise<unknown>,
  leads: unknown[] = [],
  decisions: unknown[] = [],
) {
  return async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return snapshot;
    if (method === "queue.service-state") return serviceState;
    if (method === "queue.detail") return undefined;
    if (method === "task.next") return null;
    if (method === "queue.queued-page") return queuedPage();
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
        .includes(
          "Operator decides whether to restart · Your decision is next",
        ),
      "the row's one status line says what is happening and who moves it next",
    );
    assert.ok(
      !tree.text().includes("operator_needed") &&
        !tree.text().includes("next: restart, route"),
      "technical stop mechanics stay off the card",
    );
    assert.match(
      tree.text(),
      /Waiting for QA capacity · position 2/,
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

    // Real totals and the in-column overflow card: the project's 12 queued tasks, three loaded.
    assert.ok(
      tree.text().includes("…and 9 more"),
      "the overflow card carries the server total",
    );

    // Long content: the full title stays in the accessible label, and the visible title is capped at two lines.
    assert.ok(
      tree.query(new RegExp(`^app, ${LONG_TITLE.slice(0, 40)}`)),
      "the accessible label names the whole task",
    );
    const stoppedLabel = tree.query(/^app, stopped,/)?.props
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
      assert.ok(
        tree.query(/^app, Board cards keep the title/),
        `the ${label} card keeps its accessible label`,
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
      assert.equal(
        emptyChipRows(tree.get(/^app, Board cards keep the title/) as HostNode),
        0,
        `the ${label} card has no empty chips row`,
      );
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a T3Code task card names the host on the eyebrow and in its accessible label", async () => {
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
      assert.match(ui.text(), /T3Code/);
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
            "Hold reason preview · The planner needs to record the source ruling.",
          ),
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
    await settle(() => Boolean(tree.query(/^app, empty-card,/)));
    const card = tree.query(/^app, empty-card,/) as HostNode;
    assert.equal(
      emptyChipRows(card),
      0,
      "a suppressed stop leaves no empty chips row",
    );
    assert.ok(
      tree.query(/^app, empty-card, Attention/),
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
        reason: "run_stalled" as const,
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
      assert.ok(tree.text().includes("Dispatch held by App planner"));
      assert.ok(tree.text().includes("Merge held by App planner"));
      assert.match(tree.text(), /Held · \d+d ago/);
      assert.ok(
        !tree
          .query(/^app, progress,/)
          ?.props.accessibilityLabel?.includes("no owner verb"),
      );
      const prerequisiteLabel = tree.query(/^app, dependency,/)?.props
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
          .query(/^app, progress,/)
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
      await settle(() => Boolean(tree.query(/^app, reason-card,/)));
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
      const label = tree.query(/^app, long-command,/)?.props
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

test("the overflow card shows loading, then an error, while its queued page loads", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const f = fixtures(store);
    const snapshot = board(
      [f.held, f.heavy, f.queued],
      [{ repoPath: "/app", count: 12 }],
    );
    // Loading: the page does not answer yet.
    mounted = mountBoard(
      invokeWith(snapshot, () => new Promise(() => undefined)),
    );
    let tree = mounted;
    await settle(() => Boolean(tree.query("9 more queued in app")));
    tree.press("9 more queued in app");
    await settle(() => tree.text().includes("Loading queued tasks…"));
    mounted.update(h("View", null));

    // Error: the page refuses; the overflow says so.
    mounted = mountBoard(
      invokeWith(snapshot, async () => {
        throw new Error("queue unavailable");
      }),
    );
    tree = mounted;
    await settle(() => Boolean(tree.query("9 more queued in app")));
    tree.press("9 more queued in app");
    await settle(() =>
      tree.text().includes("Could not load queued tasks. Try again."),
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
  // The title is capped at two lines and carries the short number, never the multi-repo reference.
  assert.match(
    card,
    /numberOfLines=\{2\}\s+style=\{\{\s*color:\s*c\.foreground,\s*fontWeight:\s*"600"/,
  );
  assert.match(card, /taskNumberLabel\(task, false\)/);
  assert.doesNotMatch(card, /repoChip|phaseChip|laneChips|profile\?\.name/);
  // The board call site passes only what the card still uses.
  const call = ui.slice(
    ui.indexOf("<TaskCard"),
    ui.indexOf("/>", ui.indexOf("<TaskCard")),
  );
  assert.doesNotMatch(call, /phaseChip|repoChip|laneChips/);
  assert.match(card, /return\s*\(?\s*<BoardCard/);
  assert.match(
    card,
    /Hold reason preview · \{holdReasonPreview\(dispatchWait\.reason\)\}/,
  );
  assert.match(ui, /Stop category · \{taskSummaryStop\.reason\}/);
  assert.match(
    ui,
    /Suggested owner verbs · \{taskSummaryStop\.suggestedVerbs\.join\(\", \"\)\}/,
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
  Array.from({ length: count }, (_, index) => {
    const letter = "abcdefghijklmnop"[index];
    return triageLead(`cut-${letter}`, `Papercut ${letter}`, {
      tags: ["papercut"],
    });
  });

test("a long papercut and a long lead render as one-line rows with a project and one state line", async () => {
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
    await settle(() => tree.text().includes("Checks passed · unapproved"));
    const text = tree.text();
    assert.ok(
      tree.query(`Triage: ${LONG_CUT}`),
      "the papercut card keeps its accessible label",
    );
    assert.match(text, /Open · board/, "a papercut states its area");
    // Papercuts and Leads are their own lists, so their rows do not repeat the kind (nucleus#1511).
    openView(tree, "Papercuts");
    const cutRow = tree.raw.query(`Triage: ${LONG_CUT}`);
    assert.ok(cutRow, "the papercut row is listed on its own view");
    assert.doesNotMatch(
      nodeText(cutRow as HostNode),
      /\bPapercut\b/,
      "no kind chip repeats the list",
    );
    assert.ok(
      !text.includes("What happened"),
      "the body passage stays in the record",
    );
    // Leads and papercuts are separate menu views, each a list of one-line rows.
    for (const [title, view] of [
      [LONG_CUT, "Papercuts"],
      [LONG_TITLE, "Leads"],
    ] as const) {
      openView(tree, view);
      const lines = tree
        .ofType("Text")
        .filter((node) => node.children.join("") === title)
        .map((node) => node.props.numberOfLines);
      assert.deepEqual(
        lines,
        [1],
        `the title "${title.slice(0, 24)}…" is one line`,
      );
    }
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// Tom, 2026-11-07: Triage pages; on the inbox the Leads and Papercuts lists keep the pages of eight.
test("Papercuts show a page of eight, an in-list row loads the rest, and the menu shows the real total", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    mounted = mountBoard(
      invokeWith(
        board([]),
        async () => ({ tasks: [], hasMore: false }),
        triagePapercuts(10),
      ),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Papercuts, 10")));
    openView(tree, "Papercuts");
    assert.equal(
      tree.all(/^Triage: Papercut /).length,
      8,
      "the first page holds eight cards",
    );
    assert.ok(
      tree.text().includes("…and 2 more"),
      "the overflow row carries the rest of the total",
    );
    tree.press("Show 2 more papercuts");
    await settle(() => tree.raw.all(/^Triage: Papercut /).length === 10);
    assert.equal(
      tree.raw.query("Show 2 more papercuts"),
      undefined,
      "no overflow row once every card shows",
    );
    assert.ok(tree.query("Papercuts, 10"), "paging leaves the total alone");
    assert.ok(tree.query("Leads, 0"), "the Leads entry counts only leads");
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("Leads show a page of eight, an in-list row loads the rest, and the menu counts every lead", async () => {
  await load();
  const store = new Store(":memory:");
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    const leads = Array.from({ length: 10 }, (_, index) => {
      const letter = "abcdefghijklmnop"[index];
      return triageLead(`idea-${letter}`, `Idea ${letter}`, { tags: ["idea"] });
    });
    mounted = mountBoard(
      invokeWith(board([]), async () => ({ tasks: [], hasMore: false }), leads),
    );
    const tree = mounted;
    await settle(() => Boolean(tree.query("Leads, 10")));
    openView(tree, "Leads");
    assert.equal(
      tree.all(/^Triage: Idea /).length,
      8,
      "the first page holds eight leads",
    );
    assert.ok(
      tree.text().includes("…and 2 more"),
      "the overflow row carries the rest of the total",
    );
    tree.press("Show 2 more leads");
    await settle(() => tree.raw.all(/^Triage: Idea /).length === 10);
    assert.equal(
      tree.raw.query("Show 2 more leads"),
      undefined,
      "no overflow row once every lead shows",
    );
    assert.ok(tree.query("Leads, 10"), "paging leaves the total alone");
    assert.ok(
      tree.query("Papercuts, 0"),
      "the Papercuts entry counts only papercuts",
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
          !contains(row, labelled("Triage: ")),
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

test("the Leads tag filter narrows the leads and their paging; papercuts have no filter and the menu count stays the inbox total", async () => {
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
    await settle(() => Boolean(tree.query("Triage: Idea lead")));
    assert.equal(
      tree.all(/^Triage: (Papercut|Plain)/).length,
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
      tree.all(/^Triage: Papercut /).length,
      8,
      "the first page of papercuts shows eight",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

// #1042 review: the list's view state lives in the shell, so a visit to another view keeps it.
test("the Leads tag, Papercuts page and open queued-more page survive a round trip to Planning", async () => {
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
      invokeWith(
        board([], [{ repoPath: "/app", count: 3 }]),
        async () => ({ tasks: [], hasMore: false }),
        leads,
      ),
    );
    const tree = mounted;
    await settle(
      () =>
        Boolean(tree.query("Papercuts, 10")) &&
        Boolean(tree.query("3 more queued in app")),
    );
    openView(tree, "Papercuts");
    tree.press("Show 2 more papercuts");
    await settle(() => tree.raw.all(/^Triage: Papercut /).length === 10);
    openView(tree, "Queue");
    tree.press("3 more queued in app");
    await settle(() => Boolean(tree.raw.query("Previous")));
    openView(tree, "Planning");
    await settle(() => !tree.raw.query("Queue list"));
    openView(tree, "Queue");
    await settle(() => Boolean(tree.raw.query("Queue list")));
    assert.ok(tree.raw.query("Previous"), "the open queued-more page is kept");
    // The Papercuts view reopens on the page it was left on.
    openView(tree, "Papercuts");
    assert.equal(
      tree.raw.all(/^Triage: Papercut /).length,
      10,
      "the expanded Papercuts page is kept",
    );
    // The Leads filter is kept too.
    openView(tree, "Leads");
    tree.press("Filter leads by tag, All tags (2)");
    tree.press("Filter leads by tag: idea (1)");
    await settle(() => tree.raw.all(/^Triage: Plain /).length === 0);
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

// Per-project queue overflow stays in the Queue list.
test("per-project Queued overflow rows render in narrow and wide board layouts", async () => {
  await load();
  for (const compact of [true, false]) {
    const store = new Store(":memory:");
    let mounted: ReturnType<typeof mountBoard> | undefined;
    try {
      mounted = mountBoard(
        invokeWith(board([], [{ repoPath: "/app", count: 3 }]), async () => ({
          tasks: [],
          hasMore: false,
        })),
        compact,
      );
      const tree = mounted;
      await settle(() => Boolean(tree.query("3 more queued in app")));
      assert.ok(
        tree.query("3 more queued in app"),
        `${compact ? "narrow" : "wide"} layout renders the per-project overflow card`,
      );
      assert.ok(
        tree.query("Queue, 3"),
        "the Queue menu count retains the actual server total",
      );
    } finally {
      mounted?.update(h("View", null));
      store.close();
    }
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
    await settle(() => Boolean(tree.query("Triage: Named lead")));
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
    await settle(() => Boolean(t3Mounted?.query("Triage: Lead without tasks")));
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
          .all(/^Triage: /)
          .reduce((sum, card) => sum + count(card), 0);
      openView(mounted, "Leads");
      let total = tabCards();
      openView(mounted, "Papercuts");
      total += tabCards();
      openView(mounted, "Leads");
      return total;
    };
    assert.equal(cardFolderCount(t3Mounted), 0);
    t3Mounted.press("Triage: Lead without tasks");
    t3Mounted.press("Close detail");
    t3Mounted.press("Triage: Papercut without tasks");
    await settle(() => detailOpened.length === 2);
    assert.deepEqual(detailOpened, [
      "lead.get:lead-only",
      "papercut.get:cut-only",
    ]);

    const plainSnapshot = { ...board([]), projects: [named] };
    plainMounted = mountBoard(rpcFor(plainSnapshot));
    await settle(() =>
      Boolean(plainMounted?.query("Triage: Lead without tasks")),
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
    openView(tree, "Active");
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
    openView(plain, "Active");
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
    await settle(() => Boolean(tree.query(/^app, Board cards keep the title/)));
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

    // Close and Keep draw inside the row's own frame (divider and accent edge), not under it.
    const rowFrame = tree.raw
      .ofType("View")
      .find(
        (node) =>
          node.props.style?.borderBottomWidth === 1 &&
          node.props.style?.borderLeftWidth === 2 &&
          nodeHas(
            node,
            (child) =>
              child.props.accessibilityLabel === "Close drained lane alpha",
          ) &&
          nodeHas(
            node,
            (child) =>
              child.props.accessibilityLabel === "Drained lane: Alpha lane",
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

    // Pressing the row opens its lane in Planning.
    tree.raw.press("Drained lane: Alpha lane");
    await settle(() => Boolean(tree.raw.query("Find lanes")));
    assert.ok(
      tree.raw
        .ofType("Text")
        .some((node) => node.children.join("") === "Planning"),
      "the board switches to Planning",
    );
    await settle(() => tree.raw.text().includes("Alpha lane"));
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
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
    const row = tree.raw
      .all(/.*/)
      .find((node) =>
        String(node.props.accessibilityLabel ?? "").includes(", host-waiting,"),
      );
    assert.ok(row, "the task row is on the board");
    const text = nodeText(row as HostNode);
    assert.equal(
      text.match(/Waiting on the host/g)?.length,
      1,
      "the wait reads once",
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
      /Waiting on the host · /,
      "and the host wait is still named",
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
      /Waiting on the host · /,
      "the row's one line carries the stop and the wait",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("the Leads and Papercuts lists hide the kind chip their list already names", async () => {
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
    await settle(() => Boolean(tree.query("Triage: Idea lead")));
    openView(tree, "Leads");
    const card = tree.raw.query("Triage: Idea lead");
    assert.ok(card, "the lead row is listed");
    assert.doesNotMatch(
      nodeText(card as HostNode),
      /\bLead\b/,
      "the Lead chip repeats nothing inside the Leads list",
    );
    openView(tree, "Papercuts");
    const cut = tree.raw.query("Triage: Tiny papercut");
    assert.ok(cut, "the papercut row is listed");
    assert.doesNotMatch(
      nodeText(cut as HostNode),
      /\bPapercut\b/,
      "the Papercut chip repeats nothing inside the Papercuts list",
    );
  } finally {
    mounted?.update(h("View", null));
    store.close();
  }
});

test("a task needing attention on Needs you names its kind, Task, in the one list", async () => {
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
    // One list, no section headers, and the task names its kind.
    assert.ok(tree.raw.query("Needs you list"), "Needs you is one list");
    assert.equal(
      tree.raw
        .ofType("Text")
        .filter((node) => node.children.join("") === "Task").length,
      1,
      "the attention task draws the Task kind label",
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

test("Planning draws its projects as flat rows with the lists' divider and accent edge", async () => {
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
    const frame = (name: string) =>
      tree.raw
        .ofType("View")
        .find(
          (node) =>
            node.props.style?.borderBottomWidth === 1 &&
            nodeHas(
              node,
              (child) =>
                child.props.accessibilityLabel === `Project row ${name}`,
            ),
        );
    const appFrame = frame("App");
    assert.ok(appFrame, "the project row draws a flat row");
    assert.equal(
      (appFrame!.props.style as { borderWidth?: number }).borderWidth,
      undefined,
      "no card border inside the list pane",
    );
    assert.equal(
      (appFrame!.props.style as { borderRadius?: number }).borderRadius,
      undefined,
      "no card corner inside the list pane",
    );
    assert.equal(
      (appFrame!.props.style as { borderLeftWidth?: number }).borderLeftWidth,
      2,
      "the row keeps the lists' accent edge",
    );
    assert.equal(
      (appFrame!.props.style as { borderLeftColor?: string }).borderLeftColor,
      "transparent",
      "closed rows carry no accent",
    );

    // Expanding keeps the plan editing and marks the open row, as the other lists mark selection.
    tree.raw.press("Project row App");
    await settle(
      () =>
        (frame("App")?.props.style as { borderLeftColor?: string })
          .borderLeftColor === dark.accent,
    );

    // Flat rows touch the pane's edges, so the Dormant group below them keeps its gutter.
    const dormantLabel = "Dormant projects, 1";
    assert.ok(tree.raw.query(dormantLabel), "the dormant project is grouped");
    assert.ok(
      tree.raw
        .ofType("View")
        .some(
          (node) =>
            node.props.style?.paddingHorizontal === 16 &&
            nodeHas(
              node,
              (child) => child.props.accessibilityLabel === dormantLabel,
            ),
        ),
      "the Dormant group keeps the list's horizontal gutter",
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
