import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { submissionSchema, type Project } from '../shared/contracts';
import {
  PROJECT_ACTIVITY_WINDOW_MS,
  isSubstantiveEventKind,
  projectActive,
  projectActivityRows,
  projectDormantByActivity,
  type ProjectActivity,
  type ProjectActivityFacts,
} from '../shared/project-activity';
import { projectSelectorRows } from '../shared/project-scope';

/** Spec 026 (nucleus#1446): one activity rule for the board selector and Planning. Oracle rows: recent without a planner, stale with a planner, executing, quiet, the threshold, a completion outside the visible page, and parked precedence. */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const head = 'a'.repeat(40);
const project = (key: string, path: string, extra: Partial<Project> = {}) => ({
  key, name: key, version: 1, visibility: 'active', repositories: [{ origin: null, path }], primary: { origin: null, path }, drain: null, ...extra,
}) as unknown as Project;
const planner = { agentId: 'planner-1', setBy: 'operator', setAt: iso(NOW - 60 * DAY) };
const emptyFacts: ProjectActivityFacts = { repositories: [], plans: [], executing: [] };
const submission = (id: string, repoPath: string) => submissionSchema.parse({
  submissionId: id, title: id, repoPath, planningCommit: head, handoffPath: `${id}.md`, originAgentId: 'origin',
});
const row = (rows: ProjectActivity[], key: string) => rows.find(item => item.key === key)!;

test('a project with recent activity and no planner is active', () => {
  const app = project('app', '/app');
  const facts: ProjectActivityFacts = { ...emptyFacts, repositories: [{ origin: null, path: '/app', at: iso(NOW - DAY) }] };
  const rows = projectActivityRows([app], facts);
  assert.equal(rows[0].activityAt, iso(NOW - DAY));
  assert.equal(projectDormantByActivity(app, rows[0], NOW), false);
});

test('a project with stale activity stays dormant even with a registered planner', () => {
  const app = project('app', '/app', { planner } as Partial<Project>);
  const facts: ProjectActivityFacts = { ...emptyFacts, repositories: [{ origin: null, path: '/app', at: iso(NOW - 6 * DAY) }] };
  const rows = projectActivityRows([app], facts);
  assert.equal(projectDormantByActivity(app, rows[0], NOW), true);
});

test('a project with an executing task is active whatever its activity age', () => {
  const app = project('app', '/app');
  const facts: ProjectActivityFacts = { ...emptyFacts, repositories: [{ origin: null, path: '/app', at: iso(NOW - 30 * DAY) }], executing: [{ origin: null, path: '/app' }] };
  const rows = projectActivityRows([app], facts);
  assert.equal(row(rows, 'app').executing, true);
  assert.equal(projectDormantByActivity(app, rows[0], NOW), false);
});

test('a quiet or never-used project is dormant with no activity time', () => {
  const quiet = project('quiet', '/quiet');
  const rows = projectActivityRows([quiet], emptyFacts);
  assert.equal(rows[0].activityAt, null);
  assert.equal(rows[0].executing, false);
  assert.equal(projectActive(rows[0], NOW), false);
  assert.equal(projectDormantByActivity(quiet, rows[0], NOW), true);
  assert.equal(projectDormantByActivity(quiet, undefined, NOW), true);
});

test('the five-day threshold is exclusive: a project just inside is active, one at or past it is dormant', () => {
  const app = project('app', '/app');
  const at = (ms: number) => projectActivityRows([app], { ...emptyFacts, repositories: [{ origin: null, path: '/app', at: iso(ms) }] })[0];
  assert.equal(PROJECT_ACTIVITY_WINDOW_MS, 5 * DAY);
  assert.equal(projectDormantByActivity(app, at(NOW - 5 * DAY + 1000), NOW), false, 'just under five days is active');
  assert.equal(projectDormantByActivity(app, at(NOW - 5 * DAY), NOW), true, 'exactly five days is dormant');
  assert.equal(projectDormantByActivity(app, at(NOW - 5 * DAY - 1000), NOW), true, 'past five days is dormant');
});

test('a parked project is never dormant, so it keeps its Parked group', () => {
  const parked = project('parked', '/parked', { visibility: 'parked' } as Partial<Project>);
  const recent: ProjectActivityFacts = { ...emptyFacts, repositories: [{ origin: null, path: '/parked', at: iso(NOW - DAY) }] };
  assert.equal(projectDormantByActivity(parked, projectActivityRows([parked], recent)[0], NOW), false);
  assert.equal(projectDormantByActivity(parked, projectActivityRows([parked], emptyFacts)[0], NOW), false);
  const rows = projectSelectorRows([parked], [], '', [], [], [], projectActivityRows([parked], emptyFacts), NOW);
  assert.equal(rows[0].visibility, 'parked');
  assert.equal(rows[0].dormant, false);
});

test('a plan version is deliberate planning activity and counts for its project', () => {
  const app = project('app', '/app');
  const rows = projectActivityRows([app], { ...emptyFacts, plans: [{ project: 'app', at: iso(NOW - DAY) }] });
  assert.equal(projectActive(rows[0], NOW), true);
});

test('repository membership uses origin when both sides know one, else the path', () => {
  const app = project('app', '/app', { repositories: [{ origin: 'owner/app', path: '/app' }] } as Partial<Project>);
  const byOrigin = projectActivityRows([app], { ...emptyFacts, repositories: [{ origin: 'owner/app', path: '/elsewhere', at: iso(NOW - DAY) }] });
  assert.equal(byOrigin[0].activityAt, iso(NOW - DAY));
  const otherOrigin = projectActivityRows([app], { ...emptyFacts, repositories: [{ origin: 'owner/other', path: '/app', at: iso(NOW - DAY) }] });
  assert.equal(otherOrigin[0].activityAt, null, 'a different origin is another repository even at the same path');
});

test('routine observation, bookkeeping and sweep event kinds never count', () => {
  for (const kind of ['agent_state', 'telemetry_stage', 'callback_reminder', 'project_planner_set', 'thread_archive_observed', 'operation_reconciled', 'transport_deferred', 'agent_message_expired'])
    assert.equal(isSubstantiveEventKind(kind), false, kind);
  for (const kind of ['submitted', 'dispatch', 'working', 'done', 'lane_changed', 'thread_archive_uncertain'])
    assert.equal(isSubstantiveEventKind(kind), true, kind);
});

test('the board selector groups by the same rule, and an omitted read keeps every project dormant', () => {
  const app = project('app', '/app');
  const quiet = project('quiet', '/quiet');
  const activity = projectActivityRows([app, quiet], { ...emptyFacts, repositories: [{ origin: null, path: '/app', at: iso(NOW - DAY) }] });
  const rows = projectSelectorRows([app, quiet], [], '', [], [], [], activity, NOW);
  assert.deepEqual(rows.map(item => [item.key, item.dormant]), [['app', false], ['quiet', true]]);
  assert.deepEqual(projectSelectorRows([app], [], '', [], [], [], [], NOW).map(item => item.dormant), [true]);
});

// --- Store-backed oracle: the persisted facts, read through the store's own write paths.

function fixture() {
  const store = new Store(':memory:');
  return { store, close: () => store.close() };
}
const readRows = (store: Store) => projectActivityRows(store.projects(), store.projectActivityFacts());
const ageEvents = (store: Store, taskId: string, at: string) => store.db.prepare('UPDATE events SET at=? WHERE taskId=?').run(at, taskId);

test('store: a fresh submission without a planner makes its project active', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    f.store.insert(submission('fresh', '/app'), 'host', 'handoff', head);
    const rows = readRows(f.store);
    assert.ok(row(rows, 'app').activityAt, 'the submission is recorded');
    assert.equal(projectActive(row(rows, 'app'), Date.now()), true);
  } finally { f.close(); }
});

test('store: routine events leave a stale project dormant, while a substantive event refreshes it', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    const task = f.store.insert(submission('stale', '/app'), 'host', 'handoff', head);
    ageEvents(f.store, task.id, iso(Date.now() - 10 * DAY));
    f.store.event(task.id, 'agent_state', 'routine observation');
    f.store.event(task.id, 'telemetry_stage', 'bookkeeping');
    f.store.event(task.id, 'callback_reminder', 'sweep');
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), false);
    f.store.event(task.id, 'lane_changed', 'a deliberate edit');
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), true);
  } finally { f.close(); }
});

test('store: executing work keeps a project active, and leaving execution returns it to the window', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    const task = f.store.insert(submission('running', '/app'), 'host', 'handoff', head);
    ageEvents(f.store, task.id, iso(Date.now() - 30 * DAY));
    f.store.update(task.id, { phase: 'working', reason: 'Working' });
    ageEvents(f.store, task.id, iso(Date.now() - 30 * DAY));
    assert.equal(row(readRows(f.store), 'app').executing, true);
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), true);
    f.store.update(task.id, { phase: 'blocked', reason: 'Blocked' });
    assert.equal(row(readRows(f.store), 'app').executing, false);
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), false);
  } finally { f.close(); }
});

test('store: a recent completion counts even when its task events are stale', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    const finished = f.store.insert(submission('finished', '/app'), 'host', 'handoff', head);
    f.store.update(finished.id, { phase: 'done', reason: 'Done' });
    ageEvents(f.store, finished.id, iso(Date.now() - 30 * DAY));
    const rows = readRows(f.store);
    assert.ok(row(rows, 'app').activityAt && Date.parse(row(rows, 'app').activityAt!) > Date.now() - DAY, 'the outcome time is the activity');
    assert.equal(projectActive(row(rows, 'app'), Date.now()), true);
  } finally { f.close(); }
});

test('store: a quiet project has no activity time, and a planner registration does not refresh it', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    f.store.upsertProject({ key: 'quiet', name: 'Quiet', repositories: [{ origin: null, path: '/quiet' }] });
    const task = f.store.insert(submission('old', '/app'), 'host', 'handoff', head);
    ageEvents(f.store, task.id, iso(Date.now() - 6 * DAY));
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-1', setBy: 'operator' });
    const rows = readRows(f.store);
    assert.equal(projectActive(row(rows, 'app'), Date.now()), false, 'stale with a planner stays dormant');
    assert.equal(row(rows, 'quiet').activityAt, null);
    assert.equal(projectActive(row(rows, 'quiet'), Date.now()), false);
  } finally { f.close(); }
});

test('store: an event written around the funnel is seen on the next read', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    const task = f.store.insert(submission('raw', '/app'), 'host', 'handoff', head);
    ageEvents(f.store, task.id, iso(Date.now() - 10 * DAY));
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), false);
    f.store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)').run(task.id, iso(Date.now() - 60_000), 'lane_changed', 'raw');
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), true);
  } finally { f.close(); }
});

test('store: an event in a rolled-back transaction does not refresh the project', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    const task = f.store.insert(submission('rolled', '/app'), 'host', 'handoff', head);
    ageEvents(f.store, task.id, iso(Date.now() - 10 * DAY));
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), false);
    assert.throws(() => f.store.transaction(() => {
      f.store.event(task.id, 'lane_changed', 'discarded');
      throw new Error('roll back');
    }), /roll back/);
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), false);
  } finally { f.close(); }
});

test('store: the threshold holds against persisted times, not only fixed clocks', () => {
  const f = fixture();
  try {
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: null, path: '/app' }] });
    const task = f.store.insert(submission('edge', '/app'), 'host', 'handoff', head);
    const minute = 60_000;
    ageEvents(f.store, task.id, iso(Date.now() - 5 * DAY + 2 * minute));
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), true, 'two minutes inside the window');
    ageEvents(f.store, task.id, iso(Date.now() - 5 * DAY - 2 * minute));
    assert.equal(projectActive(row(readRows(f.store), 'app'), Date.now()), false, 'two minutes past the window');
  } finally { f.close(); }
});
