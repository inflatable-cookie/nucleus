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

/** Queue #1391: the header's queue menu, which holds the slot table (Tom, 2026-11-21), renders in the top layer too. */
