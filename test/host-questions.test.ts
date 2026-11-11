import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaseoAdapter } from '../service/paseo-composition';
import type { Task } from '../shared/contracts';

/**
 * Witnesses for the native question boundary (step 3 row 10, task 883). They
 * pin what the adapter's public native-question methods do before and after the
 * Paseo host moves them: the rejection shape of task-level refusals, the
 * timeline read each answered-question call makes, and the decision raise that
 * reaches the native timeline through the adapter.
 */

const task = { agentId: 'worker', workspaceId: 'workspace' } as unknown as Task;

function adapterWithAgent(agent: unknown) {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  Object.assign(adapter, { api: { agents: { ref: () => agent } } });
  return adapter;
}

test('answered questions read the adapter timeline page at call time and keep only clean allow answers', async () => {
  const adapter = adapterWithAgent({});
  const limits: unknown[] = [];
  Object.assign(adapter, {
    agentTimelinePage: async (_agentId: string, limit?: number) => {
      limits.push(limit);
      return { entries: [
        { timestamp: 't1', item: { type: 'permission_resolved', requestId: 'q1', question: 'Which route?', resolution: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Focused', blank: '  ' } } } } },
        { timestamp: 't2', item: { type: 'permission_resolved', requestId: 'q2', resolution: { behavior: 'deny' } } },
        { timestamp: 't3', item: { type: 'permission_resolved', requestId: 'q3', title: 'Titled', resolution: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Yes' } } } } },
      ] };
    },
  });
  assert.deepEqual(await adapter.answeredQuestions!('worker'), [
    { requestId: 'q1', question: 'Which route?', answers: { 'Question 1': 'Focused' } },
    { requestId: 'q3', question: 'Titled', answers: { 'Question 1': 'Yes' } },
  ]);
  assert.deepEqual(limits, [40]);
  Object.assign(adapter, { agentTimelinePage: async () => null });
  assert.deepEqual(await adapter.answeredQuestions!('worker'), [], 'an unreadable timeline is empty, never evidence');
});

test('task-level native decisions refuse as rejections, never as synchronous throws', async () => {
  const agent = {
    refresh: async () => true, current: () => ({}), archivedAt: null, workspaceId: 'other-workspace', pendingPermissions: [],
    respondToPermission: async () => { throw Error('must not respond'); },
    timeline: { subscribe: () => { throw Error('must not subscribe'); } },
    send: async () => { throw Error('must not send'); },
  };
  const adapter = adapterWithAgent(agent);
  const signal = new AbortController().signal;

  const raised = adapter.raiseTaskDecision!(task, { id: 'decision-1', question: 'Continue?', options: [], signal });
  assert.ok(raised instanceof Promise);
  await assert.rejects(raised, { message: 'Task thread identity changed' });

  const answered = adapter.answerTaskDecision!(task, { requestId: 'request', header: 'Question 1', answer: 'Yes' });
  assert.ok(answered instanceof Promise);
  await assert.rejects(answered, { message: 'Task thread identity changed' });

  const unthreaded = { agentId: null, workspaceId: null } as unknown as Task;
  const missing = adapter.raiseTaskDecision!(unthreaded, { id: 'decision-2', question: 'Continue?', options: [], signal });
  assert.ok(missing instanceof Promise);
  await assert.rejects(missing, { message: 'Task has no thread for a native decision' });
  const missingAnswer = adapter.answerTaskDecision!(unthreaded, { requestId: 'request', header: 'Question 1', answer: 'Yes' });
  assert.ok(missingAnswer instanceof Promise);
  await assert.rejects(missingAnswer, { message: 'Task has no thread for a native decision' });
});

test('a raised decision on the task thread reaches its native timeline through the adapter and returns the operator answer', async () => {
  let listener!: (event: { event: unknown }) => void;
  const sent: unknown[][] = [];
  const subscription = Object.assign(() => {}, { ready: Promise.resolve() });
  const agent = {
    refresh: async () => true, current: () => ({}), archivedAt: null, workspaceId: 'workspace',
    timeline: { subscribe: (cb: typeof listener) => { listener = cb; return subscription; } },
    send: async (...args: unknown[]) => { sent.push(args); },
  };
  const adapter = adapterWithAgent(agent);
  const answer = adapter.raiseTaskDecision!(task, { id: 'budget-1', question: 'Continue?', options: ['Yes', 'No'], signal: new AbortController().signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(String((sent[0] ?? [])[0]), /\[Queue decision budget-1\] Continue\?/);
  listener({ event: { type: 'permission_requested', request: { id: 'native', kind: 'question', input: { questions: [{ header: 'Question 1', question: '[Queue decision budget-1] Continue?' }] } } } });
  listener({ event: { type: 'permission_resolved', requestId: 'native', resolution: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Yes' } } } } });
  assert.equal(await answer, 'Yes');
});

test('pending questions keep only well-formed question requests, and an answer is refused for a changed thread or a request no longer pending', async () => {
  const delivered: unknown[] = [];
  const agent = {
    refresh: async () => true, workspaceId: 'workspace', archivedAt: null,
    pendingPermissions: [
      { id: 'q1', kind: 'question', input: { questions: [{ header: 'Question 1', question: 'Which route?', options: [{ label: 'Focused' }, 'Broad'] }] } },
      { id: 'q2', kind: 'question', input: { questions: [{ header: 'Question 1', question: 'A?' }, { header: 'Question 1', question: 'B?' }] } },
      { id: 'p1', kind: 'tool', input: { questions: [{ header: 'Question 1', question: 'Not a question' }] } },
      { id: 'q3', kind: 'question', input: { questions: [{ header: '  ', question: 'Blank?' }] } },
    ],
    respondToPermission: async (input: unknown) => { delivered.push(input); },
  };
  const adapter = adapterWithAgent(agent);
  assert.deepEqual(await adapter.pendingQuestions!('worker'), [
    { requestId: 'q1', questions: [{ header: 'Question 1', question: 'Which route?', options: ['Focused', 'Broad'] }] },
  ]);
  await adapter.answerNativeQuestion!('worker', 'workspace', 'q1', { 'Question 1': 'Focused' });
  assert.deepEqual(delivered, [{ requestId: 'q1', response: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Focused' } } } }]);
  await assert.rejects(adapter.answerNativeQuestion!('worker', 'other-workspace', 'q1', {}), { message: 'Question thread identity changed' });
  await assert.rejects(adapter.answerNativeQuestion!('worker', 'workspace', 'p1', {}), { message: 'Question is no longer pending' });
  assert.equal(delivered.length, 1, 'a refused answer never reaches the thread');
});

test('dismissing a pending native question denies only that question request', async () => {
  const delivered: unknown[] = [];
  const agent = {
    refresh: async () => true, workspaceId: 'workspace', archivedAt: null,
    pendingPermissions: [
      { id: 'q1', kind: 'question', input: { questions: [{ header: 'Question 1', question: '[Queue decision budget-1] Continue?' }] } },
      { id: 'p1', kind: 'tool', input: { command: 'git push' } },
    ],
    respondToPermission: async (input: unknown) => { delivered.push(input); },
  };
  const adapter = adapterWithAgent(agent);
  await adapter.dismissNativeQuestion!('worker', 'workspace', 'q1');
  assert.deepEqual(delivered, [{ requestId: 'q1', response: { behavior: 'deny' } }]);
  await assert.rejects(adapter.dismissNativeQuestion!('worker', 'other-workspace', 'q1'), { message: 'Question thread identity changed' });
  await assert.rejects(adapter.dismissNativeQuestion!('worker', 'workspace', 'p1'), { message: 'Question is no longer pending' });
  assert.equal(delivered.length, 1, 'a tool permission is never denied through dismiss');
});

test('a pending read on a missing thread rejects instead of reading as no questions', async () => {
  const adapter = adapterWithAgent({ refresh: async () => false, pendingPermissions: [] });
  const read = adapter.pendingQuestions!('worker');
  assert.ok(read instanceof Promise);
  await assert.rejects(read, { message: 'Agent was not found' });
});
