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

const hostProfiles = [
  { id: 'sol', name: 'Sol', provider: 'openai', model: 'gpt-5', modeId: 'agent', thinkingOptionId: 'high', featureValues: { fast: true }, notes: 'primary' },
  { id: 'mini', name: 'Mini', provider: 'openai', model: 'gpt-5-mini', notes: '' },
];
// A faithful no-cwd Paseo read: modes are always reported (the daemon snapshot
// carries them), and feature values are deferred because they need a project
// directory (nucleus#1139 review).
const catalog: HostCatalog = { featuresDeferred: true, providers: [{ key: 'openai', label: 'OpenAI', available: true, problem: '', models: [
  { id: 'gpt-5', label: 'GPT-5', aliases: [], thinkingOptions: [{ id: 'high', label: 'High' }], defaultThinkingOptionId: null, modes: [{ id: 'agent', label: 'Agent' }], features: [] },
  { id: 'gpt-5-mini', label: 'Mini', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] },
] }] };

test('imported profiles preserve the former Paseo list and routing selection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-routing-'));
  const store = new Store(join(dir, 'db'));
  try {
    importHostProfiles(store, { source: 'paseo', hostProfiles, providerMap: {} });
    const engine = new Engine(store, { catalog: async () => catalog } as Adapter);
    await engine.refresh();
    // The former adapter projected the profile config and provider model discovery this way.
    const legacy = hostProfiles.map(p => {
      const model = catalog.providers[0]!.models.find(m => m.id === p.model)!;
      const supportedThinking = model.thinkingOptions.map(o => o.id);
      return { id: p.id, name: p.name, provider: p.provider, model: p.model, modeId: p.modeId,
        thinkingOptionId: p.thinkingOptionId, featureValues: p.featureValues, notes: p.notes ?? '',
        available: true, problem: '', supportedThinking };
    });
    assert.deepEqual(engine.profiles, legacy);
    const pool = hostProfiles.map(p => poolSchema.parse({ profileId: p.id, enabled: true, group: p.id, roles: ['worker'], weight: 1, scopes: ['general'] }));
    const task = submissionSchema.parse({ submissionId: 's', title: 't', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'o' }) as Task;
    assert.deepEqual(chooseProfile(task, engine.profiles, pool, {}, new Set()), chooseProfile(task, legacy, pool, {}, new Set()));
    assert.ok(chooseProfile(task, legacy, pool, {}, new Set()));
  } finally { store.close(); }
});

test('failed initial catalog read waits; missing host model is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-routing-'));
  const store = new Store(join(dir, 'db'));
  try {
    importHostProfiles(store, { source: 'paseo', hostProfiles, providerMap: {} });
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
