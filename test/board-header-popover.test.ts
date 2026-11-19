import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs, type HostNode } from './support/render';

useNativeStubs();
const h = React.createElement;
const c = new Proxy({}, { get: () => '#123' }) as never;
const textOf = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('');
const contains = (node: HostNode, label: string): boolean => node.children.some(child => typeof child !== 'string' && (child.props.accessibilityLabel === label || contains(child, label)));

const repo = (name: string) => ({ origin: `owner/${name}`, path: `/${name}` });
const project = (key: string) => ({ key, name: key, repositories: [repo(key)], primary: repo(key), owner: { agentId: 'thread', assignedBy: 'operator', assignedAt: '2026-10-03T00:00:00.000Z', note: '' } });
const projects = [project('consumer-b-v2'), project('project-a-accelerator')];

/** Queue #1391: the open project popover renders in the top layer, above the board columns. */
test('the open project selector renders in the popover layer, not inside the header row', async () => {
  const { PopoverHost, POPOVER_LAYER_ID } = await import('../client/popover');
  const { ProjectSelector } = await import('../client/project-scope-controls');
  const ui = mount(h(PopoverHost, null,
    h('View', { accessibilityLabel: 'Trigger row' },
      h(ProjectSelector, { projects: projects as never, tasks: [], leads: [], value: [], onChange: () => {}, onOpenChange: () => {}, compact: false, c })),
    h('View', { accessibilityLabel: 'Column container' }, h('Text', null, 'Working card'))));
  const layer = () => ui.ofType('View').find(node => node.props.testID === POPOVER_LAYER_ID)!;
  assert.ok(layer(), 'the host mounts one layer');
  ui.press(/^Projects, /);
  assert.ok(contains(layer(), 'Project selector'), 'the open popover is in the top layer');
  assert.ok(!contains(ui.get('Trigger row'), 'Project selector'), 'and not inside the header row');
  assert.ok(!contains(ui.get('Column container'), 'Project selector'), 'and not inside the column container');
  assert.ok(ui.get('Column container'), 'the columns still render below');
  ui.update(h('View'));
});

/** Queue #1391: the header's other menus render in the top layer too. */
test("the header's queue and slot menus render in the popover layer, above the board columns", async () => {
  const { PopoverHost, POPOVER_LAYER_ID } = await import('../client/popover');
  const { BoardHeader } = await import('../client/board/header');
  const state = {
    connected: true, paused: false, quiet: false, stoppedThreads: 0,
    activeWorkers: 0, unsettled: 0, occupiedSlots: 1, globalLimit: 10,
    projectLimit: 2, projectLimitOverrides: {}, dispatchHeld: false,
    operationBacklog: 0, drained: false, boundRuns: [],
    projectCapacities: [{ projectKey: 'a', projectName: 'Alpha', occupiedSlots: 1, slotLimit: 2, inFlightTasks: 1, inFlightLimit: 5 }],
    qaFence: { fence: null },
  };
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = mount(h(QueryClientProvider, { client: query, children: h(PluginRpcProvider, { invoke: async () => ({}), children: h(PopoverHost, null,
    h(BoardHeader, {
      c, state: state as never, refetchState: async () => {}, busy: false,
      act: async () => {}, error: '', onDismissError: () => {}, readError: null,
      staleRead: null, inset: 12, settingsOpener: null, navigation: null,
      children: h('View', { accessibilityLabel: 'Column container' }, h('Text', null, 'Working card')),
    })) }) }));
  const layer = () => ui.ofType('View').find(node => node.props.testID === POPOVER_LAYER_ID)!;
  assert.ok(layer(), 'the board shell mounts one layer');

  ui.press('Queue controls menu');
  assert.ok(contains(layer(), 'Queue controls'), 'the queue menu is in the top layer');
  assert.ok(!contains(ui.get('Column container'), 'Queue controls'), 'and not inside the column container');
  ui.press('Close queue controls');

  ui.press(/^Project slot usage/);
  assert.ok(contains(layer(), 'Projects using slots'), 'the slot popover is in the top layer');
  assert.ok(!contains(ui.get('Column container'), 'Projects using slots'), 'and not inside the column container');
  assert.ok(textOf(layer()).includes('Alpha'), 'the slot counts render in the layer');
  ui.update(h('View'));
  query.clear();
});
