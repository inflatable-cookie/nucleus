import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA, Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { workerPrompt } from '../core/dispatch/prompts';
import { runPrompt, checkpointPrompt, queueLaneBlock } from '../core/dispatch/prompts';
import { parseNorthstarDocument, submissionQueueFields } from '../core/planning/handoff';
import { submissionSchema, projectSchema, taskControlInputSchema, type Profile, type Run, type Task } from '../shared/contracts';
import { pipelineBoard } from '../shared/pipeline-board';
import { LANE_IDLE_CLOSE_MS, LANE_IDLE_CLOSE_NOTE } from '../core/planning/lanes';
import type { Adapter } from '../core/host';

/** Spec 019 acceptance oracle: one named test per row (1–20), under the 2026-09-26 many-to-many revision. */
const head = 'a'.repeat(40);
const profile: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const submission = (id: string, extra: Record<string, unknown> = {}) => submissionSchema.parse({
  submissionId: id, title: id, repoPath: extra.repoPath ?? '/repo-a', planningCommit: head, handoffPath: `${id}.md`, originAgentId: 'origin', ...extra,
});
function fixture() {
  const store = new Store(':memory:');
  const adapter = { profiles: async () => [profile], findAgents: async () => [], observe: observeIdle('ws') } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  return { store, engine, close: async () => { await engine.stop(); store.close(); } };
}
test('lane task pages include queued work beyond the board card page and report the full total', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('many'));
    for (let i = 0; i < 30; i++) f.store.insert(submission(`many-${i}`, { lanes: ['many'] }), 'host', 'handoff', head);
    const first = f.store.laneTaskPage('many', 0, 25);
    const second = f.store.laneTaskPage('many', first.nextOffset!, 25);
    assert.equal(first.total, 30);
    assert.equal(first.tasks.length, 25);
    assert.equal(first.nextOffset, 25);
    assert.equal(second.total, 30);
    assert.equal(second.tasks.length, 5);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.tasks, ...second.tasks].map(task => task.id)).size, 30);
  } finally { void f.close(); }
});
const laneInput = (key: string, repos: Array<{ origin: string; path: string }> = [{ origin: 'acme/alpha', path: '/repo-a' }]) => ({
  key, title: key.replaceAll('-', ' '), aim: `Done looks like ${key} shipped.`, repositories: repos,
});
const laneContext = (key: string) => ({ key, title: key.replaceAll('-', ' '), aim: `Done looks like ${key} shipped.` });
const boardRepoA = { origin: 'acme/alpha', path: '/repo-a' };
const boardRepoB = { origin: 'acme/beta', path: '/repo-b' };
const boardProject = (key: string, ...repositories: Array<{ origin: string; path: string }>) => ({ key, name: key, version: 1, visibility: 'active' as const, repositories, primary: repositories[0], drain: null });
const boardParkedProject = (key: string, ...repositories: Array<{ origin: string; path: string }>) => ({ ...boardProject(key, ...repositories), visibility: 'parked' as const });
test('1. Task submitted with a known lane key is attached, shown on the board and counted in the lane view', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('silo-adoption'));
    const task = f.store.insert(submission('laned', { lanes: ['silo-adoption'] }), 'host', 'handoff', head);
    assert.deepEqual(task.lanes, ['silo-adoption']);
    assert.deepEqual(task.laneContext, [laneContext('silo-adoption')]);
    const briefed = f.store.insert(submission('briefed', { lanes: ['silo-adoption'], brief: { text: 'Brief text for the lane attachment proof.' }, handoffPath: '' }), 'host', '', head);
    assert.deepEqual(briefed.lanes, ['silo-adoption']);
    const views = f.store.laneViews();
    assert.equal(views[0].key, 'silo-adoption');
    assert.equal(views[0].liveByPhase.queued, 2);
    const board = pipelineBoard({ projects: f.store.projects(), lanes: views, selection: [],  leads: [], tasks: [task, briefed] as never });
    assert.equal(board.counts.Queued, 2);
    assert.deepEqual(board.cards.Queued.map(card => card.lanes), [['silo-adoption'], ['silo-adoption']], 'each card keeps its lane membership');
  } finally { void f.close(); }
});

test('2. Unknown key, a done or abandoned lane, or a lane that does not list the repository is refused', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('known'));
    f.store.upsertLane(laneInput('closed-lane'));
    f.store.setLaneStatus('closed-lane', 'done');
    f.store.upsertLane(laneInput('abandoned-lane'));
    f.store.setLaneStatus('abandoned-lane', 'abandoned');
    assert.throws(() => f.store.insert(submission('unknown', { lanes: ['missing'] }), 'host', 'h', head), /Unknown lane key missing/);
    assert.throws(() => f.store.insert(submission('done-lane', { lanes: ['closed-lane'] }), 'host', 'h', head), /closed-lane is done/);
    assert.throws(() => f.store.insert(submission('abandoned', { lanes: ['abandoned-lane'] }), 'host', 'h', head), /abandoned-lane is abandoned/);
    assert.throws(() => f.store.insert(submission('wrong-repo', { lanes: ['known'], repoPath: '/other' }), 'host', 'h', head), /does not list this repository/);
    f.store.requireAttachableLanes(['known'], '/repo-a');
    assert.throws(() => f.store.requireAttachableLanes(['missing'], '/repo-a'), /Unknown lane key/);
  } finally { void f.close(); }
});

test('3. set_lane on a live task, including clearing it, changes only the lane', async () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    f.store.upsertLane(laneInput('beta'));
    const original = f.store.insert(submission('move', { lanes: ['alpha'] }), 'host', 'h', head);
    const moved = await f.engine.performTaskControl({ taskId: original.id, version: original.version, action: 'set_lane', lanes: ['alpha', 'beta'] });
    assert.deepEqual(moved.lanes, ['alpha', 'beta']);
    assert.deepEqual(moved.laneContext.map(context => context.key), ['alpha', 'beta']);
    assert.equal(moved.phase, original.phase);
    assert.equal(moved.held, original.held);
    assert.equal(moved.dependsOn.join(), original.dependsOn.join());
    assert.equal(moved.reason, original.reason);
    assert.equal(moved.agentId, original.agentId);
    const cleared = await f.engine.performTaskControl({ taskId: moved.id, version: moved.version, action: 'set_lane', lane: null });
    assert.deepEqual(cleared.lanes, []);
    assert.deepEqual(cleared.laneContext, []);
    assert.equal(cleared.phase, original.phase);
    assert.throws(() => taskControlInputSchema.parse({ taskId: cleared.id, version: cleared.version, action: 'hold', lane: 'alpha' }), /Lane is only valid for set_lane/);
  } finally { await f.close(); }
});

test('4. Lane closed while tasks run keeps them attached; the done lane is hidden once they finish', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('running'));
    const task = f.store.insert(submission('live', { lanes: ['running'] }), 'host', 'h', head);
    f.store.update(task.id, { phase: 'working', reason: 'Working' });
    f.store.setLaneStatus('running', 'done', 'Parked the line');
    const current = f.store.task(task.id);
    assert.deepEqual(current.lanes, ['running']);
    assert.equal(current.phase, 'working');
    // The Lanes table that hid closed lanes is retired (#866); the record keeps its status.
    assert.equal(f.store.laneViews().find(view => view.key === 'running')!.status, 'done');
    const finished = f.store.update(current.id, { phase: 'done', reason: 'Done' });
    assert.equal(f.store.laneViews().find(view => view.key === 'running')!.status, 'done');
    assert.deepEqual(f.store.outcome(finished.id)!.lanes, ['running']);
  } finally { void f.close(); }
});

test('5. Task purged after finishing still counts through the outcome row', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('history'));
    const task = f.store.insert(submission('finished', { lanes: ['history'] }), 'host', 'h', head);
    f.store.update(task.id, { phase: 'done', reason: 'Done', removedAt: new Date(0).toISOString() });
    assert.deepEqual(f.store.outcome(task.id)!.lanes, ['history']);
    const purged = f.store.purgeOldTasks(Date.now());
    assert.ok(purged.includes(task.id));
    assert.throws(() => f.store.task(task.id), /purged/);
    const view = f.store.laneViews().find(lane => lane.key === 'history')!;
    assert.equal(view.terminalCount, 1);
    assert.equal(view.recentOutcomes[0].taskId, task.id);
  } finally { void f.close(); }
});

test('6. Active lane with no live tasks stays visible with its last activity', () => {
  const f = fixture();
  try {
    const lane = f.store.upsertLane(laneInput('idle'));
    const views = f.store.laneViews();
    assert.equal(views[0].key, 'idle');
    assert.deepEqual(views[0].liveByPhase, {});
    assert.equal(views[0].lastActivityAt, lane.updatedAt);
    assert.equal(views[0].terminalCount, 0, 'an idle lane has no terminal outcomes');
    assert.equal(Object.values(views[0].liveByPhase).reduce((sum, count) => sum + count, 0), 0, 'and no live counts');
  } finally { void f.close(); }
});

test('7. Prompts carry the aim block only with a lane', () => {
  // The byte-for-byte handoff snapshot lives in briefs.test.ts; one copy is enough (lean audit 2026-10-15).
  const task = {
    id: 'task', runId: 'initial', title: 'Build', originAgentId: 'origin', coordinatorAgentId: null, dependsOn: [],
    branch: 'ns-task', baseBranch: 'main', handoffPath: 'handoff.md', planningCommit: head, retiredWorkers: [],
    skipPRReview: false, resolution: { pendingWorkerInstruction: null }, lanes: ['silo-adoption'], laneContext: [{ key: 'silo-adoption', title: 'Silo adoption', aim: 'Nucleus can see the line of work.' }],
  } as unknown as Task;
  const worker = workerPrompt(task, true);
  const reviewer = runPrompt(task, { id: 'rev', role: 'reviewer', generation: 1, head } as Run, '/helper', '/ticket', true);
  const checkpoint = checkpointPrompt(task, { ordinal: 1, createdAt: 'now', summary: 's', head } as any);
  for (const prompt of [worker, reviewer, checkpoint]) {
    assert.match(prompt, /Lane context — not scope authority: Silo adoption/);
    assert.match(prompt, /Nucleus can see the line of work/);
    assert.match(prompt, /grants no additional authority/);
  }
  const plain = { ...task, lanes: [], laneContext: [] } as unknown as Task;
  assert.equal(queueLaneBlock(plain), '');
  assert.doesNotMatch(workerPrompt(plain, true), /Lane context/);
});

test('8. Tasks without lanes and unused repositories keep Status grouping and empty prompt block', () => {
  const f = fixture();
  try {
    const task = f.store.insert(submission('plain'), 'host', 'h', head);
    assert.deepEqual(task.lanes, []);
    assert.deepEqual(task.laneContext, []);
    assert.equal(f.store.lanes().length, 0);
    const replay = f.store.insert(submission('plain'), 'host', 'h', head);
    assert.equal(replay.id, task.id);
    f.store.upsertLane(laneInput('later'));
    assert.throws(() => f.store.insert(submission('plain', { lanes: ['later'] }), 'host', 'h', head), /already used with different content/);
    const board = pipelineBoard({ projects: f.store.projects(), lanes: [], selection: [],  leads: [], tasks: [task] as never });
    assert.equal(board.counts.Queued, 1, 'unlaned live work is on the board like any other');
    assert.equal(queueLaneBlock(task), '');
  } finally { void f.close(); }
});

test('9. Duplicate origin is refused; a two-repository lane shows both tasks with repository chips', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.upsertLane(laneInput('dup', [
      { origin: 'acme/alpha', path: '/repo-a' }, { origin: 'acme/alpha', path: '/other' },
    ])), /Duplicate repository origin/);
    const lane = f.store.upsertLane(laneInput('span', [
      { origin: 'acme/alpha', path: '/repo-a' }, { origin: 'acme/beta', path: '/repo-b' },
    ]));
    const again = f.store.upsertLane(laneInput('span', [
      { origin: 'acme/alpha', path: '/repo-a' }, { origin: 'acme/beta', path: '/repo-b' },
    ]));
    assert.equal(again.id, lane.id);
    assert.equal(f.store.lanes().length, 1);
    const a = f.store.insert(submission('a', { lanes: ['span'], repoPath: '/repo-a' }), 'host', 'h', head);
    const b = f.store.insert(submission('b', { lanes: ['span'], repoPath: '/repo-b' }), 'host', 'h', head);
    const view = f.store.laneViews()[0];
    assert.equal(view.liveByRepository['/repo-a'], 1);
    assert.equal(view.liveByRepository['/repo-b'], 1);
    assert.equal(view.repositories.length, 2);
    assert.equal(Object.values(view.liveByPhase).reduce((sum, count) => sum + count, 0), 2);
  } finally { void f.close(); }
});

test('10. Lanes and attachment survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-lanes-'));
  const livePath = join(dir, 'live.sqlite');
  try {
    let store = new Store(livePath);
    store.upsertLane(laneInput('kept'));
    const kept = store.insert(submission('kept-task', { lanes: ['kept'] }), 'host', 'h', head);
    store.close();
    store = new Store(livePath);
    assert.equal(store.laneByKey('kept')!.title, 'kept');
    assert.deepEqual(store.task(kept.id).lanes, ['kept']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12. Removing a repository that still has live tasks in the lane is refused', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('span', [
      { origin: 'acme/alpha', path: '/repo-a' }, { origin: 'acme/beta', path: '/repo-b' },
    ]));
    f.store.insert(submission('live-a', { lanes: ['span'], repoPath: '/repo-a' }), 'host', 'h', head);
    assert.throws(() => f.store.upsertLane(laneInput('span', [{ origin: 'acme/beta', path: '/repo-b' }])), /still has live tasks/);
    f.store.upsertLane(laneInput('span', [
      { origin: 'acme/alpha', path: '/repo-a' }, { origin: 'acme/beta', path: '/repo-b' }, { origin: 'acme/gamma', path: '/repo-c' },
    ]));
    assert.equal(f.store.laneByKey('span')!.repositories.length, 3);
  } finally { void f.close(); }
});

test('13. Submission with a list of two lane keys, and with queue.lanes; lane and lanes together refused', () => {
  const frontmatter = (queue: string) => `---\ntitle: Laned\nqueue_approval: "Tom"\nqueue:\n${queue}\n---\n\nBrief body.\n`;
  const lane = parseNorthstarDocument(frontmatter('  lane: [alpha, beta]\n  scope: mechanical'), 'brief');
  assert.deepEqual(submissionQueueFields(lane.queue).lanes, ['alpha', 'beta']);
  const lanes = parseNorthstarDocument(frontmatter('  lanes: [alpha, beta]\n  scope: mechanical'), 'brief');
  assert.deepEqual(submissionQueueFields(lanes.queue).lanes, ['alpha', 'beta']);
  const single = parseNorthstarDocument(frontmatter('  lane: alpha\n  scope: mechanical'), 'brief');
  assert.deepEqual(submissionQueueFields(single.queue).lanes, ['alpha']);
  const none = parseNorthstarDocument(frontmatter('  lane: null\n  scope: mechanical'), 'brief');
  assert.deepEqual(submissionQueueFields(none.queue).lanes, []);
  const both = parseNorthstarDocument(frontmatter('  lane: alpha\n  lanes: [beta]\n  scope: mechanical'), 'brief');
  assert.throws(() => submissionQueueFields(both.queue), /not both/);

  const parsed = submissionSchema.parse({ submissionId: 'two', title: 'Two', repoPath: '/repo-a', planningCommit: head, handoffPath: 't.md', originAgentId: 'origin', lanes: ['alpha', 'beta'] });
  assert.deepEqual(parsed.lanes, ['alpha', 'beta']);
  assert.throws(() => submissionSchema.parse({ submissionId: 'dup', title: 'Dup', repoPath: '/repo-a', planningCommit: head, handoffPath: 'd.md', originAgentId: 'origin', lanes: ['alpha', 'alpha'] }), /Duplicate lane key/);
});

test('14. A list with one unknown, closed or non-listing key refuses the whole submission and attaches nothing', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    f.store.upsertLane(laneInput('beta'));
    f.store.upsertLane(laneInput('closed'));
    f.store.setLaneStatus('closed', 'done');
    assert.throws(() => f.store.insert(submission('partial-unknown', { lanes: ['alpha', 'missing'] }), 'host', 'h', head), /Unknown lane key missing/);
    assert.throws(() => f.store.insert(submission('partial-closed', { lanes: ['alpha', 'closed'] }), 'host', 'h', head), /closed is done/);
    assert.throws(() => f.store.insert(submission('partial-repo', { lanes: ['alpha', 'beta'], repoPath: '/repo-b' }), 'host', 'h', head), /does not list this repository/);
    assert.equal(f.store.tasks().length, 0, 'nothing is attached from a refused set');
    f.store.requireAttachableLanes(['alpha', 'beta'], '/repo-a');
    assert.throws(() => f.store.requireAttachableLanes(['alpha', 'missing'], '/repo-a'), /Unknown lane key missing/);
  } finally { void f.close(); }
});

test('15. set_lane replaces the full list; empty clears; single lane becomes one item; version checked; nothing else changes', async () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    f.store.upsertLane(laneInput('beta'));
    const original = f.store.insert(submission('replace', { lanes: ['alpha'], dependsOn: [] }), 'host', 'h', head);
    const full = await f.engine.performTaskControl({ taskId: original.id, version: original.version, action: 'set_lane', lanes: ['alpha', 'beta'] });
    assert.deepEqual(full.lanes, ['alpha', 'beta']);
    const changed = await f.engine.performTaskControl({ taskId: full.id, version: full.version, action: 'set_lane', lanes: ['beta'] });
    assert.deepEqual(changed.lanes, ['beta']);
    const emptied = await f.engine.performTaskControl({ taskId: changed.id, version: changed.version, action: 'set_lane', lanes: [] });
    assert.deepEqual(emptied.lanes, []);
    const single = await f.engine.performTaskControl({ taskId: emptied.id, version: emptied.version, action: 'set_lane', lane: 'alpha' });
    assert.deepEqual(single.lanes, ['alpha']);
    for (const field of ['phase', 'held', 'reason', 'agentId', 'branch', 'dependsOn'] as const)
      assert.deepEqual(single[field], original[field], `${field} is untouched by set_lane`);
    await assert.rejects(f.engine.performTaskControl({ taskId: single.id, version: original.version, action: 'set_lane', lanes: ['beta'] }), /refresh/);
    assert.throws(() => taskControlInputSchema.parse({ taskId: single.id, version: single.version, action: 'set_lane', lane: 'alpha', lanes: ['beta'] }), /not both/);
    assert.throws(() => taskControlInputSchema.parse({ taskId: single.id, version: single.version, action: 'set_lane' }), /requires a lane key/);
  } finally { await f.close(); }
});

test('16. A shared task shows one card on the board; an action acts on the one task; Status shows it once', async () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    f.store.upsertLane(laneInput('beta'));
    const task = f.store.insert(submission('shared', { lanes: ['alpha', 'beta'] }), 'host', 'h', head);
    const board = pipelineBoard({ projects: f.store.projects(), lanes: f.store.laneViews(), selection: [],  leads: [], tasks: [task] as never });
    assert.equal(board.counts.Queued, 1, 'counted once, whatever its lane count');
    const card = board.cards.Queued[0];
    assert.equal(card.id, task.id);
    assert.deepEqual(card.lanes, ['alpha', 'beta'], 'the card keeps both lanes for the task view');
    const moved = await f.engine.performTaskControl({ taskId: card.id, version: task.version, action: 'set_lane', lanes: ['beta'] });
    const after = pipelineBoard({ projects: f.store.projects(), lanes: f.store.laneViews(), selection: [],  leads: [], tasks: [moved] as never });
    assert.equal(f.store.laneViews().some(view => view.key === 'alpha'), true, 'the empty active lane keeps its record');
    assert.deepEqual(after.cards.Queued.map(item => item.lanes), [['beta']]);
    assert.equal(f.store.tasks().filter(item => item.id === task.id).length, 1, 'Status shows the task once');
  } finally { await f.close(); }
});

test('17. Counts with a shared task count it in each lane and once across lanes', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    f.store.upsertLane(laneInput('beta'));
    const task = f.store.insert(submission('shared', { lanes: ['alpha', 'beta'] }), 'host', 'h', head);
    const views = f.store.laneViews();
    assert.equal(views.find(lane => lane.key === 'alpha')!.liveByPhase.queued, 1);
    assert.equal(views.find(lane => lane.key === 'beta')!.liveByPhase.queued, 1);
    const boardTasks = f.store.uiTasks().filter(item => !['done', 'cancelled'].includes(item.phase));
    assert.equal(new Set(boardTasks.map(item => item.id)).size, 1, 'the board header counts each task once');
    assert.equal(boardTasks.filter(item => item.id === task.id).length, 1);
  } finally { void f.close(); }
});

test('18. Prompts for zero, one and two lanes: zero unchanged, one byte-identical, two in list order', () => {
  const base = {
    id: 'task', runId: 'initial', title: 'Build', originAgentId: 'origin', coordinatorAgentId: null, dependsOn: [],
    branch: 'ns-task', baseBranch: 'main', handoffPath: 'handoff.md', planningCommit: head, retiredWorkers: [],
    skipPRReview: false, resolution: { pendingWorkerInstruction: null },
  } as unknown as Task;
  const zero = { ...base, lanes: [], laneContext: [] } as unknown as Task;
  assert.equal(queueLaneBlock(zero), '');
  assert.doesNotMatch(workerPrompt(zero, true), /Lane context/);
  const one = { ...base, lanes: ['silo-adoption'], laneContext: [{ key: 'silo-adoption', title: 'Silo adoption', aim: 'Nucleus can see the line of work.' }] } as unknown as Task;
  // The pre-revision single-lane block, byte for byte.
  assert.equal(queueLaneBlock(one), 'Lane context — not scope authority: Silo adoption\nNucleus can see the line of work.\nThe handoff or brief still governs this task\'s scope. The lane aim grants no additional authority.\n');
  const two = { ...base, lanes: ['silo-adoption', 'beta-lane'], laneContext: [laneContext('silo-adoption'), laneContext('beta-lane')] } as unknown as Task;
  const block = queueLaneBlock(two);
  assert.equal((block.match(/Lane context — not scope authority:/g) ?? []).length, 2);
  assert.ok(block.indexOf('silo adoption') < block.indexOf('beta lane'), 'aim blocks follow the membership order');
  assert.match(block, /Done looks like silo-adoption shipped\./);
  assert.match(block, /Done looks like beta-lane shipped\./);
});

test('19. Schema 50 upgrade keeps task and outcome lanes, rows and completion time across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-lanes-migrate-'));
  const path = join(dir, 'queue.sqlite');
  try {
    let store = new Store(path);
    store.upsertLane(laneInput('alpha'));
    const task = store.insert(submission('migrated', { lanes: ['alpha'] }), 'host', 'h', head);
    store.update(task.id, { phase: 'done' });
    const finishedAt = store.outcome(task.id)!.finishedAt;
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('schema', 50);
    const taskCount = Number(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n);
    const outcomeCount = Number(store.db.prepare('SELECT COUNT(*) AS n FROM outcomes').get()!.n);
    store.close();
    store = new Store(path);
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA);
    assert.deepEqual(store.task(task.id).lanes, ['alpha']);
    assert.deepEqual(store.task(task.id).laneContext, [laneContext('alpha')]);
    assert.deepEqual(store.outcome(task.id)!.lanes, ['alpha']);
    assert.equal(store.outcome(task.id)!.finishedAt, finishedAt, 'the migration never re-dates an outcome row');
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n), taskCount, 'no task row is dropped');
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM outcomes').get()!.n), outcomeCount, 'no outcome row is dropped');
    assert.deepEqual(store.searchOutcomes({ lane: 'alpha' }).results.map(row => row.taskId), [task.id]);
    store.close();
    store = new Store(path);
    assert.deepEqual(store.task(task.id).lanes, ['alpha']);
    assert.deepEqual(store.outcome(task.id)!.lanes, ['alpha']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('20. Outcome search by lane finds a two-lane outcome under either key', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    f.store.upsertLane(laneInput('beta'));
    const task = f.store.insert(submission('two-lanes', { lanes: ['alpha', 'beta'] }), 'host', 'h', head);
    f.store.update(task.id, { phase: 'done' });
    assert.deepEqual(f.store.outcome(task.id)!.lanes, ['alpha', 'beta']);
    assert.deepEqual(f.store.searchOutcomes({ lane: 'alpha' }).results.map(row => row.taskId), [task.id]);
    assert.deepEqual(f.store.searchOutcomes({ lane: 'beta' }).results.map(row => row.taskId), [task.id]);
    assert.deepEqual(f.store.searchOutcomes({ lane: 'alpha' }).results[0].lanes, ['alpha', 'beta']);
  } finally { void f.close(); }
});

const DAY = 86400000;
/** Rewrite a lane's own timestamp so its idle age is exact; nothing else in it moves. */
function ageLane(store: Store, key: string, at: number) {
  const lane = store.laneByKey(key)!;
  store.db.prepare('UPDATE lanes SET data=? WHERE key=?').run(JSON.stringify({ ...lane, updatedAt: new Date(at).toISOString() }), key);
}
const papercut = (id: string, lanes: string[], extra: Record<string, unknown> = {}) => ({
  id, repository: { origin: 'acme/alpha', path: '/repo-a' }, area: null, title: id, happened: 'It broke.', impact: '', fix: null,
  filedBy: 'agent', filedAt: new Date().toISOString(), state: 'open' as const, taskId: null, closedReason: null, note: null, closedAt: null, source: null, lanes, ...extra,
});
const lead = (id: string, lanes: string[]) => {
  const stamp = new Date().toISOString();
  return { id, title: id, body: '', repositories: [{ origin: 'acme/alpha', path: '/repo-a' }], lanes, author: 'planner', state: 'open' as const, version: 1,
    dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: null };
};


test('21. Only the lane idle for 14 days closes; 13 days, a live task, an open lead, papercut or draft keep a lane open', () => {
  const f = fixture();
  try {
    const at = Date.now() + 30 * DAY;
    for (const key of ['idle', 'thirteen', 'live', 'lead', 'papercut', 'parked', 'recent-cut']) f.store.upsertLane(laneInput(key));
    f.store.setLaneStatus('parked', 'paused');
    const task = f.store.insert(submission('running', { lanes: ['live'] }), 'host', 'h', head);
    f.store.update(task.id, { phase: 'working', reason: 'Working' });
    f.store.addLead(lead('lead-1', ['lead']), 'planner');
    f.store.addPapercut(papercut('cut-1', ['papercut']));
    // A papercut resolved inside the window is activity, even though nothing is open now.
    f.store.addPapercut(papercut('cut-2', ['recent-cut'], { state: 'closed', closedReason: 'completed', closedAt: new Date(at - 2 * DAY).toISOString() }));
    ageLane(f.store, 'thirteen', at - 13 * DAY);
    const closed = f.store.closeIdleLanes(at);
    assert.deepEqual(closed, ['idle']);
    const idle = f.store.laneByKey('idle')!;
    assert.equal(idle.status, 'done');
    assert.equal(idle.note, LANE_IDLE_CLOSE_NOTE);
    assert.ok(idle.closedAt);
    for (const key of ['thirteen', 'live', 'lead', 'papercut', 'recent-cut']) assert.equal(f.store.laneByKey(key)!.status, 'active', key);
    assert.equal(f.store.laneByKey('parked')!.status, 'paused');
    // The auto-closed lane is done and the 13-day lane is still open.
    assert.equal(f.store.laneViews().find(view => view.key === 'idle')!.status, 'done');
    assert.equal(f.store.laneViews().find(view => view.key === 'thirteen')!.status, 'active');
    // Closing changed nothing about the task or records in other lanes, and a second pass is a no-op.
    assert.equal(f.store.task(task.id).phase, 'working');
    assert.deepEqual(f.store.closeIdleLanes(at), []);
    assert.deepEqual(f.store.closeIdleLanes(at + DAY - 60000), [], 'the 13-day lane closes only after its own 14 days');
    assert.deepEqual(f.store.closeIdleLanes(at + DAY + 1), ['thirteen']);
  } finally { void f.close(); }
});

test('21. The engine maintenance pass closes an idle lane', async () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('stale'));
    f.store.upsertLane(laneInput('fresh'));
    ageLane(f.store, 'stale', Date.now() - LANE_IDLE_CLOSE_MS - DAY);
    f.store.setMeta('paused', true);
    await f.engine.sweepOnce();
    assert.equal(f.store.laneByKey('stale')!.status, 'active', 'a paused Queue leaves lanes alone');
    f.store.setMeta('paused', false);
    await f.engine.sweepOnce();
    assert.equal(f.store.laneByKey('stale')!.status, 'done');
    assert.equal(f.store.laneByKey('fresh')!.status, 'active');
  } finally { await f.close(); }
});

test('22. An auto-closed lane reopens with lane.status active and its outcomes are still found', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('history'));
    const task = f.store.insert(submission('finished', { lanes: ['history'] }), 'host', 'h', head);
    f.store.update(task.id, { phase: 'done', reason: 'Done' });
    assert.deepEqual(f.store.closeIdleLanes(Date.now() + 15 * DAY), ['history']);
    assert.equal(f.store.laneByKey('history')!.status, 'done');
    assert.deepEqual(f.store.searchOutcomes({ lane: 'history' }).results.map(row => row.taskId), [task.id]);
    const reopened = f.store.setLaneStatus('history', 'active');
    assert.equal(reopened.status, 'active');
    assert.equal(reopened.closedAt, null);
    f.store.requireAttachableLanes(['history'], '/repo-a');
    assert.deepEqual(f.store.searchOutcomes({ lane: 'history' }).results.map(row => row.taskId), [task.id]);
    assert.equal(f.store.laneViews().find(lane => lane.key === 'history')!.terminalCount, 1);
    // Reopening is activity: the lane does not close again on the next pass.
    assert.deepEqual(f.store.closeIdleLanes(), []);
  } finally { void f.close(); }
});

test('a one-lane submission retry reconciles the pre-revision stored identity hash', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('alpha'));
    const original = submission('retry', { lanes: ['alpha'] });
    const task = f.store.insert(original, 'host', 'h', head);
    // The pre-revision hash put the single lane under the `lane` key, and that is
    // still what an in-flight retry of the same submission must recompute.
    const { skipPRReview, dependsOn, notifyOriginOnCloseout, completionNotificationAgentIds, instruction, brief, lanes, draftProvenance, leadProvenance, ...rest } = original;
    const legacyHash = digest(JSON.stringify({ ...rest, lane: 'alpha' }));
    f.store.db.prepare('UPDATE tasks SET input_hash=? WHERE id=?').run(legacyHash, task.id);
    assert.equal(f.store.existing(original)?.id, task.id);
    assert.equal(f.store.insert(original, 'host', 'h', head).id, task.id, 'the retry is idempotent');
  } finally { void f.close(); }
});

test('attachment matches a listed origin when the local path hint differs', () => {
  const f = fixture();
  try {
    f.store.upsertLane(laneInput('silo', [{ origin: 'acme/alpha', path: '/elsewhere' }]));
    assert.throws(() => f.store.insert(submission('path-only', { lanes: ['silo'] }), 'host', 'h', head), /does not list this repository/);
    const task = f.store.insert(submission('origin-match', { lanes: ['silo'] }), 'host', 'h', head, {}, undefined, 'acme/alpha');
    assert.deepEqual(task.lanes, ['silo']);
  } finally { void f.close(); }
});
