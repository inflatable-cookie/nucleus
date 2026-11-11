import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, digest, operationIdForKey, operationInputHash } from "../core/store/store";
import { Engine } from "../core/engine";
import { taskControlOperation } from "../core/verbs/task-control-key";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
} from "../core/verbs/owner-verbs";
import { blockingRecoveryEffects } from "../core/recovery/recovery-effects";
import {
  QUEUE_REPOSITORY_ORIGIN,
  submissionSchema,
  taskControlInputSchema,
  taskOwner,
} from "../shared/contracts";
import { originRecipient } from "../core/resolution";
import { queueOperationSchema } from "../shared/operations";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  commit = "b".repeat(40);
/** Production Queue project key: `repo-${digest(origin).slice(0, 20)}`. */
const QUEUE_LIVE_KEY = `repo-${digest(QUEUE_REPOSITORY_ORIGIN).slice(0, 20)}`;
async function fixture(origin = QUEUE_REPOSITORY_ORIGIN) {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-ops-")), "queue.sqlite"),
  );
  store.setMeta("hostId", "host");
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Blocked merged task",
      repoPath: "/repo",
      planningCommit: commit,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    commit,
  );
  store.upsertProject({
    key: "app",
    name: "App",
    repositories: [{ origin: null, path: "/repo" }],
  });
  store.setProjectPlanner({
    key: "app",
    agentId: "project-planner",
    setBy: "operator",
  });
  store.upsertProject({
    key: QUEUE_LIVE_KEY,
    name: "Queue",
    repositories: [{ origin, path: "/queue" }],
  });
  store.setProjectPlanner({
    key: QUEUE_LIVE_KEY,
    agentId: "queue-planner",
    setBy: "operator",
  });
  let sends = 0;
  const adapter = {
    merged: async () => ({ merged: true, commit, head, base: "main" }),
    observe: async () => {
      sends++;
      throw Error("unexpected observation");
    },
    merge: async () => {
      sends++;
    },
    notify: async () => {
      sends++;
    },
    originAgent: async (id: string) =>
      id === "operator"
        ? null
        : { id, workspaceId: "planning", title: "Chatterbox", archived: false },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.update(inserted.id, {
    phase: "needs_attention",
    prHead: head,
    prUrl: "https://github.com/example/repo/pull/7",
    resumePrNumber: 7,
    resolution: {
      ...store.task(inserted.id).resolution,
      attention: true,
      integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
    },
  });
  const task = () => store.task(inserted.id);
  const control = (fields: Record<string, unknown>) =>
    taskControlInputSchema.parse({
      taskId: inserted.id,
      version: task().version,
      caller: "operator (board)",
      reason: "Settled after investigation",
      ...fields,
    });
  const pending = () => {
    const prior = control({
      action: "retry_effect",
      effect: "workspace_creation",
    });
    const { key, payload } = taskControlOperation(prior),
      id = operationIdForKey(key),
      at = new Date().toISOString();
    store.putOperation(
      queueOperationSchema.parse({
        id,
        key,
        kind: "task_control",
        inputHash: operationInputHash(payload),
        state: "needs_attention",
        taskId: inserted.id,
        expectedVersion: prior.version,
        createdAt: at,
        startedAt: at,
        settledAt: at,
        attempts: 1,
        diagnostic: "The delivery outcome is unknown",
        effect: {
          kind: "task_control",
          target: "retry_effect",
          intentAt: at,
          status: "uncertain",
        },
      }),
      payload,
    );
    return id;
  };
  return { store, engine, task, control, pending, sends: () => sends };
}

test("planner force settles exactly the uncertain operation and keeps its history", async () => {
  const f = await fixture();
  try {
    const id = f.pending();
    const effect = `task_control_operation.${id}`;
    await f.engine.performTaskControl(
      f.control({
        action: "retry_effect",
        effect,
        force: true,
        caller: "project-planner",
      }),
    );
    assert.equal(f.sends(), 0);
    assert.equal(f.store.operation(id)?.state, "needs_attention");
    assert.equal(
      f.store.operation(id)?.diagnostic,
      "The delivery outcome is unknown",
    );
    assert.equal(
      blockingRecoveryEffects(f.store, f.task()).some(
        (item) => item.identity === id,
      ),
      false,
    );
    assert.equal(
      f.task().resolution.ownerSettlements.at(-1)?.source,
      "project_planner",
    );
    assert.equal(
      ownerPendingEffects(collectOwnerVerbFacts(f.store, f.task())).some(
        (item) => item.effect === effect,
      ),
      false,
    );
  } finally {
    f.store.close();
  }
});

test("Queue planner closes a merged task blocked by an uncertain operation in one call", async () => {
  const f = await fixture();
  try {
    const id = f.pending();
    const result = await f.engine.performTaskControl(
      f.control({
        action: "move",
        to: "closeout",
        force: true,
        caller: "queue-planner",
      }),
    );
    assert.equal(result.phase, "syncing");
    assert.equal(result.resolution.mergedCommit, commit);
    assert.equal(result.resolution.integrationTurn, null);
    assert.equal(
      result.resolution.ownerSettlements.some(
        (item) =>
          item.effect === `task_control_operation.${id}` &&
          item.source === "queue_planner",
      ),
      true,
    );
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("Queue planner force closeout succeeds on an project-c-shaped row (prefix id, other project planner, historical participant)", async () => {
  const queuePlanner = "d070792d-65b7-4f0e-8175-34c56f88dc40";
  const caller = "d070792d";
  const f = await fixture();
  try {
    f.store.upsertProject({
      key: "project-c",
      name: "Project-C",
      repositories: [{ origin: "https://github.com/example/project-c.git", path: "/project-c" }],
    });
    f.store.setProjectPlanner({ key: "project-c", agentId: "project-c-planner", setBy: "operator" });
    f.store.setProjectPlanner({ key: QUEUE_LIVE_KEY, agentId: queuePlanner, setBy: "operator" });
    f.store.update(f.task().id, {
      repoPath: "/project-c",
      repository: "https://github.com/example/project-c.git",
      originAgentId: queuePlanner,
      agentId: "worker",
      coordinatorAgentId: queuePlanner,
      resolution: { ...f.task().resolution, reviewerAgentId: "reviewer" },
    });
    f.store.putRun({
      id: "historical-planner-run",
      taskId: f.task().id,
      role: "recovery",
      generation: 1,
      head,
      base: "main",
      agentId: queuePlanner,
      workspaceId: "ws",
      profile: null,
      status: "finished",
      createdAt: new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      active: false,
      idleSince: new Date().toISOString(),
      completion: null,
      released: true,
    });
    const result = await f.engine.performTaskControl(
      f.control({ action: "move", to: "closeout", force: true, caller }),
    );
    assert.equal(result.phase, "syncing");
    assert.equal(result.resolution.mergedCommit, commit);
    await assert.rejects(
      f.engine.performTaskControl(
        f.control({ action: "move", to: "closeout", force: true, caller: "worker", version: result.version }),
      ),
      /planner.*operator/,
    );
  } finally {
    f.store.close();
  }
});

test("queue project lookup accepts the renamed repository origin", async () => {
  const f = await fixture("inflatable-cookie/nucleus");
  try {
    assert.equal(f.store.queueProject()?.key, QUEUE_LIVE_KEY);
  } finally {
    f.store.close();
  }
});

test("Queue's own project keyed like production (repo-<hash>, real origin) authorizes force, notice fallback and reparent", async () => {
  const f = await fixture();
  try {
    assert.equal(QUEUE_LIVE_KEY, "repo-997ec7dcf45ce2ed9ca3");
    assert.equal(f.store.projectByKey("paseo-northstar-queue"), null);
    assert.equal(f.store.queueProject()?.key, QUEUE_LIVE_KEY);
    const id = f.pending();
    const forced = await f.engine.performTaskControl(
      f.control({
        action: "retry_effect",
        effect: `task_control_operation.${id}`,
        force: true,
        caller: "queue-planner",
      }),
    );
    assert.equal(forced.resolution.ownerSettlements.at(-1)?.source, "queue_planner");
    f.store.setProjectPlanner({ key: "app", agentId: null, setBy: "test" });
    const noticeTask = f.store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Planner-less notice",
        repoPath: "/repo",
        planningCommit: commit,
        handoffPath: "notice.md",
        originAgentId: "operator",
      }),
      "host",
      "handoff",
      commit,
    );
    assert.equal(originRecipient(f.store, f.store.task(noticeTask.id)), "queue-planner");
    await f.engine.reparent({
      toAgentId: "successor",
      caller: "queue-planner",
      reason: "Queue planner authority",
      taskIds: [f.task().id],
    } as never);
    assert.equal(taskOwner(f.store.task(f.task().id)), "successor");
  } finally {
    f.store.close();
  }
});
