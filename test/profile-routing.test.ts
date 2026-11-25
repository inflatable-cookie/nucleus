import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { nucleusProfileSchema } from '../shared/profiles';
import type { Adapter } from '../core/host';
import type { HostCatalog } from '../shared/host';
import { paseoVocabulary } from '../hosts/paseo/vocabulary';

const profiles = [
  { id: 'sol', name: 'Sol', provider: 'claude', model: 'claude-opus-5-5', modeId: 'full-access', thinkingOptionId: 'high', featureValues: { fast: true }, notes: 'primary' },
  { id: 'mini', name: 'Mini', provider: 'codex', model: 'gpt-6-luna', notes: '' },
].map(profile => nucleusProfileSchema.parse(profile));
// A faithful no-cwd Paseo read: modes are always reported (the daemon snapshot
// carries them), and feature values are deferred because they need a project
// directory (nucleus#1139 review).
const catalog: HostCatalog = { featuresDeferred: true, providers: [
  { key: 'claude', label: 'Claude', available: true, problem: '', models: [
    { id: 'claude-opus-5-5', label: 'Opus', aliases: [], thinkingOptions: [{ id: 'high', label: 'High' }], defaultThinkingOptionId: null, modes: [{ id: 'bypassPermissions', label: 'Bypass' }], features: [] }] },
  { key: 'codex', label: 'Codex', available: true, problem: '', models: [
    { id: 'gpt-6-luna', label: 'Luna', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] },
] };

test('failed initial catalog read waits; missing host model is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-routing-'));
  const store = new Store(join(dir, 'db'));
  try {
    store.setProfiles(profiles);
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

test("a task host this engine cannot resolve never borrows another host's profiles (nucleus#1364)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-routing-"));
  const store = new Store(join(dir, "db"));
  try {
    store.setProfiles(profiles);
    const engine = new Engine(store, {
      catalog: async () => catalog,
      vocabulary: paseoVocabulary,
    } as Adapter);
    // The registered host this task names has no adapter in this engine: a host
    // removed from the registry, or one never read. Selection must not fall back
    // to the primary host's profiles, because that is how a T3-hosted task once
    // picked a profile only Paseo's catalog could launch.
    engine.hostIds = () => ["t3code:env"];
    engine.resolveHostAdapter = () => undefined;
    await engine.refresh();
    assert.deepEqual(
      engine.profilesFor("t3code:env"),
      [],
      "no borrowed profile set for a host without its own catalog",
    );
    assert.equal(
      engine.profileCatalogKnownFor("t3code:env"),
      false,
      "dispatch waits for that host's own catalog",
    );
    assert.ok(
      engine.profilesFor(undefined).length > 0,
      "the primary host keeps its own set",
    );
    assert.equal(engine.profileCatalogKnownFor(undefined), true);
  } finally {
    store.close();
  }
});
