import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Adapter } from "../core/host";
import { git } from "../core/git/index";
import { recordIntent } from "../core/verbs/disposition/effects";
import { archiveUnusedWorkspace } from "../core/workspaces/unused-workspace";
import { recordWorkspaceRetirement } from "../core/workspaces/terminal-workspace-retirement";
import { settleExternalWorkspaceArchive } from "../core/workspaces/external-workspace-archive";
import {
  dispositionSchema,
  reviewEntryRecordSchema,
} from "../shared/contracts";
import { profile } from "./support/fakes";
import {
  assertRetry,
  deferredRestart,
  head,
  intentFixture,
  lostReply,
  restartAfterIntent,
} from "./support/intent-restart";

for (const agent of [false, true]) {
  const kind = agent ? "agent_intent" : "dispatch_intent";
  test(`${kind} binds the original native resource across a roll`, async (t) => {
    let attempts = 0;
    let observed = 0;
    const worker = profile("worker-profile");
    const f = intentFixture(
      t,
      {
        validate: async () => head,
        verifyWorkspace: async (task) => task.branch,
        createWorkspace: async () => {
          attempts++;
          throw lostReply;
        },
        createAgent: async () => {
          if (agent) {
            attempts++;
            throw lostReply;
          }
          return { id: "worker", workspaceId: "ws" };
        },
        findWorkspaces: async () => {
          observed++;
          return [{ id: "ws", directory: f.dir }];
        },
        findAgents: async () => {
          observed++;
          return [{ id: "worker", workspaceId: "ws" }];
        },
      },
      {
        phase: agent ? "dispatching" : "queued",
        agentId: null,
        runId: null,
        workspaceId: agent ? "ws" : null,
        prHead: null,
        prUrl: null,
        profile: agent ? worker : null,
        workspaceIntent: agent,
      },
    );
    f.engine.profiles = [worker];
    f.store.setMeta("pool", [
      {
        profileId: worker.id,
        enabled: true,
        group: "fixture",
        weight: 1,
        scopes: ["general"],
      },
    ]);
    await restartAfterIntent(
      f.engine,
      f.id,
      kind,
      async () => {
        if (agent)
          await f.engine
            .launchAgentOnce(f.task())
            .catch((error) => assert.equal(error, lostReply));
        else await f.engine.dispatchTask(f.id, false);
        assert.equal(attempts, 1);
      },
      (store) => {
        const restarted = f.start(store);
        restarted.profiles = [worker];
        return restarted;
      },
      async (store, sweep) => {
        await sweep();
        const task = store.task(f.id);
        assert.equal(
          agent ? task.agentId : task.workspaceId,
          agent ? "worker" : "ws",
        );
        assert.ok(observed >= 1, "read the original target before continuing");
        assert.equal(attempts, 1);
        const count = store
          .eventsAll(f.id)
          .filter((e) => e.kind === kind).length;
        await sweep();
        assert.equal(
          store.eventsAll(f.id).filter((e) => e.kind === kind).length,
          count,
        );
        assert.equal(attempts, 1);
      },
    );
  });
}

test("closeout_workspace_intent rebinds the existing workspace", async (t) => {
  let sends = 0;
  let observations = 0;
  const closeout = { id: "closeout", directory: "fixture-closeout" };
  const ports = {
    workspaceAvailable: async () => false,
    createCloseoutWorkspace: async () => {
      sends++;
      throw lostReply;
    },
    findCloseoutWorkspaces: async () => {
      observations++;
      return [closeout];
    },
    verifyCloseoutWorkspace: async () => {},
  };
  const f = intentFixture(
    t,
    { ...ports, syncMain: async () => head } as Partial<Adapter>,
    { phase: "closing", agentId: null },
  );
  f.engine.resolution.update(f.task(), {
    mergedCommit: head,
    syncedCommit: head,
  });
  const setup = (engine: typeof f.engine) => {
    engine.resolution.closeoutAuthority = async () => "agent";
    engine.resolution.lease = async () => true;
  };
  setup(f.engine);
  await restartAfterIntent(
    f.engine,
    f.id,
    "closeout_workspace_intent",
    () => assert.rejects(f.engine.lifecycle.recover(f.task()), lostReply),
    (store) => {
      const engine = f.start(store);
      setup(engine);
      return engine;
    },
    async (store, sweep) => {
      await sweep();
      assert.equal(
        store.task(f.id).resolution.closeoutWorkspaceId,
        closeout.id,
      );
      assert.equal(sends, 1);
      assert.equal(observations, 1);
      await sweep();
      assert.equal(
        store
          .eventsAll(f.id)
          .filter((e) => e.kind === "closeout_workspace_created").length,
        1,
      );
      assert.equal(sends, 1);
    },
  );
});

test("sibling_worktrees_intent records the project members before provisioning", async (t) => {
  const f = intentFixture(t);
  f.engine.siblingDataDir = f.dir;
  // The fixture stops after the durable write, before any checkout command.
  f.store.projectFor = () =>
    ({
      key: "fixture",
      repositories: [{ origin: null, path: join(f.dir, "sibling") }],
    }) as NonNullable<ReturnType<typeof f.store.projectFor>>;
  const update = f.store.update.bind(f.store);
  await deferredRestart(
    t,
    f,
    "sibling_worktrees_intent",
    async () => {
      f.store.update = (...args) => {
        const task = update(...args);
        if (args[2] === "sibling_worktrees_intent") throw lostReply;
        return task;
      };
      try {
        await assert.rejects(f.engine.ensureSiblings(f.task()), lostReply);
      } finally {
        f.store.update = update;
      }
      f.store.update(f.id, { phase: "done", workspaceId: null });
    },
    "The terminal sibling cleanup scan needs a pin, which this occurrence has not yet written",
    (store) => {
      assert.equal(store.task(f.id).siblingIntent, false);
    },
  );
});

function disposition(status: "complete" | "draining") {
  return dispositionSchema.parse({
    kind: "cancel",
    status,
    requestedAt: new Date().toISOString(),
    requestedBy: "operator",
    reason: "Fixture cancellation",
    workDisposition: "preserve",
    workspaceId: "ws",
  });
}

test("workspace_retirement_intent observes catalog and disk absence on a cancelled task", async (t) => {
  let reads = 0;
  const directory = "absent";
  const f = intentFixture(
    t,
    {
      taskWorkspaceArchived: async () => {
        reads++;
        return true;
      },
      archiveTaskWorkspace: async () =>
        assert.fail("The retired catalog entry must not be sent again"),
    },
    {
      phase: "cancelled",
      disposition: disposition("complete"),
      prHead: null,
      prUrl: null,
    },
  );
  const absent = join(f.dir, directory);
  f.store.update(f.id, { directory: absent });
  await restartAfterIntent(
    f.engine,
    f.id,
    "workspace_retirement_intent",
    async () => {
      const at = new Date().toISOString();
      recordWorkspaceRetirement(f.store, f.id, {
        workspaceId: "ws",
        directory: absent,
        branch: f.task().branch,
        head,
        authorization: {
          caller: "operator",
          kind: "operator",
          note: "",
          reason: "Fixture retired the workspace",
          at,
        },
        state: "intent",
        detail: "Archive reply was lost",
        intentAt: at,
        archivedAt: null,
      });
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      assert.equal(
        store.task(f.id).resolution.workspaceRetirement?.state,
        "archived",
      );
      assert.equal(reads, 1);
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
      assert.equal(reads, 1);
    },
  );
});

test("disposition_effect_intent is settled by the active cancellation fence", async (t) => {
  const f = intentFixture(
    t,
    {
      taskWorkspaceArchived: async () => true,
      archiveTaskWorkspace: async () =>
        assert.fail("A proved archive must not be repeated"),
    },
    { disposition: disposition("draining"), prHead: null, prUrl: null },
  );
  f.store.update(f.id, { directory: join(f.dir, "archived-worktree") });
  await restartAfterIntent(
    f.engine,
    f.id,
    "disposition_effect_intent",
    async () => {
      recordIntent(f.store, f.id, "archive_workspace", "ws");
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      assert.ok(
        store
          .task(f.id)
          .disposition?.effects.find(
            (e) => e.kind === "archive_workspace" && e.target === "ws",
          )?.result,
      );
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
    },
  );
});

test("unused_workspace_archive_intent survives for its existing owner retry", async (t) => {
  let sends = 0;
  const f = intentFixture(
    t,
    {
      archiveTaskWorkspace: async () => {
        sends++;
        throw lostReply;
      },
      findWorkspaces: async () => [
        { id: "duplicate", directory: join(f.dir, "duplicate") },
      ],
    },
    { phase: "blocked", agentId: null, runId: null, prHead: null, prUrl: null },
  );
  const checkout = join(f.dir, "duplicate");
  await mkdir(checkout);
  await git(checkout, "init", "--initial-branch", f.task().branch);
  await git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  );
  f.store.update(f.id, {
    repoPath: checkout,
    planningBase: await git(checkout, "rev-parse", "HEAD"),
  });
  await restartAfterIntent(
    f.engine,
    f.id,
    "unused_workspace_archive_intent",
    () =>
      assert.rejects(
        archiveUnusedWorkspace(
          f.store,
          f.adapter,
          {
            taskId: f.id,
            version: f.task().version,
            unusedWorkspaceId: "duplicate",
          },
          () => true,
        ),
        lostReply,
      ),
    f.start,
    async (store, sweep) => {
      await sweep();
      assertRetry(store, f.id, "workspace_archive.duplicate");
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
      assert.equal(sends, 1);
    },
  );
});

test("external_workspace_archive_intent observes the catalog-only effect after a roll", async (t) => {
  let catalogued = true;
  let sends = 0;
  const placement = {
    kind: "directory",
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  };
  const f = intentFixture(
    t,
    {
      archiveTaskWorkspace: async () =>
        assert.fail("A preserved workspace is catalog-only"),
      taskWorkspaceArchived: async () => !catalogued,
      externalWorkspaceCatalog: async (directory) => ({
        ok: true,
        entries: catalogued
          ? [{ workspaceId: "ws", directory, placement }]
          : [],
      }),
      archiveExternalWorkspace: async (input) => {
        assert.equal(input.allowed(placement, [], null), true);
        sends++;
        catalogued = false;
        throw lostReply;
      },
    },
    { phase: "done" },
  );
  const details = { ...f.task(), repository: "example/repo" };
  f.store.update(f.id, {
    entrypoint: "review",
    reviewEntry: reviewEntryRecordSchema.parse({
      operationId: "c".repeat(64),
      prNumber: 1,
      repository: details.repository,
      branch: details.branch,
      workspaceId: "ws",
      verifiedHead: head,
      verifiedBase: head,
      planningCommit: head,
      authority: "Fixture approval",
      authorDeclaration: {
        models: ["fixture/model"],
        githubAuthor: "author",
        authoringSystem: "fixture",
        attestedBy: "operator",
        provenance: "Fixture",
      },
      checkedAt: new Date().toISOString(),
      preserveWorkspace: true,
      directory: f.dir,
    }),
  });
  f.engine.resolution.update(f.task(), {
    mergedCommit: head,
    syncedCommit: head,
  });
  await restartAfterIntent(
    f.engine,
    f.id,
    "external_workspace_archive_intent",
    async () => {
      await settleExternalWorkspaceArchive(
        {
          store: f.store,
          adapter: f.adapter,
          paused: () => false,
          resolution: f.engine.resolution,
        },
        f.id,
      );
      const archives = f.task().resolution.externalWorkspaceArchives;
      f.engine.resolution.update(f.task(), {
        externalWorkspaceArchives: archives.map((record) => ({
          ...record,
          nextAttemptAt: new Date(0).toISOString(),
        })),
      });
    },
    f.start,
    async (store, sweep) => {
      await sweep();
      assert.equal(
        store.task(f.id).resolution.externalWorkspaceArchives[0]?.state,
        "archived",
      );
      const events = store.eventsAll(f.id);
      await sweep();
      assert.deepEqual(store.eventsAll(f.id), events);
      assert.equal(sends, 1);
    },
  );
});
