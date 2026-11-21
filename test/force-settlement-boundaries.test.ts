import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { archiveSettledByOwner } from "../core/workspaces/archive-intent";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import {
  submissionSchema,
  taskControlInputSchema,
  holdsOf,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  base = "b".repeat(40);
async function setup() {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-settled-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Settlement",
      repoPath: "/repo",
      planningCommit: base,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    base,
  );
  let calls = 0;
  const adapter = {
    observe: async () => {
      calls++;
      throw Error("unavailable");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta("paused", false);
  const current = () => store.task(task.id);
  const force = (effect: string) =>
    engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: current().version,
        action: "retry_effect",
        effect,
        force: true,
        caller: "operator (board)",
        reason: "Owner settled this occurrence",
      }),
    );
  return { store, task: current, force, engine, calls: () => calls };
}

test("stop releases a held turn even when participant observation fails", async () => {
  const f = await setup();
  try {
    f.store.update(f.task().id, {
      phase: "merging",
      agentId: "worker",
      runId: "worker-run",
      workspaceId: "ws",
      resolution: {
        ...f.task().resolution,
        integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      },
    });
    const result = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: f.task().id,
        version: f.task().version,
        action: "stop",
        reason: "Free the turn",
        caller: "operator (board)",
      }),
    );
    assert.equal(result.resolution.integrationTurn, null);
    assert.ok(holdsOf(result).dispatch);
    assert.match(result.reason, /Remaining activity needs attention/);
  } finally {
    f.store.close();
  }
});
