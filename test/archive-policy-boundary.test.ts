import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PaseoAdapter } from '../service/paseo-composition';
import type { Task } from '../shared/contracts';
import type { ExternalWorkspaceArchiveInput } from '../core/host/adapter';

function adapterWith(host: object) {
  const adapter = Object.create(PaseoAdapter.prototype) as PaseoAdapter;
  Object.defineProperty(adapter, 'workspaceHost', { value: host });
  return adapter;
}

test('owned archive reads the current workspace and late-bound path override in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-boundary-'));
  const calls: string[] = [];
  const adapter = adapterWith({ workspaceRef: () => ({ directory: root, refresh: async () => { calls.push('refresh'); }, current: () => { calls.push('current'); return { projectRootPath: root }; } }) });
  adapter.ownedDataDirFor = async () => { calls.push('owned override'); throw Error('override'); };
  const task = { id: 'task', phase: 'working', repoPath: root, workspaceId: 'ws', directory: root, resolution: {} } as Task;
  await assert.rejects(adapter.archiveTaskWorkspace(task, 'ws', root, '', () => true, false), /override/);
  assert.deepEqual(calls, ['refresh', 'current', 'owned override']);
});

test('external archive honours overrides and leaves a failed native call uncertain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-boundary-'));
  const calls: string[] = [];
  const current = { workspaceDirectory: root, workspaceKind: 'directory', project: { checkout: { cwd: root, isPaseoOwnedWorktree: false, mainRepoRoot: null } } };
  const adapter = adapterWith({
    workspaceRef: () => ({ refresh: async () => { calls.push('refresh'); }, current: () => current, archive: async () => { calls.push('archive'); throw Error('lost'); } }),
    workspaceThreads: async () => { calls.push('threads'); return { ok: true, threads: [] }; },
    workspaceTerminals: async () => { calls.push('terminals'); return { ok: true, terminals: [] }; },
  });
  adapter.preservedGitIdentity = async () => { calls.push('identity override'); return null; };
  const input = { workspaceId: 'ws', directory: root, samePathWorkspaceIds: [], ownedAgentIds: new Set(), requestId: 'request', allowed: () => { calls.push('allowed'); return true; } } as unknown as ExternalWorkspaceArchiveInput;
  const result = await adapter.archiveExternalWorkspace(input);
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(calls, ['refresh', 'threads', 'terminals', 'identity override', 'allowed', 'archive']);
});
