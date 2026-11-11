import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import {
  externalArchiveHoldReason,
  externalWorkspaceArchiveDue,
} from "../core/workspaces/external-workspace-archive";
import {
  externalWorkspaceArchivesSettled,
  reviewEntryRecordSchema,
  submissionSchema,
  taskControlInputSchema,
} from "../shared/contracts";
import type { Adapter } from "../core/host";
import type { ResolutionAdapter } from "../core/resolution";

const head = "a".repeat(40),
  workspaceId = "ws-ext",
  directory = "/external";
test("settling a catalog archive keeps its unknown outcome and stops automatic retry", async () => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), "force-external-")), "queue.sqlite"),
  );
  const task = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "External archive",
      repoPath: "/repo",
      planningCommit: head,
      handoffPath: "handoff.md",
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    head,
    {
      entrypoint: "review",
      reviewEntry: reviewEntryRecordSchema.parse({
        operationId: "c".repeat(64),
        prNumber: 41,
        repository: "example/repo",
        branch: "feature/external",
        workspaceId,
        verifiedHead: head,
        verifiedBase: head,
        planningCommit: head,
        authority: "Operator approved takeover",
        authorDeclaration: {
          models: ["openai/gpt-5"],
          githubAuthor: "external-author",
          authoringSystem: "external-agent",
          attestedBy: "operator",
          provenance: "Fixture attestation",
        },
        checkedAt: new Date().toISOString(),
        preserveWorkspace: true,
        directory,
      }),
    },
  );
  let calls = 0;
  const adapter = {
    observe: async () => {
      calls++;
      throw Error("unexpected");
    },
  } as unknown as Adapter & ResolutionAdapter;
  const engine = new Engine(store, adapter, 0);
  await engine.stop();
  store.setMeta("paused", false);
  try {
    store.update(task.id, {
      workspaceId,
      directory,
      phase: "done",
      resolution: {
        ...store.task(task.id).resolution,
        mergedCommit: head,
        syncedCommit: head,
        externalWorkspaceArchives: [
          {
            workspaceId,
            directory,
            requestId: "archive-request",
            state: "uncertain",
            observed: null,
            participants: [],
            native: null,
            folderPresent: null,
            detail: "unknown",
            attempts: 1,
            source: null,
            folderRemovalAuthorized: false,
            folderRemovedBy: null,
            samePathRegistrations: [workspaceId],
            intentAt: "2026-11-04T00:00:00.000Z",
            settledAt: null,
            nextAttemptAt: null,
          },
        ],
      },
    });
    const before = store.task(task.id);
    assert.equal(externalWorkspaceArchiveDue(before), true);
    const after = await engine.performTaskControl(
      taskControlInputSchema.parse({
        taskId: task.id,
        version: before.version,
        action: "retry_effect",
        effect: `external_workspace_archive.${workspaceId}`,
        force: true,
        caller: "operator (board)",
        reason: "Owner settled",
      }),
    );
    assert.equal(calls, 0);
    assert.equal(
      after.resolution.externalWorkspaceArchives[0].state,
      "uncertain",
    );
    assert.equal(externalWorkspaceArchiveDue(after), false);
    assert.equal(externalArchiveHoldReason(after), "");
    assert.equal(externalWorkspaceArchivesSettled(after), true);
  } finally {
    store.close();
  }
});
