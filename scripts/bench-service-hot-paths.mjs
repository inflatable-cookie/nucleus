import { scratchDirectory } from '../shared/scratch-root.mjs';
import { instrumentBenchmarkExecutor } from "./bench-executor-fixture.mjs";
import { spawn } from 'node:child_process';
import { existsSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const snapshot = process.env.NUCLEUS_BENCH_SNAPSHOT;
const scratch = scratchDirectory(process.env.TMPDIR);
if (!snapshot) throw new Error('Set NUCLEUS_BENCH_SNAPSHOT');
const fixture = mkdtempSync(join(scratch, 'service-bench-'));
const baseline = process.env.NUCLEUS_BENCH_BASE ?? 'dad241ee7a5c0a6bd8bc8f7c8bc995609f554fe4';
const after = process.env.NUCLEUS_BENCH_HEAD ?? 'HEAD';
const duration = Number(process.env.NUCLEUS_BENCH_SECONDS ?? 60);
if (duration < 60) throw new Error('The comparison needs at least 60 seconds per source');
const exit = child => new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(child.spawnfile + ' exited ' + code)));
});
async function command(program, args, options = {}) {
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
  let out = '';
  child.stdout.on('data', bytes => { out += bytes; });
  await exit(child);
  return out.trim();
}
const snapshotHash = createHash('sha256');
for await (const bytes of createReadStream(snapshot)) snapshotHash.update(bytes);
const receipt = { snapshotSha256: snapshotHash.digest('hex'), durationSeconds: duration, fixture, retentionAt: Date.now(), variants: [] };
console.log('Benchmark fixture: ' + fixture);
for (const [label, ref] of [['before', baseline], ['after', after]]) {
  const head = await command('git', ['rev-parse', ref]);
  const source = join(fixture, label), dataDir = join(fixture, label + '-data');
  mkdirSync(source); mkdirSync(dataDir);
  const archive = spawn('git', ['archive', head], { stdio: ['ignore', 'pipe', 'inherit'] });
  const unpack = spawn('tar', ['-x', '-C', source], { stdio: ['pipe', 'ignore', 'inherit'] });
  await Promise.all([pipeline(archive.stdout, unpack.stdin), exit(archive), exit(unpack)]);
  await pipeline(createReadStream(snapshot), createGunzip(), createWriteStream(join(dataDir, 'queue.sqlite'), { mode: 0o600 }));
  // The same inert fixture and counters are applied to both archived sources.
  const workerPath = join(source, 'service/executor/executor-worker.ts');
  const fixturesPath = join(source, 'service/executor/executor-fixtures.ts');
  const patched = instrumentBenchmarkExecutor(readFileSync(workerPath, 'utf8'),
    existsSync(fixturesPath) ? readFileSync(fixturesPath, 'utf8') : undefined);
  writeFileSync(workerPath, patched.worker);
  if (patched.fixtures !== undefined) writeFileSync(fixturesPath, patched.fixtures);
  const resultPath = join(fixture, label + '.json');
  console.log('Starting ' + label + ' ' + head);
  await command(process.execPath, ['--import', require.resolve('tsx'), resolve('scripts/bench-service-hot-paths-worker.mjs'), source, dataDir, resultPath, String(duration)], {
    env: { ...process.env, NODE_PATH: dirname(dirname(require.resolve('zod/package.json'))), GIT_OPTIONAL_LOCKS: '0', PASEO_HOME: join(dataDir, 'paseo'), NUCLEUS_DATA_HOME: dataDir, NUCLEUS_BENCH_AT: String(receipt.retentionAt) },
  });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  receipt.variants.push({ label, head, ...result });
  console.log(JSON.stringify(receipt.variants.at(-1)));
  writeFileSync(join(fixture, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
console.log('Receipt: ' + join(fixture, 'receipt.json'));
