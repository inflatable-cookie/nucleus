import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, operationInputHash } from '../core/store/store';

test('an accepted submission whose payload cannot be read is no board card and stays in the operation journal', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-pending-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  try {
    const key = 'pending-submission-unreadable';
    const payload = { submission: { title: 42 } };
    store.acceptOperation({ key, kind: 'submit', inputHash: operationInputHash(payload), submissionId: 'submission-unreadable', repoPath: dir, payload });
    assert.deepEqual(store.pendingSubmissions(), []);
    assert.equal(store.operations({ states: ['pending'] }).some(operation => operation.key === key), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
