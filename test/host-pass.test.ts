import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { enginePorts } from '../core/port-context';
import { HostPass } from '../core/scheduling/host-pass';
import type { Adapter, AgentObservation } from '../core/host';

/**
 * nucleus#1257: one host's audit steps are their own owner. A step that throws is
 * recorded as `hostPassError` and never stops the host's later steps, so a silent
 * host pass cannot pass for a clean one.
 */
type Loose = Record<string, any>;
const HOST = 'host-1';

function fixture(t: TestContext, adapter: Loose) {
  const store = new Store(':memory:');
  const engine = new Engine(store, adapter as Adapter, 60_000);
  t.after(async () => { await engine.stop(); store.close(); });
  const hostPass = new HostPass(enginePorts(engine,
    ['adapter', 'host', 'inventoryHostMatches', 'observeRetiredWorkers', 'retiredObservationKey', 'retiredObservationPlan', 'store'],
    ['observationTargets']));
  return { store, engine, hostPass };
}

test('a step that throws is recorded and the host\'s later steps still run', async t => {
  const ran: string[] = [];
  const adapter = {
    reconcileReportedSettlements: async () => { ran.push('settlements'); },
    reconcileThreadTitles: () => { ran.push('titles'); throw new Error('titles fault'); },
    reconcileSettledThreads: async () => { ran.push('settled'); },
  };
  const f = fixture(t, adapter);

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));

  assert.deepEqual(ran, ['settlements', 'titles', 'settled'], 'the client steps run in order, past the failure');
  assert.equal(String(f.store.getMeta('hostPassError')), `${HOST}/reconcileThreadTitles: titles fault`);
  assert.equal(result.inventory, null);
  assert.equal(result.finishedCatchUp.size, 0);
});

test('a clean pass records no failure and answers the inventory it read', async t => {
  const observations = new Map<string, AgentObservation>([['agent-1', { active: true } as AgentObservation]]);
  const f = fixture(t, { observationInventory: async () => observations });
  f.engine.resolution.observationTargets = () => ['agent-1'];

  const result = await f.engine.withHost(HOST, () => f.hostPass.run(HOST));

  assert.equal(f.store.getMeta('hostPassError'), undefined, 'a clean pass writes no failure');
  assert.equal(result.inventory, observations);
});
