import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PaseoAdapter } from '../service/paseo-composition';
import type { ExternalWorkspaceArchiveInput } from '../core/host/adapter';

test('catalog and worktree archive read their observations and policy overrides in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-overrides-'));
  const calls: string[] = [];
  const current = { id: 'ws', workspaceDirectory: root, workspaceKind: 'worktree', project: { checkout: { cwd: root } } };
  const adapter = Object.create(PaseoAdapter.prototype) as PaseoAdapter;
  Object.defineProperty(adapter, 'workspaceHost', { value: {
    workspaceInventory: async () => { calls.push('inventory'); return [current]; },
    workspaceRef: () => ({ refresh: async () => { calls.push('refresh'); }, current: () => current, archive: async () => { calls.push('archive'); return { archivedAt: 'now' }; } }),
    workspaceThreads: async () => { calls.push('threads'); return { ok: true, threads: [] }; },
    workspaceTerminals: async () => { calls.push('terminals'); return { ok: true, terminals: [] }; },
  } });
  assert.equal((await adapter.externalWorkspaceCatalog(root)).ok, true);
  adapter.proveExternalWorktreeSource = async () => { calls.push('source override'); return { source: { commonDir: 'common', branch: 'branch', head: 'head', directory: root, remote: '', publication: '', ignored: [] } }; };
  adapter.preservedGitIdentity = async () => { calls.push('identity override'); return 'common\0branch\0head'; };
  adapter.catalogEntryPresent = async () => { calls.push('catalog override'); return false; };
  const input = { workspaceId: 'ws', directory: root, samePathWorkspaceIds: [], ownedAgentIds: new Set(), requestId: 'request', expected: {}, allowed: () => { calls.push('allowed'); return true; } } as unknown as ExternalWorkspaceArchiveInput;
  assert.equal((await adapter.archiveExternalWorkspace(input)).status, 'archived');
  assert.deepEqual(calls, ['inventory', 'refresh', 'threads', 'terminals', 'source override', 'identity override', 'allowed', 'archive', 'catalog override', 'identity override']);
});
