import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { T3CodeHost } from '../hosts/t3code/adapter';
import { t3codeVocabulary } from '../hosts/t3code/vocabulary';
import { paseoVocabulary } from '../hosts/paseo/vocabulary';
import { canonicalCatalog, mergeCanonicalCatalogs } from '../shared/profile-vocabulary';
import type { HostCatalog } from '../shared/host';
import { t3Fake } from './support/t3code-fake';
import { nightlyProviders, paseoCatalog } from './support/pool-shapes';

/**
 * nucleus#1365: the profile editor shows one Thinking and one Mode control in
 * canonical values, and no host's thinking carrier (T3's Pi `thinking`, its
 * `reasoningEffort` select) appears again as a feature field.
 */
useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, { get: () => '#123' }) as never;

async function t3Catalog(t: TestContext): Promise<HostCatalog> {
  const root = mkdtempSync(join(tmpdir(), 'profile-thinking-ui-'));
  const server = await t3Fake(t, await realpath(root));
  server.controls.providers = nightlyProviders();
  const host = new T3CodeHost({ endpoint: server.endpoint, bearer: 'synthetic-bearer', statePath: join(root, 'state.json'), timeoutMs: 1_000, probeThreadId: 'synthetic-probe' });
  t.after(() => { host.close(); rmSync(root, { recursive: true, force: true }); });
  await host.connect();
  return host.catalog();
}

async function editor(catalog: HostCatalog, initial: Record<string, unknown>) {
  const { ProfileEditor } = await import('../client/settings-profile-editor');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invoke = async () => ({});
  return mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never, children: h(ProfileEditor as never, {
    c: colors, catalog, catalogs: [], directory: null, projects: [], repositories: [], initial: { notes: '', ...initial }, entry: null, state: null,
    busy: false, poolSaveStatus: '', onChooseDirectory: () => {},
  }) }) }));
}

/** Every control the editor labels with a field name, by that name. */
const controls = (ui: Awaited<ReturnType<typeof editor>>, name: string) => ui.all(new RegExp(`^${name}, `));

test('a model whose host carries thinking as a feature shows exactly one Thinking and one Mode control and no thinking or reasoning field', async t => {
  const merged = mergeCanonicalCatalogs([canonicalCatalog(paseoVocabulary, paseoCatalog()), canonicalCatalog(t3codeVocabulary, await t3Catalog(t))]);
  // Muse 1.3 grind after migration: T3 carries Pi's level as its `thinking` option.
  const ui = await editor(merged, { id: 'synthetic-muse', name: 'Muse 1.3 grind', provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', thinkingOptionId: 'medium' });
  assert.equal(controls(ui, 'Thinking').length, 1, 'one Thinking control');
  assert.equal(controls(ui, 'Mode').length, 1, 'one Mode control');
  assert.equal(ui.get(/^Thinking, /).props.accessibilityLabel, 'Thinking, Medium');
  assert.doesNotMatch(ui.text(), /Reasoning|Effort/, 'no carrier shows as a feature');
  // T3's codex reasoning select is the Thinking control, never a feature beside it.
  const codex = await editor(merged, { id: 'synthetic-luna', name: 'Codex grind', provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' });
  assert.equal(controls(codex, 'Thinking').length, 1);
  assert.equal(controls(codex, 'Mode').length, 1);
  assert.equal(codex.all(/^Reasoning, /).length, 0);
  assert.equal(codex.all(/^Service Tier, /).length, 1, 'other provider features still show');
});

test('a model with no modes still shows its one Mode control, as Host default', async () => {
  const ui = await editor(canonicalCatalog(paseoVocabulary, paseoCatalog()), { id: 'synthetic-pi', name: 'Pi', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high' });
  assert.equal(controls(ui, 'Mode').length, 1);
  assert.equal(ui.get('Mode, Host default').type, 'Text');
  assert.equal(controls(ui, 'Thinking').length, 1);
});
