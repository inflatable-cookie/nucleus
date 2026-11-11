import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { submissionSchema } from '../shared/contracts';

test('next derives a queued prerequisite and capacity wait without writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nucleus-queue-next-'));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    const add = (name: string, dependsOn: string[] = []) => runtime.store.insert(submissionSchema.parse({
      submissionId: name, title: name, repoPath: '/fixture', planningCommit: 'a'.repeat(40), handoffPath: 'fixture.md', originAgentId: 'origin', dependsOn,
    }), 'host', 'brief', 'a'.repeat(40));
    const parent = add('parent'), child = add('child', [parent.id]);
    runtime.store.setMeta('paused', false);
    const version = runtime.store.task(child.id).version, events = runtime.store.eventsAll(child.id).length;
    assert.match(runtime.taskNext({ taskId: child.id }).reason, /Waiting for prerequisites/);
    assert.match(runtime.snapshot({}).tasks.find(task => task.id === child.id)!.reason, /Waiting for prerequisites/);
    assert.equal(runtime.store.task(child.id).version, version);
    assert.equal(runtime.store.eventsAll(child.id).length, events);
    runtime.store.setMeta('globalLimit', 0);
    runtime.store.update(parent.id, { phase: 'done' });
    assert.match(runtime.taskNext({ taskId: child.id }).reason, /Global concurrent task-slot limit reached/);
  } finally { await runtime.stop(); }
});

test('board exposes a bounded queue head and paged remainder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nucleus-queue-page-'));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    for (let i = 0; i < 12; i++) runtime.store.insert(submissionSchema.parse({
      submissionId: `page-${i}`, title: `Task ${i}`, repoPath: '/fixture', planningCommit: 'a'.repeat(40), handoffPath: 'fixture.md', originAgentId: 'origin',
    }), 'host', 'brief', 'a'.repeat(40));
    const board = runtime.uiSnapshot({});
    assert.ok(!('unchanged' in board));
    if ('unchanged' in board) return;
    assert.equal(board.tasks.length, 5);
    assert.equal(board.queuedCounts.find(item => item.repoPath === '/fixture')?.count, 12);
    const first = runtime.queuedPage({ repoPath: '/fixture', offset: 0, limit: 5 });
    const second = runtime.queuedPage({ repoPath: '/fixture', offset: first.nextOffset!, limit: 5 });
    const third = runtime.queuedPage({ repoPath: '/fixture', offset: second.nextOffset!, limit: 5 });
    assert.equal(third.nextOffset, null);
    assert.equal(new Set([...first.tasks, ...second.tasks, ...third.tasks].map(task => task.id)).size, 12);
  } finally { await runtime.stop(); }
});

test('queued tasks remain pageable after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nucleus-queue-restart-'));
  let runtime = new QueueRuntime({ dataDir: dir, timers: false });
  const ids: string[] = [];
  try {
    for (let i = 0; i < 14; i++) {
      ids.push(runtime.store.insert(submissionSchema.parse({ submissionId: `restart-${i}`, title: `Task ${i}`, repoPath: '/fixture', planningCommit: 'a'.repeat(40), handoffPath: 'fixture.md', originAgentId: 'origin' }), 'host', 'brief', 'a'.repeat(40)).id);
    }
  } finally { await runtime.stop(); }
  runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    const first = runtime.queuedPage({ repoPath: '/fixture', offset: 0, limit: 8 });
    const second = runtime.queuedPage({ repoPath: '/fixture', offset: first.nextOffset!, limit: 8 });
    assert.deepEqual(new Set([...first.tasks, ...second.tasks].map(task => task.id)), new Set(ids));
    assert.equal(second.nextOffset, null);
  } finally { await runtime.stop(); }
});
