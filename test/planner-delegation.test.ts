import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../shared/contracts';
import { delegateQuestion } from '../core/questions/planner-delegation';
import { DelegatedHostUnavailable } from '../core/questions/delegation';
import { parseNativeDelegatedReply } from '../core/questions/question-delegation';
import type { Resolution } from '../core/resolution';

/**
 * Task 1109: one question climbs the planner rungs in order — the task's own
 * planner, then the project's, then the decider — and an observed miss on one rung
 * is permission to ask the next while an unknown send is never resent.
 */
function fixture(options: { answers?: Record<string, string | null>; unknown?: string[]; abortOnAnswer?: boolean; lastHostDown?: string } = {}) {
  const controller = new AbortController();
  const delivered = new Set<string>();
  const calls = { sends: [] as string[], observations: [] as string[], decider: 0, unknown: 0, skips: [] as string[], intents: [] as string[], archives: [] as string[] };
  const answers = options.answers ?? {};
  const resolution = {
    stopped: () => false,
    store: { eventsAll: (id: string) => options.unknown?.includes(id.replace('delegation:', '')) && delivered.has(id.replace('delegation:', ''))
      ? [{ kind: 'delegated_closed', detail: 'Delivery outcome unknown; never resend' }] : [] },
    adapter: { runDecider: () => {} },
    delegatedDelivery: (id: string) => delivered.has(id) ? { recipient: id } : undefined,
    delegation: { requireHost: async (task: Task, recipient: string) => {
      if (options.lastHostDown === recipient) throw new DelegatedHostUnavailable('Delegated recipient host is unavailable or unknown');
    } },
    askBound: async (_task: Task, recipient: string, input: { messageId: string }) => {
      assert.ok(calls.intents.at(-1)?.startsWith('planner'), 'intent precedes delivery or observation');
      calls.observations.push(recipient);
      if (!delivered.has(input.messageId)) { calls.sends.push(recipient); delivered.add(input.messageId); }
      if (answers[recipient] === undefined) throw Error('delivery outcome unknown');
      if (options.abortOnAnswer) controller.abort();
      return answers[recipient];
    },
    deciderProfile: () => ({ id: 'decider-profile' }),
    deciderBound: async () => {
      assert.ok(calls.intents.at(-1)?.startsWith('decider'), 'the decider rung follows the planners');
      calls.decider++;
      return { agentId: 'decider', text: 'Answer: Continue\nReason: Known planner miss' };
    },
    host: { archiveAgent: async (id: string) => { calls.archives.push(id); } },
  } as unknown as Resolution;
  const input = {
    planners: [
      { agentId: 'task-planner', messageId: 'task-window', rung: 'task' as const },
      { agentId: 'project-planner', messageId: 'project-window', rung: 'project' as const },
    ],
    decisionId: 'question',
    context: { question: 'Proceed?', choices: ['Continue', 'Hold'], context: [] },
    signal: controller.signal, parse: parseNativeDelegatedReply,
    onIntent: (role: string, agentId?: string, rung?: string) => { calls.intents.push(`${role}:${rung ?? agentId ?? ''}`); },
    onSkip: (rung: string) => { calls.skips.push(rung); },
    onMiss: () => {}, onUnknown: () => { calls.unknown++; },
  };
  return { calls, run: () => delegateQuestion(resolution, {} as Task, input) };
}

test('a silent task planner hands the question to the project planner, in order', async () => {
  const f = fixture({ answers: { 'task-planner': null, 'project-planner': 'Answer: Continue\nReason: Project ruling' } });
  const result = await f.run();
  assert.deepEqual(f.calls.sends, ['task-planner', 'project-planner']);
  assert.equal(result?.rung, 'project');
  assert.equal(result?.reply.kind, 'answer');
  assert.equal(f.calls.decider, 0);
});

test('the task planner answering first ends the route', async () => {
  const f = fixture({ answers: { 'task-planner': 'Answer: Hold\nReason: Task ruling' } });
  const result = await f.run();
  assert.deepEqual(f.calls.sends, ['task-planner']);
  assert.equal(result?.rung, 'task');
  assert.equal(result?.reply.kind, 'answer');
});

test('an unknown planner delivery never asks the next rung, including when resuming its recorded window', async () => {
  const f = fixture({ answers: {}, unknown: ['task-window'] });
  assert.equal(await f.run(), null);
  assert.equal(await f.run(), null);
  assert.deepEqual(f.calls.sends, ['task-planner']);
  assert.equal(f.calls.observations.length, 1);
  assert.equal(f.calls.unknown, 2);
  assert.deepEqual(f.calls.sends, ['task-planner'], 'the project planner is never asked after an uncertain send');
  assert.equal(f.calls.decider, 0);
});

test('a known miss on every rung opens the decider and archives its answer thread', async () => {
  const f = fixture({ answers: { 'task-planner': null, 'project-planner': null } });
  const result = await f.run();
  assert.equal(result?.role, 'decider');
  assert.equal(f.calls.decider, 1);
  assert.deepEqual(f.calls.archives, ['decider']);
});

test('a planner operator classification settles routing without asking the next rung or the decider', async () => {
  const f = fixture({ answers: { 'task-planner': 'Decision: operator\nReason: A product change' } });
  const result = await f.run();
  assert.equal(result?.role, 'planner');
  assert.equal(result?.reply.kind, 'operator');
  assert.deepEqual(f.calls.sends, ['task-planner']);
  assert.equal(f.calls.decider, 0);
});

test('a rung whose host is unavailable is skipped in order, never waited on behind a live fallback', async () => {
  const f = fixture({ lastHostDown: 'task-planner', answers: { 'project-planner': 'Answer: Continue\nReason: Fallback' } });
  const result = await f.run();
  assert.deepEqual(f.calls.skips, ['task']);
  assert.deepEqual(f.calls.sends, ['project-planner']);
  assert.equal(result?.rung, 'project');
});

test('the last rung keeps the host wait when its host is unavailable', async () => {
  const f = fixture({ lastHostDown: 'project-planner', answers: { 'task-planner': null } });
  await assert.rejects(f.run(), /host is unavailable/);
  assert.deepEqual(f.calls.skips, []);
});

test('a project planner that cannot be asked on its host leaves the question to the caller', async () => {
  const unavailable: string[] = [];
  const controller = new AbortController();
  const unaskable = (planners: Array<{ agentId: string; messageId: string; rung: 'task' | 'project' }>) => delegateQuestion({
    stopped: () => false, store: { eventsAll: () => [] }, adapter: {},
    delegatedDelivery: () => undefined,
    delegation: { requireHost: async () => {} },
    askBound: async () => null,
  } as unknown as Resolution, {} as Task, {
    planners, decisionId: 'unaskable',
    context: { question: 'Proceed?', choices: [], context: [] }, signal: controller.signal,
    parse: parseNativeDelegatedReply, onIntent: () => {}, onMiss: () => {}, onUnknown: () => {},
    onUnavailable: planner => { unavailable.push(planner); },
  });
  // A task rung its host cannot ask falls through; only the project rung's refusal reaches the caller.
  assert.equal(await unaskable([{ agentId: 'task-planner', messageId: 'task-window', rung: 'task' }]), null);
  assert.deepEqual(unavailable, [], 'a task planner that cannot be asked does not raise the board decision');
  assert.equal(await unaskable([{ agentId: 'project-planner', messageId: 'project-window', rung: 'project' }]), null);
  assert.deepEqual(unavailable, ['project-planner']);
});

test('shutdown never reads a released store or starts a delegate', async () => {
  const resolution = {
    stopped: () => true,
    get store() { throw Error('database is closed'); },
  } as unknown as Resolution;
  const result = await delegateQuestion(resolution, {} as Task, {
    planners: [{ agentId: 'planner', messageId: 'closed', rung: 'project' }], decisionId: 'closed',
    context: { question: 'Proceed?', choices: [], context: [] }, signal: new AbortController().signal,
    parse: parseNativeDelegatedReply,
    onIntent: () => assert.fail('no send during shutdown'), onMiss: () => assert.fail('no outcome during shutdown'),
    onUnknown: () => assert.fail('no outcome during shutdown'),
  });
  assert.equal(result, null);
});

test('an observed planner receipt remains auditable after cancellation without opening a decider', async () => {
  const f = fixture({ answers: { 'task-planner': 'Answer: Continue\nReason: Recorded before cancellation' }, abortOnAnswer: true });
  const result = await f.run();
  assert.equal(result?.role, 'planner');
  assert.equal(result?.reply.kind, 'answer');
  assert.equal(f.calls.decider, 0);
});
