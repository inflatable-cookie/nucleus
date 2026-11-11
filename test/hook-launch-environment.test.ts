import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userInfo, tmpdir } from 'node:os';
import { minimalHookEnvironment, executeHookProgram } from '../core/hooks/hooks';

test('hook environment derives USER from the OS and keeps its closed allowlist', t => {
  const originalUser = process.env.USER;
  process.env.USER = 'forged-caller-user';
  process.env.QUEUE_TEST_UNRELATED = 'must-not-forward';
  t.after(() => {
    if (originalUser === undefined) delete process.env.USER; else process.env.USER = originalUser;
    delete process.env.QUEUE_TEST_UNRELATED;
  });
  const env = minimalHookEnvironment('event', 'schema');
  assert.equal(env.USER, userInfo().username);
  assert.notEqual(env.USER, process.env.USER);
  assert.deepEqual(Object.keys(env).sort(), [
    'USER', 'PASEO_QUEUE_EVENT_ID', 'PASEO_QUEUE_EVENT_SCHEMA',
    ...['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => Boolean(process.env[key])),
  ].sort());
  assert.equal(env.QUEUE_TEST_UNRELATED, undefined);
  assert.equal(env.PASEO_QUEUE_EVENT_ID, 'event');
  assert.equal(env.PASEO_QUEUE_EVENT_SCHEMA, 'schema');
});

test('a real hook child receives launch user identity without unrelated environment', async () => {
  const result = await executeHookProgram({
    root: tmpdir(), executable: process.execPath,
    argv: ['-e', 'process.stdout.write(JSON.stringify({user:process.env.USER,uid:process.getuid?.(),unrelated:process.env.QUEUE_TEST_UNRELATED,event:process.env.PASEO_QUEUE_EVENT_ID}))'],
    stdin: Buffer.alloc(0), timeoutMs: 10_000, maxOutputBytes: 1024,
    env: minimalHookEnvironment('child-event'),
  });
  assert.equal(result.code, 0);
  const observed = JSON.parse(result.stdout.toString('utf8'));
  assert.equal(observed.user, userInfo().username);
  if (process.getuid) assert.equal(observed.uid, process.getuid());
  assert.equal(observed.unrelated, undefined);
  assert.equal(observed.event, 'child-event');
});
