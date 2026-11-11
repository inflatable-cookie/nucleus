import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { RunUsageTracker } from '../core/telemetry/run-usage-tracker';
import { submissionSchema, type Run } from '../shared/contracts';
import type { RunUsageSource } from '../core/telemetry/run-usage';

test('usage subscriptions resolve each run host and leave an unavailable host untouched', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const source = (host: string) => ({ subscribeRunUsage: async (id: string) => { calls.push(`${host}:${id}`); return Object.assign(() => {}, { subscriptionId: 'subscription', ready: Promise.resolve() }); } }) as RunUsageSource;
  const a = source('a'), b = source('b');
  let onlineB = false;
  const tracker = new RunUsageTracker(store, a, undefined, run => run.hostId === 'a' ? a : run.hostId === 'b' && onlineB ? b : undefined);
  try {
    const make = (host: string) => {
      const task = store.insert(submissionSchema.parse({ submissionId: host, title: host, repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), host, 'h', 'a'.repeat(40));
      const run: Run = { id: `run-${host}`, taskId: task.id, role: 'reviewer', generation: 1, head: '', base: '', agentId: 'same', workspaceId: 'ws', profile: null, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false };
      store.putRun(run);
    };
    make('a'); make('b'); tracker.sync(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['a:same']);
    onlineB = true; tracker.sync(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['a:same', 'b:same']);
  } finally { tracker.close(); store.close(); }
});
