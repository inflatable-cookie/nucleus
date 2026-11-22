import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  assertCheckoutAvailable,
  CheckoutRefusalError,
  CheckoutUnavailableError,
  liveCheckoutPlacement,
  type CheckoutVolumeInfo,
} from "../core/workspaces/checkout-volume";
import {
  getLocalWorkspacePlacement,
  getWorkRoot,
  initializeWorkRoot,
} from "../core/workspaces/work-root.mjs";
import {
  bbWorkspacePathInRoot,
  ownedWorkspacePath,
  repoCommonDir,
  workspacePathInRoot,
} from "../core/workspaces/workspace-allocation";
import { classifyOrphanWorktree } from "../core/workspaces/orphan-worktree";
import {
  canonicalLinkRoot,
  provisionWorktreeLinks,
} from "../core/workspaces/worktree-links";
import { runScratchRoot } from "../core/workspaces/run-scratch";
import { liveBackupDir } from "../core/store/backup-worker.mjs";
import { chooseWorkspaceProvider } from "../core/workspaces/barge-allocator";
import { defaultDataDir } from "../shared/service/default-data-dir";
import { Store } from "../core/store/store";
import { PaseoAdapter } from "../service/paseo-composition";
import { submissionSchema, type Task } from "../shared/contracts";
import { reviewEntryRecordSchema } from "../shared/schema/review/entry";

function gitRepo(root: string) {
  const run = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "base");
  return run;
}

const volumeInfo = (
  mount: string,
  uuid = "stash-uuid",
): CheckoutVolumeInfo => ({
  MountPoint: mount,
  VolumeUUID: uuid,
  Internal: false,
  Writable: true,
  WritableVolume: true,
});

function createPlacementAdapter(
  dataDir: string,
  mount: string,
  uuid: string,
  observe: (path: string) => CheckoutVolumeInfo,
  readSettings: () => ReturnType<typeof getLocalWorkspacePlacement>,
) {
  const placement = readSettings();
  return new PaseoAdapter(
    "ws://127.0.0.1:1",
    join(dataDir, "cb.sock"),
    join(dataDir, "report.mjs"),
    undefined,
    undefined,
    {
      dataDir: join(placement.workRoot, "queue"),
      workspaceRoot: placement.activeRoot,
      retainedWorkspaceRoots: placement.retainedRoots,
      admit: (target: string) =>
        assertCheckoutAvailable({
          mount,
          uuid,
          observe,
          workspaceRoot: placement.activeRoot,
          retainedWorkspaceRoots: placement.retainedRoots,
          target,
        }),
      admitIntake: (target: string) =>
        assertCheckoutAvailable({
          mount,
          uuid,
          observe,
          scope: "intake",
          target,
        }),
    },
  );
}

test("checkout admission guards active and retained roots, rejects redirected paths and missing or mismatched volumes without internal fallback", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-local-ws-guard-")));
  try {
    const mount = join(root, "Stash");
    const elsewhere = join(root, "internal-fallback");
    mkdirSync(elsewhere, { recursive: true });

    const activeRoot = join(mount, "worktrees", "nucleus");
    const retainedRoot = join(mount, "queue", "workspaces");
    const valid = volumeInfo(mount, "pinned-uuid");

    // 1. Missing volume must refuse and never create the mount point or directories.
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: activeRoot,
          retainedWorkspaceRoots: [retainedRoot],
          target: join(activeRoot, "repo-digest", "ns-task"),
          observe: () => valid,
        }),
      CheckoutUnavailableError,
    );
    assert.equal(existsSync(mount), false);

    // 2. Mismatched volume UUID must refuse.
    mkdirSync(mount);
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: activeRoot,
          retainedWorkspaceRoots: [retainedRoot],
          target: join(activeRoot, "repo-digest", "ns-task"),
          observe: () => volumeInfo(mount, "wrong-uuid"),
        }),
      CheckoutRefusalError,
    );

    // 3. Valid mount admits active root, retained root, and QA root, but rejects paths outside them.
    assertCheckoutAvailable({
      mount,
      uuid: "pinned-uuid",
      workspaceRoot: activeRoot,
      retainedWorkspaceRoots: [retainedRoot],
      target: join(activeRoot, "repo-digest", "ns-task"),
      observe: () => valid,
    });
    assertCheckoutAvailable({
      mount,
      uuid: "pinned-uuid",
      workspaceRoot: activeRoot,
      retainedWorkspaceRoots: [retainedRoot],
      target: join(retainedRoot, "repo-digest", "ns-old"),
      observe: () => valid,
    });
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: activeRoot,
          retainedWorkspaceRoots: [retainedRoot],
          target: join(mount, "other", "ns-task"),
          observe: () => valid,
        }),
      CheckoutRefusalError,
    );
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: elsewhere,
          target: join(elsewhere, "ns-task"),
          observe: () => valid,
        }),
      CheckoutRefusalError,
    );

    // 4. Redirected (symlinked) active root ancestor or leaf refuses.
    symlinkSync(elsewhere, join(mount, "worktrees"));
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: activeRoot,
          retainedWorkspaceRoots: [retainedRoot],
          target: join(activeRoot, "repo-digest", "ns-task"),
          observe: () => valid,
        }),
      /redirected/,
    );
    rmSync(join(mount, "worktrees"));

    mkdirSync(join(mount, "worktrees"), { recursive: true });
    symlinkSync(elsewhere, activeRoot);
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: activeRoot,
          retainedWorkspaceRoots: [retainedRoot],
          target: join(activeRoot, "repo-digest", "ns-task"),
          observe: () => valid,
        }),
      /redirected/,
    );
    rmSync(activeRoot);

    // 5. Redirected retained root refuses even when active root is clean.
    mkdirSync(activeRoot, { recursive: true });
    mkdirSync(join(mount, "queue"), { recursive: true });
    symlinkSync(elsewhere, retainedRoot);
    assert.throws(
      () =>
        assertCheckoutAvailable({
          mount,
          uuid: "pinned-uuid",
          workspaceRoot: activeRoot,
          retainedWorkspaceRoots: [retainedRoot],
          target: join(activeRoot, "repo-digest", "ns-task"),
          observe: () => valid,
        }),
      /redirected/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed-root cutover and restart: old task resumes, prepared path binds, new task allocates under worktrees/nucleus with links, and each cleans up at its recorded path", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-mixed-cutover-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const mount = join(root, "Stash");
  const data = join(root, "data");
  const repo = join(root, "repo");
  const dep = join(root, "dep-lib");
  const origin = join(root, "origin.git");
  [mount, data, repo, dep].forEach((dir) =>
    mkdirSync(dir, { recursive: true }),
  );

  const runRepo = gitRepo(repo);
  gitRepo(dep);
  writeFileSync(
    join(repo, "paseo.json"),
    JSON.stringify({
      worktree: { setup: "nucleus worktree prepare ../dep-lib" },
    }),
  );
  runRepo("add", "paseo.json");
  runRepo("commit", "-q", "-m", "add paseo manifest");
  const head = runRepo("rev-parse", "HEAD");
  runRepo("init", "--bare", "-q", origin);
  runRepo("remote", "add", "origin", origin);
  runRepo("push", "-q", "origin", "main");

  const common = await repoCommonDir(repo);
  const storePath = join(data, "queue.sqlite");
  let store = new Store(storePath);
  let volumePresent = true;
  let volumeUuid = "stash-uuid";
  const observe = (targetMount: string): CheckoutVolumeInfo => {
    if (!volumePresent) throw new Error("volume absent");
    return volumeInfo(targetMount, volumeUuid);
  };

  // Phase 1: Pre-cutover settings, when <mount>/queue/workspaces was the active
  // root. A current install writes that path explicitly; the default is now
  // <mount>/worktrees/nucleus (nucleus#1526).
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      workRoot: mount,
      workVolumeId: "stash-uuid",
      localWorkspaceRoot: join(mount, "queue", "workspaces"),
    }),
  );
  initializeWorkRoot(data, {});
  const prePlacement = getLocalWorkspacePlacement(data, {});
  assert.equal(prePlacement.activeRoot, join(mount, "queue", "workspaces"));
  assert.deepEqual(prePlacement.retainedRoots, []);

  // Create Old Task A (allocated & bound on <mount>/queue/workspaces) and
  // Prepared Task B (populated on <mount>/queue/workspaces before roll/cutover, not yet bound).
  const oldTask = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Old task on legacy root",
      repoPath: repo,
      planningCommit: head,
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    head,
  );
  const preparedTask = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Prepared task before roll",
      repoPath: repo,
      planningCommit: head,
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    head,
  );

  const workspacesMap = new Map<
    string,
    { id: string; directory: string; catalogued: boolean }
  >();
  const wireFakeApi = (adapter: PaseoAdapter) => {
    (adapter as any).api = {
      workspaces: {
        list: async () => ({
          entries: [...workspacesMap.values()]
            .filter((entry) => entry.catalogued)
            .map((entry) => ({
              id: entry.id,
              projectRootPath: entry.directory,
              workspaceDirectory: entry.directory,
            })),
          pageInfo: { hasMore: false },
        }),
        create: async (input: {
          source: { path: string };
          requestId?: string;
        }) => {
          const id = `ws-${basename(input.source.path)}`;
          workspacesMap.set(id, {
            id,
            directory: input.source.path,
            catalogued: true,
          });
          return { id, directory: input.source.path };
        },
        ref: (id: string) => ({
          get directory() {
            return workspacesMap.get(id)?.directory ?? null;
          },
          refresh: async () => {},
          current: () =>
            workspacesMap.get(id)?.catalogued
              ? {
                  projectRootPath: repo,
                  workspaceDirectory: workspacesMap.get(id)!.directory,
                }
              : undefined,
          archive: async () => {
            const entry = workspacesMap.get(id);
            if (entry) entry.catalogued = false;
            return { archivedAt: new Date().toISOString() };
          },
        }),
      },
      projects: { list: async () => ({ projects: [] }) },
      agents: {
        list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      },
    };
  };

  let adapter = createPlacementAdapter(data, mount, "stash-uuid", observe, () =>
    getLocalWorkspacePlacement(data, {}),
  );
  wireFakeApi(adapter);

  const popA = await adapter.populateTaskWorktree(oldTask);
  const wsA = await adapter.createWorkspace(oldTask, {
    freshlyPopulated: popA.populated,
  });
  assert.equal(
    wsA.directory,
    ownedWorkspacePath(join(mount, "queue"), common, oldTask.id),
  );
  runRepo("push", "-q", "origin", oldTask.branch);
  const boundOldTask = store.update(oldTask.id, {
    workspaceId: wsA.id,
    directory: wsA.directory,
    phase: "working",
  });

  // Populate Task B on the old root before the cutover/roll (workspaceIntent: true, no workspaceId/directory yet).
  store.update(preparedTask.id, {
    workspaceIntent: true,
    phase: "dispatching",
  });
  const popB = await adapter.populateTaskWorktree(store.task(preparedTask.id));
  assert.equal(
    popB.directory,
    ownedWorkspacePath(join(mount, "queue"), common, preparedTask.id),
  );

  // Phase 2: Cutover + service restart.
  // Direct new local task workspaces to <mount>/worktrees/nucleus while keeping <mount> as workRoot.
  store.close();
  const newWorkspaceRoot = join(mount, "worktrees", "nucleus");
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      workRoot: mount,
      workVolumeId: "stash-uuid",
      localWorkspaceRoot: newWorkspaceRoot,
    }),
  );
  initializeWorkRoot(data, {});
  const postPlacement = getLocalWorkspacePlacement(data, {});
  assert.equal(postPlacement.workRoot, mount);
  assert.equal(postPlacement.activeRoot, newWorkspaceRoot);
  assert.deepEqual(postPlacement.retainedRoots, [
    join(mount, "queue", "workspaces"),
  ]);

  store = new Store(storePath);
  adapter = createPlacementAdapter(data, mount, "stash-uuid", observe, () =>
    getLocalWorkspacePlacement(data, {}),
  );
  wireFakeApi(adapter);

  // 2a. Old Task A resumes on its recorded old-root path without moves or record rewrites.
  assert.equal(store.task(boundOldTask.id).directory, wsA.directory);
  await adapter.preflightWorkspaceStorage(store.task(boundOldTask.id));
  assert.deepEqual(
    await adapter.preflightWorkerContinuation(store.task(boundOldTask.id)),
    {
      available: true,
    },
  );
  assert.equal(
    await canonicalLinkRoot(data, repo, wsA.directory, adapter.testPlacement),
    dirname(wsA.directory),
  );

  // 2b. Prepared Task B (populated pre-roll on old root) binds its prepared old-root path after the roll.
  const wsB = await adapter.createWorkspace(store.task(preparedTask.id));
  assert.equal(wsB.directory, popB.directory);
  runRepo("push", "-q", "origin", preparedTask.branch);
  store.update(preparedTask.id, {
    workspaceId: wsB.id,
    directory: wsB.directory,
    phase: "working",
  });

  // 2c. New Task C allocates on <mount>/worktrees/nucleus/<digest>/ns-<taskId> and provisions sibling links.
  const newTask = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "New task on worktrees/nucleus",
      repoPath: repo,
      planningCommit: head,
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    head,
  );
  await adapter.preflightWorkspaceStorage(newTask);
  const popC = await adapter.populateTaskWorktree(newTask);
  const wsC = await adapter.createWorkspace(newTask, {
    freshlyPopulated: popC.populated,
  });
  const expectedNewDir = workspacePathInRoot(
    newWorkspaceRoot,
    common,
    newTask.id,
  );
  assert.equal(wsC.directory, expectedNewDir);
  assert.equal(existsSync(expectedNewDir), true);
  runRepo("push", "-q", "origin", newTask.branch);
  const boundNewTask = store.update(newTask.id, {
    workspaceId: wsC.id,
    directory: wsC.directory,
    phase: "working",
  });

  // Sibling/dependency link provisioning resolves the canonical root on <mount>/worktrees/nucleus.
  const linkResult = await provisionWorktreeLinks({
    dataDir: data,
    task: boundNewTask,
    configured: [{ origin: null, path: dep }],
    testPlacement: adapter.testPlacement,
  });
  assert.equal(linkResult.findings.length, 0);
  assert.equal(linkResult.links[0]?.outcome, "created");
  assert.equal(
    realpathSync(readlinkSync(join(dirname(wsC.directory), "dep-lib"))),
    realpathSync(dep),
  );

  // BB host path also uses <mount>/worktrees/nucleus/<digest>/task-<id>/ns-<id>.
  const bbTask = { id: "bb-task", repoPath: repo, hostId: "bb:host-1" } as Task;
  assert.equal(
    await adapter.ownedPathFor(bbTask),
    bbWorkspacePathInRoot(newWorkspaceRoot, common, bbTask.id),
  );

  // 2d. Positive-binding guard: a task bound to the new root (or an unbound task) cannot clean up on the old root.
  const unboundOldAttempt = ownedWorkspacePath(
    join(mount, "queue"),
    common,
    newTask.id,
  );
  assert.equal(
    await adapter.ownedDataDirFor(boundNewTask, unboundOldAttempt),
    null,
  );
  assert.equal(await adapter.ownedDataDirFor(newTask, unboundOldAttempt), null);

  // 2e. Mismatched or absent volume blocks both old-root and new-root preflights without falling back.
  volumeUuid = "wrong-uuid";
  await assert.rejects(
    adapter.preflightWorkspaceStorage(store.task(boundOldTask.id)),
    CheckoutRefusalError,
  );
  await assert.rejects(
    adapter.preflightWorkspaceStorage(boundNewTask),
    CheckoutRefusalError,
  );
  volumePresent = false;
  await assert.rejects(
    adapter.preflightWorkspaceStorage(boundNewTask),
    CheckoutUnavailableError,
  );
  volumePresent = true;
  volumeUuid = "stash-uuid";

  // 2f. Recovery of lost directory reuses recorded old-root path for old task and active new-root path for unallocated task.
  rmSync(wsA.directory, { recursive: true, force: true });
  runRepo("worktree", "prune");
  runRepo("branch", "-D", oldTask.branch);
  const recoveredOld = await adapter.recoverTaskWorkspace(
    store.task(boundOldTask.id),
    { target: "branch" },
  );
  assert.equal(recoveredOld.directory, wsA.directory);
  assert.equal(existsSync(wsA.directory), true);

  // 2g. Cleanup of each task succeeds at its own recorded path (including orphan discard via assertCanonicalOwnedPath).
  const doneOld = store.update(boundOldTask.id, {
    phase: "done",
    prHead: head,
    resolution: {
      ...boundOldTask.resolution,
      mergedCommit: head,
      syncedCommit: head,
    },
  });
  await adapter.archiveTaskWorkspace(
    doneOld,
    wsA.id,
    wsA.directory,
    head,
    () => true,
    false,
    { requirePublished: true },
  );
  assert.equal(existsSync(wsA.directory), false);

  const doneNew = store.update(boundNewTask.id, {
    phase: "done",
    prHead: head,
    resolution: {
      ...boundNewTask.resolution,
      mergedCommit: head,
      syncedCommit: head,
    },
  });
  await adapter.archiveTaskWorkspace(
    doneNew,
    wsC.id,
    wsC.directory,
    head,
    () => true,
    false,
    { requirePublished: true },
  );
  assert.equal(existsSync(wsC.directory), false);

  // Orphan classification & canonical path check works directly on <mount>/worktrees/nucleus too.
  const orphanTask = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Orphan on worktrees/nucleus",
      repoPath: repo,
      planningCommit: head,
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    head,
  );
  const popOrphan = await adapter.populateTaskWorktree(orphanTask);
  rmSync(join(common, "worktrees", `ns-${orphanTask.id}`), {
    recursive: true,
    force: true,
  });
  const orphanCheck = await classifyOrphanWorktree({
    directory: popOrphan.directory,
    repoPath: repo,
    dataDir: newWorkspaceRoot,
    taskId: orphanTask.id,
  });
  assert.equal(orphanCheck.orphaned, true);
  assert.equal(lstatSync(popOrphan.directory).isDirectory(), true);
  rmSync(popOrphan.directory, { recursive: true, force: true });

  // Phase 3: Rollback retains positively bound new-root tasks while returning new allocations to queue/workspaces.
  const taskBeforeRollback = store.insert(
    submissionSchema.parse({
      submissionId: randomUUID(),
      title: "Live task before rollback",
      repoPath: repo,
      planningCommit: head,
      originAgentId: "origin",
    }),
    "host",
    "handoff",
    head,
  );
  const popRoll = await adapter.populateTaskWorktree(taskBeforeRollback);
  const wsRoll = await adapter.createWorkspace(taskBeforeRollback, {
    freshlyPopulated: popRoll.populated,
  });
  runRepo("push", "-q", "origin", taskBeforeRollback.branch);
  const boundRollTask = store.update(taskBeforeRollback.id, {
    workspaceId: wsRoll.id,
    directory: wsRoll.directory,
    phase: "working",
  });

  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      workRoot: mount,
      workVolumeId: "stash-uuid",
      // Rollback names the retired root explicitly: removing the setting returns
      // to the current portable default, <mount>/worktrees/nucleus.
      localWorkspaceRoot: join(mount, "queue", "workspaces"),
      retainedWorkspaceRoots: [newWorkspaceRoot],
    }),
  );
  adapter = createPlacementAdapter(data, mount, "stash-uuid", observe, () =>
    getLocalWorkspacePlacement(data, {}),
  );
  wireFakeApi(adapter);

  const postRollbackTask = { id: "post-rollback", repoPath: repo } as Task;
  assert.equal(
    await adapter.ownedPathFor(postRollbackTask),
    ownedWorkspacePath(join(mount, "queue"), common, postRollbackTask.id),
  );
  await adapter.preflightWorkspaceStorage(boundRollTask);
  assert.deepEqual(await adapter.preflightWorkerContinuation(boundRollTask), {
    available: true,
  });
  const doneRoll = store.update(boundRollTask.id, {
    phase: "done",
    prHead: head,
    resolution: {
      ...boundRollTask.resolution,
      mergedCommit: head,
      syncedCommit: head,
    },
  });
  await adapter.archiveTaskWorkspace(
    doneRoll,
    wsRoll.id,
    wsRoll.directory,
    head,
    () => true,
    false,
    { requirePublished: true },
  );
  assert.equal(existsSync(wsRoll.directory), false);

  store.close();
});

test("live placement via defaultDataDir preserves backup, run-scratch, QA, Barge, and attached review placement", async (t) => {
  const liveData = defaultDataDir();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-live-preserve-")));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(liveData, "settings.json"), { force: true });
  });

  const mount = join(root, "Stash");
  const worktreesNucleus = join(mount, "worktrees", "nucleus");
  mkdirSync(liveData, { recursive: true });
  mkdirSync(mount, { recursive: true });
  writeFileSync(
    join(liveData, "settings.json"),
    JSON.stringify({ workRoot: mount, localWorkspaceRoot: worktreesNucleus }),
  );

  // Live checkout placement reads the opted-in active root and auto-retains <mount>/queue/workspaces.
  const live = liveCheckoutPlacement(liveData);
  assert.ok(live);
  assert.equal(live.workRoot, mount);
  assert.equal(live.activeRoot, worktreesNucleus);
  assert.deepEqual(live.retainedRoots, [join(mount, "queue", "workspaces")]);

  // Run-scratch, backup, and QA placement keep using workRoot directly.
  assert.equal(getWorkRoot(liveData), mount);
  assert.equal(
    runScratchRoot(getWorkRoot(liveData), "repo"),
    join(mount, "scratch", "repo"),
  );
  assert.ok(!liveBackupDir().includes("worktrees/nucleus"));

  // Barge provider selection stays untouched when repo opts in.
  assert.equal(
    chooseWorkspaceProvider({
      task: {
        proofOnly: undefined,
        reviewEntry: null,
        workspaceOwnership: "queue",
        workspaceIntent: false,
        workspaceAllocation: null,
        workspaceId: null,
        directory: null,
        repoPath: "/repo",
        repository: "owner/repo",
      },
      workspaceProviderFor: () => "barge",
    }),
    "barge",
  );

  // Attached review-entry admission still uses intake scope without forcing local workspace root.
  const reviewDir = join(mount, "paseo", "worktrees", "review-1", "slug");
  mkdirSync(reviewDir, { recursive: true });
  const entry = reviewEntryRecordSchema.parse({
    operationId: "a".repeat(64),
    prNumber: 7,
    repository: "owner/repo",
    branch: "feat/review",
    workspaceId: "wks_1",
    verifiedHead: "b".repeat(40),
    verifiedBase: "c".repeat(40),
    dispatchBase: null,
    planningCommit: "c".repeat(40),
    authority: "Operator approved",
    authorDeclaration: {
      models: ["openai/gpt-5"],
      githubAuthor: "author",
      authoringSystem: "agent",
      attestedBy: "operator",
      provenance: "fixture",
    },
    checkedAt: new Date().toISOString(),
    preserveWorkspace: false,
    directory: reviewDir,
  });
  const adapter = new PaseoAdapter(
    "ws://127.0.0.1:1",
    join(liveData, "cb.sock"),
    join(liveData, "report.mjs"),
    undefined,
    undefined,
    {
      dataDir: join(mount, "queue"),
      workspaceRoot: worktreesNucleus,
      retainedWorkspaceRoots: [join(mount, "queue", "workspaces")],
      admit: (target) =>
        assertCheckoutAvailable({
          mount,
          workspaceRoot: worktreesNucleus,
          retainedWorkspaceRoots: [join(mount, "queue", "workspaces")],
          target,
        }),
      admitIntake: (target) =>
        assertCheckoutAvailable({ mount, scope: "intake", target }),
    },
  );
  const intakeTask = {
    id: "review-task",
    repoPath: "/repo",
    workspaceId: entry.workspaceId,
    directory: reviewDir,
    reviewEntry: entry,
  } as Task;
  await adapter.preflightWorkspaceStorage(intakeTask);
  assert.equal(await adapter.ownedPathFor(intakeTask), reviewDir);
});
