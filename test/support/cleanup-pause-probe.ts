import { Engine } from '../../core/engine';

async function main() {
  const engine = Object.create(Engine.prototype) as Engine;
  const state = engine as any;
  let paused = true;
  let started = 0;
  Object.assign(state, {
    stopped: false, cleanupQueue: [], cleanupDraining: null, titleQueue: new Set(), titleDraining: null,
    projectionEnqueued: new Map(), projectionDone: new Map(), projectionInFlight: new Set(), projectionWaiters: [],
    // #912: every task is host-scoped, and cleanup runs each effect inside its host.
    withHost: (_id: string, fn: () => unknown) => fn(), taskHostAvailable: () => true,
    store: { getMeta: () => paused, task: (id: string) => ({ id, hostId: "host" }) },
    scheduleCleanupRetry: () => {}, lifecycle: { archive: async () => { started++; } },
  });
  engine.enqueueCleanup('a');
  process.stdout.write('started\n');
  await Promise.all([
    state.drainProjections(),
    state.awaitProjectionOccurrence('cleanup:a:', () => engine.drainCleanup()),
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  if (started !== 0 || state.cleanupQueue.length !== 1) throw Error('Paused cleanup did not remain queued');
  paused = false;
  await engine.drainCleanup();
  if (Number(started) !== 1 || state.cleanupQueue.length !== 0 || state.projectionDone.get('cleanup:a:') !== 1)
    throw Error('Queued cleanup did not settle after unpause');
  process.stdout.write('settled\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
