import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PaseoAdapter } from '../service/paseo-composition';
import { ownedWorkspacePath, repoCommonDir } from '../core/workspaces/workspace-allocation';
import { command, git } from '../core/git/index';
import type { Task } from '../shared/contracts';

test('a completed proof-only workspace archives its clean detached commit from the published base branch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-proof-archive-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), origin = join(root, 'origin.git');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(primary, 'README.md'), 'merged qualification\n');
  await git(primary, 'add', '-A'); await git(primary, 'commit', '-m', 'merged qualification');
  await git(primary, 'remote', 'add', 'origin', origin); await git(primary, 'push', 'origin', 'main');
  const head = await git(primary, 'rev-parse', 'HEAD');
  const directory = ownedWorkspacePath(root, await repoCommonDir(primary), 'task');
  await mkdir(dirname(directory), { recursive: true });
  await git(primary, 'worktree', 'add', '--detach', directory, head);

  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  (adapter as any).dataDir = () => root;
  let catalogued = true;
  (adapter as any).api = {
    workspaces: { ref: () => ({ directory, refresh: async () => {},
      current: () => catalogued ? { projectRootPath: primary } : undefined,
      archive: async () => { catalogued = false; return { archivedAt: new Date().toISOString() }; },
    }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: 'task', repoPath: primary, directory, branch: '', baseBranch: 'main', workspaceId: 'workspace',
    planningCommit: head, planningBase: head, phase: 'done', entrypoint: 'proof', proofOnly: { commit: head },
    proofOnlyResult: { status: 'passed', commit: head, selector: 'effigy check', executionRunId: 'executor-run',
      reviewerRunId: 'reviewer-run', evidence: 'Qualification passed.' }, prUrl: null, prHead: null,
    resolution: { mergedCommit: null, syncedCommit: null, archivedWorkspaceIds: [] } } as unknown as Task;

  assert.deepEqual(await adapter.archiveTaskWorkspace(task, 'workspace', directory, head, () => true, false, true), []);
  assert.equal(existsSync(directory), false, 'the clean detached workspace is removed after publication is proved on main');
  assert.equal(catalogued, false, 'Paseo workspace archive is confirmed');
});

// effigy#666, 2026-11-07: an owner accepted an interrupted proof-only run. It has a report
// acceptance and no result, and its checkout is still detached with no branch.
test('an owner-accepted proof-only workspace archives at its commit, not as a report-only branch', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-proof-accept-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), origin = join(root, 'origin.git');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', primary], root);
  await git(primary, 'config', 'user.name', 'Queue test');
  await git(primary, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(primary, 'README.md'), 'merged qualification\n');
  await git(primary, 'add', '-A'); await git(primary, 'commit', '-m', 'merged qualification');
  await git(primary, 'remote', 'add', 'origin', origin); await git(primary, 'push', 'origin', 'main');
  const head = await git(primary, 'rev-parse', 'HEAD');
  const directory = ownedWorkspacePath(root, await repoCommonDir(primary), 'task');
  await mkdir(dirname(directory), { recursive: true });
  await git(primary, 'worktree', 'add', '--detach', directory, head);
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  (adapter as any).dataDir = () => root;
  let catalogued = true;
  (adapter as any).api = {
    workspaces: { ref: () => ({ directory, refresh: async () => {},
      current: () => catalogued ? { projectRootPath: primary } : undefined,
      archive: async () => { catalogued = false; return { archivedAt: new Date().toISOString() }; },
    }) },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
  };
  const task = { id: 'task', repoPath: primary, directory, branch: '', baseBranch: 'main', workspaceId: 'workspace',
    planningCommit: head, planningBase: head, phase: 'done', entrypoint: 'proof', proofOnly: { commit: head },
    reportAcceptance: { by: 'owner' }, prUrl: null, prHead: null,
    resolution: { mergedCommit: null, syncedCommit: null, archivedWorkspaceIds: [] } } as unknown as Task;
  assert.deepEqual(await adapter.archiveTaskWorkspace(task, 'workspace', directory, head, () => true, false, true), []);
  assert.equal(existsSync(directory), false);
  assert.equal(catalogued, false);
  await assert.rejects(adapter.archiveTaskWorkspace(task, 'workspace', directory, 'b'.repeat(40), () => true, false, true),
    /head other than its immutable qualification commit/, 'the commit guard still holds');
});
