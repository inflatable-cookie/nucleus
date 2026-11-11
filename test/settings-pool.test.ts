import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { build } from 'esbuild';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { boardShellPlugin, mount, useNativeStubs } from './support/render';
import { poolSchema, type PoolEntry, type Profile } from '../shared/contracts';

useNativeStubs();

type SettingsModule = typeof import('../client/settings-screen');
let settings: SettingsModule;
const load = async () => {
  settings = await import('../client/settings-screen');
  return settings;
};
const loadBundle = async () => {
  const bytes = (await build({ entryPoints: [new URL('../client/settings-screen.tsx', import.meta.url).pathname], bundle: true, plugins: [boardShellPlugin],
    platform: 'node', format: 'cjs', packages: 'external', write: false })).outputFiles[0]!.text;
  const compiled = { exports: {} as SettingsModule };
  new Function('require', 'module', 'exports', bytes)(createRequire(import.meta.url), compiled, compiled.exports);
  settings = compiled.exports;
};

const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const tick = () => new Promise(resolve => setImmediate(resolve));
/** Real time for debounced autosaves: poll every 20 ms for up to 3 s. */
async function waitFor(probe: () => boolean, label = 'condition') {
  for (const deadline = Date.now() + 3_000; Date.now() < deadline;) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(`timed out waiting for ${label}`);
}
const profile = (id: string, name = id): Profile => ({
  id, name, provider: 'openai', model: 'gpt-5', notes: '', available: true, problem: '', supportedThinking: [],
});
const entry = (profileId: string, group = 'subscription'): PoolEntry =>
  poolSchema.parse({ profileId, group, weight: 1, enabled: true, scopes: ['general'] });

/** Settings-only capacity writes: the read Settings renders, with no change recorded yet. */
const CAPACITY_VALUES = { globalLimit: 32, projectLimit: 5, papercutProjectLimit: 2, paseoCallLimit: 6, stallThresholdMinutes: 30, holdReminderMinutes: 120, holdEscalationMinutes: 240, laneDrainMinutes: 120, laneDrainEscalationMinutes: 1440 };
interface CapacityView { effective: typeof CAPACITY_VALUES; changes: { version: number; at: string; surface: string; before: typeof CAPACITY_VALUES; after: typeof CAPACITY_VALUES }[] }
const capacityAuthorityState = (overrides: Record<string, unknown> = {}): CapacityView => ({
  effective: CAPACITY_VALUES,
  changes: [],
  ...overrides,
} as CapacityView);
const board = (overrides: Record<string, unknown> = {}) => ({
  revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 5, papercutProjectLimit: 2,
  tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
  lanes: [], projects: [], projectLimitOverrides: {}, projectCapacities: [], prStates: {},
  ...overrides,
});

/** Remove a project row's override the way an operator does: its trash icon, then the confirmation (Tom, 2026-11-08). */
function pressRemove(ui: { press(label: string | RegExp): void }, name: string) {
  ui.press(`Remove the ${name} override`);
  ui.press(`Remove ${name} dispatch limit override`);
}

async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail('the settings screen did not settle');
}

function unmount(ui: ReturnType<typeof mount>) {
  ui.update(h('View', null));
}

function setSettingsWidth(ui: ReturnType<typeof mount>, width: number) {
  ui.get('Nucleus settings').props.onLayout({ nativeEvent: { layout: { width } } });
}

function selectSettingsTab(ui: ReturnType<typeof mount>, label: string) {
  const tab = (ui.get('Settings sections') as Node).children.find((node): node is Node => typeof node !== 'string' && node.props.accessibilityLabel === label);
  assert.ok(tab, `the ${label} tab`);
  tab.props.onPress();
}

function screenTree(state: ReturnType<typeof board>, onPool?: (input: unknown) => void, compact = false, onUsage?: (input: unknown) => void, onOffsets?: (input: unknown) => void) {
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return state;
    if (method === 'queue.capacity-state') return capacityAuthorityState();
    if (method === 'queue.demand-offsets') { onOffsets?.(input); return input; }
    if (method === 'queue.usage') { onUsage?.(input); return { level: 'maximum', setLevel: 'maximum', until: null, expired: false }; }
    if (method === 'backup.list') return { snapshots: [], localError: null };
    if (method === 'queue.pool' || method === 'queue.profile') { onPool?.(input); return { ok: true }; }
    return {};
  };
  return h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, {
      invoke,
      children: h(settings.QueueSettingsScreen as never, {
        theme: { colors: c },
        host: { id: 'host', label: 'Host' },
        layout: { compact, platform: 'ios' as const },
      }),
    }),
  });
}

test('a live profile row is one line at narrow and wide sizes, with no By request status', async () => {
  await load();
  const model = 'claude-sonnet-4-5-20250929';
  const longName = 'A very long profile name that would otherwise truncate';
  const state = board({
    profiles: [{ ...profile('worker-1', longName), provider: 'anthropic', model, thinkingOptionId: 'high' }],
    pool: [poolSchema.parse({ profileId: 'worker-1', group: 'anthropic-max', enabled: true, scopes: ['general'], roles: ['worker', 'reviewer', 'coordinator'], cost: 'very_high', capability: 'frontier', weight: 3 })],
    recentAssignments: { 'profile:worker-1': 2 },
    assignments: { 'profile:worker-1': 7 },
  });
  for (const compact of [false, true]) {
    const mode = compact ? 'compact' : 'wide';
    const ui = mount(screenTree(state, undefined, compact));
    if (compact) setSettingsWidth(ui, 390);
    selectSettingsTab(ui, 'Profiles');
    await settle(() => ui.text().includes(longName));
    const texts = ui.ofType('Text');
    const name = texts.find(node => node.children.join('') === longName)!;
    const modelLine = texts.find(node => node.children.join('') === model);
    assert.ok(name && !modelLine, `${mode} row renders only the profile name`);
    assert.equal(ui.query(`${longName}: Needs a request`), undefined, 'By request and its status icon are retired (Tom, 2026-11-09)');
    assert.equal(name.props.numberOfLines, undefined, `the name is not ellipsised in the ${mode} view`);
    const rowChildren = (child: typeof name) => ui.ofType('View').find(view => view.children.includes(child))?.children.filter(item => typeof item !== 'string') ?? [];
    assert.deepEqual(rowChildren(name).filter(child => child !== name).map(child => child.props.accessibilityLabel), [`Disable ${longName}`, `Edit ${longName}`], 'On/Off and Edit share one line with the name');
    assert.equal(ui.query(`Remove ${longName}`), undefined, 'Remove stays off the list row');
    assert.doesNotMatch(ui.text(), /Cost:|Usage policy:|· relative share|checked against the usage level|2 recent · 7 total|Profile notes|Changes save automatically/);
    unmount(ui);
  }
});

test('a pool with one stale entry renders it marked and removable; Remove saves exactly the other entries', async () => {
  await load();
  const live = entry('live');
  const stale = { ...entry('opencode-go', 'opencode-go'), enabled: false };
  const saved: unknown[] = [];
  const ui = mount(screenTree(board({
    profiles: [profile('live', 'Live model')],
    pool: [live, stale],
  }), input => saved.push(input)));
  selectSettingsTab(ui, 'Profiles');
  await settle(() => ui.text().includes('Live model') && ui.text().includes('This profile is gone'));
  assert.match(ui.text(), /Live model/, 'the live catalog row is first');
  assert.match(ui.text(), /opencode-go/, 'the stale row keeps its last-known id');
  assert.doesNotMatch(ui.text(), /opencode-go · worker/, 'stale rows show no group or roles');
  assert.match(ui.text(), /This profile is gone/);
  assert.ok(ui.get('Remove opencode-go'));
  assert.equal(ui.query('Remove live'), undefined, 'live rows keep On/Off and Edit, not Remove');
  const liveBeforeStale = ui.text().indexOf('Live model') < ui.text().indexOf('This profile is gone');
  assert.equal(liveBeforeStale, true, 'stale rows sort after live ones');
  ui.press('Remove opencode-go');
  await settle(() => saved.length === 1);
  assert.deepEqual(saved[0], { entries: [live] }, 'Remove saves the other entries unchanged');
  unmount(ui);
});

test('an empty or disconnected catalog marks nothing stale', async () => {
  await load();
  const pool = [entry('live'), { ...entry('opencode-go', 'opencode-go'), enabled: false }];
  const empty = mount(screenTree(board({ connected: true, profiles: [], pool })));
  selectSettingsTab(empty, 'Profiles');
  await settle(() => empty.text().includes('No profiles yet. Add one from what this host can run.'));
  assert.equal(empty.text().includes('This profile is gone'), false);
  assert.equal(empty.query('Remove opencode-go'), undefined);
  unmount(empty);

  const disconnected = mount(screenTree(board({
    connected: false,
    profiles: [profile('live', 'Live model')],
    pool,
  })));
  selectSettingsTab(disconnected, 'Profiles');
  await settle(() => disconnected.text().includes('Live model'));
  assert.equal(disconnected.text().includes('This profile is gone'), false, 'a daemon outage does not offer to remove stale rows');
  assert.equal(disconnected.query('Remove opencode-go'), undefined);
  unmount(disconnected);
});

test('the bundled dark Settings screen adds a project override from the picker and removes it', async () => {
  await loadBundle();
  const projectA = { key: 'project-a', name: 'Project-A', version: 1, visibility: 'active', repositories: [{ origin: 'owner/project-a', path: '/project-a' }], primary: { origin: 'owner/project-a', path: '/project-a' } };
  const projectD = { key: 'project-d', name: 'Project-D', version: 1, visibility: 'active', repositories: [{ origin: 'owner/project-d', path: '/project-d' }], primary: { origin: 'owner/project-d', path: '/project-d' } };
  let state = board({ projects: [projectA, projectD], projectLimitOverrides: { 'project-d': 3 } });
  const writes: unknown[] = [];
  // Controls for the review #596 regressions: hold a write in flight, or fail one.
  let hold: Promise<void> | null = null, failRemove = false;
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return state;
    if (method === 'backup.list') return { snapshots: [], localError: null };
    if (method === 'queue.capacity-state') return capacityAuthorityState();
    if (method === 'queue.project-dispatch-limit') {
      const change = input as { projectKey: string; limit: number | null };
      if (hold) await hold;
      if (change.limit === null && failRemove) throw new Error('override store unavailable');
      writes.push(change);
      const overrides = { ...(state.projectLimitOverrides as Record<string, number>) };
      if (change.limit === null) delete overrides[change.projectKey]; else overrides[change.projectKey] = change.limit;
      state = board({ ...state, revision: state.revision + 1, projects: [projectA, projectD], projectLimitOverrides: overrides });
      return { ok: true };
    }
    return {};
  };
  const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke,
    children: h(settings.QueueSettingsScreen as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } }) }) }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Dispatch limits');
    await settle(() => Boolean(ui.query('Remove the Project-D override')));
    assert.equal(ui.get('Global dispatch limit (slots, 1–64)').props.value, '32', 'the task slots are writable again, seeded from the state in force');
    assert.equal(ui.query('Save dispatch limits'), undefined, 'Dispatch limits has no save buttons');
    assert.equal(ui.get('Nucleus settings').props.style.backgroundColor, dark.surface0, 'the rendered bundle uses the dark host theme');
    assert.equal(ui.ofType('Modal').length, 0, 'the override picker opens no dialog');
    assert.equal(ui.query('Add project limit override: Project-A'), undefined, 'the project picker starts closed');
    ui.press('Add project limit override, +');
    assert.ok(ui.get('Add project limit override: Project-A'), '+ opens the anchored project picker');
    assert.equal(ui.query('Add project limit override: Project-D'), undefined, 'projects with an override are left out of the picker');
    // Choosing a project creates its override at once at the per-project limit.
    // While that create is in flight, + waits: a second pick cannot race it (review #596).
    let releaseCreate!: () => void; hold = new Promise(resolve => { releaseCreate = resolve; });
    ui.press('Add project limit override: Project-A');
    await waitFor(() => ui.get('Add project limit override, +').props.disabled === true, '+ to wait for the pending create');
    assert.equal(ui.query('Add project limit override: Project-A'), undefined, 'picking closes the picker');
    hold = null; releaseCreate();
    await waitFor(() => (state.projectLimitOverrides as Record<string, number>)['project-a'] === 5 && Boolean(ui.query('Remove the Project-A override')), 'the override to be created on pick');
    // One line per override: no fixed-width field, no in-flight control (review #599; Tom, 2026-11-08).
    assert.ok(!ui.ofType('View').some(node => node.props.style?.width === 200), 'no fixed-width override field');
    assert.equal(ui.query(/In-flight task cap/), undefined, 'the in-flight cap is always twice the slots');
    assert.deepEqual(writes, [{ projectKey: 'project-a', limit: 5 }]);
    const slots = 'Task slots for Project-A (0–64; 0 admits nothing)';
    ui.type(slots, '0');
    await waitFor(() => (state.projectLimitOverrides as Record<string, number>)['project-a'] === 0, 'the edit to autosave');
    assert.deepEqual(writes[1], { projectKey: 'project-a', limit: 0 });

    // A refresh from an in-flight save never replaces a newer draft (review #596).
    let release!: () => void; hold = new Promise(resolve => { release = resolve; });
    ui.type(slots, '4'); ui.get(slots).props.onBlur();
    // Saving… is quiet now (Tom, 2026-11-08): the held save shows only as the draft that waits for it.
    await waitFor(() => ui.get(slots).props.value === '4', 'the draft to be entered');
    await new Promise(resolve => setTimeout(resolve, 700));
    ui.type(slots, '');
    hold = null; release();
    await waitFor(() => (state.projectLimitOverrides as Record<string, number>)['project-a'] === 4, 'the in-flight save to land');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(ui.get(slots).props.value, '', 'the cleared draft stays while typing');
    const settled = writes.length;
    ui.get(slots).props.onBlur();
    assert.equal(ui.get(slots).props.value, '4', 'an empty field returns to the value when typing ends');
    assert.equal(writes.length, settled, 'an empty field is never sent');

    // Once Remove starts the row takes no edits, so nothing recreates the override (review #596).
    let releaseRemove!: () => void; hold = new Promise(resolve => { releaseRemove = resolve; });
    ui.type(slots, '6');
    const beforeRemove = writes.length;
    pressRemove(ui, 'Project-A');
    await waitFor(() => ui.get(slots).props.editable === false, 'the row to lock while Remove runs');
    ui.type(slots, '4');
    assert.equal(ui.get(slots).props.value, '6', 'typing during Remove is ignored');
    hold = null; releaseRemove();
    await waitFor(() => !Object.keys(state.projectLimitOverrides as Record<string, number>).includes('project-a') && !ui.query('Remove the Project-A override'), 'the locked removal');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.ok(!Object.keys(state.projectLimitOverrides as Record<string, number>).includes('project-a'), 'no edit typed during Remove recreates the override');
    assert.deepEqual(writes.slice(beforeRemove), [{ projectKey: 'project-a', limit: null }], 'only the removal is written: the pending 6 is replaced and the typed 4 ignored');
    // Re-add it for the edit-then-Remove case.
    ui.press('Add project limit override, +'); ui.press('Add project limit override: Project-A');
    await waitFor(() => Boolean(ui.query('Remove the Project-A override')), 'Project-A to be re-added');
    // An edit immediately followed by Remove ends removed: Remove replaces the pending edit.
    ui.type(slots, '7'); pressRemove(ui, 'Project-A');
    await waitFor(() => !Object.keys(state.projectLimitOverrides as Record<string, number>).includes('project-a') && !ui.query('Remove the Project-A override'), 'the removal');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.ok(!Object.keys(state.projectLimitOverrides as Record<string, number>).includes('project-a'), 'no pending edit recreates the override after Remove');
    assert.deepEqual(writes.at(-1), { projectKey: 'project-a', limit: null });
    assert.equal(writes.filter(write => (write as { limit: number | null }).limit === 7).length, 0);

    // A failed Remove explains itself and keeps the override.
    failRemove = true;
    pressRemove(ui, 'Project-D');
    await waitFor(() => /Not saved: .*override store unavailable/.test(String(ui.query('Project-D override save status')?.children.join(''))), 'the removal failure to show');
    assert.equal((state.projectLimitOverrides as Record<string, number>)['project-d'], 3);
    assert.equal(ui.get('Task slots for Project-D (0–64; 0 admits nothing)').props.editable, true, 'a failed Remove gives editing back');
    failRemove = false;
    assert.deepEqual(state.projectLimitOverrides, { 'project-d': 3 }, 'removing Project-A keeps the other project override');
    assert.equal(ui.query('Cancel Project-A dispatch limit override'), undefined, 'no draft rows or Cancel: picking creates');
  } finally { ui.update(h('View', null)); client.clear(); }
});

test('Settings has no Repositories section: per-repository overrides live in the opened project, the default in Projects → Defaults', async () => {
  await load();
  const ui = mount(screenTree(board()));
  try {
    await settle(() => ui.text().includes('Profiles'));
    assert.equal(ui.query('Repositories'), undefined, 'the section is gone (lane nucleus-ui, task 946 build task 4)');
    assert.ok(ui.get('Projects'));
  } finally { unmount(ui); }
});

/** The task slots' save has settled: its status reads Saved. */
const saved = (ui: { query: (label: string) => { children: unknown[] } | undefined }) => ui.query('Task slots save status')?.children.join('') === 'Saved';

test('dark bundled Dispatch limits: three task slots first, Advanced reveals six, autosave keeps the whole state', async () => {
  await loadBundle();
  let authority: CapacityView = capacityAuthorityState();
  let state = board();
  const writes: Record<string, number>[] = [];
  const invoke = async (method: string, input: unknown) => {
    if (method === 'queue.ui-snapshot') return state;
    if (method === 'backup.list') return { snapshots: [], localError: null };
    if (method === 'queue.capacity-state') return authority;
    if (method === 'queue.capacity') {
      writes.push(input as Record<string, number>);
      const after = { ...authority.effective, ...(input as Record<string, number>) };
      authority = { effective: after, changes: [...authority.changes, { version: authority.changes.length + 1, at: '2026-10-25T09:05:00.000Z', surface: 'paseo', before: authority.effective, after }] };
      return { ok: true };
    }
    return {};
  };
  const dark = { accent: '#1f6feb', accentForeground: '#fff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke, children: h(settings.QueueSettingsScreen as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } }) }) }));
  try {
    await settle(() => ui.text().includes('Profiles'));
    ui.press('Dispatch limits');
    await settle(() => ui.text().includes('Task slots'));
    // Only the three task slots show first; the six secondary limits wait under a collapsed Advanced revealer.
    for (const [label, value] of [
      ['Global dispatch limit (slots, 1–64)', '32'], ['Per project dispatch limit (slots, 1–32)', '5'],
      ['Papercuts dispatch limit (slots, 1–32)', '2'],
    ]) assert.equal(ui.get(label).props.value, value, label);
    assert.equal(ui.get('Advanced limits').props.accessibilityState.expanded, false, 'Advanced starts collapsed');
    assert.equal(ui.query('Paseo calls dispatch limit (calls, 1–32)'), undefined, 'a collapsed Advanced hides its fields');
    assert.equal(ui.query('Stall threshold dispatch limit (minutes, 1–240)'), undefined);
    assert.equal(/sudo|capacity-authority|capacity\.json/.test(ui.text()), false, 'no privileged command or host document is named');
    // The change log stays for the CLI: Settings shows no view of it (Tom, 2026-11-08).
    assert.doesNotMatch(ui.text(), /Recorded changes|Change history|None yet\. The first change/);
    assert.equal(ui.query('View change history'), undefined, 'no history button');
    assert.equal(ui.query('Task slots save status'), undefined, 'no idle label: the status element appears only with a real status');

    // Opening Advanced is local: the six values, their units and bounds, and no write.
    ui.press('Advanced limits');
    assert.equal(ui.get('Advanced limits').props.accessibilityState.expanded, true, 'the revealer announces its expanded state');
    for (const [label, value] of [
      ['Paseo calls dispatch limit (calls, 1–32)', '6'], ['Stall threshold dispatch limit (minutes, 1–240)', '30'],
      ['Hold reminder dispatch limit (minutes, 1–10080)', '120'], ['Hold escalation dispatch limit (minutes, 1–10080)', '240'],
      ['Lane drain dispatch limit (minutes, 1–10080)', '120'], ['Lane drain escalation dispatch limit (minutes, 1–10080)', '1440'],
    ]) assert.equal(ui.get(label).props.value, value, label);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(writes.length, 0, 'opening Advanced writes nothing');

    // Typing saves the whole state once the pause elapses.
    ui.type('Global dispatch limit (slots, 1–64)', '21');
    await waitFor(() => writes.length === 1, 'the capacity change to autosave');
    assert.deepEqual(writes[0], { ...CAPACITY_VALUES, globalLimit: 21 }, 'the write carries every limit, so no untouched one is reset');
    // The save settles visibly; the server records the change, and the screen shows no receipt for it.
    await settle(() => saved(ui));
    assert.equal(authority.changes.length, 1, 'the server still records the applied change');
    assert.doesNotMatch(ui.text(), /Version 1 ·|Global 32 → 21|Paseo plugin bridge/);

    // An advanced limit saves through the same section, and the write still carries the others.
    ui.type('Stall threshold dispatch limit (minutes, 1–240)', '45');
    await waitFor(() => writes.length === 2, 'the advanced change to autosave');
    assert.deepEqual(writes[1], { ...CAPACITY_VALUES, globalLimit: 21, stallThresholdMinutes: 45 });
    await settle(() => saved(ui));

    // An out-of-range value is never sent while it is typed, and collapsing writes nothing.
    ui.type('Hold reminder dispatch limit (minutes, 1–10080)', '0');
    ui.press('Advanced limits');
    assert.equal(ui.query('Hold reminder dispatch limit (minutes, 1–10080)'), undefined, 'collapsed');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(writes.length, 2, 'an out-of-range value writes nothing, even across a collapse');
    // A valid value now saves as the third change.
    ui.press('Advanced limits');
    ui.type('Hold reminder dispatch limit (minutes, 1–10080)', '60');
    await waitFor(() => writes.length === 3, 'the third advanced change to autosave');
    await settle(() => saved(ui));
    assert.equal(authority.changes.length, 3, 'every applied change is recorded for queue.capacity-state');
    assert.doesNotMatch(ui.text(), /Version \d+ ·|Recorded changes/, 'with a full record, still no receipt on screen');
    assert.equal(ui.query('View change history'), undefined);
    assert.ok(ui.text().includes('Project overrides'));
    assert.ok(ui.text().includes('Usage level'));
  } finally { ui.update(h('View', null)); client.clear(); }
});

test('Dispatch limits steppers: one typeable field between − and +, bounded and validated the same on every host (Tom, 2026-11-08)', async () => {
  await loadBundle();
  const dark = { accent: '#1f6feb', accentForeground: '#fff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  // A fresh screen with its own capacity record and write log.
  const harness = () => {
    let authority: CapacityView = capacityAuthorityState();
    const writes: Record<string, number>[] = [];
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board();
      if (method === 'backup.list') return { snapshots: [], localError: null };
      if (method === 'queue.capacity-state') return authority;
      if (method === 'queue.capacity') {
        writes.push(input as Record<string, number>);
        const after = { ...authority.effective, ...(input as Record<string, number>) };
        authority = { effective: after, changes: [...authority.changes, { version: authority.changes.length + 1, at: '2026-10-25T09:05:00.000Z', surface: 'paseo', before: authority.effective, after }] };
        return { ok: true };
      }
      return {};
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke, children: h(settings.QueueSettingsScreen as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } }) }) }));
    return { ui, writes, client };
  };
  // Every host renders the same shared stepper: no DOM input, one typeable field, − and + on each side.
  const screen = harness();
  try {
    await settle(() => screen.ui.text().includes('Profiles'));
    screen.ui.press('Dispatch limits');
    await settle(() => screen.ui.text().includes('Task slots'));
    assert.equal(screen.ui.ofType('input').length, 0, 'no DOM input: the field is the shared TextInput');
    assert.equal(screen.ui.get('Global dispatch limit (slots, 1–64)').type, 'TextInput');
    assert.equal(screen.ui.get('Global dispatch limit (slots, 1–64)').props.keyboardType, 'number-pad');
    screen.ui.press('Increase Global dispatch limit (slots, 1–64)');
    await waitFor(() => screen.writes.length === 1, 'the step to autosave');
    assert.equal(screen.writes[0]!.globalLimit, 33, 'a step writes the value one above');
    screen.ui.type('Global dispatch limit (slots, 1–64)', '21');
    await waitFor(() => screen.writes.length === 2, 'the typed value to autosave');
    assert.deepEqual(screen.writes[1], { ...CAPACITY_VALUES, globalLimit: 21 }, 'the write carries every limit, so no untouched one is reset');
    await settle(() => saved(screen.ui));
    // The field takes digits only, and an out-of-range value is never sent while it is typed.
    const global = 'Global dispatch limit (slots, 1–64)';
    screen.ui.type(global, 'abc');
    assert.equal(screen.ui.get(global).props.value, '', 'letters never enter the field');
    for (const bad of ['0', '65']) screen.ui.type(global, bad);
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(screen.writes.length, 2, 'out-of-range input writes nothing while typed');
    // Ending typing clamps into the range, and that value saves.
    screen.ui.get(global).props.onBlur();
    assert.equal(screen.ui.get(global).props.value, '64', 'clamped to the ceiling');
    await waitFor(() => screen.writes.length === 3, 'the clamped value to autosave');
    assert.equal(screen.writes[2]!.globalLimit, 64);
    // The bounds hold the buttons too: the floor and ceiling are valid values that save.
    assert.equal(screen.ui.get('Increase Global dispatch limit (slots, 1–64)').props.accessibilityState.disabled, true, 'Increase stops at the ceiling');
    screen.ui.type(global, '1');
    await waitFor(() => screen.writes.length === 4, 'the floor value to autosave');
    assert.equal(screen.ui.get('Decrease Global dispatch limit (slots, 1–64)').props.accessibilityState.disabled, true, 'Decrease stops at the floor');
    // The Advanced timers use the same control; the unit reads after the field.
    screen.ui.press('Advanced limits');
    screen.ui.press('Increase Hold reminder dispatch limit (minutes, 1–10080)');
    await waitFor(() => screen.writes.length === 5, 'the advanced step to autosave');
    assert.equal(screen.writes.at(-1)!.holdReminderMinutes, 121);
    assert.ok(screen.ui.text().includes('min'), 'timer units stay beside the field');
  } finally { screen.ui.update(h('View', null)); screen.client.clear(); }
});

test('Spec 052: the usage slider lives under Dispatch limits, and saves a level with an end time picked from the calendar', async () => {
  await load();
  const sent: unknown[] = [];
  const ui = mount(screenTree(board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] }), undefined, false, input => sent.push(input)));
  selectSettingsTab(ui, 'Profiles');
  await settle(() => ui.text().includes('Live model'));
  assert.equal(ui.query('Usage level'), undefined, 'Profiles no longer carries the slider');
  ui.press('Dispatch limits');
  await settle(() => ui.text().includes('Usage level'));
  // Normal in force shows only when it differs from the level set, and the end time shows only above Normal.
  assert.doesNotMatch(ui.text(), /Normal in force/);
  assert.doesNotMatch(ui.text(), /until/);
  // The end-time field sits in a column: no flex basis to stretch it into a tall gap (Tom, 2026-10-22).
  assert.ok(!ui.ofType('View').some(node => node.props.style?.flexBasis === 280), 'no 280 px basis on the Limits page');
  for (const title of ['Usage level', 'Role demand', 'Task slots', 'Project overrides']) {
    const header = ui.ofType('Text').find(node => node.props.accessibilityRole === 'header' && node.children.join('') === title);
    assert.ok(header, `${title} section header`);
    // A long note or "Not saved" reason wraps below; it never squeezes the title (review #599).
    // A long title wraps inside its group rather than overflowing the section on a narrow layout (857 review evidence).
    assert.equal(header!.props.style.flexShrink, 1, `${title} wraps instead of overflowing`);
    assert.equal(header!.props.numberOfLines, undefined, `${title} is never truncated`);
    assert.ok(header!.props.style.minWidth >= 120);
  }
  assert.ok(ui.ofType('View').filter(node => node.props.style?.flexWrap === 'wrap' && node.props.style?.columnGap === 12).length >= 4, 'every section header row wraps');
  ui.press('Usage Maximum');
  await settle(() => /Runs need two extra capability steps/.test(ui.get('Usage level help').props.accessibilityHint));
  await waitFor(() => sent.length === 1, 'the level to save on press');
  assert.deepEqual(sent[0], { level: 'maximum', until: null });
  ui.press('Return to Normal: No end');
  await settle(() => ui.text().includes('In 1 week'));
  assert.ok(!ui.ofType('View').some(node => node.props.style?.width === 200), 'the end time is small text, not a field beside the slider (task 1014)');
  ui.press('In 3 days');
  ui.press('Minute 30');
  ui.press('Done');
  await settle(() => !ui.text().includes('In 1 week'));
  assert.equal(ui.query('Return to Normal: No end'), undefined, 'the link shows the picked local time');
  assert.equal(ui.query('Save usage level'), undefined, 'no save button: the end time saves when picked');
  await waitFor(() => sent.length === 2, 'the end time to save when picked');
  const saved = sent[1] as { level: string; until: string };
  assert.equal(saved.level, 'maximum');
  const until = new Date(saved.until);
  assert.equal(until.getMinutes(), 30);
  const days = (until.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 2.9 && days < 3.1, `about three days ahead, got ${days.toFixed(2)}`);
  unmount(ui);
});

test('Spec 053: Dispatch limits sets the role demand offsets within -4..+4 and autosaves all three once the presses settle', async () => {
  await load();
  const sent: unknown[] = [];
  const ui = mount(screenTree(board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] }), undefined, false, undefined, input => sent.push(input)));
  selectSettingsTab(ui, 'Profiles');
  await settle(() => ui.text().includes('Live model'));
  ui.press('Dispatch limits');
  await settle(() => Boolean(ui.query('Role demand offsets')));
  assert.equal(ui.get('coordinator demand offset').props.value, '−2', 'defaults: coordinator two steps below the task');
  assert.equal(ui.get('reviewer demand offset').props.value, '0');
  assert.equal(ui.query('Save role demand'), undefined, 'no save button');
  assert.equal(ui.query('Role demand save status'), undefined, 'no idle label: the status element appears only with a real status');
  ui.press('Lower reviewer demand');
  ui.press('Lower coordinator demand'); ui.press('Lower coordinator demand'); ui.press('Lower coordinator demand');
  await settle(() => ui.query('coordinator demand offset')?.props.value === '−4');
  assert.equal(ui.get('Lower coordinator demand').props.disabled, true, 'the floor is −4');
  await waitFor(() => sent.length === 1, 'the offsets to autosave');
  assert.deepEqual(sent[0], { worker: 0, reviewer: -1, coordinator: -4 }, 'quick presses land as one save');
  await waitFor(() => ui.get('Role demand save status').children.join('') === 'Saved', 'the saved status');
  unmount(ui);
});

test('Dispatch limits keeps explanations behind (?): hidden until hovered or pressed (Tom, 2026-10-22)', async () => {
  await load();
  const ui = mount(screenTree(board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] })));
  await settle(() => ui.query('Role demand help') !== undefined);
  // The descriptions are no longer on the page.
  for (const text of ["Each run needs the task's complexity", 'Parked tasks hold no slot', "A project's own slot limit", 'Runs need what the task needs'])
    assert.ok(!ui.text().includes(text), `"${text}" sits behind its (?)`);
  for (const title of ['Usage level', 'Role demand', 'Task slots', 'Project overrides']) {
    const help = ui.get(`${title} help`);
    assert.ok(help.props.accessibilityHint.length > 20, `${title} has its explanation as the (?) hint`);
    assert.equal(ui.query(`${title} help text`), undefined, `${title} help is closed by default`);
  }
  // Pressing pins it open; pressing again closes it. Hover opens it too.
  ui.press('Task slots help');
  await settle(() => Boolean(ui.query('Task slots help text')));
  assert.match(ui.text(), /Parked tasks hold no slot/);
  ui.press('Task slots help');
  await settle(() => !ui.query('Task slots help text'));
  ui.get('Role demand help').props.onHoverIn();
  await settle(() => Boolean(ui.query('Role demand help text')));
  ui.get('Role demand help').props.onHoverOut();
  await settle(() => !ui.query('Role demand help text'));
  // Review #600: a press closes a tip that hover or focus opened, and it stays closed until the pointer leaves.
  ui.get('Usage level help').props.onHoverIn();
  await settle(() => Boolean(ui.query('Usage level help text')));
  ui.press('Usage level help');
  await settle(() => !ui.query('Usage level help text'));
  ui.get('Usage level help').props.onHoverIn();
  await tick(); await tick();
  assert.equal(ui.query('Usage level help text'), undefined, 'still hovered after closing: stays closed');
  ui.get('Usage level help').props.onHoverOut();
  ui.get('Usage level help').props.onHoverIn();
  await settle(() => Boolean(ui.query('Usage level help text')), );
  ui.get('Usage level help').props.onFocus?.(); ui.press('Usage level help');
  await settle(() => !ui.query('Usage level help text'));
  // Review #600: the panel spans its section's header row (capped at 420 px), never a fixed width that overflows a compact layout.
  ui.press('Task slots help');
  await settle(() => Boolean(ui.query('Task slots help text')));
  assert.equal(ui.get('Task slots help text').props.style.maxWidth, 420);
  assert.ok(!ui.ofType('View').some(node => node.props.style?.width === 300), 'no fixed-width help panel');
  assert.ok(ui.ofType('View').some(node => node.props.style?.position === 'absolute' && node.props.style?.left === 0 && node.props.style?.right === 0), 'the panel is laid against both edges of its section');
  unmount(ui);
});

test('Spec 052: a usage expiry projected while the end-time picker is open keeps the picker and the draft', async () => {
  await load();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const state = board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] }) as ReturnType<typeof board> & { usage: unknown };
  state.usage = { level: 'maximum', setLevel: 'maximum', until, expired: false };
  const ui = mount(screenTree(state));
  await settle(() => Boolean(ui.query('Usage High')) && ui.text().includes('until'));
  ui.press('Usage High');
  ui.press(/^Return to Normal: until /);
  await settle(() => ui.text().includes('In 1 week'));
  // The level expires on the host; the next poll re-projects the board.
  state.usage = { level: 'normal', setLevel: 'maximum', until, expired: true };
  const deadline = Date.now() + 9000;
  while (!ui.text().includes('Normal in force') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(ui.text(), /Normal in force/, 'the header shows the expiry');
  assert.match(ui.text(), /In 1 week/, 'the picker stays open');
  assert.match(ui.get('Usage level help').props.accessibilityHint, /Runs need one extra capability step/, 'the edited level draft survives');
  unmount(ui);
});

test('settings tabs show the short labels and keep full accessible names', async () => {
  await load();
  const ui = mount(screenTree(board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] })));
  await settle(() => ui.query('Settings sections') !== undefined);
  const sections = ui.get('Settings sections') as Node;
  assert.equal(sections.type, 'View', 'one row of tabs, no scroller');
  assert.equal(sections.props.style.flexWrap, 'nowrap', 'the tabs never wrap');
  for (const [full, short] of [['Profiles', 'Profiles'], ['Dispatch limits', 'Limits']]) {
    const tab = ui.get(full) as Node;
    assert.ok(sections.children.some(node => typeof node !== 'string' && node.props.accessibilityLabel === full), `${full} is a tab`);
    assert.equal(ui.ofType('Text').some(node => node.children.join('') === short), true, `${full} shows as ${short}`);
    assert.equal(tab.props.accessibilityRole, 'button');
  }
  unmount(ui);
});

test('Spec 052: a profile row shows a status only for a problem; a frontier profile shows none at any level, and the editor has no By request', async () => {
  await loadBundle();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const pool = [
    poolSchema.parse({ profileId: 'frontier', group: 'frontier', enabled: true, scopes: ['general'], cost: 'very_high', capability: 'frontier', weight: 1 }),
    poolSchema.parse({ profileId: 'cheap', group: 'cheap', enabled: true, scopes: ['general'], cost: 'low', capability: 'frontier', weight: 1 }),
    poolSchema.parse({ profileId: 'off', group: 'off', enabled: false, scopes: ['general'], cost: 'very_high', capability: 'frontier', weight: 1 }),
    poolSchema.parse({ profileId: 'gone', group: 'gone', enabled: true, scopes: ['general'], cost: 'very_high', weight: 1 }),
  ];
  let state = board({ profiles: [profile('frontier', 'Frontier Opus with a long profile name'), profile('cheap', 'Cheap'), profile('off', 'Off'), { ...profile('gone', 'Gone'), available: false, problem: 'Provider missing' }], pool }) as ReturnType<typeof board> & { usage: unknown };
  state.usage = { level: 'maximum', setLevel: 'maximum', until, expired: false };
  const writes: string[] = [];
  const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  const invoke = async (method: string) => {
    if (method === 'queue.ui-snapshot') return state;
    if (method === 'backup.list') return { snapshots: [], localError: null };
    if (method === 'queue.capacity-state') return capacityAuthorityState();
    writes.push(method);
    return {};
  };
  const status = (ui: ReturnType<typeof mount>, name: string) => ui.ofType('Pressable').find(node => String(node.props.accessibilityLabel ?? '').startsWith(`${name}: `))?.props.accessibilityLabel?.toString().slice(name.length + 2) ?? '';
  for (const compact of [false, true]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    state = { ...state, usage: { level: 'maximum', setLevel: 'maximum', until, expired: false } };
    const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never,
      children: h(settings.QueueSettingsScreen as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact, platform: 'ios' as const } }) }) }));
    try {
      selectSettingsTab(ui, 'Profiles');
      await settle(() => ui.text().includes('Frontier Opus'));
      assert.equal(ui.get('Nucleus settings').props.style.backgroundColor, dark.surface0);
      assert.equal(status(ui, 'Frontier Opus with a long profile name'), '', 'a frontier profile has no status');
      assert.equal(status(ui, 'Cheap'), '', 'needing a request is not a row status');
      assert.equal(status(ui, 'Off'), '', 'an off profile has no status');
      assert.equal(status(ui, 'Gone'), 'Unavailable');
      assert.doesNotMatch(ui.text(), /Usage policy:|Cost: very high|· relative share|Changes save automatically|Profile notes/);
      state = { ...state, revision: state.revision + 1, usage: { level: 'normal', setLevel: 'maximum', until, expired: true } };
      await client.refetchQueries({ queryKey: ['nucleus', 'state'], exact: true });
      // A refetch is async: wait on the clock, not on a fixed count of immediate ticks, so the probe cannot race it.
      await waitFor(() => status(ui, 'Gone') === 'Unavailable', 'the refetch to settle');
      assert.equal(status(ui, 'Frontier Opus with a long profile name'), '', 'still no status at Normal');
      assert.equal(status(ui, 'Gone'), 'Unavailable', 'unavailable still shows at Normal');
      ui.press('Edit Frontier Opus with a long profile name');
      await settle(() => Boolean(ui.query('Capability help')));
      assert.equal(ui.query('Selection by request'), undefined, 'By request is retired (Tom, 2026-11-09)');
      assert.match(ui.get('Capability help').props.accessibilityHint, /Frontier runs only on request below Maximum/);
      assert.match(ui.get('Cost help').props.accessibilityHint, /Unset ranks as medium and is never cost-gated/);
      assert.doesNotMatch(ui.text(), /Each cost step down|Each run needs the task's complexity|Weight 2 receives|By request/);
      assert.equal(ui.query('Save Frontier Opus with a long profile name'), undefined);
      assert.equal(ui.query('Cancel'), undefined);
      assert.ok(ui.get('Remove Frontier Opus with a long profile name'), 'Remove is an icon action in the editor header');
      assert.deepEqual(writes.filter(method => method === 'queue.profile' || method === 'queue.pool'), [], 'reading the policy writes nothing');
    } finally { ui.update(h('View', null)); client.clear(); }
  }
});

test('Spec 028: only the Backups tab lists snapshots, and the stale warning rides the board projection', async () => {
  await loadBundle();
  const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  // Eight hours old: past the seven-hour stale threshold, and known to the board rather
  // than to a `backup.list` poll of its own (2026-10-25 performance audit).
  const newestSnapshotAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const state = board({ backup: { newestSnapshotAt, localError: null } });
  const listed: string[] = [];
  const invoke = async (method: string) => {
    if (method === 'queue.ui-snapshot') return state;
    if (method === 'backup.list') { listed.push(method); return { snapshots: [], localError: null }; }
    return {};
  };
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, { invoke: invoke as never, children: h(settings.QueueSettingsScreen as never, {
      theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
    }) }),
  }));
  try {
    assert.equal(ui.get('Nucleus settings').props.style.backgroundColor, dark.surface0, 'the installed shape renders in the dark host theme');
    await settle(() => /Newest verified backup 4\d\d min ago/.test(ui.text()));
    assert.deepEqual(listed, [], 'the Profiles tab never polls the snapshot list');
    ui.press('Backups');
    await settle(() => listed.length > 0);
    assert.match(ui.text(), /Newest verified 8 h ago · next due now/, 'the Backups tab reads the listing in place');
    assert.match(ui.text(), /Newest verified snapshot is 8 h old/, 'a stale snapshot reads as a warning on the Backups tab');
  } finally { unmount(ui); }
});

test('Spec 028: an absent Builds volume shows the outage everywhere, never an empty-snapshot waiting message', async () => {
  await loadBundle();
  const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  // The real absent-volume shape: no snapshot at all, and the reason recorded beside the store.
  const outage = 'Backup volume unavailable: /Volumes/retired-volume is not mounted (ENOENT)';
  const state = board({ backup: { newestSnapshotAt: null, localError: outage } });
  const invoke = async (method: string) => {
    if (method === 'queue.ui-snapshot') return state;
    if (method === 'backup.list') return { snapshots: [], localError: null };
    return {};
  };
  const ui = mount(h(QueryClientProvider, {
    client: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    children: h(PluginRpcProvider, { invoke: invoke as never, children: h(settings.QueueSettingsScreen as never, {
      theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const },
    }) }),
  }));
  try {
    // The warning on another tab names the outage. "No verified backup yet" would read as
    // "waiting for the first snapshot", which hides a volume that is away (row 5).
    await waitFor(() => Boolean(ui.query('Backups are failing help')), 'backup warning');
    assert.ok(!/No verified backup yet/.test(ui.text()), 'an outage is not reported as an empty snapshot');
    assert.equal(ui.get('Backups are failing help').props.accessibilityHint, outage, 'the host error waits behind the ? popover');
    ui.press('Backups');
    await waitFor(() => ui.text().includes(`No verified snapshot: ${outage}`), 'backup warning');
    // nucleus#965: on the Backups page the outage is one warning line with its reason.
    assert.doesNotMatch(ui.text(), /No snapshots yet/, 'the empty-listing message never shows during an outage (Spec 028)');
  } finally { unmount(ui); }
});

test('Subscriptions: a group row names only its state; its counts and pause sit in the opened editor', async () => {
  await load();
  const ui = mount(screenTree(board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] })));
  try {
    selectSettingsTab(ui, 'Profiles');
    await settle(() => Boolean(ui.all(/^Pause /)[0]));
    assert.ok(contains(ui.get('Subscriptions') as Node, 'Pause subscription'), 'the groups sit in the Subscriptions section on Profiles');
    assert.doesNotMatch(ui.text(), /recent ·/, 'no counts on the row');
    assert.equal(ui.query('Mark unavailable'), undefined, 'the pause is folded until the group is opened');
    ui.press(/^Pause /);
    await settle(() => ui.text().includes('recent ·'));
    assert.match(ui.text(), /Reason/);
    assert.ok(ui.get('Retry at'), 'the retry field is named plainly');
  } finally { unmount(ui); }
});

test('a problem shows an unboxed warning glyph; needing a request shows no glyph now By request is retired', async () => {
  await load();
  const dark = { accent: '#1f6feb', accentForeground: '#ffffff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusWarning: '#f0883e', statusDanger: '#f85149' };
  const state = board({
    profiles: [profile('paused', 'GLM 5.3 Flash'), profile('oracle', 'Opus Oracle'), profile('both', 'Paused oracle')],
    pool: [
      poolSchema.parse({ profileId: 'paused', group: 'zai', enabled: true, scopes: ['general'], weight: 1 }),
      poolSchema.parse({ profileId: 'oracle', group: 'anthropic', enabled: true, scopes: ['general'], cost: 'very_high', capability: 'frontier', weight: 1 }),
      poolSchema.parse({ profileId: 'both', group: 'zai', enabled: true, scopes: ['general'], cost: 'very_high', capability: 'frontier', weight: 1 }),
    ],
    availability: [{ group: 'zai', unavailable: true, reason: 'weekly limit', retryAt: new Date(Date.now() + 3_600_000).toISOString() }],
  });
  const ui = mount(h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }), children: h(PluginRpcProvider, {
    invoke: (async (method: string) => method === 'queue.ui-snapshot' ? state : method === 'backup.list' ? { snapshots: [], localError: null } : method === 'queue.capacity-state' ? capacityAuthorityState() : {}) as never,
    children: h(settings.QueueSettingsScreen as never, { theme: { colors: dark }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } }) }) }));
  try {
    selectSettingsTab(ui, 'Profiles');
    await settle(() => ui.text().includes('Paused oracle'));
    const node = ui.get('GLM 5.3 Flash: Subscription paused') as Node;
    const icon = node.children.find((child): child is Node => typeof child !== 'string' && child.props.name !== undefined)!;
    assert.deepEqual([icon.props.name, icon.props.color], ['TriangleAlert', dark.statusWarning], 'a paused subscription reads as a warning');
    assert.equal(node.props.style.backgroundColor, undefined, 'no button box');
    assert.notEqual(node.props.accessibilityRole, 'button');
    assert.equal(ui.query('Opus Oracle: Needs a request'), undefined, 'a frontier profile shows no status');
    assert.equal(ui.query('Opus Oracle: Subscription paused'), undefined);
    const name = ui.ofType('Text').find(item => item.children.join('') === 'Paused oracle')!;
    const rowLabels = ui.ofType('View').find(view => view.children.includes(name))!.children.filter((child): child is Node => typeof child !== 'string' && child !== name).map(child => child.props.accessibilityLabel);
    assert.deepEqual(rowLabels, ['Paused oracle: Subscription paused', 'Disable Paused oracle', 'Edit Paused oracle'], 'the warning, then On/Off and Edit');
    node.props.onHoverIn();
    await settle(() => ui.text().includes('Subscription paused'));
    assert.match(ui.text(), /Subscription paused/, 'the tooltip names the status');
  } finally { unmount(ui); }
});

test('the opened editor autosaves pool fields and keeps Remove at the bottom with a confirmation', async () => {
  await load();
  const saved: unknown[] = [];
  const ui = mount(screenTree(board({
    profiles: [profile('live', 'Live model')],
    pool: [entry('live')],
  }), input => saved.push(input)));
  try {
    selectSettingsTab(ui, 'Profiles');
    await settle(() => ui.text().includes('Live model'));
    assert.equal(ui.query('Remove Live model'), undefined);
    ui.press('Edit Live model');
    await settle(() => Boolean(ui.query('Cost help')) && Boolean(ui.query('Remove Live model')));
    assert.equal(ui.query('Save Live model'), undefined);
    assert.equal(ui.query('Cancel'), undefined);
    assert.doesNotMatch(ui.text(), /Changes save automatically|Profile notes|Usage policy:/);
    ui.press('Cost high');
    await waitFor(() => saved.some(value => value && typeof value === 'object' && 'cost' in (value as object)), 'cost to autosave');
    const costWrite = saved.find(value => value && typeof value === 'object' && (value as { cost?: string }).cost === 'high') as { profileId: string; cost: string };
    assert.equal(costWrite.profileId, 'live');
    assert.equal(ui.query('Advanced'), undefined, 'subscription and weight are directly visible');
    await settle(() => Boolean(ui.query('Decrease weight for Live model')));
    ui.press('Increase weight for Live model');
    await waitFor(() => saved.some(value => value && typeof value === 'object' && (value as { weight?: number }).weight === 2), 'weight to autosave');
    assert.match(ui.get('Weight help').props.accessibilityHint, /Recent assignments: 0; total assignments: 0/);
    ui.press('Remove Live model');
    await settle(() => Boolean(ui.query('Confirm removing Live model')));
    assert.match(ui.text(), /Remove Live model\?/);
    ui.press('Keep Live model');
    await settle(() => !ui.query('Confirm removing Live model'));
    assert.ok(ui.get('Remove Live model'));
  } finally { unmount(ui); }
});

type Node = { type: string; props: Record<string, any>; children: Array<Node | string> };
const contains = (node: Node, label: string | RegExp): boolean => node.children.some(child => typeof child !== 'string'
  && ((typeof label === 'string' ? child.props.accessibilityLabel === label : label.test(String(child.props.accessibilityLabel ?? ''))) || contains(child, label)));
/** The half-width column holding a control: a flex-1 View with a minWidth (0 beside its pair, 100% stacked). */
function columnOf(ui: ReturnType<typeof mount>, label: string | RegExp) {
  const column = (ui.ofType('View') as Node[]).filter(node => node.props.style?.flex === 1 && 'minWidth' in (node.props.style ?? {}) && contains(node, label)).at(-1);
  assert.ok(column, `a column for ${label}`);
  return column;
}
async function openEditor(name = 'Live model') {
  await load();
  const saved: unknown[] = [];
  const ui = mount(screenTree(board({
    profiles: [profile('live', name)],
    pool: [{ ...entry('live'), cost: 'high' }],
  }), input => saved.push(input)));
  selectSettingsTab(ui, 'Profiles');
  await settle(() => ui.text().includes(name));
  ui.press(`Edit ${name}`);
  await settle(() => Boolean(ui.query('Cost help')));
  return { ui, saved };
}
const layoutEditor = (ui: ReturnType<typeof mount>, width: number, name = 'Live model') =>
  ui.get(`${name} editor`).props.onLayout({ nativeEvent: { layout: { width } } });

test('the editor pairs Provider | Model and Cost | Capability from its own width, stacking only on a phone', async () => {
  const { ui } = await openEditor();
  try {
    const pairs = [[/^Provider, /, /^Model, /], ['Cost value', 'Capability value']] as const;
    const minWidths = () => pairs.flat().map(label => columnOf(ui, label).props.style.minWidth);
    // Paseo's settings column measures about 640: the screen is compact, the editor still pairs.
    setSettingsWidth(ui, 640);
    assert.ok(ui.query('Settings sections'), 'the tab row shows at the Paseo settings width');
    for (const width of [0, 610, 1280]) {
      layoutEditor(ui, width);
      assert.deepEqual(minWidths(), [0, 0, 0, 0], `paired at an editor width of ${width}`);
    }
    layoutEditor(ui, 358);
    assert.deepEqual(minWidths(), Array(4).fill('100%'), 'stacked at a phone width');
  } finally { unmount(ui); }
});

/** The direct View children of a row, each a column. */
const columns = (node: Node) => node.children.filter((child): child is Node => typeof child !== 'string' && child.type === 'View');

test('Name shares the first row with Duplicate and Remove, with no caption above it', async () => {
  const { ui } = await openEditor();
  try {
    for (const width of [688, 390]) {
      layoutEditor(ui, width);
      const nameRow = ui.get('Profile name row') as Node;
      assert.equal(nameRow.props.style.flexWrap, 'nowrap', `one row at ${width}`);
      assert.ok(contains(nameRow, 'Name') && contains(nameRow, 'Duplicate Live model') && contains(nameRow, 'Remove Live model'), `Name, Duplicate and Remove share the row at ${width}`);
      const name = ui.get('Name');
      assert.equal(name.props.placeholder, 'Name', 'the placeholder carries the name');
      assert.equal(ui.ofType('Text').some(node => node.children.join('') === 'Name'), false, 'no separate Name caption');
      const editor = ui.get('Live model editor') as Node;
      assert.equal(columns(editor)[0], nameRow, 'the Name row is the editor\'s first row');
    }
  } finally { unmount(ui); }
});

test('Subscription and Weight take half the second row each, aligned at field height; By request is gone', async () => {
  const { ui, saved } = await openEditor();
  try {
    layoutEditor(ui, 688);
    const dispatchRow = ui.get('Profile dispatch row') as Node;
    const [subscription, weight, ...more] = columns(dispatchRow);
    assert.equal(more.length, 0, 'two columns only');
    assert.deepEqual([subscription.props.style.flex, subscription.props.style.minWidth, weight.props.style.flex, weight.props.style.minWidth], [1, 0, 1, 0], 'Subscription and Weight split the row in half');
    assert.ok(contains(subscription, 'Subscription'));
    assert.ok(contains(weight, 'Weight help') && contains(weight, 'Weight for Live model'), 'Weight is the shared number control with its ?');
    assert.equal(ui.query('Selection by request'), undefined, 'By request is retired (Tom, 2026-11-09)');
    assert.doesNotMatch(ui.text(), /By request/);
    assert.equal(dispatchRow.props.style.alignItems, 'flex-end', 'the controls line up along their bottom edge');
    const stepper = (ui.ofType('View') as Node[]).filter(node => node.props.style?.justifyContent === 'center' && contains(node, 'Weight for Live model')).at(-1)!;
    const subscriptionHeight = ui.get('Subscription').props.style.minHeight;
    assert.equal(subscriptionHeight, 36, 'the Subscription input is at the one control height');
    assert.equal(stepper.props.style.minHeight, subscriptionHeight, 'the stepper sits in a box as tall as the Subscription input');
    layoutEditor(ui, 358);
    assert.equal(subscriptionMin(ui), '100%', 'on a phone Subscription takes the whole row');
    assert.equal(columns(ui.get('Profile dispatch row') as Node)[1].props.style.minWidth, '100%', 'Weight takes the next row');
    ui.press('Increase weight for Live model');
    await waitFor(() => saved.some(value => (value as { weight?: number })?.weight === 2), 'weight to autosave');
    assert.equal(saved.some(value => value && typeof value === 'object' && 'byRequest' in (value as object)), false, 'no write carries the retired flag');
  } finally { unmount(ui); }
});
const subscriptionMin = (ui: ReturnType<typeof mount>) => columns(ui.get('Profile dispatch row') as Node)[0].props.style.minWidth;

test('Cost and Capability are sliders with the chosen value beside the label, no stop labels, and an unset value marks no stop', async () => {
  const { ui, saved } = await openEditor();
  try {
    const cost = ui.get(/^Cost slider, /), capability = ui.get(/^Capability slider, /);
    assert.equal(cost.props.accessibilityRole, 'adjustable');
    assert.equal(cost.props.accessibilityLabel, 'Cost slider, High');
    assert.equal(cost.props.accessibilityValue.now, 3);
    assert.equal(capability.props.accessibilityLabel, 'Capability slider, not set');
    assert.equal(capability.props.accessibilityValue.now, undefined, 'unset marks no stop');
    assert.equal(ui.get('Cost high').props.accessibilityState.selected, true);
    assert.equal(ui.query('Cost help') !== undefined && ui.query('Capability help') !== undefined, true, 'a ? beside each name');
    assert.equal(ui.get('Cost value').children.join(''), 'High', 'the chosen cost sits at the right of its label row');
    assert.equal(ui.get('Capability value').children.join(''), 'Unset');
    const costLabelRow = (ui.ofType('View') as Node[]).filter(node => node.props.style?.flexWrap === 'nowrap' && contains(node, 'Cost help') && contains(node, 'Cost value')).at(-1);
    assert.ok(costLabelRow, 'the value shares the label row');
    assert.doesNotMatch(ui.text(), /Very low|Very high|\bMedium\b/, 'no stop labels under either slider');
    capability.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    await waitFor(() => saved.some(value => (value as { capability?: string })?.capability === 'medium'), 'an adjust from unset to start at medium, as unset counts');
    // Tom, 2026-11-09: five capability stops, low to frontier; very low is gone.
    assert.deepEqual(['low', 'medium', 'high', 'very high', 'frontier'].map(stop => Boolean(ui.query(`Capability ${stop}`))), [true, true, true, true, true]);
    assert.equal(ui.query('Capability very low'), undefined, 'no very low stop');
    assert.equal(capability.props.accessibilityValue.max, 4);
    ui.press('Capability frontier');
    await waitFor(() => saved.some(value => (value as { capability?: string })?.capability === 'frontier'), 'the frontier stop to autosave');
    await settle(() => ui.get('Capability value').children.join('') === 'Frontier');
    assert.equal(ui.get('Capability value').children.join(''), 'Frontier', 'the chosen value shows at the right of the label');
    assert.match(ui.get('Capability help').props.accessibilityHint, /Frontier runs only on request below Maximum/);
    ui.press('Cost very low');
    await waitFor(() => saved.some(value => (value as { cost?: string })?.cost === 'very_low'), 'a stop press to autosave');
  } finally { unmount(ui); }
});

test('a long profile name keeps Duplicate and Remove on the Name row', async () => {
  const name = 'A very long profile name that goes on well past the width of the settings column on any phone';
  const { ui } = await openEditor(name);
  try {
    layoutEditor(ui, 358, name);
    const nameRow = ui.get('Profile name row') as Node;
    assert.equal(nameRow.props.style.flexWrap, 'nowrap', 'Name and the actions share one non-wrapping row');
    assert.ok(contains(nameRow, 'Name') && contains(nameRow, `Remove ${name}`));
    assert.equal(ui.get('Name').props.value, name);
  } finally { unmount(ui); }
});

test('every Settings section aligns with the tab row: no inner side padding at any width', async () => {
  await load();
  const ui = mount(screenTree(board({ profiles: [profile('live', 'Live model')], pool: [entry('live')] })));
  try {
    for (const width of [390, 640, 1280]) {
      setSettingsWidth(ui, width);
      for (const section of ['Dispatch limits', 'Profiles', 'Projects', 'Backups', 'Telemetry']) {
        selectSettingsTab(ui, section);
        await tick();
        let checked = 0;
        for (const node of [...ui.ofType('ScrollView'), ...ui.ofType('View')] as Node[]) {
          const style = node.props.style ?? {};
          if (node.props.accessibilityLabel === 'Settings sections') continue;
          if (style.flex === 1 && (style.minHeight === 0)) {
            checked++;
            assert.equal(style.marginHorizontal ?? 0, 0, `${section} at ${width}: no side margin`);
            assert.equal(style.paddingHorizontal ?? 0, 0, `${section} at ${width}: no side padding`);
          }
        }
        assert.ok(checked > 0, `${section} at ${width}: its content column was checked`);
        assert.equal(ui.get('Nucleus settings').props.style.paddingHorizontal ?? 0, 0);
        assert.equal(ui.query('Store backups')?.props.style.paddingHorizontal ?? 0, 0);
      }
    }
  } finally { unmount(ui); }
});

test('a stop slider is one continuous track with stops and labels placed at their own positions', async () => {
  const { ui } = await openEditor();
  try {
    const slider = ui.get(/^Cost slider, /) as Node;
    const nodes = slider.children.filter((child): child is Node => typeof child !== 'string');
    const tracks = nodes.filter(node => node.type === 'View');
    assert.equal(tracks.length, 2, 'one base track and one fill, nothing between the stops');
    assert.deepEqual([tracks[0].props.style.left, tracks[0].props.style.right], [0, 0], 'the base track spans first to last stop');
    assert.equal(tracks[1].props.style.width, '75%', 'the fill reaches the chosen stop (High, 3 of 4)');
    const stops = nodes.filter(node => node.props.accessibilityRole === 'button');
    assert.deepEqual(stops.map(stop => stop.props.style.left), ['0%', '25%', '50%', '75%', '100%']);
    for (const stop of stops) {
      assert.equal(stop.props.style.position, 'absolute', 'targets overlay the track instead of splitting it');
      assert.equal(stop.props.style.width, 44);
      assert.equal(stop.props.style.marginLeft, -22, 'each target is centred on its stop');
    }
    const ring = (label: string) => (ui.get(label).children[0] as Node).props.style;
    assert.equal(ring('Cost very high').borderWidth, 1, 'an unfilled stop keeps a thin ring');
    assert.equal(ring('Cost high').width, 18, 'the chosen stop is larger');
    assert.equal(ring('Cost high').borderWidth, 2);
  } finally { unmount(ui); }
});
