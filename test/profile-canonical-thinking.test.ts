import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { t3codeVocabulary } from '../hosts/t3code/vocabulary';
import { paseoVocabulary } from '../hosts/paseo/vocabulary';
import { bbVocabulary } from '../hosts/bb/vocabulary';
import { HOST_VOCABULARIES } from '../hosts/vocabularies';
import { Store } from '../core/store/store';
import { migrateProfileThinking } from '../core/store/profile-vocabulary-migration';
import { nucleusProfileSchema, profileCompatibility } from '../shared/profiles';
import { canonicalCatalog, launchThinkingLevel, translateProfile } from '../shared/profile-vocabulary';
import { t3Fake } from './support/t3code-fake';
import { nightlyProviders, paseoCatalog } from './support/pool-shapes';

/**
 * nucleus#1365 (Tom, 2026-11-19: "There should only ever be one field for this
 * setting in the profile settings UI"): a profile stores its thinking level once,
 * canonically, and each host adapter translates it to its own carrier.
 */

const vocabularies = Object.values(HOST_VOCABULARIES);

/**
 * The live store's shapes with synthesised ids: the T3 pilot's "Muse 1.3 grind"
 * (nucleus#1364) held its level only as Pi's `thinking` option; the Paseo codex
 * and claude profiles are canonical already. The rest are the other host
 * spellings a profile written through a host could carry.
 */
const live = [
  { id: 'synthetic-muse', name: 'Muse 1.3 grind', provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', featureValues: { thinking: 'medium' }, notes: '' },
  { id: 'synthetic-luna', name: 'Codex grind', provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh', notes: '' },
  { id: 'synthetic-opus', name: 'Claude opus', provider: 'claude', model: 'claude-opus-5-5', modeId: 'full-access', thinkingOptionId: 'medium', notes: '' },
  { id: 'synthetic-sol', name: 'Codex reasoning', provider: 'codex', model: 'gpt-6.1-sol', featureValues: { reasoningEffort: 'high', serviceTier: 'priority' }, notes: '' },
  { id: 'synthetic-haiku', name: 'Claude effort', provider: 'claude', model: 'claude-haiku-5-5', featureValues: { effort: 'ultrathink' }, notes: '' },
  { id: 'synthetic-ultra', name: 'Claude ultrathink', provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'ultrathink', notes: '' },
  { id: 'synthetic-bb', name: 'BB off', provider: 'codex', model: 'gpt-6-luna', thinkingOptionId: 'none', notes: '' },
  { id: 'synthetic-old', name: 'Older reasoning', provider: 'grok', model: 'grok-4.6', featureValues: { reasoning: 'low' }, notes: '' },
  { id: 'synthetic-same', name: 'Both agree', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high', featureValues: { thinking: 'high' }, notes: '' },
  { id: 'synthetic-odd', name: 'No match', provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'ultracode', notes: '' },
  { id: 'synthetic-clash', name: 'Disagree', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'low', featureValues: { thinking: 'max' }, notes: '' },
];

test('the migration moves every host carrier and host spelling to one canonical level, keeps meaning, and a second run changes nothing', () => {
  const { profiles, record } = migrateProfileThinking(live, vocabularies, '2026-11-19T00:00:00.000Z');
  const byId = Object.fromEntries((profiles as Array<{ id: string }>).map(profile => [profile.id, profile]));
  const thinking = (id: string) => [(byId[id] as { thinkingOptionId?: string }).thinkingOptionId, (byId[id] as { featureValues?: unknown }).featureValues];
  assert.deepEqual(thinking('synthetic-muse'), ['medium', undefined], 'Muse 1.3 grind: Pi\'s thinking option becomes the level');
  assert.deepEqual(byId['synthetic-luna'], live[1], 'a canonical Paseo codex profile is untouched');
  assert.deepEqual(byId['synthetic-opus'], live[2], 'a canonical Paseo claude profile is untouched');
  assert.deepEqual(thinking('synthetic-sol'), ['high', { serviceTier: 'priority' }], 'T3\'s reasoning select goes; other options stay');
  assert.deepEqual(thinking('synthetic-haiku'), ['ultra', undefined], 'T3\'s claude effort ultrathink reads back as ultra');
  assert.deepEqual(thinking('synthetic-ultra'), ['ultra', undefined]);
  assert.deepEqual(thinking('synthetic-bb'), ['off', undefined], 'BB\'s none is off');
  assert.deepEqual(thinking('synthetic-old'), ['low', undefined], 'an older driver\'s reasoning select moves too');
  assert.deepEqual(thinking('synthetic-same'), ['high', undefined], 'a carrier that agrees with the level is dropped');
  // No canonical match, or two readings: left exactly as stored and reported.
  assert.equal(byId['synthetic-odd'], live[9]);
  assert.equal(byId['synthetic-clash'], live[10]);
  assert.deepEqual(record.unknown, [
    { profileId: 'synthetic-odd', field: 'thinkingOptionId', value: 'ultracode' },
    { profileId: 'synthetic-clash', field: 'thinkingOptionId', value: { stored: 'low', carried: { thinking: 'max' } } },
  ]);
  assert.deepEqual(record.changes.find(change => change.profileId === 'synthetic-muse'), { profileId: 'synthetic-muse', field: 'thinkingOptionId', from: undefined, to: 'medium' });
  // Every migrated profile parses as a stored profile with one thinking value.
  for (const profile of profiles) nucleusProfileSchema.parse(profile);
  const again = migrateProfileThinking(profiles, vocabularies);
  assert.deepEqual(again.record.changes, [], 'idempotent');
  assert.deepEqual(again.profiles, profiles);
});

test('the store runs the thinking migration on open, records its first run, and a second open changes nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-thinking-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db');
  const first = new Store(path);
  first.setMeta('profiles', [live[0], live[1]]);
  first.close();
  const second = new Store(path);
  try {
    second.migrateProfileThinking(vocabularies);
    const muse = second.profiles().find(profile => profile.id === 'synthetic-muse')!;
    assert.deepEqual([muse.thinkingOptionId, muse.featureValues], ['medium', undefined]);
    const record = second.getMeta<{ at: string; changes: unknown[] }>('profileThinkingMigration')!;
    assert.equal(record.changes.length, 2);
    const stored = JSON.stringify(second.getMeta('profiles'));
    second.migrateProfileThinking(vocabularies);
    assert.equal(JSON.stringify(second.getMeta('profiles')), stored);
    assert.equal(second.getMeta<{ at: string }>('profileThinkingMigration')!.at, record.at, 'a run with no change keeps the record');
    // A row a rolled-back build writes during its window moves on the next open.
    second.setMeta('profiles', [...second.getMeta<unknown[]>('profiles')!, live[3]]);
    second.migrateProfileThinking(vocabularies);
    assert.equal(second.profiles().find(profile => profile.id === 'synthetic-sol')!.thinkingOptionId, 'high');
  } finally { second.close(); }
});

async function t3Catalog(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'profile-thinking-t3-'));
  const server = await t3Fake(t, await realpath(root));
  server.controls.providers = nightlyProviders();
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  return host.catalog();
}

test('launch translation gives each host its own spelling, a level a model can\'t express is a per-host note, and a host spelling reads back canonical', async t => {
  const t3 = await t3Catalog(t);
  const muse = nucleusProfileSchema.parse(migrateProfileThinking([live[0]], vocabularies).profiles[0]);
  // Paseo carries the level as its thinking option; T3 as Pi's `thinking` option.
  assert.deepEqual(translateProfile(paseoVocabulary, muse), { ok: true, launch: { provider: 'pi', model: muse.model, thinkingOptionId: 'medium' }, translated: [] });
  assert.deepEqual(translateProfile(t3codeVocabulary, muse), { ok: true, launch: { provider: 'pi', model: muse.model, featureValues: { thinking: 'medium' } }, translated: ['thinking'] });
  const ultra = nucleusProfileSchema.parse({ id: 'u', name: 'U', provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'ultra' });
  const onT3 = profileCompatibility(ultra, t3, t3codeVocabulary);
  assert.deepEqual([onT3.status, onT3.launch], ['works', { provider: 'claudeAgent', model: 'claude-opus-5-5', featureValues: { effort: 'ultrathink' } }]);
  // Paseo's claude table has no ultra: a note naming the host, not another field.
  assert.equal(profileCompatibility(ultra, paseoCatalog(), paseoVocabulary).reason, "Paseo can't express thinking level ultra for claude");
  // Muse 1.3 offers minimal..xhigh on T3: max is a per-host note on the level.
  const museMax = nucleusProfileSchema.parse({ ...muse, thinkingOptionId: 'max' });
  assert.equal(profileCompatibility(museMax, t3, t3codeVocabulary).reason, "T3Code's opencode-go/muse-spark-1.3-contributor has no thinking level max");
  // A host's own spelling in a launch reads back as the canonical level.
  assert.equal(launchThinkingLevel(t3codeVocabulary, onT3.launch), 'ultra');
  assert.equal(launchThinkingLevel(t3codeVocabulary, { provider: 'pi', featureValues: { thinking: 'medium' } }), 'medium');
  assert.equal(launchThinkingLevel(bbVocabulary, { provider: 'codex', thinkingOptionId: 'none' }), 'off');
  assert.equal(launchThinkingLevel(paseoVocabulary, { provider: 'codex', thinkingOptionId: 'xhigh' }), 'xhigh');
  assert.equal(launchThinkingLevel(paseoVocabulary, { provider: 'codex' }), null);
});

test('a host\'s thinking select is never a feature: T3\'s reasoning select, older or current, reads as the levels and a profile cannot set it', async t => {
  const providers = nightlyProviders();
  // An older driver names its select `reasoning` with no role marker.
  providers[0]!.models.push({ slug: 'gpt-older', name: 'Older', capabilities: { optionDescriptors: [
    { id: 'reasoning', label: 'Reasoning', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high'].map(id => ({ id, label: id })) },
    { id: 'serviceTier', label: 'Service Tier', type: 'select', currentValue: 'default', options: [{ id: 'default', label: 'Default', isDefault: true }] },
  ] } });
  const root = mkdtempSync(join(tmpdir(), 'profile-thinking-t3-older-'));
  const server = await t3Fake(t, await realpath(root));
  server.controls.providers = providers;
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  const codex = canonicalCatalog(t3codeVocabulary, await host.catalog()).providers.find(provider => provider.key === 'codex')!;
  const older = codex.models.find(model => model.id === 'gpt-older')!;
  assert.deepEqual(older.thinkingOptions.map(option => option.id), ['low', 'medium', 'high']);
  assert.deepEqual(older.features.map(feature => feature.id), ['serviceTier']);
  for (const model of codex.models) assert.equal(model.features.some(feature => feature.id === 'reasoningEffort' || feature.id === 'reasoning'), false, model.id);
  const set = nucleusProfileSchema.parse({ id: 's', name: 'S', provider: 'codex', model: 'gpt-older', featureValues: { reasoning: 'high' } });
  assert.deepEqual(translateProfile(t3codeVocabulary, set).ok, false);
});
