import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { submissionSchema } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('native answers use the recorded host and an unknown send cannot repeat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-question-host-'));
  const client = { isConnected: false }, calls: string[] = [];
  const a = { client, hostId: 'a', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs'), connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; }, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
  const b = { pendingQuestions: async () => [{ requestId: 'q', questions: [{ header: 'H', question: 'Q', options: [] }] }], answerNativeQuestion: async () => { calls.push('b'); throw Error('unknown delivery'); } } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => a, timers: false });
  try {
    await runtime.started; await runtime.bootstrap;
    const admission = runtime.hostRegistry.resource('b', () => Object.create(Object.getPrototypeOf(runtime.admission)) as typeof runtime.admission);
    runtime.hostRegistry.connect('b', 'b-endpoint', { adapter: b, admission });
    const task = runtime.store.insert(submissionSchema.parse({ submissionId: 'native-host', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'b', 'h', 'a'.repeat(40));
    runtime.store.update(task.id, { phase: 'working', agentId: 'agent', workspaceId: 'ws', runId: 'run' });
    const input = { taskId: task.id, agentId: 'agent', requestId: 'q', answers: { H: 'yes' } };
    await assert.rejects(runtime.answerNativeQuestion(input), /unknown delivery/);
    await assert.rejects(runtime.answerNativeQuestion(input), /already recorded/);
    assert.deepEqual(calls, ['b']);
  } finally { await runtime.drain(); }
});
