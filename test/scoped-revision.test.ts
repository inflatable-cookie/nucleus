import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskControl, submissionSchema } from '../shared/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { callCatalogueMethod } from '../service/transport/dispatch';
import type { Adapter } from '../core/host';

test('the versioned revise control accepts one non-empty scoped instruction', () => {
  const parsed = taskControl.input.parse({ taskId: 'task', version: 3, action:'move',to:'work',reason:'Return to the retained author', instruction: 'Apply the accepted replacement plan' });
  assert.equal(parsed.version, 3);
  assert.equal(parsed.instruction, 'Apply the accepted replacement plan');
});





test('revise rejects empty, whitespace-only and oversized instructions while instruction-free revise stays valid', () => {
  const base = { taskId: 'task', version: 3, action:'move' as const,to:'work',reason:'Return to the retained author' };
  assert.throws(() => taskControl.input.parse({ ...base, instruction: '' }));
  assert.throws(() => taskControl.input.parse({ ...base, instruction: '   ' }));
  assert.throws(() => taskControl.input.parse({ ...base, instruction: 'x'.repeat(12001) }));
  assert.equal(taskControl.input.parse(base).instruction, undefined);
});

test('the control requires task identity and accepts an omitted version', () => {
  assert.throws(() => taskControl.input.parse({ version: 3, action:'move',to:'work',reason:'Return to the retained author', instruction: 'x' }), /taskId|Invalid|required/i);
  assert.equal(taskControl.input.parse({ taskId: 'task', action:'move',to:'work',reason:'Return to the retained author', instruction: 'x' }).version, undefined);
});

test('instruction stays invalid for controls that do not carry scoped worker authority', () => {
  // A restart may carry a retained-worker remap's continuation (2026-09-28); the engine refuses it elsewhere.
  assert.equal(taskControl.input.parse({ taskId: 'task', version: 3, action: 'restart', reason: 'Remap', instruction: 'report only' }).instruction, 'report only');
  assert.throws(() => taskControl.input.parse({ taskId: 'task', version: 3, action: 'hold', instruction: 'no' }), /Instruction is only valid for a restart or a move to work/);
  // Round 4: a replacement profile is chosen with route role=worker; the retired retry field carries nothing.
  assert.equal((taskControl.input.parse({ taskId: 'task', version: 3, action: 'restart', reason: 'Remap', profile: { profileId: 'backup', reason: 'Use the eligible backup' } }) as Record<string, unknown>).profile, undefined);
});


test('omitted versions use the current task version and durable controls retain it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scoped-revision-'));
  const adapter = { client: { isConnected: true }, hostId: 'fixture-host',
    socketPath: join(root, 'callback.sock'), helperPath: join(root, 'helper.mjs'),
    connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }),
    observe: async () => ({ id: 'worker', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
    archiveAgent: async () => {},
  } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: root, adapterFactory: () => adapter, timers: false });
  try {
    runtime.store.setMeta('paused', true);
    await runtime.ensureBootstrap();
    const task = runtime.store.insert(submissionSchema.parse({ submissionId: 'scoped-revision', title: 'Scoped revision',
      repoPath: '/fixture/project', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin'
    }), 'fixture-host', 'Handoff', 'a'.repeat(40));
    runtime.store.update(task.id, { title: 'Updated since the read' });
    const applied = await callCatalogueMethod(runtime, 'queue.task', { taskId: task.id, action: 'hold', reason: 'Wait' }) as { held: boolean };
    assert.equal(applied.held, true);
    await assert.rejects(callCatalogueMethod(runtime, 'queue.task', { taskId: task.id, version: task.version, action: 'release' }), /Task changed/);
    const durableVersion = runtime.store.task(task.id).version;
    await assert.rejects(callCatalogueMethod(runtime, 'queue.task', { taskId: task.id, action: 'route', role: 'worker', profileId: 'missing-profile', reason: 'Next route', now: true }));
    const operations = runtime.store.operations({ taskId: task.id }).filter(operation => operation.kind === 'task_control');
    assert.equal(operations.length, 1);
    assert.equal(operations[0].expectedVersion, durableVersion);
    const payload = runtime.store.operationPayload(operations[0].id) as { control: { version: number } };
    assert.equal(payload.control.version, durableVersion);
  } finally { await runtime.engine.quiesce(); await runtime.drain(); }
});
