import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { Decisions } from '../core/planning/decisions';
import { chooseProfile } from '../core/dispatch/routing';
import { reconcileRoutingSignoffs, SIGNOFF_DECLINE, signoffApprove, signoffUse } from '../core/dispatch/routing-signoff';
import { poolSchema, submissionSchema, taskControlInputSchema, type Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';

/**
 * Spec 052 routing sign-off (Tom, 2026-10-21): a request above the usage level,
 * or for a frontier profile below Maximum, applies only once the operator signs it off on
 * the board; until then the role runs on automatic selection and nothing waits.
 */
const profile = (id: string): Profile => ({ id, name: id === 'sol' ? 'Sol oracle' : id, provider: 'test', model: `test/${id}`, available: true, problem: '', notes: '', supportedThinking: id === 'opus' ? ['xhigh'] : [] });
const profiles = ['cheap', 'sol', 'opus'].map(profile);
const pool = [
  poolSchema.parse({ profileId: 'cheap', enabled: true, group: 'cheap', roles: ['worker', 'reviewer', 'coordinator'], weight: 1, scopes: ['general'], cost: 'low' }),
  poolSchema.parse({ profileId: 'sol', enabled: true, group: 'sol', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'high', capability: 'frontier' }),
  poolSchema.parse({ profileId: 'opus', enabled: true, group: 'opus', roles: ['worker', 'reviewer'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'frontier' }),
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-signoff-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('pool', pool);
  const decisions = new Decisions(store);
  const submit = (extra: Record<string, unknown> = {}) => store.insert(submissionSchema.parse({ submissionId: `signoff-${Math.random()}`, title: 'Signed task',
    repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'planner',
    profileRequests: { reviewer: { profileId: 'sol', reason: 'Independent complete review', required: true } }, ...extra }), 'host', 'handoff', 'a'.repeat(40));
  const reconcile = (id: string) => reconcileRoutingSignoffs(store, decisions, id, profiles);
  const answer = (id: string, text: string, relayed = false) => {
    const decision = decisions.get({ id });
    return decisions.answer({ id, version: decision.version, answer: text, answeredBy: relayed ? 'supervisor' : 'operator (board)', relayed, note: relayed ? 'Tom said yes' : '' });
  };
  return { dir, store, decisions, submit, reconcile, answer, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('an unsigned request for a frontier profile pins nothing and never waits; a signed one is used', () => {
  const f = fixture(); try {
    const task = f.submit();
    assert.equal(task.profileRequests?.reviewer?.requestedBy, 'planner', 'the submission records who asked');
    assert.equal(task.profileRequests?.reviewer?.signoff, undefined);
    assert.equal(chooseProfile(task, profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'cheap', 'a required unsigned request runs on automatic selection');
    const signed = { ...task, profileRequests: { reviewer: { ...task.profileRequests!.reviewer!, signoff: { status: 'approved' as const, decisionId: 'd', by: 'operator (board)', at: 'now', note: '' } } } };
    assert.equal(chooseProfile(signed, profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'sol');
    // A submission cannot carry its own sign-off.
    const smuggled = f.submit({ profileRequests: { reviewer: { profileId: 'sol', reason: 'x', required: true,
      signoff: { status: 'approved', decisionId: null, by: 'operator (board)', at: 'now', note: '' } } } });
    assert.equal(smuggled.profileRequests?.reviewer?.signoff, undefined, 'Queue writes the sign-off, never a submission');
  } finally { f.close(); }
});

test('Queue asks once, and a board approval signs the request off', () => {
  const f = fixture(); try {
    const task = f.submit();
    f.reconcile(task.id);
    const pending = f.store.task(task.id).profileRequests!.reviewer!.signoff!;
    assert.equal(pending.status, 'pending');
    const decision = f.decisions.get({ id: pending.decisionId! });
    assert.equal(decision.askedBy.agentId, 'planner', 'the question is asked on the requester\'s behalf');
    assert.deepEqual(decision.links.tasks, [task.id]);
    assert.match(decision.question, /reviewer: use Sol oracle\? It is rated frontier, which is request-only below Maximum\./);
    assert.deepEqual(decision.options, [signoffApprove('Sol oracle'), SIGNOFF_DECLINE, signoffUse('cheap'), signoffUse('opus')]);
    assert.match(decision.context ?? '', /Independent complete review/);
    f.reconcile(task.id);
    assert.equal(f.decisions.list({ task: task.id }).length, 1, 'a second pass asks nothing new');
    f.answer(decision.id, signoffApprove('Sol oracle'));
    f.reconcile(task.id);
    const signed = f.store.task(task.id);
    assert.equal(signed.profileRequests!.reviewer!.signoff!.status, 'approved');
    assert.equal(chooseProfile(signed, profiles, pool, {}, new Set(), 'reviewer', {}, f.store.usageLevel())?.profile.id, 'sol');
    assert.ok(f.store.eventsAll(task.id).some(event => event.kind === 'routing_signoff'));
  } finally { f.close(); }
});

test('the operator can pick another profile, decline, or answer by relay (which declines)', () => {
  const f = fixture(); try {
    const chosen = f.submit(); f.reconcile(chosen.id);
    f.answer(f.store.task(chosen.id).profileRequests!.reviewer!.signoff!.decisionId!, signoffUse('opus'));
    f.reconcile(chosen.id);
    assert.deepEqual([f.store.task(chosen.id).profileRequests!.reviewer!.profileId, f.store.task(chosen.id).profileRequests!.reviewer!.signoff!.status], ['opus', 'approved']);

    const declined = f.submit(); f.reconcile(declined.id);
    f.answer(f.store.task(declined.id).profileRequests!.reviewer!.signoff!.decisionId!, SIGNOFF_DECLINE);
    f.reconcile(declined.id);
    assert.equal(f.store.task(declined.id).profileRequests!.reviewer!.signoff!.status, 'declined');
    assert.equal(chooseProfile(f.store.task(declined.id), profiles, pool, {}, new Set(), 'reviewer')?.profile.id, 'cheap');

    const relayed = f.submit(); f.reconcile(relayed.id);
    f.answer(f.store.task(relayed.id).profileRequests!.reviewer!.signoff!.decisionId!, signoffApprove('Sol oracle'), true);
    f.reconcile(relayed.id);
    const signoff = f.store.task(relayed.id).profileRequests!.reviewer!.signoff!;
    assert.equal(signoff.status, 'declined', 'only a board answer signs off');
    assert.match(signoff.note, /relayed answer does not sign off/);
  } finally { f.close(); }
});

test('a level that covers the profile withdraws the question; a finished task withdraws its open ones', () => {
  const f = fixture(); try {
    const covered = f.submit({ profileRequests: { worker: { profileId: 'opus', reason: 'Hard work', required: true } } });
    f.reconcile(covered.id);
    const first = f.store.task(covered.id).profileRequests!.worker!.signoff!.decisionId!;
    f.store.setMeta('usageLevel', { level: 'maximum', until: null, setAt: new Date().toISOString() });
    f.reconcile(covered.id);
    assert.equal(f.decisions.get({ id: first }).status, 'withdrawn', 'Maximum covers very_high: nothing to sign off');
    f.store.setMeta('usageLevel', { level: 'normal', until: null, setAt: new Date().toISOString() });

    const finished = f.submit(); f.reconcile(finished.id);
    const open = f.store.task(finished.id).profileRequests!.reviewer!.signoff!.decisionId!;
    f.store.update(finished.id, { phase: 'done', finishedAt: new Date().toISOString(), reason: 'Closed' });
    f.reconcile(finished.id);
    assert.equal(f.decisions.get({ id: open }).status, 'withdrawn');
  } finally { f.close(); }
});

test('the operator\'s board route is its own sign-off; another route is asked, and route now to an unsigned profile is refused', async () => {
  const f = fixture(); try {
    const engine = new Engine(f.store, { profiles: async () => profiles } as unknown as Adapter, 0);
    engine.profiles = profiles;
    const task = f.submit({ profileRequests: undefined });
    const route = (caller: string, profileId: string, now = false) => engine.performTaskControl(taskControlInputSchema.parse({
      taskId: task.id, version: f.store.task(task.id).version, action: 'route', role: 'reviewer', profileId, reason: 'Needs strong review', caller, ...(now ? { now: true } : {}) }));
    const board = await route('operator (board)', 'sol');
    assert.deepEqual([board.profileRequests!.reviewer!.requestedBy, board.profileRequests!.reviewer!.signoff?.status], ['operator (board)', 'approved']);
    const owner = await route('owner-thread', 'opus');
    assert.deepEqual([owner.profileRequests!.reviewer!.requestedBy, owner.profileRequests!.reviewer!.signoff], ['owner-thread', undefined]);
    // PR 825 (task 577): the refusal is decided inside the route, so the request
    // is recorded even when `now` names an unsigned profile.
    await assert.rejects(route('owner-thread', 'opus', true), /needs the operator's board sign-off before a route can replace a live run/);
  } finally { f.close(); }
});

test('an answer maps through the options as asked, even if the catalog renames profiles before Queue reads it (Sol, #580)', () => {
  const f = fixture(); try {
    const task = f.submit(); f.reconcile(task.id);
    const id = f.store.task(task.id).profileRequests!.reviewer!.signoff!.decisionId!;
    f.answer(id, signoffUse('cheap'));
    // The catalog swaps the two names before the next pass.
    const swapped = profiles.map(item => item.id === 'cheap' ? { ...item, name: 'opus' } : item.id === 'opus' ? { ...item, name: 'cheap' } : item);
    reconcileRoutingSignoffs(f.store, f.decisions, task.id, swapped);
    assert.deepEqual([f.store.task(task.id).profileRequests!.reviewer!.profileId, f.store.task(task.id).profileRequests!.reviewer!.signoff!.status], ['cheap', 'approved']);
  } finally { f.close(); }
});

test('an unsigned worker route keeps its thinking level on the request, so automatic selection is not blocked by it (Sol, #580)', async () => {
  const f = fixture(); try {
    const engine = new Engine(f.store, { profiles: async () => profiles } as unknown as Adapter, 0);
    engine.profiles = profiles;
    const task = f.submit({ profileRequests: undefined });
    const routed = await engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id, version: f.store.task(task.id).version, action: 'route', role: 'worker',
      profileId: 'opus', reason: 'Hard work', thinkingOptionId: 'xhigh', caller: 'owner-thread' }));
    assert.equal(routed.thinkingOptionId, '', 'the task-level thinking is unchanged');
    assert.equal(routed.profileRequests!.worker!.thinkingOptionId, 'xhigh');
    assert.equal(chooseProfile(routed, profiles, pool, {}, new Set(), 'worker')?.profile.id, 'cheap', 'automatic selection is not held to the unsigned level');
    const signed = { ...routed, profileRequests: { worker: { ...routed.profileRequests!.worker!, signoff: { status: 'approved' as const, decisionId: 'd', by: 'operator (board)', at: 'now', note: '' } } } };
    const picked = chooseProfile(signed, profiles, pool, {}, new Set(), 'worker');
    assert.deepEqual([picked?.profile.id, picked?.profile.thinkingOptionId], ['opus', 'xhigh'], 'once signed off the route runs at its level');
  } finally { f.close(); }
});

test('a later route validates against the honoured thinking level, not an unsigned request\'s (Sol, #580)', async () => {
  const f = fixture(); try {
    const engine = new Engine(f.store, { profiles: async () => profiles } as unknown as Adapter, 0);
    engine.profiles = profiles;
    const task = f.submit({ profileRequests: undefined });
    const route = (profileId: string, extra: Record<string, unknown> = {}) => engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id,
      version: f.store.task(task.id).version, action: 'route', role: 'worker', profileId, reason: 'Owner choice', caller: 'owner-thread', ...extra }));
    await route('opus', { thinkingOptionId: 'xhigh' });
    const cheap = await route('cheap');
    assert.equal(cheap.profileRequests!.worker!.profileId, 'cheap', 'the unsigned xhigh level does not refuse a route to a profile without it');
  } finally { f.close(); }
});
