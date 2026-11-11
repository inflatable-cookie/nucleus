import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backendSourceDigest } from '../shared/service/build';

test('the backend identity changes when its host implementation changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-build-'));
  for (const dir of ['server', 'core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'server', 'entry.ts'), 'server');
  writeFileSync(join(root, 'shared', 'entry.ts'), 'shared');
  writeFileSync(join(root, 'hosts', 'entry.ts'), 'first');
  writeFileSync(join(root, 'bin', 'queue-service.mjs'), 'service');
  const first = backendSourceDigest(root);
  writeFileSync(join(root, 'hosts', 'entry.ts'), 'second');
  assert.notEqual(backendSourceDigest(root), first);
});

test('the backend identity includes relocated planning and transport sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'planning-build-'));
  for (const dir of ['server', 'core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'bin', 'queue-service.mjs'), 'service');
  const first = backendSourceDigest(root);
  writeFileSync(join(root, 'core', 'planning.ts'), 'planning');
  const second = backendSourceDigest(root);
  assert.notEqual(second, first);
  writeFileSync(join(root, 'service', 'transport.mjs'), 'transport');
  assert.notEqual(backendSourceDigest(root), second);
});

test('the backend identity includes relocated core source bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-build-'));
  for (const dir of ['server', 'core', 'service', 'shared', 'hosts', 'bin']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'bin', 'queue-service.mjs'), 'service');
  writeFileSync(join(root, 'core', 'git.ts'), 'first');
  const first = backendSourceDigest(root);
  writeFileSync(join(root, 'core', 'git.ts'), 'second');
  assert.notEqual(backendSourceDigest(root), first);
});
