import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../shared/contracts';
import { delegateQuestion } from '../core/questions/planner-delegation';
import { parseNativeDelegatedReply } from '../core/questions/question-delegation';
import type { Resolution } from '../core/resolution';

function fixture(text: string | null, unknown = false, abortOnAnswer = false) {
  const controller = new AbortController();
  let delivered = false;
  const calls = { plannerSends: 0, observations: 0, decider: 0, unknown: 0, intents: [] as string[], archives: [] as string[] };
  const resolution = {
    stopped: () => false,
    store: { eventsAll: (id: string) => delivered && unknown && id === 'delegation:planner-window' ? [{ kind: 'delegated_closed', detail: 'Delivery outcome unknown; never resend' }] : [] },
    adapter: { runDecider: () => {} },
    delegatedDelivery: (id: string) => delivered && id === 'planner-window' ? { recipient: 'planner' } : undefined,
    delegation: { requireHost: async () => {} },
    askBound: async () => {
      assert.equal(calls.intents.at(-1), 'planner', 'intent precedes delivery or observation');
      calls.observations++;
      if (!delivered) { calls.plannerSends++; delivered = true; }
      if (unknown) throw Error('delivery outcome unknown');
      if (abortOnAnswer) controller.abort();
      return text;
    },
    deciderProfile: () => ({ id: 'decider-profile' }),
    deciderBound: async () => {
      assert.equal(calls.intents.at(-1), 'decider');
      calls.decider++;
      return { agentId: 'decider', text: 'Answer: Continue\nReason: Known planner miss' };
    },
    host: { archiveAgent: async (id: string) => { calls.archives.push(id); } },
  } as unknown as Resolution;
  const input = {
    planner: 'planner', plannerMessageId: 'planner-window', decisionId: 'question',
    context: { question: 'Proceed?', choices: ['Continue', 'Hold'], context: [] },
    signal: controller.signal, parse: parseNativeDelegatedReply,
    onIntent: (role: string) => { calls.intents.push(role); },
    onMiss: () => {}, onUnknown: () => { calls.unknown++; },
  };
  return { calls, run: () => delegateQuestion(resolution, {} as Task, input) };
}

test('unknown planner delivery never asks the decider, including when resuming its recorded window', async () => {
  const f = fixture(null, true);
  assert.equal(await f.run(), null);
  assert.equal(await f.run(), null);
  assert.equal(f.calls.plannerSends, 1);
  assert.equal(f.calls.observations, 1);
  assert.equal(f.calls.unknown, 2);
  assert.equal(f.calls.decider, 0);
});

test('a known planner miss opens the decider rung and archives its answer thread', async () => {
  const f = fixture(null);
  const result = await f.run();
  assert.equal(result?.role, 'decider');
  assert.equal(f.calls.decider, 1);
  assert.deepEqual(f.calls.archives, ['decider']);
});

test('a planner operator classification settles routing without asking the decider', async () => {
  const f = fixture('Decision: operator\nReason: A product change');
  const result = await f.run();
  assert.equal(result?.role, 'planner');
  assert.equal(result?.reply.kind, 'operator');
  assert.equal(f.calls.decider, 0);
});

test('shutdown never reads a released store or starts a delegate', async () => {
  const resolution = {
    stopped: () => true,
    get store() { throw Error('database is closed'); },
  } as unknown as Resolution;
  const result = await delegateQuestion(resolution, {} as Task, {
    planner: 'planner', plannerMessageId: 'closed', decisionId: 'closed',
    context: { question: 'Proceed?', choices: [], context: [] }, signal: new AbortController().signal,
    parse: parseNativeDelegatedReply,
    onIntent: () => assert.fail('no send during shutdown'), onMiss: () => assert.fail('no outcome during shutdown'),
    onUnknown: () => assert.fail('no outcome during shutdown'),
  });
  assert.equal(result, null);
});


test('an observed planner receipt remains auditable after cancellation without opening a decider', async () => {
  const f = fixture('Answer: Continue\nReason: Recorded before cancellation', false, true);
  const result = await f.run();
  assert.equal(result?.role, 'planner');
  assert.equal(result?.reply.kind, 'answer');
  assert.equal(f.calls.decider, 0);
});
