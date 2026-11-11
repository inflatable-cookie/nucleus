import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkBridgeImports } from '../scripts/check-bridge-imports.mjs';
import ts from 'typescript';
import * as contracts from '../shared/contracts';
import * as holds from '../shared/holds';
import * as disposition from '../shared/disposition';
import * as taskView from '../shared/task-view';

const root = fileURLToPath(new URL('../shared/', import.meta.url));

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function imports(path: string) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return source.statements.filter(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    .filter(node => node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier));
}

test('domain schemas and RPC definitions never import the contracts barrel', () => {
  for (const path of [...files(resolve(root, 'schema')), ...files(resolve(root, 'rpc'))]) {
    for (const node of imports(path)) {
      const target = resolve(dirname(path), (node.moduleSpecifier as ts.StringLiteral).text).replace(/\.(?:ts|js)$/, '');
      assert.notEqual(target, resolve(root, 'contracts'), `${path} imports contracts`);
    }
  }
});

test('extracted task logic imports contracts only as types', () => {
  for (const name of ['holds', 'disposition', 'task-view']) {
    for (const node of imports(resolve(root, `${name}.ts`))) {
      if ((node.moduleSpecifier as ts.StringLiteral).text !== './contracts') continue;
      assert.ok(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly, `${name} loads contracts at runtime`);
    }
  }
});

test('contracts preserves the extracted public functions and constants', () => {
  for (const module of [holds, disposition, taskView]) {
    for (const [name, value] of Object.entries(module)) {
      assert.equal(contracts[name as keyof typeof contracts], value, `${name} must remain a re-export`);
    }
  }
});


test('domain modules form an acyclic graph with schemas below RPC definitions', () => {
  const paths = [...files(resolve(root, 'schema')), ...files(resolve(root, 'rpc'))];
  const modules = new Set(paths.map(path => path.replace(/\.ts$/, '')));
  const graph = new Map(paths.map(path => [path.replace(/\.ts$/, ''), imports(path)
    .map(node => resolve(dirname(path), (node.moduleSpecifier as ts.StringLiteral).text).replace(/\.(?:ts|js)$/, ''))
    .filter(target => modules.has(target))]));
  const visited = new Set<string>();
  function visit(path: string, ancestors: string[]) {
    assert.ok(!ancestors.includes(path), `Domain import cycle: ${[...ancestors, path].join(' -> ')}`);
    if (visited.has(path)) return;
    for (const target of graph.get(path) ?? []) {
      if (path.startsWith(resolve(root, 'schema') + '/')) {
        assert.ok(!target.startsWith(resolve(root, 'rpc') + '/'), `${path} imports an RPC module`);
      }
      visit(target, [...ancestors, path]);
    }
    visited.add(path);
  }
  for (const path of graph.keys()) visit(path, []);
});

test('contracts preserves every domain schema and RPC value as a re-export', async () => {
  for (const path of [...files(resolve(root, 'schema')), ...files(resolve(root, 'rpc'))]) {
    const domain = await import(pathToFileURL(path).href);
    for (const [name, value] of Object.entries(domain)) {
      assert.equal(contracts[name as keyof typeof contracts], value, `${path}: ${name} must remain a re-export`);
    }
  }
});

test('the bridge import gate passes through the split contracts', () => {
  assert.doesNotThrow(() => checkBridgeImports(resolve(root, '..')));
});
