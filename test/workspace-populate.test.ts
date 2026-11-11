import { fakeAdapter, observeIdle } from './support/fakes';
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { Engine } from "../core/engine";
import { submissionSchema, type Profile, type Task } from "../shared/contracts";
import type { Adapter } from "../core/host";
import { PaseoAdapter } from "../service/paseo-composition";
import { GitBulkCommandError, GIT_SLOW_TIMEOUT_MS } from "../core/git/index";
import {
  WORKSPACE_POPULATE_BUDGET_MS, classifyWorkspaceCreation, ownedWorkspacePath, populateOwnedWorktree,
  WorkspaceObservationUnavailableError, sameWorkspacePath, removeOrphanCheckout, repoCommonDir, workspaceDataDirFor,
} from "../core/workspaces/workspace-allocation";
import { worktreeAddTargets } from "../core/machine/process-identity";
import { assertCheckoutAvailable } from "../core/workspaces/checkout-volume";

const profile: Profile = { id: "worker", name: "worker", provider: "test", model: "test", notes: "", available: true, problem: "", supportedThinking: [] };

function gitRepo(root: string) {
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("commit", "-q", "--allow-empty", "-m", "base");
  return run;
}

test("the bulk populate budget is the existing 600s Git ceiling, not Paseo's 120s read timeout", () => {
  assert.equal(WORKSPACE_POPULATE_BUDGET_MS, GIT_SLOW_TIMEOUT_MS);
  assert.equal(WORKSPACE_POPULATE_BUDGET_MS, 600000);
});

test("worktree-add process matching requires the add verb and the target path", () => {
  const path = "/data/workspaces/ab/ns-task";
  assert.equal(worktreeAddTargets("git worktree add -b ns-task /data/workspaces/ab/ns-task abcdef", path), true);
  assert.equal(worktreeAddTargets("git status /data/workspaces/ab/ns-task", path), false);
  assert.equal(worktreeAddTargets("git worktree list", path), false);
});

test("creation reconciliation observes both old and new owned paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-cutover-"));
  const repo = join(root, "repo"), oldData = join(root, "old"), newData = join(root, "new");
  mkdirSync(repo);
  try {
    const run = gitRepo(repo);
    const task = { id: "cutover", repoPath: repo, baseBranch: "main", branch: "ns-cutover" } as Task;
    const common = await repoCommonDir(repo);
    const oldPath = ownedWorkspacePath(oldData, common, task.id);
    const newPath = ownedWorkspacePath(newData, common, task.id);
    const input = { task, ownedPath: newPath, legacyPaths: [oldPath] };
    const unknown = await classifyWorkspaceCreation({ ...input, scan: path => path === oldPath ? { state: "unknown" } : { state: "absent" } });
    assert.equal(unknown.kind, "unknown");
    const running = await classifyWorkspaceCreation({ ...input, scan: path => path === oldPath ? { state: "found", pid: 42 } : { state: "absent" } });
    assert.equal(running.kind, "still_running");
    mkdirSync(join(oldPath, ".."), { recursive: true });
    run("worktree", "add", "-q", "-b", task.branch, oldPath, "main");
    const found = await classifyWorkspaceCreation({ ...input, scan: () => ({ state: "absent" }) });
    assert.deepEqual(found, { kind: "found_done", directory: oldPath });
    mkdirSync(newPath, { recursive: true });
    const conflict = await classifyWorkspaceCreation({ ...input, scan: () => ({ state: "absent" }) });
    assert.equal(conflict.kind, "conflicting");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allocator registers a private mounted placement and refuses before effects when unavailable", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-placement-")));
  const repo = join(root, "repo"), data = join(root, "data"), mount = join(root, "Builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(mount);
  try {
    const run = gitRepo(repo);
    const base = run("rev-parse", "HEAD");
    let available = false, requests = 0, registered = '';
    const admit = (target: string) => assertCheckoutAvailable({ mount, uuid: "fixture", target, observe: () => ({
      MountPoint: mount, VolumeUUID: available ? "fixture" : "wrong", Internal: false, Writable: true, WritableVolume: true,
    }) });
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
      { dataDir: join(mount, "queue"), admit });
    adapter.scanForWorktreeAdd = () => ({ state: "absent" });
    (adapter as any).api = { workspaces: {
      list: async () => ({ entries: registered ? [{ id: "workspace", projectRootPath: registered, workspaceDirectory: registered }] : [], pageInfo: { hasMore: false } }),
      create: async (request: any) => { requests++; registered = request.source.path; return { id: "workspace", directory: registered }; },
    }, projects: { list: async () => ({ projects: [] }) } };
    const task = { id: "place", title: "Placement", repoPath: repo, baseBranch: "main", branch: "ns-place", planningBase: base, planningCommit: base } as Task;
    const expected = ownedWorkspacePath(join(mount, "queue"), await repoCommonDir(repo), task.id);
    await assert.rejects(adapter.populateTaskWorktree(task), /storage unavailable/);
    assert.equal(existsSync(join(mount, "queue")), false);
    assert.equal(run("branch", "--list", task.branch), "");
    assert.equal(requests, 0);
    available = true;
    assert.equal((await adapter.populateTaskWorktree(task)).directory, expected);
    assert.deepEqual(await adapter.createWorkspace(task), { id: "workspace", directory: expected });
    assert.equal(requests, 1);
    assert.equal(run("-C", expected, "branch", "--show-current"), task.branch);
    available = false;
    await assert.rejects(adapter.findWorkspaces(task), /storage unavailable/);
    assert.deepEqual(await adapter.preflightWorkerContinuation({ ...task, workspaceId: "workspace", directory: expected }),
      { available: false, reason: "Queue checkout storage unavailable: mounted volume identity does not match" });
    assert.equal(requests, 1, "a missing volume never triggers another registration");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allocator refuses missing, wrong, read-only and redirected private mounts before all effects", async t => {
  for (const failure of ["missing", "wrong", "read-only", "redirected"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-refusal-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "repo"), data = join(root, "data"), mount = join(root, "Builds");
    mkdirSync(repo); mkdirSync(data);
    if (failure !== "missing") mkdirSync(mount);
    if (failure === "redirected") { mkdirSync(join(mount, "queue")); symlinkSync(data, join(mount, "queue", "workspaces")); }
    const run = gitRepo(repo), head = run("rev-parse", "HEAD");
    let creates = 0;
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
      { dataDir: join(mount, "queue"), admit: target => assertCheckoutAvailable({ mount, uuid: "fixture", target,
        observe: () => ({ MountPoint: mount, VolumeUUID: failure === "wrong" ? "wrong" : "fixture", Internal: false,
          Writable: failure !== "read-only", WritableVolume: true }) }) });
    adapter.scanForWorktreeAdd = () => ({ state: "absent" });
    (adapter as any).api = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }), create: async () => { creates++; } } };
    const task = { id: failure, title: failure, repoPath: repo, baseBranch: "main", branch: `ns-${failure}`, planningBase: head, planningCommit: head } as Task;
    await assert.rejects(adapter.populateTaskWorktree(task), /storage unavailable/);
    await assert.rejects(adapter.createWorkspace(task), /storage unavailable/);
    assert.equal(run("branch", "--list", task.branch), "", failure);
    assert.equal(run("worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).length, 1);
    assert.equal(creates, 0);
    assert.equal(existsSync(ownedWorkspacePath(data, await repoCommonDir(repo), task.id)), false);
  }
});

test("freshly populated workspace registration skips the duplicate inventory and reports step timings", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-timings-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data");
  mkdirSync(repo); mkdirSync(data);
  const run = gitRepo(repo), head = run("rev-parse", "HEAD");
  const origin = join(root, "origin.git");
  run("init", "-q", "--bare", origin);
  run("remote", "add", "origin", origin);
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"));
  let processScans = 0;
  adapter.scanForWorktreeAdd = () => { processScans++; return { state: "absent" }; };
  let inventoryCalls = 0, created = 0;
  (adapter as any).api = {
    workspaces: {
      list: async () => { inventoryCalls++; return { entries: [], pageInfo: { hasMore: false } }; },
      create: async (request: any) => { created++; return { id: "workspace", directory: request.source.path }; },
    },
    projects: { list: async () => ({ projects: [] }) },
  };
  const steps: Array<{ step: string; status: string; elapsedMs?: number }> = [];
  adapter.workspaceCreationProgress = (_taskId, step, status, elapsedMs) => steps.push({ step, status, elapsedMs });
  const task = { id: "timings", title: "Timings", repoPath: repo, baseBranch: "main", branch: "ns-timings", planningBase: head, planningCommit: head } as Task;
  const populated = await adapter.populateTaskWorktree(task);
  assert.equal(populated.populated, true);
  processScans = 0;
  const workspace = await adapter.createWorkspace(task, { freshlyPopulated: populated.populated });
  assert.equal(workspace.directory, populated.directory);
  assert.equal(processScans, 0, "the just-completed populate makes a process-table scan redundant");
  assert.equal(inventoryCalls, 2, "one list reconciles before populate and one checks exact-path aliases before registration");
  assert.equal(created, 1);
  assert.ok(steps.some(step => step.step === "workspace_identity_lookup" && step.status === "skipped"));
  for (const step of ["worktree_inspection", "owned_path_proof", "path_registration_check", "repository_project_lookup", "workspace_creation"]) {
    assert.ok(steps.some(item => item.step === step && item.status === "started"), `${step} has a start timing`);
    const finished = steps.find(item => item.step === step && item.status === "finished");
    assert.ok(finished && finished.elapsedMs! >= 0, `${step} has an elapsed timing`);
  }
  // Project-A #5009: a reconciliation's inspection moved the task's version on every step, so the
  // replay it decided always found the task changed. It stayed in creation for 13 hours.
  const before = steps.length;
  assert.equal((await adapter.inspectWorkspaceCreation(task)).kind, "found_done");
  assert.equal(steps.length, before, "a reconciliation's inspection reports no creation progress");
  assert.equal(processScans, 1, "ordinary inspection retains the live-process proof");
  assert.equal((await adapter.inspectWorkspaceCreation(task, { progress: true })).kind, "found_done");
  processScans = 1;
  for (const step of ["git_worktree_list", "git_rev_parse", "git_rev_list", "git_ls_remote"]) {
    assert.ok(steps.some(item => item.step === `worktree_inspection_${step}` && item.status === "started"), `${step} has a start timing`);
    const finished = steps.find(item => item.step === `worktree_inspection_${step}` && item.status === "finished");
    assert.ok(finished && finished.elapsedMs! >= 0, `${step} has an elapsed timing`);
  }
  await adapter.recoverTaskWorkspace({ ...task, prHead: head });
  assert.equal(processScans, 2, "recovery retains the live-process proof");
});

test("concurrent task populates retain one branch and reconcile the same checkout", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-race-")));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds);
  try {
    const run = gitRepo(repo), head = run("rev-parse", "HEAD");
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
      { dataDir: builds, admit: () => {} });
    adapter.scanForWorktreeAdd = () => ({ state: "absent" });
    (adapter as any).api = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    const task = { id: "race", title: "Race", repoPath: repo, baseBranch: "main", branch: "ns-race", planningBase: head, planningCommit: head } as Task;
    const results = await Promise.allSettled([adapter.populateTaskWorktree(task), adapter.populateTaskWorktree(task)]);
    assert.ok(results.some(result => result.status === "fulfilled"));
    const expected = ownedWorkspacePath(builds, await repoCommonDir(repo), task.id);
    const state = await adapter.inspectWorkspaceCreation(task);
    assert.deepEqual(state, { kind: "found_done", directory: expected });
    assert.equal(run("worktree", "list", "--porcelain").split('\n').filter(line => line === `branch refs/heads/${task.branch}`).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classify distinguishes found-done, absent, still-running, unknown, partial and conflicting", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-classify-"));
  const dir = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(dir);
  try {
    const run = gitRepo(dir);
    const task = { id: "abc", repoPath: dir, baseBranch: "main", branch: "ns-abc" } as Task;
    const ownedPath = ownedWorkspacePath(dataDir, await repoCommonDir(dir), task.id);
    assert.equal((await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "absent" }) })).kind, "absent");

    const running = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "found", pid: 4242 }) });
    assert.equal(running.kind, "still_running");
    if (running.kind === "still_running") assert.match(running.evidence, /pid 4242/);

    const unknown = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "unknown" }) });
    assert.equal(unknown.kind, "unknown");

    mkdirSync(join(ownedPath, ".."), { recursive: true });
    run("worktree", "add", "-q", "-b", "ns-abc", ownedPath, "main");
    const done = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(done.kind, "found_done");
    if (done.kind === "found_done") assert.equal(realpathSync(done.directory), realpathSync(ownedPath));

    writeFileSync(join(ownedPath, "dirty.txt"), "partial");
    const partial = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(partial.kind, "partial");
    if (partial.kind === "partial") assert.equal(realpathSync(partial.orphan.directory!), realpathSync(ownedPath));

    run("worktree", "remove", "--force", ownedPath);
    run("checkout", "-q", "ns-abc");
    run("commit", "-q", "--allow-empty", "-m", "authored");
    run("checkout", "-q", "main");
    const conflict = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(conflict.kind, "conflicting");
    if (conflict.kind === "conflicting") assert.match(conflict.evidence, /commits beyond base/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication proof queries only the push remote, while recovery keeps the check", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-remotes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data"), remoteRoot = join(root, "remotes");
  mkdirSync(repo); mkdirSync(data); mkdirSync(remoteRoot);
  const run = gitRepo(repo), head = run("rev-parse", "HEAD");
  const pushRemotePath = join(remoteRoot, "push.git");
  run("init", "-q", "--bare", pushRemotePath);
  run("remote", "add", "push-task", pushRemotePath);
  run("config", "branch.ns-many.pushRemote", "push-task");
  for (let i = 0; i < 42; i++) run("remote", "add", `extra-${i}`, join(remoteRoot, "unused.git"));
  run("worktree", "add", "-q", "-b", "ns-many", join(data, "workspace"), head);
  run("push", "push-task", "ns-many");
  run("update-ref", "-d", "refs/remotes/push-task/ns-many");

  const bin = join(root, "bin"), log = join(root, "ls-remote.log");
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = ls-remote ]; then remote="$2"; [ "$remote" = --heads ] && remote="$3"; printf '%s\\n' "$remote" >> "$NS_LS_REMOTE_LOG"; fi\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.NS_LS_REMOTE_LOG = log;
  const task = { id: "many", repoPath: repo, baseBranch: "main", branch: "ns-many" } as Task;
  try {
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"));
    adapter.scanForWorktreeAdd = () => ({ state: "absent" });
    await assert.rejects(adapter.inspectOrphanWorkspace(task), /published to push-task/);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["push-task"]);

    rmSync(log);
    const ownedPath = ownedWorkspacePath(data, await repoCommonDir(repo), task.id);
    const fresh = await classifyWorkspaceCreation({ task, ownedPath, skipProcessScan: true, skipRemoteCheck: true });
    assert.deepEqual(fresh, { kind: "found_done", directory: join(data, "workspace") });
    assert.equal(existsSync(log), false, "freshly populated inspection skips the network check");
  } finally {
    process.env.PATH = previousPath;
    delete process.env.NS_LS_REMOTE_LOG;
  }
});

test("an unlocked dirty slug-matched worktree at an arbitrary path is not a removable leftover", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-authored-"));
  const dir = join(root, "repo");
  const dataDir = join(root, "data");
  const paseoWt = join(root, "paseo-wt", "ns-abc");
  mkdirSync(dir);
  try {
    const run = gitRepo(dir);
    const task = { id: "abc", repoPath: dir, baseBranch: "main", branch: "ns-abc" } as Task;
    const ownedPath = ownedWorkspacePath(dataDir, await repoCommonDir(dir), task.id);
    mkdirSync(join(paseoWt, ".."), { recursive: true });
    run("worktree", "add", "-q", "-b", "ns-abc", paseoWt, "main");
    writeFileSync(join(paseoWt, "notes.txt"), "authored");
    const state = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(state.kind, "conflicting");
    if (state.kind === "conflicting") assert.match(state.evidence, /unlocked and dirty/);
    const head = run("rev-parse", "ns-abc");
    const fabricated = { directory: paseoWt, branch: "ns-abc", head, lockReason: "partial" };
    await assert.rejects(() => removeOrphanCheckout(task, fabricated, ownedPath), /not a Queue-owned leftover or a Paseo initializing lock/);
    assert.equal(existsSync(join(paseoWt, "notes.txt")), true);

    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(dataDir, "cb.sock"), join(dataDir, "report.mjs"));
    await assert.rejects(() => adapter.inspectOrphanWorkspace(task), /not a provable orphan.*unlocked and dirty/);
    await assert.rejects(() => adapter.removeOrphanWorkspace(task, fabricated), /not a provable orphan.*unlocked and dirty/);
    assert.equal(existsSync(join(paseoWt, "notes.txt")), true);

    run("worktree", "lock", "--reason", "initializing", paseoWt);
    const locked = await classifyWorkspaceCreation({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(locked.kind, "partial");
    if (locked.kind === "partial") assert.equal(locked.orphan.lockReason, "initializing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Queue gitBulk populate from the selected base then Paseo registers the existing directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-populate-"));
  const dir = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(dir); mkdirSync(dataDir);
  try {
    const run = gitRepo(dir);
    run("branch", "release/v0.5");
    run("commit", "-q", "--allow-empty", "-m", "later-on-main");
    const release = run("rev-parse", "release/v0.5");
    const task = {
      id: "task", title: "Release fix", repoPath: dir, branch: "ns-task", baseBranch: "release/v0.5",
      planningBase: release, planningCommit: release,
    } as Task;
    const ownedPath = ownedWorkspacePath(workspaceDataDirFor(join(dataDir, "report.mjs")), await repoCommonDir(dir), task.id);
    const populated = await populateOwnedWorktree({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(populated.populated, true);
    assert.equal(populated.budgetMs, WORKSPACE_POPULATE_BUDGET_MS);
    assert.ok(populated.elapsedMs < 120000, "a small fixture must not pretend to be a long checkout");
    assert.equal(run("-C", ownedPath, "branch", "--show-current"), "ns-task");
    assert.equal(run("-C", ownedPath, "rev-parse", "HEAD"), release);
    assert.notEqual(run("rev-parse", "main"), release);

    const again = await populateOwnedWorktree({ task, ownedPath, scan: () => ({ state: "absent" }) });
    assert.equal(again.populated, false, "found-done does not add a second worktree");
    assert.equal(realpathSync(again.directory), realpathSync(ownedPath));

    const requests: unknown[] = [];
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(dataDir, "cb.sock"), join(dataDir, "report.mjs"));
    (adapter as any).api = { workspaces: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
      create: async (input: unknown) => { requests.push(input); return { id: "workspace", directory: ownedPath }; },
    } };
    assert.deepEqual(await adapter.createWorkspace(task), { id: "workspace", directory: ownedPath });
    const source = (requests[0] as { source: { kind: string; path: string } }).source;
    assert.equal(source.kind, "directory");
    assert.equal(realpathSync(source.path), realpathSync(ownedPath));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory-kind listing matches the Queue-owned path", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-list-"));
  const dir = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(dir); mkdirSync(dataDir);
  try {
    gitRepo(dir);
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(dataDir, "cb.sock"), join(dataDir, "report.mjs"));
    const owned = ownedWorkspacePath(dataDir, await repoCommonDir(dir), "task");
    (adapter as any).api = { workspaces: { list: async () => ({ entries: [
      { id: "dir-ws", projectRootPath: owned, workspaceDirectory: owned },
      { id: "other", projectRootPath: dir, worktreeSlug: "ns-other", workspaceDirectory: "/other" },
    ], pageInfo: { hasMore: false } }) } };
    assert.deepEqual(await adapter.findWorkspaces({ id: "task", repoPath: dir, workspaceId: null } as Task),
      [{ id: "dir-ws", directory: owned }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory registration at the legacy path remains discoverable after cutover", async () => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-legacy-list-"));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds);
  try {
    gitRepo(repo);
    const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
      { dataDir: builds, admit: () => {} });
    const oldPath = ownedWorkspacePath(data, await repoCommonDir(repo), "task");
    (adapter as any).api = { workspaces: { list: async () => ({ entries: [
      { id: "legacy", projectRootPath: oldPath, workspaceDirectory: oldPath },
    ], pageInfo: { hasMore: false } }) } };
    assert.deepEqual(await adapter.findWorkspaces({ id: "task", repoPath: repo, workspaceId: null } as Task),
      [{ id: "legacy", directory: oldPath }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("archive of a Queue-owned directory leftover uses no-force worktree remove", async t => {
  const root = mkdtempSync(join(tmpdir(), "ns-ws-archive-"));
  const dir = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(dir); mkdirSync(dataDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = gitRepo(dir);
  const head = run("rev-parse", "HEAD");
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(dataDir, "cb.sock"), join(dataDir, "report.mjs"));
  const owned = ownedWorkspacePath(dataDir, await repoCommonDir(dir), "task");
  mkdirSync(join(owned, ".."), { recursive: true });
  run("worktree", "add", "-q", "-b", "ns-task", owned, "main");
  const origin = join(root, "origin.git");
  run("init", "--bare", "-q", origin);
  run("remote", "add", "origin", origin);
  run("push", "-q", "origin", "ns-task");
  let catalogued = true;
  let archives = 0;
  (adapter as any).api = {
    workspaces: { ref: () => ({
      directory: owned,
      refresh: async () => {},
      current: () => catalogued ? { projectRootPath: owned } : undefined,
      archive: async () => { archives++; catalogued = false; return { archivedAt: new Date().toISOString() }; },
    }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: "task", repoPath: dir, branch: "ns-task", workspaceId: "workspace", directory: owned } as Task;
  run("worktree", "lock", owned);
  await assert.rejects(adapter.archiveTaskWorkspace(task, "workspace", owned, head, () => true, false, true), /worktree\.teardown failed/);
  assert.equal(existsSync(owned), true, "non-force removal preserves a locked worktree");
  run("worktree", "unlock", owned);
  await adapter.archiveTaskWorkspace(task, "workspace", owned, head, () => true, true, true);
  assert.equal(archives, 1, "local teardown does not replay the native archive");
  assert.equal(existsSync(owned), false);
  assert.equal(run("worktree", "list", "--porcelain").includes(owned), false);
  assert.equal(run("ls-remote", "origin", "refs/heads/ns-task").split(/\s+/)[0], head);
});

test("archive of an external Queue-owned task proves placement and retires its exact checkout", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-external-archive-")));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds"), stash = join(root, "stash");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds); mkdirSync(stash);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = gitRepo(repo), head = run("rev-parse", "HEAD");
  const directory = ownedWorkspacePath(builds, await repoCommonDir(repo), "task");
  mkdirSync(join(directory, ".."), { recursive: true });
  run("worktree", "add", "-q", "-b", "ns-task", directory, "main");
  const origin = join(root, "origin.git");
  run("init", "--bare", "-q", origin); run("remote", "add", "origin", origin); run("push", "-q", "origin", "ns-task");
  let available = true, catalogued = true, archives = 0;
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
    { dataDir: stash, retainedDataDirs: [builds], admit: path => { assert.equal(path, directory); if (!available) throw Error("storage unavailable"); } });
  (adapter as any).api = {
    workspaces: { ref: () => ({ directory, refresh: async () => {},
      current: () => catalogued ? { projectRootPath: repo } : undefined,
      archive: async () => { archives++; catalogued = false; return { archivedAt: new Date().toISOString() }; } }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: "task", repoPath: repo, branch: "ns-task", workspaceId: "workspace", directory } as Task;
  available = false;
  await assert.rejects(adapter.preflightWorkspaceStorage(task), /storage unavailable/);
  await assert.rejects(adapter.archiveTaskWorkspace(task, "workspace", directory, head, () => true, false, true), /storage unavailable/);
  assert.equal(archives, 0); assert.equal(existsSync(directory), true);
  available = true;
  await adapter.preflightWorkspaceStorage(task);
  assert.deepEqual(await adapter.preflightWorkerContinuation(task), { available: true });
  let uncertain = '', observed = false;
  await assert.rejects(adapter.archiveTaskWorkspace(task, "workspace", directory, head, () => true, false, true, new Set(), false, false, {
    begin: () => { available = false; return 'run'; },
    observed: () => { observed = true; }, uncertain: reason => { uncertain = reason; },
  }), /storage unavailable/);
  assert.equal(observed, false); assert.match(uncertain, /storage unavailable/);
  assert.equal(archives, 0); assert.equal(existsSync(directory), true);
  available = true;
  await adapter.archiveTaskWorkspace(task, "workspace", directory, head, () => true, false, true);
  assert.equal(archives, 1); assert.equal(existsSync(directory), false);
});

test("a legacy registered task retires in place while new tasks allocate externally", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-cutover-lifecycle-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds);
  const run = gitRepo(repo), head = run("rev-parse", "HEAD"), common = await repoCommonDir(repo);
  const directory = ownedWorkspacePath(data, common, "old");
  mkdirSync(join(directory, ".."), { recursive: true });
  run("worktree", "add", "-q", "-b", "ns-old", directory, "main");
  let available = false, catalogued = true, creations = 0;
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
    { dataDir: builds, admit: () => { if (!available) throw Error("storage unavailable"); } });
  adapter.scanForWorktreeAdd = () => ({ state: "absent" });
  (adapter as any).api = { workspaces: {
    list: async () => ({ entries: catalogued ? [{ id: "old-workspace", projectRootPath: directory, workspaceDirectory: directory }] : [], pageInfo: { hasMore: false } }),
    ref: () => ({ directory, refresh: async () => {}, current: () => catalogued ? { projectRootPath: repo } : undefined,
      archive: async () => { catalogued = false; return { archivedAt: new Date().toISOString() }; } }),
    create: async (input: any) => { creations++; return { id: "new-workspace", directory: input.source.path }; },
  }, projects: { list: async () => ({ projects: [] }) }, agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
  const old = { id: "old", title: "Old", repoPath: repo, baseBranch: "main", branch: "ns-old", workspaceId: "old-workspace", directory, resolution: { archiveIntentWorkspaceId: "old-workspace" } } as Task;
  const discard = { workspaceId: "old-workspace", directory, caller: "owner", authority: "operator" as const, note: null, reason: "fixture", at: new Date().toISOString() };
  await adapter.archiveTaskWorkspace(old, old.workspaceId!, directory, head, () => true, false, true, new Set(), false, false, undefined, undefined, discard);
  assert.equal(existsSync(directory), false);
  const fresh = { id: "fresh", title: "Fresh", repoPath: repo, baseBranch: "main", branch: "ns-fresh", planningBase: head, planningCommit: head } as Task;
  await assert.rejects(adapter.populateTaskWorktree(fresh), /storage unavailable/);
  assert.equal(creations, 0);
  available = true;
  const populated = await adapter.populateTaskWorktree(fresh);
  const registered = await adapter.createWorkspace(fresh);
  assert.equal(registered.directory, populated.directory);
  assert.equal(registered.directory, ownedWorkspacePath(builds, common, fresh.id));
  assert.equal(run("-C", registered.directory, "branch", "--show-current"), fresh.branch);
  assert.equal(creations, 1);
});

test("external orphan retirement requires its exact recorded owner and volume", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-orphan-external-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds);
  const run = gitRepo(repo), head = run("rev-parse", "HEAD");
  const common = await repoCommonDir(repo), directory = ownedWorkspacePath(builds, common, "task");
  mkdirSync(join(directory, ".."), { recursive: true });
  run("worktree", "add", "-q", "-b", "ns-task", directory, "main");
  rmSync(join(common, "worktrees", "ns-task"), { recursive: true });
  let available = false, catalogued = true, archives = 0;
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
    { dataDir: builds, admit: () => { if (!available) throw Error("storage unavailable"); } });
  (adapter as any).api = {
    workspaces: { ref: () => ({ directory, refresh: async () => {}, current: () => catalogued ? { projectRootPath: repo } : undefined,
      archive: async () => { archives++; catalogued = false; return { archivedAt: new Date().toISOString() }; } }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: "task", repoPath: repo, branch: "ns-task", workspaceId: "workspace", directory, resolution: { archiveIntentWorkspaceId: "workspace" } } as Task;
  const discard = { workspaceId: "workspace", directory, caller: "owner", authority: "operator" as const, note: null, reason: "fixture", at: new Date().toISOString() };
  await assert.rejects(adapter.archiveTaskWorkspace(task, "workspace", directory, head, () => true, false, true, new Set(), false, false, undefined, undefined, discard), /storage unavailable/);
  assert.equal(archives, 0); assert.equal(existsSync(directory), true);
  available = true;
  await assert.rejects(adapter.archiveTaskWorkspace({ ...task, id: "foreign" }, "workspace", directory, head, () => true, false, true, new Set(), false, false, undefined, undefined, discard));
  assert.equal(archives, 0); assert.equal(existsSync(directory), true);
  await adapter.archiveTaskWorkspace(task, "workspace", directory, head, () => true, false, true, new Set(), false, false, undefined, undefined, discard);
  assert.equal(archives, 1); assert.equal(existsSync(directory), false);
});

test("legacy partial creation and uncertain process prevent new external effects through the adapter", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-legacy-inflight-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds);
  const run = gitRepo(repo), head = run("rev-parse", "HEAD"), common = await repoCommonDir(repo);
  const task = { id: "legacy", title: "Legacy", repoPath: repo, baseBranch: "main", branch: "ns-legacy", planningBase: head, planningCommit: head } as Task;
  const oldPath = ownedWorkspacePath(data, common, task.id), newPath = ownedWorkspacePath(builds, common, task.id);
  let creates = 0;
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
    { dataDir: builds, admit: () => {} });
  (adapter as any).api = { workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }), create: async () => { creates++; throw Error("unexpected"); } } };
  adapter.scanForWorktreeAdd = path => path === oldPath ? { state: "unknown" } : { state: "absent" };
  assert.equal((await adapter.inspectWorkspaceCreation(task)).kind, "unknown");
  await assert.rejects(adapter.populateTaskWorktree(task));
  await assert.rejects(adapter.createWorkspace(task));
  assert.equal(existsSync(newPath), false); assert.equal(creates, 0); assert.equal(run("branch", "--list", task.branch), "");
  mkdirSync(join(oldPath, ".."), { recursive: true });
  run("worktree", "add", "-q", "-b", task.branch, oldPath, "main");
  writeFileSync(join(oldPath, "partial"), "evidence");
  adapter.scanForWorktreeAdd = () => ({ state: "absent" });
  assert.equal((await adapter.inspectWorkspaceCreation(task)).kind, "partial");
  await assert.rejects(adapter.populateTaskWorktree(task));
  assert.equal(existsSync(oldPath), true); assert.equal(existsSync(newPath), false); assert.equal(creates, 0);
});

function engineFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ns-ws-engine-"));
  const store = new Store(join(dir, "queue.sqlite"));
  store.setMeta("paused", false);
  store.setMeta("pool", [{ profileId: profile.id, enabled: true, group: "author", roles: ["worker"], weight: 1, scopes: ["general"] }]);
  const calls = { populate: 0, create: 0, agents: 0 };
  let workspaces: { id: string; directory: string }[] = [];
  let creation: Awaited<ReturnType<NonNullable<Adapter["inspectWorkspaceCreation"]>>> = { kind: "absent" };
  let createOptions: { freshlyPopulated?: boolean } | undefined;
  let adapter: Adapter;
  adapter = fakeAdapter({
    profiles: async () => [profile], validate: async t => t.planningCommit,
    populateTaskWorktree: async () => {
      calls.populate++;
      return { directory: "/worktree", populated: true, budgetMs: WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: 180000 };
    },
    inspectWorkspaceCreation: async () => creation,
    createWorkspace: async (t, options) => { calls.create++; createOptions = options;
      adapter.workspaceCreationProgress?.(t.id, "fixture_registration", "started");
      return { id: `ws-${t.id}`, directory: "/worktree" }; },
    findWorkspaces: async () => workspaces,
    verifyWorkspace: async t => t.branch,
    createAgent: async t => { calls.agents++; return { id: `agent-${t.runId}`, workspaceId: t.workspaceId }; },
    observe: observeIdle("workspace"),
    verifyPr: async () => ({ url: "https://example.invalid/pr/1", head: "a".repeat(40) }),
    removeOrphanWorkspace: async () => { creation = { kind: "absent" }; },
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  const queued = () => {
    const submitted = store.insert(submissionSchema.parse({
      submissionId: randomUUID(), title: "Task", repoPath: "/repo", planningCommit: "b".repeat(40),
      handoffPath: "docs/handoff.md", originAgentId: "origin",
    }), "host", "handoff", "b".repeat(40));
    return store.update(submitted.id, { phase: "queued", planningBase: "b".repeat(40), branch: `ns-${submitted.id}`, reason: "" });
  };
  return {
    store, engine, adapter, calls, dir, queued, createOptions: () => createOptions,
    setWorkspaces: (value: typeof workspaces) => { workspaces = value; },
    setCreation: (value: typeof creation) => { creation = value; },
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("a simulated healthy create beyond 120s finishes under the 600s budget and binds the worker", async () => {
  const f = engineFixture();
  try {
    const task = f.queued();
    await f.engine.wake();
    const stored = f.store.task(task.id);
    assert.equal(f.calls.populate, 1);
    assert.equal(f.calls.create, 1);
    assert.equal(f.createOptions()?.freshlyPopulated, true);
    assert.ok(f.store.eventsAll(task.id).every(event => !event.kind.startsWith("workspace_creation_step_")),
      "no workspace creation-step event is written (task 989); the dispatching reason line carries the progress");
    assert.equal(f.calls.agents, 1);
    assert.equal(stored.workspaceId, `ws-${task.id}`);
    assert.equal(stored.directory, "/worktree");
    assert.equal(stored.phase, "working");
    const started = f.store.eventsAll(task.id).find(event => event.kind === "workspace_populate_started");
    const finished = f.store.eventsAll(task.id).find(event => event.kind === "workspace_populate_finished");
    assert.ok(started);
    assert.equal(JSON.parse(started!.detail).budgetMs, WORKSPACE_POPULATE_BUDGET_MS);
    assert.equal(JSON.parse(finished!.detail).elapsedMs, 180000);
    assert.equal(JSON.parse(finished!.detail).outcome, "ok");
    assert.ok(JSON.parse(finished!.detail).elapsedMs > 120000);
  } finally { await f.close(); }
});

test("durable intent is recorded before populate, and found-done binds once after a lost response", async () => {
  const f = engineFixture();
  try {
    const task = f.queued();
    let intentAtPopulate = false;
    f.adapter.populateTaskWorktree = async () => {
      intentAtPopulate = f.store.task(task.id).workspaceIntent === true && !f.store.task(task.id).workspaceId;
      f.calls.populate++;
      return { directory: "/worktree", populated: false, budgetMs: WORKSPACE_POPULATE_BUDGET_MS, elapsedMs: 12 };
    };
    await f.engine.wake();
    assert.equal(intentAtPopulate, true);
    assert.equal(f.store.task(task.id).workspaceId, `ws-${task.id}`);

    const lost = f.store.update(f.queued().id, {
      phase: "needs_attention", workspaceIntent: true, workspaceId: null, directory: null, reason: "lost",
    });
    f.setCreation({ kind: "found_done", directory: "/worktree" });
    f.setWorkspaces([]);
    const bound = await f.engine.performTaskControl({ taskId: lost.id, version: lost.version, action:"restart",reason:"Replay the pre-dispatch validation" });
    assert.equal(bound.workspaceId, `ws-${lost.id}`);
    assert.equal(bound.directory, "/worktree");
    assert.equal(bound.workspaceIntent, true);
    assert.equal(f.calls.create, 2);
    await f.engine.wake();
    assert.equal(f.calls.create, 2, "dispatch reuses the bound workspace");
  } finally { await f.close(); }
});

test("truly absent retries once; live or unknown populate does not replay", async () => {
  const f = engineFixture();
  try {
    const absent = f.store.update(f.queued().id, { phase: "needs_attention", workspaceIntent: true, reason: "unproven" });
    f.setCreation({ kind: "absent" });
    const replayed = await f.engine.performTaskControl({ taskId: absent.id, version: absent.version, action: "retry_effect", effect: "workspace_creation", reason: "absent" });
    assert.equal(replayed.phase, "queued");
    assert.match(replayed.reason, /provably absent/);

    const live = f.store.update(f.queued().id, { phase: "needs_attention", workspaceIntent: true, reason: "unproven" });
    f.setCreation({ kind: "still_running", evidence: "pid 9 targeting /worktree" });
    await assert.rejects(() => f.engine.performTaskControl({
      taskId: live.id, version: live.version, action: "retry_effect", effect: "workspace_creation", reason: "again", discard: true,
    }), /still running/);
    assert.equal(f.store.task(live.id).workspaceIntent, true);

    const unknown = f.store.update(f.queued().id, { phase: "needs_attention", workspaceIntent: true, reason: "unproven" });
    f.setCreation({ kind: "unknown", evidence: "process listing unreadable" });
    await assert.rejects(() => f.engine.performTaskControl({
      taskId: unknown.id, version: unknown.version, action: "retry_effect", effect: "workspace_creation", reason: "again",
    }), /uncertain/);
  } finally { await f.close(); }
});

test("partial unpublished leftover is preserved until retry_effect discard; authored work refuses", async () => {
  const f = engineFixture();
  try {
    const orphan = { directory: "/worktree", branch: "ns-x", head: "b".repeat(40), lockReason: "partial" };
    const partial = f.store.update(f.queued().id, { phase: "needs_attention", workspaceIntent: true, reason: "unproven" });
    f.setCreation({ kind: "partial", orphan, evidence: "unpublished leftover" });
    await assert.rejects(() => f.engine.performTaskControl({
      taskId: partial.id, version: partial.version, action: "retry_effect", effect: "workspace_creation", reason: "no discard",
    }), /orphan worktree at \/worktree/);
    assert.equal(f.store.task(partial.id).workspaceIntent, true);
    const replayed = await f.engine.performTaskControl({
      taskId: partial.id, version: f.store.task(partial.id).version, action: "retry_effect",
      effect: "workspace_creation", reason: "discard leftover", discard: true,
    });
    assert.equal(replayed.phase, "queued");
    assert.equal(f.store.eventsAll(partial.id).some(event => event.kind === "orphan_workspace_removed"), true);

    const authored = f.store.update(f.queued().id, { phase: "needs_attention", workspaceIntent: true, reason: "unproven" });
    f.setCreation({ kind: "conflicting", evidence: "the branch has commits beyond base" });
    await assert.rejects(() => f.engine.performTaskControl({
      taskId: authored.id, version: authored.version, action: "retry_effect", effect: "workspace_creation", reason: "force", discard: true,
    }), /commits beyond base/);
    assert.equal(f.store.task(authored.id).workspaceIntent, true);
  } finally { await f.close(); }
});

test("a timed-out populate records budget and elapsed, preserves the leftover, and does not mint a second workspace", async () => {
  const f = engineFixture();
  try {
    const task = f.queued();
    f.setCreation({ kind: "partial", orphan: { directory: "/worktree", branch: task.branch, head: "b".repeat(40), lockReason: "partial" }, evidence: "timeout leftover" });
    f.adapter.populateTaskWorktree = async () => {
      f.calls.populate++;
      throw new GitBulkCommandError("git worktree add timed out and was terminated by SIGTERM (budget 600000ms, elapsed 180012ms)", {
        args: ["worktree", "add", "/worktree", "main"], budgetMs: 600000, elapsedMs: 180012,
        timedOut: true, killed: true, exitCode: null, signal: "SIGTERM", stdout: "", stderr: "Updating files: 86%",
      });
    };
    await f.engine.wake();
    assert.equal(f.calls.populate, 1);
    assert.equal(f.calls.create, 0);
    assert.equal(f.calls.agents, 0);
    assert.equal(f.store.task(task.id).workspaceId, null);
    assert.equal(f.store.task(task.id).workspaceIntent, true);
    const finished = f.store.eventsAll(task.id).find(event => event.kind === "workspace_populate_finished");
    assert.equal(JSON.parse(finished!.detail).outcome, "timedOut");
    assert.equal(JSON.parse(finished!.detail).elapsedMs, 180012);
    assert.match(f.store.task(task.id).reason, /timed out|orphan worktree at \/worktree/);
  } finally { await f.close(); }
});


test("new and retained workspace preflights depend only on their own fixture volume", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-ws-volumes-")));
  const repo = join(root, "repo"), data = join(root, "data"), newer = join(root, "stash"), older = join(root, "builds");
  [repo, data, newer, older].forEach(path => mkdirSync(path));
  gitRepo(repo);
  let available = newer;
  const admit = (path: string) => { if (!path.startsWith(`${available}/`)) throw Error("volume unavailable"); };
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
    { dataDir: newer, retainedDataDirs: [older], admit });
  const fresh = { id: "fresh", repoPath: repo } as Task;
  const retained = { id: "old", repoPath: repo, directory: ownedWorkspacePath(older, await repoCommonDir(repo), "old") } as Task;
  await adapter.preflightWorkspaceStorage(fresh);
  await assert.rejects(adapter.preflightWorkspaceStorage(retained), /volume unavailable/);
  available = older;
  await adapter.preflightWorkspaceStorage(retained);
  await assert.rejects(adapter.preflightWorkspaceStorage(fresh), /volume unavailable/);
});

 test('allocation observation failures wait while a foreign path still refuses', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-allocation-read-')));
  const repo = join(root, 'repo'), data = join(root, 'data'), stash = join(root, 'stash');
  [repo, data, stash].forEach(path => mkdirSync(path));
  gitRepo(repo);
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(data, 'cb.sock'), join(data, 'report.mjs'), undefined, undefined,
    { dataDir: stash, admit: () => {} });
  const directory = ownedWorkspacePath(stash, await repoCommonDir(repo), 'task');
  const task = { id: 'task', repoPath: repo, directory } as Task;
  await adapter.preflightWorkspaceStorage(task);
  await assert.rejects(adapter.preflightWorkspaceStorage({ ...task, directory: join(root, 'foreign') }), /not a Queue allocation/);
  await assert.rejects(adapter.preflightWorkspaceStorage({ ...task, repoPath: join(root, 'unreadable') }), WorkspaceObservationUnavailableError);
  const loop = join(root, 'loop');
  symlinkSync(loop, loop);
  assert.throws(() => sameWorkspacePath(loop, directory), WorkspaceObservationUnavailableError);
 });

test('empty Git identity output is unavailable, never the process working directory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-empty-git-')));
  const stub = join(root, 'git');
  writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  chmodSync(stub, 0o755);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = root;
    await assert.rejects(repoCommonDir(root), WorkspaceObservationUnavailableError);
  } finally { process.env.PATH = savedPath; }
});

test('an absent workspace leaf keeps its allocation through a readable root alias', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-allocation-alias-')));
  const repo = join(root, 'repo'), data = join(root, 'data'), stash = join(root, 'stash'), alias = join(root, 'alias');
  [repo, data, stash].forEach(path => mkdirSync(path));
  gitRepo(repo);
  symlinkSync(stash, alias, 'dir');
  const directory = ownedWorkspacePath(alias, await repoCommonDir(repo), 'task');
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(data, 'cb.sock'), join(data, 'report.mjs'), undefined, undefined,
    { dataDir: stash, admit: () => {} });
  assert.equal(existsSync(directory), false);
  await adapter.preflightWorkspaceStorage({ id: 'task', repoPath: repo, directory } as Task);
});

test('common-directory observation failures propagate through creation classification', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-common-read-')));
  const repo = join(root, 'repo'), data = join(root, 'data');
  mkdirSync(repo); mkdirSync(data);
  const run = gitRepo(repo);
  const ownedPath = ownedWorkspacePath(data, await repoCommonDir(repo), 'task');
  run('worktree', 'add', '-q', '-b', 'ns-task', ownedPath, 'main');
  const task = { id: 'task', repoPath: repo, baseBranch: 'main', branch: 'ns-task' } as Task;
  const input = { task, ownedPath, skipProcessScan: true, skipRemoteCheck: true };
  assert.equal((await classifyWorkspaceCreation(input)).kind, 'found_done');
  const gitFile = join(ownedPath, '.git'), original = readFileSync(gitFile, 'utf8');
  try {
    writeFileSync(gitFile, 'gitdir: unreadable-git-directory\n');
    await assert.rejects(classifyWorkspaceCreation(input), WorkspaceObservationUnavailableError);
  } finally { writeFileSync(gitFile, original); }
  const foreign = join(root, 'foreign');
  mkdirSync(foreign); gitRepo(foreign);
  const state = await classifyWorkspaceCreation({ ...input, task: { ...task, id: 'foreign', branch: 'ns-foreign' }, ownedPath: foreign });
  assert.equal(state.kind, 'conflicting');
  if (state.kind === 'conflicting') assert.match(state.evidence, /does not share the task repository/);
});

test('owned data directory proof propagates unreadable repository identity', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-owned-data-read-')));
  const repo = join(root, 'repo'), data = join(root, 'data');
  mkdirSync(repo); mkdirSync(data); gitRepo(repo);
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(data, 'cb.sock'), join(data, 'report.mjs'));
  const directory = ownedWorkspacePath(data, await repoCommonDir(repo), 'task');
  const task = { id: 'task', repoPath: repo, directory } as Task;
  assert.equal(await (adapter as any).ownedDataDirFor(task, directory), data);
  assert.equal(await (adapter as any).ownedDataDirFor(task, join(root, 'foreign')), null);
  await assert.rejects((adapter as any).ownedDataDirFor({ ...task, repoPath: join(root, 'unreadable') }, directory), WorkspaceObservationUnavailableError);
});
