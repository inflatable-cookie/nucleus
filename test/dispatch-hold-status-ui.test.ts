import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { inboxText, showInView } from "./support/inbox";
import { boardDetailReply, boardNext, boardTasks } from "./support/board-tasks";
import {
  summarizeTask,
  syncHoldProjection,
} from "../shared/contracts";

// Queue reliability: the card and detail show the live dispatch hold, not the
// stale stored reason, and `task.next` names the same fence. Synthetic rows only.
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
const at = "2026-10-27T00:00:00.000Z";
const STALE =
  "Chatterbox routing: origin 0b355fd4 was not found in workspace project-c";
const DISPATCH =
  "Dispatch held by operator: planning owes a ruling on the cleared origin";
const MERGE = "Merge held by operator: external receipt pending";
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
const board = (tasks: ReturnType<typeof summarizeTask>[]) => ({
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

function mountBoard(
  invoke: (method: string, input: unknown) => Promise<unknown>,
) {
  const surfaceProps = {
    theme: { colors: c },
    host: { id: "host", label: "Host" },
    layout: { compact: false, platform: "ios" as const },
  };
  const client = new QueryClient();
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

test("the card and detail show the live dispatch hold, and next names the same fence", async () => {
  await load();
  const makeTask = boardTasks();
  let mounted: ReturnType<typeof mountBoard> | undefined;
  try {
    // Queued, dispatch held, stale stored reason and cleared routing errors.
    const stale = makeTask("stale-hold", {
      phase: "queued",
      reason: STALE,
      ...syncHoldProjection({ dispatch: fence(DISPATCH) }),
    });
    // Both fences on a queued task: the dispatch wait, with the merge hold still named.
    const both = makeTask("both-holds", {
      phase: "queued",
      reason: STALE,
      ...syncHoldProjection({ dispatch: fence(DISPATCH), merge: fence(MERGE) }),
    });
    // Merge-only hold on a reviewing task: its activity stays the state.
    const review = makeTask("merge-review", {
      phase: "reviewing",
      reason: "Reviewer run is reading the diff",
      ...syncHoldProjection({ merge: fence(MERGE) }),
    });
    // A genuine unresolved routing error, unheld.
    const routing = makeTask("real-origin-error", {
      phase: "queued",
      reason: "Waiting for dispatch",
      originError: "Origin thread 0b355fd4 not found",
    });
    const unheld = makeTask("unheld", {
      phase: "working",
      reason: "Worker is editing",
    });
    const rows = [stale, both, review, routing, unheld];
    const replies = new Map(rows.map((row) => [row.id, boardDetailReply(row)]));
    const snapshot = board(rows.map((row) => summarizeTask(row)));
    const invoke = async (method: string, input: unknown) => {
      const taskId = (input as { taskId?: string } | undefined)?.taskId ?? "";
      if (method === "queue.ui-snapshot") return snapshot;
      if (method === "queue.service-state") return serviceState;
      if (method === "queue.detail") return replies.get(taskId);
      if (method === "task.next") return boardNext(replies.get(taskId)!.task);
      // `host.run.board` is one combined object (runs plus the accounting join), not
      // a run list: an array here fails the method's output schema, so the query
      // errors and retries instead of settling into an empty, well-formed board.
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
      return {};
    };
    const tree = mountBoard(invoke);
    mounted = tree;
    // The inbox lists one view at a time; the cards span Needs you, Queue, Working, In review and Closing.
    await settle(() => {
      const all = inboxText(tree);
      return all.includes("stale-hold") && all.includes("unheld");
    });
    const cards = inboxText(tree);

    // The card shows the state and keeps the live reason accessible.
    assert.ok(showInView(tree, "stale-hold"));
    assert.ok(tree.query(/planning owes a ruling on the cleared origin/));
    assert.ok(!cards.includes(DISPATCH));
    assert.ok(
      !cards.includes(STALE),
      "no card shows the obsolete stored reason",
    );
    assert.ok(
      cards.includes("Dispatch held"),
      "the state chip still says dispatch held",
    );
    assert.ok(
      cards.includes("Merge held"),
      "the both-holds card keeps the merge hold chip",
    );
    assert.ok(showInView(tree, "merge-review"));
    assert.ok(tree.query(/Reviewer run is reading the diff/));

    // Detail: the stale stored reason is not shown, and next names the fence.
    assert.ok(showInView(tree, "stale-hold"), "the stale-hold card is listed");
    tree.press(/stale-hold/);
    // nucleus#1537: the Overview names the live hold and its holder in plain words;
    // the hold lines and the stored routing errors live in Details.
    await settle(() =>
      Boolean(tree.query(/^What is happening: .*Dispatch is held by operator/)),
    );
    tree.press("Details");
    await settle(() => Boolean(tree.query("Dispatch hold owner and reason")));
    assert.ok(
      tree.query("Dispatch hold owner and reason"),
      "the dispatch hold line is on the detail",
    );
    assert.ok(
      !tree.text().includes(STALE),
      "the detail does not show the obsolete stored reason",
    );

    // Both fences: the dispatch fence is the wait, the merge fence has its own line.
    assert.ok(showInView(tree, "both-holds"), "the both-holds card is listed");
    tree.press(/both-holds/);
    // Selecting a task opens on its Overview tab.
    await settle(() =>
      Boolean(tree.query(/^What is happening: .*Dispatch is held by/)),
    );
    tree.press("Details");
    await settle(() => Boolean(tree.query("Merge hold owner and reason")));
    assert.ok(
      tree.query("Dispatch hold owner and reason"),
      "the dispatch wait is on the detail",
    );
    assert.ok(
      tree.text().includes(MERGE),
      "the merge hold stays discoverable on the detail",
    );
    assert.ok(
      !tree.query(/^What is happening: .*Merge is held/),
      "next does not name the merge fence for a queued task",
    );

    // A genuine routing error still reaches the detail.
    assert.ok(
      showInView(tree, "real-origin-error"),
      "the real-origin-error card is listed",
    );
    tree.press(/real-origin-error/);
    await settle(
      () => tree.query("Details")?.props.accessibilityState.selected === false,
    );
    tree.press("Details");
    await settle(() =>
      tree.text().includes("Origin routing: Origin thread 0b355fd4 not found"),
    );
    assert.equal(
      tree.query("Dispatch hold owner and reason"),
      undefined,
      "no hold is invented",
    );

    // A merge-only reviewing task names its merge fence in detail.
    assert.ok(
      showInView(tree, "merge-review"),
      "the merge-review card is listed",
    );
    tree.press(/merge-review/);
    await settle(
      () => tree.query("Details")?.props.accessibilityState.selected === false,
    );
    tree.press("Details");
    await settle(() => Boolean(tree.query("Merge hold owner and reason")));
    assert.equal(
      tree.query("Dispatch hold owner and reason"),
      undefined,
      "a merge hold is never a dispatch wait",
    );

    // An unheld working task has neither fence line.
    assert.ok(showInView(tree, "unheld"), "the unheld card is listed");
    assert.ok(tree.query(/Worker is editing/));
    tree.press(/unheld/);
    await settle(() => Boolean(tree.query("Details")));
    tree.press("Details");
    await settle(
      () => tree.query("Details")?.props.accessibilityState.selected === true,
    );
    assert.equal(tree.query("Dispatch hold owner and reason"), undefined);
    assert.equal(tree.query("Merge hold owner and reason"), undefined);
  } finally {
    mounted?.update(h("View", null));
  }
});
