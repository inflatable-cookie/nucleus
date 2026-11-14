import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyVerbRun } from '../core/verbs/verb-fences';

test('verb run classification keeps observations lazy and names fences', () => {
  type Input = Parameters<typeof classifyVerbRun>[0];
  const base: Input = { settlement: { kind: 'observes' }, episode: false, displace: false, completed: true,
    currentBinding: false, agentId: 'a', workspaceId: 'w' };
  const idle = { id: 'a', workspaceId: 'w', active: false, activeTurnId: null, permissions: false, status: 'idle' };
  const cases: Array<[Partial<Input>, ReturnType<typeof classifyVerbRun>]> = [
    [{ settlement: { kind: 'fences', why: 'effect' } }, { kind: 'fence', why: 'effect' }],
    [{ settlement: { kind: 'settles' } }, { kind: 'settle' }],
    [{ episode: true, displace: true }, { kind: 'episode' }],
    [{ displace: true }, { kind: 'displace' }],
    [{ completed: false }, { kind: 'superseded' }],
    [{ currentBinding: true }, { kind: 'fence', why: 'its callback binding is still current' }],
    [{}, { kind: 'observe' }],
    [{ observation: null }, { kind: 'fence', why: 'its agent is unobservable' }],
    [{ observation: null, observationError: 'T3RpcError timeout orchestration.subscribeThread' },
      { kind: 'fence', why: 'its agent is unobservable (T3RpcError timeout orchestration.subscribeThread)' }],
    [{ observation: null, observationError: null }, { kind: 'fence', why: 'its agent is unobservable' }],
    [{ observation: { ...idle, workspaceId: 'other' } }, { kind: 'fence', why: 'its agent is unobservable' }],
    [{ observation: { ...idle, active: true } }, { kind: 'fence', why: 'its agent is active' }],
    [{ observation: { ...idle, permissions: true } }, { kind: 'fence', why: 'its agent is awaiting a permission request' }],
    [{ observation: { ...idle, status: 'initializing' } }, { kind: 'fence', why: 'its agent is initializing' }],
    ...['idle', 'error', 'closed'].map(status => [{ observation: { ...idle, status } }, { kind: 'settle' }] as [Partial<Input>, ReturnType<typeof classifyVerbRun>]),
  ];
  for (const [facts, expected] of cases) assert.deepEqual(classifyVerbRun({ ...base, ...facts }), expected);
});
