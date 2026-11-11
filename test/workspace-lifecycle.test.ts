import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaseoAdapter } from "../service/paseo-composition";
import { ownedWorkspacePath, repoCommonDir, workspaceCreationRefusal } from "../core/workspaces/workspace-allocation";
import { WorkspaceLifecycle, type WorkspaceLifecycleHost, type WorkspacePlacementFixture } from "../core/workspaces/workspace-lifecycle";
import type { Task } from "../shared/contracts";

/**
 * Step 4 row 1 of the Paseo split (task 902): workspace preflight, population,
 * creation and recovery policy moves out of `host/paseo/paseo.ts` into core.
 *
 * These witnesses pin what that move could quietly break. Every fact the policy
 * reads from its host — the data home, the test placement, the process scan, the
 * progress hook and the native workspace calls — is read at the call that uses
 * it, never captured. The policy re-enters its own public entry points through
 * the host, so an override at the host still governs the whole operation exactly
 * as the adapter's self-calls did. Creation keeps its step order and its progress
 * events, and the adapter's delegates add no microtask turn of their own.
 */

const gitRepo = (root: string) => {
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "base");
};

/**
 * A host surface carrying only what the policy reads; every call and every fact is
 * recorded. The adapter's own wiring is reproduced by `bind`: the machine seams
 * (`dataDir`, `placement`, `ownedPathFor`, `ownedDataDirFor`) delegate back to the
 * policy, so its implementations run — unless a case replaces that seam, which is
 * exactly how a test overrides `adapter.dataDir` on the real adapter.
 */
type HostStub = WorkspaceLifecycleHost & { calls: string[]; bind(policy: WorkspaceLifecycle): void };
function hostStub(overrides: Partial<WorkspaceLifecycleHost> = {}): HostStub {
  const calls: string[] = [];
  const bound: { policy: WorkspaceLifecycle | null } = { policy: null };
  return {
    calls,
    helperPath: "/nowhere/data/report.mjs",
    workspaceHost: {
      workspaceInventory: async () => { calls.push("workspaceInventory"); return []; },
      repositoryProject: async projectRoot => { calls.push(`repositoryProject:${projectRoot}`); return { projectId: "prj_one" }; },
      createWorkspace: async spec => { calls.push(`createWorkspace:${spec.requestId}:${spec.directory}`); return { id: "w-created", directory: spec.directory }; },
    },
    findWorkspaces: async () => { calls.push("findWorkspaces"); return []; },
    inspectWorkspaceCreation: async (_task, options) => {
      calls.push(`inspectWorkspaceCreation:${options?.progress ? "progress" : "silent"}`);
      return { kind: "absent" };
    },
    inspectOrphanWorkspace: async () => { calls.push("inspectOrphanWorkspace"); return null; },
    dataDir: () => bound.policy!.dataDir(),
    placement: () => bound.policy!.placement(),
    ownedPathFor: (task: Task) => bound.policy!.ownedPathFor(task),
    ownedDataDirFor: (task: Task, directory: string) => bound.policy!.ownedDataDirFor(task, directory),
    bind: (policy: WorkspaceLifecycle) => { bound.policy = policy; },
    ...overrides,
  };
}

/** A policy over the stub host, wired the way the adapter wires itself. */
const policy = (host: HostStub): WorkspaceLifecycle => {
  const lifecycle: WorkspaceLifecycle = new WorkspaceLifecycle(host);
  host.bind(lifecycle);
  return lifecycle;
};

const task = (overrides: Partial<Task> = {}) => ({ id: "lifecycle", repoPath: "/repo", baseBranch: "main", branch: "ns-lifecycle",
  title: "A lifecycle", ...overrides }) as Task;

test("the data home and the placement are read from the host at each call, never captured", () => {
  const host = hostStub();
  const lifecycle = policy(host);

  assert.equal(lifecycle.dataDir(), "/nowhere/data");
  (host as { helperPath: string }).helperPath = "/elsewhere/state/report.mjs";
  assert.equal(lifecycle.dataDir(), "/elsewhere/state", "the next call derives from the data home the host holds now");

  assert.equal(lifecycle.placement(), null, "no fixture placement and a data home that is not the live one is no placement");
  const admitted: string[] = [];
  const fixture: WorkspacePlacementFixture = { dataDir: "/fixture/queue", admit: path => admitted.push(path) };
  (host as { testPlacement?: WorkspacePlacementFixture }).testPlacement = fixture;
  const placement = lifecycle.placement();
  assert.equal(placement, fixture, "a test placement is returned as the host holds it");
  placement!.admit("/fixture/queue/ns-lifecycle");
  assert.deepEqual(admitted, ["/fixture/queue/ns-lifecycle"], "the fixture's own admission is the one called");

  // A replaced fixture is the one the next call admits through.
  const second: string[] = [];
  (host as { testPlacement?: WorkspacePlacementFixture }).testPlacement = { dataDir: "/fixture/queue", admit: path => second.push(path) };
  lifecycle.placement()!.admit("/fixture/queue/ns-lifecycle");
  assert.deepEqual([admitted, second], [["/fixture/queue/ns-lifecycle"], ["/fixture/queue/ns-lifecycle"]]);
});

test("the storage preflight proves the owned path against the placement the host holds at that call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), retained = join(root, "retained", "queue"), current = join(root, "current", "queue");
  mkdirSync(repo, { recursive: true });
  gitRepo(repo);
  const common = await repoCommonDir(repo);
  // A checkout an earlier allocation left on a retained volume: owned, but not by the current root.
  const recorded = ownedWorkspacePath(retained, common, "lifecycle");

  const admissions: string[] = [];
  const host = hostStub({ testPlacement: { dataDir: current, retainedDataDirs: [retained], admit: path => admissions.push(path) } });
  const lifecycle = policy(host);
  await lifecycle.preflightWorkspaceStorage(task({ repoPath: repo, directory: recorded }));
  assert.deepEqual(admissions, [recorded], "the recorded retained checkout is the path admitted");

  // The fixture the host holds at the next call decides the next admission.
  const later: string[] = [];
  (host as { testPlacement?: WorkspacePlacementFixture }).testPlacement = { dataDir: current, retainedDataDirs: [retained], admit: path => later.push(path) };
  await policy(host).preflightWorkspaceStorage(task({ repoPath: repo, directory: recorded }));
  assert.deepEqual(later, [recorded]);

  // A foreign directory is refused before anything is admitted.
  await assert.rejects(lifecycle.preflightWorkspaceStorage(task({ repoPath: repo, directory: join(root, "foreign") })),
    { message: "Recorded workspace directory is not a Queue allocation" });
  assert.deepEqual(admissions, [recorded], "a refused path admits nothing");
});

test("the moved inspection reports its steps and scans with the hook the host holds at that call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  gitRepo(repo);

  const order: string[] = [];
  const host = hostStub({
    helperPath: join(data, "report.mjs"),
    testPlacement: { dataDir: data, admit: () => order.push("admit") },
    scanForWorktreeAdd: path => { order.push(`scan:${path}`); return { state: "absent" }; },
    workspaceCreationProgress: (_taskId, step, status) => order.push(`${status}:${step}`),
  });
  const scanned = await policy(host).inspectWorkspaceCreation(task({ repoPath: repo }), { progress: true });

  assert.deepEqual(scanned, { kind: "absent" });
  const owned = ownedWorkspacePath(data, await repoCommonDir(repo), "lifecycle");
  assert.deepEqual(order, [
    `scan:${owned}`,
    "started:worktree_inspection_git_worktree_list",
    "finished:worktree_inspection_git_worktree_list",
    "started:worktree_inspection_git_rev_parse",
    "finished:worktree_inspection_git_rev_parse",
  ], "the process scan runs first, then each Git substep keeps its own started/finished pair, and nothing is admitted");

  // A reconciliation's silent inspection reports nothing at all.
  order.length = 0;
  await policy(host).inspectWorkspaceCreation(task({ repoPath: repo }));
  assert.deepEqual(order.filter(entry => !entry.startsWith("scan:")), [], "no progress write moves the task version a replay fences on");
});

test("creation keeps its step order and its progress events across the moved boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  gitRepo(repo);

  const order: string[] = [];
  const owned = ownedWorkspacePath(data, await repoCommonDir(repo), "lifecycle");
  const host = hostStub({
    workspaceCreationProgress: (_taskId, step, status) => order.push(`${status}:${step}`),
    inspectWorkspaceCreation: async () => { order.push("inspectWorkspaceCreation"); return { kind: "found_done", directory: owned }; },
  });
  host.workspaceHost.createWorkspace = async spec => {
    order.push(`createWorkspace:${spec.requestId}`);
    return { id: "w-created", directory: spec.directory };
  };
  host.findWorkspaces = async () => { order.push("findWorkspaces"); return []; };

  const created = await policy(host).createWorkspace(task({ repoPath: repo }));
  assert.deepEqual(created, { id: "w-created", directory: owned });
  assert.deepEqual(order, [
    "started:workspace_identity_lookup",
    "findWorkspaces",
    "finished:workspace_identity_lookup",
    "started:worktree_inspection",
    "inspectWorkspaceCreation",
    "finished:worktree_inspection",
    "started:owned_path_proof",
    "finished:owned_path_proof",
    "started:path_registration_check",
    "finished:path_registration_check",
    "started:repository_project_lookup",
    "finished:repository_project_lookup",
    "started:paseo_workspace_create",
    "createWorkspace:ns-workspace-lifecycle",
    "finished:paseo_workspace_create",
  ], "identity, inspection, owned path, one-registration check, project lookup, then the native create");

  // A freshly populated checkout skips the identity lookup and keeps the create's request identity.
  order.length = 0;
  const fresh = await policy(host).createWorkspace(task({ repoPath: repo }), { freshlyPopulated: true });
  assert.deepEqual(fresh, { id: "w-created", directory: owned });
  assert.equal(order.includes("findWorkspaces"), false, "a freshly populated checkout has no identity to look up");
  assert.deepEqual(order.slice(0, 2), ["skipped:workspace_identity_lookup", "started:worktree_inspection"]);
});

test("the moved entry points re-enter through the host, so a replaced surface governs the whole operation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  gitRepo(repo);

  // Creation: a replaced `findWorkspaces` short-circuits it, even though the host's
  // inventory would match by the task's own slug.
  const reuse = { id: "w-known", directory: join(root, "known") };
  const host = hostStub({ testPlacement: { dataDir: data, admit: () => {} } });
  host.workspaceHost.workspaceInventory = async () => [{ id: "w-known", projectRootPath: repo, worktreeSlug: "ns-lifecycle", workspaceDirectory: reuse.directory }];
  host.findWorkspaces = async () => [reuse];
  assert.deepEqual(await policy(host).createWorkspace(task({ repoPath: repo })), reuse,
    "the replaced inventory match is the one creation reuses");
  assert.equal(host.calls.includes("inspectWorkspaceCreation:progress"), false, "a found identity never reaches inspection");

  // Population: the replaced inspection governs it and keeps its options.
  host.findWorkspaces = async () => [];
  host.inspectWorkspaceCreation = async (_task, options) => {
    host.calls.push(`populate-inspection:${options?.progress ? "progress" : "silent"}`);
    return { kind: "found_done", directory: reuse.directory };
  };
  assert.deepEqual(await policy(host).populateTaskWorktree(task({ repoPath: repo })),
    { directory: reuse.directory, populated: false, budgetMs: 0, elapsedMs: 0 });
  assert.deepEqual(host.calls.filter(call => call.startsWith("populate-inspection")), ["populate-inspection:progress"]);

  // Recovery: the replaced lookup decides, and a found checkout is still proved
  // clean on the accepted PR head before it is returned.
  const checkout = join(root, "recovered");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "worktree", "add", "-q", "-b", "ns-lifecycle", checkout, "main"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  host.findWorkspaces = async () => [{ id: "w-known", directory: checkout }];
  host.inspectWorkspaceCreation = async () => { host.calls.push("recovery-inspection"); return { kind: "absent" }; };
  assert.deepEqual(await policy(host).recoverTaskWorkspace(task({ repoPath: repo, prHead: head })),
    { id: "w-known", directory: checkout }, "a found checkout is returned once it proves clean on the accepted head");
  assert.deepEqual(host.calls.filter(call => call === "recovery-inspection"), [], "a found checkout needs no creation inspection");

  // Orphan removal: the replaced orphan inspection decides whether the removal may run.
  host.inspectOrphanWorkspace = async () => { host.calls.push("orphan-inspection"); return null; };
  await assert.rejects(policy(host).removeOrphanWorkspace(task({ repoPath: repo }), { directory: null, branch: "ns-lifecycle", head, lockReason: "initializing" }),
    { message: "Orphan workspace changed; inspect again" });
  assert.deepEqual(host.calls.filter(call => call === "orphan-inspection"), ["orphan-inspection"],
    "the removal re-enters the orphan inspection through the host");

  // Orphan inspection: the replaced creation inspection is its single decision point.
  host.inspectWorkspaceCreation = async () => { host.calls.push("orphan-creation-inspection"); return { kind: "absent" }; };
  assert.equal(await policy(host).inspectOrphanWorkspace(task({ repoPath: repo })), null);
  assert.deepEqual(host.calls.filter(call => call === "orphan-creation-inspection"), ["orphan-creation-inspection"]);

  // A non-absent creation state keeps its refusal text through the same boundary.
  host.inspectWorkspaceCreation = async () => ({ kind: "still_running", evidence: "git worktree add is live at pid 42" });
  await assert.rejects(policy(host).inspectOrphanWorkspace(task({ repoPath: repo })),
    { message: workspaceCreationRefusal({ kind: "still_running", evidence: "git worktree add is live at pid 42" }) });
});

test("the machine seams are reached through the host, so an adapter override of dataDir, placement or an owned path still fires", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  gitRepo(repo);

  // A replaced seam on the host is the one the policy's own operations use, in the
  // same order the adapter's self-calls used it.
  const reached: string[] = [];
  const admitted: string[] = [];
  const record = (name: string) => { if (!reached.includes(name)) reached.push(name); };
  const owned = join(data, "owned", "ns-lifecycle");
  const host = hostStub({
    dataDir: () => { record("dataDir"); return data; },
    placement: () => { record("placement"); return { dataDir: data, admit: path => admitted.push(path) }; },
    ownedPathFor: async () => { record("ownedPathFor"); return owned; },
  });
  await policy(host).preflightWorkspaceStorage(task({ repoPath: repo, directory: owned }));
  assert.deepEqual(reached, ["placement", "ownedPathFor", "dataDir"],
    "the preflight asks the host for the placement, the owned path and the data home, in that order");
  assert.deepEqual(admitted, [owned], "the replaced placement admits the recorded checkout");

  // The owned-data proof a removal makes is the host's too.
  const seams: string[] = [];
  const orphanHost = hostStub({ ownedDataDirFor: async () => { seams.push("ownedDataDirFor"); return null; } });
  const orphan = { directory: join(root, "leftover"), branch: "ns-lifecycle", head: "", lockReason: "initializing" };
  orphanHost.inspectOrphanWorkspace = async () => orphan;
  await assert.rejects(policy(orphanHost).removeOrphanWorkspace(task({ repoPath: repo }), orphan));
  assert.deepEqual(seams, ["ownedDataDirFor"], "the removal asks the host for the owned data dir, so an override decides it");

  // End to end on the real adapter: the override the archive and proof-only fixtures
  // install is the one the moved policy uses to derive, match and admit the owned path.
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(root, "callback.sock"), join(root, "report.mjs"));
  const overridden = join(root, "override");
  (adapter as unknown as { dataDir: () => string }).dataDir = () => overridden;
  const admissions: string[] = [];
  (adapter as unknown as { placement: () => unknown }).placement = () => ({ dataDir: overridden, admit: (path: string) => admissions.push(path) });
  const derived = ownedWorkspacePath(overridden, await repoCommonDir(repo), "lifecycle");
  assert.notEqual(derived, ownedWorkspacePath(join(root, "unused"), await repoCommonDir(repo), "lifecycle"),
    "the override and the adapter's own data home derive different owned paths");
  (adapter as unknown as { workspaceHostCache: unknown }).workspaceHostCache = {
    workspaceInventory: async () => [{ id: "w-owned", projectRootPath: derived, worktreeSlug: "ns-lifecycle", workspaceDirectory: derived }],
    repositoryProject: async () => ({}),
    createWorkspace: async () => ({ id: "w", directory: derived }),
  };
  assert.deepEqual(await adapter.findWorkspaces(task({ repoPath: repo })), [{ id: "w-owned", directory: derived }],
    "the owned path the overridden data home derives is the one matched");
  assert.deepEqual(admissions, [derived], "the overridden placement admits the matched owned path");
});

test("the adapter's delegates hand back the policy's own promise, so the move adds no microtask turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ns-workspace-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(root, "callback.sock"), join(root, "report.mjs"));
  const sentinels = {
    preflightWorkspaceStorage: Promise.resolve(), inspectWorkspaceCreation: Promise.resolve({ kind: "absent" }),
    populateTaskWorktree: Promise.resolve({ directory: "/d", populated: false, budgetMs: 0, elapsedMs: 0 }),
    createWorkspace: Promise.resolve({ id: "w", directory: "/d" }), inspectOrphanWorkspace: Promise.resolve(null),
    removeOrphanWorkspace: Promise.resolve(), recoverTaskWorkspace: Promise.resolve({ id: "w", directory: "/d" }),
    findWorkspaces: Promise.resolve([]), ownedPathFor: Promise.resolve("/d"), ownedDataDirFor: Promise.resolve(null),
  };
  (adapter as unknown as { workspaceLifecycleCache: unknown }).workspaceLifecycleCache = {
    preflightWorkspaceStorage: () => sentinels.preflightWorkspaceStorage,
    inspectWorkspaceCreation: () => sentinels.inspectWorkspaceCreation,
    populateTaskWorktree: () => sentinels.populateTaskWorktree,
    createWorkspace: () => sentinels.createWorkspace,
    inspectOrphanWorkspace: () => sentinels.inspectOrphanWorkspace,
    removeOrphanWorkspace: () => sentinels.removeOrphanWorkspace,
    recoverTaskWorkspace: () => sentinels.recoverTaskWorkspace,
    findWorkspaces: () => sentinels.findWorkspaces,
    ownedPathFor: () => sentinels.ownedPathFor,
    ownedDataDirFor: () => sentinels.ownedDataDirFor,
    dataDir: () => "/data",
    placement: () => null,
  };

  assert.equal(adapter.preflightWorkspaceStorage(task()), sentinels.preflightWorkspaceStorage);
  assert.equal(adapter.inspectWorkspaceCreation(task()), sentinels.inspectWorkspaceCreation);
  assert.equal(adapter.populateTaskWorktree(task()), sentinels.populateTaskWorktree);
  assert.equal(adapter.createWorkspace(task()), sentinels.createWorkspace);
  assert.equal(adapter.inspectOrphanWorkspace(task()), sentinels.inspectOrphanWorkspace);
  assert.equal(adapter.removeOrphanWorkspace(task(), { directory: null, branch: "b", head: "h", lockReason: "initializing" }), sentinels.removeOrphanWorkspace);
  assert.equal(adapter.recoverTaskWorkspace(task()), sentinels.recoverTaskWorkspace);
  assert.equal(adapter.findWorkspaces(task()), sentinels.findWorkspaces);

  // Rule 9 of the lane contract: a delegate is a plain return method, never an async wrapper.
  for (const name of ["preflightWorkspaceStorage", "inspectWorkspaceCreation", "populateTaskWorktree", "createWorkspace",
    "inspectOrphanWorkspace", "removeOrphanWorkspace", "recoverTaskWorkspace", "findWorkspaces"]) {
    const method = (PaseoAdapter.prototype as unknown as Record<string, { constructor: { name: string } }>)[name]!;
    assert.equal(method.constructor.name, "Function", `${name} must not be an async wrapper`);
  }

  // The retained helpers the later rows still call stay one-line returns over the same policy.
  assert.equal((adapter as unknown as { dataDir(): string }).dataDir(), "/data");
  assert.equal((adapter as unknown as { ownedPathFor(task: Task): Promise<string> }).ownedPathFor(task()), sentinels.ownedPathFor);
  assert.equal((adapter as unknown as { ownedDataDirFor(task: Task, directory: string): Promise<string | null> }).ownedDataDirFor(task(), "/d"), sentinels.ownedDataDirFor);
});

/** A real repository with one bare origin; every helper call is recorded nowhere but runs for real. */
function originFixture(t: { after(fn: () => void): void }, name: string) {
  const root = mkdtempSync(join(tmpdir(), `ns-workspace-lifecycle-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git"), repo = join(root, "repo"), data = join(root, "data");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  mkdirSync(repo, { recursive: true });
  gitRepo(repo);
  const gitAt = (cwd: string) => (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const run = gitAt(repo);
  run("remote", "add", "origin", origin);
  run("push", "-q", "origin", "main");
  return { root, origin, repo, data, run, gitAt, base: run("rev-parse", "HEAD") };
}

test("a lost task workspace is re-created from the branch on origin, never rebound to a dead registration", async (t) => {
  const f = originFixture(t, "branch-target");
  f.run("checkout", "-q", "-b", "ns-lifecycle", "main");
  writeFileSync(join(f.repo, "partial.txt"), "published partial work\n");
  f.run("add", "-A"); f.run("commit", "-q", "-m", "published partial work");
  const published = f.run("rev-parse", "HEAD");
  f.run("push", "-q", "origin", "ns-lifecycle");
  f.run("checkout", "-q", "main");

  const host = hostStub({ testPlacement: { dataDir: f.data, admit: () => {} } });
  const dead = join(f.root, "gone");
  // The volume is gone but its registration is still inventoried.
  host.findWorkspaces = async () => [{ id: "dead-workspace", directory: dead }];
  // The accepted PR head is older than the branch's published head.
  const recovered = await policy(host).recoverTaskWorkspace(
    task({ repoPath: f.repo, branch: "ns-lifecycle", prHead: f.base }), { target: "branch" });
  assert.notEqual(recovered.directory, dead, "a dead registration is not rebound");
  assert.equal(f.gitAt(recovered.directory)("rev-parse", "HEAD"), published, "the branch head wins over the older accepted PR head");
  assert.equal(f.gitAt(recovered.directory)("branch", "--show-current"), "ns-lifecycle");
  assert.equal(f.gitAt(recovered.directory)("status", "--porcelain"), "", "the re-created checkout is clean");
  assert.equal(existsSync(dead), false, "nothing was written into the dead folder");

  // The default target is the accepted PR head, so a task without one cannot recover.
  await assert.rejects(policy(host).recoverTaskWorkspace(task({ repoPath: f.repo, branch: "ns-lifecycle", prHead: null })),
    { message: "Task workspace recovery requires an accepted PR head" });
  // Without the branch on origin and without a PR head there is no source at all.
  await assert.rejects(policy(host).recoverTaskWorkspace(task({ repoPath: f.repo, branch: "ns-absent", prHead: null }), { target: "branch" }),
    { message: "Task workspace recovery requires the branch ns-absent on origin, or an accepted PR head" });
});

test("a surviving local branch that is the newer line is kept, and two diverged lines refuse", async (t) => {
  const f = originFixture(t, "local-branch");
  f.run("checkout", "-q", "-b", "ns-lifecycle", "main");
  writeFileSync(join(f.repo, "one.txt"), "one\n");
  f.run("add", "-A"); f.run("commit", "-q", "-m", "published work");
  f.run("push", "-q", "origin", "ns-lifecycle");
  // An unpushed commit survives in the repository, even though the worktree is gone.
  writeFileSync(join(f.repo, "two.txt"), "two\n");
  f.run("add", "-A"); f.run("commit", "-q", "-m", "unpushed work");
  const localOnly = f.run("rev-parse", "HEAD");
  f.run("checkout", "-q", "main");

  const host = hostStub({ testPlacement: { dataDir: f.data, admit: () => {} } });
  const recovered = await policy(host).recoverTaskWorkspace(task({ repoPath: f.repo, branch: "ns-lifecycle" }), { target: "branch" });
  assert.equal(f.gitAt(recovered.directory)("rev-parse", "HEAD"), localOnly,
    "the surviving local branch is the newer line and is never reset");
  assert.equal(f.gitAt(recovered.directory)("status", "--porcelain"), "");

  // Two lines with no fast-forward between them are refused, not overwritten.
  rmSync(recovered.directory, { recursive: true, force: true });
  f.run("worktree", "prune");
  const sibling = f.run("commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "sibling line");
  f.run("update-ref", "refs/heads/ns-lifecycle", sibling);
  await assert.rejects(policy(host).recoverTaskWorkspace(task({ repoPath: f.repo, branch: "ns-lifecycle" }), { target: "branch" }),
    /no fast-forward between them; inspect before recovering the worktree/);
  assert.equal(f.run("rev-parse", "refs/heads/ns-lifecycle"), sibling, "the refused recovery changed nothing");
});
