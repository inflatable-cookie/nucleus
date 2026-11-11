/**
 * A minimal synchronous renderer for client component tests. It runs function
 * components with useState, useRef, useEffect, useMemo and useCallback, renders
 * host elements as plain nodes and dispatches presses and text changes. Import
 * client modules after `useNativeStubs()` so react-native resolves to host stubs.
 */
import * as nodeModule from 'node:module';
import React from 'react';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { bindBoardShell } from '../../client/shell';

const stub = new URL('./native-stub.mjs', import.meta.url).href;
/** react-native (Flow source) and the plugin's native entry resolve to host-string stubs. */
export function useNativeStubs() {
  const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: { resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown): unknown }): void };
  registerHooks({ resolve: (specifier, context, next) =>
    specifier === 'react-native' || specifier === '@getpaseo/plugin/client/react-native' ? { url: stub, shortCircuit: true } : next(specifier, context) });
  const shell = nodeModule.createRequire(import.meta.url)('./board-shell');
  bindBoardShell(shell);
}

/** Bundled renders use the same shell stand-ins as direct source renders. */
export const boardShellPlugin: Plugin = {
  name: 'test-board-shell',
  setup(build) {
    build.onResolve({ filter: /(?:^|\/)shell(?:\/index)?$/ }, args => {
      const path = resolve(args.resolveDir, args.path);
      const shell = resolve(import.meta.dirname, '../../client/shell');
      if (path === shell || path === `${shell}/index`) return { path: resolve(import.meta.dirname, 'board-shell.ts') };
    });
  },
};

export type HostNode = { type: string; props: Record<string, any>; children: Array<HostNode | string> };
type Slot = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: () => void };
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const changed = (prev: unknown[] | undefined, next: unknown[] | undefined) => !prev || !next || next.length !== prev.length || next.some((dep, index) => !Object.is(dep, prev[index]));

export function mount(initial: React.ReactElement) {
  let element = initial, tree: Array<HostNode | string> = [], rendering = false, dirty = false;
  const states = new Map<string, Slot[]>();
  let effects: Array<() => void> = [], seen = new Set<string>();

  function call(type: (props: unknown) => React.ReactNode, props: unknown, path: string) {
    seen.add(path);
    const slots = states.get(path) ?? [];
    states.set(path, slots);
    let index = 0;
    const effect = (fn: () => void | (() => void), deps?: unknown[]) => {
      const at = index++, prev = slots[at];
      if (prev && !changed(prev.deps, deps)) return;
      slots[at] = { deps, cleanup: prev?.cleanup };
      effects.push(() => { slots[at].cleanup?.(); const cleanup = fn(); slots[at].cleanup = typeof cleanup === 'function' ? cleanup : undefined; });
    };
    const memo = (fn: () => unknown, deps?: unknown[]) => {
      const at = index++, prev = slots[at];
      if (prev && !changed(prev.deps, deps)) return prev.value;
      slots[at] = { value: fn(), deps };
      return slots[at].value;
    };
    const dispatcher = {
      useState(init: unknown) {
        const at = index++;
        if (!slots[at]) slots[at] = { value: typeof init === 'function' ? (init as () => unknown)() : init };
        const slot = slots[at];
        return [slot.value, (next: unknown) => {
          const value = typeof next === 'function' ? (next as (value: unknown) => unknown)(slot.value) : next;
          if (Object.is(value, slot.value)) return;
          slot.value = value;
          schedule();
        }];
      },
      useRef(init: unknown) { const at = index++; if (!slots[at]) slots[at] = { current: init }; return slots[at]; },
      useEffect: effect, useLayoutEffect: effect, useInsertionEffect: effect,
      useMemo: memo,
      useCallback: (fn: unknown, deps?: unknown[]) => memo(() => fn, deps),
      useContext: (context: { _currentValue: unknown }) => context._currentValue,
      // External-store hooks (plugin state selectors, react-query subscriptions).
      // Like React, only a changed `subscribe` identity resubscribes; the newest
      // `getSnapshot` is read through the slot. React-query builds a fresh
      // `getSnapshot` arrow every render, so treating it as a dependency tore
      // every query down and resubscribed it on each pass, which refetched the
      // queries and re-dirtied the tree forever.
      useSyncExternalStore(subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => unknown) {
        const at = index++;
        const slot = slots[at] ?? (slots[at] = { value: getSnapshot() });
        const value = getSnapshot();
        if (!Object.is(value, slot.value)) { slot.value = value; schedule(); }
        slot.current = getSnapshot;
        const check = () => {
          const next = (slot.current as () => unknown)();
          if (!Object.is(next, slot.value)) { slot.value = next; schedule(); }
        };
        effect(() => {
          const unsubscribe = subscribe(check);
          // A store may have changed between render and subscription.
          check();
          return unsubscribe;
        }, [subscribe]);
        return slot.value;
      },
      useDebugValue() { /* no-op under the test renderer */ },
    };
    const previous = internals.H;
    internals.H = dispatcher;
    try { return type(props); } finally { internals.H = previous; }
  }

  function walk(node: React.ReactNode, path: string): Array<HostNode | string> {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap((child, index) => walk(child, `${path}[${(child as React.ReactElement)?.key ?? index}]`));
    const { type, props } = node as React.ReactElement<Record<string, any>>;
    if (type === React.Fragment) return walk(props.children, path);
    if (typeof type === 'string') return [{ type, props, children: walk(props.children, `${path}/${type}`) }];
    // React.memo: render the wrapped component under its own name; the renderer never skips.
    if (type && typeof type === 'object' && (type as { $$typeof?: unknown }).$$typeof === Symbol.for('react.memo'))
      return walk(React.createElement((type as unknown as { type: React.ElementType }).type, props), path);
    if (typeof type === 'function') {
      const next = `${path}/${type.name}`;
      return walk(call(type as (props: unknown) => React.ReactNode, props, next), next);
    }
    // React 19 context providers: the provider is the context object itself, and
    // useContext reads `_currentValue`, so scope it around the children walk.
    if (type && typeof type === 'object' && (type as { $$typeof?: unknown }).$$typeof === Symbol.for('react.context')) {
      const context = type as { _currentValue: unknown };
      const previous = context._currentValue;
      context._currentValue = (props as { value: unknown }).value;
      try { return walk((props as { children: React.ReactNode }).children, path); } finally { context._currentValue = previous; }
    }
    throw new Error(`Unsupported element type ${String(type)}`);
  }

  let renderCount = 0;
  function render() {
    rendering = true;
    do {
      // Always-on QueryClient reads (host runs plus the accounting list) add
      // passes per mount; 300 fired on the bundled board after that join.
      if (++renderCount > 5000) throw new Error(`render loop: ${renderCount} passes; states=${states.size}`);
      dirty = false;
      seen = new Set();
      effects = [];
      tree = walk(element, '');
      for (const path of [...states.keys()]) if (!seen.has(path)) { for (const slot of states.get(path)!) slot?.cleanup?.(); states.delete(path); }
      for (const run of effects) run();
    } while (dirty);
    rendering = false;
  }
  function schedule() { if (rendering) dirty = true; else render(); }

  const all = () => { const out: HostNode[] = []; const visit = (items: Array<HostNode | string>) => { for (const item of items) if (typeof item !== 'string') { out.push(item); visit(item.children); } }; visit(tree); return out; };
  const text = (node: HostNode | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
  const byLabel = (label: string | RegExp) => all().filter(node => typeof node.props.accessibilityLabel === 'string' && (typeof label === 'string' ? node.props.accessibilityLabel === label : label.test(node.props.accessibilityLabel)));
  const get = (label: string | RegExp) => {
    const found = byLabel(label);
    if (found.length !== 1) throw new Error(`Expected one node labelled ${label}, found ${found.length}`);
    return found[0];
  };

  render();
  return {
    update(next: React.ReactElement) { element = next; render(); },
    get, query: (label: string | RegExp) => byLabel(label)[0],
    all: byLabel,
    ofType: (type: string) => all().filter(node => node.type === type),
    text: () => tree.map(text).join(' '),
    press(label: string | RegExp) { get(label).props.onPress(); },
    type(label: string | RegExp, value: string) { get(label).props.onChangeText(value); },
  };
}
