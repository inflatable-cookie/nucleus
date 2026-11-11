import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { submissionSchema, outcomeLookupSchema, detail, taskNumberLabel, summarizeTask } from '../shared/contracts';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';
import { workerPrompt } from '../core/dispatch/prompts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-numbers-'));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path);
  let sequence = 0;
  const add = (origin = 'alice/alpha') => {
    const id = `submission-${++sequence}`;
    const input = submissionSchema.parse({ submissionId: id, title: `Task ${id}`, repoPath: '/fixture/alpha', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
    return { input, task: store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, origin) };
  };
  return { path, get store() { return store; }, add, reopen() { store.close(); store = new Store(path); }, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Spec 021 #1 first accepted task starts at one and later tasks count up', () => {
  const f = fixture(); try {
    assert.deepEqual([f.add().task.number, f.add().task.number, f.add().task.number], [1, 2, 3]);
  } finally { f.close(); }
});

test('Spec 021 #2 repositories have independent sequences and distinct references', () => {
  const f = fixture(); try {
    assert.equal(f.add('alice/alpha').task.reference, 'alpha#001');
    assert.equal(f.add('bob/beta').task.reference, 'beta#001');
    assert.equal(f.add('alice/alpha').task.reference, 'alpha#002');
  } finally { f.close(); }
});

test('Spec 021 #3 refusal rolls back assignment and preview does not touch the live counter', () => {
  const f = fixture(); try {
    const first = f.add();
    assert.throws(() => f.store.insert({ ...first.input, submissionId: 'bad', dependsOn: ['missing'] }, 'host', 'handoff', 'a'.repeat(40)), /Prerequisite/);
    assert.equal(f.store.db.prepare('SELECT next_number FROM task_number_counters WHERE repository=?').get('alice/alpha')?.next_number, 2);
    assert.equal(f.add().task.number, 2);
  } finally { f.close(); }
});

test('Spec 021 #4 replayed submission keeps its task and number', () => {
  const f = fixture(); try {
    const first = f.add();
    assert.deepEqual(f.store.insert(first.input, 'host', 'handoff', 'a'.repeat(40)).id, first.task.id);
    assert.equal(f.store.existing(first.input)?.number, 1);
    assert.equal(f.add().task.number, 2);
  } finally { f.close(); }
});

test('Spec 021 #6 terminal and purged tasks never release a number; outcome resolves by reference', () => {
  const f = fixture(); try {
    const first = f.add().task;
    f.store.update(first.id, { phase: 'cancelled' });
    const finished = f.store.task(first.id);
    f.store.update(first.id, { removedAt: new Date(0).toISOString() }, undefined, '', finished.version);
    f.store.purgeOldTasks(Date.now() + 30 * 86400000);
    assert.equal(f.store.taskIdByNumber({ reference: 'alpha#1' }), first.id);
    assert.equal(f.store.outcome(first.id)?.reference, 'alpha#001');
    assert.equal(f.add().task.number, 2);
  } finally { f.close(); }
});

test('Spec 021 #8 reference and repository-number lookups resolve; unknown reference fails', () => {
  const f = fixture(); try {
    const task = f.add().task;
    assert.equal(f.store.taskIdByNumber({ reference: 'alpha#1' }), task.id);
    assert.equal(f.store.taskIdByNumber({ reference: 'alpha#001' }), task.id, 'zero-filled and plain references resolve alike');
    assert.equal(f.store.resolveTaskId('alice/alpha#1'),task.id);
    assert.ok(detail.input.safeParse({reference:'alice/alpha#1'}).success);
    assert.ok(detail.input.safeParse({ reference: 'alpha#001' }).success);
    assert.equal(f.store.taskIdByNumber({ repository: 'alice/alpha', number: 1 }), task.id);
    assert.throws(() => f.store.taskIdByNumber({ reference: 'alpha#2' }), /not found/);
    assert.ok(detail.input.safeParse({ reference: 'alpha#1' }).success);
    assert.ok(outcomeLookupSchema.safeParse({ repository: 'alice/alpha', number: 1 }).success);
    const sameName = f.add('bob/alpha').task;
    assert.equal(sameName.number, 1);
    assert.throws(() => f.store.taskIdByNumber({ reference: 'alpha#1' }), /Ambiguous/);
    assert.equal(f.store.resolveTaskId('bob/alpha#1'),sameName.id);
    assert.equal(f.store.taskIdByNumber({ repository: 'bob/alpha', number: 1 }), sameName.id);
  } finally { f.close(); }
});

test('Spec 021 #9 workspace title retains number across phase changes', () => {
  const f = fixture(); try {
    const task = f.add().task;
    assert.equal(taskWorkspaceTitle(task), 'Queued: 001 Task submission-1');
    assert.equal(taskWorkspaceTitle({ ...task, phase: 'working' }), 'Working: 001 Task submission-1');
    assert.equal(taskWorkspaceTitle({ ...task, phase: 'awaiting_review' }), 'Review: 001 Task submission-1');
  } finally { f.close(); }
});

test('Spec 021 #10 board summary renders local and cross-repository labels', () => {
  const f = fixture(); try {
    const task = f.add().task;
    const summary = summarizeTask(task);
    assert.equal(summary.number, 1);
    assert.equal(taskNumberLabel(summary, false), '#001');
    assert.equal(taskNumberLabel(summary, true), 'alpha#001');
  } finally { f.close(); }
});

test('Spec 021 #11 schema 50 upgrade preserves creation order and counters', () => {
  const f = fixture(); try {
    const first = f.add().task, second = f.add().task, other = f.add('bob/beta').task;
    f.store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    f.store.setMeta('schema', 50);
    f.reopen();
    assert.deepEqual([f.store.task(first.id).number, f.store.task(second.id).number, f.store.task(other.id).number], [1, 2, 1]);
    f.reopen();
    assert.equal(f.store.task(second.id).reference, 'alpha#002');
    assert.equal(f.add().task.number, 3);
  } finally { f.close(); }
});

test('Spec 021 #12 worker prompt carries number and bare-number PR title', () => {
  const f = fixture(); try {
    const task = f.add().task;
    const prompt = workerPrompt(task);
    assert.match(prompt, /Task number: alpha#001 \(001\)/);
    assert.match(prompt, /Start the PR title with the bare task number, for example `001:/);
    assert.match(prompt, /Do not use `#001`/);
  } finally { f.close(); }
});
