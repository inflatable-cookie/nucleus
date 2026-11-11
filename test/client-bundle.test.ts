import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

/**
 * Paseo compiles the plugin client with esbuild (es2020, async lowered) and the
 * mobile app evaluates it in Hermes from source, bypassing Metro's Babel
 * transforms. Class syntax survives that build and failed at construction on
 * mobile ("prototype of undefined" opening Settings, 2026-09-29), so the client
 * bundle must not contain a class.
 */
test('the client bundle Paseo compiles for Hermes contains no class syntax', async () => {
  const root = resolve(import.meta.dirname, '..');
  const result = await build({
    entryPoints: [resolve(root, 'index.client.tsx')],
    bundle: true, format: 'cjs', jsx: 'automatic', platform: 'neutral', target: 'es2020',
    supported: { 'async-await': false },
    external: ['@getpaseo/*', '@tanstack/react-query', 'react', 'react/jsx-runtime', 'react-native', 'zod'],
    write: false, logLevel: 'silent',
  });
  const code = result.outputFiles[0]!.text;
  const classes = [...code.matchAll(/(?:^|[=(,:\s])class(?:\s+[A-Za-z_$][\w$]*)?\s*(?:extends\b[^{]*)?\{/gm)].map(m => code.slice(Math.max(0, m.index! - 60), m.index! + 40));
  assert.deepEqual(classes, [], 'client code must not use class syntax');
});

/**
 * Browser-shared code cannot load Node. The backend's shared/service transport
 * deliberately uses Node sockets; scan the client graph independently so those
 * backend modules never mask a Node import reaching Hermes.
 */
test('no shared module the plugin client loads imports a Node module', async () => {
  const root = resolve(import.meta.dirname, '..');
  const reached: string[] = [];
  await build({
    entryPoints: [resolve(root, 'index.client.tsx')],
    bundle: true, format: 'cjs', jsx: 'automatic', platform: 'node', target: 'es2020', write: false, logLevel: 'silent', outdir: 'unused',
    external: ['@getpaseo/*', '@tanstack/react-query', 'react', 'react/jsx-runtime', 'react-native', 'zod'],
    plugins: [{ name: 'shared-node-imports', setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^(?:node:|[a-z][a-z0-9._-]*)/ }, args => {
        if (!args.importer.startsWith(resolve(root, 'shared'))) return;
        if (!(args.path.startsWith('node:') || isBuiltin(args.path))) return;
        reached.push(`${args.path} from ${args.importer.slice(root.length + 1)}`);
        return { path: args.path, external: true };
      });
    } }],
  });
  assert.deepEqual(reached, []);
});
