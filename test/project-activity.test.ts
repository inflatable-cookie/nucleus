import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Leads } from '../core/planning/leads';
import { submissionSchema, type Project } from '../shared/contracts';
import {
  PROJECT_ACTIVE_ITEM_COUNT,
  PROJECT_ACTIVITY_WINDOW_MS,
  isSubstantiveEventKind,
  projectActive,
  projectActiveItemCount,
  projectActivityRows,
  projectDormantByActivity,
  type ActivityItemFact,
  type ActivityRepository,
  type ProjectActivity,
  type ProjectActivityFacts,
} from '../shared/project-activity';
import { projectSelectorRows } from '../shared/project-scope';

/**
 * Spec 026 (nucleus#1446, brief v3): one rule for the board selector and Planning. Active needs two
 * distinct recent work items within three days; a task and its linked leads are one item. Oracle: one
 * sweep task across lifecycle events and linked records stays Dormant, two items activate a project
 * without a planner, stale work with a planner stays Dormant, one of two items aging out restores
 * Dormant, plus the boundary, a never-used project, recent completion and parked precedence.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const head = 'a'.repeat(40);
const project = (key: string, path: string, extra: Partial<Project> = {}) => ({
  key, name: key, version: 1, visibility: 'active', repositories: [{ origin: null, path }], primary: { origin: null, path }, drain: null, ...extra,
}) as unknown as Project;
const planner = { agentId: 'planner-1', setBy: 'operator', setAt: iso(NOW - 60 * DAY) };
const item = (id: string, at: number, executing = false, repositories: ActivityRepository[] = [{ origin: null, path: '/app' }]): ActivityItemFact => ({ id, at: iso(at), executing, repositories });
const facts = (...items: ActivityItemFact[]): ProjectActivityFacts => ({ items });
const rowFor = (projects: Project[], f: ProjectActivityFacts, key: string): ProjectActivity => projectActivityRows(projects, f).find(row => row.key === key)!;
const submission = (id: string, repoPath: string) => submissionSchema.parse({
  submissionId: id, title: id, repoPath, planningCommit: head, handoffPath: `${id}.md`, originAgentId: 'origin',
});

test('two distinct recent items activate a project without a planner', () => {
  const app = project('app', '/app');
  const row = rowFor([app], facts(item('one', NOW - DAY), item('two', NOW - 2 * DAY)), 'app');
  assert.equal(projectActiveItemCount(row, NOW), 2);
  assert.equal(projectDormantByActivity(app, row, NOW), false);
});

test('one recent sweep item stays Dormant, including while it is executing', () => {
  const app = project('app', '/app');
  const recent = rowFor([app], facts(item('sweep', NOW - DAY)), 'app');
  assert.equal(projectDormantByActivity(app, recent, NOW), true);
  const running = rowFor([app], facts(item('sweep', NOW - 30 * DAY, true)), 'app');
  assert.equal(projectActiveItemCount(running, NOW), 1, 'one executing item is still one item');
  assert.equal(projectDormantByActivity(app, running, NOW), true);
});

test('one executing item and one recent item activate a project', () => {
  const app = project('app', '/app');
  const row = rowFor([app], facts(item('running', NOW - 30 * DAY, true), item('recent', NOW - DAY)), 'app');
  assert.equal(projectActive(row, NOW), true);
});

test('an item counts once: duplicate ids are one item', () => {
  const app = project('app', '/app');
  const row = rowFor([app], facts(item('same', NOW - DAY), item('same', NOW - 2 * DAY)), 'app');
  assert.equal(projectActiveItemCount(row, NOW), 1);
  assert.equal(projectDormantByActivity(app, row, NOW), true);
});

test('stale work with a registered planner stays Dormant', () => {
  const app = project('app', '/app', { planner } as Partial<Project>);
  const row = rowFor([app], facts(item('old-one', NOW - 6 * DAY), item('old-two', NOW - 10 * DAY)), 'app');
  assert.equal(projectDormantByActivity(app, row, NOW), true);
});

test('one of two items aging out restores Dormant', () => {
  const app = project('app', '/app');
  const both = facts(item('a', NOW - DAY), item('b', NOW - 2 * DAY));
  assert.equal(projectActive(rowFor([app], both, 'app'), NOW), true);
  assert.equal(projectActive(rowFor([app], both, 'app'), NOW + 2 * DAY), false, 'both items are past three days by then');
  const later = rowFor([app], facts(item('a', NOW - DAY), item('b', NOW - 2.5 * DAY)), 'app');
  assert.equal(projectActiveItemCount(later, NOW + DAY), 1, 'item b ages out and item a remains');
  assert.equal(projectDormantByActivity(app, later, NOW + DAY), true);
});

test('the three-day boundary is exclusive: just inside counts, exactly three days does not', () => {
  const app = project('app', '/app');
  assert.equal(PROJECT_ACTIVITY_WINDOW_MS, 3 * DAY);
  assert.equal(PROJECT_ACTIVE_ITEM_COUNT, 2);
  const justInside = rowFor([app], facts(item('a', NOW - 3 * DAY + 1000), item('b', NOW - 3 * DAY + 1000)), 'app');
  assert.equal(projectActive(justInside, NOW), true);
  const atBoundary = rowFor([app], facts(item('a', NOW - 3 * DAY), item('b', NOW - 3 * DAY)), 'app');
  assert.equal(projectActive(atBoundary, NOW), false, 'exactly three days is dormant');
  const pastBoundary = rowFor([app], facts(item('a', NOW - 3 * DAY - 1000), item('b', NOW - 3 * DAY - 1000)), 'app');
  assert.equal(projectActive(pastBoundary, NOW), false);
});

test('a never-used project is dormant with no items', () => {
  const quiet = project('quiet', '/quiet');
  const row = rowFor([quiet], facts(item('elsewhere', NOW - DAY, false, [{ origin: null, path: '/app' }])), 'quiet');
  assert.deepEqual(row.items, []);
  assert.equal(projectDormantByActivity(quiet, row, NOW), true);
  assert.equal(projectDormantByActivity(quiet, undefined, NOW), true);
});

test('a parked project is never dormant, whatever its items', () => {
  const parked = project('parked', '/app', { visibility: 'parked' } as Partial<Project>);
  const row = rowFor([parked], facts(item('a', NOW - DAY), item('b', NOW - DAY)), 'parked');
  assert.equal(projectDormantByActivity(parked, row, NOW), false);
  assert.equal(projectDormantByActivity(parked, rowFor([parked], facts(), 'parked'), NOW), false);
  const rows = projectSelectorRows([parked], [], '', [], [], [], [row], NOW);
  assert.equal(rows[0].visibility, 'parked');
  assert.equal(rows[0].dormant, false);
});

test('repository membership uses origin when both sides know one, else the path', () => {
  const app = project('app', '/app', { repositories: [{ origin: 'owner/app', path: '/app' }] } as Partial<Project>);
  const byOrigin = rowFor([app], facts(item('a', NOW - DAY, false, [{ origin: 'owner/app', path: '/elsewhere' }])), 'app');
  assert.equal(byOrigin.items.length, 1);
  const otherOrigin = rowFor([app], facts(item('b', NOW - DAY, false, [{ origin: 'owner/other', path: '/app' }])), 'app');
  assert.deepEqual(otherOrigin.items, [], 'a different origin is another repository even at the same path');
});

test('the selector groups by the same rule, and an omitted read keeps every project dormant', () => {
  const app = project('app', '/app');
  const quiet = project('quiet', '/quiet');
  const activity = projectActivityRows([app, quiet], facts(item('a', NOW - DAY), item('b', NOW - DAY)));
  const rows = projectSelectorRows([app, quiet], [], '', [], [], [], activity, NOW);
  assert.deepEqual(rows.map(row => [row.key, row.dormant]), [['app', false], ['quiet', true]]);
  assert.deepEqual(projectSelectorRows([app], [], '', [], [], [], [], NOW).map(row => row.dormant), [true]);
});

test('routine observation, bookkeeping and sweep event kinds are never substantive', () => {
  for (const kind of ['agent_state', 'telemetry_stage', 'callback_reminder', 'project_planner_set', 'thread_archive_observed', 'operation_reconciled', 'transport_deferred', 'agent_message_expired'])
    assert.equal(isSubstantiveEventKind(kind), false, kind);
  for (const kind of ['submitted', 'dispatch', 'working', 'done', 'lane_changed', 'papercut_linked', 'thread_archive_uncertain'])
    assert.equal(isSubstantiveEventKind(kind), true, kind);
});

// --- Store-backed oracle: the persisted facts, read through the store's own write paths.

const fixture = () => new Store(':memory:');
const readRows = (store: Store, key: string) => rowFor(store.projects(), store.projectActivityFacts(), key);
const activeIn = (store: Store, key: string) => projectActive(readRows(store, key), Date.now());
const ageEvents = (store: Store, taskId: string, at: string) => store.db.prepare('UPDATE events SET at=? WHERE taskId=?').run(at, taskId);
const ageAll = (store: Store, at: string) => store.db.prepare('UPDATE events SET at=?').run(at);
const ago = (ms: number) => iso(Date.now() - ms);
const seedApp = (store: Store) => store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: 'owner/app', path: '/app' }] });
/** A task in the fixture repository: its origin is the project's, so membership is by origin as in production. */
const insertTask = (store: Store, id: string) => store.insert(submission(id, '/app'), 'host', 'handoff', head, {}, undefined, 'owner/app');

test('store: one sweep task across lifecycle events and a linked lead stays Dormant, while running and after', () => {
  const store = fixture();
  try {
    seedApp(store);
    const sweep = insertTask(store, 'sweep');
    const lead = new Leads(store).add({ repositories: [{ origin: 'owner/app', path: '/app' }], title: 'Sweep finding', body: 'Filing text', lanes: [], tags: [], author: 'fixture' });
    store.event(sweep.id, 'papercut_linked', lead.id);
    store.event(sweep.id, 'dispatch', 'dispatched');
    store.update(sweep.id, { phase: 'working', reason: 'Working' });
    store.event(sweep.id, 'lane_changed', 'lane edit');
    store.updateLead({ ...store.lead(lead.id), state: 'promoted', targets: [{ kind: 'task', repository: 'owner/app', reference: sweep.id, at: ago(0) }], updatedAt: ago(0) });
    assert.equal(readRows(store, 'app').items.length, 1, 'the task and its linked lead are one item');
    assert.equal(activeIn(store, 'app'), false, 'a single running sweep stays dormant');
    store.update(sweep.id, { phase: 'done', reason: 'Done' });
    assert.equal(readRows(store, 'app').items.length, 1);
    assert.equal(activeIn(store, 'app'), false, 'a single completed sweep stays dormant');
  } finally { store.close(); }
});

test('store: a papercut link event alone joins its lead to the task, so the pair is one item', () => {
  const store = fixture();
  try {
    seedApp(store);
    const task = insertTask(store, 'linked');
    const lead = new Leads(store).add({ repositories: [{ origin: 'owner/app', path: '/app' }], title: 'Promoted', body: 'Filing text', lanes: [], tags: [], author: 'fixture' });
    store.event(task.id, 'papercut_source_claimed', lead.id);
    assert.equal(readRows(store, 'app').items.length, 1, 'the claimed lead and its task are one item');
    assert.equal(activeIn(store, 'app'), false);
  } finally { store.close(); }
});

test('store: two independent items activate a project without a planner', () => {
  const store = fixture();
  try {
    seedApp(store);
    insertTask(store, 'first');
    assert.equal(activeIn(store, 'app'), false, 'one item is dormant');
    insertTask(store, 'second');
    assert.equal(readRows(store, 'app').items.length, 2);
    assert.equal(activeIn(store, 'app'), true);
  } finally { store.close(); }
});

test('store: an independent lead and a task are two items', () => {
  const store = fixture();
  try {
    seedApp(store);
    insertTask(store, 'task');
    new Leads(store).add({ repositories: [{ origin: 'owner/app', path: '/app' }], title: 'Own record', body: 'Filing text', lanes: [], tags: [], author: 'fixture' });
    assert.equal(readRows(store, 'app').items.length, 2);
    assert.equal(activeIn(store, 'app'), true);
  } finally { store.close(); }
});

test('store: two tasks linked to one lead are one item', () => {
  const store = fixture();
  try {
    seedApp(store);
    const first = insertTask(store, 'first');
    const second = insertTask(store, 'second');
    const lead = new Leads(store).add({ repositories: [{ origin: 'owner/app', path: '/app' }], title: 'Shared', body: 'Filing text', lanes: [], tags: [], author: 'fixture' });
    store.updateLead({ ...store.lead(lead.id), state: 'promoted', targets: [
      { kind: 'task', repository: 'owner/app', reference: first.id, at: ago(0) },
      { kind: 'task', repository: 'owner/app', reference: second.id, at: ago(0) },
    ], updatedAt: ago(0) });
    assert.equal(readRows(store, 'app').items.length, 1, 'both tasks and the lead form one item');
    assert.equal(activeIn(store, 'app'), false);
  } finally { store.close(); }
});

test('store: stale work with a registered planner stays Dormant', () => {
  const store = fixture();
  try {
    seedApp(store);
    for (const id of ['old-a', 'old-b']) {
      const task = insertTask(store, id);
      ageEvents(store, task.id, ago(4 * DAY));
    }
    store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    assert.equal(activeIn(store, 'app'), false);
  } finally { store.close(); }
});

test('store: one of two items aging out restores Dormant', () => {
  const store = fixture();
  try {
    seedApp(store);
    const first = insertTask(store, 'first');
    const second = insertTask(store, 'second');
    assert.equal(activeIn(store, 'app'), true);
    ageEvents(store, second.id, ago(4 * DAY));
    assert.equal(readRows(store, 'app').items.length, 1);
    assert.equal(activeIn(store, 'app'), false);
    void first;
  } finally { store.close(); }
});

test('store: a recent completion outside the visible page counts, however old its task events', () => {
  const store = fixture();
  try {
    seedApp(store);
    const done = [insertTask(store, 'done-a'), insertTask(store, 'done-b')];
    for (const task of done) {
      store.update(task.id, { phase: 'done', reason: 'Done' });
      ageEvents(store, task.id, ago(30 * DAY));
    }
    assert.equal(readRows(store, 'app').items.length, 2, 'the completions are the items');
    assert.equal(activeIn(store, 'app'), true);
  } finally { store.close(); }
});

test('store: the three-day boundary holds against persisted times', () => {
  const store = fixture();
  try {
    seedApp(store);
    const first = insertTask(store, 'edge-a');
    const second = insertTask(store, 'edge-b');
    const minute = 60_000;
    ageEvents(store, first.id, ago(3 * DAY - 2 * minute));
    ageEvents(store, second.id, ago(3 * DAY - 2 * minute));
    assert.equal(activeIn(store, 'app'), true, 'two minutes inside the window');
    ageEvents(store, second.id, ago(3 * DAY + 2 * minute));
    assert.equal(activeIn(store, 'app'), false, 'one item past the window leaves one');
  } finally { store.close(); }
});

test('store: a never-used project and a project with only routine events are dormant', () => {
  const store = fixture();
  try {
    seedApp(store);
    store.upsertProject({ key: 'quiet', name: 'Quiet', repositories: [{ origin: null, path: '/quiet' }] });
    const task = insertTask(store, 'routine');
    ageAll(store, ago(10 * DAY));
    store.event(task.id, 'agent_state', 'routine observation');
    store.event(task.id, 'telemetry_stage', 'bookkeeping');
    store.event(task.id, 'callback_reminder', 'sweep');
    assert.equal(activeIn(store, 'app'), false);
    assert.equal(readRows(store, 'quiet').items.length, 0);
    assert.equal(activeIn(store, 'quiet'), false);
  } finally { store.close(); }
});

test('store: an event written around the funnel is seen on the next read', () => {
  const store = fixture();
  try {
    seedApp(store);
    const first = insertTask(store, 'raw-a');
    const second = insertTask(store, 'raw-b');
    ageEvents(store, first.id, ago(10 * DAY));
    ageEvents(store, second.id, ago(10 * DAY));
    assert.equal(activeIn(store, 'app'), false);
    store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)').run(first.id, ago(60_000), 'lane_changed', 'raw');
    store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)').run(second.id, ago(60_000), 'lane_changed', 'raw');
    assert.equal(activeIn(store, 'app'), true);
  } finally { store.close(); }
});

test('store: an event in a rolled-back transaction does not count', () => {
  const store = fixture();
  try {
    seedApp(store);
    const first = insertTask(store, 'rolled-a');
    const second = insertTask(store, 'rolled-b');
    ageEvents(store, first.id, ago(10 * DAY));
    ageEvents(store, second.id, ago(10 * DAY));
    assert.equal(activeIn(store, 'app'), false);
    assert.throws(() => store.transaction(() => {
      store.event(first.id, 'lane_changed', 'discarded');
      store.event(second.id, 'lane_changed', 'discarded');
      throw new Error('roll back');
    }), /roll back/);
    assert.equal(activeIn(store, 'app'), false);
  } finally { store.close(); }
});
