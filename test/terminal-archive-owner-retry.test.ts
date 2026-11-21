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
