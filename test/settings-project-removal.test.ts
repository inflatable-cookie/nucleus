import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs, type HostNode } from './support/render';
import { type Project, type ProjectManagementPreview, type ProjectSettings, type ProjectSettingsRow } from '../shared/contracts';

/*
 * Settings → Projects → Remove (lane `nucleus-ui`, "Projects in Settings", build
 * task 4): the scoped removal dialog behind the opened project's trash icon, and
 * the section hint that opens Settings at Projects.
 */
useNativeStubs();
const h = React.createElement;
const syntheticHome = ["", "Users", "example"].join("/");
const dark = { accent: '#1f6feb', accentForeground: '#fff', surface0: '#0d1117', surface1: '#161b22', surface2: '#30363d', border: '#30363d', foreground: '#f0f6fc', foregroundMuted: '#8b949e', statusSuccess: '#3fb950', statusWarning: '#f0883e', statusDanger: '#f85149' } as never;
async function settle(probe: () => boolean, label = 'screen') {
  for (const deadline = Date.now() + 3_000; Date.now() < deadline;) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${label} did not settle`);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');
const done = (ui: { update(next: React.ReactElement): void }) => ui.update(h('View'));

const repo = (origin: string) => ({ origin, path: `/workspace/user/Dev/${origin.split('/')[1]}` });
const project = (key: string, name = key, version = 3): Project => ({ key, name, version, visibility: 'active', repositories: [repo(`acme/${key}`)], primary: repo(`acme/${key}`), drain: null }) as Project;
const settingsRowOf = (p: Project): ProjectSettingsRow => ({
  project: p, repositories: p.repositories.map((repository, index) => ({ repository, primary: index === 0, settings: null })),
  slots: { value: 4, override: null }, plannerLive: null, latestQa: null, problems: [],
}) as ProjectSettingsRow;
const settingsOf = (projects: Project[]): ProjectSettings => ({ defaultSlots: 4, projects: projects.map(settingsRowOf) });
type Item = ProjectManagementPreview['items'][number];
const previewOf = (p: Project, items: Item[] = [], tasks: Array<{ taskId: string; version: number }> = [], extra: Partial<ProjectManagementPreview> = {}) =>
  ({ project: p, target: null, digest: 'pinned', cancellation: null, items, tasks, ...extra }) as ProjectManagementPreview;
const noCancel = { cancelRpc: async () => { throw new Error('must not cancel'); }, cancellationRpc: async () => { throw new Error('no cancellation'); }, resetRpc: async () => ({ reset: true as const }) };

async function sheet(props: Record<string, unknown>) {
  const { ProjectManagementView } = await import('../client/project-management-view');
  return mount(h(ProjectManagementView, { c: dark, onClose: () => {}, onRemoved: () => {}, ...props } as never));
}

test('removalEffect: the danger button says what it does', async () => {
  const { removalEffect } = await import('../client/project-management-view');
  assert.equal(removalEffect(0), 'Delete project');
  assert.equal(removalEffect(1), 'Cancel 1 task');
  assert.equal(removalEffect(3), 'Cancel 3 tasks');
});

test('project removal cancellation migrates the legacy storage key once', async () => {
  const { readMigratedCancellation } = await import('../client/project-management-view');
  const oldKey = 'northstar-queue:project-removal:legacy-project';
  const newKey = 'nucleus:project-removal:legacy-project';
  const value = { operationId: 'op-1', reason: 'cleanup', digest: 'd1', version: 2, tasks: [{ taskId: 'task-1', version: 4 }] };
  const items = new Map([[oldKey, JSON.stringify(value)]]);
  const reads = new Map<string, number>();
  const storage = {
    getItem(key: string) { reads.set(key, (reads.get(key) ?? 0) + 1); return items.get(key) ?? null; },
    setItem(key: string, raw: string) { items.set(key, raw); },
    removeItem(key: string) { items.delete(key); },
  };
  assert.deepEqual(readMigratedCancellation(storage, 'legacy-project'), value);
  assert.equal(items.has(oldKey), false);
  assert.deepEqual(JSON.parse(items.get(newKey)!), value);
  assert.deepEqual(readMigratedCancellation(storage, 'legacy-project'), value);
  assert.equal(reads.get(oldKey), 1, 'after migration, reads use only the Nucleus key');
});

test('the section hint is taken once, by the next Settings screen or by one already showing', async () => {
  const { hintSettingsSection, takeSettingsSection } = await import('../client/settings-hint');
  assert.equal(takeSettingsSection(), null);
  hintSettingsSection('projects');
  assert.equal(takeSettingsSection(), 'projects');
  assert.equal(takeSettingsSection(), null, 'used once: plain Settings opens at its first section');
});

test('full screen, wide and narrow: the hint opens Settings at Projects; the trash icon opens Remove scoped to the project; Delete project asks once more and returns to the list', async () => {
  const { hintSettingsSection } = await import('../client/settings-hint');
  const { QueueSettingsScreen } = await import('../client/settings-screen');
  const board = { revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true, activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 4, papercutProjectLimit: 2, tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {}, lanes: [], projects: [], projectLimitOverrides: {}, projectInFlightLimitOverrides: {}, projectCapacities: [], prStates: {}, usage: { level: 'normal', setLevel: 'normal', until: null, expired: false }, demandOffsets: { worker: 0, reviewer: 0, coordinator: 0 }, routingGrants: [], backup: { newestSnapshotAt: new Date().toISOString(), localError: null } };
  for (const width of [390, 1024]) {
    const key = `book-${width}`;
    let projects = [project(key, 'Book'), project(`nucleus-${width}`, 'Nucleus')];
    const calls: Array<[string, any]> = [];
    const invoke = async (method: string, input: any) => {
      if (method === 'queue.ui-snapshot') return board;
      if (method === 'project.settings') return settingsOf(projects);
      if (method === 'project.owner-candidates') return [];
      if (method === 'backup.list') return { snapshots: [], localError: null };
      if (method === 'project.management-preview') { calls.push([method, input]); return previewOf(projects[0]!); }
      if (method === 'project.manage-remove') { calls.push([method, input]); projects = projects.slice(1); return { key, repositories: [repo(`acme/${key}`)], reason: input.reason, removedAt: 'now' }; }
      return {};
    };
    hintSettingsSection('projects');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = mount(h(QueryClientProvider, { client, children: h(PluginRpcProvider, { invoke: invoke as never, children: h(QueueSettingsScreen as never, { theme: { colors: dark }, layout: { compact: false, platform: 'ios' }, host: { id: 'host', label: 'Host' } }) }) }));
    try {
      ui.get('Nucleus settings').props.onLayout({ nativeEvent: { layout: { width } } });
      await settle(() => Boolean(ui.query('Book, Active')), `${width}: opens at Projects without choosing it`);
      assert.equal(ui.query('Repositories'), undefined, 'no Repositories section');
      ui.press('Book, Active');
      ui.press('Remove Book');
      await settle(() => calls.length === 1, `${width}: preview`);
      assert.deepEqual(calls[0], ['project.management-preview', { key }], 'scoped: the project is already chosen');
      assert.ok(ui.get('Remove Book dialog'));
      assert.equal(ui.ofType('Modal')[0]!.props.animationType, 'fade', `${width}: a centred dialog, never a bottom sheet`);
      assert.equal(ui.get('Remove Book dialog').props.style.borderTopLeftRadius, undefined, `${width}: full radius`);
      assert.equal(ui.query('Move to, Choose'), undefined, `${width}: no Move to`);
      assert.equal(ui.ofType('Modal').length, 1);
      assert.equal(ui.query('Search managed projects'), undefined, 'no project search in the sheet');
      await settle(() => ui.text().includes('No open work'), 'preview shown');
      assert.equal(ui.get('Delete project').props.accessibilityState.disabled, true, 'a reason first');
      ui.type('Reason', 'merged elsewhere');
      ui.press('Delete project');
      assert.match(ui.text(), /Delete Book\? Repository files and task history stay\./);
      assert.equal(calls.length, 1, 'nothing written before the second press');
      ui.press('Delete project Book');
      await settle(() => Boolean(ui.query('Nucleus, Active')) && !ui.query('Book, Active'), `${width}: back to the list`);
      assert.deepEqual(calls[1], ['project.manage-remove', { key, version: 3, digest: 'pinned', reason: 'merged elsewhere' }]);
      assert.equal(ui.ofType('Modal').length, 0, 'the sheet closed');
    } finally { done(ui); client.clear(); }
  }
});

test('Remove only removes: no Move to, no Remove work; the preview and the removal never name a target', async () => {
  const source = project('only-src', 'Source'), other = project('only-dst', 'Destination');
  const previews: unknown[] = [], requests: unknown[] = [];
  let removed = 0;
  const rpc = { ...noCancel,
    previewRpc: async (input: unknown) => { previews.push(input); return previewOf(source, [{ kind: 'lead', id: 'lead', label: 'Approved brief', shared: true } as Item]); },
    removeRpc: async (input: unknown) => { requests.push(input); return { key: source.key, repositories: source.repositories, reason: 'retired', removedAt: 'now' }; },
  };
  const ui = await sheet({ project: source, projects: [source, other], rpc, onRemoved: () => removed++ });
  await tick();
  assert.equal(ui.query('Move to, Choose'), undefined, 'no Move to dropdown');
  assert.equal(ui.query('Remove work'), undefined, 'no Remove work toggle');
  assert.doesNotMatch(ui.text(), /Move/, 'nothing mentions moving');
  assert.match(ui.text(), /1 open record/);
  assert.match(ui.text(), /lead · Approved brief · shared/);
  assert.match(ui.text(), /Open tasks are cancelled with work preserved; shared planning records listed here close too\./);
  ui.type('Reason', 'retired');
  ui.press('Delete project');
  ui.press('Keep Source');
  assert.equal(requests.length, 0, 'Keep withdraws the confirmation');
  ui.press('Delete project');
  ui.press('Delete project Source');
  await tick();
  assert.deepEqual(previews, [{ key: source.key }]);
  assert.deepEqual(requests, [{ key: source.key, version: 3, digest: 'pinned', reason: 'retired' }]);
  assert.equal(removed, 1);
  done(ui);
});

test('the dialog frame: centred, full radius, fading, bounded width; each icon names its own control', async () => {
  const source = project('frame-src', 'Frame');
  const rpc = { ...noCancel, removeRpc: async () => { throw new Error('no delete'); }, previewRpc: async () => previewOf(source) };
  const ui = await sheet({ project: source, rpc });
  await tick();
  const modal = ui.ofType('Modal')[0]!;
  assert.equal(modal.props.animationType, 'fade');
  const frame = ui.get('Remove Frame dialog');
  assert.equal(frame.props.style.maxWidth, 560);
  assert.ok(frame.props.style.borderRadius > 0);
  assert.equal(frame.props.style.borderTopLeftRadius, undefined, 'not a top-only bottom sheet');
  const scrim = ui.ofType('View').find(node => node.props.style?.justifyContent && node.props.style?.backgroundColor)!;
  assert.equal(scrim.props.style.justifyContent, 'center');
  assert.match(ui.text(), /No open work/);
  assert.equal(ui.get('Refresh open work').props.accessibilityHint, 'Refresh open work');
  assert.equal(ui.get('Close Remove Frame').props.accessibilityHint, 'Close Remove Frame');
  done(ui);
});

test('cancellation: one operation identity survives an interrupted reply, is reconciled identically and never deletes before settlement', async () => {
  const source = project('cancel-src', 'Cancel source');
  const requests: unknown[] = [];
  let removals = 0;
  const rpc = { resetRpc: async () => ({ reset: true as const }),
    previewRpc: async () => previewOf(source, [{ kind: 'task', id: 'task-1', label: 'Active work', shared: false } as Item], [{ taskId: 'task-1', version: 7 }]),
    removeRpc: async () => { removals++; throw new Error('never delete'); },
    cancelRpc: async (input: unknown) => { requests.push(input); throw new Error('response interrupted'); },
    cancellationRpc: async () => { throw new Error('receipt temporarily unavailable'); } };
  const ui = await sheet({ project: source, projects: [source], rpc });
  await tick();
  ui.type('Reason', 'remove stale project');
  ui.press('Cancel 1 task');
  assert.match(ui.text(), /Cancel its task\? Work is preserved\./);
  ui.press('Cancel 1 task Cancel source');
  await tick();
  assert.equal(requests.length, 1); assert.equal(removals, 0);
  assert.match(ui.text(), /Closing this dialog doesn't stop it/);
  assert.equal(ui.get('Cancel 1 task').props.accessibilityState.disabled, true, 'no second request while the first is unsettled');
  ui.press('Reconcile original cancellation');
  await tick();
  assert.deepEqual(requests[1], requests[0], 'only the identical operation may be reconciled');
  ui.press('Close Remove Cancel source');
  done(ui); // unmount stops receipt polling; the durable request continues independently.
});

test('cancellation: a refused stale request resets into a fresh preview that needs its own confirmation', async () => {
  const source = project('refused-src', 'Refused', 2);
  let reset = false;
  const requests: Array<{ operationId: string; tasks: Array<{ taskId: string; version: number }> }> = [];
  const rpc = {
    previewRpc: async () => previewOf(source, [{ kind: 'task', id: 't', label: 'Task', shared: false } as Item], [{ taskId: 't', version: reset ? 8 : 7 }], { digest: reset ? 'new' : 'old' }),
    removeRpc: async () => { throw new Error('no delete'); },
    cancelRpc: async (input: { operationId: string; tasks: Array<{ taskId: string; version: number }> }) => { requests.push(input); throw new Error('Task changed; refresh before retrying'); },
    cancellationRpc: async () => { throw new Error('No accepted batch'); },
    resetRpc: async (input: { operationId: string; tasks: Array<{ taskId: string; version: number }> }) => { assert.equal(input.operationId, requests[0]!.operationId); assert.equal(input.tasks[0]!.version, 7); reset = true; return { reset: true as const }; },
  };
  const ui = await sheet({ project: source, projects: [source], rpc });
  await tick();
  ui.type('Reason', 'cleanup');
  ui.press('Cancel 1 task'); ui.press('Cancel 1 task Refused');
  await tick();
  ui.press('Reset a refused stale cancellation');
  await tick(); await tick();
  assert.equal(ui.query('Cancel 1 task Refused'), undefined, 'the new inventory withdrew the confirmation');
  ui.press('Cancel 1 task'); ui.press('Cancel 1 task Refused');
  await tick();
  assert.equal(requests.length, 2); assert.notEqual(requests[1]!.operationId, requests[0]!.operationId); assert.equal(requests[1]!.tasks[0]!.version, 8);
  done(ui);
});

test('loading, a failed preview without host paths, QA and the 256-task limit block, and a long name wraps', async () => {
  const long = 'A project name long enough to run past the settings column on a phone and keep going';
  const source = project('blocked-src', long);
  let resolve!: (value: ProjectManagementPreview) => void;
  const pending = { ...noCancel, removeRpc: async () => { throw new Error('no delete'); }, previewRpc: () => new Promise<ProjectManagementPreview>(done => { resolve = done; }) };
  const ui = await sheet({ project: source, projects: [source], rpc: pending });
  assert.match(ui.text(), /Checking open work…/);
  assert.equal(ui.get('Delete project').props.accessibilityState.disabled, true, 'nothing to confirm while loading');
  const title = ui.ofType('Text').find(node => node.props.accessibilityRole === 'header' && textOf(node) === `Remove ${long}`)!;
  assert.equal(title.props.numberOfLines, 2, 'a long name wraps to two lines');
  resolve(previewOf(source, [{ kind: 'qa', id: 'qa-1', label: 'Milestone QA running', shared: false } as Item]));
  await tick();
  assert.match(ui.text(), /Pending operations or QA must settle first\. Nothing was removed\./);
  ui.type('Reason', 'cleanup');
  assert.equal(ui.get('Delete project').props.accessibilityState.disabled, true, 'blocked by QA');
  done(ui);

  const many = Array.from({ length: 257 }, (_, index) => ({ taskId: `t${index}`, version: 1 }));
  const big = await sheet({ project: source, projects: [source], rpc: { ...noCancel, removeRpc: async () => { throw new Error('no delete'); }, previewRpc: async () => previewOf(source, [], many) } });
  await tick();
  assert.match(big.text(), /Over the 256-task cancellation limit\. Cancel tasks through Nucleus first\./);
  big.type('Reason', 'cleanup');
  assert.equal(big.get('Cancel 257 tasks').props.accessibilityState.disabled, true);
  done(big);

  const failed = await sheet({ project: source, projects: [source], rpc: { ...noCancel, removeRpc: async () => { throw new Error('no delete'); }, previewRpc: async () => { throw new Error(`store locked at ${syntheticHome}/.local/share/nucleus/store.db`); } } });
  await tick();
  const alert = failed.ofType('Text').find(node => node.props.accessibilityRole === 'alert')!;
  assert.match(textOf(alert), /store locked/);
  assert.equal(textOf(alert).includes(syntheticHome), false, 'host paths removed');
  done(failed);
});
