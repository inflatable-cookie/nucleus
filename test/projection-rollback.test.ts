import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { submissionSchema, runSchema } from '../shared/contracts';
import { taskStopRecord } from '../shared/task-stop';

function fixture() {
  const store = new Store(':memory:');
  const add = (id: string, dependsOn: string[] = []) => store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: '/fixture',
    planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', dependsOn }), 'host', 'brief', 'a'.repeat(40));
  const first = add('first'), other = add('untouched'), dependent = add('dependent', [first.id]);
  const run = runSchema.parse({ id: 'run', taskId: first.id, role: 'revision', status: 'running', generation: 1,
    head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'agent', workspaceId: 'workspace', profile: null, lastObservedAt: null, active: true, idleSince: null, completion: null, released: false, createdAt: new Date().toISOString() });
  store.putRun(run);
  store.tasks(); store.pendingRuns();
  const projection = (store as unknown as { tasksStore: { taskProjection: Map<string, unknown> } }).tasksStore.taskProjection;
  return { store, add, first, other, dependent, run: store.run(run.id)!, projection };
}

test('rollback restores changed task and run entries while retaining untouched objects and indexes', () => {
  const f = fixture();
  try {
    const original = f.store.task(f.first.id), untouched = f.projection.get(f.other.id), runs = f.store.pendingRuns();
    const before = f.store.boardRevision();
    assert.throws(() => f.store.transaction(() => {
      f.store.update(f.first.id, { phase: 'done' });
      f.store.putRun({ ...f.run, released: true, status: 'finished' });
      assert.equal(f.store.pendingRuns().length, 0);
      assert.ok(f.store.admissionCandidates().some(task => task.id === f.dependent.id));
      throw new Error('refused');
    }), /refused/);
    assert.deepEqual(f.store.task(f.first.id), original);
    assert.equal((f.store as unknown as { tasksStore: { taskProjection: unknown } }).tasksStore.taskProjection, f.projection);
    assert.equal(f.projection.get(f.other.id), untouched);
    assert.equal(f.store.boardRevision(), before);
    assert.deepEqual(f.store.pendingRuns(), runs);
    assert.ok(!f.store.admissionCandidates().some(task => task.id === f.dependent.id));
  } finally { f.store.close(); }
});

test('rollback removes inserted identities and restores removed-task pending runs', () => {
  const f = fixture();
  try {
    const ids = f.store.tasks().map(task => task.id), runs = f.store.pendingRuns();
    let inserted = '';
    assert.throws(() => f.store.transaction(() => {
      inserted = f.add('new').id;
      f.store.update(f.first.id, { removedAt: new Date().toISOString() });
      assert.equal(f.store.pendingRuns().length, 0);
      throw new Error('refused');
    }), /refused/);
    assert.deepEqual(f.store.tasks().map(task => task.id), ids);
    assert.equal((f.store as unknown as { tasksStore: { taskProjection: unknown } }).tasksStore.taskProjection, f.projection);
    assert.ok(!f.store.admissionCandidates().some(task => task.id === inserted));
    assert.deepEqual(f.store.pendingRuns(), runs);
    assert.equal(f.store.taskOrNull(inserted), null);
  } finally { f.store.close(); }
});

test('writes that bypass the funnels retain clock-based rebuilding after rollback', () => {
  const f = fixture();
  try {
    const before = f.store.task(f.first.id);
    assert.throws(() => f.store.transaction(() => {
      f.store.update(f.first.id, { reason: 'temporary' });
      f.store.db.prepare("UPDATE tasks SET data=json_set(data,'$.title','bypass') WHERE id=?").run(f.other.id);
      throw new Error('refused');
    }), /refused/);
    assert.deepEqual(f.store.task(f.first.id), before);
    assert.notEqual((f.store as unknown as { tasksStore: { taskProjection: unknown } }).tasksStore.taskProjection, f.projection);
    assert.equal(f.store.task(f.other.id).title, 'untouched');
  } finally { f.store.close(); }
});


test('rollback restores the routing-attempt epoch before recomputing readiness', () => {
  const f = fixture();
  try {
    f.store.setRoutingEpoch('catalog');
    const other = f.store.task(f.other.id);
    f.store.update(f.other.id, { reason: 'No eligible profile', resolution: { ...other.resolution, stop: taskStopRecord('route_unavailable', 'No eligible profile') } });
    f.store.markRoutingAttempt(f.other.id);
    assert.equal(f.store.routingRetryAllowed(f.store.task(f.other.id)), false);
    assert.throws(() => f.store.transaction(() => {
      f.store.update(f.other.id, { title: 'temporary' });
      throw new Error('refused');
    }), /refused/);
    assert.equal(f.store.routingRetryAllowed(f.store.task(f.other.id)), false);
    assert.ok(!f.store.admissionCandidates().some(task => task.id === f.other.id));
  } finally { f.store.close(); }
});
