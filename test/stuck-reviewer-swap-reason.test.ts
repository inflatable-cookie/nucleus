import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/responsible-lifecycle-fixture';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';

/**
 * Papercut 8fffbf59: barge#061 at 21:40:26 swapped its retained reviewer
 * ("Retained reviewer ... is not eligible for another round") and archived the
 * idle, same-model thread with no recorded condition, so the project could not
 * judge whether the replacement's verdict was its one counted review.
 *
 * The swap now names which condition failed in its event and in `next`.
 */
test('8fffbf59: a reviewer swap records the condition that failed', async () => {
  const f = fixture();
  try {
    await f.engine.wake();
    assert.equal(f.run().role, 'reviewer', 'the first round launches the retained reviewer');
    const first = f.run();
    await f.report('changes_required');
    const retainedAgent = f.current().resolution.reviewerAgentId;
    assert.equal(retainedAgent, first.agentId, 'the reviewer stays retained after its verdict');
    // The next round follows the author's return at the same head. The retained
    // thread is idle, in its recorded workspace, but its observed runtime no
    // longer matches the pinned reviewer profile.
    f.states.set(retainedAgent!, {
      id: retainedAgent!, workspaceId: 'workspace', status: 'idle', active: false, activeTurnId: null,
      permissions: false, error: '', provider: 'codex', model: 'gpt-6.1-sol-renamed',
    });
    await f.engine.wake();
    assert.equal(f.run().role, 'revision', 'the author returns at the same head');
    await f.report('ready_for_review');
    await f.engine.wake();
    const swapEvent = f.events('reviewer_fresh_agent').at(-1)!;
    const swap = JSON.parse(swapEvent.detail) as { fromAgentId: string; condition: string; detail: string; head: string };
    assert.equal(swap.fromAgentId, retainedAgent);
    assert.equal(swap.condition, 'runtime');
    assert.match(swap.detail, /gpt-6\.1-sol-renamed/);
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current()));
    assert.deepEqual(next.reviewerSwap && { fromAgentId: next.reviewerSwap.fromAgentId, condition: next.reviewerSwap.condition },
      { fromAgentId: retainedAgent, condition: 'runtime' }, 'next carries the same swap reason');
  } finally { await f.close(); }
});

/**
 * The consult-bound path (reviewer 5884638293): a reviewer created by a
 * reviewer consult has no prior review run, so its round check is replaced by
 * the consult independence check. A reviewer whose model collides with the
 * task authors must still be swapped, with the same recorded condition.
 */
test('8fffbf59: a non-independent consult-bound reviewer is swapped, not kept', async () => {
  const f = fixture();
  try {
    const consultAgent = 'agent-consult';
    const current = f.current();
    // The recorded shape: a consult created and retained this reviewer before
    // any review run existed, and its model collides with the source author's.
    f.store.update(f.submitted.id, {
      workerModel: f.reviewer.model, workerModels: [f.reviewer.model],
      resolution: { ...current.resolution, reviewerAgentId: consultAgent, reviewerProfile: f.reviewer },
    }, 'test_consult_reviewer', 'a consult retained this reviewer before any review run');
    f.store.event(f.submitted.id, 'reviewer_consult_reviewer', `consult-1: ${consultAgent}`);
    f.states.set(consultAgent, {
      id: consultAgent, workspaceId: 'workspace', status: 'idle', active: false, activeTurnId: null,
      permissions: false, error: '', provider: 'codex', model: f.reviewer.model,
    });
    await f.engine.wake();
    const swapEvent = f.events('reviewer_fresh_agent').at(-1)!;
    const swap = JSON.parse(swapEvent.detail) as { fromAgentId: string; condition: string; detail: string };
    assert.equal(swap.fromAgentId, consultAgent, 'the consult-bound reviewer is the thread the swap names');
    assert.equal(swap.condition, 'participant');
    assert.match(swap.detail, /not independent/);
    assert.notEqual(f.current().resolution.reviewerAgentId, undefined);
  } finally { await f.close(); }
});
