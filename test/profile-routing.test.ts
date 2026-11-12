import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { importHostProfiles } from '../core/planning/profile-import';
import { chooseProfile } from '../core/dispatch/routing';
import { poolSchema, submissionSchema, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import type { HostCatalog } from '../shared/host';
import { paseoVocabulary } from '../hosts/paseo/vocabulary';

// Paseo's own profile list, in Paseo's spellings: the import moves them to the
// canonical vocabulary (task 1158), and routing translates them back with
// Paseo's table, so a launch sends exactly what the former list did.
const hostProfiles = [
  { id: 'sol', name: 'Sol', provider: 'claude', model: 'claude-opus-5-5', modeId: 'bypassPermissions', thinkingOptionId: 'high', featureValues: { fast: true }, notes: 'primary' },
  { id: 'mini', name: 'Mini', provider: 'codex', model: 'gpt-6-luna', notes: '' },
];
// A faithful no-cwd Paseo read: modes are always reported (the daemon snapshot
// carries them), and feature values are deferred because they need a project
// directory (nucleus#1139 review).
const catalog: HostCatalog = { featuresDeferred: true, providers: [
  { key: 'claude', label: 'Claude', available: true, problem: '', models: [
    { id: 'claude-opus-5-5', label: 'Opus', aliases: [], thinkingOptions: [{ id: 'high', label: 'High' }], defaultThinkingOptionId: null, modes: [{ id: 'bypassPermissions', label: 'Bypass' }], features: [] }] },
  { key: 'codex', label: 'Codex', available: true, problem: '', models: [
    { id: 'gpt-6-luna', label: 'Luna', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] },
] };

test('imported profiles preserve the former Paseo list and routing selection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-routing-'));
  const store = new Store(join(dir, 'db'));
  try {
    importHostProfiles(store, { source: 'paseo', hostProfiles });
    assert.equal(store.profiles()[0]!.modeId, 'full-access', 'the stored profile is canonical');
    const engine = new Engine(store, { catalog: async () => catalog, vocabulary: paseoVocabulary } as Adapter);
    await engine.refresh();
    // The former adapter projected the profile config and provider model discovery this way.
    const legacy = hostProfiles.map(p => {
      const model = catalog.providers.flatMap(provider => provider.models).find(m => m.id === p.model)!;
      const supportedThinking = model.thinkingOptions.map(o => o.id);
      return { id: p.id, name: p.name, provider: p.provider, model: p.model, modeId: p.modeId,
        thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues, notes: p.notes ?? '',
        available: true, problem: '', supportedThinking };
    });
    const defined = (value: object) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
    const routed = legacy.map(p => ({ ...defined(p), ...(p.modeId ? { translated: ['mode'] } : {}) }) as typeof p);
    assert.deepEqual(engine.profiles, routed);
    const pool = hostProfiles.map(p => poolSchema.parse({ profileId: p.id, enabled: true, group: p.id, roles: ['worker'], weight: 1, scopes: ['general'] }));
    const task = submissionSchema.parse({ submissionId: 's', title: 't', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'o' }) as Task;
    assert.deepEqual(chooseProfile(task, engine.profiles, pool, {}, new Set()), chooseProfile(task, routed, pool, {}, new Set()));
    assert.ok(chooseProfile(task, legacy, pool, {}, new Set()));
  } finally { store.close(); }
});

test('failed initial catalog read waits; missing host model is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-routing-'));
  const store = new Store(join(dir, 'db'));
  try {
    importHostProfiles(store, { source: 'paseo', hostProfiles });
    let fail = true;
    const engine = new Engine(store, { catalog: async () => { if (fail) throw Error('catalog offline'); return { providers: [] }; } } as unknown as Adapter);
    await assert.rejects(engine.refresh(), /catalog offline/);
    assert.equal(engine.profileCatalogKnown(), false);
    fail = false;
    await engine.refresh();
    assert.equal(engine.profileCatalogKnown(), true);
    assert.equal(engine.profiles[0]!.available, false);
    assert.match(engine.profiles[0]!.problem, /not available/);
  } finally { store.close(); }
});
