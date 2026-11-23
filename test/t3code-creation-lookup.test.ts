import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { WIRE_LABEL_KEYS } from "../shared/wire-labels";
import { t3Fake, threadProjection } from "./support/t3code-fake";
import { storedHostState, type StoredThread } from "./support/t3code-state";

/**
 * Spec 068 §3 on T3: a creation lookup and a dead-thread check answer only from
 * T3's own facts — the live shell inside its freshness bound and an exact read by
 * id over RPC — never from a stale copy, and never "absent" on a read that did
 * not complete. A create whose reply was lost (and whose launch record was
 * dropped) is still found by the child thread id its command derives.
 */

async function fixture(t: TestContext, input: { timeoutMs?: number } = {}) {
  const root = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), "t3code-creation-lookup-"),
  );
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const threads: StoredThread[] = [
    { id: "nucleus-thread-lookup-0", taskId: "task-lookup", runId: "run-recorded" },
  ];
  const state = storedHostState({ directory, threads });
  // The ledger holds one create command whose reply was lost: it was sent, so
  // the child thread T3 derives from its id is a lookup candidate.
  (state.intents as Record<string, unknown>)["ns-run-run-lost-reply"] = {
    payload: "{}",
    status: "unknown",
    timedOut: true,
  };
  const workspaceId = Object.keys(state.workspaces)[0]!;
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  for (const thread of threads)
    server.threads.set(thread.id, threadProjection(thread.id, directory));
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: input.timeoutMs ?? 5_000,
    probeThreadId: threads[0]!.id,
  });
  t.after(() => host.close());
  await host.connect();
  return { server, host, directory, workspaceId };
}

const labels = (runId: string) => ({
  [WIRE_LABEL_KEYS.task]: "task-lookup",
  [WIRE_LABEL_KEYS.run]: runId,
});

test("a created thread whose reply and launch record were lost is found by its derived id", async (t) => {
  const { server, host, directory, workspaceId } = await fixture(t);
  const derived = "thread:delegated-task:ns-run-run-lost-reply";
  server.threads.set(derived, threadProjection(derived, directory));
  host.reads.live.close();
  const found = await host.findRunAgents(labels("run-lost-reply"));
  assert.deepEqual(found, [
    { id: derived, workspaceId, hostConfirmed: true },
  ]);
});

test("no thread on a complete, fresh read is an empty answer, and an unsent command is never read", async (t) => {
  const { server, host } = await fixture(t);
  await host.reads.shell();
  const reads = () =>
    server.requests.filter((request) => request.tag === "orchestration.subscribeThread")
      .length;
  const before = reads();
  assert.deepEqual(await host.findRunAgents(labels("run-never-created")), []);
  assert.equal(reads(), before, "no exact read for a command never sent");
  assert.deepEqual(await host.findRunAgents(labels("run-lost-reply")), []);
  assert.equal(reads() - before, 1, "one exact read for the sent command");
});

test("a shell past its freshness bound that cannot reopen never answers absent", async (t) => {
  const { server, host } = await fixture(t, { timeoutMs: 300 });
  await host.reads.shell();
  host.reads.live.quietBoundMs = 20;
  await new Promise((resolve) => setTimeout(resolve, 60));
  server.controls.stalledMethods = ["orchestration.subscribeShell"];
  await assert.rejects(host.findRunAgents(labels("run-never-created")));
  await assert.rejects(host.originAgent("nucleus-thread-gone"));
  server.controls.stalledMethods = [];
});

test("a thread T3 no longer has is gone on the shell plus the exact read", async (t) => {
  const { server, host } = await fixture(t);
  const id = "nucleus-thread-lookup-0";
  assert.ok(await host.originAgent(id), "a listed thread is present");
  server.threads.delete(id);
  host.reads.live.close();
  assert.equal(await host.originAgent(id), null);
});
