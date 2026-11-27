import { test } from 'node:test';

const iconOf = (node: { type: string; props: Record<string, any>; children: unknown[] }): string | undefined => {
  if (node.type === 'Icon') return node.props.name;
  for (const child of node.children) if (typeof child !== 'string') { const found = iconOf(child as never); if (found) return found; }
  return undefined;
};
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs, type HostNode } from './support/render';
import { type ProjectSettings, type ProjectSettingsRow } from '../shared/contracts';

useNativeStubs();
const h = React.createElement;
const syntheticHome = ["", "Users", "example"].join("/");
const dark = { accent: '#1f6feb', accentForeground: '#fff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusSuccess: '#3fb950', statusWarning: '#f0883e', statusDanger: '#f85149' } as never;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(probe: () => boolean, label = 'screen') {
  for (const deadline = Date.now() + 3_000; Date.now() < deadline;) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${label} did not settle`);
}
const contains = (node: HostNode | string, label: string): boolean => typeof node !== 'string' && (node.props.accessibilityLabel === label || node.children.some(child => contains(child, label)));
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');

const repo = (origin: string, path = `/workspace/user/Dev/${origin.split('/')[1]}`) => ({ origin, path });
function row(key: string, name: string, repos: Array<{ origin: string | null; path: string }>, extra: Partial<ProjectSettingsRow> = {}): ProjectSettingsRow {
  return {
    project: { key, name, version: 1, repositories: repos, primary: repos[0]!, drain: null },
    repositories: repos.map((repository, index) => ({ repository, primary: index === 0, settings: null })),
    slots: { value: 4, override: null }, plannerLive: null, plannerTicket: null, problems: [],
    ...extra,
  } as ProjectSettingsRow;
}
const implicit = (origin: string, extra: Partial<ProjectSettingsRow> = {}) =>
  row(`repo-${Buffer.from(origin).toString('hex').padEnd(20, '0').slice(0, 20)}`, origin.split('/')[1]!, [repo(origin)], extra);
const settingsOf = (projects: ProjectSettingsRow[]): ProjectSettings => ({ defaultSlots: 4, projects });

const board = { revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 5,  tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [], projectLimitOverrides: {}, projectInFlightLimitOverrides: {}, projectCapacities: [], prStates: {}, usage: { level: 'normal', setLevel: 'normal', until: null, expired: false }, backup: { newestSnapshotAt: new Date().toISOString(), localError: null } };

async function screen(width: number, invoke: (method: string, input: unknown) => Promise<unknown>) {
  const { QueueSettingsScreen } = await import('../client/settings-screen');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never, children: h(QueueSettingsScreen as never, { theme: { colors: dark }, layout: { compact: false, platform: 'ios' }, host: { id: 'host', label: 'Host' } }) }) }));
  ui.get('Nucleus settings').props.onLayout({ nativeEvent: { layout: { width } } });
  return ui;
}
function openProjects(ui: Awaited<ReturnType<typeof screen>>, width: number) {
  void width;
  ui.press('Projects');
}
const done = (ui: { update(next: React.ReactElement): void }) => ui.update(h('View'));

test('helpers: sorted by name, filter by name or repository, implicit repositories, derived keys and host paths', async () => {
  const { sortProjectRows, filterProjectRows, implicitRepositories, projectKeyFor, withoutHostPaths } = await import('../client/projects-settings');
  const rows = [implicit('acme/zeta'), row('consumer-app', 'Consumer-App', [repo('acme/sound')]), implicit('acme/alpha'), row('project-c', 'Project-C', [repo('acme/project-c'), repo('acme/project-f')])];
  assert.deepEqual(sortProjectRows(rows).map(entry => entry.project.name), ['alpha', 'Consumer-App', 'Project-C', 'zeta']);
  assert.deepEqual(filterProjectRows(rows, 'PROJECT-F').map(entry => entry.project.name), ['Project-C'], 'a repository name matches too');
  assert.deepEqual(filterProjectRows(rows, '  ').length, 4);
  const renamed = implicit('acme/renamed'); renamed.project.name = 'Renamed by operator';
  assert.deepEqual(implicitRepositories([...rows, renamed]).map(entry => entry.origin), ['acme/alpha', 'acme/zeta'],
    'only implicit projects still named after their repository; named and renamed projects are not offered');
  assert.equal(projectKeyFor('Nucleus UI', []), 'nucleus-ui');
  assert.equal(projectKeyFor('Nucleus', ['nucleus', 'nucleus-2']), 'nucleus-3', 'a numeric suffix on collision');
  assert.equal(projectKeyFor('2026 plans', []), 'project-2026-plans', 'a key starts with a letter');
  assert.equal(projectKeyFor('✨', []), 'project');
  assert.equal(projectKeyFor('Café Ünïcode', []), 'cafe-unicode');
  assert.match(projectKeyFor('x'.repeat(300), []), /^x{1,60}$/);
  assert.equal(withoutHostPaths(`Repository ${syntheticHome}/Dev/book already belongs to project book`), 'Repository book already belongs to project book');
  assert.equal(withoutHostPaths('acme/app already belongs to project project-c'), 'acme/app already belongs to project project-c', 'an owner/name is not a path');
});

test('wide and narrow: one-line rows sorted by name, one problem icon with its tooltip in the overlay layer', async () => {
  const long = 'A project name long enough to run past the settings column on a phone and keep going';
  const data = settingsOf([
    implicit('acme/book'),
    row('nucleus', 'Nucleus', [repo('acme/nucleus')], { problems: ['Planner thread is gone', 'Planner ticket pending'] }),
    row('consumer-app', 'Consumer-App', [repo('acme/sound')], { problems: ['No planner'] }),
    row('long', long, [repo('acme/long')]),
  ]);
  for (const width of [1024, 390]) {
    const ui = await screen(width, async method => method === 'queue.ui-snapshot' ? board : method === 'project.settings' ? data : method === 'backup.list' ? { snapshots: [], localError: null } : {});
    await settle(() => ui.text().includes('Usage level'), 'limits');
    openProjects(ui, width);
    await settle(() => ui.text().includes('Consumer-App'), 'projects');
    const labels = ui.all(/^(book|Nucleus|Consumer-App|A project name[^,]*)(,|$)/).map(node => node.props.accessibilityLabel);
    assert.deepEqual(labels, [`${long}`, 'book', 'Consumer-App, No planner', 'Nucleus, Planner thread is gone, Planner ticket pending'], `${width}: sorted by name, problems in the row label`);
    const longName = ui.ofType('Text').find(node => textOf(node) === long)!;
    assert.equal(longName.props.numberOfLines, 1, `${width}: a long name stays on one line`);
    assert.doesNotMatch(ui.text(), /repo-|\/workspace\/user|acme\//, `${width}: no keys, paths or origins on the rows`);
    assert.equal(ui.all('Nucleus problems').length, 1, `${width}: one icon however many problems`);
    assert.equal(ui.query('book problems'), undefined, `${width}: no icon without a problem`);
    assert.equal(ui.query('Filter projects'), undefined, `${width}: no filter at 4 rows`);
    const layer = () => ui.ofType('View').find(node => node.props.testID === 'nucleus-popover-layer')!;
    ui.press('Nucleus problems');
    assert.ok(contains(layer(), 'Nucleus problems help text'), `${width}: the tooltip renders in the overlay layer`);
    assert.match(textOf(layer()), /Planner thread is gone\nPlanner ticket pending/, `${width}: worst first, one per line`);
    ui.get('Nucleus problems').props.onBlur();
    assert.equal(ui.query('Nucleus problems help text'), undefined);
    ui.get('Nucleus problems').props.onHoverIn();
    assert.ok(ui.query('Nucleus problems help text'), `${width}: hover opens it too`);
    done(ui);
  }
});

test('the filter appears above 12 rows and matches names', async () => {
  const many = Array.from({ length: 13 }, (_, index) => implicit(`acme/repo${String(index).padStart(2, '0')}`));
  const { ProjectsSection } = await import('../client/projects-settings');
  const { PopoverHost } = await import('../client/popover');
  const render = (projects: ProjectSettingsRow[]) => h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, h(PluginRpcProvider, { invoke: async () => assert.fail('no RPC here'), children: h(PopoverHost, null, h(ProjectsSection, { c: dark, compact: false, inset: 24, query: { data: settingsOf(projects), error: null, isPending: false, refetch: () => {} } })) }));
  const twelve = mount(render(many.slice(0, 12)));
  assert.equal(twelve.query('Filter projects'), undefined, '12 rows: no filter');
  done(twelve);
  const ui = mount(render(many));
  assert.equal(ui.get('Filter projects').props.placeholder, 'Filter');
  ui.type('Filter projects', 'repo07');
  assert.deepEqual(ui.all(/^repo07$/).map(node => node.props.accessibilityLabel), ['repo07']);
  ui.type('Filter projects', 'nothing like it');
  assert.match(ui.text(), /No projects match/);
  done(ui);
});

test('loading, empty, failure with Retry, and a stale list that keeps its rows', async () => {
  const { ProjectsSection } = await import('../client/projects-settings');
  const { PopoverHost } = await import('../client/popover');
  let retried = 0;
  const render = (query: { data: ProjectSettings | undefined; error: unknown; isPending: boolean }) =>
    h(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, h(PluginRpcProvider, { invoke: async () => assert.fail('no RPC here'), children: h(PopoverHost, null, h(ProjectsSection, { c: dark, compact: true, inset: 16, query: { ...query, refetch: () => { retried++; } } })) }));
  const ui = mount(render({ data: undefined, error: null, isPending: true }));
  assert.match(ui.text(), /Loading projects…/);
  ui.update(render({ data: settingsOf([]), error: null, isPending: false }));
  assert.match(ui.text(), /No projects/);
  ui.update(render({ data: undefined, error: new Error(`socket closed at ${syntheticHome}/.local/share/nucleus/run.sock`), isPending: false }));
  assert.match(ui.text(), /Couldn't load projects/);
  assert.equal(ui.text().includes(syntheticHome), false, 'host paths are removed from the reason');
  ui.press('Retry projects');
  assert.equal(retried, 1);
  ui.update(render({ data: settingsOf([implicit('acme/book')]), error: new Error('offline'), isPending: false }));
  assert.ok(ui.get('book'), 'a stale list keeps its rows');
  assert.ok(ui.get('Projects problems'), 'with a warning icon on the header');
  assert.doesNotMatch(ui.text(), /Couldn't load projects/);
  done(ui);


});
