import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from '../core/host/adapter';
import { hostConnected, hostConnectionRequired } from '../hosts/paseo';

test('runtime connection reads remain late-bound, including missing-client behavior', () => {
  const host = { client: { isConnected: false } } as unknown as Adapter;
  assert.equal(hostConnected(host), false);
  (host as unknown as { client: { isConnected: boolean } }).client = { isConnected: true };
  assert.equal(hostConnected(host), true);
  assert.equal(hostConnectionRequired(host), true);
  assert.equal(hostConnected({} as Adapter), false);
  assert.throws(() => hostConnectionRequired({} as Adapter), TypeError);
});

const concreteAdapterImport = /import\s*(?:type\s+)?\{[^}]*\bPaseoAdapter\b/s;

test('the concrete adapter fence catches value and type-only imports', () => {
  assert.match("import { PaseoAdapter } from './paseo';", concreteAdapterImport);
  assert.match("import{ PaseoAdapter } from './paseo';", concreteAdapterImport);
  assert.match("import type { PaseoAdapter } from './paseo';", concreteAdapterImport);
  assert.doesNotMatch("import type { Adapter } from './adapter';", concreteAdapterImport);
});

test('core and shared modules do not import the Paseo SDK or concrete adapter', () => {
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.tsx?$/.test(path)) {
        const source = readFileSync(path, 'utf8');
        assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"]@getpaseo\//, path);
        assert.doesNotMatch(source, concreteAdapterImport, path);
      }
    }
  }
  visit('core'); visit('shared');
});
