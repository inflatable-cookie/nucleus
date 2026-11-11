/**
 * The board's host boundary. Board components and shared code reach the host
 * through the shell in client/shell, never the Paseo plugin package, so the same
 * components can run in a web shell later. Only the Paseo client subtree may import the plugin package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]@getpaseo\/plugin(?:\/[^'"]*)?['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('board and shared code do not import the plugin package', () => {
  const files = [...sourceFiles(join(root, 'client')), ...sourceFiles(join(root, 'shared'))];
  assert.ok(files.length > 20, 'the scan found the board source');
  const importers = files
    .filter(file => PLUGIN_IMPORT.test(readFileSync(file, 'utf8')))
    .map(file => relative(root, file));
  assert.deepEqual(importers, []);
  const shell = readFileSync(join(root, 'client/shell/index.ts'), 'utf8');
  assert.match(shell, /export function bindBoardShell/);
  assert.doesNotMatch(shell, /paseo/);
  const entry = readFileSync(join(root, 'hosts/paseo/client/index.tsx'), 'utf8');
  assert.ok(entry.indexOf('bindBoardShell(paseoShell)') < entry.indexOf('client.addSurface'), 'the shell is bound before board registration');
});

test('the boundary rule matches the plugin specifiers it guards', () => {
  for (const specifier of ['@getpaseo/plugin', '@getpaseo/plugin/client', '@getpaseo/plugin/client/react-native']) {
    assert.match(`import { useRpc } from "${specifier}";`, PLUGIN_IMPORT);
    assert.match(`import type { X } from '${specifier}';`, PLUGIN_IMPORT);
    assert.match(`const m = await import("${specifier}");`, PLUGIN_IMPORT);
  }
  assert.doesNotMatch('import { Icon } from "./shell";', PLUGIN_IMPORT);
  assert.doesNotMatch('import { defineRpc } from "@getpaseo/plugin-like-name";', PLUGIN_IMPORT);
});

test('shell injection preserves hook and component identities synchronously', async () => {
  const shell = await import('../client/shell');
  const first = {
    useRpc: () => () => Promise.resolve(undefined),
    useWorkspace: () => null,
    Icon: () => null,
  } as unknown as import('../client/shell').BoardShell;
  shell.bindBoardShell(first);
  assert.equal(shell.useRpc, first.useRpc);
  assert.equal(shell.useWorkspace, first.useWorkspace);
  assert.equal(shell.Icon, first.Icon);
  const second = { ...first, Icon: () => null };
  shell.bindBoardShell(second);
  assert.equal(shell.Icon, second.Icon);
});
