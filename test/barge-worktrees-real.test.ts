import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Engine } from "../core/engine";
import { Store } from "../core/store/store";
import type { Adapter } from "../core/host";
import { verifyTaskWorktreeIdentity } from "../core/git/index";
import { moveTaskToWorkerHost } from "../core/dispatch/worker-host-move";
import {
  bargeWorktreeReturn,
  bargeWorktreeStatus,
  BargeCliError,
  type BargeClientOptions,
} from "../core/workspaces/barge-cli";
import { BargeCustodyLostError } from "../core/workspaces/barge-custodian";
import {
  createBargeAllocationIntent,
  nextAllocationSequence,
  provisionBargeAllocation,
  resolveBargeRepoIdentifier,
  returnBargeAllocation,
  verifyBargeLeaseAndCustody,
} from "../core/workspaces/barge-allocator";
import { createStoreWorkspaceAllocationBridge } from "../core/workspaces/workspace-allocation-bridge";
import { CheckoutUnavailableError } from "../core/workspaces/checkout-volume";
import {
  WorkspaceLifecycle,
  type WorkspaceLifecycleHost,
} from "../core/workspaces/workspace-lifecycle";
import { OwnedWorkspaceArchive } from "../core/workspaces/owned-workspace-archive";
import { submissionSchema } from "../shared/contracts";

const execFileAsync = promisify(execFile);

function findRealBargeBin(): string | null {
  const envCandidates = [
    process.env.NUCLEUS_BARGE_BIN,
    process.env.BARGE_BIN,
  ];
  const pathDirs = (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => join(dir, "barge"));
  for (const candidate of [...envCandidates, ...pathDirs]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

const REAL_BARGE_BIN = findRealBargeBin();

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nucleus Real Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Nucleus Real Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout.trim();
}

async function runBargeSetup(
  bin: string,
  stateDir: string,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    env: { ...process.env, BARGE_STATE_DIR: stateDir },
  });
  return stdout.trim();
}

async function setupIsolatedBargeEnv(
  bin: string,
  root: string,
  poolMax = 2,
): Promise<{
  stateDir: string;
  controlRootDir: string;
  originBare: string;
  repoPath: string;
  baseSha: string;
  cliOptions: BargeClientOptions;
  pidsToCleanup: number[];
}> {
  const stateDir = join(root, "barge-state");
  const mountDir = join(root, "barge-vol");
  const controlRootDir = join(root, "custodians");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(mountDir, { recursive: true });
  mkdirSync(controlRootDir, { recursive: true });

  const originBare = join(root, "origin.git");
  const seed = join(root, "seed");
  const repoPath = join(root, "repo");
  mkdirSync(originBare, { recursive: true });
  mkdirSync(seed, { recursive: true });

  await runGit(originBare, "init", "--bare", "-b", "main");
  await runGit(seed, "init", "-b", "main");
  writeFileSync(
    join(seed, ".gitignore"),
    "node_modules/\ntarget/\n*.local\n",
  );
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "barge-real" }));
  writeFileSync(join(seed, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  writeFileSync(join(seed, "README.md"), "base\n");
  await runGit(seed, "add", "-A");
  await runGit(seed, "commit", "-m", "base");
  await runGit(seed, "remote", "add", "origin", originBare);
  await runGit(seed, "push", "origin", "main");
  const baseSha = await runGit(seed, "rev-parse", "HEAD");
  rmSync(seed, { recursive: true, force: true });

  await execFileAsync("git", ["clone", originBare, repoPath]);

  const { stdout: dfOut } = await execFileAsync("df", ["-P", mountDir]);
  const mountLine = dfOut.trim().split(/\r?\n/).pop() ?? "";
  const volumeMount = mountLine.replace(/^.*\s(\/[^\n]*)$/, "$1").trim() || "/";
  const rootDir = relative(realpathSync(volumeMount), realpathSync(mountDir));

  await runBargeSetup(
    bin,
    stateDir,
    "volume",
    "register",
    "--name",
    "testvol",
    "--mount",
    realpathSync(volumeMount),
    "--root-dir",
    rootDir || "Areas",
    "--availability",
    "permanent",
    "--durability",
    "expendable",
  );
  // Write account layout.json inside isolated BARGE_STATE_DIR without touching live volume `.barge/layout.json`.
  writeFileSync(
    join(stateDir, "layout.json"),
    JSON.stringify({
      schema: "barge.layout/1",
      classes: {
        worktrees: { volume: "testvol", path: "worktrees" },
      },
    }),
  );

  // Use bare local path as canonical origin/repo url so Barge's canonical_repo matches `originBare`
  const realOrigin = realpathSync(originBare);
  const canonicalPoolRepo = realOrigin
    .replace(/^file:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  await runGit(repoPath, "remote", "set-url", "origin", realOrigin);
  writeFileSync(
    join(stateDir, "worktree-pools.json"),
    JSON.stringify({
      schema: "barge.worktree-pools/1",
      pools: [
        {
          repo: canonicalPoolRepo,
          origin: realOrigin,
          warm: 1,
          max: poolMax,
          warm_paths: [
            { path: "node_modules", keys: ["package-lock.json"] },
          ],
          disposable: ["target"],
        },
      ],
    }),
  );

  return {
    stateDir,
    controlRootDir,
    originBare: realOrigin,
    repoPath: realpathSync(repoPath),
    baseSha,
    cliOptions: {
      bin,
      env: { BARGE_STATE_DIR: stateDir },
      timeoutMs: 30_000,
    },
    pidsToCleanup: [],
  };
}

function submitTask(store: Store, repoPath: string, baseSha: string, title = "Real Barge Task") {
  store.upsertProject({
    key: "barge-real",
    name: "Barge Real",
    repositories: [{ origin: null, path: repoPath }],
  });
  return store.insert(
    submissionSchema.parse({
      submissionId: `real-${Math.random().toString(16).slice(2)}`,
      title,
      repoPath,
      baseBranch: "main",
      planningCommit: baseSha,
      brief: { text: "Brief" },
      originAgentId: "agent-1",
    }),
    "t3code-synthetic",
    "brief",
    baseSha,
  );
}

test(
  "real Barge CLI: lease, worktree run detached custodian, competing return refusal, service-roll survival, warm node_modules, and path reuse guard",
  { skip: REAL_BARGE_BIN ? false : "real pinned barge CLI binary unavailable" },
  async () => {
    const dir = makeTempDir("nuc-barge-real-1-");
    const env = await setupIsolatedBargeEnv(REAL_BARGE_BIN!, dir, 1);
    try {
      const store = new Store(":memory:");
      store.putRepository(
        { origin: null, path: env.repoPath },
        null,
        "",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "barge",
      );
      const bridge = createStoreWorkspaceAllocationBridge(store, {
        bargeCliOptions: env.cliOptions,
        custodianControlRootDir: env.controlRootDir,
      });

      const task1 = submitTask(store, env.repoPath, env.baseSha, "Task 1");
      const intent1 = createBargeAllocationIntent({
        task: task1,
        sequence: 1,
        baseSha: env.baseSha,
        repoIdentifier: await resolveBargeRepoIdentifier(env.repoPath),
      });
      bridge.saveWorkspaceAllocation(task1.id, intent1);

      const alloc1 = await provisionBargeAllocation({
        allocation: intent1,
        task: task1,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task1.id, u),
        cliOptions: env.cliOptions,
        controlRootDir: env.controlRootDir,
      });
      if (alloc1.custodian?.pid) env.pidsToCleanup.push(alloc1.custodian.pid);

      assert.equal(alloc1.state, "leased");
      assert.equal(alloc1.custodian?.state, "holding");
      assert.ok(alloc1.custodian?.pid);
      assert.ok(alloc1.checkoutPath && existsSync(alloc1.checkoutPath));

      // Verify `barge worktree status` shows the lease root actively held!
      const statuses = await bargeWorktreeStatus(
        { repo: env.originBare },
        env.cliOptions,
      );
      const root1 = statuses[0]?.roots.find((r) => r.lease_id === alloc1.leaseId);
      assert.ok(root1);
      assert.equal(root1.held, true);

      // Competing `barge worktree return` MUST be refused while detached custodian holds it!
      await assert.rejects(
        bargeWorktreeReturn(
          { leaseId: alloc1.leaseId!, disposable: true },
          env.cliOptions,
        ),
        (err: unknown) => {
          assert.ok(err instanceof BargeCliError);
          assert.equal(err.kind, "refused");
          assert.match(err.message, /held/i);
          return true;
        },
      );

      // Simulate service roll (reconstruct Engine from store) + reconcile custodian still holding
      const dummyAdapter = {
        hostId: "t3code-synthetic",
        workspaceAllocationBridge: bridge,
        observe: async () => null,
        listLiveAgents: async () => [],
        originAgent: async () => null,
      } as unknown as Adapter;
      const rolledEngine = new Engine(store, dummyAdapter, 0);
      await rolledEngine.reconcileBargeCustodians();
      assert.equal(store.task(task1.id).workspaceAllocation?.state, "leased");
      assert.equal(store.task(task1.id).workspaceAllocation?.custodian?.state, "holding");

      // Pool max=1: Task 2 hits full pool wait (CheckoutUnavailableError)
      const task2 = submitTask(store, env.repoPath, env.baseSha, "Task 2");
      const intent2 = createBargeAllocationIntent({
        task: task2,
        sequence: 1,
        baseSha: env.baseSha,
        repoIdentifier: env.originBare,
      });
      bridge.saveWorkspaceAllocation(task2.id, intent2);
      await assert.rejects(
        provisionBargeAllocation({
          allocation: intent2,
          task: task2,
          saveAllocation: (u) => bridge.saveWorkspaceAllocation(task2.id, u),
          cliOptions: env.cliOptions,
          controlRootDir: env.controlRootDir,
        }),
        CheckoutUnavailableError,
      );

      // Populate warm node_modules + disposable target/ + commit on task 1's checkout
      mkdirSync(join(alloc1.checkoutPath!, "node_modules", "warm-pkg"), { recursive: true });
      writeFileSync(join(alloc1.checkoutPath!, "node_modules", "warm-pkg", "index.js"), "warm=1;\n");
      mkdirSync(join(alloc1.checkoutPath!, "target", "debug"), { recursive: true });
      writeFileSync(join(alloc1.checkoutPath!, "target", "debug", "app"), "bin\n");
      writeFileSync(join(alloc1.checkoutPath!, "feature.txt"), "feature\n");
      await runGit(alloc1.checkoutPath!, "add", "feature.txt");
      await runGit(alloc1.checkoutPath!, "commit", "-m", "task1 feature");

      // Terminate Task 1 cleanly through OwnedWorkspaceArchive with positive publication proof (mergedCommit)
      store.update(task1.id, {
        phase: "done",
        workspaceId: "ws-t1",
        directory: alloc1.checkoutPath,
        resolution: {
          ...store.task(task1.id).resolution,
          mergedCommit: env.baseSha,
        },
      });
      // Push feature commit & merged base branch check skipped by setting mergedCommit after push or origin branch containing
      await runGit(alloc1.checkoutPath!, "push", "origin", `${task1.branch}:${task1.branch}`);
      // Update main on origin? Use origin branch publication cleanly:
      const t1 = store.update(task1.id, {
        resolution: { ...store.task(task1.id).resolution, mergedCommit: null },
      });

      let archivedNative = false;
      const archive = new OwnedWorkspaceArchive({
        helperPath: join(dir, "helper.mjs"),
        workspaceAllocationBridge: bridge,
        dataDir: () => join(dir, "nuc-data"),
        placement: () => null,
        ownedDataDirFor: async () => null,
        ownedPathFor: async () => alloc1.checkoutPath!,
        classifyOrphan: (async () => ({ orphaned: false })) as never,
        observe: async () => null,
        workspaceHost: {
          workspaceInventory: async () => [],
          repositoryProject: async () => ({}),
          createWorkspace: async () => ({ id: "ws-t1", directory: alloc1.checkoutPath! }),
          archiveThreadPage: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
          workspaceRef: (id: string) => ({
            id,
            directory: alloc1.checkoutPath!,
            refresh: async () => undefined,
            current: () =>
              archivedNative
                ? null
                : { id, projectId: "prj_1", projectRootPath: env.repoPath, directory: alloc1.checkoutPath! },
            archive: async () => {
              archivedNative = true;
              return { archivedAt: new Date().toISOString() };
            },
          }),
          activeThreads: async () => [],
        },
        hostProcessListing: async () => [],
      } as never);

      await archive.archiveTaskWorkspace(t1, "ws-t1", alloc1.checkoutPath!, await runGit(alloc1.checkoutPath!, "rev-parse", "HEAD"), () => true, false, { requirePublished: true });
      assert.equal(archivedNative, true);
      assert.equal(store.task(task1.id).workspaceAllocation?.state, "returned");
      assert.equal(store.task(task1.id).workspaceAllocation?.custodian?.state, "released");
      assert.equal(store.task(task1.id).workspaceAllocation?.returnRecord?.disposable, true);
      // Warm node_modules preserved by keepDependencies + Barge warm_paths!
      assert.equal(existsSync(join(alloc1.checkoutPath!, "node_modules", "warm-pkg", "index.js")), true);

      // Now Task 2 leases the freed warm root (same filesystem path!)
      const alloc2 = await provisionBargeAllocation({
        allocation: intent2,
        task: task2,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task2.id, u),
        cliOptions: env.cliOptions,
        controlRootDir: env.controlRootDir,
      });
      if (alloc2.custodian?.pid) env.pidsToCleanup.push(alloc2.custodian.pid);
      assert.equal(alloc2.checkoutPath, alloc1.checkoutPath);
      assert.notEqual(alloc2.leaseId, alloc1.leaseId);
      assert.equal(existsSync(join(alloc2.checkoutPath!, "node_modules", "warm-pkg", "index.js")), true);

      // Late return or late identity check on Task 1 MUST NOT touch Task 2's live lease!
      await assert.rejects(
        verifyTaskWorktreeIdentity(store.task(task1.id)),
        /different Git roots/i,
      );
      await returnBargeAllocation({
        allocation: store.task(task1.id).workspaceAllocation!,
        task: store.task(task1.id),
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task1.id, u),
        cliOptions: env.cliOptions,
      });
      // Task 2's lease and custodian stay completely unharmed!
      await verifyBargeLeaseAndCustody({
        allocation: store.task(task2.id).workspaceAllocation!,
        cliOptions: env.cliOptions,
      });

      // Cleanly return Task 2 at end
      await returnBargeAllocation({
        allocation: store.task(task2.id).workspaceAllocation!,
        task: store.task(task2.id),
        dispositionEvidence: "test_cleanup",
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task2.id, u),
        cliOptions: env.cliOptions,
      });
    } finally {
      for (const pid of env.pidsToCleanup) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "real Barge CLI: custodian SIGKILL mid-use fences return, and host-move replacement returns lease 1 before leasing lease 2 on same branch",
  { skip: REAL_BARGE_BIN ? false : "real pinned barge CLI binary unavailable" },
  async () => {
    const dir = makeTempDir("nuc-barge-real-2-");
    const env = await setupIsolatedBargeEnv(REAL_BARGE_BIN!, dir, 2);
    try {
      const store = new Store(":memory:");
      store.putRepository(
        { origin: null, path: env.repoPath },
        null,
        "",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "barge",
      );
      const bridge = createStoreWorkspaceAllocationBridge(store, {
        bargeCliOptions: env.cliOptions,
        custodianControlRootDir: env.controlRootDir,
      });

      // --- Part A: Custodian killed mid-use ---
      const taskA = submitTask(store, env.repoPath, env.baseSha, "Task A");
      const intentA = createBargeAllocationIntent({
        task: taskA,
        sequence: 1,
        baseSha: env.baseSha,
        repoIdentifier: env.originBare,
      });
      bridge.saveWorkspaceAllocation(taskA.id, intentA);
      const allocA = await provisionBargeAllocation({
        allocation: intentA,
        task: taskA,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(taskA.id, u),
        cliOptions: env.cliOptions,
        controlRootDir: env.controlRootDir,
      });
      env.pidsToCleanup.push(allocA.custodian!.pid!);
      store.update(taskA.id, { phase: "working", workspaceId: "ws-a", directory: allocA.checkoutPath });

      // Kill the real detached custodian unexpectedly
      process.kill(allocA.custodian!.pid!, "SIGKILL");
      // Wait briefly until kernel reaps process
      await new Promise((r) => setTimeout(r, 150));

      const dummyAdapter = {
        hostId: "t3code-synthetic",
        workspaceAllocationBridge: bridge,
        observe: async () => null,
        listLiveAgents: async () => [],
        originAgent: async () => null,
      } as unknown as Adapter;
      const engine = new Engine(store, dummyAdapter, 0);
      await engine.reconcileBargeCustodians();

      const afterKill = store.task(taskA.id);
      assert.equal(afterKill.workspaceAllocation?.state, "lost", `expected lost; got state=${afterKill.workspaceAllocation?.state}, err=${afterKill.workspaceAllocation?.error}, events=${JSON.stringify(store.events(taskA.id).slice(-3))}`);
      assert.equal(afterKill.phase, "needs_attention");

      await assert.rejects(
        returnBargeAllocation({
          allocation: afterKill.workspaceAllocation!,
          task: afterKill,
          dispositionEvidence: "terminal_discard",
          saveAllocation: (u) => bridge.saveWorkspaceAllocation(taskA.id, u),
          cliOptions: env.cliOptions,
        }),
        BargeCustodyLostError,
      );

      // --- Part B: Replacement / Host Move re-allocates exact same branch after lease 1 returns ---
      const taskB = submitTask(store, env.repoPath, env.baseSha, "Task B");
      let lifecycle!: WorkspaceLifecycle;
      const lifecycleHost = {
        helperPath: join(dir, "helper.mjs"),
        workspaceAllocationBridge: bridge,
        dataDir: () => join(dir, "nuc-data"),
        placement: () => null,
        ownedPathFor: async (t: { id: string }) => store.task(t.id).workspaceAllocation!.checkoutPath!,
        ownedDataDirFor: async () => null,
        findWorkspaces: async () => [],
        inspectWorkspaceCreation: async (t: unknown, opts: unknown) =>
          lifecycle.inspectWorkspaceCreation(t as never, opts as never),
        inspectOrphanWorkspace: async () => null,
        workspaceHost: {
          workspaceInventory: async () => [],
          repositoryProject: async () => ({ workspaceRoot: env.repoPath }),
          createWorkspace: async (spec: { requestId: string; directory: string }) => ({
            id: `ws-${spec.requestId}`,
            directory: spec.directory,
          }),
        },
      } as unknown as WorkspaceLifecycleHost;
      lifecycle = new WorkspaceLifecycle(lifecycleHost as never);

      const pop1 = await lifecycle.populateTaskWorktree(store.task(taskB.id));
      const ws1 = await lifecycle.createWorkspace(store.task(taskB.id), { freshlyPopulated: true });
      const b1 = store.task(taskB.id).workspaceAllocation!;
      if (b1.custodian?.pid) env.pidsToCleanup.push(b1.custodian.pid);

      // Make commit in B1 & push branch for continuation
      writeFileSync(join(pop1.directory, "move.txt"), "step 1\n");
      await runGit(pop1.directory, "add", "move.txt");
      await runGit(pop1.directory, "commit", "-m", "step 1");
      const moveHead = await runGit(pop1.directory, "rev-parse", "HEAD");
      await runGit(pop1.directory, "push", "origin", `${taskB.branch}:${taskB.branch}`);

      // Execute replacement via recoverTaskWorkspace (same branch `ns-<taskB>`, sequence 2, new requestId!)
      store.update(taskB.id, {
        workspaceId: ws1.id,
        directory: ws1.directory,
      });
      moveTaskToWorkerHost({
        store,
        taskId: taskB.id,
        oldHead: moveHead,
        targetHostId: "paseo-host",
        targetProfile: {
          id: "paseo",
          name: "paseo",
          provider: "codex",
          model: "gpt-5",
          notes: "",
          available: true,
          problem: "",
          supportedThinking: [],
        },
        targetGroup: null,
        hostSelection: { basis: "worker_profile", hostId: "paseo-host", reason: "move test" },
        retireReason: "move test",
      });

      // Return displaced lease 1 cleanly before provisioning replacement on target host
      const movedTask = store.task(taskB.id);
      assert.equal(movedTask.resolution.displacedWorkspaceAllocations.length, 1);
      await returnBargeAllocation({
        allocation: movedTask.resolution.displacedWorkspaceAllocations[0]!,
        task: movedTask,
        originPublished: true,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(taskB.id, u),
        cliOptions: env.cliOptions,
      });

      const ws2 = await lifecycle.recoverTaskWorkspace(store.task(taskB.id), {
        target: "branch",
      });
      const b2 = store.task(taskB.id).workspaceAllocation!;
      if (b2.custodian?.pid) env.pidsToCleanup.push(b2.custodian.pid);
      assert.equal(b2.sequence, 2);
      assert.notEqual(b2.requestId, b1.requestId);
      assert.notEqual(b2.leaseId, b1.leaseId);
      assert.equal(b2.custodian?.state, "holding");
      assert.equal(await runGit(ws2.directory, "rev-parse", "HEAD"), moveHead);
      assert.equal(await runGit(ws2.directory, "branch", "--show-current"), taskB.branch);

      await returnBargeAllocation({
        allocation: b2,
        task: store.task(taskB.id),
        originPublished: true,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(taskB.id, u),
        cliOptions: env.cliOptions,
      });
    } finally {
      for (const pid of env.pidsToCleanup) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
