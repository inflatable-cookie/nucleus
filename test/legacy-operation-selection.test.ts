import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, operationInputHash } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host/adapter';

test('an old host-bound operation records migration evidence before attempting its effect', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, {} as Adapter, 0);
  engine.hostAvailable = host => host === 'a';
  const payload = { type: 'review_entry', input: {} };
  try {
    const accepted = store.acceptOperation({ key: 'old', kind: 'review_entry', inputHash: operationInputHash(payload), hostId: 'a', payload });
    if (!('accepted' in accepted)) throw Error('backpressured');
    await engine.runOperation(accepted.operation.id);
    const record = store.operation(accepted.operation.id)!;
    assert.deepEqual(record.hostSelection, {hostId:'a',basis:'migrated',reason:'Recorded operation host is online'});
    assert.equal(record.id, accepted.operation.id);
    assert.deepEqual(store.operationPayload(record.id), payload);
  } finally { await engine.stop(); store.close(); }
});
