import { submission, tempStore } from "./support/fakes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, qualifiedThreadArchiveEffectKey } from "../core/store/store";
import { submissionSchema } from "../shared/contracts";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import type { Adapter } from "../core/host";

for (const status of ["intent", "uncertain"] as const)
  test(`prior-process ${status} without a transport result stays observation-only`, async (t) => {
    const { store } = tempStore(t);
    store.setMeta("paused", false);
    store.setMeta("hostRegistry", [{ id: "host", endpoint: "fixture" }]);
    const initial = store.insert(
      submission({ planningCommit: "a".repeat(40) }),
      "host",
      "handoff",
      "a".repeat(40),
    );
    const task = store.update(initial.id, {
      phase: "done",
      agentId: "worker",
      workspaceId: "ws",
      resolution: { ...initial.resolution, mergedCommit: "b".repeat(40) },
    });
    store.setMeta(qualifiedThreadArchiveEffectKey("host", "worker"), {
      status,
      at: new Date().toISOString(),
    });
    let calls = 0,
      proofs = 0;
    const adapter = {
      observe: async () => ({
        id: "worker",
        workspaceId: "ws",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
        labels: { "northstar.task": task.id },
      }),
      originAgent: async () => ({
        id: "worker",
        workspaceId: "ws",
        title: "",
        archived: false,
      }),
      archiveAgent: async () => {
        calls++;
      },
    } as unknown as Adapter;
    for (let i = 0; i < 3; i++)
      await archiveFinishedThreads(store, adapter, task.id, async () => {
        proofs++;
        return null;
      });
    assert.equal(calls, 0);
    assert.equal(proofs, 0);
    assert.equal(
      store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey("host", "worker"))?.status,
      status,
    );
    assert.ok(
      store
        .eventsAll(task.id)
        .some(
          (event) =>
            event.kind === "thread_archive_wait" &&
            event.detail.includes("observation-only"),
        ),
    );
  });
