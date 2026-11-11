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

test("settling an uncertain merge records it without observation or a reissue", async () => {
  const f = await setup();
  try {
    f.store.update(f.task().id, {
      phase: "merging",
      resolution: {
        ...f.task().resolution,
        mergeIntent: true,
        mergeHead: head,
        mergeRequestedAt: "2026-11-04T00:00:00.000Z",
        mergeResponseOutcome: "uncertain",
        integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
      },
    });
    const result = await f.force("merge-response.merge-response");
    assert.equal(f.calls(), 0);
    assert.equal(result.resolution.mergeIntent, false);
    assert.equal(result.resolution.integrationTurn, null);
    assert.equal(result.resolution.mergeAutoRetryExhausted, true);
    assert.ok(
      f.store
        .eventsAll(result.id)
        .some((event) => event.kind === "owner_settled_merge_intent"),
    );
  } finally {
    f.store.close();
  }
});

test("running project validation offers force and records supersession, never a pass", async () => {
  const f = await setup();
  try {
    f.store.update(f.task().id, {
      phase: "verifying",
      prHead: head,
      resolution: {
        ...f.task().resolution,
        projectValidation: {
          argv: ["test"],
          digest: "d",
          exitCode: null,
          durationMs: 0,
          outputTail: "",
          base,
          head,
          state: "running",
          hostRunId: "run-1",
          queueBuild: "",
          settingsRevision: 0,
          pid: null,
          capacityWait: null,
          capacityUnavailable: false,
        },
      },
    });
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.task()));
    const retry = next.verbs.find(
      (view) =>
        view.verb === "retry_effect" &&
        view.forceArgs?.effect === "project-validation.project-validation",
    );
    assert.equal(retry?.available, false);
    assert.equal(retry?.forceArgs?.force, true);
    const result = await f.force("project-validation.project-validation");
    assert.equal(result.resolution.projectValidation?.state, "superseded");
    assert.equal(f.calls(), 0);
  } finally {
    f.store.close();
  }
});

test("settled workspace archive stays historical and no longer owns the archive lane", async () => {
  const f = await setup();
  try {
    f.store.update(f.task().id, {
      phase: "done",
      workspaceId: "ws",
      directory: "/worktree",
      prHead: head,
      resolution: {
        ...f.task().resolution,
        mergedCommit: base,
        archiveIntentWorkspaceId: "ws",
        archiveIntentHead: head,
        workspaceArchiveRetries: [
          {
            workspaceId: "ws",
            attempts: 1,
            error: "unknown",
            nextAttemptAt: "2026-11-04T00:00:00.000Z",
          },
        ],
      },
    });
    await f.force("workspace_archive.ws");
    assert.equal(archiveSettledByOwner(f.task(), "ws"), true);
    assert.equal(
      f.task().resolution.archivedWorkspaceIds.includes("ws"),
      false,
    );
    assert.equal(f.calls(), 0);
  } finally {
    f.store.close();
  }
});

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
