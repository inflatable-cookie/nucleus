import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';
import { exactProofFixture } from './support/review-entry-fixture';

test('review entry binds the selected worker host and separately proves the origin host', async () => {
  const f = exactProofFixture(), store = new Store(join(f.root, 'queue.sqlite'));
  const a = { originAgent: async (id: string) => ({ id, workspaceId: 'origin-workspace', title: 'Origin', archived: false }),
    observe: observeIdle('origin-workspace') } as unknown as Adapter;
  let inspected = 0;
  const b = { ...f.adapter, hostId: 'b', inspectReviewEntry: async (...args: Parameters<typeof f.adapter.inspectReviewEntry>) => { inspected++; return f.adapter.inspectReviewEntry(...args); } } as unknown as Adapter;
  const engine = new Engine(store, a, 0);
  engine.selectIngressHost = host => host;
  engine.resolveHostAdapter = host => host === 'a' ? a : host === 'b' ? b : undefined;
  engine.hostAvailable = () => true;
  engine.identifyOriginHost = async () => 'a';
  try {
    const accepted = await engine.startOperation({ key: 'cross-host-review', kind: 'review_entry', payload: { type: 'review_entry', input: f.reviewInput }, hostId: 'b' });
    assert.ok('accepted' in accepted); if (!('accepted' in accepted)) return;
    const settled = await engine.awaitOperation(accepted.operation.id, 10000);
    assert.equal(settled.state, 'succeeded', settled.diagnostic);
    const task = store.task(settled.taskId!);
    assert.equal(task.hostId, 'b'); assert.equal(task.originHostId, 'a'); assert.ok(inspected > 0);
  } finally { await engine.stop(); store.close(); }
});


test('review-entry workspace preparation selects the service host and preserves the native request identity', async () => {
  const { QueueRuntime } = await import('../service/runtime-owner');
  const { createHash } = await import('node:crypto');
  const input = { hostId: 'b', leadId: 'lead', leadVersion: 3, prNumber: 802, title: 'Lead title', repoPath: '/repository' };
  const calls: unknown[] = [];
  const adapters = {
    a: { createReviewEntryWorkspace: () => { throw Error('wrong host'); } },
    b: { createReviewEntryWorkspace: (spec: unknown) => { calls.push(spec); return Promise.resolve({ id: 'intake-workspace' }); } },
  };
  let active = 'a';
  const owner = { started: Promise.resolve(), anyHostConnected: () => true,
    engine: {
      selectIngressHost: (host: string) => host,
      hostAvailable: (host: string) => host === 'b',
      withHost: (host: string, operation: () => unknown) => { const previous = active; active = host; try { return operation(); } finally { active = previous; } },
      get adapter() { return adapters[active as keyof typeof adapters]; },
    },
  };
  const prepare = (value: typeof input) => QueueRuntime.prototype.reviewEntryWorkspace.call(owner as unknown as InstanceType<typeof QueueRuntime>, value);
  assert.deepEqual(await prepare(input), { workspaceId: 'intake-workspace' });
  assert.deepEqual(calls, [{ requestId: `nucleus-review-entry-${createHash('sha256').update('lead\n802\n3').digest('hex').slice(0,32)}`,
    title: 'Review PR #802: Lead title', repoPath: '/repository', prNumber: 802 }]);
  await assert.rejects(prepare({ ...input, hostId: 'missing' }), /Selected review-entry host is unavailable/);
  assert.equal(calls.length, 1);
});
