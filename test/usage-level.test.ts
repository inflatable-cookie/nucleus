import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';

type Board = { unchanged?: true; revision: number; usage?: { level: string; setLevel: string; expired: boolean } };

test('Spec 052: queue.usage sets the level, refuses a past end time, and the board re-projects once when it expires', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nsq-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  const realNow = Date.now;
  try {
    await assert.rejects(runtime.configureUsage({ level: 'maximum', until: new Date(realNow() - 1000).toISOString() }), /must be in the future/);
    const until = new Date(realNow() + 60_000).toISOString();
    assert.deepEqual(await runtime.configureUsage({ level: 'maximum', until }), { level: 'maximum', setLevel: 'maximum', until, expired: false });
    const first = runtime.uiSnapshot() as Board;
    assert.equal(first.usage?.level, 'maximum');
    assert.equal((runtime.uiSnapshot({ revision: first.revision }) as Board).unchanged, true, 'unchanged while the level holds');
    // The end time passes with no durable write.
    Date.now = () => realNow() + 120_000;
    const expired = runtime.uiSnapshot({ revision: first.revision }) as Board;
    assert.equal(expired.unchanged, undefined, 'the poller gets a fresh projection');
    assert.deepEqual([expired.usage?.level, expired.usage?.setLevel, expired.usage?.expired], ['normal', 'maximum', true]);
    assert.equal((runtime.uiSnapshot({ revision: expired.revision }) as Board).unchanged, true, 'and only once');
  } finally { Date.now = realNow; await runtime.stop(); }
});

import { Store } from '../core/store/store';
import { Decisions } from '../core/planning/decisions';
import { chooseProfile } from '../core/dispatch/routing';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { USAGE_GATE_APPROVE, USAGE_GATE_WAIT, reconcileUsageGate, usageGateBlocked } from '../core/dispatch/usage-gate';
import { automaticReachable, automaticSelection, automaticSelectionTag, demandRank, describeAutomaticSelection, requestOnly } from '../shared/pool';
import { requestedTier, workerStartTier } from '../shared/demand';
import { configurePool, poolSchema, submissionSchema, usageLevels, type Profile, type Task, type UsageLevel, type UsageView } from '../shared/contracts';

const policyProfile = (id: string): Profile => ({ id, name: id, provider: 'test', model: `test/${id}`, available: true, problem: '', notes: '', supportedThinking: [] });
const capabilities = [null, 'mechanical', 'worker', 'heavyweight', 'frontier'] as const;
const policyEntry = (profileId: string, capability: typeof capabilities[number], extra: Record<string, unknown> = {}) =>
  poolSchema.parse({ profileId, enabled: true, group: profileId, roles: ['worker', 'reviewer', 'coordinator'], weight: 'default', scopes: ['general'], capability, ...extra });

test('Spec 052 diagnostics: the explanation matches what chooseProfile does, for every level, tier and requested tier', () => {
  const store = new Store(':memory:');
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'matrix', title: 'Matrix', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    for (const level of usageLevels) for (const capability of capabilities) for (const complexity of ['medium', 'high', 'very_high'] as const) {
      const requested = requestedTier(complexity);
      const entry = policyEntry('p', capability), profiles = [policyProfile('p')];
      const automatic = automaticSelection(entry, level, requested);
      const label = `${level}/${capability}/${complexity}`;
      const adopt = task.complexity === complexity ? task : store.update(task.id, { complexity });
      for (const role of ['worker', 'reviewer', 'coordinator'] as const) {
        const automaticRole = automaticSelection(entry, level, requested, undefined, role);
        const picked = chooseProfile(adopt, profiles, [entry], {}, new Set(), role, {}, level)?.profile.id ?? null;
        assert.equal(picked === 'p', automaticRole === 'allowed', `${label} ${role}: automatic selection agrees with the explanation`);
        const requestedProfile = { ...adopt, profileRequests: { [role]: { profileId: 'p', reason: 'Owner request', required: false } } };
        // Maximum no longer reserves Heavyweight and Frontier (Tom, 2026-11-23), so a request applies at every level.
        assert.equal(chooseProfile(requestedProfile, profiles, [entry], {}, new Set(), role, {}, level)?.profile.id,
          'p', `${label} ${role}: the explicit request applies directly`);
      }
      // Cost is never the permission rule (Tom, 2026-11-17), and a tier at or
      // below the task's requested tier is automatic whenever the level's
      // permission rule does not hold it.
      if (level !== 'maximum' && !requestOnly(entry, level, requested) && (capability === null || demandRank(capability) <= demandRank(requested)))
        assert.equal(automatic, 'allowed', `${label}: a covered tier at or below the requested tier is automatic`);
      // The level's tier rule and the task's requested-tier bound are the two
      // automatic bounds, never the climb exception before a recorded climb.
      assert.equal(automatic === 'request_tier', !automaticReachable(entry, level, requested), label);
      const usage: UsageView = { level, setLevel: level, until: null, expired: false };
      const text = describeAutomaticSelection(entry, usage, iso => iso, requested);
      assert.equal(/permission|request-only|explicit route/.test(text), automatic === 'request_tier', `${label}: "${text}"`);
      assert.equal(automaticSelectionTag(entry, level, requested) !== '', automatic === 'request_tier', label);
      assert.ok(automaticSelectionTag(entry, level, requested).length <= 16, `${label}: the button tag stays short enough not to overflow a compact chooser`);
    }
  } finally { store.close(); }
});

test('dispatch usage level drives routing with subscription gauge storage removed', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='usage_samples'").get(), undefined);
    const task = store.insert(submissionSchema.parse({ submissionId: 'level-without-gauge', title: 'Level without gauge', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', preferredProfileId: 'frontier', complexity: 'medium' }), 'host', 'handoff', 'a'.repeat(40));
    const entry = policyEntry('frontier', 'frontier');
    store.setMeta('pool', [entry]);
    store.setMeta('usageLevel', { level: 'maximum', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const maximum = store.routingPolicy(task, Date.now(), [policyProfile('frontier')]);
    assert.equal(maximum.profiles.find(profile => profile.profileId === 'frontier')?.automatic, 'allowed');
    store.setMeta('usageLevel', { level: 'normal', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const normal = store.routingPolicy(task, Date.now(), [policyProfile('frontier')]);
    assert.equal(normal.profiles.find(profile => profile.profileId === 'frontier')?.automatic, 'request_tier');
    assert.notEqual(maximum.selection?.demand, normal.selection?.demand, 'the stored level still changes dispatch demand without gauge samples');
  } finally { store.close(); }
});

test('Spec 052 diagnostics: next and a cached detail read explain the policy fresh, through expiry, beside other gates', () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('pool', [
      policyEntry('frontier', 'frontier'),
      policyEntry('cheap-flag', 'frontier'),
      policyEntry('pricey', 'heavyweight'),
      policyEntry('off', 'frontier', { enabled: false }),
    ]);
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'policy', title: 'Policy', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'medium',
      preferredProfileId: 'cheap-flag', profileRequests: { reviewer: { profileId: 'off', reason: 'Owner route', required: false }, coordinator: { profileId: 'gone', reason: 'Owner route', required: false } } }), 'host', 'handoff', 'a'.repeat(40));
    const task = store.update(inserted.id, { profile: policyProfile('frontier'), resolution: { ...inserted.resolution, reviewerProfile: policyProfile('pricey') } });
    // The expiry is relative to the real clock: task.next reads it (milestone QA 2ceec381).
    const until = new Date(Date.now() + 3_600_000).toISOString(), before = Date.parse(until) - 60_000, after = Date.parse(until) + 60_000;
    store.setMeta('usageLevel', { level: 'maximum', until, setAt: '2026-10-19T00:00:00.000Z' });
    const rows = (at: number) => Object.fromEntries(store.routingPolicy(store.task(task.id), at).profiles.map(p => [`${p.role}:${p.profileId}`, p]));

    const lifted = rows(before);
    assert.deepEqual(Object.keys(lifted), ['worker:cheap-flag', 'worker:frontier', 'reviewer:off', 'reviewer:pricey', 'coordinator:gone']);
    assert.equal(lifted['worker:frontier']!.source, 'dispatched');
    assert.equal(lifted['worker:frontier']!.automatic, 'allowed');
    assert.equal(lifted['worker:frontier']!.capability, 'frontier');
    assert.match(lifted['worker:frontier']!.explanation, new RegExp(String.raw`^Recorded worker run used it \(history, not today's policy\); automatic selection: Frontier · Automatic at Maximum until ${until}$`));
    assert.equal(lifted['worker:cheap-flag']!.automatic, 'allowed', 'a cheap frontier profile is automatic at Maximum');
    // Usage permission never masks a hard gate, and an explicit request stays explicit.
    assert.equal(lifted['reviewer:off']!.automatic, 'allowed');
    assert.deepEqual(lifted['reviewer:off']!.gates, ['disabled in the pool']);
    assert.match(lifted['reviewer:off']!.explanation, /^Explicit reviewer request: Owner route; .*; also disabled in the pool$/);
    assert.equal(lifted['coordinator:gone']!.automatic, null);
    assert.match(lifted['coordinator:gone']!.explanation, /not in the pool/);

    const normal = rows(after);
    assert.equal(normal['worker:frontier']!.automatic, 'request_tier');
    assert.match(normal['worker:frontier']!.explanation, new RegExp(String.raw`^Recorded worker run used it \(history, not today's policy\); automatic selection: Frontier: above the task's Worker bracket, so an explicit route is required \(Maximum ended ${until}\)$`));
    assert.equal(normal['reviewer:pricey']!.automatic, 'request_tier', 'Heavyweight needs permission at Normal for a medium task');
    assert.equal(normal['worker:cheap-flag']!.automatic, 'request_tier', 'below Maximum a frontier profile needs a request whatever its cost');
    assert.match(normal['worker:cheap-flag']!.explanation, /^Worker preference; automatic selection: Frontier: above the task's Worker bracket, so an explicit route is required \(Maximum ended .*\); a preference alone does not select it$/);
    store.setMeta('usageLevel', { level: 'high', until: null, setAt: '2026-10-19T00:00:00.000Z' });
    assert.equal(rows(after)['reviewer:pricey']!.automatic, 'allowed', 'a reviewer is not capped at the task\'s Worker bracket; at High only Frontier needs a request (Tom, 2026-11-18)');
    assert.equal(rows(after)['worker:cheap-flag']!.automatic, 'request_tier', 'at High frontier still needs a request');
    store.setMeta('usageLevel', { level: 'extra_high', until: null, setAt: '2026-10-19T00:00:00.000Z' });
    assert.equal(rows(after)['worker:cheap-flag']!.automatic, 'request_tier', 'at Extra high a Frontier profile still sits above a medium task\'s Worker bracket');
    assert.match(rows(after)['worker:cheap-flag']!.explanation, /above the task's Worker bracket/);
    store.setMeta('usageLevel', { level: 'maximum', until, setAt: '2026-10-19T00:00:00.000Z' });

    // task.next reads the same projection; nothing about the task or settings changes.
    const version = store.task(task.id).version;
    const next = ownerTaskNext(collectOwnerVerbFacts(store, store.task(task.id)));
    assert.equal(next.routingPolicy?.usage.level, 'maximum');
    assert.equal(store.task(task.id).version, version);

    // The detail payload is cached, the policy is not: expiry shows on the next read inside the cache window.
    let clock = before;
    const read = createTaskDetailCache(store, { now: () => clock, maxAgeMs: 3_600_000 });
    const first = read(task.id);
    assert.equal(first.routingPolicy.usage.level, 'maximum');
    assert.equal(first.routingPolicy.profiles.find(p => p.profileId === 'frontier')!.automatic, 'allowed');
    clock = after;
    const second = read(task.id);
    assert.equal(second.events, first.events, 'the bounded payload came from the cache');
    assert.deepEqual([second.routingPolicy.usage.level, second.routingPolicy.usage.expired], ['normal', true]);
    assert.equal(second.routingPolicy.profiles.find(p => p.profileId === 'frontier')!.automatic, 'request_tier');
    assert.deepEqual(store.usageSetting(), { level: 'maximum', until, setAt: '2026-10-19T00:00:00.000Z' }, 'no read writes the setting');
  } finally { store.close(); }
});

test('Spec 052: the board explains a recorded climb at the bracket it earned', () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('pool', [policyEntry('wide', 'heavyweight'), policyEntry('frontier', 'frontier')]);
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'climbed-board', title: 'Climbed', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    const task = store.update(inserted.id, { profile: policyProfile('wide'), completion: null });
    store.setMeta('usageLevel', { level: 'normal', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const before = store.routingPolicy(store.task(task.id), Date.now());
    assert.equal(before.requested, 'heavyweight', 'a high task may climb to Heavyweight');
    assert.equal(before.climbTier, null);
    assert.equal(before.profiles.find(row => row.profileId === 'wide')?.automatic, 'request_tier', 'before the climb Heavyweight is held');
    assert.match(before.profiles.find(row => row.profileId === 'wide')!.explanation, /Heavyweight: request-only at Normal/);
    store.update(task.id, { resolution: { ...store.task(task.id).resolution,
      workerClimb: { reviewRunId: 'review-1', from: 'worker', to: 'heavyweight', profileId: 'wide', at: '2026-11-17T00:00:00.000Z' } } });
    const climbed = store.routingPolicy(store.task(task.id), Date.now());
    assert.equal(climbed.climbTier, 'heavyweight');
    const row = climbed.profiles.find(item => item.profileId === 'wide')!;
    assert.equal(row.automatic, 'allowed', 'the recorded climb covers Heavyweight');
    assert.match(row.explanation, /Automatic at Normal/);
  } finally { store.close(); }
});

test('052 migration: a stored minimal level reads as low, and normal, high and maximum are unchanged across an open', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-usage-migration-'));
  try {
    const path = join(dir, 'queue.sqlite');
    const seed = new Store(path);
    seed.setMeta('usageLevel', { level: 'minimal', until: null, setAt: '2026-10-18T00:00:00.000Z' });
    seed.close();
    const reopened = new Store(path);
    try {
      assert.deepEqual(reopened.usageSetting(), { level: 'low', until: null, setAt: '2026-10-18T00:00:00.000Z' }, 'the stored minimal name reads as low');
      assert.equal(reopened.usageLevel(), 'low');
      const raw = reopened.getMeta<Record<string, unknown>>('usageLevel')!;
      assert.equal(raw.level, 'low', 'the migration rewrites the stored name, so no reader sees minimal');
    } finally { reopened.close(); }
    for (const level of ['normal', 'high', 'maximum'] as const) {
      const first = new Store(path);
      first.setMeta('usageLevel', { level, until: null, setAt: '2026-11-17T00:00:00.000Z' });
      first.close();
      const next = new Store(path);
      try {
        assert.equal(next.usageSetting()?.level, level, `a stored ${level} is unchanged (the live setting is high)`);
      } finally { next.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('052: on Low, submitting a high or very-high complexity task opens a decision and holds it until approved, then it starts one bracket below and can climb back', () => {
  const store = new Store(':memory:');
  try {
    const entries = [
      policyEntry('a-worker', 'worker'),
      policyEntry('z-heavyweight', 'heavyweight'),
      policyEntry('frontier', 'frontier'),
    ];
    const profiles = entries.map(entry => policyProfile(entry.profileId));
    store.setMeta('pool', entries);
    store.setMeta('usageLevel', { level: 'low', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const task = store.insert(submissionSchema.parse({ submissionId: 'gated', title: 'Gated', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    const decisions = new Decisions(store);
    reconcileUsageGate(store, decisions, task.id);
    const gated = store.task(task.id);
    assert.equal(gated.usageGate?.status, 'pending');
    assert.equal(gated.reason, USAGE_GATE_WAIT, 'the queued task reads its own wait');
    assert.ok(gated.holds.dispatch, 'the task is held with a dispatch fence');
    assert.equal(gated.holds.dispatch!.owner, 'operator (board)');
    assert.equal(usageGateBlocked(gated, 'low'), true, 'dispatch refuses while the gate is pending');
    const decision = decisions.get({ id: gated.usageGate!.decisionId! });
    assert.equal(decision.status, 'open', 'one decision is open on the board');
    assert.deepEqual(decision.links.tasks, [task.id], 'and it is tied to the task');
    assert.equal(workerStartTier('low', 'high'), 'worker', 'the task starts one bracket below Heavyweight');

    // Approve on the board: the fence clears and the task may dispatch.
    decisions.answer({ id: decision.id, version: decision.version, answer: USAGE_GATE_APPROVE, answeredBy: 'operator (board)', relayed: false, note: '' });
    reconcileUsageGate(store, decisions, task.id);
    const approved = store.task(task.id);
    assert.equal(approved.usageGate?.status, 'approved');
    assert.equal(approved.holds.dispatch, undefined, 'the gate clears its own fence');
    assert.equal(approved.reason, 'Waiting for dispatch');
    assert.equal(usageGateBlocked(approved, 'low'), false, 'the approved task dispatches');
    // It runs on Worker, and a revision after review changes climbs to Heavyweight.
    assert.equal(chooseProfile(approved, profiles, entries, {}, new Set(), 'worker', {}, 'low', true)?.profile.id, 'a-worker');
    const reviewing = { ...approved, resolution: { ...approved.resolution, review: { eventId: 'review-1', taskId: approved.id, runId: 'review-1', status: 'changes_required' as const, summary: 'Fix the defect', head: 'a'.repeat(40) } } };
    assert.equal(chooseProfile(reviewing, profiles, entries, {}, new Set(), 'worker', {}, 'low', false)?.profile.id, 'z-heavyweight');
    assert.ok(!chooseProfile(reviewing, profiles, entries, {}, new Set(), 'worker', {}, 'low', false)?.profile.id.includes('frontier'),
      'a Frontier run above the climb bracket still needs its own request');
  } finally { store.close(); }
});

test('052: a declined Low gate keeps the task held, and lowering its complexity releases it and withdraws the question', () => {
  const store = new Store(':memory:');
  try {
    const entries = [policyEntry('a-worker', 'worker'), policyEntry('z-heavyweight', 'heavyweight')];
    store.setMeta('pool', entries);
    store.setMeta('usageLevel', { level: 'low', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const task = store.insert(submissionSchema.parse({ submissionId: 'gated-declined', title: 'Gated', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    const decisions = new Decisions(store);
    reconcileUsageGate(store, decisions, task.id);
    const decision = decisions.get({ id: store.task(task.id).usageGate!.decisionId! });
    decisions.answer({ id: decision.id, version: decision.version, answer: 'Decline: keep it held', answeredBy: 'operator (board)', relayed: false, note: '' });
    reconcileUsageGate(store, decisions, task.id);
    const declined = store.task(task.id);
    assert.equal(declined.usageGate?.status, 'declined');
    assert.ok(declined.holds.dispatch, 'a decline keeps the fence: the task does not run without permission');
    assert.equal(usageGateBlocked(declined, 'low'), true);

    // The owner lowers the complexity; the level no longer gates it and the hold clears.
    store.update(task.id, { complexity: 'medium' });
    reconcileUsageGate(store, decisions, task.id);
    const released = store.task(task.id);
    assert.equal(released.usageGate, null);
    assert.equal(released.holds.dispatch, undefined);
    assert.equal(usageGateBlocked(released, 'low'), false);
  } finally { store.close(); }
});

test('052: the Low gate is decided at admission, so a level change never holds work submitted earlier or already started', () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('usageLevel', { level: 'normal', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const submitted = store.insert(submissionSchema.parse({ submissionId: 'before-low', title: 'Before low', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    assert.equal(submitted.usageGate ?? null, null, 'a submission made under Normal carries no gate');
    store.setMeta('usageLevel', { level: 'low', until: null, setAt: '2026-11-17T01:00:00.000Z' });
    const decisions = new Decisions(store);
    reconcileUsageGate(store, decisions, submitted.id);
    const after = store.task(submitted.id);
    assert.equal(after.usageGate ?? null, null, 'the level change never retroactively gates accepted work');
    assert.equal(after.holds.dispatch, undefined);
    assert.equal(usageGateBlocked(after, 'low'), false);

    // An already-started task that was admitted under Low keeps its gate only as
    // history: dispatching is no longer refused once it is running.
    store.setMeta('usageLevel', { level: 'low', until: null, setAt: '2026-11-17T02:00:00.000Z' });
    const started = store.insert(submissionSchema.parse({ submissionId: 'started-under-low', title: 'Started', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    assert.equal(started.usageGate?.status, 'pending');
    store.update(started.id, { usageGate: { ...started.usageGate!, status: 'approved' }, phase: 'working', agentId: 'worker', runId: 'run', workspaceId: 'ws', directory: '/worktree' });
    assert.equal(usageGateBlocked(store.task(started.id), 'low'), false, 'an approved/running task dispatches');
  } finally { store.close(); }
});

test('052: a pre-existing board hold is never replaced by the Low gate, and approving the gate does not clear it', () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('usageLevel', { level: 'low', until: null, setAt: '2026-11-17T00:00:00.000Z' });
    const task = store.insert(submissionSchema.parse({ submissionId: 'already-held', title: 'Already held', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin', complexity: 'high' }), 'host', 'handoff', 'a'.repeat(40));
    assert.equal(task.usageGate?.status, 'pending');
    const fence = { owner: 'operator (board)', reason: 'Operator board hold', at: '2026-11-17T03:00:00.000Z', generation: 1, until: null };
    store.update(task.id, { holds: { dispatch: fence }, held: true, holdOwner: fence.owner, holdReason: fence.reason, holdAt: fence.at, holdGeneration: 1 });
    const decisions = new Decisions(store);
    reconcileUsageGate(store, decisions, task.id);
    const gated = store.task(task.id);
    assert.equal(gated.holds.dispatch?.reason, 'Operator board hold', 'the existing hold stays the visible fence');
    assert.equal(gated.holds.dispatch?.at, fence.at);
    assert.equal(gated.usageGate?.holdAt, null, 'the gate records that it placed no fence');
    const decision = decisions.get({ id: gated.usageGate!.decisionId! });
    decisions.answer({ id: decision.id, version: decision.version, answer: USAGE_GATE_APPROVE, answeredBy: 'operator (board)', relayed: false, note: '' });
    reconcileUsageGate(store, decisions, task.id);
    const approved = store.task(task.id);
    assert.equal(approved.usageGate?.status, 'approved');
    assert.equal(approved.holds.dispatch?.reason, 'Operator board hold', 'approval clears only the gate\'s own fence, never the operator\'s hold');
  } finally { store.close(); }
});

test('task 1002 and nucleus#1385: the store step drops stored By request flags and moves five-point capabilities to brackets; a stale write does too', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-by-request-'));
  try {
    const path = join(dir, 'queue.sqlite');
    const first = new Store(path);
    first.setMeta('pool', [
      { profileId: 'sol', enabled: true, group: 'openai', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'very_high', byRequest: true },
      { profileId: 'deepseek', enabled: true, group: 'deepseek', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'low', capability: 'high', byRequest: true },
      { profileId: 'muse', enabled: true, group: 'muse', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_low', capability: 'very_low' },
      { profileId: 'glm', enabled: true, group: 'zai', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'low', capability: 'medium' },
    ]);
    first.close();
    const reopened = new Store(path);
    try {
      const raw = reopened.getMeta<Record<string, unknown>[]>('pool')!;
      assert.equal(raw.some(entry => 'byRequest' in entry), false, 'no stored profile carries a by-request flag after the store step');
      assert.deepEqual(raw.map(entry => entry.capability), ['heavyweight', 'worker', 'mechanical', 'worker']);
      assert.deepEqual(reopened.pool().map(entry => [entry.profileId, entry.capability]),
        [['sol', 'heavyweight'], ['deepseek', 'worker'], ['muse', 'mechanical'], ['glm', 'worker']]);
      assert.equal(automaticSelection(reopened.pool().find(entry => entry.profileId === 'sol')!, 'high'), 'allowed', 'Heavyweight is automatic at High');
      assert.equal(automaticSelection({ capability: 'frontier' }, 'high'), 'request_tier', 'a Frontier profile still needs permission at High');
    } finally { reopened.close(); }
    const stale = configurePool.input.parse({ entries: [{ profileId: 'sol', enabled: true, group: 'openai', roles: ['worker'], weight: 1, scopes: ['general'], byRequest: true, capability: 'very_low' }] });
    assert.deepEqual([('byRequest' in stale.entries[0]!), stale.entries[0]!.capability], [false, 'mechanical'], 'an older client write reads without the flag, on its bracket');
    assert.throws(() => poolSchema.parse({ profileId: 'x', enabled: true, group: 'x', roles: ['worker'], weight: 1, scopes: ['general'], byRequest: true }), 'the pool schema no longer accepts the flag');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
