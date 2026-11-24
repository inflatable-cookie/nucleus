import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { mount, useNativeStubs, type HostNode } from './support/render';

useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, { get: () => '#123' }) as never;

test('queue actions precede the slot table and run list in a viewport-constrained scrolling menu', async () => {
  const { BoardHeader } = await import('../client/board/header');
  for (const count of [0, 3, 8]) {
    const state = {
      connected: true, paused: false, dispatchHeld: false, drained: false,
      boundRuns: Array.from({ length: count }, (_, i) => ({ runId: `run-${i}`, taskId: `task-${i}`, role: 'worker' })),
      projectLimitOverrides: {}, projectCapacities: [],
    };
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = mount(h(QueryClientProvider, { client: query, children: h(PluginRpcProvider, { invoke: async () => ({}), children: h(BoardHeader, {
      c: colors, state: state as never, refetchState: async () => {}, busy: false,
      act: async () => {}, error: '', onDismissError: () => {}, readError: null,
      staleRead: null, inset: 12, settingsOpener: null, filter: null, children: null,
    }) }) }));
    const pause = ui.get('Pause and drain');
    assert.equal(pause.props.accessibilityHint, 'Pause and drain');
    assert.equal(pause.props.style.borderTopRightRadius, 0);
    assert.equal(pause.props.style.borderBottomRightRadius, 0);
    assert.doesNotMatch(ui.text(), /Pause and drain/, 'the button displays only its icon');
    pause.props.onHoverIn();
    assert.match(ui.text(), /Pause and drain/, 'hover reveals the icon button label');
    ui.get('Pause and drain').props.onHoverOut();
    assert.doesNotMatch(ui.text(), /Pause and drain/, 'leaving the button hides the label');
    ui.press('Queue controls menu');
    const menu = ui.get('Queue controls');
    const children = menu.children.filter((node): node is HostNode => typeof node !== 'string');
    assert.deepEqual(children.slice(0, 3).map(node => node.props.accessibilityLabel), ['Pause', 'Dispatch hold', 'Stop']);
    // The slot table and the bound runs follow the actions; the whole menu scrolls inside the viewport.
    assert.match(String(children[3].props.accessibilityLabel), /^Project slot usage/);
    const list = children[4];
    assert.equal(list.props.accessibilityLabel, `${count} bound runs`);
    assert.equal(list.children.length, Math.min(count, 8) + 1);
    assert.equal(menu.type, 'ScrollView');
    assert.equal(menu.props.nestedScrollEnabled, true);
    assert.ok(menu.props.style.maxHeight > 0 && menu.props.style.maxHeight < 900);
    ui.update(h('View'));
    query.clear();
  }
});
