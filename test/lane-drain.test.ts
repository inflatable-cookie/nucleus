import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Leads } from '../core/planning/leads';
import { evaluateDrains } from '../core/planning/lanes';
import type { Adapter } from '../core/host';
import { laneKeepInputSchema, projectQaRunSchema, submissionSchema } from '../shared/contracts';
import { pipelineBoard } from '../shared/pipeline-board';
import type { Profile, Task } from '../shared/contracts';

/**
 * Spec 041 acceptance rows 5–10: drained lanes prompt their plan owner once per
 * episode, escalate to the operator's decisions view, and end on new work, a keep
 * or a close. A drained board gets the plan's next aim on the same rules but never
 * escalates (Tom, 2026-10-15).
 */

const head = 'a'.repeat(40);
const profile: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const submission = (id: string, extra: Record<string, unknown> = {}) => submissionSchema.parse({
  submissionId: id, title: id, repoPath: '/repo-a', planningCommit: head, handoffPath: `${id}.md`, originAgentId: 'origin', ...extra,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** A board drains when work finishes: give the project one task that just finished. */
const finishOne = (f: { store: Store }, id: string, repoPath = '/repo-a') => {
  const task = f.store.insert(submission(id, { repoPath }), 'host', 'h', head);
  f.store.update(task.id, { phase: 'done' });
};

function fixture() {
  const notified: Array<{ agentId: string; noticeId: string; text: string }> = [];
  const store = new Store(':memory:');
  const adapter = {
    profiles: async () => [profile], findAgents: async () => [],
    observe: observeIdle('ws'),
    notify: async (agentId: string, noticeId: string, text: string) => { notified.push({ agentId, noticeId, text }); },
  } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  engine.identifyOriginHost = async () => 'fixture-host';
  return { store, engine, leads: new Leads(store), notified, close: async () => { await engine.stop(); store.close(); } };
}

const repoA = { origin: 'acme/alpha', path: '/repo-a' };
/** A project with one lane planned by an agent, plus its lane document. */
function planFixture(f: ReturnType<typeof fixture>, owner = 'planner-agent') {
  f.store.upsertLane({ key: 'alpha', title: 'Alpha lane', aim: 'Done looks like alpha shipped.', repositories: [repoA] });
  f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA] }); f.store.setProjectPlanner({ key: 'app', agentId: 'planner-agent', setBy: 'test' });
  f.store.editLaneDocument({ key: 'alpha', version: 0, text: 'Alpha document.', author: owner });
  return f.store.setPlan({
    project: 'app', version: 0, author: owner,
    entries: [
      { lane: 'alpha', note: '', horizon: 'now' as const, doneWhen: 'Alpha shipped' },
    ],
  });
}

/** Backdate every activity source the lane view reads, so the lane looks untouched for an hour.
 * The store stamps terminal finishedAt with now(), so tasks and outcome rows are aged too. */
function backdate(f: ReturnType<typeof fixture>, minutes: number) {
  const at = minutesAgo(minutes);
  for (const lane of f.store.lanes()) {
    f.store.db.prepare('UPDATE lanes SET data=? WHERE key=?').run(JSON.stringify({ ...lane, createdAt: at, updatedAt: at }), lane.key);
  }
  f.store.db.prepare('UPDATE events SET at=?').run(at);
  for (const task of f.store.tasks()) {
    f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...task, updatedAt: at, ...(task.finishedAt ? { finishedAt: at } : {}) }), task.id);
  }
  for (const row of f.store.db.prepare('SELECT taskId, data FROM outcomes').all() as Array<{ taskId: string; data: string }>) {
    const outcome = JSON.parse(row.data) as { finishedAt: string | null };
    f.store.db.prepare('UPDATE outcomes SET data=? WHERE taskId=?').run(JSON.stringify({ ...outcome, finishedAt: at }), row.taskId);
  }
}

const drainNotices = (f: ReturnType<typeof fixture>) => f.store.pendingNotices().filter(n => n.kind === 'lane_drain' || n.kind === 'next_aim');
const laneNotices = (f: ReturnType<typeof fixture>) => drainNotices(f).filter(n => n.kind === 'lane_drain');
/** Keeps the project's board alive with a live task on an unplanned lane, so only the lane episode is under test. */
function keepBoardAlive(f: ReturnType<typeof fixture>) {
  f.store.upsertLane({ key: 'side', title: 'Side lane', aim: 'Done looks like side shipped.', repositories: [repoA] });
  f.store.insert(submission('side-work', { lanes: ['side'] }), 'host', 'h', head);
}
const decisionsCards = (f: ReturnType<typeof fixture>) => pipelineBoard({
  projects: f.store.projects(),
  lanes: f.store.laneViews(), selection: [],  leads: [], tasks: [],
}).cards.Decisions;

test('Spec 041 row 5: a lane whose last task finished with no leads prompts its plan owner once the drain time passes', () => {
  const f = fixture();
  try {
    planFixture(f);
    const task = f.store.insert(submission('last-task', { lanes: ['alpha'] }), 'host', 'h', head);
    f.store.update(task.id, { phase: 'done', finishedAt: minutesAgo(200) });
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    const notices = laneNotices(f);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.kind, 'lane_drain');
    assert.equal(notices[0]!.agentId, 'planner-agent');
    assert.match(notices[0]!.text, /Alpha lane \(alpha\)/);
    assert.match(notices[0]!.text, /Aim: Done looks like alpha shipped\./);
    assert.match(notices[0]!.text, /Done when: Alpha shipped/);
    assert.match(notices[0]!.text, /last-task — done/);
    assert.match(notices[0]!.text, /lane\.keep/);
    const lane = f.store.laneByKey('alpha')!;
    assert.ok(lane.drain?.since);
    assert.equal(lane.drain.notices, 1);
  } finally { void f.close(); }
});

test('Spec 041 row 6: the same drain does not send a second notice before escalation', () => {
  const f = fixture();
  try {
    planFixture(f);
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    assert.equal(laneNotices(f).length, 1);
    const first = f.store.laneByKey('alpha')!.drain!;
    f.store.evaluateLaneDrains();
    f.store.evaluateLaneDrains();
    assert.equal(laneNotices(f).length, 1, 'one notice per drain episode');
    assert.equal(f.store.laneByKey('alpha')!.drain!.since, first.since);
    assert.equal(f.store.laneByKey('alpha')!.drain!.escalatedAt, null);
  } finally { void f.close(); }
});

test('Spec 041 row 7: the escalation timer puts the lane on the Decisions view; Close finishes it and Keep needs a reason', () => {
  const f = fixture();
  try {
    planFixture(f);
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    // Age the episode past laneDrainEscalationMinutes (1440 by default; the test store uses 90).
    f.store.setMeta('laneDrainEscalationMinutes', 90);
    const lane = f.store.laneByKey('alpha')!;
    f.store.db.prepare('UPDATE lanes SET data=? WHERE key=?').run(JSON.stringify({ ...lane, drain: { ...lane.drain!, since: minutesAgo(91) } }), 'alpha');
    f.store.evaluateLaneDrains();
    assert.ok(f.store.laneByKey('alpha')!.drain?.escalatedAt);
    const card = decisionsCards(f).find(card => card.kind === 'lane_drain' && card.value.key === 'alpha');
    assert.ok(card, 'the escalated lane joins the Decisions column');
    // Keep needs its reason at the contract boundary.
    assert.equal(laneKeepInputSchema.safeParse({ key: 'alpha', reason: '  ' }).success, false);
    assert.equal(laneKeepInputSchema.safeParse({ key: 'alpha' }).success, false);
    // Close ends the episode and clears the item.
    f.store.setLaneStatus('alpha', 'done');
    assert.equal(f.store.laneByKey('alpha')!.drain, null);
    assert.equal(decisionsCards(f).some(card => card.kind === 'lane_drain'), false);
  } finally { void f.close(); }
});

test('Spec 041 row 8: new work or an open lead on a drained lane ends the episode and clears the item', () => {
  const f = fixture();
  try {
    planFixture(f);
    f.store.setMeta('laneDrainEscalationMinutes', 90);
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    const lane = f.store.laneByKey('alpha')!;
    f.store.db.prepare('UPDATE lanes SET data=? WHERE key=?').run(JSON.stringify({ ...lane, drain: { ...lane.drain!, since: minutesAgo(91), escalatedAt: minutesAgo(1) } }), 'alpha');
    assert.ok(decisionsCards(f).some(card => card.kind === 'lane_drain'));
    const task = f.store.insert(submission('more-work', { lanes: ['alpha'] }), 'host', 'h', head);
    f.store.evaluateLaneDrains();
    assert.equal(f.store.laneByKey('alpha')!.drain, null, 'a new task ends the episode');
    assert.equal(decisionsCards(f).some(card => card.kind === 'lane_drain'), false);
    f.store.update(task.id, { phase: 'done', finishedAt: minutesAgo(200) });
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    assert.ok(f.store.laneByKey('alpha')!.drain, 'the lane drains again as a new episode');
    const lead = f.leads.add({ repositories: [repoA], title: 'Lead toward alpha', body: 'Toward the aim.', lanes: ['alpha'], author: 'planner-agent' });
    f.store.evaluateLaneDrains();
    assert.equal(f.store.laneByKey('alpha')!.drain, null, 'an open lead ends the episode');
    void lead;
  } finally { void f.close(); }
});

test('Spec 041 keep: a reason ends the episode; idleness alone never re-opens it, later activity then a drain does', () => {
  const f = fixture();
  try {
    planFixture(f);
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    const first = f.store.laneByKey('alpha')!.drain!;
    const kept = f.store.keepLane({ key: 'alpha', reason: 'Waiting on the design review', author: 'planner-agent' });
    assert.equal(kept.drain, null);
    assert.equal(kept.keep?.reason, 'Waiting on the design review');
    assert.equal(kept.keep?.by, 'planner-agent');
    assert.equal(decisionsCards(f).some(card => card.kind === 'lane_drain'), false);
    // Idleness after the keep is the answer standing, not a new drain (2026-10-04: the keep itself
    // was the last activity, so the lane re-prompted every drain period).
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    assert.equal(f.store.laneByKey('alpha')!.drain, null, 'a kept lane stays quiet while nothing changes');
    assert.equal(laneNotices(f).length, 1);
    // Activity after the keep, then a full drain period, starts a fresh episode with a fresh notice.
    const lane = f.store.laneByKey('alpha')!;
    f.store.db.prepare('UPDATE lanes SET data=? WHERE key=?').run(JSON.stringify({ ...lane, keep: { ...lane.keep!, at: minutesAgo(400) } }), 'alpha');
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    const second = f.store.laneByKey('alpha')!.drain!;
    assert.notEqual(second.since, first.since);
    assert.equal(laneNotices(f).length, 2);
  } finally { void f.close(); }
});

test('Spec 042: a lane that leaves the plan ends its episode, and a project with no owner never opens one', () => {
  const f = fixture();
  try {
    f.store.upsertLane({ key: 'alpha', title: 'Alpha lane', aim: 'Done looks like alpha shipped.', repositories: [repoA] });
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA] });
    f.store.setPlan({ project: 'app', version: 0, author: 'operator (board)', entries: [{ lane: 'alpha', note: '', horizon: 'now' as const, doneWhen: 'Alpha shipped' }] });
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    assert.equal(drainNotices(f).length, 0, 'no owner, no prompt');
    assert.equal(f.store.laneByKey('alpha')!.drain, null, 'dormant: no episode');
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-agent', setBy: 'test' });
    f.store.evaluateLaneDrains();
    assert.ok(f.store.laneByKey('alpha')!.drain, 'owned: the episode opens');
    // A plan save without the lane removes it from the plan and ends the episode.
    f.store.setPlan({ project: 'app', version: 1, author: 'operator (board)', entries: [] });
    f.store.evaluateLaneDrains();
    assert.equal(f.store.laneByKey('alpha')!.drain, null);
  } finally { void f.close(); }
});

test('Spec 041 row 9: a project with no unfinished task sends the plan owner its next aim', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    f.store.upsertLane({ key: 'alpha', title: 'Alpha lane', aim: 'Done looks like alpha shipped.', repositories: [repoA] });
    f.store.upsertLane({ key: 'beta', title: 'Beta lane', aim: 'Done looks like beta shipped.', repositories: [repoA] });
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA] }); f.store.setProjectPlanner({ key: 'app', agentId: 'planner-agent', setBy: 'test' });
    f.store.editLaneDocument({ key: 'alpha', version: 0, text: 'Alpha document.', author: 'planner-agent' });
    f.store.setPlan({
      project: 'app', version: 0, author: 'planner-agent',
      entries: [
        { lane: 'alpha', note: '', horizon: 'now' as const, doneWhen: 'Alpha shipped' },
        { lane: 'beta', note: '', horizon: 'next' as const, doneWhen: 'Beta shipped' },
      ],
    });
    const lead = f.leads.add({ repositories: [repoA], title: 'Idea toward alpha', body: 'An idea.', lanes: ['alpha'], author: 'planner-agent' });
    finishOne(f, 'finished-alpha');
    f.store.evaluateLaneDrains();
    const notices = drainNotices(f).filter(n => n.kind === 'next_aim');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.agentId, 'planner-agent');
    assert.match(notices[0]!.text, /the project's board is drained/);
    assert.match(notices[0]!.text, /Project: App \(app\)/);
    assert.match(notices[0]!.text, /Top now step: Alpha lane \(alpha\)/);
    assert.match(notices[0]!.text, /Done when: Alpha shipped/);
    assert.match(notices[0]!.text, /Lane document: version 1/);
    assert.match(notices[0]!.text, new RegExp(`Open leads: Idea toward alpha \\(${lead.id}\\)`));
    assert.match(notices[0]!.text, /First next step: Beta lane \(beta\)/);
    assert.match(notices[0]!.text, /brief tasks toward the step/i);
    // A live task anywhere in the project ends the episode; the notice is superseded before delivery.
    const task: Task = f.store.insert(submission('revive', { lanes: ['beta'] }), 'host', 'h', head);
    f.store.evaluateLaneDrains();
    assert.equal(f.store.projectByKey('app')!.drain, null);
    await f.engine.resolution.deliverDrainNotices();
    assert.equal(f.notified.length, 0, 'nothing delivered for the ended episode');
    assert.equal(f.store.notices('project:app')[0]!.status, 'superseded');
    void task;
  } finally { void f.close(); }
});

test('Spec 041 row 10: a drained project with no now or next step is asked for a plan', () => {
  const f = fixture();
  try {
    f.store.upsertLane({ key: 'later-lane', title: 'Later lane', aim: 'Done looks like later shipped.', repositories: [repoA] });
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA] }); f.store.setProjectPlanner({ key: 'app', agentId: 'planner-agent', setBy: 'test' });
    f.store.setPlan({ project: 'app', version: 0, author: 'planner-agent', entries: [{ lane: 'later-lane', note: '', horizon: 'later' as const }] });
    finishOne(f, 'finished-later');
    f.store.evaluateLaneDrains();
    const notices = drainNotices(f).filter(n => n.kind === 'next_aim');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.text, /Top now step: none/);
    assert.match(notices[0]!.text, /save a plan \(plan\.set\)/i);
    // Saving a plan with a now step answers the ask and ends the episode.
    f.store.setPlan({ project: 'app', version: 1, author: 'planner-agent', entries: [{ lane: 'later-lane', note: '', horizon: 'now' as const, doneWhen: 'Later shipped' }] });
    f.store.evaluateLaneDrains();
    assert.equal(f.store.projectByKey('app')!.drain, null);
  } finally { void f.close(); }
});

test('Spec 041: a lane drain notice uses the current plan at delivery intent', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    planFixture(f);
    keepBoardAlive(f);
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    const original = laneNotices(f)[0]!;
    const since = f.store.laneByKey('alpha')!.drain!.since;

    f.store.setPlan({ project: 'app', version: 1, author: 'planner-agent', entries: [
      { lane: 'alpha', note: '', horizon: 'now' as const, doneWhen: 'Alpha shipped after the review' },
    ] });
    await f.engine.resolution.deliverDrainNotices();

    assert.equal(f.store.laneByKey('alpha')!.drain!.since, since, 'saving the same top lane keeps the episode');
    assert.equal(f.store.notices('lane:alpha').length, 1, 'the episode retains one notice');
    assert.equal(f.store.notices('lane:alpha')[0]!.id, original.id);
    assert.equal(f.store.notices('lane:alpha')[0]!.status, 'delivered');
    assert.match(f.notified[0]!.text, /Done when: Alpha shipped after the review/);
  } finally { await f.close(); }
});

test('Spec 041: a project drain notice uses the current plan at delivery intent', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    f.store.upsertLane({ key: 'alpha', title: 'Alpha lane', aim: 'Done looks like alpha shipped.', repositories: [repoA] });
    f.store.upsertLane({ key: 'beta', title: 'Beta lane', aim: 'Done looks like beta shipped.', repositories: [repoA] });
    f.store.upsertLane({ key: 'gamma', title: 'Gamma lane', aim: 'Done looks like gamma shipped.', repositories: [repoA] });
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-agent', setBy: 'test' });
    f.store.setPlan({ project: 'app', version: 0, author: 'planner-agent', entries: [
      { lane: 'alpha', note: '', horizon: 'now' as const, doneWhen: 'Alpha shipped' },
      { lane: 'beta', note: '', horizon: 'next' as const, doneWhen: 'Beta shipped' },
    ] });
    finishOne(f, 'finished-alpha');
    f.store.evaluateLaneDrains();
    const original = drainNotices(f).find(notice => notice.kind === 'next_aim')!;
    const since = f.store.projectByKey('app')!.drain!.since;

    f.store.setPlan({ project: 'app', version: 1, author: 'planner-agent', entries: [
      { lane: 'alpha', note: '', horizon: 'now' as const, doneWhen: 'Alpha shipped after the review' },
      { lane: 'gamma', note: '', horizon: 'next' as const, doneWhen: 'Gamma shipped' },
    ] });
    await f.engine.resolution.deliverDrainNotices();

    assert.equal(f.store.projectByKey('app')!.drain!.since, since, 'saving the same top lane keeps the episode');
    assert.equal(f.store.notices('project:app').length, 1, 'the episode retains one notice');
    assert.equal(f.store.notices('project:app')[0]!.id, original.id);
    assert.equal(f.store.notices('project:app')[0]!.status, 'delivered');
    assert.match(f.notified[0]!.text, /Done when: Alpha shipped after the review/);
    assert.match(f.notified[0]!.text, /First next step: Gamma lane \(gamma\)/);
    assert.doesNotMatch(f.notified[0]!.text, /First next step: Beta lane/);
  } finally { await f.close(); }
});

test('Spec 041: the drain prompt is delivered to the owner thread once, and a gone owner is superseded while escalation still covers the answer', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    planFixture(f);
    keepBoardAlive(f);
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    await f.engine.resolution.deliverDrainNotices();
    assert.equal(f.notified.length, 1);
    assert.equal(f.notified[0]!.agentId, 'planner-agent');
    assert.equal(f.store.notices('lane:alpha')[0]!.status, 'delivered');
    await f.engine.resolution.deliverDrainNotices();
    assert.equal(f.notified.length, 1, 'never resent');
    // An episode that ends before delivery supersedes the notice.
    const f2 = fixture();
    try {
      f2.store.setMeta('paused', false);
      planFixture(f2);
      keepBoardAlive(f2);
      backdate(f2, 200);
      f2.store.evaluateLaneDrains();
      f2.store.keepLane({ key: 'alpha', reason: 'Not yet', author: 'planner-agent' });
      await f2.engine.resolution.deliverDrainNotices();
      assert.equal(f2.notified.length, 0);
      assert.equal(f2.store.notices('lane:alpha')[0]!.status, 'superseded');
    } finally { await f2.close(); }
    // A vanished owner thread is superseded; the escalation timer still reaches the operator.
    const f3 = fixture();
    try {
      f3.store.setMeta('paused', false);
      planFixture(f3);
      keepBoardAlive(f3);
      backdate(f3, 200);
      f3.store.evaluateLaneDrains();
      (f3.engine.resolution as unknown as { adapter: Adapter }).adapter.observe = async () => { throw new Error('Agent was not found'); };
      await f3.engine.resolution.deliverDrainNotices();
      const notice = f3.store.notices('lane:alpha')[0]!;
      assert.equal(notice.status, 'superseded');
      assert.match(notice.error, /no longer available/);
      f3.store.setMeta('laneDrainEscalationMinutes', 90);
      const lane = f3.store.laneByKey('alpha')!;
      f3.store.db.prepare('UPDATE lanes SET data=? WHERE key=?').run(JSON.stringify({ ...lane, drain: { ...lane.drain!, since: minutesAgo(91) } }), 'alpha');
      f3.store.evaluateLaneDrains();
      assert.ok(f3.store.laneByKey('alpha')!.drain?.escalatedAt, 'escalation covers an unreachable owner');
      assert.ok(decisionsCards(f3).some(card => card.kind === 'lane_drain'));
    } finally { await f3.close(); }
  } finally { await f.close(); }
});

test('Spec 041: the engine sweep runs the drain pass, and the project record keeps its episode across an operator edit', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    planFixture(f);
    backdate(f, 200);
    await f.engine.wake();
    const notices = f.store.notices('lane:alpha');
    assert.equal(notices.length, 1, 'the sweep evaluated the drains and delivered the prompt');
    assert.equal(notices[0]!.status, 'delivered');
    assert.equal(f.notified[0]!.agentId, 'planner-agent');
    // An operator park/unpark cycle must not reset the project's next-aim episode.
    f.store.upsertProject({ key: 'app', name: 'App renamed', repositories: [repoA] });
    const project = f.store.projectByKey('app')!;
    assert.equal(project.name, 'App renamed');
    assert.equal(project.version, 2);
    f.store.evaluateLaneDrains();
    assert.equal(f.store.projectByKey('app')!.version, 2, 'episode writes never bump the operator version');
  } finally { await f.close(); }
});

test('Spec 041 review 5402595790: a default or never-saved project is never prompted, never escalated, never carries an episode', () => {
  const f = fixture();
  try {
    const repoB = { origin: 'acme/beta', path: '/repo-b' };
    // A bare lane auto-creates the default per-repository project; nothing is ever saved there.
    f.store.upsertLane({ key: 'alpha', title: 'Alpha lane', aim: 'Done looks like alpha shipped.', repositories: [repoA] });
    // A named project with no saved plan behaves the same.
    f.store.upsertLane({ key: 'beta', title: 'Beta lane', aim: 'Done looks like beta shipped.', repositories: [repoB] });
    f.store.upsertProject({ key: 'bare', name: 'Bare', repositories: [repoB] }); f.store.setProjectPlanner({ key: 'bare', agentId: 'planner-agent', setBy: 'test' });
    backdate(f, 200);
    f.store.evaluateLaneDrains();
    assert.equal(drainNotices(f).length, 0, 'no notice without a saved plan and an owner');
    for (const project of f.store.projects()) {
      assert.equal(project.drain, null, `project ${project.key} carries no episode`);
    }
    assert.ok(f.store.projects().length >= 2, 'the default project exists alongside the named one');
    // Saving a plan is what makes the project promptable; until then nothing starts.
    f.store.setPlan({ project: 'bare', version: 0, author: 'planner-agent', entries: [{ lane: 'beta', note: '', horizon: 'now' as const, doneWhen: 'Beta shipped' }] });
    finishOne(f, 'finished-beta', '/repo-b');
    f.store.evaluateLaneDrains();
    assert.ok(f.store.projectByKey('bare')!.drain, 'a saved plan starts the episode');
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 1, 'and prompts the owner');
  } finally { void f.close(); }
});

test('Spec 041 review 5402595790: an owner Queue cannot name gets no prompt; the lane escalates and the board never does', () => {
  const at = Date.now();
  const evaluation = evaluateDrains(
    [{ key: 'alpha', title: 'Alpha lane', aim: 'Aim', drain: null, status: 'active', lastActivityAt: minutesAgo(200),
       liveTasks: 0, openLeads: 0, plan: { project: 'app', projectName: 'App', owner: '', doneWhen: 'Ship it' }, outcomes: [] }],
    [{ key: 'app', name: 'App', drain: null, liveTasks: 0, lastFinishedAt: minutesAgo(5),
       topNow: { lane: 'alpha', title: 'Alpha lane', aim: 'Aim', doneWhen: 'Ship it', documentVersion: 1 },
       firstNext: null, openLeads: [], owner: '' }],
    { drainMinutes: 120, escalationMinutes: 1440 }, at);
  assert.equal(evaluation.notices.length, 0, 'no notice is queued for an empty owner');
  assert.ok(evaluation.lanes['alpha']?.escalatedAt, 'the lane escalates straight away');
  assert.ok(evaluation.projects['app'], 'the board still records its episode');
  assert.equal(evaluation.projects['app']!.escalatedAt, null, 'a drained board is not an operator decision (Tom, 2026-10-15)');
});

test('a dormant project never fires a next aim, and an episode with no recent finish ends', () => {
  // 2026-10-03: at go-live every idle project fired a next-aim at its importer
  // (23 to the Northstar thread). A board drains when its work finishes, not by being idle.
  const at = Date.now();
  const project = (lastFinishedAt: string | null, drain: { since: string; lane?: string; notices: number; lastNoticeAt: string | null; escalatedAt: string | null } | null = null) => ({
    key: 'app', name: 'App', drain, liveTasks: 0, lastFinishedAt,
    topNow: { lane: 'alpha', title: 'Alpha lane', aim: 'Aim', doneWhen: 'Ship it', documentVersion: 1 }, firstNext: null, openLeads: [], owner: 'planner-agent' });
  const settings = { drainMinutes: 120, escalationMinutes: 1440 };
  for (const idle of [null, minutesAgo(60 * 24 * 7)]) {
    const evaluation = evaluateDrains([], [project(idle)], settings, at);
    assert.equal(evaluation.notices.length, 0, `no notice for last finish ${idle}`);
    assert.equal(evaluation.projects['app'], undefined, 'no episode starts');
  }
  const stale = evaluateDrains([], [project(minutesAgo(60 * 24 * 7), { since: minutesAgo(10), lane: 'alpha', notices: 1, lastNoticeAt: minutesAgo(10), escalatedAt: null })], settings, at);
  assert.equal(stale.projects['app'], null, 'an episode a dormant board started ends, superseding its pending prompt');
  const fresh = evaluateDrains([], [project(minutesAgo(5))], settings, at);
  assert.equal(fresh.notices.length, 1, 'work that just finished still prompts');
});


test('an idle plan answers the drained board until new work finishes after it (Tom, 2026-10-15)', () => {
  const at = Date.now();
  const settings = { drainMinutes: 120, escalationMinutes: 1440 };
  const project = (lastFinishedAt: string, idleSince: string | null, drain: { since: string; notices: number; lastNoticeAt: string | null; escalatedAt: string | null } | null = null) => ({
    key: 'app', name: 'App', drain, liveTasks: 0, lastFinishedAt, idleSince, topNow: null, firstNext: null, openLeads: [], owner: 'planner-agent' });
  const answered = evaluateDrains([], [project(minutesAgo(30), minutesAgo(10), { since: minutesAgo(20), notices: 1, lastNoticeAt: minutesAgo(20), escalatedAt: null })], settings, at);
  assert.equal(answered.notices.length, 0, 'no prompt for a board idle on purpose');
  assert.equal(answered.projects['app'], null, 'the open episode ends, superseding its pending prompt');
  const resumed = evaluateDrains([], [project(minutesAgo(2), minutesAgo(10))], settings, at);
  assert.equal(resumed.notices.length, 1, 'work that finishes after the idle mark prompts again');
});

test('plan.set records an idle reason only for a plan with no now or next lane, and a later save clears it', () => {
  const f = fixture();
  try {
    f.store.upsertLane({ key: 'gaps', title: 'Gap intake', aim: 'Real gaps triaged.', repositories: [repoA] });
    f.store.upsertProject({ key: 'project-d', name: 'Project-D', repositories: [repoA] });
    f.store.setProjectPlanner({ key: 'project-d', agentId: 'planner-agent', setBy: 'test' });
    assert.throws(() => f.store.setPlan({ project: 'project-d', version: 0, author: 'planner-agent', idle: 'Waiting for real Cream gaps',
      entries: [{ lane: 'gaps', horizon: 'now' as const }] }), /idle plan has no now or next lane/);
    finishOne(f, 'finished-project-d', '/repo-a');
    const idle = f.store.setPlan({ project: 'project-d', version: 0, author: 'planner-agent', idle: 'Waiting for real Cream gaps',
      entries: [{ lane: 'gaps', horizon: 'later' as const }] });
    assert.equal(idle.idle?.reason, 'Waiting for real Cream gaps');
    assert.equal(f.store.plan({ project: 'project-d' }).idle?.reason, 'Waiting for real Cream gaps', 'the latest read the Planning tab uses carries it');
    f.store.evaluateLaneDrains();
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 0, 'the idle board is not prompted');
    assert.equal(f.store.projectByKey('project-d')!.drain, null);
    const changed = f.store.setPlan({ project: 'project-d', version: idle.version, author: 'planner-agent', entries: [{ lane: 'gaps', horizon: 'later' as const }] });
    assert.equal(changed.idle ?? null, null, 'a plan change without idle clears the acknowledgement');
  } finally { void f.close(); }
});

test('only a project planner or operator submission ends the project\'s idle mark and wakes its planner', (t) => {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: base });
  const f = fixture();
  try {
    const repoB = { origin: 'acme/beta', path: '/repo-b' };
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA] });
    f.store.setProjectPlanner({ key: 'app', agentId: 'planner-agent', setBy: 'test' });
    f.store.upsertProject({ key: 'side', name: 'Side project', repositories: [repoB] });
    f.store.setPlan({ project: 'app', version: 0, author: 'planner-agent', idle: 'Waiting for the next project task', entries: [] });
    const idleAt = f.store.plan({ project: 'app' }).idle!.at;

    const other = f.store.insert(submission('finished-side', { repoPath: repoB.path }), 'host', 'h', head, {}, undefined, repoB.origin);
    f.store.update(other.id, { phase: 'done', finishedAt: new Date(Date.parse(idleAt) + 1_000).toISOString() });
    t.mock.timers.setTime(base + 1_000);
    f.store.evaluateLaneDrains(Date.now());
    assert.equal(f.store.plan({ project: 'app' }).idle?.at, idleAt, 'another project\'s task leaves the idle mark intact');
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 0, 'another project\'s task does not wake this planner');

    const foreign = f.store.insert(submission('finished-app-foreign', { repoPath: repoA.path, originAgentId: 'another-planner' }), 'host', 'h', head, {}, undefined, repoA.origin);
    f.store.update(foreign.id, { phase: 'done', finishedAt: new Date(Date.parse(idleAt) + 2_000).toISOString() });
    t.mock.timers.setTime(base + 2_000);
    f.store.evaluateLaneDrains(Date.now());
    assert.equal(f.store.plan({ project: 'app' }).idle?.at, idleAt, 'another planner\'s task in this repository leaves the idle mark intact');
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 0, 'another planner\'s task in this repository does not wake this planner');

    const own = f.store.insert(submission('finished-app-own', { repoPath: repoA.path, originAgentId: 'planner-agent' }), 'host', 'h', head, {}, undefined, repoA.origin);
    f.store.update(own.id, { phase: 'done', finishedAt: new Date(Date.parse(idleAt) + 3_000).toISOString() });
    t.mock.timers.setTime(base + 3_000);
    f.store.evaluateLaneDrains(Date.now());
    assert.equal(f.store.plan({ project: 'app' }).idle, undefined, 'the project planner\'s finished task clears its idle mark');
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 1, 'the project planner\'s finished task wakes its planner');

    t.mock.timers.setTime(base + 4_000);
    const current = f.store.plan({ project: 'app' });
    const operatorIdle = f.store.setPlan({ project: 'app', version: current.version, author: 'planner-agent', idle: 'Waiting for board work', entries: [] });
    f.store.evaluateLaneDrains(Date.now());
    assert.equal(f.store.plan({ project: 'app' }).idle?.at, operatorIdle.idle!.at, 'the earlier planner task leaves the new idle mark intact');
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 1, 'the new idle mark does not wake the planner');
    t.mock.timers.setTime(base + 5_000);
    const operator = f.store.insert(submission('finished-app-operator', { repoPath: repoA.path, originAgentId: 'operator (board)' }), 'host', 'h', head, {}, undefined, repoA.origin);
    f.store.update(operator.id, { phase: 'done', finishedAt: new Date(Date.parse(operatorIdle.idle!.at) + 1_000).toISOString() });
    f.store.evaluateLaneDrains(Date.now());
    assert.equal(f.store.plan({ project: 'app' }).idle, undefined, 'an operator-submitted finished task clears the idle mark');
    assert.equal(drainNotices(f).filter(n => n.kind === 'next_aim').length, 2, 'an operator-submitted finished task wakes the planner');
  } finally { void f.close(); }
});

test('shared lanes remain in both drained project roadmaps while lane notices stay unique', () => {
  const f = fixture();
  try {
    const repoB = { origin: 'acme/beta', path: '/repo-b' };
    for (const key of ['shared-now', 'shared-next']) {
      f.store.upsertLane({ key, title: key, aim: `${key} shipped`, repositories: [repoA, repoB] });
    }
    for (const [key, repo] of [['app-a', repoA], ['app-b', repoB]] as const) {
      f.store.upsertProject({ key, name: key, repositories: [repo] });
      f.store.setProjectPlanner({ key, agentId: `${key}-owner`, setBy: 'test' });
      f.store.setPlan({ project: key, version: 0, author: `${key}-owner`, entries: [
        { lane: 'shared-now', horizon: 'now', doneWhen: `${key} accepted` },
        { lane: 'shared-next', horizon: 'next', doneWhen: 'Next shipped' },
      ] });
    }
    backdate(f, 200);
    finishOne(f, 'finished-a', '/repo-a');
    finishOne(f, 'finished-b', '/repo-b');
    f.store.evaluateLaneDrains();
    const notices = drainNotices(f).filter(n => n.kind === 'next_aim');
    assert.equal(notices.length, 2);
    for (const key of ['app-a', 'app-b']) {
      const notice = notices.find(n => n.agentId === `${key}-owner`)!;
      assert.ok(notice);
      assert.match(notice.text, /Top now step: shared-now \(shared-now\)/);
      assert.match(notice.text, /First next step: shared-next \(shared-next\)/);
      assert.ok(notice.text.includes(`Done when: ${key} accepted`));
      assert.doesNotMatch(notice.text, /The plan has no now or next step/);
    }
    assert.equal(laneNotices(f).length, 2, 'one notice per shared lane, not per project');
    f.store.evaluateLaneDrains();
    assert.equal(drainNotices(f).length, 4, 'repeated evaluation does not duplicate notices');
  } finally { void f.close(); }
});


const qaRun = (id: string, state: 'queued' | 'running' | 'passed' | 'failed' | 'hold', repository = repoA) => projectQaRunSchema.parse({
  id, repository, key: repository.origin, state, baseBranch: 'main', base: head,
  argv: ['effigy', 'qa'], digest: 'b'.repeat(64), exitCode: null, durationMs: 0,
  outputTail: '', startedAt: new Date().toISOString(), finishedAt: null, pid: null,
  capacityWait: null, capacityUnavailable: false,
});

test('project drain counts queued and running QA across all project repositories, not just latest results', () => {
  const f = fixture();
  try {
    planFixture(f);
    const repoB = { origin: 'acme/beta', path: '/repo-b' };
    f.store.upsertProject({ key: 'app', name: 'App', repositories: [repoA, repoB], primary: repoA });
    finishOne(f, 'finished-before-qa');
    // A QA worktree maps by origin to the project, even when its path differs.
    const qaRepo = { ...repoB, path: '/private/qa-worktree' };
    for (const state of ['queued', 'running'] as const) {
      const run = qaRun(`active-${state}`, state, qaRepo);
      f.store.putQaRun(run);
      f.store.putQaRun(qaRun(`newer-${state}`, 'passed', qaRepo));
      f.store.evaluateLaneDrains();
      assert.equal(f.store.projectByKey('app')!.drain, null);
      assert.equal(f.store.notices('project:app').length, 0);
      f.store.putQaRun({ ...run, state: 'passed' });
    }
    f.store.evaluateLaneDrains();
    assert.ok(f.store.projectByKey('app')!.drain, 'settled QA allows the normal project episode');
  } finally { void f.close(); }
});

test('QA starting during owner observation supersedes the pending project drain before delivery', async () => {
  const f = fixture();
  try {
    f.store.setMeta('paused', false);
    planFixture(f);
    finishOne(f, 'finished-before-observation');
    f.store.evaluateLaneDrains();
    const notice = f.store.notices('project:app')[0]!;
    assert.equal(notice.status, 'pending');
    f.engine.resolution.adapter.observe = async id => {
      f.store.putQaRun(qaRun('started-during-observation', 'running'));
      return { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' };
    };
    await f.engine.resolution.deliverDrainNotices();
    assert.equal(f.store.projectByKey('app')!.drain, null);
    assert.equal(f.store.notices('project:app')[0]!.status, 'superseded');
    assert.equal(f.notified.length, 0);
  } finally { await f.close(); }
});

test('QA in another project and held or settled QA do not suppress project drain', () => {
  const f = fixture();
  try {
    planFixture(f);
    finishOne(f, 'finished-unrelated-qa');
    f.store.upsertProject({ key: 'other', name: 'Other', repositories: [{ origin: 'acme/other', path: '/other' }] });
    f.store.putQaRun(qaRun('other-running', 'running', { origin: 'acme/other', path: '/other' }));
    for (const state of ['passed', 'failed', 'hold'] as const) f.store.putQaRun(qaRun(`settled-${state}`, state));
    f.store.evaluateLaneDrains();
    assert.ok(f.store.projectByKey('app')!.drain);
    assert.equal(f.store.notices('project:app').length, 1);
  } finally { void f.close(); }
});
