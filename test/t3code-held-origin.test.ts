import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3CodeHost } from "../hosts/t3code/adapter";
import { createAdapter } from "../hosts/t3code";
import { HostPolicies } from "../core/host/host-policies";
import type { Adapter, HostPolicyConstructor } from "../core/host";
import {
  Admission,
  admitAdapter,
  DEFAULT_START_INTERVAL_MS,
} from "../core/host/admission";
import { PaseoAdapter } from "../service/paseo-composition";
import type { Task } from "../shared/contracts";
import { t3Fake, threadProjection } from "./support/t3code-fake";
import {
  storedHostState,
  taskFact,
  type StoredThread,
} from "./support/t3code-state";

/**
 * T3 calls stop queueing on admission (perf pass 2026-11-23, brief C).
 *
 * T3 answered in 1-25 ms inside the service, yet an inventory call waited a p50
 * of 381 ms (p90 1.6 s) for its one slot, behind a fixed 125 ms gap between any
 * two calls to the host. Most of that queue was `originAgent`, which T3's live
 * shell already answers from memory. A held answer now takes no slot, and T3,
 * which multiplexes every call over one connection, keeps no start gap; Paseo
 * keeps its 125 ms.
 */

const THREADS = 12;
const threadId = (index: number) => `nucleus-thread-origin${index}`;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "t3code-held-origin-"));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  const threads: StoredThread[] = Array.from(
    { length: THREADS },
    (_, index) => ({
      id: threadId(index),
      taskId: `task-origin-${index}`,
      runId: `run-origin-${index}`,
    }),
  );
  const statePath = join(root, "state.json");
  writeFileSync(
    statePath,
    JSON.stringify(storedHostState({ directory, threads })),
    { mode: 0o600 },
  );
  for (const thread of threads)
    server.threads.set(thread.id, threadProjection(thread.id, directory));
  const host = new T3CodeHost({
    endpoint: server.endpoint,
    bearer: "synthetic-bearer",
    statePath,
    timeoutMs: 5_000,
    probeThreadId: threadId(0),
  });
  t.after(() => host.close());
  await host.connect();
  const adapter = createAdapter(
    HostPolicies as unknown as HostPolicyConstructor,
    host,
  );
  return { server, host, adapter };
}

const quiet = () => new Admission({ log: () => {} });

test("originAgent answered from a fresh live shell takes no admission slot and sends T3 nothing", async (t) => {
  const { server, host, adapter } = await fixture(t);
  const admission = quiet();
  const admitted = admitAdapter(adapter, admission);
  await host.reads.shell();
  assert.equal(host.reads.live.live, true);
  const exact = await host.originAgent(threadId(1));
  const start = server.requests.length;

  const answers = await Promise.all(
    Array.from({ length: 20 }, () => admitted.originAgent!(threadId(1))),
  );

  for (const answer of answers) assert.deepEqual(answer, exact);
  const snapshot = admission.snapshot();
  assert.equal(snapshot.inventory.completed, 0, "no inventory slot was taken");
  assert.equal(snapshot.slotWait.inventory.samples, 0);
  assert.equal(admission.heldOriginAnswers, 20);
  assert.equal(server.requests.length - start, 0, "T3 was asked nothing");
});

test("a stale live shell falls back to the admitted read, which refreshes it", async (t) => {
  const { server, host, adapter } = await fixture(t);
  const admission = quiet();
  const admitted = admitAdapter(adapter, admission);
  await host.reads.shell();
  host.reads.live.quietBoundMs = 20;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(host.reads.live.live, false, "past its bound the copy is stale");
  const shells = server.requests.filter(
    (request) => request.tag === "orchestration.subscribeShell",
  ).length;

  const answer = await admitted.originAgent!(threadId(2));

  assert.equal(answer?.id, threadId(2));
  assert.equal(admission.heldOriginAnswers, 0, "a stale copy answers nothing");
  assert.equal(
    admission.snapshot().inventory.completed,
    1,
    "one admitted read",
  );
  assert.equal(
    server.requests.filter(
      (request) => request.tag === "orchestration.subscribeShell",
    ).length - shells,
    1,
    "the admitted read took one fresh shell snapshot",
  );
});

test("a thread the live shell does not list is read by its exact id, never answered absent from the shell", async (t) => {
  const { server, host, adapter } = await fixture(t);
  const admission = quiet();
  const admitted = admitAdapter(adapter, admission);
  await host.reads.shell();
  // T3 removes the thread: its shell stops listing it.
  server.threads.delete(threadId(3));
  await host.reads.shell();
  assert.equal(host.reads.live.row(threadId(3)), undefined);
  const threadReads = () =>
    server.requests.filter(
      (request) =>
        request.tag === "orchestration.subscribeThread" &&
        (request.payload as { threadId?: string }).threadId === threadId(3),
    ).length;
  const before = threadReads();

  assert.equal(await admitted.originAgent!(threadId(3)), null);

  assert.equal(admission.heldOriginAnswers, 0);
  assert.equal(admission.snapshot().inventory.completed, 1);
  assert.equal(
    threadReads() - before,
    1,
    "the answer came from one exact read by id",
  );
});

test("T3 declares no start gap; Paseo keeps 125 ms; an explicit option still wins", async (t) => {
  const { adapter } = await fixture(t);
  const t3 = quiet();
  admitAdapter(adapter, t3);
  assert.equal(t3.snapshot().total.startIntervalMs, 0);

  const paseo = quiet();
  admitAdapter(new PaseoAdapter("ws://127.0.0.1:1", "unused", "unused"), paseo);
  assert.equal(paseo.snapshot().total.startIntervalMs, 125);
  assert.equal(DEFAULT_START_INTERVAL_MS, 125);

  const pinned = new Admission({ startIntervalMs: 40, log: () => {} });
  admitAdapter(adapter, pinned);
  assert.equal(pinned.snapshot().total.startIntervalMs, 40);
});

test("a synthetic burst of origin and inventory reads: slot waits before and after", async (t) => {
  const { host, adapter } = await fixture(t);
  await host.reads.shell();
  // Distinct requests, so admission's coalescing of identical calls stays out of it.
  const ORIGINS = THREADS;
  const LISTS = 4;
  const burst = async (admitted: Adapter) =>
    await Promise.all([
      ...Array.from({ length: ORIGINS }, (_, index) =>
        admitted.originAgent!(threadId(index)),
      ),
      ...Array.from({ length: LISTS }, (_, index) =>
        admitted.findAgents(
          taskFact(`task-origin-${index}`, "working") as Task,
        ),
      ),
    ]);

  // Before: every origin read queued for the one inventory slot, 125 ms apart.
  const before = quiet();
  const forwarding = {
    originAgent: (id: string) => adapter.originAgent!(id),
    findAgents: (task: Task) => adapter.findAgents(task),
  } as unknown as Adapter;
  await burst(admitAdapter(forwarding, before));
  // After: origin reads answer from the live shell; the lists take the slot back to back.
  const after = quiet();
  await burst(admitAdapter(adapter, after));

  const was = before.snapshot().slotWait.inventory;
  const now = after.snapshot().slotWait.inventory;
  t.diagnostic(`inventory slot wait before ${JSON.stringify(was)}`);
  t.diagnostic(`inventory slot wait after ${JSON.stringify(now)}`);
  assert.equal(was.samples, ORIGINS + LISTS);
  // Sixteen distinct starts 125 ms apart: the median call waited at least a few gaps.
  assert.ok((was.p50Ms ?? 0) >= 3 * 125, `before p50 ${was.p50Ms}`);
  assert.equal(now.samples, LISTS, "origin reads took no slot");
  assert.equal(after.heldOriginAnswers, ORIGINS);
  assert.ok(
    (now.maxMs ?? Infinity) < (was.p50Ms ?? 0),
    `after max ${now.maxMs} is below the before median ${was.p50Ms}`,
  );
});
