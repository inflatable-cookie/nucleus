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

for (const landed of [true, false])
  test(`lost archive response: ${landed ? "landed request is observed" : "unlanded request is reissued after proof"}`, async (t) => {
    const store = new Store(
      join(mkdtempSync(join(tmpdir(), "archive-unknown-")), "queue.sqlite"),
    );
    t.after(() => store.close());
    store.setMeta("paused", false);
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
      workspaceId: "ws",
      resolution: { ...initial.resolution, mergedCommit: "b".repeat(40) },
    });
    let archived = false,
      sends = 0,
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
        archived,
      }),
      archiveAgent: async () => {
        sends++;
        if (sends === 1) {
          archived = landed;
          throw Error("connection reset after send");
        }
        archived = true;
      },
    } as unknown as Adapter;
    const proof = async () => {
      proofs++;
      return null;
    };
    await archiveFinishedThreads(store, adapter, task.id, proof);
    assert.equal(
      store.getMeta<{ status: string }>(
        qualifiedThreadArchiveEffectKey("host", "worker"),
      )?.status,
      "uncertain",
    );
    await archiveFinishedThreads(store, adapter, task.id, proof);
    assert.equal(
      store.getMeta<{ status: string }>(
        qualifiedThreadArchiveEffectKey("host", "worker"),
      )?.status,
      "archived",
    );
    assert.equal(sends, landed ? 1 : 2);
    assert.equal(proofs, landed ? 0 : 1);
    if (!landed)
      assert.ok(
        store
          .eventsAll(task.id)
          .some(
            (event) =>
              event.kind === "thread_archive_wait" &&
              event.detail.includes("reissuing"),
          ),
      );
  });
