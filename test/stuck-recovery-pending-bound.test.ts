import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/responsible-lifecycle-fixture';

/**
 * Papercut 0489ea25: nucleus#1166's Grok turn stopped making progress at 16:02.
 * Nucleus recorded `stalled_turn`, then `recovery_pending` at 16:22:49, and
 * then nothing for 2h14m: no recovery run, no escalation, nobody told. The
 * stalled worker still held the workspace lease, so the launch silently
 * returned each pass and left the pending episode in place.
 *
 * A pending recovery episode that starts no run inside the bound now reaches
 * the task's planner ladder, naming the stop and the verb that exits it.
 */
test('0489ea25: a recovery episode that never starts a run escalates within the bound', async () => {
  const f = fixture();
  try {
    const at = new Date().toISOString();
    const current = f.current();
    f.store.update(f.submitted.id, {
      phase: 'needs_attention',
      reason: 'The worker run looks stalled: no agent activity while Paseo still reports it running',
      resolution: {
        ...current.resolution,
        attention: true,
        stop: {
          reason: 'run_stalled',
          detail: 'The worker run initial (agent worker, active turn worker-turn-1) looks stalled: no agent activity while Paseo still reports it running. It still owns this task; the owner may use restart for this exact run after checking its retained identity',
          since: at,
          suggestedVerbs: ['restart'],
        },
        recovery: {
          id: 'recovery-pending-1', key: 'stalled-episode', generation: current.coordinatorGeneration,
          runId: null, agentId: null, status: 'pending', summary: '', idleSince: null, incidentId: null, progress: null,
        },
      },
    }, 'test_recovery_pending', 'stalled turn recorded a pending recovery episode');
    f.store.event(f.submitted.id, 'recovery_pending', 'stalled turn episode');
    // The bound is a few real minutes in production; the test drives it directly.
    (f.engine.resolution.recovery as unknown as { pendingBoundMs: number }).pendingBoundMs = 0;
    await f.engine.resolution.recovery.pass(f.submitted.id);
    const task = f.current();
    assert.equal(task.resolution.recovery?.status, 'escalated', 'the episode reaches a person instead of staying pending');
    assert.match(task.resolution.recovery!.summary, /run_stalled/);
    assert.match(task.resolution.recovery!.summary, /restart/);
    const ladder = f.events('planner_escalation');
    assert.equal(ladder.length, 1, 'the task planner ladder is opened once for the episode');
    assert.match(f.events('planner_escalation_question')[0]!.detail, /run_stalled/);
    assert.match(f.events('planner_escalation_question')[0]!.detail, /restart/);
  } finally { await f.close(); }
});
