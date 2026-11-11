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
import { type Project, type ProjectSettings, type ProjectSettingsRow, type RepositorySettings } from '../shared/contracts';

useNativeStubs();
const h = React.createElement;
const syntheticHome = ["", "Users", "example"].join("/");
const dark = { accent: '#1f6feb', accentForeground: '#fff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusSuccess: '#3fb950', statusWarning: '#f0883e', statusDanger: '#f85149' } as never;
async function settle(probe: () => boolean, label = 'screen') {
  for (const deadline = Date.now() + 3_000; Date.now() < deadline;) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${label} did not settle`);
}
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');
const done = (ui: { update(next: React.ReactElement): void }) => ui.update(h('View'));

type Repo = { origin: string | null; path: string };
const repo = (origin: string): Repo => ({ origin, path: `/workspace/user/Dev/${origin.split('/')[1]}` });
const settingsRow = (repository: Repo, extra: Partial<RepositorySettings> = {}): RepositorySettings => ({
  repository, scratchNamespace: null, closeout: null, validation: null, reviewer: null, qa: null, checksPolicy: null, note: '', updatedAt: '2026-11-08T00:00:00.000Z', revision: 1, ...extra,
});
function row(key: string, name: string, repos: Repo[], extra: Partial<ProjectSettingsRow> & { settings?: Array<RepositorySettings | null>; planner?: string } = {}): ProjectSettingsRow {
  const { settings, planner, ...rest } = extra;
  return {
    project: { key, name, version: 3, visibility: 'active', repositories: repos, primary: repos[0]!, drain: null, ...(planner ? { planner: { agentId: planner, setBy: 'operator', setAt: '2026-11-08T00:00:00.000Z' } } : {}) },
    repositories: repos.map((repository, index) => ({ repository, primary: index === 0, settings: settings?.[index] ?? null })),
    slots: { value: 4, override: null }, plannerLive: planner ? true : null, latestQa: null, problems: [],
    ...rest,
  } as ProjectSettingsRow;
}
const implicit = (origin: string) => row(`repo-${Buffer.from(origin).toString('hex').padEnd(20, '0').slice(0, 20)}`, origin.split('/')[1]!, [repo(origin)]);
const settingsOf = (projects: ProjectSettingsRow[]): ProjectSettings => ({ defaultSlots: 4, projects });
const candidates = [
  { id: 'agent-planner', title: 'Nucleus planner', workspaceId: null, kind: 'planner' as const },
  { id: 'agent-other-planner', title: 'Consumer planner', workspaceId: null, kind: 'planner' as const },
  { id: 'agent-worker', title: '950: a task thread', workspaceId: null, kind: 'worker' as const },
  { id: 'agent-reviewer', title: 'Review 950', workspaceId: null, kind: 'reviewer' as const },
];

type Call = [string, any];
function harness(initial: ProjectSettings, options: { refuse?: (method: string, input: any) => string | null; blockers?: (input: any) => Promise<unknown>; mergeCheck?: (input: any) => Promise<unknown>; candidates?: { data: typeof candidates | undefined; error: unknown; isPending: boolean } } = {}) {
  const calls: Call[] = [];
  let data = initial, error: unknown = null, refreshes = 0;
  const reply = (method: string, input: any, result: unknown) => {
    calls.push([method, input]);
    const refusal = options.refuse?.(method, input);
    if (refusal) return Promise.reject(new Error(refusal));
    return Promise.resolve(result);
  };
  const projectOf = (key: string): Project => data.projects.find(entry => entry.project.key === key)!.project;
  const edit = {
    saveProject: (input: any) => reply('project.upsert', input, { ...projectOf(input.key), ...input, version: projectOf(input.key).version + 1 }),
    setPlanner: (input: any) => reply('project.set-planner', input, { ...projectOf(input.key), version: projectOf(input.key).version + 1 }),
    setSlots: (input: any) => reply('queue.project-dispatch-limit', input, { ok: true }),
    setRepository: (input: any) => reply('repository.set', input, {}),
    park: (input: any) => reply('project.park', input, { ...projectOf(input.key), visibility: 'parked', version: input.version + 1 }),
    unpark: (input: any) => reply('project.unpark', input, { ...projectOf(input.key), visibility: 'active', version: input.version + 1 }),
    repositoryBlockers: (input: any) => { calls.push(['project.removal-blockers', input]); return options.blockers ? options.blockers(input) : Promise.resolve([]); },
    removeRepository: (input: any) => reply('project.remove-repository', input, {
      project: { ...projectOf(input.key), repositories: projectOf(input.key).repositories.filter(member => member.origin !== input.repository), version: input.version + 1 },
      tombstone: { key: 'repo-x', repositories: [], reason: input.reason, removedAt: 'now' } }),
    mergeCheck: (input: any) => { calls.push(['project.merge-check', input]); return options.mergeCheck ? options.mergeCheck(input) : Promise.resolve({ blockers: [], carried: [] }); },
    merge: (input: any) => {
      const source = projectOf(input.source), target = projectOf(input.target);
      const moving = input.repository ? source.repositories.filter(member => member.origin === input.repository) : source.repositories;
      const rest = source.repositories.filter(member => !moving.includes(member));
      return reply('project.merge', input, { project: { ...target, repositories: [...target.repositories, ...moving], version: input.versions.target + 1 },
        source: rest.length ? { ...source, repositories: rest, version: input.versions.source + 1 } : null,
        tombstone: rest.length ? null : { key: source.key, repositories: source.repositories, reason: input.reason, removedAt: 'now' } });
    },
    refresh: async () => { refreshes++; },
    candidates: options.candidates ?? { data: candidates, error: null, isPending: false },
  };
  let ui!: ReturnType<typeof mount>;
  let render!: () => React.ReactElement;
  return {
    calls, get refreshes() { return refreshes; },
    async mount(compact: boolean) {
      const { ProjectsSection } = await import('../client/projects-settings');
      const { PopoverHost } = await import('../client/popover');
      render = () => h(PopoverHost, null, h(ProjectsSection, { c: dark, compact, inset: compact ? 16 : 24, query: { data, error, isPending: false, refetch: () => {} }, createProject: async () => {}, edit: edit as never }));
      ui = mount(render());
      return ui;
    },
    set(next: { data?: ProjectSettings; error?: unknown }) { if (next.data) data = next.data; if ('error' in next) error = next.error; ui.update(render()); },
  };
}

test('helpers: commands split like a shell and join back; the planner picker leaves task threads out and marks a gone planner', async () => {
  const { splitCommand, joinCommand } = await import('../client/project-helpers');
  assert.deepEqual(splitCommand('effigy qa'), { argv: ['effigy', 'qa'] });
  assert.deepEqual(splitCommand(`  npm run "test all"  --grep 'a b' x\\ y "q\\"t" `), { argv: ['npm', 'run', 'test all', '--grep', 'a b', 'x y', 'q"t'] });
  assert.deepEqual(splitCommand(''), { argv: [] });
  assert.deepEqual(splitCommand(`""`), { argv: [''] }, 'an empty quoted word is a word');
  assert.deepEqual(splitCommand(`echo "open`), { error: 'a quote is not closed' });
  for (const argv of [['effigy', 'qa'], ['sh', '-c', "it's a test"], ['node', '--flag=a b', ''], ['a\\b', '$HOME']])
    assert.deepEqual(splitCommand(joinCommand(argv)), { argv }, `round trip ${JSON.stringify(argv)}`);
  assert.equal(joinCommand(['effigy', 'qa', '--timeout=120']), 'effigy qa --timeout=120', 'plain words stay bare');

  const { plannerOptions } = await import('../client/project-editor');
  const entry = row('nucleus', 'Nucleus', [repo('acme/nucleus')], { planner: 'agent-planner' });
  assert.deepEqual(plannerOptions(entry, candidates, 'agent-planner').map(option => option.label), ['None', 'Nucleus planner', 'Consumer planner'], 'workers and reviewers are left out');
  const gone = { ...row('nucleus', 'Nucleus', [repo('acme/nucleus')], { planner: 'agent-gone' }), plannerLive: false };
  assert.deepEqual(plannerOptions(gone, candidates, 'agent-gone').at(-1), { value: 'agent-gone', label: 'Gone' }, 'a planner no longer live stays, labelled Gone');
  assert.deepEqual(plannerOptions(gone, undefined, 'agent-gone').at(-1), { value: 'agent-gone', label: 'Gone' }, 'Gone from the server liveness while candidates load');
  const asWorker = row('nucleus', 'Nucleus', [repo('acme/nucleus')], { planner: 'agent-worker' });
  assert.equal(plannerOptions(asWorker, candidates, 'agent-worker').at(-1)!.label, '950: a task thread', 'a live planner of another kind keeps its title');
});

test('wide and narrow: a row opens the project; name, planner and Slots autosave in one ordered queue; Back returns to the list', async () => {
  for (const compact of [false, true]) {
    const data = settingsOf([implicit('acme/book'), row('nucleus', 'Nucleus', [repo('acme/nucleus')], { planner: 'agent-planner' })]);
    const app = harness(data);
    const ui = await app.mount(compact);
    try {
      ui.press('Nucleus, Active');
      assert.ok(ui.get('Nucleus project'), `${compact}: opened`);
      assert.ok(ui.get('Back to Projects'));
      assert.equal(iconOf(ui.get('Park Nucleus')), 'Pause', 'park is a top-right icon');
      assert.equal(iconOf(ui.get('Move Nucleus into another project')), 'FolderInput');
      assert.equal(iconOf(ui.get('Back to Projects')), 'ChevronLeft', 'Back keeps its word: an arrow alone could mean undo');
      assert.equal(ui.query('Remove Nucleus'), undefined, 'no trash icon without the removal calls');
      assert.equal(ui.query(/In flight/), undefined, 'Slots only: in flight is always twice the slots');
      assert.equal(ui.get('Project name').props.value, 'Nucleus');
      assert.equal(ui.get('Planner, Nucleus planner').props.accessibilityRole, 'button');
      const slots = ui.get('Slots for Nucleus');
      assert.equal(slots.props.value, '', 'no override: empty');
      assert.equal(slots.props.placeholder, '4', 'the inherited Per project value as placeholder');
      assert.equal(slots.props.accessibilityValue.text, 'Inherited, 4');
      assert.ok(ui.get('Slots help'));

      ui.type('Project name', 'Nucleus core');
      ui.press('Planner, Nucleus planner');
      assert.deepEqual(ui.all(/^Planner: /).map(node => node.props.accessibilityLabel), ['Planner: None', 'Planner: Nucleus planner', 'Planner: Consumer planner']);
      ui.press('Planner: Consumer planner');
      await settle(() => app.calls.length === 2, 'name and planner');
      assert.deepEqual(app.calls, [
        ['project.upsert', { key: 'nucleus', name: 'Nucleus core', repositories: [repo('acme/nucleus')] }],
        ['project.set-planner', { key: 'nucleus', agentId: 'agent-other-planner' }],
      ], 'the pending rename goes first, then the planner, in one batch');
      assert.equal(app.refreshes, 1, 'one re-read after the batch');

      app.calls.length = 0;
      ui.press('Increase Slots for Nucleus');
      ui.get('Slots for Nucleus').props.onBlur();
      await settle(() => app.calls.length === 1, 'slots');
      assert.deepEqual(app.calls[0], ['queue.project-dispatch-limit', { projectKey: 'nucleus', limit: 5 }], 'stepping from the inherited value sets an override');
      await settle(() => ui.query('Nucleus save status')?.children.join('') === 'Saved', 'saved');
      const overridden = settingsOf([implicit('acme/book'), { ...row('nucleus', 'Nucleus core', [repo('acme/nucleus')], { planner: 'agent-other-planner' }), slots: { value: 5, override: 5 } }]);
      app.set({ data: overridden });
      assert.equal(ui.get('Slots for Nucleus core').props.value, '5');
      app.calls.length = 0;
      const field = () => ui.get('Slots for Nucleus core');
      field().props.onFocus();
      ui.type('Slots for Nucleus core', '');
      field().props.onBlur();
      await settle(() => app.calls.length === 1, 'clear');
      assert.deepEqual(app.calls[0], ['queue.project-dispatch-limit', { projectKey: 'nucleus', limit: null }], 'clearing returns the project to inherited and off the Limits list');

      ui.press('Back to Projects');
      assert.ok(ui.get('book, Active'), 'back to the list');
    } finally { done(ui); }
  }
});

test('the empty name is held back with its reason and never sent; a repository change keeps the stored name', async () => {
  const app = harness(settingsOf([implicit('acme/book'), row('nucleus', 'Nucleus', [repo('acme/nucleus')])]));
  const ui = await app.mount(false);
  try {
    ui.press('Nucleus, Active');
    ui.type('Project name', '  ');
    assert.equal(ui.get('Nucleus save status').children.join(''), 'Not saved');
    ui.press('Not saved help');
    assert.match(ui.text(), /Name is empty/);
    ui.press('Add repository, +');
    ui.press('Add repository: acme/book');
    await settle(() => app.calls.length === 1, 'add');
    assert.deepEqual(app.calls[0], ['project.upsert', { key: 'nucleus', name: 'Nucleus', repositories: [repo('acme/nucleus'), repo('acme/book')], primary: repo('acme/nucleus') }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(ui.get('Nucleus save status').children.join(''), 'Not saved', 'the repository change landed, but the empty name is still held back, never Saved');
    assert.equal(ui.get('Project name').props.value, '  ', 'the draft name stays');
    assert.equal(ui.get('Not saved help').props.accessibilityHint, 'Name is empty');
    ui.type('Project name', 'Nucleus core');
    ui.get('Project name').props.onBlur();
    await settle(() => app.calls.length === 2, 'valid name');
    assert.equal(app.calls[1]![1].name, 'Nucleus core');
    await settle(() => ui.query('Nucleus save status')?.children.join('') === 'Saved', 'saved once the name is valid');
  } finally { done(ui); }
});

test('one repository: settings inline; QA, Checks, Reviewer and Merge check each write their own patch', async () => {
  const nucleus = repo('acme/nucleus');
  const refuse = (method: string, input: any) => method === 'repository.set' && input.checksPolicy === 'required' ? 'checksPolicy "required" refused: acme/nucleus: required checks are not readable. Nothing was written' : null;
  const app = harness(settingsOf([row('nucleus', 'Nucleus', [nucleus], { settings: [settingsRow(nucleus, { qa: { argv: ['effigy', 'qa'], timeoutMs: 7_200_000, maxOutputBytes: 1000, terminationGraceMs: 5000, schedule: null } })] })]), { refuse });
  const ui = await app.mount(true);
  try {
    ui.press('Nucleus, Active');
    assert.ok(ui.get('acme/nucleus, primary'), 'the one repository shows inline, with its star');
    assert.equal(ui.query('Remove acme/nucleus'), undefined, 'one repository: nothing to remove');
    assert.doesNotMatch(ui.text(), /\/workspace\/user/, 'no checkout paths');
    for (const help of ['Checks help', 'Reviewer help', 'Merge check help']) assert.ok(ui.get(help), help);
    assert.equal(ui.query('Validation default for acme/nucleus'), undefined, 'the retired validation policy renders no control');

    assert.equal(ui.get('QA command for acme/nucleus').props.value, 'effigy qa');
    assert.equal(ui.get('QA timeout for acme/nucleus').props.value, '120');
    app.calls.length = 0;
    ui.type('QA command for acme/nucleus', 'effigy qa --suite "unit all"');
    ui.press('QA schedule for acme/nucleus');
    ui.get('QA command for acme/nucleus').props.onBlur();
    await settle(() => app.calls.length === 1, 'qa');
    assert.deepEqual(app.calls[0], ['repository.set', { repository: 'acme/nucleus', qa: { maxOutputBytes: 1000, terminationGraceMs: 5000, argv: ['effigy', 'qa', '--suite', 'unit all'], timeoutMs: 7_200_000, schedule: { afterMerges: 10, maxIntervalHours: 24 } } }], 'quotes honoured, caps kept, the 24-hour ceiling untouched');
    ui.type('QA command for acme/nucleus', 'effigy "qa');
    assert.equal(ui.get('Nucleus save status').children.join(''), 'Not saved', 'an open quote is held back');
    ui.type('QA command for acme/nucleus', '');
    assert.equal(ui.get('QA timeout for acme/nucleus').props.accessibilityState.disabled, true, 'no command: no timeout to set');
    ui.get('QA command for acme/nucleus').props.onBlur();
    await settle(() => app.calls.length === 2, 'qa cleared');
    assert.deepEqual(app.calls[1], ['repository.set', { repository: 'acme/nucleus', qa: null }], 'an empty command clears qa');

    app.calls.length = 0;
    ui.press('Checks for acme/nucleus, All');
    ui.press('Checks for acme/nucleus: Required');
    await settle(() => app.calls.length === 1, 'checks');
    assert.deepEqual(app.calls[0], ['repository.set', { repository: 'acme/nucleus', checksPolicy: 'required' }]);
    await settle(() => Boolean(ui.query('Checks for acme/nucleus, All')), 'checks reverted');
    await settle(() => ui.query('Nucleus save status')?.children.join('') === 'Not saved', 'the refusal shows as Not saved');
    ui.press('Not saved help');
    assert.match(ui.text(), /required checks are not readable/, 'with the server reason behind its (?)');

    app.calls.length = 0;
    ui.type('Reviewer for acme/nucleus', 'not a login!');
    assert.equal(app.calls.length, 0);
    ui.type('Reviewer for acme/nucleus', 'nucleus-review');
    ui.get('Reviewer for acme/nucleus').props.onBlur();
    await settle(() => app.calls.length === 1, 'reviewer');
    assert.deepEqual(app.calls[0], ['repository.set', { repository: 'acme/nucleus', reviewer: { login: 'nucleus-review' } }]);

    app.calls.length = 0;
    ui.type('Merge check for acme/nucleus', 'effigy check');
    ui.get('Merge check for acme/nucleus').props.onBlur();
    await settle(() => app.calls.length === 1, 'merge');
    assert.deepEqual(app.calls[0], ['repository.set', { repository: 'acme/nucleus', validation: { argv: ['effigy', 'check'], timeoutMs: 900_000, maxOutputBytes: 65_536 } }]);
  } finally { done(ui); }
});

test('several repositories: collapsed rows, one open at a time, star moves the primary, remove is confirmed and the primary cannot go', async () => {
  const [a, b, c2] = [repo('acme/project-c'), repo('acme/project-f'), repo('acme/hull')];
  const app = harness(settingsOf([row('project-c', 'Project-C', [a, b, c2]), implicit('acme/book')]));
  const ui = await app.mount(false);
  try {
    ui.press('Project-C, Active');
    assert.equal(ui.get('acme/project-c, primary').props.accessibilityState.expanded, false, 'collapsed');
    assert.equal(ui.query('QA command for acme/project-c'), undefined);
    ui.press('acme/project-f');
    assert.ok(ui.get('QA command for acme/project-f'));
    ui.press('acme/hull');
    assert.equal(ui.query('QA command for acme/project-f'), undefined, 'one open at a time');
    assert.ok(ui.get('QA command for acme/hull'));
    ui.press('acme/project-c, primary');
    assert.equal(ui.get('Remove acme/project-c').props.accessibilityState.disabled, true, 'the primary cannot be removed until the star moves');
    assert.equal(ui.get('Remove acme/project-c').props.accessibilityHint, 'Move ★ to another repository first');
    ui.press('acme/project-f');
    assert.equal(iconOf(ui.get('Make acme/project-f primary')), 'Star');
    assert.equal(iconOf(ui.get('Remove acme/project-f')), 'Trash2', 'remove is the trash, as on every page');
    ui.press('Make acme/project-f primary');
    await settle(() => app.calls.length === 1, 'primary');
    assert.deepEqual(app.calls[0], ['project.upsert', { key: 'project-c', name: 'Project-C', repositories: [b, a, c2], primary: b }]);
    ui.press('acme/hull');
    ui.press('Remove acme/hull');
    assert.match(ui.text(), /Remove acme\/hull\?/);
    await settle(() => app.calls.length === 2, 'blocker check');
    assert.deepEqual(app.calls[1], ['project.removal-blockers', { key: 'project-c', repository: 'acme/hull' }], 'only a read until a choice is made');
    ui.press('Separate acme/hull into its own project');
    await settle(() => app.calls.length === 3, 'separate');
    assert.deepEqual(app.calls[2], ['project.upsert', { key: 'project-c', name: 'Project-C', repositories: [b, a], primary: b }], "Separate project keeps today's write");
    ui.press('Add repository, +');
    assert.deepEqual(ui.all(/^Add repository: /).map(node => node.props.accessibilityLabel), ['Add repository: acme/book', 'Add repository: Other…'], 'the Add project chooser');
    ui.press('Add repository: Other…');
    ui.type('Other repository (owner/name)', 'acme/project-c');
    assert.equal(ui.get('Add other repository').props.accessibilityState.disabled, true, 'a member is not added twice');
    ui.type('Other repository (owner/name)', 'acme/new');
    assert.equal(iconOf(ui.get('Add other repository')), 'Plus');
    assert.equal(iconOf(ui.get('Cancel other repository')), 'X');
    ui.press('Add other repository');
    await settle(() => app.calls.length === 4, 'add other');
    assert.deepEqual(app.calls[3][1].repositories.at(-1), { origin: 'acme/new', path: '' });
  } finally { done(ui); }
});

test('nucleus#967 Remove from Nucleus: one server step with the newest version; the row goes once it lands', async () => {
  const [a, b] = [repo('acme/consumer-b-v2'), repo('acme/market')];
  for (const compact of [true, false]) {
    const app = harness(settingsOf([row('consumer', 'Consumer-B', [a, b])]));
    const ui = await app.mount(compact);
    try {
      ui.press('Consumer-B, Active');
      ui.press('acme/market');
      ui.press('Remove acme/market');
      assert.ok(ui.get('Remove acme/market from Nucleus'), `${compact ? 'narrow' : 'wide'}: both choices`);
      assert.ok(ui.get('Separate acme/market into its own project'));
      assert.match(ui.get('Remove repository help').props.accessibilityHint, /Task history stays readable/, 'the detail sits behind a (?)');
      await settle(() => ui.get('Remove acme/market from Nucleus').props.accessibilityState.disabled === false, 'blockers read');
      assert.doesNotMatch(ui.text(), /Checking open work/);
      ui.press('Remove acme/market from Nucleus');
      await settle(() => app.calls.some(call => call[0] === 'project.remove-repository'), 'remove');
      assert.deepEqual(app.calls.find(call => call[0] === 'project.remove-repository'),
        ['project.remove-repository', { key: 'consumer', version: 3, repository: 'acme/market', reason: 'Removed from Consumer-B in Settings' }]);
      assert.equal(app.calls.filter(call => call[0] === 'project.upsert').length, 0, 'no split-off write first');
      await settle(() => ui.query('acme/market') === undefined, 'row removed');
      assert.doesNotMatch(ui.text(), /Remove acme\/market\?/);
    } finally { done(ui); }
  }
});

test('nucleus#967 Remove from Nucleus: disabled with the blocker while loading, blocked or unreadable; Retry rereads', async () => {
  const a = repo('acme/consumer-b-v2');
  const label = 'acme/market-with-a-rather-long-repository-name-for-wrapping';
  const b = repo(label);
  let answer: () => Promise<unknown> = () => new Promise(() => {});
  const app = harness(settingsOf([row('consumer', 'Consumer-B', [a, b])]), { blockers: () => answer() });
  const ui = await app.mount(true);
  try {
    ui.press('Consumer-B, Active');
    ui.press(label);
    ui.press(`Remove ${label}`);
    const danger = () => ui.get(`Remove ${label} from Nucleus`);
    assert.equal(danger().props.accessibilityState.disabled, true, 'loading: disabled');
    assert.equal(danger().props.accessibilityHint, 'Checking open work…');
    assert.match(ui.text(), /Checking open work…/);
    assert.notEqual(ui.get(`Separate ${label} into its own project`).props.accessibilityState.disabled, true, 'Separate project never waits');
    ui.press(`Keep ${label}`);
    answer = () => Promise.reject(new Error(`service down at ${syntheticHome}/Dev/x`));
    ui.press(`Remove ${label}`);
    await settle(() => /Couldn't check open work/.test(ui.text()), 'error');
    assert.equal(ui.text().includes(syntheticHome), false, 'no host paths');
    assert.equal(danger().props.accessibilityState.disabled, true, 'unreadable: disabled');
    answer = () => Promise.resolve([{ kind: 'task', label: 'task', names: ['market#012', 'market#013'] }, { kind: 'lead', label: 'open lead', names: ['Rename'] }]);
    ui.press(`Retry checking ${label}`);
    await settle(() => /Can't remove from Nucleus/.test(ui.text()), 'blocked');
    assert.match(ui.text(), /Can't remove from Nucleus: 2 tasks \(market#012, market#013\); 1 open lead \(Rename\)/, "the refusal's wording");
    assert.equal(danger().props.accessibilityState.disabled, true, 'blocked: disabled');
    assert.equal(danger().props.accessibilityHint, 'Blocked by 2 tasks (market#012, market#013); 1 open lead (Rename)');
    assert.equal(app.calls.filter(call => call[0] === 'project.remove-repository').length, 0);
    ui.press(`Separate ${label} into its own project`);
    await settle(() => app.calls.some(call => call[0] === 'project.upsert'), 'separate still works');
    assert.deepEqual(app.calls.find(call => call[0] === 'project.upsert')![1].repositories, [a]);
  } finally { done(ui); }
});

test('nucleus#967 Remove from Nucleus: a refusal that races the check shows as Not saved and keeps the repository', async () => {
  const [a, b] = [repo('acme/consumer-b-v2'), repo('acme/market')];
  const app = harness(settingsOf([row('consumer', 'Consumer-B', [a, b])]), { refuse: method => method === 'project.remove-repository' ? 'Repository acme/market cannot be removed: 1 task (market#014)' : null });
  const ui = await app.mount(false);
  try {
    ui.press('Consumer-B, Active');
    ui.press('acme/market');
    ui.press('Remove acme/market');
    await settle(() => ui.get('Remove acme/market from Nucleus').props.accessibilityState.disabled === false, 'blockers read');
    ui.press('Remove acme/market from Nucleus');
    await settle(() => /Not saved/.test(ui.text()), 'refused');
    assert.ok(ui.get('acme/market'), 'still a member');
  } finally { done(ui); }
});

test('nucleus#969 Move into: an icon with the card actions, a target dropdown, a confirm that says what goes, one server step, then the target opens', async () => {
  for (const compact of [false, true]) {
    const book = [repo('acme/book'), repo('acme/book-assets')];
    const app = harness(settingsOf([row('site', 'Site', [repo('acme/site')], { planner: 'agent-planner' }), row('book', 'Book', book), row('archive', 'Archive', [repo('acme/archive')])]));
    const ui = await app.mount(compact);
    try {
      ui.press('Book, Active');
      const open = ui.get('Move Book into another project');
      assert.equal(open.props.accessibilityRole, 'button');
      assert.equal(open.props.accessibilityHint, 'Move Book into another project', 'an icon button whose name shows on hover');
      ui.press('Move Book into another project');
      await settle(() => app.calls.some(call => call[0] === 'project.merge-check'), 'check');
      assert.deepEqual(app.calls[0], ['project.merge-check', { source: 'book' }], 'the whole project\'s move check');
      assert.equal(ui.get('Move Book').props.accessibilityState.disabled, true, 'nothing chosen yet');
      assert.equal(ui.get('Move Book').props.accessibilityHint, 'Choose a project');
      ui.press('Move into, Project');
      assert.deepEqual(ui.all(/^Move into: /).map(node => node.props.accessibilityLabel), ['Move into: Archive', 'Move into: Site'], 'other projects by name, never itself');
      ui.press('Move into: Site');
      assert.match(ui.text(), /Move Book into Site\? Its 2 repositories join Site\. Site's name, planner, slots and primary stay; Book's name, planner and slots are dropped\./, 'nothing comes along: no count');
      await settle(() => ui.get('Move Book into Site').props.accessibilityState.disabled === false, 'enabled');
      assert.equal(app.calls.filter(call => call[0] === 'project.merge').length, 0, 'nothing written before Move');
      ui.press('Move Book into Site');
      await settle(() => app.calls.some(call => call[0] === 'project.merge'), 'merge');
      assert.deepEqual(app.calls.find(call => call[0] === 'project.merge'),
        ['project.merge', { source: 'book', target: 'site', versions: { source: 3, target: 3 }, reason: 'Moved into Site in Settings' }]);
      assert.equal(app.calls.filter(call => call[0] === 'project.upsert').length, 0, 'one step, no membership writes around it');
      await settle(() => Boolean(ui.query('Site project')), 'the target opens');
    } finally { done(ui); }
  }
});

test('nucleus#969 Move into: disabled with the blocker while loading, blocked or unreadable; no other project; a refusal shows Not saved', async () => {
  let answer: () => Promise<unknown> = () => new Promise(() => {});
  const long = 'Book with a rather long project name that has to wrap at the narrow settings width';
  const app = harness(settingsOf([row('book', long, [repo('acme/book')]), row('site', 'Site', [repo('acme/site')])]), {
    mergeCheck: () => answer(), refuse: method => method === 'project.merge' ? 'Stale project version for site: expected 4' : null });
  const ui = await app.mount(true);
  try {
    ui.press(`${long}, Active`);
    ui.press(`Move ${long} into another project`);
    ui.press('Move into, Project');
    ui.press('Move into: Site');
    const move = () => ui.get(`Move ${long} into Site`);
    assert.match(ui.text(), /Its repository joins Site/, 'one repository reads as one');
    assert.equal(move().props.accessibilityHint, 'Checking open work…');
    assert.equal(move().props.accessibilityState.disabled, true);
    ui.press(`Cancel moving ${long}`);
    assert.equal(ui.query(`Move ${long} into another project`)?.props.accessibilityState?.disabled, false, 'closed');
    answer = () => Promise.reject(new Error(`down at ${syntheticHome}/Dev/x`));
    ui.press(`Move ${long} into another project`);
    await settle(() => /Couldn't check open work/.test(ui.text()), 'error');
    assert.equal(ui.text().includes(syntheticHome), false);
    answer = () => Promise.resolve({ blockers: [{ kind: 'qa', label: 'project QA run', names: ['acme/book running'] }], carried: [{ kind: 'task', label: 'task', names: ['book#001'] }] });
    ui.press(`Retry checking ${long}`);
    await settle(() => /Can't move: 1 project QA run \(acme\/book running\)/.test(ui.text()), 'blocked');
    ui.press('Move into, Project');
    ui.press('Move into: Site');
    assert.equal(move().props.accessibilityState.disabled, true);
    assert.equal(move().props.accessibilityHint, 'Blocked by 1 project QA run (acme/book running)', 'a running QA still refuses, worded as the remove dialog words blockers');
    answer = () => Promise.resolve({ blockers: [], carried: [
      { kind: 'lead', label: 'open lead', names: ['Button density at md with a bare label', 'Cohort runs persist each accepted capture as it completes'] },
      { kind: 'papercut', label: 'open papercut', names: ['No Effigy format selector for TypeScript'] },
      { kind: 'task', label: 'task', names: ['book#001'] }] });
    ui.press(`Cancel moving ${long}`);
    ui.press(`Move ${long} into another project`);
    ui.press('Move into, Project');
    ui.press('Move into: Site');
    await settle(() => move().props.accessibilityState.disabled === false, 'open work comes along instead of blocking');
    assert.match(ui.text(), /Its repository joins Site with 2 leads, 1 papercut, 1 task\. Site's name/, 'the confirm counts what comes along');
    assert.doesNotMatch(ui.text(), /Can't move/);
    ui.press(`Move ${long} into Site`);
    await settle(() => /Not saved/.test(ui.text()), 'refused');
    assert.ok(ui.get(`${long} project`), 'still here after a refusal');
  } finally { done(ui); }
  const lone = harness(settingsOf([row('book', 'Book', [repo('acme/book')])]));
  const ui2 = await lone.mount(false);
  try {
    ui2.press('Book, Active');
    ui2.press('Move Book into another project');
    ui2.press('Move into, Project');
    assert.match(ui2.text(), /No other project/, 'empty');
    assert.equal(ui2.get('Move Book').props.accessibilityState.disabled, true);
  } finally { done(ui2); }
});

test('nucleus#969 Add repository: a repository of another project is offered with its project and moved in one server step', async () => {
  for (const compact of [false, true]) {
    const [tools, kit] = [repo('acme/tools'), repo('acme/kit')];
    const app = harness(settingsOf([row('site', 'Site', [repo('acme/site')]), row('book', 'Book', [repo('acme/book')]), row('tools', 'Tools', [tools, kit]), implicit('acme/loose')]));
    const ui = await app.mount(compact);
    try {
      ui.press('Site, Active');
      ui.press('Add repository, +');
      assert.deepEqual(ui.all(/^Add repository: /).map(node => node.props.accessibilityLabel),
        ['Add repository: acme/loose', 'Add repository: acme/book · Book', 'Add repository: acme/kit · Tools', 'Add repository: acme/tools · Tools', 'Add repository: Other…']);
      ui.press('Add repository: acme/book · Book');
      assert.match(ui.text(), /Move acme\/book here\? It's the only repository in Book, so Book goes: its name, planner and slots are dropped\./);
      await settle(() => ui.get('Move acme/book into Site').props.accessibilityState.disabled === false, 'check read');
      assert.deepEqual(app.calls.at(-1), ['project.merge-check', { source: 'book' }]);
      ui.press('Move acme/book into Site');
      await settle(() => app.calls.some(call => call[0] === 'project.merge'), 'merge');
      assert.deepEqual(app.calls.find(call => call[0] === 'project.merge'),
        ['project.merge', { source: 'book', target: 'site', versions: { source: 3, target: 3 }, repository: 'acme/book', reason: 'Added to Site in Settings' }]);
      assert.equal(app.calls.filter(call => call[0] === 'project.upsert').length, 0, 'never a plain add that leaves its old project');
      await settle(() => Boolean(ui.query('acme/book')), 'now a member');

      ui.press('Add repository, +');
      ui.press('Add repository: acme/kit · Tools');
      assert.match(ui.text(), /acme\/kit is in Tools with 1 other repository\. Move just it, or all of Tools\?/);
      await settle(() => ui.get('Move all of Tools into Site').props.accessibilityState.disabled === false, 'blockers read');
      ui.press('Move only acme/kit into Site');
      await settle(() => app.calls.filter(call => call[0] === 'project.merge').length === 2, 'move one');
      assert.deepEqual(app.calls.filter(call => call[0] === 'project.merge')[1]![1], { source: 'tools', target: 'site', versions: { source: 3, target: 4 }, repository: 'acme/kit', reason: 'Added to Site in Settings' },
        'the newest target version');

      ui.press('Add repository, +');
      ui.press('Add repository: acme/tools · Tools');
      assert.equal(ui.get('Move only acme/tools into Site').props.accessibilityState.disabled, true, 'a primary moves only with its project');
      assert.equal(ui.get('Move only acme/tools into Site').props.accessibilityHint, "acme/tools is Tools's primary: move ★ there first");
      await settle(() => ui.get('Move all of Tools into Site').props.accessibilityState.disabled === false, 'blockers read');
      ui.press('Move all of Tools into Site');
      await settle(() => app.calls.filter(call => call[0] === 'project.merge').length === 3, 'move all');
      assert.equal('repository' in app.calls.filter(call => call[0] === 'project.merge')[2]![1], false, 'the whole project');
    } finally { done(ui); }
  }
});

test('nucleus#969 Add repository: Other… naming a repository of another project asks to move it; a blocked project can only move one member', async () => {
  const app = harness(settingsOf([row('site', 'Site', [repo('acme/site')]), row('tools', 'Tools', [repo('acme/tools'), repo('acme/kit')])]),
    { mergeCheck: () => Promise.resolve({ blockers: [{ kind: 'operation', label: 'repository re-key', names: ['acme/tools'] }], carried: [{ kind: 'lead', label: 'open lead', names: ['Rename'] }] }) });
  const ui = await app.mount(false);
  try {
    ui.press('Site, Active');
    ui.press('Add repository, +');
    ui.press('Add repository: Other…');
    ui.type('Other repository (owner/name)', 'ACME/kit');
    ui.press('Add other repository');
    assert.match(ui.text(), /acme\/kit is in Tools/);
    await settle(() => /Can't move Tools: 1 repository re-key \(acme\/tools\)/.test(ui.text()), 'blocked');
    assert.equal(ui.get('Move all of Tools into Site').props.accessibilityHint, 'Blocked by 1 repository re-key (acme/tools)');
    assert.notEqual(ui.get('Move only acme/kit into Site').props.accessibilityState.disabled, true, 'one member leaves its project without removing it');
    ui.press('Cancel moving acme/kit');
    assert.doesNotMatch(ui.text(), /acme\/kit is in Tools/);
    assert.equal(app.calls.filter(call => call[0] === 'project.merge' || call[0] === 'project.upsert').length, 0);
  } finally { done(ui); }
});

test('nucleus#969 Remove from Nucleus names a separate project that also holds the repository', async () => {
  const [site, book] = [repo('acme/site'), repo('acme/book')];
  const app = harness(settingsOf([row('site', 'Site', [site, book]), row('book', 'Book', [book])]));
  const ui = await app.mount(true);
  try {
    ui.press('Site, Active');
    ui.press('acme/book');
    ui.press('Remove acme/book');
    assert.match(ui.text(), /Remove from Nucleus also deletes project Book\./);
    ui.press('Keep acme/book');
    ui.press('acme/site, primary');
    assert.doesNotMatch(ui.text(), /also deletes/);
  } finally { done(ui); }
});

test('park asks first and unpark acts; both carry the newest version', async () => {
  const app = harness(settingsOf([row('nucleus', 'Nucleus', [repo('acme/nucleus')])]));
  const ui = await app.mount(true);
  try {
    ui.press('Nucleus, Active');
    ui.press('Park Nucleus');
    assert.match(ui.text(), /Park Nucleus\? No new work starts\./);
    assert.equal(app.calls.length, 0);
    ui.press('Keep project Nucleus');
    assert.doesNotMatch(ui.text(), /No new work starts/);
    ui.press('Park Nucleus');
    ui.press('Park project Nucleus');
    await settle(() => app.calls.length === 1, 'park');
    assert.deepEqual(app.calls[0], ['project.park', { key: 'nucleus', version: 3 }]);
    app.set({ data: settingsOf([{ ...row('nucleus', 'Nucleus', [repo('acme/nucleus')]), project: { ...row('nucleus', 'Nucleus', [repo('acme/nucleus')]).project, visibility: 'parked', version: 4 } }]) });
    assert.match(ui.text(), /Parked/);
    ui.press('Unpark Nucleus');
    await settle(() => app.calls.length === 2, 'unpark');
    assert.deepEqual(app.calls[1], ['project.unpark', { key: 'nucleus', version: 4 }], 'no confirm to unpark');
  } finally { done(ui); }
});

test('loading, a failed re-read keeps fields disabled and never blank, a staged QA is read-only, long names wrap, and a gone planner shows Gone', async () => {
  const long = 'A project name long enough to run past the settings column on a phone and keep going';
  const nucleus = repo('acme/nucleus');
  const staged = settingsRow(nucleus, { qa: { stages: [{ name: 'unit', argv: ['npm', 'test'], timeoutMs: 60_000 }, { name: 'e2e', argv: ['npm', 'run', 'e2e'], timeoutMs: 60_000 }, { name: 'docs', argv: ['npm', 'run', 'docs'], timeoutMs: 60_000 }], maxOutputBytes: 65_536, terminationGraceMs: 5000, schedule: null } });
  const entry = { ...row('nucleus', long, [nucleus], { planner: 'agent-gone', settings: [staged] }), plannerLive: false };
  const app = harness(settingsOf([entry]), { candidates: { data: undefined, error: new Error('host offline'), isPending: false } });
  const ui = await app.mount(true);
  try {
    ui.press(new RegExp(`^${long}, Active`));
    const title = ui.ofType('Text').find(node => node.props.accessibilityRole === 'header' && textOf(node) === long)!;
    assert.equal(title.props.numberOfLines, 2, 'a long name wraps to two lines, never past the column');
    assert.ok(ui.get('Planner, Gone'), 'a planner thread no longer live stays selected as Gone');
    assert.match(ui.text(), /Couldn't load threads/);
    assert.equal(ui.get('QA for acme/nucleus').children.join(''), 'Staged · 3 steps');
    assert.equal(ui.query('QA command for acme/nucleus'), undefined, 'no command field for a staged QA');

    app.set({ error: new Error(`socket closed at ${syntheticHome}/.local/share/nucleus/run.sock`) });
    assert.match(ui.text(), new RegExp(`Couldn't load ${long}`));
    assert.equal(ui.text().includes(syntheticHome), false);
    assert.equal(ui.get('Project name').props.value, long, 'never blank');
    assert.equal(ui.get('Project name').props.editable, false, 'disabled');
    assert.equal(ui.get(`Park ${long}`).props.accessibilityState.disabled, true);
    assert.ok(ui.get(`Retry ${long}`));
  } finally { done(ui); }

  const { ProjectEditor } = await import('../client/project-editor');
  const { PopoverHost } = await import('../client/popover');
  const editor = (props: Record<string, unknown>) => h(PopoverHost, null, h(ProjectEditor, { c: dark, projectKey: 'nucleus', refetch: () => {}, actions: {} as never, onBack: () => {}, ...props } as never));
  const loading = mount(editor({ data: undefined, error: null }));
  assert.match(loading.text(), /Loading…/);
  loading.update(editor({ data: undefined, error: new Error('offline') }));
  assert.match(loading.text(), /Couldn't load the project/);
  assert.ok(loading.get('Retry the project'));
  loading.update(editor({ data: settingsOf([]), error: null }));
  assert.match(loading.text(), /This project no longer exists/);
  done(loading);
});

test('the full screen wires the writes: set-planner as the operator, then a re-read of project.settings', async () => {
  let reads = 0;
  const writes: Call[] = [];
  const data = settingsOf([row('nucleus', 'Nucleus', [repo('acme/nucleus')])]);
  const board = { revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 4, papercutProjectLimit: 2, tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [], projectLimitOverrides: {}, projectInFlightLimitOverrides: {}, projectCapacities: [], prStates: {}, usage: { level: 'normal', setLevel: 'normal', until: null, expired: false }, demandOffsets: { worker: 0, reviewer: 0, coordinator: 0 }, routingGrants: [], backup: { newestSnapshotAt: new Date().toISOString(), localError: null } };
  const { QueueSettingsScreen } = await import('../client/settings-screen');
  for (const width of [390, 1024]) {
    writes.length = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invoke = async (method: string, input: unknown) => {
      if (method === 'queue.ui-snapshot') return board;
      if (method === 'project.settings') { reads++; return data; }
      if (method === 'project.owner-candidates') return candidates;
      if (method === 'backup.list') return { snapshots: [], localError: null };
      if (method === 'project.set-planner') { writes.push([method, input]); return { ...data.projects[0]!.project, version: 4 }; }
      return {};
    };
    const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never, children: h(QueueSettingsScreen as never, { theme: { colors: dark }, layout: { compact: false, platform: 'ios' }, host: { id: 'host', label: 'Host' } }) }) }));
    try {
      ui.get('Nucleus settings').props.onLayout({ nativeEvent: { layout: { width } } });
      await settle(() => ui.text().includes('Usage level'), 'limits');
      ui.press('Projects');
      await settle(() => Boolean(ui.query('Nucleus, Active')), 'projects');
      ui.press('Nucleus, Active');
      await settle(() => Boolean(ui.query('Planner, None')), 'candidates');
      const before = reads;
      ui.press('Planner, None');
      ui.press('Planner: Nucleus planner');
      await settle(() => writes.length === 1 && reads > before, `${width}: write and re-read`);
      assert.deepEqual(writes[0], ['project.set-planner', { key: 'nucleus', agentId: 'agent-planner', setBy: 'operator' }]);
    } finally { done(ui); }
  }
});
