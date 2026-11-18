import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHostOperationOutcome } from '../shared/service/host-channel';

// BB builds work row IDs as threadId:rowKind:providerCallId.
test('BB timeline preserves long composite work identities and refuses oversized ones', () => {
  const id = `thr_synthetic:tool:${'call_'.repeat(100)}`;
  const answer = (entryId: string) => ({ operation: 'thread.timeline', at: '2026-11-18T00:00:00Z', calls: {}, value: {
    threadId: 'thr_synthetic', hasOlder: false, pendingBackgroundTasks: [],
    entries: [{ id: entryId, seq: 1, at: 1, turnId: null, status: 'completed', name: 'tool' }],
  } });
  const accepted = parseHostOperationOutcome('thread.timeline', answer(id));
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal((accepted.value.value as { entries: Array<{ id: string }> }).entries[0]!.id, id);
  const refused = parseHostOperationOutcome('thread.timeline', answer('x'.repeat(4097)));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.failure.message, /entries\.0\.id/);
});
