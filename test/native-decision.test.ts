import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoAgentHandle, PaseoAgentTimelineEvent } from '@getpaseo/client';
import { raiseNativeDecision } from '../hosts/paseo/adapter/host-questions';

function fake() {
  let listener!: (event: PaseoAgentTimelineEvent) => void, removed = false;
  const sent: unknown[] = [];
  const subscription = Object.assign(() => { removed = true; }, { ready: Promise.resolve() });
  const agent = { timeline: { subscribe: (cb: typeof listener) => { listener = cb; return subscription; } }, send: async (...args: unknown[]) => { sent.push(args); } } as unknown as PaseoAgentHandle;
  return { agent, sent, emit: (event: unknown) => listener({ agentId: 'worker', event } as PaseoAgentTimelineEvent), removed: () => removed };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Queue raises a native decision on the task thread and receives its operator answer', async () => {
  const f = fake(); const controller = new AbortController();
  const answer = raiseNativeDecision(f.agent, { id: 'budget-1', question: 'Continue?', options: ['Yes', 'No'], signal: controller.signal });
  await tick(); assert.match(String((f.sent[0] as any[])[0]), /\[Queue decision budget-1\] Continue\?/);
  f.emit({ type: 'permission_requested', request: { id: 'unrelated', kind: 'question', input: { questions: [{ header: 'Question 1', question: 'Other?' }] } } });
  f.emit({ type: 'permission_requested', request: { id: 'native', kind: 'question', input: { questions: [{ header: 'Question 1', question: '[Queue decision budget-1] Continue?' }] } } });
  f.emit({ type: 'permission_resolved', requestId: 'native', resolution: { behavior: 'allow', updatedInput: { answers: { 'Question 1': 'Yes' } } } });
  assert.equal(await answer, 'Yes'); assert.equal(f.removed(), true);
});

test('lost observation never guesses an answer or retries a send', async () => {
  const f = fake(); const controller = new AbortController();
  const answer = raiseNativeDecision(f.agent, { id: 'one', question: 'Proceed?', options: [], signal: controller.signal });
  await tick(); f.emit({ type: 'subscription_restored' });
  await assert.rejects(answer, /unknown/); assert.equal(f.sent.length, 1); assert.equal(f.removed(), true);
});
