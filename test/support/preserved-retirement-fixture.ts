import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../core/store/store";
import { Engine } from "../../core/engine";
import { PaseoAdapter, type Adapter } from "../../service/paseo-composition";
import { submissionSchema, OPERATOR_BOARD_CALLER } from "../../shared/contracts";
import { RuntimeRetirementService } from "../../core/runtime/runtime-retirement";
import { classifyOrphanWorktree } from "../../core/workspaces/orphan-worktree";
import { ownedWorkspacePath } from "../../core/workspaces/workspace-allocation";
import { toolTimelineTail } from "./tool-timeline";

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A canonical repository with a pushed task commit and a generated build target. */
export async function setup(t: { after(fn: () => void | Promise<void>): void }, merged = false, nestedOutputs = false, canonical = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nsq-worktree-cleanup-")));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git"), repo = join(root, "repo"), worktreeRoot = join(root, "worktrees");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, repo);
  git(repo, "config", "user.name", "Queue tests");
  git(repo, "config", "user.email", "queue@example.invalid");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "Cargo.toml"), "[package]\nname = \"cache-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  await writeFile(join(repo, "Cargo.lock"), 'version = 3\n\n[[package]]\nname = "cache-fixture"\nversion = "0.1.0"\n');
  await writeFile(join(repo, ".gitignore"), "target/\nnode_modules/\ntask-build/\n");
  await writeFile(join(repo, "src", "lib.rs"), "pub fn shared_source() -> u8 { 1 }\n");
  git(repo, "add", "-A"); git(repo, "commit", "-m", "base"); git(repo, "push", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  await mkdir(worktreeRoot);
  const store = new Store(join(root, "queue.sqlite"));
  store.setMeta("paused", false);
  const inserted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: merged ? "Merged cleanup" : "Cancelled cleanup", repoPath: repo,
    planningCommit: base, handoffPath: "handoff.md", originAgentId: "origin",
  }), "host", "handoff", base);
  const directory = canonical ? ownedWorkspacePath(join(root, "data"), git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), inserted.id) : join(worktreeRoot, `ns-${inserted.id}`);
  git(repo, "worktree", "add", "-b", inserted.branch, directory);
  git(directory, "config", "user.name", "Queue tests");
  git(directory, "config", "user.email", "queue@example.invalid");
  await writeFile(join(directory, "src", "task.rs"), "pub fn task_source() -> u8 { 2 }\n");
  git(directory, "add", "-A"); git(directory, "commit", "-m", "task work");
  git(directory, "push", "-u", "origin", inserted.branch);
  let mergedCommit: string | null = null;
  const backend = join(directory, "backend");
  const nestedNodeModules = join(directory, "frontend", "apps", "web", "node_modules", "pkg");
  if (nestedOutputs) {
    await mkdir(join(backend, "src"), { recursive: true });
    await writeFile(join(backend, "Cargo.toml"), '[package]\nname = "nested-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(backend, "Cargo.lock"), 'version = 3\n\n[[package]]\nname = "nested-fixture"\nversion = "0.1.0"\n');
    await writeFile(join(backend, "src", "lib.rs"), "pub fn nested_source() {}\n");
    await mkdir(nestedNodeModules, { recursive: true });
    await writeFile(join(nestedNodeModules, "cache.bin"), "generated package output");
    git(directory, "add", "backend");
    git(directory, "commit", "-m", "add nested build fixtures");
    git(directory, "push", "origin", inserted.branch);
  }
  const taskHead = git(directory, "rev-parse", "HEAD");
  if (merged) {
    git(repo, "merge", "--no-ff", inserted.branch, "-m", "merge task work");
    mergedCommit = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "origin", "main");
  }
  const target = join(directory, "target", "debug");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "cache.bin"), "generated output");
  const nestedTarget = join(backend, "target", "debug");
  if (nestedOutputs) {
    await mkdir(nestedTarget, { recursive: true });
    await writeFile(join(nestedTarget, "cache.bin"), "nested generated output");
  }
  const task = store.update(inserted.id, {
    workspaceId: `workspace-${inserted.id}`, directory, prHead: taskHead,
    phase: merged ? "done" : "working",
    ...(merged ? { resolution: { ...inserted.resolution, mergedCommit, syncedCommit: mergedCommit } } : {
      workspaceIntent: true, agentIntent: true, agentId: `worker-${inserted.id}`, runId: `run-${inserted.id}`,
    }),
  });
  return { root, remote, repo, worktreeRoot, store, task, directory, target: join(directory, "target"), nestedTarget: join(directory, "backend", "target"), nestedNodeModules: join(directory, "frontend", "apps", "web", "node_modules"), head: taskHead, base, mergedCommit };
}

export function archiverFor(f: Awaited<ReturnType<typeof setup>>, agents: unknown[] = []) {
  const archive = { count: 0, requests: [] as string[], failure: null as string | null, catalogued: true, retainDirectory: false, lostReply: false };
  const workspace = { projectRootPath: f.repo, worktreeSlug: f.task.branch };
  const adapter = Object.create(PaseoAdapter.prototype) as InstanceType<typeof PaseoAdapter>;
  (adapter as any).dataDir = () => join(f.root, "data");
  // A class field, not a prototype method: the real classifier is what a discard
  // reads at the adapter's orphan proof, so the fixture carries the same rule.
  (adapter as any).classifyOrphan = classifyOrphanWorktree;
  adapter.observe = async id => ({ id, workspaceId: f.task.workspaceId, status: "idle", active: false, permissions: false, error: "" });
  adapter.agentTimelinePage = async () => toolTimelineTail([], 200);
  Object.defineProperty(adapter, "api", { value: {
    workspaces: { ref: (id: string) => ({
      directory: f.directory, refresh: async () => {},
      current: () => id === f.task.workspaceId && archive.catalogued ? workspace : undefined,
      archive: async (requestId: string) => {
        const retirement = f.store.task(f.task.id).resolution.workspaceRetirement;
        if (retirement) {
          assert.equal(retirement.state, 'intent', 'intent is durable at the actual native effect boundary');
          assert.ok(retirement.intentAt);
        }
        archive.count++;
        archive.requests.push(requestId);
        if (archive.failure) throw Error(archive.failure);
        archive.catalogued = false;
        if (archive.lostReply) throw Error("worktree.teardown interrupted: native archive reply lost after catalog removal");
        if (!archive.retainDirectory) await rm(f.directory, { recursive: true, force: true });
        return { archivedAt: new Date().toISOString() };
      },
    }) },
    agents: { list: async () => ({ entries: agents.map(agent => ({ agent })), pageInfo: { hasMore: false } }) },
  } });
  return { adapter, archive, workspace };
}

export function engineAdapter(archiveWorkspace: Adapter["archiveTaskWorkspace"], observeStatus = "idle"): Adapter {
  return {
    profiles: async () => [], validate: async () => "", createWorkspace: async () => { throw new Error("unused"); },
    findWorkspaces: async () => [], verifyWorkspace: async task => task.branch,
    createAgent: async () => { throw new Error("unused"); }, findAgents: async () => [],
    observe: async id => ({ id, workspaceId: null, status: observeStatus, active: observeStatus === "running", permissions: false, error: "" }),
    archiveAgent: async () => {}, archiveTaskWorkspace: archiveWorkspace, taskWorkspaceArchived: async () => false,
    verifyPr: async () => ({ url: "", head: "" }),
  };
}

/** Run-bound settlement (Queue #342): a finished run's output goes once its agent is observably idle. */
export function settlingAdapter(f: Awaited<ReturnType<typeof setup>>, agent: { active: boolean }): Adapter {
  return {
    ...engineAdapter(async () => { throw new Error("unused"); }),
    observe: async id => ({ id, workspaceId: f.task.workspaceId, status: agent.active ? "running" : "idle", active: agent.active, permissions: false, error: "" }),
  };
}

export async function preservedFixture(t: Parameters<typeof setup>[0], agents: unknown[] = [], canonical = false) {
  const f = await setup(t, false, false, canonical);
  const { adapter: archiver, archive, workspace } = archiverFor(f, agents);
  const adapter: Adapter = { ...settlingAdapter(f, { active: false }),
    archiveTaskWorkspace: (...args: Parameters<NonNullable<Adapter['archiveTaskWorkspace']>>) => archiver.archiveTaskWorkspace(...args),
    taskWorkspaceArchived: id => archiver.taskWorkspaceArchived(id),
    verifyCancelledWorkspacePr: async () => {}, findAnyOpenBranchPr: async () => [],
  };
  const runtime = new RuntimeRetirementService(f.store, async () => ({ code: 0, timedOut: false, spawnError: '', output: '{"scope":{"kind":"none"}}' }));
  const engine = new Engine(f.store, adapter, 0, undefined, runtime);
  const cancelled = await engine.disposeTask({ taskId: f.task.id, version: f.task.version, action: 'cancel', reason: 'Keep evidence', workDisposition: 'preserve' });
  const retry = (overrides: Record<string, unknown> = {}) => engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version,
    action: 'retry_effect', effect: `workspace_archive.${f.task.workspaceId}`, reason: 'Owner authorizes retirement; published source is retained', caller: OPERATOR_BOARD_CALLER, ...overrides });
  return { ...f, adapter, archive, workspace, runtime, engine, cancelled, retry,
    close: async () => { await engine.stop(); f.store.close(); } };
}
