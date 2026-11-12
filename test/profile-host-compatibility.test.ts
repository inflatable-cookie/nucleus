import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { Store } from '../core/store/store';
import { RuntimeSettings } from '../core/runtime/settings';
import { chooseProfile } from '../core/dispatch/routing';
import { nucleusProfileSchema, profileCompatibility, type NucleusProfile, type ProfileHostSetting } from '../shared/profiles';
import { poolSchema, submissionSchema, type PoolEntry, type Profile, type Task } from '../shared/contracts';
import type { HostAgentSpec, HostCatalog } from '../shared/host';
import { t3Fake } from './support/t3code-fake';
import { nightlyProviders, poolShapes } from './support/pool-shapes';

/**
 * A synthetic Paseo catalog in the shape the Paseo adapter reports: provider keys
 * as the pool names them, Claude's own modes (bypassPermissions among them),
 * Codex's three, Pi's opencode-go models with thinking levels, and Grok's
 * auto_accept toggle. Identifiers are synthetic.
 */
const thinking = (...ids: string[]) => ids.map(id => ({ id, label: id }));
const paseoCatalog = (): HostCatalog => ({ providers: [
  { key: 'claude', label: 'Claude', available: true, problem: '', models: ['claude-haiku-5-5', 'claude-opus-5-5'].map(id => ({ id, label: id, aliases: [], thinkingOptions: thinking('low', 'medium', 'high'), defaultThinkingOptionId: null,
    modes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map(mode => ({ id: mode, label: mode })), features: [] })) },
  { key: 'codex', label: 'Codex', available: true, problem: '', models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'].map(id => ({ id, label: id, aliases: [], thinkingOptions: thinking('low', 'medium', 'high', 'xhigh'), defaultThinkingOptionId: null,
    modes: ['read-only', 'auto', 'full-access'].map(mode => ({ id: mode, label: mode })), features: [] })) },
  { key: 'pi', label: 'Pi', available: true, problem: '', models: ['opencode-go/muse-spark-1.3-contributor', 'opencode-go/deepseek-v4.1-flash'].map(id => ({ id, label: id, aliases: [], thinkingOptions: thinking('low', 'medium', 'high'), defaultThinkingOptionId: null, modes: [], features: [] })) },
  { key: 'grok', label: 'Grok', available: true, problem: '', models: [{ id: 'grok-4.6', label: 'Grok 4.6', aliases: [], thinkingOptions: thinking('low', 'high'), defaultThinkingOptionId: null, modes: [],
    features: [{ type: 'toggle' as const, id: 'auto_accept', label: 'Auto accept', value: false }] }] },
] });

const stored = (index: number, hosts?: NucleusProfile['hosts']) => nucleusProfileSchema.parse({ id: `shape-${index}`, name: poolShapes[index]!.profile.label,
  ...Object.fromEntries(Object.entries(poolShapes[index]!.profile).filter(([key]) => key !== 'label')), ...(hosts ? { hosts } : {}) });
const storedPool = (): PoolEntry[] => poolShapes.map((shape, index) => poolSchema.parse({ profileId: `shape-${index}`, ...shape.entry }));

/**
 * The T3 mappings that make each pool shape T3 can host run there, from the
 * nightly snapshot: T3 names Claude's instance `claudeAgent` and carries its
 * effort as an option, Pi carries thinking as an option named `thinking`, and
 * Grok does not report auto_accept.
 */
const t3Mappings: Record<number, ProfileHostSetting> = {
  3: { provider: 'claudeAgent', thinkingOptionId: null, featureValues: { effort: 'high' } },
  4: { provider: 'claudeAgent', modeId: 'full-access', thinkingOptionId: null, featureValues: { effort: 'medium' } },
  6: { featureValues: null },
  7: { thinkingOptionId: null, featureValues: { thinking: 'high' } },
  8: { thinkingOptionId: null, featureValues: { thinking: 'high' } },
};

async function t3Fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'profile-host-compat-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = nightlyProviders();
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  return { root, directory, host, server, catalog: await host.catalog() };
}

test('every pool profile shape has a computed status and reason on Paseo and on the nightly T3 catalog', async t => {
  const { catalog: t3 } = await t3Fixture(t);
  const paseo = paseoCatalog();
  const on = (index: number, catalog: HostCatalog, kind: 'paseo' | 't3code', hosts?: NucleusProfile['hosts']) => {
    const answer = profileCompatibility(stored(index, hosts), catalog, {}, kind);
    return answer.status === 'works' ? 'works' : answer.reason;
  };
  const expectedPaseo = poolShapes.map((_, index) => index === 10
    ? "Paseo's codex has no mode bypassPermissions (it offers read-only, auto, full-access)" : 'works');
  assert.deepEqual(poolShapes.map((_, index) => on(index, paseo, 'paseo')), expectedPaseo);
  // The nightly T3 has Codex, Claude (as claudeAgent), Grok and Pi. Unmapped, only
  // the Codex shapes run; every other shape names what is missing.
  assert.deepEqual(poolShapes.map((_, index) => on(index, t3, 't3code')), [
    'works', 'works', 'works',
    'T3Code has no claude provider', 'T3Code has no claude provider', 'T3Code has no claude provider',
    "T3Code's grok-4.6 has no option auto_accept",
    "T3Code's opencode-go/muse-spark-1.3-contributor has no thinking level high",
    "T3Code's opencode-go/deepseek-v4.1-flash has no thinking level high",
    "T3Code's opencode-go/deepseek-v4.1-flash has no thinking level high",
    "T3Code's codex has no mode bypassPermissions (it offers approval-required, auto-accept-edits, auto, full-access)",
    'works',
  ]);
  // With the mappings every enabled shape runs on T3, and Paseo is unaffected.
  for (const [index, setting] of Object.entries(t3Mappings)) {
    const hosts = { t3code: setting };
    assert.equal(on(Number(index), t3, 't3code', hosts), 'works', `${poolShapes[Number(index)]!.profile.label} runs on T3 once mapped`);
    assert.equal(on(Number(index), paseo, 'paseo', hosts), 'works', `${poolShapes[Number(index)]!.profile.label} still runs on Paseo`);
  }
  // A mapping naming a provider or model T3 lacks says so; an exclusion wins.
  assert.equal(on(4, t3, 't3code', { t3code: { provider: 'claudeCode' } }), 'T3Code has no claudeCode provider');
  assert.equal(on(0, t3, 't3code', { t3code: { model: 'gpt-7' } }), "T3Code's codex has no model gpt-7");
  assert.equal(on(0, t3, 't3code', { t3code: { excluded: true } }), 'Excluded on T3Code in Settings');
  assert.equal(on(0, paseo, 'paseo', { t3code: { excluded: true } }), 'works', 'an exclusion holds only on its host');
});

const taskOf = (more: Partial<Task> = {}): Task => submissionSchema.parse({
  submissionId: 'profile-host-compat', title: 'Profile host compatibility', repoPath: '/repo', planningCommit: 'a'.repeat(40),
  handoffPath: 'handoff.md', originAgentId: 'origin', hostId: 't3code:env', ...more,
}) as Task;
const launchSpec = (workspaceId: string, profile: Profile, requestId: string): HostAgentSpec => ({ workspaceId, profile, title: 'Synthetic role', mcpBindingPath: null,
  attempt: () => ({ requestId, prompt: 'Synthetic prompt', labels: { task: 'synthetic-task', role: 'worker' }, environment: {} }) });

test('a mapped profile launches on T3 with its mapped values, an excluded one is never selected, and routingPolicy names both', async t => {
  const { directory, host, server, catalog } = await t3Fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'profile-host-engine-'));
  const store = new Store(join(dir, 'db'));
  const paseo = { profiles: async () => [], observe: async () => { throw Error('not observed'); }, catalog: async () => paseoCatalog() } as unknown as Adapter;
  const t3Adapter = { profiles: async () => [], observe: async () => { throw Error('not observed'); }, catalog: async () => catalog } as unknown as Adapter;
  const engine = new Engine(store, paseo, 0);
  engine.hostIds = () => ['paseo:local', 't3code:env'];
  engine.resolveHostAdapter = id => id === 't3code:env' ? t3Adapter : paseo;
  try {
    // Only Opus Oracle (mapped) and Terra worker (to be excluded) are enabled.
    // Opus is rated very high at medium cost here, so automatic selection reaches it.
    const pool = storedPool().map(entry => ({ ...entry, enabled: entry.profileId === 'shape-4' || entry.profileId === 'shape-2',
      ...(entry.profileId === 'shape-4' ? { capability: 'very_high' as const, cost: 'medium' as const } : {}) }));
    store.setProfiles(poolShapes.map((_, index) => stored(index)));
    store.setMeta('pool', pool);
    await engine.refresh();
    // Settings writes the mapping and the exclusion; selection follows at once.
    const settings = new RuntimeSettings({ store, engine } as unknown as ConstructorParameters<typeof RuntimeSettings>[0]);
    settings.profileUpdate({ id: 'shape-4', hosts: { t3code: t3Mappings[4]! } });
    settings.profileUpdate({ id: 'shape-2', hosts: { t3code: { excluded: true } } });
    const t3Profiles = engine.profilesFor('t3code:env');
    const opus = t3Profiles.find(profile => profile.id === 'shape-4')!;
    assert.equal(opus.available, true);
    assert.deepEqual({ provider: opus.provider, model: opus.model, modeId: opus.modeId, thinkingOptionId: opus.thinkingOptionId, featureValues: opus.featureValues, mapped: opus.mapped },
      { provider: 'claudeAgent', model: 'claude-opus-5-5', modeId: 'full-access', thinkingOptionId: undefined, featureValues: { effort: 'medium' }, mapped: ['provider', 'modeId', 'thinkingOptionId', 'featureValues'] });
    // Paseo's snapshot keeps the profile's own values.
    const paseoOpus = engine.profilesFor().find(profile => profile.id === 'shape-4')!;
    assert.deepEqual({ provider: paseoOpus.provider, modeId: paseoOpus.modeId, thinkingOptionId: paseoOpus.thinkingOptionId }, { provider: 'claude', modeId: 'bypassPermissions', thinkingOptionId: 'medium' });

    // The mapped profile launches on T3 with the mapped provider, model and mode.
    const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
    await host.createAgent(launchSpec(workspace.id, opus, 'launch-opus'));
    const command = server.commands.find(candidate => candidate.commandId === 'launch-opus')!;
    assert.equal(command.modelSelection.instanceId, 'claudeAgent');
    assert.equal(command.modelSelection.model, 'claude-opus-5-5');
    assert.deepEqual(command.modelSelection.options, [{ id: 'effort', value: 'medium' }]);
    assert.equal(command.runtimeMode, 'full-access');

    // The excluded Terra is never selected for a T3 task, though Paseo would pick it.
    const terraOnly = pool.map(entry => ({ ...entry, enabled: entry.profileId === 'shape-2' }));
    const task = { ...taskOf({ complexity: 'medium' }), workerModel: 'other-author', workerModels: ['other-author'] };
    const t3Terra = t3Profiles.find(profile => profile.id === 'shape-2')!;
    assert.deepEqual({ available: t3Terra.available, excluded: t3Terra.excluded, problem: t3Terra.problem }, { available: false, excluded: true, problem: 'Excluded on T3Code in Settings' });
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal(chooseProfile(task, t3Profiles, terraOnly, {}, new Set(), 'worker', {}, 'normal', store.demandRoleOffsets(), true), null);
    assert.equal(chooseProfile(task, engine.profilesFor(), terraOnly, {}, new Set(), 'worker', {}, 'normal', store.demandRoleOffsets(), true)?.profile.id, 'shape-2');
    // With both enabled, every T3 worker pick is the mapped Opus.
    const both = chooseProfile(task, t3Profiles, pool, {}, new Set(), 'worker', {}, 'normal', store.demandRoleOffsets(), true);
    assert.equal(both?.profile.id, 'shape-4');
    assert.equal(both?.profile.provider, 'claudeAgent');

    // routingPolicy names the exclusion and the mapping, and explains the choice.
    const retained = store.insert(taskOf({ complexity: 'medium' }), 't3code:env', 'handoff', 'a'.repeat(40));
    const policy = store.routingPolicy(store.task(retained.id), Date.now(), t3Profiles);
    assert.equal(policy.host?.hostId, 't3code:env');
    assert.deepEqual(policy.host?.effects, [
      { profileId: 'shape-2', name: 'Codex worker (full-access)', effect: 'excluded', reason: 'Excluded on T3Code in Settings' },
      { profileId: 'shape-4', name: 'Claude opus (bypassPermissions)', effect: 'mapped', reason: 'launches as claudeAgent/claude-opus-5-5, mode full-access (mapped: provider, modeId, thinkingOptionId, featureValues)' },
    ]);
    assert.equal(policy.selection?.choice?.profileId, 'shape-4');

    // The compatibility read shares the same answers, per host.
    const read = engine.profileCompatibility();
    assert.deepEqual(read.hosts.map(entry => [entry.hostId, entry.kind, entry.label, entry.catalog !== null]), [['paseo:local', 'paseo', 'Paseo', true], ['t3code:env', 't3code', 'T3Code', true]]);
    const row = (profileId: string, hostId: string) => read.rows.find(item => item.profileId === profileId && item.hostId === hostId)!;
    assert.deepEqual([row('shape-4', 't3code:env').status, row('shape-4', 't3code:env').launch?.provider], ['works', 'claudeAgent']);
    assert.deepEqual([row('shape-4', 'paseo:local').status, row('shape-4', 'paseo:local').launch?.provider], ['works', 'claude']);
    assert.equal(row('shape-2', 't3code:env').status, 'excluded');
    assert.equal(row('shape-8', 't3code:env').reason, "T3Code's opencode-go/deepseek-v4.1-flash has no thinking level high");
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('routingPolicy explains a medium task landing on the cheapest low-rated profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-host-selection-'));
  const store = new Store(join(dir, 'db'));
  try {
    // The Swallowtail case on T3 before mapping: Luna and Muse are rated low with
    // very low cost, DeepSeek medium with low cost. Muse and DeepSeek are out on T3.
    const pool = storedPool();
    store.setMeta('pool', pool);
    const catalog: HostCatalog = { providers: nightlyProviders().filter(provider => provider.enabled).map(provider => ({ key: provider.instanceId, label: provider.displayName, available: true, problem: '',
      models: provider.models.map(model => ({ id: model.slug, label: model.name, aliases: [], thinkingOptions: model.slug.startsWith('gpt') || model.slug.startsWith('grok') ? thinking('low', 'medium', 'high', 'xhigh', 'max') : [], defaultThinkingOptionId: null,
        modes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'].map(id => ({ id, label: id })), features: [] })) })) };
    const profiles = poolShapes.map((_, index) => stored(index));
    const t3Profiles = profiles.map(profile => ({ id: profile.id, name: profile.name, ...profileCompatibility(profile, catalog, {}, 't3code').launch, notes: '',
      ...(({ available, problem, supportedThinking }) => ({ available, problem, supportedThinking }))(profileCompatibility(profile, catalog, {}, 't3code')) }));
    const retained = store.insert(taskOf({ complexity: 'medium' }), 't3code:env', 'handoff', 'a'.repeat(40));
    const policy = store.routingPolicy(store.task(retained.id), Date.now(), t3Profiles);
    const selection = policy.selection!;
    assert.deepEqual([selection.complexity, selection.roleOffset, selection.usageOffset, selection.fullDemand, selection.demand], ['medium', 0, 0, 'medium', 'low']);
    assert.match(selection.step, /first attempt: one step down/);
    // Luna leads the set on its very low cost (16× weight 2 = 32).
    assert.equal(selection.met[0]!.profileId, 'shape-0');
    assert.equal(selection.met[0]!.effectiveWeight, 32);
    assert.equal(selection.choice?.profileId, 'shape-0');
    assert.match(selection.choice!.reason, /fewest recent assignments per effective weight/);
    assert.ok(!selection.met.some(item => item.profileId === 'shape-7' || item.profileId === 'shape-8'), 'Muse and DeepSeek are not in the T3 set');
    assert.ok(policy.host!.effects.some(effect => effect.profileId === 'shape-8' && effect.effect === 'unavailable'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
