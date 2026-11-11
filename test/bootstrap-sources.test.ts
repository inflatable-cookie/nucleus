import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const helper = new URL('../bin/bootstrap-sources.mjs', import.meta.url);
type Sources = (root: string, entries?: string[]) => Promise<Map<string, Buffer>>;
async function collector() {
  return (await import(helper.href)).bootstrapSources as Sources;
}

test('bootstrap closure follows imports, re-exports, literal dynamic imports and declarations across directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-closure-'));
  const files: Record<string, string> = {
    'entry.ts': `import './nested/static'; export * from './other/reexport.mjs'; void import('./dynamic.ts'); import type { T } from './types'; // import './missing.ts'`,
    'nested/static.ts': `import '../entry';`,
    'other/reexport.mjs': `export { value } from '../leaf.mjs';`,
    'other/reexport.d.mts': 'export declare const value: number;',
    'leaf.mjs': 'export const value = 1;',
    'leaf.d.ts': `import type { T } from './types'; export declare const value: T;`,
    'dynamic.ts': `export const dynamic = true;`,
    'types.d.ts': 'export type T = number;',
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const collect = await collector();
  const sources = await collect(root, ['entry.ts']);
  assert.deepEqual([...sources.keys()].sort(), Object.keys(files).sort());
  for (const [path, bytes] of sources) assert.equal(bytes.toString(), files[path]);
  await writeFile(join(root, 'dynamic.ts'), `import './missing';`);
  await assert.rejects(collect(root, ['entry.ts']), /Missing bootstrap import/);
});

test('the real bootstrap entries have the same complete import closure after copying', async () => {
  const collect = await collector();
  const root = new URL('..', import.meta.url).pathname;
  const sources = await collect(root);
  // All local modules are copied bytes, never links into the source checkout.
  const fixture = await mkdtemp(join(tmpdir(), 'bootstrap-real-'));
  for (const [path, bytes] of sources) {
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await writeFile(join(fixture, path), bytes);
  }
  const copied = await collect(fixture);
  assert.deepEqual([...copied.keys()], [...sources.keys()]);
  for (const [path, bytes] of sources) assert.deepEqual(await readFile(join(fixture, path)), bytes);
  assert.ok(sources.has('shared/service/local-client.ts'));
  assert.ok(!sources.has('service/transport/server.ts'), 'unrelated service implementation is not in the closure');
});
