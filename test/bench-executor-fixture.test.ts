import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { instrumentBenchmarkExecutor } from '../scripts/bench-executor-fixture.mjs';

for (const lazy of [false, true]) test('benchmark retains inert preparation and accurate counters with ' + (lazy ? 'lazy' : 'inline') + ' fixtures', async () => {
  const fixtureSource = [
    'function fakeAdapter() { return {}; }',
    'export const FIXTURES = {',
    '  fake: { adapter: fakeAdapter },',
    '};',
    'export async function handleDebug(runtime, op) {',
    '  const request = op;',
    '  if (request.target === "fixture") {',
    '    throw new Error("unknown fixture action");',
    '  }',
    '}',
  ].join('\n');
  const workerSource = 'async function bootExecutor() {}\nvoid bootExecutor();\n' + (lazy ? '' : fixtureSource);
  const patched = instrumentBenchmarkExecutor(workerSource, lazy ? fixtureSource : undefined);
  class ChildProcess {
    spawn() { return this; }
    on(_event: string, done: () => void) { done(); return this; }
  }
  const childProcess = { ChildProcess, spawn: () => new ChildProcess().spawn(), spawnSync() {}, execFileSync() {} };
  const context = createContext({ process: { execPath: 'fixture-node' } });
  const evaluate = (source: string) => {
    const module = { exports: {} as any };
    const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
    runInContext('(function(require,module,exports){' + compiled + '\n})', context)(
      (name: string) => name === 'node:child_process' ? childProcess : { syncBuiltinESMExports() {} }, module, module.exports);
    return module.exports;
  };
  const worker = evaluate(patched.worker);
  const fixtures = patched.fixtures === undefined ? worker : evaluate(patched.fixtures);
  const writes: unknown[] = [];
  fixtures.FIXTURES.bench.instrumentStore({}, {
    deleteMeta: (key: string) => writes.push(['delete', key]),
    setMeta: (key: string, value: unknown) => writes.push([key, value]),
  });
  assert.deepEqual(writes, [['delete', 'processOwner'], ['paused', true], ['dispatchHeld', true]]);
  const read = () => fixtures.handleDebug({}, { target: 'fixture', action: 'bench-spawns' });
  assert.equal(await read(), 0);
  await fixtures.handleDebug({}, { target: 'fixture', action: 'bench-spawn-probe' });
  assert.equal(await read(), 1);
});

test('benchmark refuses an unrecognized fixture layout', () => {
  assert.throws(() => instrumentBenchmarkExecutor('void bootExecutor();', 'no fixtures'), /did not match/);
});
