import { submission, tempStore } from "./support/fakes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Admission, admitAdapter } from "../core/host/admission";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import { submissionSchema, runSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";

test("terminal thread pipelines overlap without exceeding shared Paseo admission", async (t) => {
  const { store } = tempStore(t);
  store.setMeta("paused", false);
  const initial = store.insert(
    submission({ planningCommit: "a".repeat(40) }),
    "host",
    "handoff",
    "a".repeat(40),
  );
  const task = store.update(initial.id, {
    phase: "done",
    agentId: "worker",
    resolution: { ...initial.resolution, mergedCommit: "b".repeat(40) },
  });
  for (const id of ["reviewer", "revision"])
    store.putRun(
      runSchema.parse({
        id,
        taskId: task.id,
        role: "reviewer",
        generation: 1,
        agentId: id,
        workspaceId: "ws",
        status: "finished",
        released: true,
        head: "b".repeat(40),
        base: "a".repeat(40),
        profile: null,
        lastObservedAt: null,
        active: false,
        idleSince: null,
        completion: null,
        createdAt: new Date().toISOString(),
      }),
    );
  let active = 0,
    peak = 0,
    calls = 0;
  const archived = new Set<string>();
  const call = async <T>(value: T): Promise<T> => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return value;
  };
  const raw = {
    observe: async (id: string) =>
      call({
        id,
        workspaceId: "ws",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
        labels: { "northstar.task": task.id },
      }),
    originAgent: async (id: string) =>
      call({ id, workspaceId: "ws", title: "", archived: archived.has(id) }),
    archiveAgent: async (id: string) => {
      await call(undefined);
      await call(undefined);
      archived.add(id);
    },
  } as unknown as Adapter;
  const admission = new Admission({
    totalLimit: 2,
    startIntervalMs: 0,
    observationCacheMs: 0,
  });
  const adapter = admitAdapter(raw, admission);
  const start = Date.now();
  await Promise.all([
    archiveFinishedThreads(store, adapter, task.id),
    ...Array.from({ length: 3 }, (_, i) =>
      admission.run("control", () => call(i)),
    ),
  ]);
  assert.equal(archived.size, 3);
  assert.equal(
    calls,
    18,
    "three agents use five calls each, alongside three control calls",
  );
  assert.ok(peak <= 2, `global cap is two, observed ${peak}`);
  assert.equal(peak, 2, "independent calls overlapped under load");
  t.diagnostic(
    `${calls} Paseo calls; peak ${peak} of 2 allowed; elapsed ${Date.now() - start} ms`,
  );
});
