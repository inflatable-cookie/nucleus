import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResponsibleThreadCache,
  type ResponsibleThreadFact,
} from "../core/questions/responsible-thread-cache";
import { formatAgentId } from "../shared/agent-identity";

const fact = (
  nativeId: string,
  lastInteraction: string,
  extra: Partial<ResponsibleThreadFact> = {},
): ResponsibleThreadFact => ({
  nativeId,
  lastInteraction,
  registeredPlanner: false,
  registeredAgent: false,
  dispatcher: false,
  repositoryWorker: false,
  taskRole: false,
  closed: false,
  ...extra,
});

test("ranks a registered planner first, then a dispatcher, a named agent and a repository worker", async () => {
  const cache = new ResponsibleThreadCache();
  const result = await cache.resolve("project", [
    {
      id: "t3code:one",
      inventory: async () => [
        fact("repository", "2026-01-09", { repositoryWorker: true }),
        fact("named", "2026-01-08", {
          registeredAgent: true,
          repositoryWorker: true,
        }),
        fact("dispatcher", "2026-01-07", {
          dispatcher: true,
          repositoryWorker: true,
        }),
        fact("task", "2026-01-10", { taskRole: true, repositoryWorker: true }),
      ],
    },
    {
      id: "paseo:two",
      inventory: async () => [
        fact("planner", "2026-01-01", { registeredPlanner: true }),
        fact("closed", "2026-01-11", { registeredPlanner: true, closed: true }),
        fact("outsider", "2026-01-12"),
      ],
    },
  ]);
  assert.deepEqual(
    result?.threads.map((thread) => thread.agentId),
    [
      formatAgentId("paseo:two", "planner"),
      formatAgentId("t3code:one", "dispatcher"),
      formatAgentId("t3code:one", "named"),
      formatAgentId("t3code:one", "repository"),
    ],
  );
  assert.deepEqual(
    result?.threads.map((thread) => thread.reasons),
    [
      ["registered-planner"],
      ["dispatcher", "repository-worker"],
      ["registered-agent", "repository-worker"],
      ["repository-worker"],
    ],
  );
});

test("a registration keeps a task-labelled thread a candidate", async () => {
  const cache = new ResponsibleThreadCache();
  const result = await cache.resolve("project", [
    {
      id: "paseo:one",
      inventory: async () => [
        fact("worker-planner", "2026-01-01", {
          registeredPlanner: true,
          taskRole: true,
        }),
      ],
    },
  ]);
  assert.deepEqual(
    result?.threads.map((thread) => thread.agentId),
    [formatAgentId("paseo:one", "worker-planner")],
  );
});

test("caches briefly, invalidates, and prevents an old inventory restoring the cache", async () => {
  let now = 0,
    calls = 0;
  let finish!: (facts: ResponsibleThreadFact[]) => void;
  const cache = new ResponsibleThreadCache(100, 1000, () => now);
  const host = {
    id: "t3code:one",
    inventory: () => {
      calls++;
      return calls === 1
        ? new Promise<ResponsibleThreadFact[]>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve([
            fact("new", "2026-01-02", { repositoryWorker: true }),
          ]);
    },
  };
  const old = cache.resolve("project", [host]);
  cache.invalidate("project");
  const fresh = await cache.resolve("project", [host]);
  finish([fact("old", "2026-01-01", { repositoryWorker: true })]);
  assert.equal(await old, null);
  assert.deepEqual(await cache.resolve("project", [host]), fresh);
  assert.equal(calls, 2);
  now = 101;
  await cache.resolve("project", [host]);
  assert.equal(calls, 3);
});

test("an offline or slow host does not block another host", async () => {
  const cache = new ResponsibleThreadCache(100, 20);
  const result = await cache.resolve("project", [
    { id: "t3code:slow", inventory: () => new Promise(() => {}) },
    {
      id: "bb:offline",
      inventory: async () => {
        throw new Error("offline");
      },
    },
    {
      id: "paseo:live",
      inventory: async () => [
        fact("live", "2026-01-01", { repositoryWorker: true }),
      ],
    },
  ]);
  assert.deepEqual(
    result?.threads.map((thread) => thread.agentId),
    [formatAgentId("paseo:live", "live")],
  );
});

test("a timed-out or failed host inventory is not cached for the TTL", async () => {
  let now = 0,
    calls = 0;
  const cache = new ResponsibleThreadCache(60_000, 20, () => now);
  const host = {
    id: "t3code:one",
    inventory: async () => {
      calls++;
      if (calls === 1) throw new Error("Responsible host inventory timed out");
      return [fact("mcp:planner", "2026-01-02", { registeredPlanner: true })];
    },
  };
  const first = await cache.resolve("project", [host]);
  assert.deepEqual(first?.threads, []);
  // Still well inside the 60s TTL, the next lookup must refresh immediately.
  now = 10;
  const second = await cache.resolve("project", [host]);
  assert.deepEqual(
    second?.threads.map((thread) => thread.agentId),
    [formatAgentId("t3code:one", "mcp:planner")],
  );
  assert.equal(calls, 2);
});
