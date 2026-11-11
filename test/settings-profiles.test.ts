import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs } from './support/render';
import { providerMapSuggestions, type NucleusProfile, type ProviderMap } from '../shared/profiles';
import type { HostCatalog, StoredHostCatalog } from '../shared/host';

/**
 * Spec 052, step 2 of the Paseo split: Settings' Profiles section creates and
 * edits Nucleus's own profiles from what the host reports, shows each one's
 * availability on this host with its plain reason, and edits the provider map.
 * Routing uses the stored profiles.
 */

useNativeStubs();

type SettingsModule = typeof import('../client/settings-screen');
let settings: SettingsModule;
const load = async () => {
  settings = await import('../client/settings-screen');
  return settings;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail('the profiles panel did not settle');
}

/** The host's report as Nucleus stored it: two available providers with models, modes, thinking and features. */
const catalog: StoredHostCatalog = {
  readAt: '2026-11-09T09:00:00.000Z',
  providers: [
    {
      key: 'openai', label: 'OpenAI', available: true, problem: '',
      models: [
        {
          id: 'gpt-5', label: 'GPT-5', aliases: ['gpt-5-latest'],
          thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true }],
          defaultThinkingOptionId: 'high',
          modes: [{ id: 'agent', label: 'Agent', description: 'Full agent work' }, { id: 'plan', label: 'Plan' }],
          features: [
            { type: 'toggle', id: 'web', label: 'Web search', value: false },
            { type: 'select', id: 'permissions', label: 'Permissions', value: 'ask', options: [{ id: 'ask', label: 'Ask' }, { id: 'allow', label: 'Allow', isDefault: true }] },
          ],
        },
        { id: 'gpt-5-mini', label: 'GPT-5 mini', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [{ id: 'agent', label: 'Agent' }], features: [] },
      ],
    },
    {
      key: 'openai-codex', label: 'Codex', available: true, problem: '',
      models: [{ id: 'codex-1', label: 'Codex 1', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }],
    },
    {
      key: 'cursor', label: 'Cursor', available: false, problem: 'Sign in required to use Cursor.',
      models: [{ id: 'cursor-1', label: 'Cursor 1', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }],
    },
  ],
};

function choose(ui: ReturnType<typeof mount>, label: string, option: string, current: string) {
  ui.press(`${label}, ${current}`);
  ui.press(`${label}: ${option}`);
}

/** A profile imported from a host that had Anthropic: unavailable here, with the reason. */
const imported = (): NucleusProfile => ({ id: 'imported', name: 'Imported Sol', provider: 'anthropic', model: 'opus', notes: 'Kept from Paseo', featureValues: undefined }) as NucleusProfile;

const board = () => ({
  revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 5, papercutProjectLimit: 2,
  tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
  lanes: [], projects: [], projectLimitOverrides: {}, projectInFlightLimitOverrides: {}, projectCapacities: [], prStates: {},
});

interface Fixture {
  profiles: NucleusProfile[];
  providerMap: ProviderMap;
  creates: unknown[];
  updates: unknown[];
  removes: unknown[];
  mapWrites: ProviderMap[];
  catalogReads: { cwd?: string; refresh?: boolean }[];
  /** Answers `host.catalog` instead of the fixed catalog when set. */
  catalogAnswer?: (input: { cwd?: string; refresh?: boolean }) => Promise<unknown>;
}

function screenTree(fixture: Fixture, compact = false) {
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return board();
    if (method === 'backup.list') return { snapshots: [], localError: null };
    if (method === 'repositories') return [{ repository: { origin: 'acme/app', path: '/app' }, closeout: null, validation: null, reviewer: null, qa: null, note: '', updatedAt: '2026-11-07T00:00:00.000Z', revision: 1 }];
    if (method === 'profile.list') return { profiles: fixture.profiles };
    if (method === 'profile.providers') return { providers: fixture.providerMap };
    if (method === 'profile.providers.set') {
      fixture.providerMap = (input as { providers: ProviderMap }).providers;
      fixture.mapWrites.push(fixture.providerMap);
      return { providers: fixture.providerMap };
    }
    if (method === 'host.catalog') {
      fixture.catalogReads.push(input as { cwd?: string });
      return fixture.catalogAnswer ? fixture.catalogAnswer(input as { cwd?: string; refresh?: boolean }) : catalog;
    }
    if (method === 'profile.create') {
      fixture.creates.push(input);
      const profile = { ...(input as NucleusProfile), id: 'created-1', model: (input as NucleusProfile).model ?? '', notes: (input as NucleusProfile).notes ?? '' };
      fixture.profiles = [...fixture.profiles, profile];
      return { profile };
    }
    if (method === 'profile.update') {
      fixture.updates.push(input);
      const patch = input as Partial<NucleusProfile> & { id: string };
      const current = fixture.profiles.find(profile => profile.id === patch.id)!;
      const merged = { ...current } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) { if (key === 'id') continue; if (value === null) delete merged[key]; else if (value !== undefined) merged[key] = value; }
      fixture.profiles = fixture.profiles.map(profile => profile.id === patch.id ? merged as unknown as NucleusProfile : profile);
      return { profile: merged };
    }
    if (method === 'profile.remove') {
      fixture.removes.push(input);
      fixture.profiles = fixture.profiles.filter(profile => profile.id !== (input as { id: string }).id);
      return { removed: true };
    }
    return {};
  };
  return h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke,
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const },
      }),
    }),
  });
}

const fixture = (): Fixture => ({ profiles: [imported()], providerMap: {}, creates: [], updates: [], removes: [], mapWrites: [], catalogReads: [] });

test('Settings Profiles creates a profile from the host catalog and shows the unavailable one with its reason', async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol'));
    assert.doesNotMatch(ui.text(), /Routing still reads Paseo|Available on this host|Profile notes|Changes save automatically|Feature values come from one project directory/);
    await settle(() => state.catalogReads.some(read => read.cwd === '/app'));
    assert.equal(ui.get('Imported Sol: Unavailable').props.accessibilityHint, 'Unavailable');
    assert.equal(ui.query('Availability for Imported Sol'), undefined);
    assert.equal(ui.query('Remove Imported Sol'), undefined, 'Remove stays off the list row');

    ui.press('Edit Imported Sol');
    await settle(() => Boolean(ui.query('Profile availability preview')));
    assert.equal(ui.get('Profile availability preview').children.join(''), 'Provider anthropic is not available on this host');
    ui.press('Close Imported Sol');

    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Close new profile')));
    assert.equal(ui.query('Create profile'), undefined);
    assert.equal(ui.query('Save'), undefined);
    ui.type('Name', 'Fast worker');
    choose(ui, 'Provider', 'OpenAI', 'Choose a provider');
    choose(ui, 'Model', 'GPT-5', 'Choose a model');
    await settle(() => state.creates.length === 1);
    assert.deepEqual(state.creates[0], {
      name: 'Fast worker', provider: 'openai', model: 'gpt-5',
      thinkingOptionId: 'high', featureValues: { web: false, permissions: 'ask' },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(state.creates[0] as object, 'notes'), false, 'notes stay stored and unsent');
    await settle(() => ui.text().includes('Fast worker') && Boolean(ui.query('Edit Fast worker') || ui.query('Close Fast worker')));
    assert.doesNotMatch(ui.text(), /Available on this host|Mode: Plan|Web search: on/);

    choose(ui, 'Mode', 'Plan', 'Host default');
    choose(ui, 'Thinking', 'Low', 'High');
    ui.press('Feature Web search on');
    choose(ui, 'Permissions', 'Allow', 'Ask');
    await settle(() => state.updates.some(entry => (entry as { modeId?: string }).modeId === 'plan' && (entry as { thinkingOptionId?: string }).thinkingOptionId === 'low'));
    const latest = state.updates.at(-1) as Record<string, unknown>;
    assert.equal(latest.id, 'created-1');
    assert.equal(latest.modeId, 'plan');
    assert.equal(latest.thinkingOptionId, 'low');
    assert.deepEqual(latest.featureValues, { web: true, permissions: 'allow' });
    assert.equal(Object.prototype.hasOwnProperty.call(latest, 'notes'), false);

    assert.equal(ui.query('Provider map'), undefined, 'one host and an empty map show no provider map');
    assert.doesNotMatch(ui.text(), /Provider map|Every host key maps to itself|Host provider key/);

    ui.press('Edit Imported Sol');
    await settle(() => Boolean(ui.query('Remove Imported Sol')));
    ui.press('Remove Imported Sol');
    await settle(() => Boolean(ui.query('Confirm removing Imported Sol')));
    ui.press('Confirm removing Imported Sol');
    await settle(() => state.removes.length === 1);
    assert.deepEqual(state.removes[0], { id: 'imported' });
    await settle(() => !ui.text().includes('Imported Sol'));
    assert.match(ui.text(), /Fast worker/, 'the other profile is untouched');
  } finally { ui.update(h('View', null)); }
});

test('Settings Profiles keeps a draft on a refused save and names the reason', async () => {
  await load();
  const state = fixture();
  let fail = true;
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string, input: unknown) => {
        if (method === 'profile.create' && fail) throw new Error('the profile store is unavailable');
        if (method === 'profile.create') { state.creates.push(input); return { profile: { ...(input as NucleusProfile), id: 'created-1', notes: '' } }; }
        if (method === 'profile.update') return { profile: Object.fromEntries([...Object.entries(input as object), ['notes', '']].filter(([, value]) => value !== null)) };
        if (method === 'queue.ui-snapshot') return board();
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'repositories') return [{ repository: { origin: 'acme/app', path: '/app' }, closeout: null, validation: null, reviewer: null, qa: null, note: '', updatedAt: '2026-11-07T00:00:00.000Z', revision: 1 }];
        if (method === 'profile.list') return { profiles: state.profiles };
        if (method === 'profile.providers') return { providers: state.providerMap };
        if (method === 'host.catalog') return catalog;
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol') && Boolean(ui.query('Add profile')));
    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Close new profile')) && Boolean(ui.query('Provider, Choose a provider')));
    ui.type('Name', 'Doomed');
    ui.press('Provider, Choose a provider');
    await settle(() => Boolean(ui.query('Provider: OpenAI')));
    ui.press('Provider: OpenAI');
    await settle(() => Boolean(ui.query('Model, Choose a model')));
    choose(ui, 'Model', 'GPT-5', 'Choose a model');
    await settle(() => /Not saved: the profile store is unavailable/.test(ui.text()));
    assert.equal(ui.get('Name').props.value, 'Doomed', 'the draft survives the refusal');
    assert.equal(state.creates.length, 0);
    // A failure needs room: it takes its own line under the Name row, not a squeeze beside the field.
    const failure = ui.get('Profile save status') as Node;
    assert.match(failure.children.join(''), /^Not saved: the profile store is unavailable/);
    assert.equal(labelsIn(ui.get('Profile name row') as Node).includes('Profile save status'), false, 'the failure is off the Name row');
    assert.equal(labelsIn(ui.get('New profile editor') as Node).includes('Profile save status'), true, 'the failure stays inside the editor');
    assert.equal(failure.props.accessibilityLiveRegion, 'polite');
    fail = false;
    choose(ui, 'Model', 'GPT-5 mini', 'GPT-5');
    await settle(() => state.creates.length === 1);
    // The created profile opens in its own editor; a rename there saves after its pause and reads Saved.
    await settle(() => Boolean(ui.query('Doomed editor')));
    ui.type('Name', 'Doomed again');
    for (const deadline = Date.now() + 3_000; Date.now() < deadline && ui.query('Profile save status')?.children.join('') !== 'Saved';) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ui.get('Profile save status').children.join(''), 'Saved');
    assert.equal(labelsIn(ui.get('Profile name row') as Node).includes('Profile save status'), true, 'a brief Saved sits inline on the Name row');
    assert.equal((state.creates[0] as { name: string }).name, 'Doomed');
    assert.equal((state.creates[0] as { model: string }).model, 'gpt-5-mini');
  } finally { ui.update(h('View', null)); }
});

test('the add flow uses dropdowns, Host default plain text, and a short unavailable-provider reason', async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol') && Boolean(ui.query('Add profile')));
    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Provider, Choose a provider')));
    ui.press('Provider, Choose a provider');
    await settle(() => Boolean(ui.query('Provider: Cursor · needs sign-in')));
    assert.ok(ui.get('Provider: Cursor · needs sign-in'), 'an unauthenticated provider is labelled with a short reason');
    assert.doesNotMatch(ui.text(), /Sign in required to use Cursor/);
    ui.press('Provider: Cursor · needs sign-in');
    await settle(() => Boolean(ui.query('Model, Choose a model')));
    choose(ui, 'Model', 'Cursor 1', 'Choose a model');
    assert.equal(ui.query('Mode, Host default'), undefined, 'an empty mode list is not a dropdown');
    assert.equal(ui.query('Thinking, Host default'), undefined, 'an empty thinking list is not a dropdown');
    const hostDefault = ui.ofType('Text').filter(node => node.children.join('') === 'Host default');
    assert.equal(hostDefault.length, 1, 'only Thinking remains when Mode has no host choice');
    assert.equal(ui.query('Notes'), undefined);
    assert.doesNotMatch(ui.text(), /\/app|Feature values come from one project directory|Available on this host|Changes save automatically/);
  } finally { ui.update(h('View', null)); }
});

test('Profiles shows loading, an empty list, a catalog error, and long names without truncation', async () => {
  await load();
  let resolveList: ((value: { profiles: NucleusProfile[] }) => void) | undefined;
  const pending = new Promise<{ profiles: NucleusProfile[] }>(resolve => { resolveList = resolve; });
  const loading = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string) => {
        if (method === 'queue.ui-snapshot') return board();
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'profile.list') return pending;
        if (method === 'profile.providers') return { providers: {} };
        if (method === 'host.catalog') return catalog;
        if (method === 'repositories') return [];
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => loading.text().includes('Profiles'));
    loading.press('Profiles');
    await settle(() => loading.text().includes('Reading profiles…'));
    assert.equal(loading.get('Stored profiles').props.style.borderBottomWidth, 1, 'a loading line keeps the section divider');
    resolveList!({ profiles: [] });
    await settle(() => loading.text().includes('No profiles yet. Add one from what this host can run.'));
    assert.equal(loading.get('Stored profiles').props.style.borderBottomWidth, 1, 'an empty line keeps the section divider');
  } finally { loading.update(h('View', null)); }

  const failed = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string) => {
        if (method === 'queue.ui-snapshot') return board();
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'profile.list') throw new Error('profile store offline');
        if (method === 'host.catalog') throw new Error('catalog offline');
        if (method === 'profile.providers') return { providers: {} };
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => failed.text().includes('Profiles'));
    failed.press('Profiles');
    await settle(() => failed.text().includes('Could not read profiles: profile store offline'));
    assert.match(failed.text(), /The host catalog could not be read: catalog offline/);
    assert.equal(failed.get('Stored profiles').props.style.borderBottomWidth, 1, 'an unreadable list with no rows keeps the section divider');
  } finally { failed.update(h('View', null)); }

  const longName = 'A very long profile name that would otherwise truncate across a narrow settings column';
  const long = fixture();
  long.profiles = [{ id: 'long', name: longName, provider: 'openai', model: 'gpt-5', notes: 'secret', featureValues: undefined } as NucleusProfile];
  const ui = mount(screenTree(long));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes(longName));
    const name = ui.ofType('Text').find(node => node.children.join('') === longName)!;
    assert.equal(name.props.numberOfLines, undefined, 'a long name is not ellipsised');
    assert.ok(ui.get(`Edit ${longName}`));
    assert.ok(ui.get('Add profile'));
    assert.doesNotMatch(ui.text(), /secret|Profile notes/);
    ui.press(`Edit ${longName}`);
    await settle(() => Boolean(ui.query('Name')));
    assert.equal(ui.query('Notes'), undefined);
    assert.ok(ui.get('Provider, OpenAI'));
    assert.ok(ui.get('Model, GPT-5'));
  } finally { ui.update(h('View', null)); }
});

test('nucleus#998: Profiles and Subscriptions are separated by a gap, not a second divider, wide and narrow', async () => {
  await load();
  const longName = 'A very long profile name that keeps going so the last row wraps on a narrow settings column';
  for (const compact of [false, true]) {
    const state = fixture();
    state.profiles = [imported(), { id: 'long', name: longName, provider: 'openai', model: 'gpt-5', featureValues: undefined } as NucleusProfile];
    const ui = mount(screenTree(state, compact));
    try {
      await settle(() => ui.text().includes('Profiles'));
      ui.press('Profiles');
      await settle(() => ui.text().includes(longName));
      const section = ui.get('Stored profiles').props.style;
      assert.equal(section.borderBottomWidth, 0, `${compact ? 'narrow' : 'wide'}: the last row's divider is the only line`);
      assert.equal(section.paddingBottom, 24, 'a wider gap before Subscriptions');
      assert.ok(ui.get('Subscriptions'));
    } finally { ui.update(h('View', null)); }
  }
});

test('nucleus#998: Subscriptions ending in group rows drop the line above the provider map', async () => {
  await load();
  const state = fixture();
  state.providerMap = { 'openai-codex': 'openai' };
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string, input: unknown) => {
        if (method === 'queue.ui-snapshot') return { ...board(), pool: [{ profileId: 'imported', group: 'anthropic', weight: 3, enabled: true, scopes: ['general'], roles: ['worker'] }] };
        return (screenTree(state).props as { children: { props: { invoke: (m: string, i: unknown) => Promise<unknown> } } }).children.props.invoke(method, input);
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => Boolean(ui.query('Provider map')) && ui.text().includes('anthropic'));
    assert.equal(ui.get('Subscriptions').props.style.borderBottomWidth, 0);
    assert.equal(ui.get('Subscriptions').props.style.paddingBottom, 24);
    assert.equal(ui.get('Provider map').props.style.borderBottomWidth, 0, 'the last section has no divider');
  } finally { ui.update(h('View', null)); }
});

test('when registered projects disagree on feature values, Profiles names the projects and hides the path picker', async () => {
  await load();
  const state = fixture();
  const other: StoredHostCatalog = {
    readAt: '2026-11-09T09:00:00.000Z',
    providers: [{
      key: 'openai', label: 'OpenAI', available: true, problem: '',
      models: [{
        id: 'gpt-5', label: 'GPT-5', aliases: [],
        thinkingOptions: [{ id: 'low', label: 'Low' }],
        defaultThinkingOptionId: 'low',
        modes: [],
        features: [{ type: 'toggle', id: 'web', label: 'Web search', value: true }],
      }],
    }],
  };
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string, input: unknown) => {
        if (method === 'queue.ui-snapshot') return {
          ...board(),
          projects: [
            { key: 'app', name: 'App', version: 1, visibility: 'active', repositories: [{ origin: 'acme/app', path: '/app' }], primary: { origin: 'acme/app', path: '/app' } },
            { key: 'other', name: 'Other', version: 1, visibility: 'active', repositories: [{ origin: 'acme/other', path: '/other' }], primary: { origin: 'acme/other', path: '/other' } },
          ],
        };
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'repositories') return [
          { repository: { origin: 'acme/app', path: '/app' }, closeout: null, validation: null, reviewer: null, qa: null, note: '', updatedAt: '2026-11-07T00:00:00.000Z', revision: 1 },
          { repository: { origin: 'acme/other', path: '/other' }, closeout: null, validation: null, reviewer: null, qa: null, note: '', updatedAt: '2026-11-07T00:00:00.000Z', revision: 1 },
        ];
        if (method === 'profile.list') return { profiles: state.profiles };
        if (method === 'profile.providers') return { providers: {} };
        if (method === 'host.catalog') {
          const cwd = (input as { cwd?: string }).cwd;
          return cwd === '/other' ? other : catalog;
        }
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol'));
    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Provider, Choose a provider')));
    choose(ui, 'Provider', 'OpenAI', 'Choose a provider');
    choose(ui, 'Model', 'GPT-5', 'Choose a model');
    await settle(() => /Feature values differ for App and Other/.test(ui.text()) || /Feature values differ for Other and App/.test(ui.text()));
    assert.doesNotMatch(ui.text(), /\/app|\/other/);
    assert.ok(ui.get('Choose which project to use'));
    assert.equal(ui.query('Project, App'), undefined, 'the project choice stays behind the disclosure');
    ui.press('Choose which project to use');
    await settle(() => Boolean(ui.query('Project, App')) || Boolean(ui.query('Project, Other')));
  } finally { ui.update(h('View', null)); }
});

test('removing a profile added this session leaves no ghost row', async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol') && Boolean(ui.query('Add profile')));
    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Close new profile')) && Boolean(ui.query('Provider, Choose a provider')));
    ui.type('Name', 'Fast worker');
    choose(ui, 'Provider', 'OpenAI', 'Choose a provider');
    choose(ui, 'Model', 'GPT-5', 'Choose a model');
    await settle(() => state.creates.length === 1 && Boolean(ui.query('Close Fast worker') || ui.query('Edit Fast worker')));
    if (ui.query('Edit Fast worker')) ui.press('Edit Fast worker');
    await settle(() => Boolean(ui.query('Remove Fast worker')));
    ui.press('Remove Fast worker');
    await settle(() => Boolean(ui.query('Confirm removing Fast worker')));
    ui.press('Confirm removing Fast worker');
    await settle(() => state.removes.length === 1);
    assert.deepEqual(state.removes[0], { id: 'created-1' });
    await settle(() => !ui.text().includes('Fast worker'));
    assert.equal(ui.query('Edit Fast worker'), undefined);
    assert.equal(ui.query('Close Fast worker'), undefined);
    assert.match(ui.text(), /Imported Sol/, 'the other profile is untouched');
  } finally { ui.update(h('View', null)); }
});

const iconOf = (node: { type: string; props: Record<string, any>; children: unknown[] }): string | undefined => {
  if (node.type === 'Icon') return node.props.name;
  for (const child of node.children) if (typeof child !== 'string') { const found = iconOf(child as never); if (found) return found; }
  return undefined;
};

for (const compact of [false, true]) test(`nucleus#999: Profiles uses the shared icon buttons, each naming its object; On/Off stays a word (${compact ? 'narrow' : 'wide'})`, async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state, compact));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol') && Boolean(ui.query('Add profile')));
    // The list-level actions sit in the section heading, refresh then add.
    assert.equal(iconOf(ui.get('Add profile')), 'Plus');
    assert.equal(iconOf(ui.get('Refresh providers and models')), 'RefreshCw');
    assert.equal(ui.ofType('Text').find(node => node.children.join('') === 'Add'), undefined, 'no Add word in the header');
    assert.equal(iconOf(ui.get('Edit Imported Sol')), 'Pencil');
    const toggle = ui.get(/^(Disable|Enable) Imported Sol$/);
    assert.equal(iconOf(toggle), undefined, 'the on/off toggle is a word, its state');
    assert.ok(['On', 'Off'].includes(JSON.stringify(toggle).match(/"(On|Off)"/)?.[1] ?? ''), 'it reads On or Off');
    ui.press('Edit Imported Sol');
    await settle(() => Boolean(ui.query('Remove Imported Sol')));
    assert.equal(iconOf(ui.get('Close Imported Sol')), 'X');
    assert.equal(iconOf(ui.get('Duplicate Imported Sol')), 'Copy');
    const remove = ui.get('Remove Imported Sol');
    assert.equal(iconOf(remove), 'Trash2');
    ui.press('Remove Imported Sol');
    await settle(() => Boolean(ui.query('Confirm removing Imported Sol')));
    assert.match(ui.text(), /Remove profile/, 'the danger confirm keeps its words');
    ui.press('Keep Imported Sol');
    ui.press('Close Imported Sol');
    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Close new profile')));
    assert.equal(iconOf(ui.get('Close new profile')), 'X');
    assert.equal(ui.get('Add profile').props.accessibilityState.disabled, true, 'one new profile at a time');
  } finally { ui.update(h('View', null)); }
});

test('a refused Remove or Duplicate names the reason and keeps the profile', async () => {
  await load();
  const state = fixture();
  let failRemove = true;
  let failDuplicate = true;
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string, input: unknown) => {
        if (method === 'profile.create' && failDuplicate) throw new Error('the profile store is unavailable');
        if (method === 'profile.remove' && failRemove) throw new Error('the profile store is unavailable');
        if (method === 'queue.ui-snapshot') return board();
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'repositories') return [{ repository: { origin: 'acme/app', path: '/app' }, closeout: null, validation: null, reviewer: null, qa: null, note: '', updatedAt: '2026-11-07T00:00:00.000Z', revision: 1 }];
        if (method === 'profile.list') return { profiles: state.profiles };
        if (method === 'profile.providers') return { providers: state.providerMap };
        if (method === 'host.catalog') return catalog;
        if (method === 'profile.create') {
          state.creates.push(input);
          const profile = { ...(input as NucleusProfile), id: 'created-1', model: (input as NucleusProfile).model ?? '', notes: (input as NucleusProfile).notes ?? '' };
          state.profiles = [...state.profiles, profile];
          return { profile };
        }
        if (method === 'profile.remove') {
          state.removes.push(input);
          state.profiles = state.profiles.filter(profile => profile.id !== (input as { id: string }).id);
          return { removed: true };
        }
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol'));
    ui.press('Edit Imported Sol');
    await settle(() => Boolean(ui.query('Duplicate Imported Sol')));
    ui.press('Duplicate Imported Sol');
    await settle(() => /Not saved: the profile store is unavailable/.test(ui.text()));
    assert.equal(state.creates.length, 0, 'a refused Duplicate writes nothing');
    assert.match(ui.text(), /Imported Sol/);
    ui.press('Remove Imported Sol');
    await settle(() => Boolean(ui.query('Confirm removing Imported Sol')));
    ui.press('Confirm removing Imported Sol');
    await settle(() => /Not saved: the profile store is unavailable/.test(ui.text()) && state.removes.length === 0);
    assert.equal(state.removes.length, 0, 'a refused Remove writes nothing');
    assert.match(ui.text(), /Imported Sol/);
    assert.ok(ui.query('Remove Imported Sol') || ui.query('Confirm removing Imported Sol'), 'the editor stays open after a refused Remove');
  } finally { ui.update(h('View', null)); }
});


/** A second host that offers OpenAI's models under its own key, and Anthropic's `opus` under `claude`. */
const second: HostCatalog = {
  providers: [
    { key: 'claude', label: 'Claude', available: true, problem: '', models: [{ id: 'opus', label: 'Opus', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] },
    { key: 'oai', label: 'OpenAI', available: true, problem: '', models: [{ id: 'gpt-5', label: 'GPT-5', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] },
  ],
};
const noMatch: HostCatalog = { providers: [{ key: 'gemini', label: 'Gemini', available: true, problem: '', models: [{ id: 'gemini-3', label: 'Gemini 3', aliases: [], thinkingOptions: [], defaultThinkingOptionId: null, modes: [], features: [] }] }] };

test('provider map suggestions need a second host offering the model under another key', () => {
  const profiles = [{ name: 'Sol', provider: 'anthropic', model: 'opus' }, { name: 'Fast', provider: 'openai', model: 'gpt-5' }];
  assert.deepEqual(providerMapSuggestions([{ id: 'paseo', catalog }], profiles), [], 'one host suggests nothing');
  assert.deepEqual(providerMapSuggestions([{ id: 'paseo', catalog }, { id: 'other', catalog: noMatch }], profiles), [], 'no model match suggests nothing');
  assert.deepEqual(providerMapSuggestions([{ id: 'paseo', catalog }, { id: 'other', catalog: second }], profiles), [
    { hostId: 'other', hostKey: 'claude', normalised: 'anthropic', profileName: 'Sol' },
    { hostId: 'other', hostKey: 'oai', normalised: 'openai', profileName: 'Fast' },
  ]);
  assert.deepEqual(providerMapSuggestions([{ id: 'paseo', catalog }, { id: 'other', catalog: second }], profiles, { claude: 'anthropic', oai: 'openai' }), [], 'mapped keys suggest nothing');
  assert.deepEqual(providerMapSuggestions([{ id: 'paseo', catalog }, { id: 'other', catalog: second }], profiles, { claude: 'something-else' })
    .map(entry => entry.hostKey), ['oai'], 'a key already mapped elsewhere is never repointed');
});

const sectionTree = (props: Partial<Parameters<SettingsModule['ProviderMapSection']>[0]> & { saves?: ProviderMap[] }) => h(settings.ProviderMapSection, {
  c, hosts: [], profiles: [], providerMap: {}, busy: false, status: null,
  onSave: async (next: ProviderMap) => { props.saves?.push(next); return true; }, ...props,
});

test('the provider map section is hidden with one host, or two hosts and no match, and while the map is read', async () => {
  await load();
  const profiles = [{ name: 'Sol', provider: 'anthropic', model: 'opus' }];
  for (const props of [
    { hosts: [{ id: 'paseo', catalog }], profiles },
    { hosts: [{ id: 'paseo', catalog }, { id: 'other', catalog: noMatch }], profiles },
    { hosts: [{ id: 'paseo', catalog }, { id: 'other', catalog: second }], profiles, providerMap: undefined },
    { hosts: [], profiles },
  ]) {
    const ui = mount(sectionTree(props));
    assert.equal(ui.query('Provider map'), undefined);
    assert.equal(ui.text(), '');
  }
});

test('a second host offering the model under another key shows the suggestion prefilled', async () => {
  await load();
  const saves: ProviderMap[] = [];
  const longName = 'A very long profile name that keeps going so the suggestion line has to wrap on a narrow settings column';
  const ui = mount(sectionTree({ hosts: [{ id: 'paseo', catalog }, { id: 'other-host', catalog: second }], profiles: [{ name: longName, provider: 'anthropic', model: 'opus' }], saves }));
  assert.ok(ui.get('Provider map'));
  assert.equal(ui.get('Provider map suggestion').children.join(''), `Mapping claude to anthropic makes ${longName} available on other-host.`);
  assert.equal(ui.get('Host provider key').props.value, 'claude');
  assert.equal(ui.get('Normalised key').props.value, 'anthropic');
  assert.doesNotMatch(ui.text(), /None\./);
  ui.press('Add provider map entry');
  await tick();
  assert.deepEqual(saves, [{ claude: 'anthropic' }]);
});

test('a stored entry keeps the provider map visible for editing and removal', async () => {
  await load();
  const state = fixture();
  state.providerMap = { 'openai-codex': 'openai' };
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => Boolean(ui.query('Provider map')));
    assert.match(ui.text(), /openai-codex → openai/);
    assert.equal(ui.query('Provider map suggestion'), undefined, 'one host suggests nothing');
    assert.equal(ui.get('Host provider key').props.value, '');
    ui.press('Remove provider map entry openai-codex');
    await settle(() => state.mapWrites.length === 1);
    assert.deepEqual(state.mapWrites[0], {});
    await settle(() => !ui.query('Provider map'));
  } finally { ui.update(h('View', null)); }
});

test('an unreadable provider map names the reason and shows no section', async () => {
  await load();
  const state = fixture();
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string, input: unknown) => {
        if (method === 'profile.providers') throw new Error('the profile store is unavailable');
        return (screenTree(state).props as { children: { props: { invoke: (m: string, i: unknown) => Promise<unknown> } } }).children.props.invoke(method, input);
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: true, platform: 'ios' as const },
      }),
    }),
  }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Could not read the provider map: the profile store is unavailable'));
    assert.equal(ui.query('Provider map'), undefined);
  } finally { ui.update(h('View', null)); }
});

test('the dispatch row and sliders wait for the board: absent while it loads or fails, present once it arrives', async () => {
  await load();
  const state = fixture();
  let resolveBoard: ((value: ReturnType<typeof board>) => void) | undefined;
  let failBoard = false;
  const pending = new Promise<ReturnType<typeof board>>(resolve => { resolveBoard = resolve; });
  const tree = () => h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string) => {
        if (method === 'queue.ui-snapshot') { if (failBoard) throw new Error('the service is restarting'); return pending; }
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'repositories') return [];
        if (method === 'profile.list') return { profiles: state.profiles };
        if (method === 'profile.providers') return { providers: {} };
        if (method === 'host.catalog') return catalog;
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  });
  const open = async (ui: ReturnType<typeof mount>) => {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => Boolean(ui.query('Edit Imported Sol')));
    ui.press('Edit Imported Sol');
    await settle(() => Boolean(ui.query('Profile name row')));
  };
  const ui = mount(tree());
  try {
    await open(ui);
    assert.equal(ui.query('Profile dispatch row'), undefined, 'no Subscription or Weight while the board loads');
    assert.equal(ui.query('Cost value'), undefined, 'no sliders while the board loads');
    assert.ok(labelsIn(ui.get('Profile name row') as Node).includes('Duplicate Imported Sol'), 'the Name row and its actions are already there');
    resolveBoard!({ ...board(), pool: [{ profileId: 'imported', group: 'anthropic', weight: 3, enabled: true, scopes: ['general'], roles: ['worker'] }] } as never);
    await settle(() => Boolean(ui.query('Profile dispatch row')));
    assert.equal(ui.get('Weight for Imported Sol').props.value, '3', 'the stored weight shows once the board arrives');
    assert.equal(ui.get('Cost value').children.join(''), 'Unset');
  } finally { ui.update(h('View', null)); }
  failBoard = true;
  const failed = mount(tree());
  try {
    await open(failed);
    await settle(() => /the service is restarting/.test(failed.text()));
    assert.equal(failed.query('Profile dispatch row'), undefined, 'a failed board read shows no dispatch fields to edit');
    assert.equal(failed.query('Cost value'), undefined);
  } finally { failed.update(h('View', null)); }
});

type Node = { type: string; props: Record<string, any>; children: Array<Node | string> };
const labelsIn = (node: Node): string[] => node.children.flatMap(child => typeof child === 'string' ? [] : [String(child.props.accessibilityLabel ?? ''), ...labelsIn(child)]);

test('model option fields flow two to a row, an odd last one spans the row, and they stack on a phone', async () => {
  await load();
  const state = fixture();
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Imported Sol') && Boolean(ui.query('Add profile')));
    ui.press('Add profile');
    await settle(() => Boolean(ui.query('Provider, Choose a provider')));
    const editor = () => ui.get('New profile editor');
    const layout = (width: number) => editor().props.onLayout({ nativeEvent: { layout: { width } } });
    const rows = () => (ui.all('Model options row') as Node[]).map(row => row.children.filter((cell): cell is Node => typeof cell !== 'string'));
    assert.equal(rows().length, 0, 'no option rows before a model is chosen');
    layout(688);
    choose(ui, 'Provider', 'OpenAI', 'Choose a provider');
    choose(ui, 'Model', 'GPT-5', 'Choose a model');
    await settle(() => rows().length === 2);
    const order = rows().map(cells => cells.map(cell => labelsIn(cell).find(label => /^(Mode|Thinking|Permissions), |^Feature Web search on$/.test(label))));
    assert.deepEqual(order, [['Mode, Host default', 'Thinking, High'], ['Feature Web search on', 'Permissions, Ask']], 'Mode and Thinking, then the features, two to a row');
    for (const cells of rows()) for (const cell of cells) assert.deepEqual([cell.props.style.flex, cell.props.style.minWidth], [1, 0], 'each option takes half the row');
    layout(358);
    for (const cells of rows()) for (const cell of cells) assert.equal(cell.props.style.minWidth, '100%', 'stacked on a phone');
    layout(688);
    choose(ui, 'Model', 'GPT-5 mini', 'GPT-5');
    await settle(() => rows().length === 1 && rows()[0].length === 2);
    assert.ok(labelsIn(rows()[0][0]).includes('Mode, Host default'));
    assert.match(ui.text(), /Host default/, 'an empty thinking list stays plain text beside Mode');
    choose(ui, 'Provider', 'Codex', 'OpenAI');
    choose(ui, 'Model', 'Codex 1', 'Choose a model');
    await settle(() => rows().length === 1 && rows()[0].length === 1);
    assert.equal(rows()[0][0].props.style.flex, 1, 'a lone option spans the row');
  } finally { ui.update(h('View', null)); }
});

test('host option values read as plain words', async () => {
  await load();
  assert.equal(settings.plainWords('xhigh', 'xhigh'), 'Extra high');
  assert.equal(settings.plainWords(undefined, 'xhigh'), 'Extra high');
  assert.equal(settings.plainWords('', 'full_access'), 'Full access');
  assert.equal(settings.plainWords('read-only', 'read-only'), 'Read only');
  assert.equal(settings.plainWords('Full Access', 'bypassPermissions'), 'Full Access', 'a host display label in words stays');
  assert.equal(settings.plainWords('max', 'max'), 'Maximum');
  assert.equal(settings.plainWords('low', 'low'), 'Low');
  assert.equal(settings.plainWords(undefined, 'bypassPermissions'), 'Bypass permissions', 'a camelCase key is spelled out');
  assert.equal(settings.plainWords('acceptEdits', 'acceptEdits'), 'Accept edits');
  assert.equal(settings.plainWords('GPT-5 high', 'gpt-5-high'), 'GPT-5 high');
});

test('a Profiles card shows Name, Subscription, Weight, Provider and Model at one control height with one caption size, wide and narrow', async () => {
  await load();
  const { control, caption } = await import('../client/design');
  const state = fixture();
  const tree = h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke: async (method: string) => {
        if (method === 'queue.ui-snapshot') return { ...board(), pool: [{ profileId: 'imported', group: 'anthropic', weight: 3, enabled: true, scopes: ['general'], roles: ['worker'] }] };
        if (method === 'backup.list') return { snapshots: [], localError: null };
        if (method === 'repositories') return [];
        if (method === 'profile.list') return { profiles: state.profiles };
        if (method === 'profile.providers') return { providers: {} };
        if (method === 'host.catalog') return catalog;
        return {};
      },
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
      }),
    }),
  });
  const ui = mount(tree);
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => Boolean(ui.query('Edit Imported Sol')));
    ui.press('Edit Imported Sol');
    await settle(() => Boolean(ui.query('Profile dispatch row')));
    const editor = () => ui.get('Imported Sol editor');
    const trigger = (label: string) => (ui.ofType('Pressable') as Node[]).find(node => String(node.props.accessibilityLabel ?? '').startsWith(`${label}, `))!;
    for (const width of [688, 358]) {
      editor().props.onLayout({ nativeEvent: { layout: { width } } });
      const heights = {
        name: ui.get('Name').props.style.minHeight,
        subscription: ui.get('Subscription').props.style.minHeight,
        decrease: ui.get('Decrease weight for Imported Sol').props.style.minHeight,
        weight: ui.get('Weight for Imported Sol').props.style.height,
        increase: ui.get('Increase weight for Imported Sol').props.style.minHeight,
        provider: trigger('Provider').props.style.minHeight,
        model: trigger('Model').props.style.minHeight,
      };
      for (const [field, height] of Object.entries(heights)) assert.equal(height, control.height, `${field} at ${width} points`);
      for (const text of ['Subscription', 'Weight', 'Provider', 'Model']) {
        const style = (ui.ofType('Text') as Node[]).find(node => node.children.join('') === text)?.props.style;
        assert.equal(style?.fontSize, caption.fontSize, `${text} caption at ${width} points`);
      }
      assert.equal(ui.get('Name').props.style.fontSize, control.text.fontSize);
      assert.equal(ui.get('Subscription').props.style.fontSize, control.text.fontSize);
    }
    // At the phone width Subscription and Weight each take a full row; By request is retired.
    const row = ui.get('Profile dispatch row') as Node;
    const cells = row.children.filter((cell): cell is Node => typeof cell !== 'string');
    assert.equal(cells[0].props.style.minWidth, '100%');
    assert.equal(cells[1].props.style.minWidth, '100%');
    assert.equal(ui.query('Selection by request'), undefined);
  } finally { ui.update(h('View', null)); }
});

test('nucleus#970: the Refresh tooltip names the stored catalog\'s age', async () => {
  const { catalogAge } = await load();
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  assert.equal(catalogAge(undefined, now), '');
  assert.equal(catalogAge('not a time', now), '');
  assert.equal(catalogAge('2026-11-09T11:59:30.000Z', now), 'read just now');
  assert.equal(catalogAge('2026-11-09T11:55:00.000Z', now), 'read 5 min ago');
  assert.equal(catalogAge('2026-11-09T09:00:00.000Z', now), 'read 3 h ago');
  assert.equal(catalogAge('2026-11-07T12:00:00.000Z', now), 'read 2 d ago');
  assert.equal(catalogAge('2026-11-09T12:05:00.000Z', now), 'read just now', 'a clock ahead of the host never reads negative');
});

for (const compact of [false, true]) test(`nucleus#970: Profiles opens on the stored catalog; Refresh replaces it, or keeps it and names the reason once (${compact ? 'narrow' : 'wide'})`, async () => {
  await load();
  const state = fixture();
  state.profiles = [{ id: 'sol', name: 'Sol', provider: 'openai', model: 'gpt-5', notes: '' } as NucleusProfile];
  const readAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const renamed = { providers: catalog.providers.map(provider => provider.key === 'openai' ? { ...provider, label: 'OpenAI Next' } : provider) };
  let release: (() => void) | null = null;
  let refreshFailure = '';
  state.catalogAnswer = async input => {
    if (!input.refresh) return { ...catalog, readAt };
    if (refreshFailure) throw new Error(refreshFailure);
    return new Promise(resolve => { release = () => resolve({ ...renamed, readAt: new Date().toISOString() }); });
  };
  const ui = mount(screenTree(state, compact));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Sol'));
    const refresh = () => ui.get('Refresh providers and models');
    await settle(() => refresh().props.accessibilityHint === 'Refresh providers and models · read 5 min ago');
    assert.equal(ui.query('Sol: Unavailable'), undefined);
    assert.ok(state.catalogReads.every(read => !read.refresh), 'opening the page never refreshes');
    ui.press('Edit Sol');
    await settle(() => Boolean(ui.query('Provider, OpenAI')));

    ui.press('Refresh providers and models');
    await settle(() => refresh().props.accessibilityHint === 'Refreshing providers and models…');
    assert.equal(refresh().props.accessibilityState.disabled, true);
    await settle(() => state.catalogReads.some(read => read.refresh));
    assert.deepEqual(state.catalogReads.filter(read => read.refresh), [{ cwd: '/app', refresh: true }]);
    assert.ok(ui.query('Provider, OpenAI'), 'the stored lists stay usable while Refresh runs');
    assert.equal(ui.query('Sol: Unavailable'), undefined, 'a read in flight never reads as unavailable');

    release!();
    await settle(() => Boolean(ui.query('Provider, OpenAI Next')));
    await settle(() => refresh().props.accessibilityHint === 'Refresh providers and models · read just now');
    assert.equal(refresh().props.accessibilityState.disabled, false);

    refreshFailure = 'Daemon is disconnected';
    ui.press('Refresh providers and models');
    await settle(() => ui.text().includes('Refresh failed: Daemon is disconnected. The stored providers and models stay.'));
    assert.equal(ui.text().split('Refresh failed').length - 1, 1, 'the reason shows once');
    assert.ok(ui.query('Provider, OpenAI Next'), 'a failed refresh keeps the stored catalog');
    await settle(() => refresh().props.accessibilityState.disabled === false);

    refreshFailure = '';
    ui.press('Refresh providers and models');
    await settle(() => !ui.text().includes('Refresh failed'));
    release!();
  } finally { ui.update(h('View', null)); }
});

test('nucleus#970: while the first catalog read is in flight, no row reads unavailable', async () => {
  await load();
  const state = fixture();
  state.profiles = [{ id: 'sol', name: 'Sol', provider: 'openai', model: 'gpt-5', notes: '' } as NucleusProfile];
  state.catalogAnswer = () => new Promise(() => {});
  const ui = mount(screenTree(state));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Profiles');
    await settle(() => ui.text().includes('Sol') && state.catalogReads.length > 0);
    assert.equal(ui.query('Sol: Unavailable'), undefined);
    assert.equal(ui.get('Refresh providers and models').props.accessibilityHint, 'Refresh providers and models');
  } finally { ui.update(h('View', null)); }
});
