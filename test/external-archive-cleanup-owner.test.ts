import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import {
  externalArchiveHoldReason,
  externalWorkspaceArchiveRequestId,
  settleExternalWorkspaceArchive,
  type ExternalWorkspaceArchivePorts,
} from "../core/workspaces/external-workspace-archive";
import {
  externalArchiveOccurrence,
  reviewEntryRecordSchema,
  submissionSchema,
  type ExternalWorkspaceArchive,
} from "../shared/contracts";
import type {
  Adapter,
  ExternalWorkspaceArchiveInput,
  ExternalWorkspaceCatalogEntry,
} from "../core/host";

/**
 * Which cleanup cause the catalog archive is allowed to clear.
 *
 * The shared `cleanupReason` field carries several owners' causes, and a task
 * with a non-empty one counts as attention on the board
 * (`core/store/store-board-index.ts`). This effect may only clear its own line,
 * and its own line includes the cause an owner's settlement has since made
 * stale: `force-settlement` writes `ownerSettlements` without touching
 * `cleanupReason`, and the derived cause excludes owner-settled registrations, so
 * an ownership test that compares against that derivation keeps the stale line
 * forever. Review 5914265742 found exactly that; these witnesses pin it.
 */

const head = "a".repeat(40);
const bound = "ws-bound",
  sibling = "ws-sibling";
/** Two worktree registrations at one preserved folder: both may be archived, and the host may remove the folder. */
const placement = {
  kind: "worktree",
  hostOwnedWorktree: true,
  mainRepoRoot: "/repo",
};

interface Fixture {
  store: Store;
  taskId: string;
  directory: string;
  calls: string[];
  ports: ExternalWorkspaceArchivePorts;
}

/** The held registration and its recorded visible cause, plus a storage stub that archives what it is handed. */
function fixture(
  t: TestContext,
  cleanupReason?: (visible: string) => string,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ns-external-cleanup-"));
  const directory = join(root, "external");
  mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(":memory:");
  t.after(() => store.close());
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "External cleanup owner",
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
        workspaceId: bound,
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
  const held: ExternalWorkspaceArchive = {
    workspaceId: bound,
    directory,
    requestId: externalWorkspaceArchiveRequestId(inserted.id, bound),
    state: "held",
    observed: null,
    participants: [],
    native: null,
    folderPresent: true,
    detail: "A host run still holds the preserved workspace",
    attempts: 2,
    source: null,
    folderRemovalAuthorized: false,
    folderRemovedBy: null,
    samePathRegistrations: [bound, sibling],
    deferredByAdmission: false,
    intentAt: null,
    settledAt: new Date().toISOString(),
    nextAttemptAt: null,
  };
  store.update(inserted.id, {
    workspaceId: bound,
    directory,
    branch: "feature/external",
    phase: "done",
    resolution: {
      ...store.task(inserted.id).resolution,
      mergedCommit: head,
      syncedCommit: head,
      externalWorkspaceArchives: [held],
      cleanupReason: externalArchiveHoldReason({
        ...store.task(inserted.id),
        resolution: {
          ...store.task(inserted.id).resolution,
          externalWorkspaceArchives: [held],
        },
      }),
    },
  });
  // The owner force-settles the held registration: the same effect and occurrence
  // the archive records, and no write to `cleanupReason`.
  const settled = store.task(inserted.id);
  store.update(
    inserted.id,
    {
      resolution: {
        ...settled.resolution,
        cleanupReason: cleanupReason
          ? cleanupReason(settled.resolution.cleanupReason)
          : settled.resolution.cleanupReason,
        ownerSettlements: [
          ...settled.resolution.ownerSettlements,
          {
            effect: `external_workspace_archive.${bound}`,
            occurrence: externalArchiveOccurrence(bound, held),
            summary:
              "The owner settled this catalog archive without an observation",
            recoveryKeys: [],
            caller: "operator (board)",
            source: "operator_board" as const,
            reason: "Force-settled in a fixture",
            at: new Date().toISOString(),
          },
        ],
      },
    },
    "owner_settled",
  );

  const calls: string[] = [];
  const entry = (workspaceId: string): ExternalWorkspaceCatalogEntry => ({
    workspaceId,
    directory,
    placement,
  });
  const adapter = {
    externalWorkspaceCatalog: async () => ({
      ok: true as const,
      entries: [entry(bound), entry(sibling)],
    }),
    archiveExternalWorkspace: async (input: ExternalWorkspaceArchiveInput) => {
      calls.push(input.workspaceId);
      if (!input.allowed(placement, [], null))
        return { status: "declined" as const, reason: "declined" };
      return {
        status: "archived" as const,
        observed: placement,
        participants: [],
        native: { archivedAt: new Date().toISOString(), error: null },
        folderPresent: true,
      };
    },
  } as unknown as Adapter;
  return {
    store,
    taskId: inserted.id,
    directory,
    calls,
    ports: {
      store,
      adapter,
      paused: () => false,
      resolution: {
        update: (task, changes, patch, event, detail) =>
          store.update(
            task.id,
            {
              ...patch,
              resolution: { ...store.task(task.id).resolution, ...changes },
            },
            event,
            detail,
          ),
      },
    },
  };
}

test("a sibling archive clears the cause an owner's settlement made stale", async (t) => {
  const f = fixture(t);
  const before = f.store.task(f.taskId);
  assert.match(
    before.resolution.cleanupReason,
    /^External workspace catalog entry held for ws-bound: /,
    "the pass recorded its own visible cause while the registration was held",
  );

  const after = await settleExternalWorkspaceArchive(f.ports, f.taskId);

  assert.deepEqual(
    f.calls,
    [sibling],
    "the owner-settled registration is never called",
  );
  assert.equal(
    after.resolution.externalWorkspaceArchives.find(
      (record) => record.workspaceId === sibling,
    )!.state,
    "archived",
  );
  assert.equal(
    after.resolution.externalWorkspaceArchives.find(
      (record) => record.workspaceId === bound,
    )!.state,
    "held",
    "the owner-settled record is history and is not rewritten",
  );
  assert.equal(
    after.resolution.cleanupReason,
    "",
    "with nothing left unsettled the external cause is cleared, so the task stops counting as attention",
  );
});

test("another owner's cleanup cause is never cleared by this effect", async (t) => {
  const f = fixture(t, () => "runtime retirement failed: workspace ws-bound");
  const after = await settleExternalWorkspaceArchive(f.ports, f.taskId);
  assert.equal(
    after.resolution.cleanupReason,
    "runtime retirement failed: workspace ws-bound",
    "the shared field holds another owner's cause, which this effect leaves exactly as it was",
  );
  assert.deepEqual(f.calls, [sibling]);
});
