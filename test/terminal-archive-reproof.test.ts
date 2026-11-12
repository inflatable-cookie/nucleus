import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { submissionSchema } from "../shared/contracts";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import type { Adapter } from "../core/host";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

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

for (const outcome of ['absent', 'deleted', 'unreadable', 'live'] as const)
  test(`terminal workspace re-proves an attached deleted participant: ${outcome}`, async t => {
    const f = await terminalArchiveFixture(t);
    const task = f.task();
    const support = 'released-reviewer';
    f.store.putRun({
      id: 'released-reviewer-run', taskId: task.id, role: 'reviewer', generation: task.coordinatorGeneration,
      head: f.head, base: task.planningBase, agentId: support, workspaceId: 'ws', profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, completion: null, released: true,
    });
    // Capture the released participant before terminal cleanup removes its
    // projection; the workspace archive must re-prove that race directly.
    const attached = new Set([support]);
    Object.assign(f.adapter, { deleteAgent: async () => assert.fail('workspace proof must not delete a thread') });
    f.adapter.observe = async () => { throw Error('participant projection no longer exists'); };
    let originReads = 0;
    f.adapter.originAgent = async id => {
      assert.equal(id, support);
      originReads++;
      if (outcome === 'unreadable') throw Error('origin read unavailable');
      return outcome === 'absent' ? null : { id, workspaceId: 'ws', title: '', archived: false, deleted: outcome === 'deleted' };
    };
    const archive = () => f.adapter.archiveTaskWorkspace(task, 'ws', f.directory, f.head,
      () => true, false, true, attached);
    if (outcome === 'absent' || outcome === 'deleted') {
      await archive();
      assert.equal(f.remote.archives.length, 1);
      assert.equal(existsSync(f.directory), false, 'authoritative removal permits the terminal workspace cleanup');
    } else {
      await assert.rejects(archive(), outcome === 'unreadable' ? /origin read unavailable/ : /participant projection no longer exists/);
      assert.equal(f.remote.archives.length, 0);
      assert.equal(existsSync(f.directory), true, 'unknown or live participant evidence preserves the workspace');
    }
    assert.ok(originReads > 0, 'projection failure alone never proves absence');
  });
