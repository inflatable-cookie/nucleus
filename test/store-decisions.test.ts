import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { submissionSchema } from '../shared/contracts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'store-decisions-'));
  const path = join(dir, 'queue.sqlite');
  const store = new Store(path);
  const add = (id: string) => store.insert(submissionSchema.parse({ submissionId: id, title: id,
    repoPath: join(dir, 'repo'), planningCommit: 'a'.repeat(40), handoffPath: 'handoff', originAgentId: 'origin' }), 'host', 'brief', 'a'.repeat(40));
  return { store, path, add };
}

test('credential, receipt and availability writes share the caller transaction', () => {
  const { store } = fixture();
  try {
    store.setCredential('run', 'original');
    const availability = JSON.stringify({ group: 'g', unavailable: true, reason: 'exhausted', retryAt: null });
    store.setAvailability('g', availability);
    store.setReportIntent('event', 'task', 'run', 'report-hash');
    store.setCompletionReceipt('event', 'task', 'run', 'completion-hash', JSON.stringify({ accepted: true }));
    store.setReportResponse('event', 'report-hash', { accepted: true });
    assert.throws(() => store.transaction(() => {
      store.deleteCredential('run');
      store.deleteAvailability('g');
      store.setCompletionReceipt('event', 'task', 'run', 'changed', '{}');
      throw Error('rollback');
    }), /rollback/);
    store.authenticate('run', 'original');
    assert.equal(store.availability()[0].reason, 'exhausted');
    const receipt = store.db.prepare('SELECT * FROM receipts WHERE id=?').get('event');
    assert.equal(receipt?.hash, 'completion-hash');
    assert.equal(receipt?.report_hash, 'report-hash');
    assert.deepEqual(JSON.parse(String(receipt?.report_response)), { hash: 'report-hash', response: { accepted: true } });
    store.deleteCredential('run');
    assert.throws(() => store.authenticate('run', 'original'), /Unauthorized callback/);
    assert.equal(store.deleteAvailability('g'), true);
    assert.equal(store.deleteAvailability('g'), false);
  } finally { store.close(); }
});

test('capacity membership agrees after incremental writes and a cold rebuild', () => {
  const { store, path, add } = fixture();
  const waiting = add('waiting');
  const interactive = add('interactive');
  const working = add('working');
  store.update(interactive.id, { interactive: true });
  store.update(working.id, { phase: 'working' });
  const expected = store.activeCapacityTasks().map(task => task.id);
  assert.ok(!expected.includes(waiting.id));
  assert.ok(expected.includes(interactive.id));
  assert.ok(expected.includes(working.id));
  store.close();
  const reopened = new Store(path);
  try { assert.deepEqual(reopened.activeCapacityTasks().map(task => task.id), expected); }
  finally { reopened.close(); }
});

test('retention candidates and purge use the same settled-history eligibility', () => {
  const { store, add } = fixture();
  try {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const settled = add('settled');
    const unfinished = add('unfinished');
    const archivePending = add('archive-pending');
    for (const task of [settled, unfinished, archivePending]) {
      store.update(task.id, { phase: task.id === unfinished.id ? 'working' : 'done' });
      store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(old, task.id);
    }
    const current = store.task(archivePending.id);
    store.update(current.id, { resolution: { ...current.resolution, archiveIntentWorkspaceId: 'workspace' } });
    assert.deepEqual(store.retentionCandidates().map(task => task.id), [settled.id]);
    assert.deepEqual(store.purgeOldTasks(), [settled.id]);
    assert.ok(store.taskOrNull(unfinished.id));
    assert.ok(store.taskOrNull(archivePending.id));
  } finally { store.close(); }
});
