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
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  purged: { taskId: string; runIds: string[] }[];
  branchPrReads: string[];
};

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-context-audit-")));
  const repoPath = join(root, "repo");
  mkdirSync(repoPath, { recursive: true });
  const calls: Calls = { stopped: [], sent: [], purged: [], branchPrReads: [] };
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
      status: "running",
      active: true,
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
    purgeReportingFiles: (taskId: string, runIds: string[]) => {
      calls.purged.push({ taskId, runIds });
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
  const insertTask = (changes: Partial<Task>): Task => {
    const task = runtime.store.insert(
      submissionSchema.parse({
        submissionId: `audit-${++seq}`,
        title: `Audit task ${seq}`,
        repoPath,
        planningCommit: HEAD,
        handoffPath: "brief.md",
        originAgentId: formatAgentId(T3, "planner"),
      }),
      T3,
      "Brief",
      HEAD,
    );
    return runtime.store.update(task.id, changes);
  };
  return { runtime, calls, insertTask, unboundReads };
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

test("bulk disposition is accepted on a service with only a T3 host", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", true);
  const task = f.insertTask({});

  const result = await f.runtime.bulkDisposition({
    operationId: "bulk-audit-1",
    tasks: [{ taskId: task.id, version: task.version }],
    action: "cancel",
    reason: "host context audit",
  });

  assert.ok(result, "the control is not refused for a missing Paseo daemon");
});

test("the audit pass reconciles a callback-free T3 worker's branch PR", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", false);
  const task = f.insertTask(liveWorker);
  const reconciled: string[] = [];
  // Only the branch-PR step reconciles here: the task window's quanta are held.
  f.runtime.engine.scheduleTaskQuantum = async () => {};
  f.runtime.engine.reconcile = async (current: Task) => {
    reconciled.push(current.id);
  };

  await f.runtime.engine.auditPass(false);

  assert.deepEqual(reconciled, [task.id], "the step reached the T3 task");
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

test("retention purges a T3 task's reporting files through its own host", async (t) => {
  const f = await fixture(t);
  f.runtime.store.setMeta("paused", false);
  const task = f.insertTask({ phase: "done", workspaceId: null });
  // An ordinary done task past retention, with its row still present.
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  f.runtime.store.db
    .prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?")
    .run(old, task.id);
  f.runtime.store.setMeta("lastRetentionAt", 0);
  f.runtime.engine.scheduleTaskQuantum = async () => {};

  await f.runtime.engine.auditPass(false);

  assert.throws(() => f.runtime.store.task(task.id), /purged/);
  assert.deepEqual(
    f.calls.purged.map((entry) => entry.taskId),
    [task.id],
    "the T3 adapter purged the task's reporting files",
  );
  assert.deepEqual(f.unboundReads, []);
});
