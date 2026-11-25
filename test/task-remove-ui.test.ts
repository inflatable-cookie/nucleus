import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The host wraps contributed components with these providers from the SDK's host
// entry; the invoke stub below stands in for the Queue service.
import { PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { mount, useNativeStubs } from "./support/render";
import { acrossViews } from "./support/inbox";
/** The inbox lists one view at a time; card reads reach every view (support/inbox.ts). */
const mountInbox = (element: React.ReactElement) => acrossViews(mount(element));
import { boardDetailReply, boardTasks } from "./support/board-tasks";
import {
  summarizeTask,
  dispositionSchema,
  taskSummarySchema,
} from "../shared/contracts";

useNativeStubs();
type QueueModule = typeof import("../client/queue");
let queue: QueueModule;
const load = async () => {
  queue = await import("../client/queue");
  return queue;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => "#000" }) as never;
const at = "2026-10-01T00:00:00.000Z";

const repo = { origin: "owner/app", path: "/app" };
const project = {
  key: "app",
  name: "App",
  repositories: [repo],
  primary: repo,
};

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the surface did not settle");
}

test("a backpressured queue.remove surfaces its reason and retry delay and keeps the detail open", async () => {
  await load();
  const task = boardTasks()("removable", {
    title: "Removable task",
    phase: "blocked",
  });
  const reply = boardDetailReply(task);
  const summary = taskSummarySchema.parse({
    id: task.id,
    title: "Removable task",
    repoPath: "/app",
    version: task.version,
    number: null,
    reference: null,
    entrypoint: "worker",
    phase: "blocked",
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
    resolution: { attention: false, mergedCommit: null },
  });
  const board = {
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
    tasks: [summary],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [project],
    prStates: {},
  };
  let removeResponse: unknown = {
    backpressured: true,
    pending: 3,
    retryAfterMs: 1000,
    reason:
      "Queue operation backlog 3 reached the configured bound of 3; retry after the queue drains",
  };
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return board;
    if (method === "queue.service-state")
      return {
        state: "running",
        detail: "",
        error: "",
        ready: true,
        paused: false,
        hostId: "host",
      };
    if (method === "queue.detail") return reply;
    if (method === "queue.remove") return removeResponse;
    if (
      method === "project.qa.list" ||
      method === "host.run.list" ||
      method === "host.run.board"
    )
      return [];
    if (method === "lead.board") return { cards: [], links: [] };
    if (
      method === "queue.plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "decision.list"
    )
      return [];
    void input;
    return {};
  };
  const surfaceProps = {
    theme: { colors: c },
    host: { id: "host", label: "Host" },
    layout: { compact: false, platform: "ios" as const },
  };
  const client = new QueryClient();
  const tree = mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );
  await settle(() => tree.text().includes("Removable task"));
  tree.press(/Removable task/);
  // nucleus#1537: the queue controls live in the task's ⋯ menu.
  const openMenu = async () => {
    await settle(() => Boolean(tree.query("Task actions menu")));
    tree.press("Task actions menu");
    await settle(() => Boolean(tree.query("Remove from queue")));
  };
  await openMenu();
  tree.press("Remove from queue");
  await settle(() => tree.text().includes("backpressured"));
  assert.match(
    tree.text(),
    /Queue operation backlog 3 reached the configured bound of 3/,
    "the banner names the backpressure reason",
  );
  assert.match(
    tree.text(),
    /Retry in about 1s/,
    "the banner names the retry delay",
  );
  assert.ok(
    tree.query("Task actions menu"),
    "the detail stays open so the operator can retry",
  );
  // Once the removal settles removed, the same action closes the detail.
  removeResponse = { ...task, removedAt: new Date().toISOString() };
  await openMenu();
  tree.press("Remove from queue");
  await settle(() => !tree.query("Task actions menu"));
  tree.update(h("View", null));
});

function drainingTask(id: string, title: string, reason: string, withRefs = false) {
  return boardTasks()(id, {
    title,
    phase: "working",
    workspaceIntent: true,
    agentIntent: true,
    workspaceId: "worker-workspace",
    directory: "/missing-worker-workspace",
    agentId: "worker",
    disposition: dispositionSchema.parse({
      kind: "cancel",
      status: "draining",
      requestedAt: at,
      requestedBy: "operator control",
      reason,
      workDisposition: "archive_if_empty",
      effects: [{ kind: "stop_thread", target: "worker", intentAt: at }],
      postDispositionRefs: withRefs
        ? [{ ref: "refs/tags/v0.11.0", sha: "b".repeat(40), observedAt: at }]
        : [],
    }),
  });
}

test("task detail offers withdrawal while a cancel has only a pending thread-stop request", async () => {
  await load();
  const draining = drainingTask("withdrawable", "Reversible cancellation", "Duplicate work");
  const reply = boardDetailReply(draining);
  const summary = summarizeTask(draining);
  const board = {
    revision: 1,
    connected: true,
    hostId: "host",
    paused: false,
    error: "",
    quiet: false,
    activeWorkers: 1,
    unsettled: 1,
    occupiedSlots: 1,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [summary],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [project],
    prStates: {},
  };
  let withdrawal: unknown;
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return board;
    if (method === "queue.service-state")
      return {
        state: "running",
        detail: "",
        error: "",
        ready: true,
        paused: false,
        hostId: "host",
      };
    if (method === "queue.detail") return reply;
    if (method === "queue.task") {
      withdrawal = input;
      return { ...draining, disposition: null };
    }
    if (
      method === "project.qa.list" ||
      method === "host.run.list" ||
      method === "host.run.board"
    )
      return [];
    if (method === "lead.board") return { cards: [], links: [] };
    if (
      method === "queue.plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "decision.list"
    )
      return [];
    return {};
  };
  const surfaceProps = {
    theme: { colors: c },
    host: { id: "host", label: "Host" },
    layout: { compact: false, platform: "ios" as const },
  };
  const client = new QueryClient();
  const tree = mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );
  await settle(() => tree.text().includes("Reversible cancellation"));
  tree.press(/Reversible cancellation/);
  await settle(() => Boolean(tree.query("Task actions menu")));
  tree.press("Task actions menu");
  await settle(() => Boolean(tree.query("Cancellation & withdrawal")));
  tree.press("Cancellation & withdrawal");
  await settle(() => tree.text().includes("Withdraw cancellation"));
  tree.type("Withdrawal reason (required)", "Planner reversed the decision");
  tree.press("Withdraw cancellation");
  await settle(() => Boolean(withdrawal));
  assert.deepEqual(withdrawal, {
    taskId: draining.id,
    version: draining.version,
    action: "withdraw_cancel",
    reason: "Planner reversed the decision",
  });
  tree.update(h("View", null));
});

test("cancelling detail names the interrupted turn and refs pushed after disposition", async () => {
  await load();
  const draining = drainingTask("post-refs", "Release after cancel", "Superseded", true);
  const reply = boardDetailReply(draining);
  const summary = summarizeTask(draining);
  const board = {
    revision: 1,
    connected: true,
    hostId: "host",
    paused: false,
    error: "",
    quiet: false,
    activeWorkers: 1,
    unsettled: 1,
    occupiedSlots: 1,
    globalLimit: 32,
    projectLimit: 5,
    tasks: [summary],
    profiles: [],
    pool: [],
    availability: [],
    assignments: {},
    recentAssignments: {},
    lanes: [],
    projects: [project],
    prStates: {},
  };
  const invoke = async (method: string, input: unknown) => {
    if (method === "queue.ui-snapshot") return board;
    if (method === "queue.service-state")
      return {
        state: "running",
        detail: "",
        error: "",
        ready: true,
        paused: false,
        hostId: "host",
      };
    if (method === "queue.detail") return reply;
    if (
      method === "project.qa.list" ||
      method === "host.run.list" ||
      method === "host.run.board"
    )
      return [];
    if (method === "lead.board") return { cards: [], links: [] };
    if (
      method === "queue.plans" ||
      method === "papercut.list" ||
      method === "draft.list" ||
      method === "decision.list"
    )
      return [];
    void input;
    return {};
  };
  const surfaceProps = {
    theme: { colors: c },
    host: { id: "host", label: "Host" },
    layout: { compact: false, platform: "ios" as const },
  };
  const client = new QueryClient();
  const tree = mountInbox(
    h(QueryClientProvider, {
      client,
      children: h(PluginRpcProvider, {
        invoke,
        children: h(queue.MainSurface as never, surfaceProps),
      }),
    }),
  );
  await settle(() => tree.text().includes("Release after cancel"));
  tree.press(/Release after cancel/);
  await settle(() => Boolean(tree.query("Details")));
  tree.press("Details");
  await settle(() => tree.text().includes("refs/tags/v0.11.0"));
  assert.match(
    tree.text(),
    /The worker turn was interrupted and is still stopping/,
  );
  assert.match(
    tree.text(),
    /Refs pushed after disposition: refs\/tags\/v0\.11\.0 bbbbbbbbbbbb/,
  );
  tree.update(h("View", null));
});
