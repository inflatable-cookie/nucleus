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

for (const condition of ["busy", "wrong workspace", "tool hold", "limit"])
  test(`unknown archive waits for ${condition}`, async (t) => {
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
      status: "uncertain",
      at: new Date().toISOString(),
      retries: condition === "limit" ? 3 : 0,
    });
    let sends = 0;
    const adapter = {
      observe: async () => ({
        id: "worker",
        workspaceId: condition === "wrong workspace" ? "other" : "ws",
        status: condition === "busy" ? "running" : "idle",
        active: condition === "busy",
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
        sends++;
      },
    } as unknown as Adapter;
    await archiveFinishedThreads(store, adapter, task.id, async () =>
      condition === "tool hold" ? "live shell" : null,
    );
    assert.equal(sends, 0);
    assert.ok(
      store
        .eventsAll(task.id)
        .some((event) => event.kind === "thread_archive_wait"),
    );
    assert.equal(
      store.getMeta<{ status: string }>(qualifiedThreadArchiveEffectKey("host", "worker"))?.status,
      "uncertain",
    );
  });
