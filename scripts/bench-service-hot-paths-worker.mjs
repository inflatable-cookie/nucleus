import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const [source, dataDir, resultPath, seconds] = process.argv.slice(2);
const { Store } = require(join(source, 'core/store/store.ts'));
const storePath = join(dataDir, 'queue.sqlite');
const start = performance.now();
const originalPrune = Store.prototype.pruneRetainedRows;
Store.prototype.pruneRetainedRows = function() { return originalPrune.call(this, Number(process.env.NUCLEUS_BENCH_AT)); };
let store;
try { store = new Store(storePath, join(dataDir, 'backups')); }
finally { Store.prototype.pruneRetainedRows = originalPrune; }
const upgradeOpenMs = performance.now() - start;
const population = {};
for (const table of ['tasks','runs','events','operations','project_qa_runs'])
  population[table] = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n);
const taskId = store.db.prepare("SELECT id FROM tasks WHERE json_extract(data,'$.phase')='queued' AND json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.workspaceId') IS NULL LIMIT 1").get()?.id;
if (!taskId) throw new Error('Snapshot has no quiet queued task for task.next');
store.close();
const openMs = [];
for (let index = 0; index < 3; index++) {
  const start = performance.now();
  store = new Store(storePath, join(dataDir, 'backups'));
  openMs.push(performance.now() - start); store.close();
}
const { QueueService } = require(join(source, 'service/transport/server.ts'));
const { ServiceClient } = require(join(source, 'shared/service/client.ts'));
const { readServiceInfo } = require(join(source, 'service/transport/identity.ts'));
const service = new QueueService({ owner: { dataDir, timers: false, hostRunEndpoint: false }, fixture: 'bench', fixtureState: { hostOffline: true }, debug: true });
const executor = service.executor;
let client;
const frontHandlerMs = [], frontTotalMs = [];
const originalHealth = service.health.bind(service);
service.health = () => {
  const start = performance.now();
  const result = originalHealth();
  frontHandlerMs.push(performance.now()-start);
  return result;
};
const samples = [];
const summarize = xs => {
  const sorted = xs.filter(Number.isFinite).sort((a,b) => a-b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length*.5)] ?? null, p95: sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))] ?? null };
};
try {
  await service.start();
  const info = readServiceInfo(dataDir);
  client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  const probeBefore = await executor.debug({ target: 'fixture', action: 'bench-spawns' });
  await executor.debug({ target: 'fixture', action: 'bench-spawn-probe' });
  const probeAfter = await executor.debug({ target: 'fixture', action: 'bench-spawns' });
  if (probeAfter !== probeBefore + 1) throw new Error('Spawn counter positive control failed');
  await client.request('service.health', {});
  await executor.callHandler('health', {});
  await executor.callHandler('snapshot', {});
  await executor.rpc('task.next', { taskId });
  const spawnedBefore = await executor.debug({ target: 'fixture', action: 'bench-spawns' });
  frontHandlerMs.length = 0;
  let previous = executor.requestTimings().recent.at(-1);
  const began = performance.now();
  let bursts = 0;
  while (performance.now() - began < Number(seconds) * 1000) {
    if (bursts % 10 === 0) await executor.debug({ target: 'store', method: 'advanceRevision', args: [] });
    const frontStart = performance.now();
    const front = client.request('service.health', {}).then(() => { frontTotalMs.push(performance.now()-frontStart); });
    await Promise.all([
      front, executor.callHandler('health', {}), executor.callHandler('snapshot', {}), executor.rpc('task.next', { taskId }),
    ]);
    const recent = executor.requestTimings().recent;
    const at = recent.indexOf(previous);
    samples.push(...recent.slice(at + 1));
    previous = recent.at(-1);
    bursts++;
    await sleep(100);
  }
  const elapsedSeconds = (performance.now() - began) / 1000;
  const spawnedAfter = await executor.debug({ target: 'fixture', action: 'bench-spawns' });
  const methods = {};
  for (const method of ['health','snapshot','task.next']) {
    const rows = samples.filter(sample => sample.method === method);
    if (!rows.length || rows.some(row => row.outcome !== 'ok')) throw new Error('Incomplete benchmark for ' + method);
    methods[method] = { handlerMs: summarize(rows.map(row=>row.handlerMs)), queueMs: summarize(rows.map(row=>row.queueMs)), totalMs: summarize(rows.map(row=>row.totalMs)) };
  }
  methods['service.health'] = {
    handlerMs: summarize(frontHandlerMs),
    queueMs: { count: frontTotalMs.length, p50: 0, p95: 0, note: 'Cached front route has no persistence queue' },
    totalMs: summarize(frontTotalMs),
  };
  const result = { spawnCounterPositiveControl: probeAfter-probeBefore, population, upgradeOpenMs, steadyOpenMs: summarize(openMs), methods,
    publicationMs: summarize(samples.map(row=>row.publicationMs)), changedPublicationMs: summarize(samples.filter(row=>row.method==='debug').map(row=>row.publicationMs)),
    elapsedSeconds, bursts, spawns: spawnedAfter-spawnedBefore, spawnsPerMinute: (spawnedAfter-spawnedBefore)*60/elapsedSeconds };
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
} finally { await client?.close(); await service.stop(); }
