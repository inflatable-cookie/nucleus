/**
 * Host ports read outside the task's host context (2026-11-23 audit).
 *
 * A fleet loop, an operator control on a queue lane or a retention pass runs in
 * no host context. There the routed adapter falls back to the service's unbound
 * adapter, which has no forge or agent ports, and host availability answers only
 * for the legacy Paseo primary. Paseo is retired, so each such read silently
 * skipped every task on T3 or BB. Each test composes the real service with only a
 * T3 host registered, as a T3-only install runs, and drives one of those paths.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRuntime } from "../service/runtime-owner";
import { formatAgentId } from "../shared/agent-identity";
import { submissionSchema, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host/adapter";

const T3 = "t3code:audit";
const HEAD = "a".repeat(40);
const AGENT = "worker-agent";
const WORKSPACE = "t3-ws-1";

type Calls = {
  stopped: string[];
  sent: { agentId: string; messageId: string }[];
  branchPrReads: string[];
  /** The worker thread's observed status; a closed thread is due its branch-PR lookup. */
  status: "running" | "closed";
};

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-context-audit-")));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  const calls: Calls = {
    stopped: [],
    sent: [],
    branchPrReads: [],
    status: "running",
  };
  const t3 = {
    hostId: T3,
    isConnected: () => true,
    capabilities: () => ({
      reportingViaMcp: false,
      supportsCoordinatorRecovery: true,
    }),
    catalog: async () => ({ providers: [] }),
    profiles: async () => [],
    validate: async () => HEAD,
    findWorkspaces: async () => [],
    findAgents: async () => [],
    createWorkspace: async () => {
      throw new Error("fixtures do not create workspaces");
    },
    verifyWorkspace: async () => {},
    createAgent: async () => {
      throw new Error("fixtures do not create agents");
    },
    observe: async (id: string) => ({
      id,
      workspaceId: WORKSPACE,
      status: calls.status,
      active: calls.status === "running",
      permissions: false,
      error: "",
    }),
    originAgent: async (id: string) => ({
      id,
      workspaceId: "origin-ws",
      title: "Planner",
      archived: false,
    }),
    archiveAgent: async () => {},
    verifyPr: async () => {
      throw new Error("not used");
    },
    notify: async () => {},
    stopAgentTurn: async (id: string) => {
      calls.stopped.push(id);
    },
    steerOrNotify: async (agentId: string, messageId: string) => {
      calls.sent.push({ agentId, messageId });
    },
    findOpenBranchPr: async (task: Task) => {
      calls.branchPrReads.push(task.id);
      return [];
    },
  } as unknown as Adapter;
  const runtime = new QueueRuntime({
    dataDir: join(root, "data"),
    hostHome: join(root, "no-paseo"),
    timers: false,
  });
  t.after(async () => {
    await runtime.drain();
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.started;
  runtime.hostRegistry.connect(T3, "ws://127.0.0.1:3773/ws", {
    adapter: t3,
    admission: runtime.admission,
  });
  await runtime.ensureBootstrap();
  assert.equal(runtime.paseoAdapter, null, "no Paseo host is composed");
  // Every port a registered host serves that is read with no host context.
  const unboundReads: string[] = [];
  runtime.engine.unboundPortRead = (port) => unboundReads.push(port);
  let seq = 0;
  const insertTask = (changes: Partial<Task>, hostId = T3): Task => {
    const task = runtime.store.insert(
      submissionSchema.parse({
        submissionId: `audit-${++seq}`,
        title: `Audit task ${seq}`,
        repoPath,
        planningCommit: HEAD,
        handoffPath: "brief.md",
        originAgentId: formatAgentId(T3, "planner"),
      }),
      hostId,
      "Brief",
      HEAD,
    );
    return runtime.store.update(task.id, changes);
  };
  return {
    runtime,
    calls,
    insertTask,
    unboundReads,
    dataDir: join(root, "data"),
  };
}

const liveWorker: Partial<Task> = {
  phase: "working",
  workspaceIntent: true,
  workspaceId: WORKSPACE,
  agentIntent: true,
  agentId: AGENT,
};

test("stop active threads cancels a live T3 turn on its own host", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", true);
  const task = f.insertTask(liveWorker);

  const result = await f.runtime.stopThreads({ caller: "operator (test)" });

  assert.deepEqual(
    f.calls.stopped,
    [AGENT],
    "the T3 cancel port took the turn",
  );
  assert.deepEqual(
    result.stopped.map((entry) => entry.taskId),
    [task.id],
  );
  assert.ok(f.runtime.store.task(task.id).pausedStop, "the stop is marked");
  assert.deepEqual(f.unboundReads, []);
});

test("stop active threads names a task whose host cannot be reached and marks nothing", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", true);
  const away = f.insertTask({ ...liveWorker, agentId: "bb-worker" }, "bb:away");
  const live = f.insertTask(liveWorker);

  await assert.rejects(
    () => f.runtime.stopThreads({ caller: "operator (test)" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("bb:away") &&
      error.message.includes(away.id),
  );
  assert.equal(f.runtime.store.task(away.id).pausedStop ?? null, null);
  assert.deepEqual(f.calls.stopped, [AGENT], "the reachable host's turn stops");
  assert.ok(f.runtime.store.task(live.id).pausedStop, "and is marked");
});

test("bulk disposition cancels a T3 task in line on a service with only a T3 host", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", true);
  const task = f.insertTask({});

  await f.runtime.bulkDisposition({
    operationId: "bulk-audit-1",
    tasks: [{ taskId: task.id, version: task.version }],
    action: "cancel",
    reason: "host context audit",
  });
  // The batch runs on its own lane; no sweep is needed to finish it.
  const deadline = Date.now() + 10_000;
  let batch = f.runtime.engine.bulkDispositionDetail("bulk-audit-1");
  while (
    ["pending", "running"].includes(batch.status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    batch = f.runtime.engine.bulkDispositionDetail("bulk-audit-1");
  }

  assert.equal(batch.status, "complete", JSON.stringify(batch.items));
  assert.deepEqual(
    batch.items.map((item) => [item.status, item.error]),
    [["complete", ""]],
  );
  assert.equal(f.runtime.store.task(task.id).phase, "cancelled");
});

test("the audit pass reconciles a callback-free T3 worker's branch PR", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", false);
  const task = f.insertTask(liveWorker);
  // The worker's thread closed without the callback that would record its PR.
  f.calls.status = "closed";
  // Only the branch-PR step reconciles here: the task window's quanta are held.
  f.runtime.engine.scheduleTaskQuantum = async () => {};

  await f.runtime.engine.auditPass(false);

  assert.deepEqual(
    f.calls.branchPrReads,
    [task.id],
    "the step reached the T3 task and looked up its branch PR on the T3 adapter",
  );
  // The whole pass reads no host port outside a host context.
  assert.deepEqual(f.unboundReads, []);
});

test("a pending brief amendment is delivered to a T3 worker by the ordinary pass", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", false);
  const version = 2;
  const task = f.insertTask({
    ...liveWorker,
    briefVersions: [
      {
        version,
        digest: `sha256:${"b".repeat(64)}`,
        mediaType: "text/markdown",
        text: "Amended brief",
        reason: "scope narrowed",
        pinnedAt: new Date().toISOString(),
      },
    ],
  });
  const messageId = `ns-brief-amendment-${task.id}-v${version}-worker`;
  // The amending control recorded the intent while the host was unreachable.
  f.runtime.store.event(
    task.id,
    "brief_amendment_delivery_intent",
    JSON.stringify({
      messageId,
      hostId: T3,
      agentId: AGENT,
      role: "worker",
      version,
    }),
  );

  await f.runtime.engine.deliverPendingBriefAmendments();

  assert.deepEqual(f.calls.sent, [{ agentId: AGENT, messageId }]);
  assert.deepEqual(f.unboundReads, []);
});

test("retention removes the run tickets of finished tasks on T3 and on a host that is gone", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", false);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const finished = (hostId: string, runId: string) => {
    const task = f.insertTask(
      { phase: "done", workspaceId: null, runId },
      hostId,
    );
    // An ordinary done task past retention, with its row still present.
    f.runtime.store.db
      .prepare(
        "UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?",
      )
      .run(old, task.id);
    return task;
  };
  const onT3 = finished(T3, "run-t3");
  const gone = finished("bb:retired", "run-gone");
  // Every host's run tickets live in the service's own data directory.
  const tickets = join(f.dataDir, "tickets");
  mkdirSync(tickets, { recursive: true });
  const ticket = (name: string, taskId: string) => {
    writeFileSync(join(tickets, name), JSON.stringify({ taskId }));
    return join(tickets, name);
  };
  const t3Ticket = ticket("run-t3.json", onT3.id);
  const goneTicket = ticket("run-gone.json", gone.id);
  // A ticket under one of these run ids that another task now holds is kept.
  const reassigned = ticket("other-run.json", "another-task");
  f.runtime.store.setMeta("lastRetentionAt", 0);
  f.runtime.engine.scheduleTaskQuantum = async () => {};

  await f.runtime.engine.auditPass(false);

  assert.throws(() => f.runtime.store.task(onT3.id), /purged/);
  assert.throws(() => f.runtime.store.task(gone.id), /purged/);
  assert.equal(existsSync(t3Ticket), false, "the T3 task's ticket is removed");
  assert.equal(existsSync(goneTicket), false, "and so is the gone host's");
  assert.equal(existsSync(reassigned), true);
  assert.deepEqual(f.unboundReads, []);
});
