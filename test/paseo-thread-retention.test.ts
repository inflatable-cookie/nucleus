import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PaseoAdapter } from "../service/paseo-composition";
import { Store } from "../core/store/store";
import { runThreadRetentionPass } from "../core/workspaces/thread-retention";
import { submissionSchema } from "../shared/contracts";
import { wireLabels } from "../shared/wire-labels";

/**
 * Orchestration contract, "Archived thread retention" (nucleus#1367): the Paseo
 * adapter's own retention surface — the archived walk, the fresh archive read and
 * the daemon's delete — proved against a daemon fixture with the real-shape
 * acceptance case: a done task's archived role thread goes, a planner thread and
 * an unarchived thread stay.
 */
const HOST = "paseo:fixture";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-19T12:00:00.000Z");

interface Agent {
  id: string;
  workspaceId: string;
  labels: Record<string, string>;
  archivedAt: string | null;
}

/** A daemon fixture: one agent list, one per-agent ref, one delete. */
function daemon(agents: Agent[]) {
  const state = new Map(agents.map((agent) => [agent.id, { ...agent }]));
  const calls = { list: 0, deleted: [] as string[] };
  const api = {
    agents: {
      list: async (options: {
        filter?: { labels?: Record<string, string>; includeArchived?: boolean };
      }) => {
        calls.list++;
        const labels = options.filter?.labels ?? {};
        const entries = [...state.values()]
          .filter((agent) =>
            Object.entries(labels).every(
              ([key, value]) => agent.labels[key] === value,
            ),
          )
          .filter(
            (agent) =>
              options.filter?.includeArchived !== false || !agent.archivedAt,
          )
          .map((agent) => ({
            agent: {
              id: agent.id,
              workspaceId: agent.workspaceId,
              labels: agent.labels,
              archivedAt: agent.archivedAt,
            },
          }));
        return { entries, pageInfo: { hasMore: false } };
      },
      ref: (id: string) => {
        const handle = {
          get archivedAt() {
            return state.get(id)?.archivedAt ?? null;
          },
          refresh: async () => (state.has(id) ? { id } : null),
        };
        return handle;
      },
    },
  };
  const client = {
    deleteAgent: async (id: string) => {
      calls.deleted.push(id);
      state.delete(id);
    },
  };
  return { state, calls, api, client };
}

function adapterFor(fixture: ReturnType<typeof daemon>): PaseoAdapter {
  const adapter = new PaseoAdapter(
    "ws://127.0.0.1:1",
    "/unused/callback.sock",
    "/unused/worker-report.mjs",
  );
  (adapter as unknown as { api: unknown }).api = fixture.api;
  (adapter as unknown as { client: unknown }).client = fixture.client;
  return adapter;
}

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "ns-paseo-retention-"));
  const store = new Store(join(directory, "queue.sqlite"));
  store.setMeta("paused", false);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const submitted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Finished task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    HOST,
    "handoff",
    "a".repeat(40),
  );
  const task = store.update(submitted.id, { phase: "done" });
  return { store, task };
}

const old = (days: number) => new Date(NOW - days * DAY).toISOString();

test("the archived walk answers both label generations and only archived threads", async () => {
  const fixtureHost = daemon([
    {
      id: "nucleus-old",
      workspaceId: "w1",
      labels: wireLabels({ task: "task-1", role: "reviewer" }),
      archivedAt: old(9),
    },
    {
      id: "northstar-old",
      workspaceId: "w2",
      labels: {
        "northstar.plugin": "northstar-queue",
        "northstar.task": "task-2",
        "northstar.role": "worker",
      },
      archivedAt: old(20),
    },
    {
      id: "live-thread",
      workspaceId: "w3",
      labels: wireLabels({ task: "task-3", role: "worker" }),
      archivedAt: null,
    },
    {
      id: "foreign",
      workspaceId: "w4",
      labels: { "other.plugin": "other" },
      archivedAt: old(4),
    },
  ]);
  const adapter = adapterFor(fixtureHost);

  const rows = (await adapter.archivedThreads())!;
  assert.deepEqual(rows.map((row) => row.id).sort(), [
    "northstar-old",
    "nucleus-old",
  ]);
  assert.equal(
    rows.find((row) => row.id === "nucleus-old")!.archivedAt,
    old(9),
  );
  assert.equal(
    rows.find((row) => row.id === "northstar-old")!.workspaceId,
    "w2",
  );
});

test("a walk that cannot reach its end answers null, never a partial list", async () => {
  const fixtureHost = daemon([
    {
      id: "thread",
      workspaceId: "w",
      labels: wireLabels({ task: "t" }),
      archivedAt: old(9),
    },
  ]);
  // The daemon claims another page but repeats the cursor: the walk is unprovable.
  fixtureHost.api.agents.list = (async () => ({
    entries: [
      {
        agent: {
          id: "thread",
          workspaceId: "w",
          labels: wireLabels({ task: "t" }),
          archivedAt: old(9),
        },
      },
    ],
    pageInfo: { hasMore: true, nextCursor: "same" },
  })) as unknown as typeof fixtureHost.api.agents.list;
  const adapter = adapterFor(fixtureHost);
  assert.equal(await adapter.archivedThreads(), null);
});

test("the fresh archive read answers the stamp now, an absent thread, or an unarchived one", async () => {
  const fixtureHost = daemon([
    {
      id: "archived",
      workspaceId: "w",
      labels: wireLabels({ task: "t" }),
      archivedAt: old(9),
    },
    {
      id: "unarchived",
      workspaceId: "w",
      labels: wireLabels({ task: "t" }),
      archivedAt: null,
    },
  ]);
  const adapter = adapterFor(fixtureHost);
  assert.deepEqual(await adapter.threadArchiveState("archived"), {
    archivedAt: old(9),
    deleted: false,
  });
  assert.deepEqual(await adapter.threadArchiveState("unarchived"), {
    archivedAt: null,
    deleted: false,
  });
  assert.equal(await adapter.threadArchiveState("gone"), null);
});

test("the real-shape pass removes a done task role thread and keeps a planner and an unarchived one", async (t) => {
  const f = fixture(t);
  const fixtureHost = daemon([
    {
      id: "reviewer-1",
      workspaceId: "w",
      labels: wireLabels({ task: f.task.id, run: "run-1", role: "reviewer" }),
      archivedAt: old(9),
    },
    {
      id: "worker-1",
      workspaceId: "w",
      labels: wireLabels({ task: f.task.id, run: "run-1" }),
      archivedAt: old(8),
    },
    // A planner thread: no task label, so it is never this pass's to remove.
    {
      id: "planner-1",
      workspaceId: "w",
      labels: wireLabels({ role: "planner" }),
      archivedAt: old(30),
    },
    // Read archived by the walk, then unarchived by the operator before the fresh read.
    {
      id: "unarchived-1",
      workspaceId: "w",
      labels: wireLabels({ task: f.task.id, role: "reviewer" }),
      archivedAt: old(9),
    },
  ]);
  const adapter = adapterFor(fixtureHost);
  const listed = await adapter.archivedThreads();
  assert.equal(listed!.length, 4);
  fixtureHost.state.get("unarchived-1")!.archivedAt = null;

  const fact = await runThreadRetentionPass({
    store: f.store,
    adapter,
    hostId: HOST,
    at: NOW,
  });

  assert.deepEqual(
    fixtureHost.calls.deleted,
    ["reviewer-1", "worker-1"],
    "the done task's own archived threads are removed, oldest stamp first",
  );
  assert.equal(fact.deleted, 2);
  assert.ok(fixtureHost.state.has("planner-1"), "a planner thread stays");
  assert.ok(
    fixtureHost.state.has("unarchived-1"),
    "an unarchived thread stays",
  );
  assert.equal(fact.remaining, 0);
});
