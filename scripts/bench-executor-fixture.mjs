/** Apply identical inert instrumentation to inline or lazy-loaded executor fixtures. */
export function instrumentBenchmarkExecutor(worker, fixtures) {
  worker = 'import benchChildProcess from "node:child_process";\nimport { syncBuiltinESMExports as benchSyncExports } from "node:module";\n' + worker;
  worker = worker.replace('void bootExecutor();', [
    'let benchSpawns = 0;',
    'Object.defineProperty(globalThis, "__nucleusBenchSpawns", { get: () => benchSpawns });',
    "for (const method of ['spawnSync','execFileSync'] as const) {",
    '  const original = benchChildProcess[method];',
    '  (benchChildProcess as any)[method] = function(...args: any[]) {',
    '    benchSpawns++; return (original as any).apply(this,args);',
    '  };',
    '}',
    'const benchSpawn = benchChildProcess.ChildProcess.prototype.spawn;',
    '(benchChildProcess.ChildProcess.prototype as any).spawn = function(...args: any[]) {',
    '  benchSpawns++; return (benchSpawn as any).apply(this,args);',
    '};',
    'benchSyncExports();',
    'void bootExecutor();',
  ].join('\n'));
  let target = fixtures === undefined ? worker : 'import benchChildProcess from "node:child_process";\n' + fixtures;
  target = target.replace('  fake: { adapter: fakeAdapter },', [
    '  bench: { adapter: fakeAdapter, instrumentStore: (_state, store) => {',
    "    store.deleteMeta('processOwner'); store.setMeta('paused',true); store.setMeta('dispatchHeld',true);",
    '  } },',
    '  fake: { adapter: fakeAdapter },',
  ].join('\n'));
  target = target.replace('  if (request.target === "fixture") {', [
    '  if (request.target === "fixture") {',
    '    if (request.action === "bench-spawns") return (globalThis as any).__nucleusBenchSpawns;',
    '    if (request.action === "bench-spawn-probe") return new Promise(resolve => { benchChildProcess.spawn(process.execPath,["-e",""]).on("close", () => resolve({ok:true})); });',
  ].join('\n'));
  if (!target.includes('  bench:') || !target.includes('bench-spawns') || !worker.includes('let benchSpawns'))
    throw new Error('Fixture instrumentation did not match archived executor');
  return fixtures === undefined ? { worker: target } : { worker, fixtures: target };
}
