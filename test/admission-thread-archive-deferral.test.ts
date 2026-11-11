import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, qualifiedThreadArchiveEffectKey } from "../core/store/store";
import { submissionSchema } from "../shared/contracts";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import { Admission, admitAdapter } from "../core/host/admission";
import type { Adapter } from "../core/host";

/**
 * A breaker deferral reached no Paseo call, so it is a wait, not uncertainty.
 * Between 15:00 and 15:30 on 2026-11-05 forty archived threads were recorded
 * `thread_archive_uncertain` with the same breaker reason while each pass
 * re-deferred the same archive a few seconds later.
 */
test("a deferred thread archive waits without recording uncertainty, and archives once the breaker clears", async (t) => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "archive-deferral-")), "queue.sqlite"));
  t.after(() => store.close());
  store.setMeta("paused", false);
  const initial = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: "Task", repoPath: "/repo", planningCommit: "a".repeat(40),
    handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", "a".repeat(40));
  const task = store.update(initial.id, {
    phase: "done", agentId: "worker", workspaceId: "ws",
    resolution: { ...initial.resolution, mergedCommit: "b".repeat(40) },
  });

  const clock = { now: 0 };
  const admission = new Admission({ now: () => clock.now, startIntervalMs: 0 });
  let archived = false, sends = 0;
  const raw = {
    observe: async () => ({ id: "worker", workspaceId: "ws", status: "idle", active: false, permissions: false, error: "",
      labels: { "northstar.task": task.id } }),
    originAgent: async () => ({ id: "worker", workspaceId: "ws", title: "", archived }),
    archiveAgent: async () => { sends++; archived = true; },
  } as unknown as Adapter;
  const adapter = admitAdapter(raw, admission);

  // Three slow inventory reads trip the breaker, as the live reason recorded.
  for (let i = 0; i < 3; i++) await admission.run("inventory", async () => { clock.now += 11_000; });
  assert.equal(admission.degradedNow, true);

  const pass = () => archiveFinishedThreads(store, adapter, task.id, async () => null);
  for (let attempt = 0; attempt < 3; attempt++) { await pass(); clock.now += 3_000; }

  assert.equal(sends, 0, "a deferral never reaches Paseo");
  const events = store.eventsAll(task.id);
  assert.equal(events.filter(event => event.kind === "thread_archive_uncertain").length, 0,
    "deferred is a wait, not uncertainty");
  const waits = events.filter(event => event.kind === "thread_archive_wait" && event.detail.includes("Archive deferred"));
  assert.equal(waits.length, 1, "the identical wait is recorded once while it holds");
  assert.equal(store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey("host", "worker"))?.status, "ready",
    "the withdrawn intent stays retryable");

  // Recovery then admits the very same archive: the wait cost no attempt.
  clock.now += 40_000;
  for (let i = 0; i < 3; i++) await admission.run("inventory", async () => { clock.now += 20; });
  assert.equal(admission.degradedNow, false);
  await pass();
  assert.equal(sends, 1);
  assert.equal(store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey("host", "worker"))?.status, "archived");
  assert.equal(store.eventsAll(task.id).filter(event => event.kind === "thread_archive_uncertain").length, 0);
});
