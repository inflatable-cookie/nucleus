import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsibleThreadResolver } from '../core/questions/responsible-thread-resolver';
import { formatAgentId } from '../shared/agent-identity';
import type { Project, Task, Run } from '../shared/contracts';

const project = { key: 'example', repositories: [{ path: '/synthetic/repo', origin: 'synthetic/repo' }], planner: null } as unknown as Project;
const task = { repoPath: '/synthetic/repo', repository: 'synthetic/repo', plannerAgentId: formatAgentId('t3code:one', 'owner'), originHostId: 't3code:one', notificationAgentId: null, originAgentId: 'operator', agentId: 'worker', hostId: 't3code:one', createdAt: '2026-01-03T00:00:00Z' } as unknown as Task;

test('resolves project checkout and task owners, excluding task roles across hosts', async () => {
  const resolver = new ResponsibleThreadResolver({
    hostIds: () => ['t3code:one', 'bb:two', 'paseo:offline'],
    hostOnline: host => host !== 'paseo:offline',
    inventory: async host => host === 't3code:one' ? [
      { id: 'owner', title: '', workspaceId: null, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'worker', title: '', workspaceId: null, directory: '/synthetic/repo' },
    ] : [
      { id: 'local', title: '', workspaceId: null, directory: '/synthetic/repo/src', updatedAt: '2026-01-04T00:00:00Z' },
      { id: 'reviewer', title: '', workspaceId: null, directory: '/synthetic/repo', labels: { 'nucleus.role': 'reviewer' } },
      { id: 'outsider', title: '', workspaceId: null },
    ],
    tasks: () => [task], runs: () => [] as Run[], projectFor: () => project,
  });
  const result = await resolver.resolve(project);
  assert.deepEqual(result.threads.map(thread => thread.agentId), [formatAgentId('bb:two', 'local'), formatAgentId('t3code:one', 'owner')]);
  assert.equal(result.threads[1]?.lastInteraction, '2026-01-03T00:00:00Z');
});

test('does not match a similarly named directory as a checkout', async () => {
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['bb:two'], hostOnline: () => true,
    inventory: async () => [{ id: 'outside', title: '', workspaceId: null, directory: '/synthetic/repository' }],
    tasks: () => [], runs: () => [], projectFor: () => null });
  assert.deepEqual((await resolver.resolve(project)).threads, []);
});

test('a recent verified Nucleus call changes the ranking and host loss drops cached candidates', async () => {
  let online = true;
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['t3code:one'], hostOnline: () => online,
    inventory: async () => [
      { id: 'first', title: '', workspaceId: null, directory: '/synthetic/repo', updatedAt: '2020-01-01T00:00:00Z' },
      { id: 'second', title: '', workspaceId: null, directory: '/synthetic/repo', updatedAt: '2021-01-01T00:00:00Z' },
    ], tasks: () => [], runs: () => [], projectFor: () => project });
  assert.equal((await resolver.resolve(project)).threads[0]?.agentId, formatAgentId('t3code:one', 'second'));
  resolver.recordActivity(formatAgentId('t3code:one', 'first'));
  assert.equal((await resolver.resolve(project)).threads[0]?.agentId, formatAgentId('t3code:one', 'first'));
  online = false;
  assert.deepEqual((await resolver.resolve(project)).threads, []);
});
