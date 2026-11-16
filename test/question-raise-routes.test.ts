import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';
import { submissionSchema, type Profile } from '../shared/contracts';

/**
 * The raise route's boundary: a native surface that announces the same request
 * twice records one durable identity, and a repeated withdrawal reads the same one.
 */
const nativeProfile: Profile = { id: 'native', name: 'native', provider: 'codex', model: 'test/native', notes: '', available: true, problem: '', supportedThinking: [] };

function fixture(requestId = 'native-1') {
  const store = new Store(':memory:');
  const requests: Array<{ requestId: string; header: string }> = [];
  const adapter = {
    // A native timeline repeats its permission-requested event; the raise route
    // must record the request identity once, whatever the host repeats.
    raiseTaskDecision: async (_task: unknown, input: { id: string; question: string; options: string[]; signal: AbortSignal;
      onRequested?: (request: { requestId: string; header: string }) => void }) => {
      requests.push({ requestId, header: 'Question 1' });
      input.onRequested?.({ requestId, header: 'Question 1' });
      input.onRequested?.({ requestId, header: 'Question 1' });
      return 'Extend the budget';
    },
    notify: async () => {},
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  return { store, engine, adapter, requests };
}

test('a repeated native request callback records one durable request identity', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'raise-repeat', title: 'Task', repoPath: '/repo',
      planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'localhost', 'h', 'a'.repeat(40));
    f.store.update(task.id, { phase: 'working', agentId: 'worker', profile: nativeProfile });
    const current = f.store.task(task.id);
    const answer = await f.engine.resolution.raiseDecision(current,
      { id: 'question-1', kind: 'review', question: 'Continue?', options: ['Extend the budget'] }, new AbortController().signal);
    assert.equal(answer, 'Extend the budget');
    const recorded = f.store.eventsAll(task.id).filter(event => event.kind === 'operator_question_native_request');
    assert.deepEqual(recorded.map(event => event.detail), ['question-1: request native-1 header Question 1 on worker']);
  } finally { await f.engine.stop(); f.store.close(); }
});

test('a second callback for the same request never adds a second identity', async () => {
  const f = fixture('native-2');
  try {
    f.store.setMeta('paused', false);
    const task = f.store.insert(submissionSchema.parse({ submissionId: 'raise-repeat-twice', title: 'Task', repoPath: '/repo',
      planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'localhost', 'h', 'a'.repeat(40));
    f.store.update(task.id, { phase: 'working', agentId: 'worker', profile: nativeProfile });
    for (const id of ['question-1', 'question-2']) {
      await f.engine.resolution.raiseDecision(f.store.task(task.id),
        { id, kind: 'review', question: 'Continue?', options: ['Extend the budget'] }, new AbortController().signal);
    }
    const recorded = f.store.eventsAll(task.id).filter(event => event.kind === 'operator_question_native_request');
    assert.deepEqual(recorded.map(event => event.detail),
      ['question-1: request native-2 header Question 1 on worker', 'question-2: request native-2 header Question 1 on worker']);
  } finally { await f.engine.stop(); f.store.close(); }
});
