import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema, taskControlInputSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

test("an unchanged move is refused with the next step", async () => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "owner-noop-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "No-op",
      repoPath: "/repo",
      planningCommit: "a".repeat(40),
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    "a".repeat(40),
  );
  const engine = new Engine(store, {} as Adapter & ResolutionAdapter, 0);
  await engine.stop();
  engine.moveToReview = async () => store.task(task.id);
  try {
    await assert.rejects(
      engine.performTaskControl(
        taskControlInputSchema.parse({
          action: "move",
          to: "review",
          taskId: task.id,
          version: store.task(task.id).version,
          reason: "Continue",
          caller: "operator (board)",
        }),
      ),
      /could not change.*read next/i,
    );
    assert.equal(store.task(task.id).version, task.version);
  } finally {
    store.close();
  }
});
