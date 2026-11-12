import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { t3codeVocabulary } from '../hosts/t3code/vocabulary';
import { paseoVocabulary } from '../hosts/paseo/vocabulary';
import { PaseoAdapter } from '../service/paseo-composition';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { Store } from '../core/store/store';
import { RuntimeSettings } from '../core/runtime/settings';
import { chooseProfile } from '../core/dispatch/routing';
import { RuntimeBoard, type BoardContext } from '../core/runtime/board';
import { createTaskDetailCache } from '../core/telemetry/task-detail';
import { migrateProfileVocabulary } from '../core/store/profile-vocabulary-migration';
import { nucleusProfileInputSchema, nucleusProfileSchema, profileCompatibility, routingProfiles, type NucleusProfile } from '../shared/profiles';
import { canonicalCatalog, isCanonicalProvider, isRuntimeMode, isThinkingLevel, mergeCanonicalCatalogs, type HostVocabulary, type LaunchValues } from '../shared/profile-vocabulary';
import { poolSchema, submissionSchema, type PoolEntry, type Profile, type Task } from '../shared/contracts';
import type { HostAgentSpec, HostCatalog } from '../shared/host';
import { t3Fake } from './support/t3code-fake';
import { nightlyProviders, paseoCatalog, poolShapes } from './support/pool-shapes';

/**
 * Task 1158 (Tom, 2026-11-12): profiles store one canonical vocabulary, and each
 * host adapter translates it in code with one table. No per-profile host setting.
 */

const stored = (index: number): NucleusProfile => nucleusProfileSchema.parse({ id: `shape-${index}`, name: poolShapes[index]!.profile.label,
  ...Object.fromEntries(Object.entries(poolShapes[index]!.profile).filter(([key]) => key !== 'label')) });
const storedPool = (): PoolEntry[] => poolShapes.map((shape, index) => poolSchema.parse({ profileId: `shape-${index}`, ...shape.entry }));

async function t3Fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'profile-vocabulary-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = nightlyProviders();
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  return { root, directory, host, server, catalog: await host.catalog() };
}

/**
 * The launch values each pool shape translates to, by label (#1151's table):
 * Haiku and Opus run on T3 as `claudeAgent` with their thinking as `effort`,
 * DeepSeek and Muse as Pi with a `thinking` option, Grok with its mode and no
 * `auto_accept`, Codex unchanged. On Paseo Claude's full access is
 * `bypassPermissions` and Grok's is `auto_accept`. A string is the expected
 * reason the shape can't run there.
 */
const expected: Record<string, { paseo: LaunchValues | string; t3code: LaunchValues | string }> = {
  'Codex grind (full-access)': {
    paseo: { provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' },
    t3code: { provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' } },
  'Codex oracle (full-access)': {
    paseo: { provider: 'codex', model: 'gpt-6.1-sol', modeId: 'full-access', thinkingOptionId: 'high' },
    t3code: { provider: 'codex', model: 'gpt-6.1-sol', modeId: 'full-access', thinkingOptionId: 'high' } },
  'Codex worker (full-access)': {
    paseo: { provider: 'codex', model: 'gpt-6.1-terra', modeId: 'full-access', thinkingOptionId: 'high' },
    t3code: { provider: 'codex', model: 'gpt-6.1-terra', modeId: 'full-access', thinkingOptionId: 'high' } },
  'Claude haiku (auto)': {
    paseo: { provider: 'claude', model: 'claude-haiku-5-5', modeId: 'auto', thinkingOptionId: 'high' },
    t3code: { provider: 'claudeAgent', model: 'claude-haiku-5-5', modeId: 'auto', featureValues: { effort: 'high' } } },
  'Claude opus (full-access)': {
    paseo: { provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'medium' },
    t3code: { provider: 'claudeAgent', model: 'claude-opus-5-5', modeId: 'full-access', featureValues: { effort: 'medium' } } },
  'Claude sonnet (full-access, disabled)': {
    paseo: { provider: 'claude', model: 'claude-haiku-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'high' },
    t3code: { provider: 'claudeAgent', model: 'claude-haiku-5-5', modeId: 'full-access', featureValues: { effort: 'high' } } },
  'Grok (full-access)': {
    paseo: { provider: 'grok', model: 'grok-4.6', thinkingOptionId: 'high', featureValues: { auto_accept: true } },
    t3code: { provider: 'grok', model: 'grok-4.6', modeId: 'full-access', thinkingOptionId: 'high' } },
  'Pi muse (no mode)': {
    paseo: { provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', thinkingOptionId: 'high' },
    t3code: { provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', featureValues: { thinking: 'high' } } },
  'Pi deepseek (no mode)': {
    paseo: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high' },
    t3code: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', featureValues: { thinking: 'high' } } },
  'Pi glm (no mode, disabled)': {
    paseo: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high' },
    t3code: { provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', featureValues: { thinking: 'high' } } },
  'Mode-only (plan)': { paseo: "Paseo can't run codex in mode plan", t3code: "T3Code can't run codex in mode plan" },
  'Mode-only (auto)': {
    paseo: { provider: 'codex', model: 'gpt-6-luna', modeId: 'auto' },
    t3code: { provider: 'codex', model: 'gpt-6-luna', modeId: 'auto' } },
};

/** Every shape whose answer on this host differs from the expected table, named with its value. */
function coverageFailures(vocabulary: HostVocabulary, catalog: HostCatalog): string[] {
  const failures: string[] = [];
  for (const [index, shape] of poolShapes.entries()) {
    const want = expected[shape.profile.label]?.[vocabulary.kind];
    if (want === undefined) { failures.push(`${shape.profile.label}: no expected ${vocabulary.label} launch`); continue; }
    const answer = profileCompatibility(stored(index), catalog, vocabulary);
    if (typeof want === 'string') {
      if (answer.status !== 'unavailable' || answer.reason !== want) failures.push(`${shape.profile.label}: expected "${want}", got ${answer.status} "${answer.reason}"`);
    } else if (answer.status !== 'works') failures.push(`${shape.profile.label}: ${answer.reason}`);
    else if (!isDeepStrictEqual(answer.launch, want)) failures.push(`${shape.profile.label}: launches ${JSON.stringify(answer.launch)}, expected ${JSON.stringify(want)}`);
  }
  return failures;
}

/** A deep copy of a table with one entry removed: a provider, or one thinking level or mode of one provider. */
function without(vocabulary: HostVocabulary, provider: string, field?: 'thinking' | 'modes', key?: string): HostVocabulary {
  const copy = structuredClone(vocabulary);
  const providers = copy.providers as Record<string, { thinking: Record<string, string>; modes: Record<string, unknown> } | undefined>;
  if (!field) delete providers[provider];
  else delete providers[provider]![field][key!];
  return copy;
}

test('acceptance 1: every pool shape is canonical and translates on Paseo and on the recorded nightly T3 catalog to its launch values', async t => {
  for (const shape of poolShapes) {
    const { label: _label, ...values } = shape.profile;
    assert.ok(isCanonicalProvider(values.provider), `${shape.profile.label}: provider ${values.provider} is canonical`);
    if (values.modeId) assert.ok(isRuntimeMode(values.modeId), `${shape.profile.label}: mode ${values.modeId} is canonical`);
    if (values.thinkingOptionId) assert.ok(isThinkingLevel(values.thinkingOptionId), `${shape.profile.label}: thinking ${values.thinkingOptionId} is canonical`);
    assert.ok(!('auto_accept' in (values.featureValues ?? {})), `${shape.profile.label}: no host-owned option`);
    nucleusProfileInputSchema.parse({ name: shape.profile.label, ...values });
  }
  const { catalog: t3 } = await t3Fixture(t);
  assert.deepEqual(coverageFailures(paseoVocabulary, paseoCatalog()), []);
  assert.deepEqual(coverageFailures(t3codeVocabulary, t3), []);
});

test('acceptance 1: removing any translation entry the pool uses fails the coverage with the value named', async t => {
  const { catalog: t3 } = await t3Fixture(t);
  const removals: [HostVocabulary, HostCatalog, string, ('thinking' | 'modes')?, string?][] = [
    [t3codeVocabulary, t3, 'claude'], [t3codeVocabulary, t3, 'pi'], [t3codeVocabulary, t3, 'grok'], [t3codeVocabulary, t3, 'codex'],
    [t3codeVocabulary, t3, 'claude', 'thinking', 'medium'], [t3codeVocabulary, t3, 'pi', 'thinking', 'high'],
    [t3codeVocabulary, t3, 'claude', 'modes', 'full-access'], [t3codeVocabulary, t3, 'codex', 'modes', 'auto'], [t3codeVocabulary, t3, 'grok', 'modes', 'full-access'],
    [paseoVocabulary, paseoCatalog(), 'claude'], [paseoVocabulary, paseoCatalog(), 'grok'],
    [paseoVocabulary, paseoCatalog(), 'claude', 'modes', 'full-access'], [paseoVocabulary, paseoCatalog(), 'claude', 'modes', 'auto'],
    [paseoVocabulary, paseoCatalog(), 'grok', 'modes', 'full-access'], [paseoVocabulary, paseoCatalog(), 'codex', 'thinking', 'xhigh'],
  ];
  for (const [vocabulary, catalog, provider, field, key] of removals) {
    const failures = coverageFailures(without(vocabulary, provider, field, key), catalog);
    const named = key ?? provider;
    assert.ok(failures.length > 0, `${vocabulary.label} without ${provider}${key ? ` ${field} ${key}` : ''} fails the coverage`);
    assert.ok(failures.some(failure => failure.includes(named)), `the failure names ${named}: ${failures.join('; ')}`);
  }
});

const launchSpec = (workspaceId: string, profile: Profile, requestId: string): HostAgentSpec => ({ workspaceId, profile, title: 'Synthetic role', mcpBindingPath: null,
  attempt: () => ({ requestId, prompt: 'Synthetic prompt', labels: { task: 'synthetic-task', role: 'worker' }, environment: {} }) });

test('acceptance 2: a canonical Opus profile launches on T3 as claudeAgent with full-access and its effort, and on Paseo with Paseo\'s ids, with no per-profile settings', async t => {
  const { directory, host, server, catalog } = await t3Fixture(t);
  const opus = nucleusProfileSchema.parse({ id: 'opus', name: 'Opus', provider: 'claude', model: 'claude-opus-5-5', modeId: 'full-access', thinkingOptionId: 'medium' });
  assert.deepEqual(Object.keys(opus).sort(), ['id', 'modeId', 'model', 'name', 'notes', 'provider', 'thinkingOptionId'], 'the profile carries canonical values only');
  const [onT3] = routingProfiles([opus], catalog, t3codeVocabulary);
  assert.equal(onT3!.available, true, onT3!.problem);
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
  await host.createAgent(launchSpec(workspace.id, onT3!, 'launch-opus'));
  const command = server.commands.find(candidate => candidate.commandId === 'launch-opus')!;
  assert.equal(command.modelSelection.instanceId, 'claudeAgent');
  assert.equal(command.modelSelection.model, 'claude-opus-5-5');
  assert.deepEqual(command.modelSelection.options, [{ id: 'effort', value: 'medium' }]);
  assert.equal(command.runtimeMode, 'full-access');

  const [onPaseo] = routingProfiles([opus], paseoCatalog(), paseoVocabulary);
  assert.equal(onPaseo!.available, true, onPaseo!.problem);
  const creates: { config: Record<string, unknown> }[] = [];
  const paseo = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  assert.equal(paseo.vocabulary, paseoVocabulary, 'the Paseo adapter owns its table');
  (paseo as unknown as { api: unknown }).api = { workspaces: { ref: () => ({ agents: { create: async (input: { config: Record<string, unknown> }) => { creates.push(input); return { id: 'agent' }; } } }) } };
  await paseo.nativeAgentCreate(launchSpec('workspace', onPaseo!, 'launch-paseo'), false, false);
  assert.deepEqual(creates[0]!.config, { provider: 'claude/claude-opus-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'medium', featureValues: undefined, mcpServers: undefined });
});

test('a value no table can express makes the profile unavailable with a computed reason, and a value outside the vocabulary is refused at the form', () => {
  const answer = (values: Record<string, unknown>, vocabulary: HostVocabulary) =>
    profileCompatibility(nucleusProfileSchema.parse({ id: 'p', name: 'P', ...values }), vocabulary === paseoVocabulary ? paseoCatalog() : { providers: [] }, vocabulary);
  assert.equal(answer({ provider: 'fx', model: 'default' }, paseoVocabulary).reason, 'Paseo has no fx provider');
  assert.equal(answer({ provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'ultra' }, paseoVocabulary).reason, "Paseo can't express thinking level ultra for claude");
  assert.equal(answer({ provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', modeId: 'full-access' }, paseoVocabulary).reason, "Paseo can't run pi in mode full-access");
  assert.equal(answer({ provider: 'grok', model: 'grok-4.6', featureValues: { auto_accept: true } }, paseoVocabulary).reason,
    'Option auto_accept is how Paseo carries a thinking level or mode; set those instead');
  assert.equal(answer({ provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions' }, paseoVocabulary).reason, "Runtime mode bypassPermissions is not in Nucleus's vocabulary");
  for (const input of [{ provider: 'claudeAgent' }, { provider: 'claude', modeId: 'bypassPermissions' }, { provider: 'claude', thinkingOptionId: 'ultrathink' }])
    assert.equal(nucleusProfileInputSchema.safeParse({ name: 'P', model: 'm', ...input }).success, false, JSON.stringify(input));
});

test('the form vocabulary is every host\'s catalog in canonical values, merged, without the options a table owns', async t => {
  const { catalog: t3 } = await t3Fixture(t);
  const paseo = canonicalCatalog(paseoVocabulary, paseoCatalog());
  const onT3 = canonicalCatalog(t3codeVocabulary, t3);
  // T3's claudeAgent reads as canonical claude, its effort option as thinking levels.
  const t3Opus = onT3.providers.find(provider => provider.key === 'claude')!.models.find(model => model.id === 'claude-opus-5-5')!;
  assert.deepEqual(t3Opus.thinkingOptions.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(t3Opus.modes.map(mode => mode.id), ['supervised', 'accept-edits', 'auto', 'full-access']);
  assert.equal(t3Opus.features.some(feature => feature.id === 'effort'), false);
  // Paseo's Claude has no canonical ultra (its ultracode is not offered), and its modes read canonically.
  const paseoOpus = paseo.providers.find(provider => provider.key === 'claude')!.models.find(model => model.id === 'claude-opus-5-5')!;
  assert.deepEqual(paseoOpus.thinkingOptions.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(paseoOpus.modes.map(mode => mode.id), ['plan', 'supervised', 'accept-edits', 'auto', 'full-access']);
  // Paseo's Grok carries its modes as auto_accept, which is not a feature the form shows.
  const paseoGrok = paseo.providers.find(provider => provider.key === 'grok')!.models[0]!;
  assert.deepEqual([paseoGrok.modes.map(mode => mode.id), paseoGrok.features], [['supervised', 'full-access'], []]);
  // Merged: a level or mode at least one host can run; providers by canonical key, once.
  const merged = mergeCanonicalCatalogs([paseo, onT3]);
  // T3's disabled Cursor still lists, unavailable with its reason.
  assert.deepEqual(merged.providers.map(provider => [provider.key, provider.available]), [['codex', true], ['claude', true], ['pi', true], ['grok', true], ['cursor', false]]);
  const mergedOpus = merged.providers.find(provider => provider.key === 'claude')!.models.find(model => model.id === 'claude-opus-5-5')!;
  assert.deepEqual(mergedOpus.thinkingOptions.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(mergedOpus.modes.map(mode => mode.id), ['plan', 'supervised', 'accept-edits', 'auto', 'full-access']);
});

test('the one-time migration moves Paseo spellings to canonical values and keeps a profile with an unknown value as stored, reported', () => {
  const live = [
    { id: 'grok', name: 'Grok', provider: 'grok', model: 'grok-4.6', thinkingOptionId: 'high', featureValues: { auto_accept: true } },
    { id: 'luna', name: 'Luna', provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' },
    { id: 'opus', name: 'Opus', provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'medium' },
    { id: 'odd', name: 'Odd', provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'ultracode' },
  ];
  const { profiles, record } = migrateProfileVocabulary(live, '2026-11-12T00:00:00.000Z');
  assert.deepEqual(profiles, [
    { id: 'grok', name: 'Grok', provider: 'grok', model: 'grok-4.6', thinkingOptionId: 'high', modeId: 'full-access' },
    live[1], { ...live[2], modeId: 'full-access' }, live[3],
  ]);
  assert.deepEqual(record.changes, [
    { profileId: 'grok', field: 'modeId', from: undefined, to: 'full-access' },
    { profileId: 'grok', field: 'featureValues', from: { auto_accept: true }, to: undefined },
    { profileId: 'opus', field: 'modeId', from: 'bypassPermissions', to: 'full-access' },
  ]);
  assert.deepEqual(record.unknown, [{ profileId: 'odd', field: 'thinkingOptionId', value: 'ultracode' }]);
  // Running it again changes nothing.
  assert.deepEqual(migrateProfileVocabulary(profiles).record.changes, []);
});

test('the store runs the migration once on open and records it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-vocabulary-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  const first = new Store(path);
  first.setMeta('profiles', [{ id: 'opus', name: 'Opus', provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions', notes: '' }]);
  first.db.prepare("DELETE FROM meta WHERE key='profileVocabularyMigration'").run();
  first.close();
  const second = new Store(path);
  try {
    assert.equal(second.profiles()[0]!.modeId, 'full-access');
    assert.deepEqual(second.getMeta<{ changes: unknown[] }>('profileVocabularyMigration')!.changes, [{ profileId: 'opus', field: 'modeId', from: 'bypassPermissions', to: 'full-access' }]);
    // A later legacy value is not rewritten: the migration ran.
    second.setMeta('profiles', [{ id: 'later', name: 'Later', provider: 'claude', model: 'm', modeId: 'bypassPermissions', notes: '' }]);
  } finally { second.close(); }
  const third = new Store(path);
  try { assert.equal(third.profiles()[0]!.modeId, 'bypassPermissions'); } finally { third.close(); }
});

const taskOf = (more: Partial<Task> = {}): Task => submissionSchema.parse({
  submissionId: 'profile-vocabulary', title: 'Profile vocabulary', repoPath: '/repo', planningCommit: 'a'.repeat(40),
  handoffPath: 'handoff.md', originAgentId: 'origin', hostId: 't3code:env', ...more,
}) as Task;

test('each host\'s routing snapshot carries its translation, selection and routingPolicy follow it, and the compatibility read agrees', async t => {
  const { catalog } = await t3Fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'profile-vocabulary-engine-'));
  const store = new Store(join(dir, 'db'));
  const paseo = { profiles: async () => [], observe: async () => { throw Error('not observed'); }, catalog: async () => paseoCatalog(), vocabulary: paseoVocabulary } as unknown as Adapter;
  const t3Adapter = { profiles: async () => [], observe: async () => { throw Error('not observed'); }, catalog: async () => catalog, vocabulary: t3codeVocabulary } as unknown as Adapter;
  const engine = new Engine(store, paseo, 0);
  engine.hostIds = () => ['paseo:local', 't3code:env'];
  engine.resolveHostAdapter = id => id === 't3code:env' ? t3Adapter : paseo;
  try {
    // Only Opus and the plan-mode Codex are enabled; Opus is rated very high at medium cost.
    const pool = storedPool().map(entry => ({ ...entry, enabled: entry.profileId === 'shape-4' || entry.profileId === 'shape-10',
      ...(entry.profileId === 'shape-4' ? { capability: 'very_high' as const, cost: 'medium' as const } : {}) }));
    store.setProfiles(poolShapes.map((_, index) => stored(index)));
    store.setMeta('pool', pool);
    await engine.refresh();
    const t3Profiles = engine.profilesFor('t3code:env');
    const opus = t3Profiles.find(profile => profile.id === 'shape-4')!;
    assert.deepEqual({ provider: opus.provider, modeId: opus.modeId, thinkingOptionId: opus.thinkingOptionId, featureValues: opus.featureValues, translated: opus.translated, available: opus.available },
      { provider: 'claudeAgent', modeId: 'full-access', thinkingOptionId: undefined, featureValues: { effort: 'medium' }, translated: ['provider', 'thinking'], available: true });
    const paseoOpus = engine.profilesFor().find(profile => profile.id === 'shape-4')!;
    assert.deepEqual({ provider: paseoOpus.provider, modeId: paseoOpus.modeId, thinkingOptionId: paseoOpus.thinkingOptionId }, { provider: 'claude', modeId: 'bypassPermissions', thinkingOptionId: 'medium' });

    // A profile edit reaches each host's snapshot at once, translated.
    const settings = new RuntimeSettings({ store, engine } as unknown as ConstructorParameters<typeof RuntimeSettings>[0]);
    settings.profileUpdate({ id: 'shape-4', thinkingOptionId: 'high' });
    assert.deepEqual(engine.profilesFor('t3code:env').find(profile => profile.id === 'shape-4')!.featureValues, { effort: 'high' });
    assert.equal(engine.profilesFor().find(profile => profile.id === 'shape-4')!.thinkingOptionId, 'high');
    assert.throws(() => settings.profileUpdate({ id: 'shape-4', hosts: { t3code: { excluded: true } } } as never), /Unrecognized key/);
    const current = engine.profilesFor('t3code:env');

    const task = { ...taskOf({ complexity: 'medium' }), workerModel: 'other-author', workerModels: ['other-author'] };
    const plan = current.find(profile => profile.id === 'shape-10')!;
    assert.deepEqual([plan.available, plan.problem], [false, "T3Code can't run codex in mode plan"]);
    const planOnly = pool.map(entry => ({ ...entry, enabled: entry.profileId === 'shape-10' }));
    assert.equal(chooseProfile(task, current, planOnly, {}, new Set(), 'worker', {}, 'normal', store.demandRoleOffsets(), true), null);
    assert.equal(chooseProfile(task, current, pool, {}, new Set(), 'worker', {}, 'normal', store.demandRoleOffsets(), true)?.profile.provider, 'claudeAgent');

    const retained = store.insert(taskOf({ complexity: 'medium' }), 't3code:env', 'handoff', 'a'.repeat(40));
    const policy = store.routingPolicy(store.task(retained.id), Date.now(), current);
    assert.deepEqual(policy.host?.effects, [
      { profileId: 'shape-4', name: 'Claude opus (full-access)', effect: 'translated', reason: 'launches as claudeAgent/claude-opus-5-5, mode full-access, options effort=high' },
      { profileId: 'shape-10', name: 'Mode-only (plan)', effect: 'unavailable', reason: "T3Code can't run codex in mode plan" },
    ]);
    assert.equal(policy.selection?.choice?.profileId, 'shape-4');
    const board = new RuntimeBoard({ store, engine, markStoreAccess: () => {},
      cachedTaskDetail: createTaskDetailCache(store, { profiles: task => engine.profilesFor(task.hostId) }) } as unknown as BoardContext);
    assert.deepEqual(board.taskNext({ taskId: retained.id }).routingPolicy?.host, policy.host);

    const read = engine.profileCompatibility();
    assert.deepEqual(read.hosts.map(entry => [entry.hostId, entry.kind, entry.label]), [['paseo:local', 'paseo', 'Paseo'], ['t3code:env', 't3code', 'T3Code']]);
    const row = (profileId: string, hostId: string) => read.rows.find(item => item.profileId === profileId && item.hostId === hostId)!;
    assert.deepEqual([row('shape-4', 't3code:env').status, row('shape-4', 't3code:env').launch?.provider, row('shape-4', 't3code:env').translated], ['works', 'claudeAgent', ['provider', 'thinking']]);
    assert.deepEqual([row('shape-4', 'paseo:local').status, row('shape-4', 'paseo:local').launch?.modeId], ['works', 'bypassPermissions']);
    assert.equal(row('shape-10', 'paseo:local').reason, "Paseo can't run codex in mode plan");
    // The form's vocabulary merges the secondary host's canonical catalog.
    assert.ok(engine.secondaryCanonicalCatalogs()[0]!.providers.some(provider => provider.key === 'claude'));
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('routingPolicy explains a medium task landing on the cheapest low-rated profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-vocabulary-selection-'));
  const store = new Store(join(dir, 'db'));
  try {
    // The Swallowtail case on T3: Luna and Muse are rated low with very low cost,
    // DeepSeek medium with low cost. This catalog reports no Pi thinking option,
    // so Muse and DeepSeek are out on T3.
    const pool = storedPool();
    store.setMeta('pool', pool);
    const levels = (...ids: string[]) => ids.map(id => ({ id, label: id }));
    const catalog: HostCatalog = { providers: nightlyProviders().filter(provider => provider.enabled).map(provider => ({ key: provider.instanceId, label: provider.displayName, available: true, problem: '',
      models: provider.models.map(model => ({ id: model.slug, label: model.name, aliases: [], thinkingOptions: model.slug.startsWith('gpt') || model.slug.startsWith('grok') ? levels('low', 'medium', 'high', 'xhigh', 'max') : [], defaultThinkingOptionId: null,
        modes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'].map(id => ({ id, label: id })), features: [] })) })) };
    const t3Profiles = routingProfiles(poolShapes.map((_, index) => stored(index)), catalog, t3codeVocabulary);
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
