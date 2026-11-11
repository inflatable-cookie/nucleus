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
function row(key: string, name: string, repos: Array<{ origin: string | null; path: string }>, extra: Partial<ProjectSettingsRow> & { parked?: boolean } = {}): ProjectSettingsRow {
  const { parked, ...rest } = extra;
  return {
    project: { key, name, version: 1, visibility: parked ? 'parked' : 'active', repositories: repos, primary: repos[0]!, drain: null },
    repositories: repos.map((repository, index) => ({ repository, primary: index === 0, settings: null })),
    slots: { value: 4, override: null }, plannerLive: null, latestQa: null, problems: [],
    ...rest,
  } as ProjectSettingsRow;
}
const implicit = (origin: string, extra: Partial<ProjectSettingsRow> & { parked?: boolean } = {}) =>
  row(`repo-${Buffer.from(origin).toString('hex').padEnd(20, '0').slice(0, 20)}`, origin.split('/')[1]!, [repo(origin)], extra);
const settingsOf = (projects: ProjectSettingsRow[]): ProjectSettings => ({ defaultSlots: 4, projects });

const board = { revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 5, papercutProjectLimit: 2, tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [], projectLimitOverrides: {}, projectInFlightLimitOverrides: {}, projectCapacities: [], prStates: {}, usage: { level: 'normal', setLevel: 'normal', until: null, expired: false }, demandOffsets: { worker: 0, reviewer: 0, coordinator: 0 }, routingGrants: [], backup: { newestSnapshotAt: new Date().toISOString(), localError: null } };

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

test('helpers: parked last, filter by name or repository, implicit repositories, derived keys and host paths', async () => {
  const { sortProjectRows, filterProjectRows, implicitRepositories, projectKeyFor, withoutHostPaths } = await import('../client/projects-settings');
  const rows = [implicit('acme/zeta'), row('consumer-app', 'Consumer-App', [repo('acme/sound')], { parked: true }), implicit('acme/alpha'), row('project-c', 'Project-C', [repo('acme/project-c'), repo('acme/project-f')])];
  assert.deepEqual(sortProjectRows(rows).map(entry => entry.project.name), ['alpha', 'Project-C', 'zeta', 'Consumer-App']);
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

test('wide and narrow: one-line rows, parked last, one problem icon with its tooltip in the overlay layer', async () => {
  const long = 'A project name long enough to run past the settings column on a phone and keep going';
  const data = settingsOf([
    implicit('acme/book'),
    row('nucleus', 'Nucleus', [repo('acme/nucleus')], { problems: ['Planner thread is gone', 'Last QA failed'] }),
    row('consumer-app', 'Consumer-App', [repo('acme/sound')], { parked: true, problems: ['No planner'] }),
    row('long', long, [repo('acme/long')]),
  ]);
  for (const width of [1024, 390]) {
    const ui = await screen(width, async method => method === 'queue.ui-snapshot' ? board : method === 'project.settings' ? data : method === 'backup.list' ? { snapshots: [], localError: null } : {});
    await settle(() => ui.text().includes('Usage level'), 'limits');
    openProjects(ui, width);
    await settle(() => ui.text().includes('Consumer-App'), 'projects');
    const labels = ui.all(/^(book|Nucleus|Consumer-App|A project name[^,]*), /).map(node => node.props.accessibilityLabel);
    assert.deepEqual(labels, [`${long}, Active`, 'book, Active', 'Nucleus, Active, Planner thread is gone, Last QA failed', 'Consumer-App, Parked, No planner'], `${width}: sorted, parked last, problems in the row label`);
    const longName = ui.ofType('Text').find(node => textOf(node) === long)!;
    assert.equal(longName.props.numberOfLines, 1, `${width}: a long name stays on one line`);
    assert.doesNotMatch(ui.text(), /repo-|\/workspace\/user|acme\//, `${width}: no keys, paths or origins on the rows`);
    assert.equal(ui.all('Nucleus problems').length, 1, `${width}: one icon however many problems`);
    assert.equal(ui.query('book problems'), undefined, `${width}: no icon without a problem`);
    assert.equal(ui.query('Filter projects'), undefined, `${width}: no filter at 4 rows`);
    assert.ok(ui.get('Add project'), `${width}: the add icon button is named`);
    const layer = () => ui.ofType('View').find(node => node.props.testID === 'nucleus-popover-layer')!;
    ui.press('Nucleus problems');
    assert.ok(contains(layer(), 'Nucleus problems help text'), `${width}: the tooltip renders in the overlay layer`);
    assert.match(textOf(layer()), /Planner thread is gone\nLast QA failed/, `${width}: worst first, one per line`);
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
  const render = (projects: ProjectSettingsRow[]) => h(PopoverHost, null, h(ProjectsSection, { c: dark, compact: false, inset: 24, query: { data: settingsOf(projects), error: null, isPending: false, refetch: () => {} }, createProject: async () => {} }));
  const twelve = mount(render(many.slice(0, 12)));
  assert.equal(twelve.query('Filter projects'), undefined, '12 rows: no filter');
  done(twelve);
  const ui = mount(render(many));
  assert.equal(ui.get('Filter projects').props.placeholder, 'Filter');
  ui.type('Filter projects', 'repo07');
  assert.deepEqual(ui.all(/, Active$/).map(node => node.props.accessibilityLabel), ['repo07, Active']);
  ui.type('Filter projects', 'nothing like it');
  assert.match(ui.text(), /No projects match/);
  done(ui);
});

test('loading, empty, failure with Retry, and a stale list that keeps its rows', async () => {
  const { ProjectsSection } = await import('../client/projects-settings');
  const { PopoverHost } = await import('../client/popover');
  let retried = 0;
  const render = (query: { data: ProjectSettings | undefined; error: unknown; isPending: boolean }) =>
    h(PopoverHost, null, h(ProjectsSection, { c: dark, compact: true, inset: 16, query: { ...query, refetch: () => { retried++; } }, createProject: async () => {} }));
  const ui = mount(render({ data: undefined, error: null, isPending: true }));
  assert.match(ui.text(), /Loading projects…/);
  assert.equal(ui.get('Add project').props.accessibilityState.disabled, true, 'nothing to add from while loading');
  ui.update(render({ data: settingsOf([]), error: null, isPending: false }));
  assert.match(ui.text(), /No projects/);
  ui.update(render({ data: undefined, error: new Error(`socket closed at ${syntheticHome}/.local/share/nucleus/run.sock`), isPending: false }));
  assert.match(ui.text(), /Couldn't load projects/);
  assert.equal(ui.text().includes(syntheticHome), false, 'host paths are removed from the reason');
  ui.press('Retry projects');
  assert.equal(retried, 1);
  ui.update(render({ data: settingsOf([implicit('acme/book')]), error: new Error('offline'), isPending: false }));
  assert.ok(ui.get('book, Active'), 'a stale list keeps its rows');
  assert.ok(ui.get('Projects problems'), 'with a warning icon on the header');
  assert.doesNotMatch(ui.text(), /Couldn't load projects/);
  done(ui);
});

test('Add project: chooser of implicit repositories and Other…, primary star, Create writes project.upsert, refusals without host paths', async () => {
  const data = settingsOf([implicit('acme/book'), implicit('acme/zeta'), row('nucleus', 'Nucleus', [repo('acme/nucleus')])]);
  const writes: unknown[] = [];
  let refuse = true;
  for (const width of [390, 1024]) {
    writes.length = 0; refuse = true;
    const ui = await screen(width, async (method, input) => {
      if (method === 'queue.ui-snapshot') return board;
      if (method === 'project.settings') return data;
      if (method === 'backup.list') return { snapshots: [], localError: null };
      if (method === 'project.upsert') {
        writes.push(input);
        if (refuse) { refuse = false; throw new Error(`Repository ${syntheticHome}/Dev/zeta already belongs to project zeta`); }
        const { create: _create, primary: _primary, ...made } = input as { key: string; name: string; repositories: Array<{ origin: string | null; path: string }>; primary?: unknown; create?: true };
        return { ...made, version: 1, visibility: 'active', primary: made.repositories[0], drain: null };
      }
      return {};
    });
    try {
      await settle(() => ui.text().includes('Usage level'), 'limits');
      openProjects(ui, width);
      await settle(() => Boolean(ui.query('book, Active')), 'projects');
      assert.equal(iconOf(ui.get('Add project')), 'Plus', `${width}: the same add button as Profiles`);
      ui.press('Add project');
      const sheet = ui.get('Add project dialog');
      assert.equal(sheet.props.accessibilityViewIsModal, true);
      const scrim = ui.ofType('Modal')[0]!.children.flatMap(child => typeof child === 'string' ? [] : child.children)
        .find(node => typeof node !== 'string' && node.props.style?.backgroundColor) as HostNode;
      assert.equal(scrim.props.style.justifyContent, 'center', `${width}: a centred dialog at every width`);
      assert.equal(ui.ofType('Modal')[0]!.props.animationType, 'fade', `${width}: fades, never slides up as a sheet`);
      assert.ok(sheet.props.style.borderRadius > 0);
      assert.equal(sheet.props.style.borderTopLeftRadius, undefined, `${width}: full radius, not a top-only sheet`);
      assert.equal(ui.get('Create project').props.accessibilityState.disabled, true, 'Create waits for a name and a repository');
      ui.type('Name', 'Book club');
      ui.press('Repositories, Choose');
      const offered = ui.all(/^Repositories: /).map(node => node.props.accessibilityLabel);
      assert.deepEqual(offered, ['Repositories: acme/book', 'Repositories: acme/zeta', 'Repositories: Other…'], 'implicit repositories by owner/name; a named project is not offered');
      ui.press('Repositories: acme/book');
      ui.press('Repositories, Choose');
      ui.press('Repositories: Other…');
      ui.type('Other repository (owner/name)', 'not a repo');
      assert.equal(ui.get('Add repository').props.accessibilityState.disabled, true, 'Other… takes owner/name only');
      ui.type('Other repository (owner/name)', 'acme/newrepo');
      assert.equal(iconOf(ui.get('Add repository')), 'Plus');
      ui.press('Add repository');
      assert.ok(ui.get('acme/book, primary'), 'the first repository is primary');
      assert.equal(iconOf(ui.get('Remove acme/book')), 'Trash2');
      ui.press('Make acme/newrepo primary');
      assert.ok(ui.get('acme/newrepo, primary'), 'the star moves the primary');
      ui.press('Create project');
      await settle(() => ui.text().includes('already belongs'), 'refusal');
      assert.match(ui.text(), /Repository zeta already belongs to project zeta/, 'the server words, host path cut');
      assert.equal(ui.text().includes(syntheticHome), false);
      assert.deepEqual(writes[0], { key: 'book-club', name: 'Book club', repositories: [{ origin: 'acme/newrepo', path: '' }, repo('acme/book')], primary: { origin: 'acme/newrepo', path: '' }, create: true }, 'Create asks the store to refuse an existing key');
      ui.press('Remove acme/newrepo');
      assert.ok(ui.get('acme/book, primary'));
      ui.press('Create project');
      await settle(() => writes.length === 2, 'second write');
      await settle(() => ui.query('Add project dialog') === undefined, 'sheet closes');
      assert.deepEqual(writes[1], { key: 'book-club', name: 'Book club', repositories: [repo('acme/book')], create: true }, 'one repository needs no primary');
    } finally { done(ui); }
  }
});

test('Add project: a key taken since the list loaded is refused, the list refreshes, and the next Create takes a free key', async () => {
  let projects = [implicit('acme/book')];
  const writes: Array<{ key: string }> = [];
  const ui = await screen(1024, async (method, input) => {
    if (method === 'queue.ui-snapshot') return board;
    if (method === 'project.settings') return settingsOf(projects);
    if (method === 'backup.list') return { snapshots: [], localError: null };
    if (method === 'project.upsert') {
      const made = input as { key: string; name: string; repositories: Array<{ origin: string | null; path: string }>; create?: true };
      writes.push(made);
      // Another client made "club" after this list loaded: the store refuses create on an existing key.
      if (made.key === 'club') { projects = [...projects, row('club', 'Club', [repo('acme/other')])]; throw new Error('Project club already exists. Nothing changed; choose another name.'); }
      return { key: made.key, name: made.name, repositories: made.repositories, version: 1, visibility: 'active', primary: made.repositories[0], drain: null };
    }
    return {};
  });
  try {
    await settle(() => ui.text().includes('Usage level'), 'limits');
    ui.press('Projects');
    await settle(() => Boolean(ui.query('book, Active')), 'projects');
    ui.press('Add project');
    ui.type('Name', 'Club');
    ui.press('Repositories, Choose');
    ui.press('Repositories: acme/book');
    ui.press('Create project');
    await settle(() => ui.text().includes('already exists'), 'refusal');
    assert.equal(writes[0]!.key, 'club');
    await settle(() => Boolean(ui.query('Club, Active')), 'refreshed list');
    ui.press('Create project');
    await settle(() => writes.length === 2, 'second create');
    assert.equal(writes[1]!.key, 'club-2', 'the refreshed list gives a free key');
    await settle(() => ui.query('Add project dialog') === undefined, 'sheet closes');
  } finally { done(ui); }
});

test('Add project at 390: a long selection scrolls between a fixed title and Create', async () => {
  const many = Array.from({ length: 30 }, (_, index) => implicit(`acme/a-long-repository-name-${String(index).padStart(2, '0')}`));
  const ui = await screen(390, async method => method === 'queue.ui-snapshot' ? board : method === 'project.settings' ? settingsOf(many) : method === 'backup.list' ? { snapshots: [], localError: null } : {});
  try {
    await settle(() => ui.text().includes('Usage level'), 'limits');
    openProjects(ui, 390);
    await settle(() => ui.text().includes('a-long-repository-name-00'), 'projects');
    ui.press('Add project');
    for (let index = 0; index < 30; index++) {
      ui.press('Repositories, Choose');
      ui.press(`Repositories: acme/a-long-repository-name-${String(index).padStart(2, '0')}`);
    }
    const sheet = ui.get('Add project dialog');
    assert.equal(sheet.props.style.maxHeight, '90%', 'the sheet is bounded by the screen');
    const fields = ui.get('Add project fields');
    assert.equal(fields.type, 'ScrollView', 'the fields and selection scroll');
    assert.equal(fields.props.style.flexShrink, 1);
    assert.equal(ui.all(/^acme\/a-long-repository-name-\d+(, primary)?$/).length, 30);
    assert.ok(contains(fields, 'acme/a-long-repository-name-29'), 'the selection is inside the scroll');
    assert.ok(!contains(fields, 'Create project') && !contains(fields, 'Close Add project'), 'Create and Close stay outside it, always in view');
    assert.ok(contains(sheet, 'Create project'));
  } finally { done(ui); }
});
