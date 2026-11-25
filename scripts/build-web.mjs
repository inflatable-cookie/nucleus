import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildEngineBoard(out) {
  await mkdir(out, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ['client/web/engine-index.tsx'],
    outfile: resolve(out, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    alias: { 'react-native': 'react-native-web' },
    plugins: [{
      name: 'web-shell',
      setup(api) {
        api.onResolve({ filter: /^\./ }, args => {
          const target = resolve(args.resolveDir, args.path);
          if (args.importer.startsWith(join(root, 'client') + '/') &&
              (target === join(root, 'client/shell') || target === join(root, 'client/shell/index'))) {
            return { path: join(root, 'client/web/shell.tsx') };
          }
          return null;
        });
      },
    }],
    minify: true,
  });
  await writeFile(join(out, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nucleus</title><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: effigy engine:board-build -- /absolute/asset-directory');
  await buildEngineBoard(process.argv[2]);
}
