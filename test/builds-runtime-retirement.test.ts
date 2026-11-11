import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../core/store/store";
import { RuntimeRetirementService } from "../core/runtime/runtime-retirement";
import { ownedWorkspacePath, repoCommonDir } from "../core/workspaces/workspace-allocation";
import { PaseoAdapter } from "../service/paseo-composition";
import { submissionSchema } from "../shared/contracts";

test("external task archive captures and retires the exact runtime scope after guarded removal", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ns-builds-runtime-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), data = join(root, "data"), builds = join(root, "builds");
  mkdirSync(repo); mkdirSync(data); mkdirSync(builds);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "base");
  const head = git("rev-parse", "HEAD");
  const store = new Store(join(root, "queue.sqlite"));
  t.after(() => store.close());
  const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Runtime fixture", repoPath: repo,
    planningCommit: head, handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", head);
  const directory = ownedWorkspacePath(builds, await repoCommonDir(repo), inserted.id);
  mkdirSync(join(directory, ".."), { recursive: true });
  git("worktree", "add", "-q", "-b", inserted.branch, directory, "main");
  const gitDir = git("-C", directory, "rev-parse", "--absolute-git-dir");
  const token = "a".repeat(32);
  writeFileSync(join(gitDir, "effigy-runtime-scope"), token);
  const task = store.update(inserted.id, { workspaceId: "workspace", directory });
  const calls: { args: string[]; cwd: string }[] = [];
  const runtime = new RuntimeRetirementService(store, async (args, options) => {
    calls.push({ args, cwd: options.cwd });
    return { code: 0, timedOut: false, spawnError: "", output: args[1] === "scope" ? JSON.stringify({ scope: { kind: "worktree", token } }) : "retired" };
  });
  await runtime.capture(task.id, "workspace", directory);
  assert.equal(store.task(task.id).resolution.runtimeRetirements[0]?.directory, directory);
  let catalogued = true;
  const adapter = new PaseoAdapter("ws://127.0.0.1:1", join(data, "cb.sock"), join(data, "report.mjs"), undefined, undefined,
    { dataDir: builds, admit: path => assert.equal(path, directory) });
  (adapter as any).api = { workspaces: { ref: () => ({ directory, refresh: async () => {},
    current: () => catalogued ? { projectRootPath: repo } : undefined,
    archive: async () => { catalogued = false; return { archivedAt: new Date().toISOString() }; } }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
  // The recorded owner discard waives publication only; ownership is still checked.
  const discard = { workspaceId: "workspace", directory, caller: "owner", authority: "operator" as const, note: null, reason: "fixture", at: new Date().toISOString() };
  await adapter.archiveTaskWorkspace(task, "workspace", directory, head, () => true, false, true, new Set(), false, false, undefined, undefined, discard);
  await runtime.archived(task.id, "workspace");
  assert.equal(store.task(task.id).resolution.runtimeRetirements[0]?.state, "retired");
  assert.deepEqual(calls.map(call => call.args), [["container", "scope", "--json"], ["container", "retire", "--scope", token, "--yes"]]);
  assert.equal(calls[0]?.cwd, directory);
  assert.notEqual(calls[1]?.cwd, directory);
});

test("a recorded directory off the checkout volume is absent history: no scope, and build output cleanup is a no-op", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retired-runtime-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "queue.sqlite"));
  t.after(() => store.close());
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Retired", repoPath: root,
    planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40));
  const directory = "/Volumes/retired-volume/queue/workspaces/retired";
  const runtime = new RuntimeRetirementService(store, async () => ({ code: 1, timedOut: false, spawnError: "ENOENT", output: "" }));
  const entry = await runtime.capture(task.id, "workspace", directory);
  assert.equal(entry?.state, "none");
  const { removeBuildOutput } = await import("../core/workspaces/worktree-cleanup");
  assert.deepEqual(await removeBuildOutput(directory), { detail: "directory absent; nothing to clean up", removed: false, safe: true });
});

test("a finished task that names a retired Builds path still reads from the store", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "retired-history-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "queue.sqlite"));
  t.after(() => store.close());
  const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: "Finished history", repoPath: root,
    planningCommit: "a".repeat(40), handoffPath: "handoff.md", originAgentId: "origin" }), "host", "handoff", "a".repeat(40));
  const directory = "/Volumes/retired-volume/queue/workspaces/finished";
  store.update(inserted.id, { phase: "done", workspaceId: "workspace", directory });
  assert.equal(store.task(inserted.id).directory, directory);
  assert.equal(store.tasks().find(task => task.id === inserted.id)?.directory, directory);
});

test('a workspace on the retired drive is never archived: the ordinary ownership proofs refuse it, owner discard included', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'retired-native-')));
  const repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const store = new Store(join(root, 'queue.sqlite'));
  try {
    const inserted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Retired native', repoPath: repo,
      planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    const directory = ownedWorkspacePath('/Volumes/retired-volume/queue', await repoCommonDir(repo), inserted.id);
    const task = store.update(inserted.id, { phase: 'done', workspaceId: 'workspace', directory });
    const records = join(repo, '.git', 'worktrees');
    for (const [name, path] of [['retired', directory], ['other', join(root, 'unmounted-stash')]]) {
      const entry = join(records, name!); mkdirSync(entry, { recursive: true }); writeFileSync(join(entry, 'gitdir'), join(path!, '.git') + '\n');
    }
    let present = true, sends = 0;
    const current = { projectRootPath: repo, workspaceDirectory: directory, workspaceKind: 'directory', project: { checkout: { cwd: directory, isPaseoOwnedWorktree: false, mainRepoRoot: null } } };
    const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(root, 'cb.sock'), join(root, 'report.mjs'));
    (adapter as any).api = { workspaces: { ref: () => ({ directory, refresh: async () => {}, current: () => present ? current : undefined,
      archive: async () => { sends++; present = false; return { archivedAt: new Date().toISOString() }; } }) },
      agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    const discard = { workspaceId: 'workspace', directory, caller: 'owner', authority: 'operator' as const, note: 'volume retired', reason: 'ruling', at: new Date().toISOString() };
    await assert.rejects(adapter.archiveTaskWorkspace(task, 'workspace', directory, '', () => true, false));
    await assert.rejects(adapter.archiveTaskWorkspace(task, 'workspace', directory, '', () => true, false, true, new Set(), false, false, undefined, undefined, discard));
    assert.equal(sends, 0, 'no catalog archive is sent for a workspace the drive no longer holds');
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(records, 'retired')), true, 'the Git record is left as it is');
  } finally { store.close(); }
});
