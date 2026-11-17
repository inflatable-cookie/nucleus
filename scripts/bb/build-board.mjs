#!/usr/bin/env node
/**
 * Spec 062, phase 6: bundle the shared board for the BB plugin.
 *
 * BB builds a plugin from its own directory with its own esbuild, which has no
 * react-native alias, so the shared board (written against react-native) cannot be
 * imported from the plugin's `app.tsx` directly. This script bundles
 * `hosts/bb/client/index.ts` and everything it imports from `client/` and `shared/`
 * into one ES module inside the plugin package:
 *
 * - `react-native` resolves to `react-native-web`, as the local web board does;
 * - React, `react-dom` and the JSX runtime stay external, so BB's own runtime slots
 *   supply them and the board shares BB's React instance;
 * - everything else (react-query, zod, the board) is bundled.
 *
 * The output, `hosts/bb/plugin/board/nucleus-board.js`, is generated and ignored by
 * Git; `nucleus-board.d.ts` beside it is the committed type surface. Run this
 * before `bb plugin build` (`effigy proof:bb:sidebar` does).
 *
 *   effigy bb:board-build
 */
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BOARD_BUNDLE = join(root, 'hosts', 'bb', 'plugin', 'board', 'nucleus-board.js');

export async function buildBoard(outfile = BOARD_BUNDLE) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['hosts/bb/client/index.ts'],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    alias: { 'react-native': 'react-native-web' },
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
    metafile: true,
  });
  return { outfile, bytes: Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No top-level await: the acceptance scripts import this module through tsx's CJS path.
  buildBoard(process.argv[2] ? resolve(process.argv[2]) : BOARD_BUNDLE).then(({ outfile, bytes }) => {
    console.log(`Built the BB board bundle: ${outfile} (${bytes} bytes)`);
  }, error => { console.error(error); process.exitCode = 1; });
}
