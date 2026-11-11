import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIT_TRANSIENT_LIMIT_MS, nextGitTransientAttempt } from '../core/git/git-transient-backoff';

test('retry timing backs off, persists the deadline and stops at fifteen minutes', () => {
  const first = nextGitTransientAttempt(null, 'index.lock', 1000)!;
  assert.deepEqual(first, { startedAt: 1000, attempts: 1, retryAt: 6000, detail: 'index.lock' });
  const second = nextGitTransientAttempt(first, 'still locked', first.retryAt)!;
  assert.equal(second.retryAt, 16000);
  assert.equal(second.startedAt, first.startedAt);
  const nearDeadline = nextGitTransientAttempt(second, 'still locked', 1000 + GIT_TRANSIENT_LIMIT_MS - 1)!;
  assert.equal(nearDeadline.retryAt, 1000 + GIT_TRANSIENT_LIMIT_MS);
  assert.equal(nextGitTransientAttempt(nearDeadline, 'still locked', nearDeadline.retryAt), null);
});
