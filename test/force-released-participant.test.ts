import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  runSchema,
  submissionSchema,
  taskControlInputSchema,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  base = "b".repeat(40);
test("a previously released but still live participant is cancelled before a forced move", async () => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-released-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Released participant",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  let cancelled = false;
  const adapter = {
    observe: async (id: string) => ({
      id,
      workspaceId: "ws",
      status: "running",
      active: true,
      activeTurnId: "turn",
      permissions: false,
      error: "",
    }),
    stopAgentTurn: async () => {
      cancelled = true;
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  try {
    store.putRun(
      runSchema.parse({
        id: "old-review",
        taskId: task.id,
        role: "reviewer",
        generation: 1,
        head,
        base,
        agentId: "reviewer",
        workspaceId: "ws",
        profile: {
          id: "p",
          name: "p",
          provider: "test",
          model: "test",
          notes: "",
          available: true,
          problem: "",
          supportedThinking: [],
        },
        status: "superseded",
        createdAt: new Date().toISOString(),
        lastObservedAt: null,
        active: false,
        idleSince: null,
        completion: null,
        released: true,
      }),
    );
    await engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: store.task(task.id).version,
        action: "move",
        to: "work",
        force: true,
        caller: "operator (board)",
        reason: "Move on",
      }),
    );
    assert.equal(cancelled, true);
    assert.ok(
      store
        .eventsAll(task.id)
        .some((event) => event.kind === "owner_stop_sent"),
    );
  } finally {
    store.close();
  }
});
