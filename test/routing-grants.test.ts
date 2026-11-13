import { formatAgentId } from '../shared/agent-identity';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Decisions } from '../core/planning/decisions';
import { chooseProfile } from '../core/dispatch/routing';
import { reconcileRoutingSignoffs, SIGNOFF_DECLINE } from '../core/dispatch/routing-signoff';
import {
  GRANT_APPROVE, GRANT_DECLINE, GRANT_OPERATOR_BOARD, activeRoutingGrants, applyRoutingGrant,
  archiveRoutingGrants, coveringGrant, grantArchiveDue, readRoutingGrants, reconcileRoutingGrants,
} from '../core/dispatch/routing-grants';
import { QueueRuntime } from '../service/runtime-owner';
import { describeRoutePolicy } from '../shared/pool';
import { poolSchema, runSchema, submissionSchema, taskControlInputSchema, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * Spec 052 planner grants (Tom, 2026-11-06): a planner asks once, the operator
 * says yes on the board, and that planner's own requests take effect for the
 * block of work without a per-task question.
 */
const profile = (id: string): Profile => ({ id, name: id === 'sol' ? 'Sol oracle' : id, provider: 'test', model: `test/${id}`, available: true, problem: '', notes: '', supportedThinking: id === 'opus' ? ['xhigh'] : [] });
const profiles = ['cheap', 'sol', 'opus'].map(profile);
const pool = [
  poolSchema.parse({ profileId: 'cheap', enabled: true, group: 'cheap', roles: ['worker', 'reviewer', 'coordinator'], weight: 1, scopes: ['general'], cost: 'low' }),
  poolSchema.parse({ profileId: 'sol', enabled: true, group: 'sol', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'high', capability: 'frontier' }),
  poolSchema.parse({ profileId: 'opus', enabled: true, group: 'opus', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' }),
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-grants-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('pool', pool);
  // Task 1183: the requesting planner belongs to the repo's project, as in production.
  const repo = store.projectFor('/repo', null) ?? store.ensureProject('/repo', null);
  store.setProjectPlanner({ key: repo.key, agentId: 'planner', setBy: 'operator' });
  const decisions = new Decisions(store);
  const submit = (extra: Record<string, unknown> = {}) => store.insert(submissionSchema.parse({
    submissionId: `grant-${Math.random()}`, title: 'Granted task',
    repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'planner',
    profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } }, ...extra,
  }), 'host', 'handoff', 'a'.repeat(40));
  const reconcile = (id: string) => reconcileRoutingSignoffs(store, decisions, id, profiles);
  const answer = (id: string, text: string, relayed = false) => {
    const decision = decisions.get({ id });
    return decisions.answer({ id, version: decision.version, answer: text, answeredBy: relayed ? 'supervisor' : GRANT_OPERATOR_BOARD, relayed, note: relayed ? 'Tom said yes' : '' });
  };
  const request = (caller = 'planner', extra: Record<string, unknown> = {}) =>
    applyRoutingGrant(store, decisions, { action: 'request', caller, reason: 'block of work needs frontier', ...extra });
  const activate = (caller = 'planner') => {
    const asked = request(caller);
    answer(asked.grant.decisionId!, GRANT_APPROVE);
    reconcileRoutingGrants(store, decisions);
    return readRoutingGrants(store).find(grant => grant.id === asked.grant.id)!;
  };
  return { dir, store, decisions, submit, reconcile, answer, request, activate, close: () => {
    try { store.close(); } catch { /* a restart proof already closed this connection */ }
    rmSync(dir, { recursive: true, force: true });
  } };
}

test('a planner request raises one decision and a board yes activates the grant', () => {
  const f = fixture(); try {
    const first = f.request();
    assert.equal(first.grant.status, 'pending');
    assert.equal(first.joined, false);
    assert.equal(first.alreadyActive, false);
    const decision = f.decisions.get({ id: first.grant.decisionId! });
    assert.equal(decision.askedBy.agentId, 'planner');
    assert.deepEqual(decision.options, [GRANT_APPROVE, GRANT_DECLINE]);
    assert.match(decision.question, /standing permission/);
    const again = f.request();
    assert.equal(again.joined, true);
    assert.equal(again.grant.id, first.grant.id);
    assert.equal(f.decisions.list({}).filter(item => item.status === 'open').length, 1, 'a repeat request joins the open decision');
    f.answer(first.grant.decisionId!, GRANT_APPROVE);
    reconcileRoutingGrants(f.store, f.decisions);
    const active = readRoutingGrants(f.store).find(grant => grant.id === first.grant.id)!;
    assert.equal(active.status, 'active');
    assert.equal(active.activatedBy, GRANT_OPERATOR_BOARD);
    assert.ok(active.activatedAt);
    const standing = f.request();
    assert.equal(standing.alreadyActive, true);
    assert.equal(standing.grant.id, active.id);
  } finally { f.close(); }
});

test('a covered request raises no decision, records the grant, and next names it', () => {
  const f = fixture(); try {
    const grant = f.activate();
    const task = f.submit();
    f.reconcile(task.id);
    const signed = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(signed.status, 'approved');
    assert.equal(signed.grantId, grant.id);
    assert.equal(f.decisions.list({ task: task.id }).length, 0, 'no per-task decision');
    assert.equal(chooseProfile(f.store.task(task.id), profiles, pool, {}, new Set(), 'reviewer', {}, f.store.usageLevel())?.profile.id, 'sol');
    const policy = f.store.routingPolicy(f.store.task(task.id)).profiles.find(row => row.role === 'reviewer' && row.source === 'request')!;
    assert.equal(policy.signoff?.grantId, grant.id);
    assert.equal(policy.automatic, 'request_frontier', 'a frontier request covered by a grant runs at Normal (Tom, 2026-11-09)');
    assert.match(policy.explanation, new RegExp(`covered by grant ${grant.id.slice(0, 8)}`));
    assert.match(describeRoutePolicy(policy, f.store.usageView()), /covered by grant /);
  } finally { f.close(); }
});

test('an open per-task decision the grant covers settles itself', () => {
  const f = fixture(); try {
    const task = f.submit();
    f.reconcile(task.id);
    const pending = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(pending.status, 'pending');
    const grant = f.activate();
    f.reconcile(task.id);
    const signed = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(signed.status, 'approved');
    assert.equal(signed.grantId, grant.id);
    assert.equal(f.decisions.get({ id: pending.decisionId! }).status, 'withdrawn');
  } finally { f.close(); }
});

test('ending and revoking a grant quietly return covered requests to automatic selection', () => {
  const f = fixture(); try {
    const grant = f.activate();
    const endedTask = f.submit();
    f.reconcile(endedTask.id);
    assert.equal(f.store.task(endedTask.id).profileRequests!.reviewer!.signoff!.grantId, grant.id);
    const ended = applyRoutingGrant(f.store, f.decisions, { action: 'end', caller: 'planner', reason: 'block of work is done' });
    assert.equal(ended.grant.status, 'ended');
    assert.ok(ended.grant.endedAt);
    assert.equal(ended.grant.endedBy, 'planner');
    f.reconcile(endedTask.id);
    const afterEnd = f.store.task(endedTask.id).profileRequests!.reviewer!.signoff!;
    assert.equal(afterEnd.status, 'pending');
    assert.equal(afterEnd.grantId, undefined);
    assert.equal(afterEnd.endedGrantId, grant.id);
    assert.equal(chooseProfile(f.store.task(endedTask.id), profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'cheap');
    f.reconcile(endedTask.id);
    assert.equal(f.decisions.list({ task: endedTask.id }).filter(item => item.status === 'open').length, 0, 'ending a grant does not open per-task sign-off');
    const policy = f.store.routingPolicy(f.store.task(endedTask.id)).profiles.find(row => row.role === 'reviewer' && row.source === 'request')!;
    assert.match(policy.explanation, /covered by grant .*which has ended/);

    const grant2 = f.activate();
    const revokedTask = f.submit();
    f.reconcile(revokedTask.id);
    const revoked = applyRoutingGrant(f.store, f.decisions, { action: 'revoke', caller: GRANT_OPERATOR_BOARD, grantId: grant2.id, reason: 'revoked from the board' });
    assert.equal(revoked.grant.status, 'revoked');
    assert.ok(revoked.grant.endedAt);
    const again = applyRoutingGrant(f.store, f.decisions, { action: 'revoke', caller: GRANT_OPERATOR_BOARD, grantId: grant2.id });
    assert.equal(again.grant.status, 'revoked');
    assert.equal(again.grant.endedAt, revoked.grant.endedAt, 'revoke is idempotent');
    f.reconcile(revokedTask.id);
    assert.equal(f.store.task(revokedTask.id).profileRequests!.reviewer!.signoff!.endedGrantId, grant2.id);
    assert.equal(chooseProfile(f.store.task(revokedTask.id), profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'cheap');
    assert.equal(f.decisions.list({ task: revokedTask.id }).filter(item => item.status === 'open').length, 0);
  } finally { f.close(); }
});

test('a fresh request after a grant ends asks again, and removing a request withdraws its orphaned question', () => {
  const f = fixture(); try {
    const grant = f.activate();
    const task = f.submit();
    f.reconcile(task.id);
    applyRoutingGrant(f.store, f.decisions, { action: 'end', caller: 'planner' });
    f.reconcile(task.id);
    f.store.update(task.id, { profileRequests: { reviewer: { profileId: 'sol', reason: 'Fresh request after grant end', required: true } } });
    f.reconcile(task.id);
    const newDecision = f.store.task(task.id).profileRequests!.reviewer!.signoff!.decisionId!;
    assert.notEqual(newDecision, grant.decisionId);
    assert.equal(f.decisions.get({ id: newDecision }).status, 'open');

    f.store.update(task.id, { profileRequests: {} });
    f.reconcile(task.id);
    assert.equal(f.decisions.get({ id: newDecision }).status, 'withdrawn');
  } finally { f.close(); }
});

test("another planner's task and automatic selection are unaffected", () => {
  const f = fixture(); try {
    f.activate();
    const other = f.submit({ originAgentId: 'other-planner' });
    f.reconcile(other.id);
    const signoff = f.store.task(other.id).profileRequests!.reviewer!.signoff!;
    assert.equal(signoff.status, 'pending');
    assert.equal(signoff.grantId, undefined);
    assert.equal(chooseProfile(f.store.task(other.id), profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'cheap');

    const automatic = f.submit({ profileRequests: undefined });
    f.reconcile(automatic.id);
    assert.equal(automatic.profileRequests?.reviewer, undefined);
    assert.equal(chooseProfile(f.store.task(automatic.id), profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'cheap');
    assert.equal(coveringGrant(f.store, f.store.task(automatic.id), 'cheap'), null, 'a grant never covers automatic selection');
  } finally { f.close(); }
});

test('an agent cannot activate a grant: only a board yes does', () => {
  const f = fixture(); try {
    assert.throws(() => f.request(GRANT_OPERATOR_BOARD), /planner requests a grant/);
    assert.throws(() => applyRoutingGrant(f.store, f.decisions, { action: 'revoke', caller: 'planner', grantId: 'x' }), /Only the operator at the board revokes/);
    const asked = f.request();
    f.answer(asked.grant.decisionId!, GRANT_APPROVE, true);
    reconcileRoutingGrants(f.store, f.decisions);
    assert.equal(readRoutingGrants(f.store).find(grant => grant.id === asked.grant.id)!.status, 'declined');

    const declined = f.request();
    f.answer(declined.grant.decisionId!, GRANT_DECLINE);
    reconcileRoutingGrants(f.store, f.decisions);
    assert.equal(readRoutingGrants(f.store).find(grant => grant.id === declined.grant.id)!.status, 'declined');
    const retry = f.request();
    assert.equal(retry.joined, false, 'a declined grant lets the planner ask again');
  } finally { f.close(); }
});

test('a named grant covers only those profiles; expiry and archive restore the route', () => {
  const f = fixture(); try {
    const named = f.request('planner', { profiles: ['opus'] });
    f.answer(named.grant.decisionId!, GRANT_APPROVE);
    reconcileRoutingGrants(f.store, f.decisions);
    const sol = f.submit();
    f.reconcile(sol.id);
    assert.equal(f.store.task(sol.id).profileRequests!.reviewer!.signoff!.status, 'pending', 'sol is outside the named set');
    const opus = f.submit({ profileRequests: { reviewer: { profileId: 'opus', reason: 'Hard review', required: true } } });
    f.reconcile(opus.id);
    assert.equal(f.store.task(opus.id).profileRequests!.reviewer!.signoff!.status, 'approved');
    applyRoutingGrant(f.store, f.decisions, { action: 'end', caller: 'planner', reason: 'done' });

    const until = new Date(Date.now() + 60_000).toISOString();
    const timed = f.request('planner', { until });
    f.answer(timed.grant.decisionId!, GRANT_APPROVE);
    reconcileRoutingGrants(f.store, f.decisions);
    const covered = f.submit();
    f.reconcile(covered.id);
    assert.equal(f.store.task(covered.id).profileRequests!.reviewer!.signoff!.grantId, timed.grant.id);
    coveringGrant(f.store, f.store.task(covered.id), 'sol', Date.now() + 120_000);
    f.reconcile(covered.id);
    assert.equal(readRoutingGrants(f.store).find(grant => grant.id === timed.grant.id)!.status, 'expired');
    assert.equal(f.store.task(covered.id).profileRequests!.reviewer!.signoff!.status, 'pending');

    const live = f.activate();
    const liveTask = f.submit();
    f.reconcile(liveTask.id);
    archiveRoutingGrants(f.store, f.decisions, new Set(['someone-else']));
    assert.equal(readRoutingGrants(f.store).find(grant => grant.id === live.id)!.status, 'archived');
    f.reconcile(liveTask.id);
    assert.equal(f.store.task(liveTask.id).profileRequests!.reviewer!.signoff!.status, 'pending');
  } finally { f.close(); }
});

test('coverage follows the current owner: reparent away clears a grant sign-off, reparent onto covers it', () => {
  const f = fixture(); try {
    const grant = f.activate();
    const task = f.submit();
    f.reconcile(task.id);
    assert.equal(f.store.task(task.id).profileRequests!.reviewer!.signoff!.grantId, grant.id);
    f.store.update(task.id, { notificationAgentId: 'other-planner' });
    f.reconcile(task.id);
    const away = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(away.status, 'pending');
    assert.equal(away.grantId, undefined);

    const incoming = f.submit({ originAgentId: 'other-planner' });
    f.reconcile(incoming.id);
    assert.equal(f.store.task(incoming.id).profileRequests!.reviewer!.signoff!.status, 'pending');
    f.store.update(incoming.id, { notificationAgentId: 'planner' });
    f.reconcile(incoming.id);
    assert.equal(f.store.task(incoming.id).profileRequests!.reviewer!.signoff!.grantId, grant.id);
  } finally { f.close(); }
});

test('a board route under a grant records the grant; a true operator approval is kept', async () => {
  const f = fixture(); try {
    const grant = f.activate();
    const engine = new Engine(f.store, { profiles: async () => profiles } as unknown as Adapter, 0);
    engine.profiles = profiles;
    const task = f.submit({ profileRequests: undefined });
    const routed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: f.store.task(task.id).version, action: 'route', role: 'reviewer',
      profileId: 'sol', reason: 'Needs strong review', caller: 'planner',
    }));
    assert.equal(routed.profileRequests!.reviewer!.signoff!.grantId, grant.id);
    assert.equal(routed.profileRequests!.reviewer!.signoff!.status, 'approved');

    const board = f.submit({ profileRequests: undefined });
    const signed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: board.id, version: f.store.task(board.id).version, action: 'route', role: 'reviewer',
      profileId: 'sol', reason: 'Operator pick', caller: GRANT_OPERATOR_BOARD,
    }));
    assert.equal(signed.profileRequests!.reviewer!.signoff!.status, 'approved');
    assert.equal(signed.profileRequests!.reviewer!.signoff!.grantId, undefined, 'a true board approval is not rewritten as a grant');
    applyRoutingGrant(f.store, f.decisions, { action: 'revoke', caller: GRANT_OPERATOR_BOARD, grantId: grant.id });
    f.reconcile(board.id);
    assert.equal(f.store.task(board.id).profileRequests!.reviewer!.signoff!.status, 'approved');
    assert.equal(f.store.task(board.id).profileRequests!.reviewer!.signoff!.grantId, undefined);
  } finally { f.close(); }
});

test('run count increments under a live grant and restart keeps the grant', () => {
  const f = fixture(); try {
    const grant = f.activate();
    const task = f.submit();
    f.reconcile(task.id);
    f.store.noteGrantRun(f.store.task(task.id), 'reviewer');
    assert.equal(readRoutingGrants(f.store).find(item => item.id === grant.id)!.runCount, 1);
    f.store.close();
    const reopened = new Store(join(f.dir, 'queue.sqlite'));
    try {
      const kept = reopened.routingGrants().find(item => item.id === grant.id)!;
      assert.equal(kept.status, 'active');
      assert.equal(kept.runCount, 1);
      assert.equal(kept.planner, 'planner');
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('a covered coordinator-route run increments the grant count', () => {
  const f = fixture(); try {
    const grant = f.activate();
    const task = f.submit({
      profileRequests: { coordinator: { profileId: 'sol', reason: 'Coordinator needs frontier', required: true } },
    });
    f.reconcile(task.id);
    assert.equal(f.store.task(task.id).profileRequests!.coordinator!.signoff!.grantId, grant.id);
    f.store.putRun(runSchema.parse({
      id: 'recovery-1', taskId: task.id, role: 'recovery', generation: 1,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'agent', workspaceId: 'workspace',
      profile: profiles[1], status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: true, idleSince: null, completion: null, released: false,
    }));
    assert.equal(readRoutingGrants(f.store).find(item => item.id === grant.id)!.runCount, 1);
    f.store.putRun(runSchema.parse({
      id: 'recovery-1', taskId: task.id, role: 'recovery', generation: 1,
      head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'agent', workspaceId: 'workspace',
      profile: profiles[1], status: 'finished', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: true,
    }));
    assert.equal(readRoutingGrants(f.store).find(item => item.id === grant.id)!.runCount, 1, 'an update of the same run does not count again');
  } finally { f.close(); }
});

test('a grant does not override an explicit per-task decline', () => {
  const f = fixture(); try {
    const task = f.submit();
    f.reconcile(task.id);
    const pending = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    f.answer(pending.decisionId!, SIGNOFF_DECLINE);
    f.reconcile(task.id);
    assert.equal(f.store.task(task.id).profileRequests!.reviewer!.signoff!.status, 'declined');
    f.activate();
    f.reconcile(task.id);
    const kept = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(kept.status, 'declined');
    assert.equal(kept.grantId, undefined);
  } finally { f.close(); }
});

test('resubmitting a declined request with no grant raises a fresh per-task decision', async () => {
  const f = fixture(); try {
    const task = f.submit();
    f.reconcile(task.id);
    f.answer(f.store.task(task.id).profileRequests!.reviewer!.signoff!.decisionId!, SIGNOFF_DECLINE);
    f.reconcile(task.id);
    assert.equal(f.store.task(task.id).profileRequests!.reviewer!.signoff!.status, 'declined');
    const engine = new Engine(f.store, { profiles: async () => profiles } as unknown as Adapter, 0);
    engine.profiles = profiles;
    const changed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: f.store.task(task.id).version, action: 'set_routing', reason: 'Ask again for frontier review',
      caller: 'planner',
      profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } },
    }));
    assert.equal(changed.profileRequests!.reviewer!.signoff, undefined);
    const routed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: changed.id, version: changed.version, action: 'route', role: 'reviewer',
      profileId: 'sol', reason: 'Needs strong review', caller: 'planner',
    }));
    assert.equal(routed.profileRequests!.reviewer!.signoff, undefined);
    f.reconcile(routed.id);
    const signoff = f.store.task(routed.id).profileRequests!.reviewer!.signoff!;
    assert.equal(signoff.status, 'pending');
    assert.ok(signoff.decisionId);
    assert.equal(signoff.grantId, undefined);
  } finally { f.close(); }
});

test('resubmitting a declined request under an active grant does not re-approve it', async () => {
  const f = fixture(); try {
    const task = f.submit();
    f.reconcile(task.id);
    f.answer(f.store.task(task.id).profileRequests!.reviewer!.signoff!.decisionId!, SIGNOFF_DECLINE);
    f.reconcile(task.id);
    f.activate();
    const engine = new Engine(f.store, { profiles: async () => profiles } as unknown as Adapter, 0);
    engine.profiles = profiles;
    const changed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: f.store.task(task.id).version, action: 'set_routing', reason: 'Ask again for frontier review',
      caller: 'planner',
      profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } },
    }));
    assert.equal(changed.profileRequests!.reviewer!.signoff!.status, 'declined');
    assert.equal(changed.profileRequests!.reviewer!.signoff!.grantId, undefined);
    const routed = await engine.performTaskControl(taskControlInputSchema.parse({
      taskId: changed.id, version: changed.version, action: 'route', role: 'reviewer',
      profileId: 'sol', reason: 'Needs strong review', caller: 'planner',
    }));
    assert.equal(routed.profileRequests!.reviewer!.signoff!.status, 'declined');
    assert.equal(routed.profileRequests!.reviewer!.signoff!.grantId, undefined);
    f.reconcile(routed.id);
    assert.equal(f.store.task(routed.id).profileRequests!.reviewer!.signoff!.status, 'declined');
  } finally { f.close(); }
});

test('wake inventories live agents only when a grant is pending or live', () => {
  const f = fixture(); try {
    assert.equal(grantArchiveDue(f.store), false);
    f.request();
    assert.equal(grantArchiveDue(f.store), true);
    f.activate();
    assert.equal(grantArchiveDue(f.store), true);
    applyRoutingGrant(f.store, f.decisions, { action: 'end', caller: 'planner', reason: 'done' });
    assert.equal(grantArchiveDue(f.store), false);
  } finally { f.close(); }
});

test('queue.routing-grant and the board snapshot keep grants across a runtime restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new QueueRuntime({ dataDir: dir, timers: false });
  t.after(() => first.stop());
  first.store.setMeta('pool', pool);
  // Task 1183: the requesting planner belongs to the repo's project, as in production.
  const repo = first.store.projectFor('/repo', null) ?? first.store.ensureProject('/repo', null);
  first.store.setProjectPlanner({ key: repo.key, agentId: 'planner', setBy: 'operator' });
  const asked = first.routingGrant({ action: 'request', caller: 'planner', reason: 'block of work needs frontier' });
  assert.equal(asked.grant.status, 'pending');
  const decision = first.decisions.get({ id: asked.grant.decisionId! });
  first.answerDecision({ id: decision.id, version: decision.version, answer: GRANT_APPROVE, answeredBy: GRANT_OPERATOR_BOARD, relayed: false, note: '' });
  const live = activeRoutingGrants(first.store);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.status, 'active');
  const snap = first.uiSnapshot() as { routingGrants?: Array<{ id: string; planner: string; runCount: number }> };
  assert.equal(snap.routingGrants?.length, 1);
  assert.equal(snap.routingGrants?.[0]?.planner, 'planner');
  await first.stop();
  const restarted = new QueueRuntime({ dataDir: dir, timers: false });
  t.after(() => restarted.stop());
  restarted.store.setMeta('pool', pool);
  const kept = activeRoutingGrants(restarted.store);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.id, asked.grant.id);
  const ended = restarted.routingGrant({ action: 'end', caller: 'planner', reason: 'done' });
  assert.equal(ended.grant.status, 'ended');
  assert.equal(activeRoutingGrants(restarted.store).length, 0);
});


test('qualified planner grants retain legacy ownership and never cover another host', () => {
 const f=fixture();try {
  const caller=formatAgentId('host','planner');
  const grant=f.activate(caller);
  const legacy=f.submit();
  assert.equal(coveringGrant(f.store,legacy,'sol')?.id,grant.id);
  assert.equal(f.request('planner').grant.id,grant.id,'the legacy caller finds its existing grant');
  const other=f.submit({originAgentId:formatAgentId('other-host','planner')});
  assert.equal(coveringGrant(f.store,other,'sol'),null);
  archiveRoutingGrants(f.store,f.decisions,new Set(), 'other-host');
  assert.equal(readRoutingGrants(f.store).find(item=>item.id===grant.id)?.status,'active');
  archiveRoutingGrants(f.store,f.decisions,new Set(['planner']), 'host');
  assert.equal(readRoutingGrants(f.store).find(item=>item.id===grant.id)?.status,'active');
  const ended=applyRoutingGrant(f.store,f.decisions,{action:'end',caller:'planner',grantId:grant.id});
  assert.equal(ended.grant.status,'ended');
 }finally{f.close();}
});
