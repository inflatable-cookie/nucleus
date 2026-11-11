import { submission, tempStore } from "./support/fakes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, qualifiedThreadArchiveEffectKey } from "../core/store/store";
import { submissionSchema } from "../shared/contracts";
import { AdmissionDeferred } from "../core/host/admission";
import { archiveFinishedThreads } from "../core/workspaces/thread-archive";
import type { Adapter } from "../core/host";

test("an admission refusal before delivery remains retryable", async (t) => {
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
  let attempts = 0,
    archived = false;
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
      archived,
    }),
    archiveAgent: async () => {
      attempts++;
      if (attempts === 1)
        throw new AdmissionDeferred("backpressure", "deferred before dispatch");
      archived = true;
    },
  } as unknown as Adapter;
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(
    store.getMeta<{ status: string }>(
      qualifiedThreadArchiveEffectKey("host", "worker"),
    )?.status,
    "ready",
  );
  await archiveFinishedThreads(store, adapter, task.id);
  assert.equal(archived, true);
  assert.equal(attempts, 2);
});
