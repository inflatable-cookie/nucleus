import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { ProvenPreSendRefusalError } from '../core/host';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { Store } from '../core/store/store';
import { chooseProfile } from '../core/dispatch/routing';
import { nucleusProfileSchema, profileAvailability, routingProfiles, type NucleusProfile, type ProviderMap } from '../shared/profiles';
import { poolSchema, submissionSchema, type PoolEntry, type Profile, type Task } from '../shared/contracts';
import type { HostAgentSpec, HostCatalog } from '../shared/host';
import { t3Fake } from './support/t3code-fake';

/**
 * The installed nightly's provider snapshot as `server.getConfig` reports it
 * (0.1.10-nightly.20261111.4529): the option descriptors each model carries, and
 * the runtime modes each provider restricts itself to. Codex and Claude report
 * no `supportedRuntimeModes`, so the nightly passes any of the four through
 * (`providerRuntimeMode`); Grok and Pi report a subset, and a request outside it
 * silently runs as `approval-required`. Copied, never connected: identifiers are
 * synthetic and the shapes are the contract.
 */
const nightlyProviders = () => [
  { instanceId: 'codex', displayName: 'Codex', enabled: true, status: 'ready', models: [
    { slug: 'gpt-6-luna', name: 'Luna', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, label: id })) },
      { id: 'serviceTier', label: 'Service Tier', type: 'select', currentValue: 'default', options: [{ id: 'default', label: 'Default', isDefault: true }, { id: 'priority', label: 'Priority' }] },
    ] } },
    { slug: 'gpt-6.1-sol', name: 'Sol', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'gpt-6.1-terra', name: 'Terra', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'claudeAgent', displayName: 'Claude', enabled: true, status: 'ready', models: [
    { slug: 'claude-haiku-5-5', name: 'Haiku', capabilities: { optionDescriptors: [
      { id: 'effort', label: 'Effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'claude-opus-5-5', name: 'Opus', capabilities: { optionDescriptors: [
      { id: 'effort', label: 'Effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'grok', displayName: 'Grok', enabled: true, status: 'ready', supportedRuntimeModes: ['approval-required', 'auto', 'full-access'], models: [
    { slug: 'grok-4.6', name: 'Grok 4.6', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'high', options: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'pi', displayName: 'Pi', enabled: true, status: 'ready', supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'full-access'], models: [
    { slug: 'opencode-go/muse-spark-1.3-contributor', name: 'Muse 1.3', capabilities: { optionDescriptors: [
      { id: 'thinking', label: 'Thinking', type: 'select', options: ['minimal', 'low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'opencode-go/deepseek-v4.1-flash', name: 'Deepseek 4.1 Flash', capabilities: { optionDescriptors: [
      { id: 'thinking', label: 'Thinking', type: 'select', options: ['low', 'high', 'max'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'cursor', displayName: 'Cursor', enabled: false, status: 'disabled', models: [] },
];

/**
 * Synthetic copies of the live profile pool's shapes (read once, read-only):
 * provider, model, quiet option ids, runtime mode, roles, capability, cost and
 * whether the pool enables it. Every field the adapter has to handle is present;
 * the ids and names are synthetic so the fixture carries no live identity.
 */
type ShapeProfile = { label: string; provider: string; model: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> };
const poolShapes: Array<{ entry: Omit<PoolEntry, 'profileId'>; profile: ShapeProfile }> = [
  { entry: { enabled: true, group: 'codex', roles: ['worker', 'coordinator', 'reviewer'], cost: 'very_low', capability: 'low', weight: 2, scopes: ['general', 'mechanical'] },
    profile: { label: 'Codex grind (full-access)', provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' } },
  { entry: { enabled: true, group: 'codex', roles: ['reviewer', 'worker'], cost: 'high', capability: 'very_high', weight: 1, scopes: ['complex', 'general'] },
    profile: { label: 'Codex oracle (full-access)', provider: 'codex', model: 'gpt-6.1-sol', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'codex', roles: ['worker'], cost: 'medium', capability: 'high', weight: 1, scopes: ['general'] },
    profile: { label: 'Codex worker (full-access)', provider: 'codex', model: 'gpt-6.1-terra', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'claude', roles: ['worker', 'reviewer'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general', 'mechanical'] },
    profile: { label: 'Claude haiku (auto)', provider: 'claude', model: 'claude-haiku-5-5', modeId: 'auto', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'claude', roles: ['reviewer', 'worker'], cost: 'very_high', capability: 'frontier', weight: 1, scopes: ['general', 'complex'] },
    profile: { label: 'Claude opus (bypassPermissions)', provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'medium' } },
  { entry: { enabled: false, group: 'claude', roles: ['worker'], cost: 'very_high', capability: 'very_high', weight: 1, scopes: ['general'] },
    profile: { label: 'Claude sonnet (bypassPermissions, disabled)', provider: 'claude', model: 'claude-haiku-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'grok', roles: ['worker', 'reviewer'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general', 'complex'] },
    profile: { label: 'Grok (no mode, auto_accept)', provider: 'grok', model: 'grok-4.6', thinkingOptionId: 'high', featureValues: { auto_accept: true } } },
  { entry: { enabled: true, group: 'meta', roles: ['worker', 'reviewer', 'coordinator'], cost: 'very_low', capability: 'low', weight: 1, scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi muse (no mode)', provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'deepseek', roles: ['worker', 'reviewer'], cost: 'low', capability: 'medium', weight: 2, scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi deepseek (no mode)', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high', featureValues: {} } },
  { entry: { enabled: false, group: 'glm', roles: ['worker', 'reviewer', 'coordinator'], cost: 'low', capability: 'medium', weight: 2, scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi glm (no mode, disabled)', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high' } },
  // The mode fence itself, on a provider T3 spells the same way: the mode the
  // pool's Claude profiles carry, which is not one of T3's four, and one that is.
  { entry: { enabled: true, group: 'codex', roles: ['worker'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general'] },
    profile: { label: 'Mode-only (bypassPermissions)', provider: 'codex', model: 'gpt-6-luna', modeId: 'bypassPermissions' } },
  { entry: { enabled: true, group: 'codex', roles: ['reviewer'], cost: 'medium', capability: 'medium', weight: 1, scopes: ['general'] },
    profile: { label: 'Mode-only (auto)', provider: 'codex', model: 'gpt-6-luna', modeId: 'auto' } },
];

/**
 * The live pool's provider spellings against this host's own: T3 names the
 * provider instance `claudeAgent`, so the pool's `claude` shapes are ineligible
 * on it until an operator maps the key. That is the provider map's job, not the
 * runtime mode's, so the sweep reads the pool as stored.
 */
const t3ProviderMap: ProviderMap = {};

const stored = (index: number) => nucleusProfileSchema.parse({ id: `shape-${index}`, name: `shape-${index}`,
  ...Object.fromEntries(Object.entries(poolShapes[index]!.profile).filter(([key]) => key !== 'label')) });
const storedPool = (): PoolEntry[] => poolShapes.map((shape, index) =>
  poolSchema.parse({ profileId: `shape-${index}`, ...shape.entry }));

interface Fixture { root: string; directory: string; host: T3CodeHost; catalog: HostCatalog; server: Awaited<ReturnType<typeof t3Fake>> }
async function fixture(t: TestContext): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 't3code-runtime-mode-'));
  const directory = await realpath(root);
  const server = await t3Fake(t, directory);
  server.controls.providers = nightlyProviders();
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  return { root, directory, host, catalog: await host.catalog(), server };
}
const launchSpec = (workspaceId: string, profile: Profile, requestId: string): HostAgentSpec => ({ workspaceId, profile, title: 'Synthetic role', mcpBindingPath: null,
  attempt: () => ({ requestId, prompt: 'Synthetic prompt', labels: { task: 'synthetic-task', role: 'worker' }, environment: {} }) });

test('the T3 catalog reports the nightly reporting provider runtime modes, with the nightly labels', async t => {
  const { catalog } = await fixture(t);
  const provider = (key: string) => catalog.providers.find(candidate => candidate.key === key)!;
  const modelsOf = (key: string) => provider(key).models;
  const modeIds = (key: string) => modelsOf(key).map(model => model.modes.map(mode => mode.id));
  // Codex and Claude report no `supportedRuntimeModes` in the nightly snapshot:
  // every one of the four passes through, so all four are offered.
  for (const key of ['codex', 'claudeAgent'])
    for (const modes of modeIds(key))
      assert.deepEqual(modes, ['approval-required', 'auto-accept-edits', 'auto', 'full-access'], `${key} offers T3's four modes`);
  // Grok and Pi restrict the subset, and the catalog reports exactly it: a
  // mode outside it would run as approval-required, so it is never offered.
  for (const modes of modeIds('grok')) assert.deepEqual(modes, ['approval-required', 'auto', 'full-access']);
  for (const modes of modeIds('pi')) assert.deepEqual(modes, ['approval-required', 'auto-accept-edits', 'full-access']);
  // The label and description are the nightly's own wording.
  assert.deepEqual(modelsOf('grok')[0]!.modes[2], { id: 'full-access', label: 'Full access', description: 'Allow commands and edits without prompts.' });
  assert.deepEqual(modelsOf('codex')[0]!.modes[0], { id: 'approval-required', label: 'Supervised', description: 'Ask before commands and file changes.' });
  // The contract this rests on is the recorded nightly quote: its values, labels
  // and descriptions are the ones the catalog reports, so a drift in either
  // place fails here rather than in a live launch.
  const contract = JSON.parse(readFileSync(new URL('./fixtures/t3code-contract.json', import.meta.url), 'utf8')) as
    { runtimeModeContract: { values: string[]; labels: Record<string, string>; descriptions: Record<string, string> } };
  const quoted = contract.runtimeModeContract;
  assert.deepEqual(modelsOf('codex')[0]!.modes.map(mode => mode.id), quoted.values);
  assert.deepEqual(modelsOf('codex')[0]!.modes.map(mode => mode.label), quoted.values.map(value => quoted.labels[value]));
  assert.deepEqual(modelsOf('codex')[0]!.modes.map(mode => mode.description), quoted.values.map(value => quoted.descriptions[value]));
});

test('the launch carries the profile\'s runtime mode, and a profile with none gets the unattended default', async t => {
  const { root, directory, host, server } = await fixture(t);
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
  const base = { id: 'synthetic', name: 'Synthetic', provider: 'codex', model: 'gpt-6-luna', available: true, problem: '', notes: '', supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max'] };
  const launched = async (modeId: string | undefined, requestId: string) => {
    const created = await host.createAgent(launchSpec(workspace.id, modeId === undefined ? base : { ...base, modeId }, requestId));
    const command = server.commands.find(candidate => candidate.commandId === requestId)!;
    return { created, command };
  };
  for (const mode of ['full-access', 'auto', 'auto-accept-edits', 'approval-required']) {
    const { command } = await launched(mode, `launch-${mode}`);
    assert.equal(command.runtimeMode, mode, `the profile's ${mode} is the thread's runtime mode`);
    assert.equal(command.interactionMode, 'default');
  }
  // A profile with no mode runs the way T3 launches a thread with none asked
  // for — full-access, the mode an unattended Paseo worker gets today — never
  // approval-required, which would stop at every approval prompt.
  const defaulted = await launched(undefined, 'launch-default');
  assert.equal(defaulted.command.runtimeMode, 'full-access');
  assert.equal((await host.observe(defaulted.created.id)).modeId, 'full-access', 'the thread reports the mode it launched with');
  // A mode T3 does not have is refused before send, named, and nothing is written.
  const before = server.commands.length;
  await assert.rejects(host.createAgent(launchSpec(workspace.id, { ...base, modeId: 'bypassPermissions' }, 'launch-bypass')),
    (error: unknown) => error instanceof ProvenPreSendRefusalError && /T3Code has no runtime mode bypassPermissions/.test(error.message));
  // A mode the provider does not offer is refused rather than silently
  // downgraded to approval-required by the nightly's providerRuntimeMode.
  await assert.rejects(host.createAgent(launchSpec(workspace.id, { ...base, provider: 'grok', model: 'grok-4.6', thinkingOptionId: undefined, modeId: 'auto-accept-edits' }, 'launch-grok')),
    (error: unknown) => error instanceof ProvenPreSendRefusalError && /T3Code provider grok does not offer runtime mode auto-accept-edits/.test(error.message));
  assert.equal(server.commands.length, before, 'both refusals are proven before the socket write');
  assert.ok(root);
});

test('every enabled pool profile shape launches on T3 or is ineligible with a named reason', async t => {
  const { root, directory, host, server } = await fixture(t);
  const workspace = await host.createWorkspace({ title: 'Synthetic worktree', requestId: 'workspace-intent', directory, project: { projectId: 'synthetic-project' } });
  const root2 = await realpath(root);
  assert.equal(workspace.directory, root2);
  const profiles = routingProfiles(poolShapes.map((_, index) => stored(index)), await host.catalog(), t3ProviderMap);
  const pool = storedPool();
  const launchedModes = new Map<string, string>();
  for (const [index, shape] of poolShapes.entries()) {
    const profile = profiles[index]!;
    const entry = pool[index]!;
    // A disabled pool entry never dispatches, so it is outside this sweep.
    if (!entry.enabled) continue;
    if (!profile.available) {
      assert.ok(profile.problem.length > 0, `${shape.profile.label}: ineligible profiles name their reason`);
      continue;
    }
    const requestId = `launch-shape-${index}`;
    await host.createAgent(launchSpec(workspace.id, profile, requestId));
    const command = server.commands.find(candidate => candidate.commandId === requestId)!;
    launchedModes.set(shape.profile.label, command.runtimeMode);
    // The thinking level and reported feature values ride the model selection
    // exactly as the profile records them.
    if (shape.profile.thinkingOptionId) {
      const reasoning = command.modelSelection.options.find((option: { id: string; value: unknown }) => option.value === shape.profile.thinkingOptionId);
      assert.ok(reasoning, `${shape.profile.label}: thinking level ${shape.profile.thinkingOptionId} rides modelSelection.options`);
    }
  }
  // The full-access shape the pool runs its grind worker on launches with
  // full-access. On a catalog that reports no modes it would be ineligible
  // instead, which is exactly the refusal this task removes.
  assert.equal(launchedModes.get('Codex grind (full-access)'), 'full-access');
  assert.equal(launchedModes.get('Codex oracle (full-access)'), 'full-access');
  assert.equal(launchedModes.get('Codex worker (full-access)'), 'full-access');
  assert.equal(launchedModes.get('Mode-only (auto)'), 'auto');
  // A mode T3 does not have is ineligible at selection with the mode named,
  // and never reaches createAgent.
  const bypass = profiles[10]!;
  assert.equal(bypass.available, false);
  assert.equal(bypass.problem, 'Configured runtime mode bypassPermissions is not one of this host\'s modes (approval-required, auto-accept-edits, auto, full-access)');
  assert.equal(launchedModes.has('Mode-only (bypassPermissions)'), false);
  // The field shapes the adapter cannot carry yet are ineligible with reasons,
  // not silent launch refusals: Grok's auto_accept toggle is not reported by the
  // nightly's Grok driver, and its reasoning control is spelled `thinking` on Pi.
  assert.match(profiles[6]!.problem, /Configured option auto_accept is not supported/);
  assert.match(profiles[7]!.problem, /Configured thinking level is not supported/);
  assert.match(profiles[8]!.problem, /Configured thinking level is not supported/);
  // The pool's Claude shapes stop at the provider spelling, truthfully: T3 names
  // the instance `claudeAgent`, and Nucleus's provider map is the one place that
  // spelling is mapped. A named reason, not a launch refusal.
  assert.equal(profiles[3]!.available, false);
  assert.match(profiles[3]!.problem, /Provider claude is not available on this host/);
  assert.equal(profiles[4]!.available, false);
  assert.match(profiles[4]!.problem, /Provider claude is not available on this host/);
});

const taskOf = (more: Partial<Task> = {}): Task => submissionSchema.parse({
  submissionId: 't3-runtime-mode', title: 'T3 runtime mode', repoPath: '/repo', planningCommit: 'a'.repeat(40),
  handoffPath: 'handoff.md', originAgentId: 'origin', hostId: 't3code:env', ...more,
}) as Task;

test('worker, reviewer and coordinator selection for a T3-bound task each find an eligible profile', async t => {
  const { catalog } = await fixture(t);
  const profiles = routingProfiles(poolShapes.map((_, index) => stored(index)), catalog, t3ProviderMap);
  const pool = storedPool();
  const dir = mkdtempSync(join(tmpdir(), 't3code-selection-'));
  const store = new Store(join(dir, 'db'));
  const notMine = { profiles: async () => [], observe: async () => { throw Error('not observed'); }, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
  const t3Adapter = { profiles: async () => [], observe: async () => { throw Error('not observed'); }, catalog: async () => catalog } as unknown as Adapter;
  const engine = new Engine(store, notMine, 0);
  engine.hostIds = () => ['t3code:env'];
  engine.resolveHostAdapter = id => id === 't3code:env' ? t3Adapter : notMine;
  try {
    store.setProfiles(poolShapes.map((_, index) => stored(index)));
    store.setMeta('pool', pool);
    await engine.refresh();
    const hostProfiles = engine.profilesFor('t3code:env');
    const counts = store.counts(), recent = store.recentCounts(), offsets = store.demandRoleOffsets();
    // A task with one recorded author, so reviewer independence has evidence.
    const task = { ...taskOf({ complexity: 'medium' }), workerModel: 'other-author', workerModels: ['other-author'] };
    // The worker selection dispatch makes: the T3 catalog's own snapshot.
    const worker = chooseProfile(task, hostProfiles, pool, counts, new Set(), 'worker', recent, 'normal', offsets, true);
    assert.ok(worker, 'a T3-bound task gets a worker');
    // Reviewer and coordinator go through the same resolution the recovery and
    // review paths use, inside the task's host context.
    const reviewer = engine.withHost('t3code:env', () => engine.resolution.select(task, 'reviewer'));
    assert.ok(reviewer, 'a T3-bound task gets a reviewer');
    const coordinator = engine.withHost('t3code:env', () => engine.resolution.select(task, 'coordinator'));
    assert.ok(coordinator, 'a T3-bound task gets a coordinator');
    // Each role moved off the same pool, and each is one the T3 catalog can run.
    for (const [role, profile] of [['worker', worker!.profile], ['reviewer', reviewer!.profile], ['coordinator', coordinator!.profile]] as const) {
      assert.equal(hostProfiles.find(candidate => candidate.id === profile.id)?.available, true, `${role} ${profile.id} is eligible on T3`);
      assert.ok(pool.some(entry => entry.profileId === profile.id && entry.enabled), `${role} ${profile.id} is an enabled pool profile`);
    }
    // The routing policy the board reads names an ineligible profile's reason
    // for this host instead of leaving it to the launch.
    const retained = store.insert(taskOf({ complexity: 'medium' }), 't3code:env', 'handoff', 'a'.repeat(40));
    store.update(retained.id, { phase: 'queued', reason: 'Queued for dispatch', profile: profiles[10]! });
    const policy = store.routingPolicy(store.task(retained.id), Date.now(), hostProfiles);
    const row = policy.profiles.find(candidate => candidate.profileId === 'shape-10')!;
    assert.deepEqual(row.gates, ['unavailable on this host: Configured runtime mode bypassPermissions is not one of this host\'s modes (approval-required, auto-accept-edits, auto, full-access)']);
    assert.match(row.explanation, /unavailable on this host/);
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
