import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mount, useNativeStubs, type HostNode } from './support/render';

useNativeStubs();
const h = React.createElement;
const colors = new Proxy({}, { get: () => '#123' }) as never;

test('queue actions precede a viewport-constrained scrolling run list', async () => {
  const { BoardHeader } = await import('../client/board/header');
  for (const count of [0, 3, 8]) {
    const state = {
      connected: true, paused: false, dispatchHeld: false, drained: false,
      boundRuns: Array.from({ length: count }, (_, i) => ({ runId: `run-${i}`, taskId: `task-${i}`, role: 'worker' })),
      projectLimitOverrides: {}, projectCapacities: [], qaFence: { fence: null },
    };
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = mount(h(QueryClientProvider, { client: query, children: h(BoardHeader, {
      c: colors, state: state as never, refetchState: async () => {}, busy: false,
      act: async () => {}, error: '', onDismissError: () => {}, readError: null,
      staleRead: null, inset: 12, settingsOpener: null, navigation: null, children: null,
    }) }));
    ui.press('Queue controls menu');
    const menu = ui.get('Queue controls');
    const children = menu.children.filter((node): node is HostNode => typeof node !== 'string');
    assert.deepEqual(children.slice(0, 3).map(node => node.props.accessibilityLabel), ['Pause', 'Dispatch hold', 'Stop']);
    const list = children[3];
    assert.equal(list.type, 'ScrollView');
    assert.equal(list.props.accessibilityLabel, `${count} bound runs`);
    assert.equal(list.children.length, count + 1);
    assert.equal(list.props.nestedScrollEnabled, true);
    assert.equal(list.props.style.flexShrink, 1);
    assert.equal(list.props.style.minHeight, 0);
    assert.ok(list.props.style.maxHeight > 0);
    assert.ok(menu.props.style.maxHeight > 0 && menu.props.style.maxHeight < 900);
    ui.update(h('View'));
    query.clear();
  }
});
