/**
 * Opt-in private proof (nucleus#1394): a configured local T3Code host starts the
 * Nucleus daemon on its own cold start, with no thread, workspace or model picker.
 *
 * It extracts the private nightly archive into run scratch, uses a fresh base
 * directory, home and Nucleus data home, and registers this checkout's
 * `nucleus-acp` launcher through T3's own provider settings. It never touches the
 * operator's T3 or Nucleus state and never opens a thread.
 *
 *   effigy proof:t3code:daemon -- --asar "<nightly app>/Contents/Resources/app.asar"
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { providerInstance, T3_RUNTIME_SCOPES } from '../../shared/t3/operator';
import { writeT3Connection } from '../../shared/t3/settings';
import { localQueueClient } from '../../shared/service/local-client';

// Set once the private server exists; the failure path stops only what this run started.
let cleanupAfterFailure: () => Promise<void> = async () => {};

async function main() {
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const asarArg = args.indexOf('--asar');
const asar = asarArg >= 0 ? args[asarArg + 1] : process.env.NUCLEUS_T3_PROOF_ASAR;
if (!asar) throw Error('Set NUCLEUS_T3_PROOF_ASAR or pass --asar with the target nightly app archive');
const scratch = process.env.TMPDIR;
if (!scratch || !existsSync(scratch) || !statSync(scratch).isDirectory()) throw Error('The run scratch volume is required');
const root = mkdtempSync(join(realpathSync(scratch), 't3-daemon-'));
console.log(JSON.stringify({ proofRoot: root }));
const evidence: Record<string, unknown> = { steps: [] };
const steps = evidence.steps as unknown[];
const step = (name: string, detail: Record<string, unknown> = {}) => { steps.push({ step: name, ...detail }); console.log(JSON.stringify({ step: name, ...detail })); };

// --- the nightly bundle, extracted as the other private proofs do --------------
type ArchiveEntry = { files?: Record<string, ArchiveEntry>; size?: number; offset?: string; unpacked?: boolean; link?: string };
function extractArchive(source: string, destination: string) {
  const fd = openSync(source, 'r');
  try {
    const prelude = Buffer.alloc(16);
    assert.equal(readSync(fd, prelude, 0, 16, 0), 16);
    const headerSize = prelude.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 16);
    const tree = JSON.parse(header.toString()) as ArchiveEntry;
    const base = prelude.readUInt32LE(4) + 8;
    function walk(entry: ArchiveEntry, relative: string) {
      const target = resolve(destination, relative);
      assert.ok(target === destination || target.startsWith(destination + sep), 'Archive entry stays inside the fixture');
      if (entry.files) {
        mkdirSync(target, { recursive: true });
        for (const [name, child] of Object.entries(entry.files)) walk(child, join(relative, name));
      } else if (entry.link) {
        symlinkSync(resolve(destination, entry.link), target);
      } else if (entry.unpacked) {
        copyFileSync(join(source + '.unpacked', relative), target);
      } else {
        const bytes = Buffer.alloc(entry.size!);
        readSync(fd, bytes, 0, bytes.length, base + Number(entry.offset));
        writeFileSync(target, bytes);
      }
    }
    for (const [name, entry] of Object.entries(tree.files ?? {})) {
      if (name === 'node_modules' || name === 'package.json') walk(entry, name);
      if (name === 'apps') walk(entry.files!.server, 'apps/server');
    }
  } finally { closeSync(fd); }
}
const bundle = join(root, 'bundle');
mkdirSync(bundle);
extractArchive(resolve(asar), bundle);
const metadata = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')) as { version: string };
step('bundle-extracted', { t3Version: metadata.version });
const entry = join(bundle, 'apps/server/dist/bin.mjs');

// --- private state: fresh home, base directory and Nucleus data home ----------
const privateHome = join(root, 'home');
const t3Data = join(root, 't3-data');
const nucleusData = join(root, 'nucleus-data');
for (const path of [privateHome, join(t3Data, 'userdata'), nucleusData]) mkdirSync(path, { recursive: true });
const probeLog = join(root, 'launcher-probes.log');
// The registered launcher: the marker install uses, a probe record, then this checkout's launcher.
const launcher = join(root, 'nucleus-acp');
const loader = join(checkout, 'node_modules/tsx/dist/loader.mjs');
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(launcher, `#!/bin/sh\n# nucleus-owned-command-v1\nprintf '%s pid=%s cwd=%s args=%s\\n' "$(date -u +%FT%TZ)" "$$" "$PWD" "$*" >> ${shellQuote(probeLog)}\nexec ${shellQuote(process.execPath)} --import ${shellQuote(loader)} ${shellQuote(join(checkout, 'bin/nucleus-acp.mjs'))} "$@"\n`, { mode: 0o700 });
chmodSync(launcher, 0o700);
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: privateHome, TMPDIR: root, TMP: root, TEMP: root,
  XDG_CONFIG_HOME: join(privateHome, '.config'), XDG_DATA_HOME: join(privateHome, '.local/share'), XDG_CACHE_HOME: join(privateHome, '.cache'),
  T3CODE_HOME: t3Data, T3CODE_NO_BROWSER: 'true', T3CODE_LOG_LEVEL: 'Warn', T3CODE_TRACE_TIMING_ENABLED: 'false',
  NUCLEUS_DATA_HOME: nucleusData,
};
// A dev checkout's service reads its Paseo plugin registration; an installed build does not (compiled identity).
mkdirSync(join(privateHome, '.paseo'), { recursive: true });
writeFileSync(join(privateHome, '.paseo/config.json'), JSON.stringify({ plugins: { nucleus: { enabled: true, path: checkout } } }), { mode: 0o600 });
writeFileSync(join(t3Data, 'userdata/settings.json'), JSON.stringify({
  providerInstances: { nucleus: providerInstance(launcher) },
  notifications: { enabled: false },
}), { mode: 0o600 });

// The stored connection an install would have written before this cold start.
const bearer = execFileSync(process.execPath, [entry, 'auth', 'session', 'issue', '--base-dir', t3Data, ...T3_RUNTIME_SCOPES.flatMap((scope) => ['--scope', scope]), '--token-only'], { cwd: root, env: environment, encoding: 'utf8' }).trim();
assert.ok(bearer.length > 20, 'a private session bearer is issued');
const port = await reservePort();
const endpoint = `http://127.0.0.1:${port}`;
writeT3Connection(nucleusData, { endpoint, bearer, baseDir: t3Data });
step('state-prepared', { providerRegistered: true, connectionStored: true, daemonRunningBefore: false });

async function reservePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((ok) => socket.listen(0, '127.0.0.1', ok));
  const found = (socket.address() as { port: number }).port;
  await new Promise<void>((ok) => socket.close(() => ok()));
  return found;
}

// Failure path: stop this run's own private server and daemon, never the operator's.
// --- T3 server lifecycle --------------------------------------------------------
let server: ChildProcess | undefined;
async function startServer(): Promise<number> {
  const log = openSync(join(root, 'server.log'), 'a', 0o600);
  server = spawn(process.execPath, [entry, '--base-dir', t3Data, '--host', '127.0.0.1', '--port', String(port), '--no-browser'], { cwd: root, env: environment, stdio: ['ignore', log, log] });
  const started = Date.now();
  await until(async () => {
    if (server?.exitCode !== null) throw Error(`T3 server exited (${server?.exitCode}); see server.log`);
    return (await fetch(`${endpoint}/.well-known/t3/environment`).catch(() => null))?.ok === true;
  }, 'T3 server ready', 90_000);
  closeSync(log);
  return Date.now() - started;
}
async function stopServer() {
  const child = server;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(Error('T3 server did not exit')); }, 15_000);
    child.once('close', () => { clearTimeout(timer); ok(); });
    child.kill('SIGTERM');
  });
  server = undefined;
}

// --- daemon observation ------------------------------------------------------
function daemonPids(): number[] {
  const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n')
    .filter((line) => line.includes('queue-service.mjs') && line.includes(`--data-dir=${nucleusData}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid));
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function probeCount(): number { return existsSync(probeLog) ? readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length : 0; }
async function healthOrNull() {
  const client = localQueueClient(nucleusData, { compatibilityWaitMs: 1_000, onProgress: () => {} });
  try { await client.connect(); return (await client.request('service.health', {})) as { t3code?: { connected?: boolean; id?: string | null } }; }
  catch { return null; }
  finally { client.close(); }
}
async function waitForT3Connected(milliseconds = 90_000) {
  return until(async () => {
    const health = await healthOrNull();
    return health?.t3code?.connected === true ? health : null;
  }, 'the daemon to connect to T3Code', milliseconds);
}
async function until<T>(read: () => Promise<T>, description: string, milliseconds = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await read().catch(() => null);
    if (result) return result as NonNullable<T>;
    await delay(250);
  }
  throw Error(`Timed out waiting for ${description}`);
}

cleanupAfterFailure = async () => {
  await stopServer().catch(() => {});
  for (const pid of daemonPids()) execFileSync('kill', ['-TERM', String(pid)]);
};
// --- 1. cold start -------------------------------------------------------------
assert.deepEqual(daemonPids(), [], 'no daemon before the cold start');
const readyMs = await startServer();
await until(async () => probeCount() > 0 ? true : null, 'the registered launcher to be probed', 90_000);
step('cold-start-probe', { probesAfterReady: probeCount(), readyMs, threadCreated: false, probeLog: 'launcher-probes.log' });
const first = await until(async () => { const pids = daemonPids(); return pids.length === 1 ? pids : null; }, 'one daemon to start', 90_000);
const health = await waitForT3Connected();
step('cold-start-daemon', { daemonPids: first, t3Connected: true, t3Id: health.t3code?.id ?? null });

// --- 2. repeated and concurrent probes converge ------------------------------
const pidBefore = first[0]!;
const before = probeCount();
await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((ok, fail) => {
  const probe = spawn(launcher, [], { cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  probe.stderr!.on('data', (chunk) => { stderr += chunk; });
  probe.on('close', (code) => code === 0 ? ok() : fail(Error(`probe exited ${code}: ${stderr.slice(-400)}`)));
})));
await delay(1_000);
assert.deepEqual(daemonPids(), [pidBefore], 'six concurrent probes leave one daemon');
step('repeated-probes', { probes: probeCount() - before, daemonPid: pidBefore, daemonCount: 1 });

// --- 3. T3-only disconnect keeps the daemon in its grace --------------------
await stopServer();
await delay(3_000);
assert.ok(pidAlive(pidBefore), 'the daemon survives the last host closing (grace)');
const afterClose = await healthOrNull();
step('t3-disconnect', { daemonAlive: true, t3ConnectedAfterClose: afterClose?.t3code?.connected === true });

// --- 4. reconnect: a restarted T3 probes, finds the daemon and reattaches ----
const probesBeforeRestart = probeCount();
await startServer();
await waitForT3Connected();
await until(async () => probeCount() > probesBeforeRestart ? true : null, 'the launcher to be probed again', 90_000);
assert.deepEqual(daemonPids(), [pidBefore], 'a T3 restart reattaches to the same daemon');
step('t3-reconnect', { daemonPid: pidBefore, daemonCount: 1 });

// --- 5. a service roll blocks the probe; the daemon starts after it ----------
await stopServer();
execFileSync('kill', ['-TERM', String(pidBefore)]);
await until(async () => pidAlive(pidBefore) ? null : true, 'the daemon to drain on SIGTERM', 60_000);
writeFileSync(join(nucleusData, 'queue-service-roll.json'), JSON.stringify({ status: 'replacing', fromBuild: 'a', toBuild: 'b', digest: 'c', at: new Date().toISOString(), detail: 'proof roll', deferrals: [] }), { mode: 0o600 });
const probesBeforeRoll = probeCount();
await startServer();
await until(async () => probeCount() > probesBeforeRoll ? true : null, 'the launcher to be probed during the roll', 90_000);
await delay(1_500);
assert.deepEqual(daemonPids(), [], 'a probe during a roll starts no daemon');
step('roll-blocks-probe', { daemonCount: 0 });
rmRoll();
await until(async () => { const pids = daemonPids(); return pids.length === 1 ? pids : null; }, 'the daemon to start after the roll', 90_000);
const afterRoll = await waitForT3Connected();
step('roll-recovered', { daemonCount: daemonPids().length, t3Connected: afterRoll.t3code?.connected === true });

function rmRoll() { execFileSync('rm', ['-f', join(nucleusData, 'queue-service-roll.json')]); }

// --- teardown -------------------------------------------------------------------
await stopServer();
for (const pid of daemonPids()) execFileSync('kill', ['-TERM', String(pid)]);
await until(async () => daemonPids().length === 0 ? true : null, 'the daemon to drain', 60_000);
evidence.t3Version = metadata.version;
evidence.passed = true;
console.log(JSON.stringify(evidence, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await cleanupAfterFailure();
});
