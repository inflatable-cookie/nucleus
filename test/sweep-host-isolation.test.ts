import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { submission } from './support/fakes';

test('a host transport failure waits only that host while the sweep processes healthy-host work', async t => {
  const store = new Store(':memory:');
  const engine = new Engine(store, {
    reconcileReportedSettlements: async () => { settled.push('healthy'); },
  } as unknown as Adapter, 60_000);
  const offlineHost = 'bb:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const healthyHost = 'paseo:primary';
  const settled: string[] = [];
  const processed: string[] = [];
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 0);
  t.after(async () => { await engine.stop(); store.close(); });
  const add = (hostId: string, title: string) => {
    const inserted = store.insert(submission({ title }), hostId, 'handoff.md', 'b'.repeat(40));
    return store.update(inserted.id, { phase: 'working' });
  };
  const offline = add(offlineHost, 'BB task');
  const healthy = add(healthyHost, 'Paseo task');

  engine.hostIds = () => [offlineHost, healthyHost];
  engine.hostAvailable = () => true;
  engine.withHost = ((hostId: string, work: () => unknown) => {
    if (hostId === offlineHost) throw new Error(`Transport not connected: host ${hostId} is unavailable`);
    return work();
  }) as typeof engine.withHost;
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.clearRetiredInvalidations = () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {
    for (const task of [offline, healthy]) if (engine.taskHostAvailable(store.task(task.id))) processed.push(`recover:${task.id}`);
  };
  engine.archiveRetiredErroredAgents = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.deliverPendingBriefAmendments = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.origins.pass = async () => {};
  engine.resolution.observationTargets = () => [];
  engine.resolution.observe = async () => {};
  engine.scheduleTaskQuantum = async taskId => { processed.push(`quantum:${taskId}`); };
  engine.dispatchQueued = async () => {
    for (const task of [offline, healthy]) if (engine.taskHostAvailable(store.task(task.id))) processed.push(`dispatch:${task.id}`);
  };
  for (const method of ['deliverNotices', 'deliverQueuedMessages', 'resumeAskQuestions', 'raiseOperatorQuestions',
    'delegateNativeQuestions', 'resumeResponsibleAnsweredQuestions', 'deliverHoldNotices', 'deliverDecisionNotices',
    'deliverDrainNotices', 'deliverHostOutageNotices'] as const)
    Object.assign(engine.resolution, { [method]: async () => {} });

  const result = await engine.auditPass(true);

  assert.equal(result.fault, null);
  assert.equal(store.getMeta('engineError'), '');
  assert.equal(store.task(offline.id).resolution.stop?.reason, 'host_unavailable');
  assert.match(store.task(offline.id).resolution.stop?.detail ?? '', new RegExp(offlineHost));
  assert.deepEqual(settled, ['healthy'], 'healthy-host settlement runs after the offline host fails');
  assert.ok(processed.includes(`recover:${healthy.id}`), 'healthy-host recovery is considered in the same pass');
  assert.ok(processed.includes(`quantum:${healthy.id}`), 'healthy-host lifecycle work runs in the same pass');
  assert.ok(processed.includes(`dispatch:${healthy.id}`), 'healthy-host dispatch runs in the same pass');
  assert.equal(processed.some(entry => entry.endsWith(offline.id)), false, 'offline-host work does not start');
});
