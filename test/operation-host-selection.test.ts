import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';

test('an accepted operation waits for its recorded host and never selects a replacement', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, {} as Adapter, 0);
  let online = 'host-b';
  engine.selectIngressHost = () => 'host-a';
  engine.hostAvailable = id => id === online;
  try {
    const payload = { type: 'review_entry', input: {} };
    const accepted = await engine.startOperation({ key: 'host-selection', kind: 'review_entry', payload });
    assert.ok('accepted' in accepted);
    if (!('accepted' in accepted)) return;
    const waiting = await engine.awaitOperation(accepted.operation.id, 100);
    assert.equal(waiting.state, 'pending');
    assert.equal(waiting.hostId, 'host-a');
    assert.deepEqual(waiting.hostSelection, { hostId: 'host-a', basis: 'sole_online_host' });
    assert.match(waiting.diagnostic, /Waiting for host host-a/);
    engine.selectIngressHost = () => 'host-b';
    const replay = await engine.startOperation({ key: 'host-selection', kind: 'review_entry', payload });
    assert.ok('accepted' in replay);
    if ('accepted' in replay) assert.equal(replay.operation.hostId, 'host-a');
    if ('accepted' in replay) assert.deepEqual(replay.operation.hostSelection, waiting.hostSelection);
    await assert.rejects(engine.startOperation({ key: 'host-selection', kind: 'review_entry', payload, hostId: 'host-b' }), /recorded selection/);
    online = 'host-a';
  } finally { await engine.stop(); store.close(); }
});
