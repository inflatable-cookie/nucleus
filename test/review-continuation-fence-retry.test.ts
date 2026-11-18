import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './support/review-continuation-fixture';

test('an idle reviewer with a delivered checkpoint can redeliver its report on the same run', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'report-lost');
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1);
    f.store.putRun({ ...f.run(), active: false, lastObservedAt: new Date(Date.now() + 1000).toISOString() });
    const sent: { id: string; text: string }[] = [];
    f.adapter.notify = async (_agent, id, text) => { sent.push({ id, text }); };
    const task = f.current();
    await f.engine.performTaskControl({ action: 'move', to: 'review', taskId: task.id, version: task.version, reason: 'Recover the lost report' });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.id, /^ns-reviewer-report-/);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('a missing task-level binding does not allow replacing its current reviewer', async () => {
  const f = fixture(); try {
    const task = f.current();
    f.store.update(task.id, { resolution: { ...task.resolution, reviewerAgentId: null } });
    await assert.rejects(f.engine.performTaskControl({ action: 'move', to: 'review', fresh: true, taskId: task.id,
      version: f.current().version, reason: 'Replace the reviewer' }), /retained reviewer/);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('an owner restarts an exhausted checkpoint through the retained reviewer', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'exhausted');
    f.store.putRun({ ...f.run(), reviewBudgetExhaustedAt: new Date().toISOString() });
    const sent: string[] = [];
    f.adapter.notify = async (_agent, _id, text) => { sent.push(text); };
    const task = f.current();
    await f.engine.performTaskControl({ action: 'restart', role: 'reviewer', taskId: task.id, version: task.version,
      reason: 'Finish the review', instruction: 'Check the outstanding tests' });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Check the outstanding tests/);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('a prior result fence does not force a fresh reviewer when the retained reader is idle', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'result-fence');
    const task = f.current();
    f.store.update(task.id, { resolution: { ...task.resolution, review: { eventId: 'saved', taskId: task.id, runId: f.runId,
      status: 'blocked', summary: 'Prior environment fault', head: f.run().head, reviewResponsibility: 'environment' } } });
    const sent: string[] = [];
    f.adapter.notify = async (_agent, _id, text) => { sent.push(text); };
    await f.engine.performTaskControl({ action: 'move', to: 'review', taskId: task.id, version: f.current().version, reason: 'Recover review' });
    assert.equal(sent.length, 1);
    assert.equal(f.current().resolution.currentRunId, f.runId);
    assert.equal(f.createdRuns.length, 0);
  } finally { await f.close(); }
});

test('checkpoint fences do not authorize replacing an available reviewer', async () => {
  for (const shape of ['result', 'run'] as const) {
    const f = fixture(); try {
      await f.report({ covered: ['Diff'], remaining: ['Tests'] }, `fresh-${shape}`);
      f.store.setMeta('paused', true);
      if (shape === 'result') f.store.update(f.submitted.id, { resolution: { ...f.current().resolution,
        review: { eventId: 'saved-block', taskId: f.submitted.id, runId: f.runId, status: 'blocked',
          summary: 'No findings; environment unavailable', head: f.run().head, reviewResponsibility: 'environment' } } });
      else f.store.putRun({ ...f.run(), id: 'other-reader', agentId: 'other-reader', reviewCheckpoints: [] });
      await assert.rejects(f.engine.performTaskControl({ action: 'move', to: 'review', fresh: true, taskId: f.submitted.id,
        version: f.current().version, reason: 'Start a fresh independent review at this head' }), /retained reviewer/);
      assert.equal(f.current().resolution.currentRunId, f.runId, shape);
      assert.equal(f.run().released, false);
      assert.equal(f.createdRuns.length, 0);
      assert.equal(f.reviewerDeliveries.length, 0);
      assert.equal(f.run().reviewCheckpoints?.length, 1);
      assert.deepEqual(f.counts(), { merges: 0, syncs: 0 });
    } finally { await f.close(); }
  }
});

test('observation settles an orphan run fencing a checkpoint and Queue continues without a turn-end event', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'other-run-checkpoint');
    const other = { ...f.run(), id: 'other-review', agentId: 'other-reviewer', reviewCheckpoints: [],
      createdAt: new Date(Date.parse(f.run().createdAt) - 60_000).toISOString(), completion: null, active: true };
    f.store.putRun(other);
    f.store.putRun({ ...other, id: 'finished-sibling', status: 'finished', released: true,
      createdAt: f.run().createdAt, completion: { eventId: 'sibling-result', taskId: f.submitted.id, runId: 'finished-sibling',
        status: 'blocked', summary: 'Earlier environment fault', head: f.run().head } });
    f.states.set(other.agentId, { ...f.states.get('review-agent')!, id: other.agentId, status: 'running', active: true });
    await f.engine.wake();
    assert.equal(f.store.run(other.id)!.released, false, 'a busy thread still holds its lease');
    assert.equal(f.reviewerDeliveries.length, 0);
    f.states.set(other.agentId, { ...f.states.get(other.agentId)!, status: 'idle', active: false });
    assert.ok(f.engine.resolution.observationTargets().includes(other.agentId));
    await f.engine.wake();
    assert.equal(f.store.run(other.id)!.released, true, 'ordinary idle observation settles the orphan run');
    assert.ok(f.store.eventsAll(f.submitted.id).some(event => event.kind === 'duplicate_run_superseded'));
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1, 'the existing continuation gate now admits the checkpoint');
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId);
    assert.equal(f.run().completion, null);
    assert.deepEqual(f.counts(), { merges: 0, syncs: 0 });
  } finally { await f.close(); }
});

test('a deferred reviewer checkpoint retries on the next pass after its incident fence clears', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'fenced-checkpoint');
    const incident = f.engine.resolution.ensureIncident(f.current(), f.run(), 'Recovery is reconciling the review incident');
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 0, 'the checkpoint waits while its incident is open');
    assert.ok(f.store.events(f.submitted.id).some(event => event.kind === 'review_auto_continue_deferred'));
    const current = f.current();
    f.store.update(current.id, { resolution: { ...current.resolution,
      incident: { ...incident, status: 'resolved', detail: 'Recovery reported the trigger settled', updatedAt: new Date().toISOString() } } });
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1, 'the continuation retries after the fence clears');
    assert.equal(f.reviewerDeliveries[0]!.runId, f.runId);
    assert.equal(f.store.events(f.submitted.id).filter(event => event.kind === 'review_auto_continued').length, 1);
  } finally { await f.close(); }
});
