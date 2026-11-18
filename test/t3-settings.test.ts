/**
 * The stored T3Code connection (nucleus#1330): one owner for the file, its
 * shape, its permissions and the change token the service watches.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readT3Connection,
  readT3RuntimeDescriptor,
  sameT3Connection,
  settingsFileStamp,
  t3RuntimeDescriptorPath,
  writeT3Connection,
} from '../shared/t3/settings';

function dataHome(): string {
  const root = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(root, 'the run scratch volume is required');
  const directory = mkdtempSync(join(realpathSync(root), 't3-settings-'));
  mkdirSync(join(directory, 'userdata'), { recursive: true });
  return directory;
}

test('the connection is written owner-only, read back whole, and cleared without touching other keys', () => {
  const dataDir = dataHome();
  assert.equal(readT3Connection(dataDir), null);
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ daemonUrl: 'ws://127.0.0.1:6767/ws', workRoot: '/synthetic/work' }), { mode: 0o644 });
  writeT3Connection(dataDir, { endpoint: 'http://127.0.0.1:3773', bearer: 'synthetic-bearer', sessionId: 'synthetic-session', expiresAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(statSync(join(dataDir, 'settings.json')).mode & 0o777, 0o600);
  assert.deepEqual(readT3Connection(dataDir), { endpoint: 'http://127.0.0.1:3773', bearer: 'synthetic-bearer', sessionId: 'synthetic-session', expiresAt: '2099-01-01T00:00:00.000Z' });
  const stored = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(stored.workRoot, '/synthetic/work', 'every other setting is preserved');
  assert.equal(stored.daemonUrl, 'ws://127.0.0.1:6767/ws');

  writeT3Connection(dataDir, null);
  assert.equal(readT3Connection(dataDir), null);
  const cleared = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(cleared.t3code, undefined);
  assert.equal(cleared.workRoot, '/synthetic/work');
});

test('a fresh data home gets the service default daemon url, and a malformed block is refused by name', () => {
  const dataDir = dataHome();
  writeT3Connection(dataDir, { endpoint: 'http://127.0.0.1:3773', bearer: 'synthetic-bearer' });
  const stored = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(stored.daemonUrl, 'ws://127.0.0.1:6767/ws');

  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ daemonUrl: 'ws://127.0.0.1:6767/ws', t3code: { endpoint: 'not-a-url', bearer: 'synthetic-bearer' } }));
  assert.throws(() => readT3Connection(dataDir), /T3Code settings in .* are not usable: endpoint/);
});

test('the change token moves when the file changes and names a missing file', () => {
  const dataDir = dataHome();
  const path = join(dataDir, 'settings.json');
  assert.equal(settingsFileStamp(path), 'missing');
  writeT3Connection(dataDir, { endpoint: 'http://127.0.0.1:3773', bearer: 'synthetic-bearer' });
  const first = settingsFileStamp(path);
  assert.notEqual(first, 'missing');
  writeT3Connection(dataDir, { endpoint: 'http://127.0.0.1:3773', bearer: 'synthetic-bearer', sessionId: 'synthetic-session' });
  assert.notEqual(settingsFileStamp(path), first);
});

test('a connection compares by what it would connect, not by its recorded session id', () => {
  const a = { endpoint: 'http://127.0.0.1:3773', bearer: 'synthetic-bearer' };
  assert.equal(sameT3Connection(a, { ...a }), true);
  assert.equal(sameT3Connection(a, { ...a, sessionId: 'synthetic-session' } as typeof a), true);
  assert.equal(sameT3Connection(a, { ...a, bearer: 'synthetic-rotated' }), false);
  assert.equal(sameT3Connection(a, { ...a, endpoint: 'http://127.0.0.1:3774' }), false);
  assert.equal(sameT3Connection(a, null), false);
  assert.equal(sameT3Connection(null, null), true);
});

test('the runtime descriptor is read from the T3 base directory only when the server recorded one', () => {
  const baseDir = dataHome();
  assert.equal(readT3RuntimeDescriptor(baseDir), null);
  writeFileSync(t3RuntimeDescriptorPath(baseDir), JSON.stringify({ version: 1, pid: 42, origin: 'http://127.0.0.1:3773', serverVersion: 'nightly-synthetic', startedAt: '2026-01-01T00:00:00.000Z' }));
  assert.deepEqual(readT3RuntimeDescriptor(baseDir), { origin: 'http://127.0.0.1:3773', pid: 42, serverVersion: 'nightly-synthetic', startedAt: '2026-01-01T00:00:00.000Z' });
  writeFileSync(t3RuntimeDescriptorPath(baseDir), JSON.stringify({ version: 1 }));
  assert.equal(readT3RuntimeDescriptor(baseDir), null, 'a descriptor without a server is not a running server');
});
