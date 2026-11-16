import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';
import { submissionSchema } from '../shared/contracts';

/**
 * The recovery sweep's boundary: a saved Queue payload is handed to the board path
 * exactly as it was recorded. The decoder skips only unreadable JSON, so an
 * incomplete record surfaces where it is used instead of being dropped silently.
 */
function fixture() {
  const store = new Store(':memory:');
  const adapter = { capabilities: () => ({ nativeDecisions: false }), notify: async () => {} } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.resolution.hostAvailable = () => true;
  store.setMeta('paused', false);
  const task = store.insert(submissionSchema.parse({ submissionId: 'question-recovery', title: 'Task', repoPath: '/repo',
    planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' }), 'localhost', 'h', 'a'.repeat(40));
  store.update(task.id, { phase: 'blocked', agentId: 'worker' });
  return { store, engine, task };
}

test('an incomplete saved payload reaches the board recovery path instead of being dropped', async () => {
  const f = fixture();
  try {
    const saved = { id: 'saved-question', kind: 'process', question: 'Continue?' };
    f.store.event(f.task.id, 'queue_ask_payload', JSON.stringify(saved));
    const recovered: Array<{ id: string; question: string }> = [];
    f.engine.resolution.ensureQueueRaiseDecision = (_task, decision) => { recovered.push({ id: decision.id, question: decision.question }); };
    await f.engine.resolution.resumeAskQuestions();
    assert.deepEqual(recovered, [{ id: 'saved-question', question: 'Continue?' }]);
  } finally { await f.engine.stop(); f.store.close(); }
});

test('a complete saved payload reopens its board decision on the recovery sweep', async () => {
  const f = fixture();
  try {
    const saved = { id: 'saved-question', kind: 'process', question: 'Continue?', options: ['Continue', 'Stop'] };
    f.store.event(f.task.id, 'queue_ask_payload', JSON.stringify(saved));
    assert.equal(f.store.eventsAll(f.task.id).some(event => event.kind === 'operator_question_decision'), false);
    await f.engine.resolution.resumeAskQuestions();
    const link = f.store.eventsAll(f.task.id).find(event => event.kind === 'operator_question_decision');
    assert.ok(link, 'the saved question is recovered on the board');
    assert.match(link.detail, /^saved-question: decision /);
  } finally { await f.engine.stop(); f.store.close(); }
});
