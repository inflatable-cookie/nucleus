import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA, RECLAIM_DRAIN_BUDGET_MS, RECLAIM_DRAIN_FREE_PAGES, RECLAIM_DRAIN_MAX_PAGES, Store } from '../core/store/store';
import { outcomeSchema, projectQaRunSchema, submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';

/**
 * Lean store 4 (task 989): the retired row fields and the workspace creation-step events
 * go. Schema 54 strips them from stored rows on every open (the one-time backlog and any
 * row a rolled-back build wrote are one rule set), the writers stop adding them, and the
 * freed pages drain on every maintenance tick while the freelist exceeds the threshold.
 */

const HEAD = 'a'.repeat(40);
const author: Profile = { id: 'author', name: 'author', provider: 'test', model: 'author', notes: '', available: true, problem: '', supportedThinking: [] };

function fixture(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nsq-lean4-${name}-`)));
  const store = new Store(join(dir, 'queue.sqlite'));
  const task = store.insert(submissionSchema.parse({ submissionId: 'task', title: 'Task', repoPath: join(dir, 'repo'),
    planningCommit: HEAD, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', HEAD);
  return { dir, store, task: task as Task, close() { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

const rowData = (store: Store, table: string, key: string, column = 'id') =>
  String((store.db.prepare(`SELECT data FROM ${table} WHERE ${column}=?`).get(key) as { data: string }).data);
const patchRow = (store: Store, table: string, key: string, patch: Record<string, unknown>, column = 'id') => {
  const raw = JSON.parse(rowData(store, table, key, column)) as Record<string, unknown>;
  store.db.prepare(`UPDATE ${table} SET data=? WHERE ${column}=?`).run(JSON.stringify({ ...raw, ...patch }), key);
};

test('schema 54 strips the retired row fields and creation-step events on open', t => {
  const f = fixture('strip');
  const path = join(f.dir, 'queue.sqlite');
  let store = f.store;
  try {
    // The rows a rolled-back older build writes: the schema defaults it still adds and
    // the write-only run field.
    patchRow(store, 'tasks', f.task.id, {
      extraReplacements: [{ id: 'grant', via: 'restart', grantedAt: '2026-01-01T00:00:00.000Z', grantedBy: 'operator', authority: 'operator', note: null, reason: 'historical', profileId: 'author', retirements: 8, status: 'granted', consumedAt: null, consumedRetirements: null, supersededAt: null }],
      resolution: { ...store.task(f.task.id).resolution, mechanicalReviewCarry: { status: 'eligible' }, authorEscalations: [{ id: 'esc', status: 'completed' }] },
    });
    store.putRun({ id: 'run', taskId: f.task.id, role: 'reviewer', generation: 1, head: HEAD, base: HEAD, instruction: 'review',
      agentId: 'reviewer', workspaceId: 'ws', profile: author, status: 'running', createdAt: '2026-11-01T00:00:00.000Z',
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
      reviewScopeDigest: 'b'.repeat(64), formalReviewerLogin: 'reviewer-login' } as unknown as Run);
    // putQaRun and putOutcome parse strictly, so their retired fields go in as raw bytes —
    // exactly the shape an older build left on disk.
    store.putQaRun(projectQaRunSchema.parse({ id: 'qa', repository: { origin: 'owner/repo', path: '/repo' }, key: '/repo', state: 'passed', baseBranch: 'main',
      base: HEAD, argv: ['effigy', 'qa'], digest: 'c'.repeat(64), exitCode: 0, durationMs: 1, outputTail: '',
      startedAt: '2026-11-01T00:00:00.000Z', submittedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:00:01.000Z',
      pid: null, capacityWait: null, capacityUnavailable: false, queuePosition: null, steps: [], failedStep: null,
      logWriteErrors: [], interruptedStep: null, hostSettlement: null, escapedDescendants: [], cancelReason: null }));
    patchRow(store, 'project_qa_runs', 'qa', { queueCapacityDeadlineAt: '2026-11-01T01:00:00.000Z' });
    store.putOutcome(outcomeSchema.parse({ taskId: 'outcome-task', submissionId: 's-outcome-task', title: 'Task', repository: { origin: 'owner/repo', path: '/repo' },
      outcome: 'done', reason: 'Merged', pr: null, mergeCommit: 'c'.repeat(40), syncedCommit: null, review: null, validation: null, closeout: null,
      brief: { digest: `sha256:${'d'.repeat(64)}`, mediaType: 'text/markdown', text: 'B', source: 'handoff', version: null, earlierDigests: [] },
      workers: [], reviewers: [], siblings: [], startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z', backfilled: false,
      lanes: [] }));
    patchRow(store, 'outcomes', 'outcome-task', {
      routing: { capability: 'mechanical', complexity: null, preferredProfileId: '', requirePreferred: false, thinkingOptionId: '' },
      stageRuns: [{ stageId: 'stage', runId: 'run', subject: {}, result: 'advanced', at: '2026-11-01T00:00:00.000Z' }],
    }, 'taskId');
    store.db.prepare("INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)").run(f.task.id, '2026-11-01T00:00:00.000Z', 'workspace_creation_step_finished', '{"step":"worktree_inspection"}');
    assert.equal(Number((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind GLOB 'workspace_creation_step_*'").get() as { n: number }).n), 1, 'the fixture carries the event row the step deletes');
    store.close();

    store = new Store(path);
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA, 'the store migrates to the current schema');
    const resolution = store.task(f.task.id).resolution as unknown as Record<string, unknown>;
    assert.equal('mechanicalReviewCarry' in resolution, false, 'the retired carry record is stripped');
    assert.equal('authorEscalations' in resolution, false, 'the retired escalation history is stripped');
    assert.equal('extraReplacements' in (store.task(f.task.id) as unknown as Record<string, unknown>), false, 'the retired grant history is stripped');
    const run = store.runs(f.task.id)[0]!;
    assert.equal('reviewScopeDigest' in run, false, 'the retired reviewer digest is stripped');
    assert.equal('formalReviewerLogin' in run, false, 'the write-only reviewer login is stripped');
    assert.equal('queueCapacityDeadlineAt' in (store.qaRun('qa') as unknown as Record<string, unknown>), false, 'the write-only QA capacity deadline is stripped');
    const outcome = store.outcomes().find(row => row.taskId === 'outcome-task')!;
    assert.equal(outcome.routing?.scope, 'mechanical', 'the legacy routing spelling reads through the one-time rewrite');
    assert.equal('stageRuns' in (JSON.parse(rowData(store, 'outcomes', 'outcome-task', 'taskId')) as Record<string, unknown>), false, 'the retired stage history is stripped');
    assert.equal(Number((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind GLOB 'workspace_creation_step_*'").get() as { n: number }).n), 0, 'the creation-step events are deleted');
    // Unrelated rows are untouched: the events the lifecycle reads survive.
    store.event(f.task.id, 'submitted', 'origin');
    assert.equal(store.eventsAll(f.task.id).at(-1)?.kind, 'submitted');
  } catch (error) { try { store.close(); } catch { /* already closed */ } throw error; }
  try { store.close(); } catch { /* already closed */ }
  rmSync(f.dir, { recursive: true, force: true });
});

test('a clean open is byte-identical: the strip changes no row it does not have to', t => {
  const f = fixture('clean');
  try {
    const before = rowData(f.store, 'tasks', f.task.id);
    const eventsBefore = f.store.db.prepare('SELECT id,taskId,at,kind,detail FROM events ORDER BY id').all();
    f.store.close();
    const store = new Store(join(f.dir, 'queue.sqlite'));
    try {
      assert.equal(rowData(store, 'tasks', f.task.id), before, 'the task row is untouched');
      assert.deepEqual(store.db.prepare('SELECT id,taskId,at,kind,detail FROM events ORDER BY id').all(), eventsBefore, 'no event row is touched');
    } finally { store.close(); }
  } finally { f.close(); }
});

test('a large freelist drains within the tick budget until it falls below the threshold', t => {
  const f = fixture('drain');
  try {
    // A prune-sized backlog: many row pages freed at once, then released through the drain bounds.
    const insert = f.store.db.prepare('INSERT INTO verb_outcomes(taskId,at,action,outcome,source,detail) VALUES(?,?,?,?,?,?)');
    f.store.transaction(() => {
      for (let index = 0; index < 30_000; index++)
        insert.run(f.task.id, '2026-11-01T00:00:00.000Z', 'move', 'applied', 'owner', JSON.stringify({ index, detail: 'd'.repeat(1_500) }));
    });
    f.store.db.prepare('DELETE FROM verb_outcomes').run();
    const freeBefore = f.store.storeFacts().freePages;
    const pagesBefore = f.store.storeFacts().pageCount;
    assert.ok(freeBefore > RECLAIM_DRAIN_FREE_PAGES, `the fixture freelist exceeds the drain threshold (got ${freeBefore})`);
    const started = performance.now();
    let ticks = 0;
    while (f.store.storeFacts().freePages > RECLAIM_DRAIN_FREE_PAGES && ticks < 64) {
      // One maintenance tick's pass, at the bounds the sweep picks above the threshold.
      const result = f.store.reclaimFreedPages({ maxPages: RECLAIM_DRAIN_MAX_PAGES, budgetMs: RECLAIM_DRAIN_BUDGET_MS });
      assert.equal(result.error, null, 'no release pass faults');
      ticks++;
    }
    const drainedMs = performance.now() - started;
    assert.ok(f.store.storeFacts().freePages <= RECLAIM_DRAIN_FREE_PAGES, 'the freelist drains to the threshold');
    assert.ok(drainedMs < 3_600_000 / 12, `the drain takes minutes, not the hours the hourly passes took (${Math.round(drainedMs)} ms over ${ticks} ticks)`);
    assert.ok(f.store.storeFacts().pageCount < pagesBefore, 'the file gave pages back');
  } finally { f.close(); }
});
