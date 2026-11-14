import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Admission, admitAdapter } from '../core/host/admission';
import type { Adapter } from '../core/host/adapter';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('different notifications to one agent wait in order; identical requests merge', async () => {
  const firstGate = deferred();
  const started: string[] = [];
  const raw = { notify: async (_agent: string, id: string) => { started.push(id); if (id === 'one') await firstGate.promise; } };
  const adapter = admitAdapter(raw as unknown as Adapter, new Admission({ startIntervalMs: 0 }));
  const notify = adapter.notify!;
  const first = notify('agent', 'one', 'first');
  const duplicate = notify('agent', 'one', 'first');
  const second = notify('agent', 'two', 'second');
  await tick();
  assert.deepEqual(started, ['one']);
  firstGate.resolve();
  await Promise.all([first, duplicate, second]);
  assert.deepEqual(started, ['one', 'two']);
});

test('steer-or-notify shares per-agent message order and merges identical requests', async () => {
  const firstGate = deferred();
  const started: string[] = [];
  const raw = {
    notify: async (_agent: string, id: string) => { started.push(`notify:${id}`); await firstGate.promise; },
    steerOrNotify: async (_agent: string, id: string) => { started.push(`steer:${id}`); },
  };
  const adapter = admitAdapter(raw as unknown as Adapter, new Admission({ startIntervalMs: 0 }));
  const first = adapter.notify!('agent', 'one', 'first');
  const second = adapter.steerOrNotify!('agent', 'two', 'second');
  const duplicate = adapter.steerOrNotify!('agent', 'two', 'second');
  await tick();
  assert.deepEqual(started, ['notify:one']);
  firstGate.resolve();
  await Promise.all([first, second, duplicate]);
  assert.deepEqual(started, ['notify:one', 'steer:two']);
});

test('different worker continuations reach the host; identical requests merge', async () => {
  const firstGate = deferred();
  const seen: string[] = [];
  const raw = { continueWorker: async (_task: { id: string }, id: string, text: string) => {
    seen.push(`${id}:${text}`);
    if (id === 'one') await firstGate.promise;
  } };
  const adapter = admitAdapter(raw as unknown as Adapter, new Admission({ startIntervalMs: 0 }));
  const continueWorker = adapter.continueWorker!;
  const task = { id: 'task' } as Parameters<typeof continueWorker>[0];
  const first = continueWorker(task, 'one', 'first');
  const duplicate = continueWorker(task, 'one', 'first');
  const second = continueWorker(task, 'two', 'second');
  await tick();
  assert.deepEqual(seen, ['one:first', 'two:second']);
  firstGate.resolve();
  await Promise.all([first, duplicate, second]);
  assert.equal(seen.filter(item => item === 'one:first').length, 1);
});

test('different workspace titles reach the host; identical requests merge', async () => {
  const firstGate = deferred();
  const seen: string[] = [];
  const raw = { setTaskWorkspaceTitle: async (_task: { id: string }, title: string) => {
    seen.push(title);
    if (title === 'First') await firstGate.promise;
  } };
  const adapter = admitAdapter(raw as unknown as Adapter, new Admission({ startIntervalMs: 0 }));
  const setTitle = adapter.setTaskWorkspaceTitle!;
  const task = { id: 'task' } as Parameters<typeof setTitle>[0];
  const first = setTitle(task, 'First', 'request-one', false);
  const duplicate = setTitle(task, 'First', 'request-one', false);
  const second = setTitle(task, 'Second', 'request-two', false);
  await tick();
  assert.deepEqual(seen, ['First']);
  firstGate.resolve();
  await Promise.all([first, duplicate, second]);
  assert.deepEqual(seen, ['First', 'Second']);
});
