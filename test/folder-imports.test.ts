import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeRule, folderViolations, importEdges } from '../scripts/check-folder-imports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('folder imports match the known violations; remove resolved edges, never add exceptions', () => {
  const known = JSON.parse(readFileSync(new URL('./fixtures/folder-import-violations.json', import.meta.url), 'utf8'));
  const actual = folderViolations(root);
  assert.deepEqual(actual, known, 'New violations must be fixed; resolved entries must be removed from the known list.');
  console.log(`Folder import debt: ${actual.length} known edges (test/fixtures/folder-import-violations.json)`);
});

test('folder rules cover processes, public host indexes and host SDK confinement', () => {
  for (const [from, to, specifier, expected] of [
    ['hosts/paseo/plugin/index.ts', 'service/install/bridge-process-actions.ts', '../../../server/service/bridge-process-actions', null],
    ['index.server.ts', 'service/install/bridge-process-actions.ts', './server/service/bridge-process-actions', 'plugin-forwarder'],
    ['hosts/paseo/plugin/bridge.ts', 'service/install/bridge-process-actions.ts', './bridge-process-actions', 'plugin-forwarder'],
    ['hosts/paseo/plugin/other.ts', 'service/install/bridge-process-actions.ts', '../../../server/service/bridge-process-actions', 'plugin-forwarder'],
    ['index.server.ts', 'server/service/install.mjs', './server/service/install.mjs', 'plugin-forwarder'],
    ['bin/host-run-private-server.mjs', 'core/store/store.ts', '../core/store/store.ts', null],
    ['bin/nucleus.mjs', 'service/transport/index.mjs', '../service/transport/index.mjs', null],
    ['core/review/report.ts', 'service/main.ts', '../../service/main', 'core-neutral'],
    ['shared/rpc.ts', 'core/store/index.ts', '../core/store', 'shared-neutral'],
    ['hosts/paseo/plugin/index.ts', 'core/store/index.ts', '../../../core/store', 'plugin-forwarder'],
    ['hosts/paseo/adapter/client.ts', 'core/store/index.ts', '../../../core/store', 'host-interface'],
    ['hosts/paseo/adapter/client.ts', 'core/host/adapter.ts', '../../../core/host/adapter', 'host-interface'],
    ['hosts/paseo/adapter/client.ts', 'core/host/index.ts', '../../../core/host', null],
    ['service/runtime/index.ts', 'hosts/paseo/adapter/client.ts', '../../hosts/paseo/adapter/client', 'host-public-index'],
    ['service/runtime/index.ts', 'hosts/paseo/index.ts', '../../hosts/paseo', null],
    ['client/board/card.tsx', 'hosts/paseo/index.ts', '../../hosts/paseo', 'client-neutral'],
    ['core/engine.ts', '@getpaseo/client', '@getpaseo/client', 'host-sdk-location'],
    ['hosts/other/index.ts', '@getpaseo/client', '@getpaseo/client', 'host-sdk-location'],
    ['hosts/paseo/index.ts', '@getpaseo/client', '@getpaseo/client', null],
    ['core/review/report.ts', 'shared/rpc.ts', '../../shared/rpc', null],
    ['client/board/card.tsx', 'client/shell/index.ts', '../shell', null],
  ] as const) assert.equal(edgeRule(from, to, specifier), expected, `${from} -> ${to}`);
});

test('parser includes type edges, reexports, dynamic imports and CommonJS without comment/string false positives', () => {
  assert.deepEqual(importEdges('fixture.ts', `
    // import 'ignored';
    const text = "import 'also-ignored'";
    import type { A } from './types';
    export { value } from './value';
    import './side-effect';
    const a = import('./dynamic');
    const b = require('./common');
    type C = import('./type-expression').C;
  `), ['./types', './value', './side-effect', './dynamic', './common', './type-expression']);
});


test('declaration modules enforce type boundaries and resolve declaration targets', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'folder-declarations-'));
  const files = {
    'shared/legacy.d.ts': "import type { Core } from '../core/types';",
    'shared/module.d.mts': "export type { Host } from '../hosts/paseo/types.mjs';",
    'shared/common.d.cts': "import Core = require('../core/common.cjs');",
    'core/types.d.ts': "export interface Core {}",
    'core/common.d.cts': "export interface Core {}",
    'core/sdk.d.mts': "export type Client = import('@getpaseo/client').Client;",
    'hosts/paseo/types.d.mts': "export interface Host {}",
    'shared/allowed.d.mts': "export type { Neutral } from './neutral.mjs';",
    'shared/neutral.d.mts': "export interface Neutral {}",
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), source);
  }
  assert.deepEqual(folderViolations(fixture), [
    'host-sdk-location: core/sdk.d.mts -> @getpaseo/client [@getpaseo/client]',
    'shared-neutral: shared/common.d.cts -> ../core/common.cjs [core/common.d.cts]',
    'shared-neutral: shared/legacy.d.ts -> ../core/types [core/types.d.ts]',
    'shared-neutral: shared/module.d.mts -> ../hosts/paseo/types.mjs [hosts/paseo/types.d.mts]',
  ]);
});
