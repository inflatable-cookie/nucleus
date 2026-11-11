import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { completionSchema, submissionSchema, type Run, type Profile } from '../shared/contracts';

const head = 'a'.repeat(40);
const profile: Profile = { id: 'reviewer', name: 'reviewer', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };

test('shared review findings resolve from the run and survive a changed completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-text-review-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'text-test', title: 'Task', repoPath: '/repo', planningCommit: head, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff\r\n', head);
    const review = completionSchema.parse({ eventId: 'review', taskId: task.id, runId: 'run', status: 'changes_required', summary: 'fix', reviewText: 'Exact findings: café\n' });
    const run: Run = { id: 'run', taskId: task.id, role: 'reviewer', generation: 1, head, base: head, instruction: 'review', agentId: 'agent', workspaceId: 'ws', profile, status: 'finished', createdAt: '2026-11-01T00:00:00.000Z', lastObservedAt: null, active: false, idleSince: null, completion: review, released: false };
    store.putRun(run);
    store.update(task.id, { resolution: { ...store.task(task.id).resolution, review } });
    const raw = () => JSON.parse(String(store.db.prepare('SELECT data FROM task_reviews WHERE taskId=? AND seq=0').get(task.id)!.data));
    assert.equal(raw().reviewText, undefined);
    assert.equal(store.task(task.id).resolution.review?.reviewText, review.reviewText);
    store.putRun({ ...run, completion: { ...review, reviewText: 'New findings' } });
    assert.equal(raw().reviewText, review.reviewText);
    assert.equal(store.task(task.id).resolution.review?.reviewText, review.reviewText);
  } finally { store.close(); }
});
