import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaseoAdapter } from '../service/paseo-composition';
import { ProvenPreSendRefusalError } from '../core/recovery/task-reasons';
import type { Profile, Run, Task } from '../shared/contracts';

/**
 * Order witness for the creation move (`server/agent-creation.ts`). A run's
 * prompt and environment are built only after its create guard passes, as they
 * were when the guard sat inside the native create. The run's scratch placement
 * is the first adapter read inside the build, so a spy on it observes exactly
 * when the build starts.
 */
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'agent-creation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = { id: 'task-1', title: 'Task', branch: 'branch', baseBranch: 'main', workspaceId: 'workspace', directory: root,
    reviewEntry: undefined } as unknown as Task;
  const run = { id: 'run-1', role: 'reviewer', workspaceId: 'workspace', head: 'a'.repeat(40), generation: 0,
    profile: { provider: 'provider', model: 'model' } as unknown as Profile } as unknown as Run;
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', join(root, 'queue.sock'), join(root, 'helper.mjs'));
  const creates: unknown[] = [];
  Object.defineProperty(adapter, 'api', { value: { workspaces: { ref: () => ({ agents: { create: async (input: unknown) => {
    creates.push(input); return { id: 'agent-1', workspaceId: 'workspace' }; } } }) } } });
  let buildReads = 0;
  adapter.scratchNamespaceFor = () => { buildReads++; throw new Error('scratch read'); };
  return { task, run, adapter, creates, buildReads: () => buildReads };
}

test('a refused create guard stops before the run prompt and environment are built', async t => {
  const f = fixture(t);
  await assert.rejects(f.adapter.createRun(f.task, f.run, 'token', null, null,
    { allowed: async () => false, stillAllowed: () => true }), ProvenPreSendRefusalError);
  assert.equal(f.buildReads(), 0, 'no prompt is built behind a refused guard');
  assert.equal(f.creates.length, 0, 'no agent is created behind a refused guard');
});

test('an allowed create guard reaches the run build before any create', async t => {
  const f = fixture(t);
  await assert.rejects(f.adapter.createRun(f.task, f.run, 'token', null, null,
    { allowed: async () => true, stillAllowed: () => true }), /scratch read/);
  assert.equal(f.buildReads(), 1, 'the build starts once the guard has passed');
  assert.equal(f.creates.length, 0, 'the failed build never reaches the native create');
});
