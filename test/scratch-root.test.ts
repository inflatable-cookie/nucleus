import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuredScratchRoot, scratchDirectory } from '../shared/scratch-root.mjs';

test('scratch configuration requires an existing absolute root with no fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-config-'));
  assert.throws(() => configuredScratchRoot({}), /Set NUCLEUS_SCRATCH_ROOT/);
  assert.throws(() => configuredScratchRoot({ NUCLEUS_SCRATCH_ROOT: 'relative' }), /absolute/);
  assert.throws(() => configuredScratchRoot({ NUCLEUS_SCRATCH_ROOT: join(root, 'absent') }), /ENOENT/);
  assert.equal(configuredScratchRoot({ NUCLEUS_SCRATCH_ROOT: root }), root);
});

test('scratch admission uses directory boundaries and refuses redirected paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'scratch-boundary-'));
  const root = join(fixture, 'root'), child = join(root, 'run'), sibling = join(fixture, 'root-other');
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling);
  const env = { NUCLEUS_SCRATCH_ROOT: root };
  assert.equal(scratchDirectory(root, env), root);
  assert.equal(scratchDirectory(child, env), child);
  assert.throws(() => scratchDirectory(sibling, env), /outside/);
  assert.throws(() => scratchDirectory(undefined, env), /existing directory/);
  const link = join(root, 'link');
  symlinkSync(sibling, link);
  assert.throws(() => scratchDirectory(link, env), /outside|redirected/);
  assert.throws(() => configuredScratchRoot({ NUCLEUS_SCRATCH_ROOT: link }), /real directory/);
});
