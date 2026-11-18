import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandPick, requestedTier, runDemand, taskDemandPreview, workerStartTier, workerStepUp, type DemandCandidate } from '../shared/demand';
import { poolSchema, submissionSchema, usageLevelSchema, usageLevels, type CapabilityLevel, type DemandLevel, type Profile, type ProfileCapability, type Task, type UsageLevel } from '../shared/contracts';
import { chooseProfile } from '../core/dispatch/routing';
import { requestOnly } from '../shared/pool';
import { poolShapes } from './support/pool-shapes';

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
const pick = (demand: DemandLevel, usage: UsageLevel = 'normal', exclude: string[] = [], requested?: DemandLevel | null, climb?: DemandLevel | null) =>
  demandPick(demand, usage, candidates, new Set(), new Set(exclude.map(id => `${id}-model`)), requested, climb);

/** The start tier of every level for every complexity (Tom, 2026-11-17). */
const START: Record<UsageLevel, Record<CapabilityLevel | 'unset', DemandLevel>> = {
  low: { very_low: 'very_low', low: 'very_low', medium: 'low', high: 'medium', very_high: 'high', unset: 'low' },
  normal: { very_low: 'very_low', low: 'low', medium: 'medium', high: 'medium', very_high: 'high', unset: 'medium' },
  high: { very_low: 'very_low', low: 'low', medium: 'medium', high: 'high', very_high: 'very_high', unset: 'medium' },
  extra_high: { very_low: 'very_low', low: 'low', medium: 'medium', high: 'high', very_high: 'very_high', unset: 'medium' },
  maximum: { very_low: 'very_high', low: 'very_high', medium: 'very_high', high: 'very_high', very_high: 'very_high', unset: 'very_high' },
};

test('052: usage levels are low, normal, high, extra high and maximum; a stored minimal reads as low', () => {
  assert.deepEqual([...usageLevels], ['low', 'normal', 'high', 'extra_high', 'maximum']);
  assert.equal(usageLevelSchema.parse('minimal'), 'low', 'a stale writer maps to low at the wire boundary');
  for (const level of usageLevels) assert.equal(usageLevelSchema.parse(level), level, `${level} is unchanged`);
});

test('052 table: every level starts a task at its own tier, with maximum on the top two tiers whatever the complexity', () => {
  for (const level of usageLevels) for (const complexity of ['very_low', 'low', 'medium', 'high', 'very_high'] as const)
    assert.equal(workerStartTier(level, complexity), START[level][complexity], `${level}/${complexity}`);
  for (const level of usageLevels) assert.equal(workerStartTier(level, null), START[level].unset, `${level}/unset complexity is medium`);
});

test('052: the worker demand is the level start tier moved by the role offsets; a reviewer never sits below the worker', () => {
  assert.equal(runDemand('very_high', 'worker', 'normal'), 'high', 'very-high complexity starts one tier below at normal');
  assert.equal(runDemand('very_high', 'reviewer', 'normal'), 'high', 'the reviewer matches the worker');
  assert.equal(runDemand('very_high', 'coordinator', 'normal'), 'low', 'the coordinator keeps its two-step offset');
  assert.equal(runDemand('very_low', 'worker', 'low'), 'very_low', 'clamped at the bottom');
  assert.equal(runDemand('very_high', 'worker', 'maximum'), 'very_high', 'at maximum workers ask for the top two tiers');
  assert.equal(runDemand('very_high', 'reviewer', 'maximum'), 'very_high', 'and reviewers too, whatever the complexity');
  assert.equal(runDemand('very_low', 'reviewer', 'maximum'), 'very_high', 'maximum lifts every complexity to the top two tiers');
  assert.equal(runDemand(null, 'worker', 'normal'), 'medium', 'unset complexity counts as medium');
});

test('052: against the real pool shape, every level starts at its table tier and maximum puts workers and reviewers on the top two tiers', () => {
  const realEntries = poolShapes.map((shape, index) => poolSchema.parse({ profileId: `shape-${index}`, ...shape.entry }));
  const realProfiles: Profile[] = realEntries.map((entry, index) => ({ id: entry.profileId, name: poolShapes[index]!.profile.label,
    provider: poolShapes[index]!.profile.provider, model: poolShapes[index]!.profile.model, available: true, problem: '', notes: '', supportedThinking: [] }));
  for (const level of usageLevels) for (const complexity of ['very_low', 'low', 'medium', 'high', 'very_high'] as const)
    assert.equal(workerStartTier(level, complexity), START[level][complexity], `real pool shape: ${level}/${complexity}`);
  for (const complexity of ['very_low', 'low', 'medium', 'high', 'very_high'] as const) {
    const rows = taskDemandPreview({ complexity }, realEntries, realProfiles, 'maximum', new Set());
    const topTwo = new Set(['very_high', 'frontier']);
    for (const row of rows.slice(0, 2)) assert.ok(row.pick.profileIds.length > 0, `${complexity}: ${row.role} has a pick at maximum`);
    for (const row of rows.slice(0, 2)) for (const id of row.pick.profileIds) {
      const entry = realEntries.find(item => item.profileId === id)!;
      assert.ok(topTwo.has(entry.capability!), `${complexity}: ${row.role} runs on ${entry.capability} at maximum`);
    }
  }
});

test('052: coordinator and recovery offsets are unchanged under every level, maximum included', () => {
  for (const level of usageLevels) for (const complexity of ['low', 'medium', 'high', 'very_high'] as const) {
    const worker = runDemand(complexity, 'worker', level);
    const coordinator = runDemand(complexity, 'coordinator', level);
    const scale = ['very_low', 'low', 'medium', 'high', 'very_high', 'frontier'];
    assert.equal(coordinator, scale[Math.max(0, scale.indexOf(worker) - 2)],
      `${level}/${complexity}: the coordinator is two tiers under the worker`);
    const reviewer = runDemand(complexity, 'reviewer', level);
    assert.ok(['very_low', 'low', 'medium', 'high', 'very_high', 'frontier'].indexOf(reviewer) >= ['very_low', 'low', 'medium', 'high', 'very_high', 'frontier'].indexOf(worker),
      `${level}/${complexity}: the reviewer is never below the worker`);
  }
});

test('052: climbing back after review changes moves one tier, capped at the requested tier', () => {
  // A very-high complexity task on Low starts at high and climbs to its requested very-high tier.
  assert.equal(requestedTier('very_high'), 'very_high');
  assert.equal(workerStepUp('high', 'very_high'), 'very_high');
  assert.equal(workerStepUp('very_high', 'very_high'), 'very_high', 'never past the requested tier');
  assert.equal(workerStepUp('frontier', 'very_high'), 'frontier', 'an explicit route above it is not pulled back');
  assert.equal(workerStepUp('low', 'medium'), 'medium');
  assert.equal(workerStepUp('very_low', 'low'), 'low');
  assert.equal(requestedTier('very_low'), 'low', 'the cheapest tier a profile carries');
  assert.equal(requestedTier(null), 'medium');
});

test('052 permission: each level gates exactly the runs the level table names', () => {
  // very-high complexity asks for the very_high tier; medium asks for medium.
  const top = [
    ['low', 'frontier', 'very_high', true],
    ['normal', 'frontier', 'medium', true], ['normal', 'very_high', 'medium', true],
    ['normal', 'very_high', 'very_high', true], ['normal', 'frontier', 'frontier', true],
    ['high', 'frontier', 'medium', true], ['high', 'very_high', 'medium', false],
    ['extra_high', 'frontier', 'medium', false], ['extra_high', 'very_high', 'medium', false],
    ['maximum', 'frontier', 'medium', false], ['maximum', 'very_high', 'medium', false],
  ] as const;
  for (const [level, capability, requested, gated] of top)
    assert.equal(requestOnly({ cost: 'very_high', capability }, level, requested), gated, `${level}/${capability}/${requested}`);
  // The requested-tier exception belongs only to a recorded climb, never to a
  // first attempt before any review climbed (Tom, 2026-11-17).
  for (const level of ['low', 'normal'] as const) {
    assert.equal(requestOnly({ cost: 'very_high', capability: 'very_high' }, level, 'very_high'), true, `${level}: no climb recorded`);
    assert.equal(requestOnly({ cost: 'very_high', capability: 'very_high' }, level, 'very_high', 'very_high'), false, `${level}: the recorded climb`);
    assert.equal(requestOnly({ cost: 'very_high', capability: 'frontier' }, level, 'very_high', 'very_high'), true, `${level}: frontier is always an explicit route`);
  }
  // A lower tier never needs permission, whatever the level.
  for (const capability of ['low', 'medium', 'high'] as const) for (const level of usageLevels)
    assert.equal(requestOnly({ cost: 'very_high', capability }, level, 'low'), false, `${level}/${capability}`);
});

test('053 rows: only profiles the level covers form the automatic set; gated ones meet the demand as sign-off only, and cost never excludes', () => {
  // Unset complexity asks for medium; on Normal the top two tiers need permission.
  assert.deepEqual(pick('medium', 'normal', [], 'medium'), {
    profileIds: ['haiku', 'grok'],
    shortfall: false,
    signoffOnly: ['opus', 'sol'],
  }, 'row 1: the run selects its own medium tier; a profile above the requested tier is not automatic, and a held one needs a request');
  assert.deepEqual(pick('medium', 'normal', ['haiku'], 'medium').profileIds, ['grok'], 'an excluded author model leaves the set');
  assert.deepEqual(pick('very_high', 'normal', [], 'very_high', 'very_high'), {
    profileIds: ['sol'], shortfall: false, signoffOnly: ['opus'],
  }, 'the recorded climb back to the very-high tier needs no request at Normal; frontier still does');
  assert.equal(pick('very_high', 'normal', [], 'very_high').profileIds.includes('sol'), false, 'before the recorded climb the very-high tier is held at Normal');
  assert.deepEqual(pick('very_high', 'low', [], 'very_high', 'very_high'), {
    profileIds: ['sol'], shortfall: false, signoffOnly: ['opus'],
  }, 'on Low the recorded climb back to the requested very-high tier needs no second request; frontier still does');
  assert.equal(pick('very_high', 'low', [], 'very_high').profileIds.includes('sol'), false, 'before a recorded climb the very-high tier is held on Low');
  assert.deepEqual(pick('very_high', 'high', [], 'very_high'), {
    profileIds: ['sol'], shortfall: false, signoffOnly: ['opus'],
  }, 'at High only frontier needs permission');
  assert.deepEqual(pick('very_high', 'extra_high', [], 'very_high'), { profileIds: ['sol'], shortfall: false, signoffOnly: [] }, 'at Extra high a covered very-high tier is automatic and frontier awaits an explicit route');
  assert.deepEqual(pick('very_high', 'maximum', [], 'medium'), { profileIds: ['opus', 'sol'], shortfall: false, signoffOnly: [] }, 'at Maximum workers use the top two tiers');
  // Cost is only the lean: a very expensive profile is not gated for its cost.
  assert.deepEqual(pick('low', 'extra_high', [], 'low').profileIds.sort(), ['glm', 'muse'], 'a low demand selects its own low tier whatever the cost');
  // On a shortfall the nearest covered profile forms the set; a gated one never does.
  const short = pick('very_high', 'normal', ['sol'], 'very_high');
  assert.deepEqual(short.profileIds, ['deepseek'], 'the nearest covered profile below the tier');
  assert.deepEqual(short.signoffOnly, ['opus']);
});

test('053: unavailable groups, disabled and catalog-missing profiles are never picked', () => {
  const offline = demandPick('high', 'normal', candidates, new Set(['deepseek']), new Set(), 'medium');
  assert.ok(!offline.profileIds.includes('deepseek'));
  const disabled = demandPick('high', 'normal', candidates.map(item => item.profileId === 'deepseek' ? { ...item, enabled: false } : item), new Set(), new Set(), 'medium');
  assert.ok(!disabled.profileIds.includes('deepseek'));
  assert.deepEqual(demandPick('high', 'normal', [], new Set(), new Set(), 'medium').profileIds, []);
});

test('053 preview: per-role rows from the level start tier, the reviewer excludes every author model, and requests show their reach', () => {
  const rows = taskDemandPreview({ complexity: 'high', workerModel: 'vendor/deepseek-model', workerModels: ['vendor/deepseek-model'] },
    pool, profiles, 'normal', new Set());
  assert.deepEqual(rows.map(row => [row.role, row.demand]), [
    ['worker', 'medium'], ['reviewer', 'medium'], ['coordinator', 'very_low'],
  ], 'a high complexity task starts one tier below at normal; the reviewer matches and the coordinator keeps its offset');
  const signed = { status: 'approved' as const, decisionId: 'd', by: 'operator (board)', at: 'now', note: '' };
  const requested = taskDemandPreview({ complexity: 'medium', profileRequests: {
    worker: { profileId: 'sol', reason: 'needs it', signoff: signed }, reviewer: { profileId: 'sol', reason: 'needs it' }, coordinator: { profileId: 'glm', reason: 'cheap' },
  } }, pool, profiles, 'normal', new Set());
  assert.deepEqual(requested.map(row => row.request), [
    { profileId: 'sol', replaces: true }, { profileId: 'sol', replaces: false }, { profileId: 'glm', replaces: true },
  ], 'a signed-off or covered request replaces the result; an unsigned gated one does not');
});

test('053 preview: an opaque author blocks review, and a review-entry author is excluded from its own review', () => {
  const opaque = taskDemandPreview({ complexity: 'high', workerModel: 'default' }, pool, profiles, 'normal', new Set());
  assert.equal(opaque[1].blocked, 'an opaque author model cannot prove review independence');
  assert.deepEqual(opaque[1].pick.profileIds, []);
  const reviewEntry = taskDemandPreview({ complexity: 'high', reviewEntry: { authorDeclaration: { models: ['vendor/deepseek-model'] } } }, pool, profiles, 'normal', new Set());
  assert.ok(!reviewEntry[1].pick.profileIds.includes('deepseek'));
});

test('053 cost lean: cost shifts the share within the set, never removes a profile', () => {
  const live = [['glm', 'low', 'medium'], ['deepseek', 'medium', 'high'], ['grok', 'medium', 'medium'], ['haiku', 'medium', 'medium']] as const;
  const leanProfiles: Profile[] = live.map(([id]) => ({ id, name: id, provider: 'test', model: `vendor/${id}-model`, available: true, problem: '', notes: '', supportedThinking: [] }));
  const leanPool = live.map(([id, cost, capability]) => entry(id, cost, capability));
  const shares = simulate({ complexity: 'medium' } as Task, leanProfiles, leanPool, 100, new Set(), 'normal');
  assert.deepEqual(shares, { glm: 50, grok: 25, haiku: 25 }, '100 medium selections: the medium tier rotates, GLM (low cost, lean 8) takes 50, each medium-cost profile 25; DeepSeek sits above the requested tier');
});

/** The share of `selections` picks each profile gets when every pick is recorded (recent and lifetime counts both). */
function simulate(task: Task, selectionProfiles: Profile[], selectionPool: typeof pool, selections: number,
  unavailable: Set<string> = new Set(), usage: UsageLevel = 'normal'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < selections; i++) {
    const chosen = chooseProfile(task, selectionProfiles, selectionPool, counts, unavailable, 'worker', counts, usage);
    if (!chosen) break;
    counts[`profile:${chosen.profile.id}`] = (counts[`profile:${chosen.profile.id}`] ?? 0) + 1;
    counts[chosen.entry.group] = (counts[chosen.entry.group] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).filter(([key]) => key.startsWith('profile:')).map(([key, n]) => [key.slice('profile:'.length), n]));
}

test('053: selection takes the level start tier, and a revision after review changes climbs one tier', () => {
  const routes = [entry('a1', 'medium', 'medium'), entry('a2', 'medium', 'medium'), entry('z1', 'medium', 'high'), entry('z2', 'medium', 'high')];
  const catalog = routes.map(item => ({ id: item.profileId, name: item.profileId, provider: 'p', model: item.profileId, available: true, problem: '', notes: '', supportedThinking: [] }));
  const task = submissionSchema.parse({ submissionId: 's', title: 'T', repoPath: '/r', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'o', complexity: 'high' }) as Task;
  const select = (candidate: Task, usage: UsageLevel = 'normal', role: 'worker' | 'reviewer' = 'worker') =>
    chooseProfile(candidate, catalog, routes, {}, new Set(), role, {}, usage)?.profile.id;
  // Normal starts a high complexity task one tier below: medium.
  assert.equal(select(task), 'a1', 'the first run asks for medium; the id breaks the tie');
  // An applied changes-required review authorizes one climb to the requested high tier.
  const changes = { ...task, resolution: { ...task.resolution, review: { eventId: 'review-1', taskId: task.id, runId: 'review-1', status: 'changes_required' as const, summary: 'Fix the defect', head: 'a'.repeat(40) } } };
  assert.equal(select(changes), 'z1', 'the next worker run after an applied changes-required review asks for high');
  assert.equal(select({ ...task, phase: 'changes_requested' as const }), 'a1', 'the phase alone does not authorize a climb');
  assert.equal(select({ ...changes, complexity: 'very_high' }), 'z1', 'the climb is capped at the requested tier, not pushed past the pool');
  assert.equal(select(task, 'maximum'), undefined, 'at maximum only the top two tiers are automatic; this pool has none');
  assert.equal(select(task, 'extra_high'), 'z1', 'at extra high the first run asks for the requested tier');
  assert.equal(select(task, 'normal', 'reviewer'), 'a1', 'the reviewer matches the worker');
});
