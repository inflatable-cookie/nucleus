import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { holdPatch } from "../core/merge/merge-hold";
import { submissionSchema } from "../shared/contracts";
import type { Adapter } from "../core/host";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const store = new Store(":memory:");
  const engine = new Engine(store, {} as Adapter, 0);
  store.setMeta("paused", false);
  store.setMeta("globalLimit", 0);
  engine.wakeRepository = async () => {};
  const add = () =>
    store.insert(
      submissionSchema.parse({
        submissionId: randomUUID(),
        title: "Task",
        repoPath: "/fixture",
        planningCommit: "a".repeat(40),
        handoffPath: "handoff.md",
        originAgentId: "origin",
      }),
      "host",
      "handoff",
      "a".repeat(40),
    );
  return {
    store,
    engine,
    add,
    close: async () => {
      await engine.stop();
      store.close();
    },
  };
}

test("a busy dependent lane does not block the safety sweep", async () => {
  const f = fixture();
  const gate = deferred(),
    entered = deferred();
  const internals = f.engine as unknown as {
    auditPass(
      drain: boolean,
      visited: Set<string>,
    ): Promise<{ fault: Error | null; covered: boolean; visited: Set<string> }>;
  };
  let passes = 0;
  internals.auditPass = async (_drain, visited) => {
    passes++;
    return { fault: null, covered: true, visited };
  };
  try {
    const parent = f.add(),
      child = f.add();
    f.store.update(child.id, { dependsOn: [parent.id] });
    const held = f.engine.scheduleLane(`task:${child.id}`, 0, async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    f.store.update(parent.id, { phase: "done" });
    const finished = await Promise.race([
      f.engine.sweepOnce().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(
      finished,
      true,
      "the sweep must finish while the dependent lane is held",
    );
    assert.equal(passes, 1);
    gate.resolve();
    await held;
    await f.engine.wake();
  } finally {
    gate.resolve();
    await f.close();
  }
});

for (const shape of [
  "parked prerequisite",
  "queued self-lifting hold",
] as const) {
  test(`settlement keeps task quanta exclusive for ${shape}`, async () => {
    const f = fixture();
    const gate = deferred(),
      started = deferred();
    let starts = 0,
      active = 0,
      maximum = 0;
    const internals = f.engine as unknown as {
      taskQuantum(id: string): Promise<void>;
      activeLanes: Set<string>;
    };
    try {
      const parent = f.add(),
        child = f.add();
      if (shape === "parked prerequisite")
        f.store.update(child.id, {
          phase: "awaiting_review",
          prerequisiteWait: {
            id: randomUUID(),
            waitsFor: [parent.id],
            reason: "Wait",
            releasedAt: null,
          },
        });
      else
        f.store.update(
          child.id,
          holdPatch(child, "dispatch", "operator", "Wait", {
            kind: "task",
            taskId: parent.id,
          }),
        );
      internals.taskQuantum = async (id) => {
        if (id !== child.id) return;
        starts++;
        active++;
        maximum = Math.max(maximum, active);
        if (starts === 1) {
          started.resolve();
          await gate.promise;
        }
        active--;
      };
      f.store.update(parent.id, { phase: "done" });
      await started.promise;
      const second = f.engine.wakeTask(child.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        internals.activeLanes.has(`task:${child.id}`),
        true,
        "the running quantum owns its lane",
      );
      assert.equal(
        starts,
        1,
        "the callback must wait for the existing quantum",
      );
      gate.resolve();
      await second;
      assert.equal(starts, 2);
      assert.equal(maximum, 1);
    } finally {
      gate.resolve();
      await f.close();
    }
  });
}
