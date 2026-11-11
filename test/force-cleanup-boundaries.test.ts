import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { RuntimeRetirementService } from "../core/runtime/runtime-retirement";
import {
  collectOwnerVerbFacts,
  ownerPendingEffects,
} from "../core/verbs/owner-verbs";
import {
  runtimeRetirementFailure,
  submissionSchema,
  taskControlInputSchema,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  commit = "b".repeat(40);
async function setup() {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-cleanup-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Force cleanup",
      repoPath: "/repo",
      planningCommit: commit,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    commit,
  );
  let observations = 0;
  const adapter = {
    merged: async () => ({ merged: true, commit, head, base: "main" }),
    observe: async (id: string) => {
      observations++;
      if (id !== "worker") throw Error("unobservable");
      return {
        id,
        workspaceId: "ws",
        status: "idle",
        active: false,
        permissions: false,
        error: "",
      };
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
        reason: "Owner settled",
      }),
    );
  return { store, engine, current, force, observations: () => observations };
}

test("settled runtime retirement is retained and automatic retry does not send", async () => {
  const f = await setup();
  try {
    f.store.update(f.current().id, {
      phase: "done",
      resolution: {
        ...f.current().resolution,
        runtimeRetirements: [
          {
            workspaceId: "ws",
            directory: "/work",
            scope: { kind: "worktree", token: "token" },
            state: "failed",
            capturedAt: "2026-11-04T00:00:00.000Z",
            provedAt: null,
            attempts: 1,
            error: "failed",
            outputTail: "",
            nextAttemptAt: null,
          },
        ],
      },
    });
    await f.force("runtime_retirement.ws");
    let calls = 0;
    const service = new RuntimeRetirementService(f.store, async () => {
      calls++;
      throw Error("unexpected");
    });
    await service.retryDue(f.current().id);
    assert.equal(calls, 0);
    assert.equal(runtimeRetirementFailure(f.current()), "");
    assert.equal(f.current().resolution.runtimeRetirements[0].state, "failed");
  } finally {
    f.store.close();
  }
});

test("a new cleanup occurrence is not hidden by the previous settlement", async () => {
  const f = await setup();
  try {
    const record = {
      workspaceId: "ws",
      directory: "/work",
      state: "uncertain" as const,
      detail: "unknown",
      at: "2026-11-04T00:00:00.000Z",
    };
    f.store.update(f.current().id, {
      phase: "done",
      resolution: { ...f.current().resolution, buildOutputCleanups: [record] },
    });
    await f.force("build_output_cleanup.ws");
    assert.equal(
      ownerPendingEffects(collectOwnerVerbFacts(f.store, f.current())).some(
        (e) => e.effect === "build_output_cleanup.ws",
      ),
      false,
    );
    f.store.update(f.current().id, {
      resolution: {
        ...f.current().resolution,
        buildOutputCleanups: [{ ...record, at: "2026-11-04T00:01:00.000Z" }],
      },
    });
    assert.equal(
      ownerPendingEffects(collectOwnerVerbFacts(f.store, f.current())).some(
        (e) => e.effect === "build_output_cleanup.ws",
      ),
      true,
    );
  } finally {
    f.store.close();
  }
});

test("forced merged closeout supersedes only the recorded participant identities", async () => {
  const f = await setup();
  try {
    f.store.update(f.current().id, {
      phase: "needs_attention",
      agentId: "worker",
      workspaceId: "ws",
      prHead: head,
      resumePrNumber: 7,
    });
    const result = await f.engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: f.current().id,
        version: f.current().version,
        action: "move",
        to: "closeout",
        force: true,
        caller: "operator (board)",
        reason: "PR is merged",
      }),
    );
    assert.deepEqual(result.resolution.ownerCloseoutParticipants, [
      { agentId: "worker", workspaceId: "ws" },
    ]);
    const lease = f.engine.resolution as unknown as {
      executionLease(
        task: typeof result,
        enclosing: undefined,
        syncing: boolean,
      ): Promise<boolean>;
    };
    assert.equal(await lease.executionLease(result, undefined, true), true);
    assert.equal(f.observations(), 1);
    const changed = { ...result, agentId: "new-worker" };
    await assert.rejects(
      lease.executionLease(changed, undefined, true),
      /unobservable/,
    );
    assert.equal(f.observations(), 2);
  } finally {
    f.store.close();
  }
});
