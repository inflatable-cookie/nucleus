import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originHostReviewAdapter, originReviewProof, withOriginReviewAdapter } from '../core/review/origin-review-adapter';
import type { Adapter } from '../core/host/adapter';
import type { ReviewEntryAdapter } from '../core/review/review-entry';
import type { ReviewEntryInput } from '../shared/contracts';

const input = { submission: { originAgentId: 'origin' } } as ReviewEntryInput;

test('origin review proof is read on the named host and refuses an archived origin', async () => {
  const hosts: string[] = [];
  const host = {
    originAgent: async (id: string) => ({ id, workspaceId: 'ws', title: 'Origin', archived: false }),
    observe: async (id: string) => ({ id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
  };
  const proof = await originReviewProof(host, (id, fn) => { hosts.push(id); return fn(); }, 'origin-host', 'origin');
  assert.deepEqual(hosts, ['origin-host']);
  assert.equal(proof.origin.workspaceId, 'ws');
  assert.equal(proof.state.workspaceId, 'ws');
  await assert.rejects(originReviewProof(
    { originAgent: async () => ({ id: 'origin', workspaceId: 'ws', title: 'Origin', archived: true }), observe: async () => { throw Error('should not observe'); } },
    (_id, fn) => fn(), 'origin-host', 'origin',
  ), /live originating thread/);
});

test('withOriginReviewAdapter supplies the proof to inspect and forwards every other property', async () => {
  const seen: unknown[] = [];
  const adapter = {
    hostId: 'worker',
    inspectReviewEntry: async (_input: ReviewEntryInput, taskId?: string, proof?: unknown) => { seen.push({ taskId, proof }); return { directory: '/d', originWorkspaceId: 'ws', busyReason: '' }; },
    originAgent: async () => null,
  } as unknown as Adapter & ReviewEntryAdapter;
  const wrapped = withOriginReviewAdapter(adapter, (reviewInput, taskId) => adapter.inspectReviewEntry(reviewInput, taskId, { origin: 'proof' } as never));
  await wrapped.inspectReviewEntry(input, 'task-1');
  assert.deepEqual(seen, [{ taskId: 'task-1', proof: { origin: 'proof' } }]);
  assert.equal(wrapped.hostId, 'worker');
});

test('originHostReviewAdapter fetches the origin on that host at inspect time', async () => {
  const hosts: string[] = [];
  const adapter = {
    hostId: 'worker',
    inspectReviewEntry: async (_input: ReviewEntryInput, _taskId?: string, proof?: { origin: { id: string } }) => ({ directory: '/d', originWorkspaceId: proof?.origin.id ?? '', busyReason: '' }),
    originAgent: async () => null,
  } as unknown as Adapter & ReviewEntryAdapter;
  const review = originHostReviewAdapter({
    host: {
      originAgent: async (id: string) => ({ id, workspaceId: 'ws', title: 'Origin', archived: false }),
      observe: async (id: string) => ({ id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
    },
    withHost: (id, fn) => { hosts.push(id); return fn(); },
  }, adapter, 'origin-host', input);
  const inspected = await review.inspectReviewEntry(input, 'task-1');
  assert.deepEqual(hosts, ['origin-host']);
  assert.equal(inspected.originWorkspaceId, 'origin');
});
