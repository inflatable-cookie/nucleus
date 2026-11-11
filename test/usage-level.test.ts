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
import { chooseProfile } from '../core/dispatch/routing';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { automaticSelection, automaticSelectionTag, describeAutomaticSelection } from '../shared/pool';
import { configurePool, poolSchema, submissionSchema, usageLevels, type Profile, type UsageView } from '../shared/contracts';

const costs = ['very_low', 'low', 'medium', 'high', 'very_high', null] as const;
const policyProfile = (id: string): Profile => ({ id, name: id, provider: 'test', model: `test/${id}`, available: true, problem: '', notes: '', supportedThinking: [] });
const capabilities = [null, 'very_high', 'frontier'] as const;
const policyEntry = (profileId: string, cost: typeof costs[number], capability: typeof capabilities[number], extra: Record<string, unknown> = {}) =>
  poolSchema.parse({ profileId, enabled: true, group: profileId, roles: ['worker', 'reviewer', 'coordinator'], weight: 1, scopes: ['general'], cost, capability, ...extra });

test('Spec 052 diagnostics: the explanation matches what chooseProfile does, for every level, cost and capability', () => {
  const store = new Store(':memory:');
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: 'matrix', title: 'Matrix', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    for (const level of usageLevels) for (const cost of costs) for (const capability of capabilities) {
      const entry = policyEntry('p', cost, capability), profiles = [policyProfile('p')];
      const automatic = automaticSelection(entry, level);
      const label = `${level}/${cost}/${capability}`;
      for (const role of ['worker', 'reviewer', 'coordinator'] as const) {
        const picked = chooseProfile(task, profiles, [entry], {}, new Set(), role, {}, level)?.profile.id ?? null;
        assert.equal(picked === 'p', !automatic.startsWith('request'), `${label} ${role}: automatic selection agrees with the explanation`);
        const requested = { ...task, profileRequests: { [role]: { profileId: 'p', reason: 'Owner request', required: false } } };
        assert.equal(chooseProfile(requested, profiles, [entry], {}, new Set(), role, {}, level)?.profile.id === 'p', !automatic.startsWith('request'),
          `${label} ${role}: an unsigned request reaches the profile only where automatic selection could (Spec 052, 2026-10-21)`);
        const signed = { ...task, profileRequests: { [role]: { profileId: 'p', reason: 'Owner request', required: false,
          signoff: { status: 'approved' as const, decisionId: 'd', by: 'operator (board)', at: '2026-10-21T00:00:00.000Z', note: '' } } } };
        assert.equal(chooseProfile(signed, profiles, [entry], {}, new Set(), role, {}, level)?.profile.id, 'p', `${label} ${role}: a signed-off request works at every level`);
      }
      // Frontier is request-only below Maximum whatever its cost; the cost ceiling is named first (Tom, 2026-11-09).
      assert.equal(automatic === 'request_frontier', capability === 'frontier' && level !== 'maximum' && automatic !== 'request_ceiling', label);
      if (level === 'maximum') assert.equal(automatic, 'allowed', `${label}: Maximum lifts every tier and cost`);
      if (level === 'high' && capability !== 'frontier') assert.equal(automatic, 'allowed', `${label}: High allows every cost`);
      // Unset cost is never cost-gated.
      if (cost === null) assert.notEqual(automatic, 'request_ceiling', label);
      const usage: UsageView = { level, setLevel: level, until: null, expired: false };
      const text = describeAutomaticSelection(entry, usage);
      assert.equal(/required|request-only/.test(text), automatic.startsWith('request'), `${label}: "${text}"`);
      assert.equal(automaticSelectionTag(entry, level) === '', automatic === 'allowed', label);
      assert.ok(automaticSelectionTag(entry, level).length <= 16, `${label}: the button tag stays short enough not to overflow a compact chooser`);
    }
  } finally { store.close(); }
});

test('Spec 052 diagnostics: next and a cached detail read explain the policy fresh, through expiry, beside other gates', () => {
  const store = new Store(':memory:');
  try {
    store.setMeta('pool', [
      policyEntry('frontier', 'very_high', 'frontier'),
      policyEntry('cheap-flag', 'low', 'frontier'),
      policyEntry('pricey', 'high', null),
      policyEntry('off', 'very_high', 'frontier', { enabled: false }),
    ]);
    const inserted = store.insert(submissionSchema.parse({ submissionId: 'policy', title: 'Policy', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin',
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
    assert.match(lifted['reviewer:off']!.explanation, /^Explicit reviewer request; .*; also disabled in the pool$/);
    assert.equal(lifted['coordinator:gone']!.automatic, null);
    assert.match(lifted['coordinator:gone']!.explanation, /not in the pool/);

    const normal = rows(after);
    assert.equal(normal['worker:frontier']!.automatic, 'request_ceiling');
    assert.match(normal['worker:frontier']!.explanation, new RegExp(String.raw`Explicit request required at Normal: very high cost is above its ceiling \(Maximum ended ${until}\)$`));
    assert.equal(normal['reviewer:pricey']!.automatic, 'allowed');
    assert.equal(normal['worker:cheap-flag']!.automatic, 'request_frontier', 'below Maximum a frontier profile needs a request whatever its cost');
    assert.match(normal['worker:cheap-flag']!.explanation, /^Worker preference; automatic selection: Frontier: request-only below Maximum \(Maximum ended .*\); a preference alone does not select it$/);
    store.setMeta('usageLevel', { level: 'low', until: null, setAt: '2026-10-19T00:00:00.000Z' });
    assert.equal(rows(after)['reviewer:pricey']!.automatic, 'request_ceiling', 'a profile above the cost ceiling needs a request');
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
    assert.equal(second.routingPolicy.profiles.find(p => p.profileId === 'frontier')!.automatic, 'request_ceiling');
    assert.deepEqual(store.usageSetting(), { level: 'maximum', until, setAt: '2026-10-19T00:00:00.000Z' }, 'no read writes the setting');
  } finally { store.close(); }
});

test('task 1002: the store step drops stored By request flags and reads very_low capability as low; a stale write drops the flag too', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ns-by-request-'));
  try {
    const path = join(dir, 'queue.sqlite');
    const first = new Store(path);
    first.setMeta('pool', [
      { profileId: 'sol', enabled: true, group: 'openai', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'very_high', byRequest: true },
      { profileId: 'opus', enabled: true, group: 'anthropic', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_high', capability: 'very_high', byRequest: true },
      { profileId: 'muse', enabled: true, group: 'muse', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_low', capability: 'very_low' },
      { profileId: 'glm', enabled: true, group: 'zai', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'low', capability: 'low' },
    ]);
    first.close();
    const reopened = new Store(path);
    try {
      const raw = reopened.getMeta<Record<string, unknown>[]>('pool')!;
      assert.equal(raw.some(entry => 'byRequest' in entry), false, 'no stored profile carries a by-request flag after the store step');
      assert.deepEqual(raw.map(entry => entry.capability), ['very_high', 'very_high', 'low', 'low'], 'only very_low changes; Opus stays very_high until the operator moves it');
      assert.deepEqual(reopened.pool().map(entry => [entry.profileId, entry.cost, entry.capability]), [['sol', 'very_high', 'very_high'], ['opus', 'very_high', 'very_high'], ['muse', 'very_low', 'low'], ['glm', 'low', 'low']]);
      const policy = (id: string) => automaticSelection(reopened.pool().find(entry => entry.profileId === id)!, 'high');
      assert.equal(policy('sol'), 'allowed', 'Sol becomes automatic by cost at High');
      assert.equal(automaticSelection({ cost: 'very_high', capability: 'frontier' }, 'high'), 'request_frontier', 'Opus rated frontier stays request-only at High');
    } finally { reopened.close(); }
    const stale = configurePool.input.parse({ entries: [{ profileId: 'sol', enabled: true, group: 'openai', roles: ['worker'], weight: 1, scopes: ['general'], byRequest: true, capability: 'very_low' }] });
    assert.deepEqual([('byRequest' in stale.entries[0]!), stale.entries[0]!.capability], [false, 'low'], 'an older client write reads without the flag');
    assert.throws(() => poolSchema.parse({ profileId: 'x', enabled: true, group: 'x', roles: ['worker'], weight: 1, scopes: ['general'], byRequest: true }), 'the pool schema no longer accepts the flag');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
