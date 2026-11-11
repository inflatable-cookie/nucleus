import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileFacts } from '../core/machine/file-facts';
import { SupervisorLivenessReader } from '../core/machine/supervisor-liveness';
import { processCommandLineAsync } from '../core/machine/process-identity';
import type { StartIdentityRead } from '../core/machine/start-identity';

test('file facts reuse unchanged bytes, re-read atomic replacements and never retain absence', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-facts-')), path = join(root, 'state.json');
  let reads = 0;
  const facts = new FileFacts(path => { reads++; try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } });
  writeFileSync(path, '{"value":1}');
  const first = facts.read(path);
  assert.strictEqual(facts.read(path), first); assert.equal(reads, 1);
  writeFileSync(join(root, 'next'), '{"value":2}'); renameSync(join(root, 'next'), path);
  assert.deepEqual(facts.read(path), { value: 2 }); assert.equal(reads, 2);
  unlinkSync(path); assert.equal(facts.read(path), null);
  writeFileSync(path, '{"value":3}'); assert.deepEqual(facts.read(path), { value: 3 });
  writeFileSync(path, 'invalid'); assert.equal(facts.read(path), null); assert.equal(facts.read(path), null);
  assert.equal(reads, 6);
});

test('a file changed during derivation cannot populate the cache with its previous facts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'file-facts-race-')), 'state');
  writeFileSync(path, 'old');
  let changed = false;
  const facts = new FileFacts(path => {
    const value = readFileSync(path, 'utf8');
    if (!changed) { changed = true; writeFileSync(path, 'new value'); }
    return value;
  });
  assert.equal(facts.read(path), 'old'); assert.equal(facts.read(path), 'new value');
});

test('supervisor watches share positive identities but reprove on expiry or settlement and never cache unknown', async () => {
  let now = 0, reads = 0;
  let result: StartIdentityRead = { kind: 'identity', identity: '123@start' };
  const liveness = new SupervisorLivenessReader({ now: () => now, alive: () => true, cacheMs: 5000,
    command: async () => 'node token', read: async () => { reads++; return result; } });
  assert.equal((await liveness.read(123, 'token', '123@start')).state, 'live');
  assert.equal((await liveness.read(123, 'token', '123@start')).state, 'live'); assert.equal(reads, 1);
  assert.equal((await liveness.read(123, 'token', '123@start', true)).state, 'live'); assert.equal(reads, 2);
  now = 5001; result = { kind: 'unavailable' };
  assert.equal((await liveness.read(123, 'token', '123@start')).state, 'unknown');
  assert.equal((await liveness.read(123, 'token', '123@start')).state, 'unknown'); assert.equal(reads, 4);
  result = { kind: 'identity', identity: '123@replacement' };
  assert.equal((await liveness.read(123, 'token', '123@start')).state, 'dead');
});


test('an unknown recorded start identity falls back to the supervisor token instead of disproving a live process', async () => {
  const liveness = new SupervisorLivenessReader();
  const line = await processCommandLineAsync(process.pid);
  assert.ok(line);
  assert.equal((await liveness.read(process.pid, line, `${process.pid}@unknown`)).state, 'live');
});


test('a matching whole-second start time cannot replace the token proof in fresh settlement checks', async () => {
  const identity = '123@2026-11-09T22:00:00Z';
  let line: string | null = 'node original-token';
  let commands = 0;
  const liveness = new SupervisorLivenessReader({
    alive: () => true, now: () => 0,
    read: async () => ({ kind: 'identity', identity }),
    command: async () => { commands++; return line; },
  });
  assert.equal((await liveness.read(123, 'original-token', identity)).state, 'live');
  assert.equal((await liveness.read(123, 'original-token', identity)).state, 'live');
  assert.equal(commands, 1, 'normal polling reuses the combined positive observation');
  line = 'node replacement-token';
  assert.equal((await liveness.read(123, 'original-token', identity, true)).state, 'dead',
    'recycled PID with an equal macOS start time is disproved by its command token');
  assert.equal((await liveness.read(123, 'original-token', identity)).state, 'dead',
    'fresh mismatch invalidates the cached token proof');
  assert.equal(commands, 3);
  assert.equal((await liveness.read(123, 'replacement-token', identity)).state, 'live');
  assert.equal((await liveness.read(123, 'different-token', identity)).state, 'dead',
    'a different requested token cannot inherit another token proof');
});

test('an unreadable fresh token remains unknown and cannot leave a cached live verdict', async () => {
  const identity = '123@2026-11-09T22:00:00Z';
  let line: string | null = 'node token';
  let commands = 0;
  const liveness = new SupervisorLivenessReader({
    alive: () => true, now: () => 0,
    read: async () => ({ kind: 'identity', identity }),
    command: async () => { commands++; return line; },
  });
  assert.equal((await liveness.read(123, 'token', identity)).state, 'live');
  line = null;
  assert.equal((await liveness.read(123, 'token', identity, true)).state, 'unknown');
  assert.equal((await liveness.read(123, 'token', identity)).state, 'unknown');
  assert.equal(commands, 3, 'unavailable token observations never reuse the old positive verdict');
});
