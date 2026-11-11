/**
 * The test harness's own contracts, kept beside the fixture support they guard.
 *
 * Both contracts were violated by milestone 9a3fb2d7: `useSyncExternalStore`
 * treated react-query's fresh `getSnapshot` arrow as a subscription dependency,
 * so every pass tore down and resubscribed every query, refetched it and
 * re-dirtied the tree until the render-loop guard fired; and socket fixtures
 * spent more path bytes than the local Unix transport binds, so the product's
 * fail-closed refusal (or a `chmod` ENOENT) replaced the assertion under test.
 * These cases hold the general rule, not one fixture: a store subscription is
 * keyed by `subscribe` alone, and a socket path is stated against its bound
 * before a product starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import React from 'react';
import { mount } from './support/render';
import { assertSocketPathFits, socketFixtureRoot, SOCKET_PATH_BOUND } from './support/socket-fixture';

const h = React.createElement;

test('an external store subscribes once while its snapshot reader identity changes, and still follows the store', () => {
  let snapshot = { count: 0 };
  const listeners = new Set<() => void>();
  const counters = { subscribes: 0, unsubscribes: 0, renders: 0 };
  const subscribe = (onChange: () => void) => {
    counters.subscribes += 1;
    listeners.add(onChange);
    return () => { counters.unsubscribes += 1; listeners.delete(onChange); };
  };
  // The react-query shape: a new reader arrow every render over a cached value.
  function Store() {
    counters.renders += 1;
    const value = React.useSyncExternalStore(subscribe, () => snapshot);
    return h('span', { accessibilityLabel: 'count' }, `count ${value.count}`);
  }
  const tree = mount(h(Store));
  assert.equal(tree.text(), 'count 0');
  assert.deepEqual([counters.subscribes, counters.unsubscribes], [1, 0], 'the store is subscribed exactly once');

  // Three re-renders with a changed reader identity and an unchanged value.
  for (let pass = 0; pass < 3; pass++) tree.update(h(Store));
  assert.equal(tree.text(), 'count 0');
  assert.deepEqual([counters.subscribes, counters.unsubscribes], [1, 0], 'reader identity is not a subscription dependency');

  // The store still drives the surface, and settles instead of churning.
  snapshot = { count: 1 };
  for (const listener of listeners) listener();
  assert.equal(tree.text(), 'count 1', 'a store change renders the new value');
  const settledAt = counters.renders;
  tree.update(h(Store));
  assert.equal(counters.renders, settledAt + 1, 'one re-render per update, no continuing churn');
  assert.deepEqual([counters.subscribes, counters.unsubscribes], [1, 0], 'no pass resubscribed');

  // Disposal releases the one subscription, so a finished surface stops listening.
  tree.update(h('div', null, 'closed'));
  assert.deepEqual([counters.subscribes, counters.unsubscribes], [1, 1], 'the surface releases its subscription when it leaves');
});

test('a changed subscribe identity replaces the old subscription exactly once', () => {
  let snapshot = { count: 0 };
  const counters = { first: 0, second: 0, unsubscribes: 0 };
  const first = (onChange: () => void) => { counters.first += 1; return () => { counters.unsubscribes += 1; }; };
  const second = (onChange: () => void) => { counters.second += 1; return () => { counters.unsubscribes += 1; }; };
  function Store({ subscribe }: { subscribe: (onChange: () => void) => () => void }) {
    const value = React.useSyncExternalStore(subscribe, () => snapshot);
    return h('span', { accessibilityLabel: 'count' }, `count ${value.count}`);
  }
  const tree = mount(h(Store, { subscribe: first }));
  tree.update(h(Store, { subscribe: first }));
  assert.deepEqual([counters.first, counters.second, counters.unsubscribes], [1, 0, 0], 'an unchanged store keeps one subscription');
  tree.update(h(Store, { subscribe: second }));
  assert.deepEqual([counters.first, counters.second, counters.unsubscribes], [1, 1, 1], 'a new store releases the old and takes one');
  snapshot = { count: 2 };
  tree.update(h(Store, { subscribe: second }));
  assert.equal(tree.text(), 'count 2');
});

test('a store whose snapshot is never the same value still trips the render-loop guard', () => {
  function Unstable() {
    const value = React.useSyncExternalStore(() => () => {}, () => ({ at: Math.random() }));
    return h('span', null, String(value.at));
  }
  assert.throws(() => mount(h(Unstable)), /render loop: 500\d+? passes/, 'the guard is not raised, removed or skipped');
});

test('a fixture socket path inside the transport bound is accepted and one beyond it is refused with both lengths', () => {
  assert.doesNotThrow(() => assertSocketPathFits('/' + 's'.repeat(SOCKET_PATH_BOUND - 2)));
  assert.throws(() => assertSocketPathFits('/' + 's'.repeat(SOCKET_PATH_BOUND - 1)),
    new RegExp(`fixture socket path is ${SOCKET_PATH_BOUND} bytes and the local transport binds fewer than ${SOCKET_PATH_BOUND}`));
});

test('a socket fixture root is one short name inside the mounted scratch the suite runs in', () => {
  const root = socketFixtureRoot('nfx-');
  try {
    assert.equal(existsSync(root), true);
    assert.match(basename(root), /^[a-f0-9]{6}$/, 'the fixture uses a short hash name');
    assert.equal(dirname(root), realpathSync(tmpdir()), 'the root is a direct child of the run scratch, never a repository path or a home fallback');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
