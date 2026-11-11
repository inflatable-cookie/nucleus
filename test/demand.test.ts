import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandPick, runDemand, workerDemandStep, taskDemandPreview, type DemandCandidate } from '../shared/demand';
import { poolSchema, submissionSchema, type CapabilityLevel, type DemandLevel, type ProfileCapability, type Task } from '../shared/contracts';
import { chooseProfile } from '../core/dispatch/routing';

/** Spec 053 acceptance, against the live pool's ratings on 2026-10-21, with Opus moved to frontier and Sol at very_high cost (Tom, 2026-11-09). */
const entry = (profileId: string, cost: CapabilityLevel, capability: ProfileCapability) =>
  poolSchema.parse({ profileId, enabled: true, group: profileId, roles: ['worker'], weight: 1, scopes: ['general'], cost, capability });
const pool = [
  entry('opus', 'very_high', 'frontier'),
  entry('deepseek', 'medium', 'high'),
  entry('glm', 'low', 'low'),
  entry('muse', 'very_low', 'low'),
  entry('haiku', 'medium', 'medium'),
  entry('sol', 'very_high', 'very_high'),
  entry('grok', 'high', 'medium'),
];
const profiles = pool.map(item => ({ id: item.profileId, model: `vendor/${item.profileId}-model`, available: true }));
const candidates: DemandCandidate[] = pool.map(item => ({ ...item, model: `vendor/${item.profileId}-model`, available: true }));
const pick = (demand: DemandLevel, usage: 'minimal' | 'low' | 'normal' | 'high' | 'maximum' = 'normal', exclude: string[] = []) =>
  demandPick(demand, usage, candidates, new Set(), new Set(exclude.map(id => `${id}-model`)));

test('053: demand is the task complexity moved by the role and the usage level, clamped, and unset counts as medium', () => {
  assert.equal(runDemand('high', 'worker', 'normal'), 'high');
  assert.equal(runDemand('high', 'reviewer', 'normal'), 'high', 'reviewer matches the task (Tom, 2026-10-21)');
  assert.equal(runDemand('high', 'coordinator', 'normal'), 'low');
  assert.equal(runDemand(null, 'worker', 'normal'), 'medium');
  assert.equal(runDemand('high', 'worker', 'low'), 'medium');
  assert.equal(runDemand('high', 'worker', 'maximum'), 'frontier', 'at Maximum demand may reach frontier (Tom, 2026-11-09)');
  assert.equal(runDemand('very_high', 'worker', 'high'), 'very_high', 'below Maximum demand stays within very_high');
  assert.equal(runDemand('very_high', 'worker', 'maximum'), 'frontier', 'clamped at frontier');
  assert.equal(runDemand('very_low', 'coordinator', 'minimal'), 'very_low', 'clamped at the bottom');
  assert.equal(runDemand('medium', 'worker', 'normal'), 'medium');
  assert.equal(runDemand('medium', 'reviewer', 'normal'), 'medium');
});

test('053 rows 1–6: every profile meeting the demand rotates (cost leans, never excludes), best available on a shortfall, sign-off profiles named', () => {
  assert.deepEqual(pick('medium').profileIds.sort(), ['deepseek', 'grok', 'haiku'], 'row 1: every profile rated medium or above rotates; Grok (high cost) is leaned against, not removed (Tom, 2026-11-04)');
  assert.deepEqual(pick('high').profileIds, ['deepseek'], 'row 2: Deepseek, high capability at medium cost');
  const authoredByDeepseek = pick('high', 'normal', ['deepseek']);
  assert.equal(authoredByDeepseek.shortfall, true, 'row 2b: Sol\'s very_high cost is above the Normal ceiling');
  assert.deepEqual(authoredByDeepseek.signoffOnly, ['opus', 'sol']);
  assert.deepEqual(pick('low').profileIds.sort(), ['deepseek', 'glm', 'grok', 'haiku', 'muse'], 'row 3: a low demand keeps every profile rated low or above');
  const veryHigh = pick('very_high');
  assert.equal(veryHigh.shortfall, true, 'row 4: nothing automatic meets very_high at Normal');
  assert.deepEqual(veryHigh.profileIds, ['deepseek'], 'the best available: the most capable automatic profiles');
  assert.deepEqual(veryHigh.signoffOnly, ['opus', 'sol']);
  const high = pick('very_high', 'high');
  assert.deepEqual(high.profileIds, ['sol'], 'at High Sol (very_high cost, very_high capability) is automatic');
  assert.deepEqual(high.signoffOnly, ['opus'], 'at High the frontier profile still needs a request');
  assert.deepEqual(pick('very_high', 'maximum').profileIds, ['opus', 'sol'], 'row 5: at Maximum Opus and Sol are both automatic');
  assert.deepEqual(pick('frontier', 'maximum').profileIds, ['opus'], 'a frontier demand at Maximum takes the frontier profile');
  assert.deepEqual(pick('very_low', 'minimal').profileIds.sort(), ['glm', 'muse'], 'row 6: Minimal keeps to its low cost ceiling');
});

test('053: unavailable groups, disabled and catalog-missing profiles are never picked', () => {
  const offline = demandPick('high', 'normal', candidates, new Set(['deepseek']));
  assert.equal(offline.shortfall, true);
  assert.ok(!offline.profileIds.includes('deepseek'));
  const disabled = demandPick('high', 'normal', candidates.map(item => item.profileId === 'deepseek' ? { ...item, enabled: false } : item));
  assert.ok(!disabled.profileIds.includes('deepseek'));
  assert.deepEqual(demandPick('high', 'normal', []).profileIds, []);
});

test('053 preview: per-role rows, the reviewer excludes every author model', () => {
  const rows = taskDemandPreview({ complexity: 'high', workerModel: 'vendor/deepseek-model', workerModels: ['vendor/deepseek-model'] },
    pool, profiles, 'normal', new Set());
  assert.deepEqual(rows.map(row => [row.role, row.demand, row.pick.profileIds.join('|')]), [
    ['worker', 'medium', 'deepseek|haiku|grok'],
    ['reviewer', 'high', 'haiku|grok'],
    ['coordinator', 'low', 'deepseek|glm|muse|haiku|grok'],
  ]);
  assert.equal(rows[1].pick.shortfall, true, 'the Deepseek-authored high task has no automatic high reviewer at Normal: Sol is above the cost ceiling');
  assert.ok(!rows[1].pick.profileIds.includes('deepseek'));
});

test('053 preview: an unrated cost is never cost-gated, as at selection (Sol, #592); every recorded author is excluded, an opaque author blocks review, and requests are shown', () => {
  const mystery = poolSchema.parse({ profileId: 'mystery', enabled: true, group: 'mystery', roles: ['worker'], weight: 1, scopes: ['general'], capability: 'low' });
  const alone = demandPick('very_low', 'minimal', [{ ...mystery, model: 'vendor/mystery-model', available: true }]);
  assert.deepEqual(alone.profileIds, ['mystery'], 'Spec 052: a pool entry with no cost is never cost-gated');
  assert.deepEqual(alone.signoffOnly, []);
  const runtime = chooseProfile(submissionSchema.parse({ submissionId: 'u', title: 'U', repoPath: '/r', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'o', complexity: 'very_low' }) as Task,
    [{ id: 'mystery', name: 'mystery', provider: 'p', model: 'vendor/mystery-model', available: true, problem: '', notes: '', supportedThinking: [] }], [mystery], {}, new Set(), 'worker', {}, 'minimal');
  assert.equal(runtime?.profile.id, 'mystery', 'the runtime admits the same profile the preview names');
  const opaqueCandidate = taskDemandPreview({ complexity: 'very_high', workerModel: 'vendor/muse-model' },
    [...pool, poolSchema.parse({ profileId: 'opaque', enabled: true, group: 'opaque', roles: ['worker'], weight: 1, scopes: ['general'], cost: 'very_low', capability: 'very_high' })],
    [...profiles, { id: 'opaque', model: 'default', available: true }], 'normal', new Set());
  assert.ok(!opaqueCandidate[1].pick.profileIds.includes('opaque'), 'an opaque-model profile never reviews');
  assert.ok(opaqueCandidate[0].pick.profileIds.includes('opaque'), 'it can still work');
  const reviewEntry = taskDemandPreview({ complexity: 'high', reviewEntry: { authorDeclaration: { models: ['vendor/deepseek-model'] } } }, pool, profiles, 'normal', new Set());
  assert.ok(!reviewEntry[1].pick.profileIds.includes('deepseek'), 'a review-entry author is excluded from its own review');
  const opaque = taskDemandPreview({ complexity: 'high', workerModel: 'default' }, pool, profiles, 'normal', new Set());
  assert.equal(opaque[1].blocked, 'an opaque author model cannot prove review independence');
  assert.deepEqual(opaque[1].pick.profileIds, []);
  const signed = { status: 'approved', decisionId: 'd', by: 'operator (board)', at: 'now', note: '' };
  const requested = taskDemandPreview({ complexity: 'medium', profileRequests: {
    worker: { profileId: 'sol', reason: 'needs it', signoff: signed }, reviewer: { profileId: 'sol', reason: 'needs it' }, coordinator: { profileId: 'glm', reason: 'cheap' },
  } }, pool, profiles, 'normal', new Set());
  assert.deepEqual(requested.map(row => row.request), [
    { profileId: 'sol', replaces: true }, { profileId: 'sol', replaces: false }, { profileId: 'glm', replaces: true },
  ], 'a signed-off or within-level request replaces the result; an unsigned above-ceiling one does not');
});


test('initial worker step reduces demand without raising the floor', () => {
  assert.equal(workerDemandStep('high', true), 'medium');
  assert.equal(workerDemandStep('very_high', true), 'high');
  assert.equal(workerDemandStep('low', true), 'low');
  assert.equal(workerDemandStep('very_low', true), 'very_low');
  assert.equal(workerDemandStep('high', false), 'high');
});


test('only the first worker selection gets the Normal-level demand step down', () => {
  const task = { complexity: 'high' as const };
  for (const usage of ['minimal', 'low', 'normal', 'high', 'maximum'] as const) {
    const initial = taskDemandPreview(task, pool, profiles, usage, new Set());
    const full = taskDemandPreview(task, pool, profiles, usage, new Set(), undefined, true);
    assert.equal(initial[0].demand, usage === 'normal' ? 'medium' : runDemand('high', 'worker', usage));
    assert.equal(full[0].demand, runDemand('high', 'worker', usage));
    assert.equal(initial[1].demand, full[1].demand);
  }
});

test('the first worker selection step is explicit and independent of review history', () => {
  const routes = [entry('m1', 'medium', 'medium'), entry('m2', 'medium', 'medium'), entry('h1', 'high', 'high'), entry('h2', 'high', 'high')];
  const catalog = routes.map(e => ({ id: e.profileId, name: e.profileId, provider: 'p', model: e.profileId, available: true, problem: '', notes: '', supportedThinking: [] }));
  const task = submissionSchema.parse({ submissionId: 's', title: 'T', repoPath: '/r', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'o', complexity: 'high' }) as Task;
  const select = (initialWorker: boolean, unavailable: string[], usage: 'normal' | 'low' | 'high' | 'minimal' | 'maximum' = 'normal', role: 'worker' | 'reviewer' = 'worker') =>
    chooseProfile(task, catalog, routes, {}, new Set(unavailable), role, {}, usage, undefined, initialWorker)?.profile.id;
  // The first step (medium) keeps every profile rated medium or above; on a fresh pool the id breaks the tie (Spec 053, Tom 2026-11-04).
  assert.equal(select(true, []), 'h1');
  assert.equal(select(true, ['h1', 'h2']), 'm1', 'the step admits the medium profiles');
  assert.equal(select(true, ['h1', 'h2', 'm1']), 'm2');
  assert.equal(select(false, []), 'h1');
  assert.equal(select(false, ['h1']), 'h2');
  assert.equal(select(false, [], 'normal', 'reviewer'), 'h1');
  for (const usage of ['minimal', 'low', 'high', 'maximum'] as const)
    assert.equal(select(false, [], usage), select(true, [], usage));
});
