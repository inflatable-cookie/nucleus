import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaseoAdapter } from '../service/paseo-composition';
import type { Task } from '../shared/contracts';

/**
 * Caller-level witnesses for the continuation preflight over the Host registration handle
 * (task 876, review 5815703868). The preflight awaits the handle's refresh in core and
 * ignores its answer, reads the handle's own directory, and compares the record's project
 * root. Each of those is pinned here through the adapter, not the host in isolation.
 */

/** An adapter whose registration handle is the test's: refresh, record and directory set per case. */
function adapterWith(handle: { refresh: () => Promise<unknown>; record: () => unknown; directory: string | null }) {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  (adapter as any).api = { workspaces: { ref: () => ({
    get directory() { return handle.directory; },
    refresh: handle.refresh,
    current: handle.record,
  }) } };
  return adapter;
}

test('the continuation preflight ignores the refresh answer and proceeds on a retained record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nsq-preflight-witness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'worker');
  await mkdir(directory);
  const task = { id: 'task', repoPath: '/repo', workspaceId: 'workspace', directory } as Task;
  const adapter = adapterWith({ refresh: async () => null, record: () => ({ projectRootPath: '/repo', workspaceDirectory: directory }), directory });
  assert.deepEqual(await adapter.preflightWorkerContinuation(task), { available: true },
    'a falsy refresh answer does not refuse: the retained record and folder decide, as before');
});

test('the continuation preflight compares the handle\'s folder and the record\'s project root, not the record\'s folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nsq-preflight-witness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'worker');
  const other = join(root, 'other');
  await mkdir(directory);
  await mkdir(other);
  const task = { id: 'task', repoPath: '/repo', workspaceId: 'workspace', directory } as Task;
  const record = () => ({ projectRootPath: '/repo', workspaceDirectory: other });

  // The record names another folder, but the handle's folder is the task's: the handle decides.
  assert.deepEqual(await adapterWith({ refresh: async () => ({}), record, directory }).preflightWorkerContinuation(task), { available: true });

  // The handle's folder moved: refused on identity, whatever the record says.
  const moved = await adapterWith({ refresh: async () => ({}), record: () => ({ projectRootPath: '/repo', workspaceDirectory: directory }), directory: other }).preflightWorkerContinuation(task);
  assert.equal(moved.available, false);
  if (!moved.available) assert.match(moved.reason, /changed identity before continuation dispatch/);

  // A project root that is neither the repository nor the task folder is refused, read from the record.
  const elsewhere = await adapterWith({ refresh: async () => ({}), record: () => ({ projectRootPath: '/elsewhere', workspaceDirectory: directory }), directory }).preflightWorkerContinuation(task);
  assert.equal(elsewhere.available, false);
  if (!elsewhere.available) assert.match(elsewhere.reason, /changed identity before continuation dispatch/);
});

test('the continuation preflight reads the record only after its refresh has resolved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nsq-preflight-witness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'worker');
  await mkdir(directory);
  const task = { id: 'task', repoPath: '/repo', workspaceId: 'workspace', directory } as Task;
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = adapterWith({
    refresh: async () => { log.push('refresh'); await gate; log.push('refresh-done'); return {}; },
    record: () => { log.push('current'); return { projectRootPath: '/repo', workspaceDirectory: directory }; },
    directory,
  });

  const pending = adapter.preflightWorkerContinuation(task);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(log, ['refresh'], 'the record is not read while the refresh is pending');
  release();
  assert.deepEqual(await pending, { available: true });
  assert.deepEqual(log, ['refresh', 'refresh-done', 'current'], 'the refresh resolves before the record is read, as before');
});
