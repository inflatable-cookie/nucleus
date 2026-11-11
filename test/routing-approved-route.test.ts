import { fakeAdapter, profile } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Decisions } from '../core/planning/decisions';
import { chooseProfile, eligibilityReasons } from '../core/dispatch/routing';
import { reconcileRoutingSignoffs, signoffApprove } from '../core/dispatch/routing-signoff';
import { supersedingRouteProfile } from '../shared/pool';
import { submissionSchema, type Profile, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { ResolutionAdapter } from '../core/resolution';

/**
 * Task 515: routing honours the operator's chosen route. The latest approved
 * route for a role is the selection Queue dispatches, and routing messages say
 * plainly why a profile was not used. Clears papercuts 8e141468 (an approved
 * worker route left an older dispatch selection in force), ca2dfcdc (routing
 * asks for approval again after the operator already chose that task and
 * profile) and d9c61c02 (a profile filtered for independence is reported as
 * absent from the catalog).
 */
const head = 'a'.repeat(40), base = 'b'.repeat(40);


const profiles = [profile('author', 'author-model'), profile('sol', 'sol-model'), profile('luna', 'luna-model')];
const pool = [
  { profileId: 'author', enabled: true, group: 'author', roles: ['worker', 'reviewer'] as const, weight: 1, scopes: ['general'] as const },
  { profileId: 'sol', enabled: true, group: 'sol', roles: ['worker', 'reviewer'] as const, weight: 1, scopes: ['general'] as const },
  { profileId: 'luna', enabled: true, group: 'luna', roles: ['worker', 'reviewer'] as const, weight: 1, scopes: ['general'] as const },
];

function routeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-approved-route-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', pool);
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Approved route', repoPath: '/repo', planningCommit: base,
    handoffPath: 'handoff.md', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  // A retained author between runs on the dispatch selection, with review
  // findings waiting: the ordinary next step is a revision on that profile.
  const task = store.update(submitted.id, {
    phase: 'changes_requested', reason: 'Address the review findings', branch: 'ns-task',
    workspaceId: 'workspace', directory: '/worktree', agentId: 'worker', runId: 'initial',
    profile: profiles[0], workerModel: 'author-model', workerModels: ['author-model'],
    prHead: head, prUrl: 'https://github.com/example/repo/pull/1',
    completion: { taskId: submitted.id, runId: 'initial', eventId: 'initial-result', status: 'ready_for_review', summary: 'Ready', prNumber: 1 },
    resolution: { ...store.task(submitted.id).resolution, currentRunId: null,
      review: { taskId: submitted.id, runId: 'review-run', eventId: 'review-change', status: 'changes_required', summary: 'One finding', head } },
  });
  const observations = new Map<string, { id: string; workspaceId: string; status: string; active: boolean; permissions: boolean; error: string }>();
  observations.set('worker', { id: 'worker', workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  const creates: Run[] = [];
  const adapter: Adapter & ResolutionAdapter = fakeAdapter({
    profiles: async () => profiles,
    validate: async () => base, verifyWorkspace: async () => task.branch,
    createWorkspace: async () => { throw new Error('No workspace creation in route fixtures'); },
    createAgent: async t => {
      const id = `agent-${t.profile!.id}`;
      observations.set(id, { id, workspaceId: t.workspaceId!, status: 'running', active: true, permissions: false, error: '' });
      return { id, workspaceId: t.workspaceId! };
    },
    observe: async id => { const state = observations.get(id); if (!state) throw new Error('Agent missing'); return state as never; },
    verifyPr: async () => ({ head, url: task.prUrl! }), verifyPrIdentity: async () => ({ head, url: task.prUrl! }),
    verifyCleanQueueWorktree: async () => {}, verifyResume: async () => {},
    stopAgentTurn: async () => {}, createRun: async (t, r) => { creates.push(r); return { id: `agent-${r.id}`, workspaceId: r.workspaceId }; },
    sendRun: async () => {}, findRunAgents: async () => [],
    verifyReview: async () => {}, mergeGate: async () => ({ head, base, wait: '' }), merge: async () => {},
    merged: async () => ({ merged: false, commit: null, head, base: 'main' }), syncMain: async () => base,
    verifyCloseout: async () => {}, notify: async () => {},
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = profiles;
  const idle = (id: string) => observations.set(id, { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' });
  return { dir, store, engine, task, current: () => store.task(task.id), creates, idle,
    close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('papercut 8e141468: an approved worker route replaces the stale dispatch selection', async () => {
  const f = routeFixture(); try {
    // The operator approved sol for the worker after the task dispatched on
    // author: the sign-off decision was answered on the board, so the request
    // is required and honoured. Only the recording differs from a `route`
    // verb, which would have armed the replacement itself.
    const approved = f.store.update(f.task.id, {
      profileRequests: { worker: { profileId: 'sol', reason: 'Sol is stronger for the revision', required: true,
        signoff: { status: 'approved', decisionId: 'decision-1', by: 'operator (board)', at: new Date().toISOString(), note: '' } } },
    }, 'routing_signoff', JSON.stringify({ role: 'worker', requested: 'sol', profileId: 'sol', status: 'approved', decisionId: 'decision-1', note: '' }));
    assert.equal(chooseProfile(approved, profiles, pool as never, {}, new Set(), 'worker')?.profile.id, 'sol');
    assert.equal(supersedingRouteProfile(approved.profileRequests?.worker, approved.profile?.id, pool as never, 'normal'), 'sol');

    await f.engine.wake();
    await f.engine.wake();
    const replaced = f.current();
    assert.equal(replaced.profile?.id, 'sol', 'the next worker run uses the approved route, not the older dispatch selection');
    assert.equal(replaced.retiredWorkers.at(-1)?.agentId, 'worker', 'the retained author retired');
    assert.equal(replaced.replacementProfile, null, 'the armed replacement was consumed');
  } finally { await f.close(); }
});

test('review finding: a required reviewer route supersedes the retained reviewer selection', async () => {
  const f = routeFixture(); try {
    // A retained reviewer from an earlier round, idle in its own workspace,
    // while a required within-level request names another profile. No
    // sign-off is needed for the request, so signoffIssue stays silent: only
    // the general rule switches the next run to the approved route.
    f.idle('old-rev');
    f.store.update(f.task.id, {
      phase: 'awaiting_review',
      resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: 'old-rev', reviewerProfile: profiles[2] },
      profileRequests: { reviewer: { profileId: 'sol', reason: 'Sol reviews this round', required: true } },
    });
    await f.engine.wake();
    await f.engine.wake();
    const runs = f.creates.filter(run => run.role === 'reviewer');
    assert.ok(runs.length, 'the next review launches');
    assert.equal(runs.at(-1)!.profile?.id, 'sol', 'the required route supersedes the retained reviewer');
  } finally { await f.close(); }
});

test('review finding fallback: an unselectable approved reviewer route waits instead of launching stale', async () => {
  const f = routeFixture(); try {
    // The retained reviewer authored the task (it is the worker's own agent),
    // and the required route is temporarily unselectable: its group is down.
    // The next run must wait visibly on the route, never launch the stale
    // profile, and honour the route once the group recovers.
    f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('sol',
      JSON.stringify({ group: 'sol', unavailable: true, reason: 'quota', retryAt: null }));
    f.store.update(f.task.id, {
      phase: 'awaiting_review',
      resolution: { ...f.current().resolution, currentRunId: null, reviewerAgentId: 'worker', reviewerProfile: profiles[2] },
      profileRequests: { reviewer: { profileId: 'sol', reason: 'Sol reviews this round', required: true } },
    });
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.creates.filter(run => run.role === 'reviewer').length, 0,
      'no reviewer run launches while the approved route is unselectable');
    assert.match(f.current().reason, /No eligible independent reviewer profile/,
      'the wait names the missing route instead of reusing the stale profile');
    assert.match(f.current().reason, /required reviewer request names sol/,
      'the wait names the superseding request and why it cannot run');
    f.store.db.prepare('DELETE FROM availability').run();
    await f.engine.wake();
    await f.engine.wake();
    const runs = f.creates.filter(run => run.role === 'reviewer');
    assert.ok(runs.length, 'the next review launches once the route is selectable');
    assert.equal(runs.at(-1)!.profile?.id, 'sol', 'the recovered run honours the approved route');
  } finally { await f.close(); }
});

test('papercut 8e141468 control: without an approved route the retained selection stays', async () => {
  const f = routeFixture(); try {
    await f.engine.wake();
    await f.engine.wake();
    assert.equal(f.current().profile?.id, 'author', 'no route, no replacement: the retained selection keeps working');
  } finally { await f.close(); }
});

test('papercut ca2dfcdc: a second request for the same approved task and profile opens no new decision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-no-reask-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('pool', [
    { profileId: 'cheap', enabled: true, group: 'cheap', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'low' },
    { profileId: 'sol', enabled: true, group: 'sol', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'high', capability: 'frontier' },
  ]);
  const cheap = profile('cheap', 'cheap-model'), sol = profile('sol', 'sol-model');
  const catalog = [cheap, sol];
  const decisions = new Decisions(store);
  const submit = () => store.insert(submissionSchema.parse({ submissionId: `reask-${Math.random()}`, title: 'Reask',
    repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'planner',
    profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } } }), 'host', 'handoff', 'a'.repeat(40));
  try {
    const task = submit();
    reconcileRoutingSignoffs(store, decisions, task.id, catalog);
    const first = store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(first.status, 'pending');
    assert.equal(decisions.list({ task: task.id }).length, 1);
    const decision = decisions.get({ id: first.decisionId! });
    decisions.answer({ id: decision.id, version: decision.version, answer: signoffApprove('sol'), answeredBy: 'operator (board)', relayed: false, note: '' });
    reconcileRoutingSignoffs(store, decisions, task.id, catalog);
    assert.equal(store.task(task.id).profileRequests!.reviewer!.signoff!.status, 'approved');
    // The approval is re-recorded without its sign-off, the way set_routing
    // stores a plain request. Asking again would repeat the operator's choice.
    store.update(task.id, { profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } } },
      'routing_changed', JSON.stringify({ role: 'reviewer', profileId: 'sol' }));
    reconcileRoutingSignoffs(store, decisions, task.id, catalog);
    const restored = store.task(task.id).profileRequests!.reviewer!;
    assert.equal(restored.signoff!.status, 'approved', 'the recorded approval is restored, not asked again');
    assert.equal(restored.signoff!.decisionId, first.decisionId, 'the restored approval names the original decision');
    assert.equal(decisions.list({ task: task.id }).length, 1, 'no second decision is opened for the same approved task and profile');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('papercut ca2dfcdc control: a later decline wins, so a re-request asks again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-reask-decline-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('pool', [
    { profileId: 'cheap', enabled: true, group: 'cheap', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'low' },
    { profileId: 'sol', enabled: true, group: 'sol', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'high', capability: 'frontier' },
  ]);
  const catalog = [profile('cheap', 'cheap-model'), profile('sol', 'sol-model')];
  const decisions = new Decisions(store);
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'reask-decline', title: 'Reask decline',
      repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'planner',
      profileRequests: { reviewer: { profileId: 'sol', reason: 'Review', required: true } } }), 'host', 'handoff', 'a'.repeat(40));
    store.event(task.id, 'routing_signoff', JSON.stringify({ role: 'reviewer', requested: 'sol', profileId: 'sol', status: 'approved', decisionId: 'old', note: '' }));
    store.event(task.id, 'routing_signoff', JSON.stringify({ role: 'reviewer', requested: 'sol', profileId: 'sol', status: 'declined', decisionId: 'newer', note: 'changed mind' }));
    store.update(task.id, { profileRequests: { reviewer: { profileId: 'sol', reason: 'Review', required: true } } }, 'routing_changed', '{}');
    reconcileRoutingSignoffs(store, decisions, task.id, catalog);
    assert.equal(decisions.list({ task: task.id }).length, 1, 'a newer decline ends the reuse: the operator is asked again');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('papercut d9c61c02: an independence-filtered profile is reported as filtered, not missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-filtered-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'filtered', title: 'Filtered',
      repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin',
      preferredProfileId: 'special', requirePreferred: true }), 'host', 'handoff', 'a'.repeat(40));
    const catalog = [profile('normal', 'normal-model'), profile('special', 'special-model')];
    const view = [catalog[0]!];
    const rated = catalog.map(item => ({ profileId: item.id, enabled: true, group: item.id, roles: ['worker'] as const, weight: 1, scopes: ['general'] as const }));
    const routed = store.update(task.id, { resolution: { ...store.task(task.id).resolution,
      reviewerProfile: { ...catalog[1]!, name: 'special' } } });
    const message = eligibilityReasons(routed, view, rated as never,
      [{ group: 'normal', unavailable: false, reason: '', retryAt: null }], 'normal', catalog);
    assert.match(message, /special: shares the reviewer's model \(special-model\); filtered for review independence/);
    assert.doesNotMatch(message, /absent from catalog/);
    const excluded = store.update(task.id, { workerExclusions: [{ agentId: null, profileId: 'special', reason: 'Operator excluded it', createdAt: new Date().toISOString() }] });
    const excludedMessage = eligibilityReasons({ ...excluded, resolution: { ...excluded.resolution, reviewerProfile: null } },
      view, rated as never, [{ group: 'normal', unavailable: false, reason: '', retryAt: null }], 'normal', catalog);
    assert.match(excludedMessage, /special: excluded for this task/);
    const missing = eligibilityReasons(routed, view,
      [...rated, { profileId: 'ghost', enabled: true, group: 'ghost', roles: ['worker'], weight: 1, scopes: ['general'] }] as never,
      [{ group: 'normal', unavailable: false, reason: '', retryAt: null }], 'normal', catalog);
    assert.match(missing, /ghost: absent from catalog/, 'a profile truly outside the catalog is still reported as absent');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the general rule: a required honoured route supersedes the recorded selection; anything else does not', () => {
  const honoured = { profileId: 'sol', reason: 'Board choice', required: true,
    signoff: { status: 'approved', decisionId: 'd', by: 'operator (board)', at: 'now', note: '' } };
  assert.equal(supersedingRouteProfile(honoured, 'author', pool as never, 'normal'), 'sol');
  assert.equal(supersedingRouteProfile(honoured, 'sol', pool as never, 'normal'), null, 'the same profile is not superseded');
  assert.equal(supersedingRouteProfile({ ...honoured, required: false }, 'author', pool as never, 'normal'), null,
    'a soft request never displaces a recorded selection');
  assert.equal(supersedingRouteProfile({ profileId: 'sol', reason: 'Pending', required: true }, 'author', [
    { profileId: 'sol', enabled: true, group: 'sol', capability: 'frontier', cost: 'high' },
  ] as never, 'normal'), null, 'an unsigned request for a by-request profile pins nothing');
  assert.equal(supersedingRouteProfile({ profileId: 'sol', reason: 'Within level', required: true }, 'author',
    pool as never, 'normal'), 'sol', 'a required within-level request is honoured at once');
});
