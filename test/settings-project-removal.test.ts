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
const project = (key: string, name = key, version = 3): Project => ({ key, name, version,  repositories: [repo(`acme/${key}`)], primary: repo(`acme/${key}`), drain: null }) as Project;
const settingsRowOf = (p: Project): ProjectSettingsRow => ({
  project: p, repositories: p.repositories.map((repository, index) => ({ repository, primary: index === 0, settings: null })),
  slots: { value: 4, override: null }, plannerLive: null, plannerTicket: null, problems: [],
}) as ProjectSettingsRow;
const settingsOf = (projects: Project[]): ProjectSettings => ({ defaultSlots: 4, projects: projects.map(settingsRowOf) });
type Item = ProjectManagementPreview['items'][number];
const previewOf = (p: Project, items: Item[] = [], tasks: Array<{ taskId: string; version: number }> = [], extra: Partial<ProjectManagementPreview> = {}) =>
  ({ project: p, target: null, digest: 'pinned', items, tasks, ...extra }) as ProjectManagementPreview;
const noCancel = {};

async function sheet(props: Record<string, unknown>) {
  const { ProjectManagementView } = await import('../client/project-management-view');
  return mount(h(ProjectManagementView, { c: dark, onClose: () => {}, onRemoved: () => {}, ...props } as never));
}




test('the section hint is taken once, by the next Settings screen or by one already showing', async () => {
  const { hintSettingsSection, takeSettingsSection } = await import('../client/settings-hint');
  assert.equal(takeSettingsSection(), null);
  hintSettingsSection('projects');
  assert.equal(takeSettingsSection(), 'projects');
  assert.equal(takeSettingsSection(), null, 'used once: plain Settings opens at its first section');
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
  assert.match(ui.text(), /Deleting this project also deletes its planning records\./);
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
  assert.equal(big.get('Delete project').props.accessibilityState.disabled, true);
  done(big);

  const failed = await sheet({ project: source, projects: [source], rpc: { ...noCancel, removeRpc: async () => { throw new Error('no delete'); }, previewRpc: async () => { throw new Error(`store locked at ${syntheticHome}/.local/share/nucleus/store.db`); } } });
  await tick();
  const alert = failed.ofType('Text').find(node => node.props.accessibilityRole === 'alert')!;
  assert.match(textOf(alert), /store locked/);
  assert.equal(textOf(alert).includes(syntheticHome), false, 'host paths removed');
  done(failed);
});

test('Rust removal refuses open tasks in the shared dialog and requires a second confirmation', async () => {
  const source = project('rust-removal', 'Rust project');
  let blocked = true;
  const requests: unknown[] = [];
  const rpc = {
    previewRpc: async () => blocked ? previewOf(source,
      [{ kind: 'task', id: 'task-1', label: 'Fixture task', shared: false }],
      [{ taskId: 'task-1', version: 2 }]) : previewOf(source),
    removeRpc: async (input: unknown) => {
      requests.push(input);
      return { key: source.key, repositories: source.repositories, reason: 'retired', removedAt: 'now' };
    },
  };
  const ui = await sheet({ project: source, rpc });
  try {
    await tick();
    ui.type('Reason', 'retired');
    assert.equal(ui.query('Cancel 1 task'), undefined);
    assert.match(ui.text(), /Finish or cancel the open tasks/);
    assert.equal(ui.get('Delete project').props.disabled, true);
    blocked = false;
    ui.press('Refresh open work');
    await tick();
    ui.press('Delete project');
    assert.equal(requests.length, 0);
    ui.press('Delete project Rust project');
    await tick();
    assert.deepEqual(requests, [{ key: source.key, version: 3, digest: 'pinned', reason: 'retired' }]);
  } finally {
    done(ui);
  }
});
