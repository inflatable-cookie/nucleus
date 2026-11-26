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

test('a test reaching the change only through a production module is not selected: that sweep is milestone QA', () => {
  const { files, sources } = tree(base);
  const result = selectAffected({ changed: ['core/x.ts'], files, sources });
  assert.ok(!selected(result).includes('test/b.test.ts'), 'test/b imports y, which imports x: a hub-style chain');
  assert.deepEqual(result.deferred, []);
});

test('a hub module selects only its direct importers, not every test that reaches it', () => {
  const hub: Record<string, string> = { 'core/hub.ts': 'export const hub = 1;' };
  for (let i = 0; i < 30; i++) {
    hub[`core/m${i}.ts`] = "import { hub } from './hub';\nexport const m = hub;";
    hub[`test/m${i}.test.ts`] = `import { m } from '../core/m${i}';\n`;
  }
  hub['test/hub.test.ts'] = "import { hub } from '../core/hub';\n";
  const { files, sources } = tree(hub);
  assert.deepEqual(selected(selectAffected({ changed: ['core/hub.ts'], files, sources })), ['test/hub.test.ts']);
});

test('past the cap the nearest files run and the rest are deferred to milestone QA', () => {
  const many: Record<string, string> = { 'core/x.ts': 'export const x = 1;', 'test/changed.test.ts': 'export {};' };
  for (let i = 0; i < 5; i++) many[`test/i${i}.test.ts`] = "import { x } from '../core/x';\n";
  for (let i = 0; i < 5; i++) many[`test/n${i}.test.ts`] = "const fixture = 'core/x.ts';\n";
  const { files, sources } = tree(many);
  const result = selectAffected({ changed: ['core/x.ts', 'test/changed.test.ts'], files, sources, max: 4 });
  assert.equal(result.tests.length, 4);
  assert.ok(selected(result).includes('test/changed.test.ts'), 'a changed test always comes first');
  assert.ok(selected(result).every(file => !file.startsWith('test/n')), 'importers outrank path literals');
  assert.equal(result.deferred.length, 7);
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

test('retired entries stay out of the affected set even when they share a changed fixture', () => {
  const active = 'test/board.test.ts';
  const retired = 'test/legacy.test.ts';
  const fixture = 'test/support/fixture.ts';
  const { files, sources } = tree({
    [active]: "import './support/fixture';",
    [retired]: "import './support/fixture';",
    [fixture]: 'export {};',
  });
  const result = selectAffected({ changed: [fixture, retired], files, sources, testFiles: [active] });
  assert.deepEqual(selected(result), [active]);
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
  assert.equal(isGraphNode('core/example.ts'), true);
  assert.equal(isGraphNode('docs/knowledge/vision.md'), false);
  assert.equal(isGraphNode('core/data.json'), false);
  assert.equal(isTestFile('test/a.test.ts'), true);
  assert.equal(isTestFile('test/fixture.cases.ts'), false);
  assert.equal(isTestFile('test/support/a.test.ts'), true);
});

test('a test that recurses an ancestor directory is selected for a nested change', () => {
  const { files, sources } = tree({
    'client/board/cards.tsx': 'export const cards = 1;',
    'test/recurse.test.ts': "const dirs = [join(root, 'client')];\n",
    'test/nested-only.test.ts': "const dirs = [join(root, 'client/board')];\n",
    'test/lookalike.test.ts': "const dirs = [join(root, 'clientele')];\n",
  });
  const result = selectAffected({ changed: ['client/board/cards.tsx'], files, sources });
  assert.deepEqual(selected(result), ['test/nested-only.test.ts', 'test/recurse.test.ts']);
  assert.deepEqual(result.tests.find(entry => entry.file === 'test/recurse.test.ts')?.reasons, ['reads directory client']);
});

test('a serial oracle that a shard entry reaches through its required case file is reported serial', () => {
  const { files, sources } = tree({
    'test/shard.test.ts': "require('./shard.cases');\nimport { x } from '../core/x';\n",
    'test/shard.cases.ts': "import { timingTest } from './support/timing';\n",
    'test/support/timing.ts': 'export function timingTest() {}',
    'core/x.ts': 'export const x = 1;',
  });
  assert.deepEqual(selectAffected({ changed: ['core/x.ts'], files, sources }).serial, ['test/shard.test.ts']);
});

test('within the cap a direct importer outranks a chain through test helpers', () => {
  const { files, sources } = tree({
    'core/x.ts': 'export const x = 1;',
    'test/support/uses-x.ts': "import { x } from '../../core/x';\nexport const h = x;",
    'test/a-via-helper.test.ts': "import { h } from './support/uses-x';\n",
    'test/z-direct.test.ts': "import { x } from '../core/x';\n",
  });
  const result = selectAffected({ changed: ['core/x.ts'], files, sources, max: 1 });
  assert.deepEqual(selected(result), ['test/z-direct.test.ts']);
  assert.deepEqual(result.deferred.map(entry => entry.file), ['test/a-via-helper.test.ts']);
});

test('a documentation change does not select tests that only walk docs/', () => {
  const { files, sources } = tree({
    'test/docs-walk.test.ts': "const root = join(here, 'docs');\n",
    'test/names-doc.test.ts': "const vision = 'knowledge/vision.md';\n",
  });
  assert.deepEqual(selected(selectAffected({ changed: ['docs/knowledge/vision.md'], files, sources })), ['test/names-doc.test.ts']);
});

test('a changed test file does not select tests that only walk test/', () => {
  const { files, sources } = tree({
    'test/edited.test.ts': 'export {};',
    'test/test-walk.test.ts': "const root = join(here, '..', 'test');\n",
  });
  assert.deepEqual(selected(selectAffected({ changed: ['test/edited.test.ts'], files, sources })), ['test/edited.test.ts']);
});

test('a test that loads a production entry by its literal path is selected for a change inside the entry', () => {
  const { files, sources } = tree({
    'client/child.tsx': 'export const child = 1;',
    'client/screen.tsx': "import { child } from './child';\nexport const screen = child;",
    'client/other.tsx': 'export const other = 1;',
    'test/bundles.test.ts': "const entry = new URL('../client/screen.tsx', import.meta.url);\n",
    'test/unrelated.test.ts': "const entry = new URL('../client/other.tsx', import.meta.url);\n",
  });
  const result = selectAffected({ changed: ['client/child.tsx'], files, sources });
  assert.deepEqual(selected(result), ['test/bundles.test.ts']);
  assert.deepEqual(result.tests[0]?.reasons, ['bundles client/screen.tsx → client/child.tsx']);
});

test('a bundled entry written into a template string or loaded dynamically is selected', () => {
  const { files, sources } = tree({
    'client/child.tsx': 'export const child = 1;',
    'client/screen.tsx': "import { child } from './child';\nexport const screen = child;",
    'test/template.test.ts': 'const contents = `export * from "../client/screen.tsx";`;\n',
    'test/dynamic.test.ts': "const screen = await import('../client/screen');\n",
  });
  assert.deepEqual(selected(selectAffected({ changed: ['client/child.tsx'], files, sources })), ['test/dynamic.test.ts', 'test/template.test.ts']);
});

test('a static import of a production entry does not select a test: the hub rule holds for bundled entries too', () => {
  const { files, sources } = tree({
    'client/child.tsx': 'export const child = 1;',
    'client/screen.tsx': "import { child } from './child';\nexport const screen = child;",
    'test/static.test.ts': "import { screen } from '../client/screen';\n",
    'test/type-only.test.ts': "type Screen = typeof import('../client/screen');\n",
  });
  assert.deepEqual(selectAffected({ changed: ['client/child.tsx'], files, sources }).tests, []);
});

test('the nearest bundled entry names the reason, and a test is selected once', () => {
  const { files, sources } = tree({
    'client/child.tsx': 'export const child = 1;',
    'client/leaf.tsx': "import { child } from './child';\nexport const leaf = child;",
    'client/screen.tsx': "import { leaf } from './leaf';\nexport const screen = leaf;",
    'test/both.test.ts': "const a = new URL('../client/screen.tsx', import.meta.url);\nconst b = new URL('../client/leaf.tsx', import.meta.url);\n",
  });
  const result = selectAffected({ changed: ['client/child.tsx'], files, sources });
  assert.deepEqual(selected(result), ['test/both.test.ts']);
  assert.deepEqual(result.tests[0]?.reasons, ['bundles client/leaf.tsx → client/child.tsx']);
});
