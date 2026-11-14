import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTPUT_TAIL_BYTES, captureStartupChunk, newStartupCapture, redactStartupText, safeSpawnErrorCode,
  sealStartupCapture, startupFailureRecord, startupFailureSummary,
} from '../hosts/paseo/plugin/startup-output';

test('startup output keeps a bounded tail and redacts a credential from the environment', () => {
  const capture = newStartupCapture({ QUEUE_API_TOKEN: 'super-secret-token', PATH: '/bin' });
  captureStartupChunk(capture, 'stderr', Buffer.from(`starting with super-secret-token at pid 42\n`));
  sealStartupCapture(capture);
  const text = capture.stderr.tail.toString('utf8');
  assert.equal(text.includes('super-secret-token'), false, 'the environment secret never reaches the tail');
  assert.match(text, /\[redacted\]/);
  assert.match(text, /pid 42/);
});

test('a secret split across two chunks is still redacted', () => {
  const capture = newStartupCapture({ GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz012345' });
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const line = `${'x'.repeat(1_100)}${secret}${'y'.repeat(1_100)}`;
  // The carry window holds the straddling secret back until the bytes that finish it arrive.
  captureStartupChunk(capture, 'stdout', Buffer.from(line.slice(0, 1_120)));
  captureStartupChunk(capture, 'stdout', Buffer.from(line.slice(1_120)));
  sealStartupCapture(capture);
  const text = capture.stdout.tail.toString('utf8');
  assert.equal(text.includes(secret), false);
  assert.ok(Buffer.byteLength(text) <= OUTPUT_TAIL_BYTES, 'the retained tail stays inside its bound');
});

test('an assignment-shaped secret is redacted even when it never came from the environment', () => {
  assert.equal(redactStartupText('{"authorization":"Bearer abc","ok":true}', []), '{"authorization":[redacted],"ok":true}');
  assert.equal(redactStartupText('token=abc123 done', []), 'token=[redacted] done');
  assert.equal(redactStartupText('nothing sensitive here', []), 'nothing sensitive here');
});

test('a sealed capture stops recording, and the failure record names what the child did', () => {
  const capture = newStartupCapture({});
  capture.pid = 4_242;
  captureStartupChunk(capture, 'stderr', Buffer.from('Error: ENOENT reading the store'));
  capture.exitCode = 3;
  sealStartupCapture(capture);
  const before = capture.stderr.tail.toString('utf8');
  captureStartupChunk(capture, 'stderr', Buffer.from('after the seal'));
  assert.equal(capture.stderr.tail.toString('utf8'), before, 'a sealed capture records nothing more');
  const failure = startupFailureRecord(capture, 'readiness window expired')!;
  assert.equal(failure.pid, 4_242);
  assert.equal(failure.exitCode, 3);
  assert.match(failure.output, /ENOENT/);
  assert.match(startupFailureSummary(failure), /child exited with code 3; stderr: .*ENOENT/);
  assert.equal(startupFailureRecord(null, 'no child'), null);
});

test('a failure summary names the spawn error, the signal, or a pid that never exited', () => {
  const base = { at: 'now', reason: 'r', pid: 7, output: '' };
  assert.equal(startupFailureSummary({ ...base, exitCode: null, signal: null, spawnError: 'EACCES' }), 'spawn error EACCES');
  assert.equal(startupFailureSummary({ ...base, exitCode: null, signal: 'SIGKILL', spawnError: null }), 'child terminated by SIGKILL');
  assert.equal(startupFailureSummary({ ...base, exitCode: null, signal: null, spawnError: null }), 'child pid 7 did not exit before readiness timed out');
  assert.equal(startupFailureSummary({ ...base, pid: null, exitCode: null, signal: null, spawnError: null }), 'child did not start');
});

test('a spawn failure keeps its errno code only when it is a code', () => {
  assert.equal(safeSpawnErrorCode(Object.assign(new Error('nope'), { code: 'ENOENT' })), 'ENOENT');
  assert.equal(safeSpawnErrorCode(new Error('a message is not a code')), 'spawn failure');
  assert.equal(safeSpawnErrorCode(null), 'spawn failure');
});
