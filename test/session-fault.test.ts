import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLoginSessionFault, LoginSessionFaultError } from '../shared/session-fault';
import { currentLoginSession, sessionsDiffer } from '../service/transport/identity';

test('OSStatus -26276 classifies as an environment fault, never a task fault', () => {
  assert.equal(isLoginSessionFault(new Error('gh: failed to get token: OSStatus -26276')), true);
  assert.equal(isLoginSessionFault({ message: 'Command failed', stderr: 'keychain: OSStatus -26276\n' }), true);
  assert.equal(isLoginSessionFault(new Error('Transport not connected (status: disconnected)')), false);
  const wrapped = new LoginSessionFaultError(new Error('gh api: OSStatus -26276'));
  assert.match(wrapped.message, /Login session environment fault/);
  assert.match(wrapped.message, /OSStatus -26276/);
});

test('login-session identity treats an unrecorded session as a mismatch', () => {
  assert.equal(currentLoginSession({ QUEUE_LOGIN_SESSION: 'fixture-session' } as NodeJS.ProcessEnv), 'fixture-session');
  assert.equal(currentLoginSession({ SECURITYSESSIONID: 'abc' } as NodeJS.ProcessEnv), 'macos:abc');
  assert.equal(sessionsDiffer('macos:abc', 'macos:abc'), false);
  assert.equal(sessionsDiffer('macos:abc', 'macos:xyz'), true);
  assert.equal(sessionsDiffer(undefined, 'macos:abc'), true);
});

test('posix login-session fallback is the kernel session, not the process pid', () => {
  const empty = {} as NodeJS.ProcessEnv;
  const first = currentLoginSession(empty);
  const second = currentLoginSession(empty);
  assert.equal(first, second);
  const proc = process as NodeJS.Process & { getsid?: (pid?: number) => number };
  if (typeof proc.getsid === "function") {
    assert.equal(first, `sid:${proc.getsid()}`);
  } else {
    assert.match(first, /^sid:(?:\d+|unknown)$/);
  }
});
