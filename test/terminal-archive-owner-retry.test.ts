import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifiedThreadArchiveEffectKey } from "../core/store/store";
import { terminalArchiveFixture } from "./support/terminal-archive-fixture";

test("existing workspace retry reopens exhausted thread reconciliation with the ordinary proofs", async (t) => {
  const f = await terminalArchiveFixture(t);
  f.store.setMeta(qualifiedThreadArchiveEffectKey("host", "worker"), {
    status: "uncertain",
    at: new Date().toISOString(),
    retries: 3,
    retryable: true,
  });
  let archived = false,
    calls = 0;
  f.adapter.observe = async (id) => ({
    id,
    workspaceId: "ws",
    status: "idle",
    active: false,
    permissions: false,
    error: "",
    labels: { "northstar.task": f.task().id },
  });
  f.adapter.originAgent = async (id) => ({
    id,
    workspaceId: "ws",
    title: "",
    archived,
  });
  f.adapter.archiveAgent = async () => {
    calls++;
    archived = true;
  };
  assert.ok(
    f
      .next()
      .some((verb) =>
        JSON.stringify(verb.args).includes("workspace_archive.ws"),
      ),
  );
  const result = await f.retry();
  assert.equal(calls, 1);
  assert.deepEqual(result.resolution.archivedWorkspaceIds, ["ws"]);
  assert.ok(
    f.store
      .eventsAll(f.task().id)
      .some((event) => event.kind === "thread_archive_owner_retry"),
  );
});

test('forced archive settlement stays visible and an ordinary retry removes the workspace', async t => {
  const f = await terminalArchiveFixture(t);
  const task = f.task();
  await f.engine.performTaskControl({ action: 'retry_effect', taskId: task.id, version: task.version,
    effect: 'workspace_archive.ws', caller: 'operator (board)', force: true,
    reason: 'Native participant is idle with no tool child; settle the stale archive failure' });
  assert.equal(f.remote.archives.length, 0, 'force itself sends no archive request');
  assert.equal(f.task().resolution.archivedWorkspaceIds.includes('ws'), false);
  const retry = f.next().find(verb => verb.args?.effect === 'workspace_archive.ws');
  assert.ok(retry, 'next retains the ordinary retry after force');
  assert.match(String(retry.args?.summary), /left on disk after forced settlement/);
  const result = await f.retry();
  assert.ok(result.resolution.archivedWorkspaceIds.includes('ws'));
  assert.equal(f.remote.archives.length, 1);
  assert.equal(f.next().some(verb => verb.args?.effect === 'workspace_archive.ws'), false);
});
