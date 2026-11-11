import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { git, command } from '../core/git/index';
import { archiveUnusedWorkspace } from '../core/workspaces/unused-workspace';
import { submissionSchema, taskControlInputSchema } from '../shared/contracts';
import type { Adapter } from '../core/host';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'ns-unused-'));
  const store = new Store(join(root, 'queue.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const repo = join(root, 'repo'), old = join(root, 'old');
  await command('git', ['init', '--initial-branch=main', repo], root);
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test');
  await writeFile(join(repo, 'handoff.md'), 'plan');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'plan');
  const base = await git(repo, 'rev-parse', 'HEAD');
  let task = store.insert(submissionSchema.parse({ submissionId: 'unused', title: 'Unused', repoPath: repo,
    planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'plan', base);
  await git(repo, 'worktree', 'add', '-b', task.branch, old, base);
  await writeFile(join(repo, 'later'), 'later'); await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'advance');
  task = store.update(task.id, { phase: 'needs_attention', workspaceId: 'retained', directory: join(root, 'retained'),
    workspaceIntent: true, planningBase: await git(repo, 'rev-parse', 'HEAD') });
  let visible = true, calls = 0, unknown = false;
  const adapter = {
    findWorkspaces: async () => visible ? [{ id: 'old', directory: old }] : [],
    archiveTaskWorkspace: async (_task: unknown, _id: string, _dir: string, _head: string, allowed: () => boolean, uncertain: boolean) => {
      if (!visible) return true;
      assert.ok(store.getMeta(`unusedWorkspaceArchive:${task.id}:old`), 'intent precedes archive');
      if (uncertain) throw Error('Workspace archive outcome is uncertain; inspect before retrying');
      assert.equal(allowed(), true); calls++;
      if (unknown) throw Error('Transport disconnected');
      visible = false; return true;
    },
  } as unknown as Adapter;
  const run = () => archiveUnusedWorkspace(store, adapter, { taskId: task.id, version: store.task(task.id).version,
    unusedWorkspaceId: 'old' }, () => true);
  return { store, task, repo, old, adapter, run, calls: () => calls, unknown: () => { unknown = true; }, absent: () => { visible = false; } };
}

test('unused duplicate behind the planning base archives without changing the retained identity or phase', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(f.calls(), 1);
  assert.equal(result.workspaceId, 'retained');
  assert.equal(result.phase, 'needs_attention');
  assert.equal(result.planningBase, f.task.planningBase);
  await f.run(); assert.equal(f.calls(), 1, 'confirmed archive is idempotent');
});

test('unused archive refuses dirty, unique, shared, current, and unknown workspace identities', async t => {
  const f = await fixture(t);
  await writeFile(join(f.old, 'untracked'), 'work');
  await assert.rejects(f.run, /dirty/);
  await git(f.old, 'add', '.'); await git(f.old, 'commit', '-m', 'unique work');
  await assert.rejects(f.run, /beyond the planning base/);
  const control = { taskId: f.task.id, version: f.store.task(f.task.id).version };
  await assert.rejects(() => archiveUnusedWorkspace(f.store, f.adapter, { ...control, unusedWorkspaceId: 'retained' }, () => true), /must be retained/);
  await assert.rejects(() => archiveUnusedWorkspace(f.store, f.adapter, { ...control, unusedWorkspaceId: 'unknown' }, () => true), /identity is absent/);
  const other = f.store.insert(submissionSchema.parse({ submissionId: 'other', title: 'Other', repoPath: f.repo,
    planningCommit: f.task.planningBase, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'plan', f.task.planningBase);
  f.store.update(other.id, { workspaceId: 'old' });
  await assert.rejects(f.run, /another task/);
  assert.equal(f.calls(), 0);
});

test('unknown archive is fenced until exact absence is reconciled; it never repeats the effect', async t => {
  const f = await fixture(t); f.unknown();
  await assert.rejects(f.run, /Transport disconnected/);
  await assert.rejects(f.run, /outcome is uncertain/);
  assert.equal(f.calls(), 1);
  f.absent(); await f.run();
  assert.equal(f.calls(), 1);
  assert.equal(f.store.task(f.task.id).workspaceId, 'retained');
});


test('unused workspace archive keeps refusing idle foreign threads', async t => {
  const f = await fixture(t);
  const flags: unknown[] = [];
  const original = f.adapter.archiveTaskWorkspace!;
  f.adapter.archiveTaskWorkspace = async (...args: Parameters<NonNullable<Adapter['archiveTaskWorkspace']>>) => {
    flags.push(args[9]);
    return original(...args);
  };
  await f.run();
  assert.equal(flags.length, 1);
  assert.equal(flags[0], undefined);
});
