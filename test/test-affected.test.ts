import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGraphNode, isTestFile, resolveLocal, selectAffected } from '../scripts/test-affected.mjs';

/** A fixture tree: each path maps to its text; every path exists at the ref. */
function tree(files: Record<string, string>) {
  return { files: new Set(Object.keys(files)), sources: new Map(Object.entries(files).filter(([path]) => isGraphNode(path))) };
}

function selected(result: ReturnType<typeof selectAffected>) {
  return result.tests.map(entry => entry.file);
}

const base = {
  'core/x.ts': 'export const x = 1;',
  'core/y.ts': "import { x } from './x';\nexport const y = x;",
  'core/unrelated.ts': 'export const unrelated = 2;',
  'test/a.test.ts': "import { x } from '../core/x';\n",
  'test/b.test.ts': "import { y } from '../core/y';\n",
  'test/unrelated.test.ts': "import { unrelated } from '../core/unrelated';\n",
};

test('a direct importer of a changed file is selected, and an unrelated test is not', () => {
  const { files, sources } = tree(base);
  const result = selectAffected({ changed: ['core/x.ts'], files, sources });
  assert.ok(selected(result).includes('test/a.test.ts'));
  assert.ok(!selected(result).includes('test/unrelated.test.ts'));
  // The import specifier also names the path, so the chain comes first and the literal second.
  assert.equal(result.tests.find(entry => entry.file === 'test/a.test.ts')?.reasons[0], 'test/a.test.ts → core/x.ts');
});

test('a transitive importer is selected with its import chain', () => {
  const { files, sources } = tree(base);
  const result = selectAffected({ changed: ['core/x.ts'], files, sources });
  assert.ok(selected(result).includes('test/b.test.ts'), 'test/b imports y, which imports x');
  assert.equal(result.tests.find(entry => entry.file === 'test/b.test.ts')?.reasons[0], 'test/b.test.ts → core/y.ts → core/x.ts');
});

test('a test that names a changed file by path is selected without importing it', () => {
  const { files, sources } = tree({
    'test/reads.test.ts': "const data = readFileSync(join(root, 'test/fixtures/data.json'), 'utf8');\n",
    'test/fixtures/data.json': '{}',
    'test/other.test.ts': "const data = readFileSync('elsewhere.json', 'utf8');\n",
  });
  const result = selectAffected({ changed: ['test/fixtures/data.json'], files, sources });
  assert.deepEqual(selected(result), ['test/reads.test.ts']);
  assert.deepEqual(result.tests[0]?.reasons, ['names test/fixtures/data.json']);
});

test('a path named relative to a test directory selects the test', () => {
  const { files, sources } = tree({
    'test/relative.test.ts': "const data = new URL('./fixtures/data.json', import.meta.url);\n",
    'test/fixtures/data.json': '{}',
  });
  assert.deepEqual(selected(selectAffected({ changed: ['test/fixtures/data.json'], files, sources })), ['test/relative.test.ts']);
});

test('a test that walks a directory is selected by the directory literal', () => {
  const { files, sources } = tree({
    'test/walk.test.ts': "const dirs = [join(root, 'client')];\n",
    'client/screen.tsx': 'export const screen = 1;',
    'test/unrelated.test.ts': "const dirs = [join(root, 'core')];\n",
  });
  const result = selectAffected({ changed: ['client/screen.tsx'], files, sources });
  assert.deepEqual(selected(result), ['test/walk.test.ts']);
  assert.deepEqual(result.tests[0]?.reasons, ['reads directory client']);
});

test('a changed test file is always selected, even without an importer', () => {
  const { files, sources } = tree({ 'test/lonely.test.ts': "import assert from 'node:assert/strict';\n" });
  const result = selectAffected({ changed: ['test/lonely.test.ts'], files, sources });
  assert.deepEqual(selected(result), ['test/lonely.test.ts']);
  assert.deepEqual(result.tests[0]?.reasons, ['changed test']);
});

test('a changed test support module selects its importers and not other tests', () => {
  const { files, sources } = tree({
    'test/support/helper.ts': 'export const helper = 1;',
    'test/uses-helper.test.ts': "import { helper } from './support/helper';\n",
    'test/no-helper.test.ts': "import { x } from '../core/x';\n",
    'core/x.ts': 'export const x = 1;',
  });
  assert.deepEqual(selected(selectAffected({ changed: ['test/support/helper.ts'], files, sources })), ['test/uses-helper.test.ts']);
});

test('a shard case file is reached through its entry', () => {
  const { files, sources } = tree({
    'test/shard-1.test.ts': "require('./shard.cases');\n",
    'test/shard.cases.ts': "import { x } from '../core/x';\n",
    'core/x.ts': 'export const x = 1;',
  });
  assert.deepEqual(selected(selectAffected({ changed: ['core/x.ts'], files, sources })), ['test/shard-1.test.ts']);
});

test('a declaration edit selects the importers of its implementation', () => {
  const { files, sources } = tree({
    'scripts/tool.mjs': 'export const tool = 1;',
    'scripts/tool.d.mts': 'export const tool: number;',
    'test/tool.test.ts': "import { tool } from '../scripts/tool.mjs';\n",
  });
  assert.deepEqual(selected(selectAffected({ changed: ['scripts/tool.d.mts'], files, sources })), ['test/tool.test.ts']);
});

test('a deleted changed file still selects the tests that imported it', () => {
  const { files, sources } = tree({ 'test/gone.test.ts': "import { gone } from '../core/gone';\n" });
  assert.deepEqual(selected(selectAffected({ changed: ['core/gone.ts'], files, sources })), ['test/gone.test.ts']);
});

test('a changed file outside the graph and the docs is reported as unmapped, never a full suite', () => {
  const { files, sources } = tree(base);
  const result = selectAffected({ changed: ['package.json', 'docs/knowledge/vision.md'], files, sources });
  assert.deepEqual(result.tests, []);
  assert.deepEqual(result.unmapped, ['package.json']);
});

test('a documentation-only change selects no test unless a test names it', () => {
  const { files, sources } = tree(base);
  assert.deepEqual(selectAffected({ changed: ['docs/knowledge/vision.md'], files, sources }).tests, []);
});

test('the wall-clock lane files are reported as serial', () => {
  const { files, sources } = tree({
    'test/timed.test.ts': "import { timingTest } from './support/timing';\nimport { x } from '../core/x';\n",
    'test/support/timing.ts': 'export function timingTest() {}',
    'core/x.ts': 'export const x = 1;',
  });
  assert.deepEqual(selectAffected({ changed: ['core/x.ts'], files, sources }).serial, ['test/timed.test.ts']);
});

test('specifiers resolve through emitted extensions and index files', () => {
  const known = new Set(['core/a.ts', 'core/b/index.tsx', 'scripts/c.mts', 'test/d.cases.ts']);
  assert.equal(resolveLocal(known, 'test/t.ts', '../core/a.js'), 'core/a.ts');
  assert.equal(resolveLocal(known, 'test/t.ts', '../core/b'), 'core/b/index.tsx');
  assert.equal(resolveLocal(known, 'test/t.ts', '../scripts/c.mjs'), 'scripts/c.mts');
  assert.equal(resolveLocal(known, 'test/t.ts', './d.cases'), 'test/d.cases.ts');
  assert.equal(resolveLocal(known, 'test/t.ts', 'node:test'), null);
});

test('the graph covers the source trees and the test tree only', () => {
  assert.equal(isGraphNode('core/engine.ts'), true);
  assert.equal(isGraphNode('index.server.ts'), true);
  assert.equal(isGraphNode('docs/knowledge/vision.md'), false);
  assert.equal(isGraphNode('core/data.json'), false);
  assert.equal(isTestFile('test/a.test.ts'), true);
  assert.equal(isTestFile('test/store-compaction-bench.test.ts'), false);
  assert.equal(isTestFile('test/support/a.test.ts'), true);
});
