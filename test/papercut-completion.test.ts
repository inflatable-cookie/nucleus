import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Papercuts } from '../core/planning/papercut-operations';
import { Leads } from '../core/planning/leads';
import { submissionSchema } from '../shared/contracts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cut-completion-'));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  const repository = { origin: 'owner/repo', path: '/fixture/repo' };
  store.putRepository(repository, null, '');
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Repair friction',
    repoPath: repository.path, planningCommit: 'a'.repeat(40), handoffPath: 'brief.md', originAgentId: 'owner' }),
  'host', 'brief', 'a'.repeat(40), {}, undefined, repository.origin);
  const cuts = new Papercuts(store);
  const cut = cuts.add({ repository, title: 'Friction', happened: 'It sticks', impact: 'Manual cleanup', filedBy: 'owner' });
  cuts.promote({ id: cut.id, taskId: task.id });
  const merged = () => ({ ...store.task(task.id).resolution, mergedCommit: 'b'.repeat(40) });
  return { task, cut, cuts, merged, get store() { return store; },
    reopen() { store.close(); store = new Store(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('merged task completion closes its promoted papercut atomically and persists one receipt', () => {
  const f = fixture(); try {
    const before = f.store.lead(f.cut.id);
    const done = f.store.update(f.task.id, { phase: 'done', prUrl: 'https://github.com/owner/repo/pull/9', resolution: f.merged() });
    const cut = f.store.papercut(f.cut.id);
    assert.equal(cut.state, 'closed'); assert.equal(cut.closedReason, 'completed');
    assert.equal(cut.closedAt, done.finishedAt); assert.equal(cut.taskId, f.task.id);
    assert.match(cut.note!, /pull\/9; merge commit b{40}/);
    assert.deepEqual(f.store.lead(f.cut.id).targets, before.targets);
    assert.equal(f.store.lead(f.cut.id).body, before.body);
    f.store.update(f.task.id, { reason: 'Closeout observed again' });
    assert.deepEqual(f.store.papercut(f.cut.id), cut);
    assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'papercut_completed').length, 1);
    f.reopen(); assert.deepEqual(f.store.papercut(f.cut.id), cut);
  } finally { f.close(); }
});

test('cancelled and unmerged done tasks leave their papercuts promoted', () => {
  for (const phase of ['cancelled', 'done'] as const) {
    const f = fixture(); try {
      f.store.update(f.task.id, { phase, prUrl: 'https://github.com/owner/repo/pull/9',
        ...(phase === 'cancelled' ? { resolution: f.merged() } : {}) });
      assert.equal(f.store.papercut(f.cut.id).state, 'promoted');
    } finally { f.close(); }
  }
});

test('manual closure and ordinary promoted leads are not overwritten', () => {
  const f = fixture(); try {
    const manual = f.cuts.close({ id: f.cut.id, reason: 'deprecated', note: 'Superseded explicitly' });
    const leads = new Leads(f.store);
    const lead = leads.add({ repositories: [{ origin: 'owner/repo', path: '/fixture/repo' }], title: 'Ordinary work', body: '', author: 'owner', lanes: [] });
    f.store.updateLead({ ...lead, state: 'promoted', targets: [{ kind: 'task', repository: 'owner/repo', reference: f.task.id, at: new Date().toISOString() }] });
    f.store.update(f.task.id, { phase: 'done', prUrl: 'https://github.com/owner/repo/pull/9', resolution: f.merged() });
    assert.deepEqual(f.store.papercut(f.cut.id), manual);
    assert.equal(f.store.lead(lead.id).state, 'promoted');
  } finally { f.close(); }
});

test('a surrounding transaction rollback preserves both task and promoted papercut', () => {
  const f = fixture(); try {
    assert.throws(() => f.store.transaction(() => {
      f.store.update(f.task.id, { phase: 'done', prUrl: 'https://github.com/owner/repo/pull/9', resolution: f.merged() });
      throw new Error('Abort closeout');
    }), /Abort closeout/);
    assert.equal(f.store.task(f.task.id).phase, 'queued');
    assert.equal(f.store.papercut(f.cut.id).state, 'promoted');
    assert.equal(f.store.events(f.task.id).filter(event => event.kind === 'papercut_completed').length, 0);
  } finally { f.close(); }
});

test('papercut-tagged lead targets use the same automatic completion', () => {
  const f = fixture(); try {
    const second = f.cuts.add({ repository: { origin: 'owner/repo', path: '/fixture/repo' }, title: 'Tagged lead', happened: 'Gap', impact: 'Time', filedBy: 'owner' });
    const lead = f.store.lead(second.id);
    const expanded = { ...lead, body: '# Approved task brief\n\nFull implementation and acceptance obligations.', version: lead.version + 1 };
    f.store.updateLead({ ...expanded, state: 'promoted', targets: [{ kind: 'task', repository: 'owner/repo', reference: f.task.id, at: new Date().toISOString() }] });
    const before = f.store.lead(second.id);
    f.store.update(f.task.id, { phase: 'done', prUrl: 'https://github.com/owner/repo/pull/9', resolution: f.merged() });
    const after = f.store.lead(second.id);
    const { state: oldState, closure: oldClosure, closedAt: oldClosedAt, updatedAt: oldUpdatedAt, ...preserved } = before;
    const { state, closure, closedAt, updatedAt, ...actual } = after;
    assert.deepEqual(actual, preserved, 'only closure fields may change on an expanded approved lead');
    assert.equal(f.store.papercut(second.id).closedReason, 'completed');
    assert.equal(f.store.papercut(f.cut.id).closedReason, 'completed');
  } finally { f.close(); }
});
