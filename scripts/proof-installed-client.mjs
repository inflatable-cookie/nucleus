import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
// Match the CJS host module identity used when evaluating the client below.
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

/** Evaluate the installed bytes with real React/Query; only host APIs are stubs.
 * This is a first-render smoke, not native layout, interactions or RPC coverage.
 */
export async function proveInstalledClient(packageRoot) {
  const result = await build({
    entryPoints: [join(packageRoot, 'client/index.client.js')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react/*', '@tanstack/react-query', '@tanstack/react-query/*', 'zod', 'zod/*', 'react-native', 'react-native/*', '@getpaseo/plugin', '@getpaseo/plugin/*'],
  });
  const surfaces = new Map();
  const native = Object.fromEntries(['Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name,
    ({ children }) => React.createElement('div', { 'data-native': name }, children)]));
  native.Platform = { OS: 'web', select: options => options.web ?? options.default };
  const host = { useRpc: () => async () => undefined, useWorkspace: () => null };
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, console, process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    require: name => name === 'react-native' ? native
      : name === '@getpaseo/plugin/client' ? host
        : name === '@getpaseo/plugin/client/react-native' ? { Icon: () => null }
          : require(name),
  }, { filename: 'installed-client.cjs' });
  const remove = () => {};
  const cleanup = module.exports.default({
    addSurface: (name, component) => { surfaces.set(name, component); return remove; },
    addSettingsScreen: screen => { surfaces.set('settings', screen.Component); return remove; },
    addWorkspacePanel: panel => { surfaces.set('workspace', panel.Component); return remove; },
    addSidebarItem: () => remove, addCommandCenterItem: () => remove,
    paseo: { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } },
  });
  try {
    assert.equal(surfaces.size, 3, 'installed plugin must register all three surfaces');
    const props = { theme: { colors: new Proxy({}, { get: () => '#181818' }) }, layout: { compact: false }, navigation: {}, workspaceId: 'proof' };
    for (const [name, component] of surfaces) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      try {
        const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(component, props)));
        assert.ok(html.length, `${name} rendered no content`);
      } finally { client.clear(); }
    }
  } finally { cleanup(); }
  console.log('client=installed main=rendered settings=rendered workspace=rendered theme=dark host=stubbed');
}
