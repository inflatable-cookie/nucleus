import { observeIdle } from './support/fakes';
/**
 * nucleus#937: pause drains. The 2026-11-08 project-c#300 shape is a reviewer
 * whose result has arrived and is waiting for thread release: pause used to
 * skip that observe, so the run stayed bound. Pause now releases it and
 * starts no new run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { boundDrainProjection } from "../core/closeout/queue-drain";
import { ACCEPTED_PR_RECONCILIATION_REASON } from "../core/recovery/task-reasons";
import {
  runSchema,
  submissionSchema,
  type Profile,
  type Run,
} from "../shared/contracts";
import type { Adapter, AgentObservation } from "../core/host";

const head = "a".repeat(40);
const base = "b".repeat(40);
const profile: Profile = {
  id: "reviewer",
  name: "Reviewer",
  provider: "test",
  model: "test",
  notes: "",
  available: true,
  problem: "",
  supportedThinking: [],
};

function fixture() {
  const store = new Store(":memory:");
  store.setMeta("paused", true);
  store.setMeta("hostId", "host");
  const launches: Run[] = [];
  const observation: AgentObservation = {
    id: "reviewer-agent",
    workspaceId: "ws",
    status: "idle",
    active: false,
    permissions: false,
    error: "",
  };
  const adapter = {
    catalog: async () => ({
      providers: [
        {
          key: "test",
          label: "test",
          available: true,
          problem: "",
          models: [
            {
              id: "test",
              label: "test",
              aliases: [],
              thinkingOptions: [],
              defaultThinkingOptionId: null,
              modes: [],
              features: [],
            },
          ],
        },
      ],
    }),
    validate: async () => base,
    createWorkspace: async () => {
      throw new Error("pause must not create a workspace");
    },
    findWorkspaces: async () => [],
    createAgent: async () => {
      throw new Error("pause must not create an agent");
    },
    findAgents: async () => [],
    observe: async (id: string) => ({ ...observation, id }),
    archiveAgent: async () => {},
    createRun: async (_task: unknown, run: Run) => {
      launches.push(run);
      throw new Error("pause must not launch a run");
    },
    sendRun: async () => {
      throw new Error("pause must not send a run");
    },
    findRunAgents: async () => [],
    continueRun: async () => {
      throw new Error("pause must not continue a run");
    },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Waiting for thread release",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  const task = store.update(submitted.id, {
    phase: "reviewing",
    reason: "Waiting for thread release",
    workspaceIntent: true,
    agentIntent: true,
    workspaceId: "ws",
    directory: "/worktree",
    agentId: "worker",
    runId: "initial",
    profile,
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/1",
    agentActive: false,
    lastAgentStatus: "idle",
    completion: {
      taskId: submitted.id,
      runId: "initial",
      eventId: "initial-result",
      status: "ready_for_review",
      summary: "Ready",
      prNumber: 1,
    },
  });
  const run = runSchema.parse({
    id: "reviewer-run",
    taskId: task.id,
    role: "reviewer",
    generation: 1,
    head,
    base,
    hostId: "host",
    agentId: "reviewer-agent",
    workspaceId: "ws",
    profile,
    profileGroup: "review",
    status: "running",
    createdAt: new Date().toISOString(),
    lastObservedAt: null,
    active: false,
    idleSince: new Date(Date.now() - 60_000).toISOString(),
    released: false,
    completion: {
      eventId: "reviewer-result",
      taskId: task.id,
      runId: "reviewer-run",
      status: "changes_required",
      summary: "Changes",
      reviewResponsibility: "author",
    },
  });
  store.putRun(run);
  store.update(task.id, {
    resolution: {
      ...store.task(task.id).resolution,
      currentRunId: run.id,
      reviewerAgentId: run.agentId,
    },
  });
  const numbered = store.task(task.id);
  return {
    store,
    engine,
    launches,
    taskId: task.id,
    runId: run.id,
    bound: {
      taskId: task.id,
      runId: run.id,
      role: "reviewer",
      reference:
        numbered.reference ??
        (numbered.number
          ? `#${String(numbered.number).padStart(3, "0")}`
          : null),
    },
    close: async () => {
      await engine.stop();
      store.close();
    },
  };
}

test("under pause, a reviewer whose result has arrived is released and no new run launches", async () => {
  const f = fixture();
  try {
    assert.equal(boundDrainProjection(f.store).drained, false);
    assert.deepEqual(boundDrainProjection(f.store).boundRuns, [f.bound]);
    await f.engine.resolution.observe();
    const released = f.store.run(f.runId)!;
    assert.equal(released.released, true);
    assert.equal(released.status, "finished");
    assert.equal(f.launches.length, 0);
    await f.engine.scheduleTaskQuantum(f.taskId);
    assert.equal(
      f.launches.length,
      0,
      "pause starts no revision, reviewer, or coordinator",
    );
    assert.equal(
      f.store.runs(f.taskId).filter((run) => run.id !== f.runId).length,
      0,
    );
    assert.equal(boundDrainProjection(f.store).drained, true);
    assert.deepEqual(boundDrainProjection(f.store).boundRuns, []);
  } finally {
    await f.close();
  }
});

function pausedStore() {
  const store = new Store(":memory:");
  store.setMeta("paused", true);
  store.setMeta("hostId", "host");
  return store;
}

test("under pause, a dispatching task without a workspace does not create one", async () => {
  const store = pausedStore();
  let createWorkspace = 0;
  const adapter = {
    catalog: async () => ({ providers: [] }),
    validate: async () => base,
    findWorkspaces: async () => [],
    inspectWorkspaceCreation: async () => ({ kind: "found_done" }),
    createWorkspace: async () => {
      createWorkspace++;
      throw new Error("pause must not create a workspace");
    },
    findAgents: async () => [],
    createAgent: async () => {
      throw new Error("pause must not create an agent");
    },
    observe: observeIdle("ws"),
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  try {
    const submitted = store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Dispatching",
        repoPath: "/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      base,
    );
    store.update(submitted.id, {
      phase: "dispatching",
      workspaceIntent: true,
      hostId: "host",
    });
    await engine.scheduleTaskQuantum(submitted.id);
    assert.equal(createWorkspace, 0);
    assert.equal(store.task(submitted.id).workspaceId, null);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("under pause, an accepted-PR task whose workspace is unavailable does not recover a replacement", async () => {
  const store = pausedStore();
  let recoverTaskWorkspace = 0;
  const adapter = {
    catalog: async () => ({ providers: [] }),
    validate: async () => base,
    findWorkspaces: async () => [],
    workspaceAvailable: async () => false,
    recoverTaskWorkspace: async () => {
      recoverTaskWorkspace++;
      throw new Error("pause must not recover a workspace");
    },
    findAgents: async () => [],
    createAgent: async () => {
      throw new Error("pause must not create an agent");
    },
    createRun: async () => {
      throw new Error("pause must not launch a run");
    },
    observe: observeIdle("ws"),
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  try {
    const submitted = store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Accepted PR",
        repoPath: "/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      base,
    );
    store.update(submitted.id, {
      phase: "needs_attention",
      reason: ACCEPTED_PR_RECONCILIATION_REASON,
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: "ws",
      directory: "/worktree",
      agentId: "worker",
      runId: "initial",
      profile,
      hostId: "host",
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/1",
      completion: {
        taskId: submitted.id,
        runId: "initial",
        eventId: "initial-result",
        status: "ready_for_review",
        summary: "Ready",
        prNumber: 1,
      },
    });
    await engine.scheduleTaskQuantum(submitted.id);
    assert.equal(recoverTaskWorkspace, 0);
    assert.equal(store.task(submitted.id).workspaceId, "ws");
    assert.equal(store.task(submitted.id).phase, "needs_attention");
  } finally {
    await engine.stop();
    store.close();
  }
});

test("under pause, a closeout run whose result has arrived is applied and released", async () => {
  const store = pausedStore();
  let launches = 0;
  const adapter = {
    catalog: async () => ({ providers: [] }),
    validate: async () => base,
    findWorkspaces: async () => [],
    findAgents: async () => [],
    createAgent: async () => {
      throw new Error("pause must not create an agent");
    },
    createRun: async () => {
      launches++;
      throw new Error("pause must not launch a run");
    },
    sendRun: async () => {
      throw new Error("pause must not send a run");
    },
    observe: observeIdle("ws"),
    archiveAgent: async () => {},
    verifyCloseout: async () => undefined,
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  try {
    const submitted = store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Closing",
        repoPath: "/repo",
        planningCommit: base,
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      base,
    );
    const task = store.update(submitted.id, {
      phase: "closing",
      workspaceIntent: true,
      agentIntent: true,
      workspaceId: "ws",
      directory: "/worktree",
      agentId: "worker",
      runId: "initial",
      profile,
      hostId: "host",
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/1",
      coordinatorAgentId: "closeout-agent",
      coordinatorGeneration: 1,
      completion: {
        taskId: submitted.id,
        runId: "initial",
        eventId: "initial-result",
        status: "ready_for_review",
        summary: "Ready",
        prNumber: 1,
      },
      resolution: {
        ...store.task(submitted.id).resolution,
        mergedCommit: base,
        syncedCommit: base,
        currentRunId: "closeout-run",
      },
    });
    store.putRun(
      runSchema.parse({
        id: "closeout-run",
        taskId: task.id,
        role: "closeout",
        generation: 1,
        head: base,
        base,
        hostId: "host",
        agentId: "closeout-agent",
        workspaceId: "ws",
        profile,
        status: "running",
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        active: false,
        idleSince: new Date(Date.now() - 60_000).toISOString(),
        released: false,
        completion: {
          eventId: "closeout-result",
          taskId: task.id,
          runId: "closeout-run",
          status: "ready_for_review",
          summary: "Closed out",
        },
      }),
    );
    await engine.resolution.observe();
    assert.equal(store.run("closeout-run")!.released, true);
    await engine.scheduleTaskQuantum(task.id);
    assert.equal(launches, 0);
    assert.equal(store.task(task.id).phase, "done");
    assert.equal(store.task(task.id).resolution.currentRunId, null);
  } finally {
    await engine.stop();
    store.close();
  }
});
