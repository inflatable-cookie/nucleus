import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsibleThreadResolver } from '../core/questions/responsible-thread-resolver';
import { formatAgentId } from '../shared/agent-identity';
import type { Project, Task, Run } from '../shared/contracts';

const paseoPlanner = formatAgentId('paseo:one', 'planner');
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
    tasks: () => [task], runs: () => [] as Run[], projectKeyResolver: () => () => project.key,
  });
  const result = await resolver.resolve(project);
  assert.deepEqual(result!.threads.map(thread => thread.agentId), [formatAgentId('t3code:one', 'owner'), formatAgentId('bb:two', 'local')]);
  assert.deepEqual(result!.threads[0]?.reasons, ['dispatcher']);
  assert.deepEqual(result!.threads[1]?.reasons, ['repository-worker']);
  assert.equal(result!.threads[0]?.lastInteraction, '2026-01-03T00:00:00Z');
});

test('does not match a similarly named directory as a checkout', async () => {
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['bb:two'], hostOnline: () => true,
    inventory: async () => [{ id: 'outside', title: '', workspaceId: null, directory: '/synthetic/repository' }],
    tasks: () => [], runs: () => [], projectKeyResolver: () => () => null });
  assert.deepEqual((await resolver.resolve(project))!.threads, []);
});

test('a recent verified Nucleus call changes the ranking and host loss drops cached candidates', async () => {
  let online = true;
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['t3code:one'], hostOnline: () => online,
    inventory: async () => [
      { id: 'first', title: '', workspaceId: null, directory: '/synthetic/repo', updatedAt: '2020-01-01T00:00:00Z' },
      { id: 'second', title: '', workspaceId: null, directory: '/synthetic/repo', updatedAt: '2021-01-01T00:00:00Z' },
    ], tasks: () => [], runs: () => [], projectKeyResolver: () => () => project.key });
  assert.equal((await resolver.resolve(project))!.threads[0]?.agentId, formatAgentId('t3code:one', 'second'));
  resolver.recordActivity(formatAgentId('t3code:one', 'first'));
  assert.equal((await resolver.resolve(project))!.threads[0]?.agentId, formatAgentId('t3code:one', 'first'));
  online = false;
  assert.deepEqual((await resolver.resolve(project))!.threads, []);
});

test('a live registered planner outranks a more recently active design thread in the same checkout',
  async () => {
    const registered = { ...project,
      planner: { agentId: paseoPlanner, setBy: 'operator', setAt: '2026-01-01T00:00:00Z' } } as unknown as Project;
    const inventories: Record<string, Array<Record<string, unknown>>> = {
      't3code:one': [{ id: 'design', title: '', workspaceId: null, directory: '/synthetic/repo', updatedAt: '2099-01-02T00:00:00Z' }],
      'paseo:one': [{ id: 'planner', title: '', workspaceId: null, updatedAt: '2026-01-01T00:00:00Z' }],
    };
    const resolver = new ResponsibleThreadResolver({ hostIds: () => ['paseo:one', 't3code:one'],
      hostOnline: () => true, inventory: async host => (inventories[host] ?? []) as never,
      tasks: () => [], runs: () => [], projectKeyResolver: () => () => registered.key });
    const result = await resolver.resolve(registered);
    assert.deepEqual(result!.threads.map(thread => [thread.agentId, thread.reasons]), [
      [paseoPlanner, ['registered-planner']],
      [formatAgentId('t3code:one', 'design'), ['repository-worker']],
    ]);
  });

test('an archived planner falls back to the newest dispatcher, then the repository worker, then nobody', async () => {
  const registered = { ...project,
    planner: { agentId: paseoPlanner, setBy: 'operator', setAt: '2026-01-01T00:00:00Z' } } as unknown as Project;
  const dispatched = { ...task, id: 'task-1', plannerAgentId: formatAgentId('t3code:one', 'dispatcher'),
    originHostId: 't3code:one', createdAt: '2026-01-05T00:00:00Z' } as unknown as Task;
  const live: Record<string, Array<Record<string, unknown>>> = {
    't3code:one': [
      { id: 'dispatcher', title: '', workspaceId: null, updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'design', title: '', workspaceId: null, directory: '/synthetic/repo', updatedAt: '2099-01-02T00:00:00Z' },
    ],
    'paseo:one': [{ id: 'planner', title: '', workspaceId: null, updatedAt: '2026-01-01T00:00:00Z' }],
  };
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['paseo:one', 't3code:one'], hostOnline: () => true,
    inventory: async host => (live[host] ?? []) as never, tasks: () => [dispatched], runs: () => [],
    projectKeyResolver: () => () => registered.key });
  assert.equal((await resolver.resolve(registered))!.threads[0]?.agentId, paseoPlanner);
  // The host no longer lists the planner: it is archived and drops out.
  live['paseo:one'] = [];
  resolver.cache.invalidate(registered.key);
  const afterPlanner = await resolver.resolve(registered);
  assert.deepEqual(afterPlanner!.threads.map(thread => [thread.agentId, thread.reasons]), [
    [formatAgentId('t3code:one', 'dispatcher'), ['dispatcher']],
    [formatAgentId('t3code:one', 'design'), ['repository-worker']],
  ]);
  // No dispatcher left: the repository worker answers.
  const noDispatcher = new ResponsibleThreadResolver({ hostIds: () => ['t3code:one'], hostOnline: () => true,
    inventory: async () => live['t3code:one']!.filter(thread => thread.id !== 'dispatcher') as never,
    tasks: () => [], runs: () => [], projectKeyResolver: () => () => registered.key });
  assert.deepEqual((await noDispatcher.resolve(registered))!.threads.map(thread => thread.agentId),
    [formatAgentId('t3code:one', 'design')]);
  // Nobody live: no candidate at all.
  const nobody = new ResponsibleThreadResolver({ hostIds: () => ['t3code:one'], hostOnline: () => true,
    inventory: async () => [], tasks: () => [], runs: () => [], projectKeyResolver: () => () => registered.key });
  assert.deepEqual((await nobody.resolve(registered))!.threads, []);
});

test('a registered named agent is a candidate even when it carries a task label', async () => {
  const named = formatAgentId('t3code:one', 'lead');
  const registered = { ...project, agents: [{ name: 'lead', purpose: 'Lead', agentId: named, hostId: 't3code:one',
    registeredBy: 'operator', registeredAt: '2026-01-01T00:00:00Z' }] } as unknown as Project;
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['t3code:one'], hostOnline: () => true,
    inventory: async () => [{ id: 'lead', title: '', workspaceId: null, labels: { 'nucleus.task': '42' } }],
    tasks: () => [], runs: () => [], projectKeyResolver: () => () => registered.key });
  assert.deepEqual((await resolver.resolve(registered))!.threads.map(thread => [thread.agentId, thread.reasons]),
    [[named, ['registered-agent']]]);
});

test('a batch shares one task and project lookup and one concurrent host inventory', async () => {
  let calls = 0, taskReads = 0, projectReads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resolver = new ResponsibleThreadResolver({ hostIds: () => ['t3code:one'], hostOnline: () => true,
    inventory: async () => { calls++; await gate; return []; },
    tasks: () => { taskReads++; return [task]; },
    runs: () => [],
    projectKeyResolver: () => { projectReads++; return () => project.key; },
  });
  const other = { ...project, key: 'other' };
  const index = resolver.taskIndex([project, other]);
  const first = resolver.resolve(project, undefined, index), second = resolver.resolve(other, undefined, index);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(taskReads, 1);
  assert.equal(projectReads, 1);
});
