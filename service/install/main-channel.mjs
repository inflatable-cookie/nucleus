import { writeOwnedJson } from "../../core/machine/owned-file.mjs";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { install, installBase, verifyVersion } from './install.mjs';
import { scratchDirectory } from '../../shared/scratch-root.mjs';
import { dataHome } from '../../shared/data-home.mjs';
import { paseoHomeEnvironment } from '../../hosts/paseo/index.mjs';

const exec = promisify(execFile);
const configPath = () => join(installBase(), 'channel.json');
async function readConfig() {
  try { return JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function save(config) {
  await mkdir(installBase(), { recursive: true });
  writeOwnedJson(configPath(), config);
}
export async function configureChannel(channel, repository, scratch) {
  if (channel === 'release') { await save({ channel }); return { channel }; }
  if (channel !== 'main' || !repository) throw Error('Use nucleus channel main <repository> or nucleus channel release');
  await verifyVersion(await realpath(join(installBase(), 'current')));
  const root = await channelScratchRoot();
  scratch = scratchDirectory(scratch ?? root, { ...process.env, NUCLEUS_SCRATCH_ROOT: root });
  await save({ channel, repository, scratch });
  return { channel, repository, scratch };
}

/** Service scratch follows the configured work volume; the developer override remains optional. */
async function channelScratchRoot() {
  const root = process.env.NUCLEUS_SCRATCH_ROOT || join(await configuredWorkRoot(), 'scratch');
  if (!process.env.NUCLEUS_SCRATCH_ROOT) await mkdir(root, { recursive: true });
  return scratchDirectory(root, { ...process.env, NUCLEUS_SCRATCH_ROOT: root });
}

// Keep this install/bridge path independent of the workspace allocator, which
// also imports node:sqlite to inspect historical allocations.
async function configuredWorkRoot() {
  const dataDir = dataHome();
  let settings = {};
  try { settings = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Work storage settings must be an object');
  if (settings.workRoot !== undefined && typeof settings.workRoot !== 'string') throw Error('workRoot must be a string');
  const root = process.env.NUCLEUS_WORK_ROOT?.trim() || settings.workRoot || join(dataDir, 'work');
  if (!isAbsolute(root) || root === '/' || resolve(root) !== root) throw Error('workRoot must be a canonical absolute directory');
  return root;
}
export async function requestRollback() {
  const prior = await verifyVersion(await realpath(join(installBase(), 'previous')));
  const config = await readConfig();
  if (config?.channel !== 'main') throw Error('Rollback through the bridge requires the main channel');
  const latest = await new MainChannel(config).target();
  await save({ ...config, rollback: prior.root, ignoredRevision: latest?.revision });
  return { next: 'Prior version queued for the normal service roll', revision: prior.revision };
}

/** Opt-in only. All Git/build work is off the RPC path, serial and low priority. */
/**
 * Keep the given versions and one other. A link is left alone: an older thread's
 * launch path may resolve through it to the current version.
 */
export async function pruneVersions(versions, keep) {
  const others = [];
  for (const name of await readdir(versions)) {
    const path = join(versions, name);
    if (!name.startsWith('.') && !keep.has(path) && !(await lstat(path)).isSymbolicLink()) others.push(path);
  }
  others.sort();
  for (const root of others.slice(0, -1)) await rm(root, { recursive: true });
}

export class MainChannel {
  checkout = null;
  lock = null;
  built = null;
  constructor(config) { this.config = config; }
  static async open(sourcePath) {
    const config = await readConfig();
    if (config?.channel !== 'main') return null;
    // A configuration file cannot silently migrate a checkout registration.
    const current = await realpath(join(installBase(), 'current'));
    if (await realpath(sourcePath) !== current) return null;
    await verifyVersion(current);
    return new MainChannel(config);
  }
  async command(command, args, cwd, environment = {}) {
    try {
      return (await exec('/usr/bin/nice', ['-n', '10', command, ...args], {
        cwd, env: { ...process.env, ...environment, ...(this.config.scratch ? { TMPDIR: this.config.scratch, TMP: this.config.scratch, TEMP: this.config.scratch } : {}) }, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
      })).stdout.trim();
    } catch (e) { throw Error(`${command} failed: ${String(e.stderr || e.message).slice(-2000)}`); }
  }
  async target() {
    this.config = await readConfig();
    if (this.config?.channel !== 'main') return null;
    if (this.config.rollback) {
      const prior = await verifyVersion(this.config.rollback);
      return { key: prior.buildId, staged: prior };
    }
    const revision = (await this.command('git', ['ls-remote', this.config.repository, 'refs/heads/main'])).split(/\s/)[0];
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Repository has no main commit');
    if (revision === this.config.ignoredRevision) return null;
    return { key: revision, revision };
  }
  async buildNode() {
    // Paseo's process.execPath can be an Electron helper. Prefer the active
    // self-contained install, and accept a checkout host only after probing it.
    const candidates = [join(installBase(), 'current/runtime/node'), process.execPath];
    const failures = [];
    for (const candidate of new Set(candidates)) {
      try {
        await this.command(candidate, ['-e', "if (process.versions.electron || !process.versions.node) process.exit(1)"]);
        return candidate;
      } catch (error) { failures.push(error.message); }
    }
    throw Error(`Main build requires a working standalone Node runtime: ${failures.join('; ')}`);
  }
  async startService(node, args, root, environment) {
    // Use the normal entry so already-installed rollback packages need no new
    // CLI flag. A ready line proves the executor and socket reached startup.
    const running = exec(node, args, {
      cwd: root, env: { ...process.env, ...environment, QUEUE_STANDBY_FOR_PID: '' },
      timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    });
    let output = '', ready = false;
    running.child.stdout.on('data', chunk => {
      output += chunk;
      if (!ready && /Nucleus service ready on /.test(output)) {
        ready = true;
        running.child.kill('SIGTERM');
      }
    });
    try { await running; }
    catch (error) { throw Error(`Staged service startup failed: ${String(error.stderr || error.message).slice(-2000)}`); }
    if (!ready) throw Error('Staged service exited before reporting ready');
  }
  async proveStartup(staged) {
    const root = await channelScratchRoot();
    const scratch = scratchDirectory(this.config.scratch, { ...process.env, NUCLEUS_SCRATCH_ROOT: root });
    const node = join(staged.root, 'runtime/node');
    await this.command(node, ['--version']);
    const proof = await mkdtemp(join(scratch, 's-'));
    const data = join(proof, 'q');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'settings.json'), JSON.stringify({ daemonUrl: 'ws://127.0.0.1:0/ws' }));
    // A short separate store avoids Unix socket path limits and never opens
    // the running service's database or connects to the operator's Paseo.
    await this.startService(node, ['bin/queue-service.mjs', `--data-dir=${data}`], staged.root, {
      HOME: join(proof, 'h'), ...paseoHomeEnvironment(join(proof, 'p')),
      TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    });
  }
  async build(revision) {
    if (this.built?.revision === revision) return this.built;
    const started = Date.now();
    if (!this.checkout) {
      const root = await channelScratchRoot();
      const scratch = scratchDirectory(this.config.scratch, { ...process.env, NUCLEUS_SCRATCH_ROOT: root });
      const checkout = await mkdtemp(join(scratch, 'nucleus-main-'));
      await this.command('git', ['clone', '--depth=1', '--no-local', '--single-branch', '--branch', 'main', '--no-checkout', '--', this.config.repository, join(checkout, 'source')]);
      this.checkout = checkout;
    }
    const source = join(this.checkout, 'source');
    await this.command('git', ['fetch', '--depth=1', 'origin', 'main'], source);
    await this.command('git', ['checkout', '--detach', revision], source);
    if (await this.command('git', ['status', '--porcelain'], source)) throw Error('Main build checkout is dirty');
    const lock = await readFile(join(source, 'package-lock.json'), 'utf8');
    if (lock !== this.lock) {
      await this.command('npm', ['ci', '--no-audit', '--no-fund'], source);
      this.lock = lock;
    }
    const packageRoot = join(this.checkout, `package-${revision}`);
    // A failed build is suppressed by the bridge until a different revision.
    await this.command(await this.buildNode(), ['scripts/build-runtime.mjs', packageRoot], source);
    // Paseo rebundles the installed entry as CommonJS. Prove that exact
    // entry loads before the package can be called a verified main build.
    await this.command(await this.buildNode(), ['scripts/prove-plugin-load.mjs', join(packageRoot, 'index.server.ts')], source);
    const archive = join(this.checkout, `package-${revision}.tgz`);
    await this.command('/usr/bin/tar', ['--format=ustar', '-czf', archive, '-C', packageRoot, '.']);
    const staged = await install(archive, undefined, { activate: false });
    await rm(packageRoot, { recursive: true });
    await rm(archive);
    if (staged.revision !== revision) throw Error('Build revision did not match main');
    await this.proveStartup(staged);
    this.built = { ...staged, elapsedMs: Date.now() - started };
    return this.built;
  }
  async pending() {
    try { return JSON.parse(await readFile(join(installBase(), 'activation.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async abandon(staged) {
    const pending = await this.pending();
    if (pending?.root === staged.root) await rm(join(installBase(), 'activation.json'), { force: true });
  }
  async prepare(staged, target) {
    await verifyVersion(staged.root);
    if (this.built?.root !== staged.root) await this.proveStartup(staged);
    const path = join(installBase(), 'activation.json');
    writeOwnedJson(path, { root: staged.root, target });
  }
  async activated(target) {
    if (target.staged) await save({ ...this.config, rollback: undefined });
    await rm(join(installBase(), 'activation.json'), { force: true });
    // This clone belongs to this builder alone. Leave its mkdtemp root in place,
    // but release bulky inputs before the plugin reload creates another builder.
    if (this.checkout) {
      for (const name of await readdir(this.checkout)) await rm(join(this.checkout, name), { recursive: true, force: true });
      this.checkout = null;
      this.lock = null;
    }
    // Keep current, previous and one other version. Never touch development links.
    const keep = new Set(await Promise.all(['current', 'previous'].map(n => realpath(join(installBase(), n)).catch(() => ''))));
    const versions = join(installBase(), 'versions');
    await pruneVersions(versions, keep);
  }
}
