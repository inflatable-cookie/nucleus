import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { submissionSchema } from "../shared/contracts";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import type { Adapter } from "../core/host";

test("a safe retry re-proves an idle owned thread before sending", async (t) => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "archive-reproof-")), "queue.sqlite"),
  );
  t.after(() => store.close());
  store.setMeta("paused", false);
  store.setMeta("hostId", "host");
  store.setMeta("hostRegistry", [{ id: "host", endpoint: "fixture" }]);
  const initial = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Task",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    "a".repeat(40),
  );
  const task = store.update(initial.id, {
    phase: "done",
    agentId: "worker",
    resolution: { ...initial.resolution, mergedCommit: "b".repeat(40) },
  });
  store.setMeta("threadArchive:worker", {
    status: "ready",
    at: new Date().toISOString(),
  });
  let calls = 0;
  let active = true;
  const adapter = {
    observe: async () => ({
      id: "worker",
      workspaceId: "ws",
      status: active ? "running" : "idle",
      active,
      permissions: false,
      error: "",
      labels: { "northstar.task": task.id },
    }),
    originAgent: async () => ({
      id: "worker",
      workspaceId: "ws",
      title: "",
      archived: calls > 0,
    }),
    archiveAgent: async () => {
      calls++;
    },
  } as unknown as Adapter;
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(calls, 0);
  active = false;
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(calls, 1);
});
