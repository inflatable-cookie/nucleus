import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../bin/nucleus-review-entry.mjs', import.meta.url));

test('lead review entry requires an explicit ownership classification for a supplied workspace', () => {
  const run = spawnSync(process.execPath, [entry, '--lead', 'lead', '--pr', '802', '--key', 'stable', '--workspace', 'workspace'], {
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--workspace requires --workspace-ownership intake\|external/);
});

test('lead review entry accepts only intake or external workspace ownership', () => {
  const run = spawnSync(process.execPath, [entry, '--lead', 'lead', '--pr', '802', '--key', 'stable', '--workspace', 'workspace', '--workspace-ownership', 'other'], {
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--workspace-ownership must be intake or external/);
});


test('lead workspace creation uses service admission and leaves preview read-only', () => {
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /values.preview&&!values.workspace/);
  assert.match(source, /client.request\('queue.review-entry-workspace',/);
  assert.doesNotMatch(source, /@getpaseo|workspaces.create|createPaseoClient/);
});
