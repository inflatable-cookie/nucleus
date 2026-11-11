import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { readFileSync } from 'node:fs';
import { boardSource } from './support/board-source';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// The host wraps contributed components with these providers from the SDK's host
// entry. A static import keeps them in the same module cache the client bundle's
// own SDK imports resolve to (one React context instance).
import { PluginClientStateProvider, PluginRpcProvider } from '@getpaseo/plugin/client/host';
import type { PluginWorkspaceSnapshot } from '@getpaseo/plugin';
import { mount, useNativeStubs } from './support/render';

useNativeStubs();

type QueueModule = typeof import('../client/queue');
let queue: QueueModule;
const load = async () => {
  queue = await import('../client/queue');
  return queue;
};
const h = React.createElement;
const c = new Proxy({}, { get: () => '#000' }) as never;
const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

const repo = { origin: 'owner/consumer', path: '/repo' };
const project = { key: 'consumer-b-v2', name: 'Consumer-B', repositories: [repo], primary: repo };
const board = {
  revision: 1, connected: true, hostId: 'host', paused: false, error: '', quiet: true,
  activeWorkers: 0, unsettled: 0, globalLimit: 32, projectLimit: 5,
  tasks: [], profiles: [], pool: [], availability: [], assignments: {}, recentAssignments: {},
  lanes: [], projects: [project], prStates: {},
};

/** RPC stub: project.get resolves by repository path; the board's reads return empty projections. */
const invoke = (project: unknown) => async (method: string, input: unknown) => {
  if (method === 'project.get') {
    const repository = (input as { repository: { origin: string | null; path: string } }).repository;
    return project !== undefined && repository.origin === null && repository.path === '/repo' ? project : null;
  }
  if (method === 'queue.ui-snapshot') return project === undefined ? {} as never : board;
  if (method === 'queue.service-state') return { state: 'running', detail: '', error: '', ready: true, paused: false, hostId: 'host' };
  if (method === 'plans' || method === 'papercut.list' || method === 'lead.board' || method === 'draft.list' || method === 'decision.list') return [];
  return {};
};

const source = (root: string | null) => {
  // The host caches snapshots; a stable identity keeps external-store subscriptions quiet.
  const workspace = (root === null ? null : { projectRootPath: root, directory: root }) as PluginWorkspaceSnapshot | null;
  return { subscribe: () => () => {}, getWorkspace: (_id: string) => workspace, getAgent: () => null };
};

const panelProps = { context: 'workspace' as const, workspaceId: 'w1', theme: { colors: c }, host: { id: 'host', label: 'Host' }, layout: { compact: false, platform: 'ios' as const } };

/** The panel under its host providers: client state, RPC and a react-query client.
 * Built as one element tree (not a wrapper component) so the closures the panel
 * hooks depend on keep stable identities across render passes. */
function panelTree(project: unknown, root: string | null) {
  return h(QueryClientProvider, {
    client: new QueryClient(),
    children: h(PluginRpcProvider, {
      invoke: invoke(project),
      children: h(PluginClientStateProvider, {
        source: source(root),
        children: h(queue.QueueBoardPanel as never, panelProps),
      }),
    }),
  });
}
let settled: Promise<Awaited<ReturnType<typeof load>>> | null = null;
const ready = () => { settled ??= load(); return settled; };

/** Yield until the panel settles or the probe keeps failing. */
async function settle(probe: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (probe()) return;
    await tick();
  }
  assert.fail('the workspace panel did not settle');
}

/** Unmount so query observers drop their refetch intervals and the suite can exit. */
function unmount(ui: ReturnType<typeof mount>) {
  ui.update(h('View', null));
}

test('026-14c rendered: the panel resolves a workspace inside a project repository to that project and presets the selection', async () => {
  await ready();
  const ui = mount(panelTree(project, '/repo'));
  // The label starts at the raw project key and settles to the project's name once the board loads.
  await settle(() => ui.query(/^Projects, /)?.props.accessibilityLabel === 'Projects, Consumer-B' && ui.query('Nucleus navigation') !== undefined);
  // The workspace's project root resolved to the project and presets the selector.
  assert.equal(ui.get(/^Projects, /).props.accessibilityLabel, 'Projects, Consumer-B');
  assert.match(ui.text(), /Nucleus board · Consumer-B/, 'the panel header names the resolved project');
  // Tasks renders the Pipeline with no Lanes switch (retired 2026-11-08); the separate
  // Lanes destination is folded into Planning (#866), so nothing is labelled Lanes.
  assert.equal(ui.all('Lanes').length, 0, 'no Lanes switch or tab');
  assert.equal(ui.query('Drafts'), undefined);
  assert.ok(ui.get(/^Tasks \(/));
  assert.ok(ui.get(/^QA runs \(/));
  assert.equal(ui.all(/^Lanes/).length, 0, 'no Lanes navigation button and no board switch');
  ui.get(/^Planning$/).props.onPress();
  assert.ok(ui.get('Find lanes'), 'Planning carries lane discovery now');
  assert.ok(ui.get('Project: Consumer-B'), 'and its own project chooser over the preset scope');
  assert.ok(ui.query(/^Projects, /), 'the header project selector stays available on Planning');
  unmount(ui);
});

test('026-14c rendered: a workspace outside every project shows a plain message', async () => {
  await ready();
  const ui = mount(panelTree(null, '/repo'));
  await settle(() => ui.text().includes('outside every Nucleus project'));
  assert.ok(ui.get('Nucleus board message'));
  assert.equal(ui.query('Nucleus navigation'), undefined, 'no board without a project');
  unmount(ui);
});

test('026-14c rendered: a workspace without a snapshot or project root cannot resolve', async () => {
  await ready();
  const ui = mount(panelTree(project, null));
  await settle(() => ui.text().includes('cannot see this workspace'));
  assert.ok(ui.get('Nucleus board message'));
  assert.equal(ui.query('Nucleus navigation'), undefined);
  unmount(ui);
});

test('026-14c the Open Nucleus board workspace command opens the registered panel', () => {
  const entry = read('hosts/paseo/client/index.tsx');
  assert.match(entry, /addWorkspacePanel\(\{ id: BOARD_PANEL_ID, title: "Nucleus board", icon: "LayoutDashboard", locations: \["workspace"\], context: "workspace", Component: QueueBoardPanel \}\)/);
  assert.match(entry, /addCommandCenterItem\(\{ id: BOARD_PANEL_ID, title: "Open Nucleus board", [^}]*context: "workspace", onSelect: context => context\.openPanel\(BOARD_PANEL_ID\) \}\)/);
});

test('026-14c the panel reuses the main surface board; there is no second copy of board code', () => {
  const ui = boardSource();
  assert.match(ui, /<MainSurface \{\.\.\.props\} workspaceBoard=\{resolution\} \/>/);
  assert.equal(ui.match(/<ProjectSelector\b/g)?.length, 1, 'one selector, preset by the workspace variant');
  assert.equal(ui.match(/ref=\{pipelineHorizontal\}/g)?.length, 1, 'one pipeline view');
  // Both Lanes modes project the one shared pipeline input, so adding a further
  // consumer of it cannot be mistaken for a divergent board. A second board
  // would have to introduce its own input instead of spreading this one.
  assert.match(ui, /const columns = useMemo\(\(\) => pipelineBoard\(pipelineInput\),/, 'the shared input feeds the one board projection');
  // The panel's scope is preset in the panel and never touches the main surface's persisted scope.
  assert.match(ui, /usePanelScope\(workspaceBoard\?\.key \?\? null\)/);
  assert.match(ui, /const scope = workspaceBoard \? panelScope \?\? \{ projects: \[workspaceBoard\.key\], statusFilter: true \} : surfaceScope;/);
});

