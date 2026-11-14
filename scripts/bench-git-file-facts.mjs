import { scratchDirectory } from '../shared/scratch-root.mjs';
// Isolated active-probe comparison: no live store, host adapter or forge writes.
import cp from 'node:child_process';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const seconds = Number(process.env.NUCLEUS_BENCH_SECONDS ?? 60);
const scratch = scratchDirectory(process.env.TMPDIR);
if (!Number.isFinite(seconds) || seconds < 60) throw new Error('Use at least 60 seconds per source');
async function command(program, args, options = {}) {
  const child = cp.spawn(program, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  await new Promise((res, rej) => { child.on('error', rej); child.on('close', code => code === 0 ? res() : rej(new Error(`${program} exited ${code}`))); });
  return output.trim();
}
if (process.argv[2] === '--worker') {
  const [source, fixture, output] = process.argv.slice(3);
  const machineSource = name => {
    const path = join(source, 'core/machine', name);
    return existsSync(path) ? path : join(source, 'server', name);
  };
  let spawns = 0;
  for (const method of ['spawnSync', 'execFileSync']) {
    const original = cp[method];
    cp[method] = function(...args) { spawns++; return original.apply(this, args); };
  }
  const original = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function(...args) { spawns++; return original.apply(this, args); };
  syncBuiltinESMExports();
  const { instructionForCommit } = require(join(source, 'core/hooks/hooks.ts'));
  const { supervisorLiveness, supervisorLivenessAsync } = require(join(source, 'core/machine/supervisor-liveness.ts'));
  const { hostRunProcessStartIdentity } = require(machineSource('start-identity.ts'));
  const after = process.env.NUCLEUS_BENCH_VARIANT === 'after';
  const Reader = after ? require(machineSource('supervisor-liveness.ts')).SupervisorLivenessReader : null;
  const validation = Reader && new Reader(), qa = Reader && new Reader();
  const state = join(fixture, 'state.json');
  writeFileSync(state, JSON.stringify({ heartbeatAt: new Date().toISOString(), identityToken: '--worker' }));
  const facts = after ? new (require(machineSource('file-facts.ts')).FileFacts)(p => JSON.parse(readFileSync(p, 'utf8'))) : null;
  const repo = join(fixture, 'repo'); mkdirSync(repo);
  await command('git', ['init', repo]);
  await command('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
  await command('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(repo, 'instruction.md'), 'Pinned instruction\n');
  await command('git', ['-C', repo, 'add', '.']);
  await command('git', ['-C', repo, 'commit', '-m', 'fixture']);
  const head = await command('git', ['-C', repo, 'rev-parse', 'HEAD']);
  const identity = hostRunProcessStartIdentity(process.pid);
  const positiveBefore = spawns;
  await command(process.execPath, ['-e', '']);
  if (spawns !== positiveBefore + 1) throw new Error('Spawn positive control failed');
  const before = spawns, cpu = process.cpuUsage(), utilization = performance.eventLoopUtilization(), began = performance.now();
  let polls = 0, qaPolls = 0, blobs = 0;
  while (performance.now() - began < seconds * 1000) {
    // Real host process, actual ps/git/file readers, production watch cadences.
    const fresh = polls % 20 === 0;
    const live = after ? await validation.read(process.pid, '--worker', identity, fresh) : supervisorLiveness(process.pid, '--worker');
    if (live.state !== 'live') throw new Error('Validation supervisor identity lost');
    if (facts) facts.read(state); else JSON.parse(readFileSync(state, 'utf8'));
    if (polls % 2 === 0) {
      const live = after ? await qa.read(process.pid, '--worker', identity, fresh) : await supervisorLivenessAsync(process.pid, '--worker');
      if (live.state !== 'live') throw new Error('QA supervisor identity lost');
      qaPolls++;
    }
    if (polls % 4 === 0) { await instructionForCommit(repo, head, 'instruction.md', 'text/markdown'); blobs++; }
    polls++;
    await sleep(Math.max(0, began + polls * 250 - performance.now()));
  }
  const elapsedMs = performance.now() - began, busy = performance.eventLoopUtilization(utilization), used = process.cpuUsage(cpu);
  writeFileSync(output, JSON.stringify({ elapsedMs, polls, qaPolls, blobs, spawns: spawns-before,
    spawnsPerMinute: (spawns-before)*60000/elapsedMs, executorBusyMs: busy.active,
    executorBusyPercent: busy.utilization*100, cpuMs: (used.user+used.system)/1000, spawnPositiveControl: 1 }, null, 2));
} else {
  const fixture = mkdtempSync(join(scratch, 'git-file-bench-'));
  const receipt = { fixture, seconds, variants: [] };
  for (const [label, ref] of [['before', process.env.NUCLEUS_BENCH_BASE ?? 'origin/main'], ['after', process.env.NUCLEUS_BENCH_HEAD ?? 'HEAD']]) {
    const head = await command('git', ['rev-parse', ref]);
    const source = join(fixture, label), data = join(fixture, label+'-data'); mkdirSync(source); mkdirSync(data);
    const archive = join(data, 'source.tar');
    await command('git', ['archive', '--output', archive, head]);
    await command('tar', ['-xf', archive, '-C', source]);
    const output = join(data, 'result.json');
    console.log(`Measuring ${label} ${head} for ${seconds}s`);
    await command(process.execPath, ['--import', require.resolve('tsx'), resolve('scripts/bench-git-file-facts.mjs'), '--worker', source, data, output], {
      env: { ...process.env, NODE_PATH: dirname(dirname(require.resolve('zod/package.json'))), NUCLEUS_BENCH_VARIANT: label },
    });
    receipt.variants.push({ label, head, ...JSON.parse(readFileSync(output, 'utf8')) });
    console.log(JSON.stringify(receipt.variants.at(-1)));
  }
  const output = join(fixture, 'receipt.json'); writeFileSync(output, JSON.stringify(receipt, null, 2));
  console.log('Receipt: '+output);
}
