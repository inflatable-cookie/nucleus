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
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RuntimeRepositories } from "../core/runtime/repositories";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { moveTaskToWorkerHost } from "../core/dispatch/worker-host-move";
import { HostPolicies } from "../core/host/host-policies";
import type { Adapter, HostPolicyConstructor } from "../core/host";
import {
  verifyTaskWorktreeIdentity,
  verifyResume,
  git,
} from "../core/git/index";
import { commonDirMatchesTask, originsMatchForTask } from "../core/git/git-identity";
import { assertOrdinaryReviewIdentity } from "../core/review/ordinary-review";
import { retainedWorkspacePlacement } from "../core/review/review-policy";
import { proveWorkspaceEmpty } from "../core/verbs/disposition/workspace";
import {
  bargeWorktreeLease,
  BargeCliError,
  overrideBargeCommandRunnerForTest,
  type BargeCommandExecutionInput,
} from "../core/workspaces/barge-cli";
import {
  BargeCustodyLostError,
  BargeUnsupportedCustodyError,
  overrideBargeCustodianDriverForTest,
  type BargeCustodianDriver,
} from "../core/workspaces/barge-custodian";
import {
  chooseWorkspaceProvider,
  createBargeAllocationIntent,
  nextAllocationSequence,
  provisionBargeAllocation,
  returnBargeAllocation,
  verifyBargeLeaseAndCustody,
} from "../core/workspaces/barge-allocator";
import { createStoreWorkspaceAllocationBridge } from "../core/workspaces/workspace-allocation-bridge";
import {
  CheckoutRefusalError,
  CheckoutUnavailableError,
} from "../core/workspaces/checkout-volume";
import { ensureTaskNodeModules } from "../core/workspaces/task-node-modules";
import { buildOutputCheckoutMismatch } from "../core/workspaces/worktree-cleanup";
import {
  canonicalLinkRoot,
  provisionWorktreeLinks,
} from "../core/workspaces/worktree-links";
import {
  WorkspaceLifecycle,
  type WorkspaceLifecycleHost,
} from "../core/workspaces/workspace-lifecycle";
import { OwnedWorkspaceArchive } from "../core/workspaces/owned-workspace-archive";
import { submissionSchema, type WorkspaceAllocation } from "../shared/contracts";

const execFileAsync = promisify(execFile);

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), prefix));
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nucleus Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Nucleus Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout.trim();
}

async function initGitRepoPair(root: string): Promise<{
  originBare: string;
  repoPath: string;
  cloneBare: string;
  baseSha: string;
}> {
  const originBare = join(root, "origin.git");
  const repoPath = join(root, "primary");
  const cloneBare = join(root, "area", ".barge", "clone.git");
  mkdirSync(originBare, { recursive: true });
  mkdirSync(join(root, "area", ".barge"), { recursive: true });
  await runGit(originBare, "init", "--bare", "-b", "main");

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await runGit(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "pkg" }));
  await runGit(seed, "add", "-A");
  await runGit(seed, "commit", "-m", "initial");
  await runGit(seed, "remote", "add", "origin", originBare);
  await runGit(seed, "push", "origin", "main");
  const baseSha = await runGit(seed, "rev-parse", "HEAD");
  rmSync(seed, { recursive: true, force: true });

  await execFileAsync("git", ["clone", originBare, repoPath]);
  await execFileAsync("git", ["clone", "--bare", originBare, cloneBare]);
  await runGit(cloneBare, "remote", "set-url", "origin", originBare);
  return { originBare, repoPath, cloneBare, baseSha };
}

async function addWorktreeCheckout(
  cloneBare: string,
  wtPath: string,
  branch: string,
  baseSha: string,
): Promise<string> {
  mkdirSync(join(wtPath, ".."), { recursive: true });
  await runGit(cloneBare, "worktree", "add", "-b", branch, wtPath, baseSha);
  return await runGit(wtPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

function submitTestTask(store: Store, repoPath: string, baseSha: string, extra: Partial<Parameters<typeof submissionSchema.parse>[0]> = {}) {
  store.upsertProject({
    key: "example",
    name: "Example",
    repositories: [{ origin: "example/repo", path: repoPath }],
  });
  const inserted = store.insert(
    submissionSchema.parse({
      submissionId: `sub-${Math.random().toString(16).slice(2)}`,
      title: "Barge task",
      repoPath,
      baseBranch: "main",
      planningCommit: baseSha,
      brief: { text: "Brief" },
      originAgentId: "agent-1",
      ...extra,
    }),
    "paseo-synthetic",
    "Brief",
    baseSha,
  );
  return store.update(inserted.id, { repository: "example/repo" });
}

test("repository.set persists workspaceProvider opt-in while keeping defaults and existing allocations unchanged", async () => {
  const dir = makeTempDir("nuc-barge-optin-");
  try {
    const { repoPath, baseSha } = await initGitRepoPair(dir);
    await runGit(repoPath, "remote", "set-url", "origin", "https://github.com/example/repo.git");
    const store = new Store(":memory:");
    const runtime = new RuntimeRepositories({
      store,
      markStoreAccess: () => undefined,
      requiredCheckTransport: async () => ({ supported: true, reason: "" }),
      wakeRepository: () => undefined,
    } as never);

    // Default unconfigured keeps local
    const preTask = submitTestTask(store, repoPath, baseSha);
    assert.equal(
      chooseWorkspaceProvider({
        task: preTask,
        workspaceProviderFor: (t) => store.workspaceProviderFor(t),
      }),
      "local",
    );

    // Opt repository into barge
    const updated = await runtime.setRepository({
      repository: repoPath,
      workspaceProvider: "barge",
    });
    assert.equal(updated.workspaceProvider, "barge");

    const fetched = await runtime.getRepository({ repository: repoPath });
    assert.equal(fetched?.workspaceProvider, "barge");

    // Existing already-allocated local task keeps local
    const existingLocalTask = store.update(preTask.id, {
      workspaceId: "ws-local-1",
      directory: "/tmp/local-ws",
    });
    assert.equal(
      chooseWorkspaceProvider({
        task: existingLocalTask,
        workspaceProviderFor: (t) => store.workspaceProviderFor(t),
      }),
      "local",
    );

    // Proof-only and external tasks keep local even on Barge-opted repo
    const proofTask = { ...preTask, proofOnly: { commit: baseSha } };
    assert.equal(
      chooseWorkspaceProvider({
        task: proofTask,
        workspaceProviderFor: (t) => store.workspaceProviderFor(t),
      }),
      "local",
    );

    const externalTask = store.update(preTask.id, {
      workspaceId: null,
      directory: null,
      workspaceOwnership: "external",
    });
    assert.equal(
      chooseWorkspaceProvider({
        task: externalTask,
        workspaceProviderFor: (t) => store.workspaceProviderFor(t),
      }),
      "local",
    );

    // Fresh non-external, non-proofOnly task selects barge
    const freshTask = submitTestTask(store, repoPath, baseSha);
    assert.equal(
      chooseWorkspaceProvider({
        task: freshTask,
        workspaceProviderFor: (t) => store.workspaceProviderFor(t),
      }),
      "barge",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("barge CLI places --json first, decodes barge.error/1, and classifies full pool as CheckoutUnavailableError", async () => {
  const seenArgvs: string[][] = [];
  overrideBargeCommandRunnerForTest(async (input: BargeCommandExecutionInput) => {
    seenArgvs.push(input.argv);
    return {
      exitCode: 1,
      stdout: "",
      stderr: JSON.stringify({
        schema: "barge.error/1",
        error: {
          kind: "refused",
          message:
            'worktree pool "example" is at its maximum of 2 and no root is free; nothing was leased',
        },
      }),
    };
  });

  try {
    await assert.rejects(
      bargeWorktreeLease({
        repo: "https://github.com/example/repo.git",
        base: "a".repeat(40),
        branch: "ns-task-1",
        request: "nuc-task-1-a1",
      }),
      (err: unknown) => {
        assert.ok(err instanceof BargeCliError);
        assert.equal(err.kind, "refused");
        assert.equal(err.isPoolFull(), true);
        assert.equal(err.isPoolUnavailable(), true);
        return true;
      },
    );
    assert.equal(seenArgvs[0]?.[0], "--json");
    assert.equal(seenArgvs[0]?.[1], "worktree");
    assert.equal(seenArgvs[0]?.[2], "lease");
  } finally {
    overrideBargeCommandRunnerForTest(null);
  }
});

test("Barge allocation persists requestId before lease, reconciles uncertain reply via lease get, and holds custodian before native Paseo/T3 registration", async () => {
  const dir = makeTempDir("nuc-barge-alloc-");
  try {
    const { originBare, repoPath, cloneBare, baseSha } = await initGitRepoPair(dir);
    const store = new Store(":memory:");
    store.putRepository({ origin: "example/repo", path: repoPath }, null, "", null, null, null, null, null, null, null, "barge");
    const task = submitTestTask(store, repoPath, baseSha);
    const bridge = createStoreWorkspaceAllocationBridge(store);

    const wtCheckout = join(dir, "area", "wt-1", "checkout");
    await addWorktreeCheckout(cloneBare, wtCheckout, task.branch, baseSha);
    const realWtCheckout = realpathSync(wtCheckout);

    const sequence = nextAllocationSequence(task);
    const intent = createBargeAllocationIntent({
      task,
      sequence,
      baseSha,
      repoIdentifier: originBare,
    });

    const events: string[] = [];
    // Persist BEFORE calling Barge CLI
    bridge.saveWorkspaceAllocation(task.id, intent, {
      auditEvent: { kind: "barge_allocation_intent", detail: intent.requestId! },
    });
    assert.equal(store.task(task.id).workspaceAllocation?.state, "intent");
    assert.ok(store.task(task.id).workspaceAllocation?.requestId);

    overrideBargeCommandRunnerForTest(async ({ argv }) => {
      const cmd = argv.slice(1, 4).join(" ");
      if (cmd.startsWith("worktree lease get")) {
        events.push(`lease_get:${argv.join(" ")}`);
        // Simulate uncertain reply reconciled by requestId without creating a second allocation
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schema: "barge.worktree-lease/1",
            data: {
              schema: "barge.worktree-lease/1",
              lease_id: "lease-101",
              request: intent.requestId,
              repo: "example/repo",
              base: baseSha,
              base_name: "main",
              branch: task.branch,
              label: task.id,
              pool: "example-repo",
              root_id: "wt-1",
              path: realWtCheckout,
              head: baseSha,
              state: "leased",
              disposable: false,
              created_unix_ms: 1000,
              updated_unix_ms: 1000,
            },
          }),
        };
      }
      if (cmd.startsWith("worktree lease")) {
        events.push(`lease:${argv.join(" ")}`);
        // Verify intent WAS already persisted before barge worktree lease ran
        assert.equal(store.task(task.id).workspaceAllocation?.requestId, intent.requestId);
        // Drop reply -> uncertain!
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          stdout: "",
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: JSON.stringify({ schema: "barge.error/1", error: { kind: "io", message: "unexpected" } }) };
    });

    const fakeCustodian: BargeCustodianDriver = {
      async start(input) {
        events.push(`custodian_start:${input.leaseId}`);
        // Lease identity and path MUST already be saved before custodian starts!
        const persisted = store.task(task.id).workspaceAllocation;
        assert.equal(persisted?.leaseId, "lease-101");
        assert.equal(persisted?.checkoutPath, realWtCheckout);
        assert.ok(persisted?.gitCommonDir);
        return {
          state: "holding",
          token: "tok-101",
          pid: process.pid,
          startIdentity: "test:self",
          readyFile: join(dir, "ready.json"),
          stopFile: join(dir, "stop"),
          startedAt: new Date().toISOString(),
          verifiedAt: new Date().toISOString(),
          releasedAt: null,
          error: null,
        };
      },
      async verify(allocation) {
        return {
          status: "holding",
          checkedAt: new Date().toISOString(),
          custodian: allocation.custodian!,
        };
      },
      async release(allocation) {
        events.push(`custodian_release:${allocation.leaseId}`);
        return {
          ...allocation.custodian!,
          state: "released",
          releasedAt: new Date().toISOString(),
        };
      },
    };
    overrideBargeCustodianDriverForTest(fakeCustodian);

    // Run through WorkspaceLifecycle (works identically for Paseo & T3 native registration)
    for (const hostKind of ["paseo", "t3code"] as const) {
      const registrations: Array<{ title: string; directory: string; requestId: string }> = [];
      const host: WorkspaceLifecycleHost = {
        helperPath: join(dir, "helper.mjs"),
        workspaceAllocationBridge: bridge,
        workspaceHost: {
          workspaceInventory: async () =>
            registrations.map((r, i) => ({
              id: `ws-${hostKind}-${i}`,
              projectRootPath: repoPath,
              workspaceDirectory: r.directory,
            })),
          repositoryProject: async () => ({ workspaceRoot: repoPath }),
          createWorkspace: async (spec) => {
            events.push(`native_create:${hostKind}:${spec.directory}`);
            // Custodian MUST already be holding before native registration runs
            assert.equal(store.task(task.id).workspaceAllocation?.custodian?.state, "holding");
            registrations.push({
              title: spec.title,
              directory: spec.directory,
              requestId: spec.requestId,
            });
            return { id: `ws-${hostKind}-1`, directory: spec.directory };
          },
        },
        dataDir: () => join(dir, "data"),
        placement: () => ({
          dataDir: join(dir, "data"),
          admit: () => {
            throw new Error("Queue local volume placement must NOT be called for Barge workspaces");
          },
        }),
        ownedPathFor: async (t) => store.task(t.id).workspaceAllocation!.checkoutPath!,
        ownedDataDirFor: async () => null,
        findWorkspaces: async () => [],
        inspectWorkspaceCreation: async () => ({ kind: "found_done", directory: realWtCheckout }),
        inspectOrphanWorkspace: async () => null,
      };
      const lifecycle = new WorkspaceLifecycle(host);
      await lifecycle.preflightWorkspaceStorage(store.task(task.id)).catch((err) => {
        // Note: status mock isn't needed after lease exists, preflight checks only pre-lease!
        assert.ok(!(err instanceof CheckoutUnavailableError) || hostKind === "paseo");
      });
      if (hostKind === "paseo") {
        const pop = await lifecycle.populateTaskWorktree(store.task(task.id));
        assert.equal(pop.directory, realWtCheckout);
        assert.equal(pop.populated, true);
      }
      const created = await lifecycle.createWorkspace(store.task(task.id), { freshlyPopulated: true });
      assert.equal(created.directory, realWtCheckout);
    }

    assert.ok(events.some((e) => e.startsWith("lease:")));
    assert.ok(events.some((e) => e.startsWith("lease_get:")));
    assert.ok(events.includes("custodian_start:lease-101"));
    assert.ok(events.includes(`native_create:paseo:${realWtCheckout}`));
    assert.ok(events.includes(`native_create:t3code:${realWtCheckout}`));
  } finally {
    overrideBargeCommandRunnerForTest(null);
    overrideBargeCustodianDriverForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custody loss fences return and surfaces on Engine.reconcile; unsupported worktree run refuses initial pilot", async () => {
  const dir = makeTempDir("nuc-barge-custody-loss-");
  try {
    const { repoPath, cloneBare, baseSha } = await initGitRepoPair(dir);
    const store = new Store(":memory:");
    const commonDir = realpathSync(
      await addWorktreeCheckout(cloneBare, join(dir, "area", "wt-1", "checkout"), "ns-custody", baseSha),
    );
    const wtCheckout = realpathSync(join(dir, "area", "wt-1", "checkout"));
    const task = submitTestTask(store, repoPath, baseSha);
    const allocation: WorkspaceAllocation = {
      provider: "barge",
      sequence: 1,
      allocationId: `${task.id}:a1`,
      requestId: "nuc-custody-a1",
      repoPath,
      repoIdentifier: "example/repo",
      baseBranch: "main",
      baseSha,
      branch: task.branch,
      label: task.id,
      leaseId: "lease-lost-1",
      pool: "example-repo",
      rootId: "wt-1",
      checkoutPath: wtCheckout,
      gitCommonDir: commonDir,
      state: "leased",
      custodian: {
        state: "holding",
        token: "tok-lost",
        pid: 999999,
        startIdentity: "test:999999",
        readyFile: null,
        stopFile: null,
        startedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        releasedAt: null,
        error: null,
      },
      returnRecord: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };
    store.update(task.id, {
      workspaceId: "ws-1",
      directory: wtCheckout,
      branch: "ns-custody",
      workspaceAllocation: allocation,
      phase: "working",
    });

    overrideBargeCommandRunnerForTest(async ({ argv }) => {
      if (argv.slice(1, 4).join(" ") === "worktree lease get") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schema: "barge.worktree-lease/1",
            data: {
              schema: "barge.worktree-lease/1",
              lease_id: "lease-lost-1",
              request: "nuc-custody-a1",
              repo: "example/repo",
              base: baseSha,
              branch: "ns-custody",
              pool: "example-repo",
              root_id: "wt-1",
              path: wtCheckout,
              head: baseSha,
              state: "leased",
              disposable: false,
              created_unix_ms: 1,
              updated_unix_ms: 1,
            },
          }),
        };
      }
      throw new Error("barge worktree return must NEVER run when custody is lost");
    });

    overrideBargeCustodianDriverForTest({
      async start() {
        throw new BargeUnsupportedCustodyError("unknown worktree command \"run\"");
      },
      async verify(alloc) {
        return {
          status: "lost",
          reason: "Custodian process exited unexpectedly (`held: false`)",
          checkedAt: new Date().toISOString(),
          custodian: { ...alloc.custodian!, state: "lost", error: "Custodian process exited unexpectedly (`held: false`)" },
        };
      },
      async release() {
        throw new BargeCustodyLostError("Custody lost before intentional release");
      },
    });

    const adapter = {
      hostId: "t3code-synthetic",
      observe: async () => ({ id: "a", workspaceId: "ws-1", status: "idle", active: false, permissions: false, error: "", archived: false }),
      listLiveAgents: async () => [],
      originAgent: async () => null,
    } as unknown as Adapter;
    const engine = new Engine(store, adapter, 0);
    await engine.reconcileBargeCustodians();

    const afterReconcile = store.task(task.id);
    assert.equal(afterReconcile.phase, "needs_attention");
    assert.equal(afterReconcile.workspaceAllocation?.state, "lost");
    assert.equal(afterReconcile.workspaceAllocation?.custodian?.state, "lost");
    assert.match(afterReconcile.reason, /custody lost/i);

    // Return remains strictly fenced
    const bridge = createStoreWorkspaceAllocationBridge(store);
    await assert.rejects(
      returnBargeAllocation({
        allocation: afterReconcile.workspaceAllocation!,
        task: afterReconcile,
        dispositionEvidence: "terminal_discard",
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task.id, u),
      }),
      BargeCustodyLostError,
    );
  } finally {
    overrideBargeCommandRunnerForTest(null);
    overrideBargeCustodianDriverForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git common-dir checks, node_modules setup, build output cleanup mismatch, and worktree-links adapt safely for Barge", async () => {
  const dir = makeTempDir("nuc-barge-git-checks-");
  try {
    const { repoPath, cloneBare, baseSha } = await initGitRepoPair(dir);
    const store = new Store(":memory:");
    const task = submitTestTask(store, repoPath, baseSha);
    const bargeCommon = realpathSync(
      await addWorktreeCheckout(cloneBare, join(dir, "area", "wt-2", "checkout"), task.branch, baseSha),
    );
    const wtCheckout = realpathSync(join(dir, "area", "wt-2", "checkout"));
    await runGit(cloneBare, "remote", "set-url", "origin", "https://github.com/example/repo.git");
    await runGit(repoPath, "remote", "set-url", "origin", "https://github.com/example/repo.git");

    // Prepare minimal brief trailer commit on Barge worktree for verifyResume
    const briefDigest = task.brief!.digest!;
    const updatedTask = store.update(task.id, {
      workspaceId: "ws-barge-2",
      directory: wtCheckout,
      workspaceAllocation: {
        provider: "barge",
        sequence: 1,
        allocationId: `${task.id}:a1`,
        requestId: "nuc-git-a1",
        repoPath,
        repoIdentifier: "https://github.com/example/repo.git",
        baseBranch: "main",
        baseSha,
        branch: task.branch,
        label: task.id,
        leaseId: "lease-git-1",
        pool: "example-repo",
        rootId: "wt-2",
        checkoutPath: wtCheckout,
        gitCommonDir: bargeCommon,
        state: "leased",
        custodian: null,
        returnRecord: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
      },
    });
    writeFileSync(join(wtCheckout, "work.txt"), "done\n");
    await runGit(wtCheckout, "add", "work.txt");
    await runGit(
      wtCheckout,
      "commit",
      "-m",
      "work",
      "--trailer",
      `Nucleus-Task: ${task.id}`,
      "--trailer",
      `Nucleus-Brief-Digest: ${briefDigest}`,
    );

    // 1. verifyTaskWorktreeIdentity passes with Barge commonDir != repoPath commonDir
    await verifyTaskWorktreeIdentity(updatedTask);

    // 2. verifyResume passes with Barge commonDir
    await verifyResume(updatedTask);

    // 3. assertOrdinaryReviewIdentity passes even with SSH vs HTTPS origin + Barge commonDir
    assert.equal(originsMatchForTask("git@github.com:example/repo.git", "https://github.com/example/repo.git"), true);
    const reviewHead = await runGit(wtCheckout, "rev-parse", "HEAD");
    assert.doesNotThrow(() =>
      assertOrdinaryReviewIdentity(
        { ...updatedTask, workspaceIntent: true },
        reviewHead,
      ),
    );

    // 4. Retained reviewer placement check on task's Barge directory passes
    const placement = await retainedWorkspacePlacement(
      {
        directory: wtCheckout,
        refresh: async () => undefined,
        current: () => ({ projectRootPath: wtCheckout }),
      },
      updatedTask,
      { id: "run-rev", workspaceId: "ws-barge-2", head: reviewHead } as never,
      { workspaceId: "ws-barge-2", directory: wtCheckout },
      "before review",
    );
    assert.deepEqual(placement, { placed: true });

    // 5. proveWorkspaceEmpty passes identity/commonDir check
    const emptyProof = await proveWorkspaceEmpty(store, {
      ...updatedTask,
      directory: wtCheckout,
    }, false, true);
    assert.equal(emptyProof.empty, true);

    // 6. buildOutputCheckoutMismatch passes with Barge expectedCommonDir
    const mismatch = await buildOutputCheckoutMismatch(repoPath, wtCheckout, {
      expectedCommonDir: bargeCommon,
      expectedCheckoutPath: wtCheckout,
    });
    assert.equal(mismatch, null);

    // 7. ensureTaskNodeModules passes with Barge expectedCommonDir (even with no lockfile -> early return or locked)
    await ensureTaskNodeModules(wtCheckout, repoPath, join(wtCheckout, ".."), {
      expectedCommonDir: bargeCommon,
      expectedCheckoutPath: wtCheckout,
    });

    // 8. canonicalLinkRoot & provisionWorktreeLinks do not emit spurious manifest_invalid on Barge
    const linkRoot = await canonicalLinkRoot(
      join(dir, "data"),
      repoPath,
      wtCheckout,
      undefined,
      updatedTask.workspaceAllocation,
    );
    assert.equal(linkRoot, realpathSync(join(wtCheckout, "..")));
    const linksResult = await provisionWorktreeLinks({
      dataDir: join(dir, "data"),
      task: {
        repoPath,
        directory: wtCheckout,
        workspaceId: "ws-barge-2",
        workspaceAllocation: updatedTask.workspaceAllocation,
      },
      configured: [],
    });
    assert.equal(linksResult.findings.length, 0);

    // 9. Late-read fence: returned allocation NEVER passes commonDirMatchesTask
    const returnedTask = {
      ...updatedTask,
      workspaceAllocation: {
        ...updatedTask.workspaceAllocation!,
        state: "returned" as const,
      },
    };
    assert.equal(
      commonDirMatchesTask(returnedTask, bargeCommon, await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"), wtCheckout),
      false,
    );
    await assert.rejects(verifyTaskWorktreeIdentity(returnedTask), /different Git roots/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable return gates --disposable, handles refused/interrupted/uncertain, keeps node_modules, and isolates reused paths on archive", async () => {
  const dir = makeTempDir("nuc-barge-return-");
  try {
    const { repoPath, cloneBare, baseSha } = await initGitRepoPair(dir);
    await runGit(repoPath, "remote", "set-url", "origin", "https://github.com/example/repo.git");
    await runGit(cloneBare, "remote", "set-url", "origin", "https://github.com/example/repo.git");
    const store = new Store(":memory:");
    const task = submitTestTask(store, repoPath, baseSha);
    const bridge = createStoreWorkspaceAllocationBridge(store);

    const commonDir = realpathSync(
      await addWorktreeCheckout(cloneBare, join(dir, "area", "wt-3", "checkout"), task.branch, baseSha),
    );
    const wtCheckout = realpathSync(join(dir, "area", "wt-3", "checkout"));
    // Warm node_modules + disposable Cargo target inside Barge tree
    mkdirSync(join(wtCheckout, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(wtCheckout, "node_modules", "dep", "index.js"), "keep\n");
    mkdirSync(join(wtCheckout, "target", "debug"), { recursive: true });
    writeFileSync(join(wtCheckout, "target", "debug", "bin"), "cleanme\n");

    const baseAlloc: WorkspaceAllocation = {
      provider: "barge",
      sequence: 1,
      allocationId: `${task.id}:a1`,
      requestId: "nuc-ret-a1",
      repoPath,
      repoIdentifier: "https://github.com/example/repo.git",
      baseBranch: "main",
      baseSha,
      branch: task.branch,
      label: task.id,
      leaseId: "lease-ret-1",
      pool: "example-repo",
      rootId: "wt-3",
      checkoutPath: wtCheckout,
      gitCommonDir: commonDir,
      state: "leased",
      custodian: {
        state: "holding",
        token: "tok-ret",
        pid: process.pid,
        startIdentity: "test:ret",
        readyFile: null,
        stopFile: null,
        startedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        releasedAt: null,
        error: null,
      },
      returnRecord: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };

    const calls: string[] = [];
    let mode: "return_refused_dirty" | "return_interrupted" | "return_lost_reply_then_ok" =
      "return_refused_dirty";

    overrideBargeCommandRunnerForTest(async ({ argv }) => {
      calls.push(argv.join(" "));
      const sub = argv.slice(1, 4).join(" ");
      if (sub === "worktree lease get") {
        const state = mode === "return_lost_reply_then_ok" ? "returned" : "leased";
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schema: "barge.worktree-lease/1",
            data: {
              schema: "barge.worktree-lease/1",
              lease_id: "lease-ret-1",
              request: "nuc-ret-a1",
              repo: "example/repo",
              base: baseSha,
              branch: task.branch,
              pool: "example-repo",
              root_id: "wt-3",
              path: wtCheckout,
              head: baseSha,
              state,
              disposable: true,
              created_unix_ms: 1,
              updated_unix_ms: 2,
            },
          }),
        };
      }
      if (argv.slice(1, 3).join(" ") === "worktree return") {
        // Native registration archive MUST have run BEFORE custodian release + return!
        if (mode === "return_refused_dirty") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: JSON.stringify({
              schema: "barge.error/1",
              error: { kind: "refused", message: "worktree has uncommitted changes; nothing was returned" },
            }),
          };
        }
        if (mode === "return_interrupted") {
          return {
            exitCode: 3,
            stdout: "",
            stderr: JSON.stringify({
              schema: "barge.error/1",
              error: { kind: "unknown_state", message: "interrupted return" },
            }),
          };
        }
        return { exitCode: null, signal: "SIGKILL", timedOut: true, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    overrideBargeCustodianDriverForTest({
      async start() {
        throw new Error("unused");
      },
      async verify(alloc) {
        return { status: "holding", checkedAt: new Date().toISOString(), custodian: alloc.custodian! };
      },
      async release(alloc) {
        calls.push(`custodian_released:${alloc.leaseId}`);
        return { ...alloc.custodian!, state: "released", releasedAt: new Date().toISOString() };
      },
    });

    // 1. Without publication/discard evidence, --disposable is NOT passed!
    const unpublishedTask = store.update(task.id, { workspaceAllocation: baseAlloc });
    await assert.rejects(
      returnBargeAllocation({
        allocation: store.task(task.id).workspaceAllocation!,
        task: unpublishedTask,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task.id, u),
      }),
      /uncommitted changes/,
    );
    assert.ok(!calls.some((c) => c.includes("--disposable")));
    assert.equal(store.task(task.id).workspaceAllocation?.returnRecord?.state, "refused");
    assert.ok(existsSync(wtCheckout), "Refused return never runs rm/git worktree remove");

    // 2. With mergedCommit (positive publication), --disposable IS passed; unknown_state records interrupted
    mode = "return_interrupted";
    const mergedTask = store.update(task.id, {
      phase: "done",
      workspaceId: "ws-ret-1",
      directory: wtCheckout,
      resolution: {
        ...store.task(task.id).resolution,
        mergedCommit: baseSha,
      },
      workspaceAllocation: { ...baseAlloc, custodian: { ...baseAlloc.custodian!, state: "released" } },
    });
    await assert.rejects(
      returnBargeAllocation({
        allocation: store.task(task.id).workspaceAllocation!,
        task: mergedTask,
        saveAllocation: (u) => bridge.saveWorkspaceAllocation(task.id, u),
      }),
      /interrupted return/,
    );
    assert.equal(store.task(task.id).workspaceAllocation?.state, "interrupted");
    assert.equal(store.task(task.id).workspaceAllocation?.returnRecord?.state, "interrupted");
    assert.ok(calls.some((c) => c.includes("--disposable")));

    // 3. Reconciling uncertain return reply via lease get completes without rm and preserves warm node_modules!
    mode = "return_lost_reply_then_ok";
    const res = await returnBargeAllocation({
      allocation: store.task(task.id).workspaceAllocation!,
      task: store.task(task.id),
      saveAllocation: (u) => bridge.saveWorkspaceAllocation(task.id, u),
    });
    assert.equal(res.status, "returned");
    assert.equal(store.task(task.id).workspaceAllocation?.state, "returned");
    assert.equal(store.task(task.id).workspaceAllocation?.returnRecord?.state, "returned");

    // 4. OwnedWorkspaceArchive on already-returned Barge path archives native registration ONLY without touching directory (could be newer task's lease!)
    let nativeArchived = false;
    const archive = new OwnedWorkspaceArchive({
      helperPath: join(dir, "helper.mjs"),
      workspaceAllocationBridge: bridge,
      dataDir: () => join(dir, "data"),
      placement: () => ({ dataDir: join(dir, "data"), admit: () => { throw new Error("must not admit"); } }),
      ownedDataDirFor: async () => null,
      ownedPathFor: async () => wtCheckout,
      classifyOrphan: (async () => ({ orphaned: false })) as never,
      observe: async () => null,
      workspaceHost: {
        workspaceInventory: async () => [],
        repositoryProject: async () => ({}),
        createWorkspace: async () => ({ id: "ws-ret-1", directory: wtCheckout }),
        archiveThreadPage: async () => ({ entries: [], hasMore: false }),
        workspaceRef: (id: string) => ({
          id,
          refresh: async () => undefined,
          current: () =>
            nativeArchived
              ? null
              : {
                  id,
                  projectId: "prj_1",
                  projectRootPath: repoPath,
                  directory: wtCheckout,
                },
          archive: async () => {
            nativeArchived = true;
            return { archivedAt: new Date().toISOString() };
          },
        }),
        activeThreads: async () => [],
      },
      hostProcessListing: async () => [],
    } as never);

    // Put a canary file from a hypothetical newer lease on wtCheckout to prove OwnedWorkspaceArchive never touches it after return!
    writeFileSync(join(wtCheckout, "newer-lease-work.txt"), "hands off\n");
    await archive.archiveTaskWorkspace(
      store.task(task.id),
      "ws-ret-1",
      wtCheckout,
      baseSha,
      () => true,
      false,
    );
    assert.equal(nativeArchived, true);
    assert.equal(existsSync(join(wtCheckout, "newer-lease-work.txt")), true);
  } finally {
    overrideBargeCommandRunnerForTest(null);
    overrideBargeCustodianDriverForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host move moves Barge allocation to displacedWorkspaceAllocations and allocates sequence+1 with new requestId only after old returns", async () => {
  const dir = makeTempDir("nuc-barge-hostmove-");
  try {
    const { originBare, repoPath, cloneBare, baseSha } = await initGitRepoPair(dir);
    const store = new Store(":memory:");
    store.putRepository({ origin: "example/repo", path: repoPath }, null, "", null, null, null, null, null, null, null, "barge");
    const task = submitTestTask(store, repoPath, baseSha);
    const bridge = createStoreWorkspaceAllocationBridge(store);

    const commonDir = realpathSync(
      await addWorktreeCheckout(cloneBare, join(dir, "area", "wt-1", "checkout"), task.branch, baseSha),
    );
    const wt1 = realpathSync(join(dir, "area", "wt-1", "checkout"));
    const alloc1: WorkspaceAllocation = {
      provider: "barge",
      sequence: 1,
      allocationId: `${task.id}:a1`,
      requestId: "nuc-move-a1",
      repoPath,
      repoIdentifier: originBare,
      baseBranch: "main",
      baseSha,
      branch: task.branch,
      label: task.id,
      leaseId: "lease-move-1",
      pool: "example-repo",
      rootId: "wt-1",
      checkoutPath: wt1,
      gitCommonDir: commonDir,
      state: "leased",
      custodian: {
        state: "holding",
        token: "tok-m1",
        pid: process.pid,
        startIdentity: "test:m1",
        readyFile: null,
        stopFile: null,
        startedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        releasedAt: null,
        error: null,
      },
      returnRecord: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };

    const movedPre = store.update(task.id, {
      workspaceId: "ws-old",
      directory: wt1,
      workspaceAllocation: alloc1,
      phase: "working",
    });

    const moved = moveTaskToWorkerHost({
      store,
      taskId: movedPre.id,
      oldHead: baseSha,
      targetHostId: "t3code-new",
      targetProfile: movedPre.profile ?? {
        id: "p-t3",
        name: "p-t3",
        provider: "codex",
        model: "gpt-5",
        notes: "",
        available: true,
        problem: "",
        supportedThinking: [],
      },
      targetGroup: movedPre.profileGroup ?? null,
      hostSelection: { basis: "worker_profile", hostId: "t3code-new", reason: "test host move" },
      retireReason: "test host move",
    });
    assert.equal(moved.hostId, "t3code-new");
    assert.equal(moved.workspaceAllocation, null);
    assert.equal(moved.resolution.displacedWorkspaceAllocations.length, 1);
    assert.equal(moved.resolution.displacedWorkspaceAllocations[0]?.leaseId, "lease-move-1");
    assert.equal(nextAllocationSequence(moved), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
