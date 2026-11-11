import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { collectOwnerVerbFacts, ownerTaskNext } from "../core/verbs/owner-verbs";
import {
  runSchema,
  submissionSchema,
  taskControlInputSchema,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  base = "b".repeat(40);
async function fixture(failStop = false, failObserve = false) {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-live-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Live turn",
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
    observe: async (id: string) => {
      if (failObserve) throw Error("unavailable");
      return {
        id,
        workspaceId: "ws",
        status: "running",
        active: true,
        activeTurnId: "turn",
        permissions: false,
        error: "",
      };
    },
    stopAgentTurn: async () => {
      calls++;
      if (failStop) throw Error("lost response");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.putRun(
    runSchema.parse({
      id: "reviewer-run",
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
      status: "running",
      createdAt: new Date().toISOString(),
      lastObservedAt: null,
      active: true,
      idleSince: null,
      completion: null,
      released: false,
    }),
  );
  const move = () =>
    engine.performTaskControl(
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
  return { store, task, move, calls: () => calls };
}

test("forced move cancels the live turn before releasing the run", async () => {
  const f = await fixture();
  try {
    await f.move();
    assert.equal(f.calls(), 1);
    assert.equal(f.store.run("reviewer-run")?.released, true);
    const events = f.store.eventsAll(f.task.id);
    assert.ok(
      events.findIndex((event) => event.kind === "owner_stop_sent") <
        events.findIndex((event) => event.kind === "owner_force_move"),
    );
  } finally {
    f.store.close();
  }
});

test("forced move records uncertain observation or cancellation and still moves", async () => {
  for (const [failStop, failObserve] of [
    [true, false],
    [false, true],
  ]) {
    const f = await fixture(failStop, failObserve);
    try {
      const result = await f.move();
      assert.equal(f.store.run("reviewer-run")?.released, true);
      assert.equal(result.phase, "changes_requested");
      assert.match(result.reason, /uncertain/);
      assert.ok(
        f.store
          .eventsAll(f.task.id)
          .some((event) => event.kind === "owner_force_uncertain_participant"),
      );
      assert.equal(f.calls(), 1);
    } finally {
      f.store.close();
    }
  }
});

test("forced move settles a run without a bound agent", async () => {
  const f = await fixture();
  try {
    f.store.putRun({ ...f.store.run("reviewer-run")!, agentId: null });
    const result = await f.move();
    assert.equal(result.phase, "changes_requested");
    assert.equal(f.store.run("reviewer-run")?.released, true);
    assert.match(result.reason, /no bound agent/);
    assert.equal(f.calls(), 0);
  } finally {
    f.store.close();
  }
});

test("next offers forced merge at an ordinary awaiting-review gate", async () => {
  const f = await fixture();
  try {
    const task = f.store.update(f.task.id, {
      phase: "awaiting_review",
      prHead: head,
      prUrl: "https://github.com/example/repo/pull/7",
      resumePrNumber: 7,
    });
    const merge = ownerTaskNext(
      collectOwnerVerbFacts(f.store, task),
    ).verbs.find(
      (view) => view.verb === "move" && view.forceArgs?.to === "merge",
    );
    assert.equal(merge?.forceArgs?.force, true);
    assert.ok(merge?.forceFill?.includes("qualification"));
  } finally {
    f.store.close();
  }
});
