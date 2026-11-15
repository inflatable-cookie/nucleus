import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeHostAdapter, type HostAdapterRoutingOwner } from '../core/host/adapter-routing';
import { formatAgentId } from '../shared/agent-identity';
import type { Adapter } from '../core/host/adapter';
import type { ReviewEntryInput } from '../shared/contracts';

function makeOwner(adapters: Record<string, Adapter>, active?: string): HostAdapterRoutingOwner & { store: { task: HostAdapterRoutingOwner['store']['task'] } } {
  const state = { activeHostId: active };
  return {
    get activeHostId() { return state.activeHostId; },
    resolveHostAdapter: (id: string) => adapters[id],
    store: { task: (id: string) => ({ id, hostId: 'worker-host', originHostId: id === 'cross' ? 'origin-host' : 'worker-host' }) },
    withHost: <T>(id: string, fn: () => T) => { const previous = state.activeHostId; state.activeHostId = id; try { return fn(); } finally { state.activeHostId = previous; } },
    hostAvailable: (id: string) => Boolean(adapters[id]),
    host: {
      originAgent: async (id: string) => ({ id, workspaceId: 'ws', title: 'Origin', archived: false }),
      observe: async (id: string) => ({ id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
    },
    hostOnline: (id: string) => Boolean(adapters[id]),
  };
}

test('direct adapter observe unwraps a qualified id for the ambient host', async () => {
  const seen: string[] = [];
  const primary = { hostId: 'primary', observe: async (id: string) => { seen.push(id); return { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' }; } } as unknown as Adapter;
  const adapter = routeHostAdapter(makeOwner({ primary }, 'primary'), primary);
  await adapter.observe(formatAgentId('primary', 'native-1'));
  assert.deepEqual(seen, ['native-1']);
});

test('a call that names an agent on another registered host re-enters that host', async () => {
  const seen: string[] = [];
  const primary = { hostId: 'primary', observe: async () => { throw Error('wrong host'); } } as unknown as Adapter;
  const secondary = { hostId: 'secondary', observe: async (id: string) => { seen.push(id); return { id, workspaceId: null, status: 'idle', active: false, permissions: false, error: '' }; } } as unknown as Adapter;
  const adapter = routeHostAdapter(makeOwner({ primary, secondary }, 'primary'), primary);
  await adapter.observe(formatAgentId('secondary', 'native-2'));
  assert.deepEqual(seen, ['native-2']);
});

test('inspectReviewEntry without a proof fetches origin evidence on the task origin host', async () => {
  const proofs: unknown[] = [];
  const worker = {
    hostId: 'worker-host',
    inspectReviewEntry: async (_input: ReviewEntryInput, _taskId?: string, proof?: unknown) => { proofs.push(proof); return { directory: '/d', originWorkspaceId: 'ws', busyReason: '' }; },
  } as unknown as Adapter;
  const origin = { hostId: 'origin-host' } as unknown as Adapter;
  const adapter = routeHostAdapter(makeOwner({ 'worker-host': worker, 'origin-host': origin }, 'worker-host'), worker);
  await (adapter.inspectReviewEntry as NonNullable<Adapter['inspectReviewEntry']>)(
    { submission: { originAgentId: 'origin' } } as ReviewEntryInput, 'cross');
  assert.equal((proofs[0] as { origin: { id: string } }).origin.id, 'origin');
});

test('inspectReviewEntry refuses an unknown origin host by name', async () => {
  const worker = { hostId: 'worker-host', inspectReviewEntry: async () => ({ directory: '/d', originWorkspaceId: 'ws', busyReason: '' }) } as unknown as Adapter;
  const routing = makeOwner({ 'worker-host': worker }, 'worker-host');
  routing.store.task = () => ({ hostId: 'worker-host', originHostId: null });
  const adapter = routeHostAdapter(routing, worker);
  await assert.rejects((adapter.inspectReviewEntry as NonNullable<Adapter['inspectReviewEntry']>)(
    { submission: { originAgentId: 'origin' } } as ReviewEntryInput, 'task-1'), /origin host is unknown/);
});
